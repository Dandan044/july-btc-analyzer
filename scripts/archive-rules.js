#!/usr/bin/env node
/**
 * 警报规则归档工具
 *
 * 支持单条/按币种/按周期批量归档，自动填写 archivedAt/archivedBy/archiveReason/status
 *
 * 用法:
 *   # 单条规则
 *   node scripts/archive-rules.js --rule APE-price-levels.js --by stage4-cleanup --reason "不在最终列表"
 *
 *   # 按币种批量
 *   node scripts/archive-rules.js --coin CHZ --by cycle-archived --reason "周期归档，警报清零"
 *
 *   # 按周期批量
 *   node scripts/archive-rules.js --cycle alt-APE-20260518-0104 --by cycle-archived --reason "周期已归档"
 *
 *   # 预览（不实际执行）
 *   node scripts/archive-rules.js --dry-run --coin CHZ --by manual --reason "测试"
 *
 *   # 全部规则（需 --confirm）
 *   node scripts/archive-rules.js --all --by manual --reason "批量重置" --confirm
 */

const fs = require('fs');
const path = require('path');

const RULES_DIR = path.join(__dirname, '..', 'skills', 'btc-alert', 'rules');
const ARCHIVE_DIR = path.join(__dirname, '..', 'skills', 'btc-alert', 'rules-archive');
const LOG_FILE = path.join(__dirname, '..', 'logs', 'archive-rules.log');

// ============================================================
// 参数解析
// ============================================================
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--rule' && i + 1 < args.length) { opts.rule = args[++i]; continue; }
    if (a === '--coin' && i + 1 < args.length) { opts.coin = args[++i]; continue; }
    if (a === '--cycle' && i + 1 < args.length) { opts.cycle = args[++i]; continue; }
    if (a === '--by' && i + 1 < args.length) { opts.by = args[++i]; continue; }
    if (a === '--reason' && i + 1 < args.length) { opts.reason = args[++i]; continue; }
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--all') { opts.all = true; continue; }
    if (a === '--confirm') { opts.confirm = true; continue; }
    if (a === '--help' || a === '-h') { showHelp(); process.exit(0); }
  }

  return opts;
}

function showHelp() {
  console.log(`
警报规则归档工具
─────────────────
自动填写 archivedAt/archivedBy/archiveReason/status 并移动到 rules-archive/

选项:
  --rule <文件名>       归档单条规则（如 APE-price-levels.js）
  --coin <币种>         归档指定币种的所有规则（如 CHZ）
  --cycle <周期ID>      归档指定周期的所有规则（如 alt-APE-20260518-0104）
  --all                 归档全部活跃规则（需 --confirm）
  --by <来源>           归档来源（必填）:
                          stage4-cleanup      阶段四正常清理
                          trigger-fired       触发后自动归档
                          cycle-archived      周期归档批量清零
                          cycle-health-check  健康检测清理
                          manual              人工归档
                          lifetime-expired    引擎自动过期
  --reason <原因>       归档原因文本（必填）
  --dry-run             预览模式，不实际移动
  --confirm             配合 --all 使用，确认批量操作

示例:
  node scripts/archive-rules.js --rule APE-price-levels.js --by stage4-cleanup --reason "不在最终列表"
  node scripts/archive-rules.js --coin CHZ --by cycle-archived --reason "周期归档清零"
  node scripts/archive-rules.js --cycle cycle-20260518-001 --by stage4-cleanup --reason "周期结束"
`);
}

// ============================================================
// 校验
// ============================================================
const VALID_BY = [
  'stage4-cleanup', 'trigger-fired', 'cycle-archived',
  'cycle-health-check', 'manual', 'lifetime-expired'
];

function validate(opts) {
  const modes = [opts.rule, opts.coin, opts.cycle, opts.all].filter(Boolean);
  if (modes.length === 0) {
    console.error('❌ 必须指定 --rule / --coin / --cycle / --all 之一');
    process.exit(1);
  }
  if (modes.length > 1) {
    console.error('❌ --rule / --coin / --cycle / --all 互斥，只能指定一个');
    process.exit(1);
  }
  if (!opts.by) {
    console.error('❌ 必须指定 --by（归档来源）');
    process.exit(1);
  }
  if (!VALID_BY.includes(opts.by)) {
    console.error(`❌ --by 非法值 "${opts.by}"，合法值: ${VALID_BY.join(', ')}`);
    process.exit(1);
  }
  if (!opts.reason) {
    console.error('❌ 必须指定 --reason（归档原因）');
    process.exit(1);
  }
  if (opts.all && !opts.confirm) {
    console.error('❌ --all 需要 --confirm 确认');
    process.exit(1);
  }
}

// ============================================================
// 日志
// ============================================================
function timestamp() {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return bj.toISOString().replace('T', ' ').substring(0, 19);
}

function log(msg) {
  const line = `[${timestamp()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

// ============================================================
// 规则匹配
// ============================================================
function findRules(opts) {
  const allFiles = fs.readdirSync(RULES_DIR).filter(f => f.endsWith('.js'));

  if (opts.rule) {
    const match = allFiles.find(f => f === opts.rule);
    if (!match) {
      console.error(`❌ 规则 "${opts.rule}" 不存在`);
      process.exit(1);
    }
    return [match];
  }

  if (opts.coin) {
    const coin = opts.coin.toUpperCase();
    const matches = allFiles.filter(f => {
      // 山寨: {COIN}-xxx.js
      if (f.startsWith(`${coin}-`)) return true;
      // BTC: YYYY-MM-DD-btc-xxx.js 或 YYYY-MM-DD-xxx.js
      if (coin === 'BTC' && /^\d{4}-\d{2}-\d{2}/.test(f)) return true;
      return false;
    });
    if (matches.length === 0) {
      console.log(`⚠️  币种 ${coin} 无活跃规则`);
      process.exit(0);
    }
    return matches;
  }

  if (opts.cycle) {
    const cycleId = opts.cycle;
    const matches = [];
    for (const f of allFiles) {
      try {
        const content = fs.readFileSync(path.join(RULES_DIR, f), 'utf8');
        // 检查 cycleId 字段
        const re = new RegExp(`cycleId:\\s*['"]${escapeRegex(cycleId)}['"]`);
        if (re.test(content)) matches.push(f);
      } catch (_) {}
    }
    if (matches.length === 0) {
      console.log(`⚠️  周期 ${cycleId} 无匹配规则（可能无 cycleId 字段或周期不匹配）`);
      process.exit(0);
    }
    return matches;
  }

  if (opts.all) {
    return allFiles;
  }

  return [];
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================
// 更新规则元数据
// ============================================================
function updateMetadata(content, opts) {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const archiveTime = bj.toISOString().replace('Z', '+08:00').replace(/\.\d{3}/, '');
  const reasonLit = escapeReason(opts.reason);

  const hasArchiveFields = /archivedAt:/.test(content);

  if (hasArchiveFields) {
    // ── 新格式规则（有完整 C19 块）→ 原地替换 ──
    let modified = content;

    modified = modified.replace(
      /(status:\s*)['"]active['"]/,
      "$1'archived'"
    );
    modified = modified.replace(
      /(archivedAt:\s*)[^,\n]+/,
      `$1'${archiveTime}'`
    );
    modified = modified.replace(
      /(archivedBy:\s*)[^,\n]+/,
      `$1'${opts.by}'`
    );
    modified = modified.replace(
      /(archiveReason:\s*)[^,\n]+/,
      `$1${reasonLit}`
    );
    return modified;
  } else {
    // ── 旧格式规则（只有 ruleType + cycleId）→ 在 C19 END 前注入归档字段 ──
    const c19EndRe = /(\/\/\s*⭐\s*C19\s*END)/;
    if (!c19EndRe.test(content)) {
      // 完全没有 C19 块 — 在 name: 后注入完整归档状态
      return content.replace(
        /(  name:\s*['"][^'"]+['"],)/,
        `$1\n  status: 'archived',\n  archivedAt: '${archiveTime}',\n  archivedBy: '${opts.by}',\n  archiveReason: ${reasonLit},`
      );
    }

    // 有 C19 但不含归档字段 → 在 END 前插入
    // regex 不捕获前导空格，原空格保留在 $1 之前，故 inject 不加前导空格
    const inject = [
      `status: 'archived',`,
      `archivedAt: '${archiveTime}',`,
      `archivedBy: '${opts.by}',`,
      `archiveReason: ${reasonLit},`,
    ].join('\n');

    // 捕获整行（含前导空格），完整替换
    const fullLineRe = /(\s*\/\/\s*⭐\s*C19\s*END)/;
    return content.replace(fullLineRe, `${inject}\n$1`);
  }
}

function escapeReason(s) {
  return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

// ============================================================
// 归档单条规则
// ============================================================
function archiveOne(filename, opts) {
  const src = path.join(RULES_DIR, filename);
  const dst = path.join(ARCHIVE_DIR, filename);

  // 处理重名（加时间戳后缀）
  let dstFinal = dst;
  if (fs.existsSync(dst)) {
    const ts = Date.now();
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    dstFinal = path.join(ARCHIVE_DIR, `${base}-${ts}${ext}`);
  }

  try {
    const content = fs.readFileSync(src, 'utf8');

    // 检查是否已归档
    const alreadyArchived = content.match(/archivedAt:\s*['"][^'"]+['"]/);
    if (alreadyArchived && !opts.force) {
      return { file: filename, status: 'SKIPPED', reason: '已归档（archivedAt 非 null）' };
    }

    if (opts.dryRun) {
      return { file: filename, status: 'DRY_RUN', dst: dstFinal };
    }

    const updated = updateMetadata(content, opts);
    fs.writeFileSync(src, updated, 'utf8');
    fs.renameSync(src, dstFinal);

    return { file: filename, status: 'ARCHIVED', dst: path.basename(dstFinal) };
  } catch (err) {
    return { file: filename, status: 'ERROR', reason: err.message };
  }
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

  validate(opts);

  const mode = opts.rule ? `规则=${opts.rule}` :
               opts.coin ? `币种=${opts.coin}` :
               opts.cycle ? `周期=${opts.cycle}` : '全部';
  const dryTag = opts.dryRun ? '[DRY RUN] ' : '';

  log(`开始归档 | ${dryTag}${mode} | 来源=${opts.by} | 原因=${opts.reason}`);

  const files = findRules(opts);
  console.log(`\n${dryTag}匹配 ${files.length} 个规则:\n`);

  const results = [];
  for (const f of files) {
    const r = archiveOne(f, opts);
    results.push(r);
    const icon = r.status === 'ARCHIVED' ? '✅' :
                 r.status === 'SKIPPED' ? '⏭️ ' :
                 r.status === 'DRY_RUN' ? '🔍' : '❌';
    console.log(`  ${icon} ${r.file} → ${r.status === 'ARCHIVED' ? r.dst : r.reason || ''}`);
  }

  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;

  console.log(`\n===== ${dryTag}汇总 =====`);
  for (const [status, count] of Object.entries(counts)) {
    const label = status === 'ARCHIVED' ? '已归档' :
                  status === 'SKIPPED' ? '跳过' :
                  status === 'DRY_RUN' ? '待归档' :
                  status === 'ERROR' ? '失败' : status;
    console.log(`  ${label}: ${count}`);
  }

  log(`归档完成 | 已归档=${counts.ARCHIVED || 0} 跳过=${counts.SKIPPED || 0} 失败=${counts.ERROR || 0}`);
}

main();
