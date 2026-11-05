/* Bilingual Reader — review explicitly saved words and sentences. */
(function () {
  'use strict';

  var collection = IMT.studyCollection;
  var words = document.getElementById('words');
  var sentences = document.getElementById('sentences');
  var status = document.getElementById('status');
  var style = document.createElement('style');
  style.textContent = IMT.studyView.css;
  document.head.appendChild(style);

  function render(items) {
    [words, sentences].forEach(function (section) {
      section.querySelector('.entries').textContent = '';
      section.hidden = true;
    });
    items.forEach(function (entry) {
      var section = entry.kind === 'word' ? words : sentences;
      var article = document.createElement('article');
      section.querySelector('.entries').appendChild(article);
      IMT.studyView.render(article, entry, { isCollection: true });
      section.hidden = false;
    });
    status.textContent = items.length ? '' : '还没有收藏。可以在网页的学习卡里收藏单词或句子。';
  }

  var receivedChange = false;
  collection.watch(function (items) {
    receivedChange = true;
    render(items);
  });
  collection.read().then(function (items) {
    if (!receivedChange) render(items);
  }).catch(function () {
    status.textContent = '无法读取本地收藏，请刷新页面重试。';
  });
})();
