#!/usr/bin/env node
/**
 * market-watch/ws-client.js v2
 * 最小化 WebSocket 客户端 — 连接 OKX 公共频道，订阅管理
 */

const { WebSocket } = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');
const CONFIG = require('./config.json');

let ws = null;
let pingTimer = null;
let messageHandler = null;
let subscriptions = new Set();
let _onClose = null;

function log(msg) {
  const ts = new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [WS] ${msg}`);
}

function connect() {
  return new Promise((resolve, reject) => {
    const agent = new HttpsProxyAgent(CONFIG.ws.proxy);

    ws = new WebSocket(CONFIG.ws.url, { agent });
    let settled = false;

    ws.on('open', () => {
      if (!settled) { settled = true; resolve(); }
      log('已连接');

      // 重订阅所有已注册的频道
      for (const key of subscriptions) {
        const [channel, instId] = key.split(':', 2);
        ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel, instId }] }));
        log(`重订阅: ${key}`);
      }

      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.ping();
      }, CONFIG.ws.pingIntervalMs);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.event) return;
        if (messageHandler) messageHandler(msg);
      } catch (_) {}
    });

    ws.on('close', (code, reason) => {
      log(`连接关闭 code=${code}`);
      clearInterval(pingTimer);
      ws = null;
      if (_onClose) _onClose();
    });

    ws.on('error', (err) => {
      if (!settled) { settled = true; reject(err); }
      else log(`错误: ${err.message}`);
    });
  });
}

function subscribe(channel, instId) {
  const key = `${channel}:${instId}`;
  if (subscriptions.has(key)) return;
  subscriptions.add(key);

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel, instId }] }));
    log(`订阅: ${key}`);
  }
}

function unsubscribe(channel, instId) {
  const key = `${channel}:${instId}`;
  subscriptions.delete(key);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ op: 'unsubscribe', args: [{ channel, instId }] }));
  }
}

function onMessage(handler) { messageHandler = handler; }
function onClose(handler) { _onClose = handler; }
function isConnected() { return ws && ws.readyState === WebSocket.OPEN; }
function getSubscriptionCount() { return subscriptions.size; }

function close() {
  clearInterval(pingTimer);
  if (ws) { ws.close(); ws = null; }
  subscriptions = new Set();
}

module.exports = { connect, subscribe, unsubscribe, onMessage, onClose, isConnected, getSubscriptionCount, close };
