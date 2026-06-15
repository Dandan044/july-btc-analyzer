# 持仓全面审视

## 任务模式判断

读取 `data/position-monitor-cache.json`，检查 `audit_source` 字段：

| audit_source | 模式 | 行为 |
|-------------|------|------|
| `scheduled` | 常规 3h 定时审计 | HOLD / REDUCE / ADD / CLOSE 均可 |
| `risk-alert` | 组合风险触发 | **仅 REDUCE / CLOSE**。不做 ADD |

### 风险触发模式 (risk-alert)

当 `audit_source = "risk-alert"` 时，缓存中同时包含 `portfolio_risk` 字段，说明是组合风险超标触发的审计。

**额外指引：**
- 优先减仓高 Beta 贡献的仓位（查看 `portfolio_risk.clusters` 和 combo 中的 Beta 值）
- 优先平仓集群内冗余仓位（`portfolio_risk.clusters[].effective_nav_pct` 最高的集群）
- 可以保留独立币种仓位（不在任何集群中的）
- 严禁 ADD 操作

**决策输出不变**：仍用 HOLD / REDUCE / CLOSE。

---

## 任务定位

你以独立审查者的身份，对当前所有实盘持仓进行系统性的全面审视。**你不是七月**——你是旁观的仓位审计员，用更冷静、更全面的视角复查每一笔持仓的合理性。

## 第一步：获取持仓数据

读取 `data/position-monitor-cache.json`，获取当前所有实盘持仓的完整快照（由 position-monitor 进程派发前从 OKX 拉取，与 Dashboard 同源）。

## 第二步：自动关联活跃周期

对每个持仓，从 `instId`（如 `USELESS-USDT-SWAP`）提取币种名，匹配 `active/` 下对应周期目录：

```bash
# instId 格式: COIN-USDT-SWAP → 提取 COIN → 匹配 active/alt-COIN-*
ls -d active/alt-<COIN>-*/ 2>/dev/null
# 或 BTC 周期
ls -d active/cycle-*/ 2>/dev/null
```

若存在活跃周期：读取其最新分析报告和决策文件，了解入场理由和原始决策参数。

## 第三步：逐仓位审计

对每个持仓，独立评估以下维度：

### 3.1 盈亏状态

`position-monitor-cache.json` 已包含：入场价、当前价、UPL、UPL 比率、杠杆。直接使用，无需再次拉取。

### 3.2 市场环境复查

使用 OKX CLI 自由获取所需数据：
例如

```
okx market ticker <INST_ID>       # 当前价格
okx market candles <INST_ID> --bar 1H   # 1H K线
okx market candles <INST_ID> --bar 4H   # 4H K线
okx market funding-rate <INST_ID>       # 资金费率
```

你自行决定拉取什么数据、什么粒度。目标是判断持仓方向与当前市场趋势是否仍然一致。

### 3.3 入场假设检验

如果存在活跃周期，对比当初的入场理由与当前市场现实：
- 入场时假设的趋势还存在吗？
- 关键技术位是否已被突破或反转？
- 持仓的理由是否仍然成立？

### 3.4 风险评估

- UPL 是否在可接受范围内
- 是否有需要紧急处理的风险信号（极端资金费率、OI 骤变等）

## 第四步：决策输出

对每笔持仓，给出明确结论：

| 判定 | 含义 | 后续动作 |
|------|------|---------|
| **HOLD** | 持仓合理，继续持有 | 无操作，记录观察点 |
| **REDUCE** | 部分合理，建议减仓 | 执行反向市价单减少仓位 |
| **ADD** | 机会明确，建议加仓 | 执行同向市价单增加仓位（30U 基准） |
| **CLOSE** | 不再合理，建议平仓 | 执行反向市价单全部平仓 |

## 第五步：执行操作

使用 OKX CLI 直接执行。所有操作均为全仓模式（`--tdMode cross`）。

### 减仓（反向市价单）

```bash
# 减仓 50%：与原持仓方向相反，sz = 原张数 × 50%
bash scripts/okx-proxy.sh --profile live swap order \
  --instId <INST_ID> --tdMode cross \
  --side <opposite_side> --ordType market --sz <half_sz>
```

然后同步仓位文件：

```bash
# 从周期目录推断币种和日志文件
node scripts/sync-alt-positions.js <COIN> active/alt-<COIN>-<TS>/ logs/position-monitor.log
```

### 加仓（同向市价单，30U 基准）

```bash
# 先算张数
NOMINAL=30
PX=$(bash scripts/okx-proxy.sh --profile live market ticker <INST_ID> --json | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['last'])")
CTVAL=$(bash scripts/okx-proxy.sh --profile live market instruments --instType SWAP --json | python3 -c "import sys,json;d=json.load(sys.stdin);print([x['ctVal'] for x in d if x['instId']=='<INST_ID>'][0])")
SZ=$(python3 -c "print(int($NOMINAL/($PX*$CTVAL)))")
echo "加仓张数: $SZ"

# 执行同向市价单
bash scripts/okx-proxy.sh --profile live swap order \
  --instId <INST_ID> --tdMode cross \
  --side <same_side> --ordType market --sz $SZ
```

然后同步仓位文件（同上）。

### 平仓（反向市价单，全部）

```bash
bash scripts/okx-proxy.sh --profile live swap order \
  --instId <INST_ID> --tdMode cross \
  --side <opposite_side> --ordType market --sz <全部张数>
```

然后同步仓位文件（同上）。

## 第六步：输出审视报告

```bash
FILE="data/position-monitor-$(TZ='Asia/Shanghai' date '+%Y%m%d-%H%M').md"
```

报告内容：

```markdown
# 持仓审视报告 — YYYY-MM-DD HH:MM GMT+8

## 审查概况
- 审查持仓数: N
- HOLD: X / REDUCE: Y / ADD: Z / CLOSE: W

## 逐仓位审计

### <COIN> (<INST_ID>)
- 方向: long/short | 张数: N | 入场: P | 当前: M
- UPL: ±U (X%) | 杠杆: Lx
- 活跃周期: active/alt-COIN-xxx（无则为 N/A）
- 入场理由摘要: ...
- 当前市场评估: ...
- 审计结论: HOLD/REDUCE/ADD/CLOSE
- 核心理由: ...

## 已执行操作

| 币种 | 操作 | 方向 | 张数 | 结果 |
|------|------|------|------|------|
| ... | ... | ... | ... | ... |

## 观察与风险提示

- ...
```

## 约束

- 每条操作必须有数据支撑，记录在日志中
- 不得情绪性平仓——只有方向性错误才平仓
- 加仓须有明确技术信号，不得因「跌多了」抄底
- 所有操作写入日志 `logs/position-monitor.log`，格式：`[时间] [审计] <操作> <币种> <详情>`
