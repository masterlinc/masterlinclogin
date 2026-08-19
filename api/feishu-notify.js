// ============================================================================
// api/feishu-notify.js — 内容工厂完成通知端点
// 用途：Proma automation 完成三平台草稿分发后，调用本端点
//       → 飞书机器人推送「草稿已就绪，请审核发布」到指定会话
// 鉴权：x-publish-key（与 api/publish 同密钥）
// 请求：POST /api/feishu-notify
//   body: { chatId: "oc_xxx", text?: "自定义通知文本", receiveIdType?: "chat_id"|"open_id" }
// ============================================================================

const { sendFeishuText } = require('../lib/feishu-bot.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, message: 'Method Not Allowed' });
    return;
  }

  // 鉴权：x-publish-key
  const expected = process.env.PUBLISH_KEY;
  const got = req.headers['x-publish-key'];
  if (!expected || got !== expected) {
    res.status(403).json({ ok: false, message: 'x-publish-key 无效' });
    return;
  }

  let body = null;
  try {
    body = (typeof req.body === 'object' && req.body !== null) ? req.body : JSON.parse(req.body || '{}');
  } catch (e) { /* ignore */ }
  if (!body || !body.chatId) {
    res.status(400).json({ ok: false, message: '缺少 chatId' });
    return;
  }

  const defaultText = '✅ 内容工厂完成：三平台草稿已就绪，请审核后发布。';
  try {
    const r = await sendFeishuText(body.chatId, String(body.text || defaultText), body.receiveIdType || 'chat_id');
    res.status(200).json({ ok: true, ...r });
  } catch (err) {
    console.error('[feishu-notify]', err && err.message ? err.message : err);
    res.status(502).json({ ok: false, message: '发送失败: ' + (err.message || '') });
  }
};
