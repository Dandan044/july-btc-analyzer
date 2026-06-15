#!/usr/bin/env node
/**
 * test-sync-oco-detect.js — 单元测试：sync-alt-positions.js OCO 触发检测逻辑
 *
 * 测试场景：WLD 真实案例
 *   1. 186 张开仓 @ $0.3185
 *   2. 93 张被 OCO TP1 @ $0.35 触发 → 实际成交 $0.348
 *   3. 46 张被 stage3 减仓 → 实际成交 $0.3548
 *   4. 剩余 47 张持仓
 *
 * 验证点：
 *   - subType=3 bills → "开仓"
 *   - subType=5 bills 匹配旧 OCO TP 价 → "OCO止盈触发"
 *   - subType=5 bills 匹配旧 OCO SL 价 → "OCO止损触发"
 *   - subType=5 bills 不匹配任何 OCO 价 → "减仓"
 *   - subType=5 bills 无旧 OCO 数据 → "减仓"
 */

// ═══ 提取自 sync-alt-positions.js 的核心逻辑 ═══
// （独立测试版本，不依赖文件系统和 OKX API）

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function round(v, d = 2) {
  return Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
}

/**
 * 对单笔 bill 进行分类（复制 sync-alt-positions.js 中的逻辑）
 * @param {object} bill - OKX 账单条目 { type, subType, sz, px, pnl, fee, ts }
 * @param {number[]} oldTpPrices - 旧 positions.json 中的 OCO 止盈触发价列表
 * @param {number[]} oldSlPrices - 旧 positions.json 中的 OCO 止损触发价列表
 * @returns {object} 操作记录条目
 */
function classifyBill(bill, oldTpPrices, oldSlPrices) {
  const type = String(bill.type);
  const subTypeVal = String(bill.subType);
  const ts = String(num(bill.ts));
  const fee = round(num(bill.fee));

  if (type === '2') {
    const billPx = num(bill.px);
    const billPnl = num(bill.pnl);

    if (subTypeVal === '3' || subTypeVal === '4' || Math.abs(billPnl) < 0.0001) {
      return {
        '时间': ts,
        '类型': '开仓',
        '价格': round(billPx, 4),
        '数量': String(bill.sz),
        '手续费': fee,
      };
    } else if (subTypeVal === '5' || subTypeVal === '6') {
      let closeLabel = '减仓';
      let matchedOcoPrice = 0;

      const isCloseTo = (px, target) => target > 0 && Math.abs(px - target) / target < 0.01;

      for (const tp of oldTpPrices) {
        if (isCloseTo(billPx, tp)) {
          closeLabel = 'OCO止盈触发';
          matchedOcoPrice = tp;
          break;
        }
      }
      if (closeLabel === '减仓') {
        for (const sl of oldSlPrices) {
          if (isCloseTo(billPx, sl)) {
            closeLabel = 'OCO止损触发';
            matchedOcoPrice = sl;
            break;
          }
        }
      }

      const record = {
        '时间': ts,
        '类型': closeLabel,
        '价格': round(billPx, 4),
        '数量': String(bill.sz),
        '已实现盈亏': round(billPnl),
        '手续费': fee,
      };
      if (matchedOcoPrice > 0) {
        record['触发价位'] = round(matchedOcoPrice, 4);
      }
      return record;
    } else {
      return {
        '时间': ts,
        '类型': '开仓',
        '价格': round(billPx, 4),
        '数量': String(bill.sz),
        '手续费': fee,
      };
    }
  } else if (type === '8') {
    return {
      '时间': ts,
      '类型': '资金费结算',
      '金额': round(num(bill.pnl)),
    };
  }
  return null;
}

// ═══ 测试用例 ═══

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`❌ ${name}: ${e.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

// ─── 测试 1: subType=3 → 开仓 ───
test('subType=3 (pnl=0) → 开仓', () => {
  const result = classifyBill(
    { type: '2', subType: '3', ts: '1780150502798', sz: '186', px: '0.3185', pnl: '0', fee: '-0.02665845' },
    [], []
  );
  assert(result['类型'] === '开仓', `期望 '开仓'，实际 '${result['类型']}'`);
  assert(result['数量'] === '186', `期望 186，实际 ${result['数量']}`);
  assert(result['价格'] === 0.3185, `期望 0.3185，实际 ${result['价格']}`);
});

// ─── 测试 2: subType=5 (pnl≠0) 无 OCO 数据 → 减仓 ───
test('subType=5 (pnl≠0) 无旧OCO数据 → 减仓', () => {
  const result = classifyBill(
    { type: '2', subType: '5', ts: '1780156800000', sz: '10', px: '0.3548', pnl: '0.363', fee: '-0.0016' },
    [], []
  );
  assert(result['类型'] === '减仓', `期望 '减仓'，实际 '${result['类型']}'`);
  assert(!result['触发价位'], '不应有触发价位');
});

// ─── 测试 3: subType=5 匹配 OCO 止盈价 → OCO止盈触发 ───
test('subType=5 成交价接近OCO TP → OCO止盈触发', () => {
  // WLD 真实场景：TP=$0.35 (offset ~$0.3465)，实际成交 $0.348
  const result = classifyBill(
    { type: '2', subType: '5', ts: '1780156177733', sz: '93', px: '0.348', pnl: '2.7435', fee: '-0.0146' },
    [0.3465, 0.35], // 旧 OCO 止盈价（offset 前和 offset 后都放入）
    [0.2847]         // 旧 OCO 止损价
  );
  assert(result['类型'] === 'OCO止盈触发', `期望 'OCO止盈触发'，实际 '${result['类型']}'`);
  assert(result['触发价位'] !== undefined, '应有触发价位');
  assert(result['已实现盈亏'] === 2.74, `期望已实现盈亏 2.74，实际 ${result['已实现盈亏']}`);
  console.log(`  → 触发价位: ${result['触发价位']}, 成交价: ${result['价格']}`);
});

// ─── 测试 4: subType=5 匹配 OCO 止损价 → OCO止损触发 ───
test('subType=5 成交价接近OCO SL → OCO止损触发', () => {
  // 模拟止损场景：SL=$0.285 (offset ~$0.2847)，实际成交 $0.284
  const result = classifyBill(
    { type: '2', subType: '5', ts: '1780157000000', sz: '93', px: '0.284', pnl: '-3.5', fee: '-0.015' },
    [0.35],
    [0.2847]  // SL offset 价
  );
  assert(result['类型'] === 'OCO止损触发', `期望 'OCO止损触发'，实际 '${result['类型']}'`);
  assert(result['已实现盈亏'] === -3.5, `期望 -3.5，实际 ${result['已实现盈亏']}`);
});

// ─── 测试 5: subType=5 价格不匹配任何 OCO → 减仓 ───
test('subType=5 价格不匹配OCO → 减仓', () => {
  const result = classifyBill(
    { type: '2', subType: '5', ts: '1780157700000', sz: '20', px: '0.37', pnl: '1.5', fee: '-0.005' },
    [0.35],   // 0.37 vs 0.35 → 差 5.7% > 1% 阈值
    [0.2847]
  );
  assert(result['类型'] === '减仓', `期望 '减仓'，实际 '${result['类型']}'`);
});

// ─── 测试 6: subType=6 (pnl≠0) → 同样支持 OCO 检测 ───
test('subType=6 匹配OCO TP → OCO止盈触发', () => {
  const result = classifyBill(
    { type: '2', subType: '6', ts: '1780157800000', sz: '47', px: '0.349', pnl: '1.41', fee: '-0.007' },
    [0.3465],
    []
  );
  assert(result['类型'] === 'OCO止盈触发', `期望 'OCO止盈触发'，实际 '${result['类型']}'`);
});

// ─── 测试 7: type=8 → 资金费结算 ───
test('type=8 → 资金费结算', () => {
  const result = classifyBill(
    { type: '8', subType: '174', ts: '1780156800000', pnl: '0.001' },
    [], []
  );
  assert(result['类型'] === '资金费结算', `期望 '资金费结算'，实际 '${result['类型']}'`);
});

// ─── 测试 8: 完整 WLD 场景回放 ───
test('完整WLD场景: 186开仓→93 OCO止盈→46 减仓', () => {
  const oldTpPrices = [0.3465]; // OCO TP1 offset 价
  const oldSlPrices = [0.2847]; // OCO SL offset 价

  const bills = [
    { type: '2', subType: '3', ts: '1780150502798', sz: '186', px: '0.3185', pnl: '0',       fee: '-0.027' },
    { type: '2', subType: '5', ts: '1780156177733', sz: '93',  px: '0.348',  pnl: '2.7435',  fee: '-0.015' },
    { type: '8', subType: '174',ts: '1780156802000', pnl: '0.0001' },
    { type: '2', subType: '5', ts: '1780157697152', sz: '10',  px: '0.3548', pnl: '0.363',   fee: '-0.002' },
    { type: '2', subType: '5', ts: '1780157697152', sz: '36',  px: '0.3548', pnl: '1.3068',  fee: '-0.006' },
  ];

  const results = bills.map(b => classifyBill(b, oldTpPrices, oldSlPrices)).filter(Boolean);

  console.log('\n  完整操作记录:');
  results.forEach(r => {
    const tp = r['触发价位'] ? ` (触发价: ${r['触发价位']})` : '';
    console.log(`    ${r['类型']}: ${r['数量']} @ $${r['价格']}${tp}`);
  });

  assert(results[0]['类型'] === '开仓', `#1 期望开仓`);
  assert(results[1]['类型'] === 'OCO止盈触发', `#2 期望 OCO止盈触发`);
  assert(results[2]['类型'] === '资金费结算', `#3 期望资金费结算`);
  assert(results[3]['类型'] === '减仓', `#4 期望减仓 (不匹配OCO)`);
  assert(results[4]['类型'] === '减仓', `#5 期望减仓`);

  // 验证阶段三减仓没有被误标为 OCO 触发
  // 0.3548 vs 0.3465 → 差 2.4% > 1% 阈值
  assert(results[3]['类型'] !== 'OCO止盈触发', '0.3548 不应匹配 OCO TP 0.3465');
});

// ─── 测试 9: 边界 — 无旧持仓数据 ───
test('无旧持仓数据 → 减仓', () => {
  const result = classifyBill(
    { type: '2', subType: '5', ts: '1780156800000', sz: '50', px: '0.35', pnl: '1.0', fee: '-0.01' },
    [], []
  );
  assert(result['类型'] === '减仓', `期望 '减仓'，实际 '${result['类型']}'`);
});

// ─── 测试 10: 1% 边界 ───
test('1% 容差边界测试', () => {
  // 0.99% 差 → 应匹配
  const r1 = classifyBill(
    { type: '2', subType: '5', ts: '1', sz: '1', px: '0.353', pnl: '0.5', fee: '0' },
    [0.35], []
  );
  assert(r1['类型'] === 'OCO止盈触发', `0.353 vs 0.35 (0.86%) → 应匹配，实际 ${r1['类型']}`);

  // 1.5% 差 → 不应匹配
  const r2 = classifyBill(
    { type: '2', subType: '5', ts: '2', sz: '1', px: '0.355', pnl: '0.5', fee: '0' },
    [0.35], []
  );
  assert(r2['类型'] === '减仓', `0.355 vs 0.35 (1.43%) → 不应匹配，实际 ${r2['类型']}`);
});

// ═══ 结果汇总 ═══
console.log(`\n${'='.repeat(50)}`);
console.log(`测试结束: ${passed} 通过, ${failed} 失败, ${passed + failed} 总计`);
if (failed > 0) {
  process.exit(1);
}
