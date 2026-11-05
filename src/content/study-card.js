/* Bilingual Reader — a selection action and a study card outside page layout. */
(function (root) {
  'use strict';

  var IMT = root.IMT;
  var GAP = 8, CARD_HEIGHT = 340;

  function elementOf(node) {
    return node && (node.nodeType === 1 ? node : node.parentElement);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(value, Math.max(min, max)));
  }

  function create(options) {
    var host, trigger, panel, title, status, content, retry, close;
    var anchor = null, pendingId = null;
    var dragging = false, frame = 0;
    var savedItems = null, syncSaved = null;

    function makeUI() {
      if (host) return;
      host = document.createElement('div');
      host.id = 'imtl-study';
      host.className = 'notranslate';
      host.setAttribute('translate', 'no');
      host.setAttribute('data-imtl-ui', 'study');
      host.style.cssText = 'all:initial!important;display:block!important;position:fixed!important;' +
        'top:0!important;left:0!important;width:0!important;height:0!important;' +
        'z-index:2147483646!important;pointer-events:none!important;';
      var shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<style>' +
        '*{box-sizing:border-box}[hidden]{display:none!important}' +
        'button{font:inherit;cursor:pointer}button:focus-visible{outline:2px solid #2788dc;outline-offset:2px}' +
        '.trigger,.panel{position:fixed;pointer-events:auto;direction:ltr;text-align:left;' +
        'font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color-scheme:light dark;' +
        'box-shadow:0 4px 18px #10223b30;margin:0}' +
        '.trigger,.retry{border:1px solid #145fa8;background:#1769b5;color:#fff;border-radius:8px;padding:4px 10px}' +
        '.trigger{white-space:nowrap}' +
        '.panel{width:min(350px,calc(100vw - 16px));padding:12px 14px;overflow:auto;overscroll-behavior:contain;' +
        'background:#fff;color:#223046;border:1px solid #d8e0ec;border-radius:12px;overflow-wrap:anywhere}' +
        'header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}' +
        '.close{border:0;background:transparent;color:inherit;border-radius:6px;font-size:18px;line-height:1;' +
        'width:26px;height:26px;padding:0}.close:hover{background:#8fa3bd30}' +
        'h3,p,ul{margin:0}h3{font-size:13px;margin-bottom:3px}.explanation,.status{color:#526179}' +
        '.source{font-weight:600}.detail,.phrases,.retry{margin-top:8px}ul{padding-left:19px}li+li{margin-top:4px}' +
        '@media(prefers-color-scheme:dark){.panel{background:#202936;color:#edf3fc;border-color:#3d4c61}' +
        '.explanation,.status{color:#c4d0e1}}' +
        IMT.studyView.css +
        '</style>' +
        '<button type="button" class="trigger" aria-controls="imtl-study-panel" aria-expanded="false" hidden>学这句</button>' +
        '<section class="panel" id="imtl-study-panel" role="dialog" aria-labelledby="imtl-study-heading" lang="zh-CN" hidden>' +
        '<header><strong id="imtl-study-heading">学这句</strong><button class="close" type="button" aria-label="关闭解析">×</button></header>' +
        '<p class="status" role="status"></p><div class="content" aria-live="polite"></div>' +
        '<button type="button" class="retry" hidden>重试</button></section>';
      trigger = shadow.querySelector('.trigger');
      panel = shadow.querySelector('.panel');
      title = shadow.querySelector('#imtl-study-heading');
      status = shadow.querySelector('.status');
      content = shadow.querySelector('.content');
      retry = shadow.querySelector('.retry');
      close = shadow.querySelector('.close');
      // Native mouse selection is normally cleared on mouse down on a button.
      trigger.addEventListener('mousedown', function (event) {
        if (event.button === 0) event.preventDefault();
      });
      trigger.addEventListener('click', function (event) {
        event.stopPropagation();
        request();
        if (!panel.hidden && event.detail === 0) close.focus({ preventScroll: true });
      });
      close.addEventListener('click', function (event) { event.stopPropagation(); dismiss(); });
      retry.addEventListener('click', function (event) {
        event.stopPropagation();
        close.focus({ preventScroll: true });
        request();
      });
    }

    function dismiss() {
      anchor = null;
      syncSaved = null;
      if (pendingId) {
        var id = pendingId;
        pendingId = null;
        try {
          chrome.runtime.sendMessage({ type: 'IMT_CANCEL_STUDY', requestId: id }, function () {
            void chrome.runtime.lastError;
          });
        } catch (e) { /* Extension may have reloaded. */ }
      }
      if (!host) return;
      panel.hidden = trigger.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      content.textContent = status.textContent = '';
      host.remove();
    }

    function isValid(candidate) {
      var mode = IMT.render.getMode();
      return candidate && (mode === 'dual' || mode === 'original') && candidate.origin.isConnected &&
        candidate.origin.contains(candidate.range.startContainer) && candidate.origin.contains(candidate.range.endContainer);
    }

    function selectedText() {
      var selection = root.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
      var range = selection.getRangeAt(0);
      var start = elementOf(range.startContainer), end = elementOf(range.endContainer);
      var origin = start && start.closest('.imtl-original');
      if (!origin || !end || !origin.contains(end) || start.isContentEditable || end.isContentEditable) return null;
      if (!origin.parentElement.matches('.imtl-block[data-imtl-state="translated"]')) return null;
      var raw = range.toString();
      var selected = selection.toString();
      var word = IMT.study.normalizeWord(selected);
      var text = word || IMT.study.normalizeSentence(selected);
      if (!text) return null;
      var context = null, nearby = null;
      if (word) {
        var prefix = document.createRange();
        prefix.selectNodeContents(origin);
        prefix.setEnd(range.startContainer, range.startOffset);
        var offset = prefix.toString().length + raw.indexOf(word);
        var source = origin.textContent;
        // A drag that stops inside a word should not turn a fragment into a new lookup.
        if (source.slice(offset, offset + word.length) !== word ||
          /[\p{Script=Latin}\p{M}]['’‐‑-]?$/u.test(source.slice(Math.max(0, offset - 3), offset)) ||
          /^['’‐‑-]?[\p{Script=Latin}\p{M}]/u.test(source.slice(offset + word.length, offset + word.length + 3))) return null;
        context = IMT.study.contextAt(source, offset, word);
        if (!context) {
          // The worker can still check nearby text for sensitive values without sending it to the model.
          var startOfWindow = Math.max(0, offset - 350);
          nearby = { text: source.slice(startOfWindow, offset + word.length + 350), offset: offset - startOfWindow };
        }
      }
      return { origin: origin, range: range.cloneRange(), raw: raw, text: text,
        kind: word ? 'word' : 'sentence', context: context, nearby: nearby };
    }

    function placement(area, rect, width, height) {
      var vw = root.innerWidth, vh = root.innerHeight;
      var left = clamp(rect.left, GAP, vw - width - GAP);
      var sideTop = clamp(rect.top, GAP, vh - height - GAP);
      var below = Math.max(GAP, area.bottom + GAP);
      var above = Math.min(vh - GAP, area.top - GAP);
      var places = [];
      if (area.right + width + 2 * GAP <= vw) places.push({ left: area.right + GAP, top: sideTop, room: vh - 2 * GAP });
      if (area.left - width >= 2 * GAP) places.push({ left: area.left - width - GAP, top: sideTop, room: vh - 2 * GAP });
      places.push({ left: left, top: below, room: vh - GAP - below });
      places.push({ left: left, bottom: above, room: above - GAP });
      return places;
    }

    function best(places, height, minHeight) {
      var fit = places.find(function (p) { return p.room >= height; });
      if (fit) return fit;
      var roomy = places.reduce(function (a, b) { return a.room >= b.room ? a : b; });
      return roomy.room >= minHeight ? roomy : null;
    }

    function layout() {
      if (!isValid(anchor)) { dismiss(); return; }
      var rect = anchor.range.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= root.innerHeight ||
        rect.right <= 0 || rect.left >= root.innerWidth) { dismiss(); return; }

      var area = rect;
      var translation = anchor.origin.parentElement.querySelector(':scope > .imtl-translation');
      if (translation && translation.getClientRects().length) {
        var range = document.createRange();
        range.selectNodeContents(translation);
        var tr = range.getBoundingClientRect();
        if (tr.width && tr.height) {
          area = { left: Math.min(rect.left, tr.left), top: Math.min(rect.top, tr.top),
            right: Math.max(rect.right, tr.right), bottom: Math.max(rect.bottom, tr.bottom) };
        }
      }

      var item = panel.hidden ? trigger : panel;
      var maxHeight = Math.min(CARD_HEIGHT, Math.max(1, root.innerHeight - 2 * GAP));
      if (item === panel) item.style.maxHeight = maxHeight + 'px';
      var width = item.offsetWidth, height = item.offsetHeight;
      // Try the space around the bilingual pair first. Keep the selected line visible
      // even if a long paragraph leaves too little space to avoid the entire translation.
      var minHeight = item === panel ? Math.min(height, 120) : height;
      var pos = best(placement(area, rect, width, height), height, minHeight) ||
        best(placement(rect, rect, width, height), height, minHeight);
      if (!pos) {
        pos = { left: clamp(rect.left, GAP, root.innerWidth - width - GAP),
          top: rect.top > root.innerHeight - rect.bottom ? GAP : root.innerHeight - height - GAP, room: maxHeight };
      }
      var shownHeight = Math.min(height, pos.room);
      if (item === panel) item.style.maxHeight = Math.min(maxHeight, pos.room) + 'px';
      item.style.left = pos.left + 'px';
      item.style.top = (pos.bottom === undefined ? pos.top : pos.bottom - shownHeight) + 'px';
    }

    function show(result, demo) {
      status.textContent = demo ? '演示模式 · 本地示例' : '';
      syncSaved = IMT.studyView.render(content, { kind: anchor.kind, text: anchor.text,
        context: anchor.context && anchor.context.sentence, analysis: result }, { onResize: layout });
      if (savedItems) syncSaved(savedItems);
      else IMT.studyCollection.read().then(function (items) {
        if (!savedItems) updateCollection(items);
      }).catch(function () { /* A later save can still retry local storage. */ });
    }

    function updateCollection(items) {
      savedItems = items;
      if (syncSaved) { syncSaved(items); layout(); }
    }

    function request() {
      if (pendingId) return;
      if (!isValid(anchor) || anchor.range.toString() !== anchor.raw) {
        dismiss(); return;
      }
      trigger.hidden = true;
      trigger.setAttribute('aria-expanded', 'true');
      panel.hidden = false;
      retry.hidden = true;
      content.textContent = '';
      var isWord = anchor.kind === 'word';
      title.textContent = isWord ? '查单词' : '学这句';
      status.textContent = isWord ? '正在查这个单词…' : '正在解析这句话…';
      panel.scrollTop = 0;
      layout();
      if (!anchor) return;

      var id = pendingId = IMT.utils.uid('study');
      function finish(response) {
        if (pendingId !== id) return;
        pendingId = null;
        if (response && response.ok && response.analysis) show(response.analysis, response.demo);
        else {
          status.textContent = (response && response.error) || '暂时无法解析，请重试。';
          retry.hidden = !!response && !response.retry;
        }
        layout();
      }
      try {
        var message = { type: isWord ? 'IMT_STUDY_WORD' : 'IMT_STUDY_SENTENCE',
          requestId: id, engineId: options.getEngineId() };
        if (isWord) {
          message.word = anchor.text;
          if (anchor.context) {
            message.sentence = anchor.context.sentence;
            message.offset = anchor.context.offset;
          } else if (anchor.nearby) {
            message.nearby = anchor.nearby.text;
            message.offset = anchor.nearby.offset;
          }
        } else message.sentence = anchor.text;
        chrome.runtime.sendMessage(message, function (response) {
          var error = chrome.runtime.lastError;
          finish(error ? null : response);
        });
      } catch (e) { finish(null); }
    }

    function refreshSelection() {
      if (dragging) return;
      if (anchor && !panel.hidden) {
        if (!isValid(anchor)) dismiss();
        return;
      }
      var next = selectedText();
      if (!isValid(next)) { dismiss(); return; }
      anchor = next;
      makeUI();
      if (!host.isConnected) document.documentElement.appendChild(host);
      trigger.textContent = next.kind === 'word' ? '查单词' : '学这句';
      trigger.hidden = false;
      layout();
    }

    function scheduleSelection() {
      if (frame) return;
      frame = root.requestAnimationFrame(function () {
        frame = 0;
        refreshSelection();
      });
    }
    function inside(event) { return host && (event.target === host || host.contains(event.target)); }
    document.addEventListener('pointerdown', function (event) {
      if (inside(event)) return;
      dragging = event.isPrimary && event.button === 0;
      if (anchor) dismiss();
    }, true);
    document.addEventListener('pointerup', function (event) {
      if (inside(event)) return;
      dragging = false;
      scheduleSelection();
    }, true);
    document.addEventListener('pointercancel', function () { dragging = false; }, true);
    document.addEventListener('selectionchange', scheduleSelection);
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || !anchor) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    }, true);
    var viewportFrame = 0;
    function updateViewport() {
      if (!anchor || viewportFrame) return;
      viewportFrame = root.requestAnimationFrame(function () {
        viewportFrame = 0;
        if (anchor) layout();
      });
    }
    root.addEventListener('resize', updateViewport);
    root.addEventListener('scroll', updateViewport, true);
    root.addEventListener('pagehide', dismiss);
    IMT.studyCollection.watch(updateCollection);
    return { dismiss: dismiss };
  }

  IMT.studyCard = { create: create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
