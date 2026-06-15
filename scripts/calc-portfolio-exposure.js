#!/usr/bin/env node
/**
 * calc-portfolio-exposure.js — 组合暴露度计算（组合级别 BTC 跟踪风险快照）
 *
 * 用法:
 *   # 模式 1：纯快照（当前实盘持仓）
 *   node scripts/calc-portfolio-exposure.js
 *
 *   # 模式 2：边际评估（开仓筛选用）
 *   node scripts/calc-portfolio-exposure.js --candidate INJ --direction long --nominal 50
 *
 * 输出:
 *   - 组合 Beta（加权平均，多单正贡献/空单负贡献）
 *   - 组合下行相关（权重加权）
 *   - 同向暴露比例（long%/short%）
 *   - 互相关矩阵 → 高相关集群检测
 *   - BTC 压力测试（±3% / ±5%）
 *   - 组合风险评分 0-100
 *   - 告警列表
 *
 * 数据源: OKX 实盘持仓 + OKX K线（15m，96 根 ≈ 1 天）
 * 缓存: data/cache/btc-correlation-{COIN}.json（15 分钟 TTL）
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ═══ 配置 ═══
const WORKSPACE = path.resolve(__dirname, '..');
const PROXY = path.join(WORKSPACE, 'scripts', 'okx-proxy.sh');
const PROXY_URL = process.env.PROXY_URL || 'http://127.0.0.1:7890';
const CACHE_DIR = path.join(WORKSPACE, 'data', 'cache');
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 分钟
const BARS = ['15m', '1H'];
const LIMIT = 96; // 15m: 约 1 天 | 1H: 约 4 天（展示用，不参与评分）

// ═══ 集群阈值 ═══
const CLUSTER_THRESHOLD = 0.70; // pairwise corr > 此值视为同一集群

// ═══ 告警阈值（快照模式用，仅供参考） ═══
const THRESHOLDS = {
  absBetaLimit: 1.0,           // abs(加权Beta) > 1.0 → 告警
  maxClusterNavPct: 40,        // 有效集群 > 40% NAV → 告警
  stressTestPnl: 8,            // 压力测试预估亏损 > 8% → 告警
};

// ═══ 阶梯硬拒绝阈值（候选模式，按 N+1 笔数分档） ═══
// 1-3笔: 不拦截
// 第4笔: 松阈值
// 第5笔: 中阈值
// 第6笔+: 全阈值
const TIERED_LIMITS = [
  // [minPositions, absBetaMax, clusterEffectiveMax, stressPnlMax]
  // minPositions = 新组合的仓位总数（含候选）
  { minPos: 1, absBeta: 99,   cluster: 100, stress: 99  },  // 1-3 笔不拦截（上限极高）
  { minPos: 4, absBeta: 1.5,  cluster: 55,  stress: 12   },  // 第4笔：松
  { minPos: 5, absBeta: 1.2,  cluster: 45,  stress: 10   },  // 第5笔：中
  { minPos: 6, absBeta: 1.0,  cluster: 40,  stress: 8    },  // 第6笔+：全阈值
];

// ═══ 风险等级 ═══
const RISK_LEVELS = [
  { max: 20, level: 'low', label: '低风险' },
  { max: 40, level: 'moderate', label: '中等风险' },
  { max: 60, level: 'elevated', label: '偏高风险' },
  { max: 80, level: 'high', label: '高风险' },
  { max: 101, level: 'critical', label: '极高风险' },
];

// ═══ 参数解析 ═══
const args = process.argv.slice(2);
let candidateCoin = null;
let candidateDirection = null;
let candidateNominal = null;
let globalThreshold = null;  // 全局风险评分上限，null=不启用

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--candidate' && i + 1 < args.length) {
    candidateCoin = args[++i].toUpperCase();
  } else if (args[i] === '--direction' && i + 1 < args.length) {
    candidateDirection = args[++i].toLowerCase();
  } else if (args[i] === '--nominal' && i + 1 < args.length) {
    candidateNominal = parseFloat(args[++i]);
  } else if (args[i] === '--global-threshold' && i + 1 < args.length) {
    globalThreshold = parseInt(args[++i]);
  }
}

const isCandidateMode = !!(candidateCoin && candidateDirection && candidateNominal);

if (isCandidateMode) {
  if (!['long', 'short'].includes(candidateDirection)) {
    console.error('--direction must be "long" or "short"');
    process.exit(1);
  }
  if (isNaN(candidateNominal) || candidateNominal <= 0) {
    console.error('--nominal must be a positive number');
    process.exit(1);
  }
}

// ═══ 工具函数 ═══
function log(msg) {
  process.stderr.write(`[portfolio-exposure] ${msg}\n`);
}

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function round(v, d = 4) {
  return Number(Number(v).toFixed(d));
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function nowTs() {
  return new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
}

function nowISO() {
  return new Date().toISOString();
}

// ═══ 获取 OKX 实盘持仓 ═══
function getLivePositions() {
  try {
    const raw = execSync(
      `bash "${PROXY}" --profile live account positions --json`,
      { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '[]') return [];
    const all = JSON.parse(trimmed);
    return all
      .filter(p => num(p.pos) !== 0)
      .map(p => ({
        instId: p.instId,
        coin: (p.instId || '').replace('-USDT-SWAP', '').replace('-USDT', ''),
        posSide: p.posSide,       // 'long' | 'short'
        pos: num(p.pos),
        notionalUsd: num(p.notionalUsd),
        avgPx: num(p.avgPx),
        markPx: num(p.markPx),
        lever: num(p.lever),
        upl: num(p.upl),
        uplRatio: num(p.uplRatio),
      }));
  } catch (e) {
    log(`OKX 持仓 API 失败: ${e.message}`);
    return null;
  }
}

// ═══ K线数据获取（带缓存，支持多时间尺度） ═══
function getCloses(coinSymbol, bar) {
  const barVal = bar || '15m';
  // 检查 K线缓存（按币种+时间尺度独立缓存）
  const klineCacheKey = `kline-${coinSymbol}-${barVal}`;
  const klineCached = cacheGet(klineCacheKey, 'kline');
  if (klineCached && klineCached.closes) {
    return { error: null, closes: klineCached.closes, fromCache: true };
  }

  const instId = `${coinSymbol}-USDT-SWAP`;
  const url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${barVal}&limit=${LIMIT}`;

  try {
    const raw = execSync(
      `curl -s --max-time 15 --proxy "${PROXY_URL}" "${url}"`,
      { encoding: 'utf8', timeout: 20000 }
    );
    const data = JSON.parse(raw);

    if (!data.data || data.data.length === 0) {
      return { error: `无K线: ${instId}`, closes: null };
    }

    const closes = data.data
      .map(c => parseFloat(c[4]))
      .reverse();

    if (closes.length < LIMIT * 0.8) {
      return { error: `K线不足: ${closes.length}/${LIMIT}`, closes: null };
    }

    // 写入 K线缓存（独立于相关性缓存）
    cacheSet(klineCacheKey, 'kline', { closes });

    return { error: null, closes };
  } catch (e) {
    return { error: `${instId}: ${e.message}`, closes: null };
  }
}

// ═══ 日志收益率 ═══
function logReturns(closes) {
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  return rets;
}

// ═══ Pearson 相关系数 ═══
function pearson(xs, ys) {
  const n = xs.length;
  if (n !== ys.length || n === 0) return null;

  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;

  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }

  if (vx === 0 || vy === 0) return 0;
  return cov / Math.sqrt(vx * vy);
}

// ═══ Beta 系数 ═══
function beta(xs, ys) {
  const n = xs.length;
  if (n !== ys.length || n === 0) return null;

  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;

  let cov = 0, vx = 0;
  for (let i = 0; i < n; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
  }

  if (vx === 0) return null;
  return cov / vx;
}

// ═══ 下行半相关（仅 BTC 下跌区间的 Pearson） ═══
function downsideCorrelation(btcRets, altRets) {
  const n = Math.min(btcRets.length, altRets.length);
  const bd = [], ad = [];
  for (let i = 0; i < n; i++) {
    if (btcRets[i] < 0) {
      bd.push(btcRets[i]);
      ad.push(altRets[i]);
    }
  }
  if (bd.length < 5) return { corr: null, count: bd.length };
  return { corr: pearson(bd, ad), count: bd.length };
}

// ═══ 不对称 Beta（上行/下行分开） ═══
// 上行 Beta：仅用 BTC 上涨区间的数据点
function upsideBeta(btcRets, altRets) {
  const n = Math.min(btcRets.length, altRets.length);
  const bu = [], au = [];
  for (let i = 0; i < n; i++) {
    if (btcRets[i] > 0) { bu.push(btcRets[i]); au.push(altRets[i]); }
  }
  if (bu.length < 5) return null;
  return beta(bu, au);
}

// 下行 Beta：仅用 BTC 下跌区间的数据点
function downsideBeta(btcRets, altRets) {
  const n = Math.min(btcRets.length, altRets.length);
  const bd = [], ad = [];
  for (let i = 0; i < n; i++) {
    if (btcRets[i] < 0) { bd.push(btcRets[i]); ad.push(altRets[i]); }
  }
  if (bd.length < 5) return null;
  return beta(bd, ad);
}

// ═══ 缓存管理 ═══
function cacheGet(key, bar) {
  try {
    const suffix = bar ? `-${bar}` : '';
    const file = path.join(CACHE_DIR, `btc-correlation-${key}${suffix}.json`);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - data.cached_at > CACHE_TTL_MS) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function cacheSet(key, bar, data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const suffix = bar ? `-${bar}` : '';
    const file = path.join(CACHE_DIR, `btc-correlation-${key}${suffix}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...data, cached_at: Date.now() }, null, 2) + '\n');
  } catch (_) {
    // 缓存写入失败不影响主流程
  }
}

// ═══ 单币 BTC 跟踪度计算（多时间尺度） ═══
function computeCoinMetricsAtBar(coin, bar) {
  if (coin === 'BTC') {
    return { corr: 1.0, beta: 1.0, downside_corr: 1.0, downside_beta: 1.0, upside_beta: 1.0, downside_count: 0, bar, error: null };
  }

  // 检查缓存（按时间尺度独立缓存）
  const cached = cacheGet(coin, bar);
  if (cached) {
    log(`  ♻️ ${coin}@${bar}: 缓存命中 (corr=${cached.corr} beta=${cached.beta})`);
    return {
      corr: cached.corr,
      beta: cached.beta,
      downside_corr: cached.downside_corr,
      downside_beta: cached.downside_beta ?? cached.beta,
      upside_beta: cached.upside_beta ?? cached.beta,
      downside_count: cached.downside_count,
      bar,
      error: null,
      fromCache: true,
    };
  }

  // 获取 BTC K线
  const btcResult = getCloses('BTC', bar);
  if (btcResult.error) {
    return { corr: null, beta: null, downside_corr: null, downside_beta: null, upside_beta: null, downside_count: 0, bar, error: `BTC K线: ${btcResult.error}` };
  }

  // 获取币种 K线
  const altResult = getCloses(coin, bar);
  if (altResult.error) {
    return { corr: null, beta: null, downside_corr: null, downside_beta: null, upside_beta: null, downside_count: 0, bar, error: `${coin} K线: ${altResult.error}` };
  }

  const btcRets = logReturns(btcResult.closes);
  const altRets = logReturns(altResult.closes);
  const ml = Math.min(btcRets.length, altRets.length);

  const c = pearson(btcRets.slice(0, ml), altRets.slice(0, ml));
  const b = beta(btcRets.slice(0, ml), altRets.slice(0, ml));
  const ds = downsideCorrelation(btcRets, altRets);
  const db = downsideBeta(btcRets, altRets);
  const ub = upsideBeta(btcRets, altRets);

  const result = {
    corr: c !== null ? round(c) : null,
    beta: b !== null ? round(b) : null,
    downside_corr: ds.corr !== null ? round(ds.corr) : null,
    downside_beta: db !== null ? round(db) : (b !== null ? round(b) : null),
    upside_beta: ub !== null ? round(ub) : (b !== null ? round(b) : null),
    downside_count: ds.count,
    bar,
    error: null,
    fromCache: false,
  };

  // 写入缓存
  if (result.corr !== null) {
    cacheSet(coin, bar, result);
  }

  return result;
}

function computeCoinMetrics(coin) {
  const metrics = {};
  for (const bar of BARS) {
    metrics[bar] = computeCoinMetricsAtBar(coin, bar);
  }
  // 向后兼容：用第一个 bar（15m）作为默认
  const m1 = metrics[BARS[0]];
  return {
    coin,
    corr: m1.corr,
    beta: m1.beta,
    downside_corr: m1.downside_corr,
    downside_beta: m1.downside_beta,
    upside_beta: m1.upside_beta,
    downside_count: m1.downside_count,
    error: m1.error,
    fromCache: m1.fromCache,
    tracking: metrics,  // 多时间尺度数据
  };

  return result;
}

// ═══ 互相关矩阵 + 集群检测 ═══
// 输入: [{coin, returns[]}], 输出: {matrix, clusters}
function buildCrossCorrelation(coinReturns) {
  const coins = coinReturns.map(c => c.coin);
  const n = coins.length;

  if (n <= 1) {
    return {
      matrix: [],
      clusters: n === 1 ? [{ coins, avg_pairwise_corr: 1.0, nav_pct: 0 }] : [],
    };
  }

  // 互相关矩阵
  const matrix = [];
  for (let i = 0; i < n; i++) {
    matrix[i] = [];
    for (let j = 0; j < n; j++) {
      if (i === j) {
        matrix[i][j] = 1.0;
      } else if (j < i) {
        matrix[i][j] = matrix[j][i];
      } else {
        const ml = Math.min(coinReturns[i].returns.length, coinReturns[j].returns.length);
        const c = pearson(
          coinReturns[i].returns.slice(0, ml),
          coinReturns[j].returns.slice(0, ml)
        );
        matrix[i][j] = c !== null ? round(c) : 0;
      }
    }
  }

  // 集群检测（连通分量）
  const visited = new Set();
  const clusters = [];

  for (let i = 0; i < n; i++) {
    if (visited.has(i)) continue;

    // BFS
    const cluster = [];
    const queue = [i];
    visited.add(i);

    while (queue.length > 0) {
      const cur = queue.shift();
      cluster.push(cur);
      for (let j = 0; j < n; j++) {
        if (!visited.has(j) && matrix[cur][j] > CLUSTER_THRESHOLD) {
          visited.add(j);
          queue.push(j);
        }
      }
    }

    if (cluster.length >= 2) {
      // 计算集群平均互相关
      let sumCorr = 0, pairCount = 0;
      for (let a = 0; a < cluster.length; a++) {
        for (let b = a + 1; b < cluster.length; b++) {
          sumCorr += matrix[cluster[a]][cluster[b]];
          pairCount++;
        }
      }
      const avgCorr = pairCount > 0 ? round(sumCorr / pairCount) : 1.0;

      clusters.push({
        coins: cluster.map(idx => coins[idx]),
        indices: cluster,
        avg_pairwise_corr: avgCorr,
        nav_pct: 0, // 后面填充
      });
    }
  }

  return { matrix, clusters, coinOrder: coins };
}

// ═══ 组合指标聚合 ═══
function buildPortfolioMetrics(positions, coinMetricsMap) {
  const metrics = {
    total_notional: 0,
    position_count: positions.length,
    positions: [],
    weighted_corr: null,
    weighted_beta: null,
    weighted_downside_corr: null,
    directional_exposure: { long_pct: 0, short_pct: 0, dominant: 'none' },
    clusters: [],
    stress_test: {},
    risk_score: 0,
    risk_level: 'low',
    warnings: [],
  };

  if (positions.length === 0) {
    metrics.risk_level = 'low';
    metrics._score_breakdown = { directional: 0, beta_mag: 0, cluster: 0, correlation: 0, stress_test: 0 };
    metrics.weighted_beta_abs = 0;
    return metrics;
  }

  // 总市值
  const totalNotional = positions.reduce((s, p) => s + p.notionalUsd, 0);
  metrics.total_notional = round(totalNotional, 2);

  // 方向暴露
  const longNotional = positions
    .filter(p => p.posSide === 'long')
    .reduce((s, p) => s + p.notionalUsd, 0);
  const shortNotional = positions
    .filter(p => p.posSide === 'short')
    .reduce((s, p) => s + p.notionalUsd, 0);

  metrics.directional_exposure = {
    long_pct: totalNotional > 0 ? round((longNotional / totalNotional) * 100) : 0,
    short_pct: totalNotional > 0 ? round((shortNotional / totalNotional) * 100) : 0,
    dominant: longNotional > shortNotional ? 'long' : (shortNotional > longNotional ? 'short' : 'balanced'),
  };

  // 加权平均 corr / beta / downside_corr
  let sumCorr = 0, sumBeta = 0, sumBetaMag = 0, sumDownside = 0;
  let corrWeightSum = 0, betaWeightSum = 0, downWeightSum = 0;

  const positionDetails = [];

  for (const pos of positions) {
    const coinMetric = coinMetricsMap[pos.coin];
    const weight = totalNotional > 0 ? pos.notionalUsd / totalNotional : 0;
    const dirSign = pos.posSide === 'long' ? 1 : -1;

    const detail = {
      coin: pos.coin,
      instId: pos.instId,
      direction: pos.posSide,
      notionalUsd: round(pos.notionalUsd, 2),
      weight_pct: round(weight * 100, 1),
      corr: coinMetric?.corr ?? null,
      beta: coinMetric?.beta ?? null,
      downside_corr: coinMetric?.downside_corr ?? null,
      beta_contrib: null, // dirSign × beta × weight（后填）
      beta_mag_contrib: null, // |beta| × weight（后填，不计方向）
    };

    if (coinMetric?.corr !== null && coinMetric.corr !== undefined) {
      sumCorr += coinMetric.corr * pos.notionalUsd;
      corrWeightSum += pos.notionalUsd;
    }
    if (coinMetric?.beta !== null && coinMetric.beta !== undefined) {
      // Beta 贡献：多单正向、空单负向
      const betaContrib = dirSign * coinMetric.beta * pos.notionalUsd;
      const betaMagContrib = Math.abs(coinMetric.beta) * pos.notionalUsd;
      sumBeta += betaContrib;
      sumBetaMag += betaMagContrib;
      betaWeightSum += pos.notionalUsd;
      detail.beta_contrib = round(betaContrib, 4);
      detail.beta_mag_contrib = round(betaMagContrib, 4);
    }
    if (coinMetric?.downside_corr !== null && coinMetric.downside_corr !== undefined) {
      sumDownside += coinMetric.downside_corr * pos.notionalUsd;
      downWeightSum += pos.notionalUsd;
    }

    positionDetails.push(detail);
  }

  metrics.positions = positionDetails;

  metrics.weighted_corr = corrWeightSum > 0 ? round(sumCorr / corrWeightSum) : null;
  metrics.weighted_downside_corr = downWeightSum > 0 ? round(sumDownside / downWeightSum) : null;

  // 组合 Beta = sum(dirSign × beta × weight) — 带方向，可抵消
  // 为正 → BTC涨组合涨，为负 → BTC涨组合跌
  metrics.weighted_beta = betaWeightSum > 0 ? round(sumBeta / betaWeightSum) : null;
  // Beta 暴露幅度 = Σ(weight × |β|) — 不计方向符号，真正反映仓位对 BTC 的敏感程度
  metrics.weighted_beta_mag = betaWeightSum > 0 ? round(sumBetaMag / betaWeightSum) : null;

  // ═══ 互相关矩阵 → 集群 ═══
  if (positions.length >= 2) {
    const coinReturnsPromises = [];
    const btcResult = getCloses('BTC');

    for (const pos of positions) {
      if (pos.coin === 'BTC') continue;
      const altResult = getCloses(pos.coin);
      if (!altResult.error && !btcResult.error) {
        // 需要与 BTC 对齐的实际 returns 用于互相关
        // 这里我们用 alt vs alt 的互相关：只需要每个币自己的 returns
        coinReturnsPromises.push({
          coin: pos.coin,
          returns: logReturns(altResult.closes),
        });
      }
    }

    // 添加 BTC 自身
    if (positions.some(p => p.coin === 'BTC') && !btcResult.error) {
      coinReturnsPromises.push({
        coin: 'BTC',
        returns: logReturns(btcResult.closes),
      });
    }

    const crossResult = buildCrossCorrelation(coinReturnsPromises);

    // 填充集群 NAV%
    for (const cluster of crossResult.clusters) {
      const clusterNotional = positions
        .filter(p => cluster.coins.includes(p.coin))
        .reduce((s, p) => s + p.notionalUsd, 0);
      cluster.nav_pct = totalNotional > 0 ? round((clusterNotional / totalNotional) * 100, 1) : 0;
    }

    metrics.clusters = crossResult.clusters;
    metrics.cross_correlation_matrix = crossResult.matrix.map((row, i) => ({
      coin: crossResult.coinOrder?.[i] || `coin_${i}`,
      correlations: row,
    }));

    // 标记每个仓位所属集群
    for (const detail of positionDetails) {
      const memberClusters = [];
      for (const cluster of crossResult.clusters) {
        if (cluster.coins.includes(detail.coin)) {
          memberClusters.push(cluster.coins.filter(c => c !== detail.coin).join('+'));
        }
      }
      detail.clusters = memberClusters.length > 0 ? memberClusters : null;
    }
  }

  // ═══ BTC 压力测试（使用不对称 Beta） ═══
  // BTC 下跌场景 → 用下行 Beta；BTC 上涨场景 → 用上行 Beta
  const scenarios = [
    { label: 'btc_minus_3pct',   btcMove: -0.03, betaField: 'downside_beta' },
    { label: 'btc_minus_5pct',   btcMove: -0.05, betaField: 'downside_beta' },
    { label: 'btc_plus_3pct',    btcMove:  0.03, betaField: 'upside_beta' },
    { label: 'btc_plus_5pct',    btcMove:  0.05, betaField: 'upside_beta' },
  ];

  for (const sc of scenarios) {
    let estPnl = 0;

    for (const pos of positions) {
      const coinMetric = coinMetricsMap[pos.coin];
      const betaField = sc.betaField;
      // 下行场景用下行Beta，上行场景用上行Beta，回退到整体Beta
      const beta_i = (coinMetric?.[betaField] ?? coinMetric?.beta) ?? 0.5;
      const dirSign = pos.posSide === 'long' ? 1 : -1;
      estPnl += pos.notionalUsd * dirSign * beta_i * sc.btcMove;
    }

    metrics.stress_test[sc.label] = {
      btc_move_pct: round(sc.btcMove * 100),
      est_pnl_usd: round(estPnl, 2),
      est_pnl_pct: totalNotional > 0 ? round((estPnl / totalNotional) * 100, 2) : 0,
    };
  }

  // ═══ 风险评分 0-100 ═══
  // 权重新配: 方向暴露10% + Beta暴露幅度20% + 集群(过滤后)10% + 绝对相关25% + 压力测试35%

  // 1. 方向暴露 (10%) — 辅助指标
  const maxExposure = Math.max(
    metrics.directional_exposure.long_pct,
    metrics.directional_exposure.short_pct
  );
  const dirScore = clamp((maxExposure - 50) / 50 * 100, 0, 100);

  // 2. Beta 暴露幅度 (20%) — 不计方向符号抵消，靠多弱相关小仓位稀释
  //   用 Σ(weight × |β|) 而非 |Σ(dirSign × β × weight)|，避免负β正多单与正β正多单互相抵消
  const avgBetaMag = metrics.weighted_beta_mag ?? 0;
  const betaScore = clamp(avgBetaMag / 1.5 * 100, 0, 100);  // avg|β|=1.5→100分
  // 保留符号版本作为参考输出
  const absBeta = metrics.weighted_beta !== null ? Math.abs(metrics.weighted_beta) : 0;
  metrics.weighted_beta_abs = round(absBeta);

  // 3. 最大集群有效占比 (10%) — 仅计入与 BTC 共振的集群
  let maxClusterEffectivePct = 0;
  for (const cluster of metrics.clusters) {
    // 计算集群平均 BTC 相关系数
    let clusterBCorrSum = 0, clusterBCorrCount = 0;
    for (const c of cluster.coins) {
      const cm = coinMetricsMap[c];
      if (cm?.corr !== null && cm?.corr !== undefined) {
        clusterBCorrSum += cm.corr;
        clusterBCorrCount++;
      }
    }
    const avgBCorr = clusterBCorrCount > 0 ? clusterBCorrSum / clusterBCorrCount : 0;
    cluster.avg_b_corr = round(avgBCorr, 3);

    // 不与 BTC 共振的集群（低 BTC corr）不计入风险评分
    // 它们可能互相关高但独立于市场趋势运行
    if (avgBCorr < 0.4) continue;

    let clusterLong = 0, clusterShort = 0, clusterNav = 0;
    for (const pos of positions) {
      if (cluster.coins.includes(pos.coin)) {
        clusterNav += pos.notionalUsd;
        if (pos.posSide === 'long') clusterLong += pos.notionalUsd;
        else clusterShort += pos.notionalUsd;
      }
    }
    const clusterDirConc = clusterNav > 0 ? Math.max(clusterLong, clusterShort) / clusterNav : 1;
    const effectivePct = (clusterNav / totalNotional) * 100 * clusterDirConc;
    cluster.effective_nav_pct = round(effectivePct, 1);
    if (effectivePct > maxClusterEffectivePct) maxClusterEffectivePct = effectivePct;
  }
  const clusterScore = clamp(maxClusterEffectivePct, 0, 100);

  // 4. 绝对相关幅度 (25%) — "仓位整体跟随 BTC 的程度"
  const absCorr = metrics.weighted_corr !== null ? Math.abs(metrics.weighted_corr) : 0.5;
  const corrScore = clamp(absCorr * 100, 0, 100);

  // 5. 压力测试最差情景 (35%) — 终极后果：BTC 涨/跌时组合的实际预估 PnL
  let worstPnlPct = 0;
  let worstScenarioLabel = '';
  for (const sc of scenarios) {
    const pct = Math.abs(metrics.stress_test[sc.label]?.est_pnl_pct || 0);
    if (pct > worstPnlPct) {
      worstPnlPct = pct;
      worstScenarioLabel = sc.label;
    }
  }
  const stressScore = clamp(worstPnlPct * 10, 0, 100);

  metrics.risk_score = Math.round(
    dirScore * 0.10 + betaScore * 0.20 + clusterScore * 0.10 + corrScore * 0.25 + stressScore * 0.35
  );
  metrics._score_breakdown = {
    directional: round(dirScore),
    beta_mag: round(betaScore),
    cluster: round(clusterScore),
    correlation: round(corrScore),
    stress_test: round(stressScore),
  };

  // 风险等级
  for (const rl of RISK_LEVELS) {
    if (metrics.risk_score <= rl.max) {
      metrics.risk_level = rl.level;
      break;
    }
  }

  // ═══ 告警生成 ═══
  metrics.warnings = [];
  const dom = metrics.directional_exposure.dominant;

  if (avgBetaMag > THRESHOLDS.absBetaLimit) {
    metrics.warnings.push(
      `组合 Beta 暴露幅度 ${round(avgBetaMag)}：对 BTC 方向暴露过高（不计方向对冲）`
    );
  }

  if (maxClusterEffectivePct > THRESHOLDS.maxClusterNavPct) {
    const biggestCluster = metrics.clusters.reduce((a, b) => (a.nav_pct || 0) > (b.nav_pct || 0) ? a : b, metrics.clusters[0] || {});
    metrics.warnings.push(
      `集群冗余：${(biggestCluster.coins || []).join('/')} 高度相关，有效占 NAV ${round(maxClusterEffectivePct)}%`
    );
  }

  if (worstPnlPct > THRESHOLDS.stressTestPnl) {
    const btcMove = metrics.stress_test[worstScenarioLabel]?.btc_move_pct || 5;
    metrics.warnings.push(
      `压力测试：BTC ${btcMove > 0 ? '+' : ''}${btcMove}% 时预估组合亏损 ${round(worstPnlPct)}%`
    );
  }

  return metrics;
}

// ═══ 候选仓位边际评估（阶梯硬拒绝） ═══
function evaluateCandidate(currentMetrics, candidateCoin, candidateDirection, candidateNominal) {
  // 获取候选币跟踪度
  const candMetric = computeCoinMetrics(candidateCoin);

  // 构建含候选仓位的扩展列表
  // 开仓(open): 新增仓位 → 追加到列表
  // 加仓(add): 同一币种同方向已有仓位 → 合并 nominal,不创建重复条目
  const currentPositions = currentMetrics.positions.map(p => ({
    coin: p.coin,
    instId: p.instId,
    posSide: p.direction,
    notionalUsd: p.notionalUsd,
    pos: 0, avgPx: 0, markPx: 0, lever: 1, upl: 0, uplRatio: 0,
  }));

  // 检测是否为加仓: 候选币种 + 方向在现有仓位中已存在
  const existingIdx = currentPositions.findIndex(
    p => p.coin === candidateCoin && p.posSide === candidateDirection
  );

  let extendedPositions, newCount;
  if (existingIdx >= 0) {
    // 加仓: 合并到已有仓位
    extendedPositions = currentPositions.map((p, i) => {
      if (i === existingIdx) return { ...p, notionalUsd: round(p.notionalUsd + candidateNominal, 2) };
      return p;
    });
    newCount = extendedPositions.length;  // 仓位数量不变
    log(`  加仓检测: ${candidateCoin} 已有 ${currentPositions[existingIdx].notionalUsd}U → 合并后 ${extendedPositions[existingIdx].notionalUsd}U`);
  } else {
    // 开仓: 追加新仓位
    const candidatePos = {
      coin: candidateCoin,
      instId: `${candidateCoin}-USDT-SWAP`,
      posSide: candidateDirection,
      notionalUsd: candidateNominal,
      pos: 0, avgPx: 0, markPx: 0, lever: 1, upl: 0, uplRatio: 0,
    };
    extendedPositions = [...currentPositions, candidatePos];
    newCount = extendedPositions.length;
  }

  // 合并 coinMetrics（含缓存复用）
  const extendedMetricsMap = {};
  const coinMetricsMap = {};
  for (const pos of currentPositions) {
    if (!coinMetricsMap[pos.coin]) coinMetricsMap[pos.coin] = computeCoinMetrics(pos.coin);
  }
  Object.assign(extendedMetricsMap, coinMetricsMap);
  extendedMetricsMap[candidateCoin] = candMetric;

  // 算新组合指标
  const newMetrics = buildPortfolioMetrics(extendedPositions, extendedMetricsMap);

  // 边际变化
  const delta = newMetrics.risk_score - currentMetrics.risk_score;

  // ═══ 改善豁免：降低风险 → 无条件通过 ═══
  if (delta < 0) {
    return {
      new_position_count: newCount,
      current_risk_score: currentMetrics.risk_score,
      with_candidate_risk_score: newMetrics.risk_score,
      risk_delta: delta,
      decision: 'pass',
      reasons: [`降低组合风险 (${currentMetrics.risk_score}→${newMetrics.risk_score})，豁免阈值检查`],
      candidate_metrics: {
        coin: candidateCoin, direction: candidateDirection, nominal: candidateNominal,
        corr: candMetric.corr, beta: candMetric.beta, downside_corr: candMetric.downside_corr,
        downside_beta: candMetric.downside_beta, upside_beta: candMetric.upside_beta,
      },
      with_portfolio: newMetrics,
    };
  }

  // ═══ 全局风险上限：评分超过上限 → 硬拒绝 ═══
  if (globalThreshold !== null && newMetrics.risk_score > globalThreshold) {
    return {
      new_position_count: newCount,
      current_risk_score: currentMetrics.risk_score,
      with_candidate_risk_score: newMetrics.risk_score,
      risk_delta: delta,
      decision: 'reject',
      reasons: [`全局风险上限: ${newMetrics.risk_score} > ${globalThreshold}`],
      candidate_metrics: {
        coin: candidateCoin, direction: candidateDirection, nominal: candidateNominal,
        corr: candMetric.corr, beta: candMetric.beta, downside_corr: candMetric.downside_corr,
        downside_beta: candMetric.downside_beta, upside_beta: candMetric.upside_beta,
      },
      with_portfolio: newMetrics,
    };
  }

  // ═══ 阶梯硬拒绝（仅对不降风险的仓位生效） ═══
  const reasons = [];
  let pass = true;

  if (newCount <= 3) {
    // 1-3笔：完全不拦截
    reasons.push('前3笔不限制');
  } else {
    // 找到适用的阶梯阈值
    let tier = TIERED_LIMITS[TIERED_LIMITS.length - 1];
    for (const t of TIERED_LIMITS) {
      if (newCount >= t.minPos) tier = t;
    }

    // 1. abs(Beta) 检查
    const newAbsBeta = Math.abs(newMetrics.weighted_beta ?? 0);
    if (newAbsBeta > tier.absBeta) {
      pass = false;
      reasons.push(`组合 Beta 绝对值 ${round(newAbsBeta)} 超过第${newCount}笔阈值 ${tier.absBeta}`);
    }

    // 2. 集群有效占比检查（且候选在该集群中）
    let newMaxClusterEff = 0;
    for (const cluster of (newMetrics.clusters || [])) {
      const eff = cluster.effective_nav_pct ?? cluster.nav_pct ?? 0;
      if (eff > newMaxClusterEff) newMaxClusterEff = eff;
    }
    if (newMaxClusterEff > tier.cluster) {
      // 检查候选是否在超限集群中
      const offendingCluster = (newMetrics.clusters || []).find(
        c => (c.effective_nav_pct ?? c.nav_pct ?? 0) > tier.cluster && c.coins.includes(candidateCoin)
      );
      if (offendingCluster) {
        pass = false;
        reasons.push(`加入后 ${offendingCluster.coins.join('/')} 集群有效占比 ${round(newMaxClusterEff)}% 超过第${newCount}笔阈值 ${tier.cluster}%`);
      }
    }

    // 3. 压力测试
    let newWorstPnl = 0;
    const scenarioLabels = Object.keys(newMetrics.stress_test || {});
    for (const label of scenarioLabels) {
      const pct = Math.abs(newMetrics.stress_test[label]?.est_pnl_pct || 0);
      if (pct > newWorstPnl) newWorstPnl = pct;
    }
    if (newWorstPnl > tier.stress) {
      pass = false;
      reasons.push(`BTC 压力测试预估亏损 ${round(newWorstPnl)}% 超过第${newCount}笔阈值 ${tier.stress}%`);
    }
  }

  return {
    new_position_count: newCount,
    current_risk_score: currentMetrics.risk_score,
    with_candidate_risk_score: newMetrics.risk_score,
    risk_delta: delta,
    decision: pass ? 'pass' : 'reject',
    reasons: reasons.length > 0 ? reasons : ['通过'],
    candidate_metrics: {
      coin: candidateCoin,
      direction: candidateDirection,
      nominal: candidateNominal,
      corr: candMetric.corr,
      beta: candMetric.beta,
      downside_corr: candMetric.downside_corr,
      downside_beta: candMetric.downside_beta,
      upside_beta: candMetric.upside_beta,
    },
    with_portfolio: newMetrics,
  };
}

// ═══ 主流程 ═══
async function main() {
  log('开始组合暴露度计算...');

  // 1. 获取实盘持仓
  const positions = getLivePositions();
  if (positions === null) {
    const result = { error: '无法获取 OKX 实盘持仓', timestamp: nowISO() };
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  log(`实盘持仓: ${positions.length} 个`);

  // 2. 逐币计算跟踪度
  const coinMetricsMap = {};
  const uniqueCoins = [...new Set(positions.map(p => p.coin))];

  for (const coin of uniqueCoins) {
    log(`计算 ${coin} 跟踪度...`);
    coinMetricsMap[coin] = computeCoinMetrics(coin);
    if (coinMetricsMap[coin].error) {
      log(`  ⚠️ ${coin}: ${coinMetricsMap[coin].error}`);
    } else {
      log(`  ✅ ${coin}: corr=${coinMetricsMap[coin].corr} beta=${coinMetricsMap[coin].beta} down_corr=${coinMetricsMap[coin].downside_corr}`);
    }
  }

  // 3. 聚合组合指标
  const portfolio = buildPortfolioMetrics(positions, coinMetricsMap);

  log(`组合 Beta=${portfolio.weighted_beta} | 下行相关=${portfolio.weighted_downside_corr} | 风险评分=${portfolio.risk_score}/${portfolio.risk_level}`);

  // 4. 构建输出
  const output = {
    timestamp: nowISO(),
    timestamp_gmt8: nowTs(),
    mode: isCandidateMode ? 'candidate' : 'snapshot',
    position_count: portfolio.position_count,
    total_notional: portfolio.total_notional,

    // 单币明细（含多时间尺度跟踪数据）
    coin_metrics: Object.fromEntries(
      Object.entries(coinMetricsMap).map(([coin, m]) => [coin, {
        corr: m.corr,
        beta: m.beta,
        downside_corr: m.downside_corr,
        downside_beta: m.downside_beta,
        upside_beta: m.upside_beta,
        error: m.error,
        tracking: m.tracking,  // { '15m': {...} }
      }])
    ),

    // 仓位加权明细
    positions: portfolio.positions,

    // 组合聚合指标
    portfolio: {
      weighted_corr: portfolio.weighted_corr,
      weighted_beta: portfolio.weighted_beta,
      weighted_beta_mag: portfolio.weighted_beta_mag,
      weighted_beta_abs: portfolio.weighted_beta_abs,
      weighted_downside_corr: portfolio.weighted_downside_corr,
      directional_exposure: portfolio.directional_exposure,
      clusters: portfolio.clusters,
      stress_test: portfolio.stress_test,
      risk_score: portfolio.risk_score,
      risk_level: portfolio.risk_level,
      score_breakdown: portfolio._score_breakdown,
      warnings: portfolio.warnings,
    },
  };

  // 5. 候选评估
  if (isCandidateMode) {
    const currentSimpleMetrics = {
      risk_score: portfolio.risk_score,
      position_count: portfolio.position_count,
      positions: portfolio.positions,
    };
    output.candidate_evaluation = evaluateCandidate(
      currentSimpleMetrics,
      candidateCoin,
      candidateDirection,
      candidateNominal
    );
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch(e => {
  log(`致命错误: ${e.message}`);
  console.log(JSON.stringify({ error: e.message, timestamp: nowISO() }, null, 2));
  process.exit(1);
});
