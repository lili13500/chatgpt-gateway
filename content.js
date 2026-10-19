// ChatGPT webpage text relay; runs only in a dedicated inactive extension tab.
(() => {
  "use strict";
  const sleep = ms => new Promise(done => setTimeout(done, ms));
  let current = null;

  function flattenContent(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map(item => {
      if (typeof item === "string") return item;
      if (item?.type === "text" && typeof item.text === "string") return item.text;
      throw Error("Non-text input is unsupported by this webpage bridge");
    }).join("\n");
    if (content == null) return "";
    throw Error("Unsupported message content: expected text");
  }
  function completePrompt(messages) {
    if (!Array.isArray(messages) || !messages.some(m => m?.role === "user"))
      throw Error("Missing user message");
    if (messages.length === 1 && messages[0].role === "user")
      return flattenContent(messages[0].content);
    return messages.map(m => {
      const role = { system: "System", developer: "Developer",
        user: "User", assistant: "Assistant", tool: "Tool" }[m.role] || m.role;
      return "[" + role + "]\n" + flattenContent(m.content);
    }).join("\n\n");
  }

  const findComposer = () => {
    for (const selector of ["#prompt-textarea", '[contenteditable="true"][data-testid="prompt-textarea"]',
      'div[contenteditable="true"]', "textarea"]) {
      const el = document.querySelector(selector);
      if (el && !el.disabled && el.getAttribute("aria-hidden") !== "true") return el;
    }
    return null;
  };
  function composerText(input) {
    return input.isContentEditable ? input.textContent || "" : input.value || "";
  }
  async function insertExact(text) {
    let input;
    for (let i = 0; i < 40; i++) {
      input = findComposer();
      if (input) break;
      await sleep(250);
    }
    if (!input) throw Error("ChatGPT input not available (check login)");
    input.focus();
    if (input.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("insertText", false, text);
      if (composerText(input) !== text) {
        input.replaceChildren(document.createTextNode(text));
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }
    } else {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (setter) setter.call(input, text); else input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (composerText(input) !== text) throw Error("Composer text mismatched; message NOT sent");
  }

  function sendButton() {
    for (const selector of ['[data-testid="send-button"]', "#composer-submit-button",
      'button[aria-label="Send prompt"]', 'button[aria-label*="Send"]']) {
      const el = document.querySelector(selector);
      if (el && !el.disabled) return el;
    }
    return null;
  }
  async function submit() {
    for (let i = 0; i < 40; i++) {
      const button = sendButton();
      if (button) { button.click(); return; }
      await sleep(200);
    }
    throw Error("ChatGPT send button not ready; request NOT sent");
  }

  const assistants = () => [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  function assistantText(el) {
    if (!el) return "";
    const content = el.querySelector(".markdown") || el.querySelector("[data-testid='assistant-response']") || el;
    return content.innerText ?? content.textContent ?? "";
  }
  const isGenerating = () => !!document.querySelector(
    'button[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label*="Stop generating"]'
  );
  function hasCompletionEvidence(el) {
    if (!el) return false;
    return !!el.querySelector(
      '[data-testid="copy-turn-action-button"], button[aria-label="Copy"], ' +
      'button[aria-label="Copy response"], button[data-testid="copy-button"]'
    );
  }
  async function emit(requestId, type, details) {
    try {
      await chrome.runtime.sendMessage({ type, requestId, ...details });
    } catch {
      // A stopped client is not proof that the model completed; the server
      // reports a transport failure and never commits a fake success.
    }
  }
  async function monitor(job, beforeCount) {
    let last = "", stable = 0, counter = 0;
    for (;;) {
      if (job.cancelled) throw Error("Request cancelled");
      await sleep(350);
      const nodes = assistants();
      const el = nodes.length > beforeCount ? nodes[nodes.length - 1] : null;
      const text = assistantText(el);
      if (text !== last) {
        last = text;
        stable = 0;
        if (el) await emit(job.requestId, "progress", { content: text });
      } else if (el && text) stable++;
      // Chrome extension service-worker stays active while the webpage is
      // thinking silently. Repeating an unchanged snapshot emits no SSE token.
      if (++counter % 55 === 0) await emit(job.requestId, "progress", { content: last });
      // A stable text span alone is NOT completion: ChatGPT may still be
      // thinking or streaming. Require its response action in this exact turn.
      if (el && !isGenerating() && stable >= 2 && hasCompletionEvidence(el)) {
        return assistantText(el);
      }
    }
  }
  async function start(msg) {
    const requestId = msg.requestId;
    const job = { requestId, cancelled: false };
    current = job;
    try {
      // The worker created a fresh, inactive browser tab; it cannot change
      // the user's current ChatGPT tab, model selection or draft.
      const before = assistants().length;
      const text = completePrompt(msg.messages);
      await insertExact(text);
      if (job.cancelled) throw Error("Cancelled before send");
      await submit();
      const final = await monitor(job, before);
      await emit(requestId, "response", { ok: true, content: final });
    } catch (error) {
      await emit(requestId, "response", { ok: false, error: String(error.message || error) });
    } finally {
      if (current === job) current = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg?.type === "ping") {
      respond({ ok: true, url: location.pathname });
      return false;
    }
    if (msg?.type === "cancel" && current?.requestId === msg.requestId) {
      current.cancelled = true;
      respond({ ok: true });
      return false;
    }
    if (msg?.type === "chat") {
      if (current) { respond({ accepted: false, error: "Tab already busy" }); return false; }
      // ACK immediately; long completion travels by independent messages.
      respond({ accepted: true });
      void start(msg);
      return false;
    }
    return false;
  });
})();
