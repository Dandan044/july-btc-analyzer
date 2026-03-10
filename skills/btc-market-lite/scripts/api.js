/**
 * BTC 市场数据 API 模块
 * 供警报器规则和其他模块复用
 */

const https = require('https');

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
 * 获取K线数据
 * @param {string} symbol - 币种 (BTC)
 * @param {string} interval - 时间间隔: 1m, 5m, 15m, 1h, 4h, 1d
 * @param {number} limit - 数据条数
 * @returns {Promise<Array>} K线数据数组，从新到旧
 */
async function getKlines(symbol = 'BTC', interval = '1h', limit = 30) {
  // 映射间隔到 CryptoCompare endpoint
  const intervalMap = {
    '1m': { endpoint: 'histominute', multiplier: 1 },
    '5m': { endpoint: 'histominute', multiplier: 5 },
    '15m': { endpoint: 'histominute', multiplier: 15 },
    '1h': { endpoint: 'histohour', multiplier: 1 },
    '4h': { endpoint: 'histohour', multiplier: 4 },
    '1d': { endpoint: 'histoday', multiplier: 1 }
  };
  
  const config = intervalMap[interval];
  if (!config) {
    throw new Error(`不支持的间隔: ${interval}`);
  }
  
  const url = `https://min-api.cryptocompare.com/data/v2/${config.endpoint}?fsym=${symbol}&tsym=USD&limit=${limit}`;
  const data = await fetch(url);
  
  if (data.Response !== 'Success') {
    throw new Error(`API错误: ${data.Message || 'Unknown error'}`);
  }
  
  // 返回格式化的K线数据，从新到旧
  return data.Data.Data.map(candle => ({
    time: candle.time,
    datetime: new Date(candle.time * 1000).toISOString(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volumeto,
    volumeFrom: candle.volumefrom
  }));
}

/**
 * 获取实时价格
 * @param {string} symbol - 币种 (BTC)
 * @returns {Promise<Object>} 价格信息
 */
async function getTicker(symbol = 'BTC') {
  const url = `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${symbol}&tsym=USD&limit=168`;
  const data = await fetch(url);
  
  if (data.Response !== 'Success') {
    throw new Error(`API错误: ${data.Message || 'Unknown error'}`);
  }
  
  const candles = data.Data.Data;
  const latest = candles[candles.length - 1];
  const hourAgo = candles[candles.length - 2];
  const dayAgo = candles[candles.length - 25];
  const weekAgo = candles[0];
  
  return {
    symbol: symbol,
    price: latest.close,
    high: latest.high,
    low: latest.low,
    change1h: ((latest.close - hourAgo.close) / hourAgo.close * 100).toFixed(2),
    change24h: ((latest.close - dayAgo.close) / dayAgo.close * 100).toFixed(2),
    change7d: ((latest.close - weekAgo.close) / weekAgo.close * 100).toFixed(2),
    volume24h: latest.volumeto,
    timestamp: new Date().toISOString()
  };
}

/**
 * 获取24小时交易量（聚合小时数据）
 * @param {string} symbol - 币种 (BTC)
 * @returns {Promise<Object>} 交易量信息
 */
async function get24hVolume(symbol = 'BTC') {
  const url = `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${symbol}&tsym=USD&limit=24`;
  const data = await fetch(url);
  
  if (data.Response !== 'Success') {
    throw new Error(`API错误: ${data.Message || 'Unknown error'}`);
  }
  
  const candles = data.Data.Data;
  const volume24h = candles.reduce((sum, c) => sum + (c.volumeto || 0), 0);
  
  return {
    symbol: symbol,
    volume24h: volume24h,
    hourlyData: candles.map(c => ({
      time: c.time,
      datetime: new Date(c.time * 1000).toISOString(),
      volume: c.volumeto,
      close: c.close
    }))
  };
}

/**
 * 获取历史价格数据
 * @param {string} symbol - 币种 (BTC)
 * @param {number} days - 天数
 * @returns {Promise<Object>} 历史价格数据
 */
async function getPriceHistory(symbol = 'BTC', days = 30) {
  const url = `https://min-api.cryptocompare.com/data/v2/histoday?fsym=${symbol}&tsym=USD&limit=${days}`;
  const data = await fetch(url);
  
  if (data.Response !== 'Success') {
    throw new Error(`API错误: ${data.Message || 'Unknown error'}`);
  }
  
  const candles = data.Data.Data.reverse(); // 从新到旧
  
  return {
    symbol: symbol,
    prices: candles.map(c => c.close),
    timestamps: candles.map(c => c.time),
    volumes: candles.map(c => c.volumeto),
    highs: candles.map(c => c.high),
    lows: candles.map(c => c.low),
    history: candles.map(c => ({
      date: new Date(c.time * 1000).toISOString().split('T')[0],
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volumeto
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

// ========== 导出 ==========

module.exports = {
  getKlines,
  getTicker,
  get24hVolume,
  getPriceHistory,
  getFearGreedIndex,
  fetch
};