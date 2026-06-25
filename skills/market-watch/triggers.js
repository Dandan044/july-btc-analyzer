#!/usr/bin/env node
/**
 * market-watch/triggers.js
 *
 * 触发检测 — 纯逻辑，对比 current vs baseline，判断是否触发
 */

const CONFIG = require('./config.json');

// ─── 获取币种的阈值配置（default + perCoin 覆盖） ───
function getThresholds(coin) {
  const base = CONFIG.thresholds.default;
  const overrides = (CONFIG.thresholds.perCoin || {})[coin] || {};
  return { ...base, ...overrides };
}

// ─── 格式化变动描述 ───
function fmtDelta(direction, deltaPct, field) {
  const dir = direction === 'up' ? '↑' : '↓';
  if (field === 'funding') {
    return `费率 ${dir} ${deltaPct.toFixed(4)}`;
  }
  return `${dir} ${deltaPct.toFixed(1)}%`;
}

/**
 * 执行触发检测
 * @param {string} coin - 币种
 * @param {object} state - store.get(coin) 返回的 entry
 * @returns {Array} 触发列表 [{ type, direction, deltaAbs, deltaPct, baseline, current, message }]
 */
function check(coin, state) {
  const triggers = [];
  if (!state || !state.baseline || !state.current) return triggers;

  const now = Date.now();
  const cfg = getThresholds(coin);

  // ─── 1. 价格偏离 ───
  if (typeof state.current.price === 'number' && typeof state.baseline.price === 'number' && state.baseline.price > 0) {
    const deltaAbs = state.current.price - state.baseline.price;
    const deltaPct = Math.abs(deltaAbs) / state.baseline.price * 100;
    const direction = deltaAbs >= 0 ? 'up' : 'down';

    if (deltaPct >= cfg.priceDeltaPct && (now - state.lastTriggered.price) > cfg.cooldownMs) {
      triggers.push({
        type: 'price',
        direction,
        deltaAbs: parseFloat(deltaAbs.toFixed(6)),
        deltaPct: parseFloat(deltaPct.toFixed(2)),
        baseline: state.baseline.price,
        current: state.current.price,
        message: `${coin} 价格 ${fmtDelta(direction, deltaPct)} 变动 ${deltaPct.toFixed(1)}% (基线: ${state.baseline.price} → 当前: ${state.current.price})`,
      });
    }
  }

  // ─── 2. OI 偏离 ───
  if (typeof state.current.oi === 'number' && typeof state.baseline.oi === 'number' && state.baseline.oi > 0) {
    const deltaAbs = state.current.oi - state.baseline.oi;
    const deltaPct = Math.abs(deltaAbs) / state.baseline.oi * 100;
    const direction = deltaAbs >= 0 ? 'up' : 'down';

    if (deltaPct >= cfg.oiDeltaPct && (now - state.lastTriggered.oi) > cfg.cooldownMs) {
      triggers.push({
        type: 'oi',
        direction,
        deltaAbs: parseFloat(deltaAbs.toFixed(0)),
        deltaPct: parseFloat(deltaPct.toFixed(2)),
        baseline: state.baseline.oi,
        current: state.current.oi,
        message: `${coin} OI ${fmtDelta(direction, deltaPct, 'oi')} 变动 ${deltaPct.toFixed(1)}% (基线: ${state.baseline.oi.toFixed(0)} → 当前: ${state.current.oi.toFixed(0)})`,
      });
    }
  }

  // ─── 3. 资金费率突变 ───
  if (typeof state.current.fundingRate === 'number' && typeof state.baseline.fundingRate === 'number') {
    const deltaAbs = Math.abs(state.current.fundingRate - state.baseline.fundingRate);

    if (deltaAbs >= cfg.fundingRateDelta && (now - state.lastTriggered.funding) > cfg.cooldownMs) {
      triggers.push({
        type: 'funding',
        direction: state.current.fundingRate >= state.baseline.fundingRate ? 'up' : 'down',
        deltaAbs: parseFloat(deltaAbs.toFixed(6)),
        deltaPct: null,
        baseline: state.baseline.fundingRate,
        current: state.current.fundingRate,
        message: `${coin} 资金费率 ${fmtDelta(state.current.fundingRate >= state.baseline.fundingRate ? 'up' : 'down', deltaAbs * 100, 'funding')}% (基线: ${(state.baseline.fundingRate * 100).toFixed(4)}% → 当前: ${(state.current.fundingRate * 100).toFixed(4)}%)`,
      });
    }
  }

  return triggers;
}

module.exports = { check, getThresholds };
