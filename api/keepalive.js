// ============================================================================
// api/keepalive.js — 飞书发信 refresh_token 保活端点
//
// 用途：即使没有访客提交，也让 refresh_token 每天自动刷新续期（永不过期）。
//   1) 从多维表格读 refresh_token（首次用 env FEISHU_MAIL_REFRESH_TOKEN 初始化）
//   2) 调 OAuth 刷新 → 拿新 user_access_token + 新 refresh_token
//   3) 把新 refresh_token 写回多维表格（完成轮换续期）
//
// 触发方式：
//   - Vercel Cron（vercel.json crons）：每天一次 GET /api/keepalive
//   - 也可由 Proma 定时任务 / 外部监控每天调一次
//
// 安全：
//   - 不输出完整 token，日志只显示长度/前后缀
//   - 可选的 FEISHU_KEEPALIVE_SECRET 环境变量做鉴权（Authorization: Bearer <secret>），
//     未配置时不强制鉴权（端点只刷新 token 不泄露任何敏感值；Vercel Cron 自带鉴权头）
// ============================================================================

const {
  obtainUserMailToken,
  readStoredRefreshToken,
  maskToken,
} = require('../lib/feishu-token.js');

function isAuthorized(req) {
  const secret = process.env.FEISHU_KEEPALIVE_SECRET;
  if (!secret) {
    // 未配置 secret：Vercel Cron 请求会带 x-vercel-cron / authorization 头；本地 curl 也放行（幂等安全）
    return true;
  }
  const auth = (req.headers && req.headers.authorization) || '';
  const expected = 'Bearer ' + secret;
  const xCron = (req.headers && req.headers['x-vercel-cron']) || '';
  return auth === expected || xCron === secret;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ ok: false, message: 'Method Not Allowed' });
    return;
  }
  if (!isAuthorized(req)) {
    res.status(403).json({ ok: false, message: 'Forbidden' });
    return;
  }

  const startedAt = Date.now();
  try {
    // forceRefresh=true：绕过 user token 缓存，强制刷新一次（续期 refresh_token）
    const token = await obtainUserMailToken({ forceRefresh: true });
    if (!token) {
      res.status(200).json({
        ok: true,
        rotated: false,
        reason: 'no mail token configured (FEISHU_MAIL_REFRESH_TOKEN / FEISHU_MAIL_USER_ACCESS_TOKEN)',
        costMs: Date.now() - startedAt,
      });
      return;
    }

    const stored = await readStoredRefreshToken().catch(() => null);
    res.status(200).json({
      ok: true,
      rotated: true,
      stored: !!stored,
      tokenMask: maskToken(token),
      costMs: Date.now() - startedAt,
    });
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    console.error('[api/keepalive] 保活刷新失败: ' + msg);
    res.status(500).json({ ok: false, message: 'keepalive failed', costMs: Date.now() - startedAt });
  }
};

module.exports.isAuthorized = isAuthorized;
