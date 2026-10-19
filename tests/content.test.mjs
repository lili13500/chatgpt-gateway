import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

test("content script preserves all text and completes only after real action appears", async () => {
  const original = fs.readFileSync("content.js", "utf8");
  let receiver;
  let sentText = "";
  let buttonClicked = false;
  let copyReady = false;
  let copyReadyTime = Infinity;
  const events = [];
  let responseResolve;
  const response = new Promise(resolve => { responseResolve = resolve; });
  const composer = {
    isContentEditable: true, textContent: "",
    focus() {}, dispatchEvent() {}, getAttribute() { return null; },
    replaceChildren(node) { this.textContent = node.textContent; },
  };
  const button = { disabled: false, click() {
    buttonClicked = true;
    setTimeout(() => {
      sentText = "开始生成...";
    }, 40);
    setTimeout(() => { sentText = "完整生成的回答，包括结尾。"; }, 280);
    setTimeout(() => {
      copyReady = true;
      copyReadyTime = Date.now();
    }, 950);
  } };
  const assistant = {
    querySelector(selector) {
      if (selector.includes(".markdown")) return { get innerText() { return sentText; } };
      if (selector.includes("copy-turn")) return copyReady ? { id: "copy" } : null;
      return null;
    },
    get innerText() { return sentText; },
  };
  const doc = {
    querySelector(selector) {
      if (selector.includes("prompt-textarea")) return composer;
      if (selector.includes("send-button")) return button;
      if (selector.includes("stop-button")) return null;
      return null;
    },
    querySelectorAll(selector) {
      return selector.includes("assistant") && buttonClicked ? [assistant] : [];
    },
    createRange: () => ({ selectNodeContents() {} }),
    execCommand(cmd, _ui, text) { if (cmd === "insertText") composer.textContent = text; return true; },
    createTextNode(text) { return { textContent: text }; },
  };
  const chrome = {
    runtime: {
      onMessage: { addListener(fn) { receiver = fn; } },
      async sendMessage(message) {
        events.push({ ...message, time: Date.now() });
        if (message.type === "response") responseResolve(message);
        return { received: true };
      },
    },
  };
  const selection = { removeAllRanges() {}, addRange() {} };
  vm.runInNewContext(original, {
    chrome, document: doc, window: { getSelection: () => selection },
    Event: class {}, InputEvent: class {},
    setTimeout, clearTimeout, console, HTMLTextAreaElement: class {},
  });
  assert.equal(typeof receiver, "function");
  const history = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant", content: "原始信息" + i,
  }));
  const suffix = "开始" + "文".repeat(25000) + "结束";
  history.push({ role: "user", content: suffix });
  let ack;
  receiver({ type: "chat", requestId: "request-1", messages: history }, {}, x => { ack = x; });
  assert.deepEqual(JSON.parse(JSON.stringify(ack)), { accepted: true });
  const outcome = await Promise.race([
    response,
    new Promise((_, reject) => setTimeout(() => reject(Error("test completion timeout")), 4000)),
  ]);
  assert.equal(buttonClicked, true, JSON.stringify(outcome));
  for (let i = 0; i < 30; i++) assert.ok(composer.textContent.includes("原始信息" + i));
  assert.ok(composer.textContent.includes(suffix));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.content, "完整生成的回答，包括结尾。");
  assert.ok(events.some(x => x.type === "progress"));
  assert.ok(events.find(x => x.type === "response").time >= copyReadyTime);
});
