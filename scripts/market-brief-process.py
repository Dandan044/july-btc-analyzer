#!/usr/bin/env python3
"""市场快报数据处理 — 读取原始 API 数据，输出结构化 JSON 和摘要"""
import json, sys, os
from collections import defaultdict
from datetime import datetime, timezone, timedelta

TZ = timezone(timedelta(hours=8))
DATA_DIR = sys.argv[1] if len(sys.argv) > 1 else '/tmp/market-brief'

def load_json(name):
    with open(os.path.join(DATA_DIR, name)) as f:
        return json.load(f)

# ── 板块映射 ──
SECTORS = {
    "L1 竞争链": ["SOL","AVAX","NEAR","SUI","APT","INJ","SEI","TIA","DOT","ATOM","ADA","TRX","ICP","ALGO","XLM","HBAR","TON","HYPE","ETC","FLOW","MINA","ASTR","IOTA","ONT","ZIL","ICX","WAXP","CELR","ZETA"],
    "L2 扩容": ["ARB","OP","STRK","ZK","METIS","IMX","SCR","LRC","CELO","POL","SKL"],
    "DeFi 蓝筹": ["AAVE","UNI","CRV","COMP","SNX","LDO","ENA","EIGEN","PENDLE","SUSHI","1INCH","DYDX","JUP","RAY","JTO","WLFI","LQTY","YFI","BNT"],
    "AI / 数据": ["FET","RENDER","WLD","ARKM","AIXBT","VIRTUAL","IP","AI","PHA","NMR"],
    "Meme 币": ["DOGE","PEPE","WIF","BONK","FLOKI","SHIB","GOAT","MOODENG","TOSHI","TRUMP","PUMP","PENGU","NEIRO","BOME","TURBO"],
    "GameFi": ["SAND","MANA","GALA","RON","AXS","ACE","PIXEL","BIGTIME","APE","CHZ","AGLD","YGG","MAGIC","ILV"],
    "RWA": ["ONDO","CFG","PAXG","XAUT"],
    "基础设施": ["LINK","GRT","BAND","PYTH","API3","TRB"],
    "平台币": ["BNB","OKB","CRO","LEO"],
    "支付": ["XRP","LTC","BCH","ZEC","DASH","CORE","ZEN"],
    "Depin": ["FIL","AR","STORJ","GRASS"],
}

coin_to_sector = {}
for sec, coins in SECTORS.items():
    for c in coins:
        coin_to_sector[c] = sec

# ── 1. 行情处理 ──
tickers_raw = load_json('tickers.json')
all_coins = []
for t in tickers_raw['data']:
    inst_id = t['instId']
    if not inst_id.endswith('-USDT'):
        continue
    coin = inst_id.replace('-USDT', '')
    last = float(t['last'])
    open24 = float(t['open24h'])
    change = (last - open24) / open24 * 100 if open24 > 0 else 0
    vol = float(t.get('volCcy24h', 0))
    all_coins.append({'coin': coin, 'last': last, 'change_pct': round(change, 2), 'vol_usdt': vol})

coin_map = {c['coin']: c for c in all_coins}

# ── 2. 恐惧贪婪 ──
fng_raw = load_json('fng.json')
fng_data = fng_raw['data']
fng_current = int(fng_data[0]['value'])
fng_category = fng_data[0]['value_classification']
fng_prev = int(fng_data[1]['value']) if len(fng_data) > 1 else fng_current
fng_trend = "改善" if fng_current > fng_prev else ("持平" if fng_current == fng_prev else "恶化")

# ── 3. BTC 衍生品 ──
funding_raw = load_json('funding.json')
fr_val = float(funding_raw['data'][0]['fundingRate']) * 100
if fr_val < -0.05: fr_status = "深度负"
elif fr_val < -0.01: fr_status = "偏空"
elif fr_val < 0.01: fr_status = "中性"
elif fr_val < 0.05: fr_status = "温和偏多"
else: fr_status = "过热"

oi_raw = load_json('oi.json')
oi_val = int(float(oi_raw['data'][0]['oi']))  # 张数

ls_raw = load_json('ls.json')
# Rubik returns [[ts, val], ...]
ls_val = float(ls_raw['data'][0][1])
if ls_val < 0.8: ls_status = "偏空"
elif ls_val < 1.2: ls_status = "中性"
elif ls_val < 2.0: ls_status = "偏多"
else: ls_status = "极端看多"

# ── 4. BTC 1H K线走势 ──
k_raw = load_json('klines.json')
klines = sorted(k_raw['data'], key=lambda x: int(x[0]))
k_desc_parts = []
first_open = float(klines[0][1])
last_close = float(klines[-1][4])
total_chg = (last_close - first_open) / first_open * 100
high_6h = max(float(k[2]) for k in klines)
low_6h = min(float(k[3]) for k in klines)

# 分前半段后半段
mid = len(klines) // 2
fh_chg = (float(klines[mid-1][4]) - first_open) / first_open * 100
sh_chg = (last_close - float(klines[mid][1])) / float(klines[mid][1]) * 100

# 生成走势描述
if fh_chg > 1 and sh_chg < -1:
    k_desc = f"前半段震荡上行(+{fh_chg:.1f}%)，后半段持续回落({sh_chg:.1f}%)，收于低点"
elif fh_chg < -1 and sh_chg > 1:
    k_desc = f"前半段下挫({fh_chg:.1f}%)，后半段V型反弹({sh_chg:.1f}%)"
elif total_chg > 1:
    k_desc = f"全时段持续上行，涨幅{total_chg:.1f}%"
elif total_chg < -1:
    k_desc = f"全时段持续下行，跌幅{abs(total_chg):.1f}%"
elif abs(total_chg) < 0.5:
    k_desc = "窄幅横盘，无明显方向"
elif fh_chg > 0 and sh_chg > 0:
    k_desc = f"温和上行{total_chg:.1f}%，前后半段均偏强"
elif fh_chg < 0 and sh_chg < 0:
    k_desc = f"温和下行{abs(total_chg):.1f}%，前后半段均偏弱"
else:
    k_desc = f"冲高回落，整体{total_chg:+.1f}%"

# ── 5. 板块分析 ──
sector_results = []
classified = set()
for coins in SECTORS.values():
    classified.update(coins)

for sec_name, coins in SECTORS.items():
    found = [coin_map[c] for c in coins if c in coin_map]
    if not found:
        continue
    changes = [c['change_pct'] for c in found]
    avg_change = sum(changes) / len(changes)
    up_count = sum(1 for c in changes if c > 0)
    down_count = sum(1 for c in changes if c < 0)
    
    sorted_by_chg = sorted(found, key=lambda x: x['change_pct'], reverse=True)
    top_g = sorted_by_chg[0]
    top_l = sorted_by_chg[-1]
    
    # Score
    if avg_change > 5: score = 8
    elif avg_change > 3: score = 7
    elif avg_change > 2: score = 6
    elif avg_change > 1: score = 5
    elif avg_change > 0.5: score = 4
    elif avg_change > 0.2: score = 2
    elif avg_change > 0: score = 1
    elif avg_change > -0.2: score = -1
    elif avg_change > -0.5: score = -2
    elif avg_change > -1: score = -3
    elif avg_change > -2: score = -4
    elif avg_change > -3: score = -5
    elif avg_change > -5: score = -7
    else: score = -8
    
    desc_parts = []
    if top_g['change_pct'] > 0.5:
        desc_parts.append(f"{top_g['coin']}+{top_g['change_pct']}%居前")
    if top_l['change_pct'] < -0.5:
        desc_parts.append(f"{top_l['coin']}{top_l['change_pct']}%居后")
    if up_count > down_count * 2:
        desc_parts.append("多数上涨")
    elif down_count > up_count * 2:
        desc_parts.append("多数下跌")
    elif up_count == down_count:
        desc_parts.append("涨跌各半")
    elif up_count > down_count:
        desc_parts.append("涨多于跌")
    else:
        desc_parts.append("跌多于涨")
    
    sector_results.append({
        'name': sec_name,
        'score': score,
        'description': '，'.join(desc_parts),
        'avg_change_pct': round(avg_change, 2),
        'up_count': up_count,
        'down_count': down_count,
        'total_count': len(found),
        'top_gainer': {'coin': top_g['coin'], 'change_pct': top_g['change_pct']},
        'top_loser': {'coin': top_l['coin'], 'change_pct': top_l['change_pct']},
    })

sector_results.sort(key=lambda x: x['avg_change_pct'], reverse=True)

# ── 6. 市场整体评分 ──
all_changes = [c['change_pct'] for c in all_coins]
up_total = sum(1 for c in all_changes if c > 0)
down_total = sum(1 for c in all_changes if c < 0)
avg_all = sum(all_changes) / len(all_changes)
pct_up = up_total / len(all_changes) * 100

# 评分
if pct_up > 80 and avg_all > 3: mkt_score = 10
elif pct_up > 75 and avg_all > 2: mkt_score = 8
elif pct_up > 70 and avg_all > 1.5: mkt_score = 7
elif pct_up > 65 and avg_all > 1: mkt_score = 6
elif pct_up > 58 and avg_all > 0.5: mkt_score = 5
elif pct_up > 55: mkt_score = 4
elif pct_up > 52: mkt_score = 2
elif pct_up > 48: mkt_score = 1
elif pct_up > 45: mkt_score = 0
elif pct_up > 40: mkt_score = -1
elif pct_up > 38: mkt_score = -2
elif pct_up > 35: mkt_score = -4
elif pct_up > 30 and avg_all > -2: mkt_score = -5
elif pct_up > 25: mkt_score = -6
elif pct_up > 20: mkt_score = -7
elif pct_up > 15: mkt_score = -8
else: mkt_score = -10

# 高波动修正：如果 6h BTC 振幅 > 3%
btc_range = (high_6h - low_6h) / low_6h * 100
high_vol = btc_range > 3

# ── 7. 涨跌榜 Top10 (过滤低量 $500K) ──
filtered = [c for c in all_coins if c['vol_usdt'] > 500000]
top_gainers = sorted(filtered, key=lambda x: x['change_pct'], reverse=True)[:10]
top_losers = sorted(filtered, key=lambda x: x['change_pct'])[:10]

# ── 8. 主流币摘要 ──
majors = {}
for coin in ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE']:
    if coin in coin_map:
        c = coin_map[coin]
        # 从 K 线推断 6h 变化
        chg_6h = None
        if coin == 'BTC':
            chg_6h = round(total_chg, 2)
        majors[coin] = {
            'price': c['last'],
            'change_24h_pct': c['change_pct'],
            'change_6h_pct': chg_6h,
        }

# ── 9. 输出 ──
output = {
    'summary': {
        'total_coins': len(all_coins),
        'up_pct': round(pct_up, 1),
        'avg_change_pct': round(avg_all, 2),
        'btc_6h_range_pct': round(btc_range, 2),
        'high_volatility': high_vol,
    },
    'btc_kline_6h': {
        'description': k_desc,
        'total_chg_pct': round(total_chg, 2),
        'first_half_chg_pct': round(fh_chg, 2),
        'second_half_chg_pct': round(sh_chg, 2),
        'high': round(high_6h, 2),
        'low': round(low_6h, 2),
        'candles': [{'ts': k[0], 'o': round(float(k[1]),2), 'h': round(float(k[2]),2),
                     'l': round(float(k[3]),2), 'c': round(float(k[4]),2)} for k in klines],
    },
    'fear_greed': {
        'current': fng_current,
        'category': fng_category,
        'trend': fng_trend,
        'prev_value': fng_prev,
    },
    'btc_derivatives': {
        'funding_rate_pct': round(fr_val, 6),
        'funding_status': fr_status,
        'oi_contracts': oi_val,
        'ls_ratio': round(ls_val, 2),
        'ls_status': ls_status,
    },
    'majors': majors,
    'sectors': sector_results,
    'top_gainers': [{'coin': c['coin'], 'sector': coin_to_sector.get(c['coin'], '其他'),
                     'change_pct': c['change_pct']} for c in top_gainers],
    'top_losers': [{'coin': c['coin'], 'sector': coin_to_sector.get(c['coin'], '其他'),
                    'change_pct': c['change_pct']} for c in top_losers],
}

# 保存完整数据给 LLM
out_path = os.path.join(DATA_DIR, 'processed.json')
with open(out_path, 'w') as f:
    json.dump(output, f, ensure_ascii=False, indent=2)

# ── 10. 打印摘要给 LLM ──
print(f"全市场: {len(all_coins)} 币种, {up_total}涨/{down_total}跌, 涨占比{pct_up:.1f}%, 均值{avg_all:+.2f}%")
print(f"BTC 6h: {k_desc}")
print(f"恐惧贪婪: {fng_current}({fng_category}), 前值{fng_prev}, {fng_trend}")
print(f"费率: {fr_val:.4f}%({fr_status}), OI: {oi_val/10000:.1f}万张, 多空比: {ls_val:.2f}({ls_status})")
print(f"市场评分建议: {mkt_score}")
print()

# 板块
for s in sector_results:
    arrow = '🟢' if s['avg_change_pct'] > 1 else ('🟡' if s['avg_change_pct'] > -1 else '🔴')
    print(f"{arrow} {s['name']}: {s['avg_change_pct']:+.2f}% (↑{s['up_count']}↓{s['down_count']}) — {s['description']}")

print()
print("涨幅前10:")
for i, c in enumerate(top_gainers[:10]):
    print(f"  {i+1}. {c['coin']:8s} ({coin_to_sector.get(c['coin'], '其他'):12s}) {c['change_pct']:+.2f}%")
print("跌幅前10:")
for i, c in enumerate(top_losers[:10]):
    print(f"  {i+1}. {c['coin']:8s} ({coin_to_sector.get(c['coin'], '其他'):12s}) {c['change_pct']:+.2f}%")

# 保存得分指导
score_guide = {
    'market_score_suggested': mkt_score,
    'high_volatility': high_vol,
    'score_guidance': "10=普遍强势上涨, 8=强势上涨, 7=明显上涨, 6=普涨, 5=偏强上涨, 4=温和上涨, 2=微涨, 0=基本无波动, -2=微跌, -4=温和下跌, -6=普跌, -7=明显下跌, -8=强势下跌, -10=普遍强势下跌; 特殊: V型反转+3~+5, 倒V-3~-5, 高波动0(标注)"
}
with open(os.path.join(DATA_DIR, 'score-guide.json'), 'w') as f:
    json.dump(score_guide, f, ensure_ascii=False)

print(f"\n完整数据: {out_path}")
