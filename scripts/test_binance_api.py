#!/usr/bin/env python3
"""
Binance API 测试脚本
测试各种交易侧数据接口的可用性

用法: python test_binance_api.py [--proxy http://127.0.0.1:7890]
"""

import argparse
import json
import time
from datetime import datetime

try:
    import requests
except ImportError:
    print("请先安装 requests: pip install requests")
    exit(1)

# Binance API 端点
SPOT_BASE = "https://api.binance.com"
FUTURES_BASE = "https://fapi.binance.com"

def test_api(name, url, session, timeout=10):
    """测试单个 API 端点"""
    print(f"\n{'='*60}")
    print(f"测试: {name}")
    print(f"URL: {url}")
    print("-" * 60)
    
    try:
        start = time.time()
        resp = session.get(url, timeout=timeout)
        elapsed = (time.time() - start) * 1000
        
        print(f"状态码: {resp.status_code}")
        print(f"响应时间: {elapsed:.0f}ms")
        
        if resp.status_code == 200:
            data = resp.json()
            print(f"响应数据 (截取前500字符):")
            print(json.dumps(data, indent=2, ensure_ascii=False)[:500])
            return True, data
        else:
            print(f"错误响应: {resp.text[:200]}")
            return False, None
            
    except requests.exceptions.Timeout:
        print("❌ 请求超时")
        return False, None
    except requests.exceptions.ConnectionError as e:
        print(f"❌ 连接错误: {str(e)[:100]}")
        return False, None
    except Exception as e:
        print(f"❌ 其他错误: {str(e)[:100]}")
        return False, None


def main():
    parser = argparse.ArgumentParser(description="Binance API 测试脚本")
    parser.add_argument("--proxy", help="代理地址，如 http://127.0.0.1:7890")
    parser.add_argument("--timeout", type=int, default=15, help="请求超时时间(秒)")
    args = parser.parse_args()
    
    # 配置 session
    session = requests.Session()
    if args.proxy:
        session.proxies = {
            "http": args.proxy,
            "https": args.proxy
        }
        print(f"使用代理: {args.proxy}")
    
    print(f"\n{'#'*60}")
    print(f"Binance API 可用性测试")
    print(f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'#'*60}")
    
    results = []
    
    # ========== 现货 API ==========
    print("\n" + "="*60)
    print("现货 API (Spot)")
    print("="*60)
    
    # 1. 服务器时间
    ok, _ = test_api(
        "服务器时间",
        f"{SPOT_BASE}/api/v3/time",
        session, args.timeout
    )
    results.append(("服务器时间", ok))
    
    # 2. 24小时行情
    ok, _ = test_api(
        "24小时行情 (BTCUSDT)",
        f"{SPOT_BASE}/api/v3/ticker/24hr?symbol=BTCUSDT",
        session, args.timeout
    )
    results.append(("24小时行情", ok))
    
    # ========== 合约 API ==========
    print("\n" + "="*60)
    print("永续合约 API (Futures)")
    print("="*60)
    
    # 3. 合约服务器时间
    ok, _ = test_api(
        "合约服务器时间",
        f"{FUTURES_BASE}/fapi/v1/time",
        session, args.timeout
    )
    results.append(("合约服务器时间", ok))
    
    # 4. 资金费率历史
    ok, _ = test_api(
        "资金费率历史 (最近10条)",
        f"{FUTURES_BASE}/fapi/v1/fundingRate?symbol=BTCUSDT&limit=10",
        session, args.timeout
    )
    results.append(("资金费率历史", ok))
    
    # 5. 当前资金费率
    ok, data = test_api(
        "当前资金费率",
        f"{FUTURES_BASE}/fapi/v1/premiumIndex?symbol=BTCUSDT",
        session, args.timeout
    )
    results.append(("当前资金费率", ok))
    
    # 6. 持仓量
    ok, _ = test_api(
        "持仓量 (Open Interest)",
        f"{FUTURES_BASE}/fapi/v1/openInterest?symbol=BTCUSDT",
        session, args.timeout
    )
    results.append(("持仓量", ok))
    
    # 7. 大户多空比 (账户数)
    ok, _ = test_api(
        "大户多空比 (账户数)",
        f"{FUTURES_BASE}/futures/data/topLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=10",
        session, args.timeout
    )
    results.append(("大户多空比(账户)", ok))
    
    # 8. 大户多空比 (持仓量)
    ok, _ = test_api(
        "大户多空比 (持仓量)",
        f"{FUTURES_BASE}/futures/data/topLongShortPositionRatio?symbol=BTCUSDT&period=5m&limit=10",
        session, args.timeout
    )
    results.append(("大户多空比(持仓)", ok))
    
    # 9. 全市场多空比
    ok, _ = test_api(
        "全市场多空比",
        f"{FUTURES_BASE}/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=10",
        session, args.timeout
    )
    results.append(("全市场多空比", ok))
    
    # 10. 合约K线
    ok, _ = test_api(
        "合约K线 (4小时, 14根)",
        f"{FUTURES_BASE}/fapi/v1/klines?symbol=BTCUSDT&interval=4h&limit=14",
        session, args.timeout
    )
    results.append(("合约K线", ok))
    
    # 11. 合约24小时行情
    ok, _ = test_api(
        "合约24小时行情",
        f"{FUTURES_BASE}/fapi/v1/ticker/24hr?symbol=BTCUSDT",
        session, args.timeout
    )
    results.append(("合约24小时行情", ok))
    
    # 12. 交易员持仓比 (多空情绪)
    ok, _ = test_api(
        "交易员多空持仓比",
        f"{FUTURES_BASE}/futures/data/takerlongshortRatio?symbol=BTCUSDT&period=5m&limit=10",
        session, args.timeout
    )
    results.append(("交易员多空比", ok))
    
    # ========== 结果汇总 ==========
    print("\n" + "="*60)
    print("测试结果汇总")
    print("="*60)
    
    success = sum(1 for _, ok in results if ok)
    total = len(results)
    
    for name, ok in results:
        status = "✅" if ok else "❌"
        print(f"  {status} {name}")
    
    print("-" * 60)
    print(f"成功: {success}/{total}")
    print(f"成功率: {success/total*100:.1f}%")


if __name__ == "__main__":
    main()