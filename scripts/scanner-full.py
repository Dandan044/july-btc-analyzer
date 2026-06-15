#!/usr/bin/env python3
"""
scanner-full.py — 统一山寨币扫描引擎（alt / zhuang 双画像）

运行方式：
  python3 scripts/scanner-full.py --profile alt      # 普通山寨（24h ticker）
  python3 scripts/scanner-full.py --profile zhuang   # 庄币（4h candle 两步法）

alt 画像：ticker open24h → 前60 → 筛A/B/C/OI → 命中
zhuang 画像：ticker open24h → 前60 → 筛A/B/C → 命中（纯 |24h%|，无 OI 筛选）

日志格式：
  正常: [时间] [扫描:alt] 内容 / [时间] [扫描:zhuang] 内容
  警告: [时间] [扫描:alt] ⚠️ WARN: 内容
  错误: [时间] [扫描:alt] ⛔ ERROR: 内容
"""

import json
import subprocess
import sys
import os
import glob
import time
import argparse
from datetime import datetime

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROXY_URL = os.environ.get("PROXY_URL", "http://127.0.0.1:7890")
USER_BLACKLIST_PATH = os.path.join(WORKSPACE, "config", "user-blacklist.json")
NON_ALT_PATH = os.path.join(WORKSPACE, "config", "non-alt-list.json")
ACTIVE_DIR = os.path.join(WORKSPACE, "active")
SCREENING_SCRIPT = os.path.join(WORKSPACE, "scripts", "alt-scanner-screening.py")
OI_FILTER_SCRIPT = os.path.join(WORKSPACE, "scripts", "alt-scanner-oi-filter.py")

# ════════════════════════════════════════════
# Profile 配置
# ════════════════════════════════════════════

PROFILES = {
    "alt": {
        "label": "普通山寨",
        "prefix": "alt-",
        "log_path": os.path.join(WORKSPACE, "logs", "alt-scanner.log"),
        "calc_method": "ticker_24h",        # 直接用 ticker open24h
        "candidate_pool": 60,               # 候选池大小
        "min_abs_pct": 0,                   # alt 不过滤涨跌幅阈值，由 OI 综合分决定
        "window_rounds": [
            (0, 14),   # 第1轮: 1-15, 15个
            (15, 29),  # 第2轮: 16-30, 15个
            (30, 44),  # 第3轮: 31-45, 15个
            (45, 59),  # 第4轮: 46-60, 15个
        ],
        "settings_key": "scannerLimit",     # dashboard-settings.json 的 key
        "default_max_coins": 45,
    },
    "zhuang": {
        "label": "庄币",
        "prefix": "zhuang-",
        "log_path": os.path.join(WORKSPACE, "logs", "zhuang-scanner.log"),
        "calc_method": "ticker_24h",        # 直接用 ticker open24h，纯 |24h%|
        "candidate_pool": 60,               # 候选池大小
        "min_abs_pct": 2.0,                 # 最低 |24h涨跌幅| 阈值
        "window_rounds": [
            (0, 4),     # 第1轮: 1-5, 5个
            (0, 14),    # 第2轮: 1-15, 15个
            (0, 29),    # 第3轮: 1-30, 30个
        ],
        "settings_key": "zhuangScannerLimit",
        "default_max_coins": 20,
    },
}


# ════════════════════════════════════════════
# 工具函数
# ════════════════════════════════════════════

def now_ts():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def log(msg, level="INFO"):
    tag = f"[扫描:{PROFILE}]"
    if level == "WARN":
        line = f"[{now_ts()}] {tag} ⚠️ WARN: {msg}"
    elif level == "ERROR":
        line = f"[{now_ts()}] {tag} ⛔ ERROR: {msg}"
    else:
        line = f"[{now_ts()}] {tag} {msg}"
    print(line)
    with open(PROFILES[PROFILE]["log_path"], "a", encoding="utf-8") as f:
        f.write(line + "\n")


def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def get_max_coins():
    """从 dashboard-settings.json 读取当前画像的上限"""
    p = PROFILES[PROFILE]
    try:
        settings_path = os.path.join(WORKSPACE, "data", "dashboard-settings.json")
        if os.path.exists(settings_path):
            with open(settings_path, 'r') as f:
                return json.load(f).get(p["settings_key"], p["default_max_coins"])
    except:
        pass
    return p["default_max_coins"]


def fetch_candle_4h(coin):
    """获取单币种已完成的 4H K 线，返回 (open, close, high, low) 或 None，带退避重试

    取 limit=2，用第二根（已完成）K 线，避免当前未完成 K 线涨跌幅偏小的问题。
    """
    p = PROFILES[PROFILE]
    inst_id = f"{coin}-USDT-SWAP"
    url = f"https://www.okx.com/api/v5/market/candles?instId={inst_id}&bar={p['candle_bar']}&limit=2"

    for attempt in range(p["candle_max_retries"]):
        try:
            result = subprocess.run(
                ["curl", "-s", "--max-time", "10", "--proxy", PROXY_URL, url],
                capture_output=True, text=True, timeout=15
            )
            data = json.loads(result.stdout)
            if data.get("code") != "0" or not data.get("data"):
                if attempt < p["candle_max_retries"] - 1:
                    time.sleep((attempt + 1) * 2)
                    continue
                return None
            # 用第二根（已完成）K 线，fallback 到第一根
            idx = 1 if len(data["data"]) >= 2 else 0
            candle = data["data"][idx]  # [ts, open, high, low, close, vol, volCcy, ...]
            open_px = float(candle[1])
            high_px = float(candle[2])
            low_px = float(candle[3])
            close_px = float(candle[4])
            if open_px == 0:
                return None
            return (open_px, close_px, high_px, low_px)
        except Exception:
            if attempt < p["candle_max_retries"] - 1:
                time.sleep((attempt + 1) * 2)
                continue
            return None
    return None


# ════════════════════════════════════════════
# 候选池构建
# ════════════════════════════════════════════

def build_candidates_ticker_24h(usdt_swaps):
    """直接用 ticker open24h 计算涨跌幅（alt + zhuang 共享）"""
    p = PROFILES[PROFILE]
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
            "vol24h": float(t.get("volCcy24h", 0)) * float(t.get("last", 0)),
        })

    # 成交量筛选：24h 交易额 < 5000万 USDT 剔除
    MIN_VOL_USD = 10_000_000
    with_change = [c for c in with_change if float(c.get("vol24h", 0)) >= MIN_VOL_USD]

    with_change.sort(key=lambda x: abs(x["change_pct"]), reverse=True)
    min_pct = p.get("min_abs_pct", 0)
    if min_pct > 0:
        with_change = [c for c in with_change if abs(c["change_pct"]) >= min_pct]
    candidates = with_change[:p["candidate_pool"]]

    log(f"候选池: 前 {len(candidates)} 个（vol≥10M | |24h涨跌幅| 降序）")
    log(f"  #1: {candidates[0]['coin']} ({candidates[0]['change_pct']:+.2f}%)")
    log(f"  #{len(candidates)}: {candidates[-1]['coin']} ({candidates[-1]['change_pct']:+.2f}%)")

    return candidates


def build_candidates_candle_4h(usdt_swaps):
    """zhuang 画像：两步法 —— ticker 粗筛成交量 → 4h candle 精算"""
    p = PROFILES[PROFILE]

    # ① 成交量粗筛
    qualified = []
    for t in usdt_swaps:
        volCcy24h = float(t.get("volCcy24h", 0))
        last = float(t.get("last", 0))
        volUsd = volCcy24h * last  # volCcy24h 是基础币数量，乘价格得 USDT
        if volUsd < p["min_vol_usd"]:
            continue
        coin = t["instId"].replace("-USDT-SWAP", "")
        qualified.append({
            "coin": coin,
            "instId": t["instId"],
            "last": last,
            "open24h_ticker": float(t.get("open24h", 0)),
            "vol24h": volUsd,
        })

    log(f"成交量 > ${p['min_vol_usd']:,}: {len(qualified)} 个")

    if not qualified:
        log("无符合条件的币种", "WARN")
        return None

    # ② 按成交量排序，取前 N → 获取 4h candle
    qualified.sort(key=lambda x: x["vol24h"], reverse=True)
    candle_targets = qualified[:p["candle_max_targets"]]
    log(f"成交量前 {len(candle_targets)} 个币种 → 获取 4H candles")

    delay_sec = p["candle_req_delay_ms"] / 1000
    with_change = []
    fetch_fail = 0

    for t in candle_targets:
        coin = t["coin"]
        candle = fetch_candle_4h(coin)
        if candle is None:
            fetch_fail += 1
            continue
        open_px, close_px, high_px, low_px = candle
        change_pct = (close_px - open_px) / open_px * 100
        # 24h 涨跌幅（从 ticker 原始 open24h 计算）
        open24h_ticker = t.get("open24h_ticker", 0)
        change_pct_24h = 0.0
        if open24h_ticker > 0:
            change_pct_24h = round((t["last"] - open24h_ticker) / open24h_ticker * 100, 2)
        with_change.append({
            "instId": t["instId"],
            "coin": coin,
            "last": t["last"],
            "open24h": open_px,          # 4h open
            "change_pct": round(change_pct, 2),       # |4h|
            "change_pct_24h": change_pct_24h,         # |24h|
            "vol24h": str(t["vol24h"]),
        })
        time.sleep(delay_sec)

    log(f"4H candle 获取完成: 成功 {len(with_change)} 个, 失败 {fetch_fail} 个")

    # ③ 排序 + 阈值过滤（庄币：按 |24h涨跌幅| 排序）
    with_change.sort(key=lambda x: abs(x["change_pct_24h"]), reverse=True)
    candidates = with_change[:p["candidate_pool"]]
    candidates = [c for c in candidates if abs(c["change_pct_24h"]) >= p["min_abs_pct"]]

    if not candidates:
        log("无有效 24h 涨跌幅数据", "ERROR")
        return None

    # ④ BTC 偏离度计算（庄币核心：越不跟 BTC 走，操盘力量越强）
    btc_4h = fetch_candle_4h("BTC")
    btc_change_4h = 0.0
    btc_change_24h = 0.0
    if btc_4h:
        btc_change_4h = round((btc_4h[1] - btc_4h[0]) / btc_4h[0] * 100, 2)
    # BTC 24h 用 ticker（已在 usdt_swaps 中）
    btc_ticker = next((t for t in usdt_swaps if t.get("instId") == "BTC-USDT-SWAP"), None)
    if btc_ticker:
        btc_open = float(btc_ticker.get("open24h", 0))
        btc_last = float(btc_ticker.get("last", 0))
        if btc_open > 0:
            btc_change_24h = round((btc_last - btc_open) / btc_open * 100, 2)
    log(f"BTC: 4h {btc_change_4h:+.2f}%, 24h {btc_change_24h:+.2f}%")

    for c in candidates:
        # 偏离度 = 币种涨跌与 BTC 涨跌的差异程度
        # 0 = 完全跟 BTC 走，1 = 完全独立
        def divergence(coin_pct, btc_pct):
            if abs(coin_pct) < 0.01 and abs(btc_pct) < 0.01:
                return 0.0  # 都没动，不算偏离
            denom = max(abs(coin_pct), abs(btc_pct), 0.5)
            return min(1.0, abs(coin_pct - btc_pct) / denom)

        div_4h = divergence(c["change_pct"], btc_change_4h)
        div_24h = divergence(c.get("change_pct_24h", 0), btc_change_24h)
        c["btc_divergence"] = round((div_4h + div_24h) / 2, 4)

    log(f"候选池: 前 {len(candidates)} 个（|24h涨跌幅| 降序）")
    log(f"  #1: {candidates[0]['coin']} ({candidates[0]['change_pct_24h']:+.2f}% | 24h)")
    log(f"  #{len(candidates)}: {candidates[-1]['coin']} ({candidates[-1]['change_pct_24h']:+.2f}% | 24h)")

    return candidates


# ════════════════════════════════════════════
# 窗口扫描（筛A/B/C/OI — 两个画像共享）
# ════════════════════════════════════════════

def window_scan(candidates, blacklist, non_alts):
    """对候选池进行窗口扫描：筛A(黑名单) → 筛B(活跃周期) → 筛C(非山寨) → OI筛选(alt only)
    
    庄币画像：跳过 OI 筛选，筛C通过后直接取第一名（候选池已按 |24h%| 降序排列）
    """
    p = PROFILES[PROFILE]
    checked_coins = set()
    selected_coin = None
    stats = {"blacklisted": 0, "active_cycle": 0, "non_alt": 0, "oi_failed": 0}
    is_zhuang = (PROFILE == "zhuang")

    for round_idx, (start, end) in enumerate(p["window_rounds"]):
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
            ["python3", SCREENING_SCRIPT, "--profile", PROFILE],
            input=window_json, capture_output=True, text=True
        )

        if screen_result.returncode != 0:
            log(f"筛A+B 脚本执行失败: {screen_result.stderr}", "ERROR")
            continue

        try:
            screening_out = json.loads(screen_result.stdout)
        except json.JSONDecodeError:
            log(f"筛A+B 输出解析失败: {screen_result.stdout[:200]}", "ERROR")
            continue

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
            if round_num >= len(p["window_rounds"]):
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
            if round_num >= len(p["window_rounds"]):
                break
            continue

        log(f"筛C通过: {len(passed_c)} 个: {[c['coin'] for c in passed_c]}")

        # ─── 庄币：直接取第一名（候选池已按 |24h%| 降序）───
        if is_zhuang:
            winner = passed_c[0]
            # 从 candidates 中找到完整数据
            coin_name = winner["coin"]
            full = next((c for c in candidates if c["coin"] == coin_name), None)
            if full:
                selected_coin = {
                    "coin": full["coin"],
                    "change_pct": full["change_pct"],
                    "oi_change_pct": None,  # 庄币不获取 OI
                }
            log(f"庄币命中: {coin_name} ({full['change_pct']:+.2f}% | 24h)" if full else f"庄币命中: {coin_name}")
            break

        # ─── OI 筛选（仅 alt 画像）───
        log("OI 筛选中...")
        oi_input = json.dumps(passed_c)
        oi_result = subprocess.run(
            ["python3", OI_FILTER_SCRIPT],
            input=oi_input, capture_output=True, text=True
        )

        if oi_result.returncode != 0:
            log(f"OI 筛选脚本执行失败: {oi_result.stderr}", "ERROR")
            stats["oi_failed"] += len(passed_c)
            if round_num >= len(p["window_rounds"]):
                break
            continue

        try:
            oi_out = json.loads(oi_result.stdout)
        except json.JSONDecodeError:
            log(f"OI 筛选输出解析失败: {oi_result.stdout[:200]}", "ERROR")
            stats["oi_failed"] += len(passed_c)
            if round_num >= len(p["window_rounds"]):
                break
            continue

        if oi_out.get("error"):
            log(f"OI 筛选异常 - {oi_out['error']}", "WARN")
            stats["oi_failed"] += 1
            if round_num >= len(p["window_rounds"]):
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
            if round_num >= len(p["window_rounds"]):
                break

    return selected_coin, stats


# ════════════════════════════════════════════
# Main
# ════════════════════════════════════════════

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True, choices=["alt", "zhuang"],
                        help="扫描画像: alt（普通山寨）| zhuang（庄币）")
    args = parser.parse_args()

    PROFILE = args.profile
    p = PROFILES[PROFILE]
    MAX_COINS = get_max_coins()

    # 步骤 1: 扫描开始
    log("=" * 50)
    log(f"扫描引擎启动 | 画像: {p['label']} ({PROFILE})")

    # 步骤 2: 检查活跃周期数量
    active_dirs = glob.glob(os.path.join(ACTIVE_DIR, f"{p['prefix']}*"))
    active_count = len(active_dirs)
    log(f"活跃周期: {active_count}/{MAX_COINS}")

    if active_count >= MAX_COINS:
        log("活跃周期已达上限，跳过本轮")
        log("=" * 50 + " 扫描结束（上限跳过）")
        print(json.dumps({"result": "skipped_max_coins", "active_count": active_count}))
        sys.exit(0)

    # 步骤 3: 获取 OKX SWAP 全量 tickers（带重试）
    log("获取 OKX SWAP tickers...")

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

    # 3.1 过滤 -USDT-SWAP
    usdt_swaps = [t for t in tickers if t.get("instId", "").endswith("-USDT-SWAP")]
    log(f"USDT-SWAP 合约: {len(usdt_swaps)} 个")

    # 3.2 + 3.3 构建候选池（画像分支）
    if p["calc_method"] == "candle_4h":
        candidates = build_candidates_candle_4h(usdt_swaps)
        if candidates is None:
            log("=" * 50 + " 扫描结束（无候选）")
            print(json.dumps({"result": "no_candles"}))
            sys.exit(0)
    else:
        candidates = build_candidates_ticker_24h(usdt_swaps)

    # 步骤 4: 加载名单（仅用户黑名单，系统黑名单不再使用）
    blacklist = set()
    user_bl_data = load_json(USER_BLACKLIST_PATH)
    user_blacklist = set()
    if user_bl_data:
        user_blacklist = set(user_bl_data.get("blacklist", []))
        blacklist |= user_blacklist
    log(f"黑名单加载: 用户 {len(user_blacklist)} 个")

    non_alts = set()
    na_data = load_json(NON_ALT_PATH)
    if na_data:
        non_alts = set(na_data.get("non_alts", []))
        log(f"非山寨名单加载: {len(non_alts)} 个")

    # 步骤 5-8: 窗口扫描
    selected_coin, stats = window_scan(candidates, blacklist, non_alts)

    # 步骤 9: 输出
    log("=" * 50)

    if selected_coin:
        coin_name = selected_coin["coin"]
        change_pct = selected_coin["change_pct"]
        oi_pct = selected_coin.get("oi_change_pct")
        
        log(f"✅ 命中: {coin_name}")
        log(f"   24h涨跌幅: {change_pct:+.2f}%")
        if oi_pct is not None:
            log(f"   OI变化: {oi_pct:+.2f}%")
        log(f"   筛选统计: 黑名单 {stats['blacklisted']} | 活跃周期 {stats['active_cycle']} | 非山寨 {stats['non_alt']} | OI失败 {stats['oi_failed']}")
        log("=" * 50 + " 扫描结束")

        output = {
            "result": "hit",
            "profile": PROFILE,
            "coin": coin_name,
            "change_pct": change_pct,
            "oi_change_pct": oi_pct,
            "stats": stats,
        }
    else:
        log(f"候选池全部未通过筛选")
        log(f"筛选统计: 黑名单 {stats['blacklisted']} | 活跃周期 {stats['active_cycle']} | 非山寨 {stats['non_alt']} | OI失败 {stats['oi_failed']}")
        log("=" * 50 + " 扫描结束（无命中）")

        output = {
            "result": "no_hit",
            "profile": PROFILE,
            "stats": stats,
        }

    print("__JSON_OUTPUT__")
    print(json.dumps(output))
