/*!
 * Bilingual Reader — 术语库
 *
 * 两种用法：
 *  1) buildPrompt()：把术语塞进 AI 引擎的 system prompt，让模型直接按术语翻译。
 *  2) apply()：翻译返回后再做一次强制替换，保证术语命中。
 */
(function (root) {
  'use strict';

  var IMT = (root.IMT = root.IMT || {});
  var U = IMT.utils;
  var G = {};

  /**
   * 归一化术语条目：{ from, to, caseSensitive }
   */
  G.normalize = function (entry) {
    if (typeof entry === 'string') {
      var parts = entry.split(/\t+|->|=>|\|/);
      return { from: (parts[0] || '').trim(), to: (parts[1] || '').trim(), caseSensitive: false };
    }
    if (!entry || typeof entry !== 'object') return null;
    var from = String(entry.from || '').trim();
    var to = String(entry.to || '').trim();
    if (!from || !to) return null;
    return { from: from, to: to, caseSensitive: !!entry.caseSensitive };
  };

  /** 过滤掉非法项 */
  G.clean = function (list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    var seen = Object.create(null);
    list.forEach(function (e) {
      var n = G.normalize(e);
      if (!n) return;
      var key = n.from.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push(n);
    });
    return out;
  };

  /**
   * 构造术语提示词。
   * @returns {string} 没有术语时返回空串
   */
  G.buildPrompt = function (glossary, sourceLang, targetLang) {
    var list = G.clean(glossary);
    if (!list.length) return '';
    var lines = list.map(function (e) {
      return '- ' + e.from + ' => ' + e.to;
    });
    return [
      'You are a professional translator. Translate the user text into ' + targetLang + '.',
      'Follow this glossary strictly — use exactly the given target term for the source term:',
      lines.join('\n'),
      'Return only the translated text, with no explanations, no quotes and no numbering.',
      'If the source text contains multiple segments separated by a line starting with "###",',
      'translate each segment separately and keep the "###" separators untouched.'
    ].join('\n');
  };

  /**
   * 翻译后的强制替换。
   * 把译文里出现的源术语（含常见变形）替换为指定译法。
   */
  G.apply = function (text, glossary) {
    var list = G.clean(glossary);
    var src = String(text == null ? '' : text);
    if (!list.length) return src;

    list.forEach(function (e) {
      if (e.caseSensitive) {
        src = src.split(e.from).join(e.to);
        return;
      }
      // 词边界：只替换完整单词，避免把 "AI" 替换进 "AIR"
      var escaped = U.escapeRegExp(e.from);
      var re = new RegExp('(^|[^A-Za-z0-9_])(' + escaped + ')(?![A-Za-z0-9_])', 'g');
      src = src.replace(re, function (m, pre, word) {
        return pre + e.to;
      });
    });
    return src;
  };

  /**
   * 解析 TSV / CSV 文本（术语库导入用）
   * 支持：from<TAB>to  或  from,to
   */
  G.parseText = function (text) {
    var lines = String(text || '').split(/\r?\n/);
    var out = [];
    lines.forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed || trimmed.charAt(0) === '#') return;
      var sep = trimmed.indexOf('\t') >= 0 ? '\t' : (trimmed.indexOf(',') >= 0 ? ',' : null);
      if (!sep) return;
      var idx = trimmed.indexOf(sep);
      var from = trimmed.slice(0, idx).trim();
      var to = trimmed.slice(idx + 1).trim();
      if (from && to) out.push({ from: from, to: to, caseSensitive: false });
    });
    return G.clean(out);
  };

  /** 导出为 TSV */
  G.toText = function (glossary) {
    return G.clean(glossary)
      .map(function (e) { return e.from + '\t' + e.to; })
      .join('\n');
  };

  IMT.glossary = G;
})(typeof globalThis !== 'undefined' ? globalThis : this);
