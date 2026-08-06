/**
 * 阶段一（轻量用户体系）本地验证脚本
 * 覆盖：设备码显示/复制、邮箱绑定（只存不验证）、plan 开关、解锁码人工解锁、
 *       pro 权益展示、个保法声明、375px 无横向溢出、现有功能不破坏（看板渲染）。
 * 运行：cd products/tests && node stage1-verify.js
 */
'use strict';
const { chromium } = require('playwright');
const { pathToFileURL } = require('url');
const path = require('path');

const APP_FILE = path.resolve(__dirname, '..', 'transition-os.html');
const APP_URL = 'http://localhost:8765/products/transition-os.html';
const LS_KEY = 'transition-os:v1';

let passed = 0, failed = 0;
function ok(name) { passed++; console.log('  ✅ ' + name); }
function bad(name, detail) { failed++; console.log('  ❌ ' + name + (detail ? ' :: ' + detail : '')); }

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push('console: ' + msg.text()); });

  // ---------- 1. 打开页面（375px） ----------
  await page.goto(APP_URL);
  await page.waitForTimeout(300);
  console.log('\n[1] 页面加载（375px）');
  ok('页面打开无致命错误');

  // 375px 无横向溢出
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  overflow ? bad('375px 无横向溢出', 'scrollWidth=' + (await page.evaluate(() => document.documentElement.scrollWidth)) + ' clientWidth=' + (await page.evaluate(() => document.documentElement.clientWidth))) : ok('375px 无横向溢出');

  // 顶部 plan 徽章（默认免费版）
  const badge = await page.textContent('#planBadge');
  badge && badge.indexOf('免费版') >= 0 ? ok('顶部显示免费版徽章') : bad('顶部免费版徽章', badge);

  // ---------- 2. 设置页：账号与身份 + Pro 区块 ----------
  console.log('\n[2] 设置页阶段一区块');
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForTimeout(300);

  const deviceId = await page.textContent('#deviceIdText').catch(() => '');
  deviceId && deviceId.length > 10 ? ok('显示设备码（db.user.id）' + deviceId.slice(0, 8)) : bad('设备码显示', deviceId);

  const emailInput = await page.$('#emailInput');
  emailInput ? ok('邮箱输入框存在') : bad('邮箱输入框存在');
  const privacy = await page.content();
  privacy.indexOf('个保法声明') >= 0 ? ok('个保法声明展示') : bad('个保法声明展示');

  const proUpgrade = await page.textContent('body');
  proUpgrade.indexOf('升级 Pro') >= 0 && proUpgrade.indexOf('¥99/月') >= 0 ? ok('Pro 区块（价格 ¥99/月）') : bad('Pro 区块', '找不到 升级 Pro / ¥99/月');
  proUpgrade.indexOf('pay-qr.png') >= 0 || proUpgrade.indexOf('/pay-qr.png') >= 0 ? ok('微信收款码引用') : bad('微信收款码引用');
  proUpgrade.indexOf('转型Pro+你的设备码') >= 0 ? ok('付款留言说明') : bad('付款留言说明');
  proUpgrade.indexOf('输入解锁码') >= 0 ? ok('解锁码输入入口') : bad('解锁码输入入口');

  // ---------- 3. 邮箱绑定（只存不验证） ----------
  console.log('\n[3] 邮箱绑定');
  await page.fill('#emailInput', 'test@example.com');
  await page.dispatchEvent('#emailInput', 'change');
  await page.waitForTimeout(200);
  let user = await page.evaluate(k => JSON.parse(localStorage.getItem(k)).user, LS_KEY);
  user.email === 'test@example.com' ? ok('绑定邮箱写入 db.user.email') : bad('邮箱写入', JSON.stringify(user.email));

  // 清除邮箱（删除权）
  await page.fill('#emailInput', '');
  await page.dispatchEvent('#emailInput', 'change');
  await page.waitForTimeout(200);
  user = await page.evaluate(k => JSON.parse(localStorage.getItem(k)).user, LS_KEY);
  user.email === '' ? ok('清空邮箱即删除（删除权）') : bad('邮箱删除', JSON.stringify(user.email));

  // ---------- 4. plan 开关 + 人工解锁 ----------
  console.log('\n[4] 人工解锁');
  user = await page.evaluate(k => JSON.parse(localStorage.getItem(k)).user, LS_KEY);
  user.plan === 'free' ? ok('默认 plan=free') : bad('默认 plan', user.plan);

  // 错误解锁码
  await page.fill('#proKeyInput', 'WRONG-KEY');
  await page.click('[data-action="unlock-pro"]');
  await page.waitForTimeout(200);
  user = await page.evaluate(k => JSON.parse(localStorage.getItem(k)).user, LS_KEY);
  user.plan === 'free' ? ok('无效解锁码不生效') : bad('无效解锁码', user.plan);

  // 正确解锁码
  await page.fill('#proKeyInput', 'PRO-2026-001');
  await page.click('[data-action="unlock-pro"]');
  await page.waitForTimeout(300);
  user = await page.evaluate(k => JSON.parse(localStorage.getItem(k)).user, LS_KEY);
  user.plan === 'pro' ? ok('PRO-2026-001 解锁成功 → plan=pro') : bad('解锁', user.plan);
  user.planNote && user.planNote.indexOf('PRO-2026-001') >= 0 ? ok('planNote 记录解锁码') : bad('planNote', user.planNote);

  const bodyAfter = await page.textContent('body');
  bodyAfter.indexOf('已解锁 Pro') >= 0 ? ok('Pro 卡片变为「已解锁 Pro」') : bad('已解锁状态展示');
  bodyAfter.indexOf('看板完整版') >= 0 && bodyAfter.indexOf('多设备同步') >= 0 && bodyAfter.indexOf('报告导出') >= 0 ? ok('Pro 权益文案展示') : bad('Pro 权益文案');
  const badge2 = await page.textContent('#planBadge');
  badge2 && badge2.indexOf('Pro') >= 0 ? ok('顶部徽章变为 Pro') : bad('顶部 Pro 徽章', badge2);

  // ---------- 5. 现有功能不破坏（看板渲染） ----------
  console.log('\n[5] 现有功能回归');
  await page.evaluate(() => { location.hash = '#/dashboard'; });
  await page.waitForTimeout(300);
  const dash = await page.textContent('#view-dashboard');
  dash && dash.indexOf('连续执行') >= 0 ? ok('看板页正常渲染') : bad('看板页渲染');
  await page.evaluate(() => { location.hash = '#/today'; });
  await page.waitForTimeout(200);
  const today = await page.textContent('#view-today');
  today && today.indexOf('晨间 4 问') >= 0 ? ok('今日页正常渲染') : bad('今日页渲染');

  // ---------- 6. JS 运行错误检查 ----------
  console.log('\n[6] 运行错误');
  errors.length === 0 ? ok('无 pageerror/console error') : bad('存在错误', errors.slice(0, 3).join(' | '));

  // ---------- 7. 恢复备份默认用户标识 = 设备码 ----------
  console.log('\n[7] 云端恢复默认用户标识');
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForTimeout(200);
  // 点击从云端恢复（不填口令直接检查默认值后再取消）
  await page.click('[data-action="cloud-restore"]');
  await page.waitForTimeout(200);
  const restoreUser = await page.inputValue('#restoreUser').catch(() => '');
  restoreUser === deviceId.trim() ? ok('恢复默认用户标识=设备码') : bad('恢复默认用户标识', restoreUser + ' vs ' + deviceId);
  await page.click('[data-action="modal-close"]').catch(() => {});

  await browser.close();
  console.log('\n====================');
  console.log('PASS: ' + passed + '  FAIL: ' + failed);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('SCRIPT ERROR:', e); process.exit(2); });
