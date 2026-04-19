#!/usr/bin/env node
/**
 * 比特币市场数据获取 v5
 * 数据源: 
 *   - OKX CLI 工具 (K线、技术指标、资金费率、期权)
 *   - OKX API (多空比、Taker买卖比)
 *   - alternative.me (恐惧贪婪指数)
 * 
 * 改进:
 *   - 使用 OKX CLI 工具获取 K线和技术指标（服务端计算）
 *   - 简化代码，移除 Deribit 依赖
 *   - 统一数据源为 OKX
 * 
 * 用法: 
 *   node get_enhanced_analysis_v5.js [--json] [--save] [--proxy http://127.0.0.1:7890]
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
const OKX_INST_ID_SWAP = 'BTC-USDT-SWAP';
const OKX_INST_ID_SPOT = 'BTC-USDT';
const OKX_PROXY_SCRIPT = path.resolve(__dirname, '../../../scripts/okx-proxy.sh');

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

// ========== 技术指标计算（备用） ==========

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
  if (values.length < period + 1) return null;
  
  const changes = [];
  for (let i = 0; i < values.length - 1; i++) {
    changes.push(values[i] - values[i + 1]);
  }
  
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

// ========== K线数据获取 (OKX CLI) ==========

/**
 * 获取日线数据 (使用 OKX CLI)
 * 输出结构与原 getDailyDataOKX 完全一致
 * @param {string} proxy - 代理地址
 * @param {Map} fngMap - 恐慌指数日期映射表 (可选)
 */
async function getDailyDataCLI(proxy, fngMap = null) {
  const LIMIT_DISPLAY = 14;
  const LIMIT_STATS = 30;
  
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
  
  // 3. 获取技术指标 (OKX CLI 服务端计算)
  const [emaData, rsiData] = await Promise.all([
    okxCLIJson(`market indicator ema ${OKX_INST_ID_SPOT} --bar 1Dutc --params 7,12,20,26`, proxy).catch(() => null),
    okxCLIJson(`market indicator rsi ${OKX_INST_ID_SPOT} --bar 1Dutc`, proxy).catch(() => null)
  ]);
  
  // 4. 获取资金费率历史
  const fundingData = await okxCLIJson(`market funding-rate ${OKX_INST_ID_SWAP} --history --limit 90`, proxy).catch(() => null);
  
  // 5. 获取交易侧数据 (OKX API，CLI 不支持)
  // ⭐ 同时获取 1D (用于历史天数) 和 1H (用于最新一天) 两个周期
  const [openInterest, longShortRatio1D, longShortRatio1H, topTraderRatio1D, topTraderRatio1H, takerVolume1D, takerVolume1H] = await Promise.all([
    getOKXData(`/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1D`, proxy).catch(() => null),
    getOKXData(`/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1D`, proxy).catch(() => null),
    getOKXData(`/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1H`, proxy).catch(() => null),
    getOKXData(`/api/v5/rubik/stat/contracts/long-short-account-ratio-contract-top-trader?instId=${OKX_INST_ID_SWAP}&period=1D`, proxy).catch(() => null),
    getOKXData(`/api/v5/rubik/stat/contracts/long-short-account-ratio-contract-top-trader?instId=${OKX_INST_ID_SWAP}&period=1H`, proxy).catch(() => null),
    getOKXData(`/api/v5/rubik/stat/taker-volume?instId=${OKX_INST_ID_SWAP}&instType=CONTRACTS&ccy=BTC&period=1D`, proxy).catch(() => null),
    getOKXData(`/api/v5/rubik/stat/taker-volume?instId=${OKX_INST_ID_SWAP}&instType=CONTRACTS&ccy=BTC&period=1H`, proxy).catch(() => null)
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
    return `$${val.toFixed(0)}`;
  };
  
  // 展示数据：取前14条
  const displayData = allDataDesc.slice(0, LIMIT_DISPLAY);
  
  // EMA 计算需要从旧到新的顺序
  const allDataAsc = [...allDataDesc].reverse();
  const closes = allDataAsc.map(d => d.close);
  
  // 尝试使用 OKX CLI 的 EMA 数据
  let ema7 = [], ema12 = [], ema20 = [], ema26 = [];
  
  if (emaData?.data) {
    // OKX CLI 返回的 EMA 数据
    // 格式可能是 { "7": 69895.0, "12": 69372.3, ... } 或数组
    // 这里我们需要自己计算，因为 CLI 只返回最新值
    ema7 = calcEMASequence(closes, 7, LIMIT_DISPLAY);
    ema12 = calcEMASequence(closes, 12, LIMIT_DISPLAY);
    ema20 = calcEMASequence(closes, 20, LIMIT_DISPLAY);
    ema26 = calcEMASequence(closes, 26, LIMIT_DISPLAY);
  } else {
    // 备用：自己计算
    ema7 = calcEMASequence(closes, 7, LIMIT_DISPLAY);
    ema12 = calcEMASequence(closes, 12, LIMIT_DISPLAY);
    ema20 = calcEMASequence(closes, 20, LIMIT_DISPLAY);
    ema26 = calcEMASequence(closes, 26, LIMIT_DISPLAY);
  }
  
  // 构建历史数据
  const history = displayData.map((d, i) => {
    const entry = {
      date: d.date,
      timestamp: d.timestamp,
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      volume: i === 0 ? null : d.volume,  // USDT为单位的交易量
      volumeFormatted: i === 0 ? null : formatVol(d.volume)  // 格式化的交易量
    };
    
    if (i < ema7.length) entry.ema7 = parseFloat(ema7[i].toFixed(2));
    if (i < ema12.length) entry.ema12 = parseFloat(ema12[i].toFixed(2));
    if (i < ema20.length) entry.ema20 = parseFloat(ema20[i].toFixed(2));
    if (i < ema26.length) entry.ema26 = parseFloat(ema26[i].toFixed(2));
    
    // 添加恐慌指数值
    if (fngMap) {
      const fngValue = fngMap.get(d.date);
      if (fngValue !== undefined) entry.fearGreed = fngValue;
    }
    
    return entry;
  });
  
  // 按 timestamp 映射
  const tsMap = new Map(history.map((r, i) => [r.timestamp, i]));
  
  // 处理资金费率 (OKX CLI 返回数组)
  if (fundingData && Array.isArray(fundingData)) {
    for (const item of fundingData.slice(0, LIMIT_DISPLAY * 3)) {
      const ts = parseInt(item.fundingTime);
      // 找到匹配的日期
      for (const h of history) {
        // 资金费率时间戳对应的日期
        const itemDate = toBeijingDate(ts);
        if (h.date === itemDate) {
          h.fundingRate = parseFloat(item.fundingRate);
          break;
        }
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
  
  // 处理多空比
  // 历史天数用 1D 数据（通过时间戳匹配），最新一天用 1H 数据（取最近一小时）
  if (longShortRatio1D?.data && Array.isArray(longShortRatio1D.data)) {
    // 历史天数：通过时间戳匹配日级别数据
    for (const item of longShortRatio1D.data.slice(0, LIMIT_DISPLAY)) {
      const ts = parseInt(item[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined && idx > 0) {  // idx > 0 表示不是最新一天
        history[idx].longShortRatio = parseFloat(item[1]);
      }
    }
  }
  // 最新一天：使用 1H 数据的最新一小时
  if (longShortRatio1H?.data && Array.isArray(longShortRatio1H.data) && longShortRatio1H.data.length > 0) {
    const latestHour = longShortRatio1H.data[0];
    history[0].longShortRatio = parseFloat(latestHour[1]);
  }
  
  // 处理大户多空比
  if (topTraderRatio1D?.data && Array.isArray(topTraderRatio1D.data)) {
    for (const item of topTraderRatio1D.data.slice(0, LIMIT_DISPLAY)) {
      const ts = parseInt(item[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined && idx > 0) {
        history[idx].topTraderRatio = parseFloat(item[1]);
      }
    }
  }
  if (topTraderRatio1H?.data && Array.isArray(topTraderRatio1H.data) && topTraderRatio1H.data.length > 0) {
    const latestHour = topTraderRatio1H.data[0];
    history[0].topTraderRatio = parseFloat(latestHour[1]);
  }
  
  // 处理 Taker 买卖比
  if (takerVolume1D?.data && Array.isArray(takerVolume1D.data)) {
    for (const item of takerVolume1D.data.slice(0, LIMIT_DISPLAY)) {
      const ts = parseInt(item[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined && idx > 0) {
        const buyVol = parseFloat(item[1]);
        const sellVol = parseFloat(item[2]);
        history[idx].takerRatio = sellVol > 0 ? buyVol / sellVol : null;
        history[idx].takerBuyVol = buyVol;
        history[idx].takerBuyVolFormatted = formatVol(buyVol);
        history[idx].takerSellVol = sellVol;
        history[idx].takerSellVolFormatted = formatVol(sellVol);
      }
    }
  }
  if (takerVolume1H?.data && Array.isArray(takerVolume1H.data) && takerVolume1H.data.length > 0) {
    const latestHour = takerVolume1H.data[0];
    const buyVol = parseFloat(latestHour[1]);
    const sellVol = parseFloat(latestHour[2]);
    if (sellVol > 0) {
      history[0].takerRatio = buyVol / sellVol;
      history[0].takerBuyVol = buyVol;
      history[0].takerBuyVolFormatted = formatVol(buyVol);
      history[0].takerSellVol = sellVol;
      history[0].takerSellVolFormatted = formatVol(sellVol);
    }
  }
  
  // 计算统计
  const currentPrice = displayData[0].close;
  const prices14d = displayData.map(d => d.close);
  const maxPrice14d = Math.max(...prices14d);
  const minPrice14d = Math.min(...prices14d);
  const avgPrice14d = prices14d.reduce((a, b) => a + b, 0) / prices14d.length;
  
  const volumes14d = displayData.slice(1).map(d => d.volume).filter(v => v);
  const maxVolume14d = volumes14d.length > 0 ? Math.max(...volumes14d) : null;
  const minVolume14d = volumes14d.length > 0 ? Math.min(...volumes14d) : null;
  const avgVolume14d = volumes14d.length > 0 ? volumes14d.reduce((a, b) => a + b, 0) / volumes14d.length : null;
  
  const prices30d = allDataAsc.slice(-30).map(d => d.close);
  const maxPrice30d = Math.max(...prices30d);
  const minPrice30d = Math.min(...prices30d);
  const avgPrice30d = prices30d.reduce((a, b) => a + b, 0) / prices30d.length;
  
  const volumes30d = allDataAsc.slice(-30).slice(0, 29).map(d => d.volume).filter(v => v);
  const maxVolume30d = volumes30d.length > 0 ? Math.max(...volumes30d) : null;
  const minVolume30d = volumes30d.length > 0 ? Math.min(...volumes30d) : null;
  const avgVolume30d = volumes30d.length > 0 ? volumes30d.reduce((a, b) => a + b, 0) / volumes30d.length : null;
  
  // RSI - 从 OKX CLI 响应中提取
  let rsi14 = null;
  try {
    // OKX CLI RSI 格式: { data: [{ timeframes: { "1Dutc": { indicators: { RSI: [{ values: { "14": "57.56" }}] }}}}] }
    const rsiArr = Array.isArray(rsiData) ? rsiData : rsiData?.data;
    if (rsiArr?.[0]?.timeframes?.["1Dutc"]?.indicators?.RSI?.[0]?.values?.["14"]) {
      rsi14 = parseFloat(rsiArr[0].timeframes["1Dutc"].indicators.RSI[0].values["14"]);
    }
  } catch (e) {
    // 忽略解析错误
  }
  
  // 备用：自己计算
  if (rsi14 === null) {
    rsi14 = calcRSI(closes, 14) ? parseFloat(calcRSI(closes, 14).toFixed(1)) : null;
  }
  
  return {
    history: history,
    current: currentPrice,
    volume24h: volume24h,
    volume24hFormatted: formatVol(volume24h),
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
          maxFormatted: formatVol(maxVolume14d),
          min: minVolume14d ? parseFloat(minVolume14d.toFixed(0)) : null,
          minFormatted: formatVol(minVolume14d),
          avg: avgVolume14d ? parseFloat(avgVolume14d.toFixed(0)) : null,
          avgFormatted: formatVol(avgVolume14d),
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
      rsi14: rsi14
    }
  };
}

/**
 * 获取4小时数据 (使用 OKX CLI)
 */
async function get4hDataCLI(proxy) {
  const LIMIT = 14;
  
  const klinesData = await okxCLIJson(`market candles ${OKX_INST_ID_SWAP} --bar 4H --limit ${LIMIT}`, proxy);
  
  // OKX CLI 返回的是数组，不是 { data: [...] }
  const klinesArray = Array.isArray(klinesData) ? klinesData : klinesData?.data;
  
  if (!klinesArray || klinesArray.length === 0) {
    return null;
  }
  
  // 并行获取其他数据
  // ⭐ longShortRatio 和 takerVolume API 只支持 5m/1H/1D，不支持 4H
  // 所以用 1H 数据，取对应 4H 周期开始的那一小时填入
  const [fundingData, openInterest, longShortRatio1H, topTraderRatio4H, takerVolume1H] = await Promise.all([
    okxCLIJson(`market funding-rate ${OKX_INST_ID_SWAP}`, proxy).catch(() => null),
    getOKXData(`/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=4H`, proxy).catch(() => null),
    getOKXData(`/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1H`, proxy).catch(() => null),
    getOKXData(`/api/v5/rubik/stat/contracts/long-short-account-ratio-contract-top-trader?instId=${OKX_INST_ID_SWAP}&period=4H`, proxy).catch(() => null),
    getOKXData(`/api/v5/rubik/stat/taker-volume?instId=${OKX_INST_ID_SWAP}&instType=CONTRACTS&ccy=BTC&period=1H`, proxy).catch(() => null)
  ]);
  
  const result = [];
  
  // 交易量格式化函数
  const formatVol = (val) => {
    if (!val) return null;
    if (val >= 1e9) return `$${(val / 1e9).toFixed(2)}B`;
    if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
    if (val >= 1e3) return `$${(val / 1e3).toFixed(2)}K`;
    return `$${val.toFixed(0)}`;
  };
  
  for (let i = 0; i < klinesArray.length; i++) {
    const k = klinesArray[i];
    const ts = parseInt(k[0]);
    const vol = parseFloat(k[7]);  // USDT为单位的交易量
    const entry = {
      time: toBeijingDatetime(ts),
      timestamp: ts,
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: vol,
      volumeFormatted: formatVol(vol)
    };
    result.push(entry);
  }
  
  const tsMap = new Map(result.map((r, i) => [r.timestamp, i]));
  
  // 资金费率 (只填入最新一根)
  if (fundingData?.data?.[0]) {
    const rate = parseFloat(fundingData.data[0].fundingRate);
    const markPrice = parseFloat(fundingData.data[0].markPrice || 0);
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
  
  // 多空比 (API只支持 1H，用 1H 数据匹配 4H K线的时间戳)
  if (longShortRatio1H?.data && Array.isArray(longShortRatio1H.data)) {
    for (const item of longShortRatio1H.data.slice(0, LIMIT * 4)) {
      const ts = parseInt(item[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined) {
        result[idx].longShortRatio = parseFloat(item[1]);
      }
    }
  }
  
  // 大户多空比 (API支持 4H)
  if (topTraderRatio4H?.data && Array.isArray(topTraderRatio4H.data)) {
    for (const item of topTraderRatio4H.data.slice(0, LIMIT)) {
      const ts = parseInt(item[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined) {
        result[idx].topTraderRatio = parseFloat(item[1]);
      }
    }
  }
  
  // Taker 买卖比 (API只支持 1H，用 1H 数据匹配 4H K线的时间戳)
  if (takerVolume1H?.data && Array.isArray(takerVolume1H.data)) {
    for (const item of takerVolume1H.data.slice(0, LIMIT * 4)) {
      const ts = parseInt(item[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined) {
        const buyVol = parseFloat(item[1]);
        const sellVol = parseFloat(item[2]);
        result[idx].takerRatio = sellVol > 0 ? buyVol / sellVol : null;
        result[idx].takerBuyVol = buyVol;
        result[idx].takerBuyVolFormatted = formatVol(buyVol);
        result[idx].takerSellVol = sellVol;
        result[idx].takerSellVolFormatted = formatVol(sellVol);
      }
    }
  }
  
  return result;
}

// ========== 恐惧贪婪指数 ==========

async function getFearGreedIndex(days = 30) {
  return fetch(`https://api.alternative.me/fng/?limit=${days}`);
}

// ========== 斐波那契分析 (使用 OKX CLI K线数据) ==========

/**
 * 获取 OKX K线数据用于斐波那契分析
 */
async function getOKXCandles(bar, limit, proxy) {
  const data = await okxCLIJson(`market candles ${OKX_INST_ID_SPOT} --bar ${bar} --limit ${limit}`, proxy);
  
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
    high: parseFloat(swingHigh.toFixed(2)),
    low: parseFloat(swingLow.toFixed(2)),
    range: parseFloat(diff.toFixed(2)),
    levels: [
      parseFloat(swingHigh.toFixed(2)),                     // 0%
      parseFloat((swingHigh - diff * 0.236).toFixed(2)),    // 23.6%
      parseFloat((swingHigh - diff * 0.382).toFixed(2)),    // 38.2%
      parseFloat((swingHigh - diff * 0.5).toFixed(2)),      // 50%
      parseFloat((swingHigh - diff * 0.618).toFixed(2)),    // 61.8%
      parseFloat((swingHigh - diff * 0.786).toFixed(2)),    // 78.6%
      parseFloat(swingLow.toFixed(2))                       // 100%
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

// ========== 期权数据 (使用 Deribit，保持数据结构一致) ==========

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
    
    // 压缩后的数据结构
    result[expiry] = {
      expiry: expiry,
      contracts: data.contracts,
      oi: {
        total: parseFloat(totalOI.toFixed(0)),
        call: parseFloat(data.callOI.toFixed(0)),
        put: parseFloat(data.putOI.toFixed(0)),
        pcr: data.callOI > 0 ? parseFloat((data.putOI / data.callOI).toFixed(3)) : null
      },
      vol: {
        total: parseFloat(totalVol.toFixed(0)),
        call: parseFloat(data.callVol.toFixed(0)),
        put: parseFloat(data.putVol.toFixed(0)),
        pcr: data.callVol > 0 ? parseFloat((data.putVol / data.callVol).toFixed(3)) : null
      },
      iv: data.ivs.length > 0 ? parseFloat((data.ivs.reduce((a,b) => a+b, 0) / data.ivs.length).toFixed(1)) : null,
      maxPain: maxPain,
      resistance: resistance.slice(0, 3).map(r => [r.strike, parseFloat(r.netOI.toFixed(0))]),
      support: support.slice(0, 3).map(s => [s.strike, parseFloat(s.netOI.toFixed(0))])
    };
  }
  
  // 找出最大的两个到期日
  const sorted = Object.entries(result)
    .sort((a, b) => b[1].oi.total - a[1].oi.total);
  
  const top2 = sorted.slice(0, 2).map(([expiry, data]) => data);
  
  // 外层note
  return {
    note: 'expiry为到期日, oi/vol为持仓量/交易量(单位BTC), pcr为Put/Call Ratio, iv为平均隐含波动率(%), maxPain为最大痛点价格, resistance/support为[执行价,净持仓]',
    data: top2
  };
}

/**
 * 获取期权数据 (使用 Deribit，与原脚本完全一致)
 */
async function getOptionsDataCLI(proxy) {
  return getDeribitOptions(proxy);
}

// ========== 主数据获取 ==========

/**
 * 创建恐慌指数日期映射表
 */
function createFngMap(fngData) {
  if (!fngData?.data) return null;
  
  const map = new Map();
  for (const d of fngData.data) {
    const ts = parseInt(d.timestamp) * 1000;  // API返回的是秒级时间戳
    const date = toBeijingDate(ts);
    map.set(date, parseInt(d.value));
  }
  return map;
}

async function getEnhancedAnalysis(proxy = null) {
  const result = {
    timestamp: toBeijingTime(new Date()),
    priceHistory: null,
    kline4h: null,
    options: null,
    fibonacci: null,
    dataSource: {
      price: 'Unknown',
      sentiment: 'Unknown'
    }
  };

  try {
    // ===== 使用 OKX CLI 获取数据 =====
    console.error('使用 OKX CLI 获取数据...');
    
    // 先获取恐慌指数，创建日期映射
    const fngData = await getFearGreedIndex(30).catch(e => { console.error('FGI error:', e.message); return null; });
    const fngMap = createFngMap(fngData);
    
    const [dailyData, kline4h, optionsData, fibData] = await Promise.all([
      getDailyDataCLI(proxy, fngMap).catch(e => { console.error('日线数据错误:', e.message); return null; }),
      get4hDataCLI(proxy).catch(e => { console.error('4小时数据错误:', e.message); return null; }),
      getOptionsDataCLI(proxy).catch(e => { console.error('Options error:', e.message); return null; }),
      getFibonacciAnalysisCLI(proxy).catch(e => { console.error('Fibonacci error:', e.message); return null; })
    ]);
    
    activeDataSource = 'OKX CLI';
    result.dataSource.price = 'OKX CLI';
    result.dataSource.sentiment = 'OKX CLI + alternative.me';

    if (dailyData) {
      result.priceHistory = {
        current: dailyData.current,
        days: dailyData.history.length,
        volume24h: dailyData.volume24h,
        volume24hFormatted: dailyData.volume24hFormatted,
        history: dailyData.history,
        statistics: dailyData.statistics,
        indicators: dailyData.indicators
      };
    }

    result.kline4h = kline4h;

    // 恐慌指数已整合到 priceHistory.history 的每日记录中，不再单独输出

    if (optionsData && optionsData.data) {
      result.options = optionsData;
    }

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
  out += '              ₿ 比特币市场数据 v5 (OKX CLI)\n';
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
  if (data.options && data.options.data && data.options.data.length > 0) {
    out += '\n── 🔮 期权市场 (Deribit) ──\n';
    
    for (let i = 0; i < data.options.data.length; i++) {
      const opt = data.options.data[i];
      const label = i === 0 ? '近期主力' : '远期主力';
      
      out += `\n   【${opt.expiry} - ${label}】\n`;
      out += `   总持仓: ${opt.oi.total} BTC | 合约数: ${opt.contracts}个\n`;
      out += `   看涨持仓: ${opt.oi.call} BTC | 看跌持仓: ${opt.oi.put} BTC\n`;
      out += `   Put/Call持仓比: ${opt.oi.pcr} (${opt.oi.pcr > 1 ? '看跌情绪占优' : '看涨情绪占优'})\n`;
      out += `   Put/Call交易比: ${opt.vol.pcr} (当日交易情绪)\n`;
      
      if (opt.iv) {
        out += `   平均隐含波动率: ${opt.iv}% (市场对未来波动的预期)\n`;
      }
      
      out += `   最大痛点: $${opt.maxPain.toLocaleString()}`;
      if (data.priceHistory?.current) {
        const diff = ((opt.maxPain - data.priceHistory.current) / data.priceHistory.current * 100).toFixed(1);
        out += ` (${diff > 0 ? '+' : ''}${diff}%距现价)\n`;
      } else {
        out += '\n';
      }
      
      if (opt.resistance && opt.resistance.length > 0) {
        out += `   阻力位: ${opt.resistance.map(r => `$${r[0]/1000}K(净看涨${r[1]})`).join(', ')}\n`;
      }
      if (opt.support && opt.support.length > 0) {
        out += `   支撑位: ${opt.support.map(s => `$${s[0]/1000}K(净看跌${s[1]})`).join(', ')}\n`;
      }
    }
    
    out += '\n   📝 说明: Put/Call持仓比>1表示看跌情绪占优; 最大痛点往往是价格磁吸位。\n';
  }
  
  // 斐波那契分析
  if (data.fibonacci) {
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
  out += `📊 数据源: ${activeDataSource || 'N/A'} + alternative.me\n`;
  
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