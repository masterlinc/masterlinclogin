// ============================================================================
// api/transition-welcome.js — Vercel Serverless Function
// 转型操作系统首次引导「邮箱轻验证」：浏览器 POST /api/transition-welcome
//   → 复用飞书邮件链路（lib/feishu-token.js 保活令牌）自动发送《欢迎加入转型系统》欢迎信
//
// 设计说明（方案：轻验证，只发欢迎信、不做格式验证之外的真伪校验）：
//   - 首次引导提交后由前端 fire-and-forget 调用，发送失败不阻断前端（静默降级）
//   - 只校验邮箱格式 + 长度；不要求用户点链接、不收验证码（阶段一「只存不验证」为主）
//   - 欢迎信内容：凌客风格一句话 + 资料指向（详见 buildWelcomeText）
//   - 不写入线索表（lead.js 是自检页线索；转型系统用户邮箱随云备份 db 上传，防丢失用途）
//
// 安全说明：
//   - 令牌一律从 Vercel 环境变量 / mail_token 表读取（同 lead.js 链路），不硬编码
//   - 失败只记日志，不向客户端暴露内部细节；前端永远得到 ok
// ============================================================================

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

// 复用保活令牌链路（与 lead.js 共用：refresh_token 存多维表格 mail_token 表，自动轮换）
const { obtainUserMailToken } = require('../lib/feishu-token.js');

// ---------- 欢迎信正文（凌客风格：一句话 + 资料指向 + 不催回复） ----------
function buildWelcomeText(nickname) {
  const name = (nickname || '').trim() || '朋友';
  return [
    name + '：',
    '',
    '欢迎加入「转型操作系统」——你刚刚花 30 秒，给自己搭好了一个每天只花 15-30 分钟的长期积累台。',
    '',
    '接下来 90 天，系统每天会告诉你四件事：今天什么日子（红/黄/绿）→ 今天唯一该做的动作 → 做完算资产还是证据 → 1 行微复盘闭环。方向由你设定的 90 天母线钉住，不用每天想该干嘛。',
    '',
    '这封邮件不需要回复，也不会打扰你。它只做一件事：当你换手机、清缓存时，用它找回你的数据（邮箱仅用于防丢失与数据找回）。',
    '',
    '资料指向：',
    '· 日常打开：masterlinc.com/products/transition-os.html',
    '· 有问题：回复本邮件，或邮件联系 lincyang@foxmail.com',
    '',
    '——凌',
    '在路上的 AI 管理博士',
    'masterlinc.com',
  ].join('\n');
}

/**
 * 发送《欢迎加入转型系统》欢迎信（飞书邮件 API）
 * @param {string} to 访客邮箱
 * @param {string} nickname 昵称（可选）
 * @returns {Promise<{sent: boolean, skipped?: boolean}>}
 *  - 未配置发信令牌 → 跳过（skipped），不抛错
 *  - 发送失败 → 抛错（由上层 catch，前端仍 ok）
 */
async function sendWelcomeEmail(to, nickname) {
  const userToken = await obtainUserMailToken();
  if (!userToken) {
    console.warn('[api/transition-welcome] 发信令牌未配置，跳过欢迎信发送（不阻断）');
    return { sent: false, skipped: true };
  }

  const mailboxId = process.env.FEISHU_MAIL_SENDER || 'me'; // 默认当前授权用户主邮箱
  const payload = {
    subject: '欢迎加入转型系统 · Transition OS',
    to: [{ mail_address: to }],
    body_plain_text: buildWelcomeText(nickname),
    dedupe_key: 'transition-welcome-' + to + '-' + Date.now(), // 防重复发送
  };

  // 10 秒超时，避免飞书慢响应拖住 Serverless
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const url = `${FEISHU_BASE}/mail/v1/user_mailboxes/${encodeURIComponent(mailboxId)}/messages/send`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + userToken,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));

    if (!data || data.code !== 0) {
      const msg = (data && data.msg) ? data.msg : 'HTTP ' + res.status;
      throw new Error('飞书邮件发送失败: ' + msg);
    }
    return { sent: true, code: data.code, message_id: data.data && data.data.message_id };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- handler ----------

module.exports = async function handler(req, res) {
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
  const nickname = String(body.nickname || '').trim().slice(0, 20);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ ok: false, message: '邮箱格式不正确' });
    return;
  }

  // 轻验证：只存不验证为主；发欢迎信不阻塞前端、失败静默降级
  let emailSent = false;
  try {
    const r = await sendWelcomeEmail(email, nickname);
    emailSent = !!r.sent;
  } catch (err) {
    console.error('[api/transition-welcome] 欢迎信发送失败: ' + (err && err.message ? err.message : err));
  }

  res.status(200).json({ ok: true, emailSent });
};

// 导出内部函数供本地单测
module.exports.sendWelcomeEmail = sendWelcomeEmail;
module.exports.buildWelcomeText = buildWelcomeText;
