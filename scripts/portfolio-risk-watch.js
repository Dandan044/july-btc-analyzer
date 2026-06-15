#!/usr/bin/env node
/**
 * portfolio-risk-watch.js — 组合风险定时监控
 *
 * 由 cron 每小时触发。调 calc-portfolio-exposure.js 快照模式，
 * 当风险评分超过阈值时，通过调度器拉起仓位管理者执行风险导向审计。
 *
 * 防骚扰:
 *   - 首次超标 → 立即拉起
 *   - 风险恶化 (上次评分+5以上) 且距上次 > 2h → 拉起
 *   - 风险持平/下降或冷却期内 → 跳过
 *
 * 状态: data/portfolio-risk-state.json
 * 日志: logs/portfolio-risk-watch.log
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKSPACE = path.resolve(__dirname, '..');
const LOG_FILE = path.join(WORKSPACE, 'logs', 'portfolio-risk-watch.log');
const STATE_FILE = path.join(WORKSPACE, 'data', 'portfolio-risk-state.json');
const SETTINGS_FILE = path.join(WORKSPACE, 'data', 'dashboard-settings.json');
const DISPATCH = path.join(WORKSPACE, 'scripts', 'dispatch.js');
const EXPOSURE_SCRIPT = path.join(WORKSPACE, 'scripts', 'calc-portfolio-exposure.js');

// ═══ 默认阈值 ═══
const DEFAULT_THRESHOLD = 60;       // risk_score >= 60 (high 级) → 触发
const WORSEN_THRESHOLD = 5;        // 评分上升 >= 5 视为恶化
const COOLDOWN_MS = 2 * 3600000;   // 恶化冷却 2h
const MAX_INTERVAL_MS = 3 * 3600000; // 最大间隔 3h (持续超标也定期拉)

// ═══ 日志 ═══
function log(msg, level = 'INFO') {
  const ts = new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  const prefix = level === 'WARN' ? '⚠️' : (level === 'ERROR' ? '⛔' : '');
  const line = `[${ts}] [risk-watch] ${prefix} ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ═══ 读取配置 ═══
function readThreshold() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return parseInt(settings.portfolioRiskThreshold) || DEFAULT_THRESHOLD;
    }
  } catch (_) {}
  return DEFAULT_THRESHOLD;
}

// ═══ 读取/写入状态 ═══
function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {}
  return { last_triggered_at: null, last_risk_score: 0, last_risk_level: 'low', trigger_count: 0 };
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2) + '\n');
}

// ═══ 获取组合风险快照 ═══
function getPortfolioRisk() {
  try {
    const raw = execSync(`node "${EXPOSURE_SCRIPT}"`, {
      encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(raw);
    if (result.error) { log(`快照失败: ${result.error}`, 'ERROR'); return null; }
    // position_count 在顶层，portfolio 在嵌套层
    const portfolio = result.portfolio || null;
    if (portfolio) portfolio.position_count = result.position_count ?? 0;
    return portfolio;
  } catch (e) {
    log(`快照异常: ${e.message}`, 'ERROR');
    return null;
  }
}

// ═══ 派发审计任务 ═══
function dispatchAudit(riskData, reason) {
  // 先写入带风险数据的持仓缓存（audit_source=risk-alert）
  try {
    const PROXY = path.join(WORKSPACE, 'scripts', 'okx-proxy.sh');
    const raw = execSync(`bash "${PROXY}" --profile live account positions --json`, {
      encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const trimmed = raw.trim();
    const allPositions = (trimmed && trimmed !== '[]') ? JSON.parse(trimmed) : [];
    const livePositions = allPositions.filter(p => parseFloat(p.pos) !== 0);

    const positionsSummary = livePositions.map(p => ({
      instId: p.instId,
      posSide: p.posSide,
      pos: p.pos,
      avgPx: p.avgPx,
      markPx: p.markPx,
      upl: p.upl,
      uplRatio: p.uplRatio,
      lever: p.lever,
      notionalUsd: p.notionalUsd,
    }));

    const cacheFile = path.join(WORKSPACE, 'data', 'position-monitor-cache.json');
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({
      generated_at: new Date().toISOString(),
      audit_source: 'risk-alert',
      position_count: livePositions.length,
      positions: positionsSummary,
      portfolio_risk: {
        risk_score: riskData.risk_score,
        risk_level: riskData.risk_level,
        weighted_beta_abs: riskData.weighted_beta_abs,
        weighted_beta: riskData.weighted_beta,
        weighted_corr: riskData.weighted_corr,
        clusters: (riskData.clusters || []).map(c => ({
          coins: c.coins, effective_nav_pct: c.effective_nav_pct || c.nav_pct,
          avg_pairwise_corr: c.avg_pairwise_corr,
        })),
        stress_test: riskData.stress_test,
        score_breakdown: riskData._score_breakdown || riskData.score_breakdown,
        warnings: riskData.warnings || [],
      },
    }, null, 2), 'utf8');
    log(`风险缓存已写入: ${cacheFile} (${livePositions.length}仓, audit_source=risk-alert)`);
  } catch (e) {
    log(`风险缓存写入失败: ${e.message}`, 'WARN');
  }
  const message = [
    '持仓全面审视 — 风险触发',
    '',
    `触发原因: ${reason}`,
    `风险评分: ${riskData.risk_score}/100 [${riskData.risk_level}]`,
    `abs(Beta): ${riskData.weighted_beta_abs ?? 'N/A'}`,
    `压力测试最差: ${Object.values(riskData.stress_test || {}).reduce((max, s) => Math.max(max, Math.abs(s.est_pnl_pct || 0)), 0).toFixed(1)}%`,
  ];

  if (riskData.warnings && riskData.warnings.length > 0) {
    message.push('');
    message.push('当前告警:');
    for (const w of riskData.warnings) message.push(`  - ${w}`);
  }

  if (riskData._score_breakdown) {
    const sb = riskData._score_breakdown;
    message.push('');
    message.push(`评分明细: 方向${sb.directional} Beta幅度${sb.beta_mag} 集群${sb.cluster} 相关${sb.correlation} 压力${sb.stress_test}`);
  }

  try {
    const msgStr = message.join('\n').replace(/"/g, '\\"');
    const cmd = `node "${DISPATCH}" --priority pro --source risk-watch --name "position-monitor-risk" --at "30s" --message "${msgStr}"`;
    log(`派发审计: ${cmd.substring(0, 120)}...`);
    execSync(cmd, { encoding: 'utf8', timeout: 15000 });
    log('审计任务已派发');
    return true;
  } catch (e) {
    log(`派发失败: ${e.message}`, 'ERROR');
    return false;
  }
}

// ═══ 主流程 ═══
async function main() {
  log('══════════ 组合风险巡检 ══════════');

  // 1. 获取快照
  const risk = getPortfolioRisk();
  if (!risk) {
    log('无法获取组合风险，跳过本轮');
    return;
  }

  const totalNotional = risk.directional_exposure
    ? (risk.directional_exposure.long_pct + risk.directional_exposure.short_pct > 0 ? '有持仓' : '')
    : '';

  if (!risk.position_count || risk.position_count === 0) {
    log(`无持仓，退出`);
    writeState({ ...readState(), last_check_at: new Date().toISOString() });
    return;
  }

  log(`风险评分: ${risk.risk_score}/100 [${risk.risk_level}] | absBeta=${risk.weighted_beta_abs} | 仓位=${risk.position_count}`);

  // 2. 判断是否超阈值
  const threshold = readThreshold();
  if (risk.risk_score < threshold) {
    log(`风险评分 ${risk.risk_score} < 阈值 ${threshold}，无需拉起`);
    writeState({
      ...readState(),
      last_risk_score: risk.risk_score,
      last_risk_level: risk.risk_level,
      last_check_at: new Date().toISOString(),
    });
    return;
  }

  // 3. 风险超标 — 判断是否拉起
  const state = readState();
  const now = Date.now();
  const lastTrigger = state.last_triggered_at ? new Date(state.last_triggered_at).getTime() : 0;
  const elapsed = now - lastTrigger;
  const riskDelta = risk.risk_score - (state.last_risk_score || 0);
  const isWorsening = riskDelta >= WORSEN_THRESHOLD;
  const cooldownPassed = elapsed > COOLDOWN_MS || lastTrigger === 0;
  const maxIntervalPassed = elapsed > MAX_INTERVAL_MS;

  let shouldTrigger = false;
  let triggerReason = '';

  if (lastTrigger === 0) {
    shouldTrigger = true;
    triggerReason = `首次风险超标 (评分 ${risk.risk_score})`;
  } else if (isWorsening && cooldownPassed) {
    shouldTrigger = true;
    triggerReason = `风险恶化 (${state.last_risk_score}→${risk.risk_score}, +${riskDelta})`;
  } else if (maxIntervalPassed) {
    shouldTrigger = true;
    triggerReason = `持续超标超 ${Math.round(elapsed / 3600000)}h,定期重审`;
  }

  if (shouldTrigger) {
    log(`🔔 触发审计: ${triggerReason}`);
    const dispatched = dispatchAudit(risk, triggerReason);

    state.last_triggered_at = new Date().toISOString();
    state.last_risk_score = risk.risk_score;
    state.last_risk_level = risk.risk_level;
    state.trigger_count = (state.trigger_count || 0) + 1;
    state.last_trigger_reason = triggerReason;
    state.last_dispatched = dispatched;
    state.last_check_at = new Date().toISOString();
    writeState(state);
  } else {
    const remainCooldown = Math.round(Math.max(0, COOLDOWN_MS - elapsed) / 60000);
    log(`跳过: 风险${isWorsening ? '恶化但冷却中' : '未显著恶化'} (Δ${riskDelta >= 0 ? '+' : ''}${riskDelta}, 冷却剩余${remainCooldown}min, 距上次${Math.round(elapsed / 60000)}min)`);

    state.last_risk_score = risk.risk_score;
    state.last_risk_level = risk.risk_level;
    state.last_check_at = new Date().toISOString();
    writeState(state);
  }

  log('══════════ 巡检结束 ══════════');
}

main().catch(e => {
  log(`致命错误: ${e.message}`, 'ERROR');
  process.exit(1);
});
