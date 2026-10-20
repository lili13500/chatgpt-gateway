import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const script = readFileSync("chatgpt-gateway.user.js", "utf8");

function pageHarness(enabled, storageUnavailable = false, sharedStorage = null, actualUrl = null) {
  let socket = null;
  let websocketCount = 0;
  let responseResolve;
  const response = new Promise(done => { responseResolve = done; });
  const posted = [];
  let answer = "";
  let visible = false;
  let complete = false;
  let firstProgressReceived = false;
  const storage = sharedStorage || new Map();
  const chatUrl = actualUrl || (enabled ? "https://chatgpt.com/?web_gateway=1" : "https://chatgpt.com/");
  const location = {
    href: chatUrl,
    pathname: "/",
  };
  let inputString = "";
  let sentPrompt = "";
  const input = {
    isContentEditable: true,
    get textContent() { return inputString; },
    set textContent(value) { inputString = value; },
    disabled: false,
    getAttribute() { return null; },
    focus() {}, dispatchEvent() {},
    replaceChildren(node) { inputString = node.textContent; },
  };
  const sendButton = {
    disabled: false,
    getAttribute() { return null; },
    click() {
      sentPrompt = inputString;
      visible = true;
      setTimeout(() => { answer = "第一段"; }, 30);
      // The simulated final response waits for the first progress POST,
      // so this test checks real incremental delivery rather than timer luck.
    },
  };
  const assistant = {
    querySelector(value) {
      if (value.includes(".markdown")) return { get innerText() { return answer; } };
      if (value.includes("copy-turn")) return complete ? { id: "completed" } : null;
      return null;
    },
  };
  const document = {
    querySelector(selector) {
      if (selector.includes("prompt-textarea")) return input;
      if (selector.includes("send-button")) return sendButton;
      if (selector.includes("stop-button")) return null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes('send-button')) return [sendButton];
      if (selector.includes('data-message-author-role="user"')) return visible ? [{}] : [];
      return selector.includes("assistant") && visible ? [assistant] : [];
    },
    execCommand(command, _ui, value) {
      if (command === "insertText") { inputString = value; return true; }
      return false;
    },
    createTextNode(text) { return { textContent: text }; },
  };
  function gmRequest(options) {
    assert.equal(options.headers["X-ChatGPT-Gateway"], "userscript-v1");
    if (options.method === "POST") {
      assert.equal(options.url, "http://127.0.0.1:18080/userscript/message");
      const msg = JSON.parse(options.data);
      posted.push(msg);
      if (msg.type === "progress" && !firstProgressReceived) {
        firstProgressReceived = true;
        assert.equal(msg.delta, "第一段");
        assert.equal(complete, false);
        setTimeout(() => { answer = "第一段完整的结尾。"; }, 30);
        setTimeout(() => { complete = true; }, 450);
      }
      queueMicrotask(() => options.onload({ status: 200, responseText: '{"accepted":true}' }));
      if (msg.type === "response") responseResolve(msg);
      return { abort() {} };
    }
    assert.equal(options.url, "http://127.0.0.1:18080/userscript/events");
    assert.equal(options.responseType, "stream");
    websocketCount++;
    let controller;
    const stream = new ReadableStream({ start(value) { controller = value; } });
    const enqueue = object => controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify(object) + "\n\n"));
    socket = {
      onopen() { void options.onloadstart({ status: 200, response: stream }); enqueue({ type: "connected" }); },
      onmessage(packet) { enqueue(JSON.parse(packet.data)); },
    };
    return { abort() {} };
  }
  document.addEventListener = () => {};
  const context = {
    location, document, GM_xmlhttpRequest: gmRequest, crypto: webcrypto, TextDecoder,
    WebSocket: class { constructor() { throw Error("Native WebSocket must not be used"); } },
    console: { info() {}, warn() {} },
    URL,
    sessionStorage: {
      getItem: key => { if (storageUnavailable) throw Error('blocked'); return storage.get(key); },
      setItem: (key, value) => { if (storageUnavailable) throw Error('blocked'); storage.set(key, value); },
    },
    window: { addEventListener() {} },
    setInterval() { return 1; }, setTimeout, clearTimeout, clearInterval() {},
    HTMLTextAreaElement: class {}, InputEvent: class {}, Event: class {},
  };
  context.window.__chatgptLocalGateway = false;
  vm.runInNewContext(script, context);
  return {
    response, posted, getSocket: () => socket,
    getWebsocketCount: () => websocketCount, getSentPrompt: () => sentPrompt,
  };
}
test("Tampermonkey is inactive in normal ChatGPT tabs", () => {
  const h = pageHarness(false);
  assert.equal(h.getWebsocketCount(), 0);
});
test("dedicated ChatGPT tab sends the entire conversation without focus hijack", async () => {
  const h = pageHarness(true);
  assert.equal(h.getWebsocketCount(), 1);
  const socket = h.getSocket();
  socket.onopen();
  const history = Array.from({ length: 53 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user", content: "消息" + i,
  }));
  const large = "头" + "测".repeat(75000) + "尾";
  history.push({ role: "user", content: large });
  socket.onmessage({ data: JSON.stringify({
    type: "chat", requestId: "proof-1", model: "auto",
    messages: history, newConversation: true,
  }) });
  const result = await Promise.race([
    h.response,
    new Promise((_, reject) => setTimeout(() => reject(new Error("page completion timeout")), 3900)),
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.content, "第一段完整的结尾。");
  const prompt = h.getSentPrompt();
  assert.ok(prompt.includes(large));
  for (let i = 0; i < 53; i++) assert.ok(prompt.includes("消息" + i));
  const progress = h.posted.filter(item => item.type === "progress");
  assert.ok(progress.length >= 2);
  let reconstructed = "";
  for (const part of progress) {
    assert.equal(part.offset, reconstructed.length);
    reconstructed += part.delta;
  }
  assert.equal(reconstructed, result.content);
});


test("explicit gateway tab remains enabled if sandbox sessionStorage is unavailable", () => {
  const h = pageHarness(true, true);
  assert.equal(h.getWebsocketCount(), 1);
});


test("document-start saves the tab marker before a full ChatGPT redirect", () => {
  assert.ok(script.includes("@run-at       document-start"));
  const storage = new Map();
  const first = pageHarness(true, false, storage);
  assert.equal(first.getWebsocketCount(), 1);
  const redirected = pageHarness(false, false, storage, "https://chatgpt.com/dots/home");
  assert.equal(redirected.getWebsocketCount(), 1);
  const ordinary = pageHarness(false);
  assert.equal(ordinary.getWebsocketCount(), 0);
});
