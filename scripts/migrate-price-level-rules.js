#!/usr/bin/env node
/**
 * 迁移所有现存多价位监控规则：
 *   间隔 3min + 硬编码 3 根 1m K 线
 *   → 间隔 10min + 动态 limit 缩放 (2 根 5m K 线起)
 *
 * 用法: node scripts/migrate-price-level-rules.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const RULES_DIR = path.resolve(__dirname, '..', 'skills/btc-alert/rules');
const dryRun = process.argv.includes('--dry-run');

function main() {
  const files = fs.readdirSync(RULES_DIR).filter(f => f.includes('price-levels') && f.endsWith('.js'));
  let updated = 0;

  for (const file of files) {
    const filePath = path.join(RULES_DIR, file);
    let content = fs.readFileSync(filePath, 'utf8');
    let modified = false;

    // 1. Add BAR/BAR_MS constants after STABILITY block
    //    Skip if already has BAR defined
    if (!content.includes('const BAR =')) {
      const stabilityEnd = content.indexOf('resetOnCrossback: true');
      if (stabilityEnd === -1) {
        console.log(`  ⚠️  ${file}: 找不到 STABILITY 块，跳过`);
        continue;
      }
      const insertPos = content.indexOf('\n', stabilityEnd) + 1; // after 'resetOnCrossback: true\n'
      // Find the next blank line after '};'
      const bracePos = content.indexOf('};', stabilityEnd);
      if (bracePos === -1) continue;
      const afterStability = content.indexOf('\n', bracePos) + 1;

      const barBlock = `
// ============================================================
// K 线参数（间隔翻倍时 limit 自动缩放）
// ============================================================
const BAR = '5m';
const BAR_MS = 5 * 60 * 1000;

`;
      content = content.slice(0, afterStability) + barBlock + content.slice(afterStability).replace(/^\n+/, '');
      modified = true;
    }

    // 2. Change interval: 3 * 60 * 1000 → 10 * 60 * 1000
    //    Skip if already 10 * 60 * 1000
    if (content.includes('interval: 3 * 60 * 1000')) {
      content = content.replace('interval: 3 * 60 * 1000', 'interval: 10 * 60 * 1000');
      modified = true;
    }

    // 3. Change hardcoded klines fetch to dynamic
    //    Skip if already using BAR
    if (!content.includes('Math.round(this.interval / BAR_MS)')) {
      // Match: const klines = await api.getOKXKlines(COIN, '1m', 3, 'SWAP');
      const oldFetchRegex = /const klines = await api\.getOKXKlines\(COIN, '1m', 3, 'SWAP'\);/g;
      if (oldFetchRegex.test(content)) {
        content = content.replace(
          oldFetchRegex,
          `const limit = Math.max(2, Math.round(this.interval / BAR_MS));\n      const klines = await api.getOKXKlines(COIN, BAR, limit, 'SWAP');`
        );
        modified = true;
      }
    }

    // 4. Update console.log message: "3根1m K线" → "${limit}根${BAR} K线"
    const logPattern = /(`\[🔍警报检查\].*?OKX获取\$\{COIN\} )3根1m K线/g;
    if (logPattern.test(content)) {
      content = content.replace(logPattern, '$1${limit}根${BAR} K线');
      modified = true;
    }

    if (modified) {
      if (dryRun) {
        console.log(`  📝 [DRY-RUN] ${file} → 需要更新`);
      } else {
        fs.writeFileSync(filePath, content, 'utf8');
        console.log(`  ✅ ${file} → 已更新`);
      }
      updated++;
    } else {
      console.log(`  ➖ ${file} → 无需更新`);
    }
  }

  console.log(`\n总计: ${files.length} 个价位规则，更新: ${updated} 个${dryRun ? ' (DRY-RUN)' : ''}`);
}

main();
