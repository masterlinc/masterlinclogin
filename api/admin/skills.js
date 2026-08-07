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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (!requireAdmin(req, res)) return;

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
