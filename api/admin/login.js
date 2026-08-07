// ============================================================================
// api/admin/login.js — 账号密码登录
//
// POST /api/admin/login  body: { username, password }
//   - 认证走通用认证模块 lib/admin-auth.js：查飞书 users 表 + scrypt 哈希比对
//   - 成功签发 HMAC token（有效期 7 天，ADMIN_SECRET 签名，payload 含
//     sub=userId + role，不含任何敏感值）
//   - 未配置环境变量 → 403（安全默认关闭）
//   - 兼容迁移：users 表为空且配置了 ADMIN_PASSWORD_HASH / ADMIN_PASSWORD →
//     首次登录自动创建管理员账号（用户名 = ADMIN_USERNAME 或 'admin'），
//     旧部署无需手动建表即可平滑升级
//   - 登录限速：同 IP 连续失败 5 次锁 15 分钟（内存 Map，尽力而为）
//   - 日志只打统计，绝不打印口令 / token / 哈希
//
// 环境变量：ADMIN_SECRET（必需）、FEISHU_APP_TOKEN（必需）、
//   FEISHU_USERS_TABLE_ID（可选）、ADMIN_USERNAME（可选，默认 admin）、
//   ADMIN_PASSWORD_HASH（可选，scrypt 哈希）、ADMIN_PASSWORD（可选，兼容迁移）
// ============================================================================

const {
  DEFAULT_ADMIN_USERNAME,
  countUsers, createUser, authenticateUser, updateUserLastLogin,
  issueToken, verifyPassword, safeEqualStr, hashPassword,
  checkLoginRate, recordLoginFail, recordLoginSuccess,
  ensureUsersTable,
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

  // 安全默认：未配置签名密钥 / 飞书凭据 → 登录接口关闭
  if (!process.env.ADMIN_SECRET || !process.env.FEISHU_APP_TOKEN) {
    res.status(403).json({ ok: false, message: '管理后台未启用（缺少 ADMIN_SECRET / FEISHU_APP_TOKEN 环境变量）' });
    return;
  }

  let body;
  try {
    body = (typeof req.body === 'object' && req.body !== null) ? req.body : JSON.parse(req.body || '{}');
  } catch (e) {
    res.status(400).json({ ok: false, message: '请求体不是合法 JSON' });
    return;
  }

  const username = String(body.username || '').trim().slice(0, 100);
  const password = String(body.password || '');
  if (!username || !password) {
    res.status(400).json({ ok: false, message: '请输入用户名和密码' });
    return;
  }

  const ip = clientIp(req);
  const rate = checkLoginRate(ip);
  if (!rate.ok) {
    res.status(429).json({ ok: false, message: '尝试次数过多，请稍后再试', retryAfter: rate.retryAfter });
    return;
  }

  try {
    await ensureUsersTable();
    const userCount = await countUsers();

    let user = null;
    if (userCount === 0) {
      // ---- 首次登录自举 / 兼容迁移 ----
      // 旧部署只有 ADMIN_PASSWORD：校验通过后自动创建 admin 账号（scrypt 哈希）
      // 或直接提供 ADMIN_PASSWORD_HASH（scrypt 哈希），无需知道明文
      let ok = false;
      let passwordHash = null;
      if (process.env.ADMIN_PASSWORD_HASH) {
        ok = await verifyPassword(password, process.env.ADMIN_PASSWORD_HASH);
        if (ok) passwordHash = process.env.ADMIN_PASSWORD_HASH.trim();
      } else if (process.env.ADMIN_PASSWORD) {
        ok = safeEqualStr(password, process.env.ADMIN_PASSWORD);
        if (ok) passwordHash = await hashPassword(password);
      } else {
        // users 表为空且无任何自举凭据 → 安全默认关闭
        res.status(403).json({ ok: false, message: '管理后台未启用（未配置管理员凭据）' });
        return;
      }
      if (!ok || !passwordHash) {
        recordLoginFail(ip);
        res.status(401).json({ ok: false, message: '用户名或密码错误' });
        return;
      }
      const uname = (process.env.ADMIN_USERNAME || DEFAULT_ADMIN_USERNAME).trim() || DEFAULT_ADMIN_USERNAME;
      const userId = 'admin-' + uname;
      user = await createUser({
        userId, username: uname, passwordHash,
        role: 'admin', status: 'active',
        nickname: '管理员', email: '',
      });
      console.log('[api/admin/login] 兼容迁移：已自动创建管理员账号 userId=' + userId);
      // 兼容迁移时若请求用户名不同，以实际创建的管理员为准
      if (uname !== username) {
        // 用已创建的账号登录（避免双账号歧义）
        user = await authenticateUser(uname, password) || user;
      }
    } else {
      // ---- 常规账号认证 ----
      user = await authenticateUser(username, password);
      if (!user) {
        recordLoginFail(ip);
        res.status(401).json({ ok: false, message: '用户名或密码错误' });
        return;
      }
    }

    // 登录成功：更新 lastLoginAt（不阻塞主流程）+ 签发 token
    if (user && user.userId) updateUserLastLogin(user.userId).catch(() => {});
    recordLoginSuccess(ip);
    const { token, expiresAt } = issueToken(user);
    console.log('[api/admin/login] ok username=' + (user.username || username) + ' role=' + user.role + ' ip=' + ip);
    res.status(200).json({
      ok: true, token, expiresAt, expiresIn: 7 * 24 * 60 * 60,
      role: user.role, userId: user.userId, username: user.username || username,
    });
  } catch (err) {
    console.error('[api/admin/login] ' + (err && err.message ? err.message : err));
    res.status(502).json({ ok: false, message: '服务暂时不可用，请稍后重试' });
  }
};

module.exports.clientIp = clientIp;
