// ============================================================================
// api/lead.js — Vercel Serverless Function
// selfcheck.html 邮箱线索收集代理：浏览器 POST /api/lead → 服务端写入飞书多维表格
//                                                   → 成功后自动发送《管理者 AI 自检配套资料》到访客邮箱
//
// 安全说明：
//   - App Secret / app_token / table_id / 邮件 API key 一律从 Vercel 环境变量读取，绝不硬编码进代码或提交 git
//   - 前端只与同域 /api/lead 通信，不暴露任何凭证
//   - 生产环境变量（Vercel 面板 → Project → Settings → Environment Variables）：
//       FEISHU_APP_ID      = <开放平台 App ID>
//       FEISHU_APP_SECRET  = <开放平台 App Secret>
//       FEISHU_APP_TOKEN   = <多维表格 app_token>
//       FEISHU_TABLE_ID    = <线索表 table_id>
//       RESEND_API_KEY     = <Resend API Key（可选，未配置则自动跳过发信，飞书线索照常落库）>
//       RESEND_FROM        = <发件人，默认 凌 <hello@masterlinc.com>（需先在 Resend 验证 masterlinc.com 域名）>
//
// 邮件方案：Resend（零依赖，直接用 Node 内置 fetch 调 REST API，附件为 base64）
// 附件来源：仓库 deliverables/ 目录（Vercel 打包进函数，函数包 < 50MB 限制）
//
// Vercel 自动把 /api 目录识别为 Serverless Functions，无需 vercel.json。
// ============================================================================

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
const RESEND_BASE = 'https://api.resend.com/emails';

// ---------- 飞书：tenant_access_token（缓存 7000 秒，token 有效期 2 小时） ----------
let tokenCache = null;

async function getTenantAccessToken() {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now) {
    return tokenCache.token;
  }

  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('FEISHU_APP_ID / FEISHU_APP_SECRET 未配置');
  }

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

  const expiresAt = Date.now() + Math.max(60, (data.expire || 7200) - 200) * 1000;
  tokenCache = { token: data.tenant_access_token, expiresAt };
  return data.tenant_access_token;
}

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

// ---------- 邮件：Resend REST API（零依赖） ----------

// 附件清单：必须与 deliverables/ 目录实际文件名一致
const DELIVERABLES = [
  { file: 'AI会议闭环四栏方法手册.pdf', type: 'application/pdf', name: 'AI会议闭环四栏方法手册.pdf' },
  { file: '会议闭环四栏模板.md', type: 'text/markdown', name: '会议闭环四栏模板.md' },
  { file: '3-真实现场案例.md', type: 'text/markdown', name: '3-真实现场案例.md' },
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

// 读取附件：{ filename, content(base64) }[]
function loadDeliverables() {
  const fs = require('fs');
  const path = require('path');
  const dir = deliverablesDir();
  return DELIVERABLES.map((d) => {
    const abs = path.join(dir, d.file);
    const buf = fs.readFileSync(abs);
    return { filename: d.name, content: buf.toString('base64'), type: d.type, bytes: buf.length };
  });
}

// 组装邮件正文（凌客风格 · 300 字内 · 欢迎 + 资料 + 1 个轻钩子）
function buildEmailText() {
  return [
    '凌：',
    '',
    '你刚在 masterlinc.com 做完「管理者 AI 自检」，这份配套资料已发到你的邮箱，先拿着。',
    '',
    '📎 三个附件',
    '1. 《AI 会议闭环四栏方法手册》PDF——五步落地清单',
    '2. 会议闭环四栏模板（可直接复制使用）',
    '3. 3 个真实现场案例（脱敏）',
    '',
    '先说明白一件事：自检会告诉你「最该让 AI 先动手的是哪一件」，但它没告诉你的是——大多数人卡住，不是不会用 AI，而是那件最该改的事，恰恰是他最不想碰的。',
    '',
    '我做了 22 年管理，现场里十有八九是这样。',
    '',
    '所以问你一个具体的问题（不用现在答，想到了回我就行）：',
    '',
    '你上周，有没有一场会、一份周报，是开完/写完都知道浪费、但不得不做的？它叫什么名字？有多久？',
    '',
    '——凌',
    '在路上的 AI 管理博士',
    'masterlinc.com',
  ].join('\n');
}

/**
 * 发送《管理者 AI 自检配套资料》邮件
 * @param {string} to 访客邮箱
 * @returns {Promise<{sent: boolean, skipped?: boolean}>}
 *  - RESEND_API_KEY 未配置 → 跳过发送（skipped），不抛错
 *  - 发送失败 → 抛错（由上层 catch，不影响飞书线索与前端 ok）
 */
async function sendMaterialsEmail(to) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[api/lead] RESEND_API_KEY 未配置，跳过资料邮件发送（飞书线索已保留）');
    return { sent: false, skipped: true };
  }

  const from = process.env.RESEND_FROM || '凌 <hello@masterlinc.com>';
  const attachments = loadDeliverables();

  const payload = {
    from,
    to,
    subject: '你的《管理者 AI 自检配套资料》已到',
    text: buildEmailText(),
    attachments: attachments.map((a) => ({ filename: a.filename, content: a.content })),
  };

  // 8 秒超时，避免 Resend 慢响应拖住 Serverless（Vercel 免费函数最长 10s）
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(RESEND_BASE, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data || data.id === undefined) {
      const msg = (data && data.message) ? data.message : 'HTTP ' + res.status;
      throw new Error('Resend 发送失败: ' + msg);
    }
    return { sent: true, id: data.id };
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
    let emailSent = false;
    try {
      const r = await sendMaterialsEmail(email);
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
module.exports.loadDeliverables = loadDeliverables;
module.exports.buildEmailText = buildEmailText;
