/* ============================================================
 * lib/track.js · MASTER LINC 埋点 SDK（匿名 · 轻量 · 静默）
 * ------------------------------------------------------------
 * 职责：
 *   1. 生成匿名设备 ID（uuid）+ 会话 ID（sid）
 *   2. 三级发送：sendBeacon → fetch → localStorage 队列兜底
 *   3. 失败静默，不干扰页面任何功能
 * 事件（POST /api/track）：
 *   page_view / skill_download / lead_submit / skill_pack_submit
 * 用法：
 *   window.track('page_view', { path: '/skills/' });
 *   window.track('skill_download', { skillId:'skill-01', skillName:'...', category:'会议', level:'★☆☆', fileType:'md', dlFrom:'card' });
 *   window.track('lead_submit', { hasEmail:true, source:'skill-pack' });
 *   window.track('skill_pack_submit', { source:'skill-pack' });
 * ============================================================ */
(function () {
  'use strict';
  if (window.__trackLoaded) return;
  window.__trackLoaded = true;

  var ENDPOINT = '/api/track';
  var QKEY = 'masterlinc_track_queue';   // 失败事件队列（上限 200 条）
  var UKEY = 'masterlinc_anon_id';       // 匿名设备 ID
  var SKEY = 'masterlinc_session_id';    // 会话 ID
  var OFFKEY = 'masterlinc_track_off';   // 用户关闭统计开关（=1 时不发）

  // ---------- 基础工具 ----------
  function uuid() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) {}
    try {
      var s = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
      return s;
    } catch (e) { return 'anon-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  }
  function storeGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function storeSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
  function storeDel(k) { try { window.localStorage.removeItem(k); } catch (e) {} }

  // ---------- 身份 ----------
  function getUid() {
    var uid = storeGet(UKEY);
    if (!uid) { uid = uuid(); storeSet(UKEY, uid); }
    return uid;
  }
  function getSid() {
    var sid = storeGet(SKEY);
    if (!sid) { sid = uuid(); storeSet(SKEY, sid); }
    return sid;
  }
  function isOff() { return storeGet(OFFKEY) === '1'; }

  // ---------- 发送 ----------
  // 三级：sendBeacon → fetch → queue。全部静默吞错。
  function sendEvents(list, done) {
    done = done || function () {};
    if (!list.length) return done();
    var body = JSON.stringify(list);
    // 1) sendBeacon（页面关闭前最可靠）
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(ENDPOINT, blob)) return done(true);
      }
    } catch (e) {}
    // 2) fetch keepalive（beacon 失败或不可用时）
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true
      }).then(function (r) {
        done(r && r.ok);
      }).catch(function () { done(false); });
      return;
    } catch (e) { done(false); }
  }

  function queuePush(list) {
    var q = [];
    try { q = JSON.parse(storeGet(QKEY) || '[]'); } catch (e) {}
    q = q.concat(list).slice(-200);
    storeSet(QKEY, JSON.stringify(q));
  }
  function queueFlush() {
    var q = [];
    try { q = JSON.parse(storeGet(QKEY) || '[]'); } catch (e) {}
    if (!q.length) return;
    sendEvents(q, function (ok) { if (ok) storeDel(QKEY); });
  }
  window.addEventListener('pagehide', queueFlush); // 离开页面时补发队列

  // ---------- 主入口 ----------
  function track(type, extra) {
    if (!type || isOff()) return;
    var ev = {
      ev: type,
      page: (window.location.pathname || '/').split('/').filter(Boolean)[0] || 'home',
      path: window.location.pathname + window.location.search,
      uid: getUid(),
      sid: getSid(),
      ref: document.referrer ? document.referrer.slice(0, 500) : '',
      extra: extra || {},
      t: Date.now(),
      v: 1
    };
    sendEvents([ev], function (ok) { if (!ok) queuePush([ev]); });
    queueFlush(); // 顺带补发历史队列
  }

  window.track = track;
  window.__track = { flush: queueFlush, uid: getUid, sid: getSid };

  // 页面浏览量自动上报（SPA 由页面自身再触发 path 变更为准，这里只上报首屏）
  try {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      track('page_view', { path: window.location.pathname + window.location.search });
    } else {
      window.addEventListener('DOMContentLoaded', function () {
        track('page_view', { path: window.location.pathname + window.location.search });
      });
    }
  } catch (e) {}
})();
