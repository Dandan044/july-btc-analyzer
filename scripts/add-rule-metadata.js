#!/usr/bin/env node
/**
 * 为所有活跃警报规则添加 ruleType + cycleId 元数据字段
 * 用法: node scripts/add-rule-metadata.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const RULES_DIR = path.join(__dirname, '..', 'skills', 'btc-alert', 'rules');
const ACTIVE_DIR = path.join(__dirname, '..', 'active');
const ARCHIVED_DIR = path.join(__dirname, '..', 'archived');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

// ============================================================
// 1. 规则类型推断：文件名 → ruleType
// ============================================================
function inferRuleType(filename) {
  const name = path.basename(filename, '.js');

  // 多空比
  if (name.includes('-ls-')) return 'ls-reversal';

  // 资金费率
  if (name.includes('-funding-')) return 'funding-reversal';

  // 复合指标：OI+Taker、OI+RSI、OI+sentiment
  if (name.includes('-oi-') && (name.includes('-taker') || name.includes('-rsi') || name.includes('-sentiment'))) {
    return 'composite';
  }

  // Taker 买卖比（纯）
  if (name.includes('-taker-')) return 'taker-ratio';

  // OI 异动（纯 OI 监控，不含 -taker/-rsi/-sentiment）
  if (name.includes('-oi-')) return 'oi-monitor';

  // 价位规则（含 short/watch/rebound 变体）
  if (name.includes('-price-') || name.includes('-short') ||
      name.includes('-watch') || name.includes('-rebound') ||
      name.endsWith('-price')) {
    return 'price-levels';
  }

  return 'composite';
}

// ============================================================
// 2. 提取 COIN
// ============================================================
function extractCoin(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(/const COIN = ['"]([^'"]+)['"]/);
    if (match) return match[1];
  } catch {}

  // 回退：从文件名前缀提取
  const basename = path.basename(filePath, '.js');
  if (/^\d{4}-\d{2}-\d{2}/.test(basename)) return 'BTC'; // 日期前缀 = BTC
  const coinMatch = basename.match(/^([A-Z0-9]+)-/);
  return coinMatch ? coinMatch[1] : 'UNKNOWN';
}

// ============================================================
// 3. 查找周期ID
// ============================================================
function findCycleId(coin) {
  if (coin === 'BTC') {
    const btcCycles = fs.readdirSync(ACTIVE_DIR)
      .filter(d => d.startsWith('cycle-')).sort();
    if (btcCycles.length > 0) return btcCycles[btcCycles.length - 1];
    return 'cycle-unknown';
  }

  const altActive = fs.readdirSync(ACTIVE_DIR)
    .filter(d => d.startsWith(`alt-${coin}-`)).sort();
  if (altActive.length > 0) return altActive[altActive.length - 1];

  try {
    const altArchived = fs.readdirSync(ARCHIVED_DIR)
      .filter(d => d.startsWith(`alt-${coin}-`)).sort();
    if (altArchived.length > 0) return `archived/${altArchived[altArchived.length - 1]}`;
  } catch {}

  return 'orphaned';
}

// ============================================================
// 4. 插入元数据字段
// ============================================================
function insertMetadata(content, ruleType, cycleId) {
  // 匹配 module.exports = { ... name: '...',
  const m = content.match(/(module\.exports\s*=\s*\{[\s\S]*?)(\s{2}name:\s*['"][^'"]+['"],)/m);
  if (!m) {
    console.error('  ⛔ 未找到 module.exports + name: 模式');
    return null;
  }

  const before = m[1] + m[2];
  const after = `\n  // ⭐ C19: 规则元数据（必填）\n  ruleType: '${ruleType}',\n  cycleId: '${cycleId}',\n  // ⭐ C19 END`;

  return content.replace(m[0], before + after);
}

// ============================================================
// 5. 主流程
// ============================================================
function main() {
  const files = fs.readdirSync(RULES_DIR).filter(f => f.endsWith('.js')).sort();

  console.log(`${DRY_RUN ? '🔍 DRY RUN' : '✍️  执行写入'} — ${files.length} 个规则文件\n`);

  let updated = 0, skipped = 0, failed = 0;
  const summary = [];

  for (const file of files) {
    const filePath = path.join(RULES_DIR, file);
    const content = fs.readFileSync(filePath, 'utf8');

    // 已有 ruleType 则跳过（除非 --force）
    if (content.includes('ruleType:') && !FORCE) {
      console.log(`  ⏭️  ${file} — 已有 metadata`);
      skipped++;
      continue;
    }

    let ruleType = inferRuleType(file);
    const coin = extractCoin(filePath);
    const cycleId = findCycleId(coin);

    console.log(`  📝 ${file} → ruleType=${ruleType}  coin=${coin}  cycleId=${cycleId}`);

    if (DRY_RUN) continue;

    const newContent = insertMetadata(content, ruleType, cycleId);
    if (!newContent) { failed++; continue; }

    fs.writeFileSync(filePath, newContent, 'utf8');
    updated++;
  }

  console.log(`\n===== 汇总 =====`);
  console.log(`${DRY_RUN ? '将' : '已'}更新: ${updated} | 跳过: ${skipped} | 失败: ${failed}`);

  const typeCounts = {};
  for (const file of files) {
    const rt = inferRuleType(file);
    typeCounts[rt] = (typeCounts[rt] || 0) + 1;
  }
  console.log('类型分布:');
  for (const [t, c] of Object.entries(typeCounts).sort()) {
    console.log(`  ${t}: ${c}`);
  }
}

main();
