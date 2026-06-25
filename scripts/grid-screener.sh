#!/bin/bash
# 网格策略币种筛选器
# 筛选条件：横盘趋势 + 适中波动 + 流动性好 + 无单边信号
set -e

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

echo "=== 第一步：拉取所有 USDT 永续合约 Tickers ===" >&2

# 一次性拉取所有 SWAP ticker（部分大列表用循环分页）
ALL_TICKERS="$TMPDIR/all_tickers.json"

# OKX tickers 接口一次最多返回多少？用分批方式
# 先尝试一次性拉取
okx market tickers SWAP --json 2>/dev/null > "$ALL_TICKERS"

# 检查是否完整（通常 SWAP 列表约 200-300 个）
COUNT=$(python3 -c "import json; d=json.load(open('$ALL_TICKERS')); print(len(d) if isinstance(d,list) else 0)" 2>/dev/null || echo 0)
echo "拉取到 $COUNT 个合约" >&2

if [ "$COUNT" -lt 100 ]; then
    echo "⚠️ ticker 数量偏少，尝试分页拉取" >&2
    # 使用 instruments 列表作为补充
    okx market instruments --instType SWAP --json 2>/dev/null > "$TMPDIR/insts.json"
    INST_COUNT=$(python3 -c "import json; d=json.load(open('$TMPDIR/insts.json')); print(len(d.get('data',d)) if isinstance(d,dict) else len(d))" 2>/dev/null || echo 0)
    echo "instruments 列表: $INST_COUNT 个" >&2
    # 只保留 USDT 保证金
    python3 -c "
import json
with open('$TMPDIR/insts.json') as f:
    data = json.load(f)
insts = data.get('data', data) if isinstance(data, dict) else data
usdt = [i for i in insts if 'USDT' in i.get('instId','') and i.get('state')=='live']
print(json.dumps(usdt))
" > "$TMPDIR/usdt_insts.json"
fi

# 用 Python 做后续分析
export TMPDIR
export MIN_VOL_USDT=5000000
python3 << 'PYEOF'
import json, subprocess, sys, math, os

TMPDIR = os.environ['TMPDIR']

# 加载 tickers
with open(f"{TMPDIR}/all_tickers.json") as f:
    tickers = json.load(f)

if not isinstance(tickers, list) or len(tickers) < 50:
    print("ERROR: ticker 数据不足", file=sys.stderr)
    sys.exit(1)

# ============ 初筛：成交量 ============
# volCcy24h 是 USDT 计价成交额
MIN_VOL_USDT = 5_000_000  # 500万 USDT

candidates = []
for t in tickers:
    vol = float(t.get('volCcy24h', 0))
    if vol < MIN_VOL_USDT:
        continue
    # 排除非 USDT 保证金
    if '-USDT-SWAP' not in t.get('instId', ''):
        continue
    # 排除股票代币/金属/外汇等非加密
    instId = t['instId']
    name = instId.replace('-USDT-SWAP', '')
    # 排除已知的非加密品类（通过命名规律 + 一些硬编码）
    non_crypto_prefixes = ['XPD', 'XAG', 'XAU', 'XPT', 'SOXL', 'SOXS', 'HPE', 'DELL', 'MSFT', 'AAPL', 'TSLA', 'NVDA', 'GOOGL', 'AMZN', 'META', 'NFLX']
    if name in non_crypto_prefixes:
        continue
    
    high = float(t.get('high24h', 0))
    low = float(t.get('low24h', 0))
    open24 = float(t.get('open24h', 0))
    last = float(t.get('last', 0))
    
    if low <= 0 or high <= 0 or open24 <= 0:
        continue
    
    # 24h 振幅
    amplitude = (high - low) / open24 * 100
    # 24h 涨跌幅
    change = (last - open24) / open24 * 100
    
    candidates.append({
        'instId': instId,
        'name': name,
        'last': last,
        'high24h': high,
        'low24h': low,
        'open24h': open24,
        'volCcy24h': vol,
        'amplitude': round(amplitude, 2),
        'change24h': round(change, 2),
    })

# 按成交量排序，取前 80 个
candidates.sort(key=lambda x: x['volCcy24h'], reverse=True)
candidates = candidates[:80]

print(f"初筛：成交量 ≥ {MIN_VOL_USDT/1e6:.0f}M USDT → {len(candidates)} 个候选", file=sys.stderr)

# ============ 第二步：拉取 K 线做趋势判断 ============
# 对每个候选拉取 4H K线（最近 48 根 = 8 天）和 1D K线（最近 30 根）

def fetch_candles(instId, bar='4H', limit=48):
    """拉取 K 线"""
    try:
        result = subprocess.run(
            ['okx', 'market', 'candles', instId, '--bar', bar, '--limit', str(limit), '--json'],
            capture_output=True, text=True, timeout=20
        )
        data = json.loads(result.stdout)
        # 返回 list of [ts, o, h, l, c, vol, volCcy]
        candles = data.get('data', data) if isinstance(data, dict) else data
        if isinstance(candles, list) and len(candles) > 0 and isinstance(candles[0], list):
            return candles
        return []
    except Exception as e:
        print(f"  fetch error {instId}: {e}", file=sys.stderr)
        return []

def calc_ema(values, period):
    """计算 EMA"""
    if len(values) < period:
        return None
    k = 2 / (period + 1)
    ema = sum(values[:period]) / period
    for v in values[period:]:
        ema = v * k + ema * (1 - k)
    return ema

def calc_atr(highs, lows, closes, period=14):
    """计算 ATR"""
    if len(highs) < period + 1:
        return None
    trs = []
    for i in range(1, len(highs)):
        tr = max(highs[i] - lows[i], 
                 abs(highs[i] - closes[i-1]), 
                 abs(lows[i] - closes[i-1]))
        trs.append(tr)
    if len(trs) < period:
        return None
    atr = sum(trs[:period]) / period
    for i in range(period, len(trs)):
        atr = (atr * (period - 1) + trs[i]) / period
    return atr

def calc_rsi(closes, period=14):
    """计算 RSI"""
    if len(closes) < period + 1:
        return None
    gains = []
    losses = []
    for i in range(1, len(closes)):
        diff = closes[i] - closes[i-1]
        gains.append(max(diff, 0))
        losses.append(max(-diff, 0))
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    rsi = 100 - 100/(1 + rs)
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        if avg_loss == 0:
            rsi = 100.0
        else:
            rs = avg_gain / avg_loss
            rsi = 100 - 100/(1 + rs)
    return rsi

def score_sideways(closes, highs, lows):
    """
    横盘评分：0-100，越高越横盘
    - 价格在 MA20 附近窄幅波动
    - 无明显趋势斜率
    - 波动率适中
    """
    if len(closes) < 30:
        return 0, {}
    
    # MA20 / MA60 斜率
    ma20 = sum(closes[-20:]) / 20
    ma60 = sum(closes[-min(60, len(closes)):]) / min(60, len(closes))
    
    # 价格区间（最近 20 根 K 线）
    recent_high = max(highs[-20:])
    recent_low = min(lows[-20:])
    range_pct = (recent_high - recent_low) / ma20 * 100
    
    # 趋势斜率：用最近 10 根 vs 前 10 根的 MA 比较
    ma_recent = sum(closes[-10:]) / 10
    ma_prior = sum(closes[-20:-10]) / 10
    trend_pct = (ma_recent - ma_prior) / ma_prior * 100 if ma_prior > 0 else 0
    
    # EMA20 斜率
    ema20 = calc_ema(closes, 20)
    ema20_prev = calc_ema(closes[:-5], 20) if len(closes) > 25 else ema20
    ema_slope = (ema20 - ema20_prev) / ema20_prev * 100 if ema20_prev and ema20_prev > 0 else 0
    
    # 价格偏离 MA20 的程度
    deviation = abs(closes[-1] - ma20) / ma20 * 100
    
    # 横盘评分逻辑
    score = 0
    
    # 1. 区间宽度 (range_pct)：3%-10% 为佳
    if 3 <= range_pct <= 10:
        score += 30
    elif 2 <= range_pct <= 3 or 10 < range_pct <= 15:
        score += 20
    elif range_pct < 2 or range_pct > 20:
        score += 5
    else:
        score += 15
    
    # 2. 趋势平坦度 (trend_pct)：-2% ~ +2% 最佳
    if abs(trend_pct) < 2:
        score += 30
    elif abs(trend_pct) < 4:
        score += 20
    elif abs(trend_pct) < 6:
        score += 10
    else:
        score += 0
    
    # 3. EMA 斜率平坦度
    if abs(ema_slope) < 1:
        score += 20
    elif abs(ema_slope) < 2:
        score += 12
    elif abs(ema_slope) < 3:
        score += 5
    else:
        score += 0
    
    # 4. 偏离 MA20 程度
    if deviation < 2:
        score += 20
    elif deviation < 4:
        score += 12
    elif deviation < 6:
        score += 5
    else:
        score += 0
    
    # 5. 反转：波动率太低也不好（< 2% 吃不到利润）
    if range_pct < 2:
        score -= 15
    
    return max(0, min(100, score)), {
        'range_pct': round(range_pct, 2),
        'trend_pct': round(trend_pct, 2),
        'ema_slope': round(ema_slope, 2),
        'deviation': round(deviation, 2),
        'ma20': round(ma20, 4),
        'recent_high': round(recent_high, 4),
        'recent_low': round(recent_low, 4),
    }

def fetch_funding_rate(instId):
    """拉取当前资金费率"""
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

def fetch_oi(instId):
    """拉取 OI"""
    try:
        result = subprocess.run(
            ['okx', 'market', 'open-interest', '--instType', 'SWAP', '--instId', instId, '--json'],
            capture_output=True, text=True, timeout=15
        )
        data = json.loads(result.stdout)
        items = data.get('data', data) if isinstance(data, dict) else data
        if isinstance(items, list) and len(items) > 0:
            oi = items[0]
            return float(oi.get('oi', oi.get('oiCcy', 0)))
    except:
        pass
    return None

print(f"\n正在拉取 {len(candidates)} 个候选的 K 线数据...", file=sys.stderr)

results = []
for i, c in enumerate(candidates):
    instId = c['instId']
    name = c['name']
    
    # 拉取 4H K线用于趋势判断
    candles_4h = fetch_candles(instId, '4H', 48)
    if len(candles_4h) < 20:
        continue
    
    # 解析 K 线 (按时间升序)
    candles_4h.sort(key=lambda x: int(x[0]))
    closes = [float(k[4]) for k in candles_4h]
    highs = [float(k[2]) for k in candles_4h]
    lows = [float(k[3]) for k in candles_4h]
    volumes = [float(k[5]) for k in candles_4h]
    
    # 横盘评分
    sideways_score, details = score_sideways(closes, highs, lows)
    
    # ATR（用于判断波动率是否适合网格）
    atr = calc_atr(highs, lows, closes)
    atr_pct = (atr / closes[-1] * 100) if atr and closes[-1] > 0 else None
    
    # RSI（判断是否极端区域）
    rsi = calc_rsi(closes)
    
    # 24h 振幅
    amp = c['amplitude']
    
    # 成交量变化
    vol_recent = sum(volumes[-6:]) / 6
    vol_older = sum(volumes[-12:-6]) / 6
    vol_change = (vol_recent - vol_older) / vol_older * 100 if vol_older > 0 else 0
    
    # 区间清晰度：区间内价格回测上下边界的次数
    recent_h = details['recent_high']
    recent_l = details['recent_low']
    high_touches = sum(1 for h in highs[-20:] if h >= recent_h * 0.985)
    low_touches = sum(1 for l in lows[-20:] if l <= recent_l * 1.015)
    
    result = {
        'instId': instId,
        'name': name,
        'last': c['last'],
        'volCcy24h': c['volCcy24h'],
        'amplitude_24h': amp,
        'change_24h': c['change24h'],
        'sideways_score': sideways_score,
        'range_pct': details['range_pct'],
        'trend_pct': details['trend_pct'],
        'ema_slope': details['ema_slope'],
        'deviation_ma20': details['deviation'],
        'atr_pct': round(atr_pct, 2) if atr_pct else None,
        'rsi_4h': round(rsi, 1) if rsi else None,
        'vol_change': round(vol_change, 1),
        'high_touches': high_touches,
        'low_touches': low_touches,
        'recent_high': details['recent_high'],
        'recent_low': details['recent_low'],
        'ma20': details['ma20'],
    }
    results.append(result)
    
    if (i+1) % 20 == 0:
        print(f"  进度: {i+1}/{len(candidates)}", file=sys.stderr)

print(f"\n完成 K 线分析: {len(results)} 个", file=sys.stderr)

# ============ 第三步：拉取资金费率（对横盘分 > 40 的） ============
good_sideways = [r for r in results if r['sideways_score'] >= 40]
print(f"\n横盘评分 ≥ 40: {len(good_sideways)} 个，正在拉取资金费率...", file=sys.stderr)

for i, r in enumerate(good_sideways):
    fr = fetch_funding_rate(r['instId'])
    r['funding_rate'] = round(fr * 100, 4) if fr is not None else None
    if (i+1) % 10 == 0:
        print(f"  费率进度: {i+1}/{len(good_sideways)}", file=sys.stderr)

# ============ 第四步：综合评分 ============
def final_score(r):
    """综合网格适配评分 0-100"""
    s = 0
    
    # 横盘分权重 50%
    s += r['sideways_score'] * 0.5
    
    # 振幅分 (3-8% 最佳) 权重 20%
    amp = r['amplitude_24h']
    if 3 <= amp <= 8:
        s += 20
    elif 2 <= amp < 3 or 8 < amp <= 12:
        s += 12
    elif amp < 1.5 or amp > 18:
        s += 2
    else:
        s += 8
    
    # 费率分 权重 10%
    fr = r.get('funding_rate')
    if fr is not None:
        if abs(fr) < 0.01:
            s += 10
        elif abs(fr) < 0.03:
            s += 6
        elif abs(fr) < 0.05:
            s += 3
        else:
            s += 0
    else:
        s += 5  # 未知给中性分
    
    # RSI 适中分 权重 10%
    rsi = r.get('rsi_4h')
    if rsi is not None:
        if 40 <= rsi <= 60:
            s += 10
        elif 35 <= rsi < 40 or 60 < rsi <= 65:
            s += 6
        elif 30 <= rsi < 35 or 65 < rsi <= 70:
            s += 3
        else:
            s += 0
    
    # 成交量稳定性 权重 5%
    vol_ch = abs(r.get('vol_change', 0))
    if vol_ch < 15:
        s += 5
    elif vol_ch < 30:
        s += 3
    else:
        s += 0
    
    # 区间边界测试次数 权重 5%
    touches = r.get('high_touches', 0) + r.get('low_touches', 0)
    if touches >= 3:
        s += 5
    elif touches >= 2:
        s += 3
    elif touches >= 1:
        s += 1
    
    return round(s, 1)

for r in results:
    r['final_score'] = final_score(r)

# 按最终分排序
results.sort(key=lambda x: x['final_score'], reverse=True)

# ============ 输出 ============
# 最终分 >= 50 的为推荐
recommended = [r for r in results if r['final_score'] >= 50]
watchlist = [r for r in results if 40 <= r['final_score'] < 50]

print(json.dumps({
    'recommended': recommended,
    'watchlist': watchlist,
    'all_analyzed': len(results),
    'total_candidates': len(candidates),
    'ts': subprocess.run(['date', '-Iseconds'], capture_output=True, text=True).stdout.strip(),
}, indent=2))

PYEOF
