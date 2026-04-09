#!/bin/bash
# OKX CLI 代理 wrapper
# 使用 proxychains4 强制通过代理访问OKX API

proxychains4 -q /home/administrator/.npm-global/bin/okx "$@"