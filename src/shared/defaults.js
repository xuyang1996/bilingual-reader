/*!
 * Bilingual Reader — 共享常量与默认配置
 *
 * 该文件同时被 content script、background service worker、popup、options 页面加载，
 * 因此必须是无依赖的 classic script，并且只能挂载到全局命名空间 IMT。
 */
(function (root) {
  'use strict';

  var IMT = (root.IMT = root.IMT || {});

  /* ------------------------------------------------------------------ *
   * 1. 标签常量
   * ------------------------------------------------------------------ */

  /** 块级标签：决定「段落」的边界，也是分段算法的基本单元 */
  var BLOCK_TAGS = [
    'HTML', 'BODY', 'ARTICLE', 'ASIDE', 'SECTION', 'DIV', 'NAV', 'HEADER', 'FOOTER',
    'MAIN', 'FIGURE', 'FIGCAPTION', 'ADDRESS', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'P', 'HR', 'PRE', 'BLOCKQUOTE', 'OL', 'UL', 'LI', 'DL', 'DT', 'DD',
    'TABLE', 'CAPTION', 'COLGROUP', 'COL', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH',
    'FORM', 'FIELDSET', 'LEGEND', 'DETAILS', 'SUMMARY', 'DIALOG', 'MENU',
    'VIDEO', 'AUDIO', 'PICTURE', 'OBJECT', 'EMBED', 'IFRAME', 'CANVAS',
    'LABEL', 'OUTPUT', 'METER', 'PROGRESS', 'HGROUP', 'SEARCH'
  ];

  /** 行内标签：ownText 收集时会并入父块的文本 */
  var INLINE_TAGS = [
    'A', 'ABBR', 'ACRONYM', 'B', 'BDI', 'BDO', 'BIG', 'CITE', 'CODE', 'DATA', 'DEL',
    'DFN', 'EM', 'FONT', 'I', 'INS', 'KBD', 'MARK', 'Q', 'RUBY', 'S', 'SAMP', 'SMALL',
    'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP', 'TIME', 'TT', 'U', 'VAR', 'WBR', 'BR'
  ];

  /** 整棵子树直接跳过：这些元素里没有可翻译的正文 */
  var EXCLUDE_TAGS = [
    'HEAD', 'TITLE', 'BASE', 'LINK', 'META', 'STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE',
    'SVG', 'MATH', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'AUDIO', 'VIDEO', 'MAP', 'AREA',
    'TEXTAREA', 'SELECT', 'OPTION', 'OPTGROUP', 'DATALIST', 'INPUT', 'BUTTON', 'PROGRESS',
    'METER', 'OUTPUT', 'XMP', 'PLAINTEXT', 'LISTING', 'SOURCE', 'TRACK', 'PICTURE',
    'FRAME', 'FRAMESET', 'NOFRAMES', 'MARQUEE', 'BLINK', 'FOREIGNOBJECT'
  ];

  /** 保留原文、不翻译（通常为行内或已具备语义） */
  var STAY_ORIGINAL_TAGS = [
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'TT', 'SUP', 'SUB',
    'MATH', 'SEMANTICS', 'mrow', 'MO', 'mfrac', 'msup', 'msub', 'mi', 'mn', 'msqrt',
    'RTC', 'RT', 'RP', 'RUBY'
  ];

  /* ------------------------------------------------------------------ *
   * 2. 识别阈值（默认值取自真实构建产物的关键常量）
   * ------------------------------------------------------------------ */

  var DEFAULT_THRESHOLDS = {
    /** 单段最少字符数，低于此值不翻译 */
    paragraphMinTextCount: 2,
    /** 整页正文最少字符数，低于此值整页不翻译 */
    mainFrameMinTextCount: 50
  };

  /* ------------------------------------------------------------------ *
   * 3. 语言与引擎
   * ------------------------------------------------------------------ */

  var LANGUAGES = [
    { code: 'auto', label: '自动检测' },
    { code: 'zh-Hans', label: '简体中文' },
    { code: 'zh-Hant', label: '繁體中文' },
    { code: 'en', label: 'English' },
    { code: 'ja', label: '日本語' },
    { code: 'ko', label: '한국어' },
    { code: 'fr', label: 'Français' },
    { code: 'de', label: 'Deutsch' },
    { code: 'es', label: 'Español' },
    { code: 'pt', label: 'Português' },
    { code: 'ru', label: 'Русский' },
    { code: 'it', label: 'Italiano' },
    { code: 'ar', label: 'العربية' },
    { code: 'th', label: 'ไทย' },
    { code: 'vi', label: 'Tiếng Việt' },
    { code: 'id', label: 'Bahasa Indonesia' },
    { code: 'hi', label: 'हिन्दी' },
    { code: 'tr', label: 'Türkçe' }
  ];

  /**
   * 引擎字段模板。
   *
   * v1.4.0 起这三个条目不再是「预置引擎」，只是新建引擎时用来补齐
   * 通用字段（queryKey / headers / extraBody / responsePath …）的样板，
   * 不会出现在用户的引擎列表里。
   */
  var ENGINE_PRESETS = {
    'openai-compatible': {
      id: 'openai-compatible',
      name: 'OpenAI 兼容接口',
      type: 'ai',
      format: 'openai',
      /** 留空 = 按 format 自动推断（如 /chat/completions） */
      path: '',
      /** 默认给 OpenAI 官方地址（与卡片名一致）；换供应商时直接改这一行 */
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      key: '',
      /** auto | bearer | x-api-key | api-key | query | none */
      auth: 'auto',
      queryKey: 'key',
      headers: {},
      extraBody: {},
      responsePath: '',
      /** system | developer | user */
      systemRole: '',
      temperature: 0.2,
      maxTokens: 0,
      timeout: 90,
      batchSize: 1
    },
    anthropic: {
      id: 'anthropic',
      name: 'Anthropic Claude',
      type: 'ai',
      format: 'anthropic',
      path: '',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
      key: '',
      auth: 'x-api-key',
      queryKey: 'key',
      headers: {},
      extraBody: {},
      responsePath: '',
      systemRole: '',
      temperature: 0.2,
      maxTokens: 8000,
      timeout: 120,
      batchSize: 1
    },
    gemini: {
      id: 'gemini',
      name: 'Google Gemini',
      type: 'ai',
      format: 'gemini',
      path: '',
      baseUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-2.0-flash',
      key: '',
      auth: 'query',
      queryKey: 'key',
      headers: {},
      extraBody: {},
      responsePath: '',
      systemRole: '',
      temperature: 0.2,
      maxTokens: 8000,
      timeout: 120,
      batchSize: 1
    }
  };

  /**
   * 供应商预设库。
   *
   * 选一个预设即可自动填好 Base URL、接口路径、鉴权方式与模型名；
   * 「通用大模型接口」内核还会在地址不对时自动尝试常见变体
   * （例如漏写 /v1），所以大部分情况下填完 Key 就能直接用。
   */
  var PROVIDER_PRESETS = [
    /* ---------- 国际 ---------- */
    { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
      path: '/chat/completions', format: 'openai', auth: 'bearer', model: 'gpt-4o-mini' },
    { id: 'anthropic', name: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com',
      path: '/v1/messages', format: 'anthropic', auth: 'x-api-key', model: 'claude-sonnet-4-5' },
    { id: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com',
      path: '/v1beta/models/{model}:generateContent', format: 'gemini', auth: 'query',
      model: 'gemini-2.0-flash' },
    { id: 'deepseek', name: 'DeepSeek 深度求索', baseUrl: 'https://api.deepseek.com',
      path: '/chat/completions', format: 'openai', auth: 'bearer', model: 'deepseek-chat' },
    { id: 'kimi', name: 'Kimi 月之暗面', baseUrl: 'https://api.moonshot.cn/v1',
      path: '/chat/completions', format: 'openai', auth: 'bearer', model: 'moonshot-v1-8k' },
    { id: 'qwen', name: '通义千问 DashScope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      path: '/chat/completions', format: 'openai', auth: 'bearer', model: 'qwen-plus' },
    { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      path: '/chat/completions', format: 'openai', auth: 'bearer', model: 'glm-4-flash' },
    { id: 'doubao', name: '豆包 火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      path: '/chat/completions', format: 'openai', auth: 'bearer', model: '' },
    { id: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1',
      path: '/chat/completions', format: 'openai', auth: 'bearer', model: 'MiniMax-M3.1-Flash' },
    { id: 'baichuan', name: '百川智能', baseUrl: 'https://api.baichuan-ai.com/v1',
      path: '/chat/completions', format: 'openai', auth: 'bearer', model: 'Baichuan4' },
    { id: 'siliconflow', name: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1',
      path: '/chat/completions', format: 'openai', auth: 'bearer', model: 'deepseek-ai/DeepSeek-V3' },
    { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1',
      path: '/chat/completions', format: 'openai', auth: 'bearer', model: 'openai/gpt-4o-mini' },
    { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1',
      path: '/chat/completions', format: 'openai', auth: 'bearer', model: 'llama-3.3-70b-versatile' },
    { id: 'together', name: 'Together AI', baseUrl: 'https://api.together.xyz/v1',
      path: '/chat/completions', format: 'openai', auth: 'bearer', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
    { id: 'fireworks', name: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1',
      path: '/chat/completions', format: 'openai', auth: 'bearer', model: 'accounts/fireworks/models/llama-v3p3-70b-instruct' },
    { id: 'xai', name: 'xAI Grok', baseUrl: 'https://api.x.ai/v1',
      path: '/chat/completions', format: 'openai', auth: 'bearer', model: 'grok-2-latest' },
    { id: 'mistral', name: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1',
      path: '/chat/completions', format: 'openai', auth: 'bearer', model: 'mistral-small-latest' },
    { id: 'azure', name: 'Azure OpenAI', baseUrl: '',
      path: '/openai/deployments/{model}/chat/completions?api-version=2024-10-21',
      format: 'openai', auth: 'api-key', model: '' },
    { id: 'openai-responses', name: 'OpenAI Responses API', baseUrl: 'https://api.openai.com/v1',
      path: '/responses', format: 'custom', auth: 'bearer', model: 'gpt-4o-mini',
      responsePath: 'output.0.content.0.text' },

    /* ---------- 国内 ---------- */
    { id: 'hunyuan', name: '腾讯混元', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
      path: '/chat/completions', format: 'openai', auth: 'bearer', model: 'hunyuan-turbos' },
    { id: 'qianfan', name: '百度千帆', baseUrl: 'https://qianfan.baidubce.com/v2',
      path: '/chat/completions', format: 'openai', auth: 'bearer', model: 'ernie-4.5-turbo-128k' },
    { id: 'volcengine', name: '火山引擎（豆包）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      path: '/chat/completions', format: 'openai', auth: 'bearer', model: '' },
    { id: 'modelscope', name: '魔搭 ModelScope', baseUrl: 'https://api-inference.modelscope.cn/v1',
      path: '/chat/completions', format: 'openai', auth: 'bearer', model: 'Qwen/Qwen2.5-72B-Instruct' },

    /* ---------- 本地 / 自建 ---------- */
    { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://localhost:11434/v1',
      path: '/chat/completions', format: 'openai', auth: 'none', model: 'qwen3:8b' },
    { id: 'vllm', name: '本地 vLLM', baseUrl: 'http://localhost:8000/v1',
      path: '/chat/completions', format: 'openai', auth: 'none', model: '' },
    { id: 'lmstudio', name: '本地 LM Studio', baseUrl: 'http://localhost:1234/v1',
      path: '/chat/completions', format: 'openai', auth: 'none', model: '' },
    { id: 'newapi', name: 'New API / One API 聚合站', baseUrl: '',
      path: '/v1/chat/completions', format: 'openai', auth: 'bearer', model: '' },

    /* ---------- 演示（本地跑，不联网、不需要 Key） ---------- */
    { id: 'demo', name: '演示模式（本地示例，无需 Key）', baseUrl: '',
      path: '', format: 'demo', auth: 'none', model: 'demo' }
  ];

  /* ------------------------------------------------------------------ *
   * 4. PII 类型
   * ------------------------------------------------------------------ */

  var PII_TYPES = [
    { id: 'EMAIL_ADDRESS', label: '邮箱地址', hint: 'someone@example.com' },
    { id: 'PHONE_NUMBER', label: '电话号码', hint: '+1 555 010 9999' },
    { id: 'CREDIT_CARD', label: '信用卡号', hint: '4111 1111 1111 1111' },
    { id: 'ID_NUMBER', label: '身份证号', hint: '110101199003074567' },
    { id: 'IP_ADDRESS', label: 'IP 地址', hint: '192.168.1.10' },
    { id: 'URL', label: '网址', hint: 'https://example.com/a' },
    { id: 'IBAN', label: '银行账号', hint: 'DE89370400440532013000' }
  ];

  /* ------------------------------------------------------------------ *
   * 5. 默认配置
   * ------------------------------------------------------------------ */

  var DEFAULT_CONFIG = {
    version: 1,
    /** 站点无关的通用规则，所有页面都会继承 */
    generalRule: {
      translationMode: 'dual', // dual | translation | original
      translationPosition: 'after', // after | before
      sourceLang: 'auto',
      targetLang: 'zh-Hans',
      /** 参与翻译的标签白名单（空 = 全部叶子块） */
      tags: [],
      /** 额外排除的 CSS 选择器 */
      excludeSelectors: [],
      /**
       * 是否连站点框架（导航 / 侧栏 / 页脚 / 面包屑）一起翻译。
       * false = 只翻正文；true = 整页翻译。
       */
      translateChrome: false,
      /** 覆盖阈值 */
      thresholds: {},
      /** 主页面正文容器选择器（可选，用于精确定位正文） */
      mainSelector: ''
    },
    /** 站点规则 */
    rules: [],
    /**
     * 引擎配置。
     *
     * v1.4.0 起不再预置任何引擎：用户在设置页「选择翻译引擎」里挑一个，
     * 填好地址 / 模型 / Key 之后才会出现在这里。
     */
    engines: {},
    /** 当前使用的引擎 id（空 = 还没选） */
    engine: '',
    /**
     * 翻译风格场景 id（对应 IMT.PROMPT_SCENARIOS）
     * 「通用」= general
     */
    scenario: 'general',
    /** 是否按网址自动匹配更贴切的场景（GitHub → github 之类） */
    autoScenario: true,
    /** 用户自定义场景：{ id: { name, desc, systemPrompt, matches } } */
    customScenarios: {},
    /** 全局目标语言（可被站点规则覆盖） */
    targetLang: 'zh-Hans',
    /** PII 脱敏 */
    pii: {
      enabled: true,
      types: PII_TYPES.map(function (t) { return t.id; })
    },
    /** 术语库：[{ from, to, caseSensitive }] */
    glossary: [],
    /** 缓存 */
    cache: {
      enabled: true,
      maxAgeDay: 30
    },
    /** 懒翻译：进入视口才翻译 */
    lazy: true,
    /** 增量翻译：监听 DOM 变化补翻 */
    incremental: true,
    /** 打开页面自动翻译 */
    autoTranslate: false,
    /** 译文渲染 */
    render: {
      targetWrapperTag: 'font',
      showOriginal: true,
      fontSize: 'inherit',
      lineHeight: '1.7',
      spacing: 8
    },
    /** 高级 */
    debug: false
  };

  /* ------------------------------------------------------------------ *
   * 6. 导出
   * ------------------------------------------------------------------ */

  IMT.BLOCK_TAGS = BLOCK_TAGS;
  IMT.INLINE_TAGS = INLINE_TAGS;
  IMT.EXCLUDE_TAGS = EXCLUDE_TAGS;
  IMT.STAY_ORIGINAL_TAGS = STAY_ORIGINAL_TAGS;
  IMT.DEFAULT_THRESHOLDS = DEFAULT_THRESHOLDS;
  IMT.LANGUAGES = LANGUAGES;
  IMT.ENGINE_PRESETS = ENGINE_PRESETS;
  IMT.PROVIDER_PRESETS = PROVIDER_PRESETS;
  IMT.PII_TYPES = PII_TYPES;
  IMT.DEFAULT_CONFIG = DEFAULT_CONFIG;
  IMT.STORAGE_KEY = 'imtl.config';
  IMT.CACHE_KEY_PREFIX = 'imtl.cache.';
  IMT.VERSION = '1.4.2';
})(typeof globalThis !== 'undefined' ? globalThis : this);
