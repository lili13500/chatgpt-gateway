import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

test("extension opens an inactive tab, preserves full history and relays progress", async () => {
  let workerListener;
  let socket;
  const created = [];
  const removed = [];
  const tabsSent = [];
  const wsMessages = [];
  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor(url) {
      assert.equal(url, "ws://127.0.0.1:18080/ws");
      this.readyState = FakeWebSocket.OPEN;
      socket = this;
    }
    send(s) { wsMessages.push(JSON.parse(s)); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const chrome = {
    tabs: {
      async create(opts) { created.push(opts); return { id: 52 }; },
      async sendMessage(id, msg) {
        tabsSent.push({ id, msg });
        return { accepted: true };
      },
      async remove(id) { removed.push(id); },
    },
    runtime: {
      onMessage: { addListener(fn) { workerListener = fn; } },
      onStartup: { addListener() {} }, onInstalled: { addListener() {} },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  let nextTimer = 1;
  vm.runInNewContext(fs.readFileSync("background.js", "utf8"), {
    chrome, WebSocket: FakeWebSocket, setTimeout,
    setInterval: () => nextTimer++, clearInterval: () => {},
    console,
  });
  socket.onopen();
  const data = Array.from({ length: 90 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user", content: "完整历史" + i,
  }));
  socket.onmessage({ data: JSON.stringify({
    type: "chat", requestId: "test-bridge-1", messages: data, model: "auto",
  }) });
  await new Promise(done => setTimeout(done, 35));
  assert.equal(created.length, 1);
  assert.equal(created[0].active, false);
  assert.equal(created[0].url, "https://chatgpt.com/");
  assert.equal(tabsSent.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(tabsSent[0].msg.messages)), data);
  assert.equal(tabsSent[0].msg.requestId, "test-bridge-1");
  workerListener({ type: "progress", requestId: "test-bridge-1", content: "第一段" },
    { tab: { id: 52 } }, () => {});
  workerListener({ type: "response", requestId: "test-bridge-1", ok: true, content: "第一段最终" },
    { tab: { id: 52 } }, () => {});
  await new Promise(done => setTimeout(done, 15));
  assert.deepEqual(wsMessages.filter(m => m.requestId === "test-bridge-1")
    .map(m => m.type), ["progress", "response"]);
  assert.deepEqual(removed, [52]);
});
