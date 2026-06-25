#!/usr/bin/env node
/**
 * market-watch/engine.js v2
 * 市场观测器引擎 — 仅监控有持仓的币种 + alwaysWatch
 */

const path = require('path');
const fs = require('fs');
const CONFIG = require('./config.json');
const wsClient = require('./ws-client');
const store = require('./data-store');
const triggers = require('./triggers');
const dispatcher = require('./dispatcher');

const WORKSPACE = path.resolve(__dirname, '..', '..');
const ACTIVE_DIR = path.join(WORKSPACE, 'active');
const LOG_FILE = path.resolve(__dirname, CONFIG.log.file);

const logDir = path.dirname(LOG_FILE);
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

function log(msg, level) {
  level = level || 'INFO';
  const ts = new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  const line = '[' + ts + '] [MW] ' + msg;
  if (level === 'ERROR') console.error(line);
  else console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

// ═══ 周期扫描 — 只监控有持仓的币种 ═══

let lastScanCoins = new Set();

function scanActiveCycles() {
  if (!fs.existsSync(ACTIVE_DIR)) { log('active/ 目录不存在', 'WARN'); return; }

  const dirs = fs.readdirSync(ACTIVE_DIR);
  const coinPositions = {};

  for (const dir of dirs) {
    const m = dir.match(/^(alt|zhuang)-([A-Z0-9]+)-/);
    if (!m) continue;
    const coin = m[2];
    if (!coin) continue;
    const posFile = path.join(ACTIVE_DIR, dir, 'positions.json');
    let count = 0;
    if (fs.existsSync(posFile)) {
      try {
        const pos = JSON.parse(fs.readFileSync(posFile, 'utf8'));
        const positions = pos['当前持仓'] || pos['positions'] || [];
        count = pos['汇总']?.['当前持仓数'] || positions.length || 0;
      } catch (_) {}
    }
    if (count > 0) coinPositions[coin] = (coinPositions[coin] || 0) + count;
  }

  const currentWatched = new Set(CONFIG.scan.alwaysWatch || []);
  for (const coin of Object.keys(coinPositions)) currentWatched.add(coin);

  const posSummary = Object.entries(coinPositions).map(function(e) { return e[0] + '(' + e[1] + ')'; }).join(',') || '无持仓';
  log('扫描 | 持仓: ' + posSummary + ' | 监控: ' + [...currentWatched].join(','));

  for (const coin of currentWatched) {
    if (!lastScanCoins.has(coin)) {
      log(coin + ' 持仓中 → 开始监控');
      registerCoin(coin);
    }
  }

  for (const coin of lastScanCoins) {
    if (!currentWatched.has(coin) && !CONFIG.scan.alwaysWatch.includes(coin)) {
      log(coin + ' 不再持仓 → 停止监控');
      unregisterCoin(coin);
    }
  }

  lastScanCoins = currentWatched;
  log('扫描完成: ' + store.getWatchedCount() + ' coins | ' + wsClient.getSubscriptionCount() + ' subs');
}

// ═══ 币种生命周期 ═══

function registerCoin(coin) {
  if (store.get(coin)) return;
  store.initCoin(coin, { cycleId: null, positionCount: 0 });
  wsClient.subscribe('tickers', coin + '-USDT-SWAP');
  wsClient.subscribe('open-interest', coin + '-USDT-SWAP');
  wsClient.subscribe('funding-rate', coin + '-USDT-SWAP');
  log(coin + ' 已注册 | ' + wsClient.getSubscriptionCount() + ' subs');
}

function unregisterCoin(coin) {
  store.remove(coin);
  wsClient.unsubscribe('tickers', coin + '-USDT-SWAP');
  wsClient.unsubscribe('open-interest', coin + '-USDT-SWAP');
  wsClient.unsubscribe('funding-rate', coin + '-USDT-SWAP');
  log(coin + ' 已注销');
}

// ═══ WS 数据处理 ═══

function handleWSMessage(msg) {
  if (!msg.arg || !msg.data || !msg.data.length) return;

  const channel = msg.arg.channel;
  const instId = msg.arg.instId;
  const coin = instId.replace(/-USDT-SWAP$/, '').replace(/-USD.*$/, '');
  if (!store.get(coin)) return;

  try {
    if (channel === 'tickers') {
      const d = msg.data[0];
      store.updateTicker(coin, {
        price: parseFloat(d.last),
        high24h: parseFloat(d.high24h),
        low24h: parseFloat(d.low24h),
        volume24h: parseFloat(d.volCcy24h),
      });
      if (!store.isReady(coin)) {
        store.setBaseline(coin);
        log(coin + ' 基线已设定 | ' + d.last);
      }
    }

    if (channel === 'open-interest') {
      const d = msg.data[0];
      store.update(coin, 'oi', parseFloat(d.oi), parseInt(d.ts));
    }

    if (channel === 'funding-rate') {
      const d = msg.data[0];
      store.update(coin, 'fundingRate', parseFloat(d.fundingRate), parseInt(d.ts));
      store.update(coin, 'nextFundingRate', parseFloat(d.nextFundingRate), parseInt(d.ts));
    }

    if (store.isReady(coin)) {
      const entry = store.get(coin);
      const hits = triggers.check(coin, entry);

      if (hits.length > 0) {
        for (const hit of hits) {
          if (hit.type === 'price') entry.lastTriggered.price = Date.now();
          if (hit.type === 'oi') entry.lastTriggered.oi = Date.now();
          if (hit.type === 'funding') entry.lastTriggered.funding = Date.now();
        }
        store.setBaseline(coin);
        dispatcher.dispatch(coin, hits, entry);
      }
    }
  } catch (e) {
    log(coin + ' 数据处理错误: ' + e.message, 'ERROR');
  }
}

// ═══ 主入口 ═══

async function main() {
  log('══════ 市场观测器启动 ══════');
  log('阈值: price\u0394\u2265' + CONFIG.thresholds.default.priceDeltaPct + '% | oi\u0394\u2265' + CONFIG.thresholds.default.oiDeltaPct + '% | fr\u0394\u2265' + CONFIG.thresholds.default.fundingRateDelta + ' | 冷却' + (CONFIG.thresholds.default.cooldownMs / 60000) + 'min');
  log('策略: 仅监控有持仓的币种 + alwaysWatch');

  scanActiveCycles();

  wsClient.onMessage(handleWSMessage);
  wsClient.onClose(function() {
    log('WS 断开，5s 后重连...', 'WARN');
    setTimeout(async function() {
      try { await wsClient.connect(); log('WS 重连成功'); }
      catch (e) { log('WS 重连失败: ' + e.message, 'ERROR'); }
    }, 5000);
  });

  try {
    await wsClient.connect();
    log('WS 已连接');
  } catch (e) {
    log('WS 连接失败: ' + e.message, 'ERROR');
  }

  const scanTimer = setInterval(scanActiveCycles, CONFIG.scan.intervalMs);
  log('扫描器已启动 (' + (CONFIG.scan.intervalMs / 1000) + 's)');

  const reportTimer = setInterval(function() {
    const coins = store.getWatchedCoins();
    if (coins.length === 0) return;
    const now = Date.now();
    const lines = [];
    for (const coin of coins.sort()) {
      const s = store.get(coin);
      if (!s) continue;
      const watchMin = Math.floor((now - s.meta.watchedSince) / 60000);
      const ready = s.baseline ? '✅' : '⏳';
      const price = s.current?.price?.toFixed(6) || '-';
      const oi = s.current?.oi?.toFixed(0) || '-';
      const ltc = s.lastTriggered;
      const lastTrig = (ltc.price || ltc.oi || ltc.funding)
        ? ' 上次触发: ' + Math.floor((now - Math.max(ltc.price, ltc.oi, ltc.funding)) / 60000) + 'min前' : '';
      lines.push(ready + ' ' + coin.padEnd(8) + ' ' + watchMin + 'min | $' + price + ' oi=' + oi + lastTrig);
    }
    log('状态报告 (' + coins.length + ' coins, ' + wsClient.getSubscriptionCount() + ' subs):\n' + lines.join('\n'));
  }, 5 * 60 * 1000);

  process.on('SIGINT', function() {
    log('收到 SIGINT，关闭...');
    clearInterval(scanTimer);
    clearInterval(reportTimer);
    wsClient.close();
    log('已关闭');
    process.exit(0);
  });

  process.on('SIGTERM', function() {
    log('收到 SIGTERM，关闭...');
    clearInterval(scanTimer);
    clearInterval(reportTimer);
    wsClient.close();
    log('已关闭');
    process.exit(0);
  });

  process.stdin.resume();
}

main().catch(function(e) {
  log('致命错误: ' + e.message, 'ERROR');
  console.error(e);
  process.exit(1);
});
