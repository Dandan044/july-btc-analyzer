#!/usr/bin/env node
/**
 * 持仓同步脚本（完整版）
 * 从OKX实盘获取BTC逐仓持仓数据，包含止盈止损订单，生成positions.json
 */

const fs = require('fs');
const path = require('path');

// 配置
const CYCLE_ID = process.argv[2] || 'cycle-20260419-001';
const WORKSPACE = '/home/administrator/.openclaw/july-btc-analyzer';
const POSITIONS_FILE = path.join(WORKSPACE, 'active', CYCLE_ID, 'positions.json');
const DATA_DIR = path.join(WORKSPACE, 'data');

// 当前时间
const NOW = new Date().toISOString();

// 加载原始数据
const rawPositions = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'raw_positions_clean.json'), 'utf8'));
const rawBills = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'raw_bills_clean.json'), 'utf8'));
const rawTpOrders = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'raw_orders_tp_clean.json'), 'utf8'));
const rawSlOrders = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'raw_orders_sl_clean.json'), 'utf8'));

// 筛选BTC逐仓持仓
const btcIsolatedPositions = rawPositions.filter(p => 
  p.instId === 'BTC-USDT-SWAP' && p.mgnMode === 'isolated'
);

// 筛选BTC逐仓止盈订单
const tpOrders = rawTpOrders.filter(o => 
  o.instId === 'BTC-USDT-SWAP' && o.tdMode === 'isolated' && o.reduceOnly === 'true'
);

// 筛选BTC逐仓止损订单
const slOrders = rawSlOrders.filter(o => 
  o.instId === 'BTC-USDT-SWAP' && o.tdMode === 'isolated'
);

// 检查旧持仓文件是否存在
let oldPositions = null;
let hasOldPosition = false;
if (fs.existsSync(POSITIONS_FILE)) {
  try {
    oldPositions = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
    hasOldPosition = oldPositions['当前持仓'] && oldPositions['当前持仓'].length > 0;
  } catch (e) {
    console.log('旧持仓文件读取失败');
  }
}

// 判断是否有平仓
const hasNewPosition = btcIsolatedPositions.length > 0;
const positionClosed = hasOldPosition && !hasNewPosition;

// 构建持仓数据
const positions = {
  "周期ID": CYCLE_ID,
  "同步时间": NOW,
  "数据来源": "OKX实盘账户",
  
  "当前持仓": btcIsolatedPositions.map(pos => {
    // 篮选操作记录（从开仓开始）
    const openTime = parseInt(pos.cTime);
    const posId = pos.posId;
    const posSide = pos.posSide;
    
    // 从账单中筛选当前仓位的操作
    const operations = rawBills
      .filter(bill => {
        return bill.instId === 'BTC-USDT-SWAP' &&
               bill.mgnMode === 'isolated' &&
               parseInt(bill.ts) >= openTime;
      })
      .map(bill => {
        const billType = parseInt(bill.type);
        let opType = '';
        
        if (billType === 2) {
          opType = '开仓/加仓/减仓';
        } else if (billType === 8) {
          opType = '资金费结算';
        } else if (billType === 9) {
          opType = '手续费';
        } else {
          opType = `其他(${billType})`;
        }
        
        return {
          "时间": bill.ts,
          "类型": opType,
          "价格": bill.px || '',
          "数量": bill.sz || '',
          "手续费": bill.fee || '0',
          "资金费": billType === 8 ? bill.pnl : ''
        };
      })
      .slice(0, 20);
    
    // 匹配止盈止损订单（按持仓方向和数量）
    const posSz = pos.pos;
    const matchedTp = tpOrders.find(o => o.posSide === posSide && o.sz === posSz);
    const matchedSl = slOrders.find(o => o.posSide === posSide && o.sz === posSz);
    
    const 委托订单 = [];
    
    if (matchedTp) {
      委托订单.push({
        "订单ID": matchedTp.ordId,
        "订单类型": "止盈",
        "价格": matchedTp.px,
        "数量": matchedTp.sz,
        "状态": matchedTp.state,
        "关联止损ID": matchedTp.linkedAlgoOrd?.algoId || ''
      });
    }
    
    if (matchedSl) {
      委托订单.push({
        "订单ID": matchedSl.algoId,
        "订单类型": "止损",
        "触发价": matchedSl.slTriggerPx,
        "执行方式": matchedSl.slOrdPx === '-1' ? "市价" : "限价",
        "数量": matchedSl.sz,
        "状态": matchedSl.state
      });
    }
    
    return {
      "持仓ID": pos.posId,
      "合约": pos.instId,
      "保证金模式": pos.mgnMode,
      "持仓方向": pos.posSide,
      "持仓张数": pos.pos,
      "可用张数": pos.availPos,
      "名义价值USD": pos.notionalUsd,
      "平均入场价": pos.avgPx,
      "杠杆": pos.lever,
      "保证金": pos.margin || '0',
      "未实现盈亏": pos.upl,
      "盈亏比例": pos.uplRatio,
      "已实现盈亏": pos.realizedPnl,
      "手续费": pos.fee,
      "资金费": pos.fundingFee,
      "强平价": pos.liqPx || '',
      "保本价": pos.bePx,
      "开仓时间": pos.cTime,
      "最后更新": pos.uTime,
      "标记价格": pos.markPx,
      "指数价格": pos.idxPx,
      "最新成交价": pos.last,
      
      "委托订单": 委托订单,
      
      "操作记录": operations
    };
  }),
  
  "最近平仓": null,
  
  "汇总": {
    "当前持仓数": btcIsolatedPositions.length,
    "未实现盈亏总计": btcIsolatedPositions.reduce((sum, p) => sum + parseFloat(p.upl || 0), 0),
    "已实现盈亏总计": btcIsolatedPositions.reduce((sum, p) => sum + parseFloat(p.realizedPnl || 0), 0)
  }
};

// 如果检测到平仓，填充最近平仓信息
if (positionClosed && oldPositions) {
  const closedPos = oldPositions['当前持仓'][0];
  positions['最近平仓'] = {
    "持仓ID": closedPos['持仓ID'],
    "合约": closedPos['合约'],
    "持仓方向": closedPos['持仓方向'],
    "开仓均价": closedPos['平均入场价'],
    "平仓价格": "需要从历史持仓API获取",
    "平仓时间": "需要从历史持仓API获取",
    "平仓类型": "需要判断",
    "持仓张数": closedPos['持仓张数'],
    "盈亏": "需要计算",
    "手续费": closedPos['手续费']
  };
  positions['备注'] = "本周期曾开仓现已平仓";
} else if (btcIsolatedPositions.length === 0) {
  positions['备注'] = "当前无BTC-USDT-SWAP逐仓持仓";
}

// 写入文件
fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
console.log(`持仓文件已生成: ${POSITIONS_FILE}`);
console.log(`当前BTC逐仓持仓: ${btcIsolatedPositions.length} 个`);
console.log(`止盈订单: ${tpOrders.length} 个`);
console.log(`止损订单: ${slOrders.length} 个`);