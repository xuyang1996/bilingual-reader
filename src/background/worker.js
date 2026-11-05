/*!
 * Bilingual Reader — Service Worker 入口
 *
 * 职责：
 *  1. 接收内容脚本的翻译请求，查缓存 → 调引擎 → 写缓存
 *  2. 配置读写
 *  3. 快捷键与右键菜单 → 转发到当前标签页
 */
importScripts(
  '../shared/defaults.js',
  '../shared/utils.js',
  '../shared/prompts.js',
  '../shared/study.js',
  '../shared/study-collection.js',
  '../core/pii.js',
  '../core/glossary.js',
  './cache.js',
  './engines.js'
);

(function () {
  'use strict';

  var IMT = globalThis.IMT;
  var U = IMT.utils;

  /* ------------------------------------------------------------------ *
   * 配置
   * ------------------------------------------------------------------ */

  function loadConfig() {
    return chrome.storage.local.get(IMT.STORAGE_KEY).then(function (data) {
      var saved = (data && data[IMT.STORAGE_KEY]) || {};
      return U.config.merge(saved);
    }).catch(function () {
      return U.config.merge({});
    });
  }

  function saveConfig(cfg) {
    var payload = {};
    payload[IMT.STORAGE_KEY] = cfg;
    return chrome.storage.local.set(payload);
  }

  /* ------------------------------------------------------------------ *
   * 全局并发限流
   * ------------------------------------------------------------------ */

  var active = 0;
  var MAX_ACTIVE = 2;
  var waiters = [];

  function release() {
    active--;
    while (active < MAX_ACTIVE && waiters.length) {
      var fn = waiters.shift();
      fn();
    }
  }

  function withSlot(fn, signal) {
    return new Promise(function (resolve, reject) {
      function abort() {
        var index = waiters.indexOf(run);
        if (index >= 0) waiters.splice(index, 1);
        reject(U.abortError());
      }
      var run = function () {
        if (signal) signal.removeEventListener('abort', abort);
        if (signal && signal.aborted) { reject(U.abortError()); return; }
        active++;
        var p;
        try {
          p = Promise.resolve(fn());
        } catch (e) {
          p = Promise.reject(e);
        }
        p.then(resolve, reject).then(release, release);
      };
      if (signal && signal.aborted) { reject(U.abortError()); return; }
      if (active < MAX_ACTIVE) run();
      else {
        waiters.push(run);
        if (signal) signal.addEventListener('abort', abort, { once: true });
      }
    });
  }

  /**
   * 判断这个引擎是否可以不配 Key。
   *   · 鉴权方式明确选了「无」→ 不需要 Key
   *   · 本机地址（Ollama / vLLM / LM Studio）→ 通常不需要 Key
   */
  function keyOptional(engine) {
    return U.engineReady(engine);
  }

  /**
   * 挑出本次该用的翻译风格场景。
   *
   * 开启「按网址自动匹配」时，先看当前网址能不能命中某个场景的 matches，
   * 命中就用它；否则回落到用户手选的场景。
   */
  function pickScenario(cfg, url) {
    var custom = cfg.customScenarios || {};
    if (cfg.autoScenario && url && IMT.prompts) {
      var hit = IMT.prompts.match(url, custom);
      if (hit) return hit;
    }
    return cfg.scenario || 'general';
  }

  /* ------------------------------------------------------------------ *
   * 翻译
   * ------------------------------------------------------------------ */

  function handleTranslate(msg, sender, signal) {
    return loadConfig().then(function (cfg) {
      U.throwIfAborted(signal);
      var engineId = msg.engineId || cfg.engine;
      var engine = (cfg.engines || {})[engineId];

      // 一个引擎都没配 → 明确告诉用户去设置页配置
      if (!Object.keys(cfg.engines || {}).length) {
        return {
          ok: false,
          error: '尚未配置翻译引擎。请在设置页「翻译引擎」里选一个引擎、填上 API Key，否则无法翻译。',
          needConfig: true
        };
      }

      // 当前选中的没配好，但别的配好了 → 退回可用的那个
      if (!engine || !U.engineReady(engine)) {
        var alt = U.pickReadyEngine(cfg);
        if (alt) {
          engineId = alt;
          engine = cfg.engines[alt];
        }
      }

      if (!engine) {
        return {
          ok: false,
          error: '尚未配置翻译引擎「' + (engineId || '（未选择）') + '」。' +
            '请在设置页「翻译引擎」里填好 API Key（本地模型除外），否则无法翻译。',
          needConfig: true
        };
      }

      var texts = Array.isArray(msg.texts) ? msg.texts : [];
      if (!texts.length) return { ok: true, texts: [] };

      // 没配 Key 就拦下来，并明确告诉用户去哪儿配
      if (!U.engineReady(engine)) {
        return {
          ok: false,
          error: '尚未配置翻译引擎「' + (engine.name || engineId) + '」。' +
            '请在设置页「翻译引擎」里填好 API Key（本地模型除外），否则无法翻译。',
          needConfig: true
        };
      }

      var sourceLang = msg.sourceLang || 'auto';
      var targetLang = msg.targetLang || cfg.targetLang || 'zh-Hans';
      var useCache = !(cfg.cache && cfg.cache.enabled === false);
      var pageUrl = (sender && sender.tab && sender.tab.url) || '';
      var scenario = pickScenario(cfg, pageUrl);

      var callEngine = function (list) {
        return withSlot(function () {
          return IMT.engines.dispatch(engine, list, {
            signal: signal,
            sourceLang: sourceLang,
            targetLang: targetLang,
            glossary: cfg.glossary || [],
            scenario: scenario,
            customScenarios: cfg.customScenarios || {}
          });
        }, signal);
      };

      if (!useCache) {
        return callEngine(texts).then(function (out) {
          return { ok: true, texts: out, errors: out.errors || [] };
        });
      }

      // 模型/地址/提示词改变后，不能继续用旧模型留下的缓存掩盖配置故障。
      var cacheEngine = engineId + ':' + U.hashString(JSON.stringify([
        engine.baseUrl, engine.path, engine.model, engine.format, engine.systemRole,
        engine.systemPrompt, engine.extraBody, engine.responsePath, engine.temperature,
        engine.maxTokens, scenario, cfg.customScenarios || {}, cfg.glossary || []
      ]));
      var keys = texts.map(function (t) {
        return IMT.cache.key(t, sourceLang, targetLang, cacheEngine);
      });

      return (msg.bypassCache ? Promise.resolve({}) : IMT.cache.getMany(keys)).then(function (cached) {
        U.throwIfAborted(signal);
        var result = new Array(texts.length);
        var errors = new Array(texts.length);
        var missingIdx = [];
        var missingText = [];

        texts.forEach(function (t, i) {
          var hit = cached[keys[i]];
          if (hit !== null && hit !== undefined) {
            result[i] = hit;
          } else {
            missingIdx.push(i);
            missingText.push(t);
          }
        });

        if (!missingText.length) return { ok: true, texts: result };

        return callEngine(missingText).then(function (translated) {
          U.throwIfAborted(signal);
          var toCache = {};
          missingIdx.forEach(function (idx, i) {
            var val = (translated && typeof translated[i] === 'string' && translated[i]) ? translated[i] : '';
            result[idx] = val;
            errors[idx] = (translated.errors || [])[i] || null;
            if (val) toCache[keys[idx]] = val;
          });
          return IMT.cache.setMany(toCache).then(function () {
            return { ok: true, texts: result, errors: errors };
          });
        });
      });
    }).catch(function (err) {
      return Object.assign({ ok: false, error: String((err && err.message) || err) },
        IMT.engines._internal.errorInfo(err));
    });
  }

  function handleStudy(msg, signal) {
    var isWord = msg.type === 'IMT_STUDY_WORD';
    var word = isWord ? IMT.study.normalizeWord(msg.word) : '';
    var sentence = IMT.study.normalizeSentence(msg.sentence);
    if (isWord ? !word : !sentence) {
      return Promise.resolve({ ok: false, error: isWord ? '请划选一个英文单词。' : '请划选一句完整的英文原文。' });
    }
    var offset = msg.offset;
    if (isWord && (!Number.isInteger(offset) || offset < 0 || sentence.slice(offset, offset + word.length) !== word)) {
      sentence = '';
    }
    var privacyText = sentence;
    if (isWord && !sentence && typeof msg.nearby === 'string' && msg.nearby.length <= 800 &&
      Number.isInteger(offset) && offset >= 0 && msg.nearby.slice(offset, offset + word.length) === word) {
      privacyText = msg.nearby;
    }
    return loadConfig().then(function (cfg) {
      U.throwIfAborted(signal);
      var engine = cfg.engines[msg.engineId];
      if (!U.engineReady(engine)) engine = cfg.engines[U.pickReadyEngine(cfg)];
      if (!engine) {
        return { ok: false, error: '请在扩展设置中选择已配置的模型，再使用学习卡。' };
      }
      if (engine.format === 'demo') {
        var example = IMT.study.demoAnalysis(sentence, word);
        return example
          ? { ok: true, analysis: example, demo: true }
          : { ok: false, error: '演示模式只解析内置例句和示例单词。学习其他内容时，请在设置中选择已配置的模型。' };
      }
      var encoded = cfg.pii && cfg.pii.enabled ? IMT.pii.encode(privacyText, cfg.pii.types) : { text: privacyText };
      if (isWord && encoded.map && Object.keys(encoded.map).some(function (key) {
        // A selected word can be a fragment of a masked email or URL.
        var sensitive = encoded.map[key];
        var index = privacyText.indexOf(sensitive, Math.max(0, offset - sensitive.length + 1));
        return index !== -1 && index < offset + word.length;
      })) return { ok: false, error: '所选文字属于已脱敏的信息，请重新划选。' };

      var payload = isWord ? { word: word } : {};
      if (sentence) payload.sentence = encoded.text;
      return withSlot(function () {
        return IMT.engines.ai.one(JSON.stringify(payload),
          { signal: signal, taskPrompt: isWord ? IMT.study.wordPrompt : IMT.study.prompt }, engine);
      }, signal).then(function (reply) {
        U.throwIfAborted(signal);
        var analysis = IMT.study.parseReply(IMT.engines._internal.stripFences(reply), function (text) {
          return IMT.pii.decode(text, encoded.map);
        }, payload);
        if (!analysis) return { ok: false, error: '模型没有返回可读的解析，请重试。', retry: true };
        if (analysis.unsupported) return { ok: false, error: isWord ? '未能识别这个英文单词，请重新划选。' : '这段文字未能识别为一句英文，请重新划选。' };
        return { ok: true, analysis: analysis };
      });
    }).catch(function () {
      return { ok: false, error: '暂时无法解析。请检查模型服务后重试。', retry: true };
    });
  }

  var collectionWrites = Promise.resolve();
  function saveStudy(msg) {
    var job = collectionWrites.then(function () {
      var item = msg.entry || {};
      var isWord = item.kind === 'word';
      var text = isWord ? IMT.study.normalizeWord(item.text) : IMT.study.normalizeSentence(item.text);
      if (!text || (!isWord && item.kind !== 'sentence') || typeof msg.saved !== 'boolean') {
        return { ok: false, error: '没有可收藏的学习内容。' };
      }
      var entry = { kind: item.kind, text: text };
      if (isWord) entry.context = IMT.study.normalizeSentence(item.context);
      if (msg.saved) {
        entry.analysis = IMT.study.parseReply(JSON.stringify(item.analysis), null,
          isWord ? { word: text } : { sentence: text });
        if (!entry.analysis || entry.analysis.unsupported) return { ok: false, error: '解析内容不完整，无法收藏。' };
      }
      var collection = IMT.studyCollection;
      return collection.read().then(function (items) {
        var key = collection.entryKey(entry);
        var next = items.filter(function (saved) { return collection.entryKey(saved) !== key; });
        if (msg.saved) next.unshift(entry);
        var update = {};
        update[collection.storageKey] = next;
        return chrome.storage.local.set(update).then(function () {
          return { ok: true, saved: msg.saved };
        });
      });
    }).catch(function () {
      return { ok: false, error: '无法更新本地收藏，请重试。' };
    });
    collectionWrites = job;
    return job;
  }

  /* ------------------------------------------------------------------ *
   * 标签页通信
   * ------------------------------------------------------------------ */

  function sendToTab(tabId, action, extra) {
    return new Promise(function (resolve) {
      if (!tabId) return resolve({ ok: false, error: '找不到标签页' });
      var msg = Object.assign({ target: 'imtl-content', action: action }, extra || {});
      try {
        chrome.tabs.sendMessage(tabId, msg, function (res) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: '该页面无法接收指令（可能是浏览器内置页面）' });
            return;
          }
          resolve(res || { ok: true });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e.message || e) });
      }
    });
  }

  function activeTab() {
    return new Promise(function (resolve) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        resolve(tabs && tabs[0]);
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * 引擎连通性测试（设置页「测试连接」按钮）
   * ------------------------------------------------------------------ */

  function handleTestEngine(msg) {
    return loadConfig().then(function (cfg) {
      var engine = (msg.engine && typeof msg.engine === 'object')
        ? U.deepMerge({}, (cfg.engines || {})[msg.engineId] || {}, msg.engine)
        : (cfg.engines || {})[msg.engineId];

      if (!engine) {
        return { ok: false, error: '找不到该引擎配置' };
      }
      if (!engine.baseUrl) {
        return { ok: false, error: '请先填写 Base URL' };
      }

      var probe = 'Hello world';
      return withSlot(function () {
        return IMT.engines.dispatch(engine, [probe], {
          sourceLang: 'auto',
          targetLang: cfg.targetLang || 'zh-Hans',
          glossary: [],
          scenario: cfg.scenario || 'general',
          customScenarios: cfg.customScenarios || {}
        });
      }).then(function (out) {
        var text = (out && out[0]) || '';
        if (!text) return { ok: false, error: '接口返回空内容' };
        return { ok: true, text: text, model: engine.model || '' };
      }, function (err) {
        return { ok: false, error: String((err && err.message) || err) };
      });
    }).catch(function (err) {
      return { ok: false, error: String((err && err.message) || err) };
    });
  }

  /* ------------------------------------------------------------------ *
   * 消息路由
   * ------------------------------------------------------------------ */

  var pendingRequests = new Map();
  function requestKey(msg, sender) {
    return [(sender.tab && sender.tab.id) || '', sender.frameId || 0, msg.requestId].join(':');
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return false;

    switch (msg.type) {
      case 'IMT_TRANSLATE':
      case 'IMT_STUDY_SENTENCE':
      case 'IMT_STUDY_WORD':
        var controller = new AbortController();
        var key = requestKey(msg, sender);
        if (msg.requestId) pendingRequests.set(key, controller);
        var job = msg.type === 'IMT_TRANSLATE'
          ? handleTranslate(msg, sender, controller.signal) : handleStudy(msg, controller.signal);
        job.then(function (result) {
          if (msg.requestId) pendingRequests.delete(key);
          sendResponse(result);
        });
        return true;

      case 'IMT_CANCEL_TRANSLATION':
      case 'IMT_CANCEL_STUDY':
        var request = pendingRequests.get(requestKey(msg, sender));
        if (request) request.abort();
        sendResponse({ ok: true });
        return false;

      case 'IMT_STUDY_SAVE':
        saveStudy(msg).then(sendResponse);
        return true;

      case 'IMT_TEST_ENGINE':
        handleTestEngine(msg).then(sendResponse);
        return true;

      case 'IMT_OPEN_OPTIONS':
        chrome.runtime.openOptionsPage(function () {
          var error = chrome.runtime.lastError;
          sendResponse(error ? { ok: false, error: error.message } : { ok: true });
        });
        return true;

      case 'IMT_STATE_REPORT':
        // 内容脚本上报状态，popup 也会直接询问内容脚本，这里仅作记录
        return false;

      case 'IMT_GET_CONFIG':
        loadConfig().then(function (cfg) { sendResponse({ ok: true, config: cfg }); });
        return true;

      case 'IMT_SET_CONFIG':
        loadConfig().then(function (cfg) {
          var next = U.config.applyPatch(cfg, msg.config || {});
          return saveConfig(next).then(function () {
            sendResponse({ ok: true, config: next });
          });
        }).catch(function (err) {
          sendResponse({ ok: false, error: String(err.message || err) });
        });
        return true;

      case 'IMT_RESET_CONFIG':
        saveConfig(U.config.merge({})).then(function () {
          sendResponse({ ok: true, config: U.config.merge({}) });
        });
        return true;

      case 'IMT_PAGE_STATE':
        activeTab().then(function (tab) {
          // popup 会带上它自己定位到的标签页，多窗口下更准确
          var tid = msg.tabId != null ? msg.tabId : (tab && tab.id);
          sendToTab(tid, 'query').then(sendResponse);
        });
        return true;

      case 'IMT_PAGE_ACTION':
        activeTab().then(function (tab) {
          var tid = msg.tabId != null ? msg.tabId : (tab && tab.id);
          sendToTab(tid, msg.action, msg.options || {}).then(sendResponse);
        });
        return true;

      case 'IMT_CLEAR_CACHE':
        IMT.cache.clear().then(function (n) { sendResponse({ ok: true, removed: n }); });
        return true;

      case 'IMT_CACHE_STATS':
        IMT.cache.stats().then(function (s) { sendResponse({ ok: true, stats: s }); });
        return true;

      default:
        return false;
    }
  });

  /* ------------------------------------------------------------------ *
   * 快捷键
   * ------------------------------------------------------------------ */

  chrome.commands.onCommand.addListener(function (command) {
    activeTab().then(function (tab) {
      if (!tab) return;
      if (command === 'toggle-translation') {
        sendToTab(tab.id, 'toggle');
      } else if (command === 'translate-page') {
        sendToTab(tab.id, 'start');
      } else if (command === 'restore-page') {
        sendToTab(tab.id, 'stop');
      }
    });
  });

  /* ------------------------------------------------------------------ *
   * 右键菜单
   * ------------------------------------------------------------------ */

  var creatingMenus = false;
  function createMenus() {
    if (creatingMenus) return;
    creatingMenus = true;
    try {
      chrome.contextMenus.removeAll(function () {
        void chrome.runtime.lastError;
        var menus = [
          ['imtl-translate', '翻译本页（双语对照）'], ['imtl-restore', '还原本页'],
          ['imtl-translation-only', '仅显示译文'], ['imtl-original-only', '仅显示原文']
        ];
        var pending = menus.length;
        menus.forEach(function (menu) {
          chrome.contextMenus.create({ id: menu[0], title: menu[1], contexts: ['page'] }, function () {
            void chrome.runtime.lastError;
            if (!--pending) creatingMenus = false;
          });
        });
      });
    } catch (e) { creatingMenus = false; }
  }

  if (chrome.contextMenus) {
    chrome.runtime.onInstalled.addListener(createMenus);
    chrome.runtime.onStartup.addListener(createMenus);
    chrome.contextMenus.onClicked.addListener(function (info, tab) {
      if (!tab) return;
      switch (info.menuItemId) {
        case 'imtl-translate': sendToTab(tab.id, 'start'); break;
        case 'imtl-restore': sendToTab(tab.id, 'stop'); break;
        case 'imtl-translation-only': sendToTab(tab.id, 'setMode', { mode: 'translation' }); break;
        case 'imtl-original-only': sendToTab(tab.id, 'setMode', { mode: 'original' }); break;
      }
    });
  }
})();
