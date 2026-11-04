/* Bilingual Reader — draggable page controls, isolated from the site's styles. */
(function (root) {
  'use strict';
  var IMT = root.IMT;
  var U = IMT.utils;
  var SIZE = 48, MARGIN = 8;

  IMT.floating = {
    create: function (options) {
      if (root.top !== root) return null;
      var opts = options || {}, state = {}, prefs = { enabled: true, position: null };
      var busy = false, destroyed = false, dragging = null, suppressClickUntil = 0, closeTimer;
      var point = { x: 0, y: 0 };
      var host = document.createElement('div');
      host.id = 'imtl-floating';
      host.className = 'notranslate';
      host.setAttribute('translate', 'no');
      host.setAttribute('data-imtl-ui', 'floating');
      // Inline !important protects the host itself; Shadow DOM protects its children.
      host.style.cssText = 'all:initial!important;position:fixed!important;display:block!important;' +
        'width:48px!important;height:48px!important;z-index:2147483647!important;' +
        'margin:0!important;padding:0!important;border:0!important;direction:ltr!important;' +
        'visibility:visible!important;opacity:1!important;pointer-events:auto!important;';
      var shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<style>' +
        ':host{color-scheme:light dark;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}' +
        '*{box-sizing:border-box}.panel,.trigger{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}' +
        'button{font:inherit;cursor:pointer;line-height:1.4}' +
        'button:focus-visible{outline:3px solid #61b7ff;outline-offset:3px}' +
        'button:disabled{cursor:not-allowed;opacity:.45}' +
        '.trigger{width:48px;height:48px;border:1px solid #ffffff66;border-radius:16px;' +
        'background:linear-gradient(145deg,#2588eb,#1558ba);color:#fff;box-shadow:0 4px 18px #163b7330;' +
        'font-size:22px;font-weight:650;display:grid;place-items:center;padding:0;touch-action:none;user-select:none;cursor:grab}' +
        '.trigger:active{cursor:grabbing}.trigger[data-paused="true"]{background:linear-gradient(145deg,#d79025,#a5640d)}' +
        '.trigger[data-working="true"]::after{content:"";position:absolute;right:2px;top:2px;' +
        'width:10px;height:10px;border-radius:50%;background:#69e6bb;border:2px solid #fff}' +
        '.panel{position:fixed;width:224px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;' +
        'padding:12px;border:1px solid #dde3eb;border-radius:16px;background:#fff;color:#243247;' +
        'box-shadow:0 8px 32px #12264826;text-align:left;direction:ltr;font-size:13px;line-height:1.5}' +
        '.panel[hidden]{display:none}.heading{font-size:12px;font-weight:650;display:flex;align-items:center;justify-content:space-between;gap:8px}' +
        '.hint{font-size:10px;color:#7b8797;font-weight:400}.status{margin:9px 0 10px;font-size:12px;color:#627188;overflow-wrap:anywhere}' +
        '.status.error{color:#be3342}.actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}' +
        '.actions button{border:1px solid #dce3ed;border-radius:8px;background:#f7f9fc;color:inherit;min-height:32px;padding:6px}' +
        '.actions button:hover:not(:disabled){border-color:#2588eb;background:#edf5ff}' +
        '.actions button.primary{background:#eaf3ff;border-color:#c5ddff;color:#165db7}' +
        '.actions button[hidden]{display:none}.actions button[hidden]+[data-action="stop"]{grid-column:1/-1}' +
        '.footer{display:flex;justify-content:space-between;gap:8px;margin-top:10px;padding-top:8px;border-top:1px solid #e8edf4}' +
        '.footer button{padding:3px 0;border:0;background:transparent;color:#627188;font-size:11px}' +
        '.footer button:hover{color:#146ac7}.footer .close:hover{color:#be3342}' +
        '@media(prefers-color-scheme:dark){.panel{background:#202936;color:#edf3fc;border-color:#39475c}' +
        '.status,.footer button{color:#b3c0d2}.hint{color:#94a4ba}.actions button{background:#2a3546;border-color:#44526a}' +
        '.actions button.primary{background:#203e62;color:#9fceff;border-color:#355c87}' +
        '.actions button:hover:not(:disabled){background:#304a6b}.footer{border-color:#39475c}.status.error{color:#ff9ba7}}' +
        '@media(prefers-reduced-motion:no-preference){.trigger{transition:box-shadow .15s}.trigger:hover{box-shadow:0 5px 22px #1558ba55}}' +
        '</style>' +
        '<button class="trigger" type="button" aria-controls="imtl-floating-panel" aria-expanded="false">译</button>' +
        '<section class="panel" id="imtl-floating-panel" aria-label="Bilingual Reader 翻译控制" hidden>' +
        '<div class="heading"><span>Bilingual Reader</span><span class="hint">拖动浮签摆放</span></div>' +
        '<p class="status" role="status">点击浮签翻译本页</p>' +
        '<div class="actions"><button type="button" class="primary" data-action="pause">暂停</button>' +
        '<button type="button" data-action="retranslate">重新翻译</button>' +
        '<button type="button" data-action="retry">重试失败段落</button>' +
        '<button type="button" data-action="stop">还原原文</button></div>' +
        '<div class="footer"><button type="button" data-action="settings">打开设置 ↗</button>' +
        '<button type="button" class="close" data-action="close" title="关闭所有网页浮签，可从扩展面板或设置重新开启">关闭浮签</button></div></section>';
      var trigger = shadow.querySelector('.trigger'), panel = shadow.querySelector('.panel');
      var status = shadow.querySelector('.status');
      function clamp(value, min, max) { return Math.max(min, Math.min(Math.max(min, max), value)); }
      function ranges() {
        return { x: Math.max(0, root.innerWidth - SIZE - 2 * MARGIN),
          y: Math.max(0, root.innerHeight - SIZE - 2 * MARGIN) };
      }
      function layoutPanel() {
        var width = Math.min(224, Math.max(0, root.innerWidth - 16));
        var left = point.x > root.innerWidth / 2 ? point.x - width - 8 : point.x + SIZE + 8;
        panel.style.left = clamp(left, MARGIN, root.innerWidth - width - MARGIN) + 'px';
        panel.style.top = clamp(point.y, MARGIN, root.innerHeight - panel.offsetHeight - MARGIN) + 'px';
      }
      function place(x, y) {
        var range = ranges();
        point.x = clamp(x, MARGIN, MARGIN + range.x);
        point.y = clamp(y, MARGIN, MARGIN + range.y);
        host.style.setProperty('left', point.x + 'px', 'important');
        host.style.setProperty('top', point.y + 'px', 'important');
        layoutPanel();
      }
      function layout() {
        var range = ranges(), p = prefs.position;
        place(p ? MARGIN + p.x * range.x : root.innerWidth - SIZE - 16,
          p ? MARGIN + p.y * range.y : MARGIN + range.y * .55);
      }
      function open(value) {
        clearTimeout(closeTimer);
        panel.hidden = !value;
        trigger.setAttribute('aria-expanded', value ? 'true' : 'false');
        if (value) layoutPanel();
      }
      function update(next) {
        state = next || {};
        var active = state.state === 'translated';
        trigger.textContent = state.paused ? '续' : active ? '原' : '译';
        var label = state.paused ? '继续翻译' : active ? '还原本页' : '翻译此页';
        trigger.setAttribute('aria-label', label + '；可拖动调整位置');
        trigger.title = label + ' · 悬停展开控制 · 拖动调整位置';
        trigger.setAttribute('aria-busy', String(busy));
        trigger.dataset.paused = String(!!state.paused);
        trigger.dataset.working = String(!state.paused && !!state.pending);
        var pause = shadow.querySelector('[data-action="pause"]');
        pause.textContent = state.paused ? '继续' : '暂停';
        pause.disabled = busy || !active || (!state.paused && !state.canPause);
        shadow.querySelector('[data-action="retranslate"]').disabled = busy;
        shadow.querySelector('[data-action="stop"]').disabled = busy || !active;
        var retry = shadow.querySelector('[data-action="retry"]');
        retry.hidden = !state.failed;
        retry.disabled = busy || !!state.paused || !!state.pending;
        status.classList.toggle('error', !!state.error);
        status.textContent = state.error || (active
          ? '已译 ' + (state.done || 0) + ' 段' + (state.paused ? ' · 已暂停' : state.pending ? ' · 翻译中…' : '')
          : '点击浮签翻译本页');
        layoutPanel();
      }
      function showError(err) {
        status.textContent = String((err && err.message) || err || '操作失败');
        status.classList.add('error'); open(true);
      }
      function act(action) {
        if (busy) return;
        busy = true; update(state);
        Promise.resolve().then(function () { return opts.onAction(action); }).then(function (result) {
          busy = false;
          if (destroyed) return;
          if (!result || !result.ok) {
            update(state); showError(result && result.error);
            if (result && result.needConfig && opts.onSettings) Promise.resolve().then(opts.onSettings).catch(showError);
          } else update(result);
        }, function (err) { busy = false; if (!destroyed) { update(state); showError(err); } });
      }
      function applyPrefs(patch) {
        if (destroyed) return;
        prefs = Object.assign({}, prefs, patch);
        if (prefs.enabled) {
          if (!host.isConnected) document.documentElement.appendChild(host);
          if (!dragging) layout();
        } else { open(false); host.remove(); }
      }
      host.addEventListener('pointerenter', function () { if (!dragging) open(true); });
      host.addEventListener('pointerleave', function () { closeTimer = setTimeout(function () {
        if (!shadow.activeElement) open(false);
      }, 180); });
      host.addEventListener('focusin', function () { open(true); });
      host.addEventListener('focusout', function () { setTimeout(function () {
        if (!shadow.activeElement && !host.matches(':hover')) open(false);
      }, 0); });
      host.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') { trigger.focus(); open(false); event.stopPropagation(); }
      });
      trigger.addEventListener('click', function (event) {
        if (Date.now() < suppressClickUntil && event.detail) { event.preventDefault(); return; }
        act(state.paused ? 'resume' : state.state === 'translated' ? 'stop' : 'start');
      });
      trigger.addEventListener('pointerdown', function (event) {
        if (event.button !== 0 || busy) return;
        dragging = { id: event.pointerId, x: event.clientX, y: event.clientY, left: point.x, top: point.y, moved: false };
        trigger.setPointerCapture(event.pointerId);
        event.stopPropagation();
      });
      trigger.addEventListener('pointermove', function () { if (!dragging) open(true); });
      function moveDrag(event) {
        if (!dragging) return;
        if (dragging.id !== event.pointerId) return;
        var dx = event.clientX - dragging.x, dy = event.clientY - dragging.y;
        if (Math.abs(dx) + Math.abs(dy) > 6) dragging.moved = true;
        if (dragging.moved) { open(false); place(dragging.left + dx, dragging.top + dy); }
        event.stopPropagation();
      }
      function endDrag(event) {
        if (!dragging || dragging.id !== event.pointerId) return;
        var moved = dragging.moved;
        dragging = null;
        if (trigger.hasPointerCapture(event.pointerId)) trigger.releasePointerCapture(event.pointerId);
        if (moved) {
          suppressClickUntil = Date.now() + 400;
          var range = ranges();
          prefs.position = { x: range.x ? (point.x - MARGIN) / range.x : 0,
            y: range.y ? (point.y - MARGIN) / range.y : 0 };
          U.floatingPrefs.write({ position: prefs.position }).catch(showError);
        }
        event.stopPropagation();
      }
      // Document capture also handles a pointer leaving the button or browser
      // retargeting an event while the original paragraph DOM is being updated.
      document.addEventListener('pointermove', moveDrag, true);
      document.addEventListener('pointerup', endDrag, true);
      document.addEventListener('pointercancel', endDrag, true);
      panel.addEventListener('click', function (event) {
        var button = event.target.closest('button[data-action]');
        if (!button || button.disabled) return;
        event.stopPropagation();
        var action = button.dataset.action;
        if (action === 'settings') {
          Promise.resolve().then(opts.onSettings).catch(showError);
        } else if (action === 'close') {
          applyPrefs({ enabled: false });
          U.floatingPrefs.write({ enabled: false }).catch(function (err) { applyPrefs({ enabled: true }); showError(err); });
        } else act(action === 'pause' && state.paused ? 'resume' : action);
      });
      root.addEventListener('resize', layout);
      var unwatch = U.floatingPrefs.watch(applyPrefs);
      update({});
      var ready = U.floatingPrefs.read().then(applyPrefs);
      return {
        ready: ready,
        update: update,
        destroy: function () {
          destroyed = true; clearTimeout(closeTimer); unwatch();
          document.removeEventListener('pointermove', moveDrag, true);
          document.removeEventListener('pointerup', endDrag, true);
          document.removeEventListener('pointercancel', endDrag, true);
          root.removeEventListener('resize', layout); host.remove();
        }
      };
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
