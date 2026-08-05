// ============================================================================
// tests/lead.test.js — api/lead.js 本地单测（零依赖，mock fetch，不发送真实请求）
// 运行：node tests/lead.test.js
// 覆盖：
//   1) 正常流程：飞书写入成功 → 飞书邮件发送成功 → 返回 200 ok + emailSent:true
//      （校验 URL、收件人、主题、3 个附件 base64url 完整性、dedupe_key）
//   2) 飞书邮件失败（code!=0）：飞书线索不丢、前端仍收到 ok，emailSent:false
//   3) 未配置发信令牌：跳过发送，前端仍 ok，不发邮件请求
//   4) 邮箱格式校验仍生效
//   5) refresh_token 自动刷新 user_access_token
// ============================================================================

const assert = require('assert');

// ---------- mock fetch ----------
let feishuMailCalls = [];
let feishuMailBehavior = { status: 200, body: { code: 0, data: { message_id: 'om_mock_1' } } };
let oauthCalls = [];

async function mockFetch(url, opts) {
  if (url.includes('/auth/v3/tenant_access_token')) {
    return { status: 200, json: async () => ({ code: 0, tenant_access_token: 'mock-tenant-token', expire: 7200 }) };
  }
  if (url.includes('/bitable/v1/apps/')) {
    return { status: 200, json: async () => ({ code: 0, data: { record: { record_id: 'mock-rec-1' } } }) };
  }
  if (url.includes('accounts.feishu.cn/oauth/v3/token')) {
    oauthCalls.push({ url, opts });
    return {
      status: 200,
      json: async () => ({ code: 0, access_token: 'mock-user-token', expires_in: 7200, refresh_token: 'mock-refresh-2' }),
    };
  }
  if (url.includes('/mail/v1/user_mailboxes/')) {
    feishuMailCalls.push({ url, opts });
    const ok = feishuMailBehavior.status >= 200 && feishuMailBehavior.status < 300;
    return {
      status: feishuMailBehavior.status,
      ok,
      json: async () => feishuMailBehavior.body,
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
  feishuMailCalls = [];
  oauthCalls = [];
  feishuMailBehavior = { status: 200, body: { code: 0, data: { message_id: 'om_mock_1' } } };
  global.fetch = mockFetch; // 必须挂到全局，api/lead.js 用的是内置 fetch
}

// 首次设置全局 fetch
reset();

function loadHandler() {
  delete require.cache[require.resolve('../api/lead.js')];
  return require('../api/lead.js');
}

function setBaseEnv() {
  process.env.FEISHU_APP_ID = 'mock'; process.env.FEISHU_APP_SECRET = 'mock';
  process.env.FEISHU_APP_TOKEN = 'mock'; process.env.FEISHU_TABLE_ID = 'mock';
}

async function run() {
  // 用例 1：正常流程（配置了 FEISHU_MAIL_REFRESH_TOKEN）
  reset();
  setBaseEnv();
  process.env.FEISHU_MAIL_REFRESH_TOKEN = 'mock-refresh-1';
  delete process.env.FEISHU_MAIL_USER_ACCESS_TOKEN;
  delete process.env.FEISHU_MAIL_SENDER;
  const handler1 = loadHandler();
  const res1 = makeRes();
  await handler1(makeReq({ email: 'visitor@example.com', question: '会议纪要总是返工', source: 'selfcheck' }), res1);

  assert.strictEqual(res1.statusCode, 200, '用例1: 应返回 200');
  assert.strictEqual(res1.body.ok, true, '用例1: ok 应为 true');
  assert.strictEqual(res1.body.emailSent, true, '用例1: emailSent 应为 true');
  assert.strictEqual(oauthCalls.length, 1, '用例1: 应调用 1 次刷新 token');
  assert.strictEqual(feishuMailCalls.length, 1, '用例1: 应恰好调用 1 次飞书邮件');

  const url1 = feishuMailCalls[0].url;
  assert.ok(url1.includes('/mail/v1/user_mailboxes/me/messages/send'), '用例1: URL 应指向 me 的发送接口');
  const payload = JSON.parse(feishuMailCalls[0].opts.body);
  assert.strictEqual(payload.to.length, 1, '用例1: 应有 1 个收件人');
  assert.strictEqual(payload.to[0].mail_address, 'visitor@example.com', '用例1: 收件人应等于访客邮箱');
  assert.ok(payload.subject.includes('已到'), '用例1: 主题应包含「已到」');
  assert.strictEqual(payload.attachments.length, 3, '用例1: 应有 3 个附件');
  const pdf = payload.attachments.find((a) => a.filename.endsWith('.pdf'));
  assert.ok(pdf, '用例1: 应含 PDF 附件');
  assert.ok(pdf.body.length > 10000, '用例1: PDF base64url 应完整（>10KB 字符）');
  assert.ok(!pdf.body.includes('+') && !pdf.body.includes('/'), '用例1: PDF body 应为 base64url（无 +/）');
  assert.ok(!pdf.body.includes('='), '用例1: PDF body 应无尾部 =');
  assert.ok(payload.dedupe_key && payload.dedupe_key.startsWith('selfcheck-'), '用例1: 应带去重键');
  assert.ok(payload.body_plain_text.includes('凌：'), '用例1: 正文应含署名风格开头');
  assert.ok(payload.body_plain_text.includes('masterlinc.com'), '用例1: 正文应含网站');
  console.log('✅ 用例1 通过：飞书写入 + 飞书邮件成功，3 附件 base64url 完整，返回 ok');

  // 用例 2：飞书邮件失败（code!=0）→ 前端仍 ok，emailSent=false
  reset();
  setBaseEnv();
  process.env.FEISHU_MAIL_USER_ACCESS_TOKEN = 'mock-user-token';
  delete process.env.FEISHU_MAIL_REFRESH_TOKEN;
  feishuMailBehavior = { status: 200, body: { code: 99991663, msg: 'mock token invalid' } };
  const handler2 = loadHandler();
  const res2 = makeRes();
  await handler2(makeReq({ email: 'visitor2@example.com' }), res2);
  assert.strictEqual(res2.statusCode, 200, '用例2: 邮件失败不应影响前端，仍 200');
  assert.strictEqual(res2.body.ok, true, '用例2: ok 应为 true');
  assert.strictEqual(res2.body.emailSent, false, '用例2: emailSent 应为 false');
  assert.strictEqual(feishuMailCalls.length, 1, '用例2: 应尝试过 1 次飞书邮件');
  console.log('✅ 用例2 通过：飞书邮件失败被吞掉，线索不丢，前端仍 ok');

  // 用例 3：未配置发信令牌 → 跳过发送，前端 ok
  reset();
  setBaseEnv();
  delete process.env.FEISHU_MAIL_REFRESH_TOKEN;
  delete process.env.FEISHU_MAIL_USER_ACCESS_TOKEN;
  const handler3 = loadHandler();
  const res3 = makeRes();
  await handler3(makeReq({ email: 'visitor3@example.com' }), res3);
  assert.strictEqual(res3.statusCode, 200, '用例3: 应返回 200');
  assert.strictEqual(res3.body.ok, true, '用例3: ok 应为 true');
  assert.strictEqual(res3.body.emailSent, false, '用例3: emailSent 应为 false');
  assert.strictEqual(feishuMailCalls.length, 0, '用例3: 不应调用飞书邮件');
  console.log('✅ 用例3 通过：未配置令牌时跳过发送，不影响飞书线索');

  // 用例 4：邮箱格式校验仍生效
  reset();
  setBaseEnv();
  process.env.FEISHU_MAIL_REFRESH_TOKEN = 'mock-refresh-1';
  const handler4 = loadHandler();
  const res4 = makeRes();
  await handler4(makeReq({ email: 'not-an-email' }), res4);
  assert.strictEqual(res4.statusCode, 400, '用例4: 非法邮箱应返回 400');
  assert.strictEqual(res4.body.ok, false, '用例4: ok 应为 false');
  assert.strictEqual(feishuMailCalls.length, 0, '用例4: 不应触发邮件');
  console.log('✅ 用例4 通过：非法邮箱 400，不触发送信');

  // 用例 5：FEISHU_MAIL_SENDER 自定义发件邮箱
  reset();
  setBaseEnv();
  process.env.FEISHU_MAIL_REFRESH_TOKEN = 'mock-refresh-1';
  process.env.FEISHU_MAIL_SENDER = 'ling@dcnzcdpxknwp.feishu.cn';
  const handler5 = loadHandler();
  const res5 = makeRes();
  await handler5(makeReq({ email: 'visitor5@example.com' }), res5);
  assert.strictEqual(res5.body.ok, true, '用例5: ok 应为 true');
  assert.strictEqual(res5.body.emailSent, true, '用例5: emailSent 应为 true');
  const url5 = feishuMailCalls[0].url;
  assert.ok(url5.includes(encodeURIComponent('ling@dcnzcdpxknwp.feishu.cn')), '用例5: URL 应使用自定义发件邮箱');
  console.log('✅ 用例5 通过：自定义发件邮箱生效');

  console.log('\n🎉 全部 5 个用例通过');
}

run().catch((err) => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});
