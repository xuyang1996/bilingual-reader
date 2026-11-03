/*!
 * Bilingual Reader — 站点规则解析
 *
 * 规则结构：
 * {
 *   id, name, enabled, urlPattern: [] | '', parentId,
 *   translationMode: 'dual'|'translation'|'original',
 *   translationPosition: 'after'|'before',
 *   sourceLang, targetLang,
 *   tags: [],              // 参与翻译的标签白名单
 *   excludeSelectors: [], // 额外排除的 CSS 选择器
 *   mainSelector: '',     // 正文容器选择器
 *   translateChrome: false, // 是否连导航/侧栏/页脚一起翻（整页翻译）
 *   thresholds: {}         // 覆盖全局阈值
 * }
 */
(function (root) {
  'use strict';

  var IMT = (root.IMT = root.IMT || {});
  var U = IMT.utils;

  var R = {};

  /** 规则可覆盖的字段（用于归一化） */
  var RULE_FIELDS = [
    'translationMode', 'translationPosition', 'sourceLang', 'targetLang',
    'tags', 'excludeSelectors', 'mainSelector', 'thresholds', 'translateChrome'
  ];

  var VALID_MODES = ['dual', 'translation', 'original'];
  var VALID_POSITIONS = ['after', 'before'];

  /** 归一化一条规则，补齐默认值并裁剪非法字段 */
  R.normalize = function (rule, defaults) {
    var out = Object.assign({}, defaults || {});
    if (!rule || typeof rule !== 'object') return out;

    out.id = rule.id ? String(rule.id) : U.uid('rule');
    out.name = rule.name ? String(rule.name) : out.id;
    out.enabled = rule.enabled !== false;
    out.urlPattern = Array.isArray(rule.urlPattern)
      ? rule.urlPattern.filter(Boolean).map(String)
      : (rule.urlPattern ? [String(rule.urlPattern)] : []);
    out.parentId = rule.parentId ? String(rule.parentId) : '';

    RULE_FIELDS.forEach(function (f) {
      if (rule[f] === undefined || rule[f] === null) return;
      out[f] = rule[f];
    });

    if (VALID_MODES.indexOf(out.translationMode) < 0) out.translationMode = 'dual';
    if (VALID_POSITIONS.indexOf(out.translationPosition) < 0) out.translationPosition = 'after';
    if (!Array.isArray(out.tags)) out.tags = [];
    if (!Array.isArray(out.excludeSelectors)) out.excludeSelectors = [];
    if (!U.isPlainObject(out.thresholds)) out.thresholds = {};
    out.translateChrome = !!out.translateChrome;

    return out;
  };

  /** 规则是否匹配该 URL */
  R.matches = function (rule, url) {
    if (!rule || !rule.enabled) return false;
    var patterns = rule.urlPattern || [];
    for (var i = 0; i < patterns.length; i++) {
      if (U.matchesPattern(url, patterns[i])) return true;
    }
    return false;
  };

  /** 规则特异性：用于决定多个规则同时命中时的覆盖顺序 */
  R.specificity = function (rule) {
    var best = 0;
    (rule.urlPattern || []).forEach(function (p) {
      var s = U.patternSpecificity(p);
      if (s > best) best = s;
    });
    if (rule.parentId) best += 5;
    return best;
  };

  /**
   * 解析出最终生效的规则。
   * @param {object} config 完整配置
   * @param {string} url    当前页面 URL
   * @returns {{rule: object, matched: string[]}}
   */
  R.resolve = function (config, url) {
    var cfg = config || {};
    var base = R.normalize(cfg.generalRule, {
      translationMode: 'dual',
      translationPosition: 'after',
      sourceLang: 'auto',
      targetLang: cfg.targetLang || 'zh-Hans',
      tags: [],
      excludeSelectors: [],
      mainSelector: '',
      thresholds: {},
      translateChrome: false
    });

    var all = Array.isArray(cfg.rules) ? cfg.rules : [];
    var byId = {};
    var rawById = {};
    all.forEach(function (r) {
      var n = R.normalize(r);
      byId[n.id] = n;
      // 保留用户原始写法：继承链要用原始字段，
      // 否则 normalize 填入的默认值会覆盖父规则的显式配置
      rawById[n.id] = r && typeof r === 'object' ? r : {};
    });

    // 1. 命中当前 URL 的规则，按特异性从低到高排序（后者覆盖前者）
    var hit = all
      .map(function (r) { return R.normalize(r); })
      .filter(function (r) { return R.matches(r, url); })
      .sort(function (a, b) { return R.specificity(a) - R.specificity(b); });

    var merged = base;
    var matched = [];

    hit.forEach(function (rule) {
      var resolved = R.resolveChain(byId, rawById, rule);
      var patch = {};
      RULE_FIELDS.forEach(function (f) {
        if (resolved[f] !== undefined) patch[f] = resolved[f];
      });
      merged = U.deepMerge(merged, patch);
      matched.push(rule.id);
    });

    // 2. 全局兜底
    if (!merged.targetLang) merged.targetLang = cfg.targetLang || 'zh-Hans';
    if (!merged.sourceLang) merged.sourceLang = 'auto';

    // 3. 阈值合并
    merged.thresholds = U.deepMerge(
      U.deepMerge({}, IMT.DEFAULT_THRESHOLDS),
      U.deepMerge(merged.thresholds || {}, {})
    );

    return { rule: merged, matched: matched };
  };

  /**
   * 沿 parentId 链解析出规则的最终形态（父规则为基线）。
   * 字段取值来自用户原始写法（rawById），而不是归一化后带默认值的版本。
   */
  R.resolveChain = function (byId, rawById, rule, seen) {
    var chain = [{ norm: rule, raw: (rawById && rawById[rule.id]) || {} }];
    var guard = seen || {};
    var cur = rule;
    var depth = 0;
    while (cur && cur.parentId && byId[cur.parentId] && depth < 10) {
      if (guard[cur.parentId]) break;
      guard[cur.parentId] = true;
      cur = byId[cur.parentId];
      chain.unshift({ norm: cur, raw: (rawById && rawById[cur.id]) || {} });
      depth++;
    }
    var merged = {};
    chain.forEach(function (c) {
      var patch = {};
      RULE_FIELDS.forEach(function (f) {
        if (c.raw[f] !== undefined) patch[f] = c.raw[f];
      });
      merged = U.deepMerge(merged, patch);
    });
    return merged;
  };

  /** 校验规则，返回错误列表（options 编辑器用） */
  R.validate = function (rule) {
    var errors = [];
    if (!rule || typeof rule !== 'object') {
      errors.push('规则必须是对象');
      return errors;
    }
    if (!rule.id || !String(rule.id).trim()) errors.push('缺少 id');
    var pats = Array.isArray(rule.urlPattern) ? rule.urlPattern : (rule.urlPattern ? [rule.urlPattern] : []);
    if (!pats.length) errors.push('缺少 urlPattern');
    pats.forEach(function (p) {
      if (!String(p).trim()) errors.push('urlPattern 中存在空项');
    });
    if (rule.translationMode && VALID_MODES.indexOf(rule.translationMode) < 0) {
      errors.push('translationMode 必须是 dual / translation / original');
    }
    if (rule.translationPosition && VALID_POSITIONS.indexOf(rule.translationPosition) < 0) {
      errors.push('translationPosition 必须是 after / before');
    }
    if (rule.tags && !Array.isArray(rule.tags)) errors.push('tags 必须是数组');
    if (rule.excludeSelectors && !Array.isArray(rule.excludeSelectors)) errors.push('excludeSelectors 必须是数组');
    if (rule.thresholds && !U.isPlainObject(rule.thresholds)) errors.push('thresholds 必须是对象');
    return errors;
  };

  /** 供 options 页展示的可读摘要 */
  R.describe = function (rule) {
    var r = R.normalize(rule);
    return {
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      patterns: r.urlPattern.join(', '),
      mode: r.translationMode,
      position: r.translationPosition,
      targetLang: r.targetLang,
      parentId: r.parentId
    };
  };

  IMT.rules = R;
})(typeof globalThis !== 'undefined' ? globalThis : this);
