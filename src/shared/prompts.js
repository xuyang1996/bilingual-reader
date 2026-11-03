/*!
 * Bilingual Reader — 翻译风格与场景库
 *
 * 每个场景是一段「领域提示词」：告诉模型当前这段文字属于哪一类，
 * 以及这类文字特有的术语、格式与语气该怎么处理。
 *
 * 场景提示词改编自开源项目 immersive-translate/prompts（MIT 许可），
 * 按本扩展的段落级双语对照渲染做了裁剪与改写，并补齐了「通用」场景。
 *
 * 三层优先级（在 src/background/engines.js 的 buildSystemPrompt 里合成）：
 *   1. 引擎卡片上手填的「自定义系统提示词」——完全覆盖下面两层
 *   2. 当前选中的场景提示词
 *   3. 通用翻译规则（BASE_RULES）
 */
(function (root) {
  'use strict';

  var IMT = (root.IMT = root.IMT || {});

  /* ------------------------------------------------------------------ *
   * 通用规则：所有场景共享，也是「通用」场景的全部内容
   * ------------------------------------------------------------------ */

  var BASE_RULES = [
    'You are a professional translator for web pages.',
    'Translate the source text into natural, idiomatic {target}.',
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

  /* ------------------------------------------------------------------ *
   * 场景库
   * ------------------------------------------------------------------ */

  var SCENARIOS = [
    {
      id: 'general',
      name: '通用',
      desc: '适合绝大多数网页的均衡翻译：忠实、简洁、不添油加醋。',
      builtin: true,
      systemPrompt: '',
      matches: []
    },
    {
      id: 'tech',
      name: '科技 / 软件',
      desc: '技术博客与软件资讯。代码、命令、标识符、产品名原样保留。',
      builtin: true,
      systemPrompt: [
        'Translate technology and software content into {target} with precise technical',
        'meaning and natural target-language terminology. Preserve code, commands,',
        'identifiers, programming-language syntax, paths, product and company names,',
        'model names, and technical abbreviations exactly where they function as source',
        'tokens. Use established localized UI labels and technical terms where available',
        'without changing procedures, constraints, or conceptual relationships.'
      ].join(' '),
      matches: [
        'https://techcrunch.com/*', 'https://www.theverge.com/*', 'https://arstechnica.com/*',
        'https://www.cnet.com/*', 'https://www.engadget.com/*', 'https://gizmodo.com/*',
        'https://www.techradar.com/*', 'https://www.zdnet.com/*', 'https://www.pcmag.com/*',
        'https://www.digitaltrends.com/*', 'https://www.techrepublic.com/*',
        'https://news.ycombinator.com/*'
      ]
    },
    {
      id: 'news',
      name: '新闻 / 媒体',
      desc: '新闻报道。事实、限定语、引语、署名与日期地名准确，不加工不评论。',
      builtin: true,
      systemPrompt: [
        'Translate news content into {target} in clear, professional journalistic language',
        'without editorializing. Preserve facts, qualifications, attribution, quotations,',
        'names, titles, organizations, places, dates, figures, and datelines accurately,',
        'using established target-language names where available. Render headlines concisely',
        'and naturally without dropping facts, changing emphasis, or exaggerating the source.'
      ].join(' '),
      matches: [
        'https://www.cnn.com/*', 'https://www.bbc.com/*', 'https://www.nytimes.com/*',
        'https://www.theguardian.com/*', 'https://www.reuters.com/*', 'https://www.cnbc.com/*',
        'https://www.aljazeera.com/*', 'https://www.washingtonpost.com/*',
        'https://www.economist.com/*', 'https://www.npr.org/*', 'https://apnews.com/*',
        'https://www.bloomberg.com/*'
      ]
    },
    {
      id: 'paper',
      name: '学术论文',
      desc: '论文与研究报告。公式、统计量、引文原样保留，不削弱结论强度。',
      builtin: true,
      systemPrompt: [
        'Translate academic and research content into {target} using precise disciplinary',
        'terminology and a formal scholarly register. Preserve the scope, uncertainty,',
        'complexity, and logical force of claims without simplifying or strengthening them.',
        'Treat quantitative expressions and author-year citations as protected source spans:',
        'copy formulas, statistical labels, values, brackets, ASCII punctuation, and author',
        'strings exactly as written, including forms such as `β = 0.42`,',
        '`95% CI [0.10, 0.74]`, `p < 0.05`, and `Smith et al. (2021)`; translate only the',
        'surrounding prose. Keep scientific notation, symbols, references, bibliographic data,',
        'abbreviations, and named methods accurate, using established target-language',
        'terminology where available outside those protected spans.'
      ].join(' '),
      matches: [
        'https://arxiv.org/*', 'https://www.sciencedirect.com/*', 'https://www.jstor.org/*',
        'https://www.springer.com/*', 'https://link.springer.com/*', 'https://ieeexplore.ieee.org/*',
        'https://www.acm.org/*', 'https://dl.acm.org/*', 'https://pubmed.ncbi.nlm.nih.gov/*',
        'https://www.nature.com/*', 'https://www.science.org/*'
      ]
    },
    {
      id: 'programming-docs',
      name: '编程文档',
      desc: 'Java / Spring / Android / Kotlin / Flutter / Web 文档。API 名与代码逐字保留。',
      builtin: true,
      systemPrompt: [
        'Translate programming documentation and technical subtitles into {target} faithfully',
        'and naturally. Translate prose according to its software-development context; do not',
        'treat an ordinary word as an API term solely because it has the same spelling.',
        'Preserve actual API identifiers, class and function names, and inline code exactly.',
        'Preserve each identifier character for character; never shorten or rewrite one',
        '(`StatelessWidget` must not become `StateWidget`). Outside code, translate ordinary',
        'words and technical prose using established target-language development terminology.',
        'Preserve code blocks, inline code, commands, paths, placeholders, string literals,',
        'and comments inside code blocks exactly, including opening and closing fences. Never',
        'translate code comments; translate explanatory prose around code normally.',
        'Preserve the source modality, constraints, ownership, sequence, state, and lifecycle',
        'relationships, including distinctions such as must versus may and immutable versus',
        'mutable. Do not add explanations or alter the stated behavior.'
      ].join(' '),
      matches: [
        'https://developer.android.com/*', 'https://docs.oracle.com/*',
        'https://docs.spring.io/*', 'https://developer.mozilla.org/*',
        'https://flutter.dev/*', 'https://docs.flutter.dev/*', 'https://kotlinlang.org/*',
        'https://docs.python.org/*', 'https://docs.rs/*', 'https://go.dev/doc/*'
      ]
    },
    {
      id: 'github',
      name: 'GitHub',
      desc: '仓库、Issue、PR 与评论。Markdown 结构、代码块与链接原样保留。',
      builtin: true,
      systemPrompt: [
        'Translate GitHub repositories, issues, pull requests, and comments into {target} using',
        'accurate software-development terminology. Preserve code, commands, identifiers,',
        'paths, URLs, version numbers, and technical syntax exactly, and retain the source',
        "item's Markdown structure, including headings, lists, tables, links, and code blocks.",
        'Use established target-language forms for GitHub features and technical concepts',
        'where they exist.'
      ].join(' '),
      matches: ['https://github.com/*', 'https://gist.github.com/*']
    },
    {
      id: 'legal',
      name: '法律',
      desc: '法律条文与判例。定义术语、法条引用、案号逐字保留，不加解释。',
      builtin: true,
      systemPrompt: [
        'Translate legal content into {target} with precise legal meaning and the appropriate',
        'jurisdictional register. Preserve defined terms, citations, case and clause',
        'references, numbering relationships, institutions, dates, abbreviations, Latin terms,',
        'and modal force such as obligations, permissions, and prohibitions. Treat formal case',
        'citations as protected source spans: copy the case name, reporter reference, year,',
        'ASCII punctuation, and parentheses exactly as written, and translate only the',
        'surrounding prose. For example, retain `Doe v. State, 410 U.S. 113 (1973)` verbatim',
        'rather than translating the party names or changing `(1973)` to localized punctuation.',
        'Do not add legal interpretation, advice, or implications absent from the source.'
      ].join(' '),
      matches: [
        'https://www.law.com/*', 'https://www.law360.com/*', 'https://www.jurist.org/*',
        'https://www.law.cornell.edu/*', 'https://www.findlaw.com/*', 'https://www.justia.com/*',
        'https://www.nolo.com/*', 'https://supreme.justia.com/*'
      ]
    },
    {
      id: 'medical',
      name: '医疗健康',
      desc: '医学资料。解剖、诊断、药名、剂量与编码准确，不添加诊疗建议。',
      builtin: true,
      systemPrompt: [
        'Translate medical content into {target} using standard target-language medical',
        'terminology. Preserve the exact meaning of anatomy, conditions, diagnoses,',
        'procedures, medicines, dosages, measurements, abbreviations, and codes such as ICD',
        'or CPT; keep numerical values and units accurate. Do not add diagnoses,',
        'recommendations, warnings, or medical advice that are not present in the source.'
      ].join(' '),
      matches: [
        'https://www.mayoclinic.org/*', 'https://www.webmd.com/*',
        'https://www.medicinenet.com/*', 'https://www.ncbi.nlm.nih.gov/*',
        'https://www.who.int/*', 'https://www.cdc.gov/*'
      ]
    },
    {
      id: 'financial',
      name: '金融财经',
      desc: '行情、研报与公告。金融术语规范，数值、百分比、货币与单位精确。',
      builtin: true,
      systemPrompt: [
        'Translate financial content into {target} with precise, professional market language.',
        'Preserve the meaning of financial instruments, institutions, indicators, metrics, and',
        'market claims, and use established target-language financial terminology. Keep',
        'numerical values, percentages, currency codes, units, and factual relationships exact',
        'while allowing conventional target-language formatting that does not change their value.'
      ].join(' '),
      matches: [
        'https://www.bloomberg.com/*', 'https://www.wsj.com/*', 'https://www.ft.com/*',
        'https://finance.yahoo.com/*', 'https://www.investopedia.com/*',
        'https://www.marketwatch.com/*', 'https://www.reuters.com/markets/*'
      ]
    },
    {
      id: 'ecommerce',
      name: '电商购物',
      desc: '商品页与详情。品牌、型号、规格、价格与促销条件准确，不夸大宣传。',
      builtin: true,
      systemPrompt: [
        'Translate e-commerce content into {target} using clear, persuasive language',
        'appropriate for shoppers without inventing, strengthening, or omitting product',
        'claims. Preserve brands, product codes, model identifiers, variant distinctions,',
        'numerical specifications, prices, and promotion conditions accurately. Localize',
        'specification labels, units, and commerce terminology naturally where appropriate',
        'while retaining the original facts.'
      ].join(' '),
      matches: [
        'https://www.temu.com/*', 'https://www.tmall.com/*', 'https://www.jd.com/*',
        'https://www.amazon.com/*', 'https://www.ebay.com/*', 'https://www.shopify.com/*',
        'https://www.alibaba.com/*', 'https://www.taobao.com/*', 'https://www.etsy.com/*'
      ]
    },
    {
      id: 'customer-service',
      name: '客服对话',
      desc: '客服短讯。语气与责任归属不变，绝不替客服答复或做出承诺。',
      builtin: true,
      systemPrompt: [
        'Translate only the customer service text provided into {target}. This is bidirectional',
        'translation for short cross-border commerce messages: render English messages in',
        'natural Chinese, and render Chinese messages as natural, professional, faithful English',
        'messages. Keep the original speaker\'s point of view and emotional intensity; use',
        'natural phrasing without marketing embellishment or excessive polishing. Expand an',
        'abbreviation only when the surrounding text makes its meaning clear; when it is',
        'ambiguous, preserve it or translate only what is clear without guessing. Preserve',
        'the exact meaning and scope of refund conditions, eligibility, exceptions, negation,',
        'who is responsible for an action, amounts, order identifiers, and links. Preserve',
        'whether a shipping or delivery time is an estimate, a range, or a guarantee; never turn',
        'an estimate into a promise. Do not add an apology, commitment, policy, explanation, or',
        'information from assumed history. Do not answer the customer, make a decision, or',
        'perform a customer-service action; translate only the supplied text.'
      ].join(' '),
      matches: []
    },
    {
      id: 'fiction',
      name: '文学小说',
      desc: '叙事文本。人物口吻、情绪、节奏与比喻保留，人名用通行译名。',
      builtin: true,
      systemPrompt: [
        'Translate fiction into {target} as natural literary prose. Preserve narrative voice,',
        'characterization, dialogue register, emotional nuance, pacing, metaphors, idioms,',
        'and cultural references rather than translating mechanically. Use established',
        'target-language translations for character names and recurring or invented concepts',
        'when available; otherwise choose contextually appropriate renderings that fit the work.'
      ].join(' '),
      matches: [
        'https://www.wattpad.com/*', 'https://www.webnovel.com/*', 'https://www.qidian.com/*',
        'https://www.17k.com/*', 'https://www.wuxiaworld.com/*', 'https://www.royalroad.com/*'
      ]
    },
    {
      id: 'social',
      name: '社交媒体',
      desc: '帖子与短文。语气轻快、口语化，保留话题标签、@提及与表情符号。',
      builtin: true,
      systemPrompt: [
        'Translate social media posts and short-form content into {target} with a natural,',
        'conversational register that matches the original tone. Keep hashtags, @-mentions,',
        'emoji, and URLs exactly as they are. Preserve the author\'s attitude, hedging, irony,',
        'and slang rather than flattening them into formal language. Keep the text short and',
        'punchy: do not pad the translation with explanations or formal connectives.'
      ].join(' '),
      matches: [
        'https://twitter.com/*', 'https://x.com/*', 'https://www.reddit.com/*',
        'https://news.ycombinator.com/*', 'https://www.douban.com/*', 'https://weibo.com/*'
      ]
    },
    {
      id: 'plain-english',
      name: '简明英语',
      desc: '把复杂英文改写成通俗易懂的英语。适合英语学习与难文速读。',
      builtin: true,
      systemPrompt: [
        'Rewrite each source item in clear, natural, plain English while preserving its meaning,',
        'key facts, tone, purpose, and document structure. Prefer familiar everyday vocabulary,',
        'replace avoidable jargon and obscure wording, and split overly complex sentences when',
        'that improves clarity. Keep necessary technical terms, proper nouns, numbers,',
        'formatting, and HTML tags accurate. Do not add explanations or information absent from',
        'the source.'
      ].join(' '),
      matches: []
    }
  ];

  /* ------------------------------------------------------------------ *
   * 工具
   * ------------------------------------------------------------------ */

  /** 把通配符网址模式编译成正则（* 匹配任意串） */
  function urlPatternToRegExp(pattern) {
    var escaped = String(pattern)
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    try {
      return new RegExp('^' + escaped + '$', 'i');
    } catch (e) {
      return null;
    }
  }

  /** 内置场景 + 用户自定义场景（自定义与内置同 id 时覆盖内置） */
  function list(custom) {
    var out = SCENARIOS.slice();
    if (custom && typeof custom === 'object') {
      Object.keys(custom).forEach(function (id) {
        var c = custom[id];
        if (!c || !c.systemPrompt) return;
        var item = {
          id: id,
          name: c.name || id,
          desc: c.desc || '',
          builtin: false,
          systemPrompt: c.systemPrompt || '',
          matches: Array.isArray(c.matches) ? c.matches : []
        };
        var idx = -1;
        for (var i = 0; i < out.length; i++) {
          if (out[i].id === id) { idx = i; break; }
        }
        if (idx >= 0) {
          // 覆盖内置：仍是内置场景，只是提示词被改过。
          // 网址规则取并集 —— 用户只改了提示词时，不该丢掉内置的自动匹配。
          var base = out[idx];
          var merged = (base.matches || []).slice();
          (item.matches || []).forEach(function (m) {
            if (merged.indexOf(m) < 0) merged.push(m);
          });
          item.matches = merged;
          item.builtin = base.builtin;
          item.overrides = true;
          out[idx] = item;
        } else {
          out.push(item);
        }
      });
    }
    return out;
  }

  /** 按 id 取场景 */
  function get(id, custom) {
    if (!id) return null;
    var all = list(custom);
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id) return all[i];
    }
    return null;
  }

  /**
   * 按网址自动匹配场景。
   * 返回场景 id；匹配不到返回 null（调用方回落到用户手选的场景）。
   */
  function match(url, custom) {
    if (!url) return null;
    var all = list(custom);
    for (var i = 0; i < all.length; i++) {
      var sc = all[i];
      var ms = sc.matches || [];
      for (var j = 0; j < ms.length; j++) {
        var re = urlPatternToRegExp(ms[j]);
        if (re && re.test(url)) return sc.id;
      }
    }
    return null;
  }

  /**
   * 合成最终系统提示词。
   *
   * @param {object} opts
   *   opts.scenario       场景 id
   *   opts.customScenarios 用户自定义场景表
   *   opts.targetLang     目标语言代码
   *   opts.targetName     目标语言名称（中文名）
   *   opts.enginePrompt   引擎卡片上手填的提示词（有则完全覆盖其余部分）
   *   opts.glossary       术语表提示词
   * @returns {string}
   */
  function buildSystemPrompt(opts) {
    opts = opts || {};
    var target = opts.targetName || opts.targetLang || 'the target language';

    // 1. 引擎自定义提示词优先
    if (opts.enginePrompt) {
      return String(opts.enginePrompt).replace(/\{target\}/g, target);
    }

    var sc = get(opts.scenario, opts.customScenarios);
    var parts = [BASE_RULES.replace(/\{target\}/g, target)];

    if (sc && sc.systemPrompt) {
      parts.push([
        '',
        '## Style for this content (' + (sc.name || sc.id) + ')',
        String(sc.systemPrompt).replace(/\{target\}/g, target)
      ].join('\n'));
    }

    if (opts.glossary) parts.push(String(opts.glossary));

    return parts.join('\n');
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */

  IMT.PROMPT_SCENARIOS = SCENARIOS;
  IMT.prompts = {
    BASE_RULES: BASE_RULES,
    list: list,
    get: get,
    match: match,
    buildSystemPrompt: buildSystemPrompt,
    urlPatternToRegExp: urlPatternToRegExp
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
