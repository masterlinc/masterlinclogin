// ============================================================================
// api/admin/leads.js — 邮箱线索列表（读飞书线索表 tblLv0WB01WbhHEE）
//
// GET /api/admin/leads  （requireAdmin）
//   筛选：?source=skill-pack  按来源渠道（前缀/包含匹配）
//         ?date=YYYY-MM-DD   按提交时间（当天）
//         ?from=ts&to=ts     按提交时间范围（毫秒）
//         ?q=xxx             邮箱模糊搜索
//         ?mask=0 | ?full=1  显示邮箱原文（默认脱敏：前 3 后 2，如 lin***ang@foxmail.com）
//         ?export=csv        导出 CSV（text/csv + Content-Disposition；含邮箱原文，仅本人可下载）
//   分页：?page=1&pageSize=50（按提交时间倒序）
//
// 合规：邮箱为个人信息；本接口仅 masterlinc（鉴权）可用；列表默认脱敏；
// 日志只打统计（条数/耗时），绝不打印邮箱原文。
// ============================================================================

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
const { requireAdmin } = require('../../lib/admin-auth.js');
const { getTenantAccessToken } = require('../../lib/feishu-token.js');

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 100;

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

/** 翻页拉取线索表全部记录 */
async function fetchAllLeads() {
  const appToken = process.env.FEISHU_APP_TOKEN;
  const tableId = process.env.FEISHU_TABLE_ID;
  if (!appToken || !tableId) throw new Error('FEISHU_APP_TOKEN / FEISHU_TABLE_ID 未配置');
  const token = await getTenantAccessToken();

  const out = [];
  let pageToken = '';
  for (let i = 0; i < 50; i++) {
    const params = new URLSearchParams({ page_size: '100' });
    if (pageToken) params.set('page_token', pageToken);
    const res = await fetch(
      `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records?${params.toString()}`,
      { headers: { Authorization: 'Bearer ' + token } }
    );
    const data = await res.json().catch(() => ({}));
    if (!data || data.code !== 0) {
      const msg = (data && data.msg) ? data.msg : 'HTTP ' + res.status;
      throw new Error('读取线索表失败: ' + msg);
    }
    const items = (data.data && data.data.items) || [];
    for (const rec of items) {
      const f = rec.fields || {};
      out.push({
        recordId: rec.record_id,
        email: pickField(f, '邮箱') || '',
        question: pickField(f, '最想解决的问题') || '',
        source: pickField(f, '来源渠道') || '直接访问',
        time: typeof f['提交时间'] === 'number' ? f['提交时间'] : 0,
        consent: pickField(f, '数据使用同意') || '',
      });
    }
    pageToken = data.data && data.data.page_token;
    if (!pageToken || !items.length) break;
  }
  return out;
}

/** 生成 CSV（含邮箱原文；字段转义 RFC 4180） */
function toCsv(rows) {
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['提交时间', '邮箱', '来源渠道', '最想解决的问题', '数据使用同意'];
  const lines = [header.map(esc).join(',')];
  for (const r of rows) {
    lines.push([new Date(r.time).toISOString(), r.email, r.source, r.question, r.consent].map(esc).join(','));
  }
  return '\uFEFF' + lines.join('\r\n'); // BOM 兼容 Excel 中文
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ ok: false, message: 'Method Not Allowed' }); return; }

  if (!requireAdmin(req, res)) return;

  const q = req.query || {};
  let source = String(q.source || '').trim();
  const fromParam = String(q.from || '').trim();
  if (!source && fromParam && fromParam !== '全部') source = fromParam; // 前端兼容：?from=skill-pack
  const dateStr = String(q.date || '').trim();
  const fromTs = q.from ? parseInt(q.from, 10) : 0;
  const toTs = q.to ? parseInt(q.to, 10) : 0;
  const emailQ = String(q.q || '').trim().toLowerCase();
  const showFull = q.mask === '0' || q.full === '1';
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, parseInt(q.pageSize, 10) || PAGE_SIZE_DEFAULT));

  try {
    const all = await fetchAllLeads();

    // 筛选
    let list = all;
    if (source) {
      list = list.filter((r) => r.source.indexOf(source) === 0 || r.source.indexOf(source) !== -1);
    }
    if (dateStr) {
      const start = new Date(dateStr + 'T00:00:00+08:00').getTime();
      const end = start + 24 * 60 * 60 * 1000;
      list = list.filter((r) => r.time >= start && r.time < end);
    }
    if (fromTs) list = list.filter((r) => r.time >= fromTs);
    if (toTs) list = list.filter((r) => r.time <= toTs);
    if (emailQ) {
      list = list.filter((r) =>
        r.email.toLowerCase().indexOf(emailQ) !== -1 ||
        r.question.toLowerCase().indexOf(emailQ) !== -1
      );
    }

    list.sort((a, b) => b.time - a.time); // 倒序
    const total = list.length;

    // CSV 导出（原文邮箱；仅 masterlinc）
    if (q.export === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="leads-' + new Date().toISOString().slice(0, 10) + '.csv"');
      res.status(200).send(toCsv(list));
      console.log('[api/admin/leads] export=csv rows=' + total);
      return;
    }

    const start = (page - 1) * pageSize;
    const items = list.slice(start, start + pageSize).map((r) => ({
      recordId: r.recordId,
      time: r.time,
      email: showFull ? r.email : maskEmail(r.email),
      masked: !showFull,
      source: r.source,
      question: r.question,
      consent: r.consent,
    }));

    console.log(`[api/admin/leads] total=${total} returned=${items.length}`);
    res.status(200).json({ ok: true, total, page, pageSize, items, leads: items });
  } catch (err) {
    console.error('[api/admin/leads] ' + (err && err.message ? err.message : err));
    res.status(502).json({ ok: false, message: '线索列表暂不可用，请稍后重试' });
  }
};

module.exports.requireAdmin = requireAdmin;
module.exports.maskEmail = maskEmail;
module.exports.toCsv = toCsv;
module.exports.fetchAllLeads = fetchAllLeads;
