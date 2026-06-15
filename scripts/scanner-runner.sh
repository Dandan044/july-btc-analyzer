#!/usr/bin/env bash
#
# scanner-runner.sh - 统一山寨币扫描引擎 Runner（alt / zhuang 双画像）
#
# 用法: bash scripts/scanner-runner.sh --profile alt|zhuang
#
# 流程:
#   1. 执行 scanner-full.py --profile <PROFILE> 扫描引擎
#   2. 解析 JSON 输出
#   3. 命中币种 → stage1-prep.js → dispatch.js 派发 LLM 阶段一
#   4. 未命中 → 正常退出
#
# Crontab:
#   */30 * * * * scanner-runner.sh --profile alt    >> logs/scanner-cron.log 2>&1
#   5 * * * *    scanner-runner.sh --profile zhuang >> logs/zhuang-scanner-cron.log 2>&1
#

set -euo pipefail

# ─── 参数解析 ───
PROFILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

if [ -z "$PROFILE" ] || [ "$PROFILE" != "alt" ] && [ "$PROFILE" != "zhuang" ]; then
  echo "用法: $0 --profile alt|zhuang"
  exit 1
fi

# 环境变量（crontab 环境缺少 PATH）
export PATH="$HOME/.npm-global/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(dirname "$SCRIPT_DIR")"

NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$NOW] ========== scanner-runner 启动 | profile=$PROFILE =========="

# ─── Profile 差异化配置 ───
case "$PROFILE" in
  alt)
    LAST_RUN_FILE="$WORKSPACE/data/last-scanner-run.txt"
    INTERVAL_KEY="scannerIntervalMin"
    DEFAULT_INTERVAL=15
    PREP_MODE="alt"
    JOB_PREFIX="alt-sentiment"
    TASK_FILE="tasks/pipeline/stage1.md"
    STAGE2_FILE="tasks/pipeline/stage2-alt.md"
    CHANGE_LABEL="涨跌幅"
    ;;
  zhuang)
    LAST_RUN_FILE="$WORKSPACE/data/last-zhuang-scanner-run.txt"
    INTERVAL_KEY="zhuangScannerIntervalMin"
    DEFAULT_INTERVAL=60
    PREP_MODE="zhuang"
    JOB_PREFIX="zhuang-sentiment"
    TASK_FILE="tasks/pipeline/stage1.md"
    STAGE2_FILE="tasks/pipeline/stage2-zhuang.md"
    CHANGE_LABEL="24h涨跌幅"
    ;;
esac

# ─── 步骤 0: 检查扫描间隔 ───
SETTINGS_FILE="$WORKSPACE/data/dashboard-settings.json"
INTERVAL_MIN=$DEFAULT_INTERVAL
if [ -f "$SETTINGS_FILE" ]; then
  CONFIGURED=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('${INTERVAL_KEY}',${DEFAULT_INTERVAL}))" "$SETTINGS_FILE" 2>/dev/null)
  if [ -n "$CONFIGURED" ] && [ "$CONFIGURED" -gt 0 ] 2>/dev/null; then
    INTERVAL_MIN=$CONFIGURED
  fi
fi

if [ -f "$LAST_RUN_FILE" ]; then
  LAST_RUN=$(cat "$LAST_RUN_FILE")
  LAST_EPOCH=$(date -d "$LAST_RUN" +%s 2>/dev/null || echo 0)
  NOW_EPOCH=$(date +%s)
  ELAPSED_MIN=$(( (NOW_EPOCH - LAST_EPOCH) / 60 ))
  if [ "$ELAPSED_MIN" -lt "$((INTERVAL_MIN - 1))" ]; then
    echo "[$NOW] 距上次扫描 ${ELAPSED_MIN}min < ${INTERVAL_MIN}min，跳过本轮"
    echo "[$NOW] ========== scanner-runner 结束（间隔跳过）=========="
    exit 0
  fi
fi
echo "[$NOW] 扫描间隔: ${INTERVAL_MIN}min"

# ─── 步骤 1: 执行扫描脚本 ───
echo "[$NOW] 执行 scanner-full.py --profile $PROFILE ..."
OUTPUT=$(python3 "$SCRIPT_DIR/scanner-full.py" --profile "$PROFILE" 2>&1)

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

# ─── 步骤 3: 命中 → 派发 ───
if [ "$RESULT" != "hit" ]; then
    echo "[$NOW] 未命中币种,正常退出"
    date -u '+%Y-%m-%dT%H:%M:%SZ' > "$LAST_RUN_FILE"
    echo "[$NOW] ========== scanner-runner 结束 =========="
    exit 0
fi

# 解析命中的币种
COIN=$(echo "$JSON_LINE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('coin',''))" 2>/dev/null)
CHANGE_PCT=$(echo "$JSON_LINE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('change_pct',0))" 2>/dev/null)
OI_PCT=$(echo "$JSON_LINE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('oi_change_pct',0))" 2>/dev/null)

if [ -z "$COIN" ]; then
    echo "[$NOW] ⛔ ERROR: 命中但无法解析币种"
    exit 1
fi

echo "[$NOW] ✅ 命中币种: $COIN (${CHANGE_LABEL}: ${CHANGE_PCT}%, OI: ${OI_PCT}%)"
echo "[$NOW] 执行阶段一预处理（上线检查 → 周期创建 → 持仓同步 → 合约数据 → 历史报告）..."

# ─── 步骤 4: 执行 stage1-prep.js ───
PREP_OUTPUT=$(node "$SCRIPT_DIR/stage1-prep.js" "$COIN" --mode "$PREP_MODE" 2>&1)

echo "$PREP_OUTPUT" | grep -v '^__PREP_OUTPUT__$' | grep -v '^{' || true

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
        echo "[$NOW] ========== scanner-runner 结束（黑名单）=========="
        exit 0
        ;;
    error)
        REASON=$(echo "$PREP_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reason',''))" 2>/dev/null)
        echo "[$NOW] ⛔ ERROR: prep 失败 — $REASON"
        echo "[$NOW] ========== scanner-runner 结束（错误）=========="
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

CYCLE_DIR=$(echo "$PREP_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cycle_dir',''))" 2>/dev/null)
POS_COUNT=$(echo "$PREP_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('positions_count',0))" 2>/dev/null)

if [ -z "$CYCLE_DIR" ]; then
    echo "[$NOW] ⛔ ERROR: 无法获取周期目录"
    exit 1
fi

echo "[$NOW] 周期: active/$CYCLE_DIR | 持仓: $POS_COUNT"
echo "[$NOW] 创建 one-shot cron job（LLM 执行 sentiment）..."

# ─── 步骤 4.5: 组装阶段二任务文件 ───
echo "[$NOW] 组装阶段二任务文件..."
node "$SCRIPT_DIR/assemble-stage2.js" --profile "$PROFILE" --write 2>&1

# ─── 步骤 5: 通过调度器派发 LLM 阶段一 ───
JOB_NAME="${JOB_PREFIX}-${COIN}-$(date +%s)"
MSG="币种: ${COIN}
周期目录: active/${CYCLE_DIR}
持仓数: ${POS_COUNT}
合约数据: OK
画像: ${PROFILE}
${CHANGE_LABEL}: ${CHANGE_PCT}%
OI变化: ${OI_PCT}%

预处理已完成（上线检查→周期创建→持仓同步→合约数据→历史报告路径）。
请读取 ${TASK_FILE} 执行消息面和链上数据收集。
完成后运行数据清单脚本，然后读取 ${STAGE2_FILE} 进入阶段二。"

MSG_FILE="/tmp/dispatch-msg-${JOB_NAME}.txt"
echo "$MSG" > "$MSG_FILE"

node "$SCRIPT_DIR/dispatch.js" \
    --priority "high-1" \
    --source "scanner" \
    --coin "$COIN" \
    --name "$JOB_NAME" \
    --at "10s" \
    --message-file "$MSG_FILE"

rm -f "$MSG_FILE"
echo "[$NOW] 调度器已提交: $JOB_NAME"
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$LAST_RUN_FILE"
echo "[$NOW] ========== scanner-runner 结束 =========="
