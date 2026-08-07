// ============================================================================
// api/admin/feedback.js — 用户反馈管理（读 user_feedback 表）
//
// GET /api/admin/feedback   （requireAdmin）
//   筛选：?type=有%20bug       按反馈类型
//         ?status=新           按状态（新/已读/已修/已回复）
//         ?date=YYYY-MM-DD     按提交时间（当天）
//         ?from=ts&to=ts       按提交时间范围（毫秒）
//         ?q=xxx               关键词搜索（描述/邮箱）
//         ?export=csv          导出 CSV（含邮箱原文，仅 masterlinc 可下载）
//   分页：?page=1&pageSize=20（按提交时间倒序）
//   列表邮箱默认脱敏（前 3 后 2，如 lin***ang@foxmail.com）
//
// PATCH /api/admin/feedback/:id   （requireAdmin）
//   body: { status?: 新|已读|已修|已回复, note?: string }
//   更新状态 / 内部备注；飞书 PUT 整体替换字段，故读全量后合并再写回。
//
// 合规：邮箱为个人信息；本接口仅 masterlinc（鉴权）可用；列表默认脱敏；
// 日志只打统计（条数/耗时/状态），绝不打印邮箱原文与反馈正文。
// ============================================================================

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
const { requireAdmin } = require('../../lib/admin-auth.js');
const { getTenantAccessToken } = require('../../lib/feishu-token.js');

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

// ---------- 表管理（复用 api/feedback.js 的自动建表模式） ----------
let tableIdCache = null;
async function ensureFeedbackTable() {
  const appToken = process.env.FEISHU_APP_TOKEN;
  if (!appToken) throw new Error('FEISHU_APP_TOKEN 未配置');
  if (process.env.FEISHU_FEEDBACK_TABLE_ID) {
    tableIdCache = process.env.FEISHU_FEEDBACK_TABLE_ID.trim();
    return tableIdCache;
  }
  if (tableIdCache) return tableIdCache;
  // 复用 api/feedback.js 的 ensureFeedbackTable（自动查找/创建 user_feedback 表）
  const { ensureFeedbackTable: ensureTable } = require('../feedback.js');
  tableIdCache = await ensureTable();
  return tableIdCache;
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

  // 读当前记录
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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (!requireAdmin(req, res)) return;

  // ---------- PATCH /api/admin/feedback/:id — 状态 / 备注更新 ----------
  const patchM = (req.url || '').match(/^\/api\/admin\/feedback\/([^/?]+)/);
  if (req.method === 'PATCH') {
    if (!patchM) {
      res.status(400).json({ ok: false, message: '缺少反馈记录 ID' });
      return;
    }
    const recordId = decodeURIComponent(patchM[1]);
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
      console.log('[api/admin/feedback] PATCH ' + recordId + ' status=' + (patch.status || '-') + ' note=' + (patch.note != null ? 'yes' : '-'));
    } catch (err) {
      if (err && err.notFound) {
        res.status(404).json({ ok: false, message: '反馈记录不存在' });
        return;
      }
      console.error('[api/admin/feedback] PATCH ' + (err && err.message ? err.message : err));
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
      console.log('[api/admin/feedback] export=csv rows=' + total);
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

    console.log(`[api/admin/feedback] total=${total} returned=${items.length}`);
    res.status(200).json({ ok: true, total, page, pageSize, items, feedback: items });
  } catch (err) {
    console.error('[api/admin/feedback] ' + (err && err.message ? err.message : err));
    res.status(502).json({ ok: false, message: '反馈列表暂不可用，请稍后重试' });
  }
};

module.exports.requireAdmin = requireAdmin;
module.exports.maskEmail = maskEmail;
module.exports.toCsv = toCsv;
module.exports.fetchAllFeedback = fetchAllFeedback;
module.exports.updateFeedback = updateFeedback;
module.exports.STATUSES = STATUSES;
