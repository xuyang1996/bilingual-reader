/* Pause/resume and cancellation tests, run by verify_reliability.py. */
(async function () {
  'use strict';
  var results = [], realFetch = window.fetch, realIO = window.IntersectionObserver;
  var controller, root, sequence = 0;
  function assert(ok, message) { if (!ok) throw new Error(message); }
  function tick() { return new Promise(function (resolve) { setTimeout(resolve, 0); }); }
  async function test(name, fn) {
    try { await fn(); results.push({ name: name, ok: true }); }
    catch (err) { results.push({ name: name, ok: false, error: err.message }); }
    finally {
      if (controller) controller.stop();
      if (root) root.remove();
      controller = root = null;
      window.fetch = realFetch;
      window.IntersectionObserver = realIO;
    }
  }
  function setup(size, options) {
    root = document.createElement('article');
    for (var i = 0; i < size; i++) {
      var p = document.createElement('p');
      p.textContent = 'Paragraph ' + i + ': English content for reliable translation control testing.';
      root.appendChild(p);
    }
    document.body.appendChild(root);
    controller = IMT.pipeline.create(Object.assign({ root: root, lazy: false,
      rule: { translateChrome: true, thresholds: { mainFrameMinTextCount: 0 } },
      config: IMT.utils.config.merge({ lazy: false, incremental: true,
        pii: { enabled: false }, engine: 'mock', engines: { mock: { batchSize: 1 } } }) }, options));
    return controller;
  }
  function deferredTransport() {
    var calls = [];
    IMT.client.setTransport(function (texts, req) {
      return new Promise(function (resolve) {
        calls.push({ text: texts[0], req: req, complete: function (value) {
          this.finished = true; resolve([value || '译文']);
        } });
      });
    });
    return calls;
  }
  function engine() {
    return { type: 'ai', format: 'openai', baseUrl: 'https://controls.invalid/' + (++sequence),
      key: 'test-only', auth: 'bearer', model: 'mock', timeout: 2 };
  }
  var opts = { sourceLang: 'auto', targetLang: 'zh-Hans' };
  async function rejected(promise) {
    try { await promise; } catch (err) { return err; }
    throw new Error('expected cancellation');
  }
  await test('pause cancels active work, preserves translations, and resumes from the previous paragraph', async function () {
    var calls = deferredTransport();
    setup(6).start();
    calls[0].complete('第一段'); calls[1].complete('第二段'); await tick();
    assert(calls.length === 4, 'expected two completed and two active paragraphs');
    var first = root.children[0].querySelector('.imtl-translation');
    var previous = root.children[1].querySelector('.imtl-translation');
    controller.pause();
    assert(controller.getStats().paused && !controller.getStats().pending, 'pause state missing');
    assert(calls[2].req.signal.aborted && calls[3].req.signal.aborted, 'active requests not cancelled');
    assert(controller.getStats().done === 2 && root.querySelectorAll('.imtl-translation').length === 2, 'completed translations lost');
    await tick(); assert(calls.length === 4, 'new requests sent while paused');
    controller.resume();
    assert(calls[4].text.indexOf('Paragraph 1:') === 0 && calls[5].text.indexOf('Paragraph 2:') === 0,
      'did not resume from the previous paragraph');
    assert(calls[4].req.bypassCache, 'previous paragraph should actually be translated again');
    // A transport that ignores abort may resolve after resume. Its old result must be ignored.
    calls[2].complete('过期译文'); calls[3].complete('过期译文'); await tick();
    assert(root.textContent.indexOf('过期译文') < 0 && controller.getStats().done === 1, 'late results changed the resumed run');
    for (var turn = 0; turn < 10 && controller.getStats().pending; turn++) {
      calls.forEach(function (call) { if (!call.finished) call.complete('继续译文'); });
      await tick();
    }
    assert(controller.getStats().done === 6 && !controller.getStats().failed, 'incorrect resumed progress');
    assert(root.querySelectorAll('.imtl-translation').length === 6 && root.querySelectorAll('.imtl-original').length === 6, 'duplicate wrappers after resuming');
    assert(root.children[0].querySelector('.imtl-translation') === first && root.children[1].querySelector('.imtl-translation') === previous,
      'existing translation nodes were replaced');
  });
  await test('rapid pause/resume cycles do not duplicate tasks or accept stale failures', async function () {
    var calls = deferredTransport(); setup(4).start();
    controller.pause(); controller.resume(); controller.pause(); controller.resume();
    assert(calls.length === 6 && calls.slice(0, 4).every(function (call) { return call.req.signal.aborted; }), 'old runs remain active');
    for (var turn = 0; turn < 10 && controller.getStats().pending; turn++) {
      calls.forEach(function (call) { if (!call.finished) call.complete('当前译文'); });
      await tick();
    }
    assert(controller.getStats().done === 4 && root.querySelectorAll('.imtl-translation').length === 4, 'rapid resume duplicated work');
    controller.resume(); assert(calls.length === 8, 'resume while already running repeated work');
  });
  await test('lazy scrolling and incremental content remain suspended until resume', async function () {
    var io;
    window.IntersectionObserver = function (callback) {
      io = this; this.callback = callback; this.observed = new Set();
      this.observe = function (el) { this.observed.add(el); };
      this.unobserve = function (el) { this.observed.delete(el); };
      this.disconnect = function () { this.observed.clear(); };
    };
    var calls = deferredTransport();
    var cfg = IMT.utils.config.merge({ lazy: true, incremental: true, pii: { enabled: false } });
    setup(3, { lazy: true, config: cfg }).start();
    assert(controller.getStats().waiting === 3 && calls.length === 0, 'fixture was not lazy');
    controller.pause();
    io.callback([{ target: root.children[1], isIntersecting: true }]);
    var p = document.createElement('p');
    p.textContent = 'New English content added while translation remains paused should wait for resume.';
    root.appendChild(p); await tick();
    assert(calls.length === 0 && controller.getStats().total === 4, 'paused incremental work sent requests or was lost');
    controller.resume();
    assert(calls.length === 1 && calls[0].text.indexOf('Paragraph 0:') === 0 && io.observed.has(p), 'resume did not restart lazy observers');
  });
  await test('restoring a paused page cancels the session and fully unwraps the DOM', async function () {
    var calls = deferredTransport(); setup(3);
    var original = root.innerHTML;
    controller.start(); calls[0].complete('译文'); await tick(); controller.pause(); controller.stop();
    calls.forEach(function (call) { if (!call.finished) call.complete('晚到译文'); }); await tick();
    assert(root.innerHTML === original && !controller.getStats().paused && controller.isStopped(), 'restore retained paused state or stale nodes');
  });
  await test('pausing a completed page is a no-op', async function () {
    IMT.client.setTransport(function () { return ['已译']; });
    setup(2).start(); await tick(); controller.pause();
    assert(!controller.getStats().paused && controller.getStats().done === 2, 'completed page became paused');
  });
  await test('cancelling fetch aborts the network without treating it as a retryable failure', async function () {
    var calls = 0, cancelled = false, abort = new AbortController();
    window.fetch = function (_, init) {
      calls++;
      return new Promise(function (_, reject) {
        init.signal.addEventListener('abort', function () { cancelled = true; reject(new DOMException('abort', 'AbortError')); });
      });
    };
    var request = IMT.engines.ai.request(['hello'], Object.assign({}, opts, { signal: abort.signal }), engine());
    await tick(); abort.abort();
    var err = await rejected(request);
    assert(err.code === 'ENGINE_CANCELLED' && calls === 1 && cancelled, 'cancelled request retried or was misreported');
  });
  await test('cancelled shared probe does not cancel another page request', async function () {
    var calls = 0, abort = new AbortController(), e = engine();
    window.fetch = function (_, init) {
      calls++;
      if (calls > 1) return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: '独立成功' } }] })));
      return new Promise(function (_, reject) {
        init.signal.addEventListener('abort', function () { reject(new DOMException('abort', 'AbortError')); });
      });
    };
    var first = rejected(IMT.engines.ai.request(['first'], Object.assign({}, opts, { signal: abort.signal }), e));
    var other = IMT.engines.ai.request(['other'], opts, e);
    await tick(); abort.abort();
    assert((await first).code === 'ENGINE_CANCELLED' && await other === '独立成功' && calls === 2, 'probe cancellation spread to unrelated work');
  });
  await test('cancelling during backoff prevents the next retry', async function () {
    var calls = 0, abort = new AbortController();
    window.fetch = function () {
      calls++;
      return Promise.resolve(new Response(JSON.stringify({ error: { message: 'rate limit' } }), { status: 429 }));
    };
    var request = rejected(IMT.engines.ai.request(['hello'], Object.assign({}, opts, { signal: abort.signal }), engine()));
    await new Promise(function (resolve) { setTimeout(resolve, 30); }); abort.abort();
    assert((await request).code === 'ENGINE_CANCELLED' && calls === 1, 'backoff did not cancel');
  });
  return results;
})()
