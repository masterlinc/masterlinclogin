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

// ---------- handler ----------

module.exports = async function handler(req, res) {
  // CORS：与静态站同域部署（/api/lead），一般无需；如跨域调试再加
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
