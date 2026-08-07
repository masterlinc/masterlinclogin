// ============================================================================
// api/skills.js — Skill 列表公开读（前台 skills 页数据源）
//
// 对齐管理后台技术方案 §3.3 / 产品方案 ②Skill 管理：
//   - GET /api/skills：读飞书 skills_config 表（不存在则自动建表并 seed 默认 12 卡），
//     返回 status=on 且按排序的卡片列表，供前台渲染
//   - 只返回上线 Skill（本来就是前台展示内容，无敏感信息）
//   - 响应头 Cache-Control: max-age=60（短缓存：后台改完 1 分钟内前台生效；
//     前台页面另有内置数组 fallback，本接口失败不阻塞）
//
// 返回结构（与 skills/index.html 内嵌 SKILLS 数组字段对齐，方便前端数据驱动渲染）：
//   { ok, source: 'config', updatedAt, skills: [{ id, name, value, cat, tools[],
//     diff, time, format, file, dlName, dlText, hook:{href,text},
//     preview:{title,style,labels[]}, sort }] }
// ============================================================================

const { ensureSkillsTableSeeded, listSkills } = require('../lib/skills-config.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'max-age=60');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ ok: false, message: 'Method Not Allowed' }); return; }

  try {
    // 确保表存在 + 新表 seed 默认 12 卡
    await ensureSkillsTableSeeded();
    const all = await listSkills();
    const online = all
      .filter((s) => s.status === 'on' && s.id)
      .sort((a, b) => (a.sort - b.sort) || a.id.localeCompare(b.id))
      .map(({ recordId, updatedAt, ...card }) => card);

    console.log(`[api/skills] total=${all.length} online=${online.length}`);
    res.status(200).json({ ok: true, source: 'config', updatedAt: Date.now(), skills: online });
  } catch (err) {
    // 读失败不向前台暴露细节；前台用内置数组 fallback
    console.error('[api/skills] ' + (err && err.message ? err.message : err));
    res.status(502).json({ ok: false, message: 'Skill 列表暂不可用' });
  }
};

module.exports.ensureSkillsTableSeeded = ensureSkillsTableSeeded;
module.exports.listSkills = listSkills;
