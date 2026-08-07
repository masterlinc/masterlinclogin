// ============================================================================
// api/feedback.js — Vercel Serverless Function
// 用户反馈提交代理（全站入口：驾驶舱设置页「关于」区 + 全站页脚）：
//   浏览器 POST /api/feedback → 服务端校验 → 写入飞书多维表格「user_feedback」表
//
// 与线索（api/lead.js）严格分开：
//   - 线索 = 营销漏斗输入（有自动发资料邮件逻辑，混入会误触发发信）
//   - 反馈 = 产品改进信号（真实用户用得不顺时主动说，无任何发信逻辑）
//   两者同进飞书多维表格（同一 app_token），但不同表、不同口径。
//
// 表结构「user_feedback」（服务端自动建表，复用 api/backup.js ensure 模式）：
//   反馈类型   SingleSelect（用得不顺 / 有 bug / 想要新功能 / 其他）
//   反馈描述   Text（必填，10~500 字）
//   邮箱       Text（可选，仅用于回访；列表默认脱敏，不用于营销）
//   来源版本   Text（如 v1.22.0）
//   来源页面   Text（如 products/transition-os.html）
//   设备ID     Text（匿名 uid 前 8 位，用于关联行为日志）
//   提交时间   DateTime（毫秒时间戳）
//   状态       SingleSelect（新 / 已读 / 已修 / 已回复，默认「新」）
//   备注       Text（masterlinc 后台内部备注）
//
// 防刷（轻量，内存 Map，Serverless 尽力而为，别吓跑真实用户）：
//   - 同一 IP 60 秒内不可重复提交
//   - 同一 IP 每日最多 5 条
//   - 描述长度 10~500 字、类型白名单、邮箱格式（可选）
//
// 个保法：邮箱仅用户自愿填写且仅用于回访；反馈记录只含邮箱 + 匿名设备 ID，
// 不含微信/手机等隐私字段。匿名可提交，不降级不拦截。
//
// 环境变量：FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_APP_TOKEN（复用现有）
//           FEISHU_FEEDBACK_TABLE_ID（可选；不配置则自动查找/创建 user_feedback 表）
// ============================================================================

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
const { getTenantAccessToken } = require('../lib/feishu-token.js');

const FEEDBACK_TABLE_NAME = 'user_feedback';
const FEEDBACK_TYPES = ['用得不顺', '有 bug', '想要新功能', '其他'];
const FEEDBACK_STATUSES = ['新', '已读', '已修', '已回复'];
const FEEDBACK_TABLE_FIELDS = [
  { field_name: '反馈类型', type: 3, property: { options: FEEDBACK_TYPES.map((t) => ({ name: t })) } }, // SingleSelect
  { field_name: '反馈描述', type: 1 },       // Text
  { field_name: '邮箱', type: 1 },           // Text（可选，仅回访）
  { field_name: '来源版本', type: 1 },       // Text
  { field_name: '来源页面', type: 1 },       // Text
  { field_name: '设备ID', type: 1 },         // Text（匿名，前 8 位）
  { field_name: '提交时间', type: 5 },       // DateTime：毫秒时间戳
  { field_name: '状态', type: 3, property: { options: FEEDBACK_STATUSES.map((s) => ({ name: s })) } }, // SingleSelect
  { field_name: '备注', type: 1 },           // Text（后台内部备注）
];

const CONTENT_MIN = 10;    // 描述最少 10 字
const CONTENT_MAX = 500;   // 描述最多 500 字
const RATE_SECONDS = 60;   // 同 IP 60 秒内不可重复提交
const RATE_DAILY_MAX = 5;  // 同 IP 每日最多 5 条

let feedbackTableIdCache = null;

// 防刷表（模块级内存，多实例不精确，属兜底）：
//   `ip` -> { dayKey, count, lastAt }
const rateMap = new Map();
function dayKey() { return new Date().toISOString().slice(0, 10); } // UTC 自然日，够用

function checkRate(ip) {
  const now = Date.now();
  const key = dayKey();
  const rec = rateMap.get(ip);
  if (!rec) {
    rateMap.set(ip, { dayKey: key, count: 1, lastAt: now });
    return { ok: true };
  }
  if (rec.dayKey !== key) {
    // 跨天重置
    rec.dayKey = key;
    rec.count = 1;
    rec.lastAt = now;
    return { ok: true };
  }
  if (now - rec.lastAt < RATE_SECONDS * 1000) {
    return { ok: false, reason: 'freq', retryAfter: Math.ceil((RATE_SECONDS * 1000 - (now - rec.lastAt)) / 1000) };
  }
  if (rec.count >= RATE_DAILY_MAX) {
    return { ok: false, reason: 'daily' };
  }
  rec.count += 1;
  rec.lastAt = now;
  return { ok: true };
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'] || '';
  const first = String(fwd).split(',')[0].trim();
  return first || req.socket && req.socket.remoteAddress || '0.0.0.0';
}

// ---------- 表管理：查找或创建 user_feedback 表 ----------
async function ensureFeedbackTable() {
  const appToken = process.env.FEISHU_APP_TOKEN;
  if (!appToken) throw new Error('FEISHU_APP_TOKEN 未配置');

  // 优先使用环境变量指定表（无需查找）
  if (process.env.FEISHU_FEEDBACK_TABLE_ID) {
    feedbackTableIdCache = process.env.FEISHU_FEEDBACK_TABLE_ID.trim();
    return feedbackTableIdCache;
  }
  if (feedbackTableIdCache) return feedbackTableIdCache;

  const token = await getTenantAccessToken();

  // 1) 列出已有表
  const listRes = await fetch(
    `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables?page_size=100`,
    { headers: { Authorization: 'Bearer ' + token } }
  );
  const listData = await listRes.json().catch(() => ({}));
  if (!listData || listData.code !== 0) {
    const msg = (listData && listData.msg) ? listData.msg : 'HTTP ' + listRes.status;
    throw new Error('查询多维表格表列表失败: ' + msg);
  }
  const items = (listData.data && listData.data.items) || [];
  const found = items.find((t) => t.name === FEEDBACK_TABLE_NAME);
  if (found) {
    feedbackTableIdCache = found.table_id;
    return found.table_id;
  }

  // 2) 没有 → 创建（单选字段带 options，与服务端常量一致）
  const createRes = await fetch(`${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ table: { name: FEEDBACK_TABLE_NAME, fields: FEEDBACK_TABLE_FIELDS } }),
  });
  const createData = await createRes.json().catch(() => ({}));
  if (!createData || createData.code !== 0 || !createData.data || !createData.data.table_id) {
    const msg = (createData && createData.msg) ? createData.msg : 'HTTP ' + createRes.status;
    throw new Error('创建 user_feedback 表失败: ' + msg);
  }
  feedbackTableIdCache = createData.data.table_id;
  console.log('[api/feedback] 已创建 user_feedback 表: table_id=' + createData.data.table_id);
  return createData.data.table_id;
}

// ---------- 飞书写入 ----------
async function writeFeedback(fields) {
  const appToken = process.env.FEISHU_APP_TOKEN;
  const tableId = await ensureFeedbackTable();
  const token = await getTenantAccessToken();

  const res = await fetch(`${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data || data.code !== 0) {
    const msg = (data && data.msg) ? data.msg : 'HTTP ' + res.status;
    throw new Error('写入 user_feedback 失败: ' + msg);
  }
  return data.data;
}

// ---------- Handler ----------
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, message: 'Method Not Allowed' }); return; }

  let body;
  try {
    body = (typeof req.body === 'object' && req.body !== null) ? req.body : JSON.parse(req.body || '{}');
  } catch (e) {
    res.status(400).json({ ok: false, message: '请求体不是合法 JSON' });
    return;
  }

  // ---------- 校验 ----------
  const type = String(body.type || '').trim();
  if (!FEEDBACK_TYPES.includes(type)) {
    res.status(400).json({ ok: false, message: '反馈类型无效' });
    return;
  }
  const content = String(body.content || '').trim();
  if (content.length < CONTENT_MIN) {
    res.status(400).json({ ok: false, message: '再说具体一点，我才能改对（至少 ' + CONTENT_MIN + ' 个字）' });
    return;
  }
  if (content.length > CONTENT_MAX) {
    res.status(400).json({ ok: false, message: '描述过长，请精简到 ' + CONTENT_MAX + ' 字以内' });
    return;
  }
  const email = String(body.email || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ ok: false, message: '邮箱格式不正确（可不填）' });
    return;
  }
  if (email.length > 200) {
    res.status(400).json({ ok: false, message: '邮箱字段过长' });
    return;
  }

  // meta：版本 / 来源页 / 匿名设备 ID（兼容顶层字段与 meta 对象）
  const meta = (body.meta && typeof body.meta === 'object') ? body.meta : {};
  const version = String(meta.version || body.version || '').slice(0, 50);
  const page = String(meta.page || body.page || '').slice(0, 200);
  let deviceId = String(meta.deviceId || body.deviceId || '').slice(0, 64);
  if (deviceId) deviceId = deviceId.replace(/[^\w-]/g, '').slice(0, 8); // 匿名化：只保留前 8 位字母数字

  // ---------- 防刷（IP 维度：60 秒 / 每日 5 条） ----------
  const ip = clientIp(req);
  const rate = checkRate(ip);
  if (!rate.ok) {
    res.status(429).json({ ok: false, message: rate.reason === 'freq' ? '你刚刚提交过了，等一会儿再试（' + rate.retryAfter + ' 秒）' : '今天提交的反馈够多了，明天再来吧 🙏' });
    return;
  }

  try {
    const fields = {
      '反馈类型': type,
      '反馈描述': content,
      '邮箱': email || '',
      '来源版本': version || '',
      '来源页面': page || '',
      '设备ID': deviceId || '',
      '提交时间': Date.now(),
      '状态': '新',
      '备注': '',
    };
    const created = await writeFeedback(fields);
    const recordId = (created && created.record) ? created.record.record_id : '';
    console.log(`[api/feedback] 收到反馈 type=${type} len=${content.length} page=${page || '-'} recordId=${recordId} 邮箱=${email ? 'yes' : 'no'}`);
    res.status(200).json({
      ok: true,
      id: recordId,
      message: '收到！这条反馈已经进我的改进清单。谢谢你不嫌麻烦说出来 🙏 你说的问题，我会认真改。',
      // 个保法：注明邮箱用途
      emailNote: email ? '你留下的邮箱仅用于回访（改好了告诉你一声），不用于营销。' : '匿名提交，反馈同样有效。',
    });
  } catch (err) {
    console.error('[api/feedback] ' + (err && err.message ? err.message : err));
    // 不向客户端暴露飞书内部错误细节
    res.status(502).json({ ok: false, message: '服务暂时不可用，请稍后重试' });
  }
};

// 导出内部函数供本地单测（Vercel 只调用 module.exports 本身，附加属性不影响）
module.exports.FEEDBACK_TABLE_NAME = FEEDBACK_TABLE_NAME;
module.exports.FEEDBACK_TYPES = FEEDBACK_TYPES;
module.exports.FEEDBACK_STATUSES = FEEDBACK_STATUSES;
module.exports.FEEDBACK_TABLE_FIELDS = FEEDBACK_TABLE_FIELDS;
module.exports.ensureFeedbackTable = ensureFeedbackTable;
module.exports.writeFeedback = writeFeedback;
module.exports.clientIp = clientIp;
module.exports.checkRate = checkRate;
module.exports.resetRate = function resetRate() { rateMap.clear(); };
