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
  var MAX_ACTIVE = 8;
  var waiters = [];

  function release() {
    active--;
    if (active < MAX_ACTIVE && waiters.length) {
      var fn = waiters.shift();
      fn();
    }
  }

  function withSlot(fn) {
    return new Promise(function (resolve, reject) {
      var run = function () {
        active++;
        var p;
        try {
          p = Promise.resolve(fn());
        } catch (e) {
          p = Promise.reject(e);
        }
        p.then(resolve, reject).then(release, release);
      };
      if (active < MAX_ACTIVE) run();
      else waiters.push(run);
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

  function handleTranslate(msg, sender) {
    return loadConfig().then(function (cfg) {
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
            sourceLang: sourceLang,
            targetLang: targetLang,
            glossary: cfg.glossary || [],
            scenario: scenario,
            customScenarios: cfg.customScenarios || {}
          });
        });
      };

      if (!useCache) {
        return callEngine(texts).then(function (out) {
          return { ok: true, texts: out };
        });
      }

      var keys = texts.map(function (t) {
        return IMT.cache.key(t, sourceLang, targetLang, engineId);
      });

      return IMT.cache.getMany(keys).then(function (cached) {
        var result = new Array(texts.length);
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
          var toCache = {};
          missingIdx.forEach(function (idx, i) {
            var val = (translated && typeof translated[i] === 'string' && translated[i]) ? translated[i] : '';
            result[idx] = val;
            if (val) toCache[keys[idx]] = val;
          });
          return IMT.cache.setMany(toCache).then(function () {
            return { ok: true, texts: result };
          });
        });
      });
    }).catch(function (err) {
      var msg = String((err && err.message) || err);
      if (err && err.code === 'ENGINE_RATE_LIMIT') {
        msg = '接口暂时不可用（多半是被限流或额度用尽）。可以稍后重试，' +
          '或在设置页换一个引擎 / 调大超时。';
      }
      return { ok: false, error: msg };
    });
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

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return false;

    switch (msg.type) {
      case 'IMT_TRANSLATE':
        handleTranslate(msg, sender).then(sendResponse);
        return true;

      case 'IMT_TEST_ENGINE':
        handleTestEngine(msg).then(sendResponse);
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

  function createMenus() {
    try {
      chrome.contextMenus.removeAll(function () {
        chrome.contextMenus.create({ id: 'imtl-translate', title: '翻译本页（双语对照）', contexts: ['page'] });
        chrome.contextMenus.create({ id: 'imtl-restore', title: '还原本页', contexts: ['page'] });
        chrome.contextMenus.create({ id: 'imtl-translation-only', title: '仅显示译文', contexts: ['page'] });
        chrome.contextMenus.create({ id: 'imtl-original-only', title: '仅显示原文', contexts: ['page'] });
      });
    } catch (e) { /* ignore */ }
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
