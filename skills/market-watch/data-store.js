#!/usr/bin/env node
/**
 * market-watch/data-store.js
 *
 * 内存数据存储 — 维护所有监控币种的 current 快照和 baseline 基线
 *
 * 数据流:
 *   ws push → store.update() → triggers.check()
 *   scanner → store.setBaseline() → 开始监控
 *   archived → store.remove() → 停止监控
 */

// ─── 内存存储 ───
//   { COIN: { baseline: {...}, current: {...}, lastTriggered: {...}, meta: {...} } }
const store = new Map();

// ─── 更新当前数据（WS 推送时调用） ───
function update(coin, field, value, ts) {
  if (!store.has(coin)) return null;

  const entry = store.get(coin);
  if (!entry.current) entry.current = {};
  entry.current[field] = value;
  entry.current[`${field}Ts`] = ts || Date.now();

  return entry;
}

// ─── 批量更新（ticker 推送时调用，包含 price + high/low/vol） ───
function updateTicker(coin, data) {
  if (!store.has(coin)) return null;
  const entry = store.get(coin);
  entry.current.price = data.price;
  entry.current.high24h = data.high24h;
  entry.current.low24h = data.low24h;
  entry.current.volume24h = data.volume24h;
  entry.current.tickerTs = Date.now();
  return entry;
}

// ─── 设置基线（开始监控或触发后重置） ───
function setBaseline(coin, fields = {}) {
  const entry = store.get(coin);
  if (!entry) return;

  entry.baseline = {
    price: fields.price ?? entry.current?.price,
    oi: fields.oi ?? entry.current?.oi,
    fundingRate: fields.fundingRate ?? entry.current?.fundingRate,
    setAt: Date.now(),
  };
}

// ─── 初始化监控一个币种 ───
function initCoin(coin, meta = {}) {
  if (store.has(coin)) return store.get(coin);

  const entry = {
    coin,
    baseline: null,
    current: {},
    lastTriggered: { price: 0, oi: 0, funding: 0 },
    meta: {
      cycleId: meta.cycleId || null,
      positionCount: meta.positionCount || 0,
      watchedSince: Date.now(),
    },
  };
  store.set(coin, entry);
  return entry;
}

// ─── 移除币种（周期归档时调用） ───
function remove(coin) {
  const existed = store.has(coin);
  store.delete(coin);
  return existed;
}

// ─── 获取币种状态 ───
function get(coin) {
  return store.get(coin) || null;
}

// ─── 获取所有监控的币种列表 ───
function getWatchedCoins() {
  return [...store.keys()];
}

// ─── 获取所有有基线的币种（已准备好触发检测） ───
function getReadyCoins() {
  const ready = [];
  for (const [coin, entry] of store) {
    if (entry.baseline) ready.push(coin);
  }
  return ready;
}

// ─── 判断基线是否已就绪 ───
function isReady(coin) {
  const entry = store.get(coin);
  return entry && entry.baseline !== null;
}

// ─── 获取监控数量 ───
function getWatchedCount() {
  return store.size;
}

// ─── 全部导出 ───
function exportState() {
  const state = {};
  for (const [coin, entry] of store) {
    state[coin] = {
      baseline: entry.baseline,
      current: entry.current,
      lastTriggered: entry.lastTriggered,
      meta: entry.meta,
    };
  }
  return state;
}

module.exports = {
  update,
  updateTicker,
  setBaseline,
  initCoin,
  remove,
  get,
  getWatchedCoins,
  getReadyCoins,
  isReady,
  getWatchedCount,
  exportState,
};
