/*!
 * Bilingual Reader — DOM 分段与正文识别
 *
 * 核心思想：把「叶子块级元素」当作翻译单元。
 *   叶子块 = 自身不含块级子元素的块级元素。
 * 这样 <div><p>a</p><p>b</p></div> 中的 div 是容器（跳过），
 * 而两个 p 分别是翻译单元 —— 天然得到段落级对照。
 *
 * 正文识别分两级：
 *   ① 站点框架（导航 / 侧栏 / 页脚 / 面包屑…）→ 整棵子树排除
 *   ② 链接密集容器（目录 / 标签云…）        → 只排除其中的「链接型」块
 *
 * 第②条刻意不排除整个容器：像 Wikipedia 的页头那样，
 * 同一个容器里既有语言菜单（该排除）也有文章标题（该翻译）。
 */
(function (root) {
  'use strict';

  var IMT = (root.IMT = root.IMT || {});
  var U = IMT.utils;

  var BLOCK = {};
  IMT.BLOCK_TAGS.forEach(function (t) { BLOCK[t] = true; });

  var EXCLUDE = {};
  IMT.EXCLUDE_TAGS.forEach(function (t) { EXCLUDE[t] = true; });

  var STAY = {};
  IMT.STAY_ORIGINAL_TAGS.forEach(function (t) { STAY[t] = true; });

  /** 需要保护原文、但不阻断整棵子树的技术片段 */
  var PROTECTED_INLINE = {
    CODE: true, KBD: true, SAMP: true, VAR: true, TT: true
  };

  var S = {};

  /* ------------------------------------------------------------------ *
   * 文本收集
   * ------------------------------------------------------------------ */

  /**
   * 收集元素的「自有文本」：跳过嵌套的块级子元素，
   * 并把技术片段（code/kbd…）替换成占位符保护起来。
   *
   * @returns {{text: string, parts: Array<{placeholder:string, original:string}>}}
   */
  S.ownText = function (el) {
    var state = { text: '', counter: 0, parts: [] };
    collect(el, state, true);
    return { text: state.text.replace(/\s+/g, ' ').trim(), parts: state.parts };
  };

  function collect(node, state, isRoot) {
    var child = node.firstChild;
    while (child) {
      var next = child.nextSibling;
      if (child.nodeType === 3) {
        state.text += child.nodeValue;
      } else if (child.nodeType === 1) {
        var tag = child.tagName.toUpperCase();
        if (!isRoot && BLOCK[tag]) {
          // 嵌套块级：它的文本属于它自己，不并入父块
        } else if (PROTECTED_INLINE[tag]) {
          var ph = '__SEG_' + (state.counter++) + '__';
          state.parts.push({ placeholder: ph, original: child.textContent || '' });
          state.text += ph;
        } else {
          collect(child, state, false);
        }
      }
      child = next;
    }
  }

  /* ------------------------------------------------------------------ *
   * 过滤条件
   * ------------------------------------------------------------------ */

  /** 元素是否应当被完全跳过 */
  S.shouldSkip = function (el) {
    var tag = el.tagName && el.tagName.toUpperCase();
    if (!tag) return true;
    if (EXCLUDE[tag]) return true;
    if (STAY[tag]) return true;
    if (el.getAttribute && el.getAttribute('translate') === 'no') return true;
    if (el.closest && el.closest('[translate="no"]')) return true;
    if (el.classList && el.classList.contains('notranslate')) return true;
    if (el.classList && el.classList.contains('imtl-original')) return true;
    if (el.classList && el.classList.contains('imtl-translation')) return true;
    if (el.getAttribute && el.getAttribute('data-imtl-state')) return true;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
    if (el.hasAttribute && el.hasAttribute('hidden')) return true;
    return false;
  };

  /** 元素是否在视口/布局中可见 */
  S.isVisible = function (el) {
    if (el.checkVisibility) {
      try {
        return !!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true, contentVisibilityAuto: true });
      } catch (e) {
        /* 老版本 Chrome 走下面的兜底 */
      }
    }
    var rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) return false;
    var style = window.getComputedStyle(el);
    if (!style) return true;
    return style.visibility !== 'hidden' && style.display !== 'none';
  };

  /* ------------------------------------------------------------------ *
   * 站点框架识别（第一级：结构性证据）
   * ------------------------------------------------------------------ */

  /** 语义地标：这些标签本身就是站点框架 */
  var CHROME_TAGS = { NAV: true, ASIDE: true, FOOTER: true };

  /** 语义地标的 ARIA 等价物 */
  var CHROME_ROLES = {
    navigation: true, complementary: true, contentinfo: true, banner: true,
    menu: true, menubar: true, search: true, toolbar: true, tablist: true
  };

  /**
   * 「站点框架」特征词。
   * 按 class/id 分词后精确匹配，而不是对整串做子串匹配——
   * 后者会把 content-meta、mainmenu 这种正常类名误判成框架。
   */
  var CHROME_TOKENS = {
    nav: 1, navbar: 1, navigation: 1, menu: 1, sidebar: 1, aside: 1,
    breadcrumb: 1, breadcrumbs: 1, pagination: 1, paginator: 1, pager: 1, toc: 1,
    footer: 1, masthead: 1, topbar: 1, toolbar: 1, comment: 1, comments: 1, disqus: 1,
    related: 1, recommend: 1, recirc: 1, promo: 1, advert: 1, advertisement: 1,
    banner: 1, social: 1, share: 1, sharing: 1, subscribe: 1, newsletter: 1,
    cookie: 1, cookies: 1, consent: 1, notice: 1, widget: 1, byline: 1,
    sitemap: 1, offcanvas: 1, drawer: 1, skip: 1, screenreader: 1, visuallyhidden: 1
  };

  /** 把 class / id 拆成词元 */
  function tokensOf(str) {
    if (!str || typeof str !== 'string') return [];
    return str.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }

  function attr(el, name) {
    return (el && el.getAttribute) ? (el.getAttribute(name) || '') : '';
  }

  /** 元素本身是否是站点框架（导航、侧栏、页脚、分享条……） */
  S.isChromeElement = function (el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName && el.tagName.toUpperCase();
    if (CHROME_TAGS[tag]) return true;

    var role = attr(el, 'role');
    if (role && CHROME_ROLES[role.toLowerCase()]) return true;

    var toks = tokensOf(attr(el, 'class')).concat(tokensOf(attr(el, 'id')));
    for (var i = 0; i < toks.length; i++) {
      if (CHROME_TOKENS[toks[i]]) return true;
    }
    return false;
  };

  /* ------------------------------------------------------------------ *
   * 链接密集容器识别（第二级：纯内容证据）
   * ------------------------------------------------------------------ */

  /** 页面根节点不参与链接密集判定——它覆盖整页，判了等于全页不翻 */
  var ROOT_TAGS = { HTML: true, BODY: true };

  /** 链接密集容器至少要有这么多条链接 */
  var DENSE_MIN_LINKS = 4;

  /** 链接文字占容器文字的下限 */
  var DENSE_MIN_RATIO = 0.55;

  /** 平均每条链接的最大长度 */
  var DENSE_MAX_AVG_LEN = 32;

  /**
   * 链接密集容器占全页文字的上限。
   * 超过这个比例说明它不是「导航」而是「页面内容本身」——
   * 例如 Hacker News 的文章列表本身就是一堆链接，不能当导航剔掉。
   */
  var DENSE_MAX_PAGE_RATIO = 0.25;

  /** 统计缓存：元素 → {text, linkCount, linkText} */
  var statsCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

  /** collect() 期间一次性算好的统计表（优先于逐元素缓存） */
  var currentStats = null;

  /**
   * 统计文本里的可见字符数（不含空白）。
   *
   * 必须用可见字符而不是原始字符数：HTML 里为了排版留下的换行与缩进
   * 会把容器的文本量撑大好几倍，把「链接文字占比」稀释到阈值以下，
   * 于是目录 / 导航列表反而认不出来。
   */
  function visibleLength(str) {
    var n = 0;
    for (var i = 0; i < str.length; i++) {
      if (str.charCodeAt(i) > 32) n++;
    }
    return n;
  }

  /**
   * 自底向上统计元素的文字量与链接特征。
   * @returns {{text:number, linkCount:number, linkText:number}}
   */
  function computeStats(el) {
    var text = 0, linkCount = 0, linkText = 0;
    var child = el.firstChild;
    while (child) {
      var next = child.nextSibling;
      if (child.nodeType === 3) {
        text += visibleLength(child.nodeValue || '');
      } else if (child.nodeType === 1) {
        if (child.tagName === 'A') {
          var at = visibleLength(child.textContent || '');
          text += at;
          linkCount++;
          linkText += at;
        } else {
          var s = getStats(child);
          text += s.text;
          linkCount += s.linkCount;
          linkText += s.linkText;
        }
      }
      child = next;
    }
    return { text: text, linkCount: linkCount, linkText: linkText };
  }

  function getStats(el) {
    if (currentStats) {
      var hit = currentStats.get(el);
      if (hit) return hit;
    }
    if (statsCache && statsCache.has(el)) return statsCache.get(el);
    var s = computeStats(el);
    if (statsCache) statsCache.set(el, s);
    return s;
  }

  /**
   * 元素是否是「链接密集容器」（目录、标签云、导航列表）。
   *
   * @param {Element} el
   * @param {number} [pageText] 全页文字量。给出时会额外做「占比过大即视为内容」的判定。
   */
  S.isLinkList = function (el, pageText) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName && el.tagName.toUpperCase();
    if (ROOT_TAGS[tag]) return false;

    var s = getStats(el);
    if (!s || !s.text) return false;
    if (s.linkCount < DENSE_MIN_LINKS) return false;
    if ((s.linkText / s.text) < DENSE_MIN_RATIO) return false;
    if ((s.linkText / s.linkCount) > DENSE_MAX_AVG_LEN) return false;

    // 占全页文字太多 → 它就是内容本身，不是框架
    if (pageText && s.text > pageText * DENSE_MAX_PAGE_RATIO) return false;

    return true;
  };

  /**
   * 块是否「由链接构成」。
   * 用于在链接密集容器里区分「该排除的菜单项」与「该保留的标题段落」。
   */
  S.isLinkish = function (el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'A') return true;
    var s = getStats(el);
    if (!s || !s.text) return false;
    return (s.linkText / s.text) >= 0.8;
  };

  /**
   * 元素是否位于站点框架区域。
   * 判定依据：祖先链上的框架特征（标签 / role / class-id 词元），
   * 以及纯内容特征（链接密集容器）。
   *
   * @param {Element} el
   * @param {number} [pageText]
   */
  S.isChrome = function (el, pageText) {
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 12) {
      if (S.isChromeElement(node)) return true;
      if (S.isLinkList(node, pageText)) return true;
      node = node.parentElement;
      depth++;
    }
    return false;
  };

  S.clearCaches = function () {
    statsCache = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
    currentStats = null;
  };

  /** 元素是否含块级子元素（即它是个容器而非段落） */
  S.hasBlockChild = function (el) {
    var child = el.firstElementChild;
    while (child) {
      var tag = child.tagName && child.tagName.toUpperCase();
      if (tag && BLOCK[tag]) return true;
      child = child.nextElementSibling;
    }
    return false;
  };

  /* ------------------------------------------------------------------ *
   * 主流程
   * ------------------------------------------------------------------ */

  /**
   * 收集当前页面中所有可翻译的段落。
   *
   * @param {Element|Document} root
   * @param {object} options {tags, excludeSelectors, thresholds, mainSelector, translateChrome}
   * @returns {{items: Array, stats: object}}
   */
  S.collect = function (root, options) {
    var opts = options || {};
    var th = U.deepMerge({}, IMT.DEFAULT_THRESHOLDS, opts.thresholds || {});
    var whitelist = (opts.tags || []).map(function (t) { return String(t).toLowerCase(); });
    /** true = 连导航 / 侧栏 / 页脚一起翻（整页翻译模式） */
    var translateChrome = !!opts.translateChrome;

    // 1. 作用域：默认整页；指定 mainSelector 时只翻该容器内部
    var scope = root || document.body || document.documentElement;
    if (opts.mainSelector) {
      var picked = null;
      try { picked = scope.querySelector(opts.mainSelector); } catch (e) { picked = null; }
      if (!picked) {
        try { picked = document.querySelector(opts.mainSelector); } catch (e) { picked = null; }
      }
      if (picked) scope = picked;
    }

    // 2. 额外排除的选择器
    var excluded = [];
    (opts.excludeSelectors || []).forEach(function (sel) {
      try {
        var list = scope.querySelectorAll(sel);
        for (var i = 0; i < list.length; i++) excluded.push(list[i]);
      } catch (e) {
        /* 非法选择器直接忽略 */
      }
    });

    var excludedSet = new Set(excluded);
    var items = [];
    var totalText = 0;
    var seq = 0;

    var candidates = [];

    // 3. 一次性统计全树的文字量与链接特征（O(n)）
    S.clearCaches();
    var statsMap = new Map();
    (function buildStats(el) {
      var text = 0, linkCount = 0, linkText = 0;
      var child = el.firstChild;
      while (child) {
        var next = child.nextSibling;
        if (child.nodeType === 3) {
          text += visibleLength(child.nodeValue || '');
        } else if (child.nodeType === 1) {
          if (child.tagName === 'A') {
            var at = visibleLength(child.textContent || '');
            text += at;
            linkCount++;
            linkText += at;
          } else {
            var s = buildStats(child);
            text += s.text;
            linkCount += s.linkCount;
            linkText += s.linkText;
          }
        }
        child = next;
      }
      var r = { text: text, linkCount: linkCount, linkText: linkText };
      statsMap.set(el, r);
      return r;
    })(scope);

    var prevStats = currentStats;
    currentStats = statsMap;
    try {
      // 全页文字量，用于「链接密集容器是否就是内容本身」的判定
      var pageText = 0;
      try {
        var bodyEl = document.body || scope;
        pageText = (statsMap.get(bodyEl) || getStats(bodyEl)).text;
      } catch (e) {
        pageText = 0;
      }

      walk(scope, false);
    } finally {
      currentStats = prevStats;
    }

    function walk(el, inDense) {
      if (!el || el.nodeType !== 1) return;
      if (excludedSet.has(el)) return;
      if (S.shouldSkip(el)) return;

      var tag = el.tagName.toUpperCase();

      // 站点框架（语义地标 / 框架词元）→ 整棵子树排除
      if (!translateChrome && S.isChromeElement(el)) return;

      // 链接密集容器 → 其中的「链接型」块排除，标题段落保留
      var dense = inDense || (!translateChrome && S.isLinkList(el, pageText));

      var isBlock = !!BLOCK[tag];
      if (isBlock && !S.hasBlockChild(el)) {
        if (!whitelist.length || whitelist.indexOf(tag.toLowerCase()) >= 0) {
          if (!(dense && !translateChrome && S.isLinkish(el))) {
            candidates.push(el);
          }
        }
      }

      // 子节点
      var child = el.firstElementChild;
      while (child) {
        var next = child.nextElementSibling;
        walk(child, dense);
        child = next;
      }

      // Shadow DOM 穿透
      if (el.shadowRoot) {
        var sr = el.shadowRoot.firstElementChild;
        while (sr) {
          var sNext = sr.nextElementSibling;
          walk(sr, dense);
          sr = sNext;
        }
      }
    }

    // 4. 整页正文量门槛（增量扫描时跳过该门槛）
    for (var i = 0; i < candidates.length; i++) {
      totalText += (candidates[i].textContent || '').length;
    }
    if (!opts.skipMainFrameCheck && totalText < th.mainFrameMinTextCount) {
      return { items: [], stats: { candidates: candidates.length, totalText: totalText, skippedByMainFrame: true } };
    }

    // 5. 逐条判定
    for (var j = 0; j < candidates.length; j++) {
      var el = candidates[j];
      var own = S.ownText(el);
      var text = own.text;
      if (!text) continue;

      var len = text.length;
      if (len < th.paragraphMinTextCount) continue;

      // 纯数字 / 纯符号的块没有可翻译语义（如排名 "1."、价格 "$100"）
      if (!U.hasLetter(text)) continue;

      // 已经翻译过 / 正在翻译
      if (el.getAttribute('data-imtl-state')) continue;

      seq++;
      items.push({
        id: 'seg-' + (seq),
        el: el,
        text: text,
        wordCount: U.countWords(text),
        parts: own.parts,
        index: seq - 1
      });
    }

    return {
      items: items,
      stats: {
        candidates: candidates.length,
        totalText: totalText,
        translated: items.length,
        skippedByMainFrame: false
      }
    };
  };

  IMT.segment = S;
})(typeof globalThis !== 'undefined' ? globalThis : this);
