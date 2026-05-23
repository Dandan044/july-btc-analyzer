#!/bin/bash
# switch-stage2-mode.sh — 切换山寨币阶段二版本
# 用法: bash switch-stage2-mode.sh [normal|aggressive]

MODE=${1:-status}
LINK="$HOME/.openclaw/july-btc-analyzer/tasks/alt-pipeline/alt-intel-stage2.live.md"

case "$MODE" in
  normal)
    ln -sf alt-intel-stage2.md "$LINK"
    echo "✅ 阶段二 → 正常版 (alt-intel-stage2.md)"
    echo "   读取 TRADE_LESSONS.md | 逻辑否定点比值<0.5放弃 | ATR>25% REJECT"
    ;;
  aggressive)
    ln -sf alt-intel-stage2-aggressive.md "$LINK"
    echo "✅ 阶段二 → 激进版 (alt-intel-stage2-aggressive.md)"
    echo "   跳过 TRADE_LESSONS | 无逻辑否定点约束 | ATR>35% REJECT"
    ;;
  status)
    TARGET=$(readlink "$LINK")
    if [[ "$TARGET" == *"aggressive"* ]]; then
      echo "当前: 激进版 (alt-intel-stage2-aggressive.md)"
    else
      echo "当前: 正常版 (alt-intel-stage2.md)"
    fi
    ;;
  *)
    echo "用法: bash switch-stage2-mode.sh [normal|aggressive|status]"
    exit 1
    ;;
esac
