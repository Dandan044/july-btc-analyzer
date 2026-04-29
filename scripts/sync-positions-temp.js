// 临时脚本：同步持仓文件（阶段三）
// 从 OKX API 获取持仓数据、止盈止损订单、账单记录，筛选 BTC 逐仓并生成 positions.json

const fs = require('fs');
const path = require('path');

// 读取临时数据文件
const positionsData = JSON.parse(fs.readFileSync('data/temp-positions.json', 'utf8'));
const algoOrdersData = JSON.parse(fs.readFileSync('data/temp-algo-orders.json', 'utf8'));
const billsData = JSON.parse(fs.readFileSync('data/temp-bills.json', 'utf8'));

// 筛选 BTC 逐仓持仓（pos > 0）
const btcIsolatedPositions = positionsData.filter(p => 
  p.instId === 'BTC-USDT-SWAP' && 
  p.mgnMode === 'isolated' && 
  parseFloat(p.pos) > 0
);

console.log('筛选结果：', btcIsolatedPositions.length, '个 BTC 逐仓持仓');

// 筛选 BTC 逐仓止盈止损订单
const btcIsolatedAlgoOrders = algoOrdersData.filter(o =>
  o.instId === 'BTC-USDT-SWAP' &&
  o.tdMode === 'isolated' &&
  o.state === 'live'
);

console.log('止盈止损订单：', btcIsolatedAlgoOrders.length, '个');

// 筛选账单记录（当前持仓从开仓开始）
// 持仓开仓时间：1777100176229
const openTime = btcIsolatedPositions.length > 0 ? btcIsolatedPositions[0].cTime : '0';
const btcIsolatedBills = billsData.filter(b =>
  b.instId === 'BTC-USDT-SWAP' &&
  b.mgnMode === 'isolated' &&
  parseInt(b.ts) >= parseInt(openTime)
);

console.log('账单记录：', btcIsolatedBills.length, '条');

// 构建 positions.json
const cycleId = 'cycle-20260425-001';
const syncTime = new Date().toISOString().replace('Z', '+08:00');

const positions = btcIsolatedPositions.map(p => {
  // 构建委托订单
  const algoOrders = btcIsolatedAlgoOrders.filter(o => o.posSide === p.posSide);
  
  const delegateOrders = algoOrders.map(o => ({
    '订单ID': o.algoId,
    '订单类型': 'OCO止盈止损',
    '止盈价': o.tpTriggerPx,
    '止损触发价': o.slTriggerPx,
    '数量': o.sz,
    '状态': o.state,
    '触发类型': o.tpTriggerPxType
  }));
  
  // 构建操作记录
  const operationRecords = btcIsolatedBills
    .filter(b => parseFloat(b.sz) === parseFloat(p.pos)) // 按持仓张数匹配
    .map(b => {
      const billType = parseInt(b.type);
      const subType = parseInt(b.subType);
      
      // type=8 是资金费结算
      if (billType === 8) {
        return {
          '时间': b.ts,
          '类型': '资金费结算',
          '金额': b.pnl,
          '标记价': b.px
        };
      }
      
      return null;
    })
    .filter(r => r !== null);
  
  // 开仓记录（从持仓数据直接获取）
  operationRecords.unshift({
    '时间': p.cTime,
    '类型': '开仓',
    '价格': p.avgPx,
    '数量': p.pos,
    '手续费': p.fee
  });
  
  // 如果有保证金追加记录，需要添加（从旧持仓文件获取）
  // 这里暂时跳过，因为 bills 数据中没有保证金追加的明确标识
  
  return {
    '持仓ID': p.posId,
    '合约': p.instId,
    '保证金模式': p.mgnMode,
    '持仓方向': p.posSide,
    '持仓张数': p.pos,
    '可用张数': p.availPos,
    '名义价值USD': p.notionalUsd,
    '平均入场价': p.avgPx,
    '杠杆': p.lever,
    '保证金': p.margin,
    '未实现盈亏': p.upl,
    '盈亏比例': p.uplRatio,
    '已实现盈亏': p.realizedPnl,
    '手续费': p.fee,
    '资金费': p.fundingFee,
    '强平价': p.liqPx,
    '保本价': p.bePx,
    '开仓时间': p.cTime,
    '最后更新': p.uTime,
    '标记价格': p.markPx,
    '指数价格': p.idxPx,
    '最新成交价': p.last,
    '委托订单': delegateOrders,
    '操作记录': operationRecords
  };
});

// 汇总数据
const summary = {
  '当前持仓数': positions.length,
  '未实现盈亏总计': positions.reduce((sum, p) => sum + parseFloat(p['未实现盈亏'] || 0), 0),
  '已实现盈亏总计': positions.reduce((sum, p) => sum + parseFloat(p['已实现盈亏'] || 0), 0)
};

// 检查是否有平仓（对比旧持仓文件）
const oldPositionsPath = 'active/cycle-20260425-001/positions.json';
let recentClose = null;

if (fs.existsSync(oldPositionsPath)) {
  const oldPositionsData = JSON.parse(fs.readFileSync(oldPositionsPath, 'utf8'));
  const oldPositions = oldPositionsData['当前持仓'] || [];
  
  // 如果旧持仓有仓位，新持仓为空 → 检测到平仓
  if (oldPositions.length > 0 && positions.length === 0) {
    console.log('检测到平仓：本周期曾开仓现已平仓');
    // 这里需要从历史持仓 API 获取平仓信息，暂时跳过
    recentClose = null; // 需要后续补充
  }
}

// 构建 positions.json 结构
const positionsJson = {
  '周期ID': cycleId,
  '同步时间': syncTime,
  '数据来源': 'OKX实盘账户',
  '当前持仓': positions,
  '最近平仓': recentClose,
  '汇总': summary
};

// 如果没有持仓
if (positions.length === 0) {
  positionsJson['备注'] = recentClose ? '本周期曾开仓现已平仓' : '当前无BTC-USDT-SWAP逐仓持仓';
}

// 输出到文件
const outputPath = 'active/cycle-20260425-001/positions.json';
fs.writeFileSync(outputPath, JSON.stringify(positionsJson, null, 2), 'utf8');
console.log('持仓文件已同步：', outputPath);
console.log('当前持仓数：', positions.length);
console.log('最近平仓：', recentClose ? '有' : '无');