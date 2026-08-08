// ============================================================================
// api/publish.js — Transition OS 内容发布工作台（任务队列 + 账号配置）
// Vercel Serverless Function
//
// 职责：
//   POST /api/publish                          → 创建发布任务（写入飞书表 publish_tasks）
//   GET  /api/publish?op=pending&key=xxx       → Proma 本机拉取待办任务（需 x-publish-key）
//   POST /api/publish?op=done                  → Proma 回写发布结果（需 x-publish-key）
//   GET  /api/publish?op=config                → 读账号配置（脱敏；同域页面可用）
//   POST /api/publish?op=config&key=xxx        → 写账号配置（需 x-publish-key，Secret 加密脱敏）
//   GET  /api/publish?op=list&userId=masterlinc→ 页面显示最近任务
//
// 存储：飞书多维表格（与 backup.js 同 app，复用 lib/feishu-token.js）
//   表「publish_tasks」：发布任务队列
//   表「publish_config」：账号配置（AppSecret 用环境变量 PUBLISH_ENC_KEY 做简单异或混淆后存储）
//
// 安全：
//   - 创建任务/读列表/读配置（脱敏）：公开（同 backup/lead 模式，流量小可接受）
//   - 拉待办/回写/写配置：必须 header x-publish-key = 环境变量 PUBLISH_KEY（未配置则禁用）
//   - 前端不暴露任何 Secret；日志只打印统计，绝不打印正文/Secret
// ============================================================================

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
const { getTenantAccessToken } = require('../lib/feishu-token.js');

const TASK_TABLE_NAME = 'publish_tasks';
const TASK_TABLE_FIELDS = [
  { field_name: '任务ID', type: 1 },       // Text
  { field_name: '创建时间', type: 5 },     // DateTime
  { field_name: '用户', type: 1 },         // Text
  { field_name: '标题', type: 1 },         // Text
  { field_name: '正文', type: 1 },         // Text（Markdown 母稿）
  { field_name: '选项', type: 1 },         // Text（JSON：封面/图文/平台开关）
  { field_name: '状态', type: 1 },         // Text：pending/processing/done/failed
  { field_name: '执行时间', type: 5 },     // DateTime
  { field_name: '结果', type: 1 },         // Text（JSON：各平台 media_id/url/错误）
  { field_name: '备注', type: 1 },         // Text
];

const CONFIG_TABLE_NAME = 'publish_config';
const CONFIG_TABLE_FIELDS = [
  { field_name: '配置键', type: 1 },       // Text：wechat_mp / xiaohongshu / jike
  { field_name: '配置值', type: 1 },       // Text（JSON，Secret 混淆）
  { field_name: '更新时间', type: 5 },     // DateTime
  { field_name: '备注', type: 1 },         // Text
];

let taskTableIdCache = null;
let configTableIdCache = null;

// ---------- 工具：简单混淆（不用于高安全场景，仅防明文落库） ----------
function obfuscate(s) {
  const key = process.env.PUBLISH_ENC_KEY || 'transition-publish-default';
  if (!s) return '';
  let out = '';
  for (let i = 0; i < s.length; i++) {
    out += String.fromCharCode(s.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return 'obf:' + Buffer.from(out, 'binary').toString('base64');
}
function deobfuscate(s) {
  const key = process.env.PUBLISH_ENC_KEY || 'transition-publish-default';
  if (!s || !s.startsWith('obf:')) return s || '';
  const buf = Buffer.from(s.slice(4), 'base64').toString('binary');
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    out += String.fromCharCode(buf.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out;
}

// ---------- 表管理 ----------
async function ensureTable(tableName, fields) {
  const appToken = process.env.FEISHU_APP_TOKEN;
  if (!appToken) throw new Error('FEISHU_APP_TOKEN 未配置');
  const token = await getTenantAccessToken();

  const listRes = await fetch(`${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables?page_size=100`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  const listData = await listRes.json().catch(() => ({}));
  if (!listData || listData.code !== 0) throw new Error('查询表列表失败: ' + ((listData && listData.msg) || listRes.status));
  const found = ((listData.data && listData.data.items) || []).find((t) => t.name === tableName);
  if (found) return found.table_id;

  const createRes = await fetch(`${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ table: { name: tableName, default_view_name: '主表', fields } }),
  });
  const createData = await createRes.json().catch(() => ({}));
  if (!createData || createData.code !== 0) throw new Error('创建表失败: ' + ((createData && createData.msg) || createRes.status));
  return createData.data.table_id;
}

async function taskTable() {
  if (taskTableIdCache) return taskTableIdCache;
  taskTableIdCache = await ensureTable(TASK_TABLE_NAME, TASK_TABLE_FIELDS);
  return taskTableIdCache;
}
async function configTable() {
  if (configTableIdCache) return configTableIdCache;
  configTableIdCache = await ensureTable(CONFIG_TABLE_NAME, CONFIG_TABLE_FIELDS);
  return configTableIdCache;
}

// ---------- 记录读写 ----------
async function addRecord(tableId, fields) {
  const appToken = process.env.FEISHU_APP_TOKEN;
  const token = await getTenantAccessToken();
  const res = await fetch(`${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ fields }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data || data.code !== 0) throw new Error('写入记录失败: ' + ((data && data.msg) || res.status));
  return data.data.record;
}

async function listRecords(tableId, pageSize) {
  const appToken = process.env.FEISHU_APP_TOKEN;
  const token = await getTenantAccessToken();
  const url = `${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=${pageSize || 20}`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json().catch(() => ({}));
  if (!data || data.code !== 0) throw new Error('读取记录失败: ' + ((data && data.msg) || res.status));
  return (data.data && data.data.items) || [];
}

async function updateRecord(tableId, recordId, fields) {
  const appToken = process.env.FEISHU_APP_TOKEN;
  const token = await getTenantAccessToken();
  const res = await fetch(`${FEISHU_BASE}/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ fields }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data || data.code !== 0) throw new Error('更新记录失败: ' + ((data && data.msg) || res.status));
  return data.data.record;
}

// ---------- 鉴权 ----------
function checkKey(req, res) {
  const expected = process.env.PUBLISH_KEY;
  if (!expected) {
    res.status(403).json({ ok: false, message: 'PUBLISH_KEY 未配置，本操作已禁用' });
    return false;
  }
  const got = req.headers['x-publish-key'];
  if (got !== expected) {
    res.status(403).json({ ok: false, message: 'x-publish-key 无效' });
    return false;
  }
  return true;
}

function readBody(req) {
  try {
    return (typeof req.body === 'object' && req.body !== null) ? req.body : JSON.parse(req.body || '{}');
  } catch (e) {
    return null;
  }
}

// ---------- 任务/配置逻辑 ----------
async function createTask(body) {
  const title = String(body.title || '').trim().slice(0, 200);
  const content = String(body.content || '').slice(0, 50000);
  const userId = String(body.userId || 'masterlinc').slice(0, 100);
  const options = body.options && typeof body.options === 'object' ? JSON.stringify(body.options) : '{}';
  if (!title) throw new Error('缺少标题');
  const tableId = await taskTable();
  const record = await addRecord(tableId, {
    '任务ID': 'pub_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    '创建时间': Date.now(),
    '用户': userId,
    '标题': title,
    '正文': content,
    '选项': options,
    '状态': 'pending',
    '备注': '由 Transition OS 发布工作台创建',
  });
  const taskId = record.fields['任务ID'];
  return { taskId };
}

async function listTasks(userId, limit) {
  const tableId = await taskTable();
  const items = await listRecords(tableId, limit || 20);
  const rows = items.map((r) => {
    const f = r.fields || {};
    return {
      recordId: r.record_id,
      taskId: f['任务ID'] || '',
      ts: f['创建时间'] || 0,
      userId: f['用户'] || '',
      title: f['标题'] || '',
      status: f['状态'] || '',
      options: safeParse(f['选项']),
      result: safeParse(f['结果']),
      note: f['备注'] || '',
    };
  });
  const filtered = userId ? rows.filter((r) => r.userId === userId) : rows;
  return filtered.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, limit || 20);
}

async function listPending() {
  const tableId = await taskTable();
  const items = await listRecords(tableId, 50);
  return items
    .map((r) => ({ recordId: r.record_id, fields: r.fields || {} }))
    .filter((r) => r.fields['状态'] === 'pending')
    .map((r) => ({
      recordId: r.recordId,
      taskId: r.fields['任务ID'] || '',
      ts: r.fields['创建时间'] || 0,
      userId: r.fields['用户'] || '',
      title: r.fields['标题'] || '',
      content: r.fields['正文'] || '',
      options: safeParse(r.fields['选项']),
    }));
}

async function markDone(body) {
  const taskId = String(body.taskId || '');
  const status = String(body.status || 'done');
  if (!taskId) throw new Error('缺少 taskId');
  const tableId = await taskTable();
  const items = await listRecords(tableId, 50);
  const rec = items.find((r) => (r.fields || {})['任务ID'] === taskId);
  if (!rec) throw new Error('任务不存在: ' + taskId);
  const result = body.result && typeof body.result === 'object' ? JSON.stringify(body.result) : '{}';
  await updateRecord(tableId, rec.record_id, {
    '状态': status === 'failed' ? 'failed' : 'done',
    '执行时间': Date.now(),
    '结果': result,
    '备注': body.note ? String(body.note).slice(0, 500) : (rec.fields['备注'] || ''),
  });
  return { ok: true, taskId, status };
}

// ---------- 配置读写 ----------
const CONFIG_DEFAULTS = {
  wechat_mp: { appId: '', appSecretSet: false, ipWhitelist: '', ipWhitelistStatus: 'unknown' },
  xiaohongshu: { nickname: '', loginStatus: 'unknown' },
  jike: { loginStatus: 'unknown' },
};

async function getConfigPublic() {
  const tableId = await configTable();
  const items = await listRecords(tableId, 50);
  const out = JSON.parse(JSON.stringify(CONFIG_DEFAULTS));
  for (const r of items) {
    const f = r.fields || {};
    const key = f['配置键'] || '';
    const val = safeParse(f['配置值']);
    if (!val) continue;
    if (key === 'wechat_mp') {
      out.wechat_mp.appId = val.appId || '';
      out.wechat_mp.appSecretSet = !!(val.appSecret && deobfuscate(val.appSecret));
      out.wechat_mp.ipWhitelist = val.ipWhitelist || '';
      out.wechat_mp.ipWhitelistStatus = val.ipWhitelistStatus || 'unknown';
    } else if (key === 'xiaohongshu') {
      out.xiaohongshu = { nickname: val.nickname || '', loginStatus: val.loginStatus || 'unknown' };
    } else if (key === 'jike') {
      out.jike = { loginStatus: val.loginStatus || 'unknown' };
    }
  }
  return out;
}

async function setConfig(body) {
  const key = String(body.key || '');
  if (!['wechat_mp', 'xiaohongshu', 'jike'].includes(key)) throw new Error('未知配置键');
  const val = body.value && typeof body.value === 'object' ? body.value : {};
  let store = JSON.parse(JSON.stringify(val));
  if (key === 'wechat_mp' && store.appSecret) {
    store.appSecret = obfuscate(String(store.appSecret));
    store.appSecretSet = true;
  }
  const tableId = await configTable();
  const items = await listRecords(tableId, 50);
  const rec = items.find((r) => (r.fields || {})['配置键'] === key);
  const fields = {
    '配置键': key,
    '配置值': JSON.stringify(store),
    '更新时间': Date.now(),
    '备注': '由发布工作台更新',
  };
  if (rec) await updateRecord(tableId, rec.record_id, fields);
  else await addRecord(tableId, fields);
  return { ok: true, key };
}

function safeParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

// ============================================================================
module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const op = url.searchParams.get('op') || '';

  try {
    // GET 配置（脱敏）
    if (op === 'config' && req.method === 'GET') {
      const cfg = await getConfigPublic();
      res.status(200).json({ ok: true, data: cfg });
      return;
    }

    // GET pending（Proma 拉取待办）
    if (op === 'pending' && req.method === 'GET') {
      if (!checkKey(req, res)) return;
      const tasks = await listPending();
      res.status(200).json({ ok: true, count: tasks.length, tasks });
      return;
    }

    // GET list（页面显示最近任务）
    if (op === 'list' && req.method === 'GET') {
      const userId = url.searchParams.get('userId') || '';
      const limit = Number(url.searchParams.get('limit') || '20');
      const tasks = await listTasks(userId, limit);
      res.status(200).json({ ok: true, count: tasks.length, tasks });
      return;
    }

    // POST done（Proma 回写）
    if (op === 'done' && req.method === 'POST') {
      if (!checkKey(req, res)) return;
      const body = readBody(req);
      if (!body) { res.status(400).json({ ok: false, message: '请求体不是合法 JSON' }); return; }
      const r = await markDone(body);
      res.status(200).json(r);
      return;
    }

    // POST config（写配置）
    if (op === 'config' && req.method === 'POST') {
      if (!checkKey(req, res)) return;
      const body = readBody(req);
      if (!body) { res.status(400).json({ ok: false, message: '请求体不是合法 JSON' }); return; }
      const r = await setConfig(body);
      res.status(200).json(r);
      return;
    }

    // POST 创建任务
    if (req.method === 'POST') {
      const body = readBody(req);
      if (!body) { res.status(400).json({ ok: false, message: '请求体不是合法 JSON' }); return; }
      const r = await createTask(body);
      res.status(200).json({ ok: true, ...r });
      return;
    }

    res.status(405).json({ ok: false, message: 'Method Not Allowed' });
  } catch (err) {
    console.error('[api/publish] ' + (err && err.message ? err.message : err));
    res.status(502).json({ ok: false, message: '服务暂时不可用，请稍后重试' });
  }
};

// 导出供本地单测
module.exports._internal = { createTask, listTasks, listPending, markDone, getConfigPublic, setConfig, obfuscate, deobfuscate };
