#!/usr/bin/env python3
"""
alt-scanner-screening.py — 山寨币扫描筛A+筛B（预写脚本，禁止 LLM 重写）

输入：stdin 接收 JSON 数组，每个元素:
  { "instId": "JTO-USDT-SWAP", "coin": "JTO", "change_pct": 40.18, ... }

输出：stdout 输出 JSON:
  { "screening": [...], "first_pass_coin": "JTO" | null, "first_pass_idx": 0 | null }

筛A（黑名单）：读取用户自定义黑名单 + coin-cooldown.json 冷却名单
筛B（活跃周期）：使用 glob.glob() 搜索 active/{prefix}-{coin}-* 目录

⚠️ 本脚本使用 glob.glob() 而非 subprocess+ls，避免 shell glob 展开陷阱。

用法：python3 alt-scanner-screening.py [--profile alt|zhuang]
  --profile 指定画像（默认 alt），决定筛B周期前缀：alt- 或 zhuang-
"""

import sys
import json
import os
import glob
import argparse

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
USER_BLACKLIST_PATH = os.path.join(WORKSPACE, 'config/user-blacklist.json')
COOLDOWN_PATH = os.path.join(WORKSPACE, 'data', 'coin-cooldown.json')


PREFIX_MAP = {
    "alt": "alt",
    "zhuang": "zhuang",
}


def main():
    parser = argparse.ArgumentParser(description='山寨币扫描筛A+筛B')
    parser.add_argument('--profile', choices=['alt', 'zhuang'], default='alt',
                        help='画像类型，决定筛B周期前缀（default: alt）')
    args = parser.parse_args()

    prefix = PREFIX_MAP.get(args.profile, "alt")
    candidates = json.load(sys.stdin)

    # 加载黑名单（仅用户自定义，系统黑名单不再使用）
    blacklist = set()
    try:
        with open(USER_BLACKLIST_PATH) as f:
            user_bl_data = json.load(f)
        blacklist |= set(user_bl_data.get("blacklist", []))
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    # 加载冷却名单（惰性清除过期条目）
    cooldown = set()
    try:
        with open(COOLDOWN_PATH) as f:
            cd_data = json.load(f)
        now_utc = __import__('datetime').datetime.now(__import__('datetime').timezone.utc)
        entries = cd_data.get('entries', {})
        expired = []
        for coin, info in entries.items():
            until = __import__('datetime').datetime.fromisoformat(info['cooldown_until'].replace('Z', '+00:00'))
            if until > now_utc:
                cooldown.add(coin)
            else:
                expired.append(coin)
        if expired:
            for c in expired:
                del entries[c]
            cd_data['entries'] = entries
            cd_data['updated'] = now_utc.isoformat()
            with open(COOLDOWN_PATH, 'w') as f:
                json.dump(cd_data, f, indent=2, ensure_ascii=False)
                f.write('\n')
    except (FileNotFoundError, json.JSONDecodeError, ValueError):
        pass

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

        # 筛A：黑名单 + 冷却名单
        if coin in blacklist:
            result["screen_a"] = f"skip (blacklisted)"
            screening.append(result)
            continue
        if coin in cooldown:
            result["screen_a"] = f"skip (cooldown)"
            screening.append(result)
            continue

        result["screen_a"] = "pass"

        # 筛B：活跃周期 (用 glob.glob 正确展开通配符，prefix 由 --profile 决定)
        # ⚠️ 检查所有画像前缀，防止 alt/zhuang 双画像共存同一币种
        all_prefixes = ['alt', 'zhuang'] if prefix in ['alt', 'zhuang'] else [prefix]
        any_cycle = []
        for p in all_prefixes:
            any_cycle.extend(glob.glob(os.path.join(WORKSPACE, f"active/{p}-{coin}-*")))
        if any_cycle:
            result["screen_b"] = f"skip (exists: {os.path.basename(any_cycle[0])})"
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
