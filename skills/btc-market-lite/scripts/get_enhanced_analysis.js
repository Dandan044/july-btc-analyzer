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
const BINANCE_FUTURES_BASE = 'https://fapi.binance.com';

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

function calcMomentum(values, days = 7) {
  // values: [最新, ..., 最旧]
  // 动量 = (当前价格 - N天前价格) / N天前价格 * 100
  if (values.length <= days) return null;
  return ((values[0] - values[days]) / values[days]) * 100;
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
      rsi14: calcRSI(closes, 14) ? parseFloat(calcRSI(closes, 14).toFixed(1)) : null,
      momentum7d: calcMomentum(closes, 7) ? parseFloat(calcMomentum(closes, 7).toFixed(2)) : null
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

// ========== 主数据获取 ==========

async function getEnhancedAnalysis(proxy = null) {
  const result = {
    timestamp: toBeijingTime(new Date()),
    priceHistory: null,
    kline4h: null,
    fearGreedIndex: null,
    dataSource: {
      price: 'Binance Futures',
      sentiment: proxy ? 'Binance Futures (via proxy)' : 'Binance Futures (no proxy)'
    }
  };

  try {
    const [dailyData, kline4h, fngData] = await Promise.all([
      proxy ? getDailyData(proxy).catch(e => { console.error('Daily error:', e.message); return null; }) : Promise.resolve(null),
      proxy ? get4hData(proxy).catch(e => { console.error('4h error:', e.message); return null; }) : Promise.resolve(null),
      getFearGreedIndex(30).catch(e => { console.error('FGI error:', e.message); return null; })
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
      out += `   RSI(14): ${ind.rsi14} ${rsiStatus}`;
    } else {
      out += `   RSI(14): N/A`;
    }
    if (ind.momentum7d !== null) {
      out += ` | 7日动量: ${ind.momentum7d > 0 ? '+' : ''}${ind.momentum7d}%\n`;
      out += `           (当前价格相对7天前的变化幅度)\n`;
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
  out += '📊 数据源: Binance Futures + alternative.me\n';
  
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