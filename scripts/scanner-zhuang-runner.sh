#!/usr/bin/env bash
#
# scanner-zhuang-runner.sh - 庄币扫描引擎 Runner
#
# 用法: bash scripts/scanner-zhuang-runner.sh
#
# 流程:
#   1. 执行 scanner-zhuang.py 扫描引擎（4h 极端涨跌幅）
#   2. 解析 JSON 输出
#   3. 命中币种 → openclaw cron add (one-shot, 10s后触发阶段一)
#   4. 未命中 → 正常退出
#
# 由 Linux crontab 触发: 建议在 alt-scanner 后 5 分钟错峰运行
#   5 * * * * /path/to/scanner-zhuang-runner.sh >> /dev/null 2>&1
#

set -euo pipefail

# 环境变量（crontab 环境缺少 PATH）
export PATH="$HOME/.npm-global/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

OPENCLAW="$(which openclaw 2>/dev/null || echo "$HOME/.npm-global/bin/openclaw")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(dirname "$SCRIPT_DIR")"

NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$NOW] ========== scanner-zhuang-runner 启动 =========="

# ─── 步骤 0: 检查扫描间隔 ───
SETTINGS_FILE="$WORKSPACE/data/dashboard-settings.json"
INTERVAL_MIN=60  # 默认 60 分钟
if [ -f "$SETTINGS_FILE" ]; then
  CONFIGURED=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('zhuangScannerIntervalMin',60))" "$SETTINGS_FILE" 2>/dev/null)
  if [ -n "$CONFIGURED" ] && [ "$CONFIGURED" -gt 0 ] 2>/dev/null; then
    INTERVAL_MIN=$CONFIGURED
  fi
fi

LAST_RUN_FILE="$WORKSPACE/data/last-zhuang-scanner-run.txt"
if [ -f "$LAST_RUN_FILE" ]; then
  LAST_RUN=$(cat "$LAST_RUN_FILE")
  LAST_EPOCH=$(date -d "$LAST_RUN" +%s 2>/dev/null || echo 0)
  NOW_EPOCH=$(date +%s)
  ELAPSED_MIN=$(( (NOW_EPOCH - LAST_EPOCH) / 60 ))
  if [ "$ELAPSED_MIN" -lt "$INTERVAL_MIN" ]; then
    echo "[$NOW] 距上次扫描 ${ELAPSED_MIN}min < ${INTERVAL_MIN}min，跳过本轮"
    echo "[$NOW] ========== scanner-zhuang-runner 结束（间隔跳过）=========="
    exit 0
  fi
fi
echo "[$NOW] 扫描间隔: ${INTERVAL_MIN}min"

# ─── 步骤 1: 执行扫描脚本 ───
echo "[$NOW] 执行 scanner-zhuang.py (4h 极端涨跌幅扫描)..."
OUTPUT=$(python3 "$SCRIPT_DIR/scanner-zhuang.py" 2>&1)

# 打印脚本输出到 stdout(会进入 crontab 日志)
echo "$OUTPUT"

# ─── 步骤 2: 提取 JSON 输出 ───
JSON_LINE=$(echo "$OUTPUT" | grep '__JSON_OUTPUT__' -A1 | tail -1)

if [ -z "$JSON_LINE" ]; then
    echo "[$NOW] ⚠️  警告: 未找到 JSON 输出行"
    exit 1
fi

RESULT=$(echo "$JSON_LINE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',''))" 2>/dev/null)

if [ -z "$RESULT" ]; then
    echo "[$NOW] ⚠️  警告: JSON 解析失败"
    exit 1
fi

echo "[$NOW] 扫描结果: $RESULT"

# ─── 步骤 3: 命中 → 创建 cron job ───
if [ "$RESULT" != "hit" ]; then
    echo "[$NOW] 未命中庄币,正常退出"
    date -u '+%Y-%m-%dT%H:%M:%SZ' > "$LAST_RUN_FILE"
    echo "[$NOW] ========== scanner-zhuang-runner 结束 =========="
    exit 0
fi

# 解析命中的币种
COIN=$(echo "$JSON_LINE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('coin',''))" 2>/dev/null)

if [ -z "$COIN" ]; then
    echo "[$NOW] ⛔ ERROR: 命中但无法解析币种"
    exit 1
fi

CHANGE_PCT=$(echo "$JSON_LINE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('change_pct',0))" 2>/dev/null)
OI_PCT=$(echo "$JSON_LINE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('oi_change_pct',0))" 2>/dev/null)

echo "[$NOW] ✅ 命中庄币: $COIN (4h涨跌幅: ${CHANGE_PCT}%, OI: ${OI_PCT}%)"
echo "[$NOW] 执行阶段一预处理（上线检查 → 周期创建 → 持仓同步 → 合约数据 → 历史报告）..."

# ─── 步骤 4: 执行 stage1-prep.js（复用普通山寨的） ───
PREP_OUTPUT=$(node "$SCRIPT_DIR/stage1-prep.js" "$COIN" --mode zhuang 2>&1)

# 打印 prep 日志（stderr 行）
echo "$PREP_OUTPUT" | grep -v '^__PREP_OUTPUT__$' | grep -v '^{' || true

# 解析 prep JSON（最后一行）
PREP_JSON=$(echo "$PREP_OUTPUT" | grep '^{' | tail -1)

if [ -z "$PREP_JSON" ]; then
    echo "[$NOW] ⛔ ERROR: prep 脚本无 JSON 输出"
    exit 1
fi

PREP_STATUS=$(echo "$PREP_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)

case "$PREP_STATUS" in
    blacklisted)
        REASON=$(echo "$PREP_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason',''))" 2>/dev/null)
        echo "[$NOW] 🔴 BLACKLIST: $COIN — $REASON"
        echo "[$NOW] ========== scanner-zhuang-runner 结束（黑名单）=========="
        exit 0
        ;;
    error)
        REASON=$(echo "$PREP_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason',''))" 2>/dev/null)
        echo "[$NOW] ⛔ ERROR: prep 失败 — $REASON"
        echo "[$NOW] ========== scanner-zhuang-runner 结束（错误）=========="
        exit 1
        ;;
    success)
        echo "[$NOW] 预处理成功"
        ;;
    *)
        echo "[$NOW] ⛔ ERROR: prep 状态异常: $PREP_STATUS"
        exit 1
        ;;
esac

# 提取周期目录
CYCLE_DIR=$(echo "$PREP_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cycle_dir',''))" 2>/dev/null)
POS_COUNT=$(echo "$PREP_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('positions_count',0))" 2>/dev/null)

if [ -z "$CYCLE_DIR" ]; then
    echo "[$NOW] ⛔ ERROR: 无法获取周期目录"
    exit 1
fi

echo "[$NOW] 周期: active/$CYCLE_DIR | 持仓: $POS_COUNT"
echo "[$NOW] 创建 one-shot cron job（LLM 执行 sentiment + 阶段二）..."

# ─── 步骤 5: openclaw cron add（sentiment + manifest + stage2） ───
JOB_NAME="zhuang-sentiment-${COIN}-$(date +%s)"

"$OPENCLAW" cron add \
    --name "$JOB_NAME" \
    --at "10s" \
    --agent july \
    --message "币种: ${COIN}
周期目录: active/${CYCLE_DIR}
持仓数: ${POS_COUNT}
合约数据: OK
4h涨跌幅: ${CHANGE_PCT}%
OI变化: ${OI_PCT}%

预处理已完成（上线检查→周期创建→持仓同步→合约数据→历史报告路径）。
请读取 tasks/zhuang-pipeline/zhuang-intel-stage1-v2.md 执行消息面和链上数据收集。
完成后运行数据清单脚本，然后读取 tasks/zhuang-pipeline/zhuang-intel-stage2.md 进入阶段二（庄币分析）。" \
    --session isolated \
    --delete-after-run \
    --no-deliver

echo "[$NOW] cron job 已创建: $JOB_NAME"
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$LAST_RUN_FILE"
echo "[$NOW] ========== scanner-zhuang-runner 结束 =========="
