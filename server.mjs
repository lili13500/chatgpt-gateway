// Local OpenAI-compatible relay for the ChatGPT *web page*, not the OpenAI API.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { WebSocketServer } from "ws";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 18080);
const wss = new WebSocketServer({ noServer: true, maxPayload: 0 });
const pending = new Map();
const queue = [];
let extension = null;
let activeId = null;

const json = (res, status, value) => {
  if (res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
};
const sse = (res, value) => {
  if (!res.writableEnded && !res.destroyed) res.write("data: " + JSON.stringify(value) + "\n\n");
};
const chunk = (entry, content, done = false) => ({
  id: "chatcmpl-" + entry.id,
  object: "chat.completion.chunk",
  created: entry.created,
  model: entry.model,
  choices: [{
    index: 0,
    delta: done ? {} : { content },
    finish_reason: done ? "stop" : null,
  }],
});
const ready = () => extension?.readyState === 1;

function removeRequest(id, reason = "Client disconnected") {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearInterval(entry.keepalive);
  // The browser may already be generating. Do not replay it against a new tab.
  if (activeId === id) {
    extension?.send(JSON.stringify({ type: "cancel", requestId: id }));
    // Keep the lane owned until the extension acknowledges completion/cancel.
  }
  if (!entry.res.writableEnded && !entry.res.destroyed) json(entry.res, 499, { error: reason });
}

function fail(entry, reason) {
  if (entry.res.writableEnded || entry.res.destroyed) return;
  if (entry.stream) {
    // Never emit a fake finish_reason=stop for a broken or incomplete answer.
    entry.res.write("event: error\ndata: " + JSON.stringify({ error: reason }) + "\n\n");
    entry.res.end();
  } else {
    json(entry.res, 502, { error: { message: reason, type: "upstream_error" } });
  }
}

function finish(id, message) {
  const entry = pending.get(id);
  if (entry) {
    pending.delete(id);
    clearInterval(entry.keepalive);
    if (!message.ok) {
      fail(entry, String(message.error || "ChatGPT browser did not complete"));
    } else {
      const content = String(message.content ?? "");
      if (entry.stream) {
        if (!content.startsWith(entry.sent)) {
          fail(entry, "Browser revised earlier streamed text; incomplete stream not marked successful");
        } else {
          const tail = content.slice(entry.sent.length);
          if (tail) sse(entry.res, chunk(entry, tail));
          sse(entry.res, chunk(entry, "", true));
          if (!entry.res.writableEnded) entry.res.end("data: [DONE]\n\n");
        }
      } else {
        json(entry.res, 200, {
          id: "chatcmpl-" + id, object: "chat.completion",
          created: entry.created, model: entry.model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }
    }
  }
  if (activeId === id) {
    activeId = null;
    dispatchNext();
  }
}

function dispatchNext() {
  if (activeId || !ready()) return;
  while (queue.length) {
    const id = queue.shift();
    const entry = pending.get(id);
    if (!entry) continue;
    activeId = id;
    extension.send(JSON.stringify({
      type: "chat", requestId: id, model: entry.model,
      messages: entry.messages, newConversation: entry.newConversation,
    }), error => {
      if (error) finish(id, { ok: false, error: "Failed sending to browser: " + error.message });
    });
    break;
  }
}

function receive(msg) {
  if (typeof msg !== "object" || !msg || typeof msg.requestId !== "string") return;
  const entry = pending.get(msg.requestId);
  if (msg.type === "progress" && entry && activeId === msg.requestId) {
    if (typeof msg.delta === "string") {
      if (msg.offset !== entry.sent.length) {
        finish(msg.requestId, { ok: false, error: "Out-of-order browser stream chunk" });
        return;
      }
      entry.sent += msg.delta;
      if (entry.stream && msg.delta) sse(entry.res, chunk(entry, msg.delta));
    } else if (typeof msg.content === "string" && msg.content.startsWith(entry.sent)) {
      // Keep compatibility with existing extension clients.
      const diff = msg.content.slice(entry.sent.length);
      entry.sent = msg.content;
      if (entry.stream && diff) sse(entry.res, chunk(entry, diff));
    }
  } else if (msg.type === "response" && activeId === msg.requestId) {
    finish(msg.requestId, msg);
  }
}

wss.on("connection", ws => {
  if (extension && extension !== ws) {
    const previous = extension;
    extension = ws;
    previous.close();
    if (activeId) finish(activeId, { ok: false, error: "Browser extension reconnected; delivery unknown" });
  } else {
    extension = ws;
  }
  ws.on("message", raw => {
    let message;
    try { message = JSON.parse(raw.toString("utf8")); } catch { return; }
    if (extension === ws) receive(message);
  });
  ws.on("close", () => {
    if (extension !== ws) return;
    extension = null;
    if (activeId) finish(activeId, { ok: false, error: "Browser extension disconnected; delivery unknown" });
    for (const id of [...pending.keys()]) finish(id, { ok: false, error: "Browser extension disconnected" });
  });
  dispatchNext();
});

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const originAllowed = !origin || origin === "null" ||
    origin === "https://chatgpt.com" || origin === "https://chat.openai.com" ||
    /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin) ||
    /^(?:app|tauri|capacitor|file):\/\//.test(origin) ||
    /^(?:chrome|moz)-extension:\/\//.test(origin);
  if (origin && !originAllowed) return json(res, 403, { error: "Origin not allowed" });
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (req.method === "GET" && req.url === "/chatgpt-gateway.user.js") {
    const script = await readFile(new URL("./chatgpt-gateway.user.js", import.meta.url));
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(script);
  }
  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, { status: "ok", userscriptConnected: ready(), extensionConnected: ready(),
      pendingRequests: pending.size, queued: queue.filter(id => pending.has(id)).length,
      active: !!activeId, transport: "chatgpt-web-tampermonkey" });
  }
  if (req.method === "GET" && req.url === "/v1/models") {
    return json(res, 200, { object: "list", data: [{ id: "auto", object: "model", owned_by: "chatgpt-web" }] });
  }
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    return json(res, 404, { error: "Not found" });
  }
  if (!ready()) return json(res, 503, { error: { message: "ChatGPT 油猴脚本尚未连接（打开专用网页标签）。", type: "upstream_error" } });
  let payload;
  try {
    const parts = [];
    for await (const data of req) parts.push(data);
    payload = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!Array.isArray(payload.messages) || !payload.messages.some(m => m?.role === "user")) {
      return json(res, 400, { error: { message: "messages must include a user turn" } });
    }
  } catch {
    return json(res, 400, { error: { message: "Invalid request JSON" } });
  }

  const id = randomUUID();
  const entry = {
    id, res, created: Math.floor(Date.now() / 1000), messages: payload.messages,
    model: String(payload.model || "auto"), stream: payload.stream === true,
    newConversation: payload.new_conversation !== false, sent: "", keepalive: null,
  };
  if (entry.stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive", "X-Accel-Buffering": "no",
    });
    sse(res, { ...chunk(entry, ""), choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    // Transport keepalive, not a fabricated model token.
    entry.keepalive = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(": ping\n\n");
    }, 15000);
    entry.keepalive.unref?.();
  }
  pending.set(id, entry);
  // Request streams commonly close after their body is read; only response
  // closure indicates the client has abandoned the answer.
  res.on("close", () => { if (pending.has(id)) removeRequest(id); });
  queue.push(id);
  dispatchNext();
});

server.on("upgrade", (req, socket, head) => {
  const origin = req.headers.origin || "";
  const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(socket.remoteAddress);
  const browser = origin === "https://chatgpt.com" || origin === "https://chat.openai.com";
  if (!local || req.url !== "/ws" || !(browser || /^(?:chrome|moz)-extension:\/\//.test(origin))) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});
server.on("error", error => { console.error("[gateway]", error.message); process.exitCode = 1; });
server.listen(PORT, HOST, () => {
  console.log("[gateway] local port " + PORT + "; awaiting ChatGPT userscript");
});
