#!/usr/bin/env python3
"""
山寨币扫描引擎 - OI 变化筛选脚本

输入：通过筛A+B+C 的币种列表（stdin JSON）
输出：按加权综合分排序后的结果（stdout JSON）

OI 变化时间窗口：24h

排序规则：
  庄币：纯 |24h涨跌幅| 降序
  普通山寨：纯 OI 增加值（原始值，非绝对值）降序
  归一化：min-max 归一化到 [0,1]，clamp 异常值
  按综合分降序排序，选最高分为 top_pick
"""

import json
import sys
import os
import subprocess

# 代理配置
PROXY_URL = os.environ.get("PROXY_URL", "http://127.0.0.1:7890")

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
        change_pct_24h = coin_data.get('change_pct_24h')  # zhuang 画像
        btc_divergence = coin_data.get('btc_divergence')  # zhuang 画像：BTC 偏离度
        idx = coin_data.get('idx')
        
        oi_data = fetch_oi_change(coin)
        
        result = {
            "coin": coin,
            "change_pct": change_pct,
            "change_pct_24h": change_pct_24h,
            "btc_divergence": btc_divergence,
            "idx": idx,
            "oi_change_pct": oi_data.get('oi_change_pct'),
            "oi_current": oi_data.get('oi_current'),
            "oi_24h_ago": oi_data.get('oi_24h_ago'),
            "oi_error": oi_data.get('error')
        }
        
        results.append(result)
    
    # ═══ 归一化加权排序 ═══
    # 庄币画像（有 change_pct_24h + btc_divergence）：纯 |24h涨跌幅| 评分
    # 普通山寨画像：双因子 |涨跌幅| + |OI|
    valid = [r for r in results if r['oi_change_pct'] is not None]
    has_24h = valid and all(r.get('change_pct_24h') is not None for r in valid)
    has_btc_div = has_24h and valid and all(r.get('btc_divergence') is not None for r in valid)
    
    if has_btc_div:
        # 庄币：纯按 |24h涨跌幅| 评分（OI/BTC偏离仅作参考信息，不参与评分）
        abs_vals_24h = [abs(v['change_pct_24h'] or 0) for v in valid]
        max_24h = max(abs_vals_24h)
        min_24h = min(abs_vals_24h)
        
        for r in results:
            if r['oi_change_pct'] is None:
                r['composite_score'] = 0
                continue
            abs_v = abs(r.get('change_pct_24h', 0) or 0)
            norm_v = (abs_v - min_24h) / (max_24h - min_24h) if max_24h != min_24h else 1.0
            r['composite_score'] = round(norm_v, 4)
            r['norm_details'] = {'change_pct_24h': round(norm_v, 4)}
        
        results.sort(key=lambda x: x.get('composite_score', 0), reverse=True)
    elif has_24h:
        # 三因子：⅓|4h| + ⅓|24h| + ⅓|OI|
        factors = [
            ('change_pct', 1/3),
            ('change_pct_24h', 1/3),
            ('oi_change_pct', 1/3),
        ]
        
        for r in results:
            if r['oi_change_pct'] is None:
                r['composite_score'] = 0
                continue
            
            score = 0.0
            norm_details = {}
            
            for field, weight in factors:
                abs_vals = [abs(v[field] or 0) for v in valid if v.get(field) is not None]
                if not abs_vals:
                    continue
                max_val = max(abs_vals)
                min_val = min(abs_vals)
                
                abs_v = abs(r.get(field, 0) or 0)
                norm_v = (abs_v - min_val) / (max_val - min_val) if max_val != min_val else 1.0
                norm_v = max(0.0, min(1.0, norm_v))
                
                score += weight * norm_v
                norm_details[field] = round(norm_v, 4)
            
            r['composite_score'] = round(score, 4)
            r['norm_details'] = norm_details
        
        results.sort(key=lambda x: x.get('composite_score', 0), reverse=True)
    else:
        # 普通山寨：按 OI 增加值（原始值，非绝对值）降序
        for r in results:
            if r['oi_change_pct'] is None:
                r['composite_score'] = -9999
            else:
                r['composite_score'] = r['oi_change_pct']
        results.sort(key=lambda x: x.get('composite_score', -9999), reverse=True)
    
    # 选出 top_pick（综合分最高）
    top_pick = None
    for item in results:
        if item.get('composite_score') is not None and item.get('composite_score') != -9999:
            fields = {
                "coin": item['coin'],
                "composite_score": item['composite_score'],
                "change_pct": item['change_pct'],
                "oi_change_pct": item['oi_change_pct'],
            }
            if has_24h:
                fields["change_pct_24h"] = item.get('change_pct_24h')
            if has_btc_div:
                fields["btc_divergence"] = item.get('btc_divergence')
            top_pick = fields
            break
    
    # 输出结果
    output = {
        "ranked": results,
        "top_pick": top_pick
    }
    
    print(json.dumps(output, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
