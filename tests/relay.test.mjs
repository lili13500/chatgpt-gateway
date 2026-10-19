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
function connect(port) {
  const ws = new WebSocket("ws://127.0.0.1:" + port + "/ws", {
    headers: { origin: "chrome-extension://testing-extension" },
  });
  return once(ws, "open").then(() => ws);
}
const submit = (base, messages, stream = false, signal) => fetch(base + "/v1/chat/completions", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "auto", messages, stream }), signal,
});
const next = async ws => JSON.parse((await once(ws, "message"))[0].toString());
const send = (ws, data) => ws.send(JSON.stringify(data));

test("local-only API, model catalogue, no extension returns 503", async t => {
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
