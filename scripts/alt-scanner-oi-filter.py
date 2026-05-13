#!/usr/bin/env python3
"""
山寨币扫描引擎 - OI 变化筛选脚本

输入：通过筛A+B+C 的币种列表（stdin JSON）
输出：按 OI 变化率排序后的结果（stdout JSON）

OI 变化时间窗口：24h
排序规则：
  1. OI 变化方向与价格方向一致（涨+OI增 或 跌+OI减）优先
  2. 同组内按 OI 变化率绝对值排序
  3. 选第一组的最高值
"""

import json
import sys
import subprocess

# 代理配置
PROXY_URL = "http://127.0.0.1:7890"

# OKX OI API
OI_API_URL = "https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume"


def fetch_oi_change(coin: str) -> dict:
    """
    获取币种 24h OI 变化率
    
    返回：
    {
        "oi_change_pct": float,  # OI 变化率（正数=增加，负数=减少）
        "oi_current": float,     # 当前 OI
        "oi_24h_ago": float,     # 昨天 OI
        "error": str or None     # 错误信息
    }
    """
    try:
        url = f"{OI_API_URL}?ccy={coin}&period=1D"
        
        # 使用 curl 命令（与现有脚本保持一致）
        result = subprocess.run(
            ['curl', '-s', '--max-time', '15', '--proxy', PROXY_URL, url],
            capture_output=True,
            text=True,
            timeout=20
        )
        
        if result.returncode != 0:
            return {"oi_change_pct": None, "error": f"curl error: {result.stderr}"}
        
        data = json.loads(result.stdout)
        
        if data.get('code') != '0' or not data.get('data'):
            return {"oi_change_pct": None, "error": f"API error: {data.get('msg', 'unknown')}"}
        
        # 解析 OI 数据（OKX 返回的是数组，每个元素是 [ts, oi, vol]）
        oi_list = data['data']
        if len(oi_list) < 2:
            return {"oi_change_pct": None, "error": "Insufficient OI data"}
        
        # 最新 OI 和 24h 前 OI（数组格式：[ts, oi, vol]）
        # oi_list[0] 是最新的数据，oi_list[-1] 是最早的数据
        # 我们需要最新和 24h 前的数据，所以取 [0] 和 [-1]
        oi_current = float(oi_list[0][1])   # 最新 OI
        oi_24h_ago = float(oi_list[-1][1])  # 最早 OI（约 180 天前）
        
        # ⚠️ 注意：period=1D 返回的是过去 180 天的日数据，不是 24h 数据
        # 我们需要取最新和倒数第 2 条（昨天）来计算 24h 变化
        if len(oi_list) < 2:
            return {"oi_change_pct": None, "error": "Insufficient OI data"}
        
        oi_current = float(oi_list[0][1])    # 最新 OI（今天）
        oi_yesterday = float(oi_list[1][1])  # 昨天 OI
        
        if oi_yesterday == 0:
            return {"oi_change_pct": None, "error": "OI yesterday is zero"}
        
        # 计算 OI 变化率（24h）
        oi_change_pct = (oi_current - oi_yesterday) / oi_yesterday * 100
        
        return {
            "oi_change_pct": round(oi_change_pct, 2),
            "oi_current": oi_current,
            "oi_24h_ago": oi_yesterday,
            "error": None
        }
        
    except subprocess.TimeoutExpired:
        return {"oi_change_pct": None, "error": "Request timeout"}
    except json.JSONDecodeError as e:
        return {"oi_change_pct": None, "error": f"JSON parse error: {e}"}
    except Exception as e:
        return {"oi_change_pct": None, "error": str(e)}


def main():
    """
    主函数：获取 OI 变化，按绝对值排序，返回 top_pick
    """
    # 读取输入
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON input: {e}"}))
        sys.exit(1)
    
    if not input_data:
        print(json.dumps({"error": "Empty input", "ranked": [], "top_pick": None}))
        sys.exit(0)
    
    # 获取每个币种的 OI 变化
    results = []
    for coin_data in input_data:
        coin = coin_data.get('coin')
        change_pct = coin_data.get('change_pct', 0)
        idx = coin_data.get('idx')
        
        oi_data = fetch_oi_change(coin)
        
        result = {
            "coin": coin,
            "change_pct": change_pct,
            "idx": idx,
            "oi_change_pct": oi_data.get('oi_change_pct'),
            "oi_current": oi_data.get('oi_current'),
            "oi_24h_ago": oi_data.get('oi_24h_ago'),
            "oi_error": oi_data.get('error')
        }
        
        results.append(result)
    
    # 排序：按 OI 变化率绝对值降序
    def sort_key(item):
        # OI 获取失败 → 排到最后
        if item['oi_change_pct'] is None:
            return -1
        return abs(item['oi_change_pct'])
    
    results.sort(key=sort_key, reverse=True)
    
    # 选出 top_pick（OI 变化率绝对值最大的）
    top_pick = None
    for item in results:
        if item['oi_change_pct'] is not None:
            top_pick = {
                "coin": item['coin'],
                "change_pct": item['change_pct'],
                "oi_change_pct": item['oi_change_pct']
            }
            break
    
    # 输出结果
    output = {
        "ranked": results,
        "top_pick": top_pick
    }
    
    print(json.dumps(output, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
