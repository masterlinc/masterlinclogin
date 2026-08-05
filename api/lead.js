// ============================================================================
// api/lead.js — Vercel Serverless Function
// selfcheck.html 邮箱线索收集代理：浏览器 POST /api/lead → 服务端写入飞书多维表格
//
// 安全说明：
//   - App Secret / app_token / table_id 一律从 Vercel 环境变量读取，绝不硬编码进代码或提交 git
//   - 前端只与同域 /api/lead 通信，不暴露任何飞书凭证
//   - 生产环境变量（Vercel 面板 → Project → Settings → Environment Variables）：
//       FEISHU_APP_ID      = <开放平台 App ID>
//       FEISHU_APP_SECRET  = <开放平台 App Secret>
//       FEISHU_APP_TOKEN   = <多维表格 app_token>
//       FEISHU_TABLE_ID    = <线索表 table_id>
//
// Vercel 自动把 /api 目录识别为 Serverless Functions，无需 vercel.json。
// ============================================================================

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

// tenant_access_token 缓存（token 有效期 2 小时，这里缓存 7000 秒留余量）
let tokenCache = null;

async function getTenantAccessToken() {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now) {
    return tokenCache.token;
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
  tokenCache = { token: data.tenant_access_token, expiresAt };
  return data.tenant_access_token;
}

async function writeRecord(fields) {
  const appToken = process.env.FEISHU_APP_TOKEN;
  const tableId = process.env.FEISHU_TABLE_ID;
  if (!appToken || !tableId) {
    throw new Error('FEISHU_APP_TOKEN / FEISHU_TABLE_ID 未配置');
  }

  const token = await getTenantAccessToken();
  const res = await fetch(`${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });
  const data = await res.json().catch(() => ({}));

  if (!data || data.code !== 0) {
    const msg = (data && data.msg) ? data.msg : 'HTTP ' + res.status;
    throw new Error('写入多维表格失败: ' + msg);
  }
  return data.data;
}

module.exports = async function handler(req, res) {
  // CORS：与静态站同域部署（/api/lead），一般无需；如跨域调试再加
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, message: 'Method Not Allowed' });
    return;
  }

  let body;
  try {
    body = (typeof req.body === 'object' && req.body !== null) ? req.body : JSON.parse(req.body || '{}');
  } catch (e) {
    res.status(400).json({ ok: false, message: '请求体不是合法 JSON' });
    return;
  }

  const email = String(body.email || '').trim();
  const question = String(body.question || '').trim();
  const source = String(body.source || '').trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ ok: false, message: '邮箱格式不正确' });
    return;
  }
  if (source && source.length > 100) {
    res.status(400).json({ ok: false, message: '来源渠道字段过长' });
    return;
  }
  if (question && question.length > 2000) {
    res.status(400).json({ ok: false, message: '问题描述过长' });
    return;
  }

  try {
    // 字段需与多维表格「线索」表的字段名完全一致
    // 注意：Text 字段（type 1）必须传字符串格式，不能传 {text: ...} 对象，否则飞书返回 TextFieldConvFail(1254060)
    // DateTime 字段（type 5）传毫秒时间戳数字
    const fields = {
      '邮箱': email,
      '最想解决的问题': question || '',
      '来源渠道': source || '直接访问',
      '提交时间': Date.now(),
      '数据使用同意': '是',
    };
    await writeRecord(fields);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[api/lead] ' + (err && err.message ? err.message : err));
    // 不向客户端暴露飞书内部错误细节
    res.status(502).json({ ok: false, message: '服务暂时不可用，请稍后重试或邮件联系我们' });
  }
};
