// ============================================================================
// api/backup.js — Vercel Serverless Function
// Transition OS（products/transition-os.html）自动实时备份代理：
//   浏览器 POST /api/backup → 服务端把 localStorage 快照写入飞书多维表格
//   「transition_backup」表（云端实时备份，用户零手动操作）
//
// 安全说明：
//   - 飞书 App Secret / app_token 一律从 Vercel 环境变量读取，绝不硬编码进代码或提交 git
//   - 前端只与同域 /api/backup 通信，不暴露任何凭证
//   - 写入端公开（同 api/lead.js 线索提交模式，流量极小可接受）；
//     读取端（GET ?op=latest，含个人数据）必须携带 header x-backup-key，
//     值 = 环境变量 BACKUP_READ_KEY；未配置 BACKUP_READ_KEY 时读取默认禁用
//   - 日志只打印统计（记录数/长度），绝不打印快照内容
//
// 生产环境变量（Vercel 面板 → Project → Settings → Environment Variables）：
//   FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_APP_TOKEN（复用现有）
//   FEISHU_BACKUP_TABLE_ID（可选；不配置则自动查找/创建「transition_backup」表）
//   BACKUP_READ_KEY（推荐；从云端恢复 / Obsidian 镜像读取时鉴权用）
//
// 表结构「transition_backup」（服务端自动建表，字段名与类型如下）：
//   备份时间   DateTime（毫秒时间戳）
//   用户       Text
//   版本       Text
//   快照类型   Text   （full=完整快照 / light=超长降级摘要快照）
//   摘要       Text   （可读统计：母线/天数/资产/证据数）
//   数据快照   Text   （完整 JSON 或轻量 JSON，Text 字段上限 100,000 字符）
// ============================================================================

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
const { getTenantAccessToken } = require('../lib/feishu-token.js');

// 飞书多行文本（type 1）字段上限 100,000 字符；保守起见 full 快照超 80,000 就降级 light
const FULL_SNAPSHOT_MAX = 80000;

const BACKUP_TABLE_NAME = 'transition_backup';
const BACKUP_TABLE_FIELDS = [
  { field_name: '备份时间', type: 5 },   // DateTime：毫秒时间戳
  { field_name: '用户', type: 1 },       // Text
  { field_name: '版本', type: 1 },       // Text
  { field_name: '快照类型', type: 1 },   // Text：full / light
  { field_name: '摘要', type: 1 },       // Text：可读统计
  { field_name: '数据快照', type: 1 },   // Text：完整 JSON / 轻量 JSON
];

let backupTableIdCache = null;

// ---------- 表管理：查找或创建 transition_backup 表 ----------
async function ensureBackupTable() {
  const appToken = process.env.FEISHU_APP_TOKEN;
  if (!appToken) throw new Error('FEISHU_APP_TOKEN 未配置');

  // 优先使用环境变量指定表（无需查找）
  if (process.env.FEISHU_BACKUP_TABLE_ID) {
    backupTableIdCache = process.env.FEISHU_BACKUP_TABLE_ID.trim();
    return backupTableIdCache;
  }
  if (backupTableIdCache) return backupTableIdCache;

  const token = await getTenantAccessToken();

  // 1) 列出已有表
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
  const found = items.find((t) => t.name === BACKUP_TABLE_NAME);
  if (found) {
    backupTableIdCache = found.table_id;
    return found.table_id;
  }

  // 2) 没有 → 创建
  const createRes = await fetch(`${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ table: { name: BACKUP_TABLE_NAME, fields: BACKUP_TABLE_FIELDS } }),
  });
  const createData = await createRes.json().catch(() => ({}));
  if (!createData || createData.code !== 0 || !createData.data || !createData.data.table_id) {
    const msg = (createData && createData.msg) ? createData.msg : 'HTTP ' + createRes.status;
    throw new Error('创建 transition_backup 表失败: ' + msg);
  }
  backupTableIdCache = createData.data.table_id;
  console.log('[api/backup] 已创建 transition_backup 表: table_id=' + createData.data.table_id);
  return createData.data.table_id;
}

// ---------- 快照预处理：摘要 + 超长降级 ----------
/** 截断字符串（按字符数），用于摘要/轻量快照 */
function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** 生成可读摘要（写入「摘要」字段，便于人眼快速确认备份内容） */
function buildSummary(db) {
  const mainline = db.mainline;
  const last = Array.isArray(db.dailySessions) && db.dailySessions.length
    ? db.dailySessions.slice().sort((a, b) => (a.date < b.date ? 1 : -1))[0]
    : null;
  return [
    '母线: ' + (mainline ? mainline.name : '未设定'),
    '记录天数: ' + (Array.isArray(db.dailySessions) ? db.dailySessions.length : 0),
    '资产: ' + (Array.isArray(db.assets) ? db.assets.length : 0),
    '证据: ' + (Array.isArray(db.evidences) ? db.evidences.length : 0),
    '复盘: ' + (Array.isArray(db.weeklyReviews) ? db.weeklyReviews.length : 0),
    '最近记录: ' + (last ? last.date + (last.actionId ? '/' + last.actionId : '') : '无'),
    '创建时间: ' + ((db.meta && db.meta.createdAt) || ''),
  ].join(' | ');
}

/**
 * 超长快照降级：保留核心结构（user/mainline/meta/统计 + 最近 30 天会话摘要
 * + 资产/证据标题清单），丢长正文。确保备份永远可写、可恢复核心，不因超限失败。
 */
function buildLightSnapshot(db) {
  const sessions = (Array.isArray(db.dailySessions) ? db.dailySessions : [])
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 30)
    .map((s) => ({
      date: s.date, actionId: s.actionId, minutes: s.minutes, status: s.status,
      output: truncate(s.output || '', 300),
      assetIds: s.assetIds, evidenceIds: s.evidenceIds,
    }));
  const assets = (Array.isArray(db.assets) ? db.assets : []).map((a) => ({
    id: a.id, type: a.type, title: truncate(a.title || '', 80), date: a.date || a.createdAt || null, link: truncate(a.link || '', 120),
  }));
  const evidences = (Array.isArray(db.evidences) ? db.evidences : []).map((e) => ({
    id: e.id, type: e.type, title: truncate(e.title || '', 80), date: e.date || e.createdAt || null,
  }));
  const reviews = (Array.isArray(db.weeklyReviews) ? db.weeklyReviews : []).map((r) => ({
    date: r.date, points: truncate((r.points || r.summary || ''), 200),
  }));
  return {
    light: true, user: db.user, mainline: db.mainline, meta: db.meta,
    dailySessions: sessions, assets, evidences, weeklyReviews: reviews,
    counts: {
      days: (db.dailySessions || []).length, assets: (db.assets || []).length,
      evidences: (db.evidences || []).length, reviews: (db.weeklyReviews || []).length,
    },
  };
}

/** 准备快照：返回 { text, type, truncated } */
function prepareSnapshot(db) {
  const full = JSON.stringify(db);
  if (full.length <= FULL_SNAPSHOT_MAX) {
    return { text: full, type: 'full', truncated: false };
  }
  const light = JSON.stringify(buildLightSnapshot(db));
  return { text: light, type: 'light', truncated: true };
}

// ---------- 飞书写入 ----------
async function writeBackup(fields) {
  const appToken = process.env.FEISHU_APP_TOKEN;
  const tableId = await ensureBackupTable();
  const token = await getTenantAccessToken();

  const res = await fetch(`${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data || data.code !== 0) {
    const msg = (data && data.msg) ? data.msg : 'HTTP ' + res.status;
    throw new Error('写入 transition_backup 失败: ' + msg);
  }
  return data.data;
}

// ---------- 飞书读取最新快照 ----------
/** 读取某用户最新一条备份记录（按「备份时间」倒序取第一条） */
async function readLatestBackup(userId) {
  const appToken = process.env.FEISHU_APP_TOKEN;
  const tableId = await ensureBackupTable();
  const token = await getTenantAccessToken();

  const url = `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records`
    + `?page_size=1&sort=${encodeURIComponent(JSON.stringify([{ field_name: '备份时间', desc: true }]))}`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json().catch(() => ({}));
  if (!data || data.code !== 0) {
    const msg = (data && data.msg) ? data.msg : 'HTTP ' + res.status;
    throw new Error('读取 transition_backup 失败: ' + msg);
  }
  const items = (data.data && data.data.items) || [];
  if (!items.length) return null;

  const rec = items[0];
  const f = rec.fields || {};
  const pick = (k) => (typeof f[k] === 'string' ? f[k] : Array.isArray(f[k]) && f[k][0] ? f[k][0].text : '');
  return {
    recordId: rec.record_id,
    backupTime: f['备份时间'] || 0,
    userId: pick('用户') || '',
    version: pick('版本') || '',
    snapshotType: pick('快照类型') || '',
    summary: pick('摘要') || '',
    snapshot: pick('数据快照') || '',
  };
}

// ---------- 读取鉴权 ----------
function checkReadKey(req) {
  const key = process.env.BACKUP_READ_KEY;
  if (!key) return false; // 未配置读取口令 → 读取禁用
  const provided = req.headers['x-backup-key'] || req.headers['X-Backup-Key'] || '';
  return provided === key;
}

// ---------- Handler ----------
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-backup-key');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (req.method === 'GET') {
    // GET /api/backup?op=latest — 读取最新快照（带口令鉴权，供前端恢复 / Obsidian 镜像）
    const op = req.query && req.query.op;
    if (op !== 'latest') {
      res.status(400).json({ ok: false, message: '仅支持 ?op=latest' });
      return;
    }
    if (!checkReadKey(req)) {
      res.status(401).json({ ok: false, message: '读取口令缺失或错误' });
      return;
    }
    try {
      const latest = await readLatestBackup(String(req.query.userId || 'masterlinc'));
      if (!latest) {
        res.status(404).json({ ok: false, message: '暂无备份记录' });
        return;
      }
      res.status(200).json({ ok: true, data: latest });
    } catch (err) {
      console.error('[api/backup] GET ' + (err && err.message ? err.message : err));
      res.status(502).json({ ok: false, message: '服务暂时不可用，请稍后重试' });
    }
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, message: 'Method Not Allowed' });
    return;
  }

  // POST /api/backup — 写入备份快照
  let body;
  try {
    body = (typeof req.body === 'object' && req.body !== null) ? req.body : JSON.parse(req.body || '{}');
  } catch (e) {
    res.status(400).json({ ok: false, message: '请求体不是合法 JSON' });
    return;
  }

  const db = body.db;
  const userId = String(body.userId || 'masterlinc').slice(0, 100);
  const version = String(body.version || '').slice(0, 50);
  if (!db || typeof db !== 'object' || !db.user) {
    res.status(400).json({ ok: false, message: '缺少有效的数据快照 db' });
    return;
  }

  try {
    const snap = prepareSnapshot(db);
    const summary = buildSummary(db);
    const fields = {
      '备份时间': (typeof body.ts === 'number' && body.ts > 0) ? body.ts : Date.now(),
      '用户': userId,
      '版本': version || 'unknown',
      '快照类型': snap.type,
      '摘要': summary,
      '数据快照': snap.text,
    };
    const created = await writeBackup(fields);
    const recordId = (created && created.record) ? created.record.record_id : '';
    const len = snap.text.length;
    console.log(`[api/backup] 备份成功 userId=${userId} type=${snap.type} len=${len} recordId=${recordId}`);
    res.status(200).json({ ok: true, recordId, snapshotType: snap.type, truncated: snap.truncated });
  } catch (err) {
    console.error('[api/backup] POST ' + (err && err.message ? err.message : err));
    // 不向客户端暴露飞书内部错误细节
    res.status(502).json({ ok: false, message: '服务暂时不可用，请稍后重试' });
  }
};

// 导出内部函数供本地单测（Vercel 只调用 module.exports 本身，附加属性不影响）
module.exports.buildSummary = buildSummary;
module.exports.buildLightSnapshot = buildLightSnapshot;
module.exports.prepareSnapshot = prepareSnapshot;
module.exports.ensureBackupTable = ensureBackupTable;
module.exports.checkReadKey = checkReadKey;
