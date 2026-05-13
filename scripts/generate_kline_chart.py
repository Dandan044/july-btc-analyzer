#!/usr/bin/env python3
"""
K线图生成器 v6 — 可选多指标 / 多时间框架 / 深色主题

支持指标组 (--indicators):
  ema     EMA 7/25/99
  bb      布林带 (20,2)
  volume  成交量
  liq     爆仓数据 (多/空)
  lsr     多空账户比
  taker   Taker 买卖量
  oi      持仓量 (OI)
  funding 资金费率 (文本标注)

预设: basic (=ema,bb,volume)  |  all  |  market (=lsr,taker,oi,liq)

用法:
  python3 scripts/generate_kline_chart.py                          # 默认 basic
  python3 scripts/generate_kline_chart.py --indicators all         # 全部指标
  python3 scripts/generate_kline_chart.py --indicators ema,bb,liq  # 自选
  python3 scripts/generate_kline_chart.py --bar 1H --indicators all
  python3 scripts/generate_kline_chart.py --instId ETH-USDT-SWAP --indicators market,ema
"""

import sys, os, json, argparse, subprocess
from datetime import datetime, timezone, timedelta
from collections import defaultdict

import pandas as pd
import mplfinance as mpf
import matplotlib.pyplot as plt
import numpy as np

PROXY_URL = "http://127.0.0.1:7890"
OKX_BASE = "https://www.okx.com"

DEFAULT_TIMEFRAMES = {
    "15m": {"visible": 120, "warmup": 200},
    "1H":  {"visible": 100, "warmup": 200},
    "4H":  {"visible": 80,  "warmup": 200},
    "1D":  {"visible": 60,  "warmup": 200},
}
ALL_BARS = ["15m", "1H", "4H", "1D"]
BAR_MINUTES = {"15m": 15, "1H": 60, "4H": 240, "1D": 1440}

# rubik period 映射 (rubik 只支持 5m/1H/1D)
BAR_TO_RUBIK = {"15m": "5m", "1H": "1H", "4H": "1H", "1D": "1D"}

# 指标组预设
INDICATOR_PRESETS = {
    "basic":  ["ema", "bb", "volume"],
    "market": ["lsr", "taker", "oi", "liq"],
}
ALL_INDICATORS = ["ema", "bb", "volume", "liq", "lsr", "taker", "oi", "funding"]


# ═══════════════ helpers ═══════════════

def api_get(path, timeout=20):
    """curl OKX API，带重试"""
    url = f"{OKX_BASE}{path}"
    for attempt in range(3):
        try:
            r = subprocess.run(["curl", "-s", "--max-time", str(timeout), "--proxy", PROXY_URL, url],
                               capture_output=True, text=True, timeout=timeout + 5)
            if r.stdout.strip():
                return json.loads(r.stdout)
        except Exception:
            pass
        if attempt < 2:
            import time
            time.sleep(1 + attempt)
    return {"code": "-1", "msg": "retry exhausted", "data": []}


def parse_klines(raw):
    records, seen = [], set()
    for row in raw:
        ts = int(row[0])
        if ts in seen: continue
        seen.add(ts)
        dt = datetime.fromtimestamp(ts / 1000, tz=timezone(timedelta(hours=8)))
        records.append({"datetime": dt, "open": float(row[1]), "high": float(row[2]),
                        "low": float(row[3]), "close": float(row[4]), "volume": float(row[5])})
    df = pd.DataFrame(records).sort_values("datetime").reset_index(drop=True)
    df.set_index("datetime", inplace=True)
    return df


def calc_ema(s, p):
    return s.ewm(span=p, adjust=False).mean()


def calc_bb(s, p=20, n=2):
    m = s.rolling(p).mean()
    st = s.rolling(p).std()
    return m + n * st, m, m - n * st


def ms_to_dt(ts, tz=None):
    if tz is None: tz = timezone(timedelta(hours=8))
    return datetime.fromtimestamp(int(ts) / 1000, tz=tz)


# ═══════════════ 数据获取 ═══════════════

def fetch_klines(inst_id, bar, limit):
    all_data, batch_size = [], 300
    while limit > 0:
        batch = min(limit, batch_size)
        url = f"/api/v5/market/candles?instId={inst_id}&bar={bar}&limit={batch}"
        if all_data: url += f"&after={all_data[-1][0]}"
        d = api_get(url)
        if d.get("code") != "0" or not d.get("data"): break
        all_data.extend(d["data"])
        limit -= len(d["data"])
        if len(d["data"]) < batch: break
    return all_data or None


def fetch_liquidations(inst_id):
    uly = inst_id.replace("-SWAP", "")
    d = api_get(f"/api/v5/public/liquidation-orders?instType=SWAP&uly={uly}&state=filled&limit=100", timeout=30)
    events = []
    for entry in d.get("data", []):
        for liq in entry.get("details", []):
            events.append({"ts": int(liq["ts"]), "sz": float(liq["sz"]), "posSide": liq["posSide"]})
    return events


def fetch_rubik(ccy, stat, period="1H", limit=720):
    """获取 rubik 统计，返回 [[ts, ...values], ...]"""
    d = api_get(f"/api/v5/rubik/stat/contracts/{stat}?ccy={ccy}&period={period}&limit={limit}")
    if d.get("code") != "0": return []
    return d.get("data", [])


def fetch_taker(inst_id, ccy, period="1H", limit=720):
    d = api_get(f"/api/v5/rubik/stat/taker-volume?instId={inst_id}&instType=CONTRACTS&ccy={ccy}&period={period}&limit={limit}")
    if d.get("code") != "0": return []
    return d.get("data", [])


def fetch_funding(inst_id):
    d = api_get(f"/api/v5/public/funding-rate?instId={inst_id}&limit=1")
    if d.get("code") != "0" or not d.get("data"): return None
    return float(d["data"][0]["fundingRate"])


def fetch_fng(limit=7):
    """恐惧贪婪指数"""
    try:
        r = subprocess.run(["curl", "-s", "--max-time", "10", "--proxy", PROXY_URL,
                            f"https://api.alternative.me/fng/?limit={limit}"],
                           capture_output=True, text=True, timeout=15)
        d = json.loads(r.stdout)
        return d.get("data", [])
    except: return []


# ═══════════════ 聚合到 K 线窗口 ═══════════════

def align_rubik_to_index(raw_data, df_index, value_idx=1, period_ms=None):
    """将 rubik 的 [ts, val] 数据对齐到 df_index
    
    df_index 是 UTC+8 时区的 datetime，rubik ts 是 UTC 毫秒。
    按时间窗口对齐：找到覆盖每个 K 线时间窗口的 rubik 数据点。
    """
    if not raw_data: return pd.Series(np.nan, index=df_index)
    if period_ms is None: period_ms = 3600000
    
    # 建立 ts → value 映射 (ts 是 UTC 毫秒，取整到最近的 period)
    bin_map = {}
    for row in raw_data:
        ts = int(row[0])
        bin_start = (ts // period_ms) * period_ms
        v = float(row[value_idx])
        bin_map[bin_start] = v
    
    # 对每个 df_index，找到对应的 rubik bin
    # df_index 是 UTC+8 datetime，转为 UTC epoch ms
    values = []
    for idx in df_index:
        # idx 已经带时区，转 UTC epoch 再对齐到 period
        idx_utc_ts = int(idx.timestamp() * 1000)
        idx_bin = (idx_utc_ts // period_ms) * period_ms
        # 尝试 exact match，再尝试前后偏移一个 period
        v = bin_map.get(idx_bin)
        if v is None:
            v = bin_map.get(idx_bin - period_ms)
        if v is None:
            v = bin_map.get(idx_bin + period_ms)
        values.append(v if v is not None else np.nan)
    return pd.Series(values, index=df_index)


def align_taker_to_index(raw_data, df_index, period_ms=None):
    """Taker 数据: [ts, sellVol, buyVol]"""
    if period_ms is None: period_ms = 3600000
    if not raw_data: return pd.Series(np.nan, index=df_index), pd.Series(np.nan, index=df_index)
    
    sell_map, buy_map = {}, {}
    for row in raw_data:
        ts = int(row[0])
        bin_start = (ts // period_ms) * period_ms
        sell_map[bin_start] = float(row[1])
        buy_map[bin_start] = float(row[2])
    
    sells, buys = [], []
    for idx in df_index:
        idx_bin = (int(idx.timestamp() * 1000) // period_ms) * period_ms
        sells.append(sell_map.get(idx_bin, sell_map.get(idx_bin - period_ms, sell_map.get(idx_bin + period_ms, np.nan))))
        buys.append(buy_map.get(idx_bin, buy_map.get(idx_bin - period_ms, buy_map.get(idx_bin + period_ms, np.nan))))
    return pd.Series(sells, index=df_index), pd.Series(buys, index=df_index)


def align_liq_to_index(events, df_index, bar_minutes):
    """爆仓事件按 K 线窗口聚合"""
    if not events: return pd.Series(0, index=df_index), pd.Series(0, index=df_index)
    bar_ms = bar_minutes * 60 * 1000
    bin_map = {int(idx.timestamp() * 1000): {"long": 0.0, "short": 0.0} for idx in df_index}
    for evt in events:
        ts_key = (evt["ts"] // bar_ms) * bar_ms
        if ts_key in bin_map:
            if evt["posSide"] == "long": bin_map[ts_key]["long"] += evt["sz"]
            else: bin_map[ts_key]["short"] += evt["sz"]
    longs = [bin_map[int(idx.timestamp() * 1000)]["long"] for idx in df_index]
    shorts = [bin_map[int(idx.timestamp() * 1000)]["short"] for idx in df_index]
    return pd.Series(longs, index=df_index), pd.Series(shorts, index=df_index)


# ═══════════════ 图表生成 ═══════════════

def generate_chart(df, indicators, inst_id, bar, output_path,
                   liq_long=None, liq_short=None,
                   lsr_series=None, taker_sell=None, taker_buy=None,
                   oi_series=None, funding_rate=None, fng_data=None):
    """核心绘图函数 — 根据启用的指标动态构建面板
    
    mplfinance 面板编号:
      0 = 主图 (始终存在)
      1 = 成交量 (仅当 volume=True 时存在)
      2+ = 额外面板 (按 addplot 中出现的 panel 编号递增)
    
    本函数先确定哪些额外面板需要，然后按顺序分配编号。
    """

    latest = df['close'].iloc[-1]
    hi, lo = df['high'].max(), df['low'].min()

    # ── 深色主题 ──
    mc = mpf.make_marketcolors(up='#26a69a', down='#ef5350', edge='inherit', wick='inherit',
                               volume={'up': '#26a69a90', 'down': '#ef535090'})
    style = mpf.make_mpf_style(marketcolors=mc, base_mpf_style='nightclouds',
                               figcolor='#1b1b2f', facecolor='#1b1b2f',
                               gridstyle='--', gridcolor='#2a2a4a')

    has_vol = "volume" in indicators

    # ── 预计算额外面板: 按顺序分配 panel 编号 ──
    # 过滤掉全 NaN 的数据
    def _ok(s):
        return s is not None and not s.isna().all() if hasattr(s, 'isna') else s is not None
    extra_types = []
    if "liq" in indicators and _ok(liq_long): extra_types.append(("liq", True))
    has_lsr = "lsr" in indicators and _ok(lsr_series)
    has_taker = "taker" in indicators and _ok(taker_sell)
    if has_lsr or has_taker: extra_types.append(("market", True))
    if "oi" in indicators and _ok(oi_series): extra_types.append(("oi", True))

    # mplfinance 面板编号: panel 0=主图, 1=成交量(可选), 2+=额外面板
    # 每个面板占用 2 个 axes (主 + twin), axes 索引 = 2 * panel_number
    extra_start = 2 if has_vol else 1
    panel_map = {}  # type -> panel number
    for i, (typ, _) in enumerate(extra_types):
        panel_map[typ] = extra_start + i

    addplots = []
    panel_ratios = [3]
    if has_vol: panel_ratios.append(0.8)
    for typ, _ in extra_types:
        ratio = {"liq": 0.6, "market": 0.7, "oi": 0.6}.get(typ, 0.6)
        panel_ratios.append(ratio)

    # ── BB & EMA (主图叠加) ──
    if "bb" in indicators:
        addplots.append(mpf.make_addplot(df['bb_upper'], panel=0, color='#7c4dff', width=1.0, linestyle='--'))
        addplots.append(mpf.make_addplot(df['bb_mid'],   panel=0, color='#7c4dff', width=0.7, linestyle=':'))
        addplots.append(mpf.make_addplot(df['bb_lower'], panel=0, color='#7c4dff', width=1.0, linestyle='--'))
    if "ema" in indicators:
        addplots.append(mpf.make_addplot(df['ema7'],  panel=0, color='#ff9800', width=1.2))
        addplots.append(mpf.make_addplot(df['ema25'], panel=0, color='#42a5f5', width=1.2))
        addplots.append(mpf.make_addplot(df['ema99'], panel=0, color='#ab47bc', width=1.2))

    # ── 爆仓 ──
    if "liq" in panel_map:
        p = panel_map["liq"]
        addplots.append(mpf.make_addplot(liq_long,  panel=p, type='bar', color='#ef5350', alpha=0.9))
        addplots.append(mpf.make_addplot(liq_short, panel=p, type='bar', color='#26a69a', alpha=0.9))

    # ── 市场 (LSR + Taker) ──
    if "market" in panel_map:
        p = panel_map["market"]
        if has_lsr:
            addplots.append(mpf.make_addplot(lsr_series, panel=p, color='#00e5ff', width=2.0))
        if has_taker:
            addplots.append(mpf.make_addplot(taker_buy,  panel=p, type='bar', color='#26a69a', alpha=0.9))
            addplots.append(mpf.make_addplot(taker_sell, panel=p, type='bar', color='#ef5350', alpha=0.9))

    # ── OI ──
    if "oi" in panel_map:
        p = panel_map["oi"]
        addplots.append(mpf.make_addplot(oi_series, panel=p, color='#00e5ff', width=2.0))

    # ── 标题 ──
    title_parts = [f"{inst_id}  {bar}", f"Last: {latest:,.2f}",
                   f"H: {hi:,.2f}  L: {lo:,.2f}"]
    if "funding" in indicators and funding_rate is not None:
        title_parts.append(f"FR: {funding_rate*100:.4f}%")
    if "fng" in indicators and fng_data:
        try: title_parts.append(f"F&G: {fng_data[0]['value']}")
        except: pass
    title_parts.append(f"{df.index[0].strftime('%m/%d %H:%M')} ~ {df.index[-1].strftime('%m/%d %H:%M')}")
    title_text = "  |  ".join(title_parts)

    # ── 绘制 ──
    mpf_kwargs = dict(type='candle', style=style, volume=has_vol,
                      title=title_text, figsize=(16, 8 + len(panel_ratios) * 1.5),
                      returnfig=True, addplot=addplots,
                      panel_ratios=tuple(panel_ratios),
                      warn_too_much_data=600)
    if has_vol:
        mpf_kwargs['volume_panel'] = 1
    fig, axes = mpf.plot(df, **mpf_kwargs)

    # ── BB 填充 ──
    if "bb" in indicators:
        ax_main = axes[0]
        x_min, x_max = ax_main.get_xlim()
        x = np.arange(len(df))
        ax_main.fill_between(x, df['bb_upper'].values, df['bb_lower'].values,
                             alpha=0.10, color='#7c4dff', zorder=0)
        ax_main.set_xlim(x_min, x_max)

    # ── 主图样式 ──
    axes[0].title.set_color('#e0e0e0')
    axes[0].title.set_fontsize(12)
    axes[0].title.set_fontweight('bold')

    # ── 手动创建所有图例 (不依赖 mplfinance) ──
    from matplotlib.lines import Line2D
    from matplotlib.patches import Patch

    DEF_STYLE = dict(loc='upper left', fontsize=8, framealpha=0.85,
                     facecolor='#1b1b2f', edgecolor='#555', labelcolor='#ddd')

    # 主图图例
    main_handles = []
    if "bb" in indicators:
        main_handles.extend([
            Line2D([0],[0], color='#7c4dff', lw=1.0, linestyle='--', label='BB Upper'),
            Line2D([0],[0], color='#7c4dff', lw=0.7, linestyle=':',  label='BB Mid'),
            Line2D([0],[0], color='#7c4dff', lw=1.0, linestyle='--', label='BB Lower'),
        ])
    if "ema" in indicators:
        main_handles.extend([
            Line2D([0],[0], color='#ff9800', lw=1.2, label='EMA7'),
            Line2D([0],[0], color='#42a5f5', lw=1.2, label='EMA25'),
            Line2D([0],[0], color='#ab47bc', lw=1.2, label='EMA99'),
        ])
    if main_handles:
        axes[0].legend(handles=main_handles, **DEF_STYLE)

    ax_list = list(axes)

    # Volume 面板标题
    if has_vol and len(ax_list) > 2:
        ax_vol = ax_list[2]
        ax_vol.set_title('Volume', loc='left', color='#ccc', fontsize=9, fontweight='bold', pad=2)
        ax_vol.set_ylabel('Volume', color='#ccc', fontsize=8, fontweight='bold', labelpad=2)
        ax_vol.yaxis.set_label_position('left')

    # 子图装饰
    # ⚠️ mplfinance 每个面板用 2 个 axes (主+twin), 索引 = 2 × panel_number
    # 例: panel 2 → axes[4], panel 3 → axes[6], panel 4 → axes[8]
    for name, pid in panel_map.items():
        ax_idx = 2 * pid
        if ax_idx >= len(ax_list): continue
        ax = ax_list[ax_idx]
        ax.set_axisbelow(True)
        ax.tick_params(colors='#aaa', labelsize=8)
        ax.grid(True, linestyle='--', color='#2a2a4a', alpha=0.4)

        # 子图标题 (左对齐) + ylabel
        ylbl = {"liq": "Liquidation", "market": "Market", "oi": "Open Interest"}.get(name, "")
        if ylbl:
            ax.set_title(ylbl, loc='left', color='#ccc', fontsize=9, fontweight='bold',
                        pad=2)
            ax.set_ylabel(ylbl, color='#ccc', fontsize=8, fontweight='bold', labelpad=2)
            ax.yaxis.set_label_position('left')

        # 图例
        handles = []
        if name == "liq":
            handles = [
                Patch(facecolor='#ef5350', alpha=0.9, label='Long Liq'),
                Patch(facecolor='#26a69a', alpha=0.9, label='Short Liq'),
            ]
        elif name == "market":
            if has_lsr:
                handles.append(Line2D([0],[0], color='#00e5ff', lw=2, label='LS Ratio'))
            if has_taker:
                handles.append(Patch(facecolor='#26a69a', alpha=0.9, label='Taker Buy'))
                handles.append(Patch(facecolor='#ef5350', alpha=0.9, label='Taker Sell'))
        elif name == "oi":
            handles = [Line2D([0],[0], color='#00e5ff', lw=1.5, label='OI')]

        if handles:
            leg = ax.legend(handles=handles, **DEF_STYLE)
            leg.set_zorder(10)

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    fig.savefig(output_path, dpi=150, bbox_inches='tight',
                facecolor=fig.get_facecolor(), edgecolor='none')
    plt.close(fig)


# ═══════════════ 主流程 ═══════════════

def resolve_indicators(raw):
    """解析 --indicators 参数，支持逗号分隔和空格分隔混用"""
    if not raw: return set(INDICATOR_PRESETS["basic"])
    # 先把带逗号的拆开
    tokens = []
    for item in raw:
        tokens.extend(item.split(","))
    selected = set()
    for token in tokens:
        token = token.strip()
        if not token: continue
        if token in INDICATOR_PRESETS:
            selected.update(INDICATOR_PRESETS[token])
        elif token == "all":
            selected.update(ALL_INDICATORS)
        elif token in ALL_INDICATORS:
            selected.add(token)
        else:
            print(f"⚠️  未知指标: '{token}' (可用: {', '.join(ALL_INDICATORS)}, 预设: {', '.join(INDICATOR_PRESETS)})")
    return selected


def run_single(inst_id, bar, visible, warmup, indicators, output_dir):
    total = visible + warmup
    ccy = inst_id.split("-")[0]

    # rubik API 粒度映射: 仅支持 5m/1H/1D, 选最接近 K 线周期的粒度
    # ⚠️ 5m 数据 OKX 硬限制 ~576 条 (约 48h), 长跨度图表中 LSR/Taker/OI 早期数据将缺失
    rubik_period = BAR_TO_RUBIK.get(bar, "1H")
    rubik_ms = {"5m": 300000, "1H": 3600000, "1D": 86400000}.get(rubik_period, 3600000)

    print(f"  ⏳ {bar}: 获取 {total} 根K线 + 指标数据...")
    raw = fetch_klines(inst_id, bar, total)
    if not raw: print(f"  ❌ K线获取失败"); return None
    df_full = parse_klines(raw)

    # 指标计算
    df_full['ema7'] = calc_ema(df_full['close'], 7)
    df_full['ema25'] = calc_ema(df_full['close'], 25)
    df_full['ema99'] = calc_ema(df_full['close'], 99)
    df_full['bb_upper'], df_full['bb_mid'], df_full['bb_lower'] = calc_bb(df_full['close'])
    df_plot = df_full.iloc[-visible:].copy()

    # 各外部数据
    liq_long = liq_short = lsr = taker_s = taker_b = oi = fr = fng = None

    if "liq" in indicators:
        events = fetch_liquidations(inst_id)
        liq_long, liq_short = align_liq_to_index(events, df_plot.index, BAR_MINUTES[bar])
        print(f"     爆仓: {len(events)}条, 总量={liq_long.sum()+liq_short.sum():,.0f}")

    if "lsr" in indicators:
        data = fetch_rubik(ccy, "long-short-account-ratio", rubik_period)
        lsr = align_rubik_to_index(data, df_plot.index, 1, rubik_ms)
        print(f"     LSR: {len(data)}点, latest={lsr.dropna().iloc[-1] if not lsr.dropna().empty else 'N/A'}")

    if "taker" in indicators:
        data = fetch_taker(inst_id, ccy, rubik_period)
        taker_s, taker_b = align_taker_to_index(data, df_plot.index, rubik_ms)
        print(f"     Taker: {len(data)}点")

    if "oi" in indicators:
        data = fetch_rubik(ccy, "open-interest-volume", rubik_period)
        oi = align_rubik_to_index(data, df_plot.index, 2, rubik_ms)
        print(f"     OI: {len(data)}点")

    if "funding" in indicators:
        fr = fetch_funding(inst_id)
        if fr is not None: print(f"     资金费率: {fr*100:.4f}%")

    if "fng" in indicators:
        fng = fetch_fng()
        if fng:
            print(f"     F&G: {fng[0]['value']} ({fng[0]['value_classification']})")

    filename = f"{inst_id.replace('-','_')}_{bar}.png"
    output_path = os.path.join(output_dir, filename)
    generate_chart(df_plot, indicators, inst_id, bar, output_path,
                   liq_long, liq_short, lsr, taker_s, taker_b, oi, fr, fng)

    print(f"  ✅ {bar} → {output_path}")
    print(f"     Price: {df_plot['low'].min():,.2f}~{df_plot['high'].max():,.2f} | Last: {df_plot['close'].iloc[-1]:,.2f}")
    if "ema" in indicators:
        print(f"     EMA7={df_plot['ema7'].iloc[-1]:,.2f} EMA25={df_plot['ema25'].iloc[-1]:,.2f} EMA99={df_plot['ema99'].iloc[-1]:,.2f}")
    if "bb" in indicators:
        print(f"     BB: {df_plot['bb_lower'].iloc[-1]:,.2f} ~ {df_plot['bb_upper'].iloc[-1]:,.2f}")
    return True


def main():
    p = argparse.ArgumentParser(description="K线图生成器 v6 — 可选多指标")
    p.add_argument("--instId", default="BTC-USDT-SWAP", help="交易对")
    p.add_argument("--bar", default=None, help="单周期")
    p.add_argument("--bars", nargs="+", default=None, help="多周期: all/short/long")
    p.add_argument("--indicators", nargs="+", default=None,
                   help=f"指标: {', '.join(ALL_INDICATORS)} | 预设: basic, market, all")
    p.add_argument("--visible", type=int, default=None)
    p.add_argument("--warmup", type=int, default=None)
    p.add_argument("--output", default=None)

    args = p.parse_args()
    inst_id = args.instId.upper()

    if args.bar and args.bars: print("❌ --bar/--bars 互斥"); sys.exit(1)
    if args.bar:
        bars = [args.bar] if args.bar in ALL_BARS else []
        if not bars: print(f"❌ 无效 bar: {args.bar}"); sys.exit(1)
    else:
        bars_list = args.bars or ALL_BARS
        expansions = {"all": ALL_BARS, "short": ["15m","1H"], "long": ["4H","1D"]}
        bars = []
        for b in bars_list:
            if b in expansions: bars.extend(expansions[b])
            elif b in ALL_BARS: bars.append(b)
        bars = sorted(set(bars), key=lambda x: ALL_BARS.index(x)) or ALL_BARS

    indicators = resolve_indicators(args.indicators)
    ts_tag = datetime.now().strftime('%Y%m%d_%H%M')
    output_dir = args.output or f"data/kline_charts/{inst_id.replace('-','_')}_{ts_tag}"
    os.makedirs(output_dir, exist_ok=True)

    tf_configs = []
    for bar in bars:
        d = DEFAULT_TIMEFRAMES.get(bar, {"visible":100,"warmup":200})
        tf_configs.append({"bar":bar, "visible":args.visible or d["visible"], "warmup":args.warmup or d["warmup"]})

    ind_str = ",".join(sorted(indicators))
    print(f"\n📊 {inst_id}  周期: {', '.join(t['bar'] for t in tf_configs)}")
    print(f"   指标: {ind_str}  输出: {output_dir}")
    print("=" * 60)

    ok = 0
    for tf in tf_configs:
        print()
        if run_single(inst_id, tf["bar"], tf["visible"], tf["warmup"], indicators, output_dir):
            ok += 1
    print(f"\n{'='*60}\n🎉 {ok}/{len(tf_configs)} → {os.path.abspath(output_dir)}")


if __name__ == "__main__":
    main()
