// ============================================================================
// api/admin/skills.js — Skill 管理（读 / 新增 / 更新）
//
// 全部 requireAdmin（Authorization: Bearer <token>）：
//   GET  /api/admin/skills        读配置表全部卡片（含下架，含记录 ID）
//   POST /api/admin/skills        新增或更新卡（按 skillId 找：存在则更新，不存在则新增）
//
// body 字段（POST，兼容嵌套与展平两种写法）：
//   { skillId, name, value, cat, tools:[]|'a,b', diff, time, format,
//     file, dlName, dlText, hook:{href,text} | hookHref/hookText,
//     preview:{title,style,labels[]} | previewTitle/previewStyle/previewLabels,
//     status:'on'|'off', sort:number }
//
// 写飞书 skills_config 表 → /api/skills 公开读直接反映 → 前台刷新即生效（无需部署）。
// 只保留统计日志，不打邮箱 / token / 敏感值。
// ============================================================================

const { requireAdmin } = require('../../lib/admin-auth.js');
const { listSkills, upsertSkill } = require('../../lib/skills-config.js');
const { getTenantAccessToken } = require('../../lib/feishu-token.js');

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

// ============================================================================
// 用户反馈管理（v1.25.1 合并自 api/admin/feedback.js——为修复 Vercel 函数数超限）
// /api/admin/feedback 由 vercel.json rewrites 路由到本函数，按 路径/方法/__fb 标记 三重分流。
// 与原实现等价：requireAdmin 鉴权、列表邮箱脱敏、筛选、CSV 导出、PATCH 状态/备注更新。
// ============================================================================

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const STATUSES = ['新', '已读', '已修', '已回复'];

function pickField(f, key) {
  const v = f[key];
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    if (v.length && typeof v[0] === 'object' && v[0].text != null) return String(v[0].text);
    if (v.length) return String(v[0]);
  }
  if (typeof v === 'number') return v;
  return '';
}

/** 邮箱脱敏：前 3 后 2，如 lin***ang@foxmail.com */
function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return s.slice(0, 3) + '***';
  const local = s.slice(0, at);
  const domain = s.slice(at);
  if (local.length <= 2) return local + '***' + domain;
  const head = local.slice(0, 3);
  const tail = local.length > 5 ? local.slice(-2) : '';
  return head + '***' + tail + domain;
}

// ---------- 反馈表管理（自动查找/创建 user_feedback 表；完整内联，不再依赖 api/feedback.js） ----------
let feedbackTableIdCache = null;
async function ensureFeedbackTable() {
  const appToken = process.env.FEISHU_APP_TOKEN;
  if (!appToken) throw new Error('FEISHU_APP_TOKEN 未配置');
  if (process.env.FEISHU_FEEDBACK_TABLE_ID) {
    feedbackTableIdCache = process.env.FEISHU_FEEDBACK_TABLE_ID.trim();
    return feedbackTableIdCache;
  }
  if (feedbackTableIdCache) return feedbackTableIdCache;

  const FEEDBACK_TABLE_NAME = 'user_feedback';
  const FEEDBACK_TYPES = ['用得不顺', '有 bug', '想要新功能', '其他'];
  const FEEDBACK_STATUSES = ['新', '已读', '已修', '已回复'];
  const FEEDBACK_TABLE_FIELDS = [
    { field_name: '反馈类型', type: 3, property: { options: FEEDBACK_TYPES.map((t) => ({ name: t })) } },
    { field_name: '反馈描述', type: 1 },
    { field_name: '邮箱', type: 1 },
    { field_name: '来源版本', type: 1 },
    { field_name: '来源页面', type: 1 },
    { field_name: '设备ID', type: 1 },
    { field_name: '提交时间', type: 5 },
    { field_name: '状态', type: 3, property: { options: FEEDBACK_STATUSES.map((s) => ({ name: s })) } },
    { field_name: '备注', type: 1 },
  ];

  const token = await getTenantAccessToken();

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
  console.log('[api/admin/skills] 已创建 user_feedback 表: table_id=' + createData.data.table_id);
  return createData.data.table_id;
}

/** 翻页拉取 user_feedback 表全部记录（个人站量级小，函数内 JS 聚合足够） */
async function fetchAllFeedback() {
  const appToken = process.env.FEISHU_APP_TOKEN;
  const tableId = await ensureFeedbackTable();
  const token = await getTenantAccessToken();

  const out = [];
  let pageToken = '';
  for (let i = 0; i < 50; i++) { // 防死循环：最多 50 页（5000 条）
    const params = new URLSearchParams({ page_size: '100' });
    if (pageToken) params.set('page_token', pageToken);
    const res = await fetch(
      `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records?${params.toString()}`,
      { headers: { Authorization: 'Bearer ' + token } }
    );
    const data = await res.json().catch(() => ({}));
    if (!data || data.code !== 0) {
      const msg = (data && data.msg) ? data.msg : 'HTTP ' + res.status;
      throw new Error('读取 user_feedback 表失败: ' + msg);
    }
    const items = (data.data && data.data.items) || [];
    for (const rec of items) {
      const f = rec.fields || {};
      out.push({
        recordId: rec.record_id,
        type: pickField(f, '反馈类型') || '',
        content: pickField(f, '反馈描述') || '',
        email: pickField(f, '邮箱') || '',
        version: pickField(f, '来源版本') || '',
        page: pickField(f, '来源页面') || '',
        deviceId: pickField(f, '设备ID') || '',
        time: typeof f['提交时间'] === 'number' ? f['提交时间'] : 0,
        status: pickField(f, '状态') || '新',
        note: pickField(f, '备注') || '',
      });
    }
    pageToken = data.data && data.data.page_token;
    if (!pageToken || !items.length) break;
  }
  return out;
}

/** 更新一条反馈（PUT 整体替换：读全量 → 合并 → 写回） */
async function updateFeedback(recordId, patch) {
  const appToken = process.env.FEISHU_APP_TOKEN;
  const tableId = await ensureFeedbackTable();
  const token = await getTenantAccessToken();

  const readRes = await fetch(
    `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/${encodeURIComponent(recordId)}`,
    { headers: { Authorization: 'Bearer ' + token } }
  );
  const readData = await readRes.json().catch(() => ({}));
  if (!readData || readData.code !== 0) {
    const msg = (readData && readData.msg) ? readData.msg : 'HTTP ' + readRes.status;
    throw new Error('读取反馈记录失败: ' + msg);
  }
  const rec = readData.data && readData.data.record;
  if (!rec || !rec.record_id) {
    const err = new Error('反馈记录不存在');
    err.notFound = true;
    throw err;
  }
  const f = rec.fields || {};
  const fields = {
    '反馈类型': pickField(f, '反馈类型') || '其他',
    '反馈描述': pickField(f, '反馈描述') || '',
    '邮箱': pickField(f, '邮箱') || '',
    '来源版本': pickField(f, '来源版本') || '',
    '来源页面': pickField(f, '来源页面') || '',
    '设备ID': pickField(f, '设备ID') || '',
    '提交时间': typeof f['提交时间'] === 'number' ? f['提交时间'] : Date.now(),
    '状态': patch.status || pickField(f, '状态') || '新',
    '备注': patch.note != null ? patch.note : (pickField(f, '备注') || ''),
  };

  const putRes = await fetch(
    `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/${encodeURIComponent(recordId)}`,
    {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    }
  );
  const putData = await putRes.json().catch(() => ({}));
  if (!putData || putData.code !== 0) {
    const msg = (putData && putData.msg) ? putData.msg : 'HTTP ' + putRes.status;
    throw new Error('更新反馈记录失败: ' + msg);
  }
  return fields;
}

/** 生成 CSV（含邮箱原文；字段转义 RFC 4180） */
function toCsv(rows) {
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['提交时间', '反馈类型', '反馈描述', '邮箱', '来源版本', '来源页面', '设备ID', '状态', '备注'];
  const lines = [header.map(esc).join(',')];
  for (const r of rows) {
    lines.push([
      new Date(r.time).toISOString(), r.type, r.content, r.email,
      r.version, r.page, r.deviceId, r.status, r.note,
    ].map(esc).join(','));
  }
  return '\uFEFF' + lines.join('\r\n'); // BOM 兼容 Excel 中文
}

/** 管理端反馈 Handler（/api/admin/feedback，由外层 handler 分流进入；已过 requireAdmin） */
async function handleAdminFeedback(req, res) {
  // ---------- PATCH /api/admin/feedback/:id — 状态 / 备注更新 ----------
  let recordIdRaw = '';
  const patchM = (req.url || '').match(/^\/api\/admin\/feedback\/([^/?]+)/);
  if (patchM) recordIdRaw = patchM[1];
  else if (req.query && req.query.fbpath) recordIdRaw = String(req.query.fbpath).split('/')[0];

  if (req.method === 'PATCH') {
    if (!recordIdRaw) {
      res.status(400).json({ ok: false, message: '缺少反馈记录 ID' });
      return;
    }
    const recordId = decodeURIComponent(recordIdRaw);
    let body;
    try {
      body = (typeof req.body === 'object' && req.body !== null) ? req.body : JSON.parse(req.body || '{}');
    } catch (e) {
      res.status(400).json({ ok: false, message: '请求体不是合法 JSON' });
      return;
    }
    const patch = {};
    if (body.status !== undefined) {
      const status = String(body.status || '').trim();
      if (!STATUSES.includes(status)) {
        res.status(400).json({ ok: false, message: '状态无效（新/已读/已修/已回复）' });
        return;
      }
      patch.status = status;
    }
    if (body.note !== undefined) {
      patch.note = String(body.note || '').slice(0, 500);
    }
    if (patch.status === undefined && patch.note === undefined) {
      res.status(400).json({ ok: false, message: '没有可更新的字段（status / note）' });
      return;
    }
    try {
      const fields = await updateFeedback(recordId, patch);
      res.status(200).json({
        ok: true,
        recordId,
        status: patch.status || fields['状态'],
        note: fields['备注'],
      });
      console.log('[api/admin/skills] 反馈 PATCH ' + recordId + ' status=' + (patch.status || '-') + ' note=' + (patch.note != null ? 'yes' : '-'));
    } catch (err) {
      if (err && err.notFound) {
        res.status(404).json({ ok: false, message: '反馈记录不存在' });
        return;
      }
      console.error('[api/admin/skills] 反馈 PATCH ' + (err && err.message ? err.message : err));
      res.status(502).json({ ok: false, message: '更新失败，请稍后重试' });
    }
    return;
  }

  // ---------- GET /api/admin/feedback — 列表 / 筛选 / 导出 ----------
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, message: 'Method Not Allowed' });
    return;
  }

  const q = req.query || {};
  const type = String(q.type || '').trim();
  const status = String(q.status || '').trim();
  const dateStr = String(q.date || '').trim();
  const fromTs = q.from ? parseInt(q.from, 10) : 0;
  const toTs = q.to ? parseInt(q.to, 10) : 0;
  const kw = String(q.q || '').trim().toLowerCase();
  const showFull = q.mask === '0' || q.full === '1';
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, parseInt(q.pageSize, 10) || PAGE_SIZE_DEFAULT));

  try {
    const all = await fetchAllFeedback();

    let list = all;
    if (type && type !== '全部') list = list.filter((r) => r.type === type);
    if (status && status !== '全部') list = list.filter((r) => r.status === status);
    if (dateStr) {
      const start = new Date(dateStr + 'T00:00:00+08:00').getTime();
      const end = start + 24 * 60 * 60 * 1000;
      list = list.filter((r) => r.time >= start && r.time < end);
    }
    if (fromTs) list = list.filter((r) => r.time >= fromTs);
    if (toTs) list = list.filter((r) => r.time <= toTs);
    if (kw) {
      list = list.filter((r) =>
        r.content.toLowerCase().indexOf(kw) !== -1 ||
        r.email.toLowerCase().indexOf(kw) !== -1
      );
    }

    list.sort((a, b) => b.time - a.time); // 倒序
    const total = list.length;

    // CSV 导出（原文邮箱；仅 masterlinc）
    if (q.export === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="feedback-' + new Date().toISOString().slice(0, 10) + '.csv"');
      res.status(200).send(toCsv(list));
      console.log('[api/admin/skills] 反馈 export=csv rows=' + total);
      return;
    }

    const start = (page - 1) * pageSize;
    const items = list.slice(start, start + pageSize).map((r) => ({
      recordId: r.recordId,
      time: r.time,
      type: r.type,
      content: r.content,
      email: showFull ? r.email : maskEmail(r.email),
      masked: !showFull,
      version: r.version,
      page: r.page,
      deviceId: r.deviceId,
      status: r.status,
      note: r.note,
    }));

    console.log(`[api/admin/skills] 反馈 total=${total} returned=${items.length}`);
    res.status(200).json({ ok: true, total, page, pageSize, items, feedback: items });
  } catch (err) {
    console.error('[api/admin/skills] 反馈 ' + (err && err.message ? err.message : err));
    res.status(502).json({ ok: false, message: '反馈列表暂不可用，请稍后重试' });
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (!requireAdmin(req, res)) return;

  // v1.25.1 分流：/api/admin/feedback（vercel.json rewrites 路由到本函数）→ 用户反馈管理
  //   三重保险：① PATCH 方法仅反馈使用（skills 用 GET/POST/PUT）
  //             ② req.url 路径含 /api/admin/feedback（Vercel rewrites 对函数保留原始路径）
  //             ③ query.__fb=1（rewrites destination 注入的标记，防 req.url 被改写）
  const isFeedbackPath = (req.url || '').indexOf('/api/admin/feedback') !== -1;
  const fbFlag = String((req.query && req.query.__fb) || '').trim() === '1';
  if (req.method === 'PATCH' || isFeedbackPath || fbFlag) {
    return handleAdminFeedback(req, res);
  }

  try {
    if (req.method === 'GET') {
      const all = await listSkills();
      const sorted = all.sort((a, b) => (a.sort - b.sort) || a.id.localeCompare(b.id));
      console.log('[api/admin/skills] GET total=' + sorted.length);
      res.status(200).json({ ok: true, skills: sorted });
      return;
    }

    if (req.method === 'POST' || req.method === 'PUT') {
      let body;
      try {
        body = (typeof req.body === 'object' && req.body !== null) ? req.body : JSON.parse(req.body || '{}');
      } catch (e) {
        res.status(400).json({ ok: false, message: '请求体不是合法 JSON' });
        return;
      }
      // 兼容 { skill: {...} } 包裹与直接传卡字段两种写法
      const card = (body && typeof body.skill === 'object' && body.skill !== null) ? body.skill : body;
      const skillId = String(card.skillId || '').trim();
      if (!skillId) { res.status(400).json({ ok: false, message: '缺少 skillId' }); return; }

      const r = await upsertSkill(card);
      console.log('[api/admin/skills] ' + req.method + ' action=' + r.action + ' skillId=' + skillId);
      res.status(200).json({ ok: true, action: r.action, skill: r.card });
      return;
    }

    res.status(405).json({ ok: false, message: 'Method Not Allowed' });
  } catch (err) {
    console.error('[api/admin/skills] ' + (err && err.message ? err.message : err));
    res.status(502).json({ ok: false, message: 'Skill 配置读写失败，请稍后重试' });
  }
};

module.exports.requireAdmin = requireAdmin;
module.exports.listSkills = listSkills;
module.exports.upsertSkill = upsertSkill;

// 反馈管理（合并自 api/admin/feedback.js）导出，供本地单测
module.exports.maskEmail = maskEmail;
module.exports.toCsv = toCsv;
module.exports.fetchAllFeedback = fetchAllFeedback;
module.exports.updateFeedback = updateFeedback;
module.exports.STATUSES = STATUSES;
module.exports.handleAdminFeedback = handleAdminFeedback;
module.exports.ensureFeedbackTable = ensureFeedbackTable;
