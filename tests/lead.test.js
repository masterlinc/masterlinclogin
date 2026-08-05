// ============================================================================
// tests/lead.test.js — api/lead.js 本地单测（零依赖，mock fetch，不发送真实请求）
// 运行：node tests/lead.test.js
// 覆盖：
//   1) 正常流程：飞书写入成功 → Resend 发送成功 → 返回 200 ok + emailSent:true
//      （校验收件人、主题、3 个附件 base64 完整性）
//   2) Resend 失败：返回 500 时，飞书线索不丢、前端仍收到 ok，emailSent:false
//   3) 未配置 RESEND_API_KEY：跳过发送，前端仍 ok，不发 Resend 请求
// ============================================================================

const assert = require('assert');

// ---------- mock fetch ----------
let resendCalls = [];
let resendBehavior = { status: 200, body: { id: 'mock-email-1' } };

async function mockFetch(url, opts) {
  if (url.includes('/auth/v3/tenant_access_token')) {
    return { status: 200, json: async () => ({ code: 0, tenant_access_token: 'mock-token', expire: 7200 }) };
  }
  if (url.includes('/bitable/v1/apps/')) {
    return { status: 200, json: async () => ({ code: 0, data: { record: { record_id: 'mock-rec-1' } } }) };
  }
  if (url.includes('api.resend.com/emails')) {
    resendCalls.push({ url, opts });
    const ok = resendBehavior.status >= 200 && resendBehavior.status < 300;
    return {
      ok,
      status: resendBehavior.status,
      json: async () => resendBehavior.body,
    };
  }
  throw new Error('unexpected url: ' + url);
}

// ---------- mock req/res ----------
function makeReq(body) {
  return { method: 'POST', body };
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

// ---------- 每个用例重置 ----------
function reset() {
  resendCalls = [];
  resendBehavior = { status: 200, body: { id: 'mock-email-1' } };
  global.fetch = mockFetch; // 必须挂到全局，api/lead.js 用的是内置 fetch
}

// 首次设置全局 fetch
reset();

function loadHandler() {
  delete require.cache[require.resolve('../api/lead.js')];
  return require('../api/lead.js');
}

async function run() {
  // 用例 1：正常流程（配置了 RESEND_API_KEY）
  reset();
  process.env.RESEND_API_KEY = 're_test_mock_key';
  process.env.FEISHU_APP_ID = 'mock'; process.env.FEISHU_APP_SECRET = 'mock';
  process.env.FEISHU_APP_TOKEN = 'mock'; process.env.FEISHU_TABLE_ID = 'mock';
  const handler1 = loadHandler();
  const res1 = makeRes();
  await handler1(makeReq({ email: 'visitor@example.com', question: '会议纪要总是返工', source: 'selfcheck' }), res1);

  assert.strictEqual(res1.statusCode, 200, '用例1: 应返回 200');
  assert.strictEqual(res1.body.ok, true, '用例1: ok 应为 true');
  assert.strictEqual(res1.body.emailSent, true, '用例1: emailSent 应为 true');
  assert.strictEqual(resendCalls.length, 1, '用例1: 应恰好调用 1 次 Resend');

  const payload = JSON.parse(resendCalls[0].opts.body);
  assert.strictEqual(payload.to, 'visitor@example.com', '用例1: 收件人应等于访客邮箱');
  assert.ok(payload.subject.includes('已到'), '用例1: 主题应包含「已到」');
  assert.strictEqual(payload.attachments.length, 3, '用例1: 应有 3 个附件');
  const pdf = payload.attachments.find((a) => a.filename.endsWith('.pdf'));
  assert.ok(pdf, '用例1: 应含 PDF 附件');
  assert.ok(pdf.content.length > 10000, '用例1: PDF base64 应完整（>10KB 字符）');
  assert.ok(payload.text.includes('凌：'), '用例1: 正文应含署名风格开头');
  assert.ok(payload.text.includes('masterlinc.com'), '用例1: 正文应含网站');
  console.log('✅ 用例1 通过：飞书写入 + Resend 成功，3 附件完整，返回 ok');

  // 用例 2：Resend 失败（500）→ 前端仍 ok，emailSent=false
  reset();
  resendBehavior = { status: 500, body: { message: 'mock server error' } };
  const handler2 = loadHandler();
  const res2 = makeRes();
  await handler2(makeReq({ email: 'visitor2@example.com' }), res2);
  assert.strictEqual(res2.statusCode, 200, '用例2: 邮件失败不应影响前端，仍 200');
  assert.strictEqual(res2.body.ok, true, '用例2: ok 应为 true');
  assert.strictEqual(res2.body.emailSent, false, '用例2: emailSent 应为 false');
  assert.strictEqual(resendCalls.length, 1, '用例2: 应尝试过 1 次 Resend');
  console.log('✅ 用例2 通过：Resend 失败被吞掉，线索不丢，前端仍 ok');

  // 用例 3：未配置 RESEND_API_KEY → 跳过发送，前端 ok
  reset();
  delete process.env.RESEND_API_KEY;
  const handler3 = loadHandler();
  const res3 = makeRes();
  await handler3(makeReq({ email: 'visitor3@example.com' }), res3);
  assert.strictEqual(res3.statusCode, 200, '用例3: 应返回 200');
  assert.strictEqual(res3.body.ok, true, '用例3: ok 应为 true');
  assert.strictEqual(res3.body.emailSent, false, '用例3: emailSent 应为 false');
  assert.strictEqual(resendCalls.length, 0, '用例3: 不应调用 Resend');
  console.log('✅ 用例3 通过：未配置 key 时跳过发送，不影响飞书线索');

  // 用例 4：邮箱格式校验仍生效
  reset();
  process.env.RESEND_API_KEY = 're_test_mock_key';
  const handler4 = loadHandler();
  const res4 = makeRes();
  await handler4(makeReq({ email: 'not-an-email' }), res4);
  assert.strictEqual(res4.statusCode, 400, '用例4: 非法邮箱应返回 400');
  assert.strictEqual(res4.body.ok, false, '用例4: ok 应为 false');
  assert.strictEqual(resendCalls.length, 0, '用例4: 不应触发 Resend');
  console.log('✅ 用例4 通过：非法邮箱 400，不触发送信');

  console.log('\n🎉 全部 4 个用例通过');
}

run().catch((err) => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});
