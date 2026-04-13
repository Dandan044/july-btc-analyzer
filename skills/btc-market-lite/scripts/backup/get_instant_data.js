#!/usr/bin/env node
/**
 * 即时分析数据获取 v1
 * 数据源: Binance Futures API
 * 
 * 功能:
 *   - 12根4小时K线
 *   - 4根1小时K线  
 *   - 8根15分钟K线
 *   - 附带交易侧数据（资金费率、OI、多空比、Taker买卖比）
 * 
 * 用法:
 *   node get_instant_data.js [--json] [--save] [--proxy http://127.0.0.1:7890]
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

// ========== Binance API ==========

async function getBinanceData(endpoint, proxy) {
  const url = `${BINANCE_FUTURES_BASE}${endpoint}`;
  return fetch(url, proxy);
}

/**
 * 获取K线数据（通用）
 * @param {string} interval - 时间间隔：4h, 1h, 15m
 * @param {number} limit - 数量
 * @param {string} proxy - 代理
 * @param {string} period - 交易侧数据周期（用于OI、多空比等）
 */
async function getKlineData(interval, limit, proxy, period = null) {
  const klines = await getBinanceData(`/fapi/v1/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`, proxy).catch(e => {
    console.error(`${interval} klines error:`, e.message);
    return null;
  });
  
  if (!klines || !Array.isArray(klines)) {
    return null;
  }
  
  // 根据时间间隔决定获取交易侧数据的周期
  const dataPeriod = period || interval;
  
  // 获取交易侧数据
  const [fundingRate, openInterest, globalLongShort, topTraderPosition, takerRatio] = await Promise.all([
    getBinanceData(`/fapi/v1/fundingRate?symbol=BTCUSDT&limit=${limit * 3}`, proxy).catch(() => null),
    getBinanceData(`/futures/data/openInterestHist?symbol=BTCUSDT&period=${dataPeriod}&limit=${limit}`, proxy).catch(() => null),
    getBinanceData(`/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=${dataPeriod}&limit=${limit}`, proxy).catch(() => null),
    getBinanceData(`/futures/data/topLongShortPositionRatio?symbol=BTCUSDT&period=${dataPeriod}&limit=${limit}`, proxy).catch(() => null),
    getBinanceData(`/futures/data/takerlongshortRatio?symbol=BTCUSDT&period=${dataPeriod}&limit=${limit}`, proxy).catch(() => null)
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
  
  // 资金费率 - 按时间匹配（取最接近的）
  if (fundingRate && Array.isArray(fundingRate)) {
    for (const d of fundingRate) {
      // 找到最接近的timestamp
      const fundingTs = d.fundingTime;
      let closestIdx = null;
      let minDiff = Infinity;
      for (const [ts, idx] of tsMap) {
        const diff = Math.abs(ts - fundingTs);
        if (diff < minDiff) {
          minDiff = diff;
          closestIdx = idx;
        }
      }
      if (closestIdx !== undefined && minDiff < 4 * 60 * 60 * 1000) { // 4小时容差
        if (result[closestIdx].fundingRate === undefined) {
          result[closestIdx].fundingRate = parseFloat(d.fundingRate);
          result[closestIdx].markPrice = parseFloat(d.markPrice);
        }
      }
    }
  }
  
  // OI
  if (openInterest && Array.isArray(openInterest)) {
    for (const d of openInterest) {
      const idx = tsMap.get(d.timestamp);
      if (idx !== undefined) {
        result[idx].openInterest = parseFloat(d.sumOpenInterest);
        result[idx].openInterestValue = parseFloat(d.sumOpenInterestValue);
      }
    }
  }
  
  // 多空人数比
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
  
  // 大户持仓比
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
  
  // Taker 买卖比
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

/**
 * 获取24小时ticker数据
 */
async function getTicker24h(proxy) {
  const ticker = await getBinanceData('/fapi/v1/ticker/24hr?symbol=BTCUSDT', proxy).catch(() => null);
  if (!ticker) return null;
  
  return {
    price: parseFloat(ticker.lastPrice),
    priceChange: parseFloat(ticker.priceChange),
    priceChangePercent: parseFloat(ticker.priceChangePercent),
    high24h: parseFloat(ticker.highPrice),
    low24h: parseFloat(ticker.lowPrice),
    volume24h: parseFloat(ticker.quoteVolume),
    openTime: ticker.openTime,
    closeTime: ticker.closeTime
  };
}

// ========== 主数据获取 ==========

async function getInstantData(proxy = null) {
  const result = {
    timestamp: toBeijingTime(new Date()),
    ticker: null,
    kline4h: null,
    kline1h: null,
    kline15m: null,
    dataSource: {
      price: 'Binance Futures',
      proxy: proxy ? 'via proxy' : 'no proxy'
    }
  };

  try {
    // 并行获取所有数据
    const [ticker, kline4h, kline1h, kline15m] = await Promise.all([
      getTicker24h(proxy).catch(e => { console.error('Ticker error:', e.message); return null; }),
      getKlineData('4h', 12, proxy, '4h').catch(e => { console.error('4h error:', e.message); return null; }),
      getKlineData('1h', 4, proxy, '1h').catch(e => { console.error('1h error:', e.message); return null; }),
      getKlineData('15m', 8, proxy, '15m').catch(e => { console.error('15m error:', e.message); return null; })
    ]);

    result.ticker = ticker;
    result.kline4h = kline4h;
    result.kline1h = kline1h;
    result.kline15m = kline15m;

  } catch (e) {
    console.error('数据获取错误:', e.message);
    throw e;
  }

  return result;
}

// ========== 格式化输出 ==========

function formatPrice(val) {
  return `$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatVolume(val) {
  if (!val) return 'N/A';
  return `$${(val / 1e9).toFixed(2)}B`;
}

function formatInstantData(data) {
  let out = '';
  
  out += '═'.repeat(70) + '\n';
  out += '              ₿ 即时分析数据 v1\n';
  out += '═'.repeat(70) + '\n\n';
  
  out += `📅 ${data.timestamp}\n\n`;
  
  // Ticker 数据
  if (data.ticker) {
    const t = data.ticker;
    out += '── 📈 24小时行情 ──\n';
    out += `   当前价格: ${formatPrice(t.price)}\n`;
    out += `   24h变化: ${t.priceChangePercent > 0 ? '+' : ''}${t.priceChangePercent}% (${formatPrice(t.priceChange)})\n`;
    out += `   24h最高: ${formatPrice(t.high24h)} | 最低: ${formatPrice(t.low24h)}\n`;
    out += `   24h成交: ${formatVolume(t.volume24h)}\n\n`;
  }
  
  // 4小时K线
  if (data.kline4h && data.kline4h.length > 0) {
    out += '── 📊 4小时K线 (12根) ──\n';
    for (const k of data.kline4h) {
      const timeShort = k.time.slice(5, 16);
      out += `   ${timeShort}: O${formatPrice(k.open)} H${formatPrice(k.high)} L${formatPrice(k.low)} C${formatPrice(k.close)}`;
      if (k.fundingRate !== undefined) {
        out += ` | 费率${(k.fundingRate * 100).toFixed(4)}%`;
      }
      if (k.openInterest !== undefined) {
        out += ` | OI${(k.openInterest/1000).toFixed(1)}k`;
      }
      if (k.longShortRatio !== undefined) {
        out += ` | 多空比${k.longShortRatio.toFixed(2)}`;
      }
      out += '\n';
    }
    out += '\n';
  }
  
  // 1小时K线
  if (data.kline1h && data.kline1h.length > 0) {
    out += '── 📊 1小时K线 (4根) ──\n';
    for (const k of data.kline1h) {
      const timeShort = k.time.slice(5, 16);
      out += `   ${timeShort}: O${formatPrice(k.open)} H${formatPrice(k.high)} L${formatPrice(k.low)} C${formatPrice(k.close)}`;
      if (k.fundingRate !== undefined) {
        out += ` | 费率${(k.fundingRate * 100).toFixed(4)}%`;
      }
      if (k.openInterest !== undefined) {
        out += ` | OI${(k.openInterest/1000).toFixed(1)}k`;
      }
      out += '\n';
    }
    out += '\n';
  }
  
  // 15分钟K线
  if (data.kline15m && data.kline15m.length > 0) {
    out += '── 📊 15分钟K线 (8根) ──\n';
    for (const k of data.kline15m) {
      const timeShort = k.time.slice(5, 16);
      out += `   ${timeShort}: O${formatPrice(k.open)} H${formatPrice(k.high)} L${formatPrice(k.low)} C${formatPrice(k.close)}`;
      if (k.volume !== undefined) {
        out += ` | 成交${(k.quoteVolume/1e6).toFixed(1)}M`;
      }
      out += '\n';
    }
    out += '\n';
  }
  
  out += '─'.repeat(70) + '\n';
  out += '📊 数据源: Binance Futures\n';
  
  return out;
}

// ========== CLI 入口 ==========

function saveData(data, basePath) {
  const scriptDir = __dirname;
  const workspaceDir = basePath || path.resolve(scriptDir, '..', '..', '..');
  const dataDir = path.join(workspaceDir, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  
  // 使用时间戳作为文件名，避免覆盖
  const timestamp = data.timestamp.replace(/[: ]/g, '-').slice(0, 19);
  const filePath = path.join(dataDir, `instant-${timestamp}.json`);
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
    const data = await getInstantData(args.proxy);
    if (args.save) {
      const savedPath = saveData(data);
      console.log(`📁 数据已保存: ${savedPath}`);
    }
    if (args.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(formatInstantData(data));
    }
  } catch (e) {
    console.error('错误:', e.message);
    process.exit(1);
  }
}

module.exports = { getInstantData, formatInstantData, saveData };

if (require.main === module) {
  main();
}