// ============================================================================
// api/admin/login.js — 管理后台登录
//
// POST /api/admin/login  body: { password }
//   - 口令与 ADMIN_PASSWORD 常量时间比较（timingSafeEqual）
//   - 成功签发 HMAC token（有效期 7 天，ADMIN_SECRET 签名，payload 只含
//     sub:'masterlinc' / iat / exp，不含任何敏感值）
//   - 未配置 ADMIN_PASSWORD / ADMIN_SECRET → 403（安全默认关闭）
//   - 登录限速：同 IP 连续失败 5 次锁 15 分钟（内存 Map，尽力而为）
//   - 日志只打统计，绝不打印口令 / token
// ============================================================================

const {
  issueToken, safeEqualStr, checkLoginRate,
  recordLoginFail, recordLoginSuccess,
} = require('../../lib/admin-auth.js');

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'] || '';
  const first = String(fwd).split(',')[0].trim();
  return first || (req.socket && req.socket.remoteAddress) || '0.0.0.0';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, message: 'Method Not Allowed' }); return; }

  const password = process.env.ADMIN_PASSWORD;
  const secret = process.env.ADMIN_SECRET;
  if (!password || !secret) {
    res.status(403).json({ ok: false, message: '管理后台未启用（缺少 ADMIN_PASSWORD / ADMIN_SECRET 环境变量）' });
    return;
  }

  let body;
  try {
    body = (typeof req.body === 'object' && req.body !== null) ? req.body : JSON.parse(req.body || '{}');
  } catch (e) {
    res.status(400).json({ ok: false, message: '请求体不是合法 JSON' });
    return;
  }

  const ip = clientIp(req);
  const rate = checkLoginRate(ip);
  if (!rate.ok) {
    res.status(429).json({ ok: false, message: '尝试次数过多，请稍后再试', retryAfter: rate.retryAfter });
    return;
  }

  const candidate = String(body.password || '');
  if (!candidate || !safeEqualStr(candidate, password)) {
    recordLoginFail(ip);
    res.status(401).json({ ok: false, message: '口令不正确' });
    return;
  }

  recordLoginSuccess(ip);
  const { token, expiresAt } = issueToken();
  console.log('[api/admin/login] ok ip=' + ip);
  res.status(200).json({ ok: true, token, expiresAt, expiresIn: 7 * 24 * 60 * 60 });
};

module.exports.clientIp = clientIp;
