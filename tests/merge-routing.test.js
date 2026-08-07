// tests/merge-routing.test.js — v1.25.1 合并后 rewrites 分流验证（模拟 Vercel rewrites 行为）
// 场景：Vercel 将 /api/feedback → /api/lead（函数收到的 req.url 保持原始路径）
//       /api/admin/feedback → /api/admin/skills?__fb=1（同样保留原始路径）
// 验证：① 原始路径分流  ② req.url 被改写（无 feedback 路径）时靠 body.type / __fb 标记分流
const assert = require('assert');

process.env.FEISHU_APP_TOKEN = 'app-mock-token';
process.env.FEISHU_TABLE_ID = 'tbl-leads';
process.env.FEISHU_APP_ID = 'cli_mock';
process.env.FEISHU_APP_SECRET = 'mock-secret';
process.env.ADMIN_SECRET = 'test-admin-secret-abcdef';

// 简化 mock fetch：只覆盖建表/写记录/列表
const mockDB = { seq: 1, tables: [], byTid: new Map() };
function ensureTable(name, tid) {
  let t = mockDB.tables.find((x) => x.name === name);
  if (!t) { t = { name, tableId: tid || 'tbl-mock-' + (mockDB.seq++), records: [] }; mockDB.tables.push(t); mockDB.byTid.set(t.tableId, t); }
  return t;
}
async function mockFetch(url, opts) {
  const u = new URL(url);
  const path = u.pathname;
  const method = (opts && opts.method) || 'GET';
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  if (path.includes('/auth/v3/tenant_access_token')) return { status: 200, json: async () => ({ code: 0, tenant_access_token: 'mock-tenant', expire: 7200 }) };
  if (/\/tables$/.test(path)) {
    if (method === 'GET') return { status: 200, json: async () => ({ code: 0, data: { items: mockDB.tables.map((t) => ({ table_id: t.tableId, name: t.name })) } }) };
    if (method === 'POST') { const t = ensureTable(body.table.name); return { status: 200, json: async () => ({ code: 0, data: { table_id: t.tableId } }) }; }
  }
  const m = path.match(/\/bitable\/v1\/apps\/[^/]+\/tables\/([^/]+)\/records(?:\/([^/]+))?$/);
  if (m) {
    const t = mockDB.byTid.get(m[1]);
    if (!t) return { status: 200, json: async () => ({ code: 1254041, msg: 'mock: table not found' }) };
    const rid = m[2];
    if (method === 'GET' && !rid) return { status: 200, json: async () => ({ code: 0, data: { items: t.records } }) };
    if (method === 'GET' && rid) return { status: 200, json: async () => ({ code: 0, data: { record: t.records.find((r) => r.record_id === rid) || null } }) };
    if (method === 'POST' && !rid) { const rec = { record_id: 'rec-' + (mockDB.seq++), fields: body.fields }; t.records.push(rec); return { status: 200, json: async () => ({ code: 0, data: { record: rec } }) }; }
    if (method === 'PUT' && rid) { const rec = t.records.find((r) => r.record_id === rid); if (!rec) return { status: 200, json: async () => ({ code: 0, data: { record: null } }) }; rec.fields = body.fields; return { status: 200, json: async () => ({ code: 0, data: { record: rec } }) }; }
  }
  return { status: 200, json: async () => ({ code: -1, msg: 'mock: unmatched ' + path }) };
}
global.fetch = mockFetch;

function makeRes() {
  const res = { statusCode: 200, headers: {}, body: undefined, status(c) { res.statusCode = c; return res; }, json(o) { res.body = o; return res; }, send(s) { res.body = s; return res; }, setHeader(k, v) { res.headers[k] = v; return res; }, end() { return res; } };
  return res;
}
const { issueToken } = require('../lib/admin-auth.js');
const AUTH = 'Bearer ' + issueToken({ userId: 'admin-admin', role: 'admin' }).token;

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('  ✓ ' + n); } else { failed++; console.error('  ✗ ' + n); } };

(async function main() {
  const lead = require('../api/lead.js');
  const adminSkills = require('../api/admin/skills.js');
  ensureTable('user_feedback', 'tbl-fb');
  ensureTable('线索', 'tbl-leads'); // lead.js 写线索用的表（FEISHU_TABLE_ID=tbl-leads）

  console.log('\n— A. 公开 /api/feedback（rewrite → lead.js）—');

  // A1: 原始路径 /api/feedback（Vercel 保留 req.url 的情形）
  {
    const res = makeRes();
    await lead(makeReq2({ method: 'POST', url: '/api/feedback', body: { type: '有 bug', content: '合并测试：设置页保存按钮被键盘遮挡，请修一下谢谢！', email: '', meta: { version: 'v1.25.1', page: 'products/transition-os.html', deviceId: 'abc123' } } }), res);
    ok(res.statusCode === 200 && res.body.ok === true, 'A1 原始路径 /api/feedback → 200 ok');
    const t = mockDB.tables.find((x) => x.name === 'user_feedback');
    ok(t && t.records.length === 1 && t.records[0].fields['反馈类型'] === '有 bug' && t.records[0].fields['设备ID'] === 'abc123', 'A1 写入 user_feedback 表（类型+设备ID前8位）');
  }

  // A2: req.url 被改写为 /api/lead（Vercel 不保留原始路径的最坏情形）→ 靠 body.type 分流；换 IP 避开 60 秒防刷
  {
    const res = makeRes();
    await lead(makeReq2({ method: 'POST', url: '/api/lead', body: { type: '想要新功能', content: '希望周报支持一键导出 PDF 格式，谢谢！', email: '', meta: {} }, socket: { remoteAddress: '8.8.8.8' } }), res);
    ok(res.statusCode === 200 && res.body.ok === true, 'A2 url=/api/lead 但 body.type 合法 → 仍走反馈（200 ok）');
    const t = mockDB.tables.find((x) => x.name === 'user_feedback');
    ok(t && t.records.length === 2 && t.records[1].fields['反馈类型'] === '想要新功能', 'A2 写入反馈表而非线索表');
  }

  // A3: 纯线索请求（body 无 type）不受影响 → 走线索逻辑（飞书线索表 tbl-leads）
  {
    const res = makeRes();
    await lead(makeReq2({ method: 'POST', url: '/api/lead', body: { email: 'test@example.com', question: '如何开始？', source: 'direct' }, socket: { remoteAddress: '7.7.7.7' } }), res);
    ok(res.statusCode === 200 && res.body.ok === true, 'A3 纯线索请求 → 200 ok（未误入反馈分支）');
  }

  // A4: 线索请求即使 url 带 /api/feedback 且无 type → 校验邮箱（不进反馈），逻辑顺序正确
  {
    const res = makeRes();
    await lead(makeReq2({ method: 'POST', url: '/api/feedback', body: { email: 'bad', question: 'x' }, socket: { remoteAddress: '6.6.6.6' } }), res);
    ok(res.statusCode === 400, 'A4 /api/feedback + 无 type + 非法邮箱 → 400（不会误写反馈）');
  }

  console.log('\n— B. 管理 /api/admin/feedback（rewrite → skills.js）—');

  // B1: 原始路径 GET（保留 req.url）
  {
    const res = makeRes();
    await adminSkills(makeReq2({ method: 'GET', url: '/api/admin/feedback', headers: { authorization: AUTH } }), res);
    ok(res.statusCode === 200 && res.body.total === 2 && res.body.feedback, 'B1 原始路径 GET 列表 → 200 total=2');
  }

  // B2: url 被改写（/api/admin/skills + __fb=1 标记）→ 靠 __fb 分流
  {
    const res = makeRes();
    await adminSkills(makeReq2({ method: 'GET', url: '/api/admin/skills?__fb=1', query: { __fb: '1' }, headers: { authorization: AUTH } }), res);
    ok(res.statusCode === 200 && res.body.total === 2, 'B2 __fb=1 标记 GET → 走反馈（200 total=2）');
  }

  // B3: PATCH（url 被改写 + fbpath）→ 更新反馈
  {
    const t = mockDB.tables.find((x) => x.name === 'user_feedback');
    const rid = t.records[0].record_id;
    const res = makeRes();
    await adminSkills(makeReq2({ method: 'PATCH', url: '/api/admin/skills?__fb=1', query: { __fb: '1', fbpath: rid }, headers: { authorization: AUTH }, body: { status: '已读' } }), res);
    ok(res.statusCode === 200 && res.body.status === '已读', 'B3 PATCH + fbpath → 状态更新 200');
  }

  // B4: 未鉴权 → 401（鉴权不松）
  {
    const res = makeRes();
    await adminSkills(makeReq2({ method: 'GET', url: '/api/admin/feedback' }), res);
    ok(res.statusCode === 401, 'B4 无 token → 401（requireAdmin 不放松）');
  }

  // B5: 正常 skills 管理请求（url=/api/admin/skills 无标记）→ 走 skills 列表，不受反馈污染
  {
    const res = makeRes();
    await adminSkills(makeReq2({ method: 'GET', url: '/api/admin/skills', headers: { authorization: AUTH } }), res);
    ok(res.statusCode === 200 && Array.isArray(res.body.skills), 'B5 正常 /api/admin/skills → skills 列表（未误入反馈）');
  }

  console.log('\n===== 结果：' + passed + ' 通过 / ' + failed + ' 失败 =====');
  process.exit(failed ? 1 : 0);
})();

function makeReq2(over) {
  const r = Object.assign({ method: 'GET', headers: {}, query: {}, socket: { remoteAddress: '9.9.9.9' } }, over);
  return r;
}
