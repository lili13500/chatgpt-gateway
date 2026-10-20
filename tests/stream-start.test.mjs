import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
const source = readFileSync('chatgpt-gateway.user.js', 'utf8');
function harness(t) {
  let options, controller, aborts = 0;
  const messages = [], timers = [];
  const stream = new ReadableStream({ start(c) { controller = c; } });
  const context = {
    location: { href: 'https://chatgpt.com/?web_gateway=1', pathname: '/' },
    sessionStorage: { getItem() { return '1'; }, setItem() {} },
    window: { addEventListener() {} },
    document: { addEventListener() {} },
    console: { info(s) { messages.push(s); }, warn() {} },
    crypto: webcrypto, URL, TextDecoder,
    setTimeout(fn, ms) { const id = setTimeout(fn, ms); id.unref(); timers.push(id); return id; },
    clearTimeout,
    GM_xmlhttpRequest(o) { options = o; return { abort() { aborts++; o.onabort?.(); } }; },
  };
  vm.runInNewContext(source, context);
  t.after(() => { timers.forEach(clearTimeout); controller.close(); });
  return { get options() { return options; }, stream, messages,
    get aborts() { return aborts; },
    send(packet) { controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(packet) + '\n\n')); },
  };
}
test('status zero at loadstart must not abort a valid GM stream', async t => {
  const h = harness(t);
  void h.options.onloadstart({ status: 0, readyState: 1, response: h.stream });
  assert.equal(h.aborts, 0, 'connection was aborted before HTTP response headers');
  assert.equal(h.messages.some(s => s.includes('已连接')), false);
  h.options.onreadystatechange?.({ status: 200, readyState: 2 });
  h.send({ type: 'connected', version: '1.3.0' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.aborts, 0);
  assert.ok(h.messages.some(s => s.includes('已连接')));
});

test('a real HTTP rejection after loadstart remains an error', async t => {
  const h = harness(t);
  void h.options.onloadstart({ status: 0, readyState: 1, response: h.stream });
  h.options.onreadystatechange?.({ status: 403, readyState: 4 });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.aborts, 1);
  assert.ok(h.messages.some(s => s.includes('HTTP 403')));
});

test('network failure after status zero is not mistaken for a connection', async t => {
  const h = harness(t);
  void h.options.onloadstart({ status: 0, readyState: 1, response: h.stream });
  h.options.onerror({ status: 0, readyState: 4 });
  assert.equal(h.aborts, 1);
  assert.equal(h.messages.some(s => s.includes('已连接')), false);
});
