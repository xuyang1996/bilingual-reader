/*!
 * Bilingual Reader — 翻译缓存
 *
 * 基于 chrome.storage.local，键名 imtl.cache.<hash>，TTL 默认 30 天。
 * 缓存键包含：原文 + 源语言 + 目标语言 + 引擎，避免跨引擎串味。
 */
(function (root) {
  'use strict';

  var IMT = (root.IMT = root.IMT || {});
  var U = IMT.utils;

  var C = {};
  var DEFAULT_TTL = 30 * 24 * 60 * 60 * 1000;

  C.ttl = DEFAULT_TTL;

  /** 生成缓存键 */
  C.key = function (text, sourceLang, targetLang, engineId) {
    var raw = [engineId || '-', sourceLang || 'auto', targetLang || '-', String(text)].join('|');
    return IMT.STORAGE_KEY + ':cache:' + U.hashString(raw);
  };

  function storage() {
    return chrome.storage.local;
  }

  /** 读取单个缓存 */
  C.get = function (key) {
    return storage().get(key).then(function (data) {
      var item = data && data[key];
      if (!item || typeof item.text !== 'string') return null;
      if (Date.now() - (item.ts || 0) > C.ttl) {
        storage().remove(key);
        return null;
      }
      return item.text;
    }).catch(function () { return null; });
  };

  /** 批量读取，返回 { key: text|null } */
  C.getMany = function (keys) {
    if (!keys || !keys.length) return Promise.resolve({});
    return storage().get(keys).then(function (data) {
      var out = {};
      var expired = [];
      keys.forEach(function (k) {
        var item = data && data[k];
        if (!item || typeof item.text !== 'string') {
          out[k] = null;
          return;
        }
        if (Date.now() - (item.ts || 0) > C.ttl) {
          out[k] = null;
          expired.push(k);
          return;
        }
        out[k] = item.text;
      });
      if (expired.length) storage().remove(expired);
      return out;
    }).catch(function () {
      var empty = {};
      keys.forEach(function (k) { empty[k] = null; });
      return empty;
    });
  };

  /** 写入缓存 */
  C.set = function (key, text) {
    if (typeof text !== 'string' || !text) return Promise.resolve();
    var payload = {};
    payload[key] = { text: text, ts: Date.now() };
    return storage().set(payload).catch(function () { /* ignore */ });
  };

  /** 批量写入 */
  C.setMany = function (obj) {
    if (!obj || !Object.keys(obj).length) return Promise.resolve();
    var payload = {};
    Object.keys(obj).forEach(function (k) {
      payload[k] = { text: obj[k], ts: Date.now() };
    });
    return storage().set(payload).catch(function () { /* ignore */ });
  };

  /** 清空全部缓存 */
  C.clear = function () {
    return storage().get(null).then(function (data) {
      var keys = Object.keys(data || {}).filter(function (k) {
        return String(k).indexOf(IMT.STORAGE_KEY + ':cache:') === 0;
      });
      if (!keys.length) return 0;
      return storage().remove(keys).then(function () { return keys.length; });
    }).catch(function () { return 0; });
  };

  /** 缓存统计 */
  C.stats = function () {
    return storage().get(null).then(function (data) {
      var count = 0;
      var bytes = 0;
      var oldest = 0;
      Object.keys(data || {}).forEach(function (k) {
        if (String(k).indexOf(IMT.STORAGE_KEY + ':cache:') !== 0) return;
        count++;
        var item = data[k];
        bytes += JSON.stringify(item).length;
        var ts = (item && item.ts) || 0;
        if (!oldest || ts < oldest) oldest = ts;
      });
      return { count: count, bytes: bytes, oldest: oldest };
    }).catch(function () { return { count: 0, bytes: 0, oldest: 0 }; });
  };

  IMT.cache = C;
})(typeof globalThis !== 'undefined' ? globalThis : this);
