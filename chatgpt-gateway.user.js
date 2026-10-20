// ==UserScript==
// @name         ChatGPT 网页桥接 · 极简油猴版
// @namespace    https://github.com/lili13500/chatgpt-gateway
// @version      1.3.1
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

  const ENDPOINT = "http://127.0.0.1:18080";
  const clientId = crypto.randomUUID();
  const headers = { "X-ChatGPT-Gateway": "userscript-v1", "X-Gateway-Client": clientId };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let connection = null;
  let retryTimer = null;
  let current = null;
  let leaving = false;
  let statusText = "连接中";

  function showStatus(text) {
    statusText = text;
    console.info("[Local Gateway 1.3.1] " + text);
    const paint = () => {
      if (!document.body) return;
      let badge = document.getElementById("chatgpt-gateway-status");
      if (!badge) {
        badge = document.createElement("div");
        badge.id = "chatgpt-gateway-status";
        badge.setAttribute("role", "status");
        badge.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483000;padding:8px 12px;background:#fff;color:#222;border:1px solid #bbb;border-radius:8px;font:12px sans-serif;max-width:360px;pointer-events:none";
        document.body.appendChild(badge);
      }
      badge.textContent = "网页桥接 1.3.1：" + statusText;
    };
    if (document.body) paint();
    else document.addEventListener("DOMContentLoaded", paint, { once: true });
  }

  async function transmit(event) {
    if (!connection?.connected) throw Error("油猴与本地服务连接已断开");
    await new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ method: "POST", url: ENDPOINT + "/userscript/message",
        headers: { ...headers, "Content-Type": "application/json" },
        anonymous: true, data: JSON.stringify(event),
        onload: result => result.status === 200 ? resolve() :
          reject(Error("本地回传失败 HTTP " + result.status + ": " + result.responseText)),
        onerror: () => reject(Error("油猴无法回传到 127.0.0.1:18080")),
        onabort: () => reject(Error("本地回传已取消")),
      });
    });
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
    // Response action buttons can be siblings of the text inside this turn.
    const turn = el?.closest?.('article[data-testid^="conversation-turn-"]') || el?.closest?.("article") || el;
    return !!turn?.querySelector(
      '[data-testid="copy-turn-action-button"], button[aria-label="Copy"], ' +
      'button[aria-label="Copy response"], button[aria-label="复制"], button[data-testid="copy-button"]'
    );
  }

  async function newChatIfNeeded(requested) {
    if (!requested) return;
    const alreadyFresh = location.pathname === "/" &&
      !document.querySelector('[data-message-author-role="user"]');
    if (alreadyFresh) return;
    const button = document.querySelector(
      '[data-testid="create-new-chat-button"], button[aria-label="新聊天"], button[aria-label="New chat"]'
    ) || [...document.querySelectorAll("button")].find(el =>
      ["新聊天", "New chat"].includes((el.textContent || "").trim()));
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
          if (delta) await transmit({ type: "progress", requestId: job.requestId,
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
      showStatus("正在接收网页回答");
      const answer = await awaitAnswer(job, before);
      if (current === job) current = null;
      await transmit({ type: "response", requestId: job.requestId, ok: true, content: answer });
      showStatus("已连接，回答已完整回传");
    } catch (error) {
      const reason = String(error?.message || error);
      if (current === job) current = null;
      showStatus("失败：" + reason);
      if (connection?.connected) {
        await transmit({ type: "response", requestId: job.requestId, ok: false, error: reason })
          .catch(failure => showStatus("回传失败：" + failure.message));
      }
    } finally {
      if (current === job) current = null;
    }
  }

  function handlePacket(msg) {
    if (msg.type === "connected") {
      connection.connected = true;
      showStatus("已连接，可从山海墨迹发送消息");
    } else if (msg.type === "cancel" && current?.requestId === msg.requestId) {
      current.cancelled = true;
      document.querySelector('button[data-testid="stop-button"]')?.click();
    } else if (msg.type === "chat") {
      if (current) {
        void transmit({ type: "response", requestId: msg.requestId, ok: false,
          error: "专用标签页仍在处理上一条消息。" }).catch(error => showStatus(error.message));
      } else {
        showStatus("已收到应用请求");
        void runChat(msg);
      }
    }
  }

  function reconnect() {
    if (connection || leaving) return;
    const attempt = { connected: false, handle: null };
    connection = attempt;
    const lost = reason => {
      if (connection !== attempt) return;
      connection = null;
      if (current) current.cancelled = true;
      showStatus(reason);
      attempt.handle?.abort();
      if (!leaving) retryTimer = setTimeout(() => { retryTimer = null; reconnect(); }, 2500);
    };
    if (typeof GM_xmlhttpRequest !== "function") {
      connection = null;
      showStatus("油猴通信权限未注入；请确认脚本在 Tampermonkey 中运行。");
      return;
    }
    showStatus("正在连接本地服务");
    try {
      attempt.handle = GM_xmlhttpRequest({ method: "GET", url: ENDPOINT + "/userscript/events",
        headers, anonymous: true, responseType: "stream",
        onloadstart: async result => {
          if (connection !== attempt) return;
          // Tampermonkey fetch mode emits loadstart with status=0 before
          // response headers. The stream is valid; only a positive HTTP
          // failure status may reject it. The connected frame confirms readiness.
          if (result.status > 0 && result.status !== 200) {
            lost("连接失败：HTTP " + result.status); return;
          }
          try {
            const reader = result.response.getReader();
            const decoder = new TextDecoder("utf-8");
            let buffer = "";
            for (;;) {
              const { value, done } = await reader.read();
              if (connection !== attempt || done) break;
              buffer += typeof value === "string" ? value : decoder.decode(value, { stream: true });
              let end;
              while ((end = buffer.indexOf("\n\n")) !== -1) {
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                if (frame.startsWith("data: ")) handlePacket(JSON.parse(frame.slice(6)));
              }
            }
            lost("接收连接已关闭，正在重连");
          } catch (error) { lost("接收失败：" + error.message); }
        },
        onreadystatechange: result => {
          if (connection === attempt && result.readyState >= 2 &&
              result.status > 0 && result.status !== 200) {
            lost("连接失败：HTTP " + result.status);
          }
        },
        onerror: () => lost("油猴无法连接 127.0.0.1:18080；请检查本地服务或油猴授权。"),
        onabort: () => lost("接收连接已取消"),
      });
    } catch (error) { lost("连接失败：" + error.message); }
  }
  window.addEventListener("pagehide", () => {
    leaving = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (current) current.cancelled = true;
    connection?.handle?.abort();
  });
  reconnect();
})();
