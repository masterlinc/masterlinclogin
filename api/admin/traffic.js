// ============================================================================
// api/admin/traffic.js — 访问数据（page_view 聚合：PV/UV/热门页面/按天趋势/来源 Top）
//
// GET /api/admin/traffic  （requireAdmin）
//   ?days=7 | 30 | all（默认 7）
//   返回：{ ok, days, pv, uv（按匿名 uid 去重）, pages:[{path,count}] Top10,
//           daily:[{date,pv,uv}], sources:[{source,count}] Top10, generatedAt }
//   数据源：behavior_events 表 ev=page_view（自建埋点，全站覆盖）；
//   与 Vercel Analytics 面板互为旁路对照。
// ============================================================================

const { requireAdmin } = require('../../lib/admin-auth.js');
const { aggregateTraffic } = require('../../lib/events.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ ok: false, message: 'Method Not Allowed' }); return; }

  if (!requireAdmin(req, res)) return;

  const q = req.query || {};
  const days = parseInt(q.days, 10) || 7;
  const from = (days > 0 && q.days !== 'all') ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;

  try {
    const agg = await aggregateTraffic({ from });
    // 兼容前端字段：today（今日卡）/ days（=daily 趋势）/ pages（含 pv/uv）/ sources（含 name）
    const daily = agg.daily || [];
    const today = daily.length ? daily[daily.length - 1] : { date: '', pv: 0, uv: 0 };
    console.log('[api/admin/traffic] days=' + days + ' pv=' + agg.pv + ' uv=' + agg.uv);
    res.status(200).json({
      ok: true, days, today,
      pv: agg.pv, uv: agg.uv,
      daysTrend: daily,
      daily,
      pages: agg.pages,
      sources: agg.sources,
      generatedAt: Date.now(),
    });
  } catch (err) {
    console.error('[api/admin/traffic] ' + (err && err.message ? err.message : err));
    res.status(502).json({ ok: false, message: '访问数据暂不可用，请稍后重试' });
  }
};

module.exports.requireAdmin = requireAdmin;
module.exports.aggregateTraffic = aggregateTraffic;
