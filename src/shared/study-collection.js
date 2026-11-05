/* Bilingual Reader — local study collection shared by the card and review page. */
(function (root) {
  'use strict';

  var IMT = (root.IMT = root.IMT || {});
  var KEY = 'imtl.study.collection';

  function entryKey(entry) {
    var text = entry.kind === 'word' ? entry.text.toLowerCase() : entry.text;
    return JSON.stringify([entry.kind, text, entry.context || '']);
  }

  function asList(value) {
    return Array.isArray(value) ? value : [];
  }

  function read() {
    return chrome.storage.local.get(KEY).then(function (data) {
      return asList(data[KEY]);
    });
  }

  function watch(onChange) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes[KEY]) onChange(asList(changes[KEY].newValue));
    });
  }

  function write(entry, saved) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage({ type: 'IMT_STUDY_SAVE', entry: entry, saved: saved }, function (result) {
        var error = chrome.runtime.lastError;
        if (error || !result || !result.ok) {
          reject(new Error((result && result.error) || '收藏操作失败，请重试。'));
        } else {
          resolve(result.saved);
        }
      });
    });
  }

  IMT.studyCollection = { storageKey: KEY, entryKey: entryKey, read: read, watch: watch, write: write };
})(typeof globalThis !== 'undefined' ? globalThis : this);
