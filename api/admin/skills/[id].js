// ============================================================================
// api/admin/skills/[id].js — Skill 管理（单卡部分更新：上下线 / 排序 / 字段）
//
// PATCH /api/admin/skills/:id  body: 任意字段子集
//   { status:'off'|'on', sort:3, name, value, ... }
//   - requireAdmin 鉴权
//   - 只更新传入字段（合并后写飞书 skills_config 表）
//   - Skill 不存在 → 404
// ============================================================================

const { requireAdmin } = require('../../../lib/admin-auth.js');
const { patchSkill } = require('../../../lib/skills-config.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'PATCH') { res.status(405).json({ ok: false, message: 'Method Not Allowed' }); return; }

  if (!requireAdmin(req, res)) return;

  const skillId = String((req.query && req.query.id) || (req.params && req.params.id) || '').trim();
  if (!skillId) { res.status(400).json({ ok: false, message: '缺少 Skill ID' }); return; }

  let body;
  try {
    body = (typeof req.body === 'object' && req.body !== null) ? req.body : JSON.parse(req.body || '{}');
  } catch (e) {
    res.status(400).json({ ok: false, message: '请求体不是合法 JSON' });
    return;
  }

  try {
    const card = await patchSkill(skillId, body);
    console.log('[api/admin/skills] PATCH skillId=' + skillId);
    res.status(200).json({ ok: true, skill: card });
  } catch (err) {
    if (err && err.status === 404) {
      res.status(404).json({ ok: false, message: err.message });
      return;
    }
    console.error('[api/admin/skills] PATCH ' + (err && err.message ? err.message : err));
    res.status(502).json({ ok: false, message: 'Skill 更新失败，请稍后重试' });
  }
};

module.exports.requireAdmin = requireAdmin;
module.exports.patchSkill = patchSkill;
