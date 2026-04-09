#!/usr/bin/env python3
"""
多时间框架斐波那契分析 - 波动率分段方案
"""

import requests
import json
from datetime import datetime
from typing import Dict, List, Tuple

# CryptoCompare API (无需代理)
CRYPTOCOMPARE_API = "https://min-api.cryptocompare.com/data/v2/histo"

def get_ohlcv(symbol: str = "BTC", currency: str = "USDT", limit: int = 100, 
              aggregate: int = 1, timeframe: str = "day") -> List[Dict]:
    """
    获取 OHLCV 数据
    
    timeframe: "day", "hour" (4h 需要aggregate=4)
    """
    endpoint = f"{CRYPTOCOMPARE_API}{timeframe}"
    
    params = {
        "fsym": symbol,
        "tsym": currency,
        "limit": limit,
        "aggregate": aggregate
    }
    
    try:
        resp = requests.get(endpoint, params=params, timeout=10)
        data = resp.json()
        
        if data.get("Response") == "Error":
            print(f"API Error: {data.get('Message')}")
            return []
        
        return data.get("Data", {}).get("Data", [])
    except Exception as e:
        print(f"请求失败: {e}")
        return []


def calculate_atr(candles: List[Dict], period: int = 14) -> float:
    """计算平均真实波幅 ATR"""
    if len(candles) < period + 1:
        return 0
    
    true_ranges = []
    for i in range(1, len(candles)):
        high = candles[i]["high"]
        low = candles[i]["low"]
        prev_close = candles[i-1]["close"]
        
        tr = max(
            high - low,
            abs(high - prev_close),
            abs(low - prev_close)
        )
        true_ranges.append(tr)
    
    # 取最近 period 个 TR 的平均值
    if len(true_ranges) >= period:
        atr = sum(true_ranges[-period:]) / period
    else:
        atr = sum(true_ranges) / len(true_ranges) if true_ranges else 0
    
    return atr


def find_swing_points(candles: List[Dict], atr_multiplier: float = 2.5, 
                      min_bars: int = 5) -> Tuple[float, float, int, int]:
    """
    找出有效波段的高低点
    
    返回: (swing_high, swing_low, high_index, low_index)
    """
    if not candles:
        return 0, 0, 0, 0
    
    # 简化版：在给定范围内找极值
    # 更复杂的可以用 ZigZag 算法
    
    high_price = candles[0]["high"]
    low_price = candles[0]["low"]
    high_idx = 0
    low_idx = 0
    
    for i, c in enumerate(candles):
        if c["high"] > high_price:
            high_price = c["high"]
            high_idx = i
        if c["low"] < low_price:
            low_price = c["low"]
            low_idx = i
    
    return high_price, low_price, high_idx, low_idx


def calculate_fibonacci(high: float, low: float) -> Dict[str, float]:
    """计算斐波那契回调位"""
    diff = high - low
    
    return {
        "0%": high,
        "23.6%": high - diff * 0.236,
        "38.2%": high - diff * 0.382,
        "50.0%": high - diff * 0.5,
        "61.8%": high - diff * 0.618,
        "78.6%": high - diff * 0.786,
        "100%": low
    }


def get_volatility_level(atr: float, price: float) -> Tuple[str, float]:
    """
    根据波动率确定回撤阈值
    
    返回: (波动率等级, 回撤阈值)
    """
    volatility = atr / price
    
    if volatility > 0.05:
        return "高波动", 0.38
    elif volatility > 0.03:
        return "中等波动", 0.23
    else:
        return "低波动", 0.15


def analyze_timeframe(timeframe: str, candles: List[Dict]) -> Dict:
    """分析单个时间框架"""
    if not candles:
        return None
    
    # 计算 ATR
    atr = calculate_atr(candles)
    
    # 找波段
    swing_high, swing_low, high_idx, low_idx = find_swing_points(candles)
    
    # 波段幅度
    swing_range = swing_high - swing_low
    
    # 当前价格
    current_price = candles[-1]["close"]
    
    # 波动率等级
    vol_level, retrace_threshold = get_volatility_level(atr, current_price)
    
    # 计算斐波那契位
    fib_levels = calculate_fibonacci(swing_high, swing_low)
    
    # 判断趋势方向
    trend = "上升趋势" if high_idx > low_idx else "下降趋势"
    
    # 计算波段持续时间
    duration = abs(high_idx - low_idx)
    
    return {
        "timeframe": timeframe,
        "current_price": current_price,
        "swing_high": swing_high,
        "swing_low": swing_low,
        "swing_range": swing_range,
        "swing_range_pct": (swing_range / swing_low) * 100,
        "atr": atr,
        "volatility": atr / current_price,
        "volatility_level": vol_level,
        "retrace_threshold": retrace_threshold,
        "fib_levels": fib_levels,
        "trend": trend,
        "duration_bars": duration,
        "high_time": datetime.fromtimestamp(candles[high_idx]["time"]).strftime("%Y-%m-%d %H:%M") if high_idx < len(candles) else "N/A",
        "low_time": datetime.fromtimestamp(candles[low_idx]["time"]).strftime("%Y-%m-%d %H:%M") if low_idx < len(candles) else "N/A",
    }


def find_confluence_zones(analyses: List[Dict], tolerance: float = 0.01) -> List[Dict]:
    """
    找出多时间框架重合的斐波那契区域
    
    tolerance: 价格容差（1% = 0.01）
    """
    all_levels = []
    
    for analysis in analyses:
        if not analysis:
            continue
        tf = analysis["timeframe"]
        for level_name, price in analysis["fib_levels"].items():
            all_levels.append({
                "price": price,
                "level": level_name,
                "timeframe": tf
            })
    
    # 按价格排序
    all_levels.sort(key=lambda x: x["price"])
    
    # 找重合区域
    confluence_zones = []
    used = set()
    
    for i, level in enumerate(all_levels):
        if i in used:
            continue
        
        zone = [level]
        used.add(i)
        
        for j in range(i + 1, len(all_levels)):
            if j in used:
                continue
            
            price_diff = abs(all_levels[j]["price"] - level["price"]) / level["price"]
            
            if price_diff <= tolerance and all_levels[j]["timeframe"] != level["timeframe"]:
                zone.append(all_levels[j])
                used.add(j)
        
        # 至少2个不同时间框架才算有效重合
        timeframes = set(item["timeframe"] for item in zone)
        if len(timeframes) >= 2:
            # 计算平均价格
            avg_price = sum(item["price"] for item in zone) / len(zone)
            
            confluence_zones.append({
                "price_range": (
                    min(item["price"] for item in zone),
                    max(item["price"] for item in zone)
                ),
                "avg_price": avg_price,
                "levels": zone,
                "timeframes": list(timeframes),
                "strength": len(timeframes)
            })
    
    # 按强度排序
    confluence_zones.sort(key=lambda x: x["strength"], reverse=True)
    
    return confluence_zones


def format_price(price: float) -> str:
    """格式化价格显示"""
    if price >= 1000:
        return f"${price:,.0f}"
    elif price >= 1:
        return f"${price:,.2f}"
    else:
        return f"${price:,.4f}"


def format_pct(pct: float) -> str:
    """格式化百分比"""
    return f"{pct:.2%}"


def main():
    print("=" * 60)
    print("多时间框架斐波那契分析 - 波动率分段方案")
    print("=" * 60)
    print()
    
    # 获取多周期数据
    print("📊 获取数据中...")
    
    # 日线 (100天)
    print("  - 日线数据 (100天)...")
    daily_data = get_ohlcv(limit=100, timeframe="day")
    
    # 4小时 (100根 = ~16天)
    print("  - 4小时数据 (100根)...")
    h4_data = get_ohlcv(limit=100, aggregate=4, timeframe="hour")
    
    # 周线 (52周)
    print("  - 周线数据 (52周)...")
    weekly_data = get_ohlcv(limit=52, timeframe="day", aggregate=7)
    
    # 分析各时间框架
    analyses = []
    
    if daily_data:
        print("\n📈 分析日线...")
        daily_analysis = analyze_timeframe("日线", daily_data)
        analyses.append(daily_analysis)
        
        print(f"  波段: {format_price(daily_analysis['swing_low'])} → {format_price(daily_analysis['swing_high'])}")
        print(f"  波段幅度: {daily_analysis['swing_range_pct']:.1f}%")
        print(f"  ATR: {format_price(daily_analysis['atr'])}")
        print(f"  波动率: {daily_analysis['volatility']:.2%} ({daily_analysis['volatility_level']})")
        print(f"  趋势: {daily_analysis['trend']}")
    
    if h4_data:
        print("\n📈 分析4小时...")
        h4_analysis = analyze_timeframe("4小时", h4_data)
        analyses.append(h4_analysis)
        
        print(f"  波段: {format_price(h4_analysis['swing_low'])} → {format_price(h4_analysis['swing_high'])}")
        print(f"  波段幅度: {h4_analysis['swing_range_pct']:.1f}%")
        print(f"  ATR: {format_price(h4_analysis['atr'])}")
        print(f"  波动率: {h4_analysis['volatility']:.2%} ({h4_analysis['volatility_level']})")
        print(f"  趋势: {h4_analysis['trend']}")
    
    if weekly_data:
        print("\n📈 分析周线...")
        weekly_analysis = analyze_timeframe("周线", weekly_data)
        analyses.append(weekly_analysis)
        
        print(f"  波段: {format_price(weekly_analysis['swing_low'])} → {format_price(weekly_analysis['swing_high'])}")
        print(f"  波段幅度: {weekly_analysis['swing_range_pct']:.1f}%")
        print(f"  ATR: {format_price(weekly_analysis['atr'])}")
        print(f"  波动率: {weekly_analysis['volatility']:.2%} ({weekly_analysis['volatility_level']})")
        print(f"  趋势: {weekly_analysis['trend']}")
    
    # 输出各时间框架斐波那契位
    print("\n" + "=" * 60)
    print("斐波那契回调位")
    print("=" * 60)
    
    for analysis in analyses:
        if not analysis:
            continue
        
        print(f"\n【{analysis['timeframe']}】")
        print(f"  当前价格: {format_price(analysis['current_price'])}")
        print(f"  波段: {format_price(analysis['swing_low'])} (低) → {format_price(analysis['swing_high'])} (高)")
        print(f"  趋势: {analysis['trend']}")
        print()
        print("  斐波那契位:")
        for level_name, price in analysis['fib_levels'].items():
            # 计算距离当前价格的百分比
            dist = (price - analysis['current_price']) / analysis['current_price'] * 100
            dist_str = f"+{dist:.1f}%" if dist > 0 else f"{dist:.1f}%"
            marker = " ← 当前" if level_name == "0%" else ""
            print(f"    {level_name:>6}: {format_price(price):>12} ({dist_str}){marker}")
    
    # 找重合区域
    print("\n" + "=" * 60)
    print("多时间框架确认区域 (重合强度)")
    print("=" * 60)
    
    confluence = find_confluence_zones(analyses, tolerance=0.015)  # 1.5% 容差
    
    if confluence:
        for i, zone in enumerate(confluence, 1):
            price_low = format_price(zone['price_range'][0])
            price_high = format_price(zone['price_range'][1])
            avg = format_price(zone['avg_price'])
            
            print(f"\n📍 区域 {i}: {price_low} ~ {price_high}")
            print(f"   平均价格: {avg}")
            print(f"   重合强度: {'⭐' * zone['strength']} ({zone['strength']} 个时间框架)")
            print(f"   包含:")
            for item in zone['levels']:
                print(f"     - {item['timeframe']}: {item['level']} @ {format_price(item['price'])}")
    else:
        print("\n⚠️ 未发现明显的多时间框架重合区域")
    
    # 当前价格相对位置
    if analyses:
        current = analyses[0]['current_price']
        print(f"\n💰 当前价格: {format_price(current)}")
        print("\n相对各时间框架斐波那契位的位置:")
        
        for analysis in analyses:
            if not analysis:
                continue
            
            # 找到当前价格最接近的斐波那契位
            fib = analysis['fib_levels']
            closest_level = min(fib.keys(), key=lambda x: abs(fib[x] - current))
            
            print(f"  {analysis['timeframe']}: 接近 {closest_level} 位 ({format_price(fib[closest_level])})")
    
    print("\n" + "=" * 60)
    
    # 返回 JSON 数据供后续使用
    result = {
        "analyses": analyses,
        "confluence_zones": confluence,
        "timestamp": datetime.now().isoformat()
    }
    
    # 保存结果
    output_file = "/home/administrator/.openclaw/july-btc-analyzer/data/fibonacci_analysis.json"
    with open(output_file, "w") as f:
        json.dump(result, f, indent=2, default=str)
    print(f"\n📁 分析结果已保存到: {output_file}")
    
    return result


if __name__ == "__main__":
    main()