#!/bin/bash
# calc-alt-hedge-y.sh — bash wrapper，输出 y 值和 JSON
# 用法: bash scripts/calc-alt-hedge-y.sh ETH long bearish
#       输出 y 值到 stdout

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COIN="${1:-}"
DIRECTION="${2:-}"
BTC_TREND="${3:-}"

if [ -z "$COIN" ] || [ -z "$DIRECTION" ] || [ -z "$BTC_TREND" ]; then
  echo "Usage: calc-alt-hedge-y.sh <coin> <long|short> <bullish|bearish|sideways>" >&2
  exit 1
fi

cd "$SCRIPT_DIR/.."
node scripts/calc-alt-hedge-y.js --coin "$COIN" --direction "$DIRECTION" --btc-trend "$BTC_TREND" 2>/dev/null
