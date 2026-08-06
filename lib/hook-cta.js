/* 申请/咨询按钮：点击展开微信二维码（移动端 mailto 失效兜底，v1.9.0）
   用法：<button type="button" class="hook-cta" data-hook-cta="ID" aria-expanded="false" aria-controls="PANEL_ID">按钮文案</button>
        <div class="hook-panel" id="PANEL_ID" hidden>二维码 + 邮箱兜底</div>
   也支持导航免费咨询按钮（button.nav-cta[data-hook-cta]）。
   点击同一按钮展开/收起；展开其它面板时自动收起当前已展开的面板。 */
(function () {
  function init() {
    var ctas = document.querySelectorAll('[data-hook-cta]');
    Array.prototype.forEach.call(ctas, function (cta) {
      var panel = document.getElementById(cta.getAttribute('aria-controls'));
      if (!panel) return;
      cta.addEventListener('click', function (e) {
        e.preventDefault();
        // 收起其它已展开面板
        var openPanels = document.querySelectorAll('.hook-panel:not([hidden])');
        Array.prototype.forEach.call(openPanels, function (op) {
          if (op === panel) return;
          op.hidden = true;
          var oc = document.querySelector('[aria-controls="' + op.id + '"]');
          if (oc) oc.setAttribute('aria-expanded', 'false');
        });
        var willShow = panel.hidden;
        panel.hidden = !willShow;
        cta.setAttribute('aria-expanded', willShow ? 'true' : 'false');
        if (willShow && panel.scrollIntoView) {
          panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
