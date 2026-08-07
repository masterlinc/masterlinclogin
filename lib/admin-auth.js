// ============================================================================
// lib/admin-auth.js — 管理后台鉴权（口令 + HMAC 会话 token）
//
// 用途（对齐管理后台技术方案 §四）：
//   - POST /api/admin/login 校验 ADMIN_PASSWORD → 签发 HMAC 签名 token（7 天有效）
//   - 所有 /api/admin/* 统一 requireAdmin(req, res) 校验 Bearer token
//
// 安全：
//   - 口令用 timingSafeEqual 常量时间比较，防时序攻击
//   - token 只含 { sub:'masterlinc', iat, exp }，不含任何敏感值；HMAC-SHA256 验签
//   - 未配置 ADMIN_PASSWORD / ADMIN_SECRET → 管理接口默认关闭（403），与 backup.js
//     读端「未配置口令默认禁用」同一安全默认
//   - 登录限速：内存 Map 记录失败次数（同 IP 连续 5 次失败锁 15 分钟）；
//     Serverless 多实例下不精确，属尽力而为兜底（流量极小）
//   - 日志只打统计，绝不打印口令 / token
// ============================================================================

const crypto = require('crypto');

const ADMIN_UID = 'masterlinc';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

// 登录失败限速表（内存，模块级）：ip -> { count, lockedUntil }
const loginFails = new Map();
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

// ---------- HMAC 签名 / token 签发 ----------
function hmacSign(payloadB64) {
  const secret = process.env.ADMIN_SECRET;
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

/** 签发 token（有效期 7 天） */
function issueToken() {
  const now = Date.now();
  const payload = { sub: ADMIN_UID, iat: now, exp: now + TOKEN_TTL_MS };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: payloadB64 + '.' + hmacSign(payloadB64), expiresAt: now + TOKEN_TTL_MS };
}

/**
 * 校验 token：格式 / 签名 / 过期 / 主体。
 * @returns {object|null} 有效返回 payload，否则 null
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
  if (!payload || payload.sub !== ADMIN_UID) return null;
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

/** 常量时间字符串比较（口令比对用） */
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

/**
 * requireAdmin 中间件：校验 Authorization: Bearer <token>。
 * @returns {boolean} true=通过；false=已写响应（调用方应 return）
 */
function requireAdmin(req, res) {
  const password = process.env.ADMIN_PASSWORD;
  const secret = process.env.ADMIN_SECRET;
  if (!password || !secret) {
    // 安全默认关闭：未配置环境变量 → 管理接口一律 403
    res.status(403).json({ ok: false, message: '管理后台未启用（缺少 ADMIN_PASSWORD / ADMIN_SECRET 环境变量）' });
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

module.exports = {
  ADMIN_UID,
  TOKEN_TTL_MS,
  issueToken,
  verifyToken,
  safeEqualStr,
  requireAdmin,
  checkLoginRate,
  recordLoginFail,
  recordLoginSuccess,
  resetLoginRate,
};
