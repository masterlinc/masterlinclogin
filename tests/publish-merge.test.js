// tests/publish-merge.test.js — v1.27.1 publish 合并进 lead.js 后分流验证（模拟 Vercel rewrites）
// 场景：Vercel 将 /api/publish → /api/lead（函数收到的 req.url 保留原始路径 /api/publish）
// 验证：① /api/publish 创建任务  ② op=pending 拉取待办（需 x-publish-key）
//       ③ op=done 回写  ④ op=config 读写配置（写需 key，读脱敏公开）  ⑤ op=list 最近任务
//       ⑥ 原有 /api/lead 线索逻辑不破坏  ⑦ /api/feedback 分流不破坏  ⑧ 鉴权不松
const assert = require('assert');

process.env.FEISHU_APP_TOKEN = 'app-mock-token';
process.env.FEISHU_TABLE_ID = 'tbl-leads';
process.env.FEISHU_APP_ID = 'cli_mock';
process.env.FEISHU_APP_SECRET = 'mock-secret';
process.env.ADMIN_SECRET = 'test-admin-secret-abcdef';
process.env.PUBLISH_KEY = 'test-publish-key-123';  // 启用 publish 受保护操作
process.env.PUBLISH_ENC_KEY = 'test-enc-key';

// 简化 mock fetch：覆盖建表/写记录/列表/更新（publish_tasks / publish_config / user_feedback / 线索）
const mockDB = { seq: 100, tables: [], byTid: new Map() };
function ensureTable(name) {
  let t = mockDB.tables.find((x) => x.name === name);
  if (!t) { t = { name, tableId: 'tbl-mock-' + (mockDB.seq++), records: [] }; mockDB.tables.push(t); mockDB.byTid.set(t.tableId, t); }
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
    if (method === 'POST' && !rid) { const rec = { record_id: 'rec-' + (mockDB.seq++), fields: body.fields }; t.records.push(rec); return { status: 200, json: async () => ({ code: 0, data: { record: rec } }) }; }
    if (method === 'PUT' && rid) { const rec = t.records.find((r) => r.record_id === rid); if (!rec) return { status: 200, json: async () => ({ code: 0, data: { record: null } }) }; rec.fields = Object.assign({}, rec.fields, body.fields); return { status: 200, json: async () => ({ code: 0, data: { record: rec } }) }; }
  }
  return { status: 200, json: async () => ({ code: -1, msg: 'mock: unmatched ' + path }) };
}
global.fetch = mockFetch;

function makeRes() {
  const res = { statusCode: 200, headers: {}, body: undefined, status(c) { res.statusCode = c; return res; }, json(o) { res.body = o; return res; }, send(s) { res.body = s; return res; }, setHeader(k, v) { res.headers[k] = v; return res; }, end() { return res; } };
  return res;
}
function makeReq(over) {
  return Object.assign({ method: 'GET', url: '/api/lead', headers: {}, query: {}, socket: { remoteAddress: '9.9.9.9' } }, over);
}

let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log('  ✓ ' + n); } else { failed++; console.error('  ✗ ' + n); } };

(async function main() {
  const lead = require('../api/lead.js');
  ensureTable('publish_tasks');
  ensureTable('publish_config');
  ensureTable('user_feedback');
  // 线索表固定 table_id（FEISHU_TABLE_ID=tbl-leads），需注册到 byTid 供 lead.js 写入
  ensureTable('线索');
  mockDB.tables.find((x) => x.name === '线索').tableId = 'tbl-leads';
  mockDB.byTid.set('tbl-leads', mockDB.tables.find((x) => x.name === '线索'));

  const PUB_HDR = { 'x-publish-key': process.env.PUBLISH_KEY };

  console.log('\n— A. /api/publish 创建任务 —');
  let taskId = '';
  {
    const res = makeRes();
    await lead(makeReq({ method: 'POST', url: '/api/publish', headers: { 'Content-Type': 'application/json' }, body: { title: '合并测试：发布一篇观察', content: '# 正文\n测试内容', userId: 'masterlinc', options: { rich: true, mp: true } } }), res);
    ok(res.statusCode === 200 && res.body.ok === true && /^pub_/.test(res.body.taskId), 'A1 POST /api/publish 创建任务 → 200 ok + taskId');
    taskId = res.body.taskId;
    const t = mockDB.tables.find((x) => x.name === 'publish_tasks');
    ok(t && t.records.length === 1 && t.records[0].fields['状态'] === 'pending' && t.records[0].fields['用户'] === 'masterlinc', 'A1 写入 publish_tasks（状态 pending）');
  }
  {
    const res = makeRes();
    await lead(makeReq({ method: 'POST', url: '/api/publish', body: { content: '没有标题' } }), res);
    ok(res.statusCode === 502 && res.body.ok === false, 'A2 无标题 → 502（错误不外泄明细）');
  }

  console.log('\n— B. /api/publish?op=pending 拉取待办（鉴权） —');
  {
    const res = makeRes();
    await lead(makeReq({ method: 'GET', url: '/api/publish?op=pending' }), res);
    ok(res.statusCode === 403 && res.body.ok === false, 'B1 无 x-publish-key → 403（鉴权不松）');
  }
  {
    const res = makeRes();
    await lead(makeReq({ method: 'GET', url: '/api/publish?op=pending', headers: { 'x-publish-key': 'wrong-key' } }), res);
    ok(res.statusCode === 403, 'B2 错误 key → 403');
  }
  {
    const res = makeRes();
    await lead(makeReq({ method: 'GET', url: '/api/publish?op=pending', headers: PUB_HDR }), res);
    ok(res.statusCode === 200 && res.body.ok === true && res.body.count === 1 && res.body.tasks[0].taskId === taskId, 'B3 正确 key → 200 count=1 待办含正文');
    ok(res.body.tasks[0].content && res.body.tasks[0].content.indexOf('# 正文') !== -1, 'B3 待办返回 content（供 Proma 拉取排版）');
  }

  console.log('\n— C. /api/publish?op=done 回写（鉴权） —');
  {
    const res = makeRes();
    await lead(makeReq({ method: 'POST', url: '/api/publish?op=done', body: { taskId, status: 'done', result: { mp: { status: 'draft' } } } }), res);
    ok(res.statusCode === 403, 'C1 无 key 回写 → 403');
  }
  {
    const res = makeRes();
    await lead(makeReq({ method: 'POST', url: '/api/publish?op=done', headers: PUB_HDR, body: { taskId, status: 'done', result: { mp: { status: 'draft' } } } }), res);
    ok(res.statusCode === 200 && res.body.ok === true && res.body.status === 'done', 'C2 有 key 回写 → 200 done');
    const t = mockDB.tables.find((x) => x.name === 'publish_tasks');
    ok(t && t.records[0].fields['状态'] === 'done' && t.records[0].fields['结果'], 'C2 状态更新为 done + 结果落库');
  }
  {
    const res = makeRes();
    await lead(makeReq({ method: 'GET', url: '/api/publish?op=pending', headers: PUB_HDR }), res);
    ok(res.statusCode === 200 && res.body.count === 0, 'C3 回写后 pending 清空');
  }

  console.log('\n— D. /api/publish?op=config 配置读写 —');
  {
    const res = makeRes();
    await lead(makeReq({ method: 'GET', url: '/api/publish?op=config' }), res);
    ok(res.statusCode === 200 && res.body.ok === true && res.body.data && res.body.data.wechat_mp, 'D1 GET config → 200（脱敏公开）');
  }
  {
    const res = makeRes();
    await lead(makeReq({ method: 'POST', url: '/api/publish?op=config', body: { key: 'wechat_mp', value: { appId: 'wx123', appSecret: 'secret-abc', ipWhitelist: '1.2.3.4', ipWhitelistStatus: 'ok' } } }), res);
    ok(res.statusCode === 403, 'D2 无 key 写配置 → 403');
  }
  {
    const res = makeRes();
    await lead(makeReq({ method: 'POST', url: '/api/publish?op=config', headers: PUB_HDR, body: { key: 'wechat_mp', value: { appId: 'wx123', appSecret: 'secret-abc', ipWhitelist: '1.2.3.4', ipWhitelistStatus: 'ok' } } }), res);
    ok(res.statusCode === 200 && res.body.ok === true, 'D3 有 key 写配置 → 200');
    const t = mockDB.tables.find((x) => x.name === 'publish_config');
    const stored = t && t.records[0].fields['配置值'];
    ok(!!stored && stored.indexOf('secret-abc') === -1 && stored.indexOf('obf:') !== -1, 'D3 AppSecret 混淆存储（不落明文）');
  }
  {
    const res = makeRes();
    await lead(makeReq({ method: 'GET', url: '/api/publish?op=config' }), res);
    ok(res.statusCode === 200 && res.body.data.wechat_mp.appId === 'wx123' && res.body.data.wechat_mp.appSecretSet === true, 'D4 GET config → 读到 appId + appSecretSet=true（不暴露 secret）');
    ok(!JSON.stringify(res.body).includes('secret-abc'), 'D4 响应不含 AppSecret 明文');
  }

  console.log('\n— E. /api/publish?op=list 最近任务（页面） —');
  {
    const res = makeRes();
    await lead(makeReq({ method: 'GET', url: '/api/publish?op=list&userId=masterlinc' }), res);
    ok(res.statusCode === 200 && res.body.ok === true && res.body.count === 1, 'E1 op=list → 200 count=1');
    ok(res.body.tasks[0].taskId === taskId && res.body.tasks[0].status === 'done', 'E1 返回任务（taskId 匹配 + 状态 done）');
    if (!(res.body.tasks[0].taskId === taskId && res.body.tasks[0].status === 'done')) console.log('    debug:', JSON.stringify(res.body));
  }

  console.log('\n— F. 原有 lead/feedback 不破坏 —');
  {
    const res = makeRes();
    await lead(makeReq({ method: 'POST', url: '/api/lead', body: { email: 'test@example.com', question: '如何开始？', source: 'direct' }, socket: { remoteAddress: '7.7.7.7' } }), res);
    ok(res.statusCode === 200 && res.body.ok === true, 'F1 纯线索请求 → 200（未误入 publish 分支）');
    const t = mockDB.tables.find((x) => x.name === '线索');
    ok(t && t.records.length === 1 && t.records[0].fields['邮箱'] === 'test@example.com', 'F1 写入线索表');
  }
  {
    const res = makeRes();
    await lead(makeReq({ method: 'POST', url: '/api/feedback', body: { type: '有 bug', content: '合并后测试：发布页按钮错位，请修复谢谢！', email: '', meta: { page: 'products/transition-os.html' } }, socket: { remoteAddress: '8.8.8.8' } }), res);
    ok(res.statusCode === 200 && res.body.ok === true, 'F2 /api/feedback 分流仍正常 → 200');
    const t = mockDB.tables.find((x) => x.name === 'user_feedback');
    ok(t && t.records.length === 1 && t.records[0].fields['反馈类型'] === '有 bug', 'F2 写入反馈表');
  }
  {
    const res = makeRes();
    await lead(makeReq({ method: 'GET', url: '/api/lead' }), res);
    ok(res.statusCode === 405, 'F3 GET /api/lead（非 publish）→ 405 保持原行为');
  }

  console.log('\n— G. 内部函数导出（单测钩子） —');
  ok(typeof lead.handlePublish === 'function', 'G1 handlePublish 已导出');
  ok(typeof lead._publish.createTask === 'function' && typeof lead._publish.markDone === 'function', 'G2 _publish 内部函数已导出');

  console.log('\n===== 结果：' + passed + ' 通过 / ' + failed + ' 失败 =====');
  process.exit(failed ? 1 : 0);
})();
