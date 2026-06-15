#!/usr/bin/env node
/**
 * position-monitor.js — 持仓全面审视定时任务
 *
 * 每 3 小时检查一次 OKX 实盘持仓。若有持仓，通过调度器
 * 派发 pro 优先级智能体执行全面审视。
 *
 * PM2 常驻进程。日志输出到 logs/position-monitor.log。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKSPACE = path.join(__dirname, '..');
const PROXY = path.join(WORKSPACE, 'scripts', 'okx-proxy.sh');
const DISPATCH = path.join(WORKSPACE, 'scripts', 'dispatch.js');
const LOG_FILE = path.join(WORKSPACE, 'logs', 'position-monitor.log');

const CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 小时

// ═══ 日志 ═══
// PM2 配置了 merge_logs + time=true，console.log 自动带时间戳捕获
function log(msg) {
  console.log(msg);
}

// ═══ 获取 OKX 实盘持仓 ═══
function getLivePositions() {
  try {
    const raw = execSync(
      `bash "${PROXY}" --profile live account positions --json`,
      { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '[]') return [];
    const all = JSON.parse(trimmed);
    return all.filter(p => parseFloat(p.pos) !== 0);
  } catch (e) {
    log(`OKX API 查询失败: ${e.message}`);
    return null; // null = 查询失败，区别于空持仓 []
  }
}

// ═══ 主循环 ═══
async function run() {
  const iterStart = new Date();
  log('══════════ 持仓审视轮次启动 ══════════');

  // 1. 获取实盘持仓
  const positions = getLivePositions();

  if (positions === null) {
    log('实盘持仓查询失败，跳过本轮');
    log('══════════ 持仓审视轮次结束 ══════════');
    return;
  }

  if (positions.length === 0) {
    log('当前无实盘持仓，跳过审视');
    log('══════════ 持仓审视轮次结束 ══════════');
    return;
  }

  log(`实盘持仓: ${positions.length} 个`);
  for (const p of positions) {
    log(`  ${p.instId} | ${p.posSide} | ${p.pos}张 | UPL=${p.upl || 0} | 杠杆=${p.lever}x | 入场=${p.avgPx}`);
  }

  // 2. 构造持仓摘要 JSON，供智能体使用
  const positionsSummary = positions.map(p => ({
    instId: p.instId,
    posSide: p.posSide,
    pos: p.pos,
    avgPx: p.avgPx,
    markPx: p.markPx,
    upl: p.upl,
    uplRatio: p.uplRatio,
    lever: p.lever,
    notionalUsd: p.notionalUsd,
    realizedPnl: p.realizedPnl,
  }));

  const summaryFile = path.join(WORKSPACE, 'data', 'position-monitor-cache.json');
  fs.mkdirSync(path.dirname(summaryFile), { recursive: true });

  // 2.5 获取组合风险快照（供审计智能体使用）
  let portfolioRisk = null;
  try {
    const exposureScript = path.join(WORKSPACE, 'scripts', 'calc-portfolio-exposure.js');
    const raw = execSync(`node "${exposureScript}"`, {
      encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    });
    const exposureResult = JSON.parse(raw);
    if (!exposureResult.error && exposureResult.portfolio) {
      portfolioRisk = {
        risk_score: exposureResult.portfolio.risk_score,
        risk_level: exposureResult.portfolio.risk_level,
        weighted_beta_abs: exposureResult.portfolio.weighted_beta_abs,
        weighted_beta: exposureResult.portfolio.weighted_beta,
        weighted_corr: exposureResult.portfolio.weighted_corr,
        clusters: (exposureResult.portfolio.clusters || []).map(c => ({
          coins: c.coins, effective_nav_pct: c.effective_nav_pct || c.nav_pct,
          avg_pairwise_corr: c.avg_pairwise_corr,
        })),
        stress_test: exposureResult.portfolio.stress_test,
        score_breakdown: exposureResult.portfolio.score_breakdown,
        warnings: exposureResult.portfolio.warnings || [],
      };
      log(`组合风险快照: ${portfolioRisk.risk_score}/100 [${portfolioRisk.risk_level}]`);
    }
  } catch (e) {
    log(`组合风险快照获取失败: ${e.message}`, 'WARN');
  }

  fs.writeFileSync(summaryFile, JSON.stringify({
    generated_at: new Date().toISOString(),
    audit_source: 'scheduled',
    position_count: positions.length,
    positions: positionsSummary,
    portfolio_risk: portfolioRisk,
  }, null, 2), 'utf8');
  log(`持仓快照已写入: ${summaryFile}` + (portfolioRisk ? ` (风险评分: ${portfolioRisk.risk_score})` : ''));

  // 3. 通过调度器派发智能体任务
  const jobName = `position-monitor-${Date.now()}`;
  const riskLine = portfolioRisk
    ? `\n组合风险: ${portfolioRisk.risk_score}/100 [${portfolioRisk.risk_level}] | absBeta=${portfolioRisk.weighted_beta_abs}`
    : '';
  const msg = [
    `📊 持仓全面审视任务`,
    ``,
    `实盘持仓数: ${positions.length}${riskLine}`,
    `持仓快照: data/position-monitor-cache.json`,
    ``,
    `请读取 tasks/position-monitor.md 执行全面审视。`,
    ``,
    `本轮迭代时间: ${iterStart.toISOString()}`,
    `下次审视: ~${new Date(iterStart.getTime() + CHECK_INTERVAL_MS).toISOString()}`,
  ].join('\n');

  const msgFile = `/tmp/${jobName}.txt`;
  fs.writeFileSync(msgFile, msg, 'utf8');

  try {
    const result = execSync(
      `node "${DISPATCH}" --priority "pro" --source "position-monitor" --name "${jobName}" --at "5s" --message-file "${msgFile}"`,
      { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    log(`调度器已提交: ${jobName} | ${result.trim().slice(0, 200)}`);
  } catch (e) {
    const stderr = e.stderr || '';
    if (stderr.includes('REJECTED')) {
      log(`调度器去重跳过（正常）: ${stderr.trim().slice(0, 200)}`);
    } else {
      log(`调度器提交失败: ${e.message}`);
    }
  }

  try { fs.unlinkSync(msgFile); } catch (_) {}

  log('══════════ 持仓审视轮次结束 ══════════');
}

// ═══ 启动 ═══
log('持仓审视进程启动 | 间隔=3h | 优先级=pro');
run(); // 首次立即执行
setInterval(run, CHECK_INTERVAL_MS);
log(`下次检查: ${new Date(Date.now() + CHECK_INTERVAL_MS).toISOString()}`);
