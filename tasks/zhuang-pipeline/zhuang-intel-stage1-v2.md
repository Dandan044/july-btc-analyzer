# 庄币阶段一 v2：Sentiment 收集 + 数据清单生成

此任务为庄币工作流阶段一，由预处理脚本（stage1-prep.js）完成后触发。

**你的唯一任务：收集媒体消息和链上数据，生成数据清单，然后进入阶段二。**

预处理脚本已完成：上线检查、周期创建、持仓同步、合约数据获取、历史报告路径收集。

---

## 触发方式

由庄币扫描引擎 + 预处理脚本完成后，通过 cron agentTurn 触发。

**入参格式**（由 scanner-zhuang-runner.sh 传递）：

```
币种: {COIN}
周期目录: active/{CYCLE_DIR}
持仓数: {N}
合约数据: OK
4h涨跌幅: {PCT}%
OI变化: {OI_PCT}%
请读取 tasks/zhuang-pipeline/zhuang-intel-stage1-v2.md 执行。
```

---

## 输入参数

| 参数 | 说明 | 示例 |
|------|------|------|
| 币种 | 目标币种 | `DOGE` |
| 周期文件夹路径 | 当前活跃周期文件夹 | `active/zhuang-DOGE-20260525-1600` |
| 日志文件路径 | `logs/zhuang-{COIN}-process.log` | `logs/zhuang-DOGE-process.log` |

---

## 输出产物

| 文件 | 路径 | 说明 |
|------|------|------|
| 消息面总结 | `{CYCLE_DIR}/data-context/sentiment-media.md` | 媒体搜索结果归纳 |
| 链上数据归纳 | `{CYCLE_DIR}/data-context/sentiment-onchain.md` | 链上指标汇总 |
| 数据清单 JSON | `{CYCLE_DIR}/data-context/data-manifest-*.json` | 由 manifest 脚本生成 |

---

## 执行

你有以下工具可用：`web_search`（搜索引擎）、`kimi_search`（备用）、`web_fetch`（抓取页面内容）、`kimi_fetch`（备用）。

#### Exa 搜索引擎参数（仅当 `web_search` provider 为 exa 时适用）

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `type` | `auto` | 模式：`auto`/`fast`/`instant`/`deep`/`deep-reasoning` |
| `count` | `5` | 结果数 1-100 |
| `freshness` | — | 时间过滤：`day`/`week`/`month`/`year`（与 date_after/date_before 互斥） |
| `date_after` | — | 发布日期晚于 YYYY-MM-DD |
| `date_before` | — | 发布日期早于 YYYY-MM-DD |
| `contents.highlights` | `true`（默认） | 高亮片段，最省 token |
| `contents.text` | — | 返回全文，可设 `{maxCharacters: N}` 限长 |
| `contents.summary` | — | AI 生成摘要，可设 `{query: "..."}` 引导 |

> 非 Exa 引擎时忽略以上参数，按原方式调用即可。

你可以自行判断使用哪个工具、搜索什么关键词、深入什么方向。

---

### 维度一：媒体消息

从这个维度审视 {COIN} 近期发生了什么——有哪些事件、叙事、情绪变化在影响市场对这个币种的看法。

**⚠️ 庄币视角：重点关注以下类型的信息**

- 项目方/庄家是否有近期动作（公告、代币解锁、合作伙伴、产品发布）
- 是否有 KOL/大 V 在喊单？消息的传播路径是怎样的？
- 社区情绪处于什么阶段——怀疑、FOMO、还是绝望？
- 是否有异常交易行为被讨论（如大额转账、交易所异常流入流出）

**时效规制：**
- 按时间倒序排列所有收集到的消息
- 使用分界线标注时间区间：`--- 七日前 ---`、`--- 十四日前 ---`
- 越近的消息越靠前，超过十四天的消息放在最后（不丢弃，但参考价值递减）

**出处要求：**
- 每条消息必须附带来源 URL
- 格式：`**来源:** [来源名](URL)`

**产出文件：** `{CYCLE_DIR}/data-context/sentiment-media.md`

按时间顺序总结消息面信号。不要做预测或交易建议。

> 若媒体搜索无有效结果，记录 `⚠️ WARN: 维度一无有效媒体信息`，标注 `status: failed`，停止该维度。不得用其他数据源替代。

---

### 维度二：链上数据

从这个维度审视 {COIN} 的链上活动揭示了什么——筹码在集中还是分散、聪明钱在做什么、持仓结构是否存在风险。

**⚠️ 庄币视角：链上数据对庄币尤为重要。** 链上筹码集中度是判断是否为庄币的核心指标之一。重点关注：
- Top 持仓地址的集中度和行为变化
- 是否有地址在近期大量增持或减持
- DEX 上的大额买卖模式

**获取方式：** 使用 `onchainos` CLI 工具（`okx-dex-token` 技能）。

#### 前置步骤：环境变量

**每次运行 onchainos 命令前必须加载认证环境变量：**

```bash
export $(cat ~/.onchainos/.env | grep -v '^#' | xargs)
```

> 如提示 `OKX_PASSPHRASE is required but not set`，说明未加载认证变量。

#### 步骤

先搜索代币地址。

**⚠️ 强制多链搜索策略：**

onchainOS 默认只搜索 Ethereum (chain 1) 和 Solana (chain 501)。**必须按以下顺序回退搜索，不能因首次搜索无果就标注失败：**

```bash
# 第1步：默认搜索（ETH + SOL）
onchainos token search --query {COIN}

# 第2步：如果第1步返回的结果中无目标代币，尝试 BSC 链
onchainos token search --query {COIN} --chains "56"

# 第3步：如果仍然无果，尝试其他常见链
onchainos token search --query {COIN} --chains "42161"    # Arbitrum
onchainos token search --query {COIN} --chains "8453"      # Base
onchainos token search --query {COIN} --chains "137"        # Polygon

# 第4步：全部失败才标注 status: failed
```

获取地址后，依次收集以下数据（可以并行调用）：

```bash
# 持有人分布
onchainos token holders --address <addr>

# 高级信息（风险等级、创建者、持仓集中度）
onchainos token advanced-info --address <addr>

# 持仓集群分析（集群集中度、跑路风险、新钱包占比）
onchainos token cluster-overview --address <addr>

# 近期 DEX 交易记录
onchainos token trades --address <addr>
```

**产出文件：** `{CYCLE_DIR}/data-context/sentiment-onchain.md`

总结你发现的链上信号。如果某个命令执行失败或数据不可用，诚实标注，不要编造。

> 若链上数据完全无法获取，记录 `⚠️ WARN: 维度二链上数据获取失败`，标注 `status: failed`。

---

## 记录日志

```bash
NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$NOW] [阶段一-sentiment] 开始收集 | coin={COIN}" >> {LOG_FILE}

# 维度一完成后
echo "[$NOW] [维度一] 媒体消息: 完成" >> {LOG_FILE}

# 维度二完成后
echo "[$NOW] [维度二] 链上数据: 完成" >> {LOG_FILE}
```

---

## 约束

**必须：**
- 两个维度各自产出文件，保存到 `{CYCLE_DIR}/data-context/` 下
- 每条消息附带来源 URL
- 使用分界线标注七日/十四日时间区间
- 链上数据标注数据来源

**禁止：**
- 不做价格预测
- 不给交易建议
- 不编造没有获取到的数据
- **不用其他渠道数据替代缺失维度**

---

## 完成后：生成数据清单 + 进入阶段二

**⚠️ 两个维度都完成后，必须依次执行以下两步，不可跳过。**

### 步骤 A：运行数据清单生成脚本

```bash
node scripts/gen-stage1-manifest.js {COIN} {CYCLE_DIR} \
  --contract-ok \
  --sentiment-media-ok \
  --sentiment-onchain-ok
```

脚本会自动检测 sentiment 文件是否存在并设置对应状态。

### 步骤 B：进入阶段二

数据清单生成后，立即读取 `tasks/zhuang-pipeline/zhuang-intel-stage2.md` 并开始执行阶段二庄币交叉验证分析。

---

## 执行流程总结

```
1. 读取本文件 → 执行媒体搜索 + 链上数据收集
2. 产出 sentiment-media.md + sentiment-onchain.md
3. 运行 gen-stage1-manifest.js → 生成数据清单 JSON
4. 读取 zhuang-pipeline/zhuang-intel-stage2.md → 进入阶段二
```

---

zhuang-intel-stage1-v2
