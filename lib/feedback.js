/* ============================================================
 * lib/feedback.js · MASTER LINC 用户反馈弹层（轻量 · 自包含 · 全站共用）
 * ------------------------------------------------------------
 * 职责：
 *   1. 全站页脚 / 驾驶舱设置页「关于」区的「反馈」入口 → 打开统一弹层
 *   2. 表单：类型（4 项）+ 一句话描述（10~500 字）+ 邮箱（选填）
 *   3. 提交 POST /api/feedback（服务端校验 + 防刷 + 写入飞书 user_feedback 表）
 *   4. 本地 60 秒防刷（localStorage 时间戳，方案 2.4 第 1 条）
 *   5. 成功 → 暖心文案 + 埋点 feedback_submit（若 track SDK 已加载）
 *
 * 用法（任意页面）：
 *   <a href="#" data-feedback data-version="v1.22.0">反馈</a>
 *   <!-- 打开时自动带版本号（可选）与来源页 -->
 *   <script src="/lib/feedback.js" defer onerror="this.remove()"></script>
 * 也可用 JS 打开：window.Feedback.open({ version: 'v1.22.0' })
 *
 * 个保法：邮箱仅用于回访，表单注明用途；匿名提交不降级。
 * 样式自包含（深色体系），与站点 / transition-os 风格一致。
 * ============================================================ */
(function () {
  'use strict';
  if (window.__feedbackLoaded) return;
  window.__feedbackLoaded = true;

  var ENDPOINT = '/api/feedback';
  var FBKEY = 'masterlinc_feedback_last'; // 本地 60 秒防刷时间戳
  var UKEY = 'masterlinc_anon_id';        // 与 track SDK 同一匿名设备 ID
  var RATE_MS = 60 * 1000;

  var TYPES = ['用得不顺', '有 bug', '想要新功能', '其他'];
  var PAGE = location.pathname;

  // ---------- 工具 ----------
  function storeGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function storeSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uuid() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) {}
    try {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    } catch (e) { return 'anon-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  }
  // 匿名设备 ID：优先复用 track SDK 的 uid；没有则生成（前 8 位提交服务端）
  function getDeviceId() {
    var uid = storeGet(UKEY);
    if (!uid) { uid = uuid(); storeSet(UKEY, uid); }
    return uid;
  }

  // ---------- 样式（自包含，深色体系） ----------
  var STYLE_ID = 'ml-feedback-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '#ml-feedback-mask{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.66);display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);}',
      '#ml-feedback-box{width:min(520px,100%);max-height:88vh;overflow:auto;background:#0d0d0c;border:1px solid rgba(244,243,239,.22);border-radius:18px;padding:26px 24px 22px;color:#f4f3ef;font-family:Inter,"SF Pro Display","Helvetica Neue","PingFang SC","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif;line-height:1.6;box-shadow:0 24px 60px rgba(0,0,0,.5);}',
      '#ml-feedback-box h3{margin:0 0 4px;font-size:19px;font-weight:750;letter-spacing:-.01em;}',
      '#ml-feedback-box .ml-fb-sub{color:#a8a8a5;font-size:13.5px;margin:0 0 18px;}',
      '#ml-feedback-box label{display:block;font-size:12.5px;color:#a8a8a5;margin:0 0 6px;}',
      '#ml-feedback-box .ml-fb-types{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px;}',
      '#ml-feedback-box .ml-fb-type{border:1px solid rgba(244,243,239,.2);background:transparent;color:#f4f3ef;border-radius:999px;padding:7px 14px;font-size:13.5px;cursor:pointer;transition:all 140ms ease;-webkit-tap-highlight-color:transparent;}',
      '#ml-feedback-box .ml-fb-type.sel{background:#f4f3ef;color:#050505;border-color:#f4f3ef;font-weight:650;}',
      '#ml-feedback-box textarea,#ml-feedback-box input{width:100%;box-sizing:border-box;background:#050505;border:1px solid rgba(244,243,239,.2);border-radius:10px;color:#f4f3ef;font:inherit;font-size:15px;padding:12px 13px;outline:none;resize:vertical;}',
      '#ml-feedback-box textarea:focus,#ml-feedback-box input:focus{border-color:#f4f3ef;}',
      '#ml-feedback-box textarea::placeholder,#ml-feedback-box input::placeholder{color:#6f6f6c;}',
      '#ml-feedback-box .ml-fb-guide{font-size:12px;color:#6f6f6c;margin-top:6px;}',
      '#ml-feedback-box .ml-fb-email{margin:14px 0 4px;}',
      '#ml-feedback-box .ml-fb-priv{font-size:11.5px;color:#8a8a85;margin:4px 0 16px;}',
      '#ml-feedback-box .ml-fb-err{color:#ff9d8a;font-size:13px;min-height:18px;margin:2px 0 10px;}',
      '#ml-feedback-box .ml-fb-actions{display:flex;justify-content:flex-end;gap:10px;align-items:center;}',
      '#ml-feedback-box .ml-fb-close{background:transparent;color:#a8a8a5;border:1px solid rgba(244,243,239,.2);border-radius:10px;padding:11px 18px;font-size:14px;cursor:pointer;transition:all 140ms ease;}',
      '#ml-feedback-box .ml-fb-close:hover{color:#f4f3ef;border-color:rgba(244,243,239,.4);}',
      '#ml-feedback-box .ml-fb-submit{background:#f4f3ef;color:#050505;border:none;border-radius:10px;padding:12px 22px;font-size:14.5px;font-weight:700;cursor:pointer;transition:opacity 140ms ease;}',
      '#ml-feedback-box .ml-fb-submit:disabled{opacity:.45;cursor:not-allowed;}',
      '#ml-feedback-box .ml-fb-done{text-align:center;padding:26px 8px 18px;}',
      '#ml-feedback-box .ml-fb-done .ml-fb-done-icon{font-size:30px;margin-bottom:8px;}',
      '#ml-feedback-box .ml-fb-done .ml-fb-done-title{font-size:17px;font-weight:700;margin-bottom:8px;}',
      '#ml-feedback-box .ml-fb-done .ml-fb-done-msg{color:#a8a8a5;font-size:14px;line-height:1.7;}',
      '@media (max-width:480px){#ml-feedback-box{padding:22px 18px 18px;}#ml-feedback-box .ml-fb-types{flex-wrap:wrap;}#ml-feedback-box .ml-fb-type{flex:1 1 40%;text-align:center;}}'
    ].join('\n');
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ---------- 弹层状态 ----------
  var el = null; // { mask, box, ... }

  function bodyLock(on) {
    try { document.body.style.overflow = on ? 'hidden' : ''; } catch (e) {}
  }

  function close() {
    if (!el) return;
    el.mask.remove();
    el = null;
    bodyLock(false);
    document.removeEventListener('keydown', onKey, true);
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }

  function open(opts) {
    opts = opts || {};
    if (el) close();
    ensureStyle();

    var mask = document.createElement('div');
    mask.id = 'ml-feedback-mask';
    mask.innerHTML =
      '<div id="ml-feedback-box" role="dialog" aria-modal="true" aria-label="用户反馈">' +
        '<h3>说说你的感受</h3>' +
        '<p class="ml-fb-sub">你用得顺，我才睡得着。说真话就行，不用客气。</p>' +
        '<label>这次是什么情况？</label>' +
        '<div class="ml-fb-types" role="radiogroup" aria-label="反馈类型">' +
          TYPES.map(function (t, i) {
            return '<button type="button" class="ml-fb-type' + (i === 0 ? ' sel' : '') + '" data-type="' + esc(t) + '" role="radio" aria-checked="' + (i === 0 ? 'true' : 'false') + '">' + esc(t) + '</button>';
          }).join('') +
        '</div>' +
        '<label for="ml-fb-content">说说哪里不痛快（10~500 字）</label>' +
        '<textarea id="ml-fb-content" rows="4" placeholder="在哪一页？想做什么？卡在哪？能说多具体就多具体。" maxlength="500"></textarea>' +
        '<div class="ml-fb-guide">在哪一页？想做什么？卡在哪？能说多具体就多具体。</div>' +
        '<div class="ml-fb-email"><label for="ml-fb-email">邮箱（选填）</label>' +
        '<input id="ml-fb-email" type="email" inputmode="email" autocomplete="email" placeholder="改好了我回你一声" /></div>' +
        '<div class="ml-fb-priv">留下邮箱，改好了我回你一声；不填就匿名提交，反馈同样有效。邮箱仅用于回访，不用于营销。</div>' +
        '<div class="ml-fb-err" id="ml-fb-err"></div>' +
        '<div class="ml-fb-actions">' +
          '<button type="button" class="ml-fb-close" id="ml-fb-cancel">先不了</button>' +
          '<button type="button" class="ml-fb-submit" id="ml-fb-submit">提给凌策 →</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(mask);
    el = {
      mask: mask,
      box: mask.querySelector('#ml-feedback-box'),
      types: mask.querySelector('.ml-fb-types'),
      content: mask.querySelector('#ml-fb-content'),
      email: mask.querySelector('#ml-fb-email'),
      err: mask.querySelector('#ml-fb-err'),
      submit: mask.querySelector('#ml-fb-submit'),
      version: opts.version || '',
    };
    bodyLock(true);
    document.addEventListener('keydown', onKey, true);

    // 遮罩点击关闭（点内容不关）
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    mask.querySelector('#ml-fb-cancel').addEventListener('click', close);

    // 类型选择
    el.types.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.ml-fb-type') : null;
      if (!btn) return;
      Array.prototype.forEach.call(el.types.querySelectorAll('.ml-fb-type'), function (b) {
        b.classList.toggle('sel', b === btn);
        b.setAttribute('aria-checked', b === btn ? 'true' : 'false');
      });
    });

    // 提交
    el.submit.addEventListener('click', submit);

    setTimeout(function () { try { el.content.focus(); } catch (e) {} }, 60);
  }

  // 本地 60 秒防刷（与服务端 IP 维度互为兜底）
  function localRateOk() {
    try {
      var last = parseInt(storeGet(FBKEY) || '0', 10);
      if (last && Date.now() - last < RATE_MS) {
        return { ok: false, retry: Math.ceil((RATE_MS - (Date.now() - last)) / 1000) };
      }
    } catch (e) {}
    return { ok: true };
  }

  function setErr(msg) { el.err.textContent = msg || ''; }

  function submit() {
    if (!el || el.submit.disabled) return;
    var type = '';
    Array.prototype.forEach.call(el.types.querySelectorAll('.ml-fb-type'), function (b) {
      if (b.classList.contains('sel')) type = b.getAttribute('data-type');
    });
    var content = el.content.value.trim();
    var email = el.email.value.trim();

    // 本地校验
    if (!type) { setErr('先选一个类型吧'); return; }
    if (content.length < 10) { setErr('再说具体一点，我才能改对（至少 10 个字）'); return; }
    if (content.length > 500) { setErr('太长了，精简到 500 字以内吧'); return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setErr('邮箱格式不对（也可以不填）'); return; }
    var rate = localRateOk();
    if (!rate.ok) { setErr('你刚刚提交过了，等 ' + rate.retry + ' 秒再试 🙏'); return; }
    setErr('');

    el.submit.disabled = true;
    el.submit.textContent = '正在提交…';

    var payload = {
      type: type,
      content: content,
      email: email || '',
      meta: {
        version: el.version || '',
        page: PAGE,
        deviceId: getDeviceId(),
      },
    };

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data && data.message ? data.message : '提交失败，请稍后重试');
          err.rate = res.status === 429;
          throw err;
        }
        return data;
      });
    }).then(function (data) {
      // 本地防刷时间戳（仅成功后记录）
      storeSet(FBKEY, String(Date.now()));
      // 埋点：feedback_submit（若 track SDK 已加载，静默失败不影响）
      try {
        if (window.track) window.track('feedback_submit', { path: PAGE, type: type, ok: true });
      } catch (e) {}
      showDone(type);
    }).catch(function (err) {
      el.submit.disabled = false;
      el.submit.textContent = '提给凌策 →';
      setErr(err.message || '网络异常，请稍后重试');
    });
  }

  function showDone() {
    el.box.innerHTML =
      '<div class="ml-fb-done">' +
        '<div class="ml-fb-done-icon">🙏</div>' +
        '<div class="ml-fb-done-title">收到！</div>' +
        '<div class="ml-fb-done-msg">这条反馈已经进我的改进清单。谢谢你不嫌麻烦说出来。你说的问题，我会认真改。</div>' +
        '<div style="margin-top:20px;"><button type="button" class="ml-fb-close" id="ml-fb-done-close" style="display:inline-block;">好的</button></div>' +
      '</div>';
    el.box.querySelector('#ml-fb-done-close').addEventListener('click', close);
    el.err = null; el.submit = null;
  }

  // ---------- 全局入口 ----------
  window.Feedback = { open: open, close: close };
  window.__feedback = { open: open, close: close };

  // 事件委托：任意 `[data-feedback]` 元素点击 → 打开弹层（支持 data-version）
  document.addEventListener('click', function (e) {
    var trigger = e.target && e.target.closest ? e.target.closest('[data-feedback]') : null;
    if (!trigger) return;
    e.preventDefault();
    open({ version: trigger.getAttribute('data-version') || '' });
  });
})();
