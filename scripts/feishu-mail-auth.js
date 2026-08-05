#!/usr/bin/env node
// ============================================================================
// scripts/feishu-mail-auth.js — 获取飞书发信用的 user_access_token / refresh_token
//
// 为什么需要它？
//   飞书「发送邮件」API（POST /mail/v1/user_mailboxes/:id/messages/send）
//   要求使用 user_access_token（用户身份），且应用需先开通权限：
//     mail:user_mailbox.message:send（发送用户邮件）
//   并携带 offline_access（持续刷新，本应用已开通）。
//
// 使用步骤：
//   1. 先在飞书开发者后台为应用开通权限「发送用户邮件」(mail:user_mailbox.message:send)：
//      https://open.feishu.cn/app/cli_aac5da640c389cdc/auth
//      （搜索 "发送用户邮件"，开通并发布应用版本）
//   2. 运行本脚本：
//      node scripts/feishu-mail-auth.js
//   3. 脚本会打印一个授权链接，用浏览器打开，在飞书里确认授权
//   4. 授权成功后脚本在本机起一个临时回调服务接收 code，自动换取 token
//   5. 把输出的 FEISHU_MAIL_REFRESH_TOKEN 配置到 Vercel 环境变量即可
//
// 注意：
//   - refresh_token 有效期内（默认 30 天，可续期）服务端会用它自动刷新 user token
//   - 脚本不把 token 写入任何文件，只打印到终端
// ============================================================================

const http = require('http');

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const REDIRECT_PORT = 8888;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const SCOPE = 'mail:user_mailbox.message:send offline_access';
const STATE = 'lingke-mail-auth';

if (!APP_ID || !APP_SECRET) {
  console.error('❌ 请先设置环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET（可从 .env.local 读取：source .env.local）');
  process.exit(1);
}

const authUrl =
  'https://accounts.feishu.cn/open-apis/authen/v1/authorize' +
  `?client_id=${encodeURIComponent(APP_ID)}` +
  `&response_type=code` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=${encodeURIComponent(SCOPE)}` +
  `&state=${STATE}` +
  `&prompt=consent`;

console.log('\n==================================================');
console.log('1️⃣  请先在开发者后台开通权限（如果还没开通）：');
console.log('   https://open.feishu.cn/app/' + APP_ID + '/auth');
console.log('   搜索「发送用户邮件」→ 开通 → 创建版本并发布');
console.log('   （配置重定向地址：开发配置 → 安全设置 → 重定向 URL 添加）');
console.log('   http://localhost:8888/callback');
console.log('==================================================\n');

console.log('2️⃣  用浏览器打开以下授权链接，并在飞书中确认授权：\n');
console.log(authUrl);
console.log('\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== '/callback') {
    res.writeHead(404); res.end('not found'); return;
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`授权失败：${error}\n请关闭窗口`);
    console.error('❌ 授权失败:', error);
    server.close(); process.exit(1); return;
  }
  if (state !== STATE) {
    res.writeHead(400); res.end('state 不匹配'); server.close(); process.exit(1); return;
  }
  if (!code) {
    res.writeHead(400); res.end('缺少 code'); server.close(); process.exit(1); return;
  }

  try {
    const resp = await fetch('https://accounts.feishu.cn/oauth/v3/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: APP_ID,
        client_secret: APP_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const data = await resp.json();
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    if (data.code !== 0 || !data.access_token) {
      res.end('换取 token 失败：' + (data.msg || 'HTTP ' + resp.status) + '\n请关闭窗口');
      console.error('❌ 换取 token 失败:', JSON.stringify(data));
      server.close(); process.exit(1); return;
    }
    res.end('✅ 授权成功！Token 已打印在终端，可以关闭窗口。');

    console.log('\n==================================================');
    console.log('✅ 授权成功！以下是需要配置到 Vercel 环境变量的值：');
    console.log('--------------------------------------------------');
    console.log('FEISHU_MAIL_REFRESH_TOKEN=' + data.refresh_token);
    console.log('FEISHU_MAIL_USER_ACCESS_TOKEN=' + data.access_token);
    console.log('--------------------------------------------------');
    console.log('建议：只配置 FEISHU_MAIL_REFRESH_TOKEN（长期有效，服务端自动刷新）。');
    console.log('配置后到 Vercel → Project → Settings → Environment Variables 添加即可。');
    console.log('==================================================\n');
    server.close();
    process.exit(0);
  } catch (e) {
    console.error('❌ 网络错误:', e.message);
    res.writeHead(500); res.end('网络错误'); server.close(); process.exit(1);
  }
});

server.listen(REDIRECT_PORT, () => {
  console.log(`3️⃣  等待授权回调（本机临时服务已启动 :${REDIRECT_PORT}）...\n`);
});
