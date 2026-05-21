#!/usr/bin/env node
/**
 * 山寨币合约市场数据获取 v2.0
 * 数据源: 
 *   - OKX CLI 工具 (K线、EMA均线、斐波那契、资金费率)
 *   - OKX API (多空比、Taker买卖比、持仓量)
 *   - 自算指标 (RSI(14) / MACD(12,26,9) / 布林带(20,2))
 * 
 * --coin 支持任意 OKX 上的 USDT 合约币种 (默认 BTC)
 * 
 * v2.0 相比 v1.0 的变化:
 *   - 全粒度(日/4H/1H/15min) 新增 RSI/MACD/布林带，用 50 根K线额外获取计算
 *   - 输出仍保持每粒度 14 根 K线，额外数据仅用于指标计算不写入
 *   - 保留: EMA 均线 / 斐波那契 / 清算数据 / 1H/15min
 * 
 * 用法: 
 *   node get_altcoin_analysis.js [--coin SOL] [--json] [--save] [--proxy http://127.0.0.1:7890]
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { execSync, exec } = require('child_process');

// ========== 配置 ==========

const PROXY_DEFAULT = 'http://127.0.0.1:7890';
const OKX_API_BASE = 'https://www.okx.com';
const OKX_PROXY_SCRIPT = path.resolve(__dirname, '../../../scripts/okx-proxy.sh');

// 多币种支持（通过 --coin 或 applyCoin() 切换）
let COIN = 'BTC';
let OKX_INST_ID_SWAP;
let OKX_INST_ID_SPOT;
let OKX_INDEX_INST_ID;
let DERIBIT_CURRENCY;

function applyCoin(coin) {
  COIN = coin.toUpperCase();
  OKX_INST_ID_SWAP = `${COIN}-USDT-SWAP`;
  OKX_INST_ID_SPOT = `${COIN}-USDT`;
  OKX_INDEX_INST_ID = `${COIN}-USD`;
  // Deribit 仅支持 BTC/ETH 期权
  DERIBIT_CURRENCY = (COIN === 'BTC' || COIN === 'ETH') ? COIN : null;
}
applyCoin('BTC');

// 根据币价动态决定小数位数
function priceDecimals(price) {
  if (price === null || price === undefined) return 2;
  const abs = Math.abs(price);
  if (abs >= 10000) return 2;    // BTC级别
  if (abs >= 100) return 3;      // SOL级别
  if (abs >= 1) return 5;        // 普通山寨币
  if (abs >= 0.01) return 7;     // 低价币
  if (abs >= 0.0001) return 9;   // 极小币
  if (abs >= 0.000001) return 11; // 微型币
  return 13;                     // 纳米币
}

// 动态价格格式化
function fmtPrice(val, refPrice = null) {
  if (val === null || val === undefined) return null;
  return parseFloat(val.toFixed(priceDecimals(refPrice ?? val)));
}

let activeDataSource = 'OKX CLI';

// ========== 工具函数 ==========

function toBeijingTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleString('en-CA', { 
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).replace(',', '');
}

function toBeijingDate(timestampMs) {
  const d = new Date(timestampMs);
  return d.toLocaleString('en-CA', { 
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

function toBeijingDatetime(timestampMs) {
  const d = new Date(timestampMs);
  return d.toLocaleString('en-CA', { 
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).replace(',', '');
}

/**
 * 调用 OKX CLI 工具（通过代理 wrapper）
 */
function okxCLI(args, proxy = null) {
  return new Promise((resolve, reject) => {
    let cmd;
    if (proxy && fs.existsSync(OKX_PROXY_SCRIPT)) {
      // 使用 wrapper 脚本
      cmd = `${OKX_PROXY_SCRIPT} ${args}`;
    } else if (proxy) {
      // 直接使用 proxychains
      cmd = `proxychains4 -q okx ${args}`;
    } else {
      cmd = `okx ${args}`;
    }
    
    exec(cmd, { maxBuffer: 50 * 1024 * 1024, timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`OKX CLI error: ${error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * 调用 OKX CLI 并解析 JSON 输出
 */
async function okxCLIJson(args, proxy = null) {
  const stdout = await okxCLI(`${args} --json`, proxy);
  try {
    const data = JSON.parse(stdout);
    // OKX CLI 返回的可能是：
    // 1. 直接数组 [...]
    // 2. 包装对象 { data: [...] }
    // 3. 复杂结构 [{ data: [...] }]
    if (Array.isArray(data)) {
      // 如果数组第一个元素有 data 字段，提取它
      if (data.length > 0 && data[0]?.data) {
        return data[0];
      }
      return data;
    }
    return data;
  } catch (e) {
    throw new Error(`JSON parse error: ${e.message}`);
  }
}

/**
 * 通过 curl 获取 OKX API 数据（用于非 CLI 支持的接口）
 */
async function getOKXData(endpoint, proxy) {
  if (!proxy) return null;
  
  return new Promise((resolve) => {
    const url = `${OKX_API_BASE}${endpoint}`;
    const cmd = `curl -s --max-time 30 -x ${proxy} '${url}'`;
    
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        console.error('OKX curl error:', error.message);
        resolve(null);
        return;
      }
      
      try {
        const json = JSON.parse(stdout);
        resolve(json);
      } catch (e) {
        console.error('OKX JSON parse error:', e.message);
        resolve(null);
      }
    });
  });
}

/**
 * 容错重试包装器 — OKX API 偶尔 429 限流，等 15 秒重试一次
 */
async function withRetry(fn, label, proxy) {
  try {
    return await fn(proxy);
  } catch (e) {
    if (e.message && (e.message.includes('429') || e.message.includes('rate') || e.message.includes('limit'))) {
      console.error(`${label} 限流 (429), 15秒后重试...`);
      await new Promise(r => setTimeout(r, 15000));
      try {
        return await fn(proxy);
      } catch (e2) {
        console.error(`${label} 重试失败:`, e2.message);
        return null;
      }
    }
    console.error(`${label} 错误:`, e.message);
    return null;
  }
}

/**
 * 无代理 fetch
 */
function fetch(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 
        'User-Agent': 'Mozilla/5.0', 
        'Accept': 'application/json'
      },
      timeout: 30000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); }
          catch (e) { resolve(data); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.end();
  });
}

// ========== 技术指标计算 ==========

/**
 * 简单 EMA 计算 — 全量对齐（前期不足返回 null）
 * @param {number[]} values - 价格数组，旧→新
 * @returns {number[]} 与输入对齐的 EMA 数组
 */
function calcEMA(values, period) {
  const result = new Array(values.length).fill(null);
  if (values.length < period) return result;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

/**
 * 兼容旧接口：返回最近 outputCount 个 EMA 值（新→旧）
 */
function calcEMASequence(values, period, outputCount) {
  const full = calcEMA(values, period);
  return full.filter(v => v !== null).reverse().slice(0, outputCount);
}

/**
 * 计算 RSI (Relative Strength Index，Wilder 平滑)
 * @param {number[]} closes - 收盘价数组，旧→新
 * @param {number} period - 周期（默认14）
 * @returns {number[]} 与输入对齐的 RSI 数组（前期不足返回 null）
 */
function calcRSI(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;

  const diffs = [];
  for (let i = 1; i < closes.length; i++) diffs.push(closes[i] - closes[i - 1]);

  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (diffs[i] > 0) avgGain += diffs[i]; else avgLoss += -diffs[i];
  }
  avgGain /= period;
  avgLoss /= period;
  result[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < closes.length; i++) {
    const gain = diffs[i - 1] > 0 ? diffs[i - 1] : 0;
    const loss = diffs[i - 1] < 0 ? -diffs[i - 1] : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return result;
}

/**
 * 计算 MACD (12/26/9)
 * @param {number[]} closes - 收盘价数组，旧→新
 * @returns {{macdLine: number[], signalLine: number[], histogram: number[]}}
 */
function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const nullArr = closes.map(() => null);
  if (closes.length < slow) return { macdLine: [...nullArr], signalLine: [...nullArr], histogram: [...nullArr] };

  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = closes.map(() => null);
  let firstValid = -1;
  for (let i = 0; i < closes.length; i++) {
    if (emaFast[i] !== null && emaSlow[i] !== null) {
      macdLine[i] = emaFast[i] - emaSlow[i];
      if (firstValid < 0) firstValid = i;
    }
  }
  if (firstValid < 0) return { macdLine: [...nullArr], signalLine: [...nullArr], histogram: [...nullArr] };

  const validMacd = macdLine.slice(firstValid).filter(v => v !== null);
  const sigEMA = calcEMA(validMacd, signal);
  const signalLine = closes.map(() => null);
  const histogram = closes.map(() => null);
  for (let i = 0, si = 0; i < closes.length; i++) {
    if (macdLine[i] !== null && si < sigEMA.length) {
      signalLine[i] = sigEMA[si];
      if (signalLine[i] !== null) histogram[i] = macdLine[i] - signalLine[i];
      si++;
    }
  }
  return { macdLine, signalLine, histogram };
}

/**
 * 计算布林带 (Bollinger Bands, SMA 20, ±2σ)
 * @param {number[]} closes - 收盘价数组，旧→新
 * @returns {{upper: number[], middle: number[], lower: number[], bandwidth: number[]}}
 */
function calcBollingerBands(closes, period = 20, multiplier = 2) {
  const nullArr = closes.map(() => null);
  if (closes.length < period) return { upper: [...nullArr], middle: [...nullArr], lower: [...nullArr], bandwidth: [...nullArr] };
  const upper = closes.map(() => null), middle = closes.map(() => null);
  const lower = closes.map(() => null), bandwidth = closes.map(() => null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const sma = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, v) => sum + (v - sma) ** 2, 0) / period;
    const stddev = Math.sqrt(variance);
    middle[i] = sma;
    upper[i] = sma + multiplier * stddev;
    lower[i] = sma - multiplier * stddev;
    bandwidth[i] = ((upper[i] - lower[i]) / sma) * 100;
  }
  return { upper, middle, lower, bandwidth };
}

/**
 * 将全量指标计算结果附加到输出蜡烛数组（新→旧）
 * indicators 数组是旧→新，candles 是新→旧
 */
function attachIndicators(candles, indicators, refPrice = null) {
  const len = indicators.rsi.length;
  for (let i = 0; i < candles.length; i++) {
    const idx = len - 1 - i;  // candles[0 最新] ↔ indicators[last]
    if (idx < 0) break;
    if (indicators.rsi[idx] !== null) candles[i].rsi = parseFloat(indicators.rsi[idx].toFixed(1));
    if (indicators.macdLine[idx] !== null) candles[i].macdLine = fmtPrice(indicators.macdLine[idx], refPrice);
    if (indicators.signalLine[idx] !== null) candles[i].macdSignal = fmtPrice(indicators.signalLine[idx], refPrice);
    if (indicators.histogram[idx] !== null) candles[i].macdHistogram = fmtPrice(indicators.histogram[idx], refPrice);
    if (indicators.bbUpper[idx] !== null) candles[i].bollingerUpper = fmtPrice(indicators.bbUpper[idx], refPrice);
    if (indicators.bbMiddle[idx] !== null) candles[i].bollingerMiddle = fmtPrice(indicators.bbMiddle[idx], refPrice);
    if (indicators.bbLower[idx] !== null) candles[i].bollingerLower = fmtPrice(indicators.bbLower[idx], refPrice);
    if (indicators.bbBandwidth[idx] !== null) candles[i].bollingerBandwidth = parseFloat(indicators.bbBandwidth[idx].toFixed(2));
  }
}


/**
 * 获取清算数据（OKX API，翻页回溯2-3天）
 * 返回清算热力图：按价格区间统计多空清算分布
 */
async function getLiquidationData(proxy, currentPrice = 80000) {
  if (!proxy) return null;
  
  // 根据币价动态设定分档间隔（约 0.5%-1% 价格区间）
  const absPrice = Math.abs(currentPrice);
  let PRICE_BIN;
  if (absPrice >= 10000) PRICE_BIN = 500;
  else if (absPrice >= 1000) PRICE_BIN = 50;
  else if (absPrice >= 100) PRICE_BIN = 5;
  else if (absPrice >= 10) PRICE_BIN = 1;
  else if (absPrice >= 1) PRICE_BIN = 0.5;
  else if (absPrice >= 0.01) PRICE_BIN = 0.01;
  else if (absPrice >= 0.0001) PRICE_BIN = 0.0001;
  else PRICE_BIN = 0.000001;
  
  const MAX_PAGES = 3;    // 最多翻3页，覆盖2-3天
  const allDetails = [];
  let before = null;
  
  for (let page = 0; page < MAX_PAGES; page++) {
    const beforeParam = before ? `&before=${before}` : '';
    const url = `${OKX_API_BASE}/api/v5/public/liquidation-orders?instFamily=${COIN}-USDT&instType=SWAP&state=filled&limit=100${beforeParam}`;
    
    const pageResult = await new Promise((resolve) => {
      const cmd = `curl -s --max-time 30 -x ${proxy} '${url}'`;
      exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
        if (error) { resolve(null); return; }
        try {
          const json = JSON.parse(stdout);
          if (json.code === '0' && json.data?.[0]?.details) {
            resolve(json.data[0].details);
          } else {
            resolve(null);
          }
        } catch (e) { resolve(null); }
      });
    });
    
    if (!pageResult || pageResult.length === 0) break;
    allDetails.push(...pageResult);
    before = Math.min(...pageResult.map(d => parseInt(d.time)));
  }
  
  if (allDetails.length === 0) return null;
  
  // 基础统计
  let longLiq = 0, shortLiq = 0;
  for (const d of allDetails) {
    const sz = parseFloat(d.sz);
    if (d.posSide === 'long') longLiq += sz;
    else shortLiq += sz;
  }
  
  // 按价格区间构建热力图
  const bins = {};
  for (const d of allDetails) {
    const px = Math.floor(parseFloat(d.bkPx) / PRICE_BIN) * PRICE_BIN;
    if (!bins[px]) bins[px] = { longCount: 0, shortCount: 0, longSz: 0, shortSz: 0 };
    const sz = parseFloat(d.sz);
    if (d.posSide === 'long') {
      bins[px].longCount++;
      bins[px].longSz += sz;
    } else {
      bins[px].shortCount++;
      bins[px].shortSz += sz;
    }
  }
  
  const heatmap = Object.entries(bins)
    .map(([priceStr, data]) => {
      const price = parseFloat(priceStr);
      const rangeEnd = parseFloat((price + PRICE_BIN).toFixed(10)); // 防浮点
      return {
        priceRange: `${price}-${rangeEnd}`,
        longCount: data.longCount,
        shortCount: data.shortCount,
        longSz: parseFloat(data.longSz.toFixed(1)),
        shortSz: parseFloat(data.shortSz.toFixed(1)),
        totalSz: parseFloat((data.longSz + data.shortSz).toFixed(1)),
        dominant: data.longSz > data.shortSz * 1.5 ? 'long' :
                  data.shortSz > data.longSz * 1.5 ? 'short' : 'mixed',
        settled: true
      };
    })
    .sort((a, b) => parseFloat(a.priceRange) - parseFloat(b.priceRange));
  
  // 关键区间
  const maxTotalZone = [...heatmap].sort((a, b) => b.totalSz - a.totalSz)[0];
  const maxLongZone = [...heatmap].sort((a, b) => b.longSz - a.longSz)[0];
  const maxShortZone = [...heatmap].sort((a, b) => b.shortSz - a.shortSz)[0];
  
  // 时间范围
  const allTimes = allDetails.map(d => parseInt(d.time));
  const tsMin = Math.min(...allTimes);
  const tsMax = Math.max(...allTimes);
  
  return {
    _disclaimer: "本数据仅包含已完成的强制平仓记录(state=filled)，是历史已爆仓数据，不是预估清算或待触发清算。不能用于判断某价位附近有多少杠杆仓位等待被清算。",
    count: allDetails.length,
    pages: MAX_PAGES,
    longLiquidation: parseFloat(longLiq.toFixed(2)),
    shortLiquidation: parseFloat(shortLiq.toFixed(2)),
    netLiquidation: parseFloat((longLiq - shortLiq).toFixed(2)),
    heatmap: heatmap,
    keyLevels: {
      maxTotal: maxTotalZone,
      maxLong: maxLongZone,
      maxShort: maxShortZone
    },
    timeRange: {
      start: tsMin,
      end: tsMax,
      spanHours: parseFloat(((tsMax - tsMin) / (1000 * 60 * 60)).toFixed(1))
    }
  };
}

// ========== K线数据获取 (OKX CLI) ==========

/**
 * 获取日线数据 (使用 OKX CLI)
 * 输出结构与原 getDailyDataOKX 完全一致
 * @param {string} proxy - 代理地址
 */
async function getDailyDataCLI(proxy) {
  const LIMIT_DISPLAY = 50;  // 输出50根日线（约2个月）
  const LIMIT_STATS = 100;  // 100根用于完整计算 RSI/MACD/BB，输出50根
  
  // 1. 获取 K线数据 (OKX CLI --json 直接返回数组)
  const klinesData = await okxCLIJson(`market candles ${OKX_INST_ID_SWAP} --bar 1D --limit ${LIMIT_STATS}`, proxy);
  
  // OKX CLI 返回的是数组，不是 { data: [...] }
  const klinesArray = Array.isArray(klinesData) ? klinesData : klinesData?.data;
  
  if (!klinesArray || klinesArray.length === 0) {
    throw new Error('无法获取日线K线数据');
  }
  
  // 2. 获取 24小时 ticker
  // OKX ticker API: vol24h 是合约张数，volCcy24h 是 BTC 单位
  // 交易量(USDT) = volCcy24h(BTC) * last(价格)
  const tickerData = await okxCLIJson(`market ticker ${OKX_INST_ID_SWAP}`, proxy);
  // tickerData 可能是数组或 { data: [...] }
  const tickerArr = Array.isArray(tickerData) ? tickerData : tickerData?.data;
  const volume24h = tickerArr?.[0]?.volCcy24h ? 
    parseFloat(tickerArr[0].volCcy24h) * parseFloat(tickerArr[0].last || 70000) : null;
  
  // 3. EMA 均线自算（全量 calcEMASequence 在下方统一计算）
  
  // 4. 获取资金费率历史（14天 × 3条/天 = 42条，取50条余量）
  const fundingDataHistory = await okxCLIJson(`market funding-rate ${OKX_INST_ID_SWAP} --history --limit 50`, proxy).catch(() => null);
  
  // 4.1 获取当前资金费率（含 premium 字段）
  const fundingDataCurrent = await okxCLIJson(`market funding-rate ${OKX_INST_ID_SWAP}`, proxy).catch(() => null);
  
  // 4.2 获取指数价格 K线（用于计算历史 Basis）
  const indexCandlesData = await okxCLIJson(`market index-candles ${OKX_INDEX_INST_ID} --bar 1D --limit ${LIMIT_STATS}`, proxy).catch(() => null);
  
  // 4.3 获取清算数据（24小时内）
  const currentPriceForLiq = parseFloat(tickerArr?.[0]?.last) || parseFloat(klinesArray[0]?.[4]) || 80000;
  const liquidationData = await getLiquidationData(proxy, currentPriceForLiq).catch(() => null);
  
  // 5. 获取交易侧数据 (OKX API，CLI 不支持)
  // 只用 1D 周期（当天数据为实时累计值，无需 1H 补丁）
  const [openInterest, longShortRatio1D, topTraderRatio1D, takerVolume1D] = await Promise.all([
    getOKXData(`/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${COIN}&period=1D`, proxy).catch(() => null),
    getOKXData(`/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${COIN}&period=1D`, proxy).catch(() => null),
    getOKXData(`/api/v5/rubik/stat/contracts/long-short-account-ratio-contract-top-trader?instId=${OKX_INST_ID_SWAP}&period=1D`, proxy).catch(() => null),
    getOKXData(`/api/v5/rubik/stat/taker-volume?instId=${OKX_INST_ID_SWAP}&instType=CONTRACTS&ccy=${COIN}&period=1D`, proxy).catch(() => null)
  ]);
  
  // 解析 K线数据 (OKX 格式: [ts, open, high, low, close, vol, volCcy, volCcyQuote, confirm])
  // volume 使用 USDT 为单位 (k[7] = volCcyQuote)，不再保留 BTC 为单位的交易量
  const allDataDesc = [];
  for (let i = 0; i < klinesArray.length; i++) {
    const k = klinesArray[i];
    const ts = parseInt(k[0]);
    allDataDesc.push({
      timestamp: ts,
      date: toBeijingDate(ts),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[7])  // USDT为单位的交易量
    });
  }
  
  // 交易量格式化函数（用于添加易读的单位）
  const formatVol = (val) => {
    if (!val) return null;
    if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
    if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
    if (val >= 1e3) return `$${(val / 1e3).toFixed(2)}K`;
    return `$${Number(val).toFixed(2)}`;
  };
  
  // 展示数据：取前14条
  const displayData = allDataDesc.slice(0, LIMIT_DISPLAY);
  const currentPrice = displayData[0]?.close || 0;
  
  // 全量数据（旧→新），用于指标计算
  const allDataAsc = [...allDataDesc].reverse();
  const closes = allDataAsc.map(d => d.close);

  // ═══ 技术指标计算（用全部100根K线）═══
  // EMA 均线（输出50根，新→旧）
  const ema7 = calcEMASequence(closes, 7, LIMIT_DISPLAY);
  const ema12 = calcEMASequence(closes, 12, LIMIT_DISPLAY);
  const ema20 = calcEMASequence(closes, 20, LIMIT_DISPLAY);
  const ema26 = calcEMASequence(closes, 26, LIMIT_DISPLAY);

  // RSI(14) / MACD(12,26,9) / 布林带(20,2) — 全量计算
  const dailyRSI = calcRSI(closes, 14);
  const dailyMACD = calcMACD(closes, 12, 26, 9);
  const dailyBB = calcBollingerBands(closes, 20, 2);

  // 构建历史数据
  const history = displayData.map((d, i) => {
    const entry = {
      date: d.date,
      timestamp: d.timestamp,
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      volume: i === 0 ? null : d.volume,
      volumeFormatted: i === 0 ? null : formatVol(d.volume)
    };
    if (i < ema7.length) entry.ema7 = fmtPrice(ema7[i], currentPrice);
    if (i < ema12.length) entry.ema12 = fmtPrice(ema12[i], currentPrice);
    if (i < ema20.length) entry.ema20 = fmtPrice(ema20[i], currentPrice);
    if (i < ema26.length) entry.ema26 = fmtPrice(ema26[i], currentPrice);
    return entry;
  });

  // 附加 RSI/MACD/布林带到输出蜡烛
  attachIndicators(history, {
    rsi: dailyRSI,
    macdLine: dailyMACD.macdLine,
    signalLine: dailyMACD.signalLine,
    histogram: dailyMACD.histogram,
    bbUpper: dailyBB.upper,
    bbMiddle: dailyBB.middle,
    bbLower: dailyBB.lower,
    bbBandwidth: dailyBB.bandwidth
  }, currentPrice);

  // 按 timestamp 映射
  const tsMap = new Map(history.map((r, i) => [r.timestamp, i]));
  
  // 资金费率：压缩为数值数组格式，同时推算结算周期
  const fundingRateValues = [];
  let fundingPeriodH = 8; // 默认8h
  if (fundingDataHistory && Array.isArray(fundingDataHistory)) {
    const fundingItems = fundingDataHistory.slice(0, 21);  // 只保留7天×3-6条
    for (const item of fundingItems) {
      fundingRateValues.push(parseFloat(item.fundingRate));
    }
    // 从相邻时间戳推算结算间隔
    if (fundingItems.length >= 2) {
      const diffs = [];
      for (let i = 1; i < fundingItems.length; i++) {
        const diff = Math.abs(parseInt(fundingItems[i-1].fundingTime) - parseInt(fundingItems[i].fundingTime));
        if (diff > 0) diffs.push(diff);
      }
      if (diffs.length > 0) {
        fundingPeriodH = Math.round((diffs.reduce((a,b)=>a+b,0) / diffs.length) / (1000 * 3600));
      }
    }
  }
  
  // 提取当前 Premium Index（从当前资金费率数据）
  let premiumCurrent = null;
  const fundingArr = Array.isArray(fundingDataCurrent) ? fundingDataCurrent : fundingDataCurrent?.data;
  if (fundingArr && fundingArr[0] && fundingArr[0].premium) {
    premiumCurrent = parseFloat(fundingArr[0].premium);
  }
  
  // 计算历史 Basis：压缩为数值数组格式
  const indexCandlesArray = Array.isArray(indexCandlesData) ? indexCandlesData : indexCandlesData?.data;
  const basisValues = [];
  if (indexCandlesArray && indexCandlesArray.length > 0) {
    for (let i = 0; i < Math.min(7, displayData.length, indexCandlesArray.length); i++) {  // 只保留7天
      const swapK = displayData[i];
      const idxK = indexCandlesArray[i];
      
      const tsDiff = Math.abs(swapK.timestamp - parseInt(idxK[0]));
      if (tsDiff < 3600000) {
        const indexClose = parseFloat(idxK[4]);
        const swapClose = swapK.close;
        const basisPercent = indexClose > 0 ? (swapClose / indexClose - 1) * 100 : 0;
        basisValues.push(parseFloat(basisPercent.toFixed(4)));
      }
    }
  }
  
  // 处理持仓量
  if (openInterest?.data && Array.isArray(openInterest.data)) {
    for (const item of openInterest.data.slice(0, LIMIT_DISPLAY)) {
      const ts = parseInt(item[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined) {
        history[idx].openInterest = parseFloat(item[1]);
        history[idx].openInterestValue = parseFloat(item[1]) * history[idx].close;
      }
    }
  }
  
  // 处理多空比（统一用 1D，当天数据为实时累计值）
  if (longShortRatio1D?.data && Array.isArray(longShortRatio1D.data)) {
    for (const item of longShortRatio1D.data.slice(0, LIMIT_DISPLAY)) {
      const ts = parseInt(item[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined) {
        history[idx].longShortRatio = parseFloat(item[1]);
      }
    }
  }
  
  // 处理大户多空比（统一用 1D）
  if (topTraderRatio1D?.data && Array.isArray(topTraderRatio1D.data)) {
    for (const item of topTraderRatio1D.data.slice(0, LIMIT_DISPLAY)) {
      const ts = parseInt(item[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined) {
        history[idx].topTraderRatio = parseFloat(item[1]);
      }
    }
  }
  
  // 处理 Taker 买卖比（统一用 1D，只保留 ratio）
  if (takerVolume1D?.data && Array.isArray(takerVolume1D.data)) {
    for (const item of takerVolume1D.data.slice(0, LIMIT_DISPLAY)) {
      const ts = parseInt(item[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined) {
        const buyVol = parseFloat(item[1]);
        const sellVol = parseFloat(item[2]);
        history[idx].takerRatio = sellVol > 0 ? buyVol / sellVol : null;
      }
    }
  }
  
  // 计算统计（基于实际输出数量 LIMIT_DISPLAY=50）
  const pricesDisplay = displayData.map(d => d.close);
  const maxPriceDisplay = Math.max(...pricesDisplay);
  const minPriceDisplay = Math.min(...pricesDisplay);
  const avgPriceDisplay = pricesDisplay.reduce((a, b) => a + b, 0) / pricesDisplay.length;
  
  const volumesDisplay = displayData.slice(1).map(d => d.volume).filter(v => v);
  const maxVolumeDisplay = volumesDisplay.length > 0 ? Math.max(...volumesDisplay) : null;
  const minVolumeDisplay = volumesDisplay.length > 0 ? Math.min(...volumesDisplay) : null;
  const avgVolumeDisplay = volumesDisplay.length > 0 ? volumesDisplay.reduce((a, b) => a + b, 0) / volumesDisplay.length : null;
  
  const prices30d = allDataAsc.slice(-30).map(d => d.close);
  const maxPrice30d = Math.max(...prices30d);
  const minPrice30d = Math.min(...prices30d);
  const avgPrice30d = prices30d.reduce((a, b) => a + b, 0) / prices30d.length;
  
  const volumes30d = allDataAsc.slice(-30).slice(0, 29).map(d => d.volume).filter(v => v);
  const maxVolume30d = volumes30d.length > 0 ? Math.max(...volumes30d) : null;
  const minVolume30d = volumes30d.length > 0 ? Math.min(...volumes30d) : null;
  const avgVolume30d = volumes30d.length > 0 ? volumes30d.reduce((a, b) => a + b, 0) / volumes30d.length : null;
  
  return {
    history: history,
    current: currentPrice,
    volume24h: volume24h,
    volume24hFormatted: formatVol(volume24h),
    premiumCurrent: premiumCurrent,
    premiumNote: "Premium Index = 当前盘口合约价格相对于现货指数价格的偏离百分比，正值表示合约溢价，负值表示合约折价",
    fundingRate: fundingRateValues.length > 0 ? {
      values: fundingRateValues,
      period: `${fundingPeriodH}h`,
      count: fundingRateValues.length,
      spanDays: Math.floor(fundingRateValues.length * fundingPeriodH / 24),
      note: `资金费率每${fundingPeriodH}小时结算一次，正值表示多头付费给空头，负值表示空头付费给多头`
    } : null,
    basis: basisValues.length > 0 ? {
      values: basisValues,
      period: "1D",
      count: basisValues.length,
      spanDays: basisValues.length,
      note: "Basis = 合约收盘价与现货指数收盘价的偏离百分比，正值表示合约溢价，负值表示合约折价"
    } : null,
    liquidation: liquidationData,
    statistics: {
      days50: {
        price: {
          max: fmtPrice(maxPriceDisplay, currentPrice),
          min: fmtPrice(minPriceDisplay, currentPrice),
          avg: fmtPrice(avgPriceDisplay, currentPrice),
          rangePosition: parseFloat(((currentPrice - minPriceDisplay) / (maxPriceDisplay - minPriceDisplay) * 100).toFixed(1))
        },
        volume: {
          max: maxVolumeDisplay ? parseFloat(maxVolumeDisplay.toFixed(0)) : null,
          maxFormatted: formatVol(maxVolumeDisplay),
          min: minVolumeDisplay ? parseFloat(minVolumeDisplay.toFixed(0)) : null,
          minFormatted: formatVol(minVolumeDisplay),
          avg: avgVolumeDisplay ? parseFloat(avgVolumeDisplay.toFixed(0)) : null,
          avgFormatted: formatVol(avgVolumeDisplay),
          volumeRatio: (volume24h && avgVolumeDisplay) ? parseFloat((volume24h / avgVolumeDisplay).toFixed(2)) : null
        }
      },
      days30: {
        price: {
          max: fmtPrice(maxPrice30d, currentPrice),
          min: fmtPrice(minPrice30d, currentPrice),
          avg: fmtPrice(avgPrice30d, currentPrice),
          rangePosition: parseFloat(((currentPrice - minPrice30d) / (maxPrice30d - minPrice30d) * 100).toFixed(1))
        },
        volume: {
          max: maxVolume30d ? parseFloat(maxVolume30d.toFixed(0)) : null,
          maxFormatted: formatVol(maxVolume30d),
          min: minVolume30d ? parseFloat(minVolume30d.toFixed(0)) : null,
          minFormatted: formatVol(minVolume30d),
          avg: avgVolume30d ? parseFloat(avgVolume30d.toFixed(0)) : null,
          avgFormatted: formatVol(avgVolume30d),
          volumeRatio: (volume24h && avgVolume30d) ? parseFloat((volume24h / avgVolume30d).toFixed(2)) : null
        }
      }
    },
    indicators: {
      rsi14: history[0]?.rsi ?? null,
      macd: history[0]?.macdLine !== undefined ? {
        macdLine: history[0].macdLine,
        signal: history[0].macdSignal,
        histogram: history[0].macdHistogram
      } : null,
      bollinger: history[0]?.bollingerUpper !== undefined ? {
        upper: history[0].bollingerUpper,
        middle: history[0].bollingerMiddle,
        lower: history[0].bollingerLower,
        bandwidth: history[0].bollingerBandwidth,
        position: (history[0].close !== undefined && history[0].bollingerUpper !== undefined)
          ? parseFloat(((history[0].close - history[0].bollingerLower) / (history[0].bollingerUpper - history[0].bollingerLower) * 100).toFixed(1))
          : null
      } : null
    }
  };
}

/**
 * 获取4小时数据 (使用 OKX CLI)
 */
async function get4hDataCLI(proxy) {
  const LIMIT_OUTPUT = 14;
  const LIMIT_FETCH = 50;   // 额外获取用于完整指标计算
  
  const klinesData = await okxCLIJson(`market candles ${OKX_INST_ID_SWAP} --bar 4H --limit ${LIMIT_FETCH}`, proxy);
  
  // OKX CLI 返回的是数组，不是 { data: [...] }
  const klinesArray = Array.isArray(klinesData) ? klinesData : klinesData?.data;
  
  if (!klinesArray || klinesArray.length === 0) {
    return null;
  }
  
  // 并行获取其他数据
  const [openInterest, longShortRatio1H, topTraderRatio4H, takerVolume1H] = await Promise.all([
    getOKXData(`/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${COIN}&period=4H`, proxy).catch(() => null),
    getOKXData(`/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${COIN}&period=1H`, proxy).catch(() => null),
    getOKXData(`/api/v5/rubik/stat/contracts/long-short-account-ratio-contract-top-trader?instId=${OKX_INST_ID_SWAP}&period=4H`, proxy).catch(() => null),
    getOKXData(`/api/v5/rubik/stat/taker-volume?instId=${OKX_INST_ID_SWAP}&instType=CONTRACTS&ccy=${COIN}&period=1H`, proxy).catch(() => null)
  ]);
  
  // 交易量格式化函数
  const formatVol = (val) => {
    if (!val) return null;
    if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
    if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
    if (val >= 1e3) return `$${(val / 1e3).toFixed(2)}K`;
    return `$${val.toFixed(0)}`;
  };
  
  // 构建全量蜡烛数据（新→旧）
  const allResult = [];
  for (let i = 0; i < klinesArray.length; i++) {
    const k = klinesArray[i];
    const ts = parseInt(k[0]);
    const vol = parseFloat(k[7]);
    allResult.push({
      time: toBeijingDatetime(ts),
      timestamp: ts,
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: vol,
      volumeFormatted: formatVol(vol)
    });
  }

  // 计算技术指标（用全部50根K线）
  const closesAsc = [...allResult].reverse().map(r => r.close);
  const h4RSI = calcRSI(closesAsc, 14);
  const h4MACD = calcMACD(closesAsc, 12, 26, 9);
  const h4BB = calcBollingerBands(closesAsc, 20, 2);
  const refPrice = allResult[0]?.close || 0;

  // 只取前14根输出
  const result = allResult.slice(0, LIMIT_OUTPUT);
  attachIndicators(result, {
    rsi: h4RSI,
    macdLine: h4MACD.macdLine,
    signalLine: h4MACD.signalLine,
    histogram: h4MACD.histogram,
    bbUpper: h4BB.upper,
    bbMiddle: h4BB.middle,
    bbLower: h4BB.lower,
    bbBandwidth: h4BB.bandwidth
  }, refPrice);

  const tsMap = new Map(result.map((r, i) => [r.timestamp, i]));
  
  // 持仓量
  if (openInterest?.data && Array.isArray(openInterest.data)) {
    for (const item of openInterest.data.slice(0, LIMIT_OUTPUT)) {
      const ts = parseInt(item[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined) {
        result[idx].openInterest = parseFloat(item[1]);
        result[idx].openInterestValue = parseFloat(item[1]) * result[idx].close;
      }
    }
  }
  
  // 多空比 (API只支持 1H，用 1H 数据匹配 4H K线的时间戳)
  if (longShortRatio1H?.data && Array.isArray(longShortRatio1H.data)) {
    for (const item of longShortRatio1H.data.slice(0, LIMIT_OUTPUT * 4)) {
      const ts = parseInt(item[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined) {
        result[idx].longShortRatio = parseFloat(item[1]);
      }
    }
  }
  
  // 大户多空比 (API支持 4H)
  if (topTraderRatio4H?.data && Array.isArray(topTraderRatio4H.data)) {
    for (const item of topTraderRatio4H.data.slice(0, LIMIT_OUTPUT)) {
      const ts = parseInt(item[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined) {
        result[idx].topTraderRatio = parseFloat(item[1]);
      }
    }
  }
  
  // Taker 买卖比 (API只支持 1H，用 1H 数据匹配 4H K线的时间戳，只保留ratio)
  if (takerVolume1H?.data && Array.isArray(takerVolume1H.data)) {
    for (const item of takerVolume1H.data.slice(0, LIMIT_OUTPUT * 4)) {
      const ts = parseInt(item[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined) {
        const buyVol = parseFloat(item[1]);
        const sellVol = parseFloat(item[2]);
        result[idx].takerRatio = sellVol > 0 ? buyVol / sellVol : null;
      }
    }
  }
  
  return result;
}

// ========== 1H K线数据 (OKX CLI) ==========

async function get1hDataCLI(proxy) {
  const LIMIT_OUTPUT = 14;
  const LIMIT_FETCH = 50;
  
  const klinesData = await okxCLIJson(`market candles ${OKX_INST_ID_SWAP} --bar 1H --limit ${LIMIT_FETCH}`, proxy);
  const klinesArray = Array.isArray(klinesData) ? klinesData : klinesData?.data;
  
  if (!klinesArray || klinesArray.length === 0) {
    return null;
  }
  
  const [openInterest, longShortRatio, takerVolume] = await Promise.all([
    getOKXData(`/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${COIN}&period=1H`, proxy).catch(() => null),
    getOKXData(`/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${COIN}&period=1H`, proxy).catch(() => null),
    getOKXData(`/api/v5/rubik/stat/taker-volume?instId=${OKX_INST_ID_SWAP}&instType=CONTRACTS&ccy=${COIN}&period=1H`, proxy).catch(() => null)
  ]);
  
  const formatVol = (val) => {
    if (!val) return null;
    if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
    if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
    if (val >= 1e3) return `$${(val / 1e3).toFixed(2)}K`;
    return `$${val.toFixed(0)}`;
  };
  
  // 构建全量蜡烛（新→旧）
  const allResult = [];
  for (let i = 0; i < klinesArray.length; i++) {
    const k = klinesArray[i];
    const ts = parseInt(k[0]);
    const vol = parseFloat(k[7]);
    allResult.push({
      time: toBeijingDatetime(ts),
      timestamp: ts,
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: vol,
      volumeFormatted: formatVol(vol)
    });
  }

  // 计算技术指标（全量50根）
  const closesAsc = [...allResult].reverse().map(r => r.close);
  const h1RSI = calcRSI(closesAsc, 14);
  const h1MACD = calcMACD(closesAsc, 12, 26, 9);
  const h1BB = calcBollingerBands(closesAsc, 20, 2);
  const refPrice = allResult[0]?.close || 0;

  // 输出14根
  const result = allResult.slice(0, LIMIT_OUTPUT);
  attachIndicators(result, {
    rsi: h1RSI,
    macdLine: h1MACD.macdLine,
    signalLine: h1MACD.signalLine,
    histogram: h1MACD.histogram,
    bbUpper: h1BB.upper,
    bbMiddle: h1BB.middle,
    bbLower: h1BB.lower,
    bbBandwidth: h1BB.bandwidth
  }, refPrice);

  const tsMap = new Map(result.map((r, i) => [r.timestamp, i]));
  
  // OI
  if (openInterest?.data && Array.isArray(openInterest.data)) {
    for (const item of openInterest.data.slice(0, LIMIT_OUTPUT)) {
      const ts = parseInt(item[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined) {
        result[idx].openInterest = parseFloat(item[1]);
        result[idx].openInterestValue = parseFloat(item[1]) * result[idx].close;
      }
    }
  }
  
  // 多空比
  if (longShortRatio?.data && Array.isArray(longShortRatio.data)) {
    for (const item of longShortRatio.data.slice(0, LIMIT_OUTPUT)) {
      const ts = parseInt(item[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined) {
        result[idx].longShortRatio = parseFloat(item[1]);
      }
    }
  }
  
  // Taker 买卖比
  if (takerVolume?.data && Array.isArray(takerVolume.data)) {
    for (const item of takerVolume.data.slice(0, LIMIT_OUTPUT)) {
      const ts = parseInt(item[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined) {
        const buyVol = parseFloat(item[1]);
        const sellVol = parseFloat(item[2]);
        result[idx].takerRatio = sellVol > 0 ? buyVol / sellVol : null;
      }
    }
  }
  
  return result;
}

// ========== 15分钟 K线数据 (OKX CLI, 纯价格动量) ==========

async function get15mDataCLI(proxy) {
  const LIMIT_OUTPUT = 14;
  const LIMIT_FETCH = 50;
  
  const klinesData = await okxCLIJson(`market candles ${OKX_INST_ID_SWAP} --bar 15m --limit ${LIMIT_FETCH}`, proxy);
  const klinesArray = Array.isArray(klinesData) ? klinesData : klinesData?.data;
  
  if (!klinesArray || klinesArray.length === 0) {
    return null;
  }
  
  const formatVol = (val) => {
    if (!val) return null;
    if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
    if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
    if (val >= 1e3) return `$${(val / 1e3).toFixed(2)}K`;
    return `$${val.toFixed(0)}`;
  };
  
  // 构建全量蜡烛（新→旧）
  const allResult = [];
  for (let i = 0; i < klinesArray.length; i++) {
    const k = klinesArray[i];
    const ts = parseInt(k[0]);
    const vol = parseFloat(k[7]);
    allResult.push({
      time: toBeijingDatetime(ts),
      timestamp: ts,
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: vol,
      volumeFormatted: formatVol(vol)
    });
  }

  // 全量收盘价（旧→新）用于指标计算
  const closesAsc = [...allResult].reverse().map(r => r.close);
  const refPrice = allResult[0]?.close || 0;

  // EMA 短线动量
  const ema7 = calcEMASequence(closesAsc, 7, LIMIT_OUTPUT);
  const ema12 = calcEMASequence(closesAsc, 12, LIMIT_OUTPUT);

  // RSI / MACD / 布林带（全量计算）
  const m15RSI = calcRSI(closesAsc, 14);
  const m15MACD = calcMACD(closesAsc, 12, 26, 9);
  const m15BB = calcBollingerBands(closesAsc, 20, 2);

  // 只取前14根输出
  const result = allResult.slice(0, LIMIT_OUTPUT);

  // 附加 EMA
  for (let i = 0; i < Math.min(result.length, ema7.length, ema12.length); i++) {
    result[i].ema7 = ema7[i];
    result[i].ema12 = ema12[i];
  }

  // 附加 RSI/MACD/布林带
  attachIndicators(result, {
    rsi: m15RSI,
    macdLine: m15MACD.macdLine,
    signalLine: m15MACD.signalLine,
    histogram: m15MACD.histogram,
    bbUpper: m15BB.upper,
    bbMiddle: m15BB.middle,
    bbLower: m15BB.lower,
    bbBandwidth: m15BB.bandwidth
  }, refPrice);

  return result;
}

// ========== 斐波那契分析 (使用 OKX CLI K线数据) ==========

/**
 * 获取 OKX K线数据用于斐波那契分析
 */
async function getOKXCandles(bar, limit, proxy) {
  // 优先用现货，不存在则回退到合约
  let data = await okxCLIJson(`market candles ${OKX_INST_ID_SPOT} --bar ${bar} --limit ${limit}`, proxy).catch(() => null);
  if (!data || (Array.isArray(data) && data.length === 0) || (data?.data && data.data.length === 0)) {
    data = await okxCLIJson(`market candles ${OKX_INST_ID_SWAP} --bar ${bar} --limit ${limit}`, proxy).catch(() => null);
  }
  if (!data) return null;
  
  // OKX CLI 返回的是数组，不是 { data: [...] }
  const arr = Array.isArray(data) ? data : data?.data;
  
  if (!arr || arr.length === 0) {
    return null;
  }
  
  return arr.map(k => ({
    time: parseInt(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4])
  }));
}

/**
 * 分析时间框架（返回压缩后的斐波那契位信息）
 */
function analyzeTimeframeRaw(timeframe, candles) {
  if (!candles || candles.length < 10) return null;
  
  let swingHigh = candles[0].high;
  let swingLow = candles[0].low;
  
  for (const c of candles) {
    if (c.high > swingHigh) swingHigh = c.high;
    if (c.low < swingLow) swingLow = c.low;
  }
  
  const currentPrice = candles[candles.length - 1].close;
  const diff = swingHigh - swingLow;
  const rangePercent = ((diff / swingLow) * 100).toFixed(1);
  
  return {
    timeframe: timeframe,
    high: fmtPrice(swingHigh),
    low: fmtPrice(swingLow),
    range: fmtPrice(diff),
    levels: [
      fmtPrice(swingHigh),                     // 0%
      fmtPrice(swingHigh - diff * 0.236, swingHigh),    // 23.6%
      fmtPrice(swingHigh - diff * 0.382, swingHigh),    // 38.2%
      fmtPrice(swingHigh - diff * 0.5, swingHigh),      // 50%
      fmtPrice(swingHigh - diff * 0.618, swingHigh),    // 61.8%
      fmtPrice(swingHigh - diff * 0.786, swingHigh),    // 78.6%
      fmtPrice(swingLow)                       // 100%
    ]
  };
}

/**
 * 获取多时间框架斐波那契分析 (使用 OKX CLI)
 */
async function getFibonacciAnalysisCLI(proxy) {
  try {
    // 并行获取不同时间框架的 K线
    const [dailyCandles, h4Candles, weeklyCandlesRaw] = await Promise.all([
      getOKXCandles('1D', 100, proxy),
      getOKXCandles('4H', 100, proxy),
      getOKXCandles('1D', 200, proxy)  // 周线从日线聚合
    ]);
    
    const result = {
      coin: COIN,
      currentPrice: null,
      note: 'high/low为波段高低点, range为波动幅度, levels数组依次对应0%, 23.6%, 38.2%, 50%, 61.8%, 78.6%, 100%斐波那契回调位价格',
      daily: null,
      fourHour: null,
      weekly: null
    };
    
    // 解析日线
    if (dailyCandles && dailyCandles.length >= 10) {
      result.currentPrice = dailyCandles[dailyCandles.length - 1].close;
      result.daily = analyzeTimeframeRaw('日线', dailyCandles);
    }
    
    // 解析4小时
    if (h4Candles && h4Candles.length >= 10) {
      result.fourHour = analyzeTimeframeRaw('4小时', h4Candles);
    }
    
    // 解析周线（从日线聚合）
    if (weeklyCandlesRaw && weeklyCandlesRaw.length >= 7) {
      const weeklyCandles = [];
      for (let i = 0; i < weeklyCandlesRaw.length; i += 7) {
        const week = weeklyCandlesRaw.slice(i, i + 7);
        if (week.length > 0) {
          weeklyCandles.push({
            time: week[0].time,
            open: week[0].open,
            high: Math.max(...week.map(w => w.high)),
            low: Math.min(...week.map(w => w.low)),
            close: week[week.length - 1].close
          });
        }
      }
      
      if (weeklyCandles.length >= 10) {
        result.weekly = analyzeTimeframeRaw('周线', weeklyCandles);
      }
    }
    
    return result;
  } catch (e) {
    console.error('斐波那契分析错误:', e.message);
    return null;
  }
}

// ========== 主数据获取 ==========

// /**
//  */
//   
//   const map = new Map();
//     const ts = parseInt(d.timestamp) * 1000;  // API返回的是秒级时间戳
//     const date = toBeijingDate(ts);
//     map.set(date, parseInt(d.value));
//   }
//   return map;
// }

async function getAltcoinAnalysis(proxy = null) {
  const result = {
    coin: COIN,
    timestamp: toBeijingTime(new Date()),
    priceHistory: null,
    kline4h: null,
    fibonacci: null,
    dataSource: {
      price: 'Unknown',
      sentiment: 'Unknown'
    }
  };

  try {
    // ===== 使用 OKX CLI 获取数据 =====
    console.error('使用 OKX CLI 获取数据...');
    
    
    const [dailyData, kline4h, kline1h, kline15m, fibData] = await Promise.all([
      withRetry(getDailyDataCLI, '日线数据', proxy),
      withRetry(get4hDataCLI, '4小时数据', proxy),
      withRetry(get1hDataCLI, '1小时数据', proxy),
      withRetry(get15mDataCLI, '15分钟数据', proxy),
      getFibonacciAnalysisCLI(proxy).catch(e => { console.error('Fibonacci error:', e.message); return null; })
    ]);
    
    activeDataSource = 'OKX CLI';
    result.dataSource.price = 'OKX CLI';
    result.dataSource.sentiment = 'OKX CLI';

    if (dailyData) {
      result.priceHistory = {
        current: dailyData.current,
        days: dailyData.history.length,
        volume24h: dailyData.volume24h,
        volume24hFormatted: dailyData.volume24hFormatted,
        premiumCurrent: dailyData.premiumCurrent,
        premiumNote: dailyData.premiumNote,
        fundingRate: dailyData.fundingRate,
        basis: dailyData.basis,
        liquidation: dailyData.liquidation,
        history: dailyData.history,
        statistics: dailyData.statistics,
        indicators: dailyData.indicators
      };
    }

    result.kline4h = kline4h;
    result.kline1h = kline1h;
    result.kline15m = kline15m;

    if (fibData) {
      result.fibonacci = fibData;
    }

  } catch (e) {
    console.error('数据获取错误:', e.message);
    throw e;
  }

  return result;
}

// ========== 格式化输出 ==========

function formatVolume(val) {
  if (!val) return 'N/A';
  return `$${(val / 1e9).toFixed(2)}B`;
}

function formatAnalysis(data) {
  let out = '';
  
  const coinEmoji = data.coin === 'BTC' ? '₿' : data.coin === 'ETH' ? 'Ξ' : data.coin === 'SOL' ? '◎' : '💰';
  out += '═'.repeat(70) + '\n';
  out += `              ${coinEmoji} ${data.coin} 市场数据 v6 (OKX CLI)\n`;
  out += '═'.repeat(70) + '\n\n';
  
  out += `📅 ${data.timestamp}\n\n`;
  
  // 价格统计
  if (data.priceHistory) {
    const ph = data.priceHistory;
    const stats = ph.statistics;
    
    out += '── 📈 价格统计 ──\n';
    out += `   当前价格: $${ph.current.toLocaleString()}\n\n`;
    
    out += `   50日: $${stats.days50.price.min.toLocaleString()} - $${stats.days50.price.max.toLocaleString()}`;
    out += ` | 均值: $${stats.days50.price.avg.toLocaleString()}`;
    out += ` | 位置: ${stats.days50.price.rangePosition}%\n`;
    
    out += `   30日: $${stats.days30.price.min.toLocaleString()} - $${stats.days30.price.max.toLocaleString()}`;
    out += ` | 均值: $${stats.days30.price.avg.toLocaleString()}`;
    out += ` | 位置: ${stats.days30.price.rangePosition}%\n`;
    
    out += '\n── 📊 交易量统计 ──\n';
    if (ph.volume24h) {
      out += `   24h聚合: ${formatVolume(ph.volume24h)}`;
      if (stats.days50.volume.avg) {
        out += ` (50日均值的${stats.days50.volume.volumeRatio}x)`;
      }
      out += '\n';
    }
    out += `   50日: ${formatVolume(stats.days50.volume.min)} - ${formatVolume(stats.days50.volume.max)}`;
    out += ` | 均值: ${formatVolume(stats.days50.volume.avg)}\n`;
    out += `   30日: ${formatVolume(stats.days30.volume.min)} - ${formatVolume(stats.days30.volume.max)}`;
    out += ` | 均值: ${formatVolume(stats.days30.volume.avg)}\n`;
    
    out += '\n── 📈 技术指标 ──\n';
    
    // RSI / MACD / 布林带 速览
    const ind = ph.indicators;
    if (ind.rsi14 !== null) {
      const rsiStatus = ind.rsi14 >= 70 ? '超买' : ind.rsi14 <= 30 ? '超卖' : '中性';
      out += `   RSI(14): ${ind.rsi14} (${rsiStatus})\n`;
    }
    if (ind.macd) {
      const macdDir = ind.macd.histogram > 0 ? '↑ 多头' : '↓ 空头';
      out += `   MACD: ${ind.macd.macdLine} | 信号线 ${ind.macd.signal} | 柱 ${ind.macd.histogram} ${macdDir}\n`;
    }
    if (ind.bollinger) {
      const bbPos = ind.bollinger.position;
      const bbLabel = bbPos >= 100 ? '突破上轨🔥' : bbPos >= 80 ? '偏上轨' : bbPos <= 0 ? '跌破下轨❄️' : bbPos <= 20 ? '偏下轨' : '中轨附近';
      out += `   布林带: 上${ind.bollinger.upper} 中${ind.bollinger.middle} 下${ind.bollinger.lower}`;
      out += ` | 带宽${ind.bollinger.bandwidth}% | 价位${bbPos}% (${bbLabel})\n`;
    }
    
    out += '\n── 📐 斐波那契回调位 ──\n';
    out += `   当前价格: $${data.fibonacci.currentPrice?.toLocaleString() || 'N/A'}\n\n`;
    
    const timeframes = ['daily', 'fourHour', 'weekly'];
    const timeframeNames = { daily: '日线', fourHour: '4小时', weekly: '周线' };
    
    for (const tf of timeframes) {
      const tfData = data.fibonacci[tf];
      if (tfData) {
        out += `   【${timeframeNames[tf]}】 `;
        out += `高点 $${tfData.high?.toLocaleString() || 'N/A'} ~ `;
        out += `低点 $${tfData.low?.toLocaleString() || 'N/A'}`;
        if (tfData.range) {
          out += ` (幅度 $${tfData.range?.toLocaleString()})`;
        }
        out += '\n';
      }
    }
    
    out += '\n';
    
    out += '   级别          日线            4小时           周线\n';
    out += '   ─────────────────────────────────────────────────────\n';
    
    const levelLabels = ['0%', '23.6%', '38.2%', '50%', '61.8%', '78.6%', '100%'];
    
    for (let i = 0; i < levelLabels.length; i++) {
      const levelLabel = levelLabels[i];
      
      const dPrice = data.fibonacci.daily?.levels?.[i];
      const h4Price = data.fibonacci.fourHour?.levels?.[i];
      const wPrice = data.fibonacci.weekly?.levels?.[i];
      
      out += `   ${levelLabel.padEnd(8)}  `;
      out += dPrice ? `$${dPrice.toLocaleString().padStart(12)}  ` : '            N/A  ';
      out += h4Price ? `$${h4Price.toLocaleString().padStart(12)}  ` : '            N/A  ';
      out += wPrice ? `$${wPrice.toLocaleString().padStart(12)}\n` : '            N/A\n';
    }
    
    out += '\n   📝 说明: 斐波那契回调位用于判断趋势中的潜在支撑/阻力位置。\n';
    out += '      61.8%(黄金分割)是最关键的支撑/阻力位。\n';
  }
  
  // 日线数据
  if (data.priceHistory?.history) {
    out += `\n── 📊 日线 (${data.priceHistory.history.length}根) ──\n`;
    for (const h of data.priceHistory.history) {
      out += `   ${h.date}: O$${h.open.toLocaleString()} H$${h.high.toLocaleString()} L$${h.low.toLocaleString()} C$${h.close.toLocaleString()}`;
      if (h.openInterest !== undefined) {
        out += ` | OI${(h.openInterest/1000).toFixed(1)}k`;
      }
      if (h.longShortRatio !== undefined) {
        out += ` | 多空比${h.longShortRatio.toFixed(2)}`;
      }
      if (h.rsi !== undefined) out += ` | RSI${h.rsi}`;
      out += '\n';
    }
  }
  
  // 4小时数据
  if (data.kline4h && data.kline4h.length > 0) {
    out += '\n── 📊 4小时K线 (14根) ──\n';
    for (let i = 0; i < Math.min(7, data.kline4h.length); i++) {
      const k = data.kline4h[i];
      const timeShort = k.time.split(' ')[0].slice(5) + ' ' + k.time.split(' ')[1].slice(0, 5);
      out += `   ${timeShort}: O$${k.open.toLocaleString()} H$${k.high.toLocaleString()} L$${k.low.toLocaleString()} C$${k.close.toLocaleString()}`;
      if (k.openInterest !== undefined) {
        out += ` | OI${(k.openInterest/1000).toFixed(1)}k`;
      }
      if (k.rsi !== undefined) out += ` | RSI${k.rsi}`;
      if (k.macdHistogram !== undefined) out += ` | MACD${k.macdHistogram > 0 ? '+' : ''}${k.macdHistogram}`;
      out += '\n';
    }
    if (data.kline4h.length > 7) {
      out += `   ... 共 ${data.kline4h.length} 根\n`;
    }
  }
  
  // 1小时数据
  if (data.kline1h && data.kline1h.length > 0) {
    out += '\n── ⏱ 1小时K线 (14根) ──\n';
    for (let i = 0; i < Math.min(7, data.kline1h.length); i++) {
      const k = data.kline1h[i];
      out += `   ${k.time} | O:${k.open} H:${k.high} L:${k.low} C:${k.close} | V:${k.volumeFormatted}`;
      if (k.longShortRatio) out += ` | 多空比:${k.longShortRatio.toFixed(2)}`;
      if (k.takerRatio) out += ` | Taker:${k.takerRatio.toFixed(2)}`;
      if (k.rsi !== undefined) out += ` | RSI${k.rsi}`;
      if (k.macdHistogram !== undefined) out += ` | MACD${k.macdHistogram > 0 ? '+' : ''}${k.macdHistogram}`;
      out += '\n';
    }
    if (data.kline1h.length > 7) {
      out += `   ... 共 ${data.kline1h.length} 根\n`;
    }
  }
  
  // 15分钟数据
  if (data.kline15m && data.kline15m.length > 0) {
    out += '\n── ⚡ 15分钟K线 (14根, 含EMA7/12 + RSI/MACD/BB) ──\n';
    for (let i = 0; i < Math.min(7, data.kline15m.length); i++) {
      const k = data.kline15m[i];
      out += `   ${k.time} | O:${k.open} H:${k.high} L:${k.low} C:${k.close} | V:${k.volumeFormatted}`;
      if (k.ema7 !== undefined) out += ` | EMA7:${k.ema7.toFixed(5)}`;
      if (k.ema12 !== undefined) out += ` EMA12:${k.ema12.toFixed(5)}`;
      if (k.rsi !== undefined) out += ` | RSI${k.rsi}`;
      if (k.macdHistogram !== undefined) out += ` | MACD${k.macdHistogram > 0 ? '+' : ''}${k.macdHistogram}`;
      out += '\n';
    }
    if (data.kline15m.length > 7) {
      out += `   ... 共 ${data.kline15m.length} 根\n`;
    }
  }
  
  out += '\n' + '─'.repeat(70) + '\n';
  out += `📊 数据源: ${activeDataSource || 'N/A'}\n`;
  
  return out;
}

// ========== CLI 入口 ==========

function saveData(data, basePath) {
  const scriptDir = __dirname;
  const workspaceDir = basePath || path.resolve(scriptDir, '..', '..', '..');
  const dataDir = path.join(workspaceDir, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const dateStr = data.timestamp.split(' ')[0];
  const coinSuffix = data.coin && data.coin !== 'BTC' ? `_${data.coin}` : '';
  const filePath = path.join(dataDir, `${dateStr}${coinSuffix}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return filePath;
}

function parseArgs() {
  const args = { coin: 'BTC', json: false, save: false, proxy: null };
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--save') args.save = true;
    else if (arg === '--coin') args.coin = process.argv[++i] || 'BTC';
    else if (arg.startsWith('--coin=')) args.coin = arg.split('=')[1];
    else if (arg === '--proxy') args.proxy = process.argv[++i] || PROXY_DEFAULT;
    else if (arg.startsWith('--proxy=')) args.proxy = arg.split('=')[1];
  }
  if (!args.proxy) args.proxy = PROXY_DEFAULT;
  return args;
}

async function main() {
  const args = parseArgs();
  applyCoin(args.coin);
  console.error(`📊 获取 ${COIN} 市场数据...`);
  try {
    const data = await getAltcoinAnalysis(args.proxy);
    if (args.save) {
      const savedPath = saveData(data);
      console.log(`📁 数据已保存: ${savedPath}`);
    }
    if (args.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(formatAnalysis(data));
    }
  } catch (e) {
    console.error('错误:', e.message);
    process.exit(1);
  }
}

module.exports = { getAltcoinAnalysis, formatAnalysis, saveData };

if (require.main === module) {
  main();
}