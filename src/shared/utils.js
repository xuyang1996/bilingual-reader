/*!
 * Bilingual Reader — 通用工具函数
 */
(function (root) {
  'use strict';

  var IMT = (root.IMT = root.IMT || {});
  var U = {};

  /* ---------- 字符串 ---------- */

  /** 规范化空白：折叠连续空白、去首尾 */
  U.normalizeSpace = function (text) {
    if (!text) return '';
    return String(text).replace(/\s+/g, ' ').trim();
  };

  /** 保留换行的规范化（用于 pre 之外的多行文本） */
  U.normalizeMultiline = function (text) {
    if (!text) return '';
    return String(text).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  };

  U.escapeHtml = function (text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  U.escapeRegExp = function (text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  };

  /** 去掉 HTML 标签，得到纯文本 */
  U.stripTags = function (html) {
    return String(html == null ? '' : html)
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  };

  /* ---------- 哈希（缓存键） ---------- */

  /**
   * FNV-1a 32 位哈希 + 长度盐，返回 16 位十六进制字符串。
   * 纯前端够用：用于生成缓存键，不用于安全场景。
   */
  U.hashString = function (str) {
    var s = String(str == null ? '' : str);
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return (h >>> 0).toString(16).padStart(8, '0') + '-' + s.length.toString(16);
  };

  /* ---------- 词数统计 ---------- */

  /**
   * 统计「词」的数量：中英文混排时，连续的拉丁字母/数字算一个词，
   * 连续的 CJK 字符每个算一个词。
   */
  U.countWords = function (text) {
    if (!text) return 0;
    var s = String(text);
    var latin = s.match(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g);
    var cjk = s.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g);
    return (latin ? latin.length : 0) + (cjk ? cjk.length : 0);
  };

  /** 是否包含中日韩文字 */
  U.hasCJK = function (text) {
    return /[\u3400-\u4DBF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(String(text || ''));
  };

  /**
   * 是否含有字母（拉丁 / 希腊 / 西里尔 / 汉字 / 假名 / 谚文…）。
   *
   * 纯数字或纯符号的块（排名 "1."、价格 "$100"、分隔线 "—"）没有可翻译的
   * 语义，翻译它们只会给双语视图添噪音。
   */
  U.hasLetter = function (text) {
    if (!text) return false;
    return /\p{L}/u.test(String(text));
  };

  /* ---------- URL 匹配 ---------- */

  /**
   * 站点规则匹配。支持的写法：
   *   example.com        → 子串匹配（大小写不敏感）
   *   *example.com*      → 通配符
   *   ||example.com       → 域名及子域匹配
   *   /^https?:\/\/.*example/ → 正则
   */
  U.matchesPattern = function (url, pattern) {
    if (!url || !pattern) return false;
    var pat = String(pattern).trim();
    if (!pat) return false;

    if (pat.indexOf('||') === 0) {
      var domain = pat.slice(2).replace(/^\.+/, '').toLowerCase();
      var host = '';
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch (e) {
        host = String(url).toLowerCase();
      }
      return host === domain || host.endsWith('.' + domain);
    }

    if (pat.charAt(0) === '/') {
      try {
        return new RegExp(pat.slice(1)).test(url);
      } catch (e) {
        return false;
      }
    }

    if (pat.indexOf('*') >= 0) {
      var re = new RegExp('^' + U.escapeRegExp(pat).replace(/\\\*/g, '.*') + '$', 'i');
      return re.test(url);
    }

    return String(url).toLowerCase().indexOf(pat.toLowerCase()) >= 0;
  };

  /** 规则特异性：越具体越靠前 */
  U.patternSpecificity = function (pattern) {
    var s = String(pattern || '');
    var score = s.length;
    if (s.indexOf('||') === 0) score += 40;
    if (s.indexOf('*') >= 0) score -= 15;
    if (s.charAt(0) === '/') score += 60;
    return score;
  };

  /* ---------- 语言检测 ---------- */

  /**
   * 极简语言检测：足够判断「是否已经是目标语言」，避免重复翻译。
   * 返回 zh / en / ja / ko / ru / ar / th / unknown
   */
  U.detectLang = function (text) {
    var s = String(text || '').trim();
    if (!s) return 'unknown';
    // 日文：假名占比足够高时才判为 ja（避免把日文汉字误判成中文）
    var kana = (s.match(/[\u3040-\u30FF]/g) || []).length;
    if (kana) {
      var han = (s.match(/[\u4E00-\u9FFF\u3400-\u4DBF]/g) || []).length;
      if (kana * 4 >= han) return 'ja';
    }
    if (/[\uAC00-\uD7AF]/.test(s)) return 'ko';
    if (/[\u4E00-\u9FFF\u3400-\u4DBF]/.test(s)) return 'zh';
    if (/[\u0600-\u06FF]/.test(s)) return 'ar';
    if (/[\u0E00-\u0E7F]/.test(s)) return 'th';
    if (/[\u0400-\u04FF]/.test(s)) return 'ru';
    var latin = (s.match(/[A-Za-z]/g) || []).length;
    var total = (s.match(/[^\s]/g) || []).length || 1;
    if (latin / total > 0.6) return 'en';
    return 'unknown';
  };

  /** 语言代码归族：zh-Hans / zh-Hant → zh */
  U.langFamily = function (code) {
    var c = String(code || '').toLowerCase();
    if (c.indexOf('zh') === 0) return 'zh';
    return c.split('-')[0];
  };

  /** 源语言与目标语言同族时，文本大概率已翻译过 */
  U.isSameLang = function (source, target) {
    var s = U.langFamily(source);
    var t = U.langFamily(target);
    if (!s || s === 'auto' || s === 'unknown') return false;
    return s === t;
  };

  /* ---------- 数组 ---------- */

  U.chunk = function (arr, size) {
    var out = [];
    var step = Math.max(1, size | 0);
    for (var i = 0; i < arr.length; i += step) out.push(arr.slice(i, i + step));
    return out;
  };

  U.unique = function (arr) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var k = String(arr[i]);
      if (!seen[k]) {
        seen[k] = true;
        out.push(arr[i]);
      }
    }
    return out;
  };

  /* ---------- 深合并 ---------- */

  U.isPlainObject = function (v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  };

  /**
   * 深合并：后面的 source 覆盖前面的 target；数组直接替换。
   * 支持可变参数：U.deepMerge({}, DEFAULTS, overrides)
   */
  U.deepMerge = function (target) {
    var out = U.isPlainObject(target) ? Object.assign({}, target) : {};
    for (var i = 1; i < arguments.length; i++) {
      var source = arguments[i];
      if (!U.isPlainObject(source)) continue;
      Object.keys(source).forEach(function (k) {
        var sv = source[k];
        var tv = out[k];
        if (U.isPlainObject(sv) && U.isPlainObject(tv)) {
          out[k] = U.deepMerge(tv, sv);
        } else if (sv !== undefined) {
          out[k] = sv;
        }
      });
    }
    return out;
  };

  /* ---------- 杂项 ---------- */

  U.debounce = function (fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      var ctx = this;
      clearTimeout(timer);
      timer = setTimeout(function () {
        fn.apply(ctx, args);
      }, wait);
    };
  };

  U.abortError = function () {
    var err = new Error('翻译已取消');
    err.name = 'AbortError';
    err.code = 'ENGINE_CANCELLED';
    return err;
  };

  U.throwIfAborted = function (signal) {
    if (signal && signal.aborted) throw U.abortError();
  };

  U.abortable = function (promise, signal) {
    if (!signal) return promise;
    return new Promise(function (resolve, reject) {
      function abort() { reject(U.abortError()); }
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(promise).then(function (value) {
        signal.removeEventListener('abort', abort);
        resolve(value);
      }, function (err) {
        signal.removeEventListener('abort', abort);
        reject(err);
      });
    });
  };

  U.sleep = function (ms, signal) {
    return new Promise(function (resolve, reject) {
      function abort() {
        clearTimeout(timer);
        reject(U.abortError());
      }
      var timer = setTimeout(function () {
        if (signal) signal.removeEventListener('abort', abort);
        resolve();
      }, ms);
      if (signal) {
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }
    });
  };

  /** 生成短 id */
  U.uid = function (prefix) {
    U._seq = (U._seq || 0) + 1;
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + U._seq;
  };

  /* ---------- 引擎就绪判断 ---------- */

  /**
   * 这个引擎是否已经配好、可以直接用。
   *
   * v1.3.0 起扩展只支持对接大模型 API，必须用户自己填 Key；
   * 例外是「鉴权方式 = 无」以及本机地址（Ollama / vLLM / LM Studio）。
   */
  U.engineReady = function (engine) {
    if (!engine) return false;
    if (engine.auth === 'none') return true;
    var base = String(engine.baseUrl || '').toLowerCase();
    if (/localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/.test(base)) return true;
    return !!(engine.key && String(engine.key).trim());
  };

  /**
   * 从配置里挑一个可用的引擎 id。
   * 优先用户当前选中的那个；它没配好就退回到任意一个已配好的。
   * 一个都没有就返回 null —— 调用方据此强制引导用户去配置。
   */
  U.pickReadyEngine = function (cfg) {
    if (!cfg) return null;
    var engines = cfg.engines || {};
    if (cfg.engine && engines[cfg.engine] && U.engineReady(engines[cfg.engine])) {
      return cfg.engine;
    }
    var ids = Object.keys(engines);
    for (var i = 0; i < ids.length; i++) {
      if (U.engineReady(engines[ids[i]])) return ids[i];
    }
    return null;
  };

  /* ---------- 配置合并 ---------- */

  /**
   * 把用户保存的配置合并到默认配置上。
   *
   * v1.4.0 起默认不再预置任何引擎，所以这里只做两件事：
   *   1. 给已存在的引擎补齐缺失的通用字段；
   *   2. 迁移：把从没配过的旧预置引擎（OpenAI / Anthropic / Gemini）清掉，
   *      免得用户看到三个空表单。
   */
  U.config = {
    merge: function (saved) {
      var base = JSON.parse(JSON.stringify(IMT.DEFAULT_CONFIG));
      var cfg = U.deepMerge(base, saved || {});

      var templates = IMT.ENGINE_PRESETS || {};
      var engines = Object.assign({}, cfg.engines || {});
      Object.keys(engines).forEach(function (k) {
        engines[k] = Object.assign({}, templates[k] || {}, engines[k]);
        engines[k].id = k;
      });

      // 迁移：v1.3.0 预置的三个引擎，如果用户从没改过就直接删掉，
      // 免得用户看到三个空表单。已经动过的（填过地址 / 模型 / Key）必须保留。
      ['openai-compatible', 'anthropic', 'gemini'].forEach(function (k) {
        var e = engines[k];
        if (!e) return;
        var tpl = templates[k] || {};
        var noKey = !String(e.key || '').trim();
        var pristine = noKey &&
          !String(e.baseUrl || '').trim() &&
          !String(e.model || '').trim();
        var stillTemplate = noKey &&
          String(e.baseUrl || '') === String(tpl.baseUrl || '') &&
          String(e.model || '') === String(tpl.model || '');
        if (pristine || stillTemplate) delete engines[k];
      });

      // 引擎名取模型名（预设引擎）。老配置里的 name 可能是旧显示名，
      // 这里统一改写成模型名，和设置页的规则对齐。
      Object.keys(engines).forEach(function (k) {
        var e = engines[k];
        if (!e.custom && e.model) e.name = e.model;
      });

      cfg.engines = engines;

      // chrome.storage 会把对象键按字母序重排，引擎在列表里的先后顺序靠 seq 固定。
      // 老配置没有 seq，这里按当前顺序补齐，保证刷新前后一致。
      var maxSeq = 0;
      Object.keys(engines).forEach(function (k) {
        var s = Number(engines[k].seq) || 0;
        if (s > maxSeq) maxSeq = s;
      });
      Object.keys(engines).forEach(function (k) {
        if (!Number(engines[k].seq)) {
          maxSeq += 1;
          engines[k].seq = maxSeq;
        }
      });

      if (!cfg.engine || !engines[cfg.engine]) {
        cfg.engine = U.pickReadyEngine(cfg) || (Object.keys(engines)[0] || '');
      }

      // 迁移：免费 Google 引擎早已下线（v1.3.0 起只支持对接大模型 API）
      if (cfg.engines['google-free']) delete cfg.engines['google-free'];
      if (cfg.engine === 'google-free') cfg.engine = '';

      if (!Array.isArray(cfg.glossary)) cfg.glossary = [];
      if (IMT.glossary && typeof IMT.glossary.clean === 'function') {
        cfg.glossary = IMT.glossary.clean(cfg.glossary);
      }
      if (!Array.isArray(cfg.rules)) cfg.rules = [];

      // 翻译风格场景
      if (!cfg.customScenarios || typeof cfg.customScenarios !== 'object') {
        cfg.customScenarios = {};
      }
      if (cfg.autoScenario === undefined) cfg.autoScenario = true;
      if (IMT.prompts && !IMT.prompts.get(cfg.scenario, cfg.customScenarios)) {
        cfg.scenario = 'general';
      }

      // 清理历史版本遗留的废弃阈值键（侧栏阈值已被「整棵排除框架」取代）
      if (cfg.generalRule && cfg.generalRule.thresholds) {
        delete cfg.generalRule.thresholds.asideMaxTextCountPerParagraph;
        delete cfg.generalRule.thresholds.asideMaxWordCountPerParagraph;
      }
      return cfg;
    }
  };

  /**
   * 把「当前配置 + 一份改动」合成新配置。
   *
   * 注意：普通对象是逐键合并的，所以「删除某个引擎」「删除某个自定义场景」
   * 这类操作在合并时会失效（旧键还在）。这两张表是「整份替换」语义，
   * 这里单独处理。
   */
  U.config.applyPatch = function (current, patch) {
    var next = U.deepMerge(current || {}, patch || {});
    var p = patch || {};
    if (p.engines) next.engines = p.engines;
    if (p.customScenarios) next.customScenarios = p.customScenarios;
    return U.config.merge(next);
  };

  IMT.utils = U;
})(typeof globalThis !== 'undefined' ? globalThis : this);
