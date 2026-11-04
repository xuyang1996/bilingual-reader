/*!
 * Bilingual Reader — 翻译引擎适配
 *
 * 只支持一种引擎：
 *   ai  通用大模型接口，兼容市面上绝大多数模型 API
 *
 * 「通用大模型接口」通过一份配置适配以下形态：
 *   · OpenAI 兼容   —— DeepSeek / Kimi / 通义 / 智谱 / 豆包 / MiniMax / 百川 /
 *                      硅基流动 / OpenRouter / Groq / Together / Fireworks /
 *                      xAI / Mistral / 混元 / 千帆 / Ollama / vLLM / LM Studio …
 *   · Anthropic     —— Claude（Messages API）
 *   · Gemini        —— Google Gemini（generateContent）
 *   · 自定义         —— 自己写请求体，指定响应字段路径
 */
(function (root) {
  'use strict';

  var IMT = (root.IMT = root.IMT || {});
  var E = {};

  /** 统一的 fetch 封装，带超时与错误信息 */
  function httpFetch(url, options, timeoutMs) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    var opts = Object.assign({}, options || {});
    if (controller) {
      opts.signal = controller.signal;
      timer = setTimeout(function () { controller.abort(); }, timeoutMs || 30000);
    }
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (body) {
        var json = null;
        try { json = JSON.parse(body); } catch (e) { /* 非 JSON */ }
        return {
          ok: res.ok,
          status: res.status,
          json: json,
          body: body,
          res: res
        };
      });
    }).then(function (out) {
      if (timer) clearTimeout(timer);
      return out;
    }, function (err) {
      if (timer) clearTimeout(timer);
      var failure = new Error(err && err.name === 'AbortError'
        ? '请求超时，请检查网络或在设置中调整超时'
        : '网络请求失败，请检查网络、接口地址及服务状态');
      failure.code = err && err.name === 'AbortError' ? 'ENGINE_TIMEOUT' : 'ENGINE_NETWORK';
      failure.retryable = true;
      throw failure;
    });
  }

  E.httpFetch = httpFetch;

  /* ================================================================== *
   * 通用大模型引擎
   * ================================================================== */

  /** 目标语言的可读名称，用于提示词 */
  var LANG_NAMES = {
    'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', zh: '中文',
    en: 'English', ja: '日本語', ko: '한국어', fr: 'Français', de: 'Deutsch',
    es: 'Español', pt: 'Português', ru: 'Русский', it: 'Italiano',
    ar: 'العربية', th: 'ไทย', vi: 'Tiếng Việt', id: 'Bahasa Indonesia',
    hi: 'हिन्दी', tr: 'Türkçe'
  };

  function langName(code) {
    var c = String(code || '');
    if (LANG_NAMES[c]) return LANG_NAMES[c];
    if (c.indexOf('zh') === 0) return '中文';
    return c || 'the target language';
  }

  /** 默认系统提示词 */
  var DEFAULT_SYSTEM_PROMPT = [
    'You are a professional translator for web pages.',
    'Translate the user text into {target}.',
    '',
    'Rules:',
    '- Output ONLY the translation. No explanations, no notes, no surrounding quotes.',
    '- Keep the original structure: line breaks, list markers, numbering and inline',
    '  HTML such as <a href="...">...</a> must be preserved.',
    '- Keep code, identifiers, URLs, file paths and product names unchanged',
    '  unless the glossary says otherwise.',
    '- Translate one input block into exactly one output block. Do not merge,',
    '  split, summarize, explain or omit anything.',
    '- If the text is already in the target language, repeat it unchanged.'
  ].join('\n');

  var BATCH_RULE = [
    '- The input is a numbered list. Reply with exactly the same number of lines,',
    '  in the same order, each line starting with the same number followed by a dot.'
  ].join('\n');

  /* ---------------- 路径取值 ---------------- */

  /**
   * 按路径取值：支持 a.b[0].c 与 a.b.0.c 两种写法。
   */
  function getPath(obj, path) {
    if (obj == null || !path) return undefined;
    var parts = String(path)
      .replace(/\[(\d+)\]/g, '.$1')
      .split('.')
      .filter(function (s) { return s !== ''; });
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  /**
   * 把各种形态的「内容值」统一成字符串：
   *   字符串 / 字符串数组 / {text} / {content} / [{type:'text',text}] …
   */
  function textFromValue(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) {
      var s = '';
      for (var i = 0; i < v.length; i++) s += textFromValue(v[i]);
      return s;
    }
    if (typeof v === 'object') {
      if (typeof v.text === 'string') return v.text;
      if (typeof v.value === 'string') return v.value;
      if (v.content != null) return textFromValue(v.content);
      if (v.parts != null) return textFromValue(v.parts);
      if (v.type === 'text' && typeof v.text === 'string') return v.text;
    }
    return '';
  }

  /**
   * 各家接口的译文位置。
   * 顺序即优先级。
   *
   * 不使用 reasoning_content 兜底：推理被 token 上限截断时，只有思维链
   * 而没有正式译文，必须报错而不能把思维链显示为翻译成功。
   */
  var EXTRACT_PATHS = [
    'choices.0.message.content',
    'choices.0.text',
    'choices.0.delta.content',
    'output_text',
    'output.0.content.0.text',
    'output.0.content',
    'output.0.text',
    'candidates.0.content.parts',
    'content',
    'translations.0.text',
    'translations.0',
    'translation',
    'result',
    'data.0.text',
    'data.0',
    'text'
  ];

  /** 从响应 JSON 中提取译文；按候选路径依次尝试 */
  function extractText(json, responsePath) {
    if (json == null) return '';
    if (responsePath) {
      var custom = textFromValue(getPath(json, responsePath));
      if (custom) return custom;
    }
    for (var i = 0; i < EXTRACT_PATHS.length; i++) {
      var v = getPath(json, EXTRACT_PATHS[i]);
      if (v == null) continue;
      var t = textFromValue(v);
      if (t) return t;
    }
    return '';
  }

  /**
   * SSE（流式）响应兜底解析。
   * 有些网关即使收到 stream:false 也会返回事件流。
   */
  function parseSSE(body) {
    var out = '';
    String(body || '').split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim();
      if (line.indexOf('data:') !== 0) return;
      var payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      try {
        var json = JSON.parse(payload);
        var t = textFromValue(getPath(json, 'choices.0.delta.content')) ||
          textFromValue(getPath(json, 'choices.0.message.content')) ||
          textFromValue(getPath(json, 'candidates.0.content.parts')) ||
          textFromValue(getPath(json, 'output_text'));
        out += t;
      } catch (e) { /* 忽略坏行 */ }
    });
    return out;
  }

  /* ---------------- 请求体构造 ---------------- */

  /**
   * 是否是「推理模型」——这类模型不接受 temperature，
   * 且用 max_completion_tokens 而不是 max_tokens。
   */
  function isReasoningModel(model) {
    var m = String(model || '').toLowerCase();
    if (!m) return false;
    return /(^|[^a-z0-9])(o1|o3|o4-mini|gpt-5|gpt5)([^a-z0-9]|$)/.test(m) ||
      /reasoner|reasoning|deepseek-r1|qwq|thinking/.test(m);
  }

  /**
   * 组装提示词。
   *
   * 三层优先级：
   *   1. 引擎卡片上手填的「自定义系统提示词」——完全覆盖下面两层
   *   2. 当前选中的翻译风格场景（通用 / 科技 / 论文 / 法律 …）
   *   3. 通用翻译规则
   *
   * 术语库始终追加在最后。
   */
  function buildSystemPrompt(opts, engine, isBatch) {
    var glossary = IMT.glossary && IMT.glossary.buildPrompt
      ? IMT.glossary.buildPrompt(opts.glossary, opts.sourceLang, opts.targetLang)
      : '';

    var targetName = langName(opts.targetLang);
    var base;

    if (IMT.prompts && typeof IMT.prompts.buildSystemPrompt === 'function') {
      base = IMT.prompts.buildSystemPrompt({
        scenario: opts.scenario,
        customScenarios: opts.customScenarios,
        targetLang: opts.targetLang,
        targetName: targetName,
        enginePrompt: engine.systemPrompt,
        glossary: ''
      });
    } else {
      base = String(engine.systemPrompt || DEFAULT_SYSTEM_PROMPT)
        .replace(/\{target\}/g, targetName);
    }

    if (isBatch) base += '\n' + BATCH_RULE;
    if (glossary) base += '\n\n' + glossary;
    return base;
  }

  /** 单条文本 → user 消息内容 */
  function userContentForSingle(text, opts, engine) {
    if (engine.systemRole === 'user') {
      return buildSystemPrompt(opts, engine, false) + '\n\n' + text;
    }
    return text;
  }

  /** 多条文本 → 编号列表 */
  function userContentForBatch(texts) {
    var lines = [];
    for (var i = 0; i < texts.length; i++) lines.push((i + 1) + '. ' + texts[i]);
    return lines.join('\n');
  }

  function buildOpenAIBody(texts, opts, engine, isBatch) {
    var body = {
      model: engine.model || 'gpt-4o-mini',
      messages: [],
      stream: false
    };
    var reasoning = isReasoningModel(engine.model);
    // MiniMax M3.1 默认 max 推理；段落翻译使用 low，用户额外参数仍可覆盖。
    if (/^MiniMax-M3\.1-Flash$/i.test(engine.model || '')) body.reasoning_effort = 'low';
    var role = engine.systemRole || (reasoning ? 'developer' : 'system');

    if (role === 'user') {
      body.messages.push({ role: 'user', content: userContentForSingle('', opts, engine) });
    } else {
      body.messages.push({ role: role, content: buildSystemPrompt(opts, engine, isBatch) });
    }

    if (isBatch) {
      body.messages.push({ role: 'user', content: userContentForBatch(texts) });
    } else {
      body.messages.push({ role: 'user', content: texts[0] });
    }

    // 推理模型不接受 temperature
    var temp = engine.temperature === undefined || engine.temperature === null
      ? 0.2 : Number(engine.temperature);
    if (!reasoning && temp > 0) body.temperature = temp;

    var maxTokens = parseInt(engine.maxTokens, 10) || 0;
    if (maxTokens > 0) {
      if (reasoning) body.max_completion_tokens = maxTokens;
      else body.max_tokens = maxTokens;
    }

    return body;
  }

  function buildAnthropicBody(texts, opts, engine, isBatch) {
    var body = {
      model: engine.model || 'claude-sonnet-4-5',
      max_tokens: parseInt(engine.maxTokens, 10) || 8000,
      messages: []
    };
    var role = engine.systemRole || 'system';
    if (role === 'user') {
      body.messages.push({ role: 'user', content: userContentForSingle('', opts, engine) });
    } else {
      body.system = buildSystemPrompt(opts, engine, isBatch);
    }
    if (isBatch) {
      body.messages.push({ role: 'user', content: userContentForBatch(texts) });
    } else {
      body.messages.push({ role: 'user', content: texts[0] });
    }
    var temp = engine.temperature === undefined || engine.temperature === null
      ? 0.2 : Number(engine.temperature);
    if (temp > 0) body.temperature = temp;
    return body;
  }

  function buildGeminiBody(texts, opts, engine, isBatch) {
    var sys = buildSystemPrompt(opts, engine, isBatch);
    var content = isBatch ? userContentForBatch(texts) : texts[0];
    var body = {
      contents: [{ parts: [{ text: (sys ? sys + '\n\n' : '') + content }] }]
    };
    var cfg = {};
    var temp = engine.temperature === undefined || engine.temperature === null
      ? 0.2 : Number(engine.temperature);
    if (temp > 0) cfg.temperature = temp;
    var maxTokens = parseInt(engine.maxTokens, 10) || 0;
    if (maxTokens > 0) cfg.maxOutputTokens = maxTokens;
    if (Object.keys(cfg).length) body.generationConfig = cfg;
    return body;
  }

  function buildCustomBody(texts, opts, engine, isBatch) {
    var body = {
      model: engine.model || '',
      messages: [],
      stream: false
    };
    var role = engine.systemRole || 'system';
    if (role === 'user') {
      body.messages.push({ role: 'user', content: userContentForSingle('', opts, engine) });
    } else {
      body.messages.push({ role: role, content: buildSystemPrompt(opts, engine, isBatch) });
    }
    if (isBatch) {
      body.messages.push({ role: 'user', content: userContentForBatch(texts) });
    } else {
      body.messages.push({ role: 'user', content: texts[0] });
    }
    return body;
  }

  /* ---------------- URL 与鉴权 ---------------- */

  /** 旧配置里的 type 决定默认格式 */
  var FORMAT_BY_TYPE = {
    openai: 'openai', anthropic: 'anthropic', gemini: 'gemini'
  };

  function normalizeEngine(engine) {
    var e = Object.assign({}, engine || {});
    if (!e.format) e.format = FORMAT_BY_TYPE[e.type] || 'openai';
    if (!e.format) e.format = 'openai';
    return e;
  }

  var FORMATS = {
    openai: {
      label: 'OpenAI 兼容',
      paths: function (e) { return [e.path ? String(e.path) : '/chat/completions']; },
      build: buildOpenAIBody
    },
    anthropic: {
      label: 'Anthropic Messages',
      paths: function (e) { return [e.path ? String(e.path) : '/v1/messages']; },
      build: buildAnthropicBody
    },
    gemini: {
      label: 'Google Gemini',
      paths: function (e) {
        return [e.path ? String(e.path) : '/v1beta/models/{model}:generateContent'];
      },
      build: buildGeminiBody
    },
    custom: {
      label: '自定义',
      paths: function (e) { return [e.path ? String(e.path) : '']; },
      build: buildCustomBody
    }
  };

  /**
   * 生成候选接口地址。
   *
   * 为什么要候选：用户填 Base URL 时十有八九会漏掉路径或版本段
   * （填 https://api.deepseek.com 却没写 /v1）。与其让用户猜，
   * 不如按常见组合依次尝试，只在 404/405 时才换下一个。
   */
  function buildUrls(engine, format) {
    var base = String(engine.baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) return [];
    var spec = FORMATS[format] || FORMATS.openai;
    var urls = [];
    function push(u) { if (u && urls.indexOf(u) < 0) urls.push(u); }

    var paths = spec.paths(engine) || [];
    paths.forEach(function (p) {
      if (!p) { push(base); return; }
      var path = p.replace(/\{model\}/g, encodeURIComponent(engine.model || ''));
      if (base.length >= path.length && base.slice(-path.length) === path) push(base);
      else push(base + path);
    });

    // OpenAI 生态：Base URL 里没有 /v1 段时，再试一次带 /v1 的
    if (format === 'openai' && !/\/v\d+(\/|$)/i.test(base)) {
      paths.forEach(function (p) {
        if (!p) return;
        var path = p.replace(/\{model\}/g, encodeURIComponent(engine.model || ''));
        push(base + '/v1' + path);
      });
    }

    return urls;
  }

  /**
   * 鉴权候选。
   * auto 模式先试 Bearer，再试 x-api-key、api-key —— 不少自建网关
   * 用的是 Anthropic 风格的鉴权头，却暴露着 OpenAI 风格的路径。
   */
  function buildAuths(engine) {
    var key = String(engine.key || '');
    var mode = engine.auth || 'auto';
    if (!key) return [{ headers: {}, query: '' }];

    switch (mode) {
      case 'bearer':
        return [{ headers: { Authorization: 'Bearer ' + key } }];
      case 'x-api-key':
        return [{ headers: { 'x-api-key': key } }];
      case 'api-key':
        return [{ headers: { 'api-key': key } }];
      case 'query':
        return [{ headers: {}, query: (engine.queryKey || 'key') + '=' + encodeURIComponent(key) }];
      case 'none':
        return [{ headers: {} }];
      default:
        return [
          { headers: { Authorization: 'Bearer ' + key } },
          { headers: { 'x-api-key': key } },
          { headers: { 'api-key': key } }
        ];
    }
  }

  /* ---------------- 批量协议 ---------------- */

  /** 去掉模型可能加上的 markdown 代码围栏 */
  function stripFences(text) {
    var s = String(text || '').trim();
    var m = /^```[a-zA-Z0-9]*\s*\n([\s\S]*?)\n?```$/.exec(s);
    return m ? m[1] : s;
  }

  /**
   * 解析编号批量回复。
   * 解析不出全部 N 条就返回 null，由调用方回退到逐条请求。
   */
  function parseBatchReply(reply, count) {
    var lines = stripFences(reply).split(/\r?\n/);
    var map = {};
    lines.forEach(function (line) {
      var m = /^\s*(?:\[(\d+)\]|(\d+)\s*[.)、．:：])\s*(.*)$/.exec(line);
      if (!m) return;
      var idx = parseInt(m[1] || m[2], 10);
      if (!idx || idx < 1 || idx > count) return;
      if (typeof map[idx] !== 'string') map[idx] = m[3];
    });
    var out = [];
    for (var i = 1; i <= count; i++) {
      if (typeof map[i] !== 'string' || !map[i].trim()) return null;
      out.push(map[i]);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 演示模式：完全在本地拼出示例译文，不发任何网络请求
   *
   * 为什么需要它：
   *   扩展的核心功能必须由用户自备大模型 API（没有免 Key 的通道），
   *   这意味着「刚装上、还没配置任何 Key」的读者看不到任何效果，
   *   商店审核员同样无法验证功能。
   *   演示模式用一份内置小词表在本地做片段替换，把「正文识别 → 双语排版 →
   *   还原」整条链路完整跑一遍，全程零网络请求、零 Key。
   *
   *   它**不是**机器翻译，只是让界面与流程可见。界面上会明确标注。
   * ------------------------------------------------------------------ */

  var DEMO_DICT = {
    'bilingual reader': '双语对照阅读器',
    'paragraph level': '段落级',
    'translation engine': '翻译引擎',
    'the extension': '本扩展',
    'this extension': '本扩展',
    'the page': '该页面',
    'long page': '长页面',
    'any page': '任意页面',
    'the original page': '原始页面',
    'the folder': '该文件夹',
    'the toolbar icon': '工具栏图标',
    'the extensions page': '扩展程序页面',
    'the way the translation looks': '译文的显示方式',
    'the recognizer': '识别器',
    'the main button': '主按钮',
    'the current page': '当前页面',
    'demo project': '演示项目',
    'engine': '引擎',
    'engines': '引擎',
    'extension': '扩展',
    'read': '读取',
    'reads': '读取',
    'visible': '可见的',
    'only': '仅',
    'every': '每个',
    'current': '当前',
    'original': '原文',
    'translation': '翻译',
    'translations': '翻译',
    'translated': '翻译',
    'translate': '翻译',
    'translating': '翻译中',
    'layout': '布局',
    'headings': '标题',
    'heading': '标题',
    'table cells': '表格单元格',
    'table': '表格',
    'cells': '单元格',
    'list items': '列表项',
    'list': '列表',
    'items': '条目',
    'item': '条目',
    'including': '包括',
    'smart': '智能的',
    'content': '内容',
    'recognition': '识别',
    'recognizer': '识别器',
    'skips': '跳过',
    'skip': '跳过',
    'navigation': '导航',
    'navigation menus': '导航菜单',
    'menus': '菜单',
    'menu': '菜单',
    'sidebars': '侧栏',
    'sidebar': '侧栏',
    'short labels': '短标签',
    'labels': '标签',
    'label': '标签',
    'lazy': '懒',
    'long': '长',
    'sent': '发送',
    'send': '发送',
    'part': '部分',
    'dynamically': '动态地',
    'dynamic': '动态',
    'loaded': '加载',
    'load': '加载',
    'personal': '个人',
    'information': '信息',
    'masking': '脱敏',
    'before the request': '请求之前',
    'request': '请求',
    'restored': '还原',
    'locally': '本地',
    'afterwards': '之后',
    'terminology': '术语',
    'base': '库',
    'keeps': '保持',
    'keep': '保持',
    'product names': '产品名',
    'consistent': '一致',
    'free': '免费',
    'out of the box': '开箱即用',
    'bring your own key': '自带 Key',
    'your own key': '你自己的 Key',
    'for an ai engine': '接入大模型引擎',
    'ai': 'AI',
    'installation': '安装',
    'install': '安装',
    'download': '下载',
    'folder': '文件夹',
    'then open': '然后打开',
    'open': '打开',
    'extensions page': '扩展程序页面',
    'chrome': 'Chrome',
    'reload any page': '刷新任意页面',
    'toolbar': '工具栏',
    'icon': '图标',
    'becomes available': '即可使用',
    'available': '可用',
    'click': '点击',
    'press': '按',
    'button': '按钮',
    'main button': '主按钮',
    'toggle': '切换',
    'show translation only': '仅显示译文',
    'only the translation': '仅译文',
    'restore': '还原',
    'popup': '弹出面板',
    'context menu': '右键菜单',
    'right click': '右键点击',
    'pick an entry': '选择一项',
    'compatible': '兼容',
    'deepseek': 'DeepSeek',
    'kimi': 'Kimi',
    'qwen': '通义千问',
    'zhipu': '智谱',
    'openrouter': 'OpenRouter',
    'ollama': 'Ollama',
    'anthropic': 'Anthropic',
    'claude models': 'Claude 模型',
    'google gemini': 'Google Gemini',
    'gemini models': 'Gemini 模型',
    'fully custom': '完全自定义',
    'your own gateway': '你自己的网关',
    'url': '地址',
    'path': '路径',
    'headers': '请求头',
    'body': '请求体',
    'response': '响应',
    'field': '字段',
    'local': '本地',
    'vllm': 'vLLM',
    'lm studio': 'LM Studio',
    'set the auth mode': '把鉴权方式设为',
    'auth mode': '鉴权方式',
    'none': '无',
    'example': '示例',
    'features': '特性',
    'feature': '特性',
    'privacy': '隐私',
    'faq': '常见问题',
    'email addresses': '邮箱地址',
    'phone numbers': '电话号码',
    'credit card numbers': '信用卡号',
    'identity numbers': '身份证号',
    'ip addresses': 'IP 地址',
    'urls': '网址',
    'why is a paragraph not translated': '为什么有的段落没有被翻译',
    'not translated': '没有被翻译',
    'too short': '太短',
    'code samples': '代码样例',
    'can i change': '我能修改',
    'the way the translation looks': '译文的显示方式',
    'does it work on sites': '它在这些站点上能用吗',
    'sites that render with javascript': '用 JavaScript 渲染的站点',
    'runs after the page is ready': '在页面就绪后运行',
    'observes the dom': '监听 DOM 变化',
    'settings page': '设置页',
    'exposes': '提供',
    'font size': '字号',
    'line height': '行高',
    'spacing': '间距',
    'order of the original': '原文与译文的顺序',
    'yes': '可以',
    'blocks': '块',
    'sample': '示例',
    'text': '文本',
    'web': '网页',
    'for': '为',
    'web site': '网站',
    'website': '网站',
    'page': '页面',
    'pages': '页面',
    'part of': '的一部分',
    'a long': '一段很长的',
    'so': '因此',
    'that': '那些',
    'this': '这',
    'with': '与',
    'from': '从',
    'on': '在',
    'in': '在',
    'by': '通过',
    'we': '我们',
    'you': '你',
    'your': '你的',
    'can': '能',
    'will': '将',
    'is': '是',
    'are': '是',
    'it': '它',
    'be': '被',
    'of': '的',
    'to': '到',
    'and': '与',
    'or': '或',
    'the': '',
    'a': '',
    'an': ''
  };

  /**
   * 整句级翻译表。
   *
   * 演示页（扩展自带的 demo/demo.html）的每一句都在这里有对应译文，
   * 所以装上扩展 → 点一下 → 就能看到一段像样的双语效果，
   * 而不是一堆半吊子的碎片。表里没有的句子才落到下面的词表替换。
   */
  var DEMO_PHRASES = {
    'Bilingual Reader — demo project': 'Bilingual Reader — 演示项目',
    'This page is a normal English web page. Load the extension, then click the toolbar icon and press': '这是一个普通的英文网页。加载扩展后，点击工具栏图标并按下',
    'Translate this page': '翻译此页',
    'to get the bilingual layout.': '即可得到双语对照排版。',
    'Bilingual Reader': '双语对照阅读器',
    'A paragraph level bilingual translation engine for the web. The extension reads the page, decides which blocks are real article content, and renders the translation right underneath the original paragraph.':
      '一个面向网页的段落级双语对照翻译引擎。扩展会读取页面，判定哪些块是真正的正文，并把译文紧贴在原文段落下方渲染。',
    'no build step': '无需构建',
    'zero dependency': '零依赖',
    'MIT licensed': 'MIT 协议',
    'Chrome MV3 no build step zero dependency MIT licensed':
      'Chrome MV3 · 无需构建 · 零依赖 · MIT 协议',
    'Table of contents': '目录',
    'Installation': '安装',
    'Usage': '使用',
    'Translation engines': '翻译引擎',
    'Features': '特性',
    'Privacy': '隐私',
    'FAQ': '常见问题',
    'Paragraph level bilingual layout, including headings, table cells and list items':
      '段落级双语对照排版，标题、表格单元格与列表项都包含在内',
    'Smart content recognition that skips navigation menus, sidebars and short labels':
      '智能正文识别，跳过导航菜单、侧栏与短标签',
    'Lazy translation, so only the visible part of a long page is sent to the engine':
      '懒翻译，长页面只有可见部分会被送去翻译',
    'Incremental translation for content that is loaded dynamically':
      '增量翻译，动态加载出来的内容自动补翻',
    'Personal information masking before the request, restored locally afterwards':
      '请求前对个人信息脱敏，译文返回后在本地还原',
    'A terminology base that keeps your product names consistent':
      '术语库，让产品名的译法保持一致',
    'Free engine out of the box, or bring your own key for an AI engine':
      '开箱即用的免费引擎，或者自带 Key 接入大模型引擎',
    'Download the folder, then open the extensions page in Chrome:':
      '下载文件夹后，在 Chrome 里打开扩展程序页面：',
    'Reload any page and the toolbar icon becomes available.':
      '刷新任意页面，工具栏图标即可使用。',
    'Translate the current page': '翻译当前页面',
    'Click the toolbar icon, then press the main button':
      '点击工具栏图标，然后按下主按钮',
    'Toggle translation': '切换翻译',
    'Show translation only': '仅显示译文',
    'Popup, then': '弹出面板，然后',
    'Translation only': '仅译文',
    'Restore the original page': '还原原始页面',
    'Translate from the context menu': '从右键菜单翻译',
    'Right click the page and pick an entry': '右键点击页面并选择一项',
    'Restoring the page removes every injected node and restores the DOM exactly as it was before translation.':
      '还原页面会移除每一个注入的节点，让 DOM 回到翻译之前的样子。',
    'The extension talks to large-model APIs only. Pick an engine in': '本扩展只对接大模型 API。在',
    'Settings → Translation engines': '设置 → 翻译引擎',
    ', fill in the address, model and API key, and you are done. No engine is pre-configured, and there is no key-free free tier.':
      '里选一个引擎，填好地址、模型与 API Key 即可。扩展不预置任何引擎，也没有免 Key 的免费通道。',
    'OpenAI compatible': 'OpenAI 兼容',
    'DeepSeek, Kimi, Qwen, Zhipu, OpenRouter, Ollama': 'DeepSeek、Kimi、通义千问、智谱、OpenRouter、Ollama',
    'Claude models': 'Claude 模型',
    'Google Gemini models': 'Google Gemini 模型',
    'Fully custom': '完全自定义',
    'Your own gateway: URL, path, headers, body, response field path':
      '你自己的网关：地址、路径、请求头、请求体、响应字段路径',
    'Local (Ollama / vLLM / LM Studio)': '本地部署（Ollama / vLLM / LM Studio）',
    'Set the auth mode to “None”': '把鉴权方式设为「无」',
    'DeepSeek example': 'DeepSeek 示例',
    'Email addresses, phone numbers, credit card numbers, identity numbers, IP addresses and URLs are replaced with placeholders before the text leaves the browser, and restored locally when the translation comes back. API keys are stored in':
      '邮箱地址、电话号码、信用卡号、身份证号、IP 地址与网址在内容离开浏览器前会被替换为占位符，译文返回后在本地还原。API Key 存放在',
    'and never leave your machine.': '，永远不会离开你的机器。',
    'Why is a paragraph not translated?': '为什么有的段落没有被翻译？',
    'The recognizer skips blocks that are too short, code samples, navigation labels and sidebars. You can lower the thresholds in the settings page.':
      '识别器会跳过太短的块、代码样例、导航标签与侧栏。你可以在设置页里调低阈值。',
    'Can I change the way the translation looks?': '我能修改译文的显示方式吗？',
    'Yes. The settings page exposes the font size, line height, spacing and the order of the original and the translation.':
      '可以。设置页提供字号、行高、间距，以及原文与译文的上下顺序。',
    'Does it work on sites that render with JavaScript?': '它在用 JavaScript 渲染的站点上能用吗？',
    'Yes. The content script runs after the page is ready and observes the DOM, so dynamically inserted paragraphs are translated as well.':
      '可以。内容脚本在页面就绪后运行并监听 DOM 变化，动态插入的段落同样会被翻译。',
    'Released under the MIT License. This page only exists to demonstrate the translation layout.':
      '基于 MIT 协议发布。本页面仅用于演示翻译排版。'
  };

  /**
   * 演示模式下把英文片段替换成中文示例
   *
   * 先查整句表（命中就是整句替换），再退回词表逐词替换。
   */
  function demoTranslate(text) {
    var s = String(text || '');
    if (!s) return '';
    // 已经是中文就原样返回
    if (/[一-鿿]/.test(s)) return s;

    var trimmed = s.trim();
    if (Object.prototype.hasOwnProperty.call(DEMO_PHRASES, trimmed)) {
      return DEMO_PHRASES[trimmed];
    }
    // 带前缀空白的整句：保留原有缩进
    var lead = s.slice(0, s.length - s.replace(/^\s+/, '').length);
    if (Object.prototype.hasOwnProperty.call(DEMO_PHRASES, trimmed)) {
      return lead + DEMO_PHRASES[trimmed];
    }

    var keys = Object.keys(DEMO_DICT);
    // 长词优先，避免短词先替换把长词切碎
    keys.sort(function (a, b) { return b.length - a.length; });
    keys.forEach(function (k) {
      if (!k) return;
      var re = new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
      s = s.replace(re, DEMO_DICT[k]);
    });
    return s;
  }

  /* ---------------- 主实现 ---------------- */

  /**
   * 记住每个引擎上次成功的「地址候选下标」与「鉴权候选下标」。
   *
   * 没有这个记忆时，Base URL 少写一个 /v1、或者服务用 x-api-key 鉴权，
   * 每一个请求都要先吃一次 404 / 401 才轮到正确的那个 —— 请求数直接翻倍。
   *
   * 记忆分两处保存：
   *   · 内存 —— 同一 service worker 生命周期内
   *   · chrome.storage.session —— MV3 的 service worker 会被随时回收重启，
   *     只放内存的话重启一次就忘一次
   */
  var successMemo = {};
  var probePending = {};
  var failures = {};
  var cooldowns = {};
  var memoLoaded = false;
  var MEMO_KEY = 'imtl.engine.memo';

  function hasSessionStorage() {
    try {
      return typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.session;
    } catch (e) {
      return false;
    }
  }

  function loadMemo() {
    if (memoLoaded) return Promise.resolve(successMemo);
    memoLoaded = true;
    if (!hasSessionStorage()) return Promise.resolve(successMemo);
    return chrome.storage.session.get(MEMO_KEY).then(function (d) {
      Object.assign(successMemo, (d && d[MEMO_KEY]) || {});
      return successMemo;
    }).catch(function () { return successMemo; });
  }

  function saveMemo(key, val) {
    successMemo[key] = val;
    if (!hasSessionStorage()) return;
    try {
      var payload = {};
      payload[MEMO_KEY] = successMemo;
      chrome.storage.session.set(payload).catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
  }

  function memoKey(engine) {
    return [engine.baseUrl || '', engine.path || '', engine.format || '',
      engine.model || '', engine.auth || ''].join('|');
  }

  // 故障隔离包含配置指纹：更换 Key 或参数后立刻允许重新测试。
  function failureKey(engine) {
    return memoKey(engine) + '|' + IMT.utils.hashString(JSON.stringify([
      engine.key || '', engine.headers || {}, engine.extraBody || {}
    ]));
  }

  function errorInfo(err) {
    return {
      message: String((err && err.message) || err || '翻译失败'),
      code: (err && err.code) || '',
      status: (err && err.status) || 0,
      fatal: !!(err && err.fatal),
      retryAfter: (err && err.retryAfter) || 0
    };
  }

  function apiError(out, engine) {
    var json = out.json || {};
    var detail = json.error || {};
    var base = json.base_resp || {};
    var message = typeof detail === 'string' ? detail : detail.message;
    message = String(message || base.status_msg || out.body || '').slice(0, 240);
    var err = new Error('HTTP ' + out.status + (message ? ': ' + message : ''));
    err.status = out.status;
    err.code = 'ENGINE_HTTP';
    if (/model.{0,100}(not.{0,10}(found|exist|available|support)|no longer|retired|deprecat)|(?:unknown|invalid|unsupported|retired)\s+model|模型.{0,30}(下线|不存在|不可用|不支持)/i.test(message)) {
      err.code = 'ENGINE_MODEL_UNAVAILABLE';
      err.message = '模型「' + engine.model + '」不可用或已下线，请在设置页更换模型。' + message;
      err.fatal = true;
    } else if (out.status === 402 || /insufficient_quota|insufficient.{0,15}(balance|credit)|余额不足|额度.{0,8}(耗尽|用尽)/i.test(message)) {
      err.code = 'ENGINE_QUOTA';
      err.message = '接口额度或余额不足，请检查模型服务账户。' + message;
      err.fatal = true;
    } else if (out.status === 401 || out.status === 403) {
      err.code = 'ENGINE_AUTH';
      err.message = '接口鉴权失败，请检查 API Key、鉴权方式和模型访问权限。' + message;
      err.fatal = true;
    }
    return err;
  }

  function waitForCooldown(key) {
    var delay = (cooldowns[key] || 0) - Date.now();
    if (delay <= 0) return Promise.resolve();
    return new Promise(function (resolve) { setTimeout(resolve, delay); })
      .then(function () { return waitForCooldown(key); });
  }

  /** 把某个下标排到最前面，其余保持原序 */
  function orderWithFirst(list, index) {
    if (typeof index !== 'number' || index < 0 || index >= list.length) {
      return list.map(function (_, i) { return i; });
    }
    return [index].concat(list.map(function (_, i) { return i; })
      .filter(function (i) { return i !== index; }));
  }

  E.ai = {
    id: 'ai',

    /**
     * 发一次请求，返回译文。
     *
     * 第一次遇到没配好的地址时会试探候选；并发请求共享同一次试探，
     * 不会各自去吃一遍 404。
     */
    request: function (texts, opts, engine) {
      var e = normalizeEngine(engine);

      // 演示模式：不联网，直接在本地拼示例译文
      if (e.format === 'demo') {
        return Promise.resolve(
          texts.map(function (t) { return demoTranslate(t); }).join('\n')
        );
      }

      var key = memoKey(e);
      var fk = failureKey(e);
      if (failures[fk] && failures[fk].until > Date.now()) {
        return Promise.reject(failures[fk].error);
      }

      return loadMemo().then(function () {
        if (successMemo[key]) return E.ai._doRequest(texts, opts, e, key);

        var pending = probePending[key];
        if (pending) {
          // 别的请求正在探测地址，等它探完直接走正确的那个
          var resume = function () {
            return E.ai.request(texts, opts, engine);
          };
          return pending.then(resume, resume);
        }

        var p = E.ai._doRequest(texts, opts, e, key);
        probePending[key] = p;
        var clear = function () { delete probePending[key]; };
        p.then(clear, function (err) {
          if (err.fatal) failures[fk] = { error: err, until: Date.now() + Math.max(30000, err.retryAfter || 0) };
          clear();
        });
        return p;
      });
    },

    /** 真正发请求（不负责记忆与并发协调） */
    _doRequest: function (texts, opts, engine, key) {
      var e = normalizeEngine(engine);
      var format = e.format;
      var spec = FORMATS[format] || FORMATS.openai;
      var isBatch = texts.length > 1;

      var urls = buildUrls(e, format);
      if (!urls.length) return Promise.reject(new Error('未配置 Base URL'));

      var auths = buildAuths(e);
      var timeout = (parseInt(e.timeout, 10) || 90) * 1000;
      var body = spec.build(texts, opts, e, isBatch);

      // 额外请求体参数
      if (e.extraBody && typeof e.extraBody === 'object') {
        Object.keys(e.extraBody).forEach(function (k) { body[k] = e.extraBody[k]; });
      }

      var memo = successMemo[key] || {};
      var urlOrder = orderWithFirst(urls, memo.url);
      var authOrder = orderWithFirst(auths, memo.auth);
      var urlPos = 0, authPos = 0;
      var lastError = null;
      var retries = 0;
      var fk = failureKey(e);

      function retry(err, out) {
        if (retries >= 2) {
          err.fatal = true;
          err.message += '；自动重试后仍未恢复，已暂停，请稍后重试失败段落。';
          throw err;
        }
        var value = out && out.res && out.res.headers.get('Retry-After');
        var delay = value && /^\s*\d+(\.\d+)?\s*$/.test(value)
          ? Number(value) * 1000 : (value ? Date.parse(value) - Date.now() : 0);
        delay = Math.max(delay || 0, 1000 * Math.pow(2, retries) + Math.floor(Math.random() * 250));
        // 不在消息通道里等待数分钟，也不提前重试服务明确要求的长冷却。
        if (delay > 30000) {
          err.message += '；服务要求稍后重试，请等待 ' + Math.ceil(delay / 1000) + ' 秒。';
          err.fatal = true;
          err.retryAfter = delay;
          throw err;
        }
        retries++;
        cooldowns[fk] = Math.max(cooldowns[fk] || 0, Date.now() + delay);
        return attempt();
      }

      function attempt() {
        if (urlPos >= urlOrder.length) {
          var err = lastError || new Error('请求失败');
          if (err.status === 404 || err.status === 405) {
            err.code = 'ENGINE_ENDPOINT';
            err.fatal = true;
          }
          return Promise.reject(err);
        }
        var urlIdx = urlOrder[urlPos];
        var authIdx = authOrder[Math.min(authPos, authOrder.length - 1)];
        var url = urls[urlIdx];
        var auth = auths[authIdx];

        var headers = { 'Content-Type': 'application/json' };
        Object.keys(auth.headers || {}).forEach(function (k) { headers[k] = auth.headers[k]; });
        if (e.headers && typeof e.headers === 'object') {
          Object.keys(e.headers).forEach(function (k) { headers[k] = e.headers[k]; });
        }

        var full = url;
        if (auth.query) {
          full += (full.indexOf('?') >= 0 ? '&' : '?') + auth.query;
        }

        return waitForCooldown(fk).then(function () {
          if (failures[fk] && failures[fk].until > Date.now()) throw failures[fk].error;
          return httpFetch(full, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(body)
          }, timeout);
        }).then(function (out) {
          if (!out.ok || (out.json && (out.json.error || (out.json.base_resp && out.json.base_resp.status_code)))) {
            var err = apiError(out, e);
            if (err.code === 'ENGINE_MODEL_UNAVAILABLE' || err.code === 'ENGINE_QUOTA') throw err;

            if ([408, 425, 429, 500, 502, 503, 504].indexOf(out.status) >= 0) {
              err.code = out.status === 429 ? 'ENGINE_RATE_LIMIT' : 'ENGINE_TEMPORARY';
              return retry(err, out);
            }

            // 鉴权方式不对 → 换一种鉴权再试
            if (out.status === 401 || out.status === 403) {
              if (authPos < authOrder.length - 1) {
                authPos++;
                lastError = err;
                return attempt();
              }
            }
            // 地址不对 → 换下一个候选地址
            if (out.status === 404 || out.status === 405) {
              urlPos++;
              authPos = 0;
              lastError = err;
              return attempt();
            }
            throw err;
          }

          var text = extractText(out.json, e.responsePath);
          if (!text && out.json == null) {
            // 不是 JSON：可能是 SSE，也可能是纯文本
            var sse = parseSSE(out.body);
            if (sse) text = sse;
            else if (out.body && !/^\s*</.test(out.body)) text = out.body.trim();
          }
          if (!text) {
            var e2 = new Error('接口返回空内容（可能是模型名/路径不对，或返回格式不在解析列表里）');
            e2.body = out.body;
            throw e2;
          }
          // 记住这次成功的组合，下次直接用它
          saveMemo(key, { url: urlIdx, auth: authIdx });
          return text.trim();
        }, function (netErr) {
          // 超时/断网不代表路径错误，始终在原地址进行有限次重试。
          if (netErr.retryable) return retry(netErr);
          throw netErr;
        });
      }

      return attempt().catch(function (err) {
        if (err.fatal) failures[fk] = { error: err, until: Date.now() + Math.max(30000, err.retryAfter || 0) };
        throw err;
      });
    },

    /** 单条 */
    one: function (text, opts, engine) {
      return E.ai.request([text], opts, engine);
    },

    /** 逐条翻译 */
    sequential: function (texts, opts, engine) {
      var out = [];
      out.errors = [];
      var step = function (i) {
        if (i >= texts.length) return Promise.resolve(out);
        return E.ai.request([texts[i]], opts, engine).then(function (t) {
          out.push(t);
          return step(i + 1);
        }, function (err) {
          out[i] = '';
          out.errors[i] = errorInfo(err);
          if (err.fatal) {
            for (var j = i + 1; j < texts.length; j++) {
              out[j] = '';
              out.errors[j] = errorInfo(err);
            }
            return out;
          }
          return step(i + 1);
        });
      };
      return step(0);
    },

    /** 批量翻译：优先用编号协议，失败自动回退逐条 */
    translate: function (texts, opts, engine) {
      var e = normalizeEngine(engine);
      if (!texts || !opts) opts = opts || {};
      if (!texts || !texts.length) return Promise.resolve([]);

      // 演示模式：本地拼示例译文，全程不联网
      if (e.format === 'demo') {
        return Promise.resolve(texts.map(function (t) { return demoTranslate(t); }));
      }

      var batchSize = Math.max(1, parseInt(e.batchSize, 10) || 1);

      if (texts.length === 1) {
        return E.ai.request(texts, opts, e).then(function (t) { return [t]; });
      }

      if (batchSize > 1) {
        return E.ai.batch(texts, opts, e, batchSize);
      }
      return E.ai.sequential(texts, opts, e);
    },

    /** 编号批量协议 */
    batch: function (texts, opts, engine, batchSize) {
      var out = [];
      out.errors = [];
      var chunk = Math.max(1, batchSize);
      var step = function (i) {
        if (i >= texts.length) return Promise.resolve(out);
        var part = texts.slice(i, i + chunk);
        if (part.length === 1) {
          return E.ai.sequential(part, opts, engine).then(append);
        }
        function append(result) {
          result.forEach(function (text, j) {
            out[i + j] = text;
            out.errors[i + j] = (result.errors || [])[j] || null;
          });
          var fatal = (result.errors || []).filter(function (err) { return err && err.fatal; })[0];
          if (fatal) {
            for (var j = i + part.length; j < texts.length; j++) {
              out[j] = '';
              out.errors[j] = fatal;
            }
            return out;
          }
          return step(i + part.length);
        }
        return E.ai.request(part, opts, engine).then(function (reply) {
          var parsed = parseBatchReply(reply, part.length);
          // 只有编号无法对齐时才逐条补翻这一批，HTTP 错误不再放大成 N 个请求。
          return parsed ? append(parsed) : E.ai.sequential(part, opts, engine).then(append);
        }, function (err) {
          var failed = part.map(function () { return ''; });
          failed.errors = part.map(function () { return errorInfo(err); });
          return append(failed);
        });
      };
      return step(0);
    },

    /* --------- 导出内部方法，供单元测试与设置页使用 --------- */
    _internal: {
      getPath: getPath,
      textFromValue: textFromValue,
      extractText: extractText,
      parseSSE: parseSSE,
      parseBatchReply: parseBatchReply,
      errorInfo: errorInfo,
      stripFences: stripFences,
      buildUrls: buildUrls,
      buildAuths: buildAuths,
      isReasoningModel: isReasoningModel,
      buildSystemPrompt: buildSystemPrompt,
      normalizeEngine: normalizeEngine,
      demoTranslate: demoTranslate,
      FORMATS: FORMATS,
      DEFAULT_SYSTEM_PROMPT: DEFAULT_SYSTEM_PROMPT
    }
  };

  // 兼容旧引用
  E.openai = E.ai;
  E.anthropic = E.ai;
  E.gemini = E.ai;

  // 内部方法在顶层也暴露一份，方便单元测试直接取 E._internal
  E._internal = E.ai._internal;

  /* ------------------------------------------------------------------ *
   * 分发
   * ------------------------------------------------------------------ */

  E.byType = {
    ai: E.ai,
    openai: E.ai,
    anthropic: E.ai,
    gemini: E.ai
  };

  /**
   * 根据引擎配置分发请求。
   * @param {object} engine  引擎配置（含 type / format / baseUrl / model / key）
   * @param {string[]} texts
   * @param {object} opts   {sourceLang, targetLang, glossary, scenario, customScenarios}
   */
  E.dispatch = function (engine, texts, opts) {
    if (!texts || !texts.length) return Promise.resolve([]);
    var type = (engine && engine.type) || 'ai';
    var impl = E.byType[type] || E.ai;
    return impl.translate(texts, opts, engine || {});
  };

  IMT.engines = E;
})(typeof globalThis !== 'undefined' ? globalThis : this);
