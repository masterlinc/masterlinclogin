// ============================================================================
// tests/keepalive.test.js — api/keepalive.js 本地单测（零依赖，mock fetch）
// 运行：node tests/keepalive.test.js
// 覆盖：
//   1) 正常保活：读表格 token → 刷新 → 写回 → 返回 ok rotated:true
//   2) 表格已有 token 时续期并原位更新
//   3) 未配置任何令牌：返回 ok rotated:false（不抛错）
//   4) 刷新失败：返回 500 ok:false（不泄露详情）
//   5) 方法限制：非 GET/HEAD → 405；鉴权失败 → 403
// ============================================================================

const assert = require('assert');

let oauthCalls = [];
let oauthBehavior = { status: 200, body: { code: 0, access_token: 'mock-user-token', expires_in: 7200, refresh_token: 'mock-refresh-2' } };
let tokenTable = { tableId: 'mock-token-table', exists: true, records: [] };
let tokenRecordSeq = 0;
let tokenWriteFail = false;

function tokenTableMock(path, opts) {
  const method = (opts && opts.method) || 'GET';
  if (/\/tables$/.test(path)) {
    if (method === 'GET') {
      return { status: 200, json: async () => ({ code: 0, data: { items: tokenTable.exists ? [{ table_id: tokenTable.tableId, name: 'mail_token' }] : [] } }) };
    }
    if (method === 'POST') {
      tokenTable.exists = true;
      return { status: 200, json: async () => ({ code: 0, data: { table_id: tokenTable.tableId } }) };
    }
  }
  if (path.includes('/tables/mock-token-table/records')) {
    if (method === 'GET') {
      return { status: 200, json: async () => ({ code: 0, data: { items: tokenTable.records } }) };
    }
    if (method === 'POST') {
      if (tokenWriteFail) return { status: 200, json: async () => ({ code: 1254044, msg: 'mock write fail' }) };
      const fields = JSON.parse(opts.body).fields;
      const rec = { record_id: 'token-rec-' + (++tokenRecordSeq), fields };
      tokenTable.records.push(rec);
      return { status: 200, json: async () => ({ code: 0, data: { record: rec } }) };
    }
    if (method === 'PUT') {
      if (tokenWriteFail) return { status: 200, json: async () => ({ code: 1254044, msg: 'mock write fail' }) };
      const fields = JSON.parse(opts.body).fields;
      const rid = path.split('/').pop();
      const rec = tokenTable.records.find((r) => r.record_id === rid) || { record_id: rid };
      rec.fields = fields;
      if (!tokenTable.records.find((r) => r.record_id === rid)) tokenTable.records.push(rec);
      return { status: 200, json: async () => ({ code: 0, data: { record: rec } }) };
    }
  }
  return { status: 200, json: async () => ({ code: 0, data: { record: { record_id: 'mock-rec-1' } } }) };
}

async function mockFetch(url, opts) {
  if (url.includes('/auth/v3/tenant_access_token')) {
    return { status: 200, json: async () => ({ code: 0, tenant_access_token: 'mock-tenant-token', expire: 7200 }) };
  }
  if (url.includes('/bitable/v1/apps/')) {
    return tokenTableMock(new URL(url).pathname, opts);
  }
  if (url.includes('accounts.feishu.cn/oauth/v3/token')) {
    oauthCalls.push({ url, opts });
    const ok = oauthBehavior.status >= 200 && oauthBehavior.status < 300;
    return { status: oauthBehavior.status, ok, json: async () => oauthBehavior.body };
  }
  throw new Error('unexpected url: ' + url);
}

function reset() {
  oauthCalls = [];
  oauthBehavior = { status: 200, body: { code: 0, access_token: 'mock-user-token', expires_in: 7200, refresh_token: 'mock-refresh-2' } };
  tokenTable = { tableId: 'mock-token-table', exists: true, records: [] };
  tokenRecordSeq = 0;
  tokenWriteFail = false;
  global.fetch = mockFetch;
}

reset();

function loadHandler() {
  // 必须同时清 lib 模块缓存（含 mailTokenCache），否则用例间 token 缓存残留
  delete require.cache[require.resolve('../lib/feishu-token.js')];
  delete require.cache[require.resolve('../api/keepalive.js')];
  return require('../api/keepalive.js');
}

function setBaseEnv() {
  process.env.FEISHU_APP_ID = 'mock';
  process.env.FEISHU_APP_SECRET = 'mock';
  process.env.FEISHU_APP_TOKEN = 'mock';
  process.env.FEISHU_TABLE_ID = 'mock';
  delete process.env.FEISHU_KEEPALIVE_SECRET;
}

function makeReq(method, headers) {
  return { method, headers: headers || {} };
}
function makeRes() {
  return {
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    statusCode: 0,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(obj) { this.body = obj; },
    end() {},
  };
}

async function run() {
  // 用例 1：正常保活（env 初始 token → 刷新 → 写回 → ok）
  reset();
  setBaseEnv();
  process.env.FEISHU_MAIL_REFRESH_TOKEN = 'mock-refresh-1';
  delete process.env.FEISHU_MAIL_USER_ACCESS_TOKEN;
  const handler1 = loadHandler();
  const res1 = makeRes();
  await handler1(makeReq('GET'), res1);
  assert.strictEqual(res1.statusCode, 200, '用例1: 应返回 200');
  assert.strictEqual(res1.body.ok, true, '用例1: ok 应为 true');
  assert.strictEqual(res1.body.rotated, true, '用例1: rotated 应为 true');
  assert.strictEqual(oauthCalls.length, 1, '用例1: 应刷新 1 次');
  assert.strictEqual(tokenTable.records.length, 1, '用例1: 应写回 1 条 token');
  assert.strictEqual(tokenTable.records[0].fields.refresh_token, 'mock-refresh-2', '用例1: 表格应存新 refresh_token');
  console.log('✅ 用例1 通过：保活刷新 + 写回新 token');

  // 用例 2：表格已有 token → 用它续期并原位更新
  reset();
  setBaseEnv();
  delete process.env.FEISHU_MAIL_REFRESH_TOKEN;
  delete process.env.FEISHU_MAIL_USER_ACCESS_TOKEN;
  tokenTable.records = [{ record_id: 'token-rec-5', fields: { refresh_token: 'mock-refresh-table', updated_at: Date.now() } }];
  const handler2 = loadHandler();
  const res2 = makeRes();
  await handler2(makeReq('GET'), res2);
  assert.strictEqual(res2.body.ok, true, '用例2: ok 应为 true');
  assert.strictEqual(res2.body.rotated, true, '用例2: rotated 应为 true');
  assert.strictEqual(oauthCalls.length, 1, '用例2: 应刷新 1 次');
  const body2 = JSON.parse(oauthCalls[0].opts.body);
  assert.strictEqual(body2.refresh_token, 'mock-refresh-table', '用例2: 应使用表格里的 token');
  assert.strictEqual(tokenTable.records.length, 1, '用例2: 应原位更新');
  assert.strictEqual(tokenTable.records[0].fields.refresh_token, 'mock-refresh-2', '用例2: 新 token 写回');
  console.log('✅ 用例2 通过：表格 token 优先，续期后原位更新');

  // 用例 3：未配置任何令牌 → ok rotated:false（不抛错，方便监控）
  reset();
  setBaseEnv();
  delete process.env.FEISHU_MAIL_REFRESH_TOKEN;
  delete process.env.FEISHU_MAIL_USER_ACCESS_TOKEN;
  const handler3 = loadHandler();
  const res3 = makeRes();
  await handler3(makeReq('GET'), res3);
  assert.strictEqual(res3.statusCode, 200, '用例3: 应返回 200');
  assert.strictEqual(res3.body.ok, true, '用例3: ok 应为 true');
  assert.strictEqual(res3.body.rotated, false, '用例3: rotated 应为 false');
  assert.strictEqual(oauthCalls.length, 0, '用例3: 不应刷新');
  console.log('✅ 用例3 通过：未配置令牌时返回 rotated:false');

  // 用例 4：刷新失败 → 500 ok:false
  reset();
  setBaseEnv();
  process.env.FEISHU_MAIL_REFRESH_TOKEN = 'mock-refresh-1';
  delete process.env.FEISHU_MAIL_USER_ACCESS_TOKEN;
  oauthBehavior = { status: 200, body: { code: 99991663, msg: 'mock refresh token invalid' } };
  const handler4 = loadHandler();
  const res4 = makeRes();
  await handler4(makeReq('GET'), res4);
  assert.strictEqual(res4.statusCode, 500, '用例4: 应返回 500');
  assert.strictEqual(res4.body.ok, false, '用例4: ok 应为 false');
  assert.strictEqual(tokenTable.records.length, 0, '用例4: 失败不应写入 token');
  console.log('✅ 用例4 通过：刷新失败返回 500，不写回（旧 token 下次重试）');

  // 用例 5：方法限制 + 鉴权
  reset();
  setBaseEnv();
  const handler5 = loadHandler();
  const res5 = makeRes();
  await handler5(makeReq('POST'), res5);
  assert.strictEqual(res5.statusCode, 405, '用例5a: POST 应 405');
  process.env.FEISHU_KEEPALIVE_SECRET = 's3cret';
  const handler5b = loadHandler();
  const res5b = makeRes();
  await handler5b(makeReq('GET', { authorization: 'Bearer wrong' }), res5b);
  assert.strictEqual(res5b.statusCode, 403, '用例5b: 错误鉴权应 403');
  const res5c = makeRes();
  await handler5b(makeReq('GET', { authorization: 'Bearer s3cret' }), res5c);
  assert.strictEqual(res5c.statusCode, 200, '用例5c: 正确鉴权应 200');
  console.log('✅ 用例5 通过：405 方法限制 + 403 鉴权保护');

  console.log('\n🎉 keepalive 全部 5 个用例通过');
}

run().catch((err) => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});
