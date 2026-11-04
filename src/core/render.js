/*!
 * Bilingual Reader — 译文渲染与回滚
 *
 * 渲染契约（与原产品保持同类结构）：
 *   <p>
 *     <font class="imtl-original">Original text</font>
 *     <font class="imtl-translation" notranslate>译文</font>
 *   </p>
 *
 * 之所以用 <font> 包裹原文，是为了让「仅显示译文 / 仅显示原文」
 * 两种模式可以通过 CSS 精确切换，而不影响表格、列表等布局。
 * 回滚时把 font 里的子节点搬回原位即可，DOM 完全还原。
 */
(function (root) {
  'use strict';

  var IMT = (root.IMT = root.IMT || {});
  var U = IMT.utils;

  var R = {};

  R.MODES = ['dual', 'translation', 'original'];

  /** 把纯文本转换为安全 HTML（保留换行） */
  R.toHtml = function (text) {
    return U.escapeHtml(text == null ? '' : text).replace(/\r?\n/g, '<br>');
  };

  /**
   * 在元素内插入译文。
   * @param {Element} el  原文元素
   * @param {string} text 译文
   * @param {object} opts {position:'after'|'before', wrapperTag, targetLang}
   * @returns {Element|null} 译文节点
   */
  R.insert = function (el, text, opts) {
    if (!el || !el.ownerDocument) return null;
    // 只有真正"已翻译"的块才走幂等分支；
    // pending 状态是待翻译标记，必须正常插入译文
    if (el.getAttribute('data-imtl-state') === 'translated') {
      var exist = el.querySelector(':scope > .imtl-translation');
      if (exist) {
        exist.innerHTML = R.toHtml(text);
      }
      return exist || null;
    }

    var o = opts || {};
    var tag = String(o.wrapperTag || 'font').toLowerCase();
    var doc = el.ownerDocument;

    // 1. 包裹原文
    var orig = doc.createElement(tag);
    orig.className = 'imtl-original';
    orig.setAttribute('notranslate', '');
    while (el.firstChild) orig.appendChild(el.firstChild);
    el.appendChild(orig);

    // 2. 构建译文
    var trans = doc.createElement(tag);
    trans.className = 'imtl-translation';
    trans.setAttribute('notranslate', '');
    trans.setAttribute('data-notranslate', '1');
    if (o.targetLang) trans.setAttribute('lang', o.targetLang);
    // 演示引擎的译文是本地拼的示例，标一下别让人误当成真实翻译
    if (o.demo) trans.setAttribute('data-imtl-demo', '1');
    trans.innerHTML = R.toHtml(text);

    // 3. 定位
    if (o.position === 'before') {
      el.insertBefore(trans, orig);
    } else {
      el.appendChild(trans);
    }

    el.classList.add('imtl-block');
    el.classList.remove('imtl-pending', 'imtl-error');
    el.removeAttribute('data-imtl-error');
    el.setAttribute('data-imtl-state', 'translated');
    return trans;
  };

  /** 标记为翻译中（显示 loading 占位） */
  R.markPending = function (el) {
    if (!el) return;
    el.classList.add('imtl-pending');
    el.setAttribute('data-imtl-state', 'pending');
  };

  R.clearPending = function (el) {
    if (!el) return;
    el.classList.remove('imtl-pending');
    if (el.getAttribute('data-imtl-state') === 'pending') {
      el.removeAttribute('data-imtl-state');
    }
  };

  /** 元素是否已翻译 */
  R.isTranslated = function (el) {
    return !!(el && el.getAttribute && el.getAttribute('data-imtl-state') === 'translated');
  };

  /**
   * 回滚：移除全部译文节点并还原原文结构。
   * @param {Document|Element} scope
   */
  R.restore = function (scope) {
    var root = scope || document;
    if (!root.querySelectorAll) return 0;

    var trans = root.querySelectorAll('.imtl-translation');
    var i;
    for (i = 0; i < trans.length; i++) {
      if (trans[i].parentNode) trans[i].parentNode.removeChild(trans[i]);
    }

    var origs = root.querySelectorAll('.imtl-original');
    for (i = 0; i < origs.length; i++) {
      var f = origs[i];
      var parent = f.parentNode;
      if (!parent) continue;
      while (f.firstChild) parent.insertBefore(f.firstChild, f);
      parent.removeChild(f);
    }

    var blocks = root.querySelectorAll('[data-imtl-state], [data-imtl-error]');
    for (i = 0; i < blocks.length; i++) {
      blocks[i].removeAttribute('data-imtl-state');
      blocks[i].removeAttribute('data-imtl-error');
      blocks[i].classList.remove('imtl-block', 'imtl-pending', 'imtl-error');
      // Chrome 的 classList.remove() 会留下空的 class="" 属性，
      // 这里显式清掉，保证回滚后 DOM 与翻译前逐字节一致
      if (!blocks[i].getAttribute('class')) {
        blocks[i].removeAttribute('class');
      }
    }

    return trans.length;
  };

  /**
   * 设置显示模式。通过 <html> 上的 class 控制，零 DOM 重写。
   * @param {string} mode 'dual' | 'translation' | 'original'
   */
  R.setMode = function (mode) {
    var html = document.documentElement;
    if (!html) return;
    R.MODES.forEach(function (m) {
      html.classList.remove('imtl-mode-' + m);
    });
    if (mode && mode !== 'none' && R.MODES.indexOf(mode) >= 0) {
      html.classList.add('imtl-mode-' + mode);
    }
    html.setAttribute('data-imtl-mode', mode || 'none');
  };

  /** 读取当前模式 */
  R.getMode = function () {
    var html = document.documentElement;
    if (!html) return 'none';
    return html.getAttribute('data-imtl-mode') || 'none';
  };

  /** 统计已翻译块数 */
  R.count = function (scope) {
    var root = scope || document;
    return root.querySelectorAll ? root.querySelectorAll('.imtl-translation').length : 0;
  };

  IMT.render = R;
})(typeof globalThis !== 'undefined' ? globalThis : this);
