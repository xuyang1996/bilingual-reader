/*!
 * Bilingual Reader — 设置页
 */
(function () {
  'use strict';

  var IMT = globalThis.IMT;
  var U = IMT.utils;

  function $(id) { return document.getElementById(id); }

  var config = null;
  var toastTimer = null;

  /** 是否运行在扩展环境里；否则进入离线预览模式 */
  var HAS_CHROME = (typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.sendMessage);

  /* ---------------- 通信 ---------------- */

  /** 离线预览：模拟后台返回，便于直接在浏览器里打开 options.html 看界面 */
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
      if (msg.type === 'IMT_RESET_CONFIG') {
        return resolve({ ok: true, config: U.config.merge({}) });
      }
      if (msg.type === 'IMT_CACHE_STATS') {
        return resolve({ ok: true, stats: { count: 214, bytes: 184320, oldest: Date.now() - 86400000 } });
      }
      if (msg.type === 'IMT_TEST_ENGINE') {
        return resolve({ ok: true, text: '你好世界（离线预览，未真正联网）', model: '' });
      }
      if (msg.type === 'IMT_CLEAR_CACHE') {
        return resolve({ ok: true, removed: 214 });
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

  function toast(text, isError) {
    var box = $('toast');
    box.textContent = text;
    box.style.background = isError ? 'var(--danger)' : 'var(--fg)';
    box.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.classList.remove('show'); }, 2200);
  }

  /* ---------------- 加载 / 保存 ---------------- */

  function loadConfig() {
    return send({ type: 'IMT_GET_CONFIG' }).then(function (res) {
      config = (res && res.ok) ? res.config : U.config.merge({});
      render();
      return config;
    });
  }

  /**
   * 保存配置。
   * @param {object} [opts] strict=false 时，引擎表单里没写完的 JSON 不阻塞保存
   */
  function persist(opts) {
    var next;
    try {
      next = collect(!(opts && opts.strict === false));
    } catch (err) {
      var msg = String((err && err.message) || err);
      toast(msg, true);
      return Promise.resolve({ ok: false, error: msg });
    }
    return send({ type: 'IMT_SET_CONFIG', config: next }).then(function (res) {
      if (res && res.ok) {
        config = res.config;
        render();
        toast('已保存');
      } else {
        toast((res && res.error) || '保存失败', true);
      }
      return res;
    });
  }

  /* ---------------- 侧边栏导航 ---------------- */

  var CURRENT_PANEL = 'engines';

  function showPanel(name) {
    CURRENT_PANEL = name;
    var panels = document.querySelectorAll('section.panel');
    for (var i = 0; i < panels.length; i++) {
      var p = panels[i];
      p.hidden = p.getAttribute('data-panel') !== name;
    }
    var btns = document.querySelectorAll('#sidebar button[data-panel]');
    for (var j = 0; j < btns.length; j++) {
      btns[j].classList.toggle('on', btns[j].getAttribute('data-panel') === name);
    }
    try {
      sessionStorage.setItem('imtl.panel', name);
    } catch (e) { /* ignore */ }
    window.scrollTo(0, 0);
  }

  /* ---------------- 引擎选项 ---------------- */

  var FORMAT_OPTIONS = [
    { value: 'openai', label: 'OpenAI 兼容（DeepSeek / Kimi / 通义 / 智谱 / Ollama…）' },
    { value: 'anthropic', label: 'Anthropic Messages（Claude）' },
    { value: 'gemini', label: 'Google Gemini（generateContent）' },
    { value: 'custom', label: '自定义（自己写请求体 + 指定响应字段）' },
    { value: 'demo', label: '演示模式（本地示例，不联网、不需要 Key）' }
  ];

  var AUTH_OPTIONS = [
    { value: 'auto', label: '自动（Bearer → x-api-key → api-key）' },
    { value: 'bearer', label: 'Bearer（Authorization: Bearer …）' },
    { value: 'x-api-key', label: 'x-api-key（Anthropic 风格）' },
    { value: 'api-key', label: 'api-key（Azure 风格）' },
    { value: 'query', label: 'URL 参数（?key=…）' },
    { value: 'none', label: '无（本地模型 / 自建网关）' }
  ];

  var SYSTEM_ROLE_OPTIONS = [
    { value: '', label: '默认（按模型自动判断）' },
    { value: 'system', label: 'system（绝大多数模型）' },
    { value: 'developer', label: 'developer（OpenAI o 系列）' },
    { value: 'user', label: '拼进 user 消息（模型不支持 system 角色时）' }
  ];

  /** 数值型字段 */
  var ENGINE_NUM_FIELDS = { batchSize: 1, timeout: 1, temperature: 1, maxTokens: 1 };
  /** JSON 型字段 */
  var ENGINE_JSON_FIELDS = { headers: 1, extraBody: 1 };

  /* ---------------- 引擎：选择器 + 单表单 ---------------- */

  /** 新建引擎时下拉里的取值前缀，形如 "__new__:openai" */
  var NEW_PREFIX = '__new__:';
  /** 当前正在查看 / 编辑的引擎 id */
  var SELECTED_ENGINE_ID = null;

  function presetById(pid) {
    if (!pid) return null;
    return (IMT.PROVIDER_PRESETS || []).filter(function (p) { return p.id === pid; })[0] || null;
  }

  /**
   * 引擎在列表里的显示名。
   * 预设引擎用「模型名」，完全自定义的引擎用用户自己起的名字。
   */
  function engineLabel(e, id) {
    if (!e) return id || '';
    if (e.name) return e.name;
    if (e.model) return e.model;
    var p = presetById(e.presetId);
    return p ? p.name : (id || '未命名引擎');
  }

  /** 「选择翻译引擎」下拉 */
  function renderEnginePicker() {
    var sel = $('enginePicker');
    sel.innerHTML = '';

    var blank = document.createElement('option');
    blank.value = '';
    blank.textContent = '— 选择一个翻译引擎 —';
    sel.appendChild(blank);

    var ids = Object.keys(config.engines || {}).sort(function (a, b) {
      var ea = config.engines[a] || {};
      var eb = config.engines[b] || {};
      var sa = Number(ea.seq) || 0;
      var sb = Number(eb.seq) || 0;
      if (sa !== sb) return sa - sb;
      return String(engineLabel(ea, a)).localeCompare(String(engineLabel(eb, b)));
    });
    if (ids.length) {
      var g1 = document.createElement('optgroup');
      g1.label = '已配置的引擎';
      ids.forEach(function (id) {
        var e = config.engines[id];
        var opt = document.createElement('option');
        opt.value = id;
        opt.textContent = engineLabel(e, id) + (U.engineReady(e) ? '' : '（未配置）');
        g1.appendChild(opt);
      });
      sel.appendChild(g1);
    }

    var g2 = document.createElement('optgroup');
    g2.label = '添加新引擎';
    (IMT.PROVIDER_PRESETS || []).forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = NEW_PREFIX + p.id;
      opt.textContent = p.name;
      g2.appendChild(opt);
    });
    var custom = document.createElement('option');
    custom.value = NEW_PREFIX + '__custom__';
    custom.textContent = '完全自定义（空白配置）';
    g2.appendChild(custom);
    sel.appendChild(g2);

    sel.value = (SELECTED_ENGINE_ID && config.engines[SELECTED_ENGINE_ID]) ? SELECTED_ENGINE_ID : '';
    updatePickerHint();
  }

  /** 下拉下面的说明文字 */
  function updatePickerHint() {
    var hint = $('enginePickerHint');
    var id = SELECTED_ENGINE_ID;
    var e = id ? config.engines[id] : null;
    if (!e) {
      hint.textContent = '选一个引擎，下方会显示它的配置表单。可以配置多个引擎，随时切换。';
      return;
    }
    var tip;
    if (e.custom) {
      tip = '完全自定义引擎：名字可以自己改，但不能和别的引擎重名。';
    } else {
      var p = presetById(e.presetId);
      tip = '「' + (p ? p.name : '预设') + '」引擎：名字直接取模型名；想自己起名字请选「完全自定义」。';
    }
    if (!U.engineReady(e)) {
      tip += ' 这个引擎还没配好（缺 API Key，或地址不是本机）。';
    }
    hint.textContent = tip;
  }

  /** 只更新下拉里某一个选项的文字，不打断用户正在输入的地方 */
  function refreshEngineOption(id) {
    var sel = $('enginePicker');
    var e = config.engines[id];
    if (!e || !sel) return;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === id) {
        sel.options[i].textContent = engineLabel(e, id) + (U.engineReady(e) ? '' : '（未配置）');
        return;
      }
    }
  }

  /**
   * 引擎在列表里的排序序号。
   *
   * chrome.storage 会把对象键按字母序重排，只靠 Object.keys 拿不到用户
   * 创建引擎的先后顺序，所以给每个引擎记一个 seq。
   */
  function nextSeq() {
    var max = 0;
    Object.keys(config.engines || {}).forEach(function (id) {
      var s = Number((config.engines[id] || {}).seq) || 0;
      if (s > max) max = s;
    });
    return max + 1;
  }

  /** 引擎 id 不能撞车 */
  function uniqueEngineId(base) {
    var id = base;
    var n = 1;
    while (config.engines && config.engines[id]) {
      n += 1;
      id = base + '-' + n;
    }
    return id;
  }

  /**
   * 新建一个引擎。
   *
   * 表单一律从空白开始（"没有配置就展示为空"），
   * 预设的推荐地址 / 路径 / 模型放在 placeholder 与提示里，不写进配置。
   */
  function createEngine(presetId) {
    var preset = presetById(presetId);
    var tpl = IMT.ENGINE_PRESETS['openai-compatible'] || {};
    var id, engine;

    if (preset) {
      id = uniqueEngineId(preset.id);
      engine = Object.assign({}, tpl, {
        id: id,
        name: '',
        type: 'ai',
        format: preset.format || 'openai',
        baseUrl: '',
        path: '',
        model: '',
        key: '',
        auth: preset.auth || 'auto',
        queryKey: 'key',
        responsePath: preset.responsePath || '',
        custom: false,
        presetId: preset.id
      });
    } else {
      id = uniqueEngineId('custom');
      engine = Object.assign({}, tpl, {
        id: id,
        name: '',
        type: 'ai',
        format: 'openai',
        baseUrl: '',
        path: '',
        model: '',
        key: '',
        auth: 'auto',
        queryKey: 'key',
        responsePath: '',
        custom: true
      });
    }

    config.engines = config.engines || {};
    config.engines[id] = engine;
    engine.seq = nextSeq();
    SELECTED_ENGINE_ID = id;
    config.engine = id;
    return engine;
  }

  /** 刷新当前引擎卡片的状态标签（填了 Key 就要马上变成「已就绪」） */
  function refreshEngineStatus(id) {
    var e = config.engines[id];
    if (!e) return;
    var ready = U.engineReady(e);
    var tag = $('engineForm').querySelector('.engine-head .tag');
    if (tag) {
      tag.className = 'tag' + (ready ? '' : ' bad');
      tag.textContent = ready ? '已就绪' : '未填 API Key';
    }
    var card = $('engineForm').querySelector('.engine-card');
    if (card) card.className = 'engine-card' + (ready ? '' : ' unready');
  }

  /** 引擎没配好时的横幅 + 侧边栏红点 */
  function renderEngineBanner() {
    var ready = U.pickReadyEngine(config);
    var banner = $('engineBanner');
    var badge = $('badgeEngines');
    var cur = config.engines[config.engine];

    if (!ready) {
      banner.hidden = false;
      banner.classList.remove('warn', 'ok');
      $('engineBannerTitle').textContent = '还不能翻译。';
      $('engineBannerText').textContent =
        '一个可用的引擎都还没有。在上面选一个引擎，填上 API Key（本地模型如 Ollama 可以选「无」鉴权），否则无法翻译。';
      badge.hidden = false;
      return;
    }

    badge.hidden = true;

    // 当前选中的没配好，但别的配好了：提醒一句，但不拦着
    if (cur && !U.engineReady(cur)) {
      banner.hidden = false;
      banner.classList.add('warn');
      $('engineBannerTitle').textContent = '注意：';
      $('engineBannerText').textContent =
        '当前选中的「' + engineLabel(cur, config.engine) + '」还没配好，翻译时会自动改用「' +
        engineLabel(config.engines[ready], ready) + '」。';
      return;
    }

    banner.hidden = true;
    banner.classList.remove('warn', 'ok');
  }

  /* ---------------- 引擎表单 ---------------- */

  function renderEngineForm() {
    var host = $('engineForm');
    host.innerHTML = '';

    var id = SELECTED_ENGINE_ID;
    var e = id ? config.engines[id] : null;
    if (!e) {
      var empty = document.createElement('div');
      empty.className = 'engine-empty';
      empty.textContent = '还没有选择引擎。在上面挑一个，下方就会显示它的配置表单。';
      host.appendChild(empty);
      return;
    }

    var ready = U.engineReady(e);
    var card = document.createElement('div');
    card.className = 'engine-card' + (ready ? '' : ' unready');

    // 演示模式：把话说清楚，别让人误以为它在真的翻译
    if (e.format === 'demo') {
      var note = document.createElement('div');
      note.className = 'banner warn demo-note';
      note.innerHTML = '<div><b>演示模式。</b>' +
        '译文完全由本机内置的小词表拼出来，<b>不联网、不需要 API Key</b>，' +
        '用于体验「正文识别 → 双语排版 → 还原」的完整流程；它不是真正的机器翻译。' +
        '要获得真实译文，请在上面另选一个供应商并填上自己的 API Key。</div>';
      card.appendChild(note);
    }

    /* 头部：标题就是引擎名（预设引擎 = 模型名） */
    var head = document.createElement('div');
    head.className = 'engine-head';
    var h3 = document.createElement('h3');
    h3.id = 'engineFormTitle';
    h3.textContent = engineLabel(e, id);
    var tag = document.createElement('span');
    tag.className = 'tag' + (ready ? '' : ' bad');
    tag.textContent = ready ? '已就绪' : '未填 API Key';
    head.appendChild(h3);
    head.appendChild(tag);
    var spacer = document.createElement('span');
    spacer.className = 'spacer';
    head.appendChild(spacer);
    var del = document.createElement('button');
    del.textContent = '删除';
    del.className = 'danger';
    del.setAttribute('data-remove-engine', id);
    head.appendChild(del);
    card.appendChild(head);

    /* 只有完全自定义的引擎才能改名字 */
    if (e.custom) {
      var nameRow = document.createElement('div');
      nameRow.className = 'engine-name-row';
      nameRow.appendChild(field(id, 'name', '引擎名称（不能与其它引擎重名）', e.name, '留空则使用模型名'));
      card.appendChild(nameRow);
      var nh = document.createElement('div');
      nh.className = 'engine-hint-inline';
      nh.textContent = '完全自定义的引擎可以自己起名字；预设引擎的名字固定取模型名。';
      card.appendChild(nh);
    }

    var g1 = document.createElement('div');
    g1.className = 'grid';
    g1.appendChild(engineSelect(id, 'format', '接口格式', e.format || 'openai', FORMAT_OPTIONS));
    g1.appendChild(engineSelect(id, 'auth', '鉴权方式', e.auth || 'auto', AUTH_OPTIONS));
    card.appendChild(g1);

    var g2 = document.createElement('div');
    g2.className = 'grid';
    g2.appendChild(field(id, 'baseUrl', 'Base URL', e.baseUrl, engineHintBaseUrl(e)));
    g2.appendChild(field(id, 'path', '接口路径（留空自动）', e.path, engineHintPath(e)));
    g2.appendChild(field(id, 'model', '模型', e.model, engineHintModel(e)));
    g2.appendChild(field(id, 'key', 'API Key', e.key, '', 'password'));
    g2.appendChild(field(id, 'batchSize', '单次请求条数', e.batchSize, '1', 'number'));
    g2.appendChild(field(id, 'timeout', '超时（秒）', e.timeout, '90', 'number'));
    card.appendChild(g2);

    var adv = document.createElement('details');
    var sum = document.createElement('summary');
    sum.textContent = '高级参数';
    adv.appendChild(sum);

    var g3 = document.createElement('div');
    g3.className = 'grid';
    g3.appendChild(field(id, 'temperature', '温度（0 = 不发送）', e.temperature, '0.2', 'number'));
    g3.appendChild(field(id, 'maxTokens', '最大输出 token（0 = 不发送）', e.maxTokens, '0', 'number'));
    g3.appendChild(field(id, 'responsePath', '响应字段路径', e.responsePath,
      'choices.0.message.content'));
    g3.appendChild(engineSelect(id, 'systemRole', 'system 角色', e.systemRole || '', SYSTEM_ROLE_OPTIONS));
    g3.appendChild(field(id, 'queryKey', 'URL 参数名（query 鉴权）', e.queryKey, 'key'));
    g3.appendChild(engineArea(id, 'headers', '自定义请求头（JSON）',
      e.headers && Object.keys(e.headers).length ? JSON.stringify(e.headers, null, 2) : '',
      '{"X-Trace-Id":"abc"}'));
    g3.appendChild(engineArea(id, 'extraBody', '额外请求体参数（JSON）',
      e.extraBody && Object.keys(e.extraBody).length ? JSON.stringify(e.extraBody, null, 2) : '',
      '{"top_p":0.1}'));
    g3.appendChild(engineArea(id, 'systemPrompt', '自定义系统提示词（留空 = 用「翻译风格」里的场景）',
      e.systemPrompt || '',
      '留空则使用「翻译风格」中选中的场景提示词'));
    adv.appendChild(g3);
    card.appendChild(adv);

    var actions = document.createElement('div');
    actions.className = 'engine-actions';
    var test = document.createElement('button');
    test.textContent = '测试连接';
    test.setAttribute('data-test-engine', id);
    actions.appendChild(test);
    var res = document.createElement('span');
    res.className = 'engine-test-result';
    res.setAttribute('data-test-result', id);
    actions.appendChild(res);
    var save = document.createElement('button');
    save.className = 'primary';
    save.textContent = '保存这个引擎';
    save.setAttribute('data-save-engine', id);
    actions.appendChild(save);
    card.appendChild(actions);

    host.appendChild(card);
  }

  /** 未配置时给用户的推荐值（只当提示，不写进配置） */
  function engineHintBaseUrl(e) {
    if (e.format === 'demo') return '演示模式不需要地址';
    var p = presetById(e.presetId);
    return p && p.baseUrl ? p.baseUrl : 'https://api.example.com/v1';
  }
  function engineHintPath(e) {
    if (e.format === 'demo') return '演示模式不需要路径';
    var p = presetById(e.presetId);
    return p && p.path ? p.path : '/chat/completions';
  }
  function engineHintModel(e) {
    if (e.format === 'demo') return '演示模式';
    var p = presetById(e.presetId);
    return p && p.model ? p.model : 'gpt-4o-mini';
  }

  /**
   * 表单 → 配置。
   *
   * 正常输入时就地同步，切换引擎也不会丢；JSON 字段解析失败时先记下原文，
   * 等保存时再报错，避免用户填到一半就被拦下。
   */
  function syncEngineForm(strict) {
    var id = SELECTED_ENGINE_ID;
    if (!id || !config.engines[id]) return true;
    var e = config.engines[id];
    var nodes = $('engineForm').querySelectorAll('[data-engine="' + id + '"]');
    var ok = true;

    Array.prototype.forEach.call(nodes, function (input) {
      var name = input.getAttribute('data-field');
      if (!name) return;

      if (ENGINE_JSON_FIELDS[name]) {
        var raw = String(input.value || '').trim();
        if (!raw) {
          e[name] = {};
          delete e['_raw_' + name];
          input.classList.remove('invalid');
          input.removeAttribute('title');
          return;
        }
        try {
          e[name] = JSON.parse(raw);
          delete e['_raw_' + name];
          input.classList.remove('invalid');
          input.removeAttribute('title');
        } catch (err) {
          e['_raw_' + name] = raw;
          input.classList.add('invalid');
          input.title = '不是合法 JSON';
          if (strict) {
            throw new Error('引擎「' + engineLabel(e, id) + '」的「' + name + '」不是合法 JSON');
          }
          ok = false;
        }
        return;
      }

      if (ENGINE_NUM_FIELDS[name]) {
        var n = parseFloat(input.value);
        e[name] = isNaN(n) ? 0 : n;
      } else {
        e[name] = input.value;
      }
    });

    return ok;
  }

  /** 引擎名不能重名 */
  function validateEngineNames(engines) {
    var seen = {};
    var ids = Object.keys(engines || {});
    for (var i = 0; i < ids.length; i++) {
      var e = engines[ids[i]] || {};
      var nm = String(e.name || '').trim();
      if (!nm) continue;
      var key = nm.toLowerCase();
      if (seen[key]) {
        return '引擎名「' + nm + '」重复了，请换一个名字（预设引擎请改模型名）。';
      }
      seen[key] = true;
    }
    return null;
  }


  function field(engineId, name, label, value, placeholder, type) {
    var wrap = document.createElement('label');
    wrap.className = 'field';
    var span = document.createElement('span');
    span.textContent = label;
    var input = document.createElement('input');
    input.type = type || 'text';
    input.value = value === undefined || value === null ? '' : value;
    input.placeholder = placeholder || '';
    input.setAttribute('data-engine', engineId);
    input.setAttribute('data-field', name);
    wrap.appendChild(span);
    wrap.appendChild(input);
    return wrap;
  }

  function engineSelect(engineId, name, label, value, options) {
    var wrap = document.createElement('label');
    wrap.className = 'field';
    var span = document.createElement('span');
    span.textContent = label;
    var sel = document.createElement('select');
    sel.setAttribute('data-engine', engineId);
    sel.setAttribute('data-field', name);
    options.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    });
    sel.value = value === undefined || value === null ? '' : value;
    wrap.appendChild(span);
    wrap.appendChild(sel);
    return wrap;
  }

  function engineArea(engineId, name, label, value, placeholder) {
    var wrap = document.createElement('label');
    wrap.className = 'field';
    var span = document.createElement('span');
    span.textContent = label;
    var ta = document.createElement('textarea');
    ta.value = value || '';
    ta.placeholder = placeholder || '';
    ta.setAttribute('data-engine', engineId);
    ta.setAttribute('data-field', name);
    wrap.appendChild(span);
    wrap.appendChild(ta);
    return wrap;
  }

  /**
   * 读取某个引擎在表单上的当前值（返回副本，不动配置）。
   * @throws {Error} JSON 字段非法时抛错
   */
  function readEngineForm(engineId, base) {
    var e = Object.assign({}, base || {});
    var nodes = $('engineForm').querySelectorAll('[data-engine="' + engineId + '"]');
    Array.prototype.forEach.call(nodes, function (input) {
      var name = input.getAttribute('data-field');
      if (!name) return;
      var val;
      if (input.type === 'checkbox') {
        val = input.checked;
      } else if (ENGINE_NUM_FIELDS[name]) {
        val = parseFloat(input.value);
        if (isNaN(val)) val = 0;
      } else if (ENGINE_JSON_FIELDS[name]) {
        var raw = String(input.value || '').trim();
        if (!raw) {
          val = {};
        } else {
          try {
            val = JSON.parse(raw);
          } catch (err) {
            throw new Error('引擎「' + (e.name || engineId) + '」的「' + name + '」不是合法 JSON');
          }
        }
      } else {
        val = input.value;
      }
      e[name] = val;
    });
    return e;
  }

  /* ---------------- 翻译风格（场景） ---------------- */

  /** 当前选中的场景 id */
  function currentScenarioId() {
    return config.scenario || 'general';
  }

  /** 列出全部场景（内置 + 自定义，自定义同 id 覆盖内置） */
  function allScenarios() {
    return IMT.prompts.list(config.customScenarios || {});
  }

  function renderScenarios() {
    var host = $('scenarioList');
    var editor = $('scenarioEditor');
    var cur = currentScenarioId();
    var custom = config.customScenarios || {};

    // 先把编辑区摘出来，等会儿要挪到选中项的正下方
    if (editor && editor.parentNode) editor.parentNode.removeChild(editor);
    host.innerHTML = '';

    var selectedItem = null;

    allScenarios().forEach(function (sc) {
      var item = document.createElement('div');
      item.className = 'scenario-item' + (sc.id === cur ? ' on' : '');
      item.setAttribute('data-scenario', sc.id);

      var radio = document.createElement('span');
      radio.className = 'radio';
      item.appendChild(radio);

      var body = document.createElement('div');
      body.className = 'body';

      var nm = document.createElement('div');
      nm.className = 'nm';
      nm.appendChild(document.createTextNode(sc.name));
      if (!sc.builtin) {
        var chip = document.createElement('span');
        chip.className = 'chip custom';
        chip.textContent = '自定义';
        nm.appendChild(chip);
      } else if (custom[sc.id]) {
        var chip2 = document.createElement('span');
        chip2.className = 'chip edited';
        chip2.textContent = '已改写';
        nm.appendChild(chip2);
      }
      body.appendChild(nm);

      var ds = document.createElement('div');
      ds.className = 'ds';
      ds.textContent = sc.desc || '';
      body.appendChild(ds);

      item.appendChild(body);
      host.appendChild(item);
      if (sc.id === cur) selectedItem = item;
    });

    // 选中的场景下面直接摊开它的表单
    if (editor && selectedItem) {
      host.insertBefore(editor, selectedItem.nextSibling);
    }

    $('autoScenario').checked = config.autoScenario !== false;

    var sel = allScenarios().filter(function (s) { return s.id === cur; })[0];
    $('scenarioHint').textContent = sel ? ('当前：' + sel.name) : '当前：通用';

    renderScenarioEditor();
  }

  /** 场景编辑区 */
  function renderScenarioEditor() {
    var cur = currentScenarioId();
    var sc = IMT.prompts.get(cur, config.customScenarios || {});
    var editor = $('scenarioEditor');
    if (!sc) {
      editor.hidden = true;
      return;
    }
    editor.hidden = false;
    $('scenarioEditorName').textContent = sc.name || cur;
    $('scenarioNameInput').value = sc.name || '';
    $('scenarioDescInput').value = sc.desc || '';
    $('scenarioPromptInput').value = sc.systemPrompt || '';
    $('scenarioMatchesInput').value = (sc.matches || []).join('\n');
    $('scenarioErr').textContent = '';

    var custom = config.customScenarios || {};
    var isCustom = !sc.builtin;
    var edited = !!custom[sc.id];

    $('scenarioReset').hidden = !isCustom;
    $('scenarioRestore').hidden = !(sc.builtin && edited);
  }

  /** 保存当前场景（写入 customScenarios，同 id 覆盖内置） */
  function saveScenario() {
    var cur = currentScenarioId();
    var name = $('scenarioNameInput').value.trim();
    var desc = $('scenarioDescInput').value.trim();
    var prompt = $('scenarioPromptInput').value;
    var matches = $('scenarioMatchesInput').value.split('\n')
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return !!s; });

    if (!name) {
      $('scenarioErr').textContent = '场景名称不能为空';
      return;
    }

    config.customScenarios = config.customScenarios || {};
    var builtin = (IMT.PROMPT_SCENARIOS || []).filter(function (s) { return s.id === cur; })[0];

    // 内置场景：提示词与内置完全一致时视为「没改过」，直接删掉覆盖项
    var sameAsBuiltin = builtin && prompt.trim() === String(builtin.systemPrompt || '').trim();
    if (builtin && sameAsBuiltin) {
      delete config.customScenarios[cur];
    } else {
      config.customScenarios[cur] = {
        id: cur,
        name: name,
        desc: desc,
        systemPrompt: prompt,
        matches: matches
      };
    }
    renderScenarios();
    // 立刻落盘，引擎表单里没写完的 JSON 不该挡住场景保存
    persist({ strict: false });
  }

  /** 恢复内置提示词 */
  function restoreScenario() {
    var cur = currentScenarioId();
    if (config.customScenarios) delete config.customScenarios[cur];
    renderScenarios();
    persist({ strict: false });
    toast('已恢复内置提示词');
  }

  /** 删除自定义场景 */
  function removeScenario() {
    var cur = currentScenarioId();
    if (!config.customScenarios || !config.customScenarios[cur]) return;
    if (!confirm('删除这个自定义场景？')) return;
    delete config.customScenarios[cur];
    config.scenario = 'general';
    renderScenarios();
    persist({ strict: false });
    toast('已删除自定义场景');
  }

  /* ---------------- 渲染 ---------------- */

  /** 保证有一个合法的选中项 */
  function ensureSelection() {
    var ids = Object.keys(config.engines || {});
    if (SELECTED_ENGINE_ID && config.engines[SELECTED_ENGINE_ID]) return;
    SELECTED_ENGINE_ID = (config.engine && config.engines[config.engine])
      ? config.engine
      : (ids[0] || null);
    if (SELECTED_ENGINE_ID) config.engine = SELECTED_ENGINE_ID;
  }

  function render() {
    ensureSelection();
    renderEnginePicker();
    renderEngineForm();
    renderScenarios();
    renderEngineBanner();

    $('ver').textContent = 'v' + IMT.VERSION;

    var th = config.generalRule && config.generalRule.thresholds
      ? config.generalRule.thresholds : {};
    var merged = U.deepMerge({}, IMT.DEFAULT_THRESHOLDS, th);
    ['paragraphMinTextCount', 'mainFrameMinTextCount'].forEach(function (k) {
      $(k).value = merged[k];
    });

    var gr = config.generalRule || {};
    $('mainSelector').value = gr.mainSelector || '';
    $('translateChrome').checked = !!gr.translateChrome;
    $('translationPosition').value = gr.translationPosition || 'after';
    $('targetWrapperTag').value = (config.render && config.render.targetWrapperTag) || 'font';
    $('fontSize').value = (config.render && config.render.fontSize) || 'inherit';
    $('lineHeight').value = (config.render && config.render.lineHeight) || '1.7';
    $('spacing').value = (config.render && config.render.spacing !== undefined) ? config.render.spacing : 8;

    $('lazy').checked = config.lazy !== false;
    $('incremental').checked = config.incremental !== false;
    $('autoTranslate').checked = !!config.autoTranslate;

    $('rules').value = JSON.stringify(config.rules || [], null, 2);
    $('rulesErr').textContent = '';
    updateRulesHint();

    $('glossary').value = IMT.glossary.toText(config.glossary || []);
    updateGlossaryCount();

    $('piiEnabled').checked = !!(config.pii && config.pii.enabled);
    renderPiiTypes();

    $('cacheEnabled').checked = !(config.cache && config.cache.enabled === false);
    $('cacheMaxAgeDay').value = (config.cache && config.cache.maxAgeDay) || 30;
  }

  function renderPiiTypes() {
    var host = $('piiTypes');
    host.innerHTML = '';
    var enabled = (config.pii && config.pii.types) || [];
    IMT.PII_TYPES.forEach(function (t) {
      var label = document.createElement('label');
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.value = t.id;
      input.checked = enabled.indexOf(t.id) >= 0;
      input.addEventListener('change', function () {
        var list = Array.prototype.slice.call(host.querySelectorAll('input:checked')).map(function (i) { return i.value; });
        config.pii.types = list;
      });
      label.appendChild(input);
      label.appendChild(document.createTextNode(' ' + t.label));
      label.title = t.hint;
      host.appendChild(label);
    });
  }

  function updateRulesHint() {
    var n = 0;
    try { n = (JSON.parse($('rules').value) || []).length; } catch (e) { /* ignore */ }
    $('rulesHint').textContent = n + ' 条规则';
  }

  function updateGlossaryCount() {
    var list = IMT.glossary.parseText($('glossary').value);
    $('glossaryCount').textContent = list.length + ' 条术语';
  }

  /* ---------------- 收集表单 ---------------- */

  function collect(strict) {
    // 先把表单同步回配置（JSON 非法会在这里抛错）
    syncEngineForm(strict !== false);

    var cfg = JSON.parse(JSON.stringify(config));

    // 当前引擎 = 「选择翻译引擎」里选中的那个
    var picked = $('enginePicker').value;
    cfg.engine = picked || config.engine || '';

    // 引擎参数：DOM 上只有当前正在编辑的那一个，其余保持存储里的值
    Object.keys(cfg.engines || {}).forEach(function (id) {
      var e = cfg.engines[id];
      // 自定义引擎没起名字就回落成模型名
      if (e.custom && !String(e.name || '').trim() && e.model) e.name = e.model;
      Object.keys(e).forEach(function (k) {
        if (k.indexOf('_raw_') === 0) delete e[k];
      });
    });

    // 引擎名不能重名
    var dup = validateEngineNames(cfg.engines);
    if (dup) throw new Error(dup);

    // 翻译风格
    cfg.scenario = currentScenarioId();
    cfg.autoScenario = $('autoScenario').checked;
    cfg.customScenarios = config.customScenarios || {};

    // 阈值
    cfg.generalRule = cfg.generalRule || {};
    cfg.generalRule.thresholds = cfg.generalRule.thresholds || {};
    ['paragraphMinTextCount', 'mainFrameMinTextCount'].forEach(function (k) {
      var v = parseInt($(k).value, 10);
      cfg.generalRule.thresholds[k] = isNaN(v) ? 0 : v;
    });

    cfg.generalRule.mainSelector = $('mainSelector').value.trim();
    cfg.generalRule.translateChrome = $('translateChrome').checked;
    cfg.generalRule.translationPosition = $('translationPosition').value;
    cfg.render = cfg.render || {};
    cfg.render.targetWrapperTag = $('targetWrapperTag').value;
    cfg.render.fontSize = $('fontSize').value || 'inherit';
    cfg.render.lineHeight = $('lineHeight').value || '1.7';
    cfg.render.spacing = parseInt($('spacing').value, 10) || 0;

    cfg.lazy = $('lazy').checked;
    cfg.incremental = $('incremental').checked;
    cfg.autoTranslate = $('autoTranslate').checked;

    // 规则
    var rulesText = $('rules').value.trim();
    if (rulesText) {
      try {
        var parsed = JSON.parse(rulesText);
        if (!Array.isArray(parsed)) throw new Error('规则必须是数组');
        cfg.rules = parsed;
        $('rulesErr').textContent = '';
      } catch (e) {
        $('rulesErr').textContent = '规则 JSON 解析失败：' + e.message;
        toast('规则 JSON 有误，未保存该部分', true);
      }
    } else {
      cfg.rules = [];
    }

    // 术语库
    cfg.glossary = IMT.glossary.parseText($('glossary').value);

    // PII
    cfg.pii = cfg.pii || {};
    cfg.pii.enabled = $('piiEnabled').checked;

    // 缓存
    cfg.cache = cfg.cache || {};
    cfg.cache.enabled = $('cacheEnabled').checked;
    cfg.cache.maxAgeDay = parseInt($('cacheMaxAgeDay').value, 10) || 30;

    return cfg;
  }

  /* ---------------- 事件 ---------------- */

  var EXAMPLE_RULES = [
    {
      id: 'example-docs',
      name: '文档站示例',
      enabled: true,
      urlPattern: ['*docs.example.com*'],
      translationMode: 'dual',
      translationPosition: 'after',
      sourceLang: 'auto',
      targetLang: 'zh-Hans',
      tags: ['p', 'li', 'h1', 'h2', 'h3', 'td', 'th'],
      excludeSelectors: ['.sidebar', 'nav', '.advertisement'],
      mainSelector: '',
      thresholds: { paragraphMinTextCount: 2 }
    }
  ];

  document.addEventListener('DOMContentLoaded', function () {
    loadConfig();

    // 恢复上次停留的面板
    var last = null;
    try { last = sessionStorage.getItem('imtl.panel'); } catch (e) { /* ignore */ }
    showPanel(last || 'engines');

    /* ---------------- 侧边栏 ---------------- */

    $('sidebar').addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('button[data-panel]') : null;
      if (!btn) return;
      showPanel(btn.getAttribute('data-panel'));
    });

    $('saveAll').addEventListener('click', function () {
      persist();
    });

    /* ---------------- 「选择翻译引擎」 ---------------- */

    $('enginePicker').addEventListener('change', function () {
      var v = this.value;

      // 选了「添加新引擎」里的某一项 → 新建一个空白引擎并切过去
      if (v && v.indexOf(NEW_PREFIX) === 0) {
        var presetId = v.slice(NEW_PREFIX.length);
        var e = createEngine(presetId);
        render();
        toast('已新建「' + (presetById(presetId) ? presetById(presetId).name : '自定义') +
          '」引擎，填好地址与 API Key 后点「保存这个引擎」');
        return;
      }

      // 选了一个已有引擎
      SELECTED_ENGINE_ID = v || null;
      if (v) config.engine = v;
      renderEngineForm();
      renderEnginePicker();
      renderEngineBanner();
    });

    /* ---------------- 引擎表单：删除 / 测试 / 保存 ---------------- */

    $('engineForm').addEventListener('click', function (ev) {
      var t = ev.target;
      var rm = t.getAttribute && t.getAttribute('data-remove-engine');
      if (rm) {
        if (!config.engines[rm]) return;
        delete config.engines[rm];
        if (config.engine === rm) config.engine = Object.keys(config.engines)[0] || '';
        if (SELECTED_ENGINE_ID === rm) SELECTED_ENGINE_ID = Object.keys(config.engines)[0] || null;
        render();
        toast('已删除，记得点「保存全部」');
        return;
      }
      var sv = t.getAttribute && t.getAttribute('data-save-engine');
      if (sv) {
        persist();
        return;
      }
      var tid = t.getAttribute && t.getAttribute('data-test-engine');
      if (tid) testEngine(tid, t);
    });

    /* 表单一改就同步到配置里，切换引擎不会丢东西 */
    $('engineForm').addEventListener('input', function (ev) {
      var input = ev.target;
      if (!input.getAttribute) return;
      var id = input.getAttribute('data-engine');
      var name = input.getAttribute('data-field');
      if (!id || !name || !config.engines[id]) return;

      var e = config.engines[id];

      if (ENGINE_JSON_FIELDS[name]) {
        var raw = String(input.value || '').trim();
        if (!raw) { e[name] = {}; delete e['_raw_' + name]; input.classList.remove('invalid'); return; }
        try {
          e[name] = JSON.parse(raw);
          delete e['_raw_' + name];
          input.classList.remove('invalid');
        } catch (err) {
          e['_raw_' + name] = raw;
          input.classList.add('invalid');
          input.title = '不是合法 JSON';
        }
        return;
      }

      if (ENGINE_NUM_FIELDS[name]) {
        var n = parseFloat(input.value);
        e[name] = isNaN(n) ? 0 : n;
      } else {
        e[name] = input.value;
      }

      // 预设引擎的名字跟着模型名走；自定义引擎用用户起的名字
      if (name === 'model' && !e.custom) e.name = input.value || '';
      if (name === 'name' && e.custom) e.name = input.value;

      var title = $('engineFormTitle');
      if (title) title.textContent = engineLabel(e, id);
      refreshEngineStatus(id);
      refreshEngineOption(id);
      updatePickerHint();
      renderEngineBanner();
    });

    // 下拉（select）的 change 不会触发 input，需要单独接
    $('engineForm').addEventListener('change', function (ev) {
      var input = ev.target;
      if (!input.getAttribute) return;
      if (input.tagName !== 'SELECT') return;
      var id = input.getAttribute('data-engine');
      var name = input.getAttribute('data-field');
      if (!id || !name || !config.engines[id]) return;
      config.engines[id][name] = input.value;
      refreshEngineStatus(id);
      refreshEngineOption(id);
      updatePickerHint();
      renderEngineBanner();
    });

    function testEngine(id, btn) {
      var out = $('engineForm').querySelector('[data-test-result="' + id + '"]');
      var engine;
      try {
        engine = readEngineForm(id, config.engines[id] || {});
      } catch (err) {
        if (out) {
          out.className = 'engine-test-result bad';
          out.textContent = '✗ ' + String((err && err.message) || err);
        }
        return;
      }
      if (out) {
        out.className = 'engine-test-result';
        out.textContent = '正在测试…';
      }
      btn.disabled = true;
      send({ type: 'IMT_TEST_ENGINE', engineId: id, engine: engine }).then(function (res) {
        btn.disabled = false;
        if (!out) return;
        if (res && res.ok) {
          out.className = 'engine-test-result ok';
          out.textContent = '✓ ' + res.text;
        } else {
          out.className = 'engine-test-result bad';
          out.textContent = '✗ ' + ((res && res.error) || '未知错误');
        }
      });
    }

    /* ---------------- 翻译风格 ---------------- */

    $('scenarioList').addEventListener('click', function (ev) {
      var item = ev.target.closest ? ev.target.closest('[data-scenario]') : null;
      if (!item) return;
      config.scenario = item.getAttribute('data-scenario');
      renderScenarios();
    });

    $('autoScenario').addEventListener('change', function () {
      config.autoScenario = this.checked;
    });

    $('scenarioSave').addEventListener('click', saveScenario);
    $('scenarioRestore').addEventListener('click', restoreScenario);
    $('scenarioReset').addEventListener('click', removeScenario);

    $('scenarioAdd').addEventListener('click', function () {
      var name = (prompt('新场景的名称（例如「游戏攻略」）：') || '').trim();
      if (!name) return;
      var id = 'custom-' + Date.now().toString(36);
      config.customScenarios = config.customScenarios || {};
      config.customScenarios[id] = {
        id: id,
        name: name,
        desc: '自定义场景',
        systemPrompt: '',
        matches: []
      };
      config.scenario = id;
      renderScenarios();
      toast('已新增场景「' + name + '」，写好提示词后点「保存这个场景」');
    });

    /* ---------------- 规则 / 术语 / 缓存 ---------------- */

    $('rules').addEventListener('input', updateRulesHint);
    $('rules').addEventListener('blur', function () {
      var txt = this.value.trim();
      if (!txt) return;
      try {
        var parsed = JSON.parse(txt);
        if (!Array.isArray(parsed)) throw new Error('规则必须是数组');
        $('rulesErr').textContent = '';
      } catch (e) {
        $('rulesErr').textContent = '规则 JSON 解析失败：' + e.message;
      }
    });

    $('rulesFormat').addEventListener('click', function () {
      try {
        var parsed = JSON.parse(this.value || '[]');
        this.value = JSON.stringify(parsed, null, 2);
        $('rulesErr').textContent = '';
      } catch (e) {
        $('rulesErr').textContent = '解析失败：' + e.message;
      }
    });

    $('rulesExample').addEventListener('click', function () {
      this.value = JSON.stringify(EXAMPLE_RULES, null, 2);
      $('rulesErr').textContent = '';
      updateRulesHint();
    });

    $('glossary').addEventListener('input', updateGlossaryCount);
    $('glossaryFormat').addEventListener('click', function () {
      this.value = IMT.glossary.toText(IMT.glossary.parseText(this.value));
      updateGlossaryCount();
    });

    $('cacheStats').addEventListener('click', function () {
      send({ type: 'IMT_CACHE_STATS' }).then(function (res) {
        if (res && res.ok) {
          var s = res.stats;
          $('cacheInfo').textContent = s.count + ' 条 / ' + (s.bytes / 1024).toFixed(1) + ' KB';
        }
      });
    });

    $('cacheClear').addEventListener('click', function () {
      send({ type: 'IMT_CLEAR_CACHE' }).then(function (res) {
        if (res && res.ok) {
          $('cacheInfo').textContent = '已清空 ' + res.removed + ' 条';
          toast('缓存已清空');
        }
      });
    });

    $('reset').addEventListener('click', function () {
      if (!confirm('恢复默认设置？所有自定义规则、术语库和密钥都会被清除。')) return;
      send({ type: 'IMT_RESET_CONFIG' }).then(function (res) {
        if (res && res.ok) {
          config = res.config;
          render();
          toast('已恢复默认设置');
        }
      });
    });

    $('export').addEventListener('click', doExport);
    $('export2').addEventListener('click', doExport);
    $('import').addEventListener('click', function () { $('fileInput').click(); });
    $('import2').addEventListener('click', function () { $('fileInput').click(); });

    function doExport() {
      var blob = new Blob([JSON.stringify(collect(), null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'bilingual-reader-config.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      toast('已导出');
    }

    $('fileInput').addEventListener('change', function () {
      var file = this.files && this.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var parsed = JSON.parse(reader.result);
          var next = U.config.merge(parsed);
          send({ type: 'IMT_SET_CONFIG', config: next }).then(function (res) {
            if (res && res.ok) {
              config = res.config;
              render();
              toast('已导入配置');
            }
          });
        } catch (e) {
          toast('导入失败：' + e.message, true);
        }
      };
      reader.readAsText(file);
      this.value = '';
    });
  });
})();
