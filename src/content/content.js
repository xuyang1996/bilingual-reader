/*!
 * Bilingual Reader — 内容脚本入口
 *
 * 职责：
 *  1. 读取配置、解析站点规则
 *  2. 注入翻译传输层（转发到 background service worker）
 *  3. 启动/停止管线，响应 popup、快捷键、右键菜单的指令
 *  4. 增量翻译（MutationObserver）
 */
(function () {
  'use strict';

  var IMT = globalThis.IMT;
  if (!IMT || !IMT.pipeline) return;
  var U = IMT.utils;

  var controller = null;
  var currentConfig = null;
  var currentMode = 'none';
  var currentLang = null;
  var lastError = null;

  /* ------------------------------------------------------------------ *
   * 配置
   * ------------------------------------------------------------------ */

  function loadConfig() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(IMT.STORAGE_KEY, function (data) {
          if (chrome.runtime.lastError) {
            resolve(U.config.merge({}));
            return;
          }
          var saved = (data && data[IMT.STORAGE_KEY]) || {};
          resolve(U.config.merge(saved));
        });
      } catch (e) {
        resolve(U.config.merge({}));
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * 传输层：把翻译请求转发给 background
   * ------------------------------------------------------------------ */

  function installTransport() {
    IMT.client.setTransport(function (texts, req) {
      return new Promise(function (resolve, reject) {
        try {
          chrome.runtime.sendMessage({
            type: 'IMT_TRANSLATE',
            texts: texts,
            sourceLang: req.sourceLang,
            targetLang: req.targetLang,
            engineId: req.engineId
          }, function (res) {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message || '后台通信失败'));
              return;
            }
            if (!res) {
              reject(new Error('后台无响应'));
              return;
            }
            if (!res.ok) {
              var err = new Error(res.error || '翻译失败');
              err.code = res.code;
              err.status = res.status;
              err.fatal = !!res.fatal;
              reject(err);
              return;
            }
            resolve({ texts: res.texts || [], errors: res.errors || [] });
          });
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * 启动 / 停止
   * ------------------------------------------------------------------ */

  function resolveRule(cfg, url) {
    var res = IMT.rules.resolve(cfg, url);
    return res.rule;
  }

  function startTranslation(opts) {
    var options = opts || {};
    return loadConfig().then(function (cfg) {
      currentConfig = cfg;
      if (options.targetLang) {
        cfg.targetLang = options.targetLang;
        cfg.generalRule = cfg.generalRule || {};
        cfg.generalRule.targetLang = options.targetLang;
      }
      if (options.engineId) cfg.engine = options.engineId;

      var rule = resolveRule(cfg, location.href);
      if (options.targetLang) rule.targetLang = options.targetLang;
      if (options.mode) rule.translationMode = options.mode;
      currentLang = rule.targetLang || cfg.targetLang;

      if (controller) controller.stop();

      controller = IMT.pipeline.create({
        root: document.body || document.documentElement,
        rule: rule,
        config: cfg,
        engineId: cfg.engine,
        lazy: cfg.lazy !== false,
        onProgress: function (stats) {
          currentMode = stats.mode === 'none' ? 'none' : 'translated';
          reportState(stats);
        }
      });

      IMT.render.setMode(rule.translationMode || 'dual');
      controller.start();
      lastError = null;
      return reportState(controller.getStats());
    }).catch(function (err) {
      lastError = String((err && err.message) || err);
      return { ok: false, error: lastError };
    });
  }

  function stopTranslation() {
    if (controller) {
      controller.stop();
      controller = null;
    }
    IMT.render.setMode('none');
    currentMode = 'none';
    return reportState({ mode: 'none', count: 0 });
  }

  function toggle() {
    if (controller && !controller.isStopped()) return stopTranslation();
    return startTranslation();
  }

  function setMode(mode) {
    if (!controller) return { ok: false, error: '页面尚未翻译' };
    controller.setMode(mode);
    currentMode = mode;
    return reportState(controller.getStats());
  }

  function setLang(lang) {
    return startTranslation({ targetLang: lang });
  }

  function setEngine(engineId) {
    return startTranslation({ engineId: engineId });
  }

  /* ------------------------------------------------------------------ *
   * 状态回报
   * ------------------------------------------------------------------ */

  function reportState(stats) {
    var state = {
      ok: true,
      state: currentMode,
      mode: IMT.render.getMode(),
      lang: currentLang,
      engine: currentConfig ? currentConfig.engine : null,
      count: stats && typeof stats.count === 'number' ? stats.count : IMT.render.count(document),
      done: stats ? stats.done : 0,
      total: stats ? stats.total : 0,
      failed: stats ? stats.failed : 0,
      pending: stats ? stats.pending : 0,
      error: (stats && stats.failed && stats.lastError) || lastError
    };
    try {
      chrome.runtime.sendMessage({ type: 'IMT_STATE_REPORT', payload: state }, function () {
        void chrome.runtime.lastError;
      });
    } catch (e) { /* ignore */ }
    return state;
  }

  /* ------------------------------------------------------------------ *
   * 消息路由
   * ------------------------------------------------------------------ */

  function handle(msg) {
    if (!msg || msg.target !== 'imtl-content') return;
    // background 统一把参数放在 msg.options 里，这里同时兼容扁平写法
    var opts = msg.options || {};
    switch (msg.action) {
      case 'start':
        return startTranslation(opts);
      case 'stop':
        return stopTranslation();
      case 'toggle':
        return toggle();
      case 'retry':
        if (!controller) return startTranslation();
        lastError = null;
        controller.retryFailed();
        return reportState(controller.getStats());
      case 'setMode':
        return setMode(opts.mode || msg.mode);
      case 'setLang':
        return setLang(opts.lang || msg.lang);
      case 'setEngine':
        return setEngine(opts.engineId || msg.engineId);
      case 'query':
        return reportState(controller ? controller.getStats() : { mode: 'none', count: 0 });
      default:
        return { ok: false, error: '未知指令: ' + msg.action };
    }
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || msg.target !== 'imtl-content') return false;
      var result;
      try {
        result = handle(msg);
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
        return false;
      }
      // handle() 对异步指令返回 Promise，必须等结果落地再回给调用方，
      // 否则 popup 会收到一个无法序列化的 Promise 而误报「操作失败」
      if (result && typeof result.then === 'function') {
        result.then(
          function (r) { sendResponse(r || { ok: true }); },
          function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
        );
        return true; // 保持消息通道，等待异步响应
      }
      sendResponse(result);
      return false;
    });
  }

  /* ------------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------------ */

  function boot() {
    installTransport();
    loadConfig().then(function (cfg) {
      currentConfig = cfg;
      if (cfg.autoTranslate) {
        setTimeout(function () { startTranslation(); }, 300);
      }
      reportState({ mode: 'none', count: 0 });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
