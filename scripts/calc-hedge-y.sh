#!/bin/bash
# calc-hedge-y.sh — bash wrapper，输出 y 值到 stdout
# 用法: bash scripts/calc-hedge-y.sh long  → 输出 "1.312"
#       bash scripts/calc-hedge-y.sh short → 输出 "0.688"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIRECTION="${1:-}"

if [ -z "$DIRECTION" ]; then
  echo "Usage: calc-hedge-y.sh long|short" >&2
  exit 1
fi

cd "$SCRIPT_DIR/.."
node scripts/calc-hedge-y.js --direction "$DIRECTION" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['y'])"
