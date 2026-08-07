// ============================================================================
// lib/events.js — behavior_events 事件表共享模块
//
// 对齐《行为日志系统技术方案》（08-06）§3：自动建表（复用 backup.js ensure 模式）、
// 字段白名单 + 匿名化、批量写、查询与聚合。被以下端点共用：
//   - /api/track                写入（最小版事件集）
//   - /api/admin/downloads      下载统计聚合（uid+skillId 去重）
//   - /api/admin/traffic        page_view 聚合（PV/UV/热门页面/按天趋势）
//   - /api/admin/events         事件流水浏览（分页/筛选）
//
// 表结构 behavior_events（字段名与类型对齐现有约定：Text=type 1，DateTime=type 5）：
//   事件时间 DateTime / 事件 Text / 页面 Text / 匿名ID Text / 会话ID Text
//   来源 Text / 扩展信息 Text / 数据版本 Text / 用户代理 Text
//
// 匿名化红线：不存邮箱/IP/正文；extra 只收白名单 key，值再经邮箱正则过滤；
// 日志只打印统计。
// ============================================================================

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
const { getTenantAccessToken } = require('./feishu-token.js');

const EVENTS_TABLE_NAME = 'behavior_events';
const EVENTS_TABLE_FIELDS = [
  { field_name: '事件时间', type: 5 },   // DateTime：毫秒时间戳
  { field_name: '事件', type: 1 },       // Text：ev
  { field_name: '页面', type: 1 },       // Text：page
  { field_name: '匿名ID', type: 1 },     // Text：uid
  { field_name: '会话ID', type: 1 },     // Text：sid
  { field_name: '来源', type: 1 },       // Text：ref
  { field_name: '扩展信息', type: 1 },   // Text：extra JSON（服务端截断 500 字符）
  { field_name: '数据版本', type: 1 },   // Text：v
  { field_name: '用户代理', type: 1 },   // Text：UA（截断 300 字符）
];

// 事件白名单（最小可用版；后续扩展 os_* 等在此追加）
const EVENT_ALLOW = new Set(['page_view', 'skill_download', 'lead_submit', 'skill_pack_submit']);

// extra 字段白名单（对齐行为日志方案 §3.3 + Skill 下载口径追加）
const EXTRA_ALLOW = new Set([
  // 通用
  'path', 'title', 'from', 'to', 'where', 'which', 'step', 'sel', 'source',
  // 自检 / 线索
  'resultType', 'taskLen', 'hasEmail', 'reason',
  // Skill 下载（对齐 Skill 数据方案 §4.1）
  'skillId', 'skillName', 'category', 'level', 'fileType', 'dlFrom', 'isPack',
  // Skill 全集包
  'wantCategory', 'packSource',
  // 转型系统（二期预留）
  'mode', 'isEdit', 'actionId', 'cat', 'kind', 'subtype', 'len',
  'switchCount', 'ratio', 'marks', 'days', 'assets', 'evidences',
  'status', 'type', 'ok', 'cloudBackupOn', 'hasDB', 'hasMainline', 'osId',
]);

// 邮箱正则（extra 值过滤用）
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const EXTRA_MAX = 500;    // 扩展信息 JSON 截断
const REF_MAX = 100;      // 来源字段截断
const V_MAX = 30;         // 数据版本截断
const PAGE_MAX = 50;      // 页面字段截断
const ID_MAX = 64;        // uid / sid 截断
const UA_MAX = 300;       // 用户代理截断

let eventsTableIdCache = null;

// ---------- 表管理：查找或创建 behavior_events 表 ----------
async function ensureEventsTable() {
  const appToken = process.env.FEISHU_APP_TOKEN;
  if (!appToken) throw new Error('FEISHU_APP_TOKEN 未配置');

  if (process.env.FEISHU_EVENTS_TABLE_ID) {
    eventsTableIdCache = process.env.FEISHU_EVENTS_TABLE_ID.trim();
    return eventsTableIdCache;
  }
  if (eventsTableIdCache) return eventsTableIdCache;

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
  const found = items.find((t) => t.name === EVENTS_TABLE_NAME);
  if (found) {
    eventsTableIdCache = found.table_id;
    return found.table_id;
  }

  // 2) 没有 → 创建
  const createRes = await fetch(`${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ table: { name: EVENTS_TABLE_NAME, fields: EVENTS_TABLE_FIELDS } }),
  });
  const createData = await createRes.json().catch(() => ({}));
  if (!createData || createData.code !== 0 || !createData.data || !createData.data.table_id) {
    const msg = (createData && createData.msg) ? createData.msg : 'HTTP ' + createRes.status;
    throw new Error('创建 behavior_events 表失败: ' + msg);
  }
  eventsTableIdCache = createData.data.table_id;
  console.log('[lib/events] 已创建 behavior_events 表: table_id=' + createData.data.table_id);
  return createData.data.table_id;
}

// ---------- 事件清洗（白名单 + 匿名化） ----------
function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) : s;
}

/** 过滤 extra：只收白名单 key，值做邮箱正则打码 + 长度截断 */
function sanitizeExtra(extra) {
  if (!extra || typeof extra !== 'object') return {};
  const out = {};
  for (const key of Object.keys(extra)) {
    if (!EXTRA_ALLOW.has(key)) continue;
    let val = extra[key];
    if (typeof val === 'string') {
      val = val.replace(EMAIL_RE, '[filtered]');
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      // 保留
    } else {
      try { val = JSON.stringify(val); } catch (e) { continue; }
    }
    if (String(val).length > 120) val = String(val).slice(0, 120);
    out[key] = val;
  }
  return out;
}

/**
 * 清洗单条原始事件（服务端入口强制）。
 * @returns {object|null} 飞书 fields；校验不过返回 null
 */
function sanitizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ev = String(raw.ev || '').trim();
  if (!EVENT_ALLOW.has(ev)) return null;           // 事件白名单
  const uid = truncate(raw.uid || '', ID_MAX);
  const sid = truncate(raw.sid || '', ID_MAX);
  if (!uid || !sid) return null;                    // 匿名 ID / 会话 ID 必填
  // 前端 SDK 兼容：path 可能放顶层（lib/track.js），并入 extra 供聚合使用
  const extra = sanitizeExtra(raw.extra);
  if (raw.path && !('path' in extra)) extra.path = truncate(raw.path, 200);
  const extraJson = JSON.stringify(extra);
  // 前端 SDK 用 t（lib/track.js）或标准 ts，兼容两者
  const ts = (typeof raw.ts === 'number' && raw.ts > 0)
    ? raw.ts
    : (typeof raw.t === 'number' && raw.t > 0) ? raw.t : Date.now();
  return {
    '事件时间': ts,
    '事件': ev,
    '页面': truncate(raw.page || '', PAGE_MAX),
    '匿名ID': uid,
    '会话ID': sid,
    '来源': truncate(raw.ref || '', REF_MAX),
    '扩展信息': extraJson.length > EXTRA_MAX ? extraJson.slice(0, EXTRA_MAX) : extraJson,
    '数据版本': truncate(raw.v || '', V_MAX),
    '用户代理': truncate(raw.ua || '', UA_MAX),
  };
}

// ---------- 写入 ----------
/**
 * 批量写入事件（每批 ≤100 条）。
 * @returns {Promise<number>} 写入条数；失败抛错（调用方决定降级）
 */
async function batchCreateEvents(events) {
  const appToken = process.env.FEISHU_APP_TOKEN;
  const tableId = await ensureEventsTable();
  const token = await getTenantAccessToken();

  const payloads = [];
  for (const ev of events) {
    const fields = sanitizeEvent(ev);
    if (fields) payloads.push({ fields });
  }
  if (!payloads.length) return 0;

  const res = await fetch(
    `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`,
    {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: payloads.slice(0, 100) }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!data || data.code !== 0) {
    const msg = (data && data.msg) ? data.msg : 'HTTP ' + res.status;
    throw new Error('批量写入 behavior_events 失败: ' + msg);
  }
  return payloads.length;
}

// ---------- 读取 ----------
/** 飞书字段取值：字符串 / 数组[{text}] 归一化 */
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

/** 归一化一条事件记录 */
function parseEventRecord(rec) {
  const f = rec.fields || {};
  let extra = {};
  try { extra = JSON.parse(pickField(f, '扩展信息') || '{}'); } catch (e) { extra = {}; }
  return {
    recordId: rec.record_id,
    ts: typeof f['事件时间'] === 'number' ? f['事件时间'] : 0,
    ev: pickField(f, '事件') || '',
    page: pickField(f, '页面') || '',
    uid: pickField(f, '匿名ID') || '',
    sid: pickField(f, '会话ID') || '',
    ref: pickField(f, '来源') || '',
    extra,
    v: pickField(f, '数据版本') || '',
    ua: pickField(f, '用户代理') || '',
  };
}

/**
 * 翻页拉取全部记录（个人站量级小，函数内 JS 聚合足够）。
 * @param {{ev?: string, from?: number, to?: number}} [opts]
 * @returns {Promise<Array>} 归一化事件数组（按事件时间升序）
 */
async function fetchAllEvents(opts) {
  const appToken = process.env.FEISHU_APP_TOKEN;
  const tableId = await ensureEventsTable();
  const token = await getTenantAccessToken();

  const out = [];
  let pageToken = '';
  for (let i = 0; i < 50; i++) { // 防死循环：最多 50 页（5000 条，个人站绰绰有余）
    const params = new URLSearchParams({ page_size: '100' });
    if (pageToken) params.set('page_token', pageToken);
    const url = `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records?${params.toString()}`;
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    const data = await res.json().catch(() => ({}));
    if (!data || data.code !== 0) {
      const msg = (data && data.msg) ? data.msg : 'HTTP ' + res.status;
      throw new Error('读取 behavior_events 失败: ' + msg);
    }
    const items = (data.data && data.data.items) || [];
    for (const rec of items) out.push(parseEventRecord(rec));
    pageToken = data.data && data.data.page_token;
    if (!pageToken || !items.length) break;
  }

  // 筛选
  let list = out;
  if (opts) {
    if (opts.ev) list = list.filter((e) => e.ev === opts.ev);
    if (opts.from) list = list.filter((e) => e.ts >= opts.from);
    if (opts.to) list = list.filter((e) => e.ts <= opts.to);
  }
  return list;
}

/** 分页浏览事件流水（倒序） */
async function listEvents(opts) {
  const { ev, path, from, to, page = 1, pageSize = 50 } = opts || {};
  let list = await fetchAllEvents({ ev, from, to });
  if (path) list = list.filter((e) => e.page === path);
  list.sort((a, b) => b.ts - a.ts); // 倒序
  const total = list.length;
  const start = (Math.max(1, page) - 1) * pageSize;
  const items = list.slice(start, start + pageSize).map((e) => ({
    recordId: e.recordId,
    time: e.ts,
    ev: e.ev,
    page: e.page,
    uid: e.uid ? e.uid.slice(0, 8) : '',   // 展示脱敏：匿名 ID 前 8 位
    ref: e.ref,
    extra: e.extra,
    v: e.v,
    ua: e.ua,
  }));
  return { total, page, pageSize, items };
}

// ---------- 聚合：下载统计 ----------
/**
 * 按 skillId 聚合 skill_download（去重口径：同 uid + 同 skillId 只计 1）。
 * @returns {Promise<{rawTotal: number, total: number, skills: Array}>}
 */
async function aggregateDownloads(opts) {
  const list = await fetchAllEvents({ ev: 'skill_download', from: opts && opts.from, to: opts && opts.to });

  const byUidSkill = new Map(); // `uid|skillId` -> first record
  for (const e of list) {
    const skillId = String((e.extra && e.extra.skillId) || '').trim();
    if (!skillId) continue;
    const key = (e.uid || '') + '|' + skillId;
    if (!byUidSkill.has(key)) byUidSkill.set(key, e);
  }

  const bySkill = new Map(); // skillId -> { count, lastAt, skillName, category }
  for (const e of byUidSkill.values()) {
    const skillId = String(e.extra.skillId).trim();
    const cur = bySkill.get(skillId) || {
      skillId,
      skillName: String(e.extra.skillName || '').slice(0, 80),
      category: String(e.extra.category || '').slice(0, 40),
      count: 0,
      lastAt: 0,
    };
    cur.count += 1;
    if (e.ts > cur.lastAt) cur.lastAt = e.ts;
    bySkill.set(skillId, cur);
  }

  const skills = Array.from(bySkill.values())
    .sort((a, b) => b.count - a.count || a.skillId.localeCompare(b.skillId));
  const total = skills.reduce((s, x) => s + x.count, 0);
  return { rawTotal: list.length, total, skills };
}

// ---------- 聚合：访问数据 ----------
function dayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 聚合 page_view：PV / UV / 热门页面 / 按天趋势 / 来源 Top。
 * @returns {Promise<{pv, uv, pages, daily, sources}>}
 */
async function aggregateTraffic(opts) {
  const list = await fetchAllEvents({ ev: 'page_view', from: opts && opts.from, to: opts && opts.to });

  const pv = list.length;
  const uvSet = new Set();
  const pageMap = new Map();   // path -> { count, uids:Set }
  const dailyMap = new Map();  // day -> { pv, uvSet }
  const srcMap = new Map();    // ref -> count

  for (const e of list) {
    if (e.uid) uvSet.add(e.uid);
    const path = String((e.extra && e.extra.path) || e.page || '/').slice(0, 200);
    let pm = pageMap.get(path);
    if (!pm) { pm = { count: 0, uids: new Set() }; pageMap.set(path, pm); }
    pm.count += 1;
    if (e.uid) pm.uids.add(e.uid);
    const src = (e.ref || '直接访问').slice(0, 100);
    srcMap.set(src, (srcMap.get(src) || 0) + 1);

    const k = dayKey(e.ts);
    let day = dailyMap.get(k);
    if (!day) { day = { date: k, pv: 0, uvSet: new Set() }; dailyMap.set(k, day); }
    day.pv += 1;
    if (e.uid) day.uvSet.add(e.uid);
  }

  const pages = Array.from(pageMap.entries())
    .map(([path, { count, uids }]) => ({ path, pv: count, uv: uids.size, count }))
    .sort((a, b) => b.pv - a.pv)
    .slice(0, 10);
  const sources = Array.from(srcMap.entries())
    .map(([source, count]) => ({ source, name: source, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  const daily = Array.from(dailyMap.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, d]) => ({ date, pv: d.pv, uv: d.uvSet.size }));

  return { pv, uv: uvSet.size, pages, daily, sources };
}

/** 清空模块级缓存（测试用） */
function resetEventsCache() {
  eventsTableIdCache = null;
}

module.exports = {
  EVENTS_TABLE_NAME,
  EVENT_ALLOW,
  EXTRA_ALLOW,
  ensureEventsTable,
  sanitizeEvent,
  sanitizeExtra,
  batchCreateEvents,
  fetchAllEvents,
  listEvents,
  aggregateDownloads,
  aggregateTraffic,
  parseEventRecord,
  resetEventsCache,
};
