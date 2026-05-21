#!/bin/bash
# ============================================================
# rules-archive/ 归档规则按币种+周两级分组压缩
#
# 归档策略：
#   - 扫描 rules-archive/ 下所有 .js 文件
#   - 按币种 → 周 两级目录重组
#   - 7天内的文件保留在扁平目录（不动）
#   - 超过7天的文件移入 COIN/YYYY-WXX/ 子目录
#   - 超过14天的整周目录压缩为 .tar.gz
#   - 永不删除
#
# 目录结构：
#   rules-archive/
#   ├── BTC/
#   │   ├── 2026-W15/
#   │   │   ├── 2026-04-10-resistance-73878.js
#   │   │   └── ...
#   │   ├── 2026-W14.tar.gz
#   │   └── ...
#   ├── AERO/
#   │   ├── 2026-W19/
#   │   └── 2026-W18.tar.gz
#   ├── _other/              ← 无法解析币种的文件
#   │   └── ...
#   ├── 2026-05-17T01-07-21_KGEN-price-levels.js  ← 近7天保留原位
#   └── ...
# ============================================================

set -euo pipefail

# ---- 配置 ----
ARCHIVE_DIR="$(cd "$(dirname "$0")/../skills/btc-alert/rules-archive" && pwd)"
ARCHIVE_AGE_DAYS=7       # 多少天后移入币种+周子目录
COMPRESS_AGE_DAYS=14     # 多少天后压缩整周目录
TODAY=$(date +"%Y-%m-%d")

# ---- 工具函数 ----

get_iso_week() {
    local date_str="$1"
    date -d "$date_str" +"%G-W%V" 2>/dev/null || echo "unknown"
}

# 从 ISO 周名（YYYY-WXX）计算该周周日日期
get_week_sunday() {
    local week_str="$1"
    local year="${week_str%-W*}"
    local week_num="${week_str#*-W}"

    local jan4="${year}-01-04"
    local dow
    dow=$(date -d "$jan4" +%u 2>/dev/null)
    [[ -z "$dow" ]] && return 1

    local offset=$(( dow - 1 ))
    local week1_monday
    week1_monday=$(date -d "$jan4 - $offset days" +"%Y-%m-%d" 2>/dev/null)
    [[ -z "$week1_monday" ]] && return 1

    local day_offset=$(( (week_num - 1) * 7 ))
    local target_monday
    target_monday=$(date -d "$week1_monday + $day_offset days" +"%Y-%m-%d" 2>/dev/null)
    [[ -z "$target_monday" ]] && return 1

    date -d "$target_monday + 6 days" +"%Y-%m-%d" 2>/dev/null
}

days_between() {
    local d1="$1" d2="$2"
    local ts1 ts2
    ts1=$(date -d "$d1" +%s 2>/dev/null) || return 1
    ts2=$(date -d "$d2" +%s 2>/dev/null) || return 1
    echo $(( (ts1 - ts2) / 86400 ))
}

# 从归档规则文件名提取币种和日期
# 输出格式: COIN|YYYY-MM-DD
parse_rule_filename() {
    local fname="$1"

    # 模式1: 2026-05-17T01-07-21_2026-05-17-type.js (引擎归档，带时间戳前缀+日期，BTC规则)
    # ⚠️ 必须在模式2之前匹配，否则 2026-04-08 会被误识别为币种
    if [[ "$fname" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})T[0-9]{2}-[0-9]{2}-[0-9]{2}_[0-9]{4}-[0-9]{2}-[0-9]{2}- ]]; then
        local datestr="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}"
        echo "BTC|${datestr}"
        return 0
    fi

    # 模式2: 2026-05-17T01-07-21_COIN-type.js (引擎归档，带时间戳前缀+币种)
    if [[ "$fname" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})T[0-9]{2}-[0-9]{2}-[0-9]{2}_([A-Z][A-Z0-9]+)- ]]; then
        local datestr="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}"
        local coin="${BASH_REMATCH[4]}"
        echo "${coin}|${datestr}"
        return 0
    fi

    # 模式3: COIN-type.js (纯币种前缀，无日期)
    # ⚠️ [A-Z] 开头至少2字符，避免匹配日期前缀
    if [[ "$fname" =~ ^([A-Z][A-Z0-9]+)- ]]; then
        local coin="${BASH_REMATCH[1]}"
        # 日期从文件修改时间推断
        echo "${coin}|mtime"
        return 0
    fi

    # 模式4: 2026-04-10-type.js (日期前缀，BTC规则)
    if [[ "$fname" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})- ]]; then
        local datestr="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}"
        echo "BTC|${datestr}"
        return 0
    fi

    # 模式5: 2Z-type.js (数字开头币种，排除纯年份4位数字)
    # 要求: 数字后紧跟大写字母（如 2Z），排除 2026-04-23T15-20-resistance 这种
    if [[ "$fname" =~ ^([0-9][A-Z][A-Z0-9]*)- ]]; then
        local coin="${BASH_REMATCH[1]}"
        echo "${coin}|mtime"
        return 0
    fi

    # 模式6: 日期+时间戳(缺秒) BTC规则 (如 2026-04-23T15-20-resistance-79443.js)
    if [[ "$fname" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})T[0-9]{2}-[0-9]{2}- ]]; then
        local datestr="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}"
        echo "BTC|${datestr}"
        return 0
    fi

    return 1
}

# ---- 主流程 ----

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 规则归档开始"
echo "归档目录: $ARCHIVE_DIR"

# 统计
MOVED_COUNT=0
SKIPPED_COUNT=0

# ---- 阶段1: 扫描 rules-archive/ 下扁平的 .js 文件，移入币种+周子目录 ----

while IFS= read -r -d '' filepath; do
    fname=$(basename "$filepath")

    # 跳过非 .js 文件
    [[ "$fname" != *.js ]] && continue

    # 跳过已在子目录中的文件（路径深度 > 1）
    # find 只搜 -maxdepth 1，所以这里不会出现子目录文件

    # 解析币种和日期
    if parsed=$(parse_rule_filename "$fname"); then
        coin="${parsed%%|*}"
        datestr="${parsed##*|}"
    else
        coin="_other"
        datestr="mtime"
    fi

    # 如果日期是 mtime，从文件修改时间获取
    if [[ "$datestr" == "mtime" ]]; then
        datestr=$(date -d "@$(stat -c %Y "$filepath")" +"%Y-%m-%d" 2>/dev/null || echo "$TODAY")
    fi

    # 检查文件日期，判断是否需要移入子目录
    age=$(days_between "$TODAY" "$datestr" 2>/dev/null) || age=0

    if [[ "$age" -lt "$ARCHIVE_AGE_DAYS" ]]; then
        ((SKIPPED_COUNT++)) || true
        continue  # 近7天，保留原位
    fi

    # 计算目标路径
    week=$(get_iso_week "$datestr")
    target_dir="$ARCHIVE_DIR/$coin/$week"
    mkdir -p "$target_dir"

    # 移动文件
    if mv "$filepath" "$target_dir/$fname" 2>/dev/null; then
        ((MOVED_COUNT++)) || true
    else
        echo "  [WARN] 移动失败: $fname"
    fi

done < <(find "$ARCHIVE_DIR" -maxdepth 1 -type f -name "*.js" -print0 2>/dev/null)

echo "已移动: ${MOVED_COUNT} 个文件, 保留: ${SKIPPED_COUNT} 个文件"

# ---- 阶段2: 压缩超过14天的整周目录 ----

COMPRESSED_COUNT=0

if [[ -d "$ARCHIVE_DIR" ]]; then
    for coin_dir in "$ARCHIVE_DIR"/*/; do
        [[ -d "$coin_dir" ]] || continue
        coin_name=$(basename "$coin_dir")

        # 跳过 _other 等特殊目录中的压缩文件
        for week_dir in "$coin_dir"*/; do
            [[ -d "$week_dir" ]] || continue
            week_name=$(basename "$week_dir")
            [[ "$week_name" == *.tar.gz ]] && continue

            # 计算该周周日日期
            week_sunday=$(get_week_sunday "$week_name" 2>/dev/null) || continue
            [[ -z "$week_sunday" ]] && continue

            age=$(days_between "$TODAY" "$week_sunday" 2>/dev/null) || continue

            if [[ "$age" -ge "$COMPRESS_AGE_DAYS" ]]; then
                echo "压缩: $coin_name/$week_name (周日 $week_sunday, ${age}天前)"

                tar -czf "${coin_dir}${week_name}.tar.gz" -C "$coin_dir" "$week_name"

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

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 规则归档完成"
