#!/usr/bin/env bash
# ============================================================================
# init-cron-tasks.sh
# 创建七月核心循环 cron 任务（四个初始任务）
# 使用默认模型，参数与当前生产一致
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="$(cd "$SCRIPT_DIR/.." && pwd)"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
err() { log "❌ $*" >&2; }

# ── 1. BTC 早间日报 ── 09:00 ──────────────────────────────────────────
log "创建 BTC 早间日报 (09:00)..."
openclaw cron add \
  --agent july \
  --name "july-btc-morning-v2" \
  --cron "0 9 * * *" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --no-deliver \
  --timeout-seconds 1800 \
  --message "开始执行日报任务。请按顺序执行日报全四阶段：
1. 读取 tasks/daily-report-stage1.md 执行数据获取
2. 读取 tasks/daily-report-stage2.md 执行技术分析
3. 读取 tasks/daily-report-stage3.md 执行仓位管理
4. 读取 tasks/daily-report-stage4.md 执行警报管理
每个阶段完成后自动进入下一阶段，最终输出全流程摘要。" \
  --json

# ── 2. BTC 晚间日报 ── 21:00 ──────────────────────────────────────────
log "创建 BTC 晚间日报 (21:00)..."
openclaw cron add \
  --agent july \
  --name "july-btc-evening-v2" \
  --cron "0 21 * * *" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --no-deliver \
  --timeout-seconds 1800 \
  --message "开始执行日报任务。请按顺序执行日报全四阶段：
1. 读取 tasks/daily-report-stage1.md 执行数据获取
2. 读取 tasks/daily-report-stage2.md 执行技术分析
3. 读取 tasks/daily-report-stage3.md 执行仓位管理
4. 读取 tasks/daily-report-stage4.md 执行警报管理
每个阶段完成后自动进入下一阶段，最终输出全流程摘要。" \
  --json

# ── 3. 周期健康检查 ── 03:00 ──────────────────────────────────────────
log "创建周期健康检查 (03:00)..."
openclaw cron add \
  --agent july \
  --name "cycle-health-check" \
  --cron "0 3 * * *" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --no-deliver \
  --message "请读取 tasks/cycle-health-check.md 执行周期健康检查任务。

按步骤完成：
1. 扫描 active/ 目录下所有活跃周期
2. 识别静默超过24小时的周期
3. 对每个静默周期执行三维诊断（警报规则+币种数据+实盘持仓）
4. 生成报告保存到 cycle-health/YYYY-MM-DD-cycle-health.md
5. 如有持仓无监控的高风险静默，通知十四月" \
  --json

# ── 4. 市场快报 ── 22:30 / 06:30 / 14:30 ─────────────────────────────
log "创建市场快报 (22:30/06:30/14:30)..."
openclaw cron add \
  --agent july \
  --name "market-brief" \
  --cron "30 22,6,14 * * *" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --no-deliver \
  --timeout-seconds 300 \
  --message "根据 tasks/market-brief.md 生成市场快报。先运行 bash scripts/market-brief-collect.sh 采集数据，再 web_search 获取新闻，最后生成 Markdown 报告和 JSON。" \
  --json

log "✅ 四个循环 cron 任务已创建完毕"
log "检查: openclaw cron list --agent july"
