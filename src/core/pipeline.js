/*!
 * Bilingual Reader — 翻译管线
 *
 * 分段 → (懒翻译调度) → 批量请求 → PII 解码 → 术语后处理 → 渲染
 *
 * 传输层（transport）可注入：
 *   IMT.client.setTransport(async (texts, opts) => [...])
 * 浏览器里由 content.js 注入到 background；测试页可注入 mock。
 */
(function (root) {
  'use strict';

  var IMT = (root.IMT = root.IMT || {});
  var U = IMT.utils;

  var I = {};

  /* ------------------------------------------------------------------ *
   * 可注入的翻译传输层
   * ------------------------------------------------------------------ */

  I.client = {
    _transport: null,
    setTransport: function (fn) { I.client._transport = fn; },
    hasTransport: function () { return !!I.client._transport; },
    translate: function (texts, opts) {
      var t = I.client._transport;
      if (!t) return Promise.reject(new Error('IMT: transport 未设置'));
      return Promise.resolve(t(texts, opts));
    }
  };

  /* ------------------------------------------------------------------ *
   * 管线
   * ------------------------------------------------------------------ */

  /**
   * @param {object} ctx
   *   root      {Element}  扫描根节点
   *   rule      {object}  已解析的站点规则
   *   config    {object}  全局配置
   *   engineId  {string}  引擎 id
   *   lazy      {boolean} 是否懒翻译
   *   onProgress {function(stats)}
   * @returns {object} controller
   */
  I.create = function (ctx) {
    var c = ctx || {};
    var cfg = c.config || {};
    var rule = c.rule || {};
    var root = c.root || document.body || document.documentElement;
    // 引擎：优先用指定的，其次当前选中的，都不行就挑一个已配好的
    var engineId = c.engineId || cfg.engine || U.pickReadyEngine(cfg);
    var engine = (cfg.engines && cfg.engines[engineId]) ||
      (cfg.engines && cfg.engines[U.pickReadyEngine(cfg)]) ||
      { batchSize: 1 };
    /** 演示引擎的译文是本地拼的示例，给个标记别让人误以为是真翻译 */
    var isDemo = engine.format === 'demo';
    var batchSize = Math.max(1, engine.batchSize || 1);
    var concurrency = 2;
    var lazy = c.lazy !== false && cfg.lazy !== false;

    var targetLang = rule.targetLang || cfg.targetLang || 'zh-Hans';
    var sourceLang = rule.sourceLang || 'auto';
    var position = rule.translationPosition || 'after';

    var registry = new Map();   // element -> item
    var queue = [];
    var running = 0;
    var stopped = false;
    var paused = false;
    var generation = 0;
    var activeBatches = new Set();
    var resumeItem = null;
    var io = null;
    var observer = null;
    var selfMutate = false;
    var failedItems = new Set();
    var haltedError = null;

    var stats = {
      total: 0, done: 0, failed: 0, skipped: 0,
      pending: 0, mode: 'none', lastError: null, startedAt: Date.now()
    };

    /* ---------------- 进度 ---------------- */

    function updateStats() {
      stats.pending = paused || stopped ? 0 : queue.length + running;
      stats.waiting = 0;
      registry.forEach(function (item) { if (item.state === 'waiting') stats.waiting++; });
      stats.paused = paused;
      stats.canPause = !stopped && !paused && !haltedError && !!(stats.pending || stats.waiting);
    }

    function notify() {
      updateStats();
      if (typeof c.onProgress === 'function') {
        try { c.onProgress(Object.assign({}, stats)); } catch (e) { /* ignore */ }
      }
    }

    /* ---------------- 收集 ---------------- */

    function collect(scope, opts) {
      var res = IMT.segment.collect(scope || root, {
        tags: rule.tags || [],
        excludeSelectors: rule.excludeSelectors || [],
        thresholds: rule.thresholds || {},
        mainSelector: rule.mainSelector || '',
        translateChrome: !!rule.translateChrome,
        skipMainFrameCheck: !!opts
      });
      var added = [];
      res.items.forEach(function (item) {
        if (registry.has(item.el)) return;
        registry.set(item.el, item);
        added.push(item);
      });
      stats.total = registry.size;
      return added;
    }

    /* ---------------- 调度 ---------------- */

    function schedule(items) {
      if (stopped) return;
      var usable = items.filter(function (item) {
        if (!item || !item.el) return false;
        if (IMT.render.isTranslated(item.el)) return false;
        // 已经是目标语言的内容无需翻译
        if (isTargetLanguage(item.text)) {
          item.state = 'skipped';
          stats.skipped++;
          return false;
        }
        return true;
      });
      if (!usable.length) {
        notify();
        return;
      }

      if (haltedError) {
        usable.forEach(function (item) { markFailed(item, haltedError); });
        notify();
        return;
      }

      if (lazy && typeof IntersectionObserver !== 'undefined') {
        usable.forEach(function (item) {
          item.state = 'waiting';
          if (!paused) {
            IMT.render.markPending(item.el);
            io.observe(item.el);
          }
        });
      } else {
        usable.forEach(function (item) {
          if (!paused) IMT.render.markPending(item.el);
          item.state = 'queued';
          queue.push(item);
        });
        pump();
      }
      notify();
    }

    /** 判断文本是否已经是目标语言 */
    function isTargetLanguage(text) {
      if (sourceLang !== 'auto' && U.isSameLang(sourceLang, targetLang)) return true;
      var detected = U.detectLang(text);
      if (detected === 'unknown') return false;
      return U.langFamily(detected) === U.langFamily(targetLang);
    }

    function pump() {
      while (!stopped && !paused && !haltedError && running < concurrency && queue.length) {
        runBatch(queue.splice(0, batchSize));
      }
      notify();
    }

    function runBatch(batch) {
      var task = { generation: generation, abort: new AbortController(), items: batch };
      batch.forEach(function (item) { item.state = 'running'; });
      activeBatches.add(task);
      running = activeBatches.size;
      translateBatch(batch, task)
        .catch(function () { /* 错误已在 translateBatch 内处理 */ })
        .then(function () {
          if (!activeBatches.delete(task)) return;
          running = activeBatches.size;
          pump();
        });
    }

    function cancelActive() {
      generation++;
      activeBatches.forEach(function (task) {
        task.items.forEach(function (item) { if (item.state === 'running') item.state = 'queued'; });
        task.abort.abort();
      });
      activeBatches.clear();
      running = 0;
    }

    function orderedItems() {
      return Array.from(registry.values()).filter(function (item) { return item.el.isConnected; })
        .sort(function (a, b) {
          var position = a.el.compareDocumentPosition(b.el);
          return position & 4 ? -1 : position & 2 ? 1 : 0;
        });
    }

    /* ---------------- 单批翻译 ---------------- */

    function markFailed(item, err) {
      if (stopped || item.state === 'translated' || item.state === 'skipped') return;
      item.state = 'failed';
      failedItems.add(item);
      stats.failed = failedItems.size;
      stats.lastError = String((err && err.message) || err || '翻译失败');
      item.el.classList.add('imtl-error');
      item.el.setAttribute('data-imtl-error', stats.lastError);
      IMT.render.clearPending(item.el);
    }

    function halt(err) {
      if (!err || !err.fatal) return;
      haltedError = err;
      queue.length = 0;
      if (io) io.disconnect();
      registry.forEach(function (item) {
        // 已经发出的请求自行完成，其余段落保留原文并允许之后补翻。
        if (item.state !== 'running') markFailed(item, err);
      });
    }

    function translateBatch(batch, task) {
      var usePII = !!(cfg.pii && cfg.pii.enabled);
      var encoded = batch.map(function (item) {
        if (usePII) {
          var r = IMT.pii.encode(item.text, cfg.pii.types || IMT.pii.ALL_TYPES);
          return { text: r.text, map: r.map };
        }
        return { text: item.text, map: null };
      });

      var req = {
        texts: encoded.map(function (e) { return e.text; }),
        sourceLang: sourceLang,
        targetLang: targetLang,
        engineId: engineId,
        signal: task.abort.signal,
        bypassCache: !!c.bypassCache || batch.some(function (item) { return !!item.forceRefresh; })
      };

      return I.client.translate(req.texts, req).then(function (res) {
        if (stopped || paused || task.generation !== generation) return;
        var list = Array.isArray(res) ? res : ((res && res.texts) || []);
        var errors = (res && res.errors) || [];
        batch.forEach(function (item, i) {
          if (errors[i] || typeof list[i] !== 'string' || !list[i].trim()) {
            var failure = errors[i] || { message: '接口未返回该段译文，请重试失败段落' };
            markFailed(item, failure);
            halt(failure);
            return;
          }
          try {
            var raw = list[i];

            if (usePII && encoded[i].map) {
              raw = IMT.pii.decode(raw, encoded[i].map);
            }
            // 还原被保护的技术片段
            (item.parts || []).forEach(function (p) {
              raw = String(raw).split(p.placeholder).join(p.original);
            });
            // 术语库后处理（提示词没生效时，靠这一步兜底）
            raw = IMT.glossary.apply(raw, cfg.glossary || []);

            raw = String(raw).trim();
            if (!raw) throw new Error('译文处理后为空，请重试失败段落');

            IMT.render.insert(item.el, raw, {
              position: position,
              wrapperTag: (cfg.render && cfg.render.targetWrapperTag) || 'font',
              targetLang: targetLang,
              demo: isDemo
            });
            item.state = 'translated';
            failedItems.delete(item);
            stats.failed = failedItems.size;
            item.forceRefresh = false;
            if (!item.completed) stats.done++;
            item.completed = true;
          } catch (err) {
            markFailed(item, err);
          }
        });
        notify();
      }, function (err) {
        if (stopped || paused || task.generation !== generation) return;
        batch.forEach(function (item) {
          markFailed(item, err);
        });
        halt(err);
        notify();
      });
    }

    /* ---------------- IntersectionObserver（懒翻译） ---------------- */

    function ensureObserver() {
      if (io || typeof IntersectionObserver === 'undefined') return;
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          io.unobserve(entry.target);
          var item = registry.get(entry.target);
          if (stopped || paused || haltedError || !item || item.state !== 'waiting') return;
          item.state = 'queued';
          queue.push(item);
          pump();
        });
      }, { rootMargin: '300px 0px', threshold: 0.01 });
    }

    /* ---------------- MutationObserver（增量翻译） ---------------- */

    function ensureMutationObserver() {
      if (observer || !cfg.incremental || typeof MutationObserver === 'undefined') return;
      observer = new MutationObserver(function (records) {
        if (stopped) return;
        var fresh = [];
        records.forEach(function (rec) {
          if (selfMutate) return;
          rec.addedNodes.forEach(function (node) {
            if (node.nodeType !== 1) return;
            if (node.classList && (node.classList.contains('imtl-translation') || node.classList.contains('imtl-original'))) {
              return;
            }
            if (node.classList && node.classList.contains('imtl-block')) return;
            fresh.push(node);
          });
        });
        if (!fresh.length) return;
        // 去重后扫描
        var seen = new Set();
        var unique = fresh.filter(function (n) {
          if (seen.has(n)) return false;
          seen.add(n);
          return true;
        });
        var added = [];
        unique.forEach(function (node) {
          added = added.concat(collect(node, true));
        });
        if (added.length) schedule(added);
      });
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    }

    /* ---------------- 对外接口 ---------------- */

    var controller = {
      /** 开始翻译 */
      start: function () {
        stopped = false;
        stats.mode = 'translating';
        stats.startedAt = Date.now();
        ensureObserver();
        var added = collect(root, false);
        ensureMutationObserver();
        schedule(added);
        stats.mode = 'translated';
        notify();
        return controller;
      },

      /** 增量刷新（页面结构变化后手动调用） */
      refresh: function () {
        var added = collect(root, false);
        schedule(added);
        notify();
        return added.length;
      },

      /** 暂停并记录最早未完成段落的上一段，保留已完成译文。 */
      pause: function () {
        updateStats();
        if (!stats.canPause) return controller;
        var items = orderedItems().filter(function (item) { return item.state !== 'skipped'; });
        var index = items.findIndex(function (item) { return item.state === 'running' || item.state === 'queued'; });
        if (index < 0) index = items.findIndex(function (item) { return item.state === 'waiting'; });
        resumeItem = items[Math.max(0, index - 1)] || null;
        paused = true;
        if (io) io.disconnect();
        cancelActive();
        registry.forEach(function (item) { IMT.render.clearPending(item.el); });
        notify();
        return controller;
      },

      /** 从暂停位置的上一段补接；已完成的更早段落保持原样。 */
      resume: function () {
        if (stopped || !paused) return controller;
        paused = false;
        var anchor = resumeItem && resumeItem.el.isConnected ? resumeItem : null;
        if (anchor) {
          if (anchor.completed) { anchor.completed = false; stats.done--; }
          anchor.state = 'queued';
          anchor.forceRefresh = true;
          failedItems.delete(anchor);
          anchor.el.classList.remove('imtl-error');
          anchor.el.removeAttribute('data-imtl-error');
        }
        resumeItem = null;
        stats.failed = failedItems.size;
        queue = orderedItems().filter(function (item) { return item.state === 'queued'; });
        ensureObserver();
        registry.forEach(function (item) {
          if (item.state === 'queued') IMT.render.markPending(item.el);
          if (item.state === 'waiting' && io) {
            IMT.render.markPending(item.el);
            io.observe(item.el);
          }
        });
        pump();
        return controller;
      },

      /** 保留成功译文，只补翻失败段落；设置页修改模型后也可直接使用。 */
      retryFailed: function () {
        if (stopped || paused || running || !failedItems.size) return 0;
        haltedError = null;
        stats.lastError = null;
        var items = Array.from(failedItems);
        failedItems.clear();
        stats.failed = 0;
        items.forEach(function (item) {
          item.el.classList.remove('imtl-error');
          item.el.removeAttribute('data-imtl-error');
          IMT.render.markPending(item.el);
          item.state = 'queued';
          queue.push(item);
        });
        pump();
        notify();
        return items.length;
      },

      /** 停止并还原 */
      stop: function () {
        stopped = true;
        paused = false;
        resumeItem = null;
        cancelActive();
        if (io) { io.disconnect(); io = null; }
        if (observer) { observer.disconnect(); observer = null; }
        queue.length = 0;
        registry.clear();
        failedItems.clear();
        haltedError = null;
        IMT.render.restore(root);
        stats.mode = 'none';
        stats.done = 0;
        stats.failed = 0;
        stats.lastError = null;
        stats.total = 0;
        stats.pending = 0;
        notify();
        return controller;
      },

      /** 切换显示模式 */
      setMode: function (mode) {
        IMT.render.setMode(mode);
        stats.mode = mode;
        notify();
      },

      getStats: function () {
        updateStats();
        return Object.assign({}, stats, { count: IMT.render.count(root) });
      },

      isStopped: function () { return stopped; }
    };

    return controller;
  };

  IMT.client = I.client;
  IMT.pipeline = I;
})(typeof globalThis !== 'undefined' ? globalThis : this);
