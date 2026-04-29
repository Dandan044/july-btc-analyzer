const fs = require('fs');
const { execSync } = require('child_process');

const CYCLE_DIR = 'active/cycle-20260425-001';
const POS_FILE = `${CYCLE_DIR}/positions.json`;
const NOW = new Date().toISOString();

// Get positions
let posData;
try {
  posData = JSON.parse(execSync('/home/administrator/.openclaw/july-btc-analyzer/scripts/okx-proxy.sh --profile live account positions --instType SWAP --instId BTC-USDT-SWAP --tdMode isolated --json 2>/dev/null', { timeout: 20000 }));
} catch(e) {
  console.log('Error getting positions:', e.message);
  process.exit(1);
}

// Filter isolated BTC position
const isolatedPos = posData.filter(p => p.instId === 'BTC-USDT-SWAP' && p.mgnMode === 'isolated' && parseFloat(p.pos) > 0);
console.log('Isolated positions count:', isolatedPos.length);

// Get algo orders
let algoData;
try {
  algoData = JSON.parse(execSync('/home/administrator/.openclaw/july-btc-analyzer/scripts/okx-proxy.sh --profile live swap algo orders --instId BTC-USDT-SWAP --tdMode isolated --json 2>/dev/null', { timeout: 20000 }));
} catch(e) {
  console.log('Error getting algo orders:', e.message);
}

// Get bills
let billsData;
try {
  billsData = JSON.parse(execSync('/home/administrator/.openclaw/july-btc-analyzer/scripts/okx-proxy.sh --profile live account bills --instType SWAP --ccy USDT --limit 50 --tdMode isolated --json 2>/dev/null', { timeout: 20000 }));
} catch(e) {
  console.log('Error getting bills:', e.message);
}

console.log('Algo orders:', algoData ? algoData.length : 0);
console.log('Bills:', billsData ? billsData.length : 0);

// Build positions.json
const result = {
  "周期ID": "cycle-20260425-001",
  "同步时间": NOW,
  "数据来源": "OKX实盘账户",
  "当前持仓": [],
  "最近平仓": null,
  "汇总": {
    "当前持仓数": 0,
    "未实现盈亏总计": 0,
    "已实现盈亏总计": 0
  }
};

// Process isolated positions
for (const pos of isolatedPos) {
  const posId = pos.posId;
  const posSide = pos.posSide;
  const avgPx = parseFloat(pos.avgPx);
  const posAmt = parseFloat(pos.pos);
  
  // Filter algo orders for this position
  const posAlgos = (algoData || []).filter(a => 
    a.posSide === posSide && 
    parseFloat(a.sz) > 0 &&
    (a.algoId || '').length > 0
  );
  
  // Build algo orders
  const algoOrders = posAlgos.map(a => ({
    "订单ID": a.algoId,
    "订单类型": a.ordType === 'oco' ? 'OCO' : (a.ordType === 'conditional' ? '止损' : '止盈'),
    "止盈触发价": a.tpTriggerPx ? parseFloat(a.tpTriggerPx) : null,
    "止损触发价": a.slTriggerPx ? parseFloat(a.slTriggerPx) : null,
    "止损执行方式": a.slOrdPx === '-1' ? '市价' : '限价',
    "数量": parseFloat(a.sz),
    "状态": a.state
  }));
  
  // Filter bills for this position (from open time onwards, type 2=trade, type 8=funding)
  const posBills = (billsData || []).filter(b => {
    if (b.instId !== 'BTC-USDT-SWAP') return false;
    if (b.mgnMode !== 'isolated') return false;
    if (b.posId && b.posId !== posId) return false;
    const billTime = parseInt(b.ts);
    const openTime = parseInt(pos.cTime);
    return billTime >= openTime;
  });
  
  // Build operation records
  const opRecords = [];
  for (const bill of posBills) {
    const billTime = parseInt(bill.ts);
    const subType = parseInt(b.subType);
    
    if (subType === 2) {
      // Trade
      const isClosing = parseFloat(b.sz) < posAmt || bill.pnl > 0;
      if (bill.pnl > 0 && !isClosing) {
        // This is a close (partial or full)
        opRecords.push({
          "时间": billTime.toString(),
          "类型": "平仓",
          "价格": parseFloat(b.px).toString(),
          "数量": parseFloat(b.sz).toString(),
          "手续费": parseFloat(b.fee).toString(),
          "盈亏": parseFloat(b.pnl).toString()
        });
      } else if (opRecords.length === 0) {
        // First trade = open
        opRecords.push({
          "时间": billTime.toString(),
          "类型": "开仓",
          "价格": parseFloat(b.px).toString(),
          "数量": parseFloat(b.sz).toString(),
          "手续费": parseFloat(b.fee).toString()
        });
      } else {
        // Could be add/remove position
        opRecords.push({
          "时间": billTime.toString(),
          "类型": "调整",
          "价格": parseFloat(b.px).toString(),
          "数量": parseFloat(b.sz).toString(),
          "手续费": parseFloat(b.fee).toString()
        });
      }
    } else if (subType === 174 || subType === 14) {
      // Funding fee
      opRecords.push({
        "时间": billTime.toString(),
        "类型": "资金费结算",
        "金额": parseFloat(b.pnl || 0).toString()
      });
    }
  }
  
  // Sort by time
  opRecords.sort((a, b) => parseInt(a.时间) - parseInt(b.时间));
  
  const position = {
    "持仓ID": posId,
    "合约": pos.instId,
    "保证金模式": pos.mgnMode,
    "持仓方向": posSide,
    "持仓张数": posAmt.toString(),
    "可用张数": pos.availPos,
    "名义价值USD": pos.notionalUsd,
    "平均入场价": avgPx.toString(),
    "杠杆": parseInt(pos.lever) || 3,
    "保证金": pos.im || pos.margin,
    "未实现盈亏": pos.upl || '0',
    "盈亏比例": pos.uplRatio || '0',
    "已实现盈亏": pos.realizedPnl || '0',
    "手续费": pos.fee || '0',
    "资金费": pos.fundingFee || '0',
    "强平价": pos.liqPx,
    "保本价": pos.bePx,
    "开仓时间": pos.cTime,
    "最后更新": pos.uTime,
    "标记价格": pos.markPx,
    "指数价格": pos.idxPx,
    "最新成交价": pos.last,
    "委托订单": algoOrders,
    "操作记录": opRecords
  };
  
  result.当前持仓.push(position);
}

// Calculate totals
result.汇总.当前持仓数 = result.当前持仓.length;
result.汇总.未实现盈亏总计 = result.当前持仓.reduce((sum, p) => sum + parseFloat(p.未实现盈亏 || 0), 0);
result.汇总.已实现盈亏总计 = result.当前持仓.reduce((sum, p) => sum + parseFloat(p.已实现盈亏 || 0), 0);

// Write file
fs.writeFileSync(POS_FILE, JSON.stringify(result, null, 2));
console.log('Positions file updated:', POS_FILE);
console.log('Position count:', result.汇总.当前持仓数);
console.log('Unrealized PnL:', result.汇总.未实现盈亏总计);
console.log('Realized PnL:', result.汇总.已实现盈亏总计);
