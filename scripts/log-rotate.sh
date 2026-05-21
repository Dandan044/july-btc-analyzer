#!/bin/bash
# ============================================================
# btc-alert 日志按日期归档脚本
#
# 归档策略：
#   - 每天凌晨执行，提取 btc-alert.log 中"昨天"的日志
#   - 移入 alert-history/YYYY-WXX/YYYY-MM-DD.log（7天内不压缩）
#   - 超过14天的整周文件夹压缩为 .tar.gz
#   - 超过30天的归档删除
#
# 目录结构：
#   logs/
#   ├── btc-alert.log                    ← 当前活跃日志
#   └── alert-history/
#       ├── 2026-W19/                    ← 本周（未压缩）
#       │   ├── 2026-05-05.log
#       │   └── 2026-05-06.log
#       ├── 2026-W18.tar.gz              ← 上周（已压缩）
#       └── ...
# ============================================================

set -euo pipefail

# ---- 参数处理 ----
# 支持指定日期参数：./log-rotate.sh 2026-05-07
# 不指定则默认处理昨天的日志
if [ $# -ge 1 ]; then
    TARGET_DATE="$1"
else
    TARGET_DATE=$(date -d "yesterday" +"%Y-%m-%d")
fi

# ---- 配置 ----
LOGS_DIR="$(cd "$(dirname "$0")/.." && pwd)/logs"
ALERT_LOG="$LOGS_DIR/btc-alert.log"
HISTORY_DIR="$LOGS_DIR/alert-history"
RETENTION_DAYS=30
COMPRESS_AGE_DAYS=14
SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---- 通知配置 ----
# QQ 目标：主人的 QQ 私聊
QQ_TARGET="qqbot:c2c:3264012CFFDCF2666417B4D4ABACEFFF"

# ---- 结果收集 ----
# 存储各阶段统计数据，最后用于通知
LOG_PHASE_RESULT=""
DATA_PHASE_RESULT=""
RULES_PHASE_RESULT=""
SUMMARY_PARTS=""

# ---- 工具函数 ----

# 获取 ISO 周号（格式：YYYY-WXX）
get_iso_week() {
    local date_str="$1"
    date -d "$date_str" +"%G-W%V"
}

# 获取昨天的日期（YYYY-MM-DD）
get_yesterday() {
    date -d "yesterday" +"%Y-%m-%d"
}

# 计算两个日期之间的天数差
days_between() {
    local d1="$1"
    local d2="$2"
    local ts1 ts2
    ts1=$(date -d "$d1" +%s)
    ts2=$(date -d "$d2" +%s)
    echo $(( (ts1 - ts2) / 86400 ))
}

# 将阶段输出转化为一行摘要
summarize_phase_output() {
    local output="$1"
    local phase_name="$2"
    local summary=""

    # 提取关键指标
    local lines=$(echo "$output" | grep -oP '提取到 \K[0-9]+' | tail -1) || true
    local moved_data=$(echo "$output" | grep -oP '已移动: \K[0-9]+' | tail -1) || true
    local skipped_data=$(echo "$output" | grep -oP '保留: \K[0-9]+' | tail -1) || true
    local compressed_data=$(echo "$output" | grep -oP '已压缩: \K[0-9]+' | tail -1) || true
    local moved_rules=$(echo "$output" | grep -oP '已移动: \K[0-9]+' | head -1) || true
    local skipped_rules=$(echo "$output" | grep -oP '保留: \K[0-9]+' | head -1) || true

    # 检查是否有压缩操作
    local compressed_dirs=$(echo "$output" | grep -c "已完成:.*→" || true)

    case "$phase_name" in
        "log")
            if [ -n "$lines" ] && [ "$lines" -gt 0 ]; then
                summary="📄 日志: 提取 ${lines} 行"
            else
                summary="📄 日志: 无新数据"  
            fi
            if echo "$output" | grep -q "压缩"; then
                summary+=", 压缩 $(echo "$output" | grep -c "已压缩") 个周目录"
            fi
            if echo "$output" | grep -q "删除过期"; then
                summary+=", 删除 $(echo "$output" | grep -c "删除过期") 个过期归档"
            fi
            LOG_PHASE_RESULT="$summary"
            ;;
        "data")
            if [ -n "$moved_data" ] && [ "$moved_data" -gt 0 ]; then
                summary="📊 数据: 归档 ${moved_data} 个文件"
            else
                summary="📊 数据: 无需归档"  
            fi
            if [ -n "$compressed_data" ] && [ "$compressed_data" -gt 0 ]; then
                summary+=", 压缩 ${compressed_data} 个周目录"
            fi
            DATA_PHASE_RESULT="$summary"
            ;;
        "rules")
            if [ -n "$moved_rules" ] && [ "$moved_rules" -gt 0 ]; then
                summary="📋 规则: 归档 ${moved_rules} 个文件"
            else
                summary="📋 规则: 无需归档"
            fi
            if [ -n "$compressed_data" ] && [ "$compressed_data" -gt 0 ]; then
                summary+=", 压缩 ${compressed_data} 个周目录"
            fi
            RULES_PHASE_RESULT="$summary"
            ;;
        *)
            ;;
    esac
}

# ---- 主流程 ----

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 日志归档开始"

# 检查日志文件是否存在
if [ ! -f "$ALERT_LOG" ]; then
    echo "日志文件不存在: $ALERT_LOG，跳过"
    exit 0
fi

# 检查日志文件是否为空
if [ ! -s "$ALERT_LOG" ]; then
    echo "日志文件为空，跳过"
    exit 0
fi

YESTERDAY="$TARGET_DATE"
WEEK_DIR=$(get_iso_week "$YESTERDAY")

echo "目标日期: $YESTERDAY"
echo "归档周目录: $WEEK_DIR"

# ---- 阶段1：提取昨天的日志 ----

# btc-alert.log 的日志行格式：
# PM2 前缀: "2026-05-03T01:03:49: [🔧警报引擎] ..."
# 或时间戳格式: "2026-05-03T01:03:49 ..."
# 提取以昨天日期开头的行

TEMP_EXTRACT=$(mktemp)
trap "rm -f '$TEMP_EXTRACT'" EXIT

# 匹配格式：YYYY-MM-DDTHH:MM:SS（PM2 time 格式）
grep "^${YESTERDAY}T" "$ALERT_LOG" > "$TEMP_EXTRACT" 2>/dev/null || true

EXTRACTED_LINES=$(wc -l < "$TEMP_EXTRACT" 2>/dev/null || echo 0)

LOG_COMPRESSED_COUNT=0
LOG_DELETED_COUNT=0

if [ "$EXTRACTED_LINES" -eq 0 ]; then
    echo "目标日期($YESTERDAY)没有日志行，跳过提取"
    LOG_PHASE_RESULT="📄 日志: 无新数据"
else
    echo "提取到 ${EXTRACTED_LINES} 行 ${YESTERDAY} 的日志"
    
    # 创建归档目录
    TARGET_DIR="$HISTORY_DIR/$WEEK_DIR"
    mkdir -p "$TARGET_DIR"
    
    # 写入归档文件（追加模式，防止同一天重复执行）
    TARGET_FILE="$TARGET_DIR/${YESTERDAY}.log"
    cat "$TEMP_EXTRACT" >> "$TARGET_FILE"
    echo "已归档到: $TARGET_FILE"
    
    # 从原日志中删除已提取的行（使用临时文件方式，保持 PM2 fd 不受影响）
    # 策略：创建不含昨天日志的新文件，然后覆盖原文件内容
    grep -v "^${YESTERDAY}T" "$ALERT_LOG" > "${ALERT_LOG}.tmp"
    cat "${ALERT_LOG}.tmp" > "$ALERT_LOG"
    rm -f "${ALERT_LOG}.tmp"
    echo "已从原日志中移除 ${YESTERDAY} 的日志行"
    
    LOG_PHASE_RESULT="📄 日志: 提取 ${EXTRACTED_LINES} 行"
fi

# ---- 阶段2：压缩超过14天的整周文件夹 ----

TODAY=$(date +"%Y-%m-%d")

if [ -d "$HISTORY_DIR" ]; then
    for week_dir in "$HISTORY_DIR"/*/; do
        [ -d "$week_dir" ] || continue
        
        week_name=$(basename "$week_dir")
        
        # 跳过已经是压缩文件的
        [[ "$week_name" == *.tar.gz ]] && continue
        
        # 从周目录名解析日期范围（YYYY-WXX → 取该周周四的日期作为参考）
        # 格式：2026-W19 → 用 date 解析
        week_date_str="${week_name%-W*}-W${week_name#*-W}"  # 保持原样
        
        # 计算该周最后一天（周日）的日期
        # ISO 周：周一=1, 周日=7
        # 用该周的周四来确定具体日期
        week_thursday=$(date -d "${week_name}-4" +"%Y-%m-%d" 2>/dev/null) || continue
        week_sunday=$(date -d "${week_thursday} +3 days" +"%Y-%m-%d" 2>/dev/null) || continue
        
        # 计算该周周日到今天的天数差
        age_days=$(days_between "$TODAY" "$week_sunday")
        
        if [ "$age_days" -ge "$COMPRESS_AGE_DAYS" ]; then
            echo "压缩周目录: $week_name (最后一天 $week_sunday, ${age_days}天前)"
            ((LOG_COMPRESSED_COUNT++)) || true
            
            # 在 history 目录下创建 tar.gz
            tar -czf "${HISTORY_DIR}/${week_name}.tar.gz" -C "$HISTORY_DIR" "$week_name"
            
            if [ $? -eq 0 ]; then
                rm -rf "$week_dir"
                echo "已压缩并删除原目录: $week_name → ${week_name}.tar.gz"
            else
                echo "压缩失败: $week_name，保留原目录"
                ((LOG_COMPRESSED_COUNT--)) || true
            fi
        fi
    done
fi

# ---- 阶段3：删除超过30天的归档 ----

if [ -d "$HISTORY_DIR" ]; then
    for archive_file in "$HISTORY_DIR"/*.tar.gz; do
        [ -f "$archive_file" ] || continue
        
        archive_name=$(basename "$archive_file" .tar.gz)
        
        # 解析周目录名获取日期
        week_thursday=$(date -d "${archive_name}-4" +"%Y-%m-%d" 2>/dev/null) || continue
        week_sunday=$(date -d "${week_thursday} +3 days" +"%Y-%m-%d" 2>/dev/null) || continue
        
        age_days=$(days_between "$TODAY" "$week_sunday")
        
        if [ "$age_days" -ge "$RETENTION_DAYS" ]; then
            echo "删除过期归档: $archive_name (最后一天 $week_sunday, ${age_days}天前)"
            rm -f "$archive_file"
            ((LOG_DELETED_COUNT++)) || true
        fi
    done
fi

# 完善日志阶段结果
if [ "$LOG_COMPRESSED_COUNT" -gt 0 ]; then
    LOG_PHASE_RESULT+=", 压缩 ${LOG_COMPRESSED_COUNT} 个周目录"
fi
if [ "$LOG_DELETED_COUNT" -gt 0 ]; then
    LOG_PHASE_RESULT+=", 删除 ${LOG_DELETED_COUNT} 个过期归档"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 日志归档完成"

# ---- 阶段4：数据归档（同步执行） ----
DATA_ARCHIVE_SCRIPT="$SCRIPTS_DIR/data-archive.sh"
DATA_PHASE_OUTPUT=$(mktemp)
export TODAY TARGET_DATE

if [ -x "$DATA_ARCHIVE_SCRIPT" ]; then
    echo ""
    # 捕获输出用于统计（不中断执行，即使失败也要继续）
    set +e
    "$DATA_ARCHIVE_SCRIPT" 2>&1 | tee "$DATA_PHASE_OUTPUT"
    DATA_EXIT_CODE=$?
    set -e
    
    if [ $DATA_EXIT_CODE -ne 0 ]; then
        echo "[WARN] 数据归档返回非零退出码: $DATA_EXIT_CODE"
        DATA_PHASE_RESULT="⚠️ 数据归档: 异常 (exit=$DATA_EXIT_CODE)"
    else
        summarize_phase_output "$(cat "$DATA_PHASE_OUTPUT")" "data"
    fi
    rm -f "$DATA_PHASE_OUTPUT"
else
    echo "[WARN] 数据归档脚本不可执行: $DATA_ARCHIVE_SCRIPT"
    DATA_PHASE_RESULT="⚠️ 数据: 脚本不可用"
fi

# ---- 阶段5：规则归档（同步执行） ----
RULES_ARCHIVE_SCRIPT="$SCRIPTS_DIR/rules-archive.sh"
RULES_PHASE_OUTPUT=$(mktemp)

if [ -x "$RULES_ARCHIVE_SCRIPT" ]; then
    echo ""
    set +e
    "$RULES_ARCHIVE_SCRIPT" 2>&1 | tee "$RULES_PHASE_OUTPUT"
    RULES_EXIT_CODE=$?
    set -e
    
    if [ $RULES_EXIT_CODE -ne 0 ]; then
        echo "[WARN] 规则归档返回非零退出码: $RULES_EXIT_CODE"
        RULES_PHASE_RESULT="⚠️ 规则归档: 异常 (exit=$RULES_EXIT_CODE)"
    else
        summarize_phase_output "$(cat "$RULES_PHASE_OUTPUT")" "rules"
    fi
    rm -f "$RULES_PHASE_OUTPUT"
else
    echo "[WARN] 规则归档脚本不可执行: $RULES_ARCHIVE_SCRIPT"
    RULES_PHASE_RESULT="⚠️ 规则: 脚本不可用"
fi

# ============================================================
# 通知：通过十四月向主人发送执行结果
# ============================================================

# 构建通知消息
NOTIFY_MSG="=== 每日归档报告 ($TARGET_DATE) ===

${LOG_PHASE_RESULT:-📄 日志: 未执行}
${DATA_PHASE_RESULT:-📊 数据: 未执行}
${RULES_PHASE_RESULT:-📋 规则: 未执行}

归档时间: $(date '+%Y-%m-%d %H:%M:%S')"

echo ""
echo "===== 通知消息 ====="
echo "$NOTIFY_MSG"
echo "===================="

# 检查 openclaw CLI 是否可用
# openclaw CLI 路径（cron 环境 PATH 不含 npm-global，需硬编码）
OPENCLAW_CLI="/home/administrator/.npm-global/bin/openclaw"
if [ -x "$OPENCLAW_CLI" ]; then
    echo ""
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 发送通知..."
    
    # 创建一次性 cron 任务：让十四月通过 QQ 发送报告
    # 使用 --at +15s 延迟 15 秒，确保任务创建完成后再执行
    set +e
    "$OPENCLAW_CLI" cron add \
        --agent shisiyue \
        --no-deliver \
        --delete-after-run \
        --name "archive-notify-${TARGET_DATE}" \
        --description "每日归档通知：${TARGET_DATE}" \
        --at "15s" \
        --timeout-seconds 120 \
        --message "请使用 message 工具通过 QQ 向主人(目标: ${QQ_TARGET})发送以下每日归档执行结果。消息格式保持原样，不要添加额外解释：

${NOTIFY_MSG}" 2>&1
    
    NOTIFY_EXIT_CODE=$?
    set -e
    
    if [ $NOTIFY_EXIT_CODE -eq 0 ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ 通知任务已创建"
    else
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ 通知任务创建失败 (exit=$NOTIFY_EXIT_CODE)"
    fi
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️ openclaw CLI 不可用，跳过通知"
fi

echo ""
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 全部归档任务完成"
