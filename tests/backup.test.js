// ============================================================================
// tests/backup.test.js — api/backup.js 本地单测（零依赖，mock fetch，不发送真实请求）
// 运行：node tests/backup.test.js
// 覆盖：
//   1) POST 正常写入：校验 URL / 字段（备份时间/用户/版本/快照类型/摘要/数据快照）/
//      Text 字段纯字符串 / 返回 ok + snapshotType=full
//   2) transition_backup 表不存在 → 自动创建后写入
//   3) 超长快照（>80,000 字符）→ 降级 light 快照，仍写入成功
//   4) GET ?op=latest 鉴权：无 key 401 / 错误 key 401 / 正确 key 200 + 最新快照
//   5) GET 未配置 BACKUP_READ_KEY → 读取禁用 401
//   6) 非法请求：非 POST 405、非法 body 400、op 非 latest 400、缺 db 400
// ============================================================================

const assert = require('assert');

// ---------- mock 环境 ----------
const envBackup = { FEISHU_APP_TOKEN: 'app_mock', BACKUP_READ_KEY: 'read-secret-123' };
function setEnv(overrides) {
  for (const k of ['FEISHU_APP_TOKEN', 'FEISHU_APP_SECRET', 'FEISHU_APP_ID', 'FEISHU_BACKUP_TABLE_ID', 'BACKUP_READ_KEY']) {
    delete process.env[k];
  }
  Object.assign(process.env, { FEISHU_APP_TOKEN: 'app_mock', FEISHU_APP_ID: 'cli_mock', FEISHU_APP_SECRET: 'secret_mock' }, overrides);
}

// ---------- mock 飞书多维表格 ----------
let backupTable = { exists: true, tableId: 'tblBackupMock', records: [] };
let recordSeq = 0;
let apiCalls = [];

function resetTable() {
  backupTable = { exists: true, tableId: 'tblBackupMock', records: [] };
  recordSeq = 0;
  apiCalls = [];
}

function feishuMock(path, opts) {
  const method = (opts && opts.method) || 'GET';
  apiCalls.push({ method, path });

  // token（getTenantAccessToken 内部调用）
  if (path.includes('/auth/v3/tenant_access_token/internal')) {
    return { status: 200, json: async () => ({ code: 0, tenant_access_token: 't_mock', expire: 7200 }) };
  }
  // 表列表 / 创建表
  if (/\/tables(\?|$)/.test(path)) {
    if (method === 'GET') {
      return { status: 200, json: async () => ({ code: 0, data: { items: backupTable.exists ? [{ table_id: backupTable.tableId, name: 'transition_backup' }] : [] } }) };
    }
    if (method === 'POST') {
      backupTable.exists = true;
      backupTable.tableId = 'tblBackupMock';
      return { status: 200, json: async () => ({ code: 0, data: { table_id: backupTable.tableId } }) };
    }
  }
  // 记录：写入 / 读取
  if (path.includes('/tables/tblBackupMock/records')) {
    if (method === 'POST') {
      const fields = JSON.parse(opts.body).fields;
      const rec = { record_id: 'backup-rec-' + (++recordSeq), fields };
      backupTable.records.push(rec);
      return { status: 200, json: async () => ({ code: 0, data: { record: rec } }) };
    }
    if (method === 'GET') {
      // 简化：按 mock 数组倒序返回第一条（模拟 sort desc）
      const sorted = backupTable.records.slice().reverse();
      return { status: 200, json: async () => ({ code: 0, data: { items: sorted.slice(0, 1) } }) };
    }
  }
  return { status: 404, json: async () => ({ code: 404, msg: 'not found' }) };
}

// ---------- 加载被测模块（require 一次，改 env/mock 不影响逻辑） ----------
const backup = require('../api/backup.js');

// ---------- 工具 ----------
function makeReq(method, body, headers) {
  return {
    method,
    headers: headers || {},
    body,
    query: {},
  };
}
async function run(req) {
  let status = 0, jsonBody = null;
  const res = {
    setHeader() {},
    status(code) { status = code; return this; },
    json(obj) { jsonBody = obj; },
    end() {},
  };
  await backup(req, res);
  return { status, body: jsonBody };
}
function sampleDb(overrides) {
  return Object.assign({
    user: { id: 'u1', name: 'masterlinc', stage: 'validate', createdAt: '2026-08-06T00:00:00.000Z' },
    mainline: { id: 'm1', name: 'AI 管理减负系统', startDate: '2026-06-01', switchedCount: 0, updatedAt: '2026-08-06T00:00:00.000Z' },
    dailySessions: [
      { id: 's1', date: '2026-08-06', actionId: 'a-publish-note', minutes: 30, status: 'done', output: '今天发布了 1 条小红书' },
      { id: 's2', date: '2026-08-05', actionId: 'a-case-card', minutes: 20, status: 'done', output: '写了案例卡' },
    ],
    assets: [{ id: 'a1', type: 'article', title: 'AI 会议闭环', link: 'https://example.com/1' }],
    evidences: [{ id: 'e1', type: 'pain', title: '管理者痛点笔记' }],
    weeklyReviews: [],
    meta: { lastExportAt: null, createdAt: '2026-08-06T00:00:00.000Z' },
  }, overrides || {});
}

// ---------- 测试 ----------
let passed = 0;
function ok(name, cond, extra) {
  if (!cond) {
    console.error('FAIL: ' + name + (extra ? ' | ' + extra : ''));
    process.exit(1);
  }
  passed++;
  console.log('  ✓ ' + name);
}

(async () => {
  console.log('api/backup.test.js');

  // 1) POST 正常写入
  resetTable();
  setEnv(envBackup);
  global.fetch = feishuMock;
  let r = await run(makeReq('POST', JSON.stringify({ db: sampleDb(), userId: 'masterlinc', version: '1.6.0', ts: 1786000000000 })));
  ok('POST 返回 200 ok + snapshotType=full', r.status === 200 && r.body.ok === true && r.body.snapshotType === 'full');
  const rec = backupTable.records[0];
  ok('字段完整（备份时间/用户/版本/快照类型/摘要/数据快照）', rec && rec.fields['备份时间'] === 1786000000000 && rec.fields['用户'] === 'masterlinc' && rec.fields['版本'] === '1.6.0' && rec.fields['快照类型'] === 'full');
  ok('摘要含统计信息', rec && /母线:/.test(rec.fields['摘要']) && /记录天数: 2/.test(rec.fields['摘要']));
  ok('数据快照可解析为 JSON 且含 user', (() => { try { const d = JSON.parse(rec.fields['数据快照']); return d && d.user && d.dailySessions.length === 2; } catch (e) { return false; } })());
  ok('Text 字段为纯字符串', rec && typeof rec.fields['数据快照'] === 'string' && typeof rec.fields['摘要'] === 'string');

  // 2) 表不存在 → 自动创建
  resetTable();
  backupTable.exists = false;
  r = await run(makeReq('POST', JSON.stringify({ db: sampleDb(), userId: 'masterlinc' })));
  ok('表不存在时自动创建并写入成功', r.status === 200 && r.body.ok === true && backupTable.records.length === 1);

  // 3) 超长快照 → 降级 light
  resetTable();
  const bigOutput = 'x'.repeat(100000); // 单个会话 output 撑大快照
  const bigDb = sampleDb({ dailySessions: [{ id: 's1', date: '2026-08-06', actionId: 'a-dictation', minutes: 3, status: 'done', output: bigOutput }] });
  r = await run(makeReq('POST', JSON.stringify({ db: bigDb, userId: 'masterlinc', version: '1.6.0', ts: Date.now() })));
  ok('超长快照返回 ok + snapshotType=light + truncated=true', r.status === 200 && r.body.ok === true && r.body.snapshotType === 'light' && r.body.truncated === true);
  const lightRec = backupTable.records[0];
  const light = JSON.parse(lightRec.fields['数据快照']);
  ok('light 快照保留核心结构（light 标记/母线/计数）', light.light === true && light.mainline && light.counts && light.counts.days === 1);
  ok('light 快照超长正文已截断（output ≤ 310 字符）', light.dailySessions[0].output.length <= 310);

  // 4) GET 鉴权
  resetTable();
  setEnv(envBackup);
  await run(makeReq('POST', JSON.stringify({ db: sampleDb(), userId: 'masterlinc', version: '1.6.0', ts: 1786000000000 })));
  // 无 key
  let g = await run({ method: 'GET', query: { op: 'latest', userId: 'masterlinc' }, headers: {} });
  ok('GET 无 key → 401', g.status === 401);
  // 错误 key
  g = await run({ method: 'GET', query: { op: 'latest' }, headers: { 'x-backup-key': 'wrong' } });
  ok('GET 错误 key → 401', g.status === 401);
  // 正确 key
  g = await run({ method: 'GET', query: { op: 'latest', userId: 'masterlinc' }, headers: { 'x-backup-key': 'read-secret-123' } });
  ok('GET 正确 key → 200 + 最新快照', g.status === 200 && g.body.ok === true && g.body.data && g.body.data.snapshotType === 'full' && JSON.parse(g.body.data.snapshot).user.name === 'masterlinc');
  ok('GET 返回摘要字段', g.body.data.summary && /母线:/.test(g.body.data.summary));

  // 5) 未配置 BACKUP_READ_KEY → 读取禁用
  resetTable();
  setEnv({ FEISHU_APP_TOKEN: 'app_mock' }); // 无 BACKUP_READ_KEY
  g = await run({ method: 'GET', query: { op: 'latest' }, headers: { 'x-backup-key': 'anything' } });
  ok('未配置 BACKUP_READ_KEY → 读取 401（默认禁用）', g.status === 401);

  // 6) 非法请求
  resetTable();
  setEnv(envBackup);
  r = await run(makeReq('PUT', '{}'));
  ok('非 POST/GET → 405', r.status === 405);
  r = await run(makeReq('POST', 'not-json{{{'));
  ok('非法 body → 400', r.status === 400);
  r = await run(makeReq('POST', JSON.stringify({ userId: 'x' })));
  ok('缺 db → 400', r.status === 400);
  r = await run(makeReq('POST', JSON.stringify({ db: { notUser: true } })));
  ok('db 无 user → 400', r.status === 400);
  g = await run({ method: 'GET', query: { op: 'list' }, headers: { 'x-backup-key': 'read-secret-123' } });
  ok('GET op 非 latest → 400', g.status === 400);

  console.log('\n全部通过：' + passed + ' 项断言');
})().catch((e) => { console.error(e); process.exit(1); });
