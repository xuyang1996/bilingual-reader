/* Fault injection tests. Run in an isolated browser with verify_reliability.py. */
(async function () {
  'use strict';
  var results = [];
  var realFetch = window.fetch;
  var opts = { sourceLang: 'auto', targetLang: 'zh-Hans' };
  var serial = 0;
  function assert(ok, message) { if (!ok) throw new Error(message); }
  async function test(name, fn) {
    try { await fn(); results.push({ name: name, ok: true }); }
    catch (err) { results.push({ name: name, ok: false, error: String(err.message || err) }); }
  }
  function engine(overrides) {
    return Object.assign({ type: 'ai', format: 'openai', baseUrl: 'https://test.invalid/' + (++serial),
      model: 'mock', auth: 'bearer', key: 'test-key', timeout: 1, batchSize: 1 }, overrides);
  }
  function response(status, body, headers) {
    return Promise.resolve(new Response(JSON.stringify(body), { status: status, headers: headers || {} }));
  }
  function translated(text) { return { choices: [{ message: { content: text } }] }; }
  async function rejection(promise) {
    try { await promise; } catch (err) { return err; }
    throw new Error('Expected failure, got success');
  }
  async function settled(controller) {
    var end = Date.now() + 3000;
    while (controller.getStats().pending && Date.now() < end) {
      await new Promise(function (resolve) { setTimeout(resolve, 10); });
    }
    assert(!controller.getStats().pending, 'pipeline did not settle');
  }
  function fixture(size) {
    var article = document.createElement('article');
    for (var i = 0; i < size; i++) {
      var p = document.createElement('p');
      p.textContent = 'Paragraph ' + i + ': This is an English paragraph with enough words to translate reliably.';
      article.appendChild(p);
    }
    document.body.appendChild(article);
    return article;
  }
  function pipeline(root, overrides) {
    var cfg = IMT.utils.config.merge({ lazy: false, incremental: false,
      pii: { enabled: false }, engine: 'mock', engines: { mock: { batchSize: 1 } } });
    return IMT.pipeline.create(Object.assign({ root: root, config: cfg, lazy: false,
      rule: { translateChrome: true, thresholds: { mainFrameMinTextCount: 0 } } }, overrides));
  }
  try {
    await test('retired model: concurrent requests share one failure, no URL probing', async function () {
      var calls = 0;
      window.fetch = function () {
        calls++;
        return response(404, { error: { message: 'The model "MiniMax-Text-01" is no longer available. (2069)' } });
      };
      var e = engine({ model: 'MiniMax-Text-01' });
      var errors = await Promise.all(Array.from({ length: 8 }, function () {
        return rejection(IMT.engines.ai.request(['hello'], opts, e));
      }));
      assert(calls === 1, 'sent ' + calls + ' requests');
      assert(errors.every(function (err) { return err.fatal && err.code === 'ENGINE_MODEL_UNAVAILABLE'; }), 'missing model error metadata');
      assert(errors[0].message.indexOf('设置页') >= 0, 'missing actionable error');
    });
    await test('corrected model can be tested immediately after a fatal error', async function () {
      window.fetch = function () { return response(200, translated('你好')); };
      var out = await IMT.engines.ai.request(['hello'], opts, engine({ model: 'MiniMax-M3.1-Flash' }));
      assert(out === '你好', 'corrected configuration blocked');
    });
    await test('generic endpoint 404 still probes /v1 and remembers the working path', async function () {
      var urls = [];
      window.fetch = function (url) {
        urls.push(url);
        return /\/v1\//.test(url) ? response(200, translated('你好')) : response(404, { error: { message: 'not found' } });
      };
      var e = engine();
      await IMT.engines.ai.request(['hello'], opts, e);
      await IMT.engines.ai.request(['world'], opts, e);
      assert(urls.length === 3 && /\/v1\//.test(urls[2]), JSON.stringify(urls));
    });
    await test('one bad paragraph during probing does not fail unrelated concurrent paragraphs', async function () {
      window.fetch = function (_, init) {
        var text = JSON.parse(init.body).messages.slice(-1)[0].content;
        return text === 'bad' ? response(400, { error: { message: 'invalid input text' } }) : response(200, translated('正确'));
      };
      var e = engine();
      var out = await Promise.allSettled(['bad', 'good', 'another'].map(function (text) {
        return IMT.engines.ai.request([text], opts, e);
      }));
      assert(out[0].status === 'rejected' && out[1].value === '正确' && out[2].value === '正确', 'probe failure spread to other inputs');
    });
    await test('429 retry honors Retry-After, stays on the same URL and recovers', async function () {
      var times = [], urls = [];
      window.fetch = function (url) {
        urls.push(url); times.push(Date.now());
        return times.length === 1 ? response(429, { error: { message: 'rate limit' } }, { 'Retry-After': '1' })
          : response(200, translated('恢复成功'));
      };
      assert(await IMT.engines.ai.request(['hello'], opts, engine()) === '恢复成功', 'did not recover');
      assert(times.length === 2 && times[1] - times[0] >= 990 && urls[0] === urls[1], 'retry delay/path wrong');
    });
    await test('temporary network failure retries the original URL', async function () {
      var urls = [];
      window.fetch = function (url) {
        urls.push(url);
        return urls.length === 1 ? Promise.reject(new TypeError('Failed to fetch')) : response(200, translated('恢复'));
      };
      await IMT.engines.ai.request(['hello'], opts, engine());
      assert(urls.length === 2 && urls[0] === urls[1], 'network retry changed URL');
    });
    await test('response-body stall remains covered by the request timeout', async function () {
      window.fetch = function (_, init) {
        return Promise.resolve({ text: function () {
          return new Promise(function (_, reject) {
            init.signal.addEventListener('abort', function () { reject(new DOMException('aborted', 'AbortError')); });
          });
        } });
      };
      // Outer deadline also makes the regression fail promptly on the old implementation.
      var err = await Promise.race([
        rejection(IMT.engines.httpFetch('https://test.invalid', {}, 30)),
        new Promise(function (resolve) { setTimeout(function () { resolve({ code: 'TEST_STALLED' }); }, 150); })
      ]);
      assert(err.code === 'ENGINE_TIMEOUT', 'body timeout was cleared at response headers');
    });
    await test('HTTP 200 provider error envelope is a failure, never translated error text', async function () {
      window.fetch = function () { return response(200, { base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }); };
      var err = await rejection(IMT.engines.ai.request(['hello'], opts, engine()));
      assert(err.code === 'ENGINE_QUOTA' && err.fatal, 'quota error lost');
    });
    await test('batch service outage has bounded retries and does not fan out into single requests', async function () {
      var calls = 0;
      window.fetch = function () { calls++; return response(503, { error: { message: 'temporarily unavailable' } }); };
      var out = await IMT.engines.dispatch(engine({ batchSize: 5 }), ['one', 'two', 'three'], opts);
      assert(calls === 3, 'expected 3 bounded attempts, got ' + calls);
      assert(out.every(function (text) { return !text; }) && out.errors.every(function (err) { return err.fatal; }), 'missing batch failures');
    });
    await test('sequential fallback preserves successes before and after one bad paragraph', async function () {
      window.fetch = function (_, init) {
        var text = JSON.parse(init.body).messages.slice(-1)[0].content;
        return text === 'bad' ? response(400, { error: { message: 'invalid input text' } }) : response(200, translated('译:' + text));
      };
      var out = await IMT.engines.dispatch(engine(), ['first', 'bad', 'last'], opts);
      assert(out[0] === '译:first' && !out[1] && out[2] === '译:last' && out.errors[1], 'partial results lost');
    });
    await test('malformed batch only retries its own chunk; final one-item chunk uses single protocol', async function () {
      var calls = [];
      window.fetch = function (_, init) {
        var text = JSON.parse(init.body).messages.slice(-1)[0].content;
        calls.push(text);
        return response(200, translated(text === '1. a\n2. b' ? '1. 甲\n2. 乙' : text === '1. c\n2. d' ? 'malformed' : '译:' + text));
      };
      var out = await IMT.engines.dispatch(engine({ batchSize: 2 }), ['a', 'b', 'c', 'd', 'e'], opts);
      assert(JSON.stringify(Array.from(out)) === JSON.stringify(['甲', '乙', '译:c', '译:d', '译:e']), JSON.stringify(out));
      assert(calls.length === 5 && calls.filter(function (s) { return s === '1. a\n2. b'; }).length === 1, 'successful chunk translated again');
    });
    await test('reasoning-only output is not accepted as a translation', async function () {
      window.fetch = function () { return response(200, { choices: [{ message: { content: '', reasoning_content: 'internal reasoning' }, finish_reason: 'length' }] }); };
      await rejection(IMT.engines.ai.request(['hello'], opts, engine()));
    });
    await test('pipeline: missing translations fail visibly; retry preserves successful DOM nodes', async function () {
      var root = fixture(3), calls = [];
      IMT.client.setTransport(function (texts) {
        calls.push(texts[0]);
        return [texts[0].indexOf('Paragraph 1:') >= 0 ? '' : '成功译文'];
      });
      var controller = pipeline(root).start();
      await settled(controller);
      assert(controller.getStats().done === 2 && controller.getStats().failed === 1, JSON.stringify(controller.getStats()));
      var existing = root.querySelector('.imtl-translation');
      IMT.client.setTransport(function (texts) { calls.push(texts[0]); return ['补翻成功']; });
      controller.retryFailed();
      await settled(controller);
      assert(controller.getStats().done === 3 && !controller.getStats().failed && calls.length === 4, 'retry retranslated successes');
      assert(root.querySelector('.imtl-translation') === existing && !root.querySelector('.imtl-error'), 'successful DOM replaced or error remains');
      controller.stop(); root.remove();
    });
    await test('pipeline: model failure pauses queued requests and exposes its cause', async function () {
      var root = fixture(20), calls = 0;
      IMT.client.setTransport(function () {
        calls++;
        return Promise.reject(Object.assign(new Error('模型已下线，请更换模型'), { code: 'ENGINE_MODEL_UNAVAILABLE', fatal: true }));
      });
      var controller = pipeline(root).start();
      await settled(controller);
      assert(calls <= 2 && controller.getStats().failed === 20, 'continued flooding invalid model: ' + calls);
      assert(controller.getStats().lastError.indexOf('模型已下线') >= 0 && !root.querySelector('.imtl-translation'), 'failure masked as success');
      controller.stop(); root.remove();
    });
    await test('pipeline: stopping before rejection leaves the page fully restored', async function () {
      var root = fixture(3), before = root.innerHTML, rejects = [];
      IMT.client.setTransport(function () { return new Promise(function (_, reject) { rejects.push(reject); }); });
      var controller = pipeline(root).start();
      controller.stop();
      rejects.forEach(function (reject) { reject(new Error('late failure')); });
      await new Promise(function (resolve) { setTimeout(resolve, 20); });
      assert(root.innerHTML === before && !controller.getStats().failed, 'late failure re-added error markers after restore');
      root.remove();
    });
    await test('pipeline: mixed mutation records do not drop newly loaded content', async function () {
      var root = fixture(1);
      IMT.client.setTransport(function () { return ['已翻译']; });
      var cfg = IMT.utils.config.merge({ lazy: false, incremental: true, pii: { enabled: false } });
      var controller = pipeline(root, { config: cfg }).start();
      await settled(controller);
      var extra = document.createElement('p');
      extra.textContent = 'Newly loaded English article content should still be translated in mixed mutation batches.';
      // Simulate a render and a real site update in the same observer delivery.
      var own = document.createElement('font'); own.className = 'imtl-translation';
      root.firstChild.appendChild(own); root.appendChild(extra);
      await new Promise(function (resolve) { setTimeout(resolve, 50); });
      await settled(controller);
      assert(extra.querySelector('.imtl-translation'), 'new content ignored because a translation node was also added');
      controller.stop(); root.remove();
    });
  } finally { window.fetch = realFetch; }
  return results;
})()
