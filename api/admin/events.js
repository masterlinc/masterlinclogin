// ============================================================================
// api/admin/events.js — 行为日志（behavior_events 表流水浏览）
//
// GET /api/admin/events  （requireAdmin）
//   ?ev=skill_download|page_view|...  按事件类型筛选
//   ?path=/skills/                    按页面筛选
//   ?from=ts&to=ts                    按时间范围筛选（毫秒）
//   ?page=1&pageSize=50               分页（默认 50，倒序）
//   返回：{ ok, total, page, pageSize, items:[{ recordId, time, ev, page,
//            uid（匿名 ID 前 8 位，脱敏）, ref, extra, v, ua }] }
// ============================================================================

const { requireAdmin } = require('../../lib/admin-auth.js');
const { listEvents } = require('../../lib/events.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ ok: false, message: 'Method Not Allowed' }); return; }

  if (!requireAdmin(req, res)) return;

  const q = req.query || {};
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize, 10) || 50));
  const ev = String(q.ev || '').trim();
  const path = String(q.path || '').trim();
  const from = q.from ? parseInt(q.from, 10) : 0;
  const to = q.to ? parseInt(q.to, 10) : 0;

  try {
    const r = await listEvents({ ev, path, from, to, page, pageSize });
    console.log('[api/admin/events] ev=' + (ev || '*') + ' total=' + r.total);
    res.status(200).json({ ok: true, ...r, events: r.items, per: r.pageSize });
  } catch (err) {
    console.error('[api/admin/events] ' + (err && err.message ? err.message : err));
    res.status(502).json({ ok: false, message: '行为日志暂不可用，请稍后重试' });
  }
};

module.exports.requireAdmin = requireAdmin;
module.exports.listEvents = listEvents;
