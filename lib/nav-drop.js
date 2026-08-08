/* 产品下拉导航（v1.28.0 · 凌设视觉规范）
   用法：<div class="nav-drop" data-nav-drop>
          <button type="button" class="nav-drop-toggle" aria-haspopup="menu" aria-expanded="false" aria-controls="productsMenu">
            产品 <span class="caret" aria-hidden="true">▾</span>
          </button>
          <div class="nav-dropdown" id="productsMenu" role="menu">…</div>
        </div>
   交互：hover 进出（与 CSS :hover 双兜底）+ click 切换 + 外点/Escape/focusout 收起；
        移动端（≤900px）页面滚动时收起 fixed 浮层，避免「面板跟着滚出」的错位感。 */
(function () {
  function init() {
    var wraps = document.querySelectorAll('[data-nav-drop]');
    Array.prototype.forEach.call(wraps, function (wrap) {
      var toggle = wrap.querySelector('.nav-drop-toggle');
      var panel = wrap.querySelector('.nav-dropdown');
      if (!toggle || !panel) return;

      function set(open) {
        wrap.classList.toggle('open', open);
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      }

      // hover 仅桌面（>900px）生效：触屏合成 mouseenter 会与 click 切换冲突，移动端只用 click 展开
      var mq = window.matchMedia('(max-width: 900px)');
      function isMobile() { return mq.matches; }
      wrap.addEventListener('mouseenter', function () { if (!isMobile()) set(true); });
      wrap.addEventListener('mouseleave', function () { if (!isMobile()) set(false); });

      toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        set(!wrap.classList.contains('open'));
      });

      document.addEventListener('click', function (e) {
        if (!wrap.contains(e.target)) set(false);
      });

      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') set(false);
      });

      panel.addEventListener('focusout', function (e) {
        if (!panel.contains(e.relatedTarget)) set(false);
      });

      // 移动端：滚动即收起（fixed 浮层不随页面滚动）
      var onScroll = function () { if (isMobile()) set(false); };
      window.addEventListener('scroll', onScroll, { passive: true });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
