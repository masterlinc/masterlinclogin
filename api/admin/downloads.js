// ============================================================================
// api/admin/downloads.js — 下载统计（按 Skill 聚合，去重口径：uid+skillId 只计 1）
//
// GET /api/admin/downloads  （requireAdmin）
//   ?days=7 | 30 | all（默认 30）：仅统计最近 N 天的 skill_download 事件
//   返回：{ ok, total（去重后合计）, skills: [{ skillId, skillName, category,
//            count（去重设备数）, lastAt }], generatedAt }
//   数据源：behavior_events 表（/api/track 埋点）；同匿名 uid + 同 skillId 只计 1，
//           天然免疫连点/刷量（对齐 Skill 数据方案口径）
// ============================================================================

const { requireAdmin } = require('../../lib/admin-auth.js');
const { aggregateDownloads } = require('../../lib/events.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ ok: false, message: 'Method Not Allowed' }); return; }

  if (!requireAdmin(req, res)) return;

  const q = req.query || {};
  const days = parseInt(q.days, 10) || 30;
  const from = (days > 0 && q.days !== 'all') ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;

  try {
    const { rawTotal, total, skills } = await aggregateDownloads({ from });
    // 兼容前端字段：total（原始点击）/ totalUnique（去重合计）/ skills[].unique
    const enriched = skills.map((s) => ({ ...s, unique: s.count }));
    console.log('[api/admin/downloads] days=' + days + ' total=' + total + ' skills=' + skills.length);
    res.status(200).json({
      ok: true, days,
      total: rawTotal,      // 原始点击计数
      totalUnique: total,   // 去重下载数
      skills: enriched,
      packLeads: 0,         // 全集包线索数（前端占位；线索在 leads 模块看）
      generatedAt: Date.now(),
    });
  } catch (err) {
    console.error('[api/admin/downloads] ' + (err && err.message ? err.message : err));
    res.status(502).json({ ok: false, message: '下载统计暂不可用，请稍后重试' });
  }
};

module.exports.requireAdmin = requireAdmin;
module.exports.aggregateDownloads = aggregateDownloads;
