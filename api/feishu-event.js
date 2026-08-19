// ============================================================================
// api/feishu-event.js — 飞书事件订阅端点
// 职责：
//   1. URL 验证（飞书后台配置事件订阅时发 challenge，须原样返回）
//   2. 接收 im.message.receive_v1：用户在飞书对机器人说话
//      → 创建发布任务（复用 api/lead.js 的 _publish.createTask）
//      → 立即回执「收到，内容工厂开始加工」
// 安全：
//   - 默认仅处理文本消息；发消息人受 FEISHU_ALLOW_OPEN_ID 白名单约束
//   - 事件来源用 FEISHU_VERIFY_TOKEN 校验（可选）
// 注意：飞书要求 3 秒内响应，本函数内完成建任务+回执（通常 1-2 秒）
// ============================================================================

const { sendFeishuText, isAllowedOpenId, verifyEventToken } = require('../lib/feishu-bot.js');
const { _publish } = require('./lead.js');

// ---------- 解析请求体 ----------
function parseBody(req) {
  if (typeof req.body === 'object' && req.body !== null) return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (e) { return null; }
}

// ---------- URL 验证：飞书 POST {"challenge":"xxx"} → 原样返回 ----------
function handleChallenge(req, res) {
  const body = parseBody(req);
  if (body && body.challenge) {
    res.status(200).json({ challenge: body.challenge });
    return true;
  }
  return false;
}

// ---------- 处理单条消息 ----------
async function handleMessage(event) {
  const header = event.header || {};
  const ev = event.event || {};
  const sender = ev.sender || {};
  const msg = ev.message || {};

  const senderOpenId = (sender.sender_id && sender.sender_id.open_id) || '';
  const chatId = msg.chat_id || '';
  const chatType = msg.chat_type || 'p2p'; // p2p 私聊 / group 群聊
  const msgType = msg.message_type || '';

  // 白名单
  if (!isAllowedOpenId(senderOpenId)) {
    return { skipped: 'not-allowed', sender: senderOpenId.slice(0, 16) };
  }

  // 只处理文本消息
  if (msgType !== 'text') return { skipped: 'not-text:' + msgType };

  let text = '';
  try {
    text = String((JSON.parse(msg.content || '{}').text) || '').trim();
  } catch (e) { /* ignore */ }
  if (!text) return { skipped: 'empty-text' };

  // 创建发布任务（标题 = 用户原话；正文留空由内容工厂按主题生成）
  const title = text.slice(0, 200);
  const { taskId } = await _publish.createTask({
    title,
    content: '',
    userId: 'feishu:' + (senderOpenId.slice(0, 16) || 'unknown'),
    options: {
      source: 'feishu',
      replyChatId: chatId,
      replyOpenId: senderOpenId,
      chatType,
    },
  });

  // 立即回执
  await sendFeishuText(
    chatId,
    `收到 ✅ 内容工厂开始加工：\n「${title}」\n⏳ 预计 10-20 分钟，完成后我会通知你审核发布。`
  );

  return { ok: true, taskId };
}

// ---------- 主 handler ----------
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // URL 验证（GET 或 POST 都可能）
  if (req.method === 'GET') {
    return handleChallenge(req, res);
  }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, message: 'Method Not Allowed' });
    return;
  }

  // challenge 优先
  if (handleChallenge(req, res)) return;

  const event = parseBody(req);
  if (!event) {
    res.status(400).json({ ok: false, message: 'invalid json' });
    return;
  }

  // 事件来源校验
  if (!verifyEventToken(event)) {
    res.status(403).json({ ok: false, message: 'invalid event token' });
    return;
  }

  const eventType = (event.header && event.header.event_type) || event.type || '';
  try {
    if (eventType === 'im.message.receive_v1') {
      const r = await handleMessage(event);
      res.status(200).json({ ok: true, ...r });
    } else if (eventType === 'url_verification') {
      res.status(200).json({ challenge: event.challenge });
    } else {
      // 其他事件（消息已读等）直接 200，不处理
      res.status(200).json({ ok: true, skipped: 'unhandled:' + eventType });
    }
  } catch (err) {
    console.error('[feishu-event]', err && err.message ? err.message : err);
    // 建任务失败也回执，避免用户干等
    const ev = event.event || {};
    const chatId = (ev.message && ev.message.chat_id) || '';
    if (chatId) {
      try {
        await sendFeishuText(chatId, '⚠️ 内容工厂处理失败：' + (err.message || '未知错误') + '\n请稍后重试，或直接告诉我在公众号/小红书发布。');
      } catch (e) { /* ignore */ }
    }
    res.status(200).json({ ok: false, message: 'handled-with-error' });
  }
};
