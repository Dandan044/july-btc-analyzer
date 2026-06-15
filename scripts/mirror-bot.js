#!/usr/bin/env node
/**
 * mirror-bot.js — 七月反向镜像引擎
 *
 * 轮询七月实盘持仓，在镜像账户执行反向开仓/平仓/改盈损。
 * PM2 常驻进程。
 *
 * 配置: data/mirror-bot-config.json
 * 缓存: data/mirror-bot-cache.json
 * 日志: logs/mirror-bot.log
 *
 * 规则:
 *   - 方向反转: long ↔ short
 *   - TP/SL 互换: 七月TP = 镜像SL, 七月SL = 镜像TP
 *   - 移动止盈止损不跟随
 *   - 仓位张数 × valueMultiplier
 *   - 保证金模式与七月一致，杠杆固定为 config.fixedLeverage（默认5x）
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ═══ 路径 ═══
const WORKSPACE = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(WORKSPACE, 'data', 'mirror-bot-config.json');
const CACHE_FILE = path.join(WORKSPACE, 'data', 'mirror-bot-cache.json');
const LOG_FILE = path.join(WORKSPACE, 'logs', 'mirror-bot.log');
const PROXY = path.join(WORKSPACE, 'scripts', 'okx-proxy.sh');

// ═══ 默认配置 ═══
const DEFAULT_CONFIG = {
  pollIntervalMs: 5000,
  valueMultiplier: 1.0,
  enabled: true,
  sourceProfile: 'live',
  targetProfile: 'mirror',
  // 镜像范围过滤: [] = 全镜像, 例 ["BTC"] 仅镜像BTC
  coinFilter: [],
  // 最小仓位阈值(USDT名义价值),低于此值不镜像
  minNotionalUsd: 5,
  // 固定开仓杠杆（仅影响保证金，仓位名义价值由 sz × valueMultiplier 决定）
  fixedLeverage: 5,
};

// ═══ 日志 ═══
function log(msg, level = 'INFO') {
  const ts = new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

// ═══ 配置加载 ═══
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    }
  } catch (e) {
    log(`配置加载失败,使用默认: ${e.message}`, 'WARN');
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

// ═══ 缓存 ═══
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch (e) {
    log(`缓存加载失败: ${e.message}`, 'WARN');
  }
  return { lastRun: null, positions: {} };
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

// ═══ OKX CLI 调用 ═══
function okx(profile, args, timeoutMs = 15000) {
  const cmd = `bash "${PROXY}" --profile ${profile} ${args} --json 2>/dev/null`;
  try {
    const raw = execSync(cmd, { encoding: 'utf8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] });
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '[]') return [];
    let jsonStart = -1;
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i] === '[' || trimmed[i] === '{') { jsonStart = i; break; }
    }
    if (jsonStart < 0) return [];
    return JSON.parse(trimmed.slice(jsonStart));
  } catch (e) {
    throw new Error(`OKX CLI 失败 [${profile}] ${args}: ${e.message}`);
  }
}

function okxRaw(profile, args, timeoutMs = 15000) {
  const cmd = `bash "${PROXY}" --profile ${profile} ${args} 2>/dev/null`;
  return execSync(cmd, { encoding: 'utf8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// ═══ 获取持仓 ═══
function getPositions(profile) {
  try {
    const raw = okx(profile, 'account positions');
    // 过滤掉 pos=0 的持仓
    return raw.filter(p => parseFloat(p.pos || 0) !== 0);
  } catch (e) {
    log(`获取持仓失败 [${profile}]: ${e.message}`, 'ERROR');
    return null;
  }
}

// ═══ 获取挂单中的止盈止损(仅 conditional + oco, 排除 move_order_stop=移动止损) ═══
function getAlgoOrders(profile) {
  try {
    // 先查活跃订单, 再查未触发的
    const active = okx(profile, 'swap algo orders --ordType conditional');
    const oco = okx(profile, 'swap algo orders --ordType oco');
    // 过滤掉移动止损 (ordType === 'move_order_stop')
    return [...active, ...oco].filter(o => {
      const type = o.ordType || '';
      // 排除移动止损
      if (type === 'move_order_stop') return false;
      return true;
    });
  } catch (e) {
    log(`获取algo订单失败 [${profile}]: ${e.message}`, 'WARN');
    return [];
  }
}

// ═══ 构建持仓快照(含TP/SL) ═══
function buildSnapshot(profile) {
  const positions = getPositions(profile);
  if (positions === null) return null;

  const algoOrders = getAlgoOrders(profile);

  const snapshot = {};
  for (const pos of positions) {
    const instId = pos.instId;
    const posSide = pos.posSide || 'net';
    const key = `${instId}_${posSide}`;

    // 匹配该持仓的TP/SL algo订单
    let tpTriggerPx = null, tpOrdPx = null, slTriggerPx = null, slOrdPx = null;
    let tpAlgoId = null, slAlgoId = null;

    for (const order of algoOrders) {
      if (order.instId !== instId) continue;
      if (order.posSide && order.posSide !== posSide) continue;
      const type = order.ordType || '';
      if (type === 'conditional') {
        // conditional可以是TP或SL
        if (order.slTriggerPx && parseFloat(order.slTriggerPx) > 0) {
          slTriggerPx = order.slTriggerPx;
          slOrdPx = order.slOrdPx;
          slAlgoId = order.algoId;
        }
        if (order.tpTriggerPx && parseFloat(order.tpTriggerPx) > 0) {
          tpTriggerPx = order.tpTriggerPx;
          tpOrdPx = order.tpOrdPx;
          tpAlgoId = order.algoId;
        }
      } else if (type === 'oco') {
        tpTriggerPx = order.tpTriggerPx;
        tpOrdPx = order.tpOrdPx;
        slTriggerPx = order.slTriggerPx;
        slOrdPx = order.slOrdPx;
        tpAlgoId = order.algoId;
        slAlgoId = order.algoId; // OCO共用一个algoId
      }
    }

    snapshot[key] = {
      instId,
      posSide,
      pos: pos.pos,
      avgPx: pos.avgPx,
      lever: pos.lever,
      mgnMode: pos.mgnMode,
      notionalUsd: pos.notionalUsd,
      markPx: pos.markPx,
      upl: pos.upl,
      // TP/SL
      tpTriggerPx,
      tpOrdPx,
      slTriggerPx,
      slOrdPx,
      tpAlgoId,
      slAlgoId,
    };
  }

  return snapshot;
}

// ═══ 计算反向方向 ═══
function reverseSide(posSide) {
  if (posSide === 'long') return 'short';
  if (posSide === 'short') return 'long';
  return 'net'; // 单向持仓模式
}

// ═══ 合约信息缓存 ═══
const instrumentCache = {};

function getInstrumentLotSz(profile, instId) {
  if (instrumentCache[instId]) return instrumentCache[instId].lotSz;
  try {
    const result = okx(profile, `market instruments --instType SWAP --instId ${instId}`, 10000);
    if (result && result.length > 0) {
      const info = result[0];
      instrumentCache[instId] = {
        lotSz: parseFloat(info.lotSz || '1'),
        ctVal: parseFloat(info.ctVal || '1'),
      };
      return instrumentCache[instId].lotSz;
    }
  } catch (e) {
    log(`获取合约信息失败 [${instId}]: ${e.message}`, 'WARN');
  }
  return 1; // fallback
}

// ═══ 计算反向 sz ═══
function calcTargetSz(sourceSz, multiplier, lotSz = 1) {
  const raw = parseFloat(sourceSz) * multiplier;
  // 对齐到最小下单量(lotSz), 防止 Math.floor(0.1)=0 的问题
  const aligned = Math.floor(raw / lotSz) * lotSz;
  // 消除浮点精度泄露 (IEEE 754: 23*0.1=2.3000000000000003)
  return Math.round(aligned * 1e8) / 1e8;
}

// ═══ 操作: 开仓(市价单) ═══
function openPosition(instId, side, sz, lever, mgnMode) {
  log(`🔴 开仓: ${instId} ${side} ${sz}张 lever=${lever}x mode=${mgnMode}`);

  // 1. 先设置杠杆 (逐仓+hedge模式必须传posSide)
  try {
    const posSide = side;
    const levCmd = mgnMode === 'isolated'
      ? `swap leverage --instId ${instId} --lever ${lever} --mgnMode isolated --posSide ${posSide}`
      : `swap leverage --instId ${instId} --lever ${lever} --mgnMode cross`;
    okxRaw('mirror', levCmd, 10000);
    log(`  杠杆已设: ${lever}x`);
  } catch (e) {
    log(`  杠杆设置失败: ${e.message}`, 'WARN');
  }

  // 2. 市价单开仓
  try {
    const posSide = mgnMode === 'cross' ? side : side;
    const result = okxRaw('mirror',
      `swap place --instId ${instId} --side ${side === 'long' ? 'buy' : 'sell'} --ordType market --sz ${sz} --tdMode ${mgnMode} --posSide ${posSide}`,
      15000
    );
    log(`  开仓结果: ${result.slice(0, 200)}`);
    return true;
  } catch (e) {
    log(`  开仓失败: ${e.message}`, 'ERROR');
    return false;
  }
}

// ═══ 操作: 平仓 ═══
function closePosition(instId, posSide, mgnMode) {
  log(`🟢 平仓: ${instId} ${posSide}`);

  try {
    const result = okxRaw('mirror',
      `swap close --instId ${instId} --mgnMode ${mgnMode} --posSide ${posSide}`,
      15000
    );
    log(`  平仓结果: ${result.slice(0, 200)}`);
    return true;
  } catch (e) {
    log(`  平仓失败: ${e.message}`, 'ERROR');
    return false;
  }
}

// ═══ 操作: 设置/修改止盈止损 ═══
// TP/SL 反向: 七月的TP → 镜像的SL, 七月的SL → 镜像的TP
function setAlgoOrder(instId, side, sz, targetTpPx, targetSlPx, existingAlgoId, mgnMode) {
  // 如果已有algo订单,先取消
  if (existingAlgoId) {
    try {
      okxRaw('mirror', `swap algo cancel --instId ${instId} --algoId ${existingAlgoId}`, 10000);
      log(`  已取消旧algo: ${existingAlgoId}`);
    } catch (e) {
      log(`  取消旧algo失败: ${e.message}`, 'WARN');
    }
  }

  if (!targetTpPx && !targetSlPx) {
    log(`  无TP/SL需设置`);
    return true;
  }

  const posSide = side;
  // 平仓方向: long→sell(卖出平多), short→buy(买入平空)
  const sideStr = side === 'long' ? 'sell' : 'buy';

  // 使用 OCO 同时设置 TP+SL
  const tpPart = targetTpPx ? `--tpTriggerPx ${targetTpPx} --tpOrdPx=-1` : '';
  const slPart = targetSlPx ? `--slTriggerPx ${targetSlPx} --slOrdPx=-1` : '';

  try {
    const cmd = `swap algo place --instId ${instId} --side ${sideStr} --sz ${sz} --ordType oco ${tpPart} ${slPart} --posSide ${posSide} --tdMode ${mgnMode || 'cross'} --reduceOnly`;
    const result = okxRaw('mirror', cmd, 15000);
    log(`  TP/SL设置: TP=${targetTpPx || '无'} SL=${targetSlPx || '无'} → ${result.slice(0, 200)}`);
    return true;
  } catch (e) {
    log(`  TP/SL设置失败: ${e.message}`, 'ERROR');
    return false;
  }
}

// ═══ 核心: 同步单次 ═══
function syncOnce(config, cache) {
  const sourceSnap = buildSnapshot(config.sourceProfile);
  if (sourceSnap === null) {
    log('源账户快照获取失败,跳过本轮', 'WARN');
    return cache;
  }

  const targetSnap = buildSnapshot(config.targetProfile);
  if (targetSnap === null) {
    log('目标账户快照获取失败,跳过本轮', 'WARN');
    return cache;
  }

  // 按coinFilter过滤源持仓
  let sourceKeys = Object.keys(sourceSnap);
  if (config.coinFilter && config.coinFilter.length > 0) {
    sourceKeys = sourceKeys.filter(k => {
      const coin = sourceSnap[k].instId.replace('-USDT-SWAP', '');
      return config.coinFilter.includes(coin);
    });
  }

  // 按最小名义价值过滤
  sourceKeys = sourceKeys.filter(k => {
    const notional = parseFloat(sourceSnap[k].notionalUsd || 0);
    return notional >= config.minNotionalUsd;
  });

  const multi = config.valueMultiplier;
  const oldPositions = { ...cache.positions };
  const newPositions = {};

  // ─── 处理已有持仓的变更 ───
  const processedSourceKeys = new Set();

  for (const key of sourceKeys) {
    processedSourceKeys.add(key);
    const src = sourceSnap[key];
    const cached = oldPositions[key];

    // 新开仓
    if (!cached) {
      log(`📌 检测到新持仓: ${key} | ${src.pos}张 | 方向=${src.posSide}`);

      const targetSide = reverseSide(src.posSide);
      const lotSz = getInstrumentLotSz(config.sourceProfile, src.instId);
      const targetSz = calcTargetSz(src.pos, multi, lotSz);

      if (targetSz < lotSz) {
        log(`  sz×${multi}=${targetSz}, 低于最小下单量(lotSz=${lotSz}),跳过`, 'WARN');
        // 写入缓存标记跳过,防止每轮重复检测
        newPositions[key] = { skipped: true, reason: `sz(${targetSz}) < lotSz(${lotSz})`, syncedAt: new Date().toISOString() };
        continue;
      }

      // 检查目标账户是否已有对应反向仓位
      const targetKey = `${src.instId}_${targetSide}`;
      if (targetSnap[targetKey]) {
        log(`  目标账户已存在对应仓位: ${targetKey}, 跳过开仓`);
        // 虽然跳过开仓,但仍需检查TP/SL
        const _srcSz = parseFloat(src.pos);
        const mirrorTp = src.slTriggerPx;
        const mirrorSl = src.tpTriggerPx;
        if (mirrorTp || mirrorSl) {
          log(`  补充设置TP/SL: mirrorTP=${mirrorTp} mirrorSL=${mirrorSl}`);
          setAlgoOrder(src.instId, targetSide, targetSz, mirrorTp, mirrorSl, null, src.mgnMode);
        }
        newPositions[key] = { targetSide, targetSz, sourceSz: _srcSz, sourceTp: src.tpTriggerPx, sourceSl: src.slTriggerPx, mirrorTp, mirrorSl, mgnMode: src.mgnMode, syncedAt: new Date().toISOString() };
        continue;
      }

      const ok = openPosition(src.instId, targetSide, targetSz, config.fixedLeverage, src.mgnMode);
      if (!ok) {
        newPositions[key] = null; // 失败,下次重试
        continue;
      }

      // 开仓成功后,设置反向TP/SL
      // 七月TP → 镜像SL, 七月SL → 镜像TP
      const mirrorTp = src.slTriggerPx; // 七月SL → 镜像TP
      const mirrorSl = src.tpTriggerPx; // 七月TP → 镜像SL

      const cachedEntry = waitAndGetAlgoId(src.instId, targetSide, 3); // 等3s让订单落库
      setAlgoOrder(src.instId, targetSide, targetSz, mirrorTp, mirrorSl, null, src.mgnMode);

      newPositions[key] = {
        targetSide,
        targetSz,
        sourceTp: src.tpTriggerPx,
        sourceSl: src.slTriggerPx,
        mirrorTp,
        mirrorSl,
        mgnMode: src.mgnMode,
        syncedAt: new Date().toISOString(),
        sourceSl: src.slTriggerPx,
        mirrorTp,
        mirrorSl,
        syncedAt: new Date().toISOString(),
      };
      continue;
    }

    // 已有持仓,检查变更
    const targetSide = cached.targetSide;
    const lotSz = getInstrumentLotSz(config.sourceProfile, src.instId);

    // 如果之前因sz不足被跳过,检查现在是否满足条件
    if (cached.skipped) {
      const targetSz = calcTargetSz(parseFloat(src.pos), multi, lotSz);
      if (targetSz < lotSz) {
        newPositions[key] = { ...cached, syncedAt: new Date().toISOString() };
        continue;
      }
      // 现在满足条件了,当作新开仓处理
      log(`📌 跳过→开仓: ${key} | sz已满足(${targetSz} >= lotSz ${lotSz})`);
      const ok = openPosition(src.instId, targetSide, targetSz, config.fixedLeverage, src.mgnMode);
      if (ok) {
        newPositions[key] = { targetSide, targetSz, sourceSz: parseFloat(src.pos), sourceTp: src.tpTriggerPx, sourceSl: src.slTriggerPx, mirrorTp: src.slTriggerPx, mirrorSl: src.tpTriggerPx, mgnMode: src.mgnMode, syncedAt: new Date().toISOString() };
      } else {
        newPositions[key] = null;
      }
      continue;
    }

    // 检查仓位是否已减小或消失(部分平仓/全平)
    const srcSz = parseFloat(src.pos);
    const cachedSrcSz = cached.sourceSz || 0;

    if (srcSz !== cachedSrcSz) {
      log(`📐 仓位变更: ${key} | ${cachedSrcSz}→${srcSz}张`);
      // 计算目标应调整的张数
      const targetSz = calcTargetSz(srcSz, multi, lotSz);
      const cachedTargetSz = cached.targetSz || 0;

      if (targetSz < lotSz) {
        // 源仓位已归零,平掉目标仓位
        log(`  源仓位归零,平目标仓位`);
        closePosition(src.instId, targetSide, src.mgnMode);
        newPositions[key] = null;
        continue;
      }

      if (targetSz !== cachedTargetSz) {
        const diff = targetSz - cachedTargetSz;
        if (diff > 0) {
          // 加仓
          log(`  加仓: +${diff}张`);
          openPosition(src.instId, targetSide, diff, config.fixedLeverage, src.mgnMode);
        } else if (diff < 0) {
          // 减仓: 反向市价单
          log(`  减仓: ${diff}张`);
          const reduceSide = targetSide === 'long' ? 'sell' : 'buy';
          try {
            okxRaw('mirror',
              `swap place --instId ${src.instId} --side ${reduceSide} --ordType market --sz ${Math.abs(diff)} --tdMode ${src.mgnMode || 'cross'} --posSide ${targetSide} --reduceOnly`,
              15000
            );
          } catch (e) {
            log(`  减仓失败: ${e.message}`, 'ERROR');
          }
        }
      }
    }

    // 检查TP/SL变更
    const mirrorTp = src.slTriggerPx; // 七月SL → 镜像TP
    const mirrorSl = src.tpTriggerPx; // 七月TP → 镜像SL

    const tpChanged = mirrorTp !== cached.mirrorTp;
    const slChanged = mirrorSl !== cached.mirrorSl;
    const finalTargetSz = calcTargetSz(srcSz, multi, lotSz);
    const szChanged = finalTargetSz !== (cached.targetSz || 0);

    // 如果仓位大小变了、或TP/SL变了,需要更新algo订单
    if (tpChanged || slChanged || szChanged) {
      log(`🔄 TP/SL/仓位变更: ${key} | mirrorTP=${cached.mirrorTp}→${mirrorTp} mirrorSL=${cached.mirrorSl}→${mirrorSl} sz=${cached.targetSz}→${finalTargetSz}`);

      // 取消旧algo并重设
      const cachedAlgoId = cached.algoId || null;

      // 获取当前目标账户上的algo订单ID (可能已变化)
      let existingAlgoId = cachedAlgoId;
      try {
        const tgtAlgos = getAlgoOrders(config.targetProfile);
        for (const o of tgtAlgos) {
          if (o.instId === src.instId && o.posSide === targetSide) {
            existingAlgoId = o.algoId;
            break;
          }
        }
      } catch (_) {}

      setAlgoOrder(src.instId, targetSide, finalTargetSz, mirrorTp, mirrorSl, existingAlgoId, src.mgnMode);
    }

    newPositions[key] = {
      targetSide,
      targetSz: finalTargetSz,
      sourceSz: srcSz,
      sourceTp: src.tpTriggerPx,
      sourceSl: src.slTriggerPx,
      mirrorTp,
      mirrorSl,
      mgnMode: src.mgnMode,
      syncedAt: new Date().toISOString(),
    };
  }

  // ─── 处理已平仓(源不再有,但缓存中有) ───
  const closedTargetKeys = new Set(); // 防止孤儿清理重复平仓
  for (const key of Object.keys(oldPositions)) {
    if (processedSourceKeys.has(key)) continue;
    const cached = oldPositions[key];
    if (!cached) continue;

    log(`🗑️ 源持仓已消失: ${key}, 平目标仓位`);
    const lastUnderscore = key.lastIndexOf('_');
    const realInstId = key.substring(0, lastUnderscore);

    const result = closePosition(realInstId, cached.targetSide, cached.mgnMode || 'cross');
    if (result) {
      closedTargetKeys.add(`${realInstId}_${cached.targetSide}`);
    }
    // 不加入 newPositions = 已删除
  }

  // ─── 清理目标账户中不应该存在的仓位 ───
  for (const tKey of Object.keys(targetSnap)) {
    // 跳过已处理的平仓
    if (closedTargetKeys.has(tKey)) {
      log(`  跳过孤儿清理(已处理平仓): ${tKey}`);
      continue;
    }
    const tgt = targetSnap[tKey];
    // 反向查:目标仓位对应的源仓位
    const reverseSourceSide = reverseSide(tgt.posSide);
    const sourceKey = `${tgt.instId}_${reverseSourceSide}`;

    // 如果源没有这个仓位
    if (!sourceSnap[sourceKey]) {
      log(`🧹 目标孤儿仓位: ${tKey}, 平仓`);
      closePosition(tgt.instId, tgt.posSide, tgt.mgnMode || 'cross');
    }
  }

  // ─── 更新缓存 ───
  cache.lastRun = new Date().toISOString();
  cache.positions = {};
  for (const key of Object.keys(newPositions)) {
    if (newPositions[key] !== null) {
      cache.positions[key] = newPositions[key];
    }
  }

  return cache;
}

// ═══ 等待并获取algo订单ID ═══
function waitAndGetAlgoId(instId, posSide, maxRetries) {
  for (let i = 0; i < maxRetries; i++) {
    const ms = (i + 1) * 2000;
    execSync(`sleep ${ms / 1000}`);
    try {
      const algos = getAlgoOrders('mirror');
      for (const o of algos) {
        if (o.instId === instId && o.posSide === posSide) {
          return o.algoId;
        }
      }
    } catch (_) {}
  }
  return null;
}

// ═══ 检查余额(首次启动检查) ═══
function checkBalance(profile) {
  try {
    const balances = okx(profile, 'account balance');
    for (const b of balances) {
      // OKX 余额在 details 数组中
      const details = b.details || [];
      for (const d of details) {
        if (d.ccy === 'USDT') {
          const avail = parseFloat(d.availEq || d.availBal || 0);
          log(`账户 [${profile}] USDT可用: ${avail.toFixed(2)} | 总权益: ${parseFloat(d.eq||0).toFixed(2)}`);
          return avail;
        }
      }
      const avail = parseFloat(b.availEq || 0);
      if (avail > 0) {
        log(`账户 [${profile}] 可用余额: ${avail.toFixed(2)} USDT`);
        return avail;
      }
    }
    log(`账户 [${profile}] USDT余额为 0`, 'WARN');
    return 0;
  } catch (e) {
    log(`余额查询失败 [${profile}]: ${e.message}`, 'ERROR');
    return -1;
  }
}

// ═══ Dashboard API 端点 (读取配置/缓存/状态) ═══
function startApiServer(config) {
  // 简单HTTP server 让Dashboard可以读取状态
  const http = require('http');
  const port = 3103;

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'GET' && req.url === '/status') {
      const cache = loadCache();
      const srcBal = checkBalance(config.sourceProfile);
      const tgtBal = checkBalance(config.targetProfile);
      res.end(JSON.stringify({
        running: true,
        config,
        lastRun: cache.lastRun,
        positionCount: Object.keys(cache.positions || {}).length,
        sourceBalance: srcBal,
        targetBalance: tgtBal,
        positions: cache.positions || {},
      }));
      return;
    }

    if (req.method === 'GET' && req.url === '/config') {
      res.end(JSON.stringify(config));
      return;
    }

    if (req.method === 'POST' && req.url === '/config') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const update = JSON.parse(body);
          Object.assign(config, update);
          saveConfig(config);
          log(`配置已更新: ${JSON.stringify(update)}`);
          res.end(JSON.stringify({ ok: true, config }));
        } catch (e) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/sync-now') {
      log('手动触发同步');
      const cache = loadCache();
      const newCache = syncOnce(config, cache);
      saveCache(newCache);
      res.end(JSON.stringify({ ok: true, positions: newCache.positions }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });

  server.listen(port, '127.0.0.1', () => {
    log(`API 服务启动: http://127.0.0.1:${port}`);
  });

  return server;
}

// ═══ 主循环 ═══
async function main() {
  log('══════════ 七月反向镜像引擎启动 ══════════');

  // 加载配置
  let config = loadConfig();
  saveConfig(config);

  // 检查账户余额
  const srcBal = checkBalance(config.sourceProfile);
  const tgtBal = checkBalance(config.targetProfile);

  if (srcBal <= 0) {
    log('⚠️ 源账户余额为0,引擎继续运行等待入金', 'WARN');
  }
  if (tgtBal <= 0) {
    log('⚠️ 镜像账户余额为0,引擎继续运行但无法开仓,请先入金!', 'WARN');
  }

  log(`配置: 轮询=${config.pollIntervalMs}ms | 倍率=${config.valueMultiplier}x | 过滤=${JSON.stringify(config.coinFilter)}`);
  log(`源账户: ${config.sourceProfile} | 目标账户: ${config.targetProfile}`);

  // 加载缓存
  let cache = loadCache();
  log(`缓存: ${Object.keys(cache.positions || {}).length} 个跟踪持仓`);

  // 启动 API 服务
  const apiServer = startApiServer(config);

  // 如果 enabled=false, 只运行 API 不做同步
  if (!config.enabled) {
    log('引擎已禁用(enabled=false),仅API服务运行');
  }

  // 首次运行缓存可能失效(服务重启后源仓位仍在但缓存丢失)
  // 清空缓存强制重新识别
  if (cache.lastRun && config.enabled) {
    const lastRunAge = Date.now() - new Date(cache.lastRun).getTime();
    if (lastRunAge > 5 * 60 * 1000) { // 5分钟未运行
      log('缓存过期(>5min),重置以重新识别源持仓');
      cache = { lastRun: null, positions: {} };
    }
  }

  // 主循环
  let runCount = 0;
  const poll = () => {
    runCount++;
    try {
      // 运行时重新读取配置(支持热更新)
      config = loadConfig();

      if (config.enabled) {
        cache = syncOnce(config, cache);
        saveCache(cache);
      }
    } catch (e) {
      log(`同步异常: ${e.message}`, 'ERROR');
      if (e.stack) log(e.stack, 'ERROR');
    }

    // 每100轮打一次摘要
    if (runCount % 100 === 0) {
      log(`心跳: ${runCount}轮 | 跟踪${Object.keys(cache.positions || {}).length}个仓位 | 最新同步=${cache.lastRun || '无'}`);
    }
  };

  // 首次立即执行
  if (config.enabled) {
    poll();
  }

  // 定时轮询
  const interval = setInterval(poll, config.pollIntervalMs);

  // 优雅退出
  const shutdown = () => {
    log('收到退出信号,保存缓存...');
    saveCache(cache);
    clearInterval(interval);
    apiServer.close();
    log('镜像引擎已停止');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log(`引擎就绪 | 间隔=${config.pollIntervalMs}ms | 下次运行≈${new Date(Date.now() + config.pollIntervalMs).toISOString()}`);
}

main().catch(e => {
  log(`启动失败: ${e.message}`, 'ERROR');
  if (e.stack) log(e.stack, 'ERROR');
  process.exit(1);
});
