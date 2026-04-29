/**
 * BTC 市场数据 API 模块
 * 供警报器规则和其他模块复用
 */

const https = require('https');
const { execSync } = require('child_process');

// OKX API 代理配置（从环境变量读取，默认 7890）
const PROXY_URL = process.env.http_proxy || process.env.HTTP_PROXY || 'http://127.0.0.1:7890';

// ========== 工具函数 ==========

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

// ========== CryptoCompare API ==========

/**
 * 获取K线数据（底层使用 OKX API）
 * @param {string} symbol - 币种 (BTC)
 * @param {string} interval - 时间间隔: 1m, 5m, 15m, 1h, 4h, 1d（自动映射到OKX格式）
 * @param {number} limit - 数据条数
 * @returns {Promise<Array>} K线数据数组，从新到旧
 */
async function getKlines(symbol = 'BTC', interval = '1h', limit = 30) {
  // CryptoCompare interval -> OKX interval 映射
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
  
  // 内部调用 OKX K线接口
  return getOKXKlines(symbol, okxInterval, limit);
}

/**
 * 获取实时价格（底层使用 OKX API）
 * @param {string} symbol - 币种 (BTC)
 * @returns {Promise<Object>} 价格信息
 */
async function getTicker(symbol = 'BTC') {
  return getOKXTicker(symbol);
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
 * @param {string} interval - 时间间隔: 1m, 5m, 15m, 1H, 2H, 4H, 1D, etc
 * @param {number} limit - 数据条数
 * @returns {Promise<Array>} K线数据数组，从新到旧
 */
async function getOKXKlines(symbol = 'BTC', interval = '1H', limit = 100) {
  const instId = `${symbol}-USDT`;
  const url = `https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=${interval}&limit=${limit}`;
  const result = execSync(`curl -s --max-time 30 --proxy "${PROXY_URL}" "${url}"`, {
    encoding: 'utf8',
    timeout: 35000
  });
  
  const data = JSON.parse(result);
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
 * @returns {Promise<Object>} 价格信息
 */
async function getOKXTicker(symbol = 'BTC') {
  const instId = `${symbol}-USDT`;
  const url = `https://www.okx.com/api/v5/market/ticker?instId=${instId}`;
  const result = execSync(`curl -s --max-time 30 --proxy "${PROXY_URL}" "${url}"`, {
    encoding: 'utf8',
    timeout: 35000
  });
  
  const data = JSON.parse(result);
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
    const klineResult = execSync(`curl -s --max-time 30 --proxy "${PROXY_URL}" "${klineUrl}"`, {
      encoding: 'utf8',
      timeout: 35000
    });
    const klineData = JSON.parse(klineResult);
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
 * @returns {Promise<Object>} 持仓量数据
 */
async function getOKXOpenInterest() {
  const url = 'https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1D';
  const result = execSync(`curl -s --max-time 30 --proxy "${PROXY_URL}" "${url}"`, {
    encoding: 'utf8',
    timeout: 35000
  });
  
  const data = JSON.parse(result);
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
 * @returns {Promise<Object>} Taker买卖比数据
 */
async function getOKXTakerRatio() {
  const url = 'https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=BTC-USDT-SWAP&instType=CONTRACTS&ccy=BTC&period=1D';
  const result = execSync(`curl -s --max-time 30 --proxy "${PROXY_URL}" "${url}"`, {
    encoding: 'utf8',
    timeout: 35000
  });
  
  const data = JSON.parse(result);
  if (data.code !== '0') {
    throw new Error(`OKX API错误: ${data.msg}`);
  }
  
  // 返回最近2天的数据（最新和前一天）
  const latest = data.data[0];
  const prev = data.data[1];
  
  const buyVol = parseFloat(latest[1]); // API 返回数组：[ts, buyVol, sellVol]
  const sellVol = parseFloat(latest[2]);
  const ratio = buyVol / sellVol;
  
  const prevBuyVol = parseFloat(prev[1]);
  const prevSellVol = parseFloat(prev[2]);
  const prevRatio = prevBuyVol / prevSellVol;
  
  return {
    currentRatio: parseFloat(ratio.toFixed(2)),
    prevRatio: parseFloat(prevRatio.toFixed(2)),
    buyVolume: buyVol,
    sellVolume: sellVol,
    change: parseFloat(((ratio - prevRatio) / prevRatio * 100).toFixed(2)),
    timestamp: new Date().toISOString(),
    history: data.data.slice(0, 7).map(d => ({
      date: new Date(parseInt(d[0])).toISOString().split("T")[0],
      buyVol: parseFloat(d[1]),
      sellVol: parseFloat(d[2]),
      ratio: parseFloat((parseFloat(d[1]) / parseFloat(d[2])).toFixed(2))
    }))
  };
}

/**
 * 获取 OKX 多空比数据
 * @returns {Promise<Object>} 多空比数据
 * 
 * OKX API 返回格式: [["1777046400000","0.81"], ...]
 * 注意：返回的是比率值，不是 longAccount/shortAccount 分开的数据
 */
async function getOKXLongShortRatio() {
  const url = 'https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1D';
  const result = execSync(`curl -s --max-time 30 --proxy "${PROXY_URL}" "${url}"`, {
    encoding: 'utf8',
    timeout: 35000
  });
  
  const data = JSON.parse(result);
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
 * 数据来源: OKX long-short-account-ratio (日线口径)
 * OKX API 返回格式: [["1777046400000","0.81"], ...] — [timestamp, ratio]
 * @returns {Promise<Object>} 顶级交易者多空比数据
 */
async function getOKXTopTraderRatio() {
  const url = 'https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1D';
  const result = execSync(`curl -s --max-time 30 --proxy "${PROXY_URL}" "${url}"`, {
    encoding: 'utf8',
    timeout: 35000
  });
  
  const data = JSON.parse(result);
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
 * 获取BTC合约清算数据（OKX API，需要代理）
 * 返回最近清算订单的统计 + 热力图
 */
async function getOKXLiquidation() {
  return new Promise((resolve) => {
    const url = `https://www.okx.com/api/v5/public/liquidation-orders?instFamily=BTC-USDT&instType=SWAP&state=filled&limit=100`;
    const cmd = `curl -s --max-time 15 --proxy "${PROXY_URL}" "${url}"`;
    const raw = execSync(cmd, { encoding: 'utf8', timeout: 20000 });
    
    try {
      const json = JSON.parse(raw);
      if (json.code !== '0' || !json.data || !json.data[0]?.details) {
        resolve(null);
        return;
      }
      
      const details = json.data[0].details;
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
      
      resolve({
        totalOrders: details.length,
        longLiquidation: parseFloat(longLiq.toFixed(2)),
        shortLiquidation: parseFloat(shortLiq.toFixed(2)),
        recent30m: {
          longLiquidation: parseFloat(recentLongLiq.toFixed(2)),
          shortLiquidation: parseFloat(recentShortLiq.toFixed(2))
        },
        netLiquidation: parseFloat((longLiq - shortLiq).toFixed(2))
      });
    } catch (e) {
      console.error('[OKX清算] 解析失败:', e.message);
      resolve(null);
    }
  });
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
  getOKXLiquidation,
  getLocalDate
};