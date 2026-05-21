#!/bin/bash
# ============================================================
# data/ 数据按日期+币种归档脚本
#
# 归档策略：
#   - 每天凌晨执行（与 log-rotate 同步）
#   - 按币种 → 周 两级目录归档
#   - 7天内的文件保留在 data/ 原处
#   - 超过14天的周目录压缩为 .tar.gz
#   - 永不删除（永久存储）
#
# 目录结构：
#   data/
#   ├── archive/
#   │   ├── BTC/
#   │   │   ├── 2026-W18/
#   │   │   │   ├── 2026-04-28.json
#   │   │   │   └── instant-2026-05-03-05-40-58.json
#   │   │   ├── 2026-W19.tar.gz
#   │   │   └── ...
#   │   ├── JUP/
#   │   │   └── ...
#   │   └── _other/              ← 无法解析币种的文件
#   │       └── ...
#   ├── 2026-05-13.json          ← 近7天保留在原位
#   └── ...
# ============================================================

set -euo pipefail

# ---- 配置 ----
DATA_DIR="$(cd "$(dirname "$0")/.." && pwd)/data"
ARCHIVE_DIR="$DATA_DIR/archive"
ARCHIVE_AGE_DAYS=7       # 多少天后移到归档
COMPRESS_AGE_DAYS=14     # 多少天后压缩整周目录
TODAY=$(date +"%Y-%m-%d")

# ---- 工具函数 ----

get_iso_week() {
    local date_str="$1"
    date -d "$date_str" +"%G-W%V" 2>/dev/null || echo "unknown"
}

# 从 ISO 周名（YYYY-WXX）计算该周周日日期
# 算法：Jan 4 总是在 ISO 第1周内，以此为锚点推算
get_week_sunday() {
    local week_str="$1"  # e.g. "2026-W18"
    local year="${week_str%-W*}"
    local week_num="${week_str#*-W}"

    # Jan 4 of that year (always in ISO week 1)
    local jan4="${year}-01-04"
    # Day of week: 1=Mon ... 7=Sun
    local dow
    dow=$(date -d "$jan4" +%u 2>/dev/null)
    [[ -z "$dow" ]] && return 1

    # Monday of week 1 = Jan 4 - (dow - 1) days
    local offset=$(( dow - 1 ))
    local week1_monday
    week1_monday=$(date -d "$jan4 - $offset days" +"%Y-%m-%d" 2>/dev/null)
    [[ -z "$week1_monday" ]] && return 1

    # Monday of target week = week1_monday + (week_num - 1) * 7 days
    local day_offset=$(( (week_num - 1) * 7 ))
    local target_monday
    target_monday=$(date -d "$week1_monday + $day_offset days" +"%Y-%m-%d" 2>/dev/null)
    [[ -z "$target_monday" ]] && return 1

    # Sunday = Monday + 6 days
    date -d "$target_monday + 6 days" +"%Y-%m-%d" 2>/dev/null
}

days_between() {
    local d1="$1" d2="$2"
    local ts1 ts2
    ts1=$(date -d "$d1" +%s 2>/dev/null) || return 1
    ts2=$(date -d "$d2" +%s 2>/dev/null) || return 1
    echo $(( (ts1 - ts2) / 86400 ))
}

# 从文件名解析币种和日期
# 输出格式: COIN|YYYY-MM-DD
parse_filename() {
    local fname="$1"
    local coin=""
    local datestr=""

    # 模式1: COIN-instant-YYYYMMDD-HHMM.json
    if [[ "$fname" =~ ^([A-Z0-9]+)-instant-([0-9]{8})-([0-9]{4})\.json$ ]]; then
        coin="${BASH_REMATCH[1]}"
        datestr="${BASH_REMATCH[2]:0:4}-${BASH_REMATCH[2]:4:2}-${BASH_REMATCH[2]:6:2}"
        echo "${coin}|${datestr}"
        return 0
    fi

    # 模式2: instant-YYYY-MM-DD-HH-MM-SS_COIN.json
    if [[ "$fname" =~ ^instant-([0-9]{4})-([0-9]{2})-([0-9]{2})-([0-9]{2})-([0-9]{2})-([0-9]{2})_([A-Z0-9]+)\.json$ ]]; then
        coin="${BASH_REMATCH[7]}"
        datestr="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}"
        echo "${coin}|${datestr}"
        return 0
    fi

    # 模式3: instant-YYYY-MM-DD-HH-MM-SS.json (BTC 即时分析)
    if [[ "$fname" =~ ^instant-([0-9]{4})-([0-9]{2})-([0-9]{2})-([0-9]{2})-([0-9]{2})-([0-9]{2})\.json$ ]]; then
        datestr="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}"
        echo "BTC|${datestr}"
        return 0
    fi

    # 模式4: YYYY-MM-DD_COIN.json
    if [[ "$fname" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})_([A-Z0-9]+)\.json$ ]]; then
        coin="${BASH_REMATCH[4]}"
        datestr="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}"
        echo "${coin}|${datestr}"
        return 0
    fi

    # 模式5: COIN-YYYY-MM-DD.json
    if [[ "$fname" =~ ^([A-Z0-9]+)-([0-9]{4})-([0-9]{2})-([0-9]{2})\.json$ ]]; then
        coin="${BASH_REMATCH[1]}"
        datestr="${BASH_REMATCH[2]}-${BASH_REMATCH[3]}-${BASH_REMATCH[4]}"
        echo "${coin}|${datestr}"
        return 0
    fi

    # 模式6: YYYY-MM-DD.json (BTC 日报)
    if [[ "$fname" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})\.json$ ]]; then
        datestr="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}"
        echo "BTC|${datestr}"
        return 0
    fi

    # 模式7: COIN-instant-YYYYMMDD-HHMMSS.json (变体)
    if [[ "$fname" =~ ^([A-Z0-9]+)-instant-([0-9]{8})-([0-9]{6})\.json$ ]]; then
        coin="${BASH_REMATCH[1]}"
        datestr="${BASH_REMATCH[2]:0:4}-${BASH_REMATCH[2]:4:2}-${BASH_REMATCH[2]:6:2}"
        echo "${coin}|${datestr}"
        return 0
    fi

    return 1
}

# 从JSON内容提取 coin 字段（备用方法）
extract_coin_from_json() {
    local file="$1"
    python3 -c "
import json, sys
try:
    with open('$file') as f:
        data = json.load(f)
    print(data.get('coin', 'UNKNOWN'))
except:
    print('UNKNOWN')
" 2>/dev/null || echo "UNKNOWN"
}

# ---- 主流程 ----

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 数据归档开始"
echo "归档目录: $ARCHIVE_DIR"

# 确保归档根目录存在
mkdir -p "$ARCHIVE_DIR"

# 统计
MOVED_COUNT=0
SKIPPED_COUNT=0

# ---- 阶段1: 扫描 data/ 下所有 JSON 文件（排除 archive 目录和操作文件） ----

while IFS= read -r -d '' filepath; do
    fname=$(basename "$filepath")

    # 跳过非 JSON 文件
    [[ "$fname" != *.json ]] && continue

    # 跳过操作型文件（永久保留在 data/）
    case "$fname" in
        altcoin-blacklist.json|alt-scanner-tickers.json|alt-scanner-top20.json|\
        alt_scanner_top60.json|fibonacci_analysis.json|SCHEMA.md|\
        raw_bills*.json|raw_orders*.json|raw_positions*.json|\
        swap_tickers_raw.json|temp-*.json|kline_chart.png|kline_charts|alert-trigger-*)
            continue
            ;;
    esac

    # 尝试从文件名解析
    if parsed=$(parse_filename "$fname"); then
        coin="${parsed%%|*}"
        datestr="${parsed##*|}"
    else
        # 无法解析，尝试从 JSON 提取
        coin=$(extract_coin_from_json "$filepath")
        if [[ "$coin" == "UNKNOWN" || -z "$coin" ]]; then
            coin="_other"
        fi
        # 从文件修改时间推断日期
        datestr=$(date -d "@$(stat -c %Y "$filepath")" +"%Y-%m-%d" 2>/dev/null || echo "$TODAY")
    fi

    # 检查文件日期，判断是否需要归档
    age=$(days_between "$TODAY" "$datestr" 2>/dev/null) || age=0

    if [[ "$age" -lt "$ARCHIVE_AGE_DAYS" ]]; then
        ((SKIPPED_COUNT++)) || true
        continue  # 近7天，保留
    fi

    # 计算归档路径
    week=$(get_iso_week "$datestr")
    target_dir="$ARCHIVE_DIR/$coin/$week"
    mkdir -p "$target_dir"

    # 移动文件
    if mv "$filepath" "$target_dir/$fname" 2>/dev/null; then
        ((MOVED_COUNT++)) || true
    else
        echo "  [WARN] 移动失败: $fname"
    fi

done < <(find "$DATA_DIR" -maxdepth 1 -type f \( -name "*.json" -o -name "*.png" \) -print0 2>/dev/null)

echo "已移动: ${MOVED_COUNT} 个文件, 保留: ${SKIPPED_COUNT} 个文件"

# ---- 阶段2: 压缩超过14天的整周目录 ----

COMPRESSED_COUNT=0

if [[ -d "$ARCHIVE_DIR" ]]; then
    for coin_dir in "$ARCHIVE_DIR"/*/; do
        [[ -d "$coin_dir" ]] || continue
        coin_name=$(basename "$coin_dir")

        for week_dir in "$coin_dir"*/; do
            [[ -d "$week_dir" ]] || continue
            week_name=$(basename "$week_dir")
            [[ "$week_name" == *.tar.gz ]] && continue

            # 使用自定义函数计算该周周日日期
            week_sunday=$(get_week_sunday "$week_name" 2>/dev/null) || continue
            [[ -z "$week_sunday" ]] && continue

            age=$(days_between "$TODAY" "$week_sunday" 2>/dev/null) || continue

            if [[ "$age" -ge "$COMPRESS_AGE_DAYS" ]]; then
                echo "压缩: $coin_name/$week_name (周日 $week_sunday, ${age}天前)"

                tar -czf "${coin_dir}/${week_name}.tar.gz" -C "$coin_dir" "$week_name"

                if [[ $? -eq 0 ]]; then
                    rm -rf "$week_dir"
                    ((COMPRESSED_COUNT++)) || true
                    echo "  已完成: $coin_name/$week_name → ${week_name}.tar.gz"
                else
                    echo "  [ERROR] 压缩失败: $coin_name/$week_name，保留原目录"
                fi
            fi
        done
    done
fi

echo "已压缩: ${COMPRESSED_COUNT} 个周目录"

# ---- 阶段3: 清理空目录 ----
find "$ARCHIVE_DIR" -type d -empty -delete 2>/dev/null || true

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 数据归档完成"
