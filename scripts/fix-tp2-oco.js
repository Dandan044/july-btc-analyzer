#!/usr/bin/env node
/**
 * fix-tp2-oco.js — 修复 INJ 和 NEAR 的止盈止损为两笔 OCO 单
 *
 * 场景：阶段三之前只设置了 1 个 TP，但有 trade_decision 中有 TP1 + TP2
 * 此脚本取消旧 OCO，重新下两笔 OCO 单（TP1+SL, TP2+SL）
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const WORKSPACE = path.resolve(__dirname, '..');
const PROXY = path.join(WORKSPACE, 'scripts', 'okx-proxy.sh');
const TP_SHIFT_PCT = 5;
const SL_SHIFT_PCT = 5;
const MAX_SHIFT_PCT = 20;

// ─── 配置：每个币种的参数 ───
const FIX_CONFIG = [
  {
    coin: 'INJ',
    cycleDir: 'alt-INJ-20260523-0030',
    // 取自 latest trade-decision 的 adjust action
    tp1: 6.0,
    tp2: 6.5,
    tp1Ratio: 50,
    stopLoss: 4.95,
  },
  {
    coin: 'NEAR',
    cycleDir: 'alt-NEAR-20260523-0730',
    tp1: 2.3,
    tp2: 2.5,
    tp1Ratio: 50,
    stopLoss: 1.884,
  },
];

// ─── 工具函数 ───
function runOkxCmd(args) {
  try {
    const cmd = `bash "${PROXY}" --profile live ${args}`;
    const out = execSync(cmd, { encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] });
    const trimmed = out.trim();
    if (!trimmed || trimmed === '[]') return [];
    let jsonStart = -1;
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i] === '[' || trimmed[i] === '{') {
        jsonStart = i;
        break;
      }
    }
    if (jsonStart < 0) return null;
    return JSON.parse(trimmed.slice(jsonStart));
  } catch (e) {
    console.error(`OKX 命令异常: ${args} → ${e.message}`);
    return null;
  }
}

function num(v) {
  return parseFloat(v) || 0;
}

function round(v, d) {
  return Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
}

// calcPnlOffset 的精确复制（保持与 stage3 一致）
function calcPnlOffset(entry, target, type, direction, tickSz) {
  const tick = num(tickSz) || 0.00001;
  const origDist = Math.abs(target - entry);
  const shiftPct = type === 'tp' ? TP_SHIFT_PCT : SL_SHIFT_PCT;

  let newDist;
  if (type === 'tp') {
    newDist = origDist * (1 - shiftPct / 100);
  } else {
    newDist = origDist * (1 + shiftPct / 100);
  }

  newDist = Math.max(newDist, tick);
  newDist = Math.min(newDist, origDist * (1 + MAX_SHIFT_PCT / 100));

  let newPrice;
  if (direction === 'long') {
    newPrice = type === 'tp' ? entry + newDist : entry - newDist;
  } else {
    newPrice = type === 'tp' ? entry - newDist : entry + newDist;
  }

  if (type === 'tp' && direction === 'long' && newPrice <= entry) newPrice = entry + tick;
  if (type === 'tp' && direction === 'short' && newPrice >= entry) newPrice = entry - tick;

  if (tick > 0) {
    newPrice = Math.round(newPrice / tick) * tick;
  }

  return round(newPrice, 8);
}

// ─── 主流程 ───
async function main() {
  for (const cfg of FIX_CONFIG) {
    const { coin, cycleDir, tp1, tp2, tp1Ratio, stopLoss } = cfg;
    const instId = `${coin}-USDT-SWAP`;

    console.log(`\n========== 处理 ${coin} (${instId}) ==========`);
    const cyclePath = path.join(WORKSPACE, 'active', cycleDir);

    // 1. 获取当前仓位信息
    const posData = runOkxCmd(`account positions --instId ${instId} --tdMode cross --json`);
    if (!posData || !posData[0]) {
      console.log(`⚠️ ${coin}: 获取持仓失败，跳过`);
      continue;
    }
    // 过滤：多个 posSide 可能有空仓位
    const livePos = posData.find(p => num(p.pos) > 0);
    if (!livePos) {
      console.log(`⚠️ ${coin}: 无持仓，跳过`);
      continue;
    }

    const entryPx = num(livePos.avgPx);
    const currentSz = num(livePos.pos);
    const direction = livePos.posSide;
    console.log(`📊 持仓: ${currentSz}张 @ $${entryPx}, 方向: ${direction}`);

    // 获取合约信息
    const instr = runOkxCmd(`market instruments --instType SWAP --instId ${instId} --json`);
    if (!instr || !instr[0]) {
      console.log(`⚠️ ${coin}: 获取合约信息失败`);
      continue;
    }
    const tickSz = num(instr[0].tickSz) || 0.001;
    const minSz = num(instr[0].minSz) || 1;
    console.log(`📊 合约: tickSz=${tickSz}, minSz=${minSz}`);

    // 2. 获取当前算法单并取消
    const algoOrders = runOkxCmd(`swap algo orders --instId ${instId}`);
    if (algoOrders && algoOrders.length > 0) {
      for (const order of algoOrders) {
        const algoId = order.algoId;
        console.log(`🔄 取消旧OCO: algoId=${algoId}, TP=${order.tpTriggerPx}, SL=${order.slTriggerPx}, sz=${order.sz}`);
        const cancelResult = runOkxCmd(`swap algo cancel --instId ${instId} --algoId ${algoId}`);
        if (cancelResult) {
          console.log(`✅ 取消成功: algoId=${algoId}`);
        } else {
          console.log(`⚠️ 取消失败: algoId=${algoId}`);
        }
      }
      // 等待确认
      await new Promise(r => setTimeout(r, 1000));
    } else {
      console.log('ℹ️ 无现有OCO单');
    }

    // 3. 计算偏移后的价格
    const slOffset = calcPnlOffset(entryPx, stopLoss, 'sl', direction, tickSz);
    const tp1Offset = calcPnlOffset(entryPx, tp1, 'tp', direction, tickSz);
    const tp2Offset = calcPnlOffset(entryPx, tp2, 'tp', direction, tickSz);

    console.log(`📐 偏移计算 (entry=$${entryPx}):`);
    console.log(`   SL: ${stopLoss} → ${slOffset}`);
    console.log(`   TP1: ${tp1} → ${tp1Offset}`);
    console.log(`   TP2: ${tp2} → ${tp2Offset}`);

    const finalSide = direction === 'long' ? 'sell' : 'buy';

    // 4. 拆分仓位
    const ratio1 = tp1Ratio / 100;
    const rawSzTp1 = Math.round(currentSz * ratio1 * 10000) / 10000;
    const rawSzTp2 = Math.round((currentSz - rawSzTp1) * 10000) / 10000;
    
    // 确保满足最小张数
    const szTp1 = Math.max(minSz, rawSzTp1);
    const szTp2 = rawSzTp2 >= minSz ? rawSzTp2 : 0;

    console.log(`📐 拆分: ${currentSz}张 → ${szTp1}张(TP1) + ${szTp2}张(TP2)`);

    // 5. OCO 1: TP1 + SL
    let placed1 = false;
    if (szTp1 >= minSz) {
      const oco1 = `swap algo place --instId ${instId} --side ${finalSide} --ordType oco --posSide ${direction} --sz ${szTp1} --slTriggerPx ${slOffset} --slOrdPx=-1 --tpTriggerPx ${tp1Offset} --tpOrdPx=-1 --reduceOnly true`;
      console.log(`🔄 OCO1(TP1): ${oco1}`);
      const r1 = runOkxCmd(oco1);
      if (r1) {
        console.log(`✅ OCO1 成功: algoId=${r1[0]?.algoId}`);
        placed1 = true;
      } else {
        console.log(`⚠️ OCO1 失败`);
      }
    } else {
      console.log(`⏭️ szTp1=${szTp1} < minSz=${minSz}, 跳过OCO1`);
    }

    // 6. OCO 2: TP2 + SL
    if (szTp2 >= minSz) {
      const oco2 = `swap algo place --instId ${instId} --side ${finalSide} --ordType oco --posSide ${direction} --sz ${szTp2} --slTriggerPx ${slOffset} --slOrdPx=-1 --tpTriggerPx ${tp2Offset} --tpOrdPx=-1 --reduceOnly true`;
      console.log(`🔄 OCO2(TP2): ${oco2}`);
      const r2 = runOkxCmd(oco2);
      if (r2) {
        console.log(`✅ OCO2 成功: algoId=${r2[0]?.algoId}`);
      } else {
        console.log(`⚠️ OCO2 失败`);
      }
    } else {
      console.log(`⏭️ szTp2=${szTp2} < minSz=${minSz}, 跳过OCO2`);
    }

    // 7. 如果 OCO1 也没成功，回退整单一笔
    if (!placed1 && szTp1 >= minSz) {
      console.log('🔄 回退: 整单一笔OCO');
      const ocoFull = `swap algo place --instId ${instId} --side ${finalSide} --ordType oco --posSide ${direction} --sz ${currentSz} --slTriggerPx ${slOffset} --slOrdPx=-1 --tpTriggerPx ${tp1Offset} --tpOrdPx=-1 --reduceOnly true`;
      runOkxCmd(ocoFull);
    }

    // 8. 验证
    await new Promise(r => setTimeout(r, 1500));
    const verify = runOkxCmd(`swap algo orders --instId ${instId}`);
    if (verify && verify.length > 0) {
      console.log(`✅ 验证: ${verify.length} 笔OCO单活跃`);
      for (const v of verify) {
        console.log(`   algoId=${v.algoId} | sz=${v.sz} | TP=${v.tpTriggerPx} | SL=${v.slTriggerPx}`);
      }
    } else {
      console.log(`⚠️ 验证: 无活跃OCO单`);
    }

    // 9. 更新 positions.json 中的委托订单
    try {
      const posFile = path.join(cyclePath, 'positions.json');
      if (fs.existsSync(posFile)) {
        const posJson = JSON.parse(fs.readFileSync(posFile, 'utf8'));
        const updatedOrders = verify ? verify.map(v => ({
          "订单ID": v.algoId,
          "订单类型": "OCO止盈止损",
          "止盈触发价": v.tpTriggerPx,
          "止盈执行方式": "市价",
          "止损触发价": v.slTriggerPx,
          "止损执行方式": "市价",
          "数量": v.sz,
          "状态": "live"
        })) : [];
        
        if (posJson['当前持仓'] && posJson['当前持仓'].length > 0) {
          posJson['当前持仓'][0]['委托订单'] = updatedOrders;
          fs.writeFileSync(posFile, JSON.stringify(posJson, null, 2));
          console.log(`✅ positions.json 已更新委托订单`);
        }
      }
    } catch (e) {
      console.log(`⚠️ positions.json 更新失败: ${e.message}`);
    }
  }

  console.log('\n========== 所有修复完成 ==========');
}

main().catch(e => console.error('Fatal:', e));
