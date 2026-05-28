#!/usr/bin/env python3
"""
non-alt-classifier.py — 提取 OKX 全量 USDT-SWAP 币对列表，供 LLM 分类

输出：
  1. scripts/_non-alt-pending.json — 待分类币对列表（JSON 数组）
  2. 同时输出 spawn instruction（供调用方读取）

用法：python3 scripts/non-alt-classifier.py
"""

import json
import subprocess
import os

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROXY_URL = os.environ.get("PROXY_URL", "http://127.0.0.1:7890")
PENDING_PATH = os.path.join(WORKSPACE, "scripts", "_non-alt-pending.json")
NON_ALT_PATH = os.path.join(WORKSPACE, "data", "non-alt-list.json")

# 已加载的非山寨名单（分类时跳过）
existing_non_alts = set()
if os.path.exists(NON_ALT_PATH):
    with open(NON_ALT_PATH) as f:
        existing_non_alts = set(json.load(f).get("non_alts", []))

# 已加载的黑名单
BLACKLIST_PATH = os.path.join(WORKSPACE, "data", "altcoin-blacklist.json")
existing_blacklist = set()
if os.path.exists(BLACKLIST_PATH):
    with open(BLACKLIST_PATH) as f:
        existing_blacklist = set(json.load(f).get("blacklist", []))

# 已有活跃周期的币种
import glob
active_dir = os.path.join(WORKSPACE, "active")
active_coins = set()
for d in glob.glob(os.path.join(active_dir, "alt-*")):
    basename = os.path.basename(d)
    # alt-DOGE-20260503-1200 → DOGE
    parts = basename.split("-", 2)
    if len(parts) >= 2:
        active_coins.add(parts[1])

print(f"[extract] 已有非山寨名单: {len(existing_non_alts)} 个")
print(f"[extract] 已有黑名单: {len(existing_blacklist)} 个")
print(f"[extract] 活跃周期币种: {len(active_coins)} 个")

# 获取全量 tickers
print(f"[extract] 正在获取 OKX SWAP tickers...")
result = subprocess.run(
    ["curl", "-s", "--max-time", "15", "--proxy", PROXY_URL,
     "https://www.okx.com/api/v5/market/tickers?instType=SWAP"],
    capture_output=True, text=True, timeout=20
)

data = json.loads(result.stdout)
if data.get("code") != "0":
    print(f"[extract] ⛔ ERROR: API 返回错误 - {data.get('msg')}")
    exit(1)

tickers = data.get("data", [])
usdt_swaps = [t for t in tickers if t.get("instId", "").endswith("-USDT-SWAP")]
print(f"[extract] 全量 USDT-SWAP 合约: {len(usdt_swaps)} 个")

# 去重提取币种名
coins = set()
coin_info = {}
for t in usdt_swaps:
    inst_id = t["instId"]
    coin = inst_id.replace("-USDT-SWAP", "")
    if coin not in coins:
        coins.add(coin)
        coin_info[coin] = {
            "instId": inst_id,
            "last": float(t.get("last", 0)),
            "vol24h": t.get("volCcy24h", "0"),
        }

print(f"[extract] 去重后币种: {len(coins)} 个")

# 过滤掉已有名单的
to_classify = []
for coin in sorted(coins):
    if coin in existing_non_alts:
        continue
    if coin in existing_blacklist:
        continue
    # 活跃周期币种保留（已经在分析中了）
    to_classify.append(coin_info[coin])

print(f"[extract] 需要分类的币种: {len(to_classify)} 个（已排除已有名单和黑名单）")

# 输出待分类列表
with open(PENDING_PATH, "w") as f:
    json.dump(to_classify, f, indent=2, ensure_ascii=False)

print(f"[extract] 待分类列表已保存: {PENDING_PATH}")

# 生成 spawn instruction
coin_names = [c["instId"].replace("-USDT-SWAP", "") for c in to_classify]
print()
print("=" * 60)
print("SPAWN INSTRUCTION:")
print("=" * 60)
print(f"""
请对以下 {len(coin_names)} 个 OKX USDT-SWAP 合约币种进行分类。

分类规则：
- **non-alt（非山寨币）**：股票代币（AAPL/TSLA/NVDA/SOXL等）、商品/贵金属（XAU/XAG/OIL/NG等）、外汇（EUR/GBP/JPY等）、稳定币（USDT/USDC等）、主流币（BTC/ETH/SOL 等）
- **alt（真山寨币）**：有独立区块链生态、链上数据、项目叙事的加密货币代币

判断依据（不确定时用这三条）：
1. 这个代币有独立的区块链/链上数据吗？股票代币没有
2. 这个代币有独立的社区和媒体叙事吗？股票代币的叙事来自公司财报
3. onchainOS 能搜索到链上持有者数据吗？如果预期为空，就不是真山寨币

待分类币种列表：
{', '.join(coin_names)}

请输出 JSON 格式的分类结果：
{{
  "non_alts": ["AAPL", "TSLA", ...],
  "alts": ["PEPE", "DOGE", ...],
  "uncertain": ["XXX"]
}}

分类完成后，请：
1. 将 non_alts 列表追加到 data/non-alt-list.json 的 "non_alts" 数组中（去重）
2. 将 uncertain 币种单独列出，标注不确定的原因
3. 输出汇总统计
""")
