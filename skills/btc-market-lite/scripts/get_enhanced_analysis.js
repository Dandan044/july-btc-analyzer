#!/usr/bin/env node
/**
 * 比特币市场数据获取 v2
 * 数据源: CryptoCompare API (主力) + alternative.me (恐惧贪婪指数)
 * 
 * 功能:
 * - 获取实时价格、市值、交易量
 * - 获取30天历史价格数据（可自定义）
 * - 获取30天恐惧贪婪指数
 * - 计算技术指标：SMA、EMA、RSI、动量、波动率
 * 
 * 输出: 与 v1 完全兼容的数据结构
 * 
 * 用法: 
 *   node get_enhanced_analysis_v2.js [--json] [--save]
 *   
 * 参数:
 *   --json  输出JSON格式
 *   --save  自动保存到 data/YYYY-MM-DD.json
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

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
        'Accept': 'application/json',
        'Authorization': 'Apikey YOUR_API_KEY' // 可选，免费版不需要
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

function calcSMA(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(0, period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcEMA(values, period) {
  if (values.length < period) return null;
  const reversed = [...values].reverse();
  const k = 2 / (period + 1);
  let ema = reversed.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < reversed.length; i++) {
    ema = reversed[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(values, period = 14) {
  if (values.length < period + 1) return null;
  
  let gains = 0, losses = 0;
  
  for (let i = 1; i <= period; i++) {
    const change = values[i - 1] - values[i];
    if (change > 0) gains += change;
    else losses -= change;
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcVolatility(values, period = 30) {
  if (values.length < period) return null;
  
  const slice = values.slice(0, period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
  
  return Math.sqrt(variance);
}

function calcMomentum(values, days = 7) {
  if (values.length <= days) return null;
  return ((values[0] - values[days]) / values[days]) * 100;
}

function calcSMASequence(values, period, days) {
  const result = [];
  for (let i = 0; i < days && i < values.length - period + 1; i++) {
    const slice = values.slice(i, i + period);
    const sma = slice.reduce((a, b) => a + b, 0) / period;
    result.push(sma);
  }
  return result;
}

function calcEMASequence(values, period, days) {
  if (values.length < period) return [];
  
  const result = [];
  const reversed = [...values].reverse();
  const k = 2 / (period + 1);
  
  const emaSeries = [];
  let ema = reversed.slice(0, period).reduce((a, b) => a + b, 0) / period;
  emaSeries.push(ema);
  
  for (let i = period; i < reversed.length; i++) {
    ema = reversed[i] * k + ema * (1 - k);
    emaSeries.push(ema);
  }
  
  return emaSeries.reverse().slice(0, days);
}

// ========== CryptoCompare API 封装 ==========

/**
 * 获取 CryptoCompare 数据
 * @param {string} endpoint - histominute | histohour | histoday
 * @param {string} fsym - 基础货币 (BTC)
 * @param {string} tsym - 目标货币 (USD)
 * @param {number} limit - 数据条数
 */
async function getCryptoCompareData(endpoint, fsym = 'BTC', tsym = 'USD', limit = 30) {
  const url = `https://min-api.cryptocompare.com/data/v2/${endpoint}?fsym=${fsym}&tsym=${tsym}&limit=${limit}`;
  const data = await fetch(url);
  
  if (data.Response !== 'Success') {
    throw new Error(`CryptoCompare API error: ${data.Message || 'Unknown error'}`);
  }
  
  return data.Data;
}

/**
 * 获取当前价格信息（从 CryptoCompare）
 */
async function getCurrentPrice() {
  // 使用 histohour 获取最新价格和变化
  const hourData = await getCryptoCompareData('histohour', 'BTC', 'USD', 168); // 7天小时数据
  
  if (!hourData.Data || hourData.Data.length === 0) {
    throw new Error('No price data available');
  }
  
  const latest = hourData.Data[hourData.Data.length - 1];
  const hourAgo = hourData.Data[hourData.Data.length - 2];
  const dayAgo = hourData.Data[hourData.Data.length - 25];
  const weekAgo = hourData.Data[0];
  
  return {
    current: latest.close,
    change1h: ((latest.close - hourAgo.close) / hourAgo.close * 100),
    change24h: ((latest.close - dayAgo.close) / dayAgo.close * 100),
    change7d: ((latest.close - weekAgo.close) / weekAgo.close * 100),
    volume24h: latest.volumeto,
    // 市值需要单独计算或从其他源获取
  };
}

/**
 * 获取历史价格数据（日级别）
 */
async function getPriceHistory(days = 31) {
  const dayData = await getCryptoCompareData('histoday', 'BTC', 'USD', days);
  
  if (!dayData.Data || dayData.Data.length === 0) {
    throw new Error('No historical price data available');
  }
  
  // CryptoCompare 返回从旧到新，需要反转
  const data = dayData.Data.reverse();
  
  return {
    prices: data.map(d => d.close),
    timestamps: data.map(d => d.time),
    volumes: data.map(d => d.volumeto),
    highs: data.map(d => d.high),
    lows: data.map(d => d.low)
  };
}

/**
 * 获取最近24小时交易量（聚合小时数据）
 * 返回完整的24小时交易量，用于替代当日不完整数据
 * 
 * ⚠️ 这是唯一可靠的交易量来源，不允许 fallback 到不完整数据
 */
async function get24hVolume(retries = 3) {
  let lastError = null;
  
  for (let i = 0; i < retries; i++) {
    try {
      // 获取最近24小时的小时数据
      const hourData = await getCryptoCompareData('histohour', 'BTC', 'USD', 24);
      
      if (!hourData.Data || hourData.Data.length < 24) {
        throw new Error('No hourly volume data available');
      }
      
      // 聚合最近24小时的交易量
      const last24Hours = hourData.Data.slice(-24);
      const volume24h = last24Hours.reduce((sum, h) => sum + (h.volumeto || 0), 0);
      
      return {
        volume24h: volume24h,
        hourlyData: last24Hours.map(h => ({
          time: h.time,
          volume: h.volumeto,
          close: h.close
        }))
      };
    } catch (e) {
      lastError = e;
      if (i < retries - 1) {
        // 等待 2 秒后重试
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  
  // 重试失败后抛出错误，不允许静默 fallback
  throw new Error(`get24hVolume failed after ${retries} retries: ${lastError?.message}`);
}

/**
 * 获取恐惧贪婪指数（仍使用 alternative.me）
 */
async function getFearGreedIndex(days = 30) {
  const data = await fetch(`https://api.alternative.me/fng/?limit=${days}`);
  return data;
}

// ========== 主数据获取 ==========

async function getEnhancedAnalysis() {
  const result = {
    timestamp: new Date().toISOString(),
    price: null,
    priceHistory: null,
    volume: null,
    fearGreedIndex: null,
    dataSource: 'CryptoCompare' // 标识数据源
  };

  try {
    // 并行获取数据
    const [currentPrice, priceHistory, fngData, volume24hData] = await Promise.all([
      getCurrentPrice().catch(e => { console.error('Price error:', e.message); return null; }),
      getPriceHistory(31).catch(e => { console.error('History error:', e.message); return null; }),
      getFearGreedIndex(30).catch(e => { console.error('FGI error:', e.message); return null; }),
      get24hVolume(3)  // 重试3次，失败则抛出错误，不允许静默 fallback
    ]);

    // ========== 基础价格数据 ==========
    if (currentPrice) {
      result.price = {
        current: parseFloat(currentPrice.current.toFixed(2)),
        change1h: currentPrice.change1h ? parseFloat(currentPrice.change1h.toFixed(2)) : null,
        change24h: currentPrice.change24h ? parseFloat(currentPrice.change24h.toFixed(2)) : null,
        change7d: currentPrice.change7d ? parseFloat(currentPrice.change7d.toFixed(2)) : null,
        volume24h: currentPrice.volume24h || null,
        marketCap: null // CryptoCompare 不直接提供市值，需要计算
      };
    }

    // ========== 价格历史数据（30天）==========
    if (priceHistory && priceHistory.prices.length > 0) {
      const priceValues = priceHistory.prices; // 已经是从新到旧
      const timestamps = priceHistory.timestamps;
      const volumeValues = priceHistory.volumes;
      
      // 计算各周期SMA序列
      const sma7Series = calcSMASequence(priceValues, 7, 31);
      const sma14Series = calcSMASequence(priceValues, 14, 31);
      const sma20Series = calcSMASequence(priceValues, 20, 31);
      const sma30Series = calcSMASequence(priceValues, 30, 31);
      const sma50Series = priceValues.length >= 50 ? calcSMASequence(priceValues, 50, 31) : [];
      
      // 计算各周期EMA序列
      const ema7Series = calcEMASequence(priceValues, 7, 31);
      const ema12Series = calcEMASequence(priceValues, 12, 31);
      const ema20Series = calcEMASequence(priceValues, 20, 31);
      const ema26Series = calcEMASequence(priceValues, 26, 31);
      
      // 构建历史数据列表
      const history = [];
      for (let i = 0; i < priceValues.length; i++) {
        const entry = {
          date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
          price: parseFloat(priceValues[i].toFixed(2)),
          high: priceHistory.highs ? parseFloat(priceHistory.highs[i].toFixed(2)) : null,
          low: priceHistory.lows ? parseFloat(priceHistory.lows[i].toFixed(2)) : null
        };
        
        if (i < sma7Series.length) entry.sma7 = parseFloat(sma7Series[i].toFixed(2));
        if (i < sma14Series.length) entry.sma14 = parseFloat(sma14Series[i].toFixed(2));
        if (i < sma20Series.length) entry.sma20 = parseFloat(sma20Series[i].toFixed(2));
        if (i < sma30Series.length) entry.sma30 = parseFloat(sma30Series[i].toFixed(2));
        if (i < sma50Series.length) entry.sma50 = parseFloat(sma50Series[i].toFixed(2));
        
        if (i < ema7Series.length) entry.ema7 = parseFloat(ema7Series[i].toFixed(2));
        if (i < ema12Series.length) entry.ema12 = parseFloat(ema12Series[i].toFixed(2));
        if (i < ema20Series.length) entry.ema20 = parseFloat(ema20Series[i].toFixed(2));
        if (i < ema26Series.length) entry.ema26 = parseFloat(ema26Series[i].toFixed(2));
        
        history.push(entry);
      }
      
      const currentPrice = priceValues[0];
      const max30d = Math.max(...priceValues);
      const min30d = Math.min(...priceValues);
      const avg30d = priceValues.reduce((a, b) => a + b, 0) / priceValues.length;
      
      result.priceHistory = {
        current: parseFloat(currentPrice.toFixed(2)),
        days: priceValues.length,
        history: history,
        statistics: {
          max30d: parseFloat(max30d.toFixed(2)),
          min30d: parseFloat(min30d.toFixed(2)),
          avg30d: parseFloat(avg30d.toFixed(2)),
          rangePosition: parseFloat(((currentPrice - min30d) / (max30d - min30d) * 100).toFixed(1))
        },
        indicators: {
          rsi14: calcRSI(priceValues, 14) ? parseFloat(calcRSI(priceValues, 14).toFixed(1)) : null,
          volatility30d: calcVolatility(priceValues, 30) ? parseFloat(calcVolatility(priceValues, 30).toFixed(2)) : null,
          momentum7d: calcMomentum(priceValues, 7) ? parseFloat(calcMomentum(priceValues, 7).toFixed(2)) : null,
          momentum14d: calcMomentum(priceValues, 14) ? parseFloat(calcMomentum(priceValues, 14).toFixed(2)) : null
        }
      };

      // ========== 交易量历史数据 ==========
      // ⚠️ 必须使用聚合的24小时交易量，不允许使用不完整的当日数据
      if (volume24hData && volumeValues && volumeValues.length > 0) {
        const currentVolume = volume24hData.volume24h;
        
        // 计算均值时排除当日（索引0），因为当日数据不完整
        // 用历史完整日数据计算均值
        const historicalVolumes = volumeValues.slice(1); // 排除当日
        const avgVolume = historicalVolumes.length > 0 
          ? historicalVolumes.reduce((a, b) => a + b, 0) / historicalVolumes.length 
          : volumeValues.reduce((a, b) => a + b, 0) / volumeValues.length;
        
        const volumeHistory = [];
        for (let i = 0; i < volumeValues.length; i++) {
          volumeHistory.push({
            date: new Date(timestamps[i] * 1000).toISOString().split('T')[0],
            volume: volumeValues[i]
          });
        }
        
        // max30d 和 min30d 用历史数据，排除当日不完整数据
        const historicalMax = historicalVolumes.length > 0 ? Math.max(...historicalVolumes) : Math.max(...volumeValues);
        const historicalMin = historicalVolumes.length > 0 ? Math.min(...historicalVolumes) : Math.min(...volumeValues);
        
        result.volume = {
          current: currentVolume,
          currentSource: '24h_aggregated',
          avg30d: avgVolume,
          max30d: historicalMax,
          min30d: historicalMin,
          volumeRatio: parseFloat((currentVolume / avgVolume).toFixed(2)),
          history: volumeHistory
        };
      } else {
        // volume24hData 获取失败，抛出错误而不是使用不完整数据
        throw new Error('24h volume data unavailable - cannot use incomplete daily data');
      }
    }

    // ========== 恐惧贪婪指数历史数据 ==========
    if (fngData?.data) {
      const fngValues = fngData.data.map(d => parseInt(d.value));
      const fngDates = fngData.data.map(d => d.timestamp);
      
      const sma7Series = calcSMASequence(fngValues, 7, 30);
      const sma14Series = calcSMASequence(fngValues, 14, 30);
      const sma30Series = calcSMASequence(fngValues, 30, 30);
      const ema7Series = calcEMASequence(fngValues, 7, 30);
      
      const history = [];
      for (let i = 0; i < fngValues.length; i++) {
        const entry = {
          date: new Date(fngDates[i] * 1000).toISOString().split('T')[0],
          value: fngValues[i]
        };
        
        if (i < sma7Series.length) entry.sma7 = parseFloat(sma7Series[i].toFixed(1));
        if (i < sma14Series.length) entry.sma14 = parseFloat(sma14Series[i].toFixed(1));
        if (i < sma30Series.length) entry.sma30 = parseFloat(sma30Series[i].toFixed(1));
        if (i < ema7Series.length) entry.ema7 = parseFloat(ema7Series[i].toFixed(1));
        
        history.push(entry);
      }
      
      const current = fngValues[0];
      const max30d = Math.max(...fngValues);
      const min30d = Math.min(...fngValues);
      const avg30d = fngValues.reduce((a, b) => a + b, 0) / fngValues.length;
      
      result.fearGreedIndex = {
        current: current,
        classification: fngData.data[0].value_classification,
        history: history,
        statistics: {
          avg30d: parseFloat(avg30d.toFixed(1)),
          max30d: max30d,
          min30d: min30d,
          rangePosition: parseFloat(((current - min30d) / (max30d - min30d) * 100).toFixed(0))
        },
        indicators: {
          rsi14: calcRSI(fngValues, 14) ? parseFloat(calcRSI(fngValues, 14).toFixed(1)) : null,
          volatility30d: calcVolatility(fngValues, 30) ? parseFloat(calcVolatility(fngValues, 30).toFixed(2)) : null,
          momentum7d: calcMomentum(fngValues, 7) ? parseFloat(calcMomentum(fngValues, 7).toFixed(1)) : null
        }
      };
    }

  } catch (e) {
    console.error('数据获取错误:', e.message);
    throw e;
  }

  return result;
}

// ========== 格式化输出（与 v1 相同）==========

function formatAnalysis(data) {
  let out = '';
  
  out += '═'.repeat(60) + '\n';
  out += '         ₿ 比特币市场数据 (v2)\n';
  out += '═'.repeat(60) + '\n\n';
  
  out += `📅 ${new Date(data.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n`;
  out += `📊 数据源: ${data.dataSource}\n\n`;
  
  // 当前价格
  if (data.price?.current) {
    out += '── 💰 当前价格 ──\n';
    out += `   价格: $${data.price.current.toLocaleString()}\n`;
    if (data.price.change1h) out += `   1小时: ${data.price.change1h > 0 ? '+' : ''}${data.price.change1h.toFixed(2)}%\n`;
    if (data.price.change24h) out += `   24小时: ${data.price.change24h > 0 ? '+' : ''}${data.price.change24h.toFixed(2)}%\n`;
    if (data.price.change7d) out += `   7天: ${data.price.change7d > 0 ? '+' : ''}${data.price.change7d.toFixed(2)}%\n`;
  }
  
  // 价格历史统计
  if (data.priceHistory) {
    const ph = data.priceHistory;
    const stats = ph.statistics;
    const ind = ph.indicators;
    
    out += '\n── 📈 价格统计 ──\n';
    out += `   30日最高: $${stats.max30d.toLocaleString()}\n`;
    out += `   30日最低: $${stats.min30d.toLocaleString()}\n`;
    out += `   30日均值: $${stats.avg30d.toLocaleString()}\n`;
    out += `   区间位置: ${stats.rangePosition}%\n`;
    
    if (ind.rsi14) {
      const rsiStatus = ind.rsi14 < 30 ? '(超卖)' : ind.rsi14 > 70 ? '(超买)' : '';
      out += `   RSI(14): ${ind.rsi14} ${rsiStatus}\n`;
    }
    if (ind.momentum7d) out += `   7日动量: ${ind.momentum7d > 0 ? '+' : ''}${ind.momentum7d.toFixed(1)}%\n`;
    if (ind.volatility30d) out += `   30日波动: $${ind.volatility30d.toFixed(0)}\n`;
    
    out += '\n── 📊 近7日价格 ──\n';
    for (let i = 0; i < Math.min(7, ph.history.length); i++) {
      const h = ph.history[i];
      out += `   ${h.date}: $${h.price.toLocaleString()}`;
      if (h.sma7) out += ` | SMA7: $${h.sma7.toLocaleString()}`;
      if (h.ema7) out += ` | EMA7: $${h.ema7.toLocaleString()}`;
      out += '\n';
    }
  }
  
  // 交易量
  if (data.volume) {
    const v = data.volume;
    out += '\n── 📊 交易量 ──\n';
    out += `   当前: $${(v.current / 1e9).toFixed(2)}B`;
    if (v.currentSource === '24h_aggregated') {
      out += ' (24h聚合)';
    } else {
      out += ' (当日累积)';
    }
    out += '\n';
    out += `   30日均值: $${(v.avg30d / 1e9).toFixed(2)}B\n`;
    out += `   相对均值: ${v.volumeRatio}x\n`;
  }
  
  // 恐惧贪婪指数
  if (data.fearGreedIndex) {
    const fng = data.fearGreedIndex;
    const stats = fng.statistics;
    const ind = fng.indicators;
    
    out += '\n── 😰 恐惧贪婪指数 ──\n';
    const emoji = fng.current <= 25 ? '😱' : fng.current <= 45 ? '😰' : fng.current <= 55 ? '😐' : fng.current <= 75 ? '😊' : '🤑';
    out += `   当前: ${fng.current} (${fng.classification}) ${emoji}\n`;
    out += `   30日均值: ${stats.avg30d}\n`;
    out += `   30日区间: ${stats.min30d} - ${stats.max30d}\n`;
    out += `   区间位置: ${stats.rangePosition}%\n`;
    
    if (ind.rsi14) out += `   RSI(14): ${ind.rsi14}\n`;
    if (ind.momentum7d) out += `   7日动量: ${ind.momentum7d > 0 ? '+' : ''}${ind.momentum7d.toFixed(1)}\n`;
    
    out += '\n   近7日数据:\n';
    for (let i = 0; i < Math.min(7, fng.history.length); i++) {
      const h = fng.history[i];
      out += `   ${h.date}: ${h.value}`;
      if (h.sma7) out += ` (SMA7: ${h.sma7})`;
      out += '\n';
    }
  }
  
  out += '\n' + '─'.repeat(60) + '\n';
  out += '📊 数据源: CryptoCompare API + alternative.me\n';
  out += '📋 使用 --json 参数获取完整历史数据\n';
  
  return out;
}

// ========== CLI 入口 ==========

function saveData(data, basePath) {
  const scriptDir = __dirname;
  const workspaceDir = basePath || path.resolve(scriptDir, '..', '..', '..');
  const dataDir = path.join(workspaceDir, 'data');
  
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  const date = new Date(data.timestamp);
  const shanghaiDate = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const dateStr = shanghaiDate.toISOString().split('T')[0];
  const filePath = path.join(dataDir, `${dateStr}.json`);
  
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  
  return filePath;
}

async function main() {
  try {
    const data = await getEnhancedAnalysis();
    const json = process.argv.includes('--json');
    const save = process.argv.includes('--save');
    
    let savedPath = null;
    if (save) {
      savedPath = saveData(data);
    }
    
    if (json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(formatAnalysis(data));
    }
    
    if (savedPath) {
      console.log(`\n📁 数据已保存: ${savedPath}`);
    }
  } catch (e) {
    console.error('错误:', e.message);
    process.exit(1);
  }
}

module.exports = { getEnhancedAnalysis, formatAnalysis, saveData, getCryptoCompareData };

if (require.main === module) {
  main();
}