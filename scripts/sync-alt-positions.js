#!/usr/bin/env node
/**
 * sync-alt-positions.js — 山寨币全仓持仓同步脚本
 *
 * 用法: node sync-alt-positions.js <COIN> <CYCLE_DIR> <LOG_FILE>
 *
 * 功能:
 *   1. 从 OKX 获取实盘全仓持仓
 *   2. 获取 OCO 止盈止损订单
 *   3. 获取账单记录（操作历史）
 *   4. 对比旧 positions.json 检测平仓
 *   5. 覆写 positions.json
 *
 * 输出: JSON 到 stdout（汇总同步结果）
 *
 * ⚠️ 只读操作，不修改任何实盘仓位
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── 参数解析 ───
const COIN = process.argv[2];
const CYCLE_DIR = process.argv[3];
const LOG_FILE = process.argv[4];

if (!COIN || !CYCLE_DIR) {
  console.error('用法: node sync-alt-positions.js <COIN> <CYCLE_DIR> [LOG_FILE]');
  process.exit(1);
}

const WORKSPACE = path.resolve(__dirname, '..');
const PROXY = path.join(WORKSPACE, 'scripts', 'okx-proxy.sh');
const POSITIONS_FILE = path.join(WORKSPACE, 'active', CYCLE_DIR, 'positions.json');
const INST_ID = `${COIN}-USDT-SWAP`;

// ─── 工具函数 ───
function runCmd(cmd) {
  try {
    const out = execSync(cmd, { encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] });
    const trimmed = out.trim();
    if (!trimmed || trimmed === '[]') return [];
    return JSON.parse(trimmed);
  } catch (e) {
    // CLI 报错时检查 stderr
    const stderr = (e.stderr || '').toString();
    // 如果是 "Instrument ... doesn't exist" 说明该币种无有效合约，返回空
    if (stderr.includes("doesn't exist") || stderr.includes('does not exist') || stderr.includes('invalid')) {
      return [];
    }
    return null;
  }
}

function log(msg, level = 'INFO') {
  // GMT+8
  const ts = new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  let line;
  if (level === 'WARN') line = `[${ts}] [同步] ⚠️ WARN: ${msg}`;
  else if (level === 'ERROR') line = `[${ts}] [同步] ⛔ ERROR: ${msg}`;
  else line = `[${ts}] [同步] ${msg}`;
  console.error(line);
  if (LOG_FILE) {
    fs.appendFileSync(LOG_FILE, line + '\n');
  }
}

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function round(v, d = 2) {
  return Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
}

// ─── 步骤 1: 备份旧持仓 ───
let oldPositionsData = null;
let oldPositionsCount = 0;
if (fs.existsSync(POSITIONS_FILE)) {
  try {
    oldPositionsData = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
    oldPositionsCount = (oldPositionsData['当前持仓'] || []).length;
    log(`旧持仓文件: ${oldPositionsCount} 个仓位`);
  } catch (e) {
    log(`旧持仓文件读取失败: ${e.message}`, 'WARN');
  }
}

// ─── 步骤 2: 获取实盘持仓 ───
log(`获取实盘持仓: ${INST_ID} cross`);
const positionsRaw = runCmd(
  `bash "${PROXY}" --profile live account positions --instId ${INST_ID} --tdMode cross --json`
);

if (positionsRaw === null) {
  log('获取实盘持仓失败（非 "instrument not found" 错误）', 'ERROR');
  // 不覆写文件，保留旧快照
  console.log(JSON.stringify({ sync_status: 'api_error', error: 'positions api failed' }));
  process.exit(1);
}

// 筛选该币种 + cross 模式
const livePositions = positionsRaw.filter(
  p => p.instId === INST_ID && p.mgnMode === 'cross' && num(p.pos) > 0
);

log(`实盘持仓: ${livePositions.length} 个`);

// ─── 步骤 3: 获取 OCO 止盈止损订单 ───
log('获取 OCO 订单...');
const algoOrders = runCmd(
  `bash "${PROXY}" --profile live swap algo orders --instId ${INST_ID} --tdMode cross --json`
) || [];

// 筛选 live 状态的 OCO 订单
const liveOcoOrders = algoOrders.filter(
  o => o.ordType === 'oco' && o.state === 'live' && o.instId === INST_ID
);

log(`活跃 OCO 订单: ${liveOcoOrders.length} 个`);

// ─── 步骤 4: 获取账单记录 ───
log('获取账单记录...');
const billsRaw = runCmd(
  `bash "${PROXY}" --profile live account bills --instId ${INST_ID} --ccy USDT --tdMode cross --limit 50 --json`
) || [];

// ─── 步骤 5: 检测平仓 ───
const closedPositions = [];

if (oldPositionsData && oldPositionsData['当前持仓'] && oldPositionsData['当前持仓'].length > 0) {
  // 快照有仓位，检查实盘是否还有
  for (const oldPos of oldPositionsData['当前持仓']) {
    const oldPosId = oldPos['持仓ID'];
    const stillExists = livePositions.some(lp => String(lp.posId) === String(oldPosId));

    if (!stillExists) {
      log(`检测到平仓: posId=${oldPosId}`);
      // 查询 positions-history 获取平仓详情
      const historyRaw = runCmd(
        `bash "${PROXY}" --profile live account positions-history --instId ${INST_ID} --tdMode cross --limit 20 --json`
      ) || [];

      // 找到该 posId 的最新平仓记录
      const closeRecord = historyRaw
        .filter(h => String(h.posId) === String(oldPosId) && num(h.closeTotalPos) > 0)
        .sort((a, b) => num(b.uTime) - num(a.uTime))[0];

      let closeType = '手动平仓';
      if (closeRecord) {
        const closePx = num(closeRecord.closeAvgPx);
        // 从快照中读取 TP/SL
        const tpOrders = (oldPos['委托订单'] || []).filter(o => o['止盈触发价']);
        const slOrders = (oldPos['委托订单'] || []).filter(o => o['止损触发价']);

        if (tpOrders.length > 0) {
          const tpPx = num(tpOrders[0]['止盈触发价']);
          if (tpPx > 0 && Math.abs(closePx - tpPx) / tpPx < 0.005) {
            closeType = '止盈触发';
          }
        }
        if (closeType === '手动平仓' && slOrders.length > 0) {
          const slPx = num(slOrders[0]['止损触发价']);
          if (slPx > 0 && Math.abs(closePx - slPx) / slPx < 0.005) {
            closeType = '止损触发';
          }
        }
      }

      closedPositions.push({
        '持仓ID': oldPosId,
        '合约': oldPos['合约'] || INST_ID,
        '持仓方向': oldPos['持仓方向'],
        '开仓均价': oldPos['平均入场价'] ? num(oldPos['平均入场价']) : (closeRecord ? num(closeRecord.openAvgPx) : 0),
        '平仓价格': closeRecord ? num(closeRecord.closeAvgPx) : 0,
        '平仓时间': closeRecord ? String(num(closeRecord.uTime)) : String(Date.now()),
        '平仓类型': closeType,
        '持仓张数': closeRecord ? String(closeRecord.closeTotalPos) : oldPos['持仓张数'] || '0',
        '盈亏': closeRecord ? round(num(closeRecord.pnl)) : round(num(oldPos['已实现盈亏'])),
        '手续费': closeRecord ? round(num(closeRecord.fee)) : round(num(oldPos['手续费'])),
      });

      log(`  → ${closeType} @ ${closeRecord ? num(closeRecord.closeAvgPx) : 'N/A'}, 盈亏: ${closeRecord ? num(closeRecord.pnl) : 'N/A'}`);
    }
  }
}

// 如果快照无仓位但实盘有仓位，检查 positions-history 判断是否为新仓
if (oldPositionsCount === 0 && livePositions.length > 0) {
  log('快照无仓位但实盘有仓位 → 新仓或历史仓位');
}

// ─── 步骤 6: 构建 positions.json ───
const now = new Date();
const syncTime = new Date(now.getTime() + 8 * 3600000).toISOString().replace(/\.\d{3}Z/, '+08:00');
// Fix timezone: format as Asia/Shanghai offset
const syncTimeSH = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') + '+08:00';

const currentPositions = [];

for (const pos of livePositions) {
  const posId = String(pos.posId);

  // 匹配 OCO 订单
  const matchingOco = liveOcoOrders.filter(o => o.posSide === pos.posSide);

  const tpPx = matchingOco.length > 0 ? num(matchingOco[0].tpTriggerPx) : 0;
  const slPx = matchingOco.length > 0 ? num(matchingOco[0].slTriggerPx) : 0;

  // 构建委托订单
  const orders = [];
  if (tpPx > 0 || slPx > 0) {
    orders.push({
      '订单ID': matchingOco[0]?.algoId || '',
      '订单类型': 'OCO止盈止损',
      '止盈触发价': tpPx > 0 ? String(round(tpPx, 4)) : '',
      '止盈执行方式': num(matchingOco[0]?.tpOrdPx) === -1 ? '市价' : '限价',
      '止损触发价': slPx > 0 ? String(round(slPx, 4)) : '',
      '止损执行方式': num(matchingOco[0]?.slOrdPx) === -1 ? '市价' : '限价',
      '数量': matchingOco[0]?.sz || pos.pos,
      '状态': matchingOco[0]?.state || 'live',
    });
  }

  // 构建操作记录（从 bills 筛选）
  const actionRecords = [];
  const cTime = num(pos.cTime);

  // 筛选该 posId 的账单（按 posId 匹配不精确，按时间 + 币种 + 模式筛选）
  const posBills = billsRaw
    .filter(b => num(b.ts) >= cTime && b.instId === INST_ID && b.mgnMode === 'cross')
    .sort((a, b) => num(a.ts) - num(b.ts));

  for (const bill of posBills) {
    const type = String(bill.type);
    const subType = String(bill.subType);
    const ts = String(num(bill.ts));
    const fee = round(num(bill.fee));

    if (type === '2') {
      // 开仓/加仓/减仓
      actionRecords.push({
        '时间': ts,
        '类型': '开仓',  // 简化，实际可能需要更多判断
        '价格': round(num(bill.px), 4),
        '数量': String(bill.sz),
        '手续费': fee,
      });
    } else if (type === '8') {
      // 资金费结算
      actionRecords.push({
        '时间': ts,
        '类型': '资金费结算',
        '金额': round(num(bill.pnl)),
      });
    }
    // type 1 = 平仓（不会出现在活跃仓位的账单中）
  }

  currentPositions.push({
    '持仓ID': posId,
    '合约': INST_ID,
    '保证金模式': 'cross',
    '持仓方向': pos.posSide,
    '持仓张数': String(pos.pos),
    '可用张数': String(pos.availPos),
    '名义价值USD': round(num(pos.notionalUsd)),
    '平均入场价': round(num(pos.avgPx), 2),
    '杠杆': String(round(num(pos.lever))),
    '保证金': round(num(pos.imr)),
    '未实现盈亏': round(num(pos.upl)),
    '盈亏比例': round(num(pos.uplRatio), 3),
    '已实现盈亏': round(num(pos.realizedPnl)),
    '手续费': round(num(pos.fee)),
    '资金费': round(num(pos.fundingFee)),
    '强平价': 'N/A(全仓)',
    '保本价': round(num(pos.bePx), 2),
    '开仓时间': String(num(pos.cTime)),
    '最后更新': String(num(pos.uTime)),
    '标记价格': round(num(pos.markPx), 2),
    '指数价格': round(num(pos.idxPx), 2),
    '最新成交价': round(num(pos.last), 2),

    '委托订单': orders,

    '操作记录': actionRecords,
  });
}

// ─── 步骤 7: 确定最近平仓 ───
let recentClose = null;
if (closedPositions.length > 0) {
  // 取最后一个
  recentClose = closedPositions[closedPositions.length - 1];
} else if (oldPositionsData && oldPositionsData['最近平仓']) {
  // 保留已有的最近平仓记录
  recentClose = oldPositionsData['最近平仓'];
}

// ─── 步骤 8: 汇总 ───
const uplTotal = currentPositions.reduce((s, p) => s + num(p['未实现盈亏']), 0);
const realizedTotal = currentPositions.reduce((s, p) => s + num(p['已实现盈亏']), 0)
  + (recentClose ? num(recentClose['盈亏']) : 0);

// ─── 步骤 9: 写入文件 ───
const output = {
  '周期ID': CYCLE_DIR,
  '币种': COIN,
  '同步时间': syncTimeSH,
  '数据来源': 'OKX实盘账户',

  '当前持仓': currentPositions,

  '最近平仓': recentClose,

  '汇总': {
    '当前持仓数': currentPositions.length,
    '未实现盈亏总计': round(uplTotal),
    '已实现盈亏总计': round(realizedTotal),
  },
};

// 生成备注
if (currentPositions.length === 0) {
  output['备注'] = `当前无${INST_ID}持仓`;
} else {
  const p = currentPositions[0];
  output['备注'] = `${INST_ID} cross ${p['持仓方向']} ${p['持仓张数']}张 @ $${p['平均入场价']}`;
}

fs.writeFileSync(POSITIONS_FILE, JSON.stringify(output, null, 2) + '\n', 'utf8');
log(`持仓文件已更新: ${POSITIONS_FILE}`);

// ─── 步骤 10: 输出 JSON 到 stdout ───
console.log(JSON.stringify({
  sync_status: 'success',
  coin: COIN,
  cycle_dir: CYCLE_DIR,
  old_positions_count: oldPositionsCount,
  live_positions_count: livePositions.length,
  closed_positions: closedPositions.length > 0 ? closedPositions.map(cp => ({
    posId: cp['持仓ID'],
    direction: cp['持仓方向'],
    close_price: cp['平仓价格'],
    close_type: cp['平仓类型'],
    pnl: cp['盈亏'],
  })) : [],
  current_positions_count: currentPositions.length,
  has_close_record: !!recentClose,
}));

// ─── 辅助函数：空仓位 ───
function writeEmptyPositions() {
  const now = new Date();
  const syncTimeSH = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') + '+08:00';

  const hasOldClose = oldPositionsData && oldPositionsData['最近平仓'];
  const output = {
    '周期ID': CYCLE_DIR,
    '币种': COIN,
    '同步时间': syncTimeSH,
    '数据来源': 'OKX实盘账户',
    '当前持仓': [],
    '最近平仓': oldPositionsData ? (oldPositionsData['最近平仓'] || null) : null,
    '汇总': {
      '当前持仓数': 0,
      '未实现盈亏总计': 0,
      '已实现盈亏总计': 0,
    },
    '备注': `当前无${INST_ID}持仓`,
  };
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(output, null, 2) + '\n', 'utf8');
}
