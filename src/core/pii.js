/*!
 * Bilingual Reader — PII（个人可识别信息）脱敏
 *
 * 流程：encode() 把敏感片段替换成占位符 → 文本送往翻译引擎 →
 *       decode() 把占位符还原为原文。占位符形如 __PII_EMAIL_ADDRESS_1__。
 */
(function (root) {
  'use strict';

  var IMT = (root.IMT = root.IMT || {});
  var P = {};

  /**
   * 每种类型的正则。
   * 顺序有意义：先匹配更长、更具体的形式。
   */
  P.PATTERNS = {
    EMAIL_ADDRESS: {
      label: '邮箱地址',
      re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
    },
    IBAN: {
      label: '银行账号',
      re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g
    },
    CREDIT_CARD: {
      label: '信用卡号',
      re: /\b(?:\d[ -]*?){13,19}\b/g
    },
    ID_NUMBER: {
      label: '身份证号',
      re: /\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g
    },
    IP_ADDRESS: {
      label: 'IP 地址',
      re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
    },
    PHONE_NUMBER: {
      label: '电话号码',
      re: /\+?\d[\d\s().-]{7,17}\d/g
    },
    URL: {
      label: '网址',
      re: /\bhttps?:\/\/[^\s<>"'`）】\]]+/g
    }
  };

  P.ALL_TYPES = Object.keys(P.PATTERNS);

  /** 生成占位符 */
  function placeholder(type, index) {
    return '__PII_' + type + '_' + index + '__';
  }

  /**
   * 编码：把敏感信息替换为占位符。
   * @param {string} text
   * @param {string[]} types 启用的类型
   * @returns {{text: string, map: Object}} map: { 占位符: 原文 }
   */
  P.encode = function (text, types) {
    var src = String(text == null ? '' : text);
    var use = (types && types.length) ? types : P.ALL_TYPES;
    var map = {};

    // 先处理更具体的类型，避免长 URL 被 PHONE_NUMBER 拆开
    var order = use.slice().sort(function (a, b) {
      var pa = P.PATTERNS[a], pb = P.PATTERNS[b];
      if (!pa || !pb) return 0;
      return (pb.re.source.length - pb.re.global) - (pa.re.source.length - pa.global);
    });

    order.forEach(function (type) {
      var def = P.PATTERNS[type];
      if (!def) return;
      var re = new RegExp(def.re.source, def.re.flags.indexOf('g') >= 0 ? def.re.flags : def.re.flags + 'g');
      src = src.replace(re, function (match) {
        // 已脱敏过的占位符本身不要重复处理
        if (/^__PII_[A-Z_]+_\d+__$/.test(match)) return match;
        var key = placeholder(type, 1);
        while (map[key] !== undefined) {
          var n = parseInt(key.match(/_(\d+)__$/)[1], 10) + 1;
          key = placeholder(type, n);
        }
        map[key] = match;
        return key;
      });
    });

    return { text: src, map: map };
  };

  /**
   * 解码：把占位符还原为原文。
   * 引擎偶尔会改写占位符（例如加上空格），因此使用宽松匹配。
   */
  P.decode = function (text, map) {
    var src = String(text == null ? '' : text);
    if (!map) return src;
    Object.keys(map).forEach(function (key) {
      var type = key.match(/^__PII_([A-Z_]+)_\d+__$/);
      // 容忍引擎在占位符内部插入空格（__PII_ EMAIL_ADDRESS _1__）
      var loose = type
        ? new RegExp('__\\s*PII\\s*_\\s*' + type[1] + '\\s*_?\\d*\\s*__', 'gi')
        : new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      src = src.replace(loose, function () { return map[key]; });
    });
    return src;
  };

  /**
   * 扫描文本，判断命中了哪些类型（用于 UI 提示与日志）
   */
  P.scan = function (text) {
    var hits = {};
    P.ALL_TYPES.forEach(function (type) {
      var def = P.PATTERNS[type];
      var re = new RegExp(def.re.source, 'g');
      var m = src(text).match(re);
      if (m && m.length) hits[type] = m.length;
    });
    return hits;
    function src(t) { return String(t == null ? '' : t); }
  };

  IMT.pii = P;
})(typeof globalThis !== 'undefined' ? globalThis : this);
