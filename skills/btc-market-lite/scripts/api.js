/**
 * BTC 市场数据 API 模块
 * 供警报器规则和其他模块复用
 *
 * 2026-05-09 重构：
 * - fetch() 从 execSync(curl) 改为异步 http.request（消除事件循环阻塞）
 * - 合约统计方法(getOKXOpenInterest/getOKXTakerRatio/getOKXLongShortRatio/getOKXTopTraderRatio)增加 symbol 参数
 * - 新增 getOKXFundingRate(symbol) 方法
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// OKX API 代理配置（从环境变量读取，默认 7890）
const PROXY_URL = process.env.http_proxy || process.env.HTTP_PROXY || 'http://127.0.0.1:7890';

// 默认请求超时（毫秒）
const DEFAULT_TIMEOUT = 30000;

// ========== 工具函数 ==========

/**
 * fetch 底层实现（单次请求，无重试）
 * 通过 HTTP CONNECT 代理访问，使用 Node.js 原生 http/https 模块
 *
 * @param {string} url - 请求 URL
 * @param {number} timeout - 超时毫秒
 * @returns {Promise<object|string>} 解析后的 JSON 或原始文本
 */
function rawFetch(url, timeout) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const proxy = new URL(PROXY_URL);

    // 通过代理建立 CONNECT 隧道
    const connectReq = http.request({
      host: proxy.hostname,
      port: proxy.port,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`,
      timeout: timeout
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        connectReq.destroy();
        reject(new Error('请求超时'));
      }
    }, timeout);

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`代理 CONNECT 失败: ${res.statusCode}`));
        }
        socket.destroy();
        return;
      }

      const req = https.request({
        socket: socket,
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method: 'GET',
        headers: {
          'Host': target.hostname,
          'User-Agent': 'btc-alert-engine/2.0'
        }
      }, (targetRes) => {
        let body = '';
        targetRes.on('data', chunk => body += chunk);
        targetRes.on('end', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);

            // 检测 HTTP 429 Too Many Requests
            if (targetRes.statusCode === 429) {
              reject(new Error('Too Many Requests'));
              return;
            }

            try { resolve(JSON.parse(body)); }
            catch (e) { resolve(body); }
          }
        });
      });

      req.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(err.message || '请求失败'));
        }
      });

      req.end();
    });

    connectReq.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(err.message || '代理连接失败'));
      }
    });

    connectReq.on('timeout', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        connectReq.destroy();
        reject(new Error('代理连接超时'));
      }
    });

    connectReq.end();
  });
}

/**
 * 异步 fetch（带 429 自动重试）
 * 通过 HTTP CONNECT 代理访问，国内必需
 *
 * 429 重试策略：最多重试 2 次，间隔递增（3s → 6s）
 *
 * @param {string} url - 请求 URL
 * @param {number} [timeout=30000] - 超时毫秒
 * @returns {Promise<object|string>} 解析后的 JSON 或原始文本
 */
async function fetch(url, timeout = DEFAULT_TIMEOUT) {
  const MAX_RETRIES = 2;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      return await rawFetch(url, timeout);
    } catch (err) {
      const isRateLimit = err.message === 'Too Many Requests';
      if (isRateLimit && attempt <= MAX_RETRIES) {
        const delay = 3000 * attempt; // 3s → 6s
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

// ========== 参数清洗（硬性过滤）==========

/**
 * 清洗 symbol 参数
 * - 自动剥离 -USDT / -USDT-SWAP / -USD 后缀
 * - 自动转大写
 * - 防止规则传完整 instId 导致二次拼接
 */
const SYMBOL_CLEAN_WARNED = new Set();
function sanitizeSymbol(symbol) {
  if (typeof symbol !== 'string' || !symbol) return 'BTC';
  const original = symbol;
  let cleaned = symbol.replace(/-USDT(-SWAP)?$/i, '').replace(/-USD$/i, '');
  cleaned = cleaned.toUpperCase();
  if (cleaned !== original && !SYMBOL_CLEAN_WARNED.has(original)) {
    console.warn(`[api] symbol自动纠正: "${original}" → "${cleaned}" (防止instId二次拼接)`);
    SYMBOL_CLEAN_WARNED.add(original);
  }
  return cleaned;
}

/**
 * 清洗 instType 参数
 * - 默认走合约 (SWAP)
 * - 自动纠正常见错误（大小写、变体名称）
 */
const INSTTYPE_CLEAN_WARNED = new Set();
function sanitizeInstType(instType) {
  if (!instType) return 'SWAP'; // ⭐ 默认合约
  const upper = String(instType).toUpperCase();
  // 标准值原样返回
  if (upper === 'SWAP' || upper === 'SPOT') return upper;
  // 常见变体映射
  const aliasMap = {
    'CONTRACTS': 'SWAP', 'FUTURES': 'SWAP', 'PERPETUAL': 'SWAP',
    'PERP': 'SWAP', 'MARGIN': 'SPOT',
  };
  if (aliasMap[upper]) {
    const mapped = aliasMap[upper];
    if (!INSTTYPE_CLEAN_WARNED.has(upper)) {
      console.warn(`[api] instType自动纠正: "${instType}" → "${mapped}"`);
      INSTTYPE_CLEAN_WARNED.add(upper);
    }
    return mapped;
  }
  // 无法识别的值 → 默认 SWAP
  if (!INSTTYPE_CLEAN_WARNED.has(instType)) {
    console.warn(`[api] instType无法识别: "${instType}" → 默认"SWAP"`);
    INSTTYPE_CLEAN_WARNED.add(instType);
  }
  return 'SWAP';
}

/**
 * 清洗 period 参数（rubik/stat 端点用）
 * - 自动纠正大小写：'1d'→'1D', '1h'→'1H', '4h'→'4H', '1w'→'1W'
 * - 分钟级和月级保持原样：5m/15m/30m, 1M/3M
 */
const PERIOD_NORMALIZE_MAP = {
  '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6H', '12h': '12H',
  '1d': '1D', '1w': '1W', '3w': '3W',
};
function sanitizePeriod(period) {
  if (!period) return '1D';
  return PERIOD_NORMALIZE_MAP[period] || period;
}

// ========== OKX Market API (K线/价格) ==========

/**
 * 获取K线数据（底层使用 OKX API）
 * @param {string} symbol - 币种 (BTC)，自动清洗
 * @param {string} interval - 时间间隔: 1m, 5m, 15m, 1h, 4h, 1d
 * @param {number} limit - 数据条数
 * @param {string} instType - 默认 SWAP
 * @returns {Promise<Array>} K线数据数组，从新到旧
 */
async function getKlines(symbol = 'BTC', interval = '1h', limit = 30, instType = 'SWAP') {
  // 大小写规范化：'1D'/'1d'/'1H'/'1h' 统一处理
  interval = interval.toLowerCase();

  // OKX interval 映射
  const intervalMap = {
    '1m': '1m',
    '5m': '5m',
    '15m': '15m',
    '1h': '1H',
    '2h': '2H',
    '4h': '4H',
    '1d': '1D'
  };
  
  const okxInterval = intervalMap[interval];
  if (!okxInterval) {
    throw new Error(`不支持的间隔: ${interval}，支持: 1m, 5m, 15m, 1h, 2h, 4h, 1d`);
  }
  
  // 内部调用 OKX K线接口（symbol 会在 getOKXKlines 内清洗）
  return getOKXKlines(symbol, okxInterval, limit, instType);
}

/**
 * 获取实时价格（底层使用 OKX API）
 * @param {string} symbol - 币种 (BTC)，自动清洗
 * @param {string} instType - 默认 SWAP
 * @returns {Promise<Object>} 价格信息
 */
async function getTicker(symbol = 'BTC', instType = 'SWAP') {
  return getOKXTicker(symbol, instType);
}

/**
 * 获取24小时交易量（聚合小时数据）
 * @param {string} symbol - 币种 (BTC)
 * @returns {Promise<Object>} 交易量信息
 */
async function get24hVolume(symbol = 'BTC') {
  // 使用 OKX 1H K线，24条 = 近24小时
  const candles = await getOKXKlines(symbol, '1H', 24);
  
  const volume24h = candles.reduce((sum, c) => sum + (c.volume || 0), 0);
  
  return {
    symbol: symbol,
    volume24h: volume24h,
    hourlyData: candles.map(c => ({
      time: c.time,
      datetime: c.datetime,
      volume: c.volume,
      close: c.close
    }))
  };
}

/**
 * 获取历史价格数据（底层使用 OKX API）
 * @param {string} symbol - 币种 (BTC)
 * @param {number} days - 天数
 * @returns {Promise<Object>} 历史价格数据
 */
async function getPriceHistory(symbol = 'BTC', days = 30) {
  // OKX 1D K线直接对应每日数据
  const candles = await getOKXKlines(symbol, '1D', days);
  
  return {
    symbol: symbol,
    prices: candles.map(c => c.close),
    timestamps: candles.map(c => c.time),
    volumes: candles.map(c => c.volume),   // volCcy，单位USDT
    highs: candles.map(c => c.high),
    lows: candles.map(c => c.low),
    _actualDays: candles.length,  // 实际返回天数（OKX limit有上限）
    history: candles.map(c => ({
      date: new Date(c.time).toISOString().split('T')[0],
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume
    }))
  };
}

/**
 * 获取恐惧贪婪指数
 * @param {number} days - 天数
 * @returns {Promise<Object>} 恐惧贪婪指数数据
 */
async function getFearGreedIndex(days = 30) {
  const data = await fetch(`https://api.alternative.me/fng/?limit=${days}`);
  
  return {
    current: parseInt(data.data[0].value),
    classification: data.data[0].value_classification,
    history: data.data.map(d => ({
      date: new Date(d.timestamp * 1000).toISOString().split('T')[0],
      value: parseInt(d.value),
      classification: d.value_classification
    }))
  };
}

// ========== OKX K线 & 价格 API（需要代理）==========

/**
 * 获取 OKX K线数据
 * @param {string} symbol - 币种 (BTC)
 * @param {string} interval - 时间间隔: 1m, 5m, 15m, 1h/1H, 2h/2H, 4h/4H, 1d/1D, etc（小写自动映射为大写）
 * @param {number} limit - 数据条数
 * @param {string} instType - 默认 SWAP（自动清洗）
 * @returns {Promise<Array>} K线数据数组，从新到旧
 */
async function getOKXKlines(symbol = 'BTC', interval = '1H', limit = 100, instType = 'SWAP') {
  // ⭐ 参数硬性过滤：清洗 symbol 和 instType
  symbol = sanitizeSymbol(symbol);
  instType = sanitizeInstType(instType);

  // ⭐ 参数位置错位检测：防止调用时漏传 COIN 或 interval/instType 互换
  //   正确签名: getOKXKlines(symbol, interval, limit, instType)
  //   常见错误: getOKXKlines('1m', 3, 'SWAP')  — 漏传 symbol
  //   常见错误: getOKXKlines(COIN, 'SWAP', '1m', 3) — interval/instType 互换
  if (typeof symbol === 'object' && symbol !== null) {
    throw new Error(`getOKXKlines: symbol 不能是对象，请使用位置参数调用: getOKXKlines(symbol, interval, limit, instType)`);
  }
  if (typeof interval === 'object' && interval !== null) {
    throw new Error(`getOKXKlines: interval 不能是对象，请使用位置参数调用: getOKXKlines(symbol, interval, limit, instType)`);
  }
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new Error(`getOKXKlines: limit 必须是正整数，收到 ${JSON.stringify(limit)}。检查参数顺序: (symbol, interval, limit, instType)`);
  }
  // 检测 interval 位置传了 instType 值（'SWAP'/'SPOT'）
  if (typeof interval === 'string' && (interval.toUpperCase() === 'SWAP' || interval.toUpperCase() === 'SPOT')) {
    throw new Error(`getOKXKlines: interval 收到 '${interval}'，疑似 interval/instType 参数互换。正确顺序: (symbol, interval, limit, instType)`);
  }

  // 小写→大写自动映射，防止 '1h'/'4h' 等小写参数导致 OKX API 报 Parameter bar error
  const normalizeMap = {
    '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
    '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6H', '12h': '12H',
    '1d': '1D', '1w': '1W',
    // 已是大写的也保留
    '1H': '1H', '2H': '2H', '4H': '4H', '6H': '6H', '12H': '12H',
    '1D': '1D', '1W': '1W',
  };
  const normalizedInterval = normalizeMap[interval] || interval;
  const instId = instType === 'SWAP' ? `${symbol}-USDT-SWAP` : `${symbol}-USDT`;
  const url = `https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=${normalizedInterval}&limit=${limit}`;
  const data = await fetch(url);
  
  if (data.code !== '0') {
    throw new Error(`OKX K线 API错误: ${data.msg}`);
  }
  
  // OKX返回格式: [ts, o, h, l, c, vol(BTC), volCcy(USDT), volCcyQuote, confirm]
  // 注意：文档说index5是volCcy，但实测index5是vol(BTC)，index6才是volCcy(USDT)
  return data.data.map(candle => ({
    time: parseInt(candle[0]),
    datetime: new Date(parseInt(candle[0])).toISOString(),
    open: parseFloat(candle[1]),
    high: parseFloat(candle[2]),
    low: parseFloat(candle[3]),
    close: parseFloat(candle[4]),
    volume: parseFloat(candle[6]),   // volCcy (USDT成交额)
    volumeBTC: parseFloat(candle[5]) // vol (BTC成交量，备用)
  }));
}

/**
 * 获取 OKX Ticker（实时价格）
 * @param {string} symbol - 币种 (BTC)
 * @param {string} instType - 默认 SWAP（自动清洗）
 * @returns {Promise<Object>} 价格信息
 */
async function getOKXTicker(symbol = 'BTC', instType = 'SWAP') {
  // ⭐ 参数硬性过滤：清洗 symbol 和 instType
  symbol = sanitizeSymbol(symbol);
  instType = sanitizeInstType(instType);

  const instId = instType === 'SWAP' ? `${symbol}-USDT-SWAP` : `${symbol}-USDT`;
  const url = `https://www.okx.com/api/v5/market/ticker?instId=${instId}`;
  const data = await fetch(url);
  
  if (data.code !== '0') {
    throw new Error(`OKX Ticker API错误: ${data.msg}`);
  }
  
  const t = data.data[0];
  const lastPx = parseFloat(t.last);
  const open24h = parseFloat(t.open24h);

  // 计算 change1h：获取最近2根1H K线进行比较
  let change1h = null;
  try {
    const klineUrl = `https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=1H&limit=2`;
    const klineData = await fetch(klineUrl);
    if (klineData.code === '0' && klineData.data.length >= 2) {
      const currentClose = parseFloat(klineData.data[0][4]);
      const hourAgoClose = parseFloat(klineData.data[1][4]);
      if (hourAgoClose > 0) {
        change1h = ((currentClose - hourAgoClose) / hourAgoClose * 100).toFixed(2);
      }
    }
  } catch (e) {
    // 计算失败不影响主流程
  }

  return {
    symbol: symbol,
    price: lastPx,
    high: parseFloat(t.high24h),
    low: parseFloat(t.low24h),
    change1h: change1h,
    change24h: ((lastPx - open24h) / open24h * 100).toFixed(2),
    change7d: null,
    volume24h: parseFloat(t.volCcy24h),
    volume: parseFloat(t.vol24h),
    askPx: parseFloat(t.askPx),
    bidPx: parseFloat(t.bidPx),
    open24h: open24h,
    sodUtc0: parseFloat(t.sodUtc0),
    sodUtc8: parseFloat(t.sodUtc8),
    timestamp: new Date(parseInt(t.ts)).toISOString()
  };
}

// ========== OKX 合约统计 API（需要代理）==========

/**
 * 获取 OKX 持仓量数据
 * @param {string} symbol - 币种 (BTC, ETH, STRK, etc.)
 * @returns {Promise<Object>} 持仓量数据
 */
async function getOKXOpenInterest(symbol = 'BTC') {
  symbol = sanitizeSymbol(symbol);
  const url = `https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${symbol}&period=1D`;
  const data = await fetch(url);
  
  if (data.code !== '0') {
    throw new Error(`OKX API错误: ${data.msg}`);
  }
  
  // 返回最近2天的数据（最新和前一天）
  const latest = data.data[0];
  const prev = data.data[1];
  
  const oiLatest = parseFloat(latest[1]); // API 返回数组：[ts, OI, volume]
  const oiPrev = parseFloat(prev[1]);
  const changePercent = ((oiLatest - oiPrev) / oiPrev * 100).toFixed(2);
  
  return {
    currentOI: oiLatest,
    prevOI: oiPrev,
    change24h: parseFloat(changePercent),
    volume: parseFloat(latest[2]),
    timestamp: new Date().toISOString(),
    history: data.data.slice(0, 7).map(d => ({
      date: new Date(parseInt(d[0])).toISOString().split("T")[0],
      openInterest: parseFloat(d[1]),
      volume: parseFloat(d[2])
    }))
  };
}

/**
 * 获取 OKX Taker 买卖比数据
 * @param {string} symbol - 币种 (BTC, ETH, STRK, etc.)
 * @param {string} [period='1D'] - 时间粒度: 5m, 1H, 1D, 1W, 1M
 * @param {number} [limit=7] - 历史数据条数
 * @returns {Promise<Object>} Taker买卖比数据
 */
async function getOKXTakerRatio(symbol = 'BTC', period = '1D', limit = 7) {
  symbol = sanitizeSymbol(symbol);
  period = sanitizePeriod(period);
  const url = `https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=${symbol}-USDT-SWAP&instType=CONTRACTS&ccy=${symbol}&period=${period}`;
  const data = await fetch(url);
  
  if (data.code !== '0') {
    throw new Error(`OKX API错误: ${data.msg}`);
  }
  
  // 返回最近2条数据（最新和前一条）
  const latest = data.data[0];
  const prev = data.data[1];
  
  const buyVol = parseFloat(latest[1]); // API 返回数组：[ts, buyVol, sellVol]
  const sellVol = parseFloat(latest[2]);
  const ratio = buyVol / sellVol;
  
  const prevBuyVol = parseFloat(prev[1]);
  const prevSellVol = parseFloat(prev[2]);
  const prevRatio = prevBuyVol / prevSellVol;

  // 日期格式自适应：日级及以上用 YYYY-MM-DD，小时/分钟级用完整 ISO
  const isDailyOrAbove = /^\d+[DWM]$/.test(period);
  const fmtDate = (ts) => {
    const d = new Date(parseInt(ts));
    return isDailyOrAbove ? d.toISOString().split('T')[0] : d.toISOString();
  };
  
  return {
    currentRatio: parseFloat(ratio.toFixed(2)),
    prevRatio: parseFloat(prevRatio.toFixed(2)),
    buyVolume: buyVol,
    sellVolume: sellVol,
    change: parseFloat(((ratio - prevRatio) / prevRatio * 100).toFixed(2)),
    timestamp: new Date().toISOString(),
    history: data.data.slice(0, limit).map(d => ({
      date: fmtDate(d[0]),
      buyVol: parseFloat(d[1]),
      sellVol: parseFloat(d[2]),
      ratio: parseFloat((parseFloat(d[1]) / parseFloat(d[2])).toFixed(2))
    }))
  };
}

/**
 * 获取 OKX 多空比数据
 * @param {string} symbol - 币种 (BTC, ETH, STRK, etc.)
 * @returns {Promise<Object>} 多空比数据
 * 
 * OKX API 返回格式: [["1777046400000","0.81"], ...]
 * 注意：返回的是比率值，不是 longAccount/shortAccount 分开的数据
 */
async function getOKXLongShortRatio(symbol = 'BTC') {
  symbol = sanitizeSymbol(symbol);
  const url = `https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${symbol}&period=1D`;
  const data = await fetch(url);
  
  if (data.code !== '0') {
    throw new Error(`OKX API错误: ${data.msg}`);
  }
  
  // OKX API 返回: [timestamp, ratio] 两个字段
  const latest = data.data[0];
  const prev = data.data[1];
  
  const currentRatio = parseFloat(latest[1]);
  const prevRatio = parseFloat(prev[1]);
  
  return {
    currentRatio: parseFloat(currentRatio.toFixed(2)),
    prevRatio: parseFloat(prevRatio.toFixed(2)),
    longAccount: null,  // OKX 比率API不提供此字段
    shortAccount: null, // OKX 比率API不提供此字段
    timestamp: new Date().toISOString(),
    history: data.data.slice(0, 7).map(d => ({
      date: new Date(parseInt(d[0])).toISOString().split("T")[0],
      ratio: parseFloat(d[1])
    }))
  };
}

/**
 * 获取 OKX 顶级交易者多空比数据
 * @param {string} symbol - 币种 (BTC, ETH, STRK, etc.)
 * @returns {Promise<Object>} 顶级交易者多空比数据
 */
async function getOKXTopTraderRatio(symbol = 'BTC') {
  symbol = sanitizeSymbol(symbol);
  const url = `https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${symbol}&period=1D`;
  const data = await fetch(url);
  
  if (data.code !== '0') {
    throw new Error(`OKX API错误: ${data.msg}`);
  }
  
  // OKX API 返回: [timestamp, ratio] 两个字段
  const latest = data.data[0];
  const prev = data.data[1];
  
  const currentRatio = parseFloat(latest[1]);
  const prevRatio = parseFloat(prev[1]);
  
  return {
    currentRatio: parseFloat(currentRatio.toFixed(3)),
    prevRatio: parseFloat(prevRatio.toFixed(3)),
    longAccount: null,  // OKX 比率API不提供此字段
    shortAccount: null, // OKX 比率API不提供此字段
    change24h: parseFloat(((currentRatio - prevRatio) / prevRatio * 100).toFixed(3)),
    timestamp: new Date().toISOString(),
    history: data.data.slice(0, 7).map(d => ({
      date: new Date(parseInt(d[0])).toISOString().split("T")[0],
      ratio: parseFloat(d[1])
    }))
  };
}

/**
 * 获取 OKX 资金费率
 * @param {string} symbol - 币种 (BTC, ONDO, etc.)
 * @returns {Promise<Object>} 资金费率数据
 */
async function getOKXFundingRate(symbol = 'BTC') {
  symbol = sanitizeSymbol(symbol);
  const url = `https://www.okx.com/api/v5/public/funding-rate?instId=${symbol}-USDT-SWAP`;
  const data = await fetch(url);
  
  if (data.code !== '0') {
    throw new Error(`OKX 资金费率 API错误: ${data.msg}`);
  }
  
  if (!data.data || data.data.length === 0) {
    throw new Error(`OKX 资金费率 API无数据: ${symbol}`);
  }
  
  const f = data.data[0];
  const fundingRate = parseFloat(f.fundingRate);
  
  return {
    symbol: symbol,
    fundingRate: fundingRate,
    nextFundingRate: parseFloat(f.nextFundingRate),
    fundingTime: f.fundingTime,
    nextFundingTime: f.nextFundingTime,
    instId: f.instId,
    method: f.method,
    // 便捷判断
    isLongPay: fundingRate > 0,  // 正费率=多头付费
    isShortPay: fundingRate < 0, // 负费率=空头付费
    timestamp: new Date().toISOString()
  };
}

/**
 * 获取BTC合约清算数据（OKX API，需要代理）
 * 返回最近清算订单的统计 + 热力图
 */
async function getOKXLiquidation() {
  const url = `https://www.okx.com/api/v5/public/liquidation-orders?instFamily=BTC-USDT&instType=SWAP&state=filled&limit=100`;
  const data = await fetch(url, 20000);
  
  if (!data || data.code !== '0' || !data.data || !data.data[0]?.details) {
    return null;
  }
  
  const details = data.data[0].details;
  const now = Date.now();
  const thirtyMinAgo = now - 30 * 60 * 1000;
  
  let longLiq = 0, shortLiq = 0;
  let recentLongLiq = 0, recentShortLiq = 0;
  
  for (const d of details) {
    const sz = parseFloat(d.sz);
    const ts = parseInt(d.ts);
    if (d.posSide === 'long') {
      longLiq += sz;
      if (ts >= thirtyMinAgo) recentLongLiq += sz;
    } else {
      shortLiq += sz;
      if (ts >= thirtyMinAgo) recentShortLiq += sz;
    }
  }
  
  return {
    totalOrders: details.length,
    longLiquidation: parseFloat(longLiq.toFixed(2)),
    shortLiquidation: parseFloat(shortLiq.toFixed(2)),
    recent30m: {
      longLiquidation: parseFloat(recentLongLiq.toFixed(2)),
      shortLiquidation: parseFloat(recentShortLiq.toFixed(2))
    },
    netLiquidation: parseFloat((longLiq - shortLiq).toFixed(2))
  };
}

/**
 * 获取跨交易所全球24h交易量（CryptoCompare 聚合数据）
 * 国内可用，无需代理，不需要 API Key
 * @param {string} symbol - 币种 (BTC, ETH, etc.)
 * @returns {Promise<Object>} { price, volume24h, totalVolume24hBtc, topTierVolume24h }
 */
async function getGlobalVolume(symbol = 'BTC') {
  symbol = sanitizeSymbol(symbol);
  const data = await fetch(`https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${symbol}&tsyms=USD`);
  const raw = data.RAW?.[symbol]?.USD;
  if (!raw) throw new Error(`CryptoCompare 返回数据异常: 缺少 ${symbol}`);
  return {
    symbol,
    price: raw.PRICE,
    volume24h: raw.TOTALVOLUME24HTO,        // 跨交易所总成交额(USD)
    totalVolume24hBtc: raw.TOTALVOLUME24H,   // 跨交易所总成交量(BTC)
    topTierVolume24h: raw.VOLUME24HOURTO,    // TopTier 交易所成交额(USD)
    change24h: ((raw.PRICE - raw.OPEN24HOUR) / raw.OPEN24HOUR * 100).toFixed(2),
    change1h: ((raw.PRICE - raw.OPENHOUR) / raw.OPENHOUR * 100).toFixed(2),
    high24h: raw.HIGH24HOUR,
    low24h: raw.LOW24HOUR,
    timestamp: new Date().toISOString()
  };
}

/**
 * 获取本地时区(Asia/Shanghai)的今日日期字符串
 * 修复 lifetime() 中的时区问题：toISOString()返回UTC日期，导致UTC+8下日期不匹配
 * @returns {string} 格式 "YYYY-MM-DD"
 */
function getLocalDate() {
  const offsetMs = 8 * 60 * 60 * 1000; // UTC+8
  return new Date(Date.now() + offsetMs).toISOString().split('T')[0];
}

// ========== 导出 ==========

module.exports = {
  getKlines,
  getTicker,
  get24hVolume,
  getPriceHistory,
  getFearGreedIndex,
  fetch,
  // OKX K线 & 价格（需要代理）
  getOKXKlines,
  getOKXTicker,
  // OKX 合约统计（需要代理）
  getOKXOpenInterest,
  getOKXTakerRatio,
  getOKXLongShortRatio,
  getOKXTopTraderRatio,
  getOKXFundingRate,
  getOKXLiquidation,
  getGlobalVolume,
  getLocalDate
};
