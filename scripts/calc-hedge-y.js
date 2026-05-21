#!/usr/bin/env node
/**
 * calc-hedge-y.js — BTC 开仓对冲系数计算
 *
 * 用法:
 *   node scripts/calc-hedge-y.js --direction long|short
 *
 * 逻辑:
 *   - 获取 OKX 实盘所有非 BTC 合约持仓
 *   - 计算多头/空头名义价值占比
 *   - 根据 BTC 开仓方向，取对手方占比计算对冲系数 y
 *
 *   y = 0.5 + opposing_ratio
 *
 *   BTC 做多 → opposing = 空头名义占比
 *   BTC 做空 → opposing = 多头名义占比
 *
 *   含义:
 *     y < 1: 账户已偏同一方向，缩减 BTC 仓位（不再加码同向）
 *     y = 1: 账户均衡，无调整
 *     y > 1: 账户偏反向，放大 BTC 仓位来对冲山寨敞口
 */

const { execSync } = require('child_process');
const path = require('path');

// ---- 配置 ----
const PROXY_SCRIPT = path.join(__dirname, 'okx-proxy.sh');
const PROFILE = 'live';
const PROXY_URL = 'http://127.0.0.1:7890';
const EXCLUDE_INST_ID = 'BTC-USDT-SWAP';

// ---- 参数 ----
const args = process.argv.slice(2);
let direction = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--direction' && i + 1 < args.length) {
    direction = args[i + 1].toLowerCase();
  }
}
if (!direction || !['long', 'short'].includes(direction)) {
  console.error('Usage: node calc-hedge-y.js --direction long|short');
  process.exit(1);
}

// ---- ctVal 缓存 ----
let _ctValMap = null;

/** 一次 API 调用获取所有 SWAP 合约 ctVal */
function loadCtValMap() {
  if (_ctValMap) return _ctValMap;
  _ctValMap = {};
  try {
    const url = 'https://www.okx.com/api/v5/public/instruments?instType=SWAP';
    const raw = execSync(
      `curl -s --max-time 20 --proxy "${PROXY_URL}" "${url}"`,
      { encoding: 'utf8', timeout: 25000, maxBuffer: 10 * 1024 * 1024 }
    );
    const data = JSON.parse(raw);
    if (data.data && Array.isArray(data.data)) {
      for (const inst of data.data) {
        if (inst.instId && inst.ctVal) {
          _ctValMap[inst.instId] = parseFloat(inst.ctVal) || 1;
        }
      }
    }
  } catch (e) {
    console.error(`[calc-hedge-y] 加载 ctVal 映射失败: ${e.message}`);
  }
  return _ctValMap;
}

/** 解析 okx CLI 表格输出 */
function parsePositionsTable(output) {
  const lines = output.split('\n');
  const results = [];
  let inData = false;

  for (const line of lines) {
    if (!line.trim() || line.startsWith('Environment:') || line.startsWith('Update')) continue;
    if (line.includes('---')) { inData = true; continue; }
    if (line.includes('instId') && line.includes('instType')) continue;
    if (!inData) continue;

    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;

    const instId = cols[0];
    const side = (cols[2] || '').toLowerCase();
    const pos = parseFloat(cols[3]) || 0;
    const avgPx = parseFloat(cols[4]) || 0;

    if (!instId.endsWith('-USDT-SWAP')) continue;
    if (Math.abs(pos) <= 0) continue;

    results.push({ instId, side, pos: Math.abs(pos), avgPx });
  }
  return results;
}

// ---- 主逻辑 ----
function main() {
  // 1. 加载 ctVal 映射（一次批量 API 调用）
  const ctValMap = loadCtValMap();

  // 2. 获取持仓
  let tableOutput;
  try {
    tableOutput = execSync(
      `${PROXY_SCRIPT} --profile ${PROFILE} account positions`,
      { encoding: 'utf8', timeout: 30000 }
    );
  } catch (err) {
    outputError(`持仓获取失败: ${err.message}`);
    return;
  }

  // 3. 解析
  const positions = parsePositionsTable(tableOutput);
  const altPositions = positions.filter(p => p.instId !== EXCLUDE_INST_ID);

  // 4. 无山寨 → 均衡
  if (altPositions.length === 0) {
    output(buildResult(0, 0, direction, 0, '无山寨币持仓'));
    return;
  }

  // 5. 计算名义价值
  let longNominal = 0, shortNominal = 0;
  for (const p of altPositions) {
    const ctVal = ctValMap[p.instId] || 1;
    const notional = p.pos * p.avgPx * ctVal;
    if (p.side === 'long') longNominal += notional;
    else if (p.side === 'short') shortNominal += notional;
  }

  const totalNominal = longNominal + shortNominal;
  if (totalNominal <= 0) {
    output(buildResult(0, 0, direction, altPositions.length, '名义价值为 0'));
    return;
  }

  // 6. 计算占比与 y
  const longRatio = longNominal / totalNominal;
  const shortRatio = shortNominal / totalNominal;
  const opposingRatio = (direction === 'long') ? shortRatio : longRatio;
  const y = 0.5 + opposingRatio;

  let hedgeAction = 'none';
  if (y > 1.05) hedgeAction = 'amplify';
  else if (y < 0.95) hedgeAction = 'reduce';

  output({
    direction,
    long_nominal: round2(longNominal),
    short_nominal: round2(shortNominal),
    total_nominal: round2(totalNominal),
    long_ratio: round3(longRatio),
    short_ratio: round3(shortRatio),
    opposing_ratio: round3(opposingRatio),
    y: round3(y),
    hedge_action: hedgeAction,
    position_count: altPositions.length
  });
}

function buildResult(longNom, shortNom, dir, count, note) {
  const total = longNom + shortNom;
  const lr = total > 0 ? longNom / total : 0.5;
  const sr = total > 0 ? shortNom / total : 0.5;
  const or = (dir === 'long') ? sr : lr;
  const y = 0.5 + or;
  return {
    direction: dir,
    long_nominal: round2(longNom),
    short_nominal: round2(shortNom),
    total_nominal: round2(total),
    long_ratio: round3(lr),
    short_ratio: round3(sr),
    opposing_ratio: round3(or),
    y: round3(y),
    hedge_action: y > 1.05 ? 'amplify' : (y < 0.95 ? 'reduce' : 'none'),
    position_count: count,
    note: note || undefined
  };
}

function output(data) { console.log(JSON.stringify(data, null, 2)); }
function outputError(reason) { output({ error: true, reason, direction, y: 1.0, note: '默认 y=1.0' }); }
function round2(v) { return Math.round(v * 100) / 100; }
function round3(v) { return Math.round(v * 1000) / 1000; }

main();
