#!/usr/bin/env python3
"""
scanner-zhuang.py — 庄币扫描引擎

与 scanner-full.py 的核心差异：
- 使用 4h K 线涨跌幅（绝对值）替代 24h ticker 涨跌幅
- 两步法：tickers 粗筛 → 4h candles 精算
- 其余筛A/B/C/OI 逻辑与普通山寨扫描一致

运行方式：python3 scripts/scanner-zhuang.py

日志格式（追加到 logs/zhuang-scanner.log）：
  正常: [时间] [庄币扫描] 内容
  警告: [时间] [庄币扫描] ⚠️ WARN: 内容
  错误: [时间] [庄币扫描] ⛔ ERROR: 内容
"""

import json
import subprocess
import sys
import os
import glob
import time
from datetime import datetime

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROXY_URL = "http://127.0.0.1:7890"
BLACKLIST_PATH = os.path.join(WORKSPACE, "data", "altcoin-blacklist.json")
USER_BLACKLIST_PATH = os.path.join(WORKSPACE, "data", "user-blacklist.json")
NON_ALT_PATH = os.path.join(WORKSPACE, "data", "non-alt-list.json")
ACTIVE_DIR = os.path.join(WORKSPACE, "active")
SCREENING_SCRIPT = os.path.join(WORKSPACE, "scripts", "alt-scanner-screening.py")
OI_FILTER_SCRIPT = os.path.join(WORKSPACE, "scripts", "alt-scanner-oi-filter.py")
LOG_PATH = os.path.join(WORKSPACE, "logs", "zhuang-scanner.log")

# ═══ 配置 ═══
MAX_CANDIDATES_FOR_CANDLES = 80   # 最多为多少个候选币取 4h candle
CANDLE_REQ_DELAY_MS = 200          # 每次 candle 请求间隔（5 req/s）
CANDLE_MAX_RETRIES = 3             # 单个 candle 请求重试次数
MIN_24H_VOL_USD = 50000            # 最小 24h 成交量（美元），筛死币
CANDLE_BAR = "4H"                  # K 线粒度

# ─── Dashboard 配置 ───
def get_max_zhuang_coins():
    """从 dashboard-settings.json 读取上限，缺省 20"""
    try:
        settings_path = os.path.join(WORKSPACE, "data", "dashboard-settings.json")
        if os.path.exists(settings_path):
            with open(settings_path, 'r') as f:
                return json.load(f).get('zhuangScannerLimit', 20)
    except:
        pass
    return 20

MAX_ZHUANG_COINS = get_max_zhuang_coins()

# 窗口策略：从头部开始，逐轮扩展
WINDOW_ROUNDS = [
    (0, 4),     # 第1轮: 前5个
    (0, 14),    # 第2轮: 前15个
    (0, 24),    # 第3轮: 全部25个
]


def now_ts():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def log(msg, level="INFO"):
    if level == "WARN":
        line = f"[{now_ts()}] [庄币扫描] ⚠️ WARN: {msg}"
    elif level == "ERROR":
        line = f"[{now_ts()}] [庄币扫描] ⛔ ERROR: {msg}"
    else:
        line = f"[{now_ts()}] [庄币扫描] {msg}"
    print(line)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def fetch_candle_4h(coin, retries=CANDLE_MAX_RETRIES):
    """
    获取单币种最新 4H K 线，返回 (open, close, high, low) 或 None
    带退避重试
    """
    inst_id = f"{coin}-USDT-SWAP"
    url = f"https://www.okx.com/api/v5/market/candles?instId={inst_id}&bar={CANDLE_BAR}&limit=1"

    for attempt in range(retries):
        try:
            result = subprocess.run(
                ["curl", "-s", "--max-time", "10", "--proxy", PROXY_URL, url],
                capture_output=True, text=True, timeout=15
            )
            data = json.loads(result.stdout)

            if data.get("code") != "0" or not data.get("data"):
                if attempt < retries - 1:
                    delay = (attempt + 1) * 2
                    time.sleep(delay)
                    continue
                return None

            candle = data["data"][0]  # [ts, open, high, low, close, vol, volCcy, ...]
            open_px = float(candle[1])
            high_px = float(candle[2])
            low_px = float(candle[3])
            close_px = float(candle[4])

            if open_px == 0:
                return None

            return (open_px, close_px, high_px, low_px)

        except Exception as e:
            if attempt < retries - 1:
                delay = (attempt + 1) * 2
                # print(f"   {coin} candle 获取重试 ({attempt+1}/{retries}): {e}")
                time.sleep(delay)
                continue
            return None

    return None


# ════════════════════════════════════════════
# 步骤 1: 扫描开始
# ════════════════════════════════════════════
log("=" * 50)
log("庄币扫描引擎启动")


# ════════════════════════════════════════════
# 步骤 2: 检查活跃周期数量
# ════════════════════════════════════════════
active_dirs = glob.glob(os.path.join(ACTIVE_DIR, "zhuang-*"))
active_count = len(active_dirs)
log(f"活跃庄币周期: {active_count}/{MAX_ZHUANG_COINS}")

if active_count >= MAX_ZHUANG_COINS:
    log("活跃庄币周期已达上限，跳过本轮")
    log("=" * 50 + " 扫描结束（上限跳过）")
    print(json.dumps({"result": "skipped_max_coins", "active_count": active_count}))
    sys.exit(0)


# ════════════════════════════════════════════
# 步骤 3: 获取 OKX SWAP 全量 tickers（带重试）
# ════════════════════════════════════════════
log("获取 OKX SWAP tickers（用于初筛）...")

MAX_RETRIES = 3
RETRY_DELAYS = [2, 4, 8]

data = None
fetch_error = None

for attempt in range(MAX_RETRIES):
    try:
        result = subprocess.run(
            ["curl", "-s", "--max-time", "15", "--proxy", PROXY_URL,
             "https://www.okx.com/api/v5/market/tickers?instType=SWAP"],
            capture_output=True, text=True, timeout=20
        )
        data = json.loads(result.stdout)
        fetch_error = None
        break
    except Exception as e:
        fetch_error = str(e)
        if attempt < MAX_RETRIES - 1:
            delay = RETRY_DELAYS[attempt]
            log(f"OKX API 获取失败 (第{attempt+1}次): {e}，{delay}s 后重试...", "WARN")
            time.sleep(delay)

if fetch_error or data is None:
    log(f"OKX API 获取失败（已重试{MAX_RETRIES}次） - {fetch_error}", "ERROR")
    log("=" * 50 + " 扫描结束")
    print(json.dumps({"result": "api_error", "error": fetch_error}))
    sys.exit(1)

if data.get("code") != "0":
    log(f"API 返回错误 - {data.get('msg')}", "ERROR")
    log("=" * 50 + " 扫描结束")
    print(json.dumps({"result": "api_error", "error": data.get("msg")}))
    sys.exit(1)

tickers = data.get("data", [])
if not tickers:
    log("tickers 返回空数组", "ERROR")
    log("=" * 50 + " 扫描结束")
    print(json.dumps({"result": "empty_tickers"}))
    sys.exit(1)

log(f"原始 tickers: {len(tickers)} 个")

# ─── 3.1 过滤 -USDT-SWAP，计算 24h 成交量 ───
usdt_swaps = []
for t in tickers:
    if not t.get("instId", "").endswith("-USDT-SWAP"):
        continue
    vol24h = float(t.get("volCcy24h", 0))
    if vol24h < MIN_24H_VOL_USD:
        continue
    coin = t["instId"].replace("-USDT-SWAP", "")
    usdt_swaps.append({
        "coin": coin,
        "instId": t["instId"],
        "last": float(t.get("last", 0)),
        "vol24h": vol24h,
    })

log(f"成交量 > ${MIN_24H_VOL_USD:,}: {len(usdt_swaps)} 个")

if not usdt_swaps:
    log("无符合条件的币种", "WARN")
    log("=" * 50 + " 扫描结束")
    print(json.dumps({"result": "no_coins"}))
    sys.exit(0)

# ─── 3.2 按 24h 成交量排序，取前 MAX_CANDIDATES_FOR_CANDLES ───
usdt_swaps.sort(key=lambda x: x["vol24h"], reverse=True)
candle_targets = usdt_swaps[:MAX_CANDIDATES_FOR_CANDLES]

log(f"成交量前 {len(candle_targets)} 个币种 → 获取 4H candles")

# ─── 3.3 并行获取 4H candles，计算涨跌幅 ───
log(f"获取 4H K 线 ({CANDLE_BAR})，间隔 {CANDLE_REQ_DELAY_MS}ms...")

with_change = []
fetch_count = 0
fetch_fail = 0

for t in candle_targets:
    coin = t["coin"]
    fetch_count += 1

    candle = fetch_candle_4h(coin)

    if candle is None:
        fetch_fail += 1
        continue

    open_px, close_px, high_px, low_px = candle
    change_pct = (close_px - open_px) / open_px * 100

    with_change.append({
        "instId": t["instId"],
        "coin": coin,
        "last": t["last"],
        "open24h": open_px,  # 实际上是 4h open，沿用以兼容后续
        "change_pct": round(change_pct, 2),
        "vol24h": str(t["vol24h"]),
    })

    # 限流：间隔 200ms
    time.sleep(CANDLE_REQ_DELAY_MS / 1000)

log(f"4H candle 获取完成: 成功 {len(with_change)} 个, 失败 {fetch_fail} 个")

# ─── 3.4 按 |涨跌幅| 排序，取前 25 ───
with_change.sort(key=lambda x: abs(x["change_pct"]), reverse=True)
candidates = with_change[:25]

# 庄币最低 |4h涨跌幅| 阈值：低于此值的币种价格根本没动，不可能是强庄控盘
MIN_ZHUANG_ABS_PCT = 2.0
candidates = [c for c in candidates if abs(c["change_pct"]) >= MIN_ZHUANG_ABS_PCT]

if not candidates:
    log("无有效 4h 涨跌幅数据", "ERROR")
    log("=" * 50 + " 扫描结束")
    print(json.dumps({"result": "no_candles"}))
    sys.exit(0)

log(f"候选池: 前 {len(candidates)} 个（|4h涨跌幅| 降序）")
log(f"  #1: {candidates[0]['coin']} ({candidates[0]['change_pct']:+.2f}% | 4h)")
log(f"  #{len(candidates)}: {candidates[-1]['coin']} ({candidates[-1]['change_pct']:+.2f}% | 4h)")


# ════════════════════════════════════════════
# 加载名单
# ════════════════════════════════════════════
blacklist = set()
bl_data = load_json(BLACKLIST_PATH)
if bl_data:
    blacklist = set(bl_data.get("blacklist", []))
    log(f"系统黑名单加载: {len(blacklist)} 个")

user_bl_data = load_json(USER_BLACKLIST_PATH)
user_blacklist = set()
if user_bl_data:
    user_blacklist = set(user_bl_data.get("blacklist", []))
    blacklist |= user_blacklist
    log(f"用户黑名单加载: {len(user_blacklist)} 个, 合并后: {len(blacklist)} 个")

non_alts = set()
na_data = load_json(NON_ALT_PATH)
if na_data:
    non_alts = set(na_data.get("non_alts", []))
    log(f"非山寨名单加载: {len(non_alts)} 个")


# ════════════════════════════════════════════
# 步骤 4-8: 窗口扫描（复用以筛A/B/C/OI）
# ════════════════════════════════════════════
checked_coins = set()
selected_coin = None
stats = {"blacklisted": 0, "active_cycle": 0, "non_alt": 0, "oi_failed": 0}

for round_idx, (start, end) in enumerate(WINDOW_ROUNDS):
    # 窗口越界保护
    actual_end = min(end, len(candidates) - 1)
    if start >= len(candidates):
        break

    round_num = round_idx + 1
    window_coins = [candidates[i] for i in range(start, actual_end + 1)]
    new_coins = [c for c in window_coins if c["coin"] not in checked_coins]
    checked_coins.update(c["coin"] for c in window_coins)

    log(f"窗口: 第{round_num}轮（索引 {start+1}-{actual_end+1}，共 {len(new_coins)} 个新增）")

    if not new_coins:
        continue

    # ─── 筛A + 筛B ───
    window_json = json.dumps(new_coins)
    screen_result = subprocess.run(
        ["python3", SCREENING_SCRIPT],
        input=window_json, capture_output=True, text=True
    )

    if screen_result.returncode != 0:
        log(f"筛A+B 脚本执行失败: {screen_result.stderr}", "ERROR")
        continue

    screening_out = json.loads(screen_result.stdout)

    passed_a_b = []
    for s in screening_out.get("screening", []):
        if s["screen_a"].startswith("skip"):
            stats["blacklisted"] += 1
        elif s["screen_b"].startswith("skip"):
            stats["active_cycle"] += 1
        elif s["pass_a_and_b"]:
            passed_a_b.append(s)

    if not passed_a_b:
        log(f"筛A+B: 全部被筛掉 → 扩展窗口")
        if round_num >= len(WINDOW_ROUNDS):
            log("窗口已达上限，本轮结束")
            break
        continue

    log(f"筛A+B通过: {len(passed_a_b)} 个: {[c['coin'] for c in passed_a_b]}")

    # ─── 筛C: 非山寨币 ───
    passed_c = []
    for c in passed_a_b:
        coin = c["coin"]
        if coin in non_alts:
            stats["non_alt"] += 1
            log(f"筛C跳过: {coin} (非山寨币)")
            continue
        passed_c.append(c)

    if not passed_c:
        log(f"筛C: 全部被筛掉 → 扩展窗口")
        if round_num >= len(WINDOW_ROUNDS):
            break
        continue

    log(f"筛C通过: {len(passed_c)} 个: {[c['coin'] for c in passed_c]}")

    # ─── OI 筛选 ───
    log("OI 筛选中...")
    oi_input = json.dumps(passed_c)
    oi_result = subprocess.run(
        ["python3", OI_FILTER_SCRIPT],
        input=oi_input, capture_output=True, text=True
    )

    if oi_result.returncode != 0:
        log(f"OI 筛选脚本执行失败: {oi_result.stderr}", "ERROR")
        stats["oi_failed"] += len(passed_c)
        if round_num >= len(WINDOW_ROUNDS):
            break
        continue

    try:
        oi_out = json.loads(oi_result.stdout)
    except json.JSONDecodeError:
        log(f"OI 筛选输出解析失败: {oi_result.stdout[:200]}", "ERROR")
        stats["oi_failed"] += len(passed_c)
        if round_num >= len(WINDOW_ROUNDS):
            break
        continue

    if oi_out.get("error"):
        log(f"OI 筛选异常 - {oi_out['error']}", "WARN")
        stats["oi_failed"] += 1
        if round_num >= len(WINDOW_ROUNDS):
            break
        continue

    top_pick = oi_out.get("top_pick")
    ranked = oi_out.get("ranked", [])

    if ranked:
        oi_ranking = ", ".join(
            f"{r['coin']} (OI {r['oi_change_pct']:+.2f}%)"
            for r in ranked if r.get("oi_change_pct") is not None
        )
        log(f"OI 排名: {oi_ranking}")

    if top_pick:
        selected_coin = top_pick
        break
    else:
        log(f"OI 筛选无有效结果 → 扩展窗口")
        if round_num >= len(WINDOW_ROUNDS):
            break


# ════════════════════════════════════════════
# 步骤 9-10: 输出结果
# ════════════════════════════════════════════
log("=" * 50)

if selected_coin:
    log(f"✅ 命中: {selected_coin['coin']}")
    log(f"   4h涨跌幅: {selected_coin['change_pct']:+.2f}%")
    log(f"   OI变化: {selected_coin['oi_change_pct']:+.2f}%")
    log(f"   筛选统计: 黑名单 {stats['blacklisted']} | 活跃周期 {stats['active_cycle']} | 非山寨 {stats['non_alt']} | OI失败 {stats['oi_failed']}")
    log("=" * 50 + " 扫描结束")

    output = {
        "result": "hit",
        "coin": selected_coin["coin"],
        "change_pct": selected_coin["change_pct"],
        "oi_change_pct": selected_coin["oi_change_pct"],
        "stats": stats,
    }
else:
    log(f"候选池全部未通过筛选")
    log(f"筛选统计: 黑名单 {stats['blacklisted']} | 活跃周期 {stats['active_cycle']} | 非山寨 {stats['non_alt']} | OI失败 {stats['oi_failed']}")
    log("=" * 50 + " 扫描结束（无命中）")

    output = {
        "result": "no_hit",
        "stats": stats,
    }

print("__JSON_OUTPUT__")
print(json.dumps(output))
