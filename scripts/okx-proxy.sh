#!/bin/bash
# OKX CLI 代理 wrapper
# 通过代理访问 OKX API（国内网络必需）
# 使用方式: ./okx-proxy.sh --profile live account balance

# 获取 OKX CLI 实际路径
OKX_BIN=$(which okx || echo "/usr/local/bin/okx")

# 代理端口（从环境变量或默认值）
PROXY_HOST="127.0.0.1"
PROXY_PORT="${HTTP_PROXY_PORT:-7890}"

# 使用 proxychains4 强制通过代理
proxychains4 -q "$OKX_BIN" "$@"