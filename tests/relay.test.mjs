import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { once } from "node:events";
import { WebSocket } from "ws";

async function harness(t) {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  listener.close();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(), env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let logs = "";
  child.stderr.on("data", x => { logs += x.toString(); });
  t.after(() => { child.kill(); });
  const base = "http://127.0.0.1:" + port;
  for (let i = 0; i < 150; i++) {
    try { if ((await (await fetch(base + "/health")).json()).status === "ok") break; }
    catch { await new Promise(done => setTimeout(done, 30)); }
  }
  const health = await (await fetch(base + "/health")).json();
  assert.equal(health.status, "ok", logs);
  return { base, port, health: () => fetch(base + "/health").then(x => x.json()) };
}
function connect(port, origin = "https://chatgpt.com") {
  const ws = new WebSocket("ws://127.0.0.1:" + port + "/ws", {
    headers: { origin },
  });
  return once(ws, "open").then(() => ws);
}
const submit = (base, messages, stream = false, signal) => fetch(base + "/v1/chat/completions", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "auto", messages, stream }), signal,
});
const next = async ws => JSON.parse((await once(ws, "message"))[0].toString());
const send = (ws, data) => ws.send(JSON.stringify(data));

test("local-only API, model catalogue, no userscript returns 503", async t => {
  const h = await harness(t);
  const resp = await submit(h.base, [{ role: "user", content: "你好" }]);
  assert.equal(resp.status, 503);
  const model = await (await fetch(h.base + "/v1/models")).json();
  assert.equal(model.data[0].id, "auto");
  const evil = await fetch(h.base + "/health", { headers: { Origin: "https://malicious.example" } });
  assert.equal(evil.status, 403);
  for (const origin of ["app://shanhai-moji", "tauri://localhost", "null"]) {
    const local = await fetch(h.base + "/health", { headers: { Origin: origin } });
    assert.equal(local.status, 200, origin);
  }
});

test("all 55 history turns and 1,000,000 Chinese characters delivered unchanged", async t => {
  const h = await harness(t);
  const ws = await connect(h.port);
  t.after(() => ws.close());
  const messages = Array.from({ length: 55 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user", content: "历史" + i,
  }));
  const input = "甲" + "长".repeat(1000000) + "终";
  messages.push({ role: "user", content: input });
  const request = submit(h.base, messages);
  const packet = await next(ws);
  assert.deepEqual(packet.messages, messages);
  const answer = "回传" + "文".repeat(95000) + "END";
  send(ws, { type: "response", requestId: packet.requestId, ok: true, content: answer });
  const resp = await request;
  assert.equal(resp.status, 200);
  const json = await resp.json();
  assert.equal(json.choices[0].message.content, answer);
  assert.equal(json.choices[0].finish_reason, "stop");
});

test("streaming deltas are real content, no deadline or fake stream", async t => {
  const h = await harness(t);
  const ws = await connect(h.port);
  t.after(() => ws.close());
  const request = submit(h.base, [{ role: "user", content: "test" }], true);
  const packet = await next(ws);
  const first = "连续中文".repeat(500);
  const final = first + "结尾保留完整";
  send(ws, { type: "progress", requestId: packet.requestId, content: first });
  send(ws, { type: "progress", requestId: packet.requestId, content: final });
  send(ws, { type: "response", requestId: packet.requestId, ok: true, content: final });
  const res = await request;
  assert.equal(res.status, 200);
  const body = await res.text();
  const frames = body.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]");
  const deltas = frames.map(line => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? "");
  assert.equal(deltas.join(""), final);
  assert.match(body, /data: \[DONE\]/);
  assert.equal(frames.filter(line => JSON.parse(line.slice(6)).choices?.[0]?.finish_reason === "stop").length, 1);
});

test("partial response followed by error cannot falsely report success", async t => {
  const h = await harness(t);
  const ws = await connect(h.port);
  t.after(() => ws.close());
  const request = submit(h.base, [{ role: "user", content: "test" }], true);
  const packet = await next(ws);
  send(ws, { type: "progress", requestId: packet.requestId, content: "截断前半句" });
  send(ws, { type: "response", requestId: packet.requestId, ok: false, error: "Browser disconnected" });
  const resp = await request;
  const body = await resp.text();
  assert.match(body, /event: error/);
  assert.doesNotMatch(body, /"finish_reason":"stop"/);
  assert.doesNotMatch(body, /data: \[DONE\]/);
});

test("two parallel API requests are serialized at the browser, not dropped", async t => {
  const h = await harness(t);
  const ws = await connect(h.port);
  t.after(() => ws.close());
  const first = submit(h.base, [{ role: "user", content: "one" }]);
  const a = await next(ws);
  const second = submit(h.base, [{ role: "user", content: "two" }]);
  await new Promise(done => setTimeout(done, 50));
  const health = await h.health();
  assert.equal(health.active, true);
  assert.equal(health.pendingRequests, 2);
  send(ws, { type: "response", requestId: a.requestId, ok: true, content: "A" });
  const bb = await next(ws);
  assert.notEqual(bb.requestId, a.requestId);
  assert.equal(bb.messages[0].content, "two");
  send(ws, { type: "response", requestId: bb.requestId, ok: true, content: "B" });
  assert.equal((await (await first).json()).choices[0].message.content, "A");
  assert.equal((await (await second).json()).choices[0].message.content, "B");
});


test("the userscript installer serves valid JavaScript, with no Chrome extension dependency", async t => {
  const h = await harness(t);
  const resp = await fetch(h.base + "/chatgpt-gateway.user.js");
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get("content-type"), /javascript/);
  const js = await resp.text();
  const tracked = await fetch(h.base + "/chatgpt-gateway.user.js?utm_source=chatgpt.com");
  assert.equal(tracked.status, 200);
  assert.equal(tracked.url, h.base + "/chatgpt-gateway.user.js");
  assert.equal(await tracked.text(), js);
  const raw = await fetch(h.base + "/chatgpt-gateway.user.js?utm_source=chatgpt.com", { redirect: "manual" });
  assert.equal(raw.status, 302);
  assert.equal(raw.headers.get("location"), "/chatgpt-gateway.user.js");
  const healthTracked = await fetch(h.base + "/health?utm_source=chatgpt.com");
  assert.equal(healthTracked.status, 200);
  const modelsTracked = await fetch(h.base + "/v1/models?utm_source=chatgpt.com");
  assert.equal(modelsTracked.status, 200);
  assert.match(js, /@name.*ChatGPT/);
  assert.match(js, /@match.*chatgpt\.com/);
  assert.match(js, /@connect\s+127\.0\.0\.1/);
  assert.match(js, /GM_xmlhttpRequest\(/);
  assert.doesNotMatch(js, /new WebSocket\(/);
});

test("WebSocket with ChatGPT Origin header carries incremental UTF-8 chunks exactly", async t => {
  const h = await harness(t);
  const ws = await connect(h.port, "https://chatgpt.com");
  t.after(() => ws.close());
  const request = submit(h.base, [{ role: "user", content: "您好" }], true);
  const packet = await next(ws);
  const first = "你好，中".repeat(190);
  send(ws, { type: "progress", requestId: packet.requestId, offset: 0, delta: first });
  send(ws, { type: "progress", requestId: packet.requestId, offset: first.length, delta: "文结尾" });
  send(ws, { type: "response", requestId: packet.requestId, ok: true, content: first + "文结尾" });
  const resp = await request;
  const raw = await resp.text();
  const parts = raw.split("\n").filter(s => s.startsWith("data: ") && !s.includes("[DONE]"));
  const actual = parts.map(s => JSON.parse(s.slice(6)).choices[0].delta.content || "").join("");
  assert.equal(actual, first + "文结尾");
  assert.match(raw, /data: \[DONE\]/);
});

test("a rewritten or truncated streaming result is an error, never a normal completion", async t => {
  const h = await harness(t);
  const ws = await connect(h.port);
  t.after(() => ws.close());
  const request = submit(h.base, [{ role: "user", content: "test" }], true);
  const packet = await next(ws);
  send(ws, { type: "progress", requestId: packet.requestId, offset: 0, delta: "已有内容" });
  send(ws, { type: "response", requestId: packet.requestId, ok: true, content: "不一致的回答" });
  const raw = await (await request).text();
  assert.match(raw, /event: error/);
  assert.doesNotMatch(raw, /data: \[DONE\]/);
});


async function grantedReceiver(h, t) {
  const headers = { 'X-ChatGPT-Gateway': 'userscript-v1',
    'X-Gateway-Client': '11111111-1111-4111-8111-111111111111' };
  const abort = new AbortController();
  const response = await fetch(h.base + '/userscript/events', { headers, signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  t.after(() => { abort.abort(); void reader.cancel().catch(() => {}); });
  let buffer = ''; const decoder = new TextDecoder();
  async function take() {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (frame.startsWith('data: ')) return JSON.parse(frame.slice(6));
        continue;
      }
      const result = await reader.read();
      if (result.done) throw Error('Receiver stream ended');
      buffer += decoder.decode(result.value, { stream: true });
    }
  }
  const post = event => fetch(h.base + '/userscript/message', { method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(event) });
  assert.equal((await take()).type, 'connected');
  return { headers, take, post, abort };
}

test('granted HTTP receives full Unicode history and returns exact streamed answer', { timeout: 10000 }, async t => {
  const h = await harness(t), receiver = await grantedReceiver(h, t);
  assert.equal((await h.health()).receiverTransport, 'tampermonkey-granted-http');
  const messages = Array.from({ length: 55 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '历史' + i }));
  messages.push({ role: 'user', content: '首' + '中'.repeat(1000000) + '尾' });
  const request = submit(h.base, messages, true);
  const packet = await receiver.take();
  assert.deepEqual(packet.messages, messages);
  const part = '逐字保留'.repeat(20000);
  assert.equal((await receiver.post({ type: 'progress', requestId: packet.requestId, offset: 0, delta: part })).status, 200);
  const tail = '完整结尾';
  assert.equal((await receiver.post({ type: 'progress', requestId: packet.requestId, offset: part.length, delta: tail })).status, 200);
  assert.equal((await receiver.post({ type: 'response', requestId: packet.requestId, ok: true, content: part + tail })).status, 200);
  const raw = await (await request).text();
  const frames = raw.split('\n').filter(s => s.startsWith('data: ') && !s.includes('[DONE]'));
  assert.equal(frames.map(s => JSON.parse(s.slice(6)).choices[0].delta.content || '').join(''), part + tail);
  assert.match(raw, /data: \[DONE\]/);
});

test('a second HTTP receiver cannot replace the active receiving tab', async t => {
  const h = await harness(t), receiver = await grantedReceiver(h, t);
  const second = await fetch(h.base + '/userscript/events', { headers: {
    ...receiver.headers, 'X-Gateway-Client': '22222222-2222-4222-8222-222222222222' } });
  assert.equal(second.status, 409);
  assert.equal((await h.health()).userscriptConnected, true);
  assert.equal((await fetch(h.base + '/userscript/events')).status, 403);
});

test('granted receiver disconnect terminates stream as error without fake completion', { timeout: 8000 }, async t => {
  const h = await harness(t), receiver = await grantedReceiver(h, t);
  const request = submit(h.base, [{ role: 'user', content: 'test' }], true);
  const packet = await receiver.take();
  assert.equal((await receiver.post({ type: 'progress', requestId: packet.requestId, offset: 0, delta: '前半句' })).status, 200);
  receiver.abort.abort();
  const raw = await (await request).text();
  assert.match(raw, /event: error/);
  assert.doesNotMatch(raw, /"finish_reason":"stop"|data: \[DONE\]/);
});

test('granted HTTP upgrades an idle legacy connection without stealing active work', async t => {
  const h = await harness(t), ws = await connect(h.port);
  t.after(() => ws.close());
  const receiver = await grantedReceiver(h, t);
  assert.equal((await h.health()).receiverTransport, 'tampermonkey-granted-http');
  const req = submit(h.base, [{ role: 'user', content: 'test' }]);
  const packet = await receiver.take();
  const other = await fetch(h.base + '/userscript/events', { headers: {
    ...receiver.headers, 'X-Gateway-Client': '22222222-2222-4222-8222-222222222222' } });
  assert.equal(other.status, 409);
  assert.equal((await receiver.post({ type: 'response', requestId: packet.requestId, ok: true, content: '完整' })).status, 200);
  assert.equal((await (await req).json()).choices[0].message.content, '完整');
});
