#!/usr/bin/env node
/**
 * refresh-onchain.js — 山寨币链上数据定时刷新脚本
 *
 * 用法: node scripts/refresh-onchain.js <COIN> [--cycle-dir <dir>] [--save]
 *
 * 功能:
 *   1. 多链搜索代币合约地址
 *   2. 并行采集 4 维度链上数据（holders / advanced-info / cluster-overview / trades）
 *   3. 填充标准化 JSON（字段名: 中文(英文)）
 *   4. 分类异常状态
 *
 * 输出: JSON 到 stdout
 * --save: 同时写入 {CYCLE_DIR}/data-context/onchain-{COIN}-{ts}.json
 */

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const COIN = (process.argv[2] || '').toUpperCase();
if (!COIN) {
  console.error('用法: node scripts/refresh-onchain.js <COIN> [--cycle-dir <dir>] [--save]');
  process.exit(1);
}

const SAVE = process.argv.includes('--save');
const CYCLE_DIR_ARG = process.argv.includes('--cycle-dir')
  ? process.argv[process.argv.indexOf('--cycle-dir') + 1]
  : null;

const WORKSPACE = path.resolve(__dirname, '..');
const TIMEOUT_MS = 25000;

// ═══ 链搜索顺序 ═══
const CHAIN_SEARCH = [
  { name: 'ethereum', idx: '1',     desc: '默认 (ETH+SOL)' },
  { name: 'bsc',      idx: '56',    desc: 'BSC' },
  { name: 'arbitrum', idx: '42161', desc: 'Arbitrum' },
  { name: 'base',     idx: '8453',  desc: 'Base' },
  { name: 'polygon',  idx: '137',   desc: 'Polygon' },
];

// ═══ 已知原生 L1/L2 链（onchainOS 不支持） ═══
const NATIVE_L1_COINS = {
  'TON':   'TON 链（The Open Network）',
  'NOT':   'TON 链（The Open Network）',
  'HMSTR': 'TON 链（The Open Network）',
  'THETA': 'Theta Network 主网',
  'BABY':  'Cosmos SDK (Babylon BBN 链)',
  'MINA':  'Mina Protocol 主网',
  'CORE':  'Core Chain 主网（BTC L2）',
  'KSM':   'Kusama 网络（Substrate）',
  'INIT':  'Cosmos/IBC 生态 (Initia L1)',
  'ATOM':  'Cosmos Hub',
  'TIA':   'Celestia 主网',
  'DYM':   'Dymension 主网',
  'OSMO':  'Osmosis (Cosmos)',
  'INJ':   'Injective (Cosmos)',
  'SEI':   'Sei Network (Cosmos)',
  'SUI':   'Sui 主网',
  'APT':   'Aptos 主网',
  'DOT':   'Polkadot 中继链',
  'NEAR':  'NEAR Protocol 主网',
  'FTM':   'Fantom/Opera 主网',
  'AVAX':  'Avalanche C/X/P Chain',
  'XRP':   'XRP Ledger',
  'ADA':   'Cardano 主网',
  'TRX':   'TRON 主网',
  'ETC':   'Ethereum Classic',
  'ZEC':   'Zcash 主网',
  'XMR':   'Monero 主网',
  'ALGO':  'Algorand 主网',
  'XTZ':   'Tezos 主网',
  'EOS':   'EOS 主网',
  'ICP':   'Internet Computer 主网',
  'FIL':   'Filecoin 主网',
  'AR':    'Arweave 主网',
  'FLOW':  'Flow 主网',
  'HBAR':  'Hedera 主网',
  'STRK':  'StarkNet L2（合约在 ETH L1 但尚未被 onchainOS 索引）',
  'ZKSYNC': 'zkSync Era L2',
  'SCROLL': 'Scroll L2',
  'LINEA': 'Linea L2',
  'BLAST': 'Blast L2',
  'MNT':   'Mantle L2',
  'MODE':  'Mode Network L2',
  'TAIKO': 'Taiko L2',
};

// ═══ 工具函数 ═══
function nowISO() {
  return new Date(Date.now() + 8 * 3600000).toISOString().replace('Z', '+08:00');
}

function nowDateStr() {
  const d = new Date(Date.now() + 8 * 3600000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function nowTimeStr() {
  const d = new Date(Date.now() + 8 * 3600000);
  return d.toISOString().slice(11, 16).replace(':', '');
}

function toNum(v) {
  if (v === null || v === undefined || v === '' || v === '--') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function pctStrToNum(v) {
  return toNum(v);
}

function loadEnv() {
  const envFile = path.join(os.homedir(), '.onchainos', '.env');
  try {
    const content = fs.readFileSync(envFile, 'utf8');
    const env = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
      }
    }
    return env;
  } catch (e) {
    console.error('  [WARN] 无法读取 onchainos .env');
    return {};
  }
}

function runOnchainos(args) {
  const envVars = loadEnv();
  const env = { ...process.env, ...envVars };
  const cmd = `onchainos ${args}`;
  try {
    const out = execSync(cmd, { encoding: 'utf8', timeout: TIMEOUT_MS, stdio: ['pipe', 'pipe', 'pipe'], env });
    const trimmed = out.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  } catch (e) {
    const stderr = (e.stderr || '').toString().trim();
    if (stderr) console.error(`  [onchainos ERR] ${stderr.slice(0, 200)}`);
    return null;
  }
}

function runOnchainosAsync(args) {
  return new Promise((resolve) => {
    const envVars = loadEnv();
    const env = { ...process.env, ...envVars };
    const cmd = `onchainos ${args}`;
    exec(cmd, { timeout: TIMEOUT_MS, env }, (error, stdout, stderr) => {
      if (error) {
        const msg = (stderr || '').toString().trim();
        if (msg) console.error(`  [onchainos ERR] ${msg.slice(0, 200)}`);
        resolve(null);
        return;
      }
      const trimmed = (stdout || '').trim();
      if (!trimmed) { resolve(null); return; }
      try {
        resolve(JSON.parse(trimmed));
      } catch (e) {
        resolve(null);
      }
    });
  });
}

function scoreCandidate(r, chainName) {
  // 评分候选代币，分数越高越好
  // 核心原则：市值是主导因素，无持有人数据加重罚
  let score = 0;
  const mcap = toNum(r.marketCap) || 0;
  const holders = toNum(r.holders);

  // 市值（百万美元，主导因素）
  score += mcap / 1_000_000;

  // 无持有人数据 → 重罚（90%），此类代币大概率不是真实交易标的
  if (!holders || holders === 0) score *= 0.1;

  // 社区认可 → 小加分
  if (r.tagList?.communityRecognized === true) score += 5;

  // 有持有人 → 小加分
  if (holders && holders > 0) score += 3;

  // 链优先级（轻微 tiebreaker）: ETH > BSC > Arbitrum > Base > Polygon > Solana
  const chainPriority = { '1': 2, '56': 1.5, '42161': 1, '8453': 0.8, '137': 0.5, '501': 0 };
  score += chainPriority[String(r.chainIndex)] || 0;

  return score;
}

function collectCandidates(results, targetCoin, chainName) {
  if (!results || !Array.isArray(results) || results.length === 0) return [];
  const candidates = [];
  for (const r of results) {
    const symbol = (r.tokenSymbol || '').toUpperCase();
    if (symbol === targetCoin) {
      const mcap = toNum(r.marketCap);
      if (mcap && mcap < 10000) continue; // 过滤垃圾币
      candidates.push({ token: r, chainName, chainIndex: r.chainIndex });
    }
  }
  return candidates;
}

// ═══ 主流程 ═══
async function main() {
  console.error(`[refresh-onchain] 开始: ${COIN}`);
  console.error(`[refresh-onchain] 步骤1: 多链搜索...`);

  let matchedToken = null;
  let matchedChain = null;
  const searchPath = [];
  const searchNotes = [];
  const allCandidates = [];

  // 搜索所有链，收集全部候选
  for (const chain of CHAIN_SEARCH) {
    console.error(`  → 搜索 ${chain.desc}...`);
    searchPath.push(chain.idx);

    let result;
    if (chain.idx === '1') {
      result = runOnchainos(`token search --query ${COIN}`);
    } else {
      result = runOnchainos(`token search --query ${COIN} --chains "${chain.idx}"`);
    }

    if (!result || !result.ok || !Array.isArray(result.data)) continue;

    // 收集此链的所有候选（默认搜索返回 ETH+SOL 两个链的结果）
    const candidates = collectCandidates(result.data, COIN, chain.name);
    for (const c of candidates) {
      allCandidates.push(c);
    }

    // 记录同名低市值排除
    for (const r of result.data) {
      const sym = (r.tokenSymbol || '').toUpperCase();
      const mcap = toNum(r.marketCap);
      if (sym === COIN && mcap && mcap < 10000) {
        searchNotes.push(`${chain.desc} 发现同名低市值代币 ${r.tokenName} ($${mcap.toFixed(0)})，已排除`);
      }
    }
  }

  // 从所有候选中选择最佳匹配
  if (allCandidates.length > 0) {
    // 按评分降序
    allCandidates.sort((a, b) => scoreCandidate(b.token, b.chainName) - scoreCandidate(a.token, a.chainName));
    const best = allCandidates[0];
    matchedToken = best.token;
    matchedChain = CHAIN_SEARCH.find(c => c.idx === String(best.chainIndex)) || { name: `chain ${best.chainIndex}`, idx: String(best.chainIndex) };

    const chainLabel = matchedToken.chainIndex === '501' ? 'solana' :
                       matchedToken.chainIndex === '56' ? 'bsc' :
                       matchedToken.chainIndex === '1' ? 'ethereum' :
                       `chain ${matchedToken.chainIndex}`;
    matchedChain = { ...matchedChain, name: chainLabel };

    console.error(`  ✅ 匹配: ${matchedToken.tokenName} (${matchedToken.tokenSymbol}) on ${chainLabel}, 市值 $${toNum(matchedToken.marketCap)?.toLocaleString()}`);

    if (allCandidates.length > 1) {
      console.error(`  ℹ️ 共找到 ${allCandidates.length} 个候选，已选择最佳匹配`);
      for (const c of allCandidates.slice(1)) {
        console.error(`     - ${c.token.tokenName} on chain ${c.chainIndex}: mcap=$${toNum(c.token.marketCap)?.toLocaleString()}, recognized=${c.token.tagList?.communityRecognized || false}`);
      }
    }
  }

  // ═══ 步骤2: 分类状态 ═══
  let status = 'ok';
  let errorCategory = null;
  let errorNote = '';

  if (!matchedToken) {
    if (NATIVE_L1_COINS[COIN]) {
      status = 'unsupported';
      errorCategory = 'unsupported_chain';
      errorNote = `${COIN} 是 ${NATIVE_L1_COINS[COIN]} 原生代币，onchainOS 不支持的链`;
    } else if (searchPath.length >= 4) {
      status = 'not_found';
      errorCategory = 'not_indexed';
      errorNote = `${COIN} 在所有已搜索链上均未找到匹配代币`;
    } else {
      status = 'failed';
      errorCategory = 'no_data';
      errorNote = '搜索异常中断';
    }
    console.error(`  ⚠️ 状态: ${status} — ${errorNote}`);
  }

  // ═══ 步骤3: 并行采集 ═══
  let holdersData = null;
  let advancedData = null;
  let clusterData = null;
  let tradesData = null;
  let tags = [];
  let solanaLimited = false;

  if (matchedToken) {
    const addr = matchedToken.tokenContractAddress;
    console.error(`[refresh-onchain] 步骤3: 并行采集...`);
    console.error(`  合约: ${addr}`);

    const [hR, aR, cR, tR] = await Promise.all([
      runOnchainosAsync(`token holders --address ${addr}`),
      runOnchainosAsync(`token advanced-info --address ${addr}`),
      runOnchainosAsync(`token cluster-overview --address ${addr}`),
      runOnchainosAsync(`token trades --address ${addr}`),
    ]);

    const extract = (r, label) => {
      if (r && r.ok && r.data !== undefined) {
        return r.data;
      }
      if (r && !r.ok) console.error(`  ⚠️ ${label}: API 返回非 ok`);
      if (!r) console.error(`  ⚠️ ${label}: 无响应`);
      return null;
    };

    holdersData = extract(hR, 'holders');
    advancedData = extract(aR, 'advanced-info');
    clusterData = extract(cR, 'cluster-overview');
    tradesData = extract(tR, 'trades');

    // 链数据质量检测
    const holdersEmpty = !Array.isArray(holdersData) || holdersData.length === 0;
    const advancedCoreEmpty = !advancedData || (
      (!advancedData.riskControlLevel || advancedData.riskControlLevel === '') &&
      (!advancedData.top10HoldPercent || advancedData.top10HoldPercent === '')
    );
    const tradesEmpty = !Array.isArray(tradesData) || tradesData.length === 0;

    if (matchedToken.chainIndex === '501') {
      if (!advancedData || !clusterData) {
        solanaLimited = true;
        status = 'partial';
        errorCategory = 'solana_limited';
        errorNote = 'Solana 链仅支持 holders 和 trades，advanced-info 和 cluster-overview 不可用';
        console.error(`  ⚠️ Solana 部分数据缺失`);
      }
    } else if (matchedToken.chainIndex === '56' && holdersEmpty && tradesEmpty && advancedCoreEmpty) {
      // BSC 链：onchainOS 常返回空 holders/advanced-info/trades，但 cluster-overview 可用
      status = 'partial';
      errorCategory = 'bsc_limited';
      errorNote = 'BSC 链 holders / advanced-info / trades 不可用，cluster-overview 可用';
      console.error(`  ⚠️ BSC 链数据受限：holders/advanced/trades 为空`);
    }

    // 提取标签
    if (advancedData && Array.isArray(advancedData.tokenTags)) {
      tags = advancedData.tokenTags;
    }
    if (matchedToken.tagList && typeof matchedToken.tagList === 'object') {
      for (const [k, v] of Object.entries(matchedToken.tagList)) {
        if (v === true && !tags.includes(k)) tags.push(k);
      }
    }

    console.error(`  holders: ${holdersData ? 'OK' : 'N/A'} | advanced: ${advancedData ? 'OK' : 'N/A'} | cluster: ${clusterData ? 'OK' : 'N/A'} | trades: ${tradesData ? 'OK' : 'N/A'}`);
  }

  // ═══ 步骤4: 构建 JSON ═══
  function buildHoldersSummary(holders) {
    if (!Array.isArray(holders) || holders.length === 0) return { top5Pct: null, topHolders: [] };
    let top5Pct = 0;
    const topHolders = [];
    for (let i = 0; i < Math.min(holders.length, 5); i++) {
      const h = holders[i];
      const pct = pctStrToNum(h.holdPercent);
      if (pct !== null && i < 5) top5Pct += pct;
      topHolders.push({
        '排名(rank)': i + 1,
        '地址(address)': h.holderWalletAddress || '',
        '持仓占比(hold_percent)': pct,
        '持仓量(hold_amount)': h.holdAmount || null,
        '买入均价(avg_buy_price)': toNum(h.avgBuyPrice),
        '卖出均价(avg_sell_price)': toNum(h.avgSellPrice),
        '已实现盈亏(realized_pnl_usd)': toNum(h.realizedPnlUsd),
        '未实现盈亏(unrealized_pnl_usd)': toNum(h.unrealizedPnlUsd),
      });
    }
    return { top5Pct, topHolders };
  }

  function buildTradesSummary(trades) {
    // 聚合统计 + 仅保留大额交易
    if (!Array.isArray(trades) || trades.length === 0) {
      return { buyCount: 0, sellCount: 0, buySellRatio: null, largeTrades: [] };
    }

    let buyCount = 0, sellCount = 0;
    let totalBuyVol = 0, totalSellVol = 0;
    const allTrades = [];

    for (const t of trades) {
      const vol = toNum(t.volume) || 0;
      if (t.type === 'buy') { buyCount++; totalBuyVol += vol; }
      else if (t.type === 'sell') { sellCount++; totalSellVol += vol; }
      allTrades.push({ type: t.type || '', volume: vol, price: toNum(t.price), dex: t.dexName || '' });
    }

    // 计算中位数，大额 = 超过中位数 3 倍
    const volumes = allTrades.map(t => t.volume).sort((a, b) => a - b);
    const mid = Math.floor(volumes.length / 2);
    const median = volumes.length % 2 === 0 ? (volumes[mid - 1] + volumes[mid]) / 2 : volumes[mid];
    const largeThreshold = Math.max(median * 3, 50); // 至少 $50，过滤极小额的噪音

    const largeTrades = allTrades
      .filter(t => t.volume >= largeThreshold)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 5)
      .map(t => ({
        '方向(type)': t.type,
        '金额USD(volume_usd)': Math.round(t.volume * 100) / 100,
        '交易所(dex)': t.dex,
      }));

    const total = buyCount + sellCount;
    const buySellRatio = sellCount > 0 ? Math.round(buyCount / sellCount * 100) / 100 : (buyCount > 0 ? null : 0);

    return {
      '采样笔数(sample_count)': total,
      '买入笔数(buy_count)': buyCount,
      '卖出笔数(sell_count)': sellCount,
      '买卖比(buy_sell_ratio)': buySellRatio,
      '大额阈值USD(large_threshold)': Math.round(largeThreshold * 100) / 100,
      '大额交易(large_trades)': largeTrades,
    };
  }

  const holdersSummary = buildHoldersSummary(holdersData);
  const tradesSummary = buildTradesSummary(tradesData);

  const output = {
    '元数据(meta)': {
      '币种(coin)': COIN,
      '采集时间(collected_at)': nowISO(),
      '有效期_分钟(ttl_minutes)': 240,
      '状态(status)': status,
      '异常类别(error_category)': errorCategory,
      '异常说明(error_note)': errorNote || null,
    },
    '链信息(chain)': {
      '主链_名称(chain_name)': matchedChain?.name || null,
      '主链_索引(chain_index)': matchedToken?.chainIndex || null,
      '合约地址(contract_address)': matchedToken?.tokenContractAddress || null,
      '代币全称(token_name)': matchedToken?.tokenName || null,
      '代币符号(token_symbol)': matchedToken?.tokenSymbol || COIN,
      '精度(decimal)': toNum(matchedToken?.decimal),
      '社区认可(community_recognized)': matchedToken?.tagList?.communityRecognized === true || tags.includes('communityRecognized'),
      '搜索路径(search_path)': searchPath,
      '搜索备注(search_notes)': searchNotes.length > 0 ? searchNotes : null,
    },
    '市场数据(market)': matchedToken ? {
      '价格(price)': toNum(matchedToken.price),
      '市值(market_cap)': toNum(matchedToken.marketCap),
      '持有人数(holders)': toNum(matchedToken.holders),
      '流动性(liquidity)': toNum(matchedToken.liquidity),
      '24h涨跌幅(change_24h)': toNum(matchedToken.change),
    } : null,
    '持仓分布(holders)': holdersData ? {
      '前5持仓占比(top5_concentration)': holdersSummary.top5Pct,
      '前100持仓占比(top100_concentration)': pctStrToNum(clusterData?.top100HoldingsPercent),
      '前5持仓明细(top_holders)': holdersSummary.topHolders,
    } : null,
    '风险指标(risk)': (advancedData || solanaLimited) ? {
      '风险控制等级(risk_control_level)': advancedData?.riskControlLevel || null,
      '集群集中度(cluster_concentration)': clusterData?.clusterConcentration || null,
      '开发者持仓占比(dev_holding_percent)': toNum(advancedData?.devHoldingPercent),
      '捆绑持仓占比(bundle_holding_percent)': toNum(advancedData?.bundleHoldingPercent),
      '狙击手持仓占比(sniper_holding_percent)': toNum(advancedData?.sniperHoldingPercent),
      '可疑持仓占比(suspicious_holding_percent)': toNum(advancedData?.suspiciousHoldingPercent),
      '跑路风险概率(rug_pull_percent)': toNum(clusterData?.rugPullPercent),
    } : null,
    '集群分析(cluster)': clusterData ? {
      '新地址占比(new_address_percent)': toNum(clusterData.holderNewAddressPercent),
      '同创建时间占比(same_creation_time_percent)': toNum(clusterData.holderSameCreationTimePercent),
      '同资金来源占比(same_fund_source_percent)': toNum(clusterData.holderSameFundSourcePercent),
    } : null,
    'DEX交易(dex)': tradesData ? tradesSummary : null,
    '代币标签(tags)': tags.length > 0 ? tags : null,
  };

  // ═══ 步骤5: 对比上次采集 ═══
  let changes = null;

  const LOG_FILE = path.join(WORKSPACE, 'logs', 'onchain-refresh.log');

  function refreshLog(msg, level = 'INFO') {
    const ts = nowISO();
    let line;
    if (level === 'WARN') line = `[${ts}] ⚠️ WARN: ${msg}`;
    else if (level === 'ERROR') line = `[${ts}] ⛔ ERROR: ${msg}`;
    else line = `[${ts}] ${msg}`;
    console.error(line);
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { /* ignore */ }
  }

  function findPreviousOnchain(coin) {
    const dataDir = path.join(WORKSPACE, 'data');
    try {
      if (!fs.existsSync(dataDir)) return null;
      const files = fs.readdirSync(dataDir)
        .filter(f => f.startsWith(`onchain-${coin}-`) && f.endsWith('.json'))
        .sort().reverse();
      if (files.length === 0) return null;
      return path.join(dataDir, files[0]);
    } catch (e) { return null; }
  }

  function updateManifest(cycleDir, jsonPath) {
    const manifestDir = path.join(WORKSPACE, 'active', cycleDir, 'data-context');
    if (!fs.existsSync(manifestDir)) return;
    try {
      const files = fs.readdirSync(manifestDir)
        .filter(f => f.startsWith('data-manifest-') && f.endsWith('.json'))
        .sort().reverse();
      if (files.length === 0) return;
      const manifestFile = path.join(manifestDir, files[0]);
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (!manifest.data_collected) manifest.data_collected = {};
      manifest.data_collected.sentiment_onchain = {
        ...(manifest.data_collected.sentiment_onchain || {}),
        json_file: jsonPath,
        json_updated_at: nowISO(),
        json_ttl_minutes: 240,
      };
      fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      refreshLog(`已更新清单: ${path.basename(manifestFile)} → json_file=${jsonPath}`);
    } catch (e) {
      refreshLog(`更新清单失败: ${e.message}`, 'WARN');
    }
  }

  function getNested(obj, path) {
    return path.split('.').reduce((o, k) => (o && o[k] !== undefined) ? o[k] : null, obj);
  }

  function computeDiff(prev, curr) {
    // 全部使用极小阈值，仅防浮点精度扰动
    const rules = [
      ['市场数据(market).市值(market_cap)',          'pct',  0.01,  '市值变动 {change}%'],
      ['市场数据(market).持有人数(holders)',         'pp',   0.01,  '持有人数变动 {change}'],
      ['持仓分布(holders).前5持仓占比(top5_concentration)',    'pp',  0.01, '前5持仓占比变化 {change}个百分点'],
      ['持仓分布(holders).前100持仓占比(top100_concentration)', 'pp',  0.01, '前100持仓占比变化 {change}个百分点'],
      ['风险指标(risk).集群集中度(cluster_concentration)',     'eq',   0,    '集群集中度从 {old} 变为 {new}'],
      ['集群分析(cluster).新地址占比(new_address_percent)',    'pp',   0.01,  '新地址占比变化 {change}个百分点'],
    ];

    const triggered = [];

    for (const [pathStr, type, threshold, template] of rules) {
      const oldVal = getNested(prev, pathStr);
      const newVal = getNested(curr, pathStr);
      if (oldVal === null || newVal === null) continue;

      let changed = false, changeDesc = '';

      if (type === 'pct') {
        // 百分比变化: |(new-old)/old| * 100 > threshold
        const pct = oldVal !== 0 ? Math.abs((newVal - oldVal) / oldVal) * 100 : 100;
        if (pct >= threshold) {
          changed = true;
          const sign = newVal >= oldVal ? '+' : '';
          changeDesc = template.replace('{change}', `${sign}${pct.toFixed(1)}%`);
        }
      } else if (type === 'pp') {
        // 百分点变化: |new - old| > threshold (适用于百分比值)
        const diff = Math.abs(newVal - oldVal);
        if (diff >= threshold) {
          changed = true;
          const sign = newVal >= oldVal ? '+' : '';
          changeDesc = template.replace('{change}', `${sign}${diff.toFixed(1)}`);
        }
      } else if (type === 'eq') {
        // 值变化: new != old
        if (String(newVal) !== String(oldVal)) {
          changed = true;
          changeDesc = template.replace('{old}', String(oldVal)).replace('{new}', String(newVal));
        }
      }

      if (changed) {
        triggered.push({
          '字段(field)': pathStr,
          '旧值(old_value)': oldVal,
          '新值(new_value)': newVal,
          '变化说明(description)': changeDesc,
        });
      }
    }

    // 特殊检查: 大额交易数变化
    const prevLarge = getNested(prev, 'DEX交易(dex).大额交易(large_trades)');
    const currLarge = getNested(curr, 'DEX交易(dex).大额交易(large_trades)');
    if (prevLarge && currLarge) {
      const prevCount = Array.isArray(prevLarge) ? prevLarge.length : 0;
      const currCount = Array.isArray(currLarge) ? currLarge.length : 0;
      if (currCount !== prevCount) {
        const sign = currCount > prevCount ? '增至' : '降至';
        triggered.push({
          '字段(field)': 'DEX交易(dex).大额交易(large_trades)',
          '旧值(old_value)': `${prevCount}笔`,
          '新值(new_value)': `${currCount}笔`,
          '变化说明(description)': `大额交易从 ${prevCount} 笔 ${sign} ${currCount} 笔`,
        });
      }
    }

    return triggered;
  }

  const prevFile = findPreviousOnchain(COIN);
  if (prevFile && output['持仓分布(holders)']) {
    try {
      const prevData = JSON.parse(fs.readFileSync(prevFile, 'utf8'));
      const triggered = computeDiff(prevData, output);
      const prevName = path.basename(prevFile);
      const prevTime = prevData['元数据(meta)']?.['采集时间(collected_at)'];
      const currTime = output['元数据(meta)']['采集时间(collected_at)'];

      // 计算间隔分钟
      let intervalMin = null;
      if (prevTime && currTime) {
        const prevMs = new Date(prevTime).getTime();
        const currMs = new Date(currTime).getTime();
        intervalMin = Math.round((currMs - prevMs) / 60000);
      }

      changes = {
        '对比基准(previous_file)': prevName,
        '间隔_分钟(interval_minutes)': intervalMin,
        '触发项(triggered)': triggered,
      };

      if (triggered.length > 0) {
        console.error(`[refresh-onchain] 🔔 变化检测: ${triggered.length} 项触发`);
        for (const t of triggered) {
          console.error(`   - ${t['变化说明(description)']}`);
        }
      } else {
        console.error(`[refresh-onchain] 变化检测: 无显著变化`);
      }
    } catch (e) {
      console.error(`[refresh-onchain] ⚠️ 对比上次数据失败: ${e.message}`);
    }
  }

  // 将 changes 加入 output
  output['变化标记(changes)'] = changes;

  // ═══ 步骤6: 保存 + 更新清单 ═══
  if (SAVE) {
    let cycleDir = CYCLE_DIR_ARG;
    if (!cycleDir) {
      const activeDir = path.join(WORKSPACE, 'active');
      try {
        const dirs = fs.readdirSync(activeDir)
          .filter(d => d.startsWith(`alt-${COIN}-`) || d.startsWith(`zhuang-${COIN}-`))
          .sort().reverse();
        if (dirs.length > 0) cycleDir = dirs[0];
      } catch (e) { /* ignore */ }
    }
    if (cycleDir) {
      const dataDir = path.join(WORKSPACE, 'data');
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const ts = `${nowDateStr()}-${nowTimeStr()}`;
      const fileName = `onchain-${COIN}-${ts}.json`;
      const filePath = path.join(dataDir, fileName);
      fs.writeFileSync(filePath, JSON.stringify(output, null, 2) + '\n', 'utf8');
      const relPath = `data/${fileName}`;
      refreshLog(`已保存: ${relPath}`);
      // 更新数据清单引用
      updateManifest(cycleDir, relPath);
    } else {
      refreshLog('未找到活跃周期，跳过保存', 'WARN');
    }
  }

  console.error(`[refresh-onchain] 完成: status=${status}`);
  console.log(JSON.stringify(output, null, 2));
}

main().catch(e => {
  console.error(`[refresh-onchain] ⛔ 异常: ${e.message}`);
  process.exit(1);
});
