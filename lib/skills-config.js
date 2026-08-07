// ============================================================================
// lib/skills-config.js — skills_config 配置表共享模块
//
// 用途（对齐管理后台技术方案 §三 / 产品方案 ②Skill 管理）：
//   - 自动建表 skills_config（复用 backup.js ensure 模式），不存在时 seed 默认 12 卡
//   - 卡片字段读写：新增/更新/上下线/排序
//   - /api/skills（公开读，仅 online + 排序）与 /api/admin/skills（管理读写）共用
//
// ID 口径：以已上线代码 skills/index.html 内嵌数组的 skill-01 ~ skill-12 为准
// （技术方案 §八 决策点 3），后台统计/埋点/配置表三处共用一套 ID。
//
// 表结构 skills_config（Text=type 1，DateTime=type 5）：
//   skillId / 名称 / 价值 / 分类 / 工具(逗号分隔) / 难度 / 时长 / 格式 /
//   文件URL / 下载文件名 / 下载文案 / 钩子链接 / 钩子文案 /
//   预览标题 / 预览样式(grid|rows|flow|cols) / 预览标签(JSON 数组) /
//   状态(on|off) / 排序(数字字符串) / 更新时间(DateTime)
// ============================================================================

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
const { getTenantAccessToken } = require('./feishu-token.js');

const SKILLS_TABLE_NAME = 'skills_config';
const SKILLS_TABLE_FIELDS = [
  { field_name: 'skillId', type: 1 },
  { field_name: '名称', type: 1 },
  { field_name: '价值', type: 1 },
  { field_name: '分类', type: 1 },
  { field_name: '工具', type: 1 },
  { field_name: '难度', type: 1 },
  { field_name: '时长', type: 1 },
  { field_name: '格式', type: 1 },
  { field_name: '文件URL', type: 1 },
  { field_name: '下载文件名', type: 1 },
  { field_name: '下载文案', type: 1 },
  { field_name: '钩子链接', type: 1 },
  { field_name: '钩子文案', type: 1 },
  { field_name: '预览标题', type: 1 },
  { field_name: '预览样式', type: 1 },
  { field_name: '预览标签', type: 1 },
  { field_name: '状态', type: 1 },
  { field_name: '排序', type: 1 },
  { field_name: '更新时间', type: 5 },
];

let skillsTableIdCache = null;

// ===================== 默认 12 卡数据（对齐 skills/index.html 内嵌 SKILLS 数组） =====================
const DEFAULT_SKILLS = [
  {
    skillId: 'skill-01', name: 'AI 会议纪要·四栏法',
    value: '把 1 小时录音变成一页「决定 / 待验证 / 负责人 / 原话」四栏决议——分对了类，责任才落得下来。',
    cat: '会议', tools: ['NotebookLM', 'Kimi'],
    diff: '★★☆', time: '首次配置 20 分钟 · 每场会 15 分钟', format: 'PDF 方法卡 · 方法 + 骨架 + 完整示例',
    file: '/skills/files/skill-01-ai-meeting-notes-4columns.md',
    dlName: 'AI会议纪要·四栏法（精品卡）.md', dlText: '免费下载 · 四栏法精品卡',
    hook: { href: '/products/selfcheck.html', text: '想要可复制的空白模板 + 会后复查清单 + 更多行业案例？¥29 进阶版 →' },
    preview: { title: '四栏骨架', style: 'grid', labels: ['已确认决定', '待验证事项', '负责人 · 截止', '原话证据'] },
    sort: 1,
  },
  {
    skillId: 'skill-04', name: 'AI 写周报法（3 小时 → 20 分钟）',
    value: '周报从 3 小时压到 20 分钟——素材随手记、AI 出初稿、人只改判断。',
    cat: '汇报周报', tools: ['DeepSeek', 'Kimi'],
    diff: '★★☆', time: '首次搭建 30 分钟 · 每周 20 分钟成稿', format: 'PDF 方法卡 · 含 3 套提示词变体 + 常见坑',
    file: '/skills/files/skill-04-ai-weekly-report.md',
    dlName: 'AI写周报法（精品卡）.md', dlText: '免费下载 · 周报法精品卡',
    hook: { href: '/products/selfcheck.html', text: '想系统化省时间（周报、汇报一起改）？免费自检，看看最该先动哪一件 →' },
    preview: { title: '三步流程', style: 'flow', labels: ['① 随手记 · 每天 2 分钟', '② AI 初稿 · 周日 15 分钟', '③ 人只改判断 · 5 分钟'] },
    sort: 2,
  },
  {
    skillId: 'skill-12', name: '管理者 AI 效率审计',
    value: '记录一周工作，按四类拆开算出可释放时间，找到 AI 最该插手的 TOP 3。',
    cat: '决策', tools: ['DeepSeek', 'Kimi', 'GPT'],
    diff: '★★★', time: '记录一周 · 周末审计 30 分钟', format: 'PDF 方法卡 · 完整审计框架',
    file: '/skills/files/skill-12-manager-ai-audit-week.md',
    dlName: '管理者AI效率审计（精品卡）.md', dlText: '免费下载 · 效率审计精品卡',
    hook: { href: '/products/selfcheck.html', text: '想深挖自己的场景、把一周变成整套打法？免费自检，10 分钟找到最该改的一件 →' },
    preview: { title: '四类时间', style: 'cols', labels: ['❶ 核心管理', '❷ 可委派', '❸ 纯重复', '⚠️ 时间黑洞'] },
    sort: 3,
  },
];

// ===================== 数据转换 =====================

/** 卡片对象 → 飞书表字段（seed / 写表用） */
function cardToFields(card) {
  return {
    'skillId': String(card.skillId || '').slice(0, 80),
    '名称': String(card.name || '').slice(0, 200),
    '价值': String(card.value || '').slice(0, 500),
    '分类': String(card.cat || card.category || '').slice(0, 50),
    '工具': (Array.isArray(card.tools) ? card.tools.join(',') : String(card.tools || '')).slice(0, 200),
    '难度': String(card.diff || '').slice(0, 20),
    '时长': String(card.time || '').slice(0, 80),
    '格式': String(card.format || '').slice(0, 100),
    '文件URL': String(card.file || '').slice(0, 300),
    '下载文件名': String(card.dlName || '').slice(0, 200),
    '下载文案': String(card.dlText || '').slice(0, 200),
    '钩子链接': String((card.hook && card.hook.href) || card.hookHref || '').slice(0, 500),
    '钩子文案': String((card.hook && card.hook.text) || card.hookText || '').slice(0, 500),
    '预览标题': String((card.preview && card.preview.title) || card.previewTitle || '').slice(0, 100),
    '预览样式': String((card.preview && card.preview.style) || card.previewStyle || '').slice(0, 20),
    '预览标签': JSON.stringify(
      (card.preview && Array.isArray(card.preview.labels)) ? card.preview.labels
        : (Array.isArray(card.previewLabels) ? card.previewLabels : [])
    ),
    '状态': String(card.status || (card.online ? 'on' : 'on')).slice(0, 10),
    '排序': String(card.sort != null ? card.sort : 99).slice(0, 10),
    '更新时间': (typeof card.updatedAt === 'number' && card.updatedAt > 0) ? card.updatedAt : Date.now(),
  };
}

/** 飞书记录 → 前台友好卡片对象 */
function fieldsToCard(f) {
  const pick = (k) => {
    const v = f[k];
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) {
      if (v.length && typeof v[0] === 'object' && v[0].text != null) return String(v[0].text);
      if (v.length) return String(v[0]);
    }
    if (typeof v === 'number') return v;
    return '';
  };
  let labels = [];
  try { const p = JSON.parse(pick('预览标签') || '[]'); if (Array.isArray(p)) labels = p; } catch (e) { labels = []; }
  return {
    id: pick('skillId') || '',
    name: pick('名称') || '',
    value: pick('价值') || '',
    cat: pick('分类') || '',
    tools: (pick('工具') || '').split(',').map((t) => t.trim()).filter(Boolean),
    diff: pick('难度') || '',
    time: pick('时长') || '',
    format: pick('格式') || '',
    file: pick('文件URL') || '',
    dlName: pick('下载文件名') || '',
    dlText: pick('下载文案') || '',
    hook: { href: pick('钩子链接') || '', text: pick('钩子文案') || '' },
    preview: { title: pick('预览标题') || '', style: pick('预览样式') || '', labels },
    status: (pick('状态') || 'on').toLowerCase() === 'off' ? 'off' : 'on',
    sort: parseInt(pick('排序') || '99', 10) || 99,
    updatedAt: (typeof f['更新时间'] === 'number') ? f['更新时间'] : 0,
  };
}

// ===================== 表管理 =====================

async function ensureSkillsTable() {
  const appToken = process.env.FEISHU_APP_TOKEN;
  if (!appToken) throw new Error('FEISHU_APP_TOKEN 未配置');

  if (process.env.FEISHU_SKILLS_TABLE_ID) {
    skillsTableIdCache = process.env.FEISHU_SKILLS_TABLE_ID.trim();
    return skillsTableIdCache;
  }
  if (skillsTableIdCache) return skillsTableIdCache;

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
  const found = items.find((t) => t.name === SKILLS_TABLE_NAME);
  if (found) {
    skillsTableIdCache = found.table_id;
    return found.table_id;
  }

  const createRes = await fetch(`${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ table: { name: SKILLS_TABLE_NAME, fields: SKILLS_TABLE_FIELDS } }),
  });
  const createData = await createRes.json().catch(() => ({}));
  if (!createData || createData.code !== 0 || !createData.data || !createData.data.table_id) {
    const msg = (createData && createData.msg) ? createData.msg : 'HTTP ' + createRes.status;
    throw new Error('创建 skills_config 表失败: ' + msg);
  }
  skillsTableIdCache = createData.data.table_id;
  console.log('[lib/skills-config] 已创建 skills_config 表: table_id=' + createData.data.table_id);
  return createData.data.table_id;
}

// ---------- 读写 ----------

async function batchCreateSkills(cards) {
  const appToken = process.env.FEISHU_APP_TOKEN;
  const tableId = await ensureSkillsTable();
  const token = await getTenantAccessToken();
  const records = cards.map((c) => ({ fields: cardToFields(c) }));
  const res = await fetch(
    `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`,
    {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!data || data.code !== 0) {
    const msg = (data && data.msg) ? data.msg : 'HTTP ' + res.status;
    throw new Error('批量写入 skills_config 失败: ' + msg);
  }
  return (data.data && data.data.records) || [];
}

/**
 * 确保表存在；若表刚创建则 seed 3 个精品卡。
 * 若表已存在但含旧版 12 卡（v1.19 之前 seed），自动收敛为 3 个精品（其余下架，保留数据可后台手动上架）。
 * @returns {Promise<{created: boolean, seeded: boolean, converged: boolean}>}
 */
async function ensureSkillsTableSeeded() {
  let created = false;
  const existed = !!skillsTableIdCache || !!process.env.FEISHU_SKILLS_TABLE_ID;
  // 探测：先列表看是否存在（复用 ensureSkillsTable 内部逻辑的一部分）
  const appToken = process.env.FEISHU_APP_TOKEN;
  const token = await getTenantAccessToken();
  let foundId = null;
  if (!process.env.FEISHU_SKILLS_TABLE_ID && !skillsTableIdCache) {
    const listRes = await fetch(
      `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables?page_size=100`,
      { headers: { Authorization: 'Bearer ' + token } }
    );
    const listData = await listRes.json().catch(() => ({}));
    const items = (listData.data && listData.data.items) || [];
    const found = items.find((t) => t.name === SKILLS_TABLE_NAME);
    if (found) foundId = found.table_id;
  }
  const tableId = await ensureSkillsTable();
  const isNew = !foundId && !existed;
  if (isNew) {
    await batchCreateSkills(DEFAULT_SKILLS);
    console.log('[lib/skills-config] 已 seed 默认 ' + DEFAULT_SKILLS.length + ' 个精品卡');
    return { created: true, seeded: true, converged: false };
  }
  // 表已存在：若发现旧版 12 卡（非精品的 skill-02/03/05-11 仍为 on），收敛为 3 个精品
  try {
    const all = await listSkills();
    const PREMIUM = new Set(['skill-01', 'skill-04', 'skill-12']);
    const needOff = all.filter((s) => s.status === 'on' && s.id && !PREMIUM.has(s.id));
    // 精品卡文案同步：以 DEFAULT_SKILLS（v1.20 精品版）为准更新已存在的精品卡
    const premiumById = {};
    DEFAULT_SKILLS.forEach((d) => { premiumById[d.skillId] = d; });
    const needUpdate = all.filter((s) => PREMIUM.has(s.id) && premiumById[s.id]);
    if (needOff.length || needUpdate.length) {
      for (const s of needOff) {
        await patchSkill(s.id, { status: 'off' });
      }
      for (const s of needUpdate) {
        const d = premiumById[s.id];
        await upsertSkill({
          skillId: d.skillId, name: d.name, value: d.value, cat: d.cat, tools: d.tools,
          diff: d.diff, time: d.time, format: d.format, file: d.file, dlName: d.dlName, dlText: d.dlText,
          hook: d.hook, preview: d.preview, status: 'on', sort: d.sort,
        });
      }
      console.log('[lib/skills-config] 已收敛为 3 个精品：下架旧卡 ' + (needOff.map((s) => s.id).join(',') || '无') + '；更新精品卡 ' + needUpdate.map((s) => s.id).join(','));
      return { created: false, seeded: false, converged: true, offCount: needOff.length, updateCount: needUpdate.length };
    }
  } catch (e) {
    console.warn('[lib/skills-config] 收敛检查跳过: ' + (e && e.message ? e.message : e));
  }
  return { created: false, seeded: false, converged: false };
}

/** 读取全部卡片（含下架） */
async function listSkills() {
  const appToken = process.env.FEISHU_APP_TOKEN;
  const tableId = await ensureSkillsTable();
  const token = await getTenantAccessToken();

  const out = [];
  let pageToken = '';
  for (let i = 0; i < 20; i++) {
    const params = new URLSearchParams({ page_size: '100' });
    if (pageToken) params.set('page_token', pageToken);
    const res = await fetch(
      `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records?${params.toString()}`,
      { headers: { Authorization: 'Bearer ' + token } }
    );
    const data = await res.json().catch(() => ({}));
    if (!data || data.code !== 0) {
      const msg = (data && data.msg) ? data.msg : 'HTTP ' + res.status;
      throw new Error('读取 skills_config 失败: ' + msg);
    }
    const items = (data.data && data.data.items) || [];
    for (const rec of items) {
      out.push({ recordId: rec.record_id, ...fieldsToCard(rec.fields || {}) });
    }
    pageToken = data.data && data.data.page_token;
    if (!pageToken || !items.length) break;
  }
  return out;
}

/** 新增或更新卡片（按 skillId 找：存在则更新，不存在则新增）
 * 部分更新语义：POST 时只传入的字段覆盖，其余保留（上下线/排序/文案均可独立提交）。 */
async function upsertSkill(card) {
  const skillId = String(card.skillId || '').trim();
  if (!skillId) throw new Error('缺少 skillId');
  const appToken = process.env.FEISHU_APP_TOKEN;
  const tableId = await ensureSkillsTable();
  const token = await getTenantAccessToken();

  const all = await listSkills();
  const existing = all.find((s) => s.id === skillId);

  // 存在时合并：只覆盖传入字段，避免清空其他字段
  const merged = existing
    ? {
        ...existing,
        ...card,
        skillId,
        hook: (card.hook || (card.hookHref || card.hookText))
          ? { ...(existing.hook || {}), ...(typeof card.hook === 'object' && card.hook ? card.hook : {}), href: card.hookHref || (card.hook && card.hook.href) || (existing.hook && existing.hook.href) || '', text: card.hookText || (card.hook && card.hook.text) || (existing.hook && existing.hook.text) || '' }
          : existing.hook,
        preview: (card.preview || card.previewTitle || card.previewStyle || card.previewLabels)
          ? { ...(existing.preview || {}), ...(typeof card.preview === 'object' && card.preview ? card.preview : {}), title: card.previewTitle || (card.preview && card.preview.title) || (existing.preview && existing.preview.title) || '', style: card.previewStyle || (card.preview && card.preview.style) || (existing.preview && existing.preview.style) || 'grid', labels: card.previewLabels || (card.preview && Array.isArray(card.preview.labels) ? card.preview.labels : (existing.preview && existing.preview.labels) || []) }
          : existing.preview,
        tools: (Array.isArray(card.tools) || typeof card.tools === 'string')
          ? (Array.isArray(card.tools) ? card.tools : String(card.tools).split(/[,，]/).map((t) => t.trim()).filter(Boolean))
          : existing.tools,
        status: card.status !== undefined ? card.status : existing.status,
        sort: card.sort !== undefined ? card.sort : existing.sort,
      }
    : { ...card, skillId };

  const fields = cardToFields(merged);

  if (existing && existing.recordId) {
    const res = await fetch(
      `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/${existing.recordId}`,
      {
        method: 'PUT',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!data || data.code !== 0) {
      const msg = (data && data.msg) ? data.msg : 'HTTP ' + res.status;
      throw new Error('更新 skills_config 记录失败: ' + msg);
    }
    return { action: 'updated', card: { ...existing, ...cardToFieldsToCard(fields) } };
  }

  const res = await fetch(
    `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!data || data.code !== 0) {
    const msg = (data && data.msg) ? data.msg : 'HTTP ' + res.status;
    throw new Error('创建 skills_config 记录失败: ' + msg);
  }
  return { action: 'created', card: cardToFieldsToCard(fields) };
}

/** 字段 → 卡片（供 upsert 返回；不依赖飞书记录结构） */
function cardToFieldsToCard(fields) {
  return fieldsToCard(fields);
}

/**
 * 部分更新卡片（PATCH）：只改传入字段（上下线/排序/文案等）。
 */
async function patchSkill(skillId, patch) {
  skillId = String(skillId || '').trim();
  if (!skillId) throw new Error('缺少 skillId');
  const appToken = process.env.FEISHU_APP_TOKEN;
  const tableId = await ensureSkillsTable();
  const token = await getTenantAccessToken();

  const all = await listSkills();
  const existing = all.find((s) => s.id === skillId);
  if (!existing) {
    const err = new Error('Skill 不存在: ' + skillId);
    err.status = 404;
    throw err;
  }

  // 合并部分字段（复用 upsert 语义：只把 patch 里的字段覆盖进去）
  const merged = { ...existing, ...patch, skillId };
  if (patch.hook) merged.hook = { ...existing.hook, ...patch.hook };
  if (patch.preview) merged.preview = { ...existing.preview, ...patch.preview };
  if (Array.isArray(patch.tools)) merged.tools = patch.tools;
  if (patch.tools && !Array.isArray(patch.tools)) merged.tools = patch.tools;
  const fields = cardToFields(merged);

  const res = await fetch(
    `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/${existing.recordId}`,
    {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!data || data.code !== 0) {
    const msg = (data && data.msg) ? data.msg : 'HTTP ' + res.status;
    throw new Error('更新 skills_config 记录失败: ' + msg);
  }
  return fieldsToCard(fields);
}

/** 清空模块级缓存（测试用） */
function resetSkillsCache() {
  skillsTableIdCache = null;
}

module.exports = {
  SKILLS_TABLE_NAME,
  DEFAULT_SKILLS,
  ensureSkillsTable,
  ensureSkillsTableSeeded,
  listSkills,
  upsertSkill,
  patchSkill,
  cardToFields,
  fieldsToCard,
  resetSkillsCache,
};
