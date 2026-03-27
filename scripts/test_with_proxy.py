#!/usr/bin/env python3
"""
通过 gost 代理测试 Binance API
"""

import subprocess
import time
import requests
import sys

# Trojan + WebSocket 节点配置 - 英国节点
TROJAN_SERVER = "141.193.213.221"
TROJAN_PORT = 443
TROJAN_PASSWORD = "a4eb5537-9523-4248-9c48-3e940f4410e5"
TROJAN_SNI = "ukhh7uufxlcbr2hbym.jjjiedian6j4tblb.com"
WS_PATH = "/images"
WS_HOST = "ukhh7uufxlcbr2hbym.jjjiedian6j4tblb.com"

# 本地代理端口
LOCAL_PORT = 7890

def start_gost():
    """启动 gost 代理 (Trojan + WebSocket)"""
    # 先停止可能存在的进程
    subprocess.run(["pkill", "-9", "-f", "gost"], capture_output=True)
    time.sleep(1)
    
    # gost v3 的 trojan+ws 配置格式
    # trojan+ws://password@server:port?sni=xxx&path=xxx&host=xxx
    forward = f"trojan+ws://{TROJAN_PASSWORD}@{TROJAN_SERVER}:{TROJAN_PORT}?sni={TROJAN_SNI}&path={WS_PATH}&host={WS_HOST}"
    
    cmd = [
        "gost", 
        f"-L=:{LOCAL_PORT}",
        f"-F={forward}"
    ]
    
    print(f"启动 gost: gost -L=:{LOCAL_PORT} -F=trojan+ws://...")
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    time.sleep(3)
    
    return proc

def test_binance():
    """测试 Binance API"""
    proxies = {
        "http": f"http://127.0.0.1:{LOCAL_PORT}",
        "https": f"http://127.0.0.1:{LOCAL_PORT}"
    }
    
    print(f"\n使用代理: http://127.0.0.1:{LOCAL_PORT}")
    
    # 测试 1: 获取 IP
    print("\n--- 测试 IP ---")
    try:
        resp = requests.get("https://api.ipify.org", proxies=proxies, timeout=15)
        print(f"当前 IP: {resp.text}")
    except Exception as e:
        print(f"IP 测试失败: {e}")
        return False
    
    # 测试 2: Binance 时间
    print("\n--- 测试 Binance API ---")
    try:
        resp = requests.get("https://fapi.binance.com/fapi/v1/time", proxies=proxies, timeout=15)
        print(f"Binance 时间: {resp.json()}")
    except Exception as e:
        print(f"Binance 时间失败: {e}")
        return False
    
    # 测试 3: 资金费率
    print("\n--- 资金费率 ---")
    try:
        resp = requests.get(
            "https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=5",
            proxies=proxies, timeout=15
        )
        data = resp.json()
        for item in data:
            print(f"  时间: {item['fundingTime']}, 费率: {item['fundingRate']}")
    except Exception as e:
        print(f"资金费率失败: {e}")
        return False
    
    # 测试 4: 持仓量
    print("\n--- 持仓量 ---")
    try:
        resp = requests.get(
            "https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT",
            proxies=proxies, timeout=15
        )
        print(f"BTCUSDT 持仓量: {resp.json()}")
    except Exception as e:
        print(f"持仓量失败: {e}")
        return False
    
    # 测试 5: 多空比
    print("\n--- 大户多空比 ---")
    try:
        resp = requests.get(
            "https://fapi.binance.com/futures/data/topLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=3",
            proxies=proxies, timeout=15
        )
        data = resp.json()
        for item in data:
            print(f"  时间: {item['timestamp']}, 多: {item['longAccount']}, 空: {item['shortAccount']}")
    except Exception as e:
        print(f"多空比失败: {e}")
    
    return True

def main():
    print("="*60)
    print("Binance API 代理测试")
    print("="*60)
    
    # 启动代理
    gost_proc = start_gost()
    
    try:
        success = test_binance()
        if success:
            print("\n✅ 测试成功！")
        else:
            print("\n❌ 部分测试失败")
    finally:
        # 停止代理
        print("\n停止 gost...")
        gost_proc.terminate()
        gost_proc.wait()

if __name__ == "__main__":
    main()