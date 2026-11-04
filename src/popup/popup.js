/*!
 * Bilingual Reader — Popup 控制面板
 */
(function () {
  'use strict';

  var IMT = globalThis.IMT;
  var U = IMT.utils;

  function $(id) { return document.getElementById(id); }

  var config = null;
  var page = null;
  var currentTabId = null;
  var floatingEnabled = true;

  function renderFloating(prefs) {
    if (Object.prototype.hasOwnProperty.call(prefs, 'enabled')) floatingEnabled = prefs.enabled;
    $('floatingToggle').textContent = floatingEnabled ? '隐藏网页浮签' : '显示网页浮签';
    $('floatingToggle').setAttribute('aria-pressed', floatingEnabled ? 'true' : 'false');
  }

  /** 是否运行在扩展环境里；否则进入离线预览模式 */
  var HAS_CHROME = (typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.sendMessage);

  /* ---------------- 与后台通信 ---------------- */

  /** 离线预览：模拟后台返回，便于直接在浏览器里打开 popup.html 看界面 */
  function mockSend(msg) {
    return new Promise(function (resolve) {
      if (!msg) return resolve({ ok: false, error: '无效请求' });
      if (msg.type === 'IMT_GET_CONFIG') {
        return resolve({ ok: true, config: U.config.merge({}) });
      }
      if (msg.type === 'IMT_SET_CONFIG') {
        var merged = U.config.applyPatch(config || {}, msg.config || {});
        return resolve({ ok: true, config: merged });
      }
      if (msg.type === 'IMT_PAGE_STATE') {
        return resolve({
          ok: true, state: 'none', mode: 'dual', lang: (config && config.targetLang) || 'zh-Hans',
          count: 0, done: 0, total: 0, failed: 0, error: null
        });
      }
      if (msg.type === 'IMT_PAGE_ACTION') {
        if (msg.action === 'stop') {
          return resolve({ ok: true, state: 'none', mode: 'none', count: 0, done: 0, failed: 0 });
        }
        return resolve({
          ok: true, state: 'translated', mode: (msg.options && msg.options.mode) || 'dual',
          lang: (config && config.targetLang) || 'zh-Hans', count: 18, done: 18, total: 18, failed: 0
        });
      }
      resolve({ ok: true });
    });
  }

  function send(msg) {
    if (!HAS_CHROME) return mockSend(msg);
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || { ok: false, error: '后台无响应' });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e.message || e) });
      }
    });
  }

  function loadConfig() {
    return send({ type: 'IMT_GET_CONFIG' }).then(function (res) {
      config = res && res.ok ? res.config : U.config.merge({});
      return config;
    });
  }

  function saveConfig(patch) {
    return send({ type: 'IMT_SET_CONFIG', config: patch }).then(function (res) {
      if (res && res.ok) config = res.config;
      return res;
    });
  }

  /* ---------------- 渲染 ---------------- */

  function renderLanguages() {
    var sel = $('lang');
    sel.innerHTML = '';
    IMT.LANGUAGES.forEach(function (l) {
      if (l.code === 'auto') return;
      var opt = document.createElement('option');
      opt.value = l.code;
      opt.textContent = l.label;
      sel.appendChild(opt);
    });
    sel.value = config.targetLang || 'zh-Hans';
  }

  function renderEngines() {
    var sel = $('engine');
    sel.innerHTML = '';
    var ids = Object.keys(config.engines || {});
    if (!ids.length) {
      var none = document.createElement('option');
      none.value = '';
      none.textContent = '（还没有配置引擎）';
      sel.appendChild(none);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    ids.forEach(function (id) {
      var e = config.engines[id];
      var opt = document.createElement('option');
      opt.value = id;
      var ready = U.engineReady(e);
      opt.textContent = (e.name || e.model || id) + (ready ? '' : '（未配置）');
      if (!ready) opt.dataset.unready = '1';
      sel.appendChild(opt);
    });
    sel.value = (config.engine && config.engines[config.engine]) ? config.engine : ids[0];
  }

  /** 当前是否有可用的引擎 */
  function readyEngineId() {
    return U.pickReadyEngine(config);
  }

  /** 当前用的是不是演示引擎（本地示例，不联网） */
  function isDemoEngine() {
    var e = config.engines[config.engine];
    return !!(e && e.format === 'demo');
  }

  /**
   * 引擎没配好时的强制提醒：
   * 翻译按钮禁用 + 顶部醒目横幅 + 一键跳设置页。
   */
  function renderConfigState() {
    var ready = readyEngineId();
    var notice = $('notice');
    var toggle = $('toggle');
    var demo = $('demoNotice');

    if (demo) demo.classList.toggle('show', isDemoEngine());

    if (ready) {
      notice.classList.remove('show');
      toggle.disabled = false;
      toggle.title = '';
      // 当前选中的引擎没配好，但别的配好了 → 翻译时自动改用配好的那个，
      // 但不偷偷改掉用户的选择，只提示一句。
      var cur = config.engines[config.engine];
      if (cur && !U.engineReady(cur)) {
        var alt = config.engines[ready];
        renderStatus('「' + (cur.name || cur.model || config.engine) + '」没配好，' +
          '翻译时改用「' + (alt.name || alt.model || ready) + '」', false);
      }
      return;
    }

    notice.classList.add('show');
    toggle.disabled = true;
    toggle.title = '请先配置翻译引擎';
  }

  /** 当前场景名 */
  function renderScenario() {
    var sc = IMT.prompts && IMT.prompts.get(config.scenario, config.customScenarios);
    $('scenarioName').textContent = sc ? sc.name : '通用';
  }

  function renderMode(mode) {
    var btns = $('modes').querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].getAttribute('data-mode') === mode);
    }
  }

  function renderStatus(text, isError) {
    var box = $('status');
    box.textContent = text;
    box.classList.toggle('err', !!isError);
  }

  function renderPage(state) {
    page = state || {};
    var translated = page.state === 'translated';
    $('pause').textContent = page.paused ? '继续' : '暂停';
    $('pause').disabled = !translated || (!page.paused && !page.canPause);
    $('pause').setAttribute('aria-pressed', page.paused ? 'true' : 'false');
    $('retranslate').disabled = !readyEngineId();
    $('retry').hidden = !page.failed;
    $('retry').disabled = !!page.pending || !!page.paused;
    $('toggle').textContent = translated ? '还原本页' : '翻译此页';
    if (page.error) {
      renderStatus('已译 ' + (page.done || 0) + ' 段 · 失败 ' + (page.failed || 0) + '。' + page.error, true);
    } else if (translated) {
      var bits = [];
      if (typeof page.done === 'number') bits.push('已译 ' + page.done + ' 段');
      if (typeof page.failed === 'number' && page.failed) bits.push('失败 ' + page.failed);
      if (page.paused) bits.push('已暂停 · 点击继续，从上一段接着翻译');
      renderStatus(bits.length ? bits.join(' · ') : '翻译中…', false);
    } else {
      renderStatus('尚未翻译 · 点击上方按钮开始', false);
    }
    renderMode(page.mode || 'dual');
    if (page.lang) $('lang').value = page.lang;
  }

  /* ---------------- 动作 ---------------- */

  /** 定位用户正在看的标签页，避免多窗口下指令打到别的页面 */
  function activeTabId() {
    return new Promise(function (resolve) {
      if (!HAS_CHROME || !chrome.tabs || !chrome.tabs.query) return resolve(null);
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          currentTabId = tabs && tabs[0] ? tabs[0].id : null;
          resolve(currentTabId);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  /**
   * 订阅内容脚本的进度上报。
   * 翻译是异步的：点下按钮后 popup 先拿到的是「开始翻译」的快照，
   * 真正译了多少段要靠内容脚本持续回报，否则面板会一直显示「已译 0 段」。
   */
  function listenForProgress() {
    if (!HAS_CHROME || !chrome.runtime || !chrome.runtime.onMessage) return;
    chrome.runtime.onMessage.addListener(function (msg, sender) {
      if (!msg || msg.type !== 'IMT_STATE_REPORT') return;
      if (currentTabId != null && sender && sender.tab && sender.tab.id !== currentTabId) return;
      renderPage(msg.payload);
    });
  }

  function queryPage() {
    return activeTabId().then(function (tabId) {
      return send({ type: 'IMT_PAGE_STATE', tabId: tabId });
    }).then(function (res) {
      if (res && res.ok) {
        renderPage(res);
      } else {
        renderPage({ state: 'none' });
        renderStatus('无法与页面通信（可能是浏览器内置页面）', true);
      }
    });
  }

  function pageAction(action, options) {
    return activeTabId().then(function (tabId) {
      return send({
        type: 'IMT_PAGE_ACTION',
        action: action,
        tabId: tabId,
        options: options || {}
      });
    });
  }

  function togglePage() {
    if (!readyEngineId()) {
      renderStatus('尚未配置翻译引擎，无法翻译。请先在设置页填好 API Key。', true);
      return Promise.resolve({ ok: false, error: '尚未配置翻译引擎' });
    }
    renderStatus('处理中…');
    return pageAction('toggle').then(function (res) {
      if (res && res.ok) renderPage(res);
      else renderStatus((res && res.error) || '操作失败', true);
      return res;
    });
  }

  function changeMode(mode) {
    renderMode(mode);
    if (page && page.state === 'translated') {
      return pageAction('setMode', { mode: mode })
        .then(function (res) {
          if (res && res.ok) renderPage(res);
          else renderStatus((res && res.error) || '切换失败', true);
        });
    }
    return pageAction('start', { mode: mode })
      .then(function (res) {
        if (res && res.ok) renderPage(res);
        else renderStatus((res && res.error) || '翻译失败', true);
      });
  }

  function changeLang(lang) {
    renderStatus('正在切换语言…');
    return saveConfig({ targetLang: lang }).then(function () {
      renderLanguages();
      if (page && page.state === 'translated') {
        return pageAction('setLang', { lang: lang })
          .then(function (res) {
            if (res && res.ok) renderPage(res);
            else renderStatus((res && res.error) || '切换语言失败', true);
          });
      }
      renderStatus('目标语言已切换为 ' + langLabel(lang), false);
    });
  }

  function changeEngine(engineId) {
    renderStatus('正在切换引擎…');
    return saveConfig({ engine: engineId }).then(function () {
      renderEngines();
      renderConfigState();
      if (page && page.state === 'translated') {
        return pageAction('setEngine', { engineId: engineId })
          .then(function (res) {
            if (res && res.ok) renderPage(res);
            else renderStatus((res && res.error) || '切换引擎失败', true);
          });
      }
      renderStatus('翻译引擎已切换', false);
    });
  }

  function langLabel(code) {
    var found = IMT.LANGUAGES.filter(function (l) { return l.code === code; })[0];
    return found ? found.label : code;
  }

  /* ---------------- 绑定 ---------------- */

  document.addEventListener('DOMContentLoaded', function () {
    $('ver').textContent = 'v' + IMT.VERSION;
    listenForProgress();
    U.floatingPrefs.read().then(renderFloating);
    var stopWatchingFloating = U.floatingPrefs.watch(renderFloating);
    window.addEventListener('unload', stopWatchingFloating, { once: true });
    $('floatingToggle').addEventListener('click', function () {
      var enabled = !floatingEnabled;
      $('floatingToggle').disabled = true;
      U.floatingPrefs.write({ enabled: enabled }).then(function () {
        renderFloating({ enabled: enabled });
        $('floatingToggle').disabled = false;
      }, function (err) {
        $('floatingToggle').disabled = false;
        renderStatus(err.message || '浮签设置保存失败', true);
      });
    });

    loadConfig().then(function () {
      renderLanguages();
      renderEngines();
      renderScenario();
      renderConfigState();
      return queryPage();
    });

    $('toggle').addEventListener('click', togglePage);
    function controlTranslation(action) {
      $('pause').disabled = true;
      $('retranslate').disabled = true;
      return pageAction(action).then(function (res) {
        if (res && res.ok) renderPage(res);
        else {
          renderPage(page);
          renderStatus((res && res.error) || '操作失败', true);
        }
      });
    }
    $('pause').addEventListener('click', function () {
      controlTranslation(page && page.paused ? 'resume' : 'pause');
    });
    $('retranslate').addEventListener('click', function () { controlTranslation('retranslate'); });
    $('retry').addEventListener('click', function () {
      $('retry').disabled = true;
      pageAction('retry').then(function (res) {
        if (res && res.ok) renderPage(res);
        else renderStatus((res && res.error) || '重试失败', true);
      });
    });

    $('noticeConfig').addEventListener('click', openOptions);

    $('modes').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button[data-mode]') : null;
      if (!btn) return;
      changeMode(btn.getAttribute('data-mode'));
    });

    $('lang').addEventListener('change', function () { changeLang(this.value); });
    $('engine').addEventListener('change', function () { changeEngine(this.value); });

    $('options').addEventListener('click', openOptions);
  });

  function openOptions() {
    if (!HAS_CHROME) {
      window.open('../options/options.html', '_blank');
      return;
    }
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html') });
    window.close();
  }
})();
