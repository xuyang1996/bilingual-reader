/* Bilingual Reader — learning card content shared by the web overlay and collection. */
(function (root) {
  'use strict';

  var IMT = root.IMT;
  var collection = IMT.studyCollection;
  var speaking = null, voicesRequested = false;
  var css = '.study-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:7px 0}' +
    '.study-tools button{font:inherit;font-size:12px;padding:3px 8px;border:1px solid currentColor;' +
    'border-radius:6px;background:transparent;color:inherit;cursor:pointer}' +
    '.study-tools button:disabled{opacity:.55;cursor:default}.study-save[aria-pressed="true"]{background:#5988ae26}' +
    '.study-feedback{font-size:12px}.study-feedback:empty{display:none}' +
    '.study-word,.study-words{margin-top:8px}.study-words summary{cursor:pointer}' +
    '.study-words .study-word{border-top:1px solid #8f9dae55;padding-top:6px}' +
    '.study-ipa,.study-headword{font-size:12px;margin-left:6px;font-weight:400}' +
    '.study-root,.study-context{margin-top:4px}.study-context{font-size:13px}';

  function add(parent, tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = text;
    parent.appendChild(el);
    return el;
  }

  function speak(text, button, feedback, resize) {
    if (speaking) return;
    var synth = root.speechSynthesis;
    var voices = synth ? synth.getVoices().filter(function (voice) {
      return voice.localService && /^en(?:[-_]|$)/i.test(voice.lang);
    }) : [];
    var voice = voices.find(function (voice) { return /^en[-_]US$/i.test(voice.lang); }) || voices[0];
    if (!voice || !root.SpeechSynthesisUtterance) {
      feedback('没有可用的本地英语语音。请在系统中添加英语语音后重试。');
      return;
    }
    var utterance = new root.SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = .9;
    speaking = utterance;
    button.disabled = true;
    button.textContent = '朗读中…';
    feedback('');
    function finish(message) {
      if (speaking === utterance) speaking = null;
      button.disabled = false;
      button.textContent = '发音';
      feedback(message);
    }
    utterance.onend = function () { finish(''); };
    utterance.onerror = function () { finish('发音失败，请重试。'); };
    try { synth.speak(utterance); }
    catch (e) { finish('发音失败，请重试。'); }
    resize();
  }

  function render(parent, entry, options) {
    var controls = [];
    var resize = options.onResize || function () {};
    // Chromium can populate the available voices asynchronously on first access.
    if (!voicesRequested && root.speechSynthesis) {
      voicesRequested = true;
      root.speechSynthesis.getVoices();
    }

    function addActions(target, item, allowSave) {
      var toolbar = add(target, 'div', 'study-tools', '');
      var audio = add(toolbar, 'button', 'study-speak', '发音');
      audio.type = 'button';
      audio.setAttribute('aria-label', item.kind === 'word' ? '朗读 ' + item.text : '朗读原句');
      var message = add(toolbar, 'span', 'study-feedback', '');
      message.setAttribute('role', 'status');
      function feedback(text) {
        message.textContent = text;
        if (message.isConnected) resize();
      }
      audio.addEventListener('click', function () { speak(item.text, audio, feedback, resize); });
      if (!allowSave) return;
      var save = add(toolbar, 'button', 'study-save', '收藏');
      toolbar.insertBefore(save, message);
      save.type = 'button';
      var saved = false;
      var writing = false;
      function setSaved(value) {
        saved = value;
        save.textContent = saved ? '取消收藏' : '收藏';
        save.setAttribute('aria-pressed', String(saved));
        save.disabled = writing;
      }
      setSaved(!!options.isCollection);
      controls.push({ key: collection.entryKey(item), update: setSaved });
      save.addEventListener('click', function () {
        writing = true;
        save.disabled = true;
        feedback('');
        collection.write(item, !saved).then(function (value) {
          writing = false;
          setSaved(value);
          if (save.isConnected) resize();
        }, function (err) {
          writing = false;
          setSaved(saved);
          feedback(err.message);
        });
      });
    }

    function showWord(target, wordEntry, showContext, allowSave) {
      var word = wordEntry.analysis.word;
      var section = add(target, 'section', 'study-word', '');
      var heading = add(section, 'h3', 'source', word.text);
      heading.lang = 'en';
      if (word.ipa) {
        var ipa = add(heading, 'span', 'study-ipa', '/' + word.ipa + '/');
        ipa.setAttribute('aria-label', '美式音标 ' + word.ipa);
      }
      if (word.headword.toLowerCase() !== word.text.toLowerCase()) {
        add(section, 'p', 'study-headword explanation', '原形 ' + word.headword);
      }
      add(section, 'p', 'explanation', word.meaning);
      if (word.root) add(section, 'p', 'study-root', '词根与构词：' + word.root);
      if (showContext && wordEntry.context) add(section, 'p', 'study-context explanation', wordEntry.context).lang = 'en';
      addActions(section, wordEntry, allowSave);
    }

    if (entry.kind === 'word') {
      showWord(parent, entry, !!options.isCollection, true);
    } else {
      var result = entry.analysis;
      if (options.isCollection && entry.text !== result.main.text) add(parent, 'p', 'source', entry.text).lang = 'en';
      add(parent, 'h3', '', '句子主干');
      add(parent, 'p', 'source', result.main.text).lang = 'en';
      add(parent, 'p', 'explanation', result.main.explanation);
      if (result.detail) add(parent, 'p', 'detail', result.detail);
      if (result.phrases.length) {
        var section = add(parent, 'section', 'phrases', '');
        add(section, 'h3', '', '关键短语');
        var list = add(section, 'ul', '', '');
        result.phrases.forEach(function (phrase) {
          var row = add(list, 'li', '', '');
          add(row, 'span', 'source', phrase.text).lang = 'en';
          add(row, 'span', 'explanation', '：' + phrase.explanation);
        });
      }
      addActions(parent, entry, true);
      if (result.words && result.words.length) {
        var words = add(parent, 'details', 'study-words', '');
        add(words, 'summary', '', '重点单词');
        words.addEventListener('toggle', resize);
        result.words.forEach(function (word) {
          showWord(words, { kind: 'word', text: word.text, context: entry.text, analysis: { word: word } },
            false, !options.isCollection);
        });
      }
    }
    return function syncSaved(items) {
      var keys = new Set(items.map(collection.entryKey));
      controls.forEach(function (control) { control.update(keys.has(control.key)); });
    };
  }

  IMT.studyView = { render: render, css: css };
})(typeof globalThis !== 'undefined' ? globalThis : this);
