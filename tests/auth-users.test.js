// ============================================================================
// tests/auth-users.test.js — 账号密码认证体系专项单测（零依赖，mock fetch，不触碰真实飞书）
//
// 运行：node tests/auth-users.test.js
// 覆盖：
//   1) 正确登录（username+password）→ 200 + token 含 role / userId
//   2) 错误密码 / 错误用户名 → 401「用户名或密码错误」
//   3) 未配置 env（ADMIN_SECRET / FEISHU_APP_TOKEN）→ 403 安全默认
//   4) token 含 role；requireAdmin 拒绝非 admin token（403）；旧 token(sub=masterlinc) 兼容
//   5) 兼容迁移：users 表空 + ADMIN_PASSWORD → 首次登录自动建 admin 账号；
//      迁移后删除 ADMIN_PASSWORD 仍可登录（完全走 users 表）
//   6) ADMIN_PASSWORD_HASH 自举：无需明文即可建号登录
//   7) 密码哈希：scrypt 盐+哈希，绝不存明文（表内 passwordHash 以 scrypt$ 开头）
//   8) 前端 admin/index.html 含用户名输入框 + 提交 { username, password }
// ============================================================================

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ---------- 环境 ----------
process.env.FEISHU_APP_TOKEN = 'app-mock-users';
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
  const pathname = u.pathname;
  const method = (opts && opts.method) || 'GET';
  const body = opts && opts.body ? JSON.parse(opts.body) : null;

  if (pathname.includes('/auth/v3/tenant_access_token')) {
    return { status: 200, json: async () => ({ code: 0, tenant_access_token: 'mock-tenant', expire: 7200 }) };
  }

  // 表列表 / 建表
  let m = pathname.match(/\/bitable\/v1\/apps\/[^/]+\/tables$/);
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
  m = pathname.match(/\/bitable\/v1\/apps\/[^/]+\/tables\/([^/]+)\/records(?:\/([^/]+))?$/);
  if (m) {
    const tid = m[1];
    const rid = m[2];
    const t = mockDB.byTid.get(tid);
    if (!t) return { status: 200, json: async () => ({ code: 1254041, msg: 'mock: table not found' }) };

    if (method === 'GET') {
      const items = t.records.slice();
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
  return { status: 200, json: async () => ({ code: -1, msg: 'mock: unmatched ' + pathname }) };
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
  const r = Object.assign({ method: 'GET', headers: {}, query: {}, socket: { remoteAddress: '1.2.3.4' } }, over);
  return r;
}

// ---------- 测试辅助 ----------
let passed = 0, failed = 0;
async function login(username, password) {
  const loginHandler = require('../api/admin/login.js');
  const res = makeRes();
  await loginHandler(makeReq({ method: 'POST', body: { username, password } }), res);
  return res;
}

const SCENARIOS = [
  ['登录：正确 username+password → 200 + token 含 role', runLoginOk],
  ['登录：错误密码 / 错误用户名 → 401', runLoginFail],
  ['登录：未配置 env → 403 安全默认', runNoEnv],
  ['token：含 role；requireAdmin 权限校验；旧 token 兼容', runTokenRole],
  ['兼容迁移：ADMIN_PASSWORD 自动建账号，迁移后删除口令仍可登录', runMigrate],
  ['自举：ADMIN_PASSWORD_HASH 无需明文建号登录', runHashBootstrap],
  ['密码哈希：scrypt 盐+哈希，绝不存明文', runHashFormat],
  ['前端：admin/index.html 含用户名输入框 + 提交 username/password', runFrontend],
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

// ==================== 1. 正确登录 ====================
async function runLoginOk() {
  const auth = require('../lib/admin-auth.js');
  process.env.ADMIN_PASSWORD = 'compat-password-1';
  delete process.env.ADMIN_PASSWORD_HASH;
  auth.resetUsersCache();

  const res = await login('admin', 'compat-password-1');
  assert.strictEqual(res.statusCode, 200, '正确账号密码应 200');
  assert.ok(res.body.token, '应返回 token');
  assert.strictEqual(res.body.role, 'admin', '响应应含 role');
  assert.strictEqual(res.body.userId, 'admin-admin', '响应应含 userId');
  assert.strictEqual(res.body.username, 'admin');

  const payload = auth.verifyToken(res.body.token);
  assert.ok(payload, 'token 应可验证');
  assert.strictEqual(payload.sub, 'admin-admin', 'token sub 应为 userId');
  assert.strictEqual(payload.role, 'admin', 'token 应含 role');

  // users 表应已自动创建并含账号
  const usersTable = tableByName('users');
  assert.ok(usersTable, 'users 表应自动创建');
  assert.strictEqual(usersTable.records.length, 1, '应只有 1 个账号');
  const rec = usersTable.records[0].fields;
  assert.strictEqual(rec.username, 'admin');
  assert.strictEqual(rec.role, 'admin');
  assert.ok(rec.passwordHash.indexOf('scrypt$') === 0, 'passwordHash 应为 scrypt 格式');
  delete process.env.ADMIN_PASSWORD;
}

// ==================== 2. 错误密码 / 用户名 ====================
async function runLoginFail() {
  const auth = require('../lib/admin-auth.js');
  auth.resetLoginRate();
  auth.resetUsersCache();
  const usersTable = tableByName('users');
  if (usersTable) usersTable.records.length = 0; // 场景隔离：清空账号
  // 已有账号场景：先建一个账号（用兼容迁移），再用错误凭据登录
  process.env.ADMIN_PASSWORD = 'pre-hashed-password';
  delete process.env.ADMIN_PASSWORD_HASH;
  let res = await login('admin', 'pre-hashed-password');
  assert.strictEqual(res.statusCode, 200);
  delete process.env.ADMIN_PASSWORD;

  auth.resetLoginRate();
  res = await login('admin', 'wrong-password');
  assert.strictEqual(res.statusCode, 401, '错误密码应 401');
  assert.strictEqual(res.body.message, '用户名或密码错误', '提示不应泄露具体是用户名还是密码错');

  auth.resetLoginRate();
  res = await login('nobody', 'pre-hashed-password');
  assert.strictEqual(res.statusCode, 401, '错误用户名应 401');

  auth.resetLoginRate();
}

// ==================== 3. 未配置 env ====================
async function runNoEnv() {
  const auth = require('../lib/admin-auth.js');
  const save = { s: process.env.ADMIN_SECRET, t: process.env.FEISHU_APP_TOKEN };
  delete process.env.ADMIN_SECRET; delete process.env.FEISHU_APP_TOKEN;
  const res = await login('admin', 'whatever');
  assert.strictEqual(res.statusCode, 403, '未配置 env 登录应 403');
  process.env.ADMIN_SECRET = save.s; process.env.FEISHU_APP_TOKEN = save.t;
}

// ==================== 4. token role / 权限 ====================
async function runTokenRole() {
  const auth = require('../lib/admin-auth.js');

  // 新 token：role=admin → requireAdmin 通过
  const adminToken = auth.issueToken({ userId: 'admin-admin', role: 'admin' }).token;
  let res = makeRes();
  assert.strictEqual(auth.requireAdmin(makeReq({ headers: { authorization: 'Bearer ' + adminToken } }), res), true, 'admin token 应通过 requireAdmin');

  // user token → requireAdmin 403
  const userToken = auth.issueToken({ userId: 'user-zhang', role: 'user' }).token;
  res = makeRes();
  assert.strictEqual(auth.requireAdmin(makeReq({ headers: { authorization: 'Bearer ' + userToken } }), res), false);
  assert.strictEqual(res.statusCode, 403, '非 admin token 调管理接口应 403');

  // user token → requireUser 通过（未来会员接口预留）
  res = makeRes();
  assert.strictEqual(auth.requireUser(makeReq({ headers: { authorization: 'Bearer ' + userToken } }), res), true, 'user token 应通过 requireUser');

  // 旧 token（sub=masterlinc）→ requireAdmin 兼容
  const oldPayloadB64 = Buffer.from(JSON.stringify({ sub: 'masterlinc', iat: Date.now(), exp: Date.now() + 3600e3 })).toString('base64url');
  const sig = require('crypto').createHmac('sha256', process.env.ADMIN_SECRET).update(oldPayloadB64).digest('base64url');
  res = makeRes();
  assert.strictEqual(auth.requireAdmin(makeReq({ headers: { authorization: 'Bearer ' + oldPayloadB64 + '.' + sig } }), res), true, '旧 token 应兼容');
}

// ==================== 5. 兼容迁移 ====================
async function runMigrate() {
  const auth = require('../lib/admin-auth.js');
  auth.resetUsersCache();
  // 清空 users 表
  const usersTable = tableByName('users');
  if (usersTable) usersTable.records.length = 0;

  process.env.ADMIN_PASSWORD = 'legacy-secret';
  delete process.env.ADMIN_PASSWORD_HASH;

  // 首次登录 → 兼容迁移自动建号
  let res = await login('admin', 'legacy-secret');
  assert.strictEqual(res.statusCode, 200, '首次登录应成功并自动建号');
  assert.strictEqual(tableByName('users').records.length, 1);

  // 迁移后删除 ADMIN_PASSWORD（模拟旧 env 已下线）→ 仍可登录（走 users 表）
  delete process.env.ADMIN_PASSWORD;
  auth.resetLoginRate();
  res = await login('admin', 'legacy-secret');
  assert.strictEqual(res.statusCode, 200, '迁移后应完全走 users 表，不依赖 ADMIN_PASSWORD');

  // 错误密码仍 401
  auth.resetLoginRate();
  res = await login('admin', 'wrong');
  assert.strictEqual(res.statusCode, 401);
}

// ==================== 6. ADMIN_PASSWORD_HASH 自举 ====================
async function runHashBootstrap() {
  const auth = require('../lib/admin-auth.js');
  auth.resetUsersCache();
  const usersTable = tableByName('users');
  if (usersTable) usersTable.records.length = 0;

  const hash = await auth.hashPassword('pre-hashed-password');
  delete process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD_HASH = hash;

  const res = await login('admin', 'pre-hashed-password');
  assert.strictEqual(res.statusCode, 200, 'HASH 自举应登录成功');
  assert.strictEqual(tableByName('users').records[0].fields.passwordHash, hash, '应原样保存已配置哈希');
  delete process.env.ADMIN_PASSWORD_HASH;
}

// ==================== 7. scrypt 哈希格式 ====================
async function runHashFormat() {
  const auth = require('../lib/admin-auth.js');
  const hash = await auth.hashPassword('plaintext-password');
  assert.ok(/^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(hash), '哈希格式 scrypt$N$r$p$salt$hash');
  assert.ok(hash.indexOf('plaintext-password') === -1, '哈希绝不包含明文');
  assert.ok(await auth.verifyPassword('plaintext-password', hash), '正确密码可验证');
  assert.ok(!(await auth.verifyPassword('wrong', hash)), '错误密码不可验证');
  assert.ok(!(await auth.verifyPassword('x', 'scrypt$bad')), '畸形哈希应拒绝');
}

// ==================== 8. 前端登录页 ====================
async function runFrontend() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'index.html'), 'utf8');
  assert.ok(html.includes('id="loginUsername"'), '登录页应含用户名输入框');
  assert.ok(html.includes('autocomplete="username"'), '用户名输入框应带 autocomplete');
  assert.ok(html.includes("api('POST', '/api/admin/login', { username: usr, password: pwd })"), '登录应提交 { username, password }');
  assert.ok(html.includes("login: { username: 'admin'"), '内置 Mock 应含 username');
  assert.ok(html.indexOf('id="loginPassword"') !== -1, '密码框应保留');
}
