### 步骤 {{step_trade_json}}: 输出开仓数据（JSON）

**⚠️ OCO 止盈止损已执行检查（警报触发分析专属）：**

如果你是因为止盈/止损价位触发而被唤醒来做本次分析，那么触发你进来的那笔 OCO 止盈止损单**极有可能已经在交易所自动执行完毕**——OCO 是交易所级委托，价格触及即成交，远快于警报引擎的延迟确认。

**在输出 `action: "reduce"` 或 `action: "close"` 之前，必须执行以下检查：**
1. 读取 `positions.json`，检查 `操作记录` 中是否有 `"OCO止盈触发"` 或 `"OCO止损触发"` 类型的条目
2. 对比上一份报告中的持仓张数和当前 `positions.json` 的持仓张数——如果持仓已经减少，减少量是否与当初设定的止盈比例吻合？
3. 如果 OCO 已经执行了止盈/止损 → **不要再次输出 `reduce` 或 `close` 操作**，已经完成的仓位减少不需要重复执行
4. 此时的正确做法：根据**剩余仓位**重新评估，给出 `hold`（持有剩余仓位观察）或 `adjust`（调整剩余仓位的止盈止损位）

> 示例：上一份报告开仓 93 张，设定 TP1 @ $0.35 平仓 50%。本次因 $0.35 触发被唤醒。positions.json 显示持仓仅剩 47 张，操作记录有"OCO止盈触发"条目。此时应输出 `action: "hold"` 或 `action: "adjust"`（移动剩余仓位止损），而非 `action: "reduce"`。

---

**⚠️ 必须执行。** 报告保存后，必须同时输出机器可读的结构化 JSON 文件，供阶段三脚本直接读取。

**文件命名规则：**
- 格式：`trade-decision-{COIN}-YYYY-MM-DD-HHMM.json`
- 保存路径：`active/{CYCLE_DIR}/reports/trade-decision-{COIN}-YYYY-MM-DD-HHMM.json`

**JSON 结构（严格按此格式，不要增减字段）：**

```json
{
  "coin": "ONDO",
  "pipeline_profile": "{{prefix}}",
  "report_file": "{{report_prefix}}-ONDO-2026-05-21-1830.md",
  "action": "open",
  "direction": "long",
  {{#zhuang_stage}}
  "zhuang_stage": "launch",
  {{/zhuang_stage}}
  "entry_condition": "immediate",
  "nominal_base": 30,
  "calc_position_input": {
    "entry": 0.15,
    "x": {{x_default}},
    "levels": [0.14, 0.13, 0.12]
  },
  "calc_position_output": null,
  "stop_loss": 0.13,
  "take_profit1": 0.18,
  "take_profit2": 0.21,
  "tp1_ratio": 50,
  "trailing_callback_ratio": null,
  "reject_reason": null,
  "reduce_ratio": null,
  "observation_conditions": []
}
```

**字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `coin` | string | 币种代码 |
| `report_file` | string | 对应的报告文件名 |
| `action` | string | `open` / `add` / `reduce` / `close` / `adjust` / `hold` / `wait` / `abort` |

> 🚫 **action 字段只能使用上述 8 个值之一，严格匹配大小写。禁止使用 `skip` / `watch` / `观望` / `skip_execution` / `none` / `pending` 等任何变体。不操作 = `wait`，持仓中不操作 = `hold`，首周期无法定向 = `abort`——没有其他名字。** |
| `direction` | string | `long` / `short`（开仓/加仓时必填） |

{{#zhuang_stage}}
| `zhuang_stage` | string | 庄家行为阶段：`accumulation` / `launch` / `distribution` / `crash` |
{{/zhuang_stage}}
| `entry_condition` | string | `immediate`（立即执行）或描述等待触发的条件 |
| `nominal_base` | number | 建议名义仓位（USDT），未指定则默认 30 |
| `calc_position_input` | object | 传给 calc-position.js 的参数 `{entry, x, levels}` |
| `calc_position_output` | object/null | calc-position.js 的完整 JSON 输出（执行后填入） |
| `stop_loss` | number | 止损价位 |
| `take_profit1` | number | 止盈1价位 |
| `take_profit2` | number/null | 止盈2价位（可选） |
| `tp1_ratio` | number | TP1 平仓比例（默认 50） |
| `trailing_callback_ratio` | number/null | 追踪止损回撤比例（小数，0.05=5%）。设置后阶段三会额外/替代创建 `swap algo trail` 订单。与 OCO 并存时为双重保护（追踪止损 + 固定止盈止损）。null 表示不启用 |
| `reject_reason` | string/null | 开仓被拒绝的原因（盈亏比不足/脚本REJECT等），null 表示允许 |
| `reduce_ratio` | number/null | 减仓比例（如 50），仅 action=reduce 时需要 |
| `observation_conditions` | string[] | 观望时列出的观察条件，只能使用合约数据面指标 |

**字段选择规则：**
- `action = open/add` → `direction`、`calc_position_input`、`stop_loss` 必填。`take_profit1` 为 null 时表示不设固定止盈（通常配合 `trailing_callback_ratio` 使用）
- `action = reduce` → `reduce_ratio` 必填
- `action = adjust` → `stop_loss`、`take_profit1` 填新价位
- `action = close` → 只需 `action: "close"`
- `action = hold` → 持仓中观望，`observation_conditions` 必填
- `action = wait` → 无持仓等待条件，`observation_conditions` 必填，**observation_conditions 中的价位必须同步写入 alert-candidates 的 `create_rules`**
- `reject_reason` 非 null 时，阶段三会跳过执行

> ⚠️ **已废弃：** 限价单和条件单开仓模式已不再使用。开仓统一使用市价单（market order）。

**止盈止损组合模式（仅 market 生效）：**

| take_profit1 | stop_loss | trailing_callback_ratio | 阶段三行为 |
|:-----------:|:---------:|:-----------------------:|-----------|
| 有值 | 有值 | null | **OCO**（固定止盈止损）— 默认模式 |
| null | 有值 | 有值 | **仅追踪止损**（不设固定止盈）— 追入模式 |
| 有值 | 有值 | 有值 | **双重保护**（OCO + 追踪止损并存）— 灵活性最大 |
| null | 有值 | null | 自动设默认 ±5% OCO 兜底 |

**日志记录：**
```
[$NOW] [阶段二] 开仓数据已保存: reports/trade-decision-{COIN}-YYYY-MM-DD-HHMM.json
```

> ⚠️ **calc_position_output 在执行 calc-position.js 后填入**，如果你选择不执行脚本计算（如观望状态），则保持为 `null`。

---

