// ============================================================================
// api/lead.js — Vercel Serverless Function
// selfcheck.html 邮箱线索收集代理：浏览器 POST /api/lead → 服务端写入飞书多维表格
//                                                   → 成功后自动发送《自检结果入门包》到访客邮箱
//
// 安全说明：
//   - App Secret / app_token / table_id / 邮件令牌一律从 Vercel 环境变量读取，绝不硬编码进代码或提交 git
//   - 前端只与同域 /api/lead 通信，不暴露任何凭证
//   - 生产环境变量（Vercel 面板 → Project → Settings → Environment Variables）：
//       FEISHU_APP_ID              = <开放平台 App ID>
//       FEISHU_APP_SECRET          = <开放平台 App Secret>
//       FEISHU_APP_TOKEN           = <多维表格 app_token>
//       FEISHU_TABLE_ID            = <线索表 table_id>
//       FEISHU_MAIL_REFRESH_TOKEN  = <OAuth 授权后得到的 refresh_token（推荐，服务端自动刷新）>
//       FEISHU_MAIL_USER_ACCESS_TOKEN = <OAuth 授权后得到的 user_access_token（可选，临时）>
//       FEISHU_MAIL_SENDER         = <发件邮箱地址；默认 "me"（当前授权用户主邮箱）>
//       FEISHU_KEEPALIVE_SECRET    = <可选，保活端点鉴权 secret（与 vercel.json cron 联动）>
//
// refresh_token 保活（v1.5.0）：
//   每次刷新后把新 refresh_token 写回多维表格 mail_token 表（lib/feishu-token.js）；
//   api/keepalive.js 每天由 Vercel Cron 触发一次强制续期 → 永不过期，无需每月重新授权。
//   首次运行时表格无记录，自动用 env FEISHU_MAIL_REFRESH_TOKEN 初始化。
//
// 邮件方案：飞书邮件 API（全国内链路，零外部依赖，直接用 Node 内置 fetch）
//   发送接口：POST /open-apis/mail/v1/user_mailboxes/:user_mailbox_id/messages/send
//   授权方式：用户 OAuth 授权（scope: mail:user_mailbox.message:send + offline_access）
//   附件格式：attachment[]{ body(base64url), filename }
// 未配置发信令牌时自动跳过发送（skipped），飞书线索照常落库，前端永远 ok。
//
// Vercel 自动把 /api 目录识别为 Serverless Functions；vercel.json 仅用于 Cron（每天保活一次）。
// ============================================================================

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

// 飞书 refresh_token 保活存储（多维表格方案）：负责 OAuth 刷新 + 新 refresh_token 写回表格
const { getTenantAccessToken, obtainUserMailToken } = require('../lib/feishu-token.js');

// 飞书机器人公共能力（内容工厂：事件接收 + 发消息）
const { sendFeishuText, isAllowedOpenId, verifyEventToken } = require('../lib/feishu-bot.js');

// ---------- 飞书：user_access_token（OAuth 用户身份，用于发信） ----------
/**
 * 获取发信用的 user_access_token（保活版）。
 * 链路：表格里读 refresh_token（首次用 env FEISHU_MAIL_REFRESH_TOKEN）→ OAuth 刷新
 *       → 新 refresh_token 写回多维表格 → 缓存 user token。
 * 未配置任何令牌 → 返回 null（上层跳过发送，不影响飞书线索）。
 */
async function getUserMailToken() {
  return obtainUserMailToken();
}

// ---------- 飞书：多维表格写入（不变） ----------
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

// ---------- 邮件：飞书邮件 API（全国内） ----------

// 附件清单：必须与 deliverables/ 目录实际文件名一致
// v1.10.0 业务逻辑重构：自检页免费区改为《自检结果入门包》（起步包三件套）；
// ¥29 完整工具包（方法手册+四栏模板+复查清单）为人工发货（微信收款后手动发），不经由此接口自动发。
const DELIVERABLES = [
  { file: '起步包-自检结果行动卡.md', type: 'text/markdown', name: '起步包-自检结果行动卡.md' },
  { file: '起步包-会前三问清单.md', type: 'text/markdown', name: '起步包-会前三问清单.md' },
  { file: '起步包-7天验证表.md', type: 'text/markdown', name: '起步包-7天验证表.md' },
];

// v1.21.0 Skill 专区：全集包（/skills/ 提交 source 含 skill-pack 前缀时发送）
// 附件 = 3 个精品 Skill 合集 ZIP（skill-collection-premium.zip，内含 3 个 Skill 各自完整精品包），Vercel 随仓库打包
const SKILL_PACK_FILES = [
  { file: 'skill-collection-premium.zip', name: 'AI管理现场-Skill精品合集.zip' },
];

// 解析 deliverables 目录绝对路径（兼容 Vercel 打包后的 cwd 与 __dirname 两种布局）
function deliverablesDir() {
  const candidates = [
    require('path').resolve(process.cwd(), 'deliverables'),
    require('path').resolve(__dirname, '..', 'deliverables'),
    require('path').resolve(__dirname, 'deliverables'),
  ];
  for (const dir of candidates) {
    try {
      if (require('fs').statSync(dir).isDirectory()) return dir;
    } catch (e) { /* 继续尝试下一个 */ }
  }
  return candidates[0];
}

// 解析 skills/files 目录绝对路径（Skill 全集包附件）
function skillsFilesDir() {
  const candidates = [
    require('path').resolve(process.cwd(), 'skills', 'files'),
    require('path').resolve(__dirname, '..', 'skills', 'files'),
    require('path').resolve(__dirname, 'skills', 'files'),
  ];
  for (const dir of candidates) {
    try {
      if (require('fs').statSync(dir).isDirectory()) return dir;
    } catch (e) { /* 继续尝试下一个 */ }
  }
  return candidates[0];
}

// 标准 base64 → base64url（飞书邮件 API 要求：+/ 替换为 -_，去掉尾部 =）
function toBase64Url(b64) {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 读取附件：{ filename, body(base64url), bytes }[]
function loadDeliverables() {
  const fs = require('fs');
  const path = require('path');
  const dir = deliverablesDir();
  return DELIVERABLES.map((d) => {
    const abs = path.join(dir, d.file);
    const buf = fs.readFileSync(abs);
    return { filename: d.name, body: toBase64Url(buf.toString('base64')), bytes: buf.length };
  });
}

// 读取 Skill 全集包附件：{ filename, body(base64url), bytes }[]
function loadSkillPackDeliverables() {
  const fs = require('fs');
  const path = require('path');
  const dir = skillsFilesDir();
  return SKILL_PACK_FILES.map((d) => {
    const abs = path.join(dir, d.file);
    const buf = fs.readFileSync(abs);
    return { filename: d.name, body: toBase64Url(buf.toString('base64')), bytes: buf.length };
  });
}

// 组装邮件正文（凌客风格 · 欢迎 + 入门包三件套 + 1 个升级钩子）
function buildEmailText() {
  return [
    '凌：',
    '',
    '你刚在 masterlinc.com 做完「管理者 AI 自检」，这份《自检结果入门包》已发到你的邮箱，先拿着。',
    '',
    '📎 三个附件（起步包）',
    '1. 自检结果行动卡——把「最该让 AI 先动手的那一件」落到第一步',
    '2. 会前三问清单——开会前 1 分钟，直接照着问',
    '3. 7 天验证表——一周内每天勾一次，看变化',
    '',
    '先说明白一件事：自检会告诉你「最该让 AI 先动手的是哪一件」，但它没告诉你的是——大多数人卡住，不是不会用 AI，而是那件最该改的事，恰恰是他最不想碰的。',
    '',
    '我做了 22 年管理，现场里十有八九是这样。',
    '',
    '所以问你一个具体的问题（不用现在答，想到了回我就行）：',
    '',
    '你上周，有没有一场会、一份周报，是开完/写完都知道浪费、但不得不做的？它叫什么名字？有多久？',
    '',
    '想要完整方法手册与会议四栏模板，见下方 ¥29 完整工具包。',
    '',
    '——凌',
    '在路上的 AI 管理博士',
    'masterlinc.com',
  ].join('\n');
}

/**
 * 发送《自检结果入门包》邮件（飞书邮件 API）
 * @param {string} to 访客邮箱
 * @returns {Promise<{sent: boolean, skipped?: boolean}>}
 *  - 未配置发信令牌 → 跳过发送（skipped），不抛错
 *  - 发送失败 → 抛错（由上层 catch，不影响飞书线索与前端 ok）
 */
async function sendMaterialsEmail(to) {
  const userToken = await getUserMailToken();
  if (!userToken) {
    console.warn('[api/lead] FEISHU_MAIL_REFRESH_TOKEN / FEISHU_MAIL_USER_ACCESS_TOKEN 未配置，跳过资料邮件发送（飞书线索已保留）');
    return { sent: false, skipped: true };
  }

  const mailboxId = process.env.FEISHU_MAIL_SENDER || 'me'; // 默认当前授权用户主邮箱
  const attachments = loadDeliverables();

  const payload = {
    subject: '你的《自检结果入门包》已到',
    to: [{ mail_address: to }],
    body_plain_text: buildEmailText(),
    attachments,
    dedupe_key: 'selfcheck-' + to + '-' + Date.now(), // 防重复发送（同用户并发时接口单用户串行）
  };

  // 10 秒超时，避免飞书慢响应拖住 Serverless（Vercel 免费函数最长 10s 量级）
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

// 组装 Skill 全集包邮件正文（凌客风格 · 3 张精品合集 ZIP + 1 个自检钩子）
function buildSkillPackEmailText() {
  return [
    '凌：',
    '',
    '你在 masterlinc.com 领的「AI 管理现场 · Skill 精品合集」，给你发过来了——3 张精品方法卡打包在一个 ZIP 里，一次收藏。',
    '',
    '里面有：',
    '· 管理者 AI 效率审计——记录一周，算出你可释放的时间，找到 AI 最该插手的 TOP 3',
    '· AI 会议纪要·四栏法——1 小时录音变成一页四栏决议，责任才落得下来',
    '· AI 写周报法——周报从 3 小时压到 20 分钟',
    '',
    '每个 Skill 都是完整精品包：能直接装进 AI 助手的技能文件 + 精品方法卡 + 使用说明。适合想一口气收藏、再慢慢挑着用的人——先存着，总有一张能帮上忙。',
    '',
    '我的建议：别一口气全看，先挑一个最疼的场景试 7 天。比如你每周被周报拖 3 小时，就只练「AI 写周报法」，拿 7 天验证表记数字。',
    '',
    '拿不准该先改哪件？可以做一次免费自检（10 分钟，测出你最该先动的那件事）：',
    '',
    'masterlinc.com/products/selfcheck.html',
    '',
    '工具免费，判断值钱。',
    '',
    '——凌',
    '在路上的 AI 管理博士',
    'masterlinc.com',
  ].join('\n');
}

/**
 * 发送《Skill 全集包》邮件（飞书邮件 API；/skills/ 全集包邮箱换，source 含 skill-pack）
 * @param {string} to 访客邮箱
 * @returns {Promise<{sent: boolean, skipped?: boolean}>}
 *  - 未配置发信令牌 → 跳过发送（skipped），不抛错
 *  - 发送失败 → 抛错（由上层 catch，不影响飞书线索与前端 ok）
 */
async function sendSkillPackEmail(to) {
  const userToken = await getUserMailToken();
  if (!userToken) {
    console.warn('[api/lead] FEISHU_MAIL_REFRESH_TOKEN / FEISHU_MAIL_USER_ACCESS_TOKEN 未配置，跳过 Skill 全集包邮件发送（飞书线索已保留）');
    return { sent: false, skipped: true };
  }

  const mailboxId = process.env.FEISHU_MAIL_SENDER || 'me'; // 默认当前授权用户主邮箱
  const attachments = loadSkillPackDeliverables();

  const payload = {
    subject: '你要的 3 张 Skill 精品卡，打包在这封邮件里',
    to: [{ mail_address: to }],
    body_plain_text: buildSkillPackEmailText(),
    attachments,
    dedupe_key: 'skill-pack-' + to + '-' + Date.now(), // 防重复发送（同用户并发时接口单用户串行）
  };

  // 10 秒超时，避免飞书慢响应拖住 Serverless（Vercel 免费函数最长 10s 量级）
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

// ============================================================================
// 用户反馈（v1.25.1 合并自 api/feedback.js——为修复 Vercel 免费版函数数超限）
// 公开提交 /api/feedback 由 vercel.json rewrites 路由到本函数，按 path/body.type 分流。
// 与线索分开：线索=营销漏斗（有自动发信），反馈=产品改进信号（无任何发信逻辑）。
// 同一 app_token，不同表（user_feedback）；表结构/防刷逻辑与原 api/feedback.js 一致。
// ============================================================================
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
  return first || (req.socket && req.socket.remoteAddress) || '0.0.0.0';
}

// ---------- 反馈表管理：查找或创建 user_feedback 表 ----------
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
  console.log('[api/lead] 已创建 user_feedback 表: table_id=' + createData.data.table_id);
  return createData.data.table_id;
}

// ---------- 反馈写入 ----------
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

// ---------- 反馈 Handler（/api/feedback，由外层 handler 分流进入） ----------
async function handleFeedback(req, res, body) {
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
    console.log(`[api/lead] 收到反馈 type=${type} len=${content.length} page=${page || '-'} recordId=${recordId} 邮箱=${email ? 'yes' : 'no'}`);
    res.status(200).json({
      ok: true,
      id: recordId,
      message: '收到！这条反馈已经进我的改进清单。谢谢你不嫌麻烦说出来 🙏 你说的问题，我会认真改。',
      // 个保法：注明邮箱用途
      emailNote: email ? '你留下的邮箱仅用于回访（改好了告诉你一声），不用于营销。' : '匿名提交，反馈同样有效。',
    });
  } catch (err) {
    console.error('[api/lead] 反馈 ' + (err && err.message ? err.message : err));
    // 不向客户端暴露飞书内部错误细节
    res.status(502).json({ ok: false, message: '服务暂时不可用，请稍后重试' });
  }
}

// ============================================================================
// 发布任务队列（v1.27.1 合并自 api/publish.js——为修复 Vercel 免费版函数数超限）
// 公开端点 /api/publish 由 vercel.json rewrites 路由到本函数，按 req.url 分流。
// Transition OS 内容发布工作台：飞书多维表格任务队列 + 账号配置。
//   表「publish_tasks」：发布任务队列
//   表「publish_config」：账号配置（AppSecret 用 PUBLISH_ENC_KEY 简单异或混淆后存储）
// 端点（与前端 transition-os.html 发布模块完全一致，前端零改动）：
//   POST /api/publish                          → 创建发布任务（写入飞书表 publish_tasks）
//   GET  /api/publish?op=pending&key=xxx       → Proma 本机拉取待办任务（需 x-publish-key）
//   POST /api/publish?op=done                  → Proma 回写发布结果（需 x-publish-key）
//   GET  /api/publish?op=config                → 读账号配置（脱敏；同域页面可用）
//   POST /api/publish?op=config&key=xxx        → 写账号配置（需 x-publish-key，Secret 加密脱敏）
//   GET  /api/publish?op=list&userId=masterlinc→ 页面显示最近任务
// ============================================================================

const TASK_TABLE_NAME = 'publish_tasks';
const TASK_TABLE_FIELDS = [
  { field_name: '任务ID', type: 1 },       // Text
  { field_name: '创建时间', type: 5 },     // DateTime
  { field_name: '用户', type: 1 },         // Text
  { field_name: '标题', type: 1 },         // Text
  { field_name: '正文', type: 1 },         // Text（Markdown 母稿）
  { field_name: '选项', type: 1 },         // Text（JSON：封面/图文/平台开关）
  { field_name: '状态', type: 1 },         // Text：pending/processing/done/failed
  { field_name: '执行时间', type: 5 },     // DateTime
  { field_name: '结果', type: 1 },         // Text（JSON：各平台 media_id/url/错误）
  { field_name: '备注', type: 1 },         // Text
];

const CONFIG_TABLE_NAME = 'publish_config';
const CONFIG_TABLE_FIELDS = [
  { field_name: '配置键', type: 1 },       // Text：wechat_mp / xiaohongshu / jike
  { field_name: '配置值', type: 1 },       // Text（JSON，Secret 混淆）
  { field_name: '更新时间', type: 5 },     // DateTime
  { field_name: '备注', type: 1 },         // Text
];

let taskTableIdCache = null;
let configTableIdCache = null;

// ---------- 工具：简单混淆（不用于高安全场景，仅防明文落库） ----------
function obfuscate(s) {
  const key = process.env.PUBLISH_ENC_KEY || 'transition-publish-default';
  if (!s) return '';
  let out = '';
  for (let i = 0; i < s.length; i++) {
    out += String.fromCharCode(s.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return 'obf:' + Buffer.from(out, 'binary').toString('base64');
}
function deobfuscate(s) {
  const key = process.env.PUBLISH_ENC_KEY || 'transition-publish-default';
  if (!s || !s.startsWith('obf:')) return s || '';
  const buf = Buffer.from(s.slice(4), 'base64').toString('binary');
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    out += String.fromCharCode(buf.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out;
}

// ---------- 表管理 ----------
async function ensureTable(tableName, fields) {
  const appToken = process.env.FEISHU_APP_TOKEN;
  if (!appToken) throw new Error('FEISHU_APP_TOKEN 未配置');
  const token = await getTenantAccessToken();

  const listRes = await fetch(`${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables?page_size=100`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  const listData = await listRes.json().catch(() => ({}));
  if (!listData || listData.code !== 0) throw new Error('查询表列表失败: ' + ((listData && listData.msg) || listRes.status));
  const found = ((listData.data && listData.data.items) || []).find((t) => t.name === tableName);
  if (found) return found.table_id;

  const createRes = await fetch(`${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ table: { name: tableName, default_view_name: '主表', fields } }),
  });
  const createData = await createRes.json().catch(() => ({}));
  if (!createData || createData.code !== 0) throw new Error('创建表失败: ' + ((createData && createData.msg) || createRes.status));
  return createData.data.table_id;
}

async function taskTable() {
  if (taskTableIdCache) return taskTableIdCache;
  taskTableIdCache = await ensureTable(TASK_TABLE_NAME, TASK_TABLE_FIELDS);
  return taskTableIdCache;
}
async function configTable() {
  if (configTableIdCache) return configTableIdCache;
  configTableIdCache = await ensureTable(CONFIG_TABLE_NAME, CONFIG_TABLE_FIELDS);
  return configTableIdCache;
}

// ---------- 记录读写 ----------
async function addRecord(tableId, fields) {
  const appToken = process.env.FEISHU_APP_TOKEN;
  const token = await getTenantAccessToken();
  const res = await fetch(`${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ fields }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data || data.code !== 0) throw new Error('写入记录失败: ' + ((data && data.msg) || res.status));
  return data.data.record;
}

async function listRecords(tableId, pageSize) {
  const appToken = process.env.FEISHU_APP_TOKEN;
  const token = await getTenantAccessToken();
  const url = `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=${pageSize || 20}`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json().catch(() => ({}));
  if (!data || data.code !== 0) throw new Error('读取记录失败: ' + ((data && data.msg) || res.status));
  return (data.data && data.data.items) || [];
}

async function updateRecord(tableId, recordId, fields) {
  const appToken = process.env.FEISHU_APP_TOKEN;
  const token = await getTenantAccessToken();
  const res = await fetch(`${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ fields }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data || data.code !== 0) throw new Error('更新记录失败: ' + ((data && data.msg) || res.status));
  return data.data.record;
}

// ---------- 鉴权 ----------
function checkKey(req, res) {
  const expected = process.env.PUBLISH_KEY;
  if (!expected) {
    res.status(403).json({ ok: false, message: 'PUBLISH_KEY 未配置，本操作已禁用' });
    return false;
  }
  const got = req.headers['x-publish-key'];
  if (got !== expected) {
    res.status(403).json({ ok: false, message: 'x-publish-key 无效' });
    return false;
  }
  return true;
}

function readBody(req) {
  try {
    return (typeof req.body === 'object' && req.body !== null) ? req.body : JSON.parse(req.body || '{}');
  } catch (e) {
    return null;
  }
}

// ---------- 任务/配置逻辑 ----------
async function createTask(body) {
  const title = String(body.title || '').trim().slice(0, 200);
  const content = String(body.content || '').slice(0, 50000);
  const userId = String(body.userId || 'masterlinc').slice(0, 100);
  const options = body.options && typeof body.options === 'object' ? JSON.stringify(body.options) : '{}';
  if (!title) throw new Error('缺少标题');
  const tableId = await taskTable();
  const record = await addRecord(tableId, {
    '任务ID': 'pub_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    '创建时间': Date.now(),
    '用户': userId,
    '标题': title,
    '正文': content,
    '选项': options,
    '状态': 'pending',
    '备注': '由 Transition OS 发布工作台创建',
  });
  const taskId = record.fields['任务ID'];
  return { taskId };
}

async function listTasks(userId, limit) {
  const tableId = await taskTable();
  const items = await listRecords(tableId, limit || 20);
  const rows = items.map((r) => {
    const f = r.fields || {};
    return {
      recordId: r.record_id,
      taskId: f['任务ID'] || '',
      ts: f['创建时间'] || 0,
      userId: f['用户'] || '',
      title: f['标题'] || '',
      status: f['状态'] || '',
      options: safeParse(f['选项']),
      result: safeParse(f['结果']),
      note: f['备注'] || '',
    };
  });
  const filtered = userId ? rows.filter((r) => r.userId === userId) : rows;
  return filtered.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, limit || 20);
}

async function listPending() {
  const tableId = await taskTable();
  const items = await listRecords(tableId, 50);
  return items
    .map((r) => ({ recordId: r.record_id, fields: r.fields || {} }))
    .filter((r) => r.fields['状态'] === 'pending')
    .map((r) => ({
      recordId: r.recordId,
      taskId: r.fields['任务ID'] || '',
      ts: r.fields['创建时间'] || 0,
      userId: r.fields['用户'] || '',
      title: r.fields['标题'] || '',
      content: r.fields['正文'] || '',
      options: safeParse(r.fields['选项']),
    }));
}

async function markDone(body) {
  const taskId = String(body.taskId || '');
  const status = String(body.status || 'done');
  if (!taskId) throw new Error('缺少 taskId');
  const tableId = await taskTable();
  const items = await listRecords(tableId, 50);
  const rec = items.find((r) => (r.fields || {})['任务ID'] === taskId);
  if (!rec) throw new Error('任务不存在: ' + taskId);
  const result = body.result && typeof body.result === 'object' ? JSON.stringify(body.result) : '{}';
  await updateRecord(tableId, rec.record_id, {
    '状态': status === 'failed' ? 'failed' : 'done',
    '执行时间': Date.now(),
    '结果': result,
    '备注': body.note ? String(body.note).slice(0, 500) : (rec.fields['备注'] || ''),
  });
  return { ok: true, taskId, status };
}

// ---------- 配置读写 ----------
const CONFIG_DEFAULTS = {
  wechat_mp: { appId: '', appSecretSet: false, ipWhitelist: '', ipWhitelistStatus: 'unknown' },
  xiaohongshu: { nickname: '', loginStatus: 'unknown' },
  jike: { loginStatus: 'unknown' },
};

async function getConfigPublic() {
  const tableId = await configTable();
  const items = await listRecords(tableId, 50);
  const out = JSON.parse(JSON.stringify(CONFIG_DEFAULTS));
  for (const r of items) {
    const f = r.fields || {};
    const key = f['配置键'] || '';
    const val = safeParse(f['配置值']);
    if (!val) continue;
    if (key === 'wechat_mp') {
      out.wechat_mp.appId = val.appId || '';
      out.wechat_mp.appSecretSet = !!(val.appSecret && deobfuscate(val.appSecret));
      out.wechat_mp.ipWhitelist = val.ipWhitelist || '';
      out.wechat_mp.ipWhitelistStatus = val.ipWhitelistStatus || 'unknown';
    } else if (key === 'xiaohongshu') {
      out.xiaohongshu = { nickname: val.nickname || '', loginStatus: val.loginStatus || 'unknown' };
    } else if (key === 'jike') {
      out.jike = { loginStatus: val.loginStatus || 'unknown' };
    }
  }
  return out;
}

async function setConfig(body) {
  const key = String(body.key || '');
  if (!['wechat_mp', 'xiaohongshu', 'jike'].includes(key)) throw new Error('未知配置键');
  const val = body.value && typeof body.value === 'object' ? body.value : {};
  let store = JSON.parse(JSON.stringify(val));
  if (key === 'wechat_mp' && store.appSecret) {
    store.appSecret = obfuscate(String(store.appSecret));
    store.appSecretSet = true;
  }
  const tableId = await configTable();
  const items = await listRecords(tableId, 50);
  const rec = items.find((r) => (r.fields || {})['配置键'] === key);
  const fields = {
    '配置键': key,
    '配置值': JSON.stringify(store),
    '更新时间': Date.now(),
    '备注': '由发布工作台更新',
  };
  if (rec) await updateRecord(tableId, rec.record_id, fields);
  else await addRecord(tableId, fields);
  return { ok: true, key };
}

function safeParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

// ---------- 发布 Handler（/api/publish，由外层 handler 分流进入） ----------
async function handlePublish(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const op = url.searchParams.get('op') || '';

  try {
    // GET 配置（脱敏）
    if (op === 'config' && req.method === 'GET') {
      const cfg = await getConfigPublic();
      res.status(200).json({ ok: true, data: cfg });
      return;
    }

    // GET pending（Proma 拉取待办）
    if (op === 'pending' && req.method === 'GET') {
      if (!checkKey(req, res)) return;
      const tasks = await listPending();
      res.status(200).json({ ok: true, count: tasks.length, tasks });
      return;
    }

    // GET list（页面显示最近任务）
    if (op === 'list' && req.method === 'GET') {
      const userId = url.searchParams.get('userId') || '';
      const limit = Number(url.searchParams.get('limit') || '20');
      const tasks = await listTasks(userId, limit);
      res.status(200).json({ ok: true, count: tasks.length, tasks });
      return;
    }

    // POST done（Proma 回写）
    if (op === 'done' && req.method === 'POST') {
      if (!checkKey(req, res)) return;
      const body = readBody(req);
      if (!body) { res.status(400).json({ ok: false, message: '请求体不是合法 JSON' }); return; }
      const r = await markDone(body);
      res.status(200).json(r);
      return;
    }

    // POST config（写配置）
    if (op === 'config' && req.method === 'POST') {
      if (!checkKey(req, res)) return;
      const body = readBody(req);
      if (!body) { res.status(400).json({ ok: false, message: '请求体不是合法 JSON' }); return; }
      const r = await setConfig(body);
      res.status(200).json(r);
      return;
    }

    // POST 创建任务
    if (req.method === 'POST') {
      const body = readBody(req);
      if (!body) { res.status(400).json({ ok: false, message: '请求体不是合法 JSON' }); return; }
      const r = await createTask(body);
      res.status(200).json({ ok: true, ...r });
      return;
    }

    res.status(405).json({ ok: false, message: 'Method Not Allowed' });
  } catch (err) {
    console.error('[api/lead] publish ' + (err && err.message ? err.message : err));
    res.status(502).json({ ok: false, message: '服务暂时不可用，请稍后重试' });
  }
}

// ---------- 飞书内容工厂（v1.28.0 合并自 api/feishu-event.js / api/feishu-notify.js） ----------
// 为修复 Vercel 免费版函数数超限，飞书机器人端点合并进本函数，由 vercel.json rewrites 分流：
//   /api/feishu-event   → 事件订阅（URL 验证 + im.message.receive_v1 → 创建发布任务 + 回执）
//   /api/feishu-notify  → 内容工厂完成通知（Proma 分发后调用，x-publish-key 鉴权）

function parseFeishuBody(req) {
  if (typeof req.body === 'object' && req.body !== null) return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (e) { return null; }
}

async function handleFeishuEvent(req, res) {
  // URL 验证（飞书 POST {"challenge":"xxx"} → 原样返回）
  const challengeBody = parseFeishuBody(req);
  if (challengeBody && challengeBody.challenge) {
    res.status(200).json({ challenge: challengeBody.challenge });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, message: 'Method Not Allowed' });
    return;
  }

  const event = parseFeishuBody(req);
  if (!event) {
    res.status(400).json({ ok: false, message: 'invalid json' });
    return;
  }
  if (!verifyEventToken(event)) {
    res.status(403).json({ ok: false, message: 'invalid event token' });
    return;
  }

  const eventType = (event.header && event.header.event_type) || event.type || '';
  try {
    if (eventType !== 'im.message.receive_v1') {
      res.status(200).json({ ok: true, skipped: 'unhandled:' + eventType });
      return;
    }

    const ev = event.event || {};
    const sender = ev.sender || {};
    const msg = ev.message || {};
    const senderOpenId = (sender.sender_id && sender.sender_id.open_id) || '';
    const chatId = msg.chat_id || '';
    const msgType = msg.message_type || '';

    if (!isAllowedOpenId(senderOpenId)) {
      res.status(200).json({ ok: true, skipped: 'not-allowed' });
      return;
    }
    if (msgType !== 'text') {
      res.status(200).json({ ok: true, skipped: 'not-text:' + msgType });
      return;
    }

    let text = '';
    try { text = String((JSON.parse(msg.content || '{}').text) || '').trim(); } catch (e) { /* ignore */ }
    if (!text) {
      res.status(200).json({ ok: true, skipped: 'empty-text' });
      return;
    }

    const title = text.slice(0, 200);
    const { taskId } = await createTask({
      title,
      content: '',
      userId: 'feishu:' + (senderOpenId.slice(0, 16) || 'unknown'),
      options: { source: 'feishu', replyChatId: chatId, replyOpenId: senderOpenId, chatType: msg.chat_type || 'p2p' },
    });

    await sendFeishuText(chatId, `收到 ✅ 内容工厂开始加工：\n「${title}」\n⏳ 预计 10-20 分钟，完成后我会通知你审核发布。`);
    res.status(200).json({ ok: true, taskId });
  } catch (err) {
    console.error('[lead] feishu-event ' + (err && err.message ? err.message : err));
    const chatId = ((event.event || {}).message || {}).chat_id || '';
    if (chatId) {
      try {
        await sendFeishuText(chatId, '⚠️ 内容工厂处理失败：' + (err.message || '未知错误') + '\n请稍后重试。');
      } catch (e) { /* ignore */ }
    }
    res.status(200).json({ ok: false, message: 'handled-with-error' });
  }
}

async function handleFeishuNotify(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, message: 'Method Not Allowed' });
    return;
  }
  const expected = process.env.PUBLISH_KEY;
  const got = req.headers['x-publish-key'];
  if (!expected || got !== expected) {
    res.status(403).json({ ok: false, message: 'x-publish-key 无效' });
    return;
  }
  const body = parseFeishuBody(req);
  if (!body || !body.chatId) {
    res.status(400).json({ ok: false, message: '缺少 chatId' });
    return;
  }
  const defaultText = '✅ 内容工厂完成：三平台草稿已就绪，请审核后发布。';
  try {
    const r = await sendFeishuText(body.chatId, String(body.text || defaultText), body.receiveIdType || 'chat_id');
    res.status(200).json({ ok: true, ...r });
  } catch (err) {
    console.error('[lead] feishu-notify ' + (err && err.message ? err.message : err));
    // 返回 200 + ok:false 携带真实错误信息（Vercel 对 5xx 会吞 body，不便于排查）
    res.status(200).json({ ok: false, error: (err && err.message) ? err.message : String(err) });
  }
}

// ---------- handler ----------

module.exports = async function handler(req, res) {
  // CORS：与静态站同域部署（/api/lead、/api/feedback、/api/publish），一般无需；如跨域调试再加
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-publish-key');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // v1.27.1 分流：/api/publish（vercel.json rewrites 路由到本函数）→ 发布任务队列
  const isPublishPath = (req.url || '').indexOf('/api/publish') !== -1;
  if (isPublishPath) {
    return handlePublish(req, res);
  }

  // v1.28.0 分流：/api/feishu-event（vercel.json rewrites 路由到本函数）→ 飞书事件订阅
  const isFeishuEventPath = (req.url || '').indexOf('/api/feishu-event') !== -1;
  if (isFeishuEventPath) {
    return handleFeishuEvent(req, res);
  }
  // v1.28.0 分流：/api/feishu-notify（vercel.json rewrites 路由到本函数）→ 内容工厂完成通知
  const isFeishuNotifyPath = (req.url || '').indexOf('/api/feishu-notify') !== -1;
  if (isFeishuNotifyPath) {
    return handleFeishuNotify(req, res);
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

  // v1.25.1 分流：/api/feedback（vercel.json rewrites 路由到本函数）→ 用户反馈逻辑
  //   双保险：① req.url 路径含 /api/feedback（Vercel rewrites 对函数保留原始路径）
  //           ② body.type 在反馈类型白名单中（反馈必带 type，线索请求不会有该字段值）
  const isFeedbackPath = (req.url || '').indexOf('/api/feedback') !== -1;
  const fbType = String(body.type || '').trim();
  if (isFeedbackPath || FEEDBACK_TYPES.indexOf(fbType) !== -1) {
    return handleFeedback(req, res, body);
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

    // 飞书写入成功 → 尝试自动发送资料邮件（失败只记录，不影响线索和前端返回）
    // source 以 skill-pack 开头 → 发《Skill 全集包》；否则维持自检页《入门包》逻辑
    const isSkillPack = (source || '').indexOf('skill-pack') === 0;
    let emailSent = false;
    try {
      const r = isSkillPack ? await sendSkillPackEmail(email) : await sendMaterialsEmail(email);
      emailSent = !!r.sent;
      if (r.skipped) {
        // 未配置发信：线索照常，前端看到成功，不会暴露内部状态
      }
    } catch (err) {
      console.error('[api/lead] 资料邮件发送失败: ' + (err && err.message ? err.message : err));
    }

    res.status(200).json({ ok: true, emailSent });
  } catch (err) {
    console.error('[api/lead] ' + (err && err.message ? err.message : err));
    // 不向客户端暴露飞书内部错误细节
    res.status(502).json({ ok: false, message: '服务暂时不可用，请稍后重试或邮件联系我们' });
  }
};

// 导出内部函数供本地单测（Vercel 只调用 module.exports 本身，附加属性不影响）
module.exports.sendMaterialsEmail = sendMaterialsEmail;
module.exports.sendSkillPackEmail = sendSkillPackEmail;
module.exports.loadDeliverables = loadDeliverables;
module.exports.loadSkillPackDeliverables = loadSkillPackDeliverables;
module.exports.buildEmailText = buildEmailText;
module.exports.buildSkillPackEmailText = buildSkillPackEmailText;
module.exports.toBase64Url = toBase64Url;
module.exports.getUserMailToken = getUserMailToken;

// 反馈（合并自 api/feedback.js）导出，供本地单测
module.exports.FEEDBACK_TABLE_NAME = FEEDBACK_TABLE_NAME;
module.exports.FEEDBACK_TYPES = FEEDBACK_TYPES;
module.exports.FEEDBACK_STATUSES = FEEDBACK_STATUSES;
module.exports.ensureFeedbackTable = ensureFeedbackTable;
module.exports.writeFeedback = writeFeedback;
module.exports.clientIp = clientIp;
module.exports.checkRate = checkRate;
module.exports.handleFeedback = handleFeedback;
module.exports.resetRate = function resetRate() { rateMap.clear(); };

// 发布任务队列（合并自 api/publish.js）导出，供本地单测
module.exports.handlePublish = handlePublish;
module.exports._publish = { createTask, listTasks, listPending, markDone, getConfigPublic, setConfig, obfuscate, deobfuscate };

// 飞书内容工厂（合并自 api/feishu-event.js / api/feishu-notify.js）导出，供本地单测
module.exports.handleFeishuEvent = handleFeishuEvent;
module.exports.handleFeishuNotify = handleFeishuNotify;
module.exports.parseFeishuBody = parseFeishuBody;
