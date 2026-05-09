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

# ---- 步骤1：提取昨天的日志 ----

# btc-alert.log 的日志行格式：
# PM2 前缀: "2026-05-03T01:03:49: [🔧警报引擎] ..."
# 或时间戳格式: "2026-05-03T01:03:49 ..."
# 提取以昨天日期开头的行

TEMP_EXTRACT=$(mktemp)
trap "rm -f '$TEMP_EXTRACT'" EXIT

# 匹配格式：YYYY-MM-DDTHH:MM:SS（PM2 time 格式）
grep "^${YESTERDAY}T" "$ALERT_LOG" > "$TEMP_EXTRACT" 2>/dev/null || true

EXTRACTED_LINES=$(wc -l < "$TEMP_EXTRACT" 2>/dev/null || echo 0)

if [ "$EXTRACTED_LINES" -eq 0 ]; then
    echo "目标日期($YESTERDAY)没有日志行，跳过提取"
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
fi

# ---- 步骤2：压缩超过14天的整周文件夹 ----

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
            
            # 在 history 目录下创建 tar.gz
            tar -czf "${HISTORY_DIR}/${week_name}.tar.gz" -C "$HISTORY_DIR" "$week_name"
            
            if [ $? -eq 0 ]; then
                rm -rf "$week_dir"
                echo "已压缩并删除原目录: $week_name → ${week_name}.tar.gz"
            else
                echo "压缩失败: $week_name，保留原目录"
            fi
        fi
    done
fi

# ---- 步骤3：删除超过30天的归档 ----

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
        fi
    done
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 日志归档完成"
