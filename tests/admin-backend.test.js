// ============================================================================
// tests/admin-backend.test.js — 管理后台后端综合单测（零依赖，mock fetch，不触碰真实飞书）
//
// 运行：node tests/admin-backend.test.js
// 覆盖：
//   1) lib/admin-auth：HMAC token 签发/校验/篡改/过期；requireAdmin 403/401/200
//   2) POST /api/admin/login：未配置 env 403 / 错误口令 401 / 正确 200 / 限速 429
//   3) POST /api/track：正常写事件、事件白名单拒绝、extra 邮箱过滤、批量、限流 429
//   4) GET /api/skills：自动建表 + seed 3 精品卡、只返回上线、排序、下架后消失
//   5) GET/POST /api/admin/skills：鉴权、新增/更新（upsert 部分更新）/上下线/404
//   6) GET /api/admin/leads：读取、脱敏、source/日期/邮箱筛选、CSV 导出原文
//   7) GET /api/admin/downloads：uid+skillId 去重聚合
//   8) GET /api/admin/traffic：page_view PV/UV/热门页面/按天趋势
//   9) GET /api/admin/events：流水分页
// ============================================================================

const assert = require('assert');

// ---------- 环境 ----------
process.env.FEISHU_APP_TOKEN = 'app-mock-token';
process.env.FEISHU_TABLE_ID = 'tbl-leads';
process.env.FEISHU_APP_ID = 'cli_mock';
process.env.FEISHU_APP_SECRET = 'mock-secret';
process.env.ADMIN_PASSWORD = 'test-password-123456';
process.env.ADMIN_SECRET = 'test-admin-secret-abcdef';

// ---------- mock 飞书多维表格 ----------
const mockDB = { seq: 1, tables: [], byTid: new Map() };
function tableByName(name) { return mockDB.tables.find((t) => t.name === name); }
function ensureTable(name, fields, tid) {
  let t = tableByName(name);
  if (!t) {
    t = { name, tableId: tid || 'tbl-mock-' + (mockDB.seq++), fields, records: [] };
    mockDB.tables.push(t);
    mockDB.byTid.set(t.tableId, t);
  }
  return t;
}
// 预置线索表（与 lead.js 写入字段一致）
ensureTable('线索', [], 'tbl-leads');
const leadsTable = tableByName('线索');
const LEADS = [
  { record_id: 'rec-lead-1', fields: { '邮箱': 'lincyang@foxmail.com', '最想解决的问题': '周报太慢', '来源渠道': 'skill-pack|xiaohongshu', '提交时间': Date.now() - 3600e3, '数据使用同意': '是' } },
  { record_id: 'rec-lead-2', fields: { '邮箱': 'boss@example.com', '最想解决的问题': '会议纪要', '来源渠道': '直接访问', '提交时间': Date.now() - 86400e3, '数据使用同意': '是' } },
  { record_id: 'rec-lead-3', fields: { '邮箱': 'abc@gmail.com', '最想解决的问题': '跨部门催进度', '来源渠道': 'skill-pack', '提交时间': Date.now() - 2 * 86400e3, '数据使用同意': '是' } },
];
leadsTable.records.push(...LEADS);

async function mockFetch(url, opts) {
  const u = new URL(url);
  const path = u.pathname;
  const method = (opts && opts.method) || 'GET';
  const body = opts && opts.body ? JSON.parse(opts.body) : null;

  if (path.includes('/auth/v3/tenant_access_token')) {
    return { status: 200, json: async () => ({ code: 0, tenant_access_token: 'mock-tenant', expire: 7200 }) };
  }

  // 表列表 / 建表
  let m = path.match(/\/bitable\/v1\/apps\/[^/]+\/tables$/);
  if (m) {
    if (method === 'GET') {
      return { status: 200, json: async () => ({ code: 0, data: { items: mockDB.tables.map((t) => ({ table_id: t.tableId, name: t.name })) } }) };
    }
    if (method === 'POST') {
      const name = body.table.name;
      const t = ensureTable(name, body.table.fields || []);
      return { status: 200, json: async () => ({ code: 0, data: { table_id: t.tableId } }) };
    }
  }

  // 记录操作
  m = path.match(/\/bitable\/v1\/apps\/[^/]+\/tables\/([^/]+)\/records(?:\/([^/]+))?$/);
  if (m) {
    const tid = m[1];
    const rid = m[2];
    const t = mockDB.byTid.get(tid);
    if (!t) return { status: 200, json: async () => ({ code: 1254041, msg: 'mock: table not found' }) };

    if (path.endsWith('/records/batch_create')) {
      const created = (body.records || []).map((r) => {
        const rec = { record_id: 'rec-' + (mockDB.seq++), fields: r.fields };
        t.records.push(rec);
        return rec;
      });
      return { status: 200, json: async () => ({ code: 0, data: { records: created } }) };
    }
    if (method === 'GET') {
      const pageSize = parseInt(u.searchParams.get('page_size') || '100', 10);
      const start = 0;
      const items = t.records.slice(start, start + pageSize);
      return { status: 200, json: async () => ({ code: 0, data: { items, has_more: false } }) };
    }
    if (method === 'POST' && !rid) {
      const rec = { record_id: 'rec-' + (mockDB.seq++), fields: body.fields };
      t.records.push(rec);
      return { status: 200, json: async () => ({ code: 0, data: { record: rec } }) };
    }
    if (method === 'PUT' && rid) {
      const rec = t.records.find((r) => r.record_id === rid);
      if (!rec) return { status: 200, json: async () => ({ code: 0, data: { record: null } }) };
      rec.fields = body.fields;
      return { status: 200, json: async () => ({ code: 0, data: { record: rec } }) };
    }
  }
  return { status: 200, json: async () => ({ code: -1, msg: 'mock: unmatched ' + path }) };
}
global.fetch = mockFetch;

// ---------- mock req / res ----------
function makeRes() {
  const res = {
    statusCode: 200, headers: {}, body: undefined, sent: false,
    status(c) { res.statusCode = c; return res; },
    json(o) { res.body = o; res.sent = true; return res; },
    send(s) { res.body = s; res.sent = true; return res; },
    setHeader(k, v) { res.headers[k] = v; return res; },
    end() { res.sent = true; return res; },
  };
  return res;
}
function makeReq(over) {
  const r = Object.assign({
    method: 'GET', headers: {}, query: {}, socket: { remoteAddress: '1.2.3.4' },
  }, over);
  return r;
}

// ---------- 测试辅助 ----------
let passed = 0, failed = 0;

function getAuthHeader() {
  const { issueToken } = require('../lib/admin-auth.js');
  return 'Bearer ' + issueToken().token;
}

async function loginToken() {
  const login = require('../api/admin/login.js');
  const res = makeRes();
  await login(makeReq({ method: 'POST', body: { password: process.env.ADMIN_PASSWORD } }), res);
  assert.strictEqual(res.statusCode, 200, 'login 应成功');
  return res.body.token;
}

// ==================== run ====================
const SCENARIOS = [
  ['admin-auth（HMAC token / requireAdmin 403/401/200）', runAuth],
  ['login（口令校验 / token / 限速 429）', runLogin],
  ['track（白名单 / 匿名化 / 批量 / 限流）', runTrack],
  ['skills 公开读（建表 + seed 12 卡 + 排序）', runPublicSkills],
  ['admin skills（GET/POST/PATCH + 鉴权 + 404）', runAdminSkills],
  ['leads（读取 / 脱敏 / 筛选 / CSV）', runLeads],
  ['downloads（uid+skillId 去重聚合）', runDownloads],
  ['traffic（page_view PV/UV/热门页/趋势）', runTraffic],
  ['events（流水分页 / 按事件筛选）', runEvents],
  ['前端兼容别名（logs/stats/visits/stats/downloads）', runAliases],
];

(async () => {
  for (const [name, fn] of SCENARIOS) {
    console.log('== ' + name + ' ==');
    try {
      await fn();
      passed++;
      console.log('  ✓ 场景通过');
    } catch (e) {
      failed++;
      console.error('  ✗ 场景失败: ' + (e && e.stack || e));
    }
  }
  console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败');
  if (failed > 0) process.exit(1);
})();

// ==================== 1. admin-auth ====================
async function runAuth() {
  const auth = require('../lib/admin-auth.js');
  const { token, expiresAt } = auth.issueToken();
  assert.ok(token.split('.').length === 2, 'token 应为 payload.signature');
  const p = auth.verifyToken(token);
  assert.strictEqual(p.sub, 'masterlinc');
  assert.ok(p.exp > Date.now());

  // 篡改 token → 无效
  const tampered = token.slice(0, -3) + 'abc';
  assert.strictEqual(auth.verifyToken(tampered), null);

  // 过期 token（手工构造）
  const crypto = require('crypto');
  const payloadB64 = Buffer.from(JSON.stringify({ sub: 'masterlinc', iat: 1, exp: 1 })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.ADMIN_SECRET).update(payloadB64).digest('base64url');
  assert.strictEqual(auth.verifyToken(payloadB64 + '.' + sig), null, '过期 token 应无效');

  // requireAdmin：未配置 env → 403（先签发 token 再删 env，验证 403 优先于验签）
  const validToken = getAuthHeader();
  const save = { p: process.env.ADMIN_PASSWORD, s: process.env.ADMIN_SECRET };
  delete process.env.ADMIN_PASSWORD; delete process.env.ADMIN_SECRET;
  let res = makeRes();
  let ok = auth.requireAdmin(makeReq({ headers: { authorization: validToken } }), res);
  assert.strictEqual(ok, false); assert.strictEqual(res.statusCode, 403, '未配置 env 应 403');
  process.env.ADMIN_PASSWORD = save.p; process.env.ADMIN_SECRET = save.s;

  // requireAdmin：无 token → 401
  res = makeRes();
  ok = auth.requireAdmin(makeReq({}), res);
  assert.strictEqual(ok, false); assert.strictEqual(res.statusCode, 401, '无 token 应 401');

  // requireAdmin：坏 token → 401
  res = makeRes();
  ok = auth.requireAdmin(makeReq({ headers: { authorization: 'Bearer bad.token' } }), res);
  assert.strictEqual(ok, false); assert.strictEqual(res.statusCode, 401, '坏 token 应 401');

  // requireAdmin：正确 token → 通过
  res = makeRes();
  ok = auth.requireAdmin(makeReq({ headers: { authorization: getAuthHeader() } }), res);
  assert.strictEqual(ok, true);
}

// ==================== 2. login ====================
async function runLogin() {
  const login = require('../api/admin/login.js');
  const auth = require('../lib/admin-auth.js');

  // 未配置 env → 403
  const save = { p: process.env.ADMIN_PASSWORD, s: process.env.ADMIN_SECRET };
  delete process.env.ADMIN_PASSWORD; delete process.env.ADMIN_SECRET;
  let res = makeRes();
  await login(makeReq({ method: 'POST', body: { password: 'x' } }), res);
  assert.strictEqual(res.statusCode, 403, '未配置 env 登录应 403');
  process.env.ADMIN_PASSWORD = save.p; process.env.ADMIN_SECRET = save.s;

  // 错误口令 → 401
  auth.resetLoginRate();
  res = makeRes();
  await login(makeReq({ method: 'POST', body: { password: 'wrong-password' } }), res);
  assert.strictEqual(res.statusCode, 401);

  // 正确口令 → 200 + token
  res = makeRes();
  await login(makeReq({ method: 'POST', body: { password: process.env.ADMIN_PASSWORD } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.token);
  assert.ok(auth.verifyToken(res.body.token), '返回 token 应可验证');

  // 限速：连续 5 次失败 → 第 6 次 429
  auth.resetLoginRate();
  for (let i = 0; i < 5; i++) {
    res = makeRes();
    await login(makeReq({ method: 'POST', body: { password: 'nope' } }), res);
    assert.strictEqual(res.statusCode, 401, '第 ' + (i + 1) + ' 次失败应 401');
  }
  res = makeRes();
  await login(makeReq({ method: 'POST', body: { password: process.env.ADMIN_PASSWORD } }), res);
  assert.strictEqual(res.statusCode, 429, '锁定后应 429');
  auth.resetLoginRate();
}

// ==================== 3. track ====================
async function runTrack() {
  const track = require('../api/track.js');
  const eventsLib = require('../lib/events.js');
  eventsLib.resetEventsCache();

  // 正常单条
  track.resetRate();
  let res = makeRes();
  await track(makeReq({
    method: 'POST',
    body: { ev: 'page_view', ts: Date.now(), page: 'home', uid: 'uid-1', sid: 'sid-1', ref: 'direct', v: 'track-1.0.0', extra: { path: '/', title: 'home' } },
    headers: { 'user-agent': 'Mozilla/5.0 (test)' },
  }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.accepted, 1);

  // 未知事件 → 400（accepted 0）
  track.resetRate();
  res = makeRes();
  await track(makeReq({ method: 'POST', body: { ev: 'evil_event', uid: 'u', sid: 's' } }), res);
  assert.strictEqual(res.statusCode, 400, '未知事件应 400');

  // 批量：2 条合法 + 1 条未知 → accepted 2
  track.resetRate();
  res = makeRes();
  await track(makeReq({
    method: 'POST',
    body: { events: [
      { ev: 'skill_download', uid: 'uid-2', sid: 's2', extra: { skillId: 'skill-01', skillName: '四栏法', category: '会议', dlFrom: 'card' } },
      { ev: 'lead_submit', uid: 'uid-2', sid: 's2', extra: { hasEmail: true, source: 'direct' } },
      { ev: 'unknown', uid: 'uid-2', sid: 's2' },
    ] },
  }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.accepted, 2);

  // extra 匿名化：白名单外 key 丢弃 + 邮箱打码
  track.resetRate();
  res = makeRes();
  await track(makeReq({
    method: 'POST',
    body: { ev: 'skill_pack_submit', uid: 'uid-3', sid: 's3', extra: { hasEmail: true, source: 'skill-pack', email: 'real@example.com', phone: '13800000000', skillId: 'pack' } },
  }), res);
  assert.strictEqual(res.statusCode, 200);
  const evt = tableByName('behavior_events').records.find((r) => r.fields['匿名ID'] === 'uid-3');
  assert.ok(evt, '事件应已落表');
  const extra = JSON.parse(evt.fields['扩展信息'] || '{}');
  assert.ok(!('email' in extra), '白名单外 email 应被剔除');
  assert.ok(!('phone' in extra), '白名单外 phone 应被剔除');
  assert.strictEqual(extra.hasEmail, true);

  // 前端 lib/track.js 格式兼容：数组 body + 顶层 path + t 字段
  track.resetRate();
  res = makeRes();
  await track(makeReq({
    method: 'POST',
    body: [
      { ev: 'page_view', page: 'home', path: '/', uid: 'uid-sdk', sid: 'sid-sdk', ref: '', extra: {}, t: Date.now() - 1000, v: 1 },
      { ev: 'skill_download', page: 'skills', path: '/skills/', uid: 'uid-sdk', sid: 'sid-sdk2', extra: { skillId: 'skill-02', skillName: '会前三问', category: '会议', level: '★☆☆', fileType: 'md', dlFrom: 'card' }, t: Date.now() - 500, v: 1 },
    ],
  }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.accepted, 2, '数组 body 应全部接受');
  const sdkEvt = tableByName('behavior_events').records.find((r) => r.fields['匿名ID'] === 'uid-sdk');
  const sdkExtra = JSON.parse(sdkEvt.fields['扩展信息'] || '{}');
  assert.strictEqual(sdkExtra.path, '/', '顶层 path 应并入 extra');
  assert.ok(sdkEvt.fields['事件时间'] > 0, 't 字段应作为事件时间');
  const sdkDl = tableByName('behavior_events').records.find((r) => r.fields['匿名ID'] === 'uid-sdk' && r.fields['事件'] === 'skill_download');
  assert.ok(sdkDl, 'skill_download 应落表');
  assert.strictEqual(JSON.parse(sdkDl.fields['扩展信息']).skillId, 'skill-02');

  // 限流：同 ev+ip 第 61 条拒绝
  track.resetRate();
  let lastCode = 0;
  for (let i = 0; i < 61; i++) {
    res = makeRes();
    await track(makeReq({ method: 'POST', body: { ev: 'page_view', uid: 'uid-r' + i, sid: 's-r' + i } }), res);
    lastCode = res.statusCode;
  }
  assert.strictEqual(lastCode, 400, '超限应 400（accepted=0）');
  track.resetRate();
}

// ==================== 4. skills 公开读 ====================
async function runPublicSkills() {
  const skills = require('../api/skills.js');
  const skillsLib = require('../lib/skills-config.js');
  skillsLib.resetSkillsCache();

  let res = makeRes();
  await skills(makeReq({ method: 'GET' }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.skills.length, 3, 'seed 应为 3 个精品卡');
  assert.ok(res.body.skills.every((s) => s.status === 'on'), '公开读只应返回上线卡');
  assert.strictEqual(res.body.skills[0].id, 'skill-01', '应按排序');
  assert.deepStrictEqual(res.body.skills[0].tools, ['NotebookLM', 'Kimi'], 'tools 应还原为数组');
  assert.strictEqual(res.body.skills[0].hook.href, '/products/selfcheck.html');
  assert.deepStrictEqual(res.body.skills[0].preview.labels.length, 4);

  // 再次调用：不重复 seed（仍 12 条）
  res = makeRes();
  await skills(makeReq({ method: 'GET' }), res);
  assert.strictEqual(res.body.skills.length, 3);
}

// ==================== 5. admin skills ====================
async function runAdminSkills() {
  const adminSkills = require('../api/admin/skills.js');
  const token = await loginToken();
  const h = { authorization: 'Bearer ' + token };

  // 无 token → 401
  let res = makeRes();
  await adminSkills(makeReq({ method: 'GET' }), res);
  assert.strictEqual(res.statusCode, 401, '无 token 应 401');

  // GET 全部（含下架）
  res = makeRes();
  await adminSkills(makeReq({ method: 'GET', headers: h }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.skills.length, 3);
  assert.ok(res.body.skills[0].recordId, '管理端应含 recordId');

  // POST 新增
  res = makeRes();
  await adminSkills(makeReq({
    method: 'POST', headers: h,
    body: { skillId: 'skill-99', name: '测试卡', value: '价值', cat: '决策', tools: ['AI'], diff: '★☆☆', time: '5 分钟', format: 'PDF', file: '/skills/files/x.md', dlName: 'x.md', dlText: '下载', hook: { href: '/#', text: '钩子' }, preview: { title: 'T', style: 'grid', labels: ['a', 'b'] }, status: 'on', sort: 99 },
  }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.action, 'created');

  // POST 更新同 ID
  res = makeRes();
  await adminSkills(makeReq({ method: 'POST', headers: h, body: { skillId: 'skill-99', name: '测试卡改', status: 'on', sort: 99 } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.action, 'updated');
  assert.strictEqual(res.body.skill.name, '测试卡改');

  // POST 上下线（前端 toggle 路径）：body 直接 { skillId, status }，不覆盖其他字段
  res = makeRes();
  await adminSkills(makeReq({ method: 'POST', headers: h, body: { skillId: 'skill-99', status: 'off' } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.skill.status, 'off');
  assert.strictEqual(res.body.skill.name, '测试卡改', '上下线不应清空其他字段');

  // POST { skill: {...} } 包裹写法
  res = makeRes();
  await adminSkills(makeReq({ method: 'POST', headers: h, body: { skill: { skillId: 'skill-98', name: '包裹卡', status: 'on', sort: 98 } } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.skill.name, '包裹卡');

  // 下架后公开读消失
  const skills = require('../api/skills.js');
  res = makeRes();
  await skills(makeReq({ method: 'GET' }), res);
  assert.ok(!res.body.skills.some((s) => s.id === 'skill-99'), '下架卡不应出现在公开读');
}

// ==================== 6. leads ====================
async function runLeads() {
  const leads = require('../api/admin/leads.js');
  const token = await loginToken();
  const h = { authorization: 'Bearer ' + token };

  // 无 token → 401
  let res = makeRes();
  await leads(makeReq({ method: 'GET' }), res);
  assert.strictEqual(res.statusCode, 401);

  // 全量 + 默认脱敏
  res = makeRes();
  await leads(makeReq({ method: 'GET', headers: h }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.total, 3);
  const first = res.body.items.find((i) => i.email.indexOf('lin') === 0);
  assert.ok(first.masked, '默认应脱敏');
  assert.strictEqual(first.email, 'lin***ng@foxmail.com', '脱敏格式 lin***ng@foxmail.com');

  // source 筛选
  res = makeRes();
  await leads(makeReq({ method: 'GET', headers: h, query: { source: 'skill-pack' } }), res);
  assert.strictEqual(res.body.total, 2, 'skill-pack 来源应 2 条');

  // from 参数（前端兼容）
  res = makeRes();
  await leads(makeReq({ method: 'GET', headers: h, query: { from: 'skill-pack' } }), res);
  assert.strictEqual(res.body.total, 2, 'from=skill-pack 应 2 条');

  // from='全部' 应忽略
  res = makeRes();
  await leads(makeReq({ method: 'GET', headers: h, query: { from: '全部' } }), res);
  assert.strictEqual(res.body.total, 3);

  // 邮箱模糊
  res = makeRes();
  await leads(makeReq({ method: 'GET', headers: h, query: { q: 'gmail' } }), res);
  assert.strictEqual(res.body.total, 1);
  assert.strictEqual(res.body.items[0].email, 'abc***@gmail.com');

  // full → 原文
  res = makeRes();
  await leads(makeReq({ method: 'GET', headers: h, query: { full: '1' } }), res);
  assert.strictEqual(res.body.items.find((i) => i.email.indexOf('lincyang') === 0).email, 'lincyang@foxmail.com');

  // CSV 导出（含原文邮箱 + BOM + Content-Disposition）
  res = makeRes();
  await leads(makeReq({ method: 'GET', headers: h, query: { export: 'csv' } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.headers['Content-Type'].indexOf('text/csv') === 0);
  assert.ok(res.headers['Content-Disposition'].indexOf('attachment') === 0);
  assert.ok(res.body.indexOf('lincyang@foxmail.com') !== -1, 'CSV 应含邮箱原文');
  assert.ok(res.body.indexOf('skill-pack') !== -1);
}

// ==================== 7. downloads ====================
async function runDownloads() {
  const eventsLib = require('../lib/events.js');
  eventsLib.resetEventsCache();
  // 清空行为事件表，避免 runTrack 污染计数
  tableByName('behavior_events').records.length = 0;
  // 直接通过 lib 写入模拟埋点数据（uid+skillId 去重）
  await eventsLib.batchCreateEvents([
    { ev: 'skill_download', ts: Date.now() - 1000, page: 'skills', uid: 'uid-a', sid: 'sa', extra: { skillId: 'skill-01', skillName: '四栏法', category: '会议', dlFrom: 'card' } },
    { ev: 'skill_download', ts: Date.now() - 900, page: 'skills', uid: 'uid-b', sid: 'sb', extra: { skillId: 'skill-01', skillName: '四栏法', category: '会议', dlFrom: 'card' } },
    { ev: 'skill_download', ts: Date.now() - 800, page: 'skills', uid: 'uid-a', sid: 'sc', extra: { skillId: 'skill-01', skillName: '四栏法', category: '会议', dlFrom: 'card' } }, // 同 uid 重复 → 去重
    { ev: 'skill_download', ts: Date.now() - 700, page: 'skills', uid: 'uid-a', sid: 'sd', extra: { skillId: 'skill-04', skillName: '周报法', category: '汇报周报' } },
  ]);

  const downloads = require('../api/admin/downloads.js');
  const token = await loginToken();
  const res = makeRes();
  await downloads(makeReq({ method: 'GET', headers: { authorization: 'Bearer ' + token }, query: { days: '30' } }), res);
  assert.strictEqual(res.statusCode, 200);
  const s01 = res.body.skills.find((s) => s.skillId === 'skill-01');
  assert.strictEqual(s01.count, 2, 'skill-01 去重后应为 2（uid-a/uid-b）');
  assert.strictEqual(s01.unique, 2, 'unique 兼容字段');
  assert.strictEqual(res.body.total, 4, 'total 应为原始点击 4（含同 uid 重复）');
  assert.strictEqual(res.body.totalUnique, 3, '合计应为去重 3（2+1）');
  assert.strictEqual(s01.skillName, '四栏法');
}

// ==================== 8. traffic ====================
async function runTraffic() {
  const eventsLib = require('../lib/events.js');
  eventsLib.resetEventsCache();
  // 清空行为事件表，避免 runTrack / runDownloads 污染
  tableByName('behavior_events').records.length = 0;
  await eventsLib.batchCreateEvents([
    { ev: 'page_view', ts: Date.now() - 3600e3, page: 'home', uid: 'u-1', sid: 's1', ref: 'direct', extra: { path: '/' } },
    { ev: 'page_view', ts: Date.now() - 3500e3, page: 'home', uid: 'u-1', sid: 's2', ref: 'direct', extra: { path: '/' } },   // 同 uid 2 次 → PV2 UV1
    { ev: 'page_view', ts: Date.now() - 3400e3, page: 'skills', uid: 'u-2', sid: 's3', ref: 'xiaohongshu.com', extra: { path: '/skills/' } },
  ]);

  const traffic = require('../api/admin/traffic.js');
  const token = await loginToken();
  const res = makeRes();
  await traffic(makeReq({ method: 'GET', headers: { authorization: 'Bearer ' + token }, query: { days: '7' } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.pv, 3);
  assert.strictEqual(res.body.uv, 2, 'UV 按 uid 去重应为 2');
  assert.strictEqual(res.body.pages[0].path, '/');
  assert.strictEqual(res.body.pages[0].pv, 2);
  assert.strictEqual(res.body.pages[0].uv, 1, '热门页 UV');
  assert.ok(res.body.daily.length >= 1, '应按天趋势');
  assert.ok(res.body.today, 'today 兼容字段');
  assert.ok(res.body.sources.some((s) => s.source === 'xiaohongshu.com'));
  assert.ok(res.body.sources.some((s) => s.name === 'xiaohongshu.com'), 'sources 含 name 兼容字段');
}

// ==================== 9. events ====================
async function runEvents() {
  const events = require('../api/admin/events.js');
  const token = await loginToken();

  let res = makeRes();
  await events(makeReq({ method: 'GET', headers: { authorization: 'Bearer ' + token } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.total > 0);
  assert.ok(res.body.items.length <= 50, '默认分页 50');
  const item = res.body.items[0];
  assert.ok(item.time > 0);
  assert.ok(item.uid.length <= 8, '匿名 ID 只显示前 8 位');
  assert.ok(item.ev.length > 0);

  // 按事件筛选
  res = makeRes();
  await events(makeReq({ method: 'GET', headers: { authorization: 'Bearer ' + token }, query: { ev: 'page_view' } }), res);
  assert.ok(res.body.items.every((i) => i.ev === 'page_view'));

  // 分页
  res = makeRes();
  await events(makeReq({ method: 'GET', headers: { authorization: 'Bearer ' + token }, query: { page: '2', pageSize: '2' } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.page, 2);
}

// ==================== 10. 前端主路径（与已上线端点契约一致） ====================
async function runAliases() {
  const token = await loginToken();
  const h = { authorization: 'Bearer ' + token };

  // /api/admin/events（行为日志，前端路径）
  const events = require('../api/admin/events.js');
  let res = makeRes();
  await events(makeReq({ method: 'GET', headers: h, query: { page: '1', pageSize: '20', ev: 'page_view' } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.items), 'events 应返回 items 数组');
  assert.ok(res.body.pageSize > 0, 'events 应返回 pageSize');
  assert.ok(res.body.items.every((i) => i.ev === 'page_view'), 'ev 筛选生效');

  // /api/admin/traffic（访问数据，前端路径）
  const traffic = require('../api/admin/traffic.js');
  res = makeRes();
  await traffic(makeReq({ method: 'GET', headers: h, query: { days: '7' } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.daily && Array.isArray(res.body.daily), 'traffic 含 daily');

  // /api/admin/downloads（下载统计，前端路径）
  const downloads = require('../api/admin/downloads.js');
  res = makeRes();
  await downloads(makeReq({ method: 'GET', headers: h, query: { days: '30' } }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.total != null, 'downloads 含 total');

  // /api/admin/leads 应返回 items 数组（前端读取字段）
  const leads = require('../api/admin/leads.js');
  res = makeRes();
  await leads(makeReq({ method: 'GET', headers: h }), res);
  assert.ok(Array.isArray(res.body.items), 'leads 应返回 items 数组');
}
