// ============================================================================
// lib/feishu-token.js — 飞书发信 refresh_token 保活存储（多维表格方案）
//
// 解决的问题：
//   飞书 OAuth refresh_token 有效期 30 天，且用一次即作废（每次刷新都会返回新
//   refresh_token）。Vercel Serverless 环境变量是只读的，函数内无法把新 token
//   写回环境变量 → 旧值每次刷新后失效 → 第二次刷新必然失败 → 需用户重新授权。
//
// 方案（方案 A）：
//   复用飞书多维表格（与线索表同 app）存放最新 refresh_token：
//     - 每次刷新：读表格里的 refresh_token → 调 OAuth 刷新 → 拿新 user token +
//       新 refresh_token → 把新 refresh_token 写回表格 → 缓存 user token
//     - 首次：表格没有记录时，用环境变量 FEISHU_MAIL_REFRESH_TOKEN 作为初始值
//     - 保活：api/keepalive.js 每天由 Vercel Cron 触发一次，强制刷新续期
//   token 存在动态存储里，随刷新自动轮换，永不过期。
//
// 安全：
//   - refresh_token 只进多维表格（飞书表格本身有权限保护），不落代码/git/日志
//   - 日志只显示长度与前后缀（maskToken），绝不打印完整 token
//   - 并发写：简单覆盖（并发概率低：保活每天一次 + 访客提交稀疏），写回带
//     updated_at 时间戳便于排查
// ============================================================================

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
const FEISHU_OAUTH_BASE = 'https://accounts.feishu.cn/oauth/v3/token';

// mail_token 表名与字段（在同一多维表格 app 下，与线索表并存）
const TOKEN_TABLE_NAME = 'mail_token';
const TOKEN_TABLE_FIELDS = [
  { field_name: 'refresh_token', type: 1 },  // 多行文本：最新 refresh_token
  { field_name: 'updated_at', type: 5 },     // 日期时间：最近一次写入（毫秒时间戳）
  { field_name: 'note', type: 1 },           // 备注：来源/说明
];

// ---------- tenant_access_token（模块级缓存，lead/keepalive 共用） ----------
let tenantTokenCache = null;

async function getTenantAccessToken() {
  const now = Date.now();
  if (tenantTokenCache && tenantTokenCache.expiresAt > now) {
    return tenantTokenCache.token;
  }

  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('FEISHU_APP_ID / FEISHU_APP_SECRET 未配置');
  }

  const res = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await res.json().catch(() => ({}));

  if (!data || data.code !== 0 || !data.tenant_access_token) {
    const msg = (data && data.msg) ? data.msg : 'HTTP ' + res.status;
    throw new Error('获取 tenant_access_token 失败: ' + msg);
  }

  const expiresAt = Date.now() + Math.max(60, (data.expire || 7200) - 200) * 1000;
  tenantTokenCache = { token: data.tenant_access_token, expiresAt };
  return data.tenant_access_token;
}

// ---------- 日志脱敏 ----------
/** 只显示 token 前 4 + 后 4 + 长度，绝不显示完整值 */
function maskToken(t) {
  if (!t) return '(empty)';
  if (typeof t !== 'string' || t.length <= 10) return `len=${t.length}`;
  return `${t.slice(0, 4)}…${t.slice(-4)} len=${t.length}`;
}

// ---------- 多维表格：mail_token 表 ----------
let tokenTableIdCache = null;

/**
 * 确保 mail_token 表存在，返回其 table_id。
 * 列出 app 下所有表 → 找 name=mail_token；找不到则创建。
 */
async function ensureMailTokenTable() {
  const appToken = process.env.FEISHU_APP_TOKEN;
  if (!appToken) {
    throw new Error('FEISHU_APP_TOKEN 未配置');
  }
  if (tokenTableIdCache) {
    return tokenTableIdCache;
  }

  const token = await getTenantAccessToken();

  // 1) 列出已有表
  const listRes = await fetch(
    `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables?page_size=100`,
    { headers: { Authorization: 'Bearer ' + token } }
  );
  const listData = await listRes.json().catch(() => ({}));
  if (!listData || listData.code !== 0) {
    const msg = (listData && listData.msg) ? listData.msg : 'HTTP ' + listRes.status;
    throw new Error('查询多维表格表列表失败: ' + msg);
  }
  const items = (listData.data && listData.data.items) || [];
  const found = items.find((t) => t.name === TOKEN_TABLE_NAME);
  if (found) {
    tokenTableIdCache = found.table_id;
    return found.table_id;
  }

  // 2) 没有 → 创建
  const createRes = await fetch(`${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      table: { name: TOKEN_TABLE_NAME, fields: TOKEN_TABLE_FIELDS },
    }),
  });
  const createData = await createRes.json().catch(() => ({}));
  if (!createData || createData.code !== 0 || !createData.data || !createData.data.table_id) {
    const msg = (createData && createData.msg) ? createData.msg : 'HTTP ' + createRes.status;
    throw new Error('创建 mail_token 表失败: ' + msg);
  }
  tokenTableIdCache = createData.data.table_id;
  console.log('[feishu-token] 已创建 mail_token 表: table_id=' + createData.data.table_id);
  return createData.data.table_id;
}

/**
 * 读取表格里的 refresh_token。
 * @returns {Promise<{refresh_token: string, updated_at: number, record_id: string}|null>}
 *   无记录 → null；读表失败 → 抛错（调用方决定降级到环境变量）
 */
async function readStoredRefreshToken() {
  const appToken = process.env.FEISHU_APP_TOKEN;
  const tableId = await ensureMailTokenTable();
  const token = await getTenantAccessToken();

  const res = await fetch(
    `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=1`,
    { headers: { Authorization: 'Bearer ' + token } }
  );
  const data = await res.json().catch(() => ({}));
  if (!data || data.code !== 0) {
    const msg = (data && data.msg) ? data.msg : 'HTTP ' + res.status;
    throw new Error('读取 mail_token 记录失败: ' + msg);
  }
  const items = (data.data && data.data.items) || [];
  if (!items.length) {
    return null;
  }
  const rec = items[0];
  const fields = rec.fields || {};
  const rt = fields.refresh_token;
  if (!rt) {
    return null;
  }
  return {
    refresh_token: rt,
    updated_at: fields.updated_at || 0,
    record_id: rec.record_id,
  };
}

/**
 * 把新的 refresh_token 写回表格（无记录则创建，有则覆盖更新）。
 * 并发保护：简单覆盖 + updated_at 时间戳；并发概率低（保活每天一次 + 访客提交稀疏）。
 * @returns {Promise<{action: 'create'|'update'}>}
 */
async function writeStoredRefreshToken(refreshToken, note) {
  const appToken = process.env.FEISHU_APP_TOKEN;
  const tableId = await ensureMailTokenTable();
  const token = await getTenantAccessToken();

  const fields = {
    refresh_token: refreshToken,
    updated_at: Date.now(),
    note: note || 'auto',
  };

  // 先读一次：有记录则更新（避免重复创建多行）
  let existing = null;
  try {
    existing = await readStoredRefreshToken();
  } catch (e) {
    // 读失败继续走创建（幂等性由飞书记录重复兜底）
  }

  if (existing && existing.record_id) {
    const res = await fetch(
      `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/${existing.record_id}`,
      {
        method: 'PUT',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!data || data.code !== 0) {
      const msg = (data && data.msg) ? data.msg : 'HTTP ' + res.status;
      throw new Error('更新 mail_token 记录失败: ' + msg);
    }
    return { action: 'update' };
  }

  const res = await fetch(
    `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!data || data.code !== 0) {
    const msg = (data && data.msg) ? data.msg : 'HTTP ' + res.status;
    throw new Error('创建 mail_token 记录失败: ' + msg);
  }
  return { action: 'create' };
}

// ---------- OAuth 刷新 ----------
/**
 * 用 refresh_token 换取新的 user_access_token + 新 refresh_token。
 * @param {string} refreshToken 当前 refresh_token
 * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number}>}
 */
async function refreshUserToken(refreshToken) {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('FEISHU_APP_ID / FEISHU_APP_SECRET 未配置');
  }

  const res = await fetch(FEISHU_OAUTH_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: appId,
      client_secret: appSecret,
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data || data.code !== 0 || !data.access_token) {
    const msg = (data && data.msg) ? data.msg : 'HTTP ' + res.status;
    throw new Error('刷新 user_access_token 失败: ' + msg);
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_in: data.expires_in || 7200,
  };
}

// ---------- 主入口：获取新鲜的 user_access_token（负责轮换 + 写回） ----------
let mailTokenCache = null;

/**
 * 获取一个可用的 user_access_token，并确保 refresh_token 已轮换写回表格。
 * 优先级：缓存 → 表格里的 refresh_token（无则用 env 初始值）→ env user_access_token。
 *
 * 出错策略：
 *   - 刷新成功但写回失败 → 只告警，仍返回 access_token（下次保活会重试写回）
 *   - 刷新失败 → 抛错（调用方决定：发信失败但线索照常 / keepalive 返回失败）
 *
 * @param {{forceRefresh?: boolean}} [opts]
 * @returns {Promise<string|null>} user_access_token；未配置任何令牌 → null
 */
async function obtainUserMailToken(opts) {
  const now = Date.now();
  if (!opts || !opts.forceRefresh) {
    if (mailTokenCache && mailTokenCache.expiresAt > now) {
      return mailTokenCache.token;
    }
  }

  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('FEISHU_APP_ID / FEISHU_APP_SECRET 未配置');
  }

  // 1) 决定 refresh_token：表格优先，env 作为首次初始值
  let refreshToken = null;
  let fromStore = false;
  try {
    const stored = await readStoredRefreshToken();
    if (stored && stored.refresh_token) {
      refreshToken = stored.refresh_token;
      fromStore = true;
    }
  } catch (e) {
    // 表格不可用（首次部署表未建 / 权限问题）→ 降级到 env，不阻断发信
    console.warn('[feishu-token] 读取表格 refresh_token 失败，降级到环境变量: ' + e.message);
  }
  if (!refreshToken) {
    refreshToken = process.env.FEISHU_MAIL_REFRESH_TOKEN || null;
  }

  // 2) 有 refresh_token → 刷新（得到新 access_token + 新 refresh_token）→ 写回表格
  if (refreshToken) {
    const r = await refreshUserToken(refreshToken);
    mailTokenCache = {
      token: r.access_token,
      expiresAt: Date.now() + Math.max(60, r.expires_in - 300) * 1000,
    };

    // 写回新 refresh_token（失败不阻断发信，只告警；保活任务会兜底重试）
    try {
      const note = (fromStore ? 'rotated' : 'initialized-from-env');
      await writeStoredRefreshToken(r.refresh_token, note);
      console.log('[feishu-token] refresh_token 已轮换写回表格 ' + maskToken(r.refresh_token) + ' (' + note + ')');
    } catch (e) {
      console.warn('[feishu-token] 写回 refresh_token 失败（不影响本次发信，保活会重试）: ' + e.message);
    }

    return r.access_token;
  }

  // 3) 无 refresh_token → 直接用 env user_access_token（临时令牌，约 2 小时有效）
  const accessToken = process.env.FEISHU_MAIL_USER_ACCESS_TOKEN;
  if (accessToken) {
    mailTokenCache = { token: accessToken, expiresAt: Date.now() + 50 * 60 * 1000 }; // 保守 50 分钟
    return accessToken;
  }

  return null; // 未配置任何发信令牌
}

/** 清除模块级缓存（测试用 / 强制刷新用） */
function resetCache() {
  tenantTokenCache = null;
  tokenTableIdCache = null;
  mailTokenCache = null;
}

module.exports = {
  getTenantAccessToken,
  ensureMailTokenTable,
  readStoredRefreshToken,
  writeStoredRefreshToken,
  refreshUserToken,
  obtainUserMailToken,
  maskToken,
  resetCache,
  TOKEN_TABLE_NAME,
};
