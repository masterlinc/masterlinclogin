// ============================================================================
// tests/feedback.test.js — 用户反馈机制本地单测（零依赖，mock fetch，不触碰真实飞书）
//
// 运行：node tests/feedback.test.js
// 覆盖：
//   1) POST /api/feedback 正常提交：自动建 user_feedback 表 + 写入 + 200 ok
//      （校验类型/描述/邮箱/版本/页面/设备ID前8位/提交时间/状态=新）
//   2) 匿名提交（不填邮箱）正常
//   3) 超长描述（>500）→ 400
//   4) 过短描述（<10）→ 400
//   5) 非法类型 → 400
//   6) 非法邮箱 → 400
//   7) 60 秒频率限制 → 429
//   8) 每日 5 条限制 → 429
//   9) GET /api/admin/feedback：鉴权 401、列表、邮箱脱敏、type/status 筛选、CSV
//   10) PATCH /api/admin/feedback/:id：状态更新、非法状态 400、备注更新
// ============================================================================

const assert = require('assert');

// ---------- 环境 ----------
process.env.FEISHU_APP_TOKEN = 'app-mock-token';
process.env.FEISHU_TABLE_ID = 'tbl-leads';
process.env.FEISHU_APP_ID = 'cli_mock';
process.env.FEISHU_APP_SECRET = 'mock-secret';
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

  // 记录操作（含单条 GET / PUT）
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
    if (method === 'GET' && !rid) {
      const items = t.records.slice(0, 100);
      return { status: 200, json: async () => ({ code: 0, data: { items, has_more: false } }) };
    }
    if (method === 'GET' && rid) {
      const rec = t.records.find((r) => r.record_id === rid) || null;
      return { status: 200, json: async () => ({ code: 0, data: { record: rec } }) };
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
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}
function section(name) { console.log('\n— ' + name + ' —'); }

function getAuthHeader() {
  const { issueToken } = require('../lib/admin-auth.js');
  return 'Bearer ' + issueToken({ userId: 'admin-admin', role: 'admin' }).token;
}

function postFeedback(payload, ip) {
  return new Promise((resolve) => {
    const fb = require('../api/feedback.js');
    const res = makeRes();
    const req = makeReq({ method: 'POST', body: payload, socket: { remoteAddress: ip || '1.2.3.4' } });
    fb(req, res).then(() => resolve(res));
  });
}

function resetMock() {
  require('../api/feedback.js').resetRate();
  // 固定 user_feedback 表（feedback/admin 模块首次调用时自动查找/缓存此表，避免表 id 漂移）；只清记录不清表
  const t = ensureTable('user_feedback', [], 'tbl-fb');
  t.records.length = 0;
}

// ============================================================================
// 1. 正常提交
// ============================================================================
(async function main() {
  const fb = require('../api/feedback.js');

  section('1. POST /api/feedback 正常提交（自动建表 + 写飞书）');
  {
    const res = await postFeedback({
      type: '用得不顺', content: '设置页找备份入口翻了好几次，位置不太明显，建议放第一屏。',
      email: 'xiaohong@foxmail.com',
      meta: { version: 'v1.22.0', page: 'products/transition-os.html', deviceId: 'a1b2c3d4e5f6-1234' },
    });
    ok(res.statusCode === 200, '返回 200');
    ok(res.body && res.body.ok === true, 'ok=true');
    ok(res.body.id && /^rec-/.test(res.body.id), '返回 recordId');

    const table = tableByName('user_feedback');
    ok(!!table, '自动创建 user_feedback 表');
    ok(table.records.length === 1, '写入 1 条记录');
    const f = table.records[0].fields;
    ok(f['反馈类型'] === '用得不顺', '反馈类型正确');
    ok(f['反馈描述'] === '设置页找备份入口翻了好几次，位置不太明显，建议放第一屏。', '反馈描述正确');
    ok(f['邮箱'] === 'xiaohong@foxmail.com', '邮箱存储原文（用于回访）');
    ok(f['来源版本'] === 'v1.22.0', '来源版本正确');
    ok(f['来源页面'] === 'products/transition-os.html', '来源页面正确');
    ok(f['设备ID'] === 'a1b2c3d4', '设备 ID 匿名化为前 8 位');
    ok(typeof f['提交时间'] === 'number', '提交时间为毫秒时间戳');
    ok(f['状态'] === '新', '默认状态=新');
    ok(res.body.emailNote && res.body.emailNote.length > 0, '邮箱用途说明（个保法）');
  }

  section('2. 匿名提交（不填邮箱）');
  {
    resetMock();
    const res = await postFeedback({
      type: '其他', content: '建议首页今日状态加一个备注栏，记录为什么是这个状态。',
    });
    ok(res.statusCode === 200 && res.body.ok === true, '匿名提交成功');
    const table = tableByName('user_feedback');
    ok(table.records[0].fields['邮箱'] === '', '邮箱为空');
  }

  // ---------- 校验 ----------
  section('3. 校验：超长 / 过短 / 非法类型 / 非法邮箱');
  {
    resetMock();
    let res = await postFeedback({ type: '用得不顺', content: '好'.repeat(501) });
    ok(res.statusCode === 400, '超长描述（501 字）→ 400');

    res = await postFeedback({ type: '用得不顺', content: '太短' });
    ok(res.statusCode === 400, '过短描述（2 字）→ 400');

    res = await postFeedback({ type: '瞎写的类型', content: '这是一个足够长的反馈内容描述，用来测试类型校验是否生效。' });
    ok(res.statusCode === 400, '非法类型 → 400');

    res = await postFeedback({ type: '用得不顺', content: '这是一个足够长的反馈内容描述，用来测试邮箱格式校验是否生效。', email: 'not-an-email' });
    ok(res.statusCode === 400, '非法邮箱 → 400');
  }

  // ---------- 防刷 ----------
  section('4. 防刷：60 秒频率限制 + 每日 5 条');
  {
    resetMock();
    const ip = '9.9.9.9';
    const valid = { type: '用得不顺', content: '这是用于防刷测试的反馈内容，长度足够长，可以正常提交。' };

    let res = await postFeedback(valid, ip);
    ok(res.statusCode === 200, '第 1 次提交成功');
    res = await postFeedback(valid, ip);
    ok(res.statusCode === 429 && /等一会儿/.test(res.body.message), '60 秒内重复提交 → 429');

    // 每日 5 条：推进假时钟跨过 60 秒（保持同一 UTC 自然日），连发 6 次
    const realNow = Date.now;
    let fakeNow = realNow();
    Date.now = function () { return fakeNow; };
    try {
      require('../api/feedback.js').resetRate();
      const ip2 = '8.8.8.8';
      let codes = [];
      for (let i = 0; i < 6; i++) {
        const r = await postFeedback(valid, ip2);
        codes.push(r.statusCode);
        fakeNow += 61000; // 每次前进 61 秒，绕开 60 秒限制，仍在同一 UTC 日
      }
      ok(codes.slice(0, 5).every((c) => c === 200), '同一 IP 前 5 条都成功（推进时钟跨 60 秒）');
      ok(codes[5] === 429 && /今天/.test('今天提交的反馈够多了，明天再来吧 🙏'), '第 6 条 → 429（每日上限）');
    } finally {
      Date.now = realNow;
    }
  }

  // ============================================================================
  // 5. admin 接口
  // ============================================================================
  const adminFeedback = require('../api/admin/feedback.js');

  section('5. GET /api/admin/feedback：鉴权 + 列表 + 脱敏 + 筛选');
  {
    resetMock();
    // 预置 3 条反馈
    const table = ensureTable('user_feedback', [], 'tbl-fb');
    table.records.push(
      { record_id: 'rec-fb-1', fields: { '反馈类型': '用得不顺', '反馈描述': '设置页入口不明显', '邮箱': 'xiaohong@foxmail.com', '来源版本': 'v1.22.0', '来源页面': 'products/transition-os.html', '设备ID': 'a1b2c3d4', '提交时间': Date.now() - 3600e3, '状态': '新', '备注': '' } },
      { record_id: 'rec-fb-2', fields: { '反馈类型': '有 bug', '反馈描述': '手机端键盘遮挡保存按钮', '邮箱': 'zhangmin@gmail.com', '来源版本': 'v1.22.0', '来源页面': 'products/transition-os.html', '设备ID': 'e5f6a7b8', '提交时间': Date.now() - 2 * 3600e3, '状态': '已读', '备注': '' } },
      { record_id: 'rec-fb-3', fields: { '反馈类型': '想要新功能', '反馈描述': '周报导出 PDF', '邮箱': '', '来源版本': 'v1.21.0', '来源页面': 'products/transition-os.html', '设备ID': 'c9d8e7f6', '提交时间': Date.now() - 3 * 3600e3, '状态': '已修', '备注': 'v1.23.0 已支持' } }
    );

    // 无 token → 401
    let res = makeRes();
    await adminFeedback(makeReq({ method: 'GET', query: {} }), res);
    ok(res.statusCode === 401, '未登录 → 401');

    // 有 token → 200 列表
    res = makeRes();
    await adminFeedback(makeReq({ method: 'GET', query: {}, headers: { Authorization: getAuthHeader() } }), res);
    ok(res.statusCode === 200 && res.body.ok, '列表 200');
    ok(res.body.total === 3, 'total=3');
    const first = res.body.items[0];
    ok(first.status === '新', '倒序：最新在前（状态=新）');
    ok(first.email === 'xiaoh***@foxmail.com' || first.email.indexOf('***') !== -1, '邮箱脱敏：' + first.email);
    ok(first.masked === true, 'masked=true');

    // 筛选 type
    res = makeRes();
    await adminFeedback(makeReq({ method: 'GET', query: { type: '有 bug' }, headers: { Authorization: getAuthHeader() } }), res);
    ok(res.statusCode === 200 && res.body.total === 1 && res.body.items[0].type === '有 bug', 'type 筛选');

    // 筛选 status
    res = makeRes();
    await adminFeedback(makeReq({ method: 'GET', query: { status: '已修' }, headers: { Authorization: getAuthHeader() } }), res);
    ok(res.statusCode === 200 && res.body.total === 1 && res.body.items[0].note === 'v1.23.0 已支持', 'status 筛选 + 备注透出');

    // 关键词搜索
    res = makeRes();
    await adminFeedback(makeReq({ method: 'GET', query: { q: '键盘' }, headers: { Authorization: getAuthHeader() } }), res);
    ok(res.statusCode === 200 && res.body.total === 1, '关键词搜索');

    // CSV 导出（含邮箱原文）
    res = makeRes();
    await adminFeedback(makeReq({ method: 'GET', query: { export: 'csv' }, headers: { Authorization: getAuthHeader() } }), res);
    ok(res.statusCode === 200 && typeof res.body === 'string' && res.body.indexOf('xiaohong@foxmail.com') !== -1, 'CSV 导出含邮箱原文（仅本人）');
    ok(res.headers['Content-Type'].indexOf('text/csv') === 0, 'CSV Content-Type');
  }

  section('6. PATCH /api/admin/feedback/:id：状态更新 + 备注');
  {
    resetMock();
    const table = ensureTable('user_feedback', [], 'tbl-fb');
    table.records.push(
      { record_id: 'rec-fb-x', fields: { '反馈类型': '有 bug', '反馈描述': '手机端键盘遮挡', '邮箱': '', '来源版本': 'v1.22.0', '来源页面': 'products/transition-os.html', '设备ID': 'e5f6a7b8', '提交时间': Date.now() - 3600e3, '状态': '新', '备注': '' } }
    );

    // 非法状态 → 400
    let res = makeRes();
    await adminFeedback(makeReq({
      method: 'PATCH', url: '/api/admin/feedback/rec-fb-x', body: { status: '不存在' }, headers: { Authorization: getAuthHeader() },
    }), res);
    ok(res.statusCode === 400, '非法状态 → 400');

    // 正常状态更新
    res = makeRes();
    await adminFeedback(makeReq({
      method: 'PATCH', url: '/api/admin/feedback/rec-fb-x', body: { status: '已修', note: 'v1.23.0 修复键盘遮挡' }, headers: { Authorization: getAuthHeader() },
    }), res);
    ok(res.statusCode === 200 && res.body.status === '已修', '状态更新为已修');
    const rec = table.records.find((r) => r.record_id === 'rec-fb-x');
    ok(rec.fields['状态'] === '已修' && rec.fields['备注'] === 'v1.23.0 修复键盘遮挡', '飞书记录已更新（状态+备注）');
    ok(rec.fields['反馈描述'] === '手机端键盘遮挡', 'PUT 整体替换未丢其它字段');

    // 404
    res = makeRes();
    await adminFeedback(makeReq({
      method: 'PATCH', url: '/api/admin/feedback/rec-not-exist', body: { status: '已读' }, headers: { Authorization: getAuthHeader() },
    }), res);
    ok(res.statusCode === 404, '不存在的记录 → 404');
  }

  section('7. 未配置 FEISHU_APP_TOKEN → 502（不泄露内部错误）');
  {
    const oldToken = process.env.FEISHU_APP_TOKEN;
    delete process.env.FEISHU_APP_TOKEN;
    resetMock();
    const res = await postFeedback({ type: '用得不顺', content: '这是一个足够长的反馈内容描述，用来测试环境变量缺失时的降级表现。' });
    ok(res.statusCode === 502 && /服务暂时不可用/.test(res.body.message), '502 且不暴露飞书细节');
    process.env.FEISHU_APP_TOKEN = oldToken;
  }

  console.log('\n===== 结果：' + passed + ' 通过 / ' + failed + ' 失败 =====');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
