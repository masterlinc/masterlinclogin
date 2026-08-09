/* 申请/咨询按钮：点击展开微信二维码（移动端 mailto 失效兜底，v1.9.0）
   用法：<button type="button" class="hook-cta" data-hook-cta="ID" aria-expanded="false" aria-controls="PANEL_ID">按钮文案</button>
        <div class="hook-panel" id="PANEL_ID" hidden>二维码 + 邮箱兜底</div>
   也支持导航免费咨询按钮（button.nav-cta[data-hook-cta]）。
   点击同一按钮展开/收起；展开其它面板时自动收起当前已展开的面板。
   v1.30.0：咨询入口点击埋点 consult_click（免费漏斗 G1，对齐行为日志方案事件口径）：
     where = nav（导航）/ card（正文卡片/结果区），source = referrer；匿名 uid/sid 由 track SDK 自动带 */
(function () {
  function consultWhere(cta) {
    var cls = (cta && cta.className) || '';
    var ctrl = cta && cta.getAttribute('aria-controls') || '';
    if (/nav-cta/.test(cls)) return 'nav';
    if (/result|paybox|lead/.test(ctrl)) return 'result';
    if (/foot|contact|coach/.test(cls + ' ' + ctrl)) return 'footer';
    return 'card';
  }
  function fireConsultClick(cta) {
    try {
      if (!window.track) return;
      window.track('consult_click', { where: consultWhere(cta), source: (document.referrer || '').slice(0, 200) || 'direct' });
    } catch (e) { /* 埋点失败静默，不影响功能 */ }
  }
  function init() {
    var ctas = document.querySelectorAll('[data-hook-cta]');
    Array.prototype.forEach.call(ctas, function (cta) {
      var panel = document.getElementById(cta.getAttribute('aria-controls'));
      if (!panel) return;
      cta.addEventListener('click', function (e) {
        e.preventDefault();
        fireConsultClick(cta);
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
