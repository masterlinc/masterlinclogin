// ============================================================================
// lib/feishu-bot.js — 飞书机器人公共能力（tenant token + 发消息 + 白名单）
// 供 api/feishu-event.js（收消息）与 api/feishu-notify.js（发通知）共用
//
// 双应用架构（2026-08-19）：
//   机器人收发消息 → 独立应用（FEISHU_BOT_APP_ID / FEISHU_BOT_APP_SECRET）
//   多维表格/邮件    → 既有应用（FEISHU_APP_ID / FEISHU_APP_SECRET，lead.js 继续用）
//   原因：用户机器人配置在新应用；若全局替换 app 会导致网站线索/飞书邮件 OAuth 断开
//
// 环境变量（Vercel 面板 → Settings → Environment Variables）：
//   FEISHU_BOT_APP_ID / FEISHU_BOT_APP_SECRET — 机器人专用应用（必配，缺省回退 FEISHU_APP_*）
//   FEISHU_ALLOW_OPEN_ID                — 可选：允许触发机器人的用户 open_id（逗号分隔）
//   FEISHU_VERIFY_TOKEN                 — 可选：事件订阅 Verification Token（校验事件来源）
// ============================================================================

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

// ---------- tenant_access_token（模块级缓存） ----------
let tokenCache = null;

async function getTenantAccessToken() {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now) return tokenCache.token;

  const appId = process.env.FEISHU_BOT_APP_ID || process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_BOT_APP_SECRET || process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) throw new Error('FEISHU_BOT_APP_ID/FEISHU_BOT_APP_SECRET（或 FEISHU_APP_ID/SECRET）未配置');

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

  const expireSec = Number(data.expire || 7200);
  tokenCache = {
    token: data.tenant_access_token,
    expiresAt: now + expireSec * 1000 - 60000, // 提前 1 分钟过期，避免临界
  };
  return tokenCache.token;
}

// ---------- 发送文本消息（chat_id 或 open_id 均可作 receive_id） ----------
async function sendFeishuText(receiveId, text, receiveIdType = 'chat_id') {
  if (!receiveId) throw new Error('缺少 receive_id');
  const token = await getTenantAccessToken();
  const res = await fetch(`${FEISHU_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text: String(text).slice(0, 4000) }),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data || data.code !== 0) {
    const msg = (data && data.msg) ? data.msg : 'HTTP ' + res.status;
    throw new Error('发送飞书消息失败: ' + msg);
  }
  return data.data;
}

// ---------- 白名单：谁的消息允许触发内容工厂 ----------
function isAllowedOpenId(openId) {
  const allow = (process.env.FEISHU_ALLOW_OPEN_ID || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (allow.length === 0) return true; // 未配置 → 默认放行（部署后建议尽快配置）
  return allow.includes(String(openId || '').trim());
}

// ---------- 事件来源校验（可选，配置 FEISHU_VERIFY_TOKEN 后生效） ----------
function verifyEventToken(event) {
  const expected = process.env.FEISHU_VERIFY_TOKEN;
  if (!expected) return true; // 未配置 → 不校验
  const got = (event.header && event.header.token) || event.token || '';
  return got === expected;
}

module.exports = { getTenantAccessToken, sendFeishuText, isAllowedOpenId, verifyEventToken };
