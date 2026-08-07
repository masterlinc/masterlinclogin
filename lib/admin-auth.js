// ============================================================================
// lib/admin-auth.js — 通用认证模块（账号密码 + HMAC 会话 token）
//
// 用途（对齐「账号密码体系与会员复用」方案）：
//   - 用户模型：飞书多维表格 users 表（服务端自动建表，复用 api/backup.js 模式）
//     userId（主键，如 admin-masterlinc）/ username（登录名）/ passwordHash
//     （scrypt 盐+哈希，绝不存明文）/ role（admin/user/pro，为会员体系预留）/
//     status（active/disabled）/ createdAt / updatedAt / lastLoginAt /
//     nickname / email
//   - authenticateUser(username, password)：查 users 表 + scrypt 哈希比对
//   - issueToken(user)：签发 HMAC-SHA256 签名 token，payload 含 sub=userId + role
//   - verifyToken(token)：验签 / 过期 / 主体
//   - requireAdmin(req, res)：校验 role=admin（向后兼容旧 token sub=masterlinc）
//   - requireUser(req, res)：role 为 admin/user/pro 可访问 —— 未来用户登录 / 会员接口复用
//   - 登录限速：同 IP 连续 5 次失败锁 15 分钟（内存 Map，尽力而为）
//
// 安全：
//   - 密码用 Node crypto scrypt（零依赖，N=16384 盐+哈希），timingSafeEqual 比对
//   - token 不含任何敏感值；HMAC-SHA256 验签
//   - 未配置 ADMIN_SECRET / FEISHU_APP_TOKEN → 管理接口默认关闭（403），安全默认
//   - 日志只打统计，绝不打印口令 / token / 哈希
//
// 环境变量：
//   ADMIN_SECRET          （必需）token 签名密钥
//   FEISHU_APP_TOKEN      （必需）飞书多维表格 app_token
//   FEISHU_USERS_TABLE_ID （可选）users 表 table_id；不配置则自动查找/创建「users」表
//   ADMIN_USERNAME        （可选）管理员登录名，默认 'admin'
//   ADMIN_PASSWORD_HASH   （可选）管理员 scrypt 哈希；users 表为空时用于首次登录自举
//   ADMIN_PASSWORD        （可选，兼容迁移）旧版单口令；users 表为空且未配 HASH 时，
//                         用兼容校验 + 首次登录自动创建 admin 账号
//
// 复用路线（详见 Obsidian「2026-08-07-账号密码体系与会员复用说明」）：
//   - 未来用户登录：转型系统邮箱验证码升级为账号体系时，users 表直接承载
//   - 会员体系：role=pro + 未来权益表
//   - 新接口预留：requireUser / registerUser / updateProfile（本期不实现，只留设计）
// ============================================================================

const crypto = require('crypto');

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
const { getTenantAccessToken } = require('./feishu-token.js');

// ---------- 常量 ----------
const DEFAULT_ADMIN_USERNAME = 'admin';       // ADMIN_USERNAME 未配置时的默认登录名
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // token 有效期 7 天

const USERS_TABLE_NAME = 'users';
// users 表字段（英文命名，便于代码直读与未来用户/会员体系复用）
const USERS_TABLE_FIELDS = [
  { field_name: 'userId', type: 1 },       // Text：主键，如 admin-masterlinc
  { field_name: 'username', type: 1 },     // Text：登录名（唯一）
  { field_name: 'passwordHash', type: 1 }, // Text：scrypt 盐+哈希（绝不存明文）
  { field_name: 'role', type: 1 },         // Text：admin / user / pro（会员体系预留）
  { field_name: 'status', type: 1 },       // Text：active / disabled
  { field_name: 'createdAt', type: 5 },    // DateTime：创建时间（毫秒）
  { field_name: 'updatedAt', type: 5 },    // DateTime：更新时间（毫秒）
  { field_name: 'lastLoginAt', type: 5 },  // DateTime：最近登录（毫秒）
  { field_name: 'nickname', type: 1 },     // Text：昵称（可选）
  { field_name: 'email', type: 1 },        // Text：邮箱（可选，未来通知/找回用）
];

let usersTableIdCache = null;

// 登录失败限速表（内存，模块级）：ip -> { count, lockedUntil }
const loginFails = new Map();
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

// ---------- users 表：查找或创建（复用 api/backup.js 自动建表模式） ----------
async function ensureUsersTable() {
  const appToken = process.env.FEISHU_APP_TOKEN;
  if (!appToken) throw new Error('FEISHU_APP_TOKEN 未配置');

  if (process.env.FEISHU_USERS_TABLE_ID) {
    usersTableIdCache = process.env.FEISHU_USERS_TABLE_ID.trim();
    return usersTableIdCache;
  }
  if (usersTableIdCache) return usersTableIdCache;

  const token = await getTenantAccessToken();

  // 1) 列出已有表
  const listRes = await fetch(
    `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables?page_size=100`,
    { headers: { Authorization: 'Bearer ' + token } }
  );
  const listData = await listRes.json().catch(() => ({}));
  if (!listData || listData.code !== 0) {
    const msg = (listData && listData.msg) ? listData.msg : 'HTTP ' + listRes.status;
    throw new Error('查询 users 表列表失败: ' + msg);
  }
  const items = (listData.data && listData.data.items) || [];
  const found = items.find((t) => t.name === USERS_TABLE_NAME);
  if (found) {
    usersTableIdCache = found.table_id;
    return found.table_id;
  }

  // 2) 没有 → 创建
  const createRes = await fetch(`${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ table: { name: USERS_TABLE_NAME, fields: USERS_TABLE_FIELDS } }),
  });
  const createData = await createRes.json().catch(() => ({}));
  if (!createData || createData.code !== 0 || !createData.data || !createData.data.table_id) {
    const msg = (createData && createData.msg) ? createData.msg : 'HTTP ' + createRes.status;
    throw new Error('创建 users 表失败: ' + msg);
  }
  usersTableIdCache = createData.data.table_id;
  console.log('[admin-auth] 已创建 users 表: table_id=' + createData.data.table_id);
  return createData.data.table_id;
}

/** 解析飞书字段值：Text 可能是字符串或 [{text}]，DateTime 是毫秒数字 */
function fieldText(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v[0] && typeof v[0].text === 'string') return v[0].text;
  return '';
}

/** 读取 users 表全部记录（users 表极小，一次拉全表 + 内存过滤足够） */
async function listUsers() {
  const appToken = process.env.FEISHU_APP_TOKEN;
  const tableId = await ensureUsersTable();
  const token = await getTenantAccessToken();
  const all = [];
  let pageToken = '';
  for (;;) {
    const url = `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records`
      + `?page_size=100` + (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '');
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    const data = await res.json().catch(() => ({}));
    if (!data || data.code !== 0) {
      const msg = (data && data.msg) ? data.msg : 'HTTP ' + res.status;
      throw new Error('读取 users 表失败: ' + msg);
    }
    const items = (data.data && data.data.items) || [];
    for (const rec of items) {
      const f = rec.fields || {};
      all.push({
        recordId: rec.record_id,
        userId: fieldText(f.userId) || fieldText(f['用户ID']),
        username: fieldText(f.username) || fieldText(f['用户名']),
        passwordHash: fieldText(f.passwordHash) || fieldText(f['密码哈希']),
        role: fieldText(f.role) || fieldText(f['角色']) || 'user',
        status: fieldText(f.status) || fieldText(f['状态']) || 'active',
        createdAt: typeof f.createdAt === 'number' ? f.createdAt : 0,
        updatedAt: typeof f.updatedAt === 'number' ? f.updatedAt : 0,
        lastLoginAt: typeof f.lastLoginAt === 'number' ? f.lastLoginAt : 0,
        nickname: fieldText(f.nickname) || fieldText(f['昵称']),
        email: fieldText(f.email) || fieldText(f['邮箱']),
      });
    }
    if (!data.data || !data.data.has_more || !data.data.page_token) break;
    pageToken = data.data.page_token;
  }
  return all;
}

/** 账号总数（判断是否需要兼容迁移 / 自举） */
async function countUsers() {
  const rows = await listUsers();
  return rows.length;
}

/** 按登录名查用户；不存在返回 null */
async function findUserByUsername(username) {
  const rows = await listUsers();
  return rows.find((u) => u.username === username) || null;
}

/** 按主键查用户；不存在返回 null */
async function findUserById(userId) {
  const rows = await listUsers();
  return rows.find((u) => u.userId === userId) || null;
}

/** 创建用户记录；返回规范化 user 对象 */
async function createUser({ userId, username, passwordHash, role = 'user', status = 'active', nickname = '', email = '' }) {
  const appToken = process.env.FEISHU_APP_TOKEN;
  const tableId = await ensureUsersTable();
  const token = await getTenantAccessToken();
  const now = Date.now();
  const fields = {
    userId, username, passwordHash, role, status,
    createdAt: now, updatedAt: now, lastLoginAt: now,
    nickname, email,
  };
  const res = await fetch(`${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data || data.code !== 0) {
    const msg = (data && data.msg) ? data.msg : 'HTTP ' + res.status;
    throw new Error('写入 users 表失败: ' + msg);
  }
  return { recordId: (data.data && data.data.record) ? data.data.record.record_id : '', userId, username, role, status, nickname, email, createdAt: now, updatedAt: now, lastLoginAt: now };
}

/** 更新用户最近登录时间（不阻塞登录主流程，失败仅告警） */
async function updateUserLastLogin(userId) {
  try {
    const appToken = process.env.FEISHU_APP_TOKEN;
    const tableId = await ensureUsersTable();
    const token = await getTenantAccessToken();
    const user = await findUserById(userId);
    if (!user || !user.recordId) return;
    // 合并全字段更新：飞书 PUT 会整体替换 fields，只传部分字段可能清空其余字段
    const fields = {
      userId: user.userId, username: user.username, passwordHash: user.passwordHash,
      role: user.role, status: user.status,
      createdAt: user.createdAt, updatedAt: Date.now(), lastLoginAt: Date.now(),
      nickname: user.nickname || '', email: user.email || '',
    };
    await fetch(`${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/${user.recordId}`, {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
  } catch (e) {
    console.warn('[admin-auth] updateUserLastLogin 失败（不影响登录）: ' + (e && e.message ? e.message : e));
  }
}

// ---------- 密码哈希（Node crypto scrypt，零依赖，盐+哈希） ----------
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_KEYLEN = 64;

function scryptAsync(password, salt, keylen, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(Buffer.from(password), salt, keylen, opts, (err, derived) => {
      if (err) reject(err); else resolve(derived);
    });
  });
}

/** 生成密码哈希：'scrypt$16384$8$1$<saltHex>$<hashHex>' */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(String(password), salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** 校验密码与存储哈希（常量时间比较） */
async function verifyPassword(password, storedHash) {
  const stored = String(storedHash || '');
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [alg, nStr, rStr, pStr, saltHex, hashHex] = parts;
  if (alg !== 'scrypt') return false;
  let salt, expected;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch (e) { return false; }
  const derived = await scryptAsync(String(password), salt, expected.length || SCRYPT_KEYLEN, {
    N: parseInt(nStr, 10) || SCRYPT_N,
    r: parseInt(rStr, 10) || SCRYPT_R,
    p: parseInt(pStr, 10) || SCRYPT_P,
  });
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

// ---------- HMAC 签名 / token 签发 ----------
function hmacSign(payloadB64) {
  const secret = process.env.ADMIN_SECRET;
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

/**
 * 签发 token（有效期 7 天）。
 * @param {{userId:string, role:string}} user 用户对象
 * @returns {{token:string, expiresAt:number}}
 */
function issueToken(user) {
  const now = Date.now();
  const payload = { sub: user && user.userId ? user.userId : 'masterlinc', role: (user && user.role) || 'admin', iat: now, exp: now + TOKEN_TTL_MS };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: payloadB64 + '.' + hmacSign(payloadB64), expiresAt: now + TOKEN_TTL_MS };
}

/**
 * 校验 token：格式 / 签名 / 过期 / 主体。
 * @returns {object|null} 有效返回 payload（含 sub=userId、role），否则 null
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return null;

  const expected = hmacSign(payloadB64);
  const a = Buffer.from(sig, 'base64url');
  const b = Buffer.from(expected, 'base64url');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload || !payload.sub) return null;
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

/** 常量时间字符串比较（兼容迁移口令比对用） */
function safeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // 长度不同也要做一次比较，避免暴露长度信息
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

// ---------- 认证 ----------
/**
 * 账号密码认证：查 users 表 + scrypt 哈希比对。
 * @returns {Promise<object|null>} 成功返回 user（含 userId/username/role/status），失败返回 null
 */
async function authenticateUser(username, password) {
  const user = await findUserByUsername(String(username || '').trim());
  if (!user) return null;
  if (user.status && user.status !== 'active') return null; // disabled 一律拒绝，不泄露状态
  const ok = await verifyPassword(String(password || ''), user.passwordHash);
  return ok ? user : null;
}

// ---------- 中间件 ----------
function authConfigured() {
  return !!(process.env.ADMIN_SECRET && process.env.FEISHU_APP_TOKEN);
}

/**
 * requireAdmin 中间件：校验 Authorization: Bearer <token> 且 role=admin。
 * 向后兼容：升级前签发的旧 token（sub='masterlinc'，无 role 字段）仍视为管理员。
 * @returns {boolean} true=通过；false=已写响应（调用方应 return）
 */
function requireAdmin(req, res) {
  if (!authConfigured()) {
    // 安全默认关闭：未配置环境变量 → 管理接口一律 403
    res.status(403).json({ ok: false, message: '管理后台未启用（缺少 ADMIN_SECRET / FEISHU_APP_TOKEN 环境变量）' });
    return false;
  }

  const auth = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) {
    res.status(401).json({ ok: false, message: '未登录：缺少 Authorization: Bearer token' });
    return false;
  }

  const payload = verifyToken(m[1].trim());
  if (!payload) {
    res.status(401).json({ ok: false, message: '登录已失效，请重新登录' });
    return false;
  }
  // 旧 token（sub=masterlinc）兼容；新 token 要求 role=admin
  if (payload.sub === 'masterlinc') return true;
  if (payload.role !== 'admin') {
    res.status(403).json({ ok: false, message: '权限不足：需要管理员账号' });
    return false;
  }
  return true;
}

/**
 * requireUser 中间件：校验 token 且 role 为 admin/user/pro —— 未来用户登录 / 会员接口复用。
 * 本期尚未有 user/pro 账号与接口，仅为架构预留。
 * @returns {boolean} true=通过；false=已写响应（调用方应 return）
 */
function requireUser(req, res) {
  if (!authConfigured()) {
    res.status(403).json({ ok: false, message: '服务未启用（缺少 ADMIN_SECRET / FEISHU_APP_TOKEN 环境变量）' });
    return false;
  }
  const auth = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) {
    res.status(401).json({ ok: false, message: '未登录：缺少 Authorization: Bearer token' });
    return false;
  }
  const payload = verifyToken(m[1].trim());
  if (!payload) {
    res.status(401).json({ ok: false, message: '登录已失效，请重新登录' });
    return false;
  }
  if (payload.sub === 'masterlinc') return true; // 旧 token 兼容
  const role = payload.role || '';
  if (!['admin', 'user', 'pro'].includes(role)) {
    res.status(403).json({ ok: false, message: '权限不足' });
    return false;
  }
  return true;
}

// ---------- 登录限速（尽力而为） ----------
/** 检查当前 IP 是否被锁；未被锁返回 { ok:true }，被锁返回 { ok:false, retryAfter } */
function checkLoginRate(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return { ok: true };
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) {
    return { ok: false, retryAfter: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
  }
  return { ok: true };
}

/** 登录失败记一次；连续 MAX_FAILS 次 → 锁 LOCK_MS */
function recordLoginFail(ip) {
  const rec = loginFails.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAILS) {
    rec.lockedUntil = Date.now() + LOCK_MS;
    rec.count = 0;
  }
  loginFails.set(ip, rec);
}

/** 登录成功清空该 IP 失败计数 */
function recordLoginSuccess(ip) {
  loginFails.delete(ip);
}

/** 清空限速表（测试用） */
function resetLoginRate() {
  loginFails.clear();
}

/** 清空 users 表缓存（测试用） */
function resetUsersCache() {
  usersTableIdCache = null;
}

module.exports = {
  DEFAULT_ADMIN_USERNAME,
  USERS_TABLE_NAME,
  TOKEN_TTL_MS,
  ensureUsersTable,
  listUsers,
  countUsers,
  findUserByUsername,
  findUserById,
  createUser,
  updateUserLastLogin,
  hashPassword,
  verifyPassword,
  authenticateUser,
  issueToken,
  verifyToken,
  safeEqualStr,
  authConfigured,
  requireAdmin,
  requireUser,
  checkLoginRate,
  recordLoginFail,
  recordLoginSuccess,
  resetLoginRate,
  resetUsersCache,
};
