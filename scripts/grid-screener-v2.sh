#!/bin/bash
# 网格策略币种筛选器 V2
# 双画像：做多趋势网格 + 做空趋势网格 + 横盘网格
set -e

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

echo "=== 拉取全市场 SWAP Tickers ===" >&2
okx market tickers SWAP --json 2>/dev/null > "$TMPDIR/all_tickers.json"

COUNT=$(python3 -c "import json; d=json.load(open('$TMPDIR/all_tickers.json')); print(len(d) if isinstance(d,list) else 0)" 2>/dev/null || echo 0)
echo "拉取到 $COUNT 个合约" >&2

export TMPDIR
python3 << 'PYEOF'
import json, subprocess, sys, os, math
from datetime import datetime

TMPDIR = os.environ['TMPDIR']

with open(f"{TMPDIR}/all_tickers.json") as f:
    tickers = json.load(f)

if not isinstance(tickers, list) or len(tickers) < 50:
    print("ERROR: ticker 数据不足", file=sys.stderr)
    sys.exit(1)

MIN_VOL_USDT = 3_000_000  # 300万 USDT（放宽一些）

# ============ 初筛 ============
candidates = []
for t in tickers:
    vol = float(t.get('volCcy24h', 0))
    if vol < MIN_VOL_USDT:
        continue
    if '-USDT-SWAP' not in t.get('instId', ''):
        continue
    name = t['instId'].replace('-USDT-SWAP', '')
    # 排除非加密
    skip = {'XPD','XAG','XAU','XPT','SOXL','SOXS','HPE','DELL','MSFT','AAPL','TSLA','NVDA','GOOGL','AMZN','META','NFLX',
            'AMD','INTC','CSCO','ORCL','IBM','QCOM','BABA','JD','PDD','BIDU','NIO','XPEV','LI',
            'UBER','LYFT','SNAP','PYPL','SQ','COIN','MSTR','MARA','RIOT','CLSK'}
    if name in skip:
        continue
    
    high = float(t.get('high24h', 0))
    low = float(t.get('low24h', 0))
    open24 = float(t.get('open24h', 0))
    last = float(t.get('last', 0))
    if low <= 0 or high <= 0 or open24 <= 0:
        continue
    
    amplitude = (high - low) / open24 * 100
    change = (last - open24) / open24 * 100
    
    candidates.append({
        'instId': t['instId'],
        'name': name,
        'last': last,
        'amplitude': round(amplitude, 2),
        'change24h': round(change, 2),
        'volCcy24h': vol,
    })

candidates.sort(key=lambda x: x['volCcy24h'], reverse=True)
candidates = candidates[:60]
print(f"初筛：成交量 ≥ {MIN_VOL_USDT/1e6:.0f}M USDT → {len(candidates)} 个 (限前60)", file=sys.stderr)

# ============ K线 + 费率获取 ============
def fetch_candles(instId, bar='4H', limit=48):
    try:
        result = subprocess.run(
            ['okx', 'market', 'candles', instId, '--bar', bar, '--limit', str(limit), '--json'],
            capture_output=True, text=True, timeout=20
        )
        data = json.loads(result.stdout)
        candles = data.get('data', data) if isinstance(data, dict) else data
        if isinstance(candles, list) and len(candles) > 0 and isinstance(candles[0], list):
            return candles
        return []
    except:
        return []

def fetch_funding(instId):
    try:
        result = subprocess.run(
            ['okx', 'market', 'funding-rate', instId, '--json'],
            capture_output=True, text=True, timeout=15
        )
        data = json.loads(result.stdout)
        items = data.get('data', data) if isinstance(data, dict) else data
        if isinstance(items, list) and len(items) > 0:
            fr = items[0]
            return float(fr.get('fundingRate', fr.get('nextFundingRate', 0)))
    except:
        pass
    return None

def calc_ema(values, period):
    if len(values) < period:
        return None
    k = 2 / (period + 1)
    ema = sum(values[:period]) / period
    for v in values[period:]:
        ema = v * k + ema * (1 - k)
    return ema

def calc_rsi(closes, period=14):
    if len(closes) < period + 1:
        return None
    gains, losses = [], []
    for i in range(1, len(closes)):
        diff = closes[i] - closes[i-1]
        gains.append(max(diff, 0))
        losses.append(max(-diff, 0))
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    if avg_loss == 0:
        return 100.0
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period-1) + gains[i]) / period
        avg_loss = (avg_loss * (period-1) + losses[i]) / period
    if avg_loss == 0:
        return 100.0
    return 100 - 100/(1 + avg_gain/avg_loss)

def analyze(instId, name, ticker_data):
    """分析一个币种，返回网格适配评分"""
    candles = fetch_candles(instId, '4H', 48)
    if len(candles) < 20:
        return None
    
    candles.sort(key=lambda x: int(x[0]))
    closes = [float(k[4]) for k in candles]
    highs = [float(k[2]) for k in candles]
    lows = [float(k[3]) for k in candles]
    volumes = [float(k[5]) for k in candles]
    
    n = len(closes)
    
    # === 趋势指标 ===
    ema20 = calc_ema(closes, 20)
    ema20_5ago = calc_ema(closes[:-5], 20)
    ema_slope = (ema20 - ema20_5ago) / ema20_5ago * 100 if ema20_5ago and ema20_5ago > 0 else 0
    
    # 趋势强度：EMA20 斜率 + 价格相对 MA20 位置
    ma20 = sum(closes[-20:]) / 20
    price_vs_ma20 = (closes[-1] - ma20) / ma20 * 100
    
    # 短期趋势：最近 10 根 vs 前 10 根
    ma10 = sum(closes[-10:]) / 10
    ma10_prior = sum(closes[-20:-10]) / 10
    trend_strength = (ma10 - ma10_prior) / ma10_prior * 100 if ma10_prior > 0 else 0
    
    # 趋势确定性：上涨K线占比
    up_bars = sum(1 for i in range(1, n) if closes[i] > closes[i-1])
    up_ratio = up_bars / (n-1) * 100
    
    # === 震荡结构评分 ===
    # 计算回踩深度：在上升趋势中，价格是否多次回踩
    recent_high = max(highs[-20:])
    recent_low = min(lows[-20:])
    range_pct = (recent_high - recent_low) / ma20 * 100
    
    # 回踩次数：价格从上轨回落 > 5%
    pullbacks = 0
    for i in range(3, len(highs)):
        # 找局部高点后的回落
        if highs[i-1] >= max(highs[max(0,i-5):i]) * 0.98:
            # 前一根是局部高点
            drop = (highs[i-1] - min(lows[i:min(i+5, len(lows))])) / highs[i-1] * 100
            if drop > 5:
                pullbacks += 1
    
    # === 波动率（振幅）评分 ===
    amp24 = ticker_data['amplitude']
    
    # 近期振幅
    recent_amp = (max(highs[-12:]) - min(lows[-12:])) / ((max(highs[-12:]) + min(lows[-12:])) / 2) * 100
    
    # === 成交量趋势 ===
    vol_recent = sum(volumes[-6:]) / 6
    vol_older = sum(volumes[-12:-6]) / 6
    vol_change = (vol_recent - vol_older) / vol_older * 100 if vol_older > 0 else 0
    
    # === 费率 ===
    funding = fetch_funding(instId)
    funding_pct = round(funding * 100, 4) if funding is not None else None
    
    # === RSI ===
    rsi = calc_rsi(closes)
    
    # === 通道清晰度：价格在 EMA20 附近波动的规律性 ===
    deviations = [abs(closes[i] - ema20) / ema20 * 100 for i in range(n) if ema20]
    avg_deviation = sum(deviations) / len(deviations) if deviations else 0
    
    # === 评分 ===
    
    # 先定方向
    if trend_strength > 0 and ema_slope > 0 and price_vs_ma20 > -2:
        direction = 'long'
        trend_label = '📈 震荡上行'
    elif trend_strength < 0 and ema_slope < 0 and price_vs_ma20 < 2:
        direction = 'short'
        trend_label = '📉 震荡下行'
    else:
        direction = 'sideways'
        trend_label = '↔️ 横盘'
    
    # 费率与方向匹配度
    fee_align_score = 0
    fee_label = ''
    if funding_pct is not None:
        if direction == 'long' and funding_pct < -0.01:
            fee_align_score = min(20, abs(funding_pct) * 400)  # 负费率做多，越高越好
            fee_label = '🔥 完美匹配'
        elif direction == 'short' and funding_pct > 0.01:
            fee_align_score = min(20, abs(funding_pct) * 400)
            fee_label = '🔥 完美匹配'
        elif direction == 'long' and funding_pct < 0:
            fee_align_score = min(10, abs(funding_pct) * 200)
            fee_label = '✅ 有利'
        elif direction == 'short' and funding_pct > 0:
            fee_align_score = min(10, abs(funding_pct) * 200)
            fee_label = '✅ 有利'
        elif abs(funding_pct) < 0.01:
            fee_align_score = 5
            fee_label = '➖ 中性'
        else:
            fee_align_score = 0
            fee_label = '⚠️ 逆风'
    
    # 综合评分
    score = 0
    
    # 1. 振幅 (0-25)
    if 5 <= amp24 <= 12:
        score += 20
    elif 12 < amp24 <= 20:
        score += 25  # 趋势网格更喜欢大振幅
    elif 3 <= amp24 < 5:
        score += 15
    elif amp24 > 20:
        score += 18  # 振幅超大但风险也大
    else:
        score += 5
    
    # 2. 趋势清晰度 (0-20)
    if direction != 'sideways':
        if abs(trend_strength) >= 5:
            score += 8
        elif abs(trend_strength) >= 3:
            score += 15
        elif abs(trend_strength) >= 1:
            score += 20
        else:
            score += 12
    else:
        score += 10
    
    # 3. 震荡结构 (0-20)
    if pullbacks >= 3:
        score += 20
    elif pullbacks >= 2:
        score += 15
    elif pullbacks >= 1:
        score += 8
    
    # 4. 费率匹配 (0-20)
    score += fee_align_score
    
    # 5. 成交量 (0-10)
    vol_m = ticker_data['volCcy24h'] / 1e6
    if vol_m > 100:
        score += 10
    elif vol_m > 30:
        score += 8
    elif vol_m > 10:
        score += 5
    else:
        score += 3
    
    # 6. RSI 健康度 (0-5)
    if rsi is not None:
        if direction == 'long' and 40 <= rsi <= 70:
            score += 5
        elif direction == 'short' and 30 <= rsi <= 60:
            score += 5
        elif 30 <= rsi <= 70:
            score += 3
    
    # 扣分项
    # 成交量萎缩严重
    if vol_change < -40:
        score -= 5
    
    # 偏离均线太远（追高风险）
    if direction == 'long' and price_vs_ma20 > 8:
        score -= 10
        fee_label += ' ⚠️追高'
    if direction == 'short' and price_vs_ma20 < -8:
        score -= 10
        fee_label += ' ⚠️追低'
    
    return {
        'instId': instId,
        'name': name,
        'direction': direction,
        'trend_label': trend_label,
        'last': ticker_data['last'],
        'change_24h': ticker_data['change24h'],
        'amplitude_24h': amp24,
        'volCcy24h': ticker_data['volCcy24h'],
        'trend_strength': round(trend_strength, 2),
        'ema_slope': round(ema_slope, 2),
        'price_vs_ma20': round(price_vs_ma20, 2),
        'range_pct': round(range_pct, 2),
        'pullbacks': pullbacks,
        'rsi': round(rsi, 1) if rsi else None,
        'funding_rate': funding_pct,
        'fee_label': fee_label,
        'vol_change': round(vol_change, 1),
        'score': round(score, 1),
    }

print(f"\n开始分析 {len(candidates)} 个候选...", file=sys.stderr)

results = []
for i, c in enumerate(candidates):
    r = analyze(c['instId'], c['name'], c)
    if r:
        results.append(r)
    if (i+1) % 20 == 0:
        print(f"  进度: {i+1}/{len(candidates)}", file=sys.stderr)

print(f"\n完成分析: {len(results)} 个", file=sys.stderr)

# 分类排序
long_grids = [r for r in results if r['direction'] == 'long']
short_grids = [r for r in results if r['direction'] == 'short']
sideways_grids = [r for r in results if r['direction'] == 'sideways']

long_grids.sort(key=lambda x: x['score'], reverse=True)
short_grids.sort(key=lambda x: x['score'], reverse=True)
sideways_grids.sort(key=lambda x: x['score'], reverse=True)

# 输出
output = {
    'long_grids': long_grids[:15],
    'short_grids': short_grids[:15],
    'sideways_grids': sideways_grids[:10],
    'summary': {
        'total_analyzed': len(results),
        'long_count': len(long_grids),
        'short_count': len(short_grids),
        'sideways_count': len(sideways_grids),
        'ts': datetime.now().isoformat(),
    }
}

print(json.dumps(output, indent=2))

PYEOF
