#!/usr/bin/env node
/**
 * 即时分析数据获取 v5
 * 数据源: OKX CLI + OKX API
 * 
 * 改进:
 *   - 使用 OKX CLI 获取 K线数据
 *   - 使用 OKX API 获取交易侧数据（多空比、Taker比）
 *   - 统一数据源为 OKX
 * 
 * 功能:
 *   - 12根4小时K线
 *   - 4根1小时K线  
 *   - 8根15分钟K线
 *   - 附带交易侧数据（资金费率、OI、多空比、Taker买卖比）
 * 
 * 用法:
 *   node get_instant_data_v5.js [--json] [--save] [--proxy http://127.0.0.1:7890]
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { exec } = require('child_process');

// ========== 配置 ==========

const PROXY_DEFAULT = 'http://127.0.0.1:7890';
const OKX_API_BASE = 'https://www.okx.com';
const OKX_INST_ID_SWAP = 'BTC-USDT-SWAP';
const OKX_PROXY_SCRIPT = path.resolve(__dirname, '../../../scripts/okx-proxy.sh');

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

/**
 * 调用 OKX CLI 工具（通过代理 wrapper）
 */
function okxCLI(args, proxy = null) {
  return new Promise((resolve, reject) => {
    let cmd;
    if (proxy && fs.existsSync(OKX_PROXY_SCRIPT)) {
      cmd = `${OKX_PROXY_SCRIPT} ${args}`;
    } else if (proxy) {
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
    // OKX CLI 返回的可能是数组或对象
    if (Array.isArray(data)) {
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
 * 通过 curl 获取 OKX API 数据
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
 * 获取清算数据（OKX API，含价格分布热力图）
 * 返回最近24小时的多空清算统计 + 热力图
 */
async function getLiquidationData(proxy) {
  if (!proxy) return null;
  
  const PRICE_BIN = 500;
  
  return new Promise((resolve) => {
    const url = `${OKX_API_BASE}/api/v5/public/liquidation-orders?instFamily=BTC-USDT&instType=SWAP&state=filled&limit=100`;
    const cmd = `curl -s --max-time 30 -x ${proxy} '${url}'`;
    
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        console.error('Liquidation API error:', error.message);
        resolve(null);
        return;
      }
      
      try {
        const json = JSON.parse(stdout);
        if (json.code !== '0' || !json.data || !json.data[0]?.details) {
          resolve(null);
          return;
        }
        
        const details = json.data[0].details;
        
        // 基础统计
        let longLiq = 0, shortLiq = 0;
        const liquidations = [];
        const bins = {};
        
        for (const d of details) {
          const sz = parseFloat(d.sz);
          const posSide = d.posSide;
          const px = parseFloat(d.bkPx);
          
          if (posSide === 'long') longLiq += sz;
          else shortLiq += sz;
          
          liquidations.push({
            time: toBeijingDatetime(parseInt(d.time)),
            timestamp: parseInt(d.time),
            bkPx: px,
            posSide: posSide,
            side: d.side,
            sz: sz
          });
          
          // 热力图分档
          const binKey = Math.floor(px / PRICE_BIN) * PRICE_BIN;
          if (!bins[binKey]) bins[binKey] = { longCount: 0, shortCount: 0, longSz: 0, shortSz: 0 };
          if (posSide === 'long') {
            bins[binKey].longCount++;
            bins[binKey].longSz += sz;
          } else {
            bins[binKey].shortCount++;
            bins[binKey].shortSz += sz;
          }
        }
        
        // 构建热力图
        const heatmap = Object.entries(bins)
          .map(([price, data]) => ({
            price: parseInt(price),
            priceRange: `${parseInt(price)}-${parseInt(price) + PRICE_BIN}`,
            longCount: data.longCount,
            shortCount: data.shortCount,
            longSz: parseFloat(data.longSz.toFixed(1)),
            shortSz: parseFloat(data.shortSz.toFixed(1)),
            totalSz: parseFloat((data.longSz + data.shortSz).toFixed(1)),
            dominant: data.longSz > data.shortSz * 1.5 ? 'long' :
                      data.shortSz > data.longSz * 1.5 ? 'short' : 'mixed'
          }))
          .sort((a, b) => a.price - b.price);
        
        resolve({
          count: details.length,
          longLiquidation: parseFloat(longLiq.toFixed(2)),
          shortLiquidation: parseFloat(shortLiq.toFixed(2)),
          netLiquidation: parseFloat((longLiq - shortLiq).toFixed(2)),
          recent: liquidations.slice(0, 10),
          heatmap: heatmap
        });
      } catch (e) {
        console.error('Liquidation JSON parse error:', e.message);
        resolve(null);
      }
    });
  });
}

// ========== K线数据获取 ==========

/**
 * 获取K线数据（使用 OKX CLI）
 * @param {string} bar - 时间间隔：4H, 1H, 15m
 * @param {number} limit - 数量
 * @param {string} proxy - 代理
 */
async function getKlineData(bar, limit, proxy) {
  // OKX 格式: 4H, 1H, 15m
  const klinesData = await okxCLIJson(`market candles ${OKX_INST_ID_SWAP} --bar ${bar} --limit ${limit}`, proxy).catch(e => {
    console.error(`${bar} klines error:`, e.message);
    return null;
  });
  
  const klinesArray = Array.isArray(klinesData) ? klinesData : klinesData?.data;
  
  if (!klinesArray || klinesArray.length === 0) {
    return null;
  }
  
  // 获取交易侧数据（OKX API）
  // 注意：多空比/大户比/Taker API 只支持 5m/1H/1D，不支持 4H
  // 所以 4H K线用 1H API 数据匹配，15m 不获取这些数据（噪音过大）
  const isShortTerm = bar === '15m';
  const tradingPeriod = bar === '4H' ? '1H' : bar;  // 4H 用 1H 数据匹配
  
  let openInterest, longShortRatio, topTraderRatio, takerVolume;
  if (isShortTerm) {
    // 15m：只取OI，不取其他交易侧数据
    openInterest = await getOKXData(`/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=${bar}&limit=${limit}`, proxy).catch(() => null);
    longShortRatio = null;
    topTraderRatio = null;
    takerVolume = null;
  } else {
    // 4H/1H：取全部交易侧数据（4H 用 1H period）
    [openInterest, longShortRatio, topTraderRatio, takerVolume] = await Promise.all([
      getOKXData(`/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=${bar}&limit=${limit}`, proxy).catch(() => null),
      getOKXData(`/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=${tradingPeriod}&limit=${limit * (bar === '4H' ? 4 : 1)}`, proxy).catch(() => null),
      getOKXData(`/api/v5/rubik/stat/contracts/long-short-account-ratio-contract-top-trader?instId=${OKX_INST_ID_SWAP}&period=${bar}&limit=${limit}`, proxy).catch(() => null),
      getOKXData(`/api/v5/rubik/stat/taker-volume?instId=${OKX_INST_ID_SWAP}&instType=CONTRACTS&ccy=BTC&period=${tradingPeriod}&limit=${limit * (bar === '4H' ? 4 : 1)}`, proxy).catch(() => null)
    ]);
  }
  
  const result = [];
  
  // 解析 K线 (OKX 格式: [ts, open, high, low, close, vol, volCcy, volCcyQuote, confirm])
  for (let i = 0; i < klinesArray.length; i++) {
    const k = klinesArray[i];
    const entry = {
      time: toBeijingDatetime(parseInt(k[0])),
      timestamp: parseInt(k[0]),
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
  
  // 获取最新资金费率（OKX CLI）
  if (bar === '4H') {
    const fundingData = await okxCLIJson(`market funding-rate ${OKX_INST_ID_SWAP}`, proxy).catch(() => null);
    const fundingArr = Array.isArray(fundingData) ? fundingData : fundingData?.data;
    
    if (fundingArr && fundingArr[0]) {
      const f = fundingArr[0];
      const fundingTs = parseInt(f.fundingTime);
      const idx = tsMap.get(fundingTs);
      if (idx !== undefined) {
        result[idx].fundingRate = parseFloat(f.fundingRate);
        result[idx].markPrice = parseFloat(f.markPrice || 0);
      }
      // 也填入最新一根（可能是下一根K线）
      if (result[0]) {
        result[0].fundingRate = parseFloat(f.fundingRate);
        result[0].markPrice = parseFloat(f.markPrice || 0);
      }
    }
  }
  
  // OI
  if (openInterest?.data && Array.isArray(openInterest.data)) {
    for (const d of openInterest.data.slice(0, limit)) {
      const ts = parseInt(d[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined) {
        result[idx].openInterest = parseFloat(d[1]);
        result[idx].openInterestValue = parseFloat(d[1]) * result[idx].close;
      }
    }
  }
  
  // 多空比
  if (longShortRatio?.data && Array.isArray(longShortRatio.data)) {
    for (const d of longShortRatio.data.slice(0, limit)) {
      const ts = parseInt(d[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined) {
        const ratio = parseFloat(d[1]);
        result[idx].longShortRatio = ratio;
        result[idx].longAccount = ratio / (1 + ratio);
        result[idx].shortAccount = 1 / (1 + ratio);
      }
    }
  }
  
  // 大户持仓比
  if (topTraderRatio?.data && Array.isArray(topTraderRatio.data)) {
    for (const d of topTraderRatio.data.slice(0, limit)) {
      const ts = parseInt(d[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined) {
        result[idx].topTraderRatio = parseFloat(d[1]);
      }
    }
  }
  
  // Taker 买卖比（只保留ratio）
  if (takerVolume?.data && Array.isArray(takerVolume.data)) {
    for (const d of takerVolume.data.slice(0, limit)) {
      const ts = parseInt(d[0]);
      const idx = tsMap.get(ts);
      if (idx !== undefined) {
        const buyVol = parseFloat(d[1]);
        const sellVol = parseFloat(d[2]);
        result[idx].takerRatio = sellVol > 0 ? buyVol / sellVol : null;
      }
    }
  }
  
  return result;
}

// ========== 4H 技术指标获取 ==========

/**
 * 获取4H级别的技术指标（BB + MACD + RSI）
 * 用于即时分析场景判断短期节奏
 */
async function getIndicators4H(proxy) {
  const [rsiData, bbData, macdData] = await Promise.all([
    okxCLIJson(`market indicator rsi ${OKX_INST_ID_SWAP} --bar 4H --list --limit 12`, proxy).catch(() => null),
    okxCLIJson(`market indicator bb ${OKX_INST_ID_SWAP} --bar 4H --list --limit 12`, proxy).catch(() => null),
    okxCLIJson(`market indicator macd ${OKX_INST_ID_SWAP} --bar 4H --list --limit 12`, proxy).catch(() => null)
  ]);
  
  const result = { rsi: null, bb: null, macd: null };
  
  // 解析 RSI
  try {
    const arr = Array.isArray(rsiData) ? rsiData : rsiData?.data;
    const list = arr?.[0]?.timeframes?.["4H"]?.indicators?.RSI;
    if (list && list.length > 0) {
      result.rsi = list.map(v => ({
        ts: parseInt(v.ts),
        value: parseFloat(v.values["14"])
      }));
    }
  } catch (e) {}
  
  // 解析 BB
  try {
    const arr = Array.isArray(bbData) ? bbData : bbData?.data;
    const list = arr?.[0]?.timeframes?.["4H"]?.indicators?.BB;
    if (list && list.length > 0) {
      result.bb = list.map(v => ({
        ts: parseInt(v.ts),
        upper: parseFloat(v.values.upper),
        middle: parseFloat(v.values.middle),
        lower: parseFloat(v.values.lower)
      }));
    }
  } catch (e) {}
  
  // 解析 MACD
  try {
    const arr = Array.isArray(macdData) ? macdData : macdData?.data;
    const list = arr?.[0]?.timeframes?.["4H"]?.indicators?.MACD;
    if (list && list.length > 0) {
      result.macd = list.map(v => ({
        ts: parseInt(v.ts),
        dif: parseFloat(v.values.dif),
        dea: parseFloat(v.values.dea),
        macd: parseFloat(v.values.macd)
      }));
    }
  } catch (e) {}
  
  return result;
}

// ========== 斐波那契分析 (使用 OKX CLI K线数据) ==========

/**
 * 获取 OKX K线数据用于斐波那契分析
 */
async function getOKXCandles(bar, limit, proxy) {
  const data = await okxCLIJson(`market candles ${OKX_INST_ID_SWAP} --bar ${bar} --limit ${limit}`, proxy);
  const arr = Array.isArray(data) ? data : data?.data;
  if (!arr || arr.length === 0) return null;
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
  return {
    timeframe: timeframe,
    high: parseFloat(swingHigh.toFixed(2)),
    low: parseFloat(swingLow.toFixed(2)),
    range: parseFloat(diff.toFixed(2)),
    levels: [
      parseFloat(swingHigh.toFixed(2)),
      parseFloat((swingHigh - diff * 0.236).toFixed(2)),
      parseFloat((swingHigh - diff * 0.382).toFixed(2)),
      parseFloat((swingHigh - diff * 0.5).toFixed(2)),
      parseFloat((swingHigh - diff * 0.618).toFixed(2)),
      parseFloat((swingHigh - diff * 0.786).toFixed(2)),
      parseFloat(swingLow.toFixed(2))
    ]
  };
}

/**
 * 获取多时间框架斐波那契分析 (使用 OKX CLI)
 */
async function getFibonacciAnalysisCLI(proxy) {
  try {
    const [dailyCandles, h4Candles, weeklyCandlesRaw] = await Promise.all([
      getOKXCandles('1D', 100, proxy),
      getOKXCandles('4H', 100, proxy),
      getOKXCandles('1D', 200, proxy)
    ]);
    const result = {
      currentPrice: null,
      note: 'high/low为波段高低点, range为波动幅度, levels数组依次对应0%, 23.6%, 38.2%, 50%, 61.8%, 78.6%, 100%斐波那契回调位价格',
      daily: null,
      fourHour: null,
      weekly: null
    };
    if (dailyCandles && dailyCandles.length >= 10) {
      result.currentPrice = dailyCandles[dailyCandles.length - 1].close;
      result.daily = analyzeTimeframeRaw('日线', dailyCandles);
    }
    if (h4Candles && h4Candles.length >= 10) {
      result.fourHour = analyzeTimeframeRaw('4小时', h4Candles);
    }
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

/**
 * 获取24小时ticker数据
 */
async function getTicker24h(proxy) {
  const tickerData = await okxCLIJson(`market ticker ${OKX_INST_ID_SWAP}`, proxy).catch(() => null);
  const tickerArr = Array.isArray(tickerData) ? tickerData : tickerData?.data;
  
  if (!tickerArr || !tickerArr[0]) return null;
  
  const t = tickerArr[0];
  const lastPrice = parseFloat(t.last);
  const open24h = parseFloat(t.open24h || lastPrice);
  
  return {
    price: lastPrice,
    priceChange: lastPrice - open24h,
    priceChangePercent: open24h > 0 ? ((lastPrice - open24h) / open24h * 100) : 0,
    high24h: parseFloat(t.high24h),
    low24h: parseFloat(t.low24h),
    volume24h: parseFloat(t.vol24h || 0) * lastPrice,  // 转换为 USDT
    openTime: null,
    closeTime: Date.now()
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
    indicators4h: null,
    liquidation: null,
    fibonacci: null,
    dataSource: {
      price: 'OKX CLI',
      proxy: proxy ? 'via proxy' : 'no proxy'
    }
  };

  try {
    console.error('使用 OKX CLI 获取即时数据...');
    
    // 并行获取所有数据 (含4H技术指标)
    const [ticker, kline4h, kline1h, kline15m, indicators4h, liquidation, fibData] = await Promise.all([
      getTicker24h(proxy).catch(e => { console.error('Ticker error:', e.message); return null; }),
      getKlineData('4H', 12, proxy).catch(e => { console.error('4h error:', e.message); return null; }),
      getKlineData('1H', 4, proxy).catch(e => { console.error('1h error:', e.message); return null; }),
      getKlineData('15m', 8, proxy).catch(e => { console.error('15m error:', e.message); return null; }),
      getIndicators4H(proxy).catch(e => { console.error('4H indicators error:', e.message); return null; }),
      getLiquidationData(proxy).catch(e => { console.error('Liquidation error:', e.message); return null; }),
      getFibonacciAnalysisCLI(proxy).catch(e => { console.error('Fibonacci error:', e.message); return null; })
    ]);

    result.ticker = ticker;
    result.kline4h = kline4h;
    result.kline1h = kline1h;
    result.kline15m = kline15m;
    result.indicators4h = indicators4h;
    result.liquidation = liquidation;
    if (fibData) result.fibonacci = fibData;

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
  out += '              ₿ 即时分析数据 v5 (OKX)\n';
  out += '═'.repeat(70) + '\n\n';
  
  out += `📅 ${data.timestamp}\n\n`;
  
  // Ticker 数据
  if (data.ticker) {
    const t = data.ticker;
    out += '── 📈 24小时行情 ──\n';
    out += `   当前价格: ${formatPrice(t.price)}\n`;
    out += `   24h变化: ${t.priceChangePercent > 0 ? '+' : ''}${t.priceChangePercent.toFixed(2)}% (${formatPrice(t.priceChange)})\n`;
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
    
    // 4H 技术指标
    if (data.indicators4h) {
      const ind = data.indicators4h;
      let hasData = false;
      
      // RSI
      if (ind.rsi && ind.rsi.length >= 3) {
        if (!hasData) { out += '   ── 4H 技术指标 ──\n'; hasData = true; }
        const latest = ind.rsi[ind.rsi.length - 1];
        const previous = ind.rsi[ind.rsi.length - 2];
        const trend = latest.value > previous.value ? '↑' : '↓';
        const rsiStatus = latest.value < 30 ? '超卖' : latest.value > 70 ? '超买' : '';
        const recent = ind.rsi.slice(-4).map(r => r.value.toFixed(1)).join(' → ');
        out += `   RSI(14): ${recent} ${trend}`;
        if (rsiStatus) out += ` ⚠️${rsiStatus}`;
        out += '\n';
      }
      
      // BB
      if (ind.bb && ind.bb.length >= 2) {
        const bbl = ind.bb[ind.bb.length - 1];
        const bw = ((bbl.upper - bbl.lower) / bbl.middle * 100).toFixed(1);
        const bwNum = parseFloat(bw);
        const squeezeWarn = bwNum < 8 ? ' ⚠️挤压' : bwNum < 12 ? ' 偏窄' : '';
        out += `   BB(20,2): 上$${bbl.upper.toFixed(0)} 中$${bbl.middle.toFixed(0)} 下$${bbl.lower.toFixed(0)} | 带宽${bw}%${squeezeWarn}\n`;
      }
      
      // MACD
      if (ind.macd && ind.macd.length >= 2) {
        const ml = ind.macd[ind.macd.length - 1];
        const mp = ind.macd[ind.macd.length - 2];
        let cross = '';
        if (mp.dif <= mp.dea && ml.dif > ml.dea) cross = ' 🔄金叉';
        else if (mp.dif >= mp.dea && ml.dif < ml.dea) cross = ' ⚠️死叉';
        else if (ml.dif > ml.dea) cross = ' (多头)';
        else cross = ' (空头)';
        const hTrend = ml.macd > mp.macd ? '↑' : '↓';
        out += `   MACD(12,26,9): DIF ${ml.dif.toFixed(1)} DEA ${ml.dea.toFixed(1)} 柱 ${ml.macd.toFixed(1)}${cross} 动能${hTrend}\n`;
      }
      
      if (hasData) out += '\n';
    }
  }
  
  // 1小时K线
  if (data.kline1h && data.kline1h.length > 0) {
    out += '── 📊 1小时K线 (4根) ──\n';
    for (const k of data.kline1h) {
      const timeShort = k.time.slice(5, 16);
      out += `   ${timeShort}: O${formatPrice(k.open)} H${formatPrice(k.high)} L${formatPrice(k.low)} C${formatPrice(k.close)}`;
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
      if (k.quoteVolume !== undefined) {
        out += ` | 成交${(k.quoteVolume/1e6).toFixed(1)}M`;
      }
      out += '\n';
    }
    out += '\n';
  }
  
  // 清算数据（最近24小时 + 热力图）
  if (data.liquidation) {
    const liq = data.liquidation;
    out += '── 🔥 清算数据 (24h) ──\n';
    out += `   清算订单数: ${liq.count} 笔\n`;
    out += `   多头清算: ${liq.longLiquidation} BTC | 空头清算: ${liq.shortLiquidation} BTC\n`;
    
    const netIndicator = liq.netLiquidation > 0 ? '多头被清算更多（短期偏空）' : 
                         liq.netLiquidation < 0 ? '空头被清算更多（短期偏多）' : '平衡';
    out += `   净清算: ${liq.netLiquidation} BTC (${netIndicator})\n`;
    
    // 价格分布
    if (liq.heatmap && liq.heatmap.length > 0) {
      out += '\n   ── 价格区间分布 ──\n';
      const maxSz = Math.max(...liq.heatmap.map(h => h.totalSz));
      for (const h of liq.heatmap) {
        const barLen = Math.max(1, Math.round(h.totalSz / maxSz * 25));
        const bar = h.dominant === 'long' ? '多'.repeat(barLen) :
                    h.dominant === 'short' ? '空'.repeat(barLen) : '混'.repeat(barLen);
        out += `   $${h.priceRange}: ${h.longCount}多/${h.shortCount}空 ${h.totalSz.toFixed(0)}BTC ${bar}\n`;
      }
    }
    
    // 最近清算记录
    if (liq.recent && liq.recent.length > 0) {
      out += '\n   最近清算:\n';
      for (let i = 0; i < Math.min(5, liq.recent.length); i++) {
        const r = liq.recent[i];
        const timeShort = r.time.slice(5, 16);
        const sideIndicator = r.posSide === 'long' ? '多爆仓→卖出' : '空爆仓→买入';
        out += `   ${timeShort}: ${r.sz} BTC @ $${r.bkPx.toLocaleString()} (${sideIndicator})\n`;
      }
    }
    out += '\n';
  }
  
  // 斐波那契回调位
  if (data.fibonacci) {
    out += '── 📐 斐波那契回调位 ──\n';
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
      
      out += `   ${levelLabel.padEnd(12)}`;
      out += dPrice ? `$${dPrice.toLocaleString().padEnd(15)}` : 'N/A'.padEnd(15);
      out += h4Price ? `$${h4Price.toLocaleString().padEnd(15)}` : 'N/A'.padEnd(15);
      out += wPrice ? `$${wPrice.toLocaleString()}` : 'N/A';
      out += '\n';
    }
    out += '\n';
  }
  
  out += '─'.repeat(70) + '\n';
  out += '📊 数据源: OKX CLI + OKX API\n';
  
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