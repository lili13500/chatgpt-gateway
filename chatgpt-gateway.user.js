// ==UserScript==
// @name         ChatGPT 网页桥接 · 极简油猴版
// @namespace    https://github.com/lili13500/chatgpt-gateway
// @version      1.2.1
// @description  在专用 ChatGPT 网页标签中使用普通网页聊天，为本机写作工具回传回答。不调用 API/Codex。
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @noframes
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @sandbox      DOM
// @updateURL    https://raw.githubusercontent.com/lili13500/chatgpt-gateway/main/chatgpt-gateway.user.js
// @downloadURL  https://raw.githubusercontent.com/lili13500/chatgpt-gateway/main/chatgpt-gateway.user.js
// ==/UserScript==

(() => {
  "use strict";

  // Opt in ONE dedicated browser tab. Every other ChatGPT tab stays untouched.
  const key = "chatgpt-local-gateway-tab-v1";
  const url = new URL(location.href);
  const requested = url.searchParams.get("web_gateway") === "1" ||
    url.hash === "#web-gateway";
  let enabled = requested;
  try {
    if (requested) sessionStorage.setItem(key, "1");
    else enabled = sessionStorage.getItem(key) === "1";
  } catch (error) {
    // Still work when the user explicitly opens the dedicated URL, even if
    // the browser blocks sessionStorage in a sandbox.
    console.warn("[Local Gateway] Tab session state unavailable:", error);
  }
  if (!enabled || window.__chatgptLocalGateway) return;
  window.__chatgptLocalGateway = true;

  const ENDPOINT = "ws://127.0.0.1:18080/ws";
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let socket = null;
  let retryTimer = null;
  let current = null;

  function transmit(event) {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(event));
      return true;
    }
    return false;
  }

  function flattened(content) {
    if (typeof content === "string") return content;
    if (content == null) return "";
    if (Array.isArray(content)) {
      return content.map(part => {
        if (typeof part === "string") return part;
        if (part?.type === "text" && typeof part.text === "string") return part.text;
        throw Error("此网页桥接只支持文本内容，未支持图片等附件。");
      }).join("\n");
    }
    throw Error("请求的消息内容不是文本格式。");
  }

  function fullPrompt(messages) {
    if (!Array.isArray(messages) || !messages.some(m => m?.role === "user")) {
      throw Error("缺少用户消息");
    }
    if (messages.length === 1 && messages[0].role === "user") {
      return flattened(messages[0].content);
    }
    // No custom history length or byte cap. The webpage may impose its own.
    return messages.map(m => {
      const role = { system: "System", developer: "Developer", user: "User",
        assistant: "Assistant", tool: "Tool" }[m.role] || m.role;
      return "[" + role + "]\n" + flattened(m.content);
    }).join("\n\n");
  }

  const inputs = [
    "#prompt-textarea",
    '[contenteditable="true"][data-testid="prompt-textarea"]',
    'div[contenteditable="true"]',
    "textarea",
  ];
  function findInput() {
    for (const selector of inputs) {
      const field = document.querySelector(selector);
      if (field && !field.disabled && field.getAttribute("aria-hidden") !== "true") {
        return field;
      }
    }
    return null;
  }
  function getInputText(input) {
    return input.isContentEditable ? (input.textContent || "") : (input.value || "");
  }
  async function typeExact(text) {
    let input = null;
    for (let i = 0; i < 80; i++) {
      input = findInput();
      if (input) break;
      await sleep(250);
    }
    if (!input) throw Error("ChatGPT 未显示可用输入框；请检查网页登录状态。");
    if (getInputText(input).trim()) {
      throw Error("专用标签页已有草稿，未覆盖、未发送。");
    }
    input.focus();
    if (input.isContentEditable) {
      // Prefer real editor input; direct DOM assignment is only a fallback.
      document.execCommand("insertText", false, text);
      if (getInputText(input) !== text) {
        input.replaceChildren(document.createTextNode(text));
        input.dispatchEvent(new InputEvent("input", {
          bubbles: true, inputType: "insertText", data: text,
        }));
      }
    } else {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, "value"
      )?.set;
      if (setter) setter.call(input, text);
      else input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (getInputText(input) !== text) {
      throw Error("输入框内容不完整，已停止提交，避免截断上下文。");
    }
  }

  const sendSelectors = [
    '[data-testid="send-button"]', "#composer-submit-button",
    'button[aria-label="Send prompt"]', 'button[aria-label*="Send"]',
  ];
  function sendButton() {
    for (const selector of sendSelectors) {
      const el = document.querySelector(selector);
      if (el && !el.disabled) return el;
    }
    return null;
  }
  async function clickSend() {
    for (let i = 0; i < 60; i++) {
      const el = sendButton();
      if (el) { el.click(); return; }
      await sleep(250);
    }
    throw Error("ChatGPT 发送按钮不可用，消息未提交。");
  }

  const assistants = () => [...document.querySelectorAll(
    '[data-message-author-role="assistant"]'
  )];
  function assistantText(el) {
    if (!el) return "";
    const body = el.querySelector(".markdown") ||
      el.querySelector('[data-testid="assistant-response"]') || el;
    return body.innerText ?? body.textContent ?? "";
  }
  const generating = () => !!document.querySelector(
    'button[data-testid="stop-button"], button[aria-label="Stop streaming"], ' +
    'button[aria-label*="Stop generating"]'
  );
  function completed(el) {
    return !!el?.querySelector(
      '[data-testid="copy-turn-action-button"], button[aria-label="Copy"], ' +
      'button[aria-label="Copy response"], button[data-testid="copy-button"]'
    );
  }

  async function newChatIfNeeded(requested) {
    if (!requested) return;
    const alreadyFresh = location.pathname === "/" &&
      !document.querySelector('[data-message-author-role="user"]');
    if (alreadyFresh) return;
    const button = document.querySelector(
      '[data-testid="create-new-chat-button"], a[href="/"], nav a[href="/"]'
    );
    if (!button) throw Error("没有找到新建对话按钮；不会复用旧对话。");
    button.click();
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      const fresh = location.pathname === "/" &&
        !document.querySelector('[data-message-author-role="user"]');
      if (fresh && findInput()) return;
    }
    throw Error("ChatGPT 没有切换到新对话，消息未发送。");
  }

  async function awaitAnswer(job, before) {
    let last = "";
    let stable = 0;
    for (;;) {
      if (job.cancelled) throw Error("请求已取消或本地连接断开。");
      await sleep(350);
      const nodes = assistants();
      const message = nodes.length > before ? nodes[nodes.length - 1] : null;
      const text = assistantText(message);

      if (message && text !== last) {
        if (text.startsWith(last)) {
          const delta = text.slice(last.length);
          if (delta) transmit({ type: "progress", requestId: job.requestId,
            offset: last.length, delta });
        } else {
          // Progress is append-only; an in-place rewrite cannot be represented
          // faithfully in SSE. The server will reject a mismatching final answer.
          job.revised = true;
        }
        last = text;
        stable = 0;
      } else if (message && text) {
        stable++;
      }
      if (message && text && !generating() && stable >= 2 && completed(message)) {
        if (job.revised) throw Error("网页生成过程中修改了已流式发送的内容；拒绝把不一致的回答标记为完成。");
        return assistantText(message);
      }
    }
  }

  async function runChat(msg) {
    const job = { requestId: msg.requestId, cancelled: false, revised: false };
    current = job;
    try {
      await newChatIfNeeded(msg.newConversation !== false);
      if (job.cancelled) throw Error("请求在输入前取消。");
      const before = assistants().length;
      await typeExact(fullPrompt(msg.messages));
      if (job.cancelled) throw Error("请求在提交前取消。");
      await clickSend();
      const answer = await awaitAnswer(job, before);
      transmit({ type: "response", requestId: job.requestId, ok: true, content: answer });
    } catch (error) {
      transmit({ type: "response", requestId: job.requestId, ok: false,
        error: String(error?.message || error) });
    } finally {
      if (current === job) current = null;
    }
  }

  function reconnect() {
    if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
    try {
      socket = new WebSocket(ENDPOINT);
    } catch {
      schedule();
      return;
    }
    socket.onopen = () => {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      console.info("[Local Gateway] Tampermonkey connected to 127.0.0.1:18080");
    };
    socket.onmessage = event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === "cancel" && current?.requestId === msg.requestId) {
        current.cancelled = true;
        document.querySelector('button[data-testid="stop-button"]')?.click();
      } else if (msg.type === "chat") {
        if (current) {
          transmit({ type: "response", requestId: msg.requestId, ok: false,
            error: "专用 ChatGPT 标签页仍在处理上一个请求。" });
        } else {
          void runChat(msg);
        }
      }
    };
    socket.onclose = () => {
      socket = null;
      if (current) current.cancelled = true;
      schedule();
    };
    socket.onerror = () => socket?.close();
  }

  function schedule() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      reconnect();
    }, 2500);
  }
  // WebSocket traffic prevents a background tab from being silently closed by
  // some extension/service-worker suspend paths. Not simulated model tokens.
  setInterval(() => transmit({ type: "heartbeat" }), 20000);
  window.addEventListener("pagehide", () => { if (current) current.cancelled = true; });
  reconnect();
})();
