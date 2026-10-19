// Chrome extension owns its own inactive ChatGPT tab. No CDP and no focus theft.
"use strict";
const GATEWAY_URL = "ws://127.0.0.1:18080/ws";
let ws = null;
let retry = null;
let active = null; // { requestId, tabId, cancelled }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function send(data) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function reconnect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try { ws = new WebSocket(GATEWAY_URL); } catch { schedule(); return; }
  ws.onopen = () => { if (retry) clearInterval(retry); retry = null; };
  ws.onmessage = event => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === "chat") startRequest(data);
    if (data.type === "cancel" && active?.requestId === data.requestId) {
      active.cancelled = true;
      chrome.tabs.sendMessage(active.tabId, { type: "cancel", requestId: data.requestId }).catch(() => {});
    }
  };
  ws.onclose = () => {
    ws = null;
    if (active) {
      active.cancelled = true;
      chrome.tabs.sendMessage(active.tabId, { type: "cancel", requestId: active.requestId }).catch(() => {});
    }
    schedule();
  };
  ws.onerror = () => ws?.close();
}
function schedule() {
  if (!retry) retry = setInterval(reconnect, 5000);
}
function emitError(requestId, error) {
  send({ type: "response", requestId, ok: false, error: String(error) });
}
async function dispose(job) {
  if (active === job) active = null;
  if (job?.tabId != null) await chrome.tabs.remove(job.tabId).catch(() => {});
}
async function startRequest(msg) {
  if (active) {
    emitError(msg.requestId, "Browser already has an active request");
    return;
  }
  const job = { requestId: msg.requestId, tabId: null, cancelled: false };
  active = job;
  try {
    // The gateway serializes requests. A disposable inactive tab prevents
    // accidental interaction with the user's normal ChatGPT chat.
    const tab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: false });
    job.tabId = tab.id;
    // New tabs inject content scripts after navigation. Wait for the receiver,
    // not for a made-up model-generation timeout.
    let delivered = false;
    let lastError = "Content script not ready";
    for (let attempt = 0; attempt < 60 && !job.cancelled; attempt++) {
      try {
        const reply = await chrome.tabs.sendMessage(job.tabId, {
          type: "chat", requestId: job.requestId,
          messages: msg.messages, model: msg.model,
          newConversation: msg.newConversation,
        });
        if (reply?.accepted) { delivered = true; break; }
        if (reply?.error) throw Error(reply.error);
      } catch (e) {
        lastError = String(e.message || e);
      }
      await sleep(500);
    }
    if (!delivered && !job.cancelled) {
      emitError(job.requestId, "ChatGPT page receiver unavailable: " + lastError);
      await dispose(job);
    }
    if (job.cancelled) await dispose(job);
  } catch (e) {
    emitError(job.requestId, e.message || e);
    await dispose(job);
  }
}

// The content script reports progress and completion independently.
// No hours-long chrome.tabs.sendMessage Promise or five-minute message port.
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if ((msg?.type !== "progress" && msg?.type !== "response") ||
      !active || msg.requestId !== active.requestId ||
      sender.tab?.id !== active.tabId) return false;
  if (!active.cancelled) send(msg);
  if (msg.type === "response") void dispose(active);
  respond({ received: true });
  return false;
});

reconnect();
chrome.runtime.onStartup.addListener(reconnect);
chrome.runtime.onInstalled.addListener(reconnect);
chrome.alarms.create("gatewayReconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "gatewayReconnect") reconnect();
});
// Chrome 116+ keeps an active extension worker alive with WebSocket traffic.
setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send('{"type":"heartbeat"}'); }, 20000);
