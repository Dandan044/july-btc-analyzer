#!/usr/bin/env node
/**
 * 比特币市场数据获取 v4
 * 数据源: 
 *   - Binance Futures API (价格/OHLCV + 交易侧数据)
 *   - alternative.me (恐惧贪婪指数)
 * 
 * 功能:
 *   - 获取日线级别数据（14天展示，30日用于统计）
 *   - 获取4小时级别数据（14根）
 *   - 交易侧数据：资金费率、OI、多空比、Taker买卖比
 * 
 * 用法: 
 *   node get_enhanced_analysis.js [--json] [--save] [--proxy http://127.0.0.1:7890]
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ========== 配置 ==========

const PROXY_DEFAULT = 'http://127.0.0.1:7890';

// ===== Binance 配置 (原数据源，地区限制) =====
const BINANCE_FUTURES_BASE = 'https://fapi.binance.com';

// ===== OKX 配置 (备用数据源，无地区限制) =====
const OKX_API_BASE = 'https://www.okx.com';
const OKX_INST_ID = 'BTC-USDT-SWAP';  // OKX 永续合约

// 数据源选择：优先 OKX，失败后回退 Binance
let activeDataSource = 'OKX';  // 'OKX' | 'Binance'

const CRYPTOCOMPARE_API = 'https://min-api.cryptocompare.com/data/v2/histo';

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

function fetch(url, proxy = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    
    if (proxy) {
      const proxyParsed = new URL(proxy);
      const proxyPort = proxyParsed.port || 80;
      
      const proxyReq = http.request({
        hostname: proxyParsed.hostname,
        port: proxyPort,
        method: 'CONNECT',
        path: `${parsed.hostname}:443`
      });
      
      proxyReq.on('connect', (res, socket) => {
        if (res.statusCode === 200) {
          const tlsSocket = require('tls').connect({
            socket: socket,
            servername: parsed.hostname
          }, () => {
            const req = `GET ${parsed.pathname}${parsed.search} HTTP/1.1\r\n` +
                       `Host: ${parsed.hostname}\r\n` +
                       `User-Agent: Mozilla/5.0\r\n` +
                       `Accept: application/json\r\n` +
                       `Connection: close\r\n\r\n`;
            tlsSocket.write(req);
            
            let data = '';
            tlsSocket.on('data', chunk => data += chunk);
            tlsSocket.on('end', () => {
              const headerEnd = data.indexOf('\r\n\r\n');
              const body = data.substring(headerEnd + 4);
              try {
                resolve(JSON.parse(body));
              } catch (e) {
                reject(new Error(`JSON parse error: ${e.message}`));
              }
            });
          });
          tlsSocket.on('error', reject);
        } else {
          reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
        }
      });
      
      proxyReq.on('error', reject);
      proxyReq.end();
    } else {
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
            catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
      req.end();
    }
  });
}

// ========== 技术指标计算 ==========

function calcEMASequence(values, period, outputCount) {
  if (values.length < period) return [];
  const reversed = [...values].reverse();
  const k = 2 / (period + 1);
  const emaSeries = [];
  let ema = reversed.slice(0, period).reduce((a, b) => a + b, 0) / period;
  emaSeries.push(ema);
  for (let i = period; i < reversed.length; i++) {
    ema = reversed[i] * k + ema * (1 - k);
    emaSeries.push(ema);
  }
  return emaSeries.reverse().slice(0, outputCount);
}

function calcRSI(values, period = 14) {
  // values: [最新, ..., 最旧]
  // 需要至少 period+1 个数据点
  if (values.length < period + 1) return null;
  
  // 计算价格变化
  const changes = [];
  for (let i = 0; i < values.length - 1; i++) {
    changes.push(values[i] - values[i + 1]);
  }
  
  // 取最近 period 个变化
  const recentChanges = changes.slice(0, period);
  
  let gains = 0, losses = 0;
  for (const change of recentChanges) {
    if (change > 0) gains += change;
    else losses -= change;
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ========== 斐波那契分析模块 ==========

/**
 * 获取 CryptoCompare OHLCV 数据（无需代理，带重试）
 */
async function getCryptoCompareData(limit, aggregate, timeframe, retries = 3) {
  const url = `${CRYPTOCOMPARE_API}${timeframe}?fsym=BTC&tsym=USDT&limit=${limit}&aggregate=${aggregate}`;
  
  for (let i = 0; i < retries; i++) {
    try {
      const data = await fetch(url, null);
      if (data?.Data?.Data && data.Data.Data.length > 0) {
        return data;
      }
    } catch (e) {
      if (i < retries - 1) await new Promise(r => setTimeout(r, 1000));
    }
  }
  return null;
}

/**
 * 计算平均真实波幅 ATR
 */
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }
  
  if (trueRanges.length < period) return 0;
  return trueRanges.slice(-period).reduce((a, b) => a + b, 0) / period;
}

/**
 * 计算斐波那契回调位
 */
function calcFibonacciLevels(high, low) {
  const diff = high - low;
  
  return {
    '0%': { price: high, label: '高点' },
    '23.6%': { price: high - diff * 0.236 },
    '38.2%': { price: high - diff * 0.382 },
    '50%': { price: high - diff * 0.5 },
    '61.8%': { price: high - diff * 0.618, label: '黄金分割' },
    '78.6%': { price: high - diff * 0.786 },
    '100%': { price: low, label: '低点' }
  };
}

/**
 * 分析单个时间框架
 */
function analyzeTimeframe(timeframe, candles) {
  if (!candles || candles.length < 10) return null;
  
  // 找波段高低点
  let swingHigh = candles[0].high;
  let swingLow = candles[0].low;
  let highIdx = 0;
  let lowIdx = 0;
  
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].high > swingHigh) {
      swingHigh = candles[i].high;
      highIdx = i;
    }
    if (candles[i].low < swingLow) {
      swingLow = candles[i].low;
      lowIdx = i;
    }
  }
  
  // 计算 ATR
  const atr = calcATR(candles, 14);
  
  // 当前价格
  const currentPrice = candles[candles.length - 1].close;
  
  // 波段幅度
  const swingRange = swingHigh - swingLow;
  const swingRangePct = (swingRange / swingLow) * 100;
  
  // 波动率
  const volatility = atr / currentPrice;
  const volatilityLevel = volatility > 0.05 ? '高波动' : volatility > 0.03 ? '中等波动' : '低波动';
  
  // 计算斐波那契位
  const fibLevels = calcFibonacciLevels(swingHigh, swingLow);
  
  // 趋势方向
  const trend = highIdx > lowIdx ? '上升趋势' : '下降趋势';
  
  // 找当前价格最接近的斐波那契位
  let closestLevel = null;
  let closestDist = Infinity;
  for (const [level, data] of Object.entries(fibLevels)) {
    const dist = Math.abs(data.price - currentPrice);
    if (dist < closestDist) {
      closestDist = dist;
      closestLevel = level;
    }
  }
  
  return {
    timeframe,
    currentPrice: parseFloat(currentPrice.toFixed(2)),
    swingHigh: parseFloat(swingHigh.toFixed(2)),
    swingLow: parseFloat(swingLow.toFixed(2)),
    swingRange: parseFloat(swingRange.toFixed(2)),
    swingRangePct: parseFloat(swingRangePct.toFixed(1)),
    atr: parseFloat(atr.toFixed(2)),
    volatility: parseFloat(volatility.toFixed(4)),
    volatilityLevel,
    fibLevels: Object.fromEntries(
      Object.entries(fibLevels).map(([k, v]) => [k, parseFloat(v.price.toFixed(2))])
    ),
    trend,
    closestLevel,
    closestPrice: parseFloat(fibLevels[closestLevel].price.toFixed(2)),
    closestDistPct: parseFloat((closestDist / currentPrice * 100).toFixed(2)),
    highTime: candles[highIdx].time ? toBeijingDatetime(candles[highIdx].time * 1000) : null,
    lowTime: candles[lowIdx].time ? toBeijingDatetime(candles[lowIdx].time * 1000) : null,
    durationBars: Math.abs(highIdx - lowIdx)
  };
}

/**
 * 找多时间框架重合区域
 */
function findConfluenceZones(analyses, tolerance = 0.015) {
  const allLevels = [];
  
  for (const analysis of analyses) {
    if (!analysis) continue;
    for (const [levelName, price] of Object.entries(analysis.fibLevels)) {
      allLevels.push({
        price,
        level: levelName,
        timeframe: analysis.timeframe
      });
    }
  }
  
  // 按价格排序
  allLevels.sort((a, b) => a.price - b.price);
  
  // 找重合区域
  const confluenceZones = [];
  const used = new Set();
  
  for (let i = 0; i < allLevels.length; i++) {
    if (used.has(i)) continue;
    
    const zone = [allLevels[i]];
    used.add(i);
    
    for (let j = i + 1; j < allLevels.length; j++) {
      if (used.has(j)) continue;
      
      const priceDiff = Math.abs(allLevels[j].price - allLevels[i].price) / allLevels[i].price;
      
      if (priceDiff <= tolerance && allLevels[j].timeframe !== allLevels[i].timeframe) {
        zone.push(allLevels[j]);
        used.add(j);
      }
    }
    
    // 至少2个不同时间框架才算有效
    const timeframes = new Set(zone.map(z => z.timeframe));
    if (timeframes.size >= 2) {
      const avgPrice = zone.reduce((a, b) => a + b.price, 0) / zone.length;
      
      confluenceZones.push({
        priceRange: {
          low: Math.min(...zone.map(z => z.price)),
          high: Math.max(...zone.map(z => z.price))
        },
        avgPrice: parseFloat(avgPrice.toFixed(2)),
        levels: zone.map(z => ({
          timeframe: z.timeframe,
          level: z.level,
          price: z.price
        })),
        timeframes: Array.from(timeframes),
        strength: timeframes.size
      });
    }
  }
  
  // 按强度排序
  confluenceZones.sort((a, b) => b.strength - a.strength);
  
  return confluenceZones;
}

/**
 * 获取多时间框架斐波那契分析
 */
async function getFibonacciAnalysis() {
  try {
    // 串行获取数据避免竞争
    const dailyData = await getCryptoCompareData(100, 1, 'day');
    const h4Data = await getCryptoCompareData(100, 4, 'hour');
    const weeklyData = await getCryptoCompareData(200, 1, 'day');
    
    const result = {
      currentPrice: null,
      daily: null,
      fourHour: null,
      weekly: null
    };
    
    // 解析日线
    if (dailyData?.Data?.Data) {
      const candles = dailyData.Data.Data
        .filter(c => c.close > 0)
        .map(c => ({
          time: c.time,
          high: c.high,
          low: c.low,
          close: c.close,
          open: c.open
        }));
      if (candles.length >= 10) {
        const analysis = analyzeTimeframeRaw('日线', candles);
        result.currentPrice = analysis.currentPrice;
        result.daily = analysis;
      }
    }
    
    // 解析4小时
    if (h4Data?.Data?.Data) {
      const candles = h4Data.Data.Data
        .filter(c => c.close > 0)
        .map(c => ({
          time: c.time,
          high: c.high,
          low: c.low,
          close: c.close,
          open: c.open
        }));
      if (candles.length >= 10) {
        const analysis = analyzeTimeframeRaw('4小时', candles);
        result.fourHour = analysis;
      }
    }
    
    // 解析周线（从日线聚合）
    if (weeklyData?.Data?.Data && weeklyData.Data.Data.length >= 7) {
      const dailyCandles = weeklyData.Data.Data
        .filter(c => c.close > 0)
        .map(c => ({
          time: c.time,
          high: c.high,
          low: c.low,
          close: c.close,
          open: c.open
        }));
      
      // 聚合为周线
      const weeklyCandles = [];
      for (let i = 0; i < dailyCandles.length; i += 7) {
        const week = dailyCandles.slice(i, i + 7);
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
        const analysis = analyzeTimeframeRaw('周线', weeklyCandles);
        result.weekly = analysis;
      }
    }
    
    return result;
  } catch (e) {
    console.error('斐波那契分析错误:', e.message);
    return null;
  }
}

/**
 * 分析时间框架（返回完整的斐波那契位信息）
 */
function analyzeTimeframeRaw(timeframe, candles) {
  if (!candles || candles.length < 10) return null;
  
  // 找波段高低点
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
    timeframeNote: `${timeframe}级别斐波那契回调分析`,
    currentPrice: parseFloat(currentPrice.toFixed(2)),
    
    // 波段背景信息
    swingHigh: parseFloat(swingHigh.toFixed(2)),
    swingHighNote: '波段高点(分析区间内的最高价)',
    swingLow: parseFloat(swingLow.toFixed(2)),
    swingLowNote: '波段低点(分析区间内的最低价)',
    swingRange: parseFloat(diff.toFixed(2)),
    swingRangeNote: `波段幅度 $${diff.toFixed(0)} (${rangePercent}% 波动)`,
    
    // 斐波那契回调位
    fibonacciLevels: {
      level_0_percent: {
        price: parseFloat(swingHigh.toFixed(2)),
        label: '波段高点',
        note: '0%回调位, 等于波段高点价格'
      },
      level_23_6_percent: {
        price: parseFloat((swingHigh - diff * 0.236).toFixed(2)),
        label: '23.6%回调',
        note: '23.6%回调位, 计算方式: 波段高点 - 波段幅度×0.236'
      },
      level_38_2_percent: {
        price: parseFloat((swingHigh - diff * 0.382).toFixed(2)),
        label: '38.2%回调',
        note: '38.2%回调位, 计算方式: 波段高点 - 波段幅度×0.382'
      },
      level_50_percent: {
        price: parseFloat((swingHigh - diff * 0.5).toFixed(2)),
        label: '50%回调',
        note: '50%回调位, 波段高低点的中位价, 不属于斐波那契数列'
      },
      level_61_8_percent: {
        price: parseFloat((swingHigh - diff * 0.618).toFixed(2)),
        label: '61.8%回调',
        note: '61.8%回调位(黄金分割), 计算方式: 波段高点 - 波段幅度×0.618'
      },
      level_78_6_percent: {
        price: parseFloat((swingHigh - diff * 0.786).toFixed(2)),
        label: '78.6%回调',
        note: '78.6%回调位, 计算方式: 波段高点 - 波段幅度×0.786'
      },
      level_100_percent: {
        price: parseFloat(swingLow.toFixed(2)),
        label: '波段低点',
        note: '100%回调位, 等于波段低点价格'
      }
    },
    
    // 使用说明
    usageNote: '斐波那契回调位基于斐波那契数列计算, 常用回调位包括23.6%、38.2%、50%、61.8%、78.6%'
  };
}



// ========== OKX API (备用数据源，无地区限制) ==========

/**
 * 使用 curl 获取 OKX 数据（处理 chunked transfer encoding）
 */
async function getOKXData(endpoint, proxy) {
  if (!proxy) return null;
  
  return new Promise((resolve) => {
    const { exec } = require('child_process');
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
 * OKX 日线数据获取
 * 数据结构保持与 Binance 一致
 */
async function getDailyDataOKX(proxy) {
  const LIMIT_DISPLAY = 14;
  const LIMIT_STATS = 30;
  
  // OKX K线: [ts, open, high, low, close, vol, volCcy, volCcyQuote, confirm]
  const klines30d = await getOKXData(`/api/v5/market/candles?instId=${OKX_INST_ID}&bar=1D&limit=${LIMIT_STATS}`, proxy).catch(() => null);
  
  if (!klines30d || klines30d.code !== '0' || !klines30d.data || klines30d.data.length === 0) {
    throw new Error('OKX: 无法获取日线K线数据');
  }
  
  // OKX 24小时数据
  const ticker24h = await getOKXData(`/api/v5/market/ticker?instId=${OKX_INST_ID}`, proxy).catch(() => null);
  const volume24h = ticker24h?.data?.[0]?.vol24h ? parseFloat(ticker24h.data[0].vol24h) * parseFloat(ticker24h.data[0].last || 70000) : null;
  
  // 并行获取交易侧数据
  const [fundingRate, openInterest, longShortRatio, topTraderRatio, takerVolume] = await Promise.all([
    // 资金费率历史 (OKX 不提供历史列表，只获取当前)
    getOKXData(`/api/v5/public/funding-rate?instId=${OKX_INST_ID}`, proxy).catch(() => null),
    // 持仓量历史
    getOKXData(`/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1D`, proxy).catch(() => null),
    // 散户多空比
    getOKXData(`/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1D`, proxy).catch(() => null),
    // 大户多空比
    getOKXData(`/api/v5/rubik/stat/contracts/long-short-account-ratio-contract-top-trader?instId=${OKX_INST_ID}&period=1D`, proxy).catch(() => null),
    // Taker买卖比
    getOKXData(`/api/v5/rubik/stat/taker-volume?instId=${OKX_INST_ID}&instType=CONTRACTS&ccy=BTC&period=1D`, proxy).catch(() => null)
  ]);
  
  // 解析 K线数据 (OKX 格式: [ts, open, high, low, close, vol, volCcy, volCcyQuote, confirm])
  // OKX 返回数据是倒序的（最新在前），我们保持这个顺序用于展示
  const allDataDesc = [];  // 最新在前（用于展示）
  for (let i = 0; i < klines30d.data.length; i++) {
    const k = klines30d.data[i];
    const ts = parseInt(k[0]);
    allDataDesc.push({
      timestamp: ts,
      date: toBeijingDate(ts),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),          // BTC 数量
      quoteVolume: parseFloat(k[7])      // USDT 数量
    });
  }
  
  // 展示数据：取前14条（最新的14天）
  const displayData = allDataDesc.slice(0, LIMIT_DISPLAY);
  
  // EMA 计算需要从旧到新的顺序
  const allDataAsc = [...allDataDesc].reverse();  // 反转：最旧在前
  const closes = allDataAsc.map(d => d.close);
  
  // 计算 EMA（从旧到新计算）
  const ema7 = calcEMASequence(closes, 7, LIMIT_DISPLAY);
  const ema12 = calcEMASequence(closes, 12, LIMIT_DISPLAY);
  const ema20 = calcEMASequence(closes, 20, LIMIT_DISPLAY);
  const ema26 = calcEMASequence(closes, 26, LIMIT_DISPLAY);
  
  // EMA 结果是最新在前（calcEMASequence 内部已反转），直接使用
  
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
      quoteVolume: i === 0 ? null : d.quoteVolume
    };
    
    if (i < ema7.length) entry.ema7 = parseFloat(ema7[i].toFixed(2));
    if (i < ema12.length) entry.ema12 = parseFloat(ema12[i].toFixed(2));
    if (i < ema20.length) entry.ema20 = parseFloat(ema20[i].toFixed(2));
    if (i < ema26.length) entry.ema26 = parseFloat(ema26[i].toFixed(2));
    
    return entry;
  });
  
  // 处理资金费率 (OKX 只返回当前费率，填入当天)
  if (fundingRate?.data?.[0]) {
    const rate = parseFloat(fundingRate.data[0].fundingRate);
    if (history[0]) history[0].fundingRate = rate;
  }
  
  // 处理持仓量历史
  // OKX open-interest-volume: [ts, oi, vol] - oi 是 BTC 数量
  if (openInterest?.data && Array.isArray(openInterest.data)) {
    const oiData = openInterest.data.slice(0, LIMIT_DISPLAY);
    for (const item of oiData) {
      const ts = parseInt(item[0]);
      const idx = history.findIndex(h => h.timestamp === ts);
      if (idx !== -1) {
        history[idx].openInterest = parseFloat(item[1]);
        history[idx].openInterestValue = parseFloat(item[1]) * history[idx].close;
      }
    }
  }
  
  // 处理散户多空比
  if (longShortRatio?.data && Array.isArray(longShortRatio.data)) {
    for (const item of longShortRatio.data.slice(0, LIMIT_DISPLAY)) {
      const ts = parseInt(item[0]);
      const idx = history.findIndex(h => h.timestamp === ts);
      if (idx !== -1) {
        history[idx].longShortRatio = parseFloat(item[1]);
      }
    }
  }
  
  // 处理大户多空比
  if (topTraderRatio?.data && Array.isArray(topTraderRatio.data)) {
    for (const item of topTraderRatio.data.slice(0, LIMIT_DISPLAY)) {
      const ts = parseInt(item[0]);
      const idx = history.findIndex(h => h.timestamp === ts);
      if (idx !== -1) {
        history[idx].topTraderRatio = parseFloat(item[1]);
      }
    }
  }
  
  // 处理 Taker 买卖比
  if (takerVolume?.data && Array.isArray(takerVolume.data)) {
    for (const item of takerVolume.data.slice(0, LIMIT_DISPLAY)) {
      const ts = parseInt(item[0]);
      const idx = history.findIndex(h => h.timestamp === ts);
      if (idx !== -1) {
        const buyVol = parseFloat(item[1]);
        const sellVol = parseFloat(item[2]);
        history[idx].takerRatio = sellVol > 0 ? buyVol / sellVol : null;
        history[idx].takerBuyVol = buyVol;
        history[idx].takerSellVol = sellVol;
      }
    }
  }
  
  // 计算统计
  const currentPrice = displayData[0].close;
  const prices14d = displayData.map(d => d.close);
  const maxPrice14d = Math.max(...prices14d);
  const minPrice14d = Math.min(...prices14d);
  const avgPrice14d = prices14d.reduce((a, b) => a + b, 0) / prices14d.length;
  
  const volumes14d = displayData.slice(1).map(d => d.quoteVolume).filter(v => v);
  const maxVolume14d = volumes14d.length > 0 ? Math.max(...volumes14d) : null;
  const minVolume14d = volumes14d.length > 0 ? Math.min(...volumes14d) : null;
  const avgVolume14d = volumes14d.length > 0 ? volumes14d.reduce((a, b) => a + b, 0) / volumes14d.length : null;
  
  const prices30d = allDataAsc.slice(-30).map(d => d.close);
  const maxPrice30d = Math.max(...prices30d);
  const minPrice30d = Math.min(...prices30d);
  const avgPrice30d = prices30d.reduce((a, b) => a + b, 0) / prices30d.length;
  
  const volumes30d = allDataAsc.slice(-30).slice(0, 29).map(d => d.quoteVolume).filter(v => v);
  const maxVolume30d = volumes30d.length > 0 ? Math.max(...volumes30d) : null;
  const minVolume30d = volumes30d.length > 0 ? Math.min(...volumes30d) : null;
  const avgVolume30d = volumes30d.length > 0 ? volumes30d.reduce((a, b) => a + b, 0) / volumes30d.length : null;
  
  return {
    history: history,
    current: currentPrice,
    volume24h: volume24h,
    statistics: {
      days14: {
        price: {
          max: parseFloat(maxPrice14d.toFixed(2)),
          min: parseFloat(minPrice14d.toFixed(2)),
          avg: parseFloat(avgPrice14d.toFixed(2)),
          rangePosition: parseFloat(((currentPrice - minPrice14d) / (maxPrice14d - minPrice14d) * 100).toFixed(1))
        },
        volume: {
          max: maxVolume14d ? parseFloat(maxVolume14d.toFixed(0)) : null,
          min: minVolume14d ? parseFloat(minVolume14d.toFixed(0)) : null,
          avg: avgVolume14d ? parseFloat(avgVolume14d.toFixed(0)) : null,
          volumeRatio: (volume24h && avgVolume14d) ? parseFloat((volume24h / avgVolume14d).toFixed(2)) : null
        }
      },
      days30: {
        price: {
          max: parseFloat(maxPrice30d.toFixed(2)),
          min: parseFloat(minPrice30d.toFixed(2)),
          avg: parseFloat(avgPrice30d.toFixed(2)),
          rangePosition: parseFloat(((currentPrice - minPrice30d) / (maxPrice30d - minPrice30d) * 100).toFixed(1))
        },
        volume: {
          max: maxVolume30d ? parseFloat(maxVolume30d.toFixed(0)) : null,
          min: minVolume30d ? parseFloat(minVolume30d.toFixed(0)) : null,
          avg: avgVolume30d ? parseFloat(avgVolume30d.toFixed(0)) : null,
          volumeRatio: (volume24h && avgVolume30d) ? parseFloat((volume24h / avgVolume30d).toFixed(2)) : null
        }
      }
    },
    indicators: {
      rsi14: calcRSI(closes, 14) ? parseFloat(calcRSI(closes, 14).toFixed(1)) : null
    }
  };
}

/**
 * OKX 4小时数据获取
 */
async function get4hDataOKX(proxy) {
  const LIMIT = 14;
  
  const klines = await getOKXData(`/api/v5/market/candles?instId=${OKX_INST_ID}&bar=4H&limit=${LIMIT}`, proxy).catch(e => {
    console.error('OKX 4h klines error:', e.message);
    return null;
  });
  
  if (!klines || klines.code !== '0' || !klines.data) {
    return null;
  }
  
  const [fundingRate, openInterest, longShortRatio, topTraderRatio, takerVolume] = await Promise.all([
    getOKXData(`/api/v5/public/funding-rate?instId=${OKX_INST_ID}`, proxy).catch(() => null),
    getOKXData(`/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=4H`, proxy).catch(() => null),
    getOKXData(`/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=4H`, proxy).catch(() => null),
    getOKXData(`/api/v5/rubik/stat/contracts/long-short-account-ratio-contract-top-trader?instId=${OKX_INST_ID}&period=4H`, proxy).catch(() => null),
    getOKXData(`/api/v5/rubik/stat/taker-volume?instId=${OKX_INST_ID}&instType=CONTRACTS&ccy=BTC&period=4H`, proxy).catch(() => null)
  ]);
  
  const result = [];
  
  for (let i = 0; i < klines.data.length; i++) {
    const k = klines.data[i];
    const ts = parseInt(k[0]);
    const entry = {
      time: toBeijingDatetime(ts),
      timestamp: ts,
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      quoteVolume: parseFloat(k[7])
    };
    result.push(entry);
  }
  
  const tsMap = new Map(result.map((r, i) => [r.timestamp, i]));
  
  // 资金费率
  if (fundingRate?.data?.[0]) {
    const rate = parseFloat(fundingRate.data[0].fundingRate);
    const markPrice = parseFloat(fundingRate.data[0].markPrice || 0);
    // 只填入最新一根
    if (result[0]) {
      result[0].fundingRate = rate;
      result[0].markPrice = markPrice;
    }
  }
  
  // 持仓量
  if (openInterest?.data && Array.isArray(openInterest.data)) {
    for (const item of openInterest.data.slice(0, LIMIT)) {
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
    for (const item of longShortRatio.data.slice(0, LIMIT)) {
      const ts = parseInt(item[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined) {
        result[idx].longShortRatio = parseFloat(item[1]);
      }
    }
  }
  
  // 大户多空比
  if (topTraderRatio?.data && Array.isArray(topTraderRatio.data)) {
    for (const item of topTraderRatio.data.slice(0, LIMIT)) {
      const ts = parseInt(item[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined) {
        result[idx].topTraderRatio = parseFloat(item[1]);
      }
    }
  }
  
  // Taker 买卖比
  if (takerVolume?.data && Array.isArray(takerVolume.data)) {
    for (const item of takerVolume.data.slice(0, LIMIT)) {
      const ts = parseInt(item[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined) {
        const buyVol = parseFloat(item[1]);
        const sellVol = parseFloat(item[2]);
        result[idx].takerRatio = sellVol > 0 ? buyVol / sellVol : null;
        result[idx].takerBuyVol = buyVol;
        result[idx].takerSellVol = sellVol;
      }
    }
  }
  
  return result;
}


// ========== Binance API ==========

async function getBinanceData(endpoint, proxy) {
  const url = `${BINANCE_FUTURES_BASE}${endpoint}`;
  return fetch(url, proxy);
}

/**
 * 获取日线数据
 * - 获取30日K线用于统计和指标计算
 * - 展示14日数据
 */
async function getDailyData(proxy) {
  const LIMIT_DISPLAY = 14;  // 展示14天
  const LIMIT_STATS = 30;    // 统计30天
  
  // 获取30日K线（用于统计和指标计算）
  const klines30d = await getBinanceData(`/fapi/v1/klines?symbol=BTCUSDT&interval=1d&limit=${LIMIT_STATS}`, proxy).catch(() => null);
  
  if (!klines30d || !Array.isArray(klines30d) || klines30d.length === 0) {
    throw new Error('无法获取日线K线数据');
  }
  
  // 获取24小时聚合交易量
  const ticker24h = await getBinanceData('/fapi/v1/ticker/24hr?symbol=BTCUSDT', proxy).catch(() => null);
  const volume24h = ticker24h ? parseFloat(ticker24h.quoteVolume) : null;
  
  // 并行获取交易侧数据（14天）
  const [fundingRate, openInterest, globalLongShort, topTraderPosition, takerRatio] = await Promise.all([
    getBinanceData(`/fapi/v1/fundingRate?symbol=BTCUSDT&limit=${LIMIT_DISPLAY * 3}`, proxy).catch(() => null),
    getBinanceData(`/futures/data/openInterestHist?symbol=BTCUSDT&period=1d&limit=${LIMIT_DISPLAY}`, proxy).catch(() => null),
    getBinanceData(`/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=1d&limit=${LIMIT_DISPLAY}`, proxy).catch(() => null),
    getBinanceData(`/futures/data/topLongShortPositionRatio?symbol=BTCUSDT&period=1d&limit=${LIMIT_DISPLAY}`, proxy).catch(() => null),
    getBinanceData(`/futures/data/takerlongshortRatio?symbol=BTCUSDT&period=1d&limit=${LIMIT_DISPLAY}`, proxy).catch(() => null)
  ]);
  
  // 解析30日数据（用于统计和指标计算）
  const allData = [];
  for (let i = 0; i < klines30d.length; i++) {
    const k = klines30d[i];
    allData.push({
      timestamp: k[0],
      date: toBeijingDate(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      quoteVolume: parseFloat(k[7])
    });
  }
  
  // 最新数据在数组末尾，反转使最新在前
  allData.reverse();
  
  // 取最近14天用于展示
  const displayData = allData.slice(0, LIMIT_DISPLAY);
  const closes = allData.map(d => d.close);  // 所有收盘价用于指标计算
  
  // 计算 EMA
  const ema7 = calcEMASequence(closes, 7, LIMIT_DISPLAY);
  const ema12 = calcEMASequence(closes, 12, LIMIT_DISPLAY);
  const ema20 = calcEMASequence(closes, 20, LIMIT_DISPLAY);
  const ema26 = calcEMASequence(closes, 26, LIMIT_DISPLAY);
  
  // 构建展示数据（当日volume置为null）
  const history = displayData.map((d, i) => {
    const entry = {
      date: d.date,
      timestamp: d.timestamp,
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      volume: i === 0 ? null : d.volume,  // 当日交易量置为null
      quoteVolume: i === 0 ? null : d.quoteVolume
    };
    
    // EMA
    if (i < ema7.length) entry.ema7 = parseFloat(ema7[i].toFixed(2));
    if (i < ema12.length) entry.ema12 = parseFloat(ema12[i].toFixed(2));
    if (i < ema20.length) entry.ema20 = parseFloat(ema20[i].toFixed(2));
    if (i < ema26.length) entry.ema26 = parseFloat(ema26[i].toFixed(2));
    
    return entry;
  });
  
  // 按 timestamp 映射（用于匹配交易侧数据）
  const tsMap = new Map(history.map((r, i) => [r.timestamp, i]));
  
  // 资金费率 - 按日期分组，取当天最后一条
  if (fundingRate && Array.isArray(fundingRate)) {
    const byDate = {};
    for (const d of fundingRate) {
      const dateStr = toBeijingDate(d.fundingTime);
      byDate[dateStr] = parseFloat(d.fundingRate);
    }
    for (const r of history) {
      if (byDate[r.date] !== undefined) {
        r.fundingRate = byDate[r.date];
      }
    }
  }
  
  // OI
  if (openInterest && Array.isArray(openInterest)) {
    for (const d of openInterest) {
      const idx = tsMap.get(d.timestamp);
      if (idx !== undefined) {
        history[idx].openInterest = parseFloat(d.sumOpenInterest);
        history[idx].openInterestValue = parseFloat(d.sumOpenInterestValue);
      }
    }
  }
  
  // 多空人数比
  if (globalLongShort && Array.isArray(globalLongShort)) {
    for (const d of globalLongShort) {
      const idx = tsMap.get(d.timestamp);
      if (idx !== undefined) {
        history[idx].longShortRatio = parseFloat(d.longShortRatio);
        history[idx].longAccount = parseFloat(d.longAccount);
        history[idx].shortAccount = parseFloat(d.shortAccount);
      }
    }
  }
  
  // 大户持仓比
  if (topTraderPosition && Array.isArray(topTraderPosition)) {
    for (const d of topTraderPosition) {
      const idx = tsMap.get(d.timestamp);
      if (idx !== undefined) {
        history[idx].topTraderRatio = parseFloat(d.longShortRatio);
        history[idx].topTraderLong = parseFloat(d.longAccount);
        history[idx].topTraderShort = parseFloat(d.shortAccount);
      }
    }
  }
  
  // Taker 买卖比
  if (takerRatio && Array.isArray(takerRatio)) {
    for (const d of takerRatio) {
      const idx = tsMap.get(d.timestamp);
      if (idx !== undefined) {
        history[idx].takerRatio = parseFloat(d.buySellRatio);
        history[idx].takerBuyVol = parseFloat(d.buyVol);
        history[idx].takerSellVol = parseFloat(d.sellVol);
      }
    }
  }
  
  // 计算统计
  const currentPrice = displayData[0].close;
  
  // 14日价格统计
  const prices14d = displayData.map(d => d.close);
  const maxPrice14d = Math.max(...prices14d);
  const minPrice14d = Math.min(...prices14d);
  const avgPrice14d = prices14d.reduce((a, b) => a + b, 0) / prices14d.length;
  
  // 14日交易量统计（排除当日）
  const volumes14d = displayData.slice(1).map(d => d.quoteVolume).filter(v => v);
  const maxVolume14d = volumes14d.length > 0 ? Math.max(...volumes14d) : null;
  const minVolume14d = volumes14d.length > 0 ? Math.min(...volumes14d) : null;
  const avgVolume14d = volumes14d.length > 0 ? volumes14d.reduce((a, b) => a + b, 0) / volumes14d.length : null;
  
  // 30日价格统计
  const prices30d = allData.slice(0, 30).map(d => d.close);
  const maxPrice30d = Math.max(...prices30d);
  const minPrice30d = Math.min(...prices30d);
  const avgPrice30d = prices30d.reduce((a, b) => a + b, 0) / prices30d.length;
  
  // 30日交易量统计（排除当日）
  const volumes30d = allData.slice(1, 30).map(d => d.quoteVolume).filter(v => v);
  const maxVolume30d = volumes30d.length > 0 ? Math.max(...volumes30d) : null;
  const minVolume30d = volumes30d.length > 0 ? Math.min(...volumes30d) : null;
  const avgVolume30d = volumes30d.length > 0 ? volumes30d.reduce((a, b) => a + b, 0) / volumes30d.length : null;
  
  return {
    history: history,
    current: currentPrice,
    volume24h: volume24h,  // 24小时聚合交易量
    statistics: {
      days14: {
        price: {
          max: parseFloat(maxPrice14d.toFixed(2)),
          min: parseFloat(minPrice14d.toFixed(2)),
          avg: parseFloat(avgPrice14d.toFixed(2)),
          rangePosition: parseFloat(((currentPrice - minPrice14d) / (maxPrice14d - minPrice14d) * 100).toFixed(1))
        },
        volume: {
          max: maxVolume14d ? parseFloat(maxVolume14d.toFixed(0)) : null,
          min: minVolume14d ? parseFloat(minVolume14d.toFixed(0)) : null,
          avg: avgVolume14d ? parseFloat(avgVolume14d.toFixed(0)) : null,
          volumeRatio: (volume24h && avgVolume14d) ? parseFloat((volume24h / avgVolume14d).toFixed(2)) : null
        }
      },
      days30: {
        price: {
          max: parseFloat(maxPrice30d.toFixed(2)),
          min: parseFloat(minPrice30d.toFixed(2)),
          avg: parseFloat(avgPrice30d.toFixed(2)),
          rangePosition: parseFloat(((currentPrice - minPrice30d) / (maxPrice30d - minPrice30d) * 100).toFixed(1))
        },
        volume: {
          max: maxVolume30d ? parseFloat(maxVolume30d.toFixed(0)) : null,
          min: minVolume30d ? parseFloat(minVolume30d.toFixed(0)) : null,
          avg: avgVolume30d ? parseFloat(avgVolume30d.toFixed(0)) : null,
          volumeRatio: (volume24h && avgVolume30d) ? parseFloat((volume24h / avgVolume30d).toFixed(2)) : null
        }
      }
    },
    indicators: {
      rsi14: calcRSI(closes, 14) ? parseFloat(calcRSI(closes, 14).toFixed(1)) : null
    }
  };
}

/**
 * 获取4小时数据（14根），含所有交易侧数据
 */
async function get4hData(proxy) {
  const LIMIT = 14;
  
  const klines = await getBinanceData(`/fapi/v1/klines?symbol=BTCUSDT&interval=4h&limit=${LIMIT}`, proxy).catch(e => {
    console.error('4h klines error:', e.message);
    return null;
  });
  
  if (!klines || !Array.isArray(klines)) {
    return null;
  }
  
  const [fundingRate, openInterest, globalLongShort, topTraderPosition, takerRatio] = await Promise.all([
    getBinanceData(`/fapi/v1/fundingRate?symbol=BTCUSDT&limit=${LIMIT}`, proxy).catch(() => null),
    getBinanceData(`/futures/data/openInterestHist?symbol=BTCUSDT&period=4h&limit=${LIMIT}`, proxy).catch(() => null),
    getBinanceData(`/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=4h&limit=${LIMIT}`, proxy).catch(() => null),
    getBinanceData(`/futures/data/topLongShortPositionRatio?symbol=BTCUSDT&period=4h&limit=${LIMIT}`, proxy).catch(() => null),
    getBinanceData(`/futures/data/takerlongshortRatio?symbol=BTCUSDT&period=4h&limit=${LIMIT}`, proxy).catch(() => null)
  ]);
  
  const result = [];
  
  for (let i = 0; i < klines.length; i++) {
    const k = klines[i];
    const entry = {
      time: toBeijingDatetime(k[0]),
      timestamp: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      quoteVolume: parseFloat(k[7])
    };
    result.push(entry);
  }
  
  const tsMap = new Map(result.map((r, i) => [r.timestamp, i]));
  
  if (fundingRate && Array.isArray(fundingRate)) {
    for (const d of fundingRate) {
      const idx = tsMap.get(d.fundingTime);
      if (idx !== undefined) {
        result[idx].fundingRate = parseFloat(d.fundingRate);
        result[idx].markPrice = parseFloat(d.markPrice);
      }
    }
  }
  
  if (openInterest && Array.isArray(openInterest)) {
    for (const d of openInterest) {
      const idx = tsMap.get(d.timestamp);
      if (idx !== undefined) {
        result[idx].openInterest = parseFloat(d.sumOpenInterest);
        result[idx].openInterestValue = parseFloat(d.sumOpenInterestValue);
      }
    }
  }
  
  if (globalLongShort && Array.isArray(globalLongShort)) {
    for (const d of globalLongShort) {
      const idx = tsMap.get(d.timestamp);
      if (idx !== undefined) {
        result[idx].longShortRatio = parseFloat(d.longShortRatio);
        result[idx].longAccount = parseFloat(d.longAccount);
        result[idx].shortAccount = parseFloat(d.shortAccount);
      }
    }
  }
  
  if (topTraderPosition && Array.isArray(topTraderPosition)) {
    for (const d of topTraderPosition) {
      const idx = tsMap.get(d.timestamp);
      if (idx !== undefined) {
        result[idx].topTraderRatio = parseFloat(d.longShortRatio);
        result[idx].topTraderLong = parseFloat(d.longAccount);
        result[idx].topTraderShort = parseFloat(d.shortAccount);
      }
    }
  }
  
  if (takerRatio && Array.isArray(takerRatio)) {
    for (const d of takerRatio) {
      const idx = tsMap.get(d.timestamp);
      if (idx !== undefined) {
        result[idx].takerRatio = parseFloat(d.buySellRatio);
        result[idx].takerBuyVol = parseFloat(d.buyVol);
        result[idx].takerSellVol = parseFloat(d.sellVol);
      }
    }
  }
  
  return result;
}

// ========== 恐惧贪婪指数 ==========

async function getFearGreedIndex(days = 30) {
  return fetch(`https://api.alternative.me/fng/?limit=${days}`);
}

// ========== Deribit 期权数据 ==========

/**
 * 获取 Deribit 期权数据
 * 使用 curl 通过代理请求
 */
async function getDeribitOptions(proxy) {
  if (!proxy) return null;
  
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    const cmd = `curl -s --max-time 30 -x ${proxy} 'https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option'`;
    
    exec(cmd, { maxBuffer: 100 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        console.error('Deribit curl error:', error.message);
        resolve(null);
        return;
      }
      
      try {
        const json = JSON.parse(stdout);
        if (json.result && Array.isArray(json.result)) {
          console.error('Deribit: 获取到', json.result.length, '个期权合约');
          resolve(analyzeOptionsData(json.result));
        } else {
          console.error('Deribit: 无有效数据');
          resolve(null);
        }
      } catch (e) {
        console.error('Deribit 解析错误:', e.message);
        resolve(null);
      }
    });
  });
}

/**
 * 分析期权数据，提取关键指标
 */
function analyzeOptionsData(options) {
  // 按到期日分组
  const byExpiry = {};
  
  for (const opt of options) {
    const parts = opt.instrument_name.split('-');
    if (parts.length < 4) continue;
    
    const expiry = parts[1];  // e.g., '24APR26'
    const strike = parseInt(parts[2]);
    const type = parts[3];  // 'C' or 'P'
    const oi = opt.open_interest || 0;
    const vol = opt.volume || 0;
    const iv = opt.mark_iv || 0;
    
    if (!byExpiry[expiry]) {
      byExpiry[expiry] = {
        contracts: 0,
        callOI: 0,
        putOI: 0,
        callVol: 0,
        putVol: 0,
        ivs: [],
        strikeData: {}
      };
    }
    
    byExpiry[expiry].contracts++;
    
    if (type === 'C') {
      byExpiry[expiry].callOI += oi;
      byExpiry[expiry].callVol += vol;
    } else {
      byExpiry[expiry].putOI += oi;
      byExpiry[expiry].putVol += vol;
    }
    
    if (iv > 0) byExpiry[expiry].ivs.push(iv);
    
    // 记录执行价数据
    if (!byExpiry[expiry].strikeData[strike]) {
      byExpiry[expiry].strikeData[strike] = { callOI: 0, putOI: 0 };
    }
    if (type === 'C') {
      byExpiry[expiry].strikeData[strike].callOI += oi;
    } else {
      byExpiry[expiry].strikeData[strike].putOI += oi;
    }
  }
  
  // 计算每个到期日的指标
  const result = {};
  
  for (const [expiry, data] of Object.entries(byExpiry)) {
    const totalOI = data.callOI + data.putOI;
    const totalVol = data.callVol + data.putVol;
    
    // Max Pain 计算
    let maxPain = 60000, maxLoss = 0;
    const strikes = Object.keys(data.strikeData).map(Number).sort((a,b) => a-b);
    
    for (let price = 40000; price <= 150000; price += 500) {
      let callLoss = 0, putLoss = 0;
      
      for (const strike of strikes) {
        const sd = data.strikeData[strike];
        if (strike > price) callLoss += sd.callOI;  // Call 作废
        if (strike < price) putLoss += sd.putOI;    // Put 作废
      }
      
      const totalLoss = callLoss + putLoss;
      if (totalLoss > maxLoss) {
        maxLoss = totalLoss;
        maxPain = price;
      }
    }
    
    // 关键价位 (净阻力/支撑)
    const resistance = [];
    const support = [];
    
    for (const [strike, sd] of Object.entries(data.strikeData)) {
      const net = sd.callOI - sd.putOI;
      if (net > 500) {
        resistance.push({ strike: parseInt(strike), netOI: net });
      }
      if (net < -500) {
        support.push({ strike: parseInt(strike), netOI: Math.abs(net) });
      }
    }
    
    resistance.sort((a, b) => b.netOI - a.netOI);
    support.sort((a, b) => b.netOI - a.netOI);
    
    result[expiry] = {
      // 基本信息
      expiryDate: expiry,
      expiryNote: `期权到期日 (${expiry})`,
      contractCount: data.contracts,
      
      // 持仓量数据
      totalOpenInterest: parseFloat(totalOI.toFixed(0)),
      totalOpenInterestNote: '总持仓量(未平仓合约数), 单位: BTC',
      callOpenInterest: parseFloat(data.callOI.toFixed(0)),
      callOpenInterestNote: '看涨期权持仓量, 单位: BTC',
      putOpenInterest: parseFloat(data.putOI.toFixed(0)),
      putOpenInterestNote: '看跌期权持仓量, 单位: BTC',
      putCallRatioOI: data.callOI > 0 ? parseFloat((data.putOI / data.callOI).toFixed(3)) : null,
      putCallRatioOINote: '看跌/看涨持仓量比值, 计算方式: 看跌期权持仓量 / 看涨期权持仓量',
      
      // 交易量数据
      totalVolume: parseFloat(totalVol.toFixed(0)),
      totalVolumeNote: '总交易量, 单位: BTC',
      callVolume: parseFloat(data.callVol.toFixed(0)),
      callVolumeNote: '看涨期权交易量, 单位: BTC',
      putVolume: parseFloat(data.putVol.toFixed(0)),
      putVolumeNote: '看跌期权交易量, 单位: BTC',
      putCallRatioVolume: data.callVol > 0 ? parseFloat((data.putVol / data.callVol).toFixed(3)) : null,
      putCallRatioVolumeNote: '看跌/看跌交易量比值, 计算方式: 看跌期权交易量 / 看涨期权交易量',
      
      // 隐含波动率
      averageImpliedVolatility: data.ivs.length > 0 ? parseFloat((data.ivs.reduce((a,b) => a+b, 0) / data.ivs.length).toFixed(1)) : null,
      averageImpliedVolatilityNote: '平均隐含波动率(%), 所有期权合约隐含波动率的算术平均值',
      
      // 最大痛点
      maxPainPrice: maxPain,
      maxPainPriceNote: '期权最大痛点价格, 到期时期权买方总收益最大(卖方损失最大)的价格点位',
      
      // 关键价位
      topResistance: resistance.slice(0, 3).map(r => ({ strikePrice: r.strike, netCallOI: parseFloat(r.netOI.toFixed(0)) })),
      topResistanceNote: '主要阻力位, 看涨期权净持仓(看涨OI - 看跌OI)为正且较大的执行价',
      topSupport: support.slice(0, 3).map(s => ({ strikePrice: s.strike, netPutOI: parseFloat(s.netOI.toFixed(0)) })),
      topSupportNote: '主要支撑位, 看跌期权净持仓(看跌OI - 看涨OI)为正且较大的执行价'
    };
  }
  
  // 找出最大的两个到期日
  const sorted = Object.entries(result)
    .sort((a, b) => b[1].totalOpenInterest - a[1].totalOpenInterest);
  
  const top2 = sorted.slice(0, 2).map(([expiry, data]) => ({
    expiry,
    ...data
  }));
  
  return top2;
}

// ========== 主数据获取 ==========

async function getEnhancedAnalysis(proxy = null) {
  const result = {
    timestamp: toBeijingTime(new Date()),
    priceHistory: null,
    kline4h: null,
    fearGreedIndex: null,
    options: null,
    fibonacci: null,
    dataSource: {
      price: 'Unknown',
      sentiment: 'Unknown'
    }
  };

  try {
    // ===== 优先尝试 OKX (无地区限制) =====
    let dailyData = null;
    let kline4h = null;
    
    if (proxy) {
      console.error('尝试 OKX 数据源...');
      try {
        dailyData = await getDailyDataOKX(proxy);
        kline4h = await get4hDataOKX(proxy);
        activeDataSource = 'OKX';
        result.dataSource.price = 'OKX';
        result.dataSource.sentiment = 'OKX (via proxy)';
        console.error('OKX 数据获取成功');
      } catch (e) {
        console.error('OKX 失败:', e.message);
        console.error('回退到 Binance...');
        
        // ===== 回退到 Binance =====
        try {
          dailyData = await getDailyData(proxy);
          kline4h = await get4hData(proxy);
          activeDataSource = 'Binance';
          result.dataSource.price = 'Binance Futures';
          result.dataSource.sentiment = 'Binance Futures (via proxy)';
        } catch (e2) {
          console.error('Binance 也失败:', e2.message);
        }
      }
    }
    
    // ===== 其他数据源（无需代理或使用代理） =====
    const [fngData, optionsData, fibData] = await Promise.all([
      getFearGreedIndex(30).catch(e => { console.error('FGI error:', e.message); return null; }),
      proxy ? getDeribitOptions(proxy).catch(e => { console.error('Options error:', e.message); return null; }) : Promise.resolve(null),
      getFibonacciAnalysis().catch(e => { console.error('Fibonacci error:', e.message); return null; })
    ]);

    if (dailyData) {
      result.priceHistory = {
        current: dailyData.current,
        days: dailyData.history.length,
        volume24h: dailyData.volume24h,
        history: dailyData.history,
        statistics: dailyData.statistics,
        indicators: dailyData.indicators
      };
    }

    result.kline4h = kline4h;

    if (fngData?.data) {
      const fngValues = fngData.data.map(d => parseInt(d.value));
      const current = fngValues[0];
      const max30d = Math.max(...fngValues);
      const min30d = Math.min(...fngValues);
      const avg30d = fngValues.reduce((a, b) => a + b, 0) / fngValues.length;
      
      result.fearGreedIndex = {
        current: current,
        classification: fngData.data[0].value_classification,
        statistics: {
          avg30d: parseFloat(avg30d.toFixed(1)),
          max30d: max30d,
          min30d: min30d,
          rangePosition: parseFloat(((current - min30d) / (max30d - min30d) * 100).toFixed(0))
        }
      };
    }

    // 期权数据
    if (optionsData && Array.isArray(optionsData)) {
      result.options = optionsData;
    }

    // 斐波那契数据
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
  
  out += '═'.repeat(70) + '\n';
  out += '              ₿ 比特币市场数据 v4\n';
  out += '═'.repeat(70) + '\n\n';
  
  out += `📅 ${data.timestamp}\n\n`;
  
  // 价格统计
  if (data.priceHistory) {
    const ph = data.priceHistory;
    const stats = ph.statistics;
    const ind = ph.indicators;
    
    out += '── 📈 价格统计 ──\n';
    out += `   当前价格: $${ph.current.toLocaleString()}\n\n`;
    
    out += `   14日: $${stats.days14.price.min.toLocaleString()} - $${stats.days14.price.max.toLocaleString()}`;
    out += ` | 均值: $${stats.days14.price.avg.toLocaleString()}`;
    out += ` | 位置: ${stats.days14.price.rangePosition}%\n`;
    
    out += `   30日: $${stats.days30.price.min.toLocaleString()} - $${stats.days30.price.max.toLocaleString()}`;
    out += ` | 均值: $${stats.days30.price.avg.toLocaleString()}`;
    out += ` | 位置: ${stats.days30.price.rangePosition}%\n`;
    
    // 交易量统计
    out += '\n── 📊 交易量统计 ──\n';
    if (ph.volume24h) {
      out += `   24h聚合: ${formatVolume(ph.volume24h)}`;
      if (stats.days14.volume.avg) {
        out += ` (14日均值的${stats.days14.volume.volumeRatio}x)`;
      }
      out += '\n';
    }
    out += `   14日: ${formatVolume(stats.days14.volume.min)} - ${formatVolume(stats.days14.volume.max)}`;
    out += ` | 均值: ${formatVolume(stats.days14.volume.avg)}\n`;
    out += `   30日: ${formatVolume(stats.days30.volume.min)} - ${formatVolume(stats.days30.volume.max)}`;
    out += ` | 均值: ${formatVolume(stats.days30.volume.avg)}\n`;
    
    // 技术指标
    out += '\n── 📈 技术指标 ──\n';
    if (ind.rsi14 !== null) {
      const rsiStatus = ind.rsi14 < 30 ? '⚠️ 超卖' : ind.rsi14 > 70 ? '⚠️ 超买' : '';
      out += `   RSI(14): ${ind.rsi14} ${rsiStatus}\n`;
    } else {
      out += `   RSI(14): N/A\n`;
    }
  }
  
  // 恐惧贪婪指数
  if (data.fearGreedIndex) {
    const fng = data.fearGreedIndex;
    out += '\n── 😰 恐惧贪婪指数 ──\n';
    const emoji = fng.current <= 25 ? '😱' : fng.current <= 45 ? '😰' : fng.current <= 55 ? '😐' : fng.current <= 75 ? '😊' : '🤑';
    out += `   当前: ${fng.current} (${fng.classification}) ${emoji}\n`;
    out += `   30日: 均值${fng.statistics.avg30d} | 区间${fng.statistics.min30d}-${fng.statistics.max30d}\n`;
  }
  
  // 期权数据
  if (data.options && data.options.length > 0) {
    out += '\n── 🔮 期权市场 (Deribit) ──\n';
    
    for (let i = 0; i < data.options.length; i++) {
      const opt = data.options[i];
      const label = i === 0 ? '近期主力' : '远期主力';
      
      out += `\n   【${opt.expiryDate} - ${label}】\n`;
      out += `   总持仓: ${opt.totalOpenInterest} BTC | 合约数: ${opt.contractCount}个\n`;
      out += `   看涨持仓: ${opt.callOpenInterest} BTC | 看跌持仓: ${opt.putOpenInterest} BTC\n`;
      out += `   Put/Call持仓比: ${opt.putCallRatioOI} (${opt.putCallRatioOI > 1 ? '看跌情绪占优' : '看涨情绪占优'})\n`;
      out += `   Put/Call交易比: ${opt.putCallRatioVolume} (当日交易情绪)\n`;
      
      if (opt.averageImpliedVolatility) {
        out += `   平均隐含波动率: ${opt.averageImpliedVolatility}% (市场对未来波动的预期)\n`;
      }
      
      out += `   最大痛点: $${opt.maxPainPrice.toLocaleString()}`;
      if (data.priceHistory?.current) {
        const diff = ((opt.maxPainPrice - data.priceHistory.current) / data.priceHistory.current * 100).toFixed(1);
        out += ` (${diff > 0 ? '+' : ''}${diff}%距现价)\n`;
      } else {
        out += '\n';
      }
      
      if (opt.topResistance && opt.topResistance.length > 0) {
        out += `   阻力位: ${opt.topResistance.map(r => `$${r.strikePrice/1000}K(净看涨${r.netCallOI})`).join(', ')}\n`;
      }
      if (opt.topSupport && opt.topSupport.length > 0) {
        out += `   支撑位: ${opt.topSupport.map(s => `$${s.strikePrice/1000}K(净看跌${s.netPutOI})`).join(', ')}\n`;
      }
    }
    
    out += '\n   📝 说明: Put/Call持仓比>1表示看跌情绪占优; 最大痛点往往是价格磁吸位。\n';
  }
  
  // 斐波那契分析
  if (data.fibonacci) {
    out += '\n── 📐 斐波那契回调位 ──\n';
    out += `   当前价格: $${data.fibonacci.currentPrice?.toLocaleString() || 'N/A'}\n\n`;
    
    // 显示各时间框架的波段背景
    const timeframes = ['daily', 'fourHour', 'weekly'];
    const timeframeNames = { daily: '日线', fourHour: '4小时', weekly: '周线' };
    
    for (const tf of timeframes) {
      const tfData = data.fibonacci[tf];
      if (tfData) {
        out += `   【${timeframeNames[tf]}】 `;
        out += `高点 $${tfData.swingHigh?.toLocaleString() || 'N/A'} ~ `;
        out += `低点 $${tfData.swingLow?.toLocaleString() || 'N/A'}`;
        if (tfData.swingRange) {
          out += ` (幅度 $${tfData.swingRange?.toLocaleString()})`;
        }
        out += '\n';
      }
    }
    
    out += '\n';
    
    // 表格头
    out += '   级别          日线            4小时           周线\n';
    out += '   ─────────────────────────────────────────────────────\n';
    
    const levelKeys = [
      'level_0_percent', 
      'level_23_6_percent', 
      'level_38_2_percent', 
      'level_50_percent',
      'level_61_8_percent', 
      'level_78_6_percent', 
      'level_100_percent'
    ];
    const levelLabels = ['0%', '23.6%', '38.2%', '50%', '61.8%', '78.6%', '100%'];
    
    for (let i = 0; i < levelKeys.length; i++) {
      const levelKey = levelKeys[i];
      const levelLabel = levelLabels[i];
      
      const dPrice = data.fibonacci.daily?.fibonacciLevels?.[levelKey]?.price;
      const h4Price = data.fibonacci.fourHour?.fibonacciLevels?.[levelKey]?.price;
      const wPrice = data.fibonacci.weekly?.fibonacciLevels?.[levelKey]?.price;
      
      out += `   ${levelLabel.padEnd(8)}  `;
      out += dPrice ? `$${dPrice.toLocaleString().padStart(12)}  ` : '            N/A  ';
      out += h4Price ? `$${h4Price.toLocaleString().padStart(12)}  ` : '            N/A  ';
      out += wPrice ? `$${wPrice.toLocaleString().padStart(12)}\n` : '            N/A\n';
    }
    
    // 使用说明
    out += '\n   📝 说明: 斐波那契回调位用于判断趋势中的潜在支撑/阻力位置。\n';
    out += '      61.8%(黄金分割)是最关键的支撑/阻力位。\n';
  }
  
  // 14日日线数据
  if (data.priceHistory?.history) {
    out += '\n── 📊 14日日线 ──\n';
    for (const h of data.priceHistory.history) {
      out += `   ${h.date}: O$${h.open.toLocaleString()} H$${h.high.toLocaleString()} L$${h.low.toLocaleString()} C$${h.close.toLocaleString()}`;
      if (h.fundingRate !== undefined) {
        const ratePct = (h.fundingRate * 100).toFixed(4);
        out += ` | 费率${ratePct}%`;
      }
      if (h.openInterest !== undefined) {
        out += ` | OI${(h.openInterest/1000).toFixed(1)}k`;
      }
      if (h.longShortRatio !== undefined) {
        out += ` | 多空比${h.longShortRatio.toFixed(2)}`;
      }
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
      if (k.fundingRate !== undefined) {
        const ratePct = (k.fundingRate * 100).toFixed(4);
        out += ` | 费率${ratePct}%`;
      }
      if (k.openInterest !== undefined) {
        out += ` | OI${(k.openInterest/1000).toFixed(1)}k`;
      }
      out += '\n';
    }
    if (data.kline4h.length > 7) {
      out += `   ... 共 ${data.kline4h.length} 根\n`;
    }
  }
  
  out += '\n' + '─'.repeat(70) + '\n';
  out += `📊 数据源: ${activeDataSource || 'N/A'} + alternative.me + CryptoCompare\n`;
  
  return out;
}

// ========== CLI 入口 ==========

function saveData(data, basePath) {
  const scriptDir = __dirname;
  const workspaceDir = basePath || path.resolve(scriptDir, '..', '..', '..');
  const dataDir = path.join(workspaceDir, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const dateStr = data.timestamp.split(' ')[0];
  const filePath = path.join(dataDir, `${dateStr}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  return filePath;
}

function parseArgs() {
  const args = { json: false, save: false, proxy: null };
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--save') args.save = true;
    else if (arg === '--proxy') args.proxy = process.argv[++i] || PROXY_DEFAULT;
    else if (arg.startsWith('--proxy=')) args.proxy = arg.split('=')[1];
  }
  if (!args.proxy) args.proxy = PROXY_DEFAULT;
  return args;
}

async function main() {
  const args = parseArgs();
  try {
    const data = await getEnhancedAnalysis(args.proxy);
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

module.exports = { getEnhancedAnalysis, formatAnalysis, saveData };

if (require.main === module) {
  main();
}