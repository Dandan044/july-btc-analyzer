#!/bin/bash
# 市场快报 - 数据采集一体化脚本
# 单次执行采集所有需要的数据，过滤低量币种后输出给 LLM
# Usage: bash scripts/market-brief-collect.sh

set -e
PROXY="${PROXY_URL:-http://127.0.0.1:7890}"
WORKDIR="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p /tmp/market-brief

echo "=== [$(date '+%H:%M:%S')] 数据采集开始 ==="

# ── 1. OKX 全量行情 ──
echo "[1/5] 获取全量行情..."
curl -s --max-time 20 --proxy "$PROXY" \
  'https://www.okx.com/api/v5/market/tickers?instType=SPOT' \
  -o /tmp/market-brief/tickers.json
echo "  $(wc -c < /tmp/market-brief/tickers.json) bytes"

# ── 2. 恐惧贪婪 ──
echo "[2/5] 获取恐惧贪婪..."
curl -s --max-time 15 'https://api.alternative.me/fng/?limit=3' \
  -o /tmp/market-brief/fng.json
echo "  OK"

# ── 3. BTC 衍生品 (并行) ──
echo "[3/5] 获取 BTC 衍生品..."
curl -s --max-time 10 --proxy "$PROXY" \
  'https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP' \
  -o /tmp/market-brief/funding.json &
curl -s --max-time 10 --proxy "$PROXY" \
  'https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP' \
  -o /tmp/market-brief/oi.json &
curl -s --max-time 10 --proxy "$PROXY" \
  'https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1D' \
  -o /tmp/market-brief/ls.json &
wait
echo "  OK"

# ── 4. BTC 1H K线 (近6根) ──
echo "[4/5] 获取 BTC 1H K线..."
curl -s --max-time 10 --proxy "$PROXY" \
  'https://www.okx.com/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=1H&limit=6' \
  -o /tmp/market-brief/klines.json
echo "  OK"

# ── 5. 数据处理与摘要输出 ──
echo "[5/5] 加工数据..."
python3 "$WORKDIR/scripts/market-brief-process.py" /tmp/market-brief

echo "=== [$(date '+%H:%M:%S')] 数据采集完成 ==="
