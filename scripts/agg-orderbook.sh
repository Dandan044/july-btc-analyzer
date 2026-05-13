#!/bin/bash
# 订单簿聚合工具
# 用法: ./agg-orderbook.sh <instId> [步长] [上下层数]
# 示例: ./agg-orderbook.sh BTC-USDT 100 10
#       ./agg-orderbook.sh ETH-USDT 5 15
#       ./agg-orderbook.sh SOL-USDT-SWAP 0.5 10

INST_ID="${1:-BTC-USDT}"
STEP="${2:-100}"
LAYERS="${3:-10}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

node "$SCRIPT_DIR/agg-orderbook.js" "$INST_ID" "$STEP" "$LAYERS"
