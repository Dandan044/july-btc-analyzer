#!/usr/bin/env python3
"""
alt-scanner-screening.py — 山寨币扫描筛A+筛B（预写脚本，禁止 LLM 重写）

输入：stdin 接收 JSON 数组，每个元素:
  { "instId": "JTO-USDT-SWAP", "coin": "JTO", "change_pct": 40.18, ... }

输出：stdout 输出 JSON:
  { "screening": [...], "first_pass_coin": "JTO" | null, "first_pass_idx": 0 | null }

筛A（黑名单）：读取 data/altcoin-blacklist.json 中的 blacklist[] 数组
筛B（活跃周期）：使用 glob.glob() 搜索 active/alt-{coin}-* 目录

⚠️ 本脚本使用 glob.glob() 而非 subprocess+ls，避免 shell glob 展开陷阱。
"""

import sys
import json
import os
import glob

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BLACKLIST_PATH = os.path.join(WORKSPACE, 'data/altcoin-blacklist.json')


def main():
    candidates = json.load(sys.stdin)

    # 加载黑名单
    try:
        with open(BLACKLIST_PATH) as f:
            blacklist_data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        blacklist_data = {"blacklist": [], "reason": ""}

    blacklist = set(blacklist_data.get("blacklist", []))

    screening = []

    for idx, c in enumerate(candidates):
        coin = c.get("coin", "")
        inst_id = c.get("instId", "")
        change_pct = c.get("change_pct", 0)

        result = {
            "idx": idx,
            "coin": coin,
            "instId": inst_id,
            "change_pct": change_pct,
            "screen_a": "pending",
            "screen_b": "pending",
            "pass_a_and_b": False,
        }

        # 筛A：黑名单
        if coin in blacklist:
            result["screen_a"] = f"skip (blacklisted)"
            screening.append(result)
            continue

        result["screen_a"] = "pass"

        # 筛B：活跃周期 (用 glob.glob 正确展开通配符)
        cycle_dirs = glob.glob(os.path.join(WORKSPACE, f"active/alt-{coin}-*"))
        if cycle_dirs:
            result["screen_b"] = f"skip (exists: {os.path.basename(cycle_dirs[0])})"
            screening.append(result)
            continue

        result["screen_b"] = "pass"
        result["pass_a_and_b"] = True
        screening.append(result)

    # 找出第一个同时通过筛A+筛B的
    first_pass = None
    first_pass_idx = None
    for s in screening:
        if s["pass_a_and_b"]:
            first_pass = s["coin"]
            first_pass_idx = s["idx"]
            break

    output = {
        "screening": screening,
        "first_pass_coin": first_pass,
        "first_pass_idx": first_pass_idx,
    }

    json.dump(output, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.flush()


if __name__ == "__main__":
    main()
