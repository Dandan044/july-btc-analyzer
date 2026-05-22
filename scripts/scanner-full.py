#!/usr/bin/env python3
"""
scanner-full.py — 山寨币扫描引擎全流程（生产版）

运行方式：python3 scripts/scanner-full.py

完整跑通：获取 tickers → 筛A(黑名单) → 筛B(活跃周期) → 筛C(非山寨名单) → OI筛选 → 输出结果
输出 JSON 供 bash wrapper 解析，决定是否 openclaw cron add。

日志格式（追加到 logs/alt-scanner.log）：
  正常: [时间] [扫描] 内容
  警告: [时间] [扫描] ⚠️ WARN: 内容
  错误: [时间] [扫描] ⛔ ERROR: 内容
"""

import json
import subprocess
import sys
import os
import glob
from datetime import datetime

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROXY_URL = "http://127.0.0.1:7890"
BLACKLIST_PATH = os.path.join(WORKSPACE, "data", "altcoin-blacklist.json")
NON_ALT_PATH = os.path.join(WORKSPACE, "data", "non-alt-list.json")
ACTIVE_DIR = os.path.join(WORKSPACE, "active")
SCREENING_SCRIPT = os.path.join(WORKSPACE, "scripts", "alt-scanner-screening.py")
OI_FILTER_SCRIPT = os.path.join(WORKSPACE, "scripts", "alt-scanner-oi-filter.py")
LOG_PATH = os.path.join(WORKSPACE, "logs", "alt-scanner.log")

MAX_ALT_COINS = 30

# 窗口策略：(start_idx, end_idx) 0-based inclusive
WINDOW_ROUNDS = [
    (25, 29),   # 第1轮: 26-30, 5个
    (20, 34),   # 第2轮: 21-35, 15个
    (10, 49),   # 第3轮: 11-50, 40个
    (0, 59),    # 第4轮: 1-60, 60个
]


def now_ts():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def log(msg, level="INFO"):
    """写入日志文件 + stdout"""
    if level == "WARN":
        line = f"[{now_ts()}] [扫描] ⚠️ WARN: {msg}"
    elif level == "ERROR":
        line = f"[{now_ts()}] [扫描] ⛔ ERROR: {msg}"
    else:
        line = f"[{now_ts()}] [扫描] {msg}"
    print(line)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


# ════════════════════════════════════════════
# 步骤 1: 扫描开始
# ════════════════════════════════════════════
log("=" * 50)
log("扫描引擎启动")


# ════════════════════════════════════════════
# 步骤 2: 检查活跃周期数量
# ════════════════════════════════════════════
active_dirs = glob.glob(os.path.join(ACTIVE_DIR, "alt-*"))
active_count = len(active_dirs)
log(f"活跃周期: {active_count}/{MAX_ALT_COINS}")

if active_count >= MAX_ALT_COINS:
    log("活跃周期已达上限，跳过本轮")
    log("=" * 50 + " 扫描结束（上限跳过）")
    print(json.dumps({"result": "skipped_max_coins", "active_count": active_count}))
    sys.exit(0)


# ════════════════════════════════════════════
# 步骤 3: 获取 OKX SWAP 全量行情
# ════════════════════════════════════════════
log("获取 OKX SWAP tickers...")
try:
    result = subprocess.run(
        ["curl", "-s", "--max-time", "15", "--proxy", PROXY_URL,
         "https://www.okx.com/api/v5/market/tickers?instType=SWAP"],
        capture_output=True, text=True, timeout=20
    )
    data = json.loads(result.stdout)
except Exception as e:
    log(f"OKX API 获取失败 - {e}", "ERROR")
    log("=" * 50 + " 扫描结束")
    print(json.dumps({"result": "api_error", "error": str(e)}))
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


# ─── 3.1 过滤 -USDT-SWAP ───
usdt_swaps = [t for t in tickers if t.get("instId", "").endswith("-USDT-SWAP")]
log(f"USDT-SWAP 合约: {len(usdt_swaps)} 个")


# ─── 3.2 计算涨跌幅 ───
with_change = []
for t in usdt_swaps:
    last = float(t.get("last", 0))
    open24h = float(t.get("open24h", 0))
    if open24h == 0:
        continue
    change_pct = (last - open24h) / open24h * 100
    coin = t["instId"].replace("-USDT-SWAP", "")
    with_change.append({
        "instId": t["instId"],
        "coin": coin,
        "last": last,
        "open24h": open24h,
        "change_pct": round(change_pct, 2),
        "vol24h": t.get("volCcy24h", "0"),
    })


# ─── 3.3 按 |涨跌幅| 排序，取前 60 ───
with_change.sort(key=lambda x: abs(x["change_pct"]), reverse=True)
candidates = with_change[:60]

log(f"候选池: 前 60 个（|涨跌幅| 降序）")
log(f"  #1: {candidates[0]['coin']} ({candidates[0]['change_pct']:+.2f}%)")
log(f"  #60: {candidates[-1]['coin']} ({candidates[-1]['change_pct']:+.2f}%)")


# ════════════════════════════════════════════
# 加载名单
# ════════════════════════════════════════════
blacklist = set()
bl_data = load_json(BLACKLIST_PATH)
if bl_data:
    blacklist = set(bl_data.get("blacklist", []))
    log(f"黑名单加载: {len(blacklist)} 个")

non_alts = set()
na_data = load_json(NON_ALT_PATH)
if na_data:
    non_alts = set(na_data.get("non_alts", []))
    log(f"非山寨名单加载: {len(non_alts)} 个")


# ════════════════════════════════════════════
# 步骤 4-8: 窗口扫描
# ════════════════════════════════════════════
checked_coins = set()
selected_coin = None
stats = {"blacklisted": 0, "active_cycle": 0, "non_alt": 0, "oi_failed": 0}

for round_idx, (start, end) in enumerate(WINDOW_ROUNDS):
    round_num = round_idx + 1
    window_coins = [candidates[i] for i in range(start, end + 1)]
    new_coins = [c for c in window_coins if c["coin"] not in checked_coins]
    checked_coins.update(c["coin"] for c in window_coins)

    log(f"窗口: 第{round_num}轮（索引 {start+1}-{end+1}，共 {len(new_coins)} 个新增）")

    # ─── 步骤 5: 筛A + 筛B (用现有 Python 脚本) ───
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

    # ─── 步骤 5C: 非山寨币筛 (替代 LLM) ───
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

    # ─── 步骤 6: OI 筛选 ───
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
    log(f"   涨跌幅: {selected_coin['change_pct']:+.2f}%")
    log(f"   OI变化: {selected_coin['oi_change_pct']:+.2f}%")
    log(f"   筛选统计: 黑名单 {stats['blacklisted']} | 活跃周期 {stats['active_cycle']} | 非山寨 {stats['non_alt']} | OI失败 {stats['oi_failed']}")
    log("=" * 50 + " 扫描结束")

    # 输出 JSON 供 bash wrapper 解析
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

# stdout 的最后一行必须是纯 JSON（bash 取最后一行解析）
print("__JSON_OUTPUT__")
print(json.dumps(output))
