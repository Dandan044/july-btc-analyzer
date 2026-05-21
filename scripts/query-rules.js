#!/usr/bin/env node
/**
 * 警报规则查询工具
 *
 * 从活跃规则和归档规则中检索,支持多维度筛选。
 * 仅查询有 C19 元数据的规则(旧无字段规则自动跳过)。
 *
 * 用法:
 *   # 全部活跃规则
 *   node scripts/query-rules.js
 *
 *   # 按币种
 *   node scripts/query-rules.js --coin CHZ
 *
 *   # 按类型
 *   node scripts/query-rules.js --type price-levels
 *
 *   # 已归档规则
 *   node scripts/query-rules.js --archived
 *
 *   # 时间范围
 *   node scripts/query-rules.js --archived --after 2026-05-15
 *   node scripts/query-rules.js --created-between 2026-05-10 2026-05-20
 *
 *   # 组合筛选
 *   node scripts/query-rules.js --coin CHZ --type price-levels --archived
 *   node scripts/query-rules.js --cycle alt-APE-20260518-0104
 *   node scripts/query-rules.js --created-by alt-intel-stage4
 *
 *   # 关键词搜索
 *   node scripts/query-rules.js --search "止损"
 *
 *   # 输出格式
 *   node scripts/query-rules.js --coin BTC --format json
 *   node scripts/query-rules.js --type price-levels --format summary
 */

const fs = require('fs');
const path = require('path');

const RULES_DIR = path.join(__dirname, '..', 'skills', 'btc-alert', 'rules');
const ARCHIVE_DIR = path.join(__dirname, '..', 'skills', 'btc-alert', 'rules-archive');

// ============================================================
// 参数解析
// ============================================================
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--coin': case '-c': opts.coin = args[++i]; break;
      case '--type': case '-t': opts.type = args[++i]; break;
      case '--status': case '-s': opts.status = args[++i]; break;
      case '--created-by': opts.createdBy = args[++i]; break;
      case '--archived-by': opts.archivedBy = args[++i]; break;
      case '--cycle': opts.cycle = args[++i]; break;
      case '--after': opts.after = args[++i]; break;
      case '--before': opts.before = args[++i]; break;
      case '--created-after': opts.createdAfter = args[++i]; break;
      case '--created-before': opts.createdBefore = args[++i]; break;
      case '--archived-after': opts.archivedAfter = args[++i]; break;
      case '--archived-before': opts.archivedBefore = args[++i]; break;
      case '--created-between':
        opts.createdAfter = args[++i];
        opts.createdBefore = args[++i];
        break;
      case '--archived-between':
        opts.archivedAfter = args[++i];
        opts.archivedBefore = args[++i];
        break;
      case '--stale': opts.stale = args[++i]; break;
      case '--recent': opts.recent = args[++i]; break;
      case '--checked-between':
        opts.checkedBetweenA = args[++i];
        opts.checkedBetweenB = args[++i];
        break;
      case '--search': opts.search = args[++i]; break;
      case '--format': case '-f': opts.format = args[++i]; break;
      case '--limit': opts.limit = parseInt(args[++i]); break;
      case '--archived': opts.scope = 'archived'; break;
      case '--active': opts.scope = 'active'; break;
      case '--all': opts.scope = 'all'; break;
      case '--help': case '-h': showHelp(); process.exit(0);
    }
  }

  return opts;
}

function showHelp() {
  console.log(`
警报规则查询工具
─────────────────
从活跃规则 (rules/) 和归档规则 (rules-archive/) 中检索。

筛选选项:
  --coin, -c <币种>        按币种筛选(如 BTC, CHZ, APE)
  --type, -t <类型>        按规则类型筛选:
                            price-levels | oi-monitor | funding-reversal
                            | taker-ratio | ls-reversal | composite
  --status, -s <状态>      按状态筛选: active | archived
  --created-by <来源>      按创建来源筛选
  --archived-by <来源>     按归档来源筛选
  --cycle <周期ID>         按周期 ID 筛选(模糊匹配)

时间筛选:
  --after <日期>           创建或归档时间 >= 日期(自动匹配创建/归档字段)
  --before <日期>          创建或归档时间 <= 日期
  --created-after <日期>   创建时间 >= 日期
  --created-before <日期>  创建时间 <= 日期
  --created-between <A> <B> 创建时间在 A~B 之间
  --archived-after <日期>  归档时间 >= 日期
  --archived-before <日期> 归档时间 <= 日期
  --archived-between <A> <B> 归档时间在 A~B 之间

lastCheckedAt 相对时间:
  --stale <时长>           最后检测距今 > 时长(可能卡死),如 --stale 10m
  --recent <时长>          最后检测在最近时长内,如 --recent 5m
  --checked-between <A> <B> 最后检测在 A~B 之前,如 --checked-between 10m 20m
  时长格式: 30s | 5m | 2h | 1d

范围:
  --active                 仅活跃规则(默认)
  --archived               仅已归档规则
  --all                    活跃 + 归档

搜索:
  --search <关键词>        在 name/coin/sourceReport/archiveReason 中搜索

输出:
  --format, -f <fmt>       table (默认) | json | summary | list
  --limit <N>              最多显示 N 条

示例:
  node scripts/query-rules.js --coin CHZ --archived
  node scripts/query-rules.js --type price-levels --format summary
  node scripts/query-rules.js --archived --after 2026-05-15 --format json
  node scripts/query-rules.js --search "止损" --archived
  node scripts/query-rules.js --cycle alt-APE-20260518-0104 --all
`);
}

// ============================================================
// 解析相对时间字符串 → 毫秒
//   支持: 30s 5m 2h 1d
// ============================================================
function parseDuration(s) {
  const m = s.match(/^(\d+)(s|m|h|d)$/);
  if (!m) throw new Error(`无效时间格式: ${s} (支持 30s 5m 2h 1d)`);
  const n = parseInt(m[1]);
  switch (m[2]) {
    case 's': return n * 1000;
    case 'm': return n * 60 * 1000;
    case 'h': return n * 3600 * 1000;
    case 'd': return n * 86400 * 1000;
    default: throw new Error(`无效时间单位: ${m[2]}`);
  }
}

// ============================================================
// 从文件内容提取 C19 元数据字段(正则,不执行代码)
// ============================================================
function extractFields(filePath, location) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const basename = path.basename(filePath, '.js');

    // 检查是否有 C19 元数据
    if (!content.includes('ruleType:')) return null;

    const get = (re) => {
      const m = content.match(re);
      return m ? m[1] : null;
    };

    return {
      file: basename,
      location: location,
      name: get(/name:\s*['"]([^'"]+)['"]/),
      ruleType: get(/ruleType:\s*['"]([^'"]+)['"]/),
      coin: get(/coin:\s*['"]([^'"]+)['"]/),
      cycleId: get(/cycleId:\s*['"]([^'"]+)['"]/),
      status: get(/status:\s*['"]([^'"]+)['"]/),
      createdAt: get(/createdAt:\s*['"]([^'"]+)['"]/),
      createdBy: get(/createdBy:\s*['"]([^'"]+)['"]/),
      sourceReport: get(/sourceReport:\s*['"]([^'"]+)['"]/),
      archivedAt: get(/archivedAt:\s*['“]([^'”]+)['”]/),
      archivedBy: get(/archivedBy:\s*['“]([^'”]+)['”]/),
      archiveReason: get(/archiveReason:\s*['“]([^'”]+)['”]/),
      lastCheckedAt: get(/lastCheckedAt:\s*['“]([^'”]+)['”]/),
    };
  } catch {
    return null;
  }
}

// ============================================================
// 收集所有规则
// ============================================================
function collectRules(opts) {
  const rules = [];
  const scope = opts.scope || 'active';

  // 活跃规则
  if (scope === 'active' || scope === 'all') {
    if (fs.existsSync(RULES_DIR)) {
      for (const f of fs.readdirSync(RULES_DIR).filter(f => f.endsWith('.js'))) {
        const fields = extractFields(path.join(RULES_DIR, f), 'active');
        if (fields) rules.push(fields);
      }
    }
  }

  // 归档规则
  if (scope === 'archived' || scope === 'all') {
    if (fs.existsSync(ARCHIVE_DIR)) {
      // 递归遍历(含子目录)
      function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.name.endsWith('.js')) {
            const fields = extractFields(full, 'archived');
            if (fields) rules.push(fields);
          }
        }
      }
      try { walk(ARCHIVE_DIR); } catch (_) {}
    }
  }

  return rules;
}

// ============================================================
// 筛选
// ============================================================
function filterRules(rules, opts) {
  return rules.filter(r => {
    if (opts.coin && r.coin?.toUpperCase() !== opts.coin.toUpperCase()) return false;
    if (opts.type && r.ruleType !== opts.type) return false;
    if (opts.status && r.status !== opts.status) return false;
    if (opts.createdBy && r.createdBy !== opts.createdBy) return false;
    if (opts.archivedBy && r.archivedBy !== opts.archivedBy) return false;
    if (opts.cycle && r.cycleId && !r.cycleId.includes(opts.cycle)) return false;

    // 时间筛选
    const createdTs = r.createdAt ? new Date(r.createdAt).getTime() : null;
    const archivedTs = r.archivedAt ? new Date(r.archivedAt).getTime() : null;
    const checkedTs = r.lastCheckedAt ? new Date(r.lastCheckedAt).getTime() : null;
    const now = Date.now();

    if (opts.createdAfter && (!createdTs || createdTs < new Date(opts.createdAfter).getTime())) return false;
    if (opts.createdBefore && (!createdTs || createdTs > new Date(opts.createdBefore + 'T23:59:59').getTime())) return false;
    if (opts.archivedAfter && (!archivedTs || archivedTs < new Date(opts.archivedAfter).getTime())) return false;
    if (opts.archivedBefore && (!archivedTs || archivedTs > new Date(opts.archivedBefore + 'T23:59:59').getTime())) return false;

    // --after / --before: 自动匹配 createdAt 或 archivedAt
    if (opts.after) {
      const afterTs = new Date(opts.after).getTime();
      const matchCreated = createdTs && createdTs >= afterTs;
      const matchArchived = archivedTs && archivedTs >= afterTs;
      if (!matchCreated && !matchArchived) return false;
    }
    if (opts.before) {
      const beforeTs = new Date(opts.before + 'T23:59:59').getTime();
      const matchCreated = createdTs && createdTs <= beforeTs;
      const matchArchived = archivedTs && archivedTs <= beforeTs;
      if (!matchCreated && !matchArchived) return false;
    }

    // 关键词搜索
    if (opts.search) {
      const kw = opts.search.toLowerCase();
      const haystack = [r.name, r.coin, r.cycleId, r.sourceReport, r.archiveReason, r.file]
        .filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(kw)) return false;
    }

    // ⭐ lastCheckedAt 相对时间筛选
    if (opts.stale) {
      const threshold = now - parseDuration(opts.stale);
      if (!checkedTs || checkedTs >= threshold) return false;
    }
    if (opts.recent) {
      const threshold = now - parseDuration(opts.recent);
      if (!checkedTs || checkedTs < threshold) return false;
    }
    if (opts.checkedBetweenA && opts.checkedBetweenB) {
      const lo = now - parseDuration(opts.checkedBetweenB);
      const hi = now - parseDuration(opts.checkedBetweenA);
      if (!checkedTs || checkedTs < lo || checkedTs > hi) return false;
    }

    return true;
  });
}

// ============================================================
// 输出
// ============================================================
function formatDate(d) {
  if (!d) return '-';
  // 截取到分钟
  return d.replace('T', ' ').substring(0, 16);
}

function truncate(s, max) {
  if (!s) return '-';
  return s.length > max ? s.substring(0, max - 1) + '...' : s;
}

function outputTable(rules) {
  if (rules.length === 0) {
    console.log('(无匹配结果)');
    return;
  }

  // 计算列宽
  const cols = {
    file: 28, name: 22, coin: 5, type: 16, status: 8,
    created: 16, archived: 16, reason: 20
  };

  // 头
  const header =
    '文件'.padEnd(cols.file) +
    '名称'.padEnd(cols.name) +
    '币种'.padEnd(cols.coin) +
    '类型'.padEnd(cols.type) +
    '状态'.padEnd(cols.status) +
    '创建时间'.padEnd(cols.created) +
    '归档时间'.padEnd(cols.archived) +
    '归档原因';
  console.log(header);
  console.log('─'.repeat(header.length));

  for (const r of rules) {
    const line =
      truncate(r.file, cols.file).padEnd(cols.file) +
      truncate(r.name, cols.name).padEnd(cols.name) +
      (r.coin || '-').padEnd(cols.coin) +
      (r.ruleType || '-').padEnd(cols.type) +
      (r.status || r.location || '-').padEnd(cols.status) +
      formatDate(r.createdAt).padEnd(cols.created) +
      formatDate(r.archivedAt).padEnd(cols.archived) +
      truncate(r.archiveReason || '-', cols.reason);
    console.log(line);
  }
}

function outputList(rules) {
  if (rules.length === 0) {
    console.log('(无匹配结果)');
    return;
  }
  for (const r of rules) {
    console.log(`${r.location === 'archived' ? '📦' : '🟢'} ${r.file}`);
    console.log(`   币种: ${r.coin || '-'}  类型: ${r.ruleType || '-'}  状态: ${r.status || r.location}`);
    console.log(`   周期: ${r.cycleId || '-'}`);
    console.log(`   创建: ${formatDate(r.createdAt)}  via ${r.createdBy || '-'}`);
    if (r.archivedAt) console.log(`   归档: ${formatDate(r.archivedAt)}  via ${r.archivedBy || '-'}  ${r.archiveReason || ''}`);
    if (r.sourceReport) console.log(`   来源报告: ${r.sourceReport}`);
    console.log();
  }
}

function outputSummary(rules) {
  if (rules.length === 0) {
    console.log('(无匹配结果)');
    return;
  }

  const byType = {}, byCoin = {}, byStatus = {};

  for (const r of rules) {
    byType[r.ruleType] = (byType[r.ruleType] || 0) + 1;
    byCoin[r.coin] = (byCoin[r.coin] || 0) + 1;
    const st = r.status || r.location;
    byStatus[st] = (byStatus[st] || 0) + 1;
  }

  console.log(`匹配 ${rules.length} 条规则\n`);
  console.log('按类型:');
  for (const [k, v] of Object.entries(byType).sort()) console.log(`  ${k}: ${v}`);
  console.log('\n按币种:');
  for (const [k, v] of Object.entries(byCoin).sort()) console.log(`  ${k}: ${v}`);
  console.log('\n按状态:');
  for (const [k, v] of Object.entries(byStatus).sort()) console.log(`  ${k}: ${v}`);
}

// ============================================================
// 主流程
// ============================================================
function main() {
  const opts = parseArgs();

  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    showHelp();
    return;
  }

  let rules = collectRules(opts);
  rules = filterRules(rules, opts);

  // 排序:按创建时间倒序
  rules.sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });

  // 限制数量
  if (opts.limit && opts.limit > 0) {
    rules = rules.slice(0, opts.limit);
  }

  const fmt = opts.format || 'table';
  switch (fmt) {
    case 'json':
      console.log(JSON.stringify(rules, null, 2));
      break;
    case 'summary':
      outputSummary(rules);
      break;
    case 'list':
      outputList(rules);
      break;
    default:
      outputTable(rules);
  }
}

main();
