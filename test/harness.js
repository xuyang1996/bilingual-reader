/*!
 * Bilingual Reader — 单元测试（运行在真实 DOM 上）
 *
 * 翻译由内置 mock 提供（词级映射），因此不需要网络，
 * 也能验证「翻译管线 + 术语后处理」这条链路。
 */
(function () {
  'use strict';

  var IMT = globalThis.IMT;
  var U = IMT.utils;

  var results = [];
  var passed = 0;
  var failed = 0;

  /* ---------------- 断言 ---------------- */

  function assert(cond, msg) {
    if (!cond) throw new Error(msg || '断言失败');
  }

  function test(name, fn) {
    return Promise.resolve()
      .then(fn)
      .then(function () {
        passed++;
        results.push({ ok: true, name: name, info: '' });
      })
      .catch(function (err) {
        failed++;
        results.push({ ok: false, name: name, info: (err && err.message) || String(err) });
      })
      .then(renderResults);
  }

  function renderResults() {
    var host = document.getElementById('results');
    host.innerHTML = '';
    results.forEach(function (r) {
      var div = document.createElement('div');
      div.className = 'res ' + (r.ok ? 'ok' : 'no');
      var tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = r.ok ? 'PASS' : 'FAIL';
      var nm = document.createElement('span');
      nm.className = 'name';
      nm.textContent = r.name;
      div.appendChild(tag);
      div.appendChild(nm);
      if (r.info) {
        var info = document.createElement('span');
        info.className = 'info';
        info.textContent = ' — ' + r.info;
        div.appendChild(info);
      }
      host.appendChild(div);
    });

    var sum = document.getElementById('summary');
    sum.textContent = passed + ' 通过 / ' + failed + ' 失败 / 共 ' + results.length;
    sum.className = failed ? 'fail' : (passed ? 'pass' : '');
  }

  function waitFor(fn, timeout) {
    var t0 = Date.now();
    return new Promise(function (resolve, reject) {
      function tick() {
        var v = false;
        try { v = fn(); } catch (e) { v = false; }
        if (v) return resolve(true);
        if (Date.now() - t0 > (timeout || 8000)) return reject(new Error('等待超时'));
        setTimeout(tick, 40);
      }
      tick();
    });
  }

  /* ---------------- mock 翻译器 ---------------- */

  var DICT = {
    bilingual: '双语', reader: '阅读器', paragraph: '段落', translation: '翻译',
    engine: '引擎', web: '网页', page: '页面', pages: '页面', every: '每个',
    paired: '配对', text: '文本', read: '阅读', original: '原文', at: '在',
    same: '同', time: '时间', extension: '扩展', translates: '翻译',
    into: '成', layout: '布局', scans: '扫描', decides: '判定',
    blocks: '块', are: '是', real: '真实', article: '文章', content: '内容',
    navigation: '导航', menus: '菜单', sidebars: '侧栏', footers: '页脚',
    short: '短', labels: '标签', skipped: '跳过', automatically: '自动',
    because: '因为', they: '它们', carry: '承载', little: '少',
    meaning: '意义', out: '出', of: '的', context: '上下文',
    works: '工作', well: '好', click: '点击', icon: '图标',
    choose: '选择', keyboard: '键盘', shortcut: '快捷键',
    enabled: '启用', supported: '支持', feature: '特性', status: '状态',
    install: '安装', from: '从', extensions: '扩展', page2: '页面',
    reload: '刷新', target: '目标', this: '这', is: '是',
    a: '一', very: '非常', effective: '有效', way: '方式',
    to: '到', learn: '学习', new: '新', language: '语言',
    hello: '你好', world: '世界', type: '类型', status2: '状态',
    should: '应该', be: '被', skipped2: '跳过', contains: '包含',
    label: '标签', that: '那个', recognizer: '识别器'
  };

  function mockTranslate(text) {
    return String(text).replace(/[A-Za-z][A-Za-z'-]*/g, function (w) {
      var k = w.toLowerCase();
      return DICT[k] !== undefined ? DICT[k] : w;
    });
  }

  function mockTransport(texts) {
    return Promise.resolve(texts.map(mockTranslate));
  }

  /* ---------------- 各模块测试 ---------------- */

  function testUtils() {
    return test('工具：hashString 稳定且区分内容', function () {
      var a = U.hashString('hello');
      var b = U.hashString('hello');
      var c = U.hashString('hello!');
      assert(a === b, '相同内容哈希应一致');
      assert(a !== c, '不同内容哈希应不同');
    }).then(function () {
      return test('工具：countWords 中英混排计数', function () {
        assert(U.countWords('Hello world') === 2, '英文 2 词');
        assert(U.countWords('你好世界') === 4, '中文 4 字');
        assert(U.countWords('Hello 你好') === 3, '混合 3');
      });
    }).then(function () {
      return test('工具：matchesPattern 支持通配与域名', function () {
        assert(U.matchesPattern('https://docs.example.com/a', '*example.com*') === true);
        assert(U.matchesPattern('https://docs.example.com/a', '||example.com') === true);
        assert(U.matchesPattern('https://other.org/a', '||example.com') === false);
        assert(U.matchesPattern('https://other.org/a', 'example.com') === false);
      });
    }).then(function () {
      return test('工具：detectLang 识别中英日', function () {
        assert(U.detectLang('Hello world this is English') === 'en');
        assert(U.detectLang('这是一段完整的中文文本') === 'zh');
        assert(U.detectLang('これは日本語のテキストです') === 'ja');
      });
    });
  }

  function testRules() {
    return test('规则：generalRule 作为基线', function () {
      var cfg = U.config.merge({ generalRule: { translationMode: 'translation' } });
      var res = IMT.rules.resolve(cfg, 'https://nobody.test/');
      assert(res.rule.translationMode === 'translation', '应继承 generalRule');
      assert(res.matched.length === 0, '不应命中任何站点规则');
    }).then(function () {
      return test('规则：更具体的规则覆盖更宽泛的规则', function () {
        var cfg = U.config.merge({
          rules: [
            { id: 'wide', urlPattern: ['*example.com*'], translationMode: 'translation', targetLang: 'ja' },
            { id: 'narrow', urlPattern: ['*docs.example.com*'], translationMode: 'dual', targetLang: 'zh-Hans' }
          ]
        });
        var res = IMT.rules.resolve(cfg, 'https://docs.example.com/guide');
        assert(res.rule.translationMode === 'dual', 'narrow 应覆盖 wide');
        assert(res.rule.targetLang === 'zh-Hans', '目标语言应被 narrow 覆盖');
        assert(res.matched.length === 2, '两条规则都应命中');
      });
    }).then(function () {
      return test('规则：parentId 继承父规则字段', function () {
        var cfg = U.config.merge({
          rules: [
            { id: 'parent', urlPattern: ['*never.test*'], translationPosition: 'before' },
            { id: 'child', parentId: 'parent', urlPattern: ['*example.com*'], translationMode: 'original' }
          ]
        });
        var res = IMT.rules.resolve(cfg, 'https://www.example.com/');
        assert(res.rule.translationPosition === 'before', '应继承父规则的 translationPosition');
        assert(res.rule.translationMode === 'original', '自身字段应生效');
      });
    });
  }

  function testPii() {
    return test('PII：encode 替换敏感信息', function () {
      var r = IMT.pii.encode('Contact john@example.com now.', ['EMAIL_ADDRESS']);
      assert(r.text.indexOf('john@example.com') < 0, '邮箱应被替换');
      assert(r.text.indexOf('__PII_EMAIL_ADDRESS_1__') >= 0, '应生成占位符');
    }).then(function () {
      return test('PII：decode 完整还原', function () {
        var src = 'Contact john@example.com or call +1 555 010 9999.';
        var r = IMT.pii.encode(src, ['EMAIL_ADDRESS', 'PHONE_NUMBER']);
        var back = IMT.pii.decode(r.text, r.map);
        assert(back === src, '往返应完全一致，实际: ' + back);
      });
    }).then(function () {
      return test('PII：信用卡与 IP 也能脱敏', function () {
        var r = IMT.pii.encode('card 4111 1111 1111 1111 ip 192.168.1.10', ['CREDIT_CARD', 'IP_ADDRESS']);
        assert(r.text.indexOf('4111') < 0, '卡号应被替换');
        assert(r.text.indexOf('192.168.1.10') < 0, 'IP 应被替换');
      });
    });
  }

  function testGlossary() {
    return test('术语库：apply 按词边界替换', function () {
      var out = IMT.glossary.apply('The reader reads a book.', [{ from: 'reader', to: '读本' }]);
      assert(out.indexOf('读本') >= 0, '应替换 reader');
      assert(out.indexOf('reads') >= 0, '不应误伤 reads');
    }).then(function () {
      return test('术语库：buildPrompt 生成提示词', function () {
        var p = IMT.glossary.buildPrompt([{ from: 'Chrome', to: '谷歌浏览器' }], 'auto', 'zh-Hans');
        assert(p.indexOf('Chrome') >= 0 && p.indexOf('谷歌浏览器') >= 0, '提示词应含术语');
        assert(IMT.glossary.buildPrompt([], 'auto', 'zh-Hans') === '', '无术语时应为空');
      });
    });
  }

  function testSegment() {
    var root = document.getElementById('article');
    return test('分段：识别标题、段落、列表项与表格单元格', function () {
      var res = IMT.segment.collect(root, { thresholds: { mainFrameMinTextCount: 0 } });
      var ids = res.items.map(function (i) { return i.el.id; });
      ['t-title', 't-sub', 't-p1', 't-h2', 't-p2', 't-li1', 't-li2', 't-li3',
       't-th1', 't-th2', 't-td1', 't-td2', 't-td3', 't-td4', 't-quote', 't-p3'].forEach(function (id) {
        assert(ids.indexOf(id) >= 0, '应识别出 ' + id);
      });
    }).then(function () {
      return test('分段：跳过代码块（pre/code）', function () {
        var res = IMT.segment.collect(root, { thresholds: { mainFrameMinTextCount: 0 } });
        var ids = res.items.map(function (i) { return i.el.id; });
        assert(ids.indexOf('t-pre') < 0, 'pre 不应被翻译');
      });
    }).then(function () {
      return test('分段：侧栏整棵排除（长段落与短标签都不翻）', function () {
        var aside = document.getElementById('t-aside');
        var res = IMT.segment.collect(aside, { thresholds: { mainFrameMinTextCount: 0 } });
        assert(res.items.length === 0, '侧栏内容应全部被跳过，实际 ' + res.items.length + ' 项');
      });
    }).then(function () {
      return test('分段：protect 技术片段（code）不被拆进段落', function () {
        var res = IMT.segment.collect(root, { thresholds: { mainFrameMinTextCount: 0 } });
        var item = res.items.filter(function (i) { return i.el.id === 't-p1'; })[0];
        assert(item && item.parts.length === 0, '普通段落不应有保护片段');
      });
    });
  }

  function testRender() {
    var root = document.getElementById('article');
    var before = root.innerHTML;

    return test('渲染：插入译文并保留原文', function () {
      var el = document.getElementById('t-p1');
      var original = el.textContent;
      IMT.render.insert(el, '【译文】', { position: 'after', wrapperTag: 'font', targetLang: 'zh-Hans' });
      var trans = el.querySelector('.imtl-translation');
      var orig = el.querySelector('.imtl-original');
      assert(!!trans, '应插入译文节点');
      assert(!!orig, '应包裹原文');
      assert(orig.textContent === original, '原文内容应保持不变');
      assert(trans.textContent === '【译文】', '译文内容应正确');
      assert(el.getAttribute('data-imtl-state') === 'translated', '应标记已翻译');
    }).then(function () {
      return test('渲染：幂等 —— 重复插入不产生第二个译文节点', function () {
        var el = document.getElementById('t-p1');
        IMT.render.insert(el, '【译文2】', { position: 'after', wrapperTag: 'font' });
        var n = el.querySelectorAll(':scope > .imtl-translation').length;
        assert(n === 1, '译文节点应只有 1 个，实际 ' + n);
      });
    }).then(function () {
      return test('渲染：before 位置把译文放在原文之前', function () {
        var el = document.getElementById('t-h2');
        IMT.render.insert(el, '【前】', { position: 'before', wrapperTag: 'font' });
        var first = el.firstElementChild;
        assert(first && first.classList.contains('imtl-translation'), '译文应在最前');
      });
    }).then(function () {
      return test('渲染：模式切换只改 html 上的 class', function () {
        IMT.render.setMode('translation');
        assert(document.documentElement.classList.contains('imtl-mode-translation'), '应有 translation 模式 class');
        IMT.render.setMode('dual');
        assert(document.documentElement.classList.contains('imtl-mode-dual'), '应有 dual 模式 class');
        assert(!document.documentElement.classList.contains('imtl-mode-translation'), '旧 class 应被移除');
      });
    }).then(function () {
      return test('渲染：回滚后 DOM 完全还原', function () {
        var count = IMT.render.restore(root);
        assert(count > 0, '应移除过译文节点');
        var now = root.innerHTML;
        assert(now === before, '回滚后 innerHTML 应与初始完全一致\n实际: ' + now +
          '\n期望: ' + before);
        assert(root.querySelectorAll('.imtl-translation').length === 0, '不应残留译文');
        assert(root.querySelectorAll('.imtl-original').length === 0, '不应残留原文包裹');
      });
    });
  }

  function testPipeline() {
    var root = document.getElementById('article');
    var before = root.innerHTML;
    var cfg = U.config.merge({ lazy: false });
    var rule = IMT.rules.resolve(cfg, location.href).rule;
    var controller = null;

    return test('管线：mock 传输层接通', function () {
      IMT.client.setTransport(mockTransport);
      assert(IMT.client.hasTransport(), '应已设置 transport');
    }).then(function () {
      return test('管线：完整跑通并插入译文', function () {
        controller = IMT.pipeline.create({
          root: root, rule: rule, config: cfg, engineId: 'openai-compatible', lazy: false
        });
        controller.start();
        return waitFor(function () {
          var s = controller.getStats();
          return s.done > 0 && s.pending === 0 && s.failed === 0;
        }, 8000).then(function () {
          var n = root.querySelectorAll('.imtl-translation').length;
          assert(n > 5, '应插入多个译文节点，实际 ' + n);
          var first = root.querySelector('#t-title .imtl-translation');
          assert(first && first.textContent.length > 0, '标题应有译文');
        });
      });
    }).then(function () {
      return test('管线：刷新不重复翻译', function () {
        var before2 = root.querySelectorAll('.imtl-translation').length;
        controller.refresh();
        var after2 = root.querySelectorAll('.imtl-translation').length;
        assert(before2 === after2, '译文节点数不应变化');
      });
    }).then(function () {
      return test('管线：停止后完全还原', function () {
        controller.stop();
        assert(root.innerHTML === before, '停止后 DOM 应完全还原');
        assert(root.querySelectorAll('.imtl-translation').length === 0, '不应残留译文');
      });
    });
  }

  function testDeepMerge() {
    return test('工具：deepMerge 支持多个源，后面的覆盖前面的', function () {
      var out = U.deepMerge({}, { a: 1, b: 2 }, { b: 3, c: 4 });
      assert(out.a === 1 && out.b === 3 && out.c === 4, '多源合并结果不对: ' + JSON.stringify(out));
      var nested = U.deepMerge({}, { t: { x: 1, y: 2 } }, { t: { y: 9 } });
      assert(nested.t.x === 1 && nested.t.y === 9, '嵌套合并结果不对');
    });
  }

  function testThresholdOverrides() {
    var root = document.getElementById('article');
    return test('分段：paragraphMinTextCount 覆盖生效', function () {
      var res = IMT.segment.collect(root, {
        thresholds: { paragraphMinTextCount: 500, mainFrameMinTextCount: 0 }
      });
      assert(res.items.length === 0, '应收集 0 段，实际 ' + res.items.length);
    }).then(function () {
      return test('分段：mainFrameMinTextCount 覆盖生效', function () {
        var res = IMT.segment.collect(root, { thresholds: { mainFrameMinTextCount: 999999 } });
        assert(res.items.length === 0, '应收集 0 段，实际 ' + res.items.length);
        assert(res.stats.skippedByMainFrame === true, 'skippedByMainFrame 应为 true');
      });
    }).then(function () {
      return test('分段：完整配置路径同样尊重阈值覆盖', function () {
        var cfg = U.config.merge({
          generalRule: { thresholds: { paragraphMinTextCount: 500, mainFrameMinTextCount: 0 } }
        });
        var rule = IMT.rules.resolve(cfg, location.href).rule;
        assert(rule.thresholds.paragraphMinTextCount === 500, '规则里的阈值应保留');
        var res = IMT.segment.collect(root, {
          thresholds: rule.thresholds,
          tags: rule.tags,
          excludeSelectors: rule.excludeSelectors,
          mainSelector: rule.mainSelector
        });
        assert(res.items.length === 0, '应收集 0 段，实际 ' + res.items.length);
      });
    }).then(function () {
      return test('分段：mainSelector 限定翻译作用域', function () {
        var res = IMT.segment.collect(document.body, {
          thresholds: { mainFrameMinTextCount: 0 },
          mainSelector: '#t-ul'
        });
        assert(res.items.length === 3, '只应收集 ul 里的 3 个 li，实际 ' + res.items.length);
        var ids = res.items.map(function (i) { return i.el.id; });
        assert(ids.indexOf('t-p1') < 0, '作用域外的段落不应被收集');
      });
    });
  }

  function testChromeDetection() {
    return test('正文识别：导航/侧栏容器被判定为框架', function () {
      var nav = document.createElement('nav');
      nav.innerHTML = '<a href="#">Home</a><a href="#">Docs</a><a href="#">Blog</a><a href="#">About</a>';
      document.body.appendChild(nav);
      assert(IMT.segment.isChromeElement(nav) === true, 'nav 标签应判定为框架');
      assert(IMT.segment.isLinkList(nav) === true, '链接密集容器应判定为链接列表');

      var bar = document.createElement('div');
      bar.className = 'site-navbar';
      document.body.appendChild(bar);
      assert(IMT.segment.isChromeElement(bar) === true, 'navbar 类名应判定为框架');

      var body = document.createElement('div');
      body.className = 'article-body';
      body.innerHTML = '<p>' + new Array(60).join('word ') + '</p>';
      document.body.appendChild(body);
      assert(IMT.segment.isChromeElement(body) === false, '正文容器不应判定为框架');
      assert(IMT.segment.isLinkList(body) === false, '正文容器不应判定为链接列表');

      var meta = document.createElement('div');
      meta.className = 'content-meta';
      document.body.appendChild(meta);
      assert(IMT.segment.isChromeElement(meta) === false, 'content-meta 不应被误判为框架');

      nav.parentNode.removeChild(nav);
      bar.parentNode.removeChild(bar);
      body.parentNode.removeChild(body);
      meta.parentNode.removeChild(meta);
    });
  }

  /**
   * 框架排除的回归用例。
   *
   * 这里锁住三件曾经出错的事：
   *   ① 侧栏里的短导航项曾经会被翻译（阈值方向反了）
   *   ② 目录条目曾经会跟着容器一起被留下
   *   ③ 链接密集规则曾经把整页链接流（HN 那类站点）全部误杀
   */
  function testChromeExclusion() {
    var stage = document.getElementById('stage');

    return test('框架排除：导航 / 侧栏 / 目录条目都不翻，同容器标题保留', function () {
      var res = IMT.segment.collect(stage, { thresholds: { mainFrameMinTextCount: 0 } });
      var ids = res.items.map(function (i) { return i.el.id; });
      assert(ids.indexOf('t-nav') < 0, '导航容器不应被收集');
      assert(ids.indexOf('t-aside-p') < 0, '侧栏段落不应被收集');
      assert(ids.indexOf('t-aside-short') < 0, '侧栏里的短标签不应被收集');
      assert(ids.indexOf('t-header-li1') < 0, '目录条目不应被收集');
      assert(ids.indexOf('t-header-li4') < 0, '目录条目不应被收集');
      assert(ids.indexOf('t-header-h2') >= 0, '同一容器里的标题应保留');
      assert(ids.indexOf('t-p1') >= 0, '正文段落应保留');
    }).then(function () {
      return test('框架排除：translateChrome 打开后框架区域也会被翻译', function () {
        var res = IMT.segment.collect(stage, {
          thresholds: { mainFrameMinTextCount: 0 },
          translateChrome: true
        });
        var ids = res.items.map(function (i) { return i.el.id; });
        assert(ids.indexOf('t-nav') >= 0, '整页翻译模式下导航应被收集');
        assert(ids.indexOf('t-aside-short') >= 0, '整页翻译模式下侧栏短标签应被收集');
        assert(ids.indexOf('t-header-li1') >= 0, '整页翻译模式下目录条目应被收集');
      });
    }).then(function () {
      return test('框架排除：占页面主体的链接流不会被当成导航误杀', function () {
        // 构造一个「内容本身就是一堆链接」的容器（HN 那类站点的形态）
        var target = document.body.textContent.length * 0.6;
        var box = document.createElement('div');
        box.id = 't-linkflow';
        var n = 0;
        while (box.textContent.length < target && n < 500) {
          var d = document.createElement('div');
          d.id = 'lf-' + n;
          d.innerHTML = '<a href="#">Headline ' + n + ' of the list</a>';
          box.appendChild(d);
          n++;
        }
        stage.appendChild(box);

        try {
          var res = IMT.segment.collect(stage, { thresholds: { mainFrameMinTextCount: 0 } });
          var ids = res.items.map(function (i) { return i.el.id; });
          assert(ids.indexOf('lf-0') >= 0, '内容型链接流不应被误杀，实际收集 ' + res.items.length + ' 项');
          assert(IMT.segment.isLinkList(box) === true, '它确实是链接密集容器');
          assert(IMT.segment.isLinkList(box, box.textContent.length) === false,
            '占页面主体时不应再判为链接列表');
          assert(IMT.segment.isLinkList(box, box.textContent.length * 100) === true,
            '只占页面一小块时应判为链接列表');
        } finally {
          box.parentNode.removeChild(box);
        }
      });
    });
  }

  function testContentScript() {
    function send(msg, timeoutMs) {
      return new Promise(function (resolve, reject) {
        var listener = (window.__imtlListeners || [])[0];
        if (!listener) return reject(new Error('content.js 未注册消息监听器'));
        var timer = setTimeout(function () { reject(new Error('未收到响应: ' + msg.action)); }, timeoutMs || 6000);
        listener(msg, {}, function (res) {
          clearTimeout(timer);
          try {
            assert(!(res && typeof res.then === 'function'),
              'sendResponse 收到的是 Promise，调用方无法序列化');
            assert(res && res.ok === true, '应返回 ok:true，实际: ' + JSON.stringify(res));
            resolve(res);
          } catch (e) { reject(e); }
        });
      });
    }

    return test('内容脚本：同步指令返回已解析对象', function () {
      return send({ target: 'imtl-content', action: 'query' }, 4000);
    }).then(function () {
      return test('内容脚本：异步指令返回已解析对象而非 Promise', function () {
        return send({ target: 'imtl-content', action: 'start', options: {} }, 8000);
      });
    }).then(function () {
      return test('内容脚本：setMode 通过 options 路由并真实生效', function () {
        return send({ target: 'imtl-content', action: 'setMode', options: { mode: 'translation' } }, 4000)
          .then(function () {
            assert(IMT.render.getMode() === 'translation',
              '模式应为 translation，实际 ' + IMT.render.getMode());
            return send({ target: 'imtl-content', action: 'setMode', options: { mode: 'dual' } }, 4000);
          });
      });
    }).then(function () {
      return test('内容脚本：setLang 通过 options 路由并重新翻译', function () {
        return send({ target: 'imtl-content', action: 'setLang', options: { lang: 'zh-Hans' } }, 12000)
          .then(function (res) {
            assert(res.lang === 'zh-Hans', '目标语言应为 zh-Hans，实际 ' + res.lang);
            assert(res.state === 'translated', '状态应为 translated，实际 ' + res.state);
            // 翻译是异步的，等译文真正落进 DOM
            return waitFor(function () {
              return document.querySelectorAll('.imtl-translation').length > 0;
            }, 8000);
          });
      });
    }).then(function () {
      return test('内容脚本：stop 后 DOM 完全还原', function () {
        return send({ target: 'imtl-content', action: 'stop' }, 6000).then(function (res) {
          assert(res.state === 'none', '状态应为 none，实际 ' + res.state);
          assert(document.querySelectorAll('.imtl-translation').length === 0, '不应残留译文');
          assert(document.querySelectorAll('.imtl-original').length === 0, '不应残留原文包裹');
        });
      });
    });
  }

  /**
   * 通用大模型引擎的单元断言。
   *
   * 这里只测「不联网」的那部分：请求地址候选、鉴权候选、请求体构造、
   * 响应解析与批量协议解析。真实联网的部分由 test/verify_ai.py 覆盖。
   */
  function testAIEngine() {
    var I = IMT.engines._internal;

    return test('AI 引擎：解析各家返回格式', function () {
      var cases = [
        // OpenAI 兼容：content 是字符串
        [{ choices: [{ message: { content: '你好世界' } }] }, '你好世界'],
        // OpenAI 兼容：content 是 parts 数组
        [{ choices: [{ message: { content: [{ type: 'text', text: '你好世界' }] } }] }, '你好世界'],
        // OpenAI Responses API
        [{ output: [{ content: [{ type: 'output_text', text: '你好世界' }] }] }, '你好世界'],
        // Anthropic Messages
        [{ content: [{ type: 'text', text: '你好世界' }] }, '你好世界'],
        // Gemini
        [{ candidates: [{ content: { parts: [{ text: '你好世界' }] } }] }, '你好世界'],
        // 一些自建网关的字段名
        [{ translation: '你好世界' }, '你好世界'],
        [{ translations: [{ text: '你好世界' }] }, '你好世界'],
        [{ data: [{ text: '你好世界' }] }, '你好世界']
      ];
      cases.forEach(function (c) {
        var got = I.extractText(c[0]);
        assert(got === c[1], '应从 ' + JSON.stringify(c[0]).slice(0, 46) + ' 解析出「' + c[1] + '」' +
          '，实际「' + got + '」');
      });
    }).then(function () {
      return test('AI 引擎：推理模型的思维链不混进译文', function () {
        var json = {
          choices: [{
            message: {
              reasoning_content: '（思维链内容）',
              content: '正式译文'
            }
          }]
        };
        var got = I.extractText(json);
        assert(got === '正式译文', '应取 content，实际「' + got + '」');
        assert(got.indexOf('思维链') < 0, '思维链不应出现在译文里');
      });
    }).then(function () {
      return test('AI 引擎：自定义响应字段路径', function () {
        var json = { result: { data: { translated: '自定义译文' } } };
        var got = I.extractText(json, 'result.data.translated');
        assert(got === '自定义译文', '应按自定义路径取值，实际「' + got + '」');
      });
    }).then(function () {
      return test('AI 引擎：事件流响应兜底解析', function () {
        var sse = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"世界"}}]}\n\n' +
          'data: [DONE]\n\n';
        assert(I.parseSSE(sse) === '你好世界', '应拼出完整译文');
      });
    }).then(function () {
      return test('AI 引擎：Base URL 漏写 /v1 时自动补候选地址', function () {
        var urls = I.buildUrls({ baseUrl: 'https://api.deepseek.com', path: '/chat/completions',
          model: 'x' }, 'openai');
        assert(urls.indexOf('https://api.deepseek.com/chat/completions') >= 0,
          '应有不带 /v1 的候选');
        assert(urls.indexOf('https://api.deepseek.com/v1/chat/completions') >= 0,
          '应有带 /v1 的候选，实际：' + JSON.stringify(urls));

        var urls2 = I.buildUrls({ baseUrl: 'https://api.deepseek.com/v1', path: '/chat/completions',
          model: 'x' }, 'openai');
        assert(urls2.indexOf('https://api.deepseek.com/v1/v1/chat/completions') < 0,
          'Base URL 已含 /v1 时不该再补一层');
      });
    }).then(function () {
      return test('AI 引擎：鉴权方式候选与回退顺序', function () {
        var auths = I.buildAuths({ key: 'sk-1', auth: 'auto' });
        assert(auths.length === 3, 'auto 应有 3 种候选，实际 ' + auths.length);
        assert(auths[0].headers.Authorization === 'Bearer sk-1', '第一种应是 Bearer');
        assert(auths[1].headers['x-api-key'] === 'sk-1', '第二种应是 x-api-key');
        assert(auths[2].headers['api-key'] === 'sk-1', '第三种应是 api-key');

        var q = I.buildAuths({ key: 'k', auth: 'query', queryKey: 'access_token' });
        assert(q[0].query.indexOf('access_token=') === 0, 'query 鉴权应拼到 URL 上');
      });
    }).then(function () {
      return test('AI 引擎：推理模型识别', function () {
        assert(I.isReasoningModel('gpt-4o-mini') === false, 'gpt-4o-mini 不是推理模型');
        assert(I.isReasoningModel('deepseek-chat') === false, 'deepseek-chat 不是推理模型');
        assert(I.isReasoningModel('o1-preview') === true, 'o1 是推理模型');
        assert(I.isReasoningModel('o3-mini') === true, 'o3 是推理模型');
        assert(I.isReasoningModel('deepseek-reasoner') === true, 'deepseek-reasoner 是推理模型');
        assert(I.isReasoningModel('qwq-plus') === true, 'qwq 是推理模型');
      });
    }).then(function () {
      return test('AI 引擎：批量编号协议解析', function () {
        var reply = '1. 译文一\n2. 译文二\n3. 译文三';
        var out = I.parseBatchReply(reply, 3);
        assert(out && out.length === 3, '应解析出 3 条');
        assert(out[1] === '译文二', '第 2 条应为「译文二」，实际「' + (out && out[1]) + '」');

        // 带 markdown 围栏也要能解析
        var fenced = I.parseBatchReply('```\n1. 甲\n2. 乙\n```', 2);
        assert(fenced && fenced[0] === '甲', '应剥掉 markdown 围栏');

        // 对不齐就返回 null，交给调用方回退逐条
        assert(I.parseBatchReply('1. 只有一条', 3) === null, '条数对不上应返回 null');
        assert(I.parseBatchReply('乱七八糟', 2) === null, '没有编号应返回 null');
      });
    }).then(function () {
      return test('AI 引擎：提示词带术语表与目标语言', function () {
        var p = I.buildSystemPrompt({
          sourceLang: 'auto', targetLang: 'zh-Hans',
          glossary: [{ from: 'Chrome', to: '谷歌浏览器' }]
        }, {}, false);
        assert(p.indexOf('谷歌浏览器') >= 0, '提示词应含术语表');
        assert(p.indexOf('简体中文') >= 0, '提示词应含目标语言名称');
      });
    }).then(function () {
      return test('AI 引擎：供应商预设库可用', function () {
        var presets = IMT.PROVIDER_PRESETS || [];
        assert(presets.length >= 20, '预设数量应不少于 20，实际 ' + presets.length);
        var ids = presets.map(function (p) { return p.id; });
        ['deepseek', 'kimi', 'qwen', 'zhipu', 'openai', 'anthropic', 'gemini',
          'ollama', 'openrouter', 'siliconflow'].forEach(function (id) {
          assert(ids.indexOf(id) >= 0, '预设里应有 ' + id);
        });
        presets.forEach(function (p) {
          assert(!!p.name && !!p.format && !!p.auth, '预设 ' + p.id + ' 字段应完整');
        });
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * 引擎配置规则（v1.4.0：不再预置任何引擎）
   * ------------------------------------------------------------------ */

  function testEngineConfig() {
    return test('引擎配置：默认不预置任何引擎', function () {
      var cfg = U.config.merge({});
      assert(Object.keys(cfg.engines || {}).length === 0,
        '默认配置里不该有引擎，实际 ' + JSON.stringify(Object.keys(cfg.engines || {})));
      assert(!cfg.engine, '默认不该有当前引擎，实际 ' + cfg.engine);
    }).then(function () {      return test('引擎配置：merge 不会偷偷塞回默认引擎', function () {
        var cfg = U.config.merge({ engines: { mine: { baseUrl: 'https://x/v1', key: 'k' } } });
        assert(Object.keys(cfg.engines).length === 1, '只应保留用户自己的引擎');
        assert(!!cfg.engines.mine, '用户的引擎要留下');
      });
    }).then(function () {
      return test('引擎配置：迁移会清掉没动过的旧预置引擎', function () {
        var cfg = U.config.merge({
          engines: {
            'openai-compatible': { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', key: '' },
            'anthropic': { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', key: '' }
          }
        });
        assert(!cfg.engines['openai-compatible'], '没动过的 OpenAI 预置应被清掉');
        assert(!cfg.engines['anthropic'], '没动过的 Anthropic 预置应被清掉');
      });
    }).then(function () {
      return test('引擎配置：迁移保留用户自己配过的引擎', function () {
        var cfg = U.config.merge({
          engines: {
            'openai-compatible': {
              baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', key: 'sk-xxx'
            }
          }
        });
        assert(!!cfg.engines['openai-compatible'], '改过的引擎必须保留');
        assert(cfg.engines['openai-compatible'].model === 'deepseek-chat', '模型名不能被覆盖');
        assert(cfg.engine === 'openai-compatible', '当前引擎应指向它');
      });
    }).then(function () {
      return test('引擎配置：引擎名取模型名', function () {
        var cfg = U.config.merge({
          engines: {
            openai: {
              id: 'openai', name: 'OpenAI', model: 'gpt-4o-mini',
              key: 'sk-x', baseUrl: 'https://api.openai.com/v1'
            }
          }
        });
        assert(cfg.engines.openai.name === 'gpt-4o-mini',
          '预设引擎的名字应取模型名，实际 ' + cfg.engines.openai.name);
      });
    }).then(function () {
      return test('引擎配置：就绪判定', function () {
        assert(!U.engineReady(null), '空引擎不算就绪');
        assert(!U.engineReady({ key: '' }), '没 Key 不算就绪');
        assert(U.engineReady({ key: 'sk-x' }), '有 Key 就绪');
        assert(U.engineReady({ auth: 'none' }), '鉴权选「无」就绪（本地模型）');
        assert(U.engineReady({ baseUrl: 'http://127.0.0.1:11434/v1', key: '' }),
          '本机地址免 Key');
        assert(!U.engineReady({ baseUrl: 'https://api.example.com/v1', key: '' }),
          '远端地址没 Key 不算就绪');
      });
    }).then(function () {
      return test('引擎配置：一个都没配时挑不出可用引擎', function () {
        var cfg = { engines: {}, engine: '' };
        assert(U.pickReadyEngine(cfg) === null, '没有可用引擎');
        var cfg2 = {
          engines: { a: { key: '' }, b: { key: 'sk-y' } },
          engine: 'a'
        };
        assert(U.pickReadyEngine(cfg2) === 'b', '应挑出配好的那个');
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * 演示模式（本地拼示例译文，不联网、不需要 Key）
   * ------------------------------------------------------------------ */

  function testDemoMode() {
    var I = IMT.engines._internal;

    return test('演示模式：整句表命中就整句替换', function () {
      var src = 'Table of contents';
      var got = I.demoTranslate(src);
      assert(got === '目录', '应整句替换为「目录」，实际「' + got + '」');
    }).then(function () {
      return test('演示模式：表里没有的句子退回词表替换', function () {
        var got = I.demoTranslate('Smart content recognition with widgets');
        assert(got.indexOf('智能的') >= 0, '应替换出「智能的」，实际「' + got + '」');
        assert(got.indexOf('内容') >= 0 && got.indexOf('识别') >= 0,
          '应替换出「内容」「识别」，实际「' + got + '」');
        // 词典里没有的词要保留英文，不能整句都消失
        assert(got.indexOf('widgets') >= 0, '未收录的词应保留英文，实际「' + got + '」');
      });
    }).then(function () {
      return test('演示模式：中文原样返回', function () {
        var got = I.demoTranslate('已经是中文的一段话');
        assert(got === '已经是中文的一段话', '中文应原样返回，实际「' + got + '」');
      });
    }).then(function () {
      return test('演示模式：不联网、不需要 Key', function () {
        // format=demo 的引擎：就绪判定为真（免 Key）
        assert(U.engineReady({ format: 'demo', auth: 'none', baseUrl: '', key: '' }),
          '演示引擎应判定为就绪（免 Key）');
        // 内核里没有 demo 的 http 请求路径
        assert(typeof I.demoTranslate === 'function', '应导出 demoTranslate 供测试');
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * 翻译风格场景
   * ------------------------------------------------------------------ */

  function testScenarios() {
    return test('场景库：内置场景齐全且提示词完整', function () {
      var list = IMT.PROMPT_SCENARIOS || [];
      assert(list.length >= 14, '内置场景应不少于 14 个，实际 ' + list.length);

      var ids = list.map(function (s) { return s.id; });
      ['general', 'tech', 'news', 'paper', 'programming-docs', 'github', 'legal',
        'medical', 'financial', 'ecommerce', 'customer-service', 'fiction',
        'social', 'plain-english'].forEach(function (id) {
        assert(ids.indexOf(id) >= 0, '场景里应有 ' + id);
      });

      list.forEach(function (s) {
        assert(!!s.id && !!s.name && !!s.desc, '场景 ' + s.id + ' 字段应完整');
        assert(Array.isArray(s.matches), '场景 ' + s.id + ' 的 matches 应是数组');
        // 「通用」场景没有专属提示词（它就是通用规则本身）
        if (s.id !== 'general') {
          assert(!!s.systemPrompt && s.systemPrompt.length > 40,
            '场景 ' + s.id + ' 应有一段专属提示词');
        }
      });
    }).then(function () {
      return test('场景：按网址自动匹配', function () {
        assert(IMT.prompts.match('https://github.com/foo/bar') === 'github',
          'github.com 应匹配 GitHub 场景');
        assert(IMT.prompts.match('https://arxiv.org/abs/2401.00001') === 'paper',
          'arxiv.org 应匹配学术论文场景');
        assert(IMT.prompts.match('https://www.nytimes.com/2024/x') === 'news',
          'nytimes.com 应匹配新闻场景');
        assert(IMT.prompts.match('https://example.com/whatever') === null,
          '没配置过的网址不该被匹配');
        assert(IMT.prompts.match('') === null, '空网址不该被匹配');
      });
    }).then(function () {
      return test('场景：通配符匹配', function () {
        var re = IMT.prompts.urlPatternToRegExp('https://*.example.com/*');
        assert(re.test('https://docs.example.com/a/b'), '应匹配子路径');
        assert(re.test('https://docs.example.com/'), '应匹配根路径');
        assert(!re.test('https://example.com/a'), '不该跨域匹配');
      });
    }).then(function () {
      return test('场景：自定义场景可覆盖同 id 的内置场景', function () {
        var custom = {
          github: { id: 'github', name: '我的 GitHub 风格', desc: '自改的',
            systemPrompt: '用工程师口吻翻译，保留代码。', matches: ['https://git.my.com/*'] }
        };
        var list = IMT.prompts.list(custom);
        var hit = list.filter(function (s) { return s.id === 'github'; })[0];
        assert(!!hit, '应能取到 github 场景');
        assert(hit.name === '我的 GitHub 风格', '自定义场景应覆盖内置的');
        assert(hit.builtin === true, '覆盖后仍算内置场景（可一键恢复）');
        assert(IMT.prompts.match('https://git.my.com/x', custom) === 'github',
          '自定义的网址规则应生效');
        // 内置的 github.com 规则被自定义版本接管（设置页保存时会带上原有网址）
        var merged = { github: Object.assign({}, custom.github, {
          matches: (IMT.PROMPT_SCENARIOS.filter(function (s) { return s.id === 'github'; })[0].matches || [])
            .concat(custom.github.matches || [])
        }) };
        assert(IMT.prompts.match('https://github.com/a/b', merged) === 'github',
          '合并网址后内置的 github.com 仍然生效');
      });
    }).then(function () {
      return test('场景：提示词合成（场景 > 引擎自定义 > 通用）', function () {
        // 1. 通用场景 = 只有通用规则
        var base = IMT.prompts.buildSystemPrompt({
          scenario: 'general', targetName: '简体中文'
        });
        assert(base.indexOf('简体中文') >= 0, '提示词应含目标语言名');
        assert(base.indexOf('{target}') < 0, '占位符应被替换掉');

        // 2. 选中的场景会追加专属规则
        var tech = IMT.prompts.buildSystemPrompt({
          scenario: 'tech', targetName: '简体中文'
        });
        assert(tech.length > base.length, '选场景后提示词应更长');
        assert(tech.indexOf('technology and software content') >= 0,
          '科技场景应追加领域规则');

        // 3. 引擎自定义提示词优先级最高，完全覆盖
        var custom = IMT.prompts.buildSystemPrompt({
          scenario: 'tech', targetName: '简体中文', enginePrompt: '只按我的规则来 {target}'
        });
        assert(custom.indexOf('只按我的规则来') >= 0, '引擎自定义提示词应生效');
        assert(custom.indexOf('technology and software content') < 0,
          '引擎自定义提示词应完全覆盖场景规则');
      });
    }).then(function () {
      return test('场景：术语库接在最后', function () {
        var p = IMT.prompts.buildSystemPrompt({
          scenario: 'general', targetName: '简体中文',
          glossary: '术语：Chrome = 谷歌浏览器'
        });
        assert(p.indexOf('谷歌浏览器') >= 0, '提示词应含术语表');
        assert(p.indexOf('谷歌浏览器') > p.indexOf('Output ONLY the translation'),
          '术语表应排在通用规则之后');
      });
    }).then(function () {
      return test('场景：配置里没配场景时回落到通用', function () {
        var cfg = U.config.merge({ scenario: 'no-such-scenario' });
        assert(cfg.scenario === 'general', '未知场景应回落到 general，实际 ' + cfg.scenario);
        var cfg2 = U.config.merge({});
        assert(cfg2.scenario === 'general', '默认场景应是 general');
        assert(cfg2.autoScenario === true, '默认应开启按网址自动匹配');
      });
    });
  }

  /* ---------------- 交互按钮 ---------------- */

  var demoController = null;

  function demoTranslate() {
    var root = document.getElementById('article');
    var cfg = U.config.merge({ lazy: false });
    var rule = IMT.rules.resolve(cfg, location.href).rule;
    IMT.client.setTransport(mockTransport);
    if (demoController) demoController.stop();
    demoController = IMT.pipeline.create({
      root: root, rule: rule, config: cfg, engineId: 'openai-compatible', lazy: false
    });
    IMT.render.setMode('dual');
    demoController.start();
  }

  function demoRestore() {
    if (demoController) demoController.stop();
    demoController = null;
    IMT.render.setMode('none');
  }

  /* ---------------- 启动 ---------------- */

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('runAll').addEventListener('click', function () {
      results = []; passed = 0; failed = 0;
      renderResults();
      testUtils()
        .then(testDeepMerge)
        .then(testRules)
        .then(testPii)
        .then(testGlossary)
        .then(testSegment)
        .then(testThresholdOverrides)
        .then(testChromeDetection)
        .then(testChromeExclusion)
        .then(testAIEngine)
        .then(testEngineConfig)
        .then(testDemoMode)
        .then(testScenarios)
        .then(testRender)
        .then(testPipeline)
        .then(testContentScript)
        .then(function () {
          var sum = document.getElementById('summary');
          sum.textContent = passed + ' 通过 / ' + failed + ' 失败 / 共 ' + results.length;
          sum.className = failed ? 'fail' : 'pass';
        });
    });

    document.getElementById('runTranslate').addEventListener('click', demoTranslate);
    document.getElementById('restore').addEventListener('click', demoRestore);
    document.getElementById('toggleMode').addEventListener('click', function () {
      var cur = IMT.render.getMode();
      var next = cur === 'dual' ? 'translation' : (cur === 'translation' ? 'original' : 'dual');
      IMT.render.setMode(next);
    });

    renderResults();

    // ?shot=1 —— 自动翻译示例文章，便于截图/预览双语对照效果
    if (/[?&]shot=1/.test(location.search)) {
      setTimeout(demoTranslate, 120);
    }

    // ?autotest=1 —— 自动跑一遍全部断言
    if (/[?&]autotest=1/.test(location.search)) {
      setTimeout(function () {
        document.getElementById('runAll').click();
      }, 120);
    }
  });
})();
