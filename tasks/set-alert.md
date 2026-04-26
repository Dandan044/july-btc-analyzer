# 设定市场警报任务

当你需要"设定市场警报"时，按以下流程执行：

## 0. ⚠️ 先测试数据获取逻辑（必须）

**在编写警报规则之前，必须先验证数据获取逻辑可用！**

### 0.1 执行步骤

1. 根据警报需求，确定需要调用的 API 方法（如 `getOKXTicker`、`getOKXKlines`、`get24hVolume` 等）
2. **手动调用一次**，检查返回数据：
   - 数据是否成功返回？
   - 数据格式是否符合预期？
   - 数值范围是否合理？（如成交额应该是几亿级别，不是几万）

### 0.2 测试方式

使用 node 命令直接测试：

```bash
node -e "
const api = require('./skills/btc-market-lite/scripts/api');
async function test() {
  const ticker = await api.getOKXTicker('BTC');
  console.log('价格:', ticker.price);
  console.log('change1h:', ticker.change1h);
  console.log('volume24h:', ticker.volume24h);
}
test().catch(console.error);
"
```

### 0.3 数据合理性检查

| 数据类型 | 合理范围示例 | 异常情况（需排查） |
|---------|-------------|-------------------|
| BTC 价格 | $60,000-$100,000 | 0.01 或 null |
| 24h成交额 | $300M-$500M | $0.01M |
| K线成交量 | 百万级 USDT | 几十 USDT |
| change1h/change24h | ±0.1% ~ ±5% | null 或 60000% |

### 0.4 发现问题时

**数据异常时，必须先修复 `skills/btc-market-lite/scripts/api.js`，再继续创建警报。**

常见问题：
- API 字段映射错误（如 OKX 返回数组 index 5/6 混淆）
- 数据单位错误（BTC vs USDT）
- limit 参数超出 API 限制

**不要在未验证数据的情况下直接创建规则文件！**

---

## 1. 理解警报需求

分析用户或自身分析发现的监控需求，确定：
- 监控目标（价格、交易量、指标等）
- 触发条件（突破、跌破、涨幅、跌幅等）
- 数据需求（K线周期、数量等）
- 触发后动作（执行即时分析任务）

## 2. 编写警报规则

根据需求，在 `skills/btc-alert/rules/` 目录下创建规则文件。

规则文件必须导出包含以下属性的对象：

```javascript
const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

// 警报创建日期（用于生命周期管理）
const CREATED_DATE = 'YYYY-MM-DD';
const TARGET_PRICE = xxxxx;
const COOLDOWN_MS = 60 * 60 * 1000; // 冷却时间：1小时

module.exports = {
  name: '规则名称',
  interval: 3 * 60 * 1000, // 检查间隔：3分钟（默认设定的技能检测间隔为3分钟）

  // 冷却状态（必须）
  lastTriggered: 0,

  async check() {
    // 冷却检查（必须放在最前面）
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    // 检测条件，返回 true/false
    // ⚠️ 注意：API 错误必须抛出，不能吞掉，否则引擎无法监控错误
    try {
      const ticker = await api.getTicker('BTC');
      return ticker.price >= TARGET_PRICE; // 或 <= TARGET_PRICE
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error; // 必须抛出，让引擎监控到错误
    }
  },

  async collect() {
    // 收集数据，返回要传递给触发器的数据
    // ⚠️ 注意：API 错误必须抛出，不能吞掉，否则引擎无法监控错误
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '15m', 5);
      const fgi = await api.getFearGreedIndex(7);

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        // ... 其他数据
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error; // 必须抛出，让引擎监控到错误
    }
  },

  async trigger(data) {
    // 使用 cron 创建隔离会话，每次警报触发独立分析
    const now = new Date().toISOString();
    const jobName = `alert-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}`;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--session', 'isolated',
      '--at', now,
      '--message', message,
      '--name', jobName,
      '--delete-after-run',
      '--no-deliver'
    ], {
      detached: true,
      stdio: 'ignore'
    });

    // 更新冷却时间（必须）
    this.lastTriggered = Date.now();
  },

  lifetime() {
    // ⚠️ 必须使用 api.getLocalDate() 而非 new Date().toISOString()（后者返回UTC日期，UTC+8下会差一天）
    const today = api.getLocalDate();
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
```

## 3. 必须遵守的规则

### 3.1 check() 日志输出规范（必须）

**每次心跳检查时，`check()` 的 console.log 必须包含以下三部分信息：**

#### ① API 数据来源说明

明确表示使用什么 API 获取了什么数据：

```
格式：[API] <数据源>获取<数据描述>
示例：[API] OKX获取BTC当前价格 | [API] CryptoCompare获取4根15分钟K线 | [API] OKX获取1H多空比数据
```

#### ② 触发进度可视化

当前值、阈值、触发状态组成可视化触发进程：

```
格式：[进度] <规则名> | <当前值描述> | <阈值描述> | 触发: <true/false>

示例：
- 价格警报：[进度] 关键支撑跌破-77500 | 当前价: $78938 | 目标: $77500 | 触发: false
- 多空比警报：[进度] 多空比恶化-0.65 | 当前比: 0.67 | 阈值: 0.65 | 触发: false
- 延迟触发：[进度] 延迟确认突破 | 突破已持续: 15分钟 | 等待: 30分钟 | 触发: false
- 定时器：[进度] 计划入场定时器 | 剩余时间: 2小时30分 | 触发时间: 14:00 | 触发: false
```

#### ③ 设立警报的来源依据

记录该警报设立的原因，来源于哪份报告的什么观点：

```
格式：[来源] <报告类型+日期>: "<核心观点摘要>"
示例：[来源] 04-22 21:00日报: "longShortRatio恶化至0.67，若继续恶化至0.65以下则空头挤压大概率爆发"
```

#### 完整示例

```javascript
async check() {
  if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

  try {
    const ticker = await api.getTicker('BTC');
    const currentPrice = ticker.price;
    const triggered = currentPrice < TARGET_PRICE;

    console.log(`[🔍警报检查] [API] CryptoCompare获取BTC实时价格 | [进度] ${this.name} | 当前价: $${currentPrice} | 目标: $${TARGET_PRICE} | 触发: ${triggered} | [来源] 04-22 21:51即时分析: "$77,500是关键支撑，跌破将破坏4H上升结构"`);
    
    return triggered;
  } catch (error) {
    console.error('[❌警报检查错误]', error.message);
    throw error;
  }
}
```

**日志输出效果：**
```
[🔍警报检查] [API] CryptoCompare获取BTC实时价格 | [进度] 关键支撑跌破警报-77500 | 当前价: $78938 | 目标: $77500 | 触发: false | [来源] 04-22 21:51即时分析: "$77,500是关键支撑，跌破将破坏4H上升结构"
```

#### 延迟触发警报的特殊格式

延迟触发警报需要额外显示等待进度：

```javascript
async check() {
  // ... 检测逻辑
  
  if (ticker.price >= TARGET_PRICE) {
    if (!this.breakthroughTime) {
      this.breakthroughTime = Date.now();
    }
    
    const elapsedMs = Date.now() - this.breakthroughTime;
    const elapsedMins = Math.floor(elapsedMs / 60000);
    const targetMins = DELAY_MS / 60000;
    
    console.log(`[🔍警报检查] [API] CryptoCompare获取BTC实时价格 | [进度] ${this.name} | 突破已持续: ${elapsedMins}分钟 | 等待确认: ${targetMins}分钟 | 当前价: $${ticker.price} | 目标: $${TARGET_PRICE} | 触发: ${elapsedMins >= targetMins} | [来源] 04-22 日报: "突破需确认，避免假突破"`);
  }
}
```

### 3.2 价格警报数量限制（必须）

**⚠️ 已废弃「上方1个/下方1个」限制，改为多价位监控模式。**

**新限制规则：**

| 类型 | 最大数量 | 说明 |
|------|---------|------|
| **价格价位** | **≤6 个** | 单个规则文件可包含多个价位（上方/下方不限） |
| 非价格警报 | ≤2 个 | 独立规则文件 |

**多价位监控的优势：**

1. 一次警报配置包含所有关键价位
2. 不需要在工作流中筛选价位
3. 单次触发可传递组合信息（多个价位同时被触发）
4. 减少规则文件数量

**新增警报时的处理逻辑**：

1. 检查 `skills/btc-alert/rules/` 目录下是否已有价格类警报
2. 若已有，评估是否需要更新价位列表：
   - 读取现有规则的价位配置
   - 对比新旧价位的有价值程度
   - 若新分析提供了更有价值的价位，更新规则文件
   - 若旧价位仍有意义但超出6个限制，保留最有价值的 ≤6 个
3. 确保总价位不超过6个

**例外**：非价格类警报（交易量、持仓量等）不受价位限制，但总数 ≤2 个。

### 3.2 禁止使用恐惧贪婪指数作为警报触发条件（必须）

❌ **FGI 不适合作为警报监控值**，原因：
- **更新频率低**：一天才更新一次，无法捕捉日内变化
- **警报器需要高频数据**：警报器检查间隔为分钟级，FGI 无法提供足够的敏感度
- **用途定位**：FGI 应作为**日报分析时的情绪参考**，而非**警报触发条件**

⚠️ 已存在的 FGI 警报必须删除。警报设计时禁止包含 FGI 相关的触发逻辑。

### 3.3 连续数据获取规范（必须）

**⚠️ 核心原则：使用K线区间数据，而非瞬时价格。**

**问题背景：**

警报器每隔 N 分钟检查一次。如果使用瞬时价格：
- 价格可能在两次检查之间短暂突破后拉回
- 警报器无法感知瞬时突破
- 导致错过重要的触发信号

**正确做法：获取K线片段，从区间高低价判断触发**

```javascript
// ❌ 错误：获取瞬时价格
async check() {
  const ticker = await api.getTicker('BTC');
  return ticker.price >= TARGET_PRICE; // 单点比较，可能漏掉瞬时突破
}

// ✅ 正确：获取K线片段
async check() {
  // 获取覆盖检查间隔的K线（如3分钟间隔 → 获取3根1分钟K线）
  const klines = await api.getKlines('BTC', '1m', 3);
  
  // 计算区间最高最低价
  const periodHigh = Math.max(...klines.map(k => k.high));
  const periodLow = Math.min(...klines.map(k => k.low));
  
  // 从区间判断是否曾到达目标位
  return periodHigh >= TARGET_PRICE; // 或 periodLow <= TARGET_PRICE
}
```

**数据获取规范：**

| 数据类型 | 错误方式 | 正确方式 | API方法 |
|---------|---------|---------|---------|
| **价格** | `getTicker()` 单点 | `getKlines()` K线区间 | `getKlines('BTC', '1m', N)` |
| **持仓量OI** | 单点数值 | OI历史数据 | OKX `/rubik/stat/contracts/open-interest-volume` |
| **交易量** | 单点数值 | 多根K线累计 | K线volume字段累加 |
| **多空比** | 单点数值 | 多时间点采样 | OKX `/rubik/stat/contracts/long-short-account-ratio` |
| **Taker买卖比** | 单点数值 | 多时间点采样 | OKX `/rubik/stat/taker-volume` |

**K线数量计算：**

- 检查间隔 = N 分钟
- 获取 N 根 1分钟K线（覆盖整个间隔）
- 或获取 ceil(N/5) 根 5分钟K线

**示例：**
- interval = 3分钟 → 获取 3 根 1m K线
- interval = 5分钟 → 获取 5 根 1m K线 或 1 根 5m K线
- interval = 15分钟 → 获取 15 根 1m K线 或 3 根 5m K线

### 3.4 创造性警报设计（必须）

**不要局限于简单的"价格到达目标位就触发"！** 警报器支持多种灵活的触发方式：

| 警报类型 | 适用场景 | 优势 |
|---------|---------|------|
| **延迟触发警报** | 突破后等待确认、避免假突破 | 观察突破后的走势稳定性，过滤假突破 |
| **定时器警报** | 计划入场时间、等待事件发酵 | 不依赖市场数据，纯时间驱动 |
| **交易量异动警报** | 大资金进出、市场活跃度变化 | 提前捕捉价格变动前的资金动向 |
| **振幅/波动率警报** | 剧烈波动、变盘前夕 | 捕捉市场异常状态 |
| **持仓量变化警报** | OI 增减、多空博弈 | 衍生品市场信号 |
| **多空比变化警报** | 散户情绪反转 | 交易侧数据，比价格更敏感 |
| **Taker买卖比警报** | 主动买/卖力量 | 实时交易意愿 |
| **资金费率警报** | 多空付费压力 | 衍生品市场情绪 |
| **组合条件警报** | 多维度同时满足 | 更精准的触发条件 |

**每次设定警报时，必须主动问自己：**
1. 除了价格，还有什么维度值得监控？
2. 当前市场有什么异常现象可能被价格警报忽略？
3. 是否需要延迟确认而非立即触发？

**如果连续多次只设定价格警报，说明思维已固化，需要主动打破。**

### 3.2 冷却机制（必须）

每条规则都必须包含冷却机制，防止频繁触发：

```javascript
// 在模块顶部定义冷却时间
const COOLDOWN_MS = 60 * 60 * 1000; // 建议 1 小时

// 在导出对象中维护状态
module.exports = {
  lastTriggered: 0, // 上次触发时间

  async check() {
    // 冷却检查必须放在 check() 最前面
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }
    // ... 其他检测逻辑
  },

  async trigger(data) {
    // 触发后必须更新冷却时间
    this.lastTriggered = Date.now();
  }
};
```

### 3.2 异步触发（必须）

trigger() 必须使用异步方式（spawn），不能使用 execSync：

```javascript
// ❌ 错误：同步方式会阻塞引擎
const { execSync } = require('child_process');
execSync('openclaw agent ...', { timeout: 30000 });

// ✅ 正确：异步方式，创建隔离会话执行即时分析
const { spawn } = require('child_process');
const now = new Date().toISOString();
spawn('openclaw', [
  'cron', 'add',
  '--agent', 'july',
  '--session', 'isolated',
  '--at', now,
  '--message', message,
  '--name', `alert-${Date.now()}`,
  '--delete-after-run',
  '--no-deliver'
], {
  detached: true,
  stdio: 'ignore'
});
```

**原因**：即时分析任务执行时间较长，使用同步方式会导致：
- 引擎被阻塞，无法检查其他规则
- 超时错误导致触发失败

### 3.3 生命周期管理

合理设置 `lifetime()`：
- 当天有效：`today === CREATED_DATE ? 'active' : 'expired'`
- 多日有效：计算日期差
- 一次性触发：触发后返回 `'completed'`

## 4. 可用的 API

引入市场数据 API：
```javascript
const api = require('../../btc-market-lite/scripts/api');
```

**已封装的方法**（定义在 `skills/btc-market-lite/scripts/api.js`）：

| 方法 | 说明 | 数据源 |
|------|------|--------|
| `getKlines(symbol, interval, limit)` | 获取K线数据（支持 1m, 5m, 15m, 1h, 4h, 1d） | CryptoCompare |
| `getTicker(symbol)` | 获取实时价格 + 涨跌幅 | CryptoCompare |
| `get24hVolume(symbol)` | 获取24小时交易量（小时级） | CryptoCompare |
| `getPriceHistory(symbol, days)` | 获取历史价格（日线） | CryptoCompare |
| `getFearGreedIndex(days)` | 获取恐惧贪婪指数 | alternative.me |
| `fetch(url)` | **通用 HTTP 请求工具** | 任意 API |

---

### ⚠️ API 扩展机制

**这些方法不是全部！** 只是已封装的常用方法。你有两种方式扩展：

#### 方式 1：使用 `api.fetch()` 调用任意 API

`fetch` 方法已导出，可以直接调用任意 HTTP API：

```javascript
const api = require('../../btc-market-lite/scripts/api');

async check() {
  // 示例：获取交易所净流入流出数据
  const data = await api.fetch('https://api.example.com/btc/flow');
  return data.netflow > 10000;
}
```

#### 方式 2：在 api.js 中添加新方法

如果某个 API 需要反复使用，可以在 `skills/btc-market-lite/scripts/api.js` 中封装：

```javascript
// 添加新方法到 api.js
async function getFundingRate() {
  const data = await fetch('https://api.coinglass.com/api/fundingRate/v2/home');
  return data.data;
}

// 更新导出
module.exports = {
  // ... 现有方法
  getFundingRate
};
```

#### 可扩展的数据源（举例）

| 数据类型 | 可用 API | 用途 |
|---------|---------|------|
| 链上数据 | Blockchain.info, Glassnode | 交易所流入流出、活跃地址 |
| 衍生品数据 | Coinglass API | 期货持仓、资金费率、清算数据 |
| 交易所数据 | OKX API | 订单簿深度、大单监控（国内需代理） |
| 市场情绪 | LunarCrush, Santiment | 社交媒体情绪、趋势 |
| 宏观经济 | FRED API | 利率、通胀数据 |

**注意**：使用新 API 前，请确认：
1. API 是否需要认证（API Key）
2. 是否有请求频率限制
3. 返回数据格式是否稳定

## 5. 创建规则文件

使用 write 工具创建规则文件：
```
/root/.openclaw/workspace-july/skills/btc-alert/rules/<YYYY-MM-DD>-<类型>-<价格>.js
```

命名示例：
- `2026-03-05-resistance-75000.js` - 压力位突破
- `2026-03-05-support-71000.js` - 支撑位跌破

## 6. 日志记录

创建完成后，必须记录到日志文件 `logs/alert-setup.log`：

格式：
```
[YYYY-MM-DD HH:mm:ss] 警报设定完成
  规则名称: xxx
  文件路径: skills/btc-alert/rules/xxx.js
  检查间隔: xx 分钟
  冷却时间: xx 分钟
  触发条件: xxx
  有效期: xxx
```

## 7. 确认输出

创建完成后：
1. 输出规则文件路径
2. 说明规则将在什么条件下触发
3. 提醒用户重启警报器引擎（如果引擎正在运行）

---

## 完整示例

```javascript
/**
 * 压力位突破警报
 * 监控 BTC 价格突破目标位
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-03-05';
const TARGET_PRICE = 75000;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '压力位突破警报-75000',
  interval: 3 * 60 * 1000, // 默认设定的技能检测间隔为3分钟
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[警报检查] 当前价格: ${ticker.price}, 目标: ${TARGET_PRICE}`);
      return ticker.price >= TARGET_PRICE;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error; // 必须抛出，让引擎监控到错误
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '15m', 5);
      const fgi = await api.getFearGreedIndex(7);

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h,
          '7d': ticker.change7d
        },
        volume24h: ticker.volume24h,
        fearGreedIndex: fgi.current,
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        triggerPrice: TARGET_PRICE,
        alertType: '压力位突破'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error; // 必须抛出，让引擎监控到错误
    }
  },

  async trigger(data) {
    // 使用 cron 创建隔离会话，每次警报触发独立分析
    const now = new Date().toISOString();
    const jobName = `alert-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}`;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--session', 'isolated',
      '--at', now,
      '--message', message,
      '--name', jobName,
      '--delete-after-run',
      '--no-deliver'
    ], {
      detached: true,
      stdio: 'ignore'
    });

    console.log(`[警报触发] 已创建即时分析任务: ${jobName}`);

    // 更新冷却时间
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = api.getLocalDate();
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
```

⚠️ 所有新规则默认触发即时分析任务。

---

## 8. 非价格类警报示例

除了支撑/阻力位的价格警报，系统支持监控多种市场维度。以下是一个**交易量异动警报**的完整示例：

```javascript
/**
 * 交易量异动警报
 * 监控 BTC 小时交易量异常放大（超过30日均值2倍）
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-03-25';
const VOLUME_MULTIPLIER = 2; // 触发阈值：均值倍数
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '交易量异动警报',
  interval: 5 * 60 * 1000, // 5分钟检查一次
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;
    
    try {
      // 获取24小时交易量（小时级数据）
      const volumeData = await api.get24hVolume('BTC');
      
      // 获取30日历史交易量
      const priceHistory = await api.getPriceHistory('BTC', 30);
      const avgVolume = priceHistory.volumes.reduce((a, b) => a + b, 0) / priceHistory.volumes.length;
      
      const currentVolume = volumeData.volume24h;
      const ratio = currentVolume / avgVolume;
      
      console.log(`[警报检查] 当前交易量: $${(currentVolume/1e9).toFixed(2)}B, 均值: $${(avgVolume/1e9).toFixed(2)}B, 比率: ${ratio.toFixed(2)}x`);
      
      return ratio >= VOLUME_MULTIPLIER;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error; // 必须抛出，让引擎监控到错误
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const volumeData = await api.get24hVolume('BTC');
      const priceHistory = await api.getPriceHistory('BTC', 30);
      const avgVolume = priceHistory.volumes.reduce((a, b) => a + b, 0) / priceHistory.volumes.length;
      const klines = await api.getKlines('BTC', '1h', 6);

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        currentVolume: volumeData.volume24h,
        averageVolume: avgVolume,
        volumeRatio: (volumeData.volume24h / avgVolume).toFixed(2),
        hourlyVolume: volumeData.hourlyData,
        klines1h: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '交易量异动',
        significance: '大资金可能正在进场或离场，需关注价格突破方向'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error; // 必须抛出，让引擎监控到错误
    }
  },

  async trigger(data) {
    const spawnMessage = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}`;
    const now = new Date().toISOString();
    const jobName = `alert-volume-${Date.now()}`;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--session', 'isolated',
      '--at', now,
      '--message', spawnMessage,
      '--name', jobName,
      '--delete-after-run',
      '--no-deliver'
    ], {
      detached: true,
      stdio: 'ignore'
    });

    console.log(`[警报触发] 已创建即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired'; // 有效期3天
  }
};
```

---

## 9. ⭐ 定时器警报示例（纯时间触发）

**定时器警报不依赖市场数据，只依赖时间判断。** 适用场景：
- 计划入场时间提醒（如"N小时后检查入场条件"）
- 定时检查市场状态
- 等待某事件发生后的定时观察

```javascript
/**
 * 定时器警报（延迟触发）
 * 不依赖市场数据，纯时间触发
 * 适用场景：计划入场时间提醒
 */

const { spawn } = require('child_process');
const api = require('../../btc-market-lite/scripts/api');

const CREATED_DATE = '2026-03-31';
const CREATED_TIME = Date.now();          // 规则创建时间
const TRIGGER_DELAY_MS = 4 * 60 * 60 * 1000; // 4小时后触发

module.exports = {
  name: '计划入场定时器-4小时',
  interval: 30 * 60 * 1000, // 30分钟检查一次（定时器不需要高频检查）
  lastTriggered: 0,

  async check() {
    // 简单判断：当前时间是否超过计划触发时间
    const now = Date.now();
    const triggerTime = CREATED_TIME + TRIGGER_DELAY_MS;
    
    if (now >= triggerTime) {
      console.log(`[定时器检查] 已到达触发时间: ${new Date(triggerTime).toISOString()}`);
      return true;
    }
    
    const remainingMs = triggerTime - now;
    const remainingHours = Math.floor(remainingMs / (60 * 60 * 1000));
    const remainingMins = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
    console.log(`[定时器检查] 距触发时间还有 ${remainingHours}小时${remainingMins}分钟`);
    
    return false;
  },

  async collect() {
    // 定时器触发时，收集当前市场快照供即时分析使用
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '1h', 4);
      
      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        klines1h: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close
        })),
        alertType: '计划入场提醒',
        message: '设定的入场观察时间已到，请检查是否满足入场条件'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `timer-alert-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}`;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--session', 'isolated',
      '--at', now,
      '--message', message,
      '--name', jobName,
      '--delete-after-run',
      '--no-deliver'
    ], {
      detached: true,
      stdio: 'ignore'
    });

    console.log(`[定时器触发] 已创建即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    // 定时器是一次性的，触发后即完成
    const now = Date.now();
    if (now >= CREATED_TIME + TRIGGER_DELAY_MS) {
      return 'completed';
    }
    return 'active';
  }
};
```

**⚠️ 定时器警报命名建议：**

使用格式：`YYYY-MM-DD-timer-Nh.js`（N表示延迟小时数）

例如：`2026-03-31-timer-4h.js`

---

## 10. ⭐ 延迟触发警报示例（价格条件 + 延迟确认）

**延迟触发警报在价格条件满足后，等待一段时间再触发即时分析。** 适用场景：
- 突破后等待确认（避免假突破）
- 跌破后等待反弹确认
- 价格触及关键位后观察走势

```javascript
/**
 * 延迟触发警报
 * 价格条件满足后，延迟一段时间再触发即时分析
 * 用于观察突破是否有效，避免假突破
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-03-31';
const TARGET_PRICE = 75000;
const DELAY_MS = 30 * 60 * 1000; // 突破后等待30分钟
const COOLDOWN_MS = 60 * 60 * 1000;

module.exports = {
  name: '压力位突破-延迟确认-75000',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,
  
  // ⭐ 延迟状态管理
  breakthroughTime: null,  // 记录突破发生时间

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const ticker = await api.getTicker('BTC');

      if (ticker.price >= TARGET_PRICE) {
        // 突破发生
        if (!this.breakthroughTime) {
          this.breakthroughTime = Date.now();
          console.log(`[突破检测] 价格已突破 ${TARGET_PRICE}，开始计时...`);
        }
        
        // 检查是否已延迟足够时间
        if (Date.now() - this.breakthroughTime >= DELAY_MS) {
          console.log(`[延迟确认] 突破已稳定 ${DELAY_MS / 60000} 分钟，触发警报`);
          return true; // 延迟确认完成，触发警报
        }
        
        const elapsedMs = Date.now() - this.breakthroughTime;
        const elapsedMins = Math.floor(elapsedMs / 60000);
        console.log(`[等待确认] 突破已持续 ${elapsedMins} 分钟，等待 ${DELAY_MS / 60000} 分钟`);
      } else {
        // 价格回落，重置计时
        if (this.breakthroughTime) {
          console.log(`[突破失效] 价格回落至 ${ticker.price}，重置计时`);
          this.breakthroughTime = null;
        }
      }
      
      return false;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '15m', 10); // 获取延迟期间的K线
      
      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        triggerPrice: TARGET_PRICE,
        breakthroughTime: this.breakthroughTime ? new Date(this.breakthroughTime).toISOString() : null,
        delayMinutes: DELAY_MS / 60000,
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '延迟确认警报',
        message: `价格突破 ${TARGET_PRICE} 后已稳定 ${DELAY_MS / 60000} 分钟，确认有效突破`
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `delayed-alert-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}`;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--session', 'isolated',
      '--at', now,
      '--message', message,
      '--name', jobName,
      '--delete-after-run',
      '--no-deliver'
    ], {
      detached: true,
      stdio: 'ignore'
    });

    console.log(`[警报触发] 已创建即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
    this.breakthroughTime = null; // 重置突破时间
  },

  lifetime() {
    const today = api.getLocalDate();
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
```

**⚠️ 延迟触发警报命名建议：**

使用格式：`YYYY-MM-DD-delayed-<类型>-<价格>.js`

例如：`2026-03-31-delayed-resistance-75000.js`

---

## 11. ⚠️ 发散思维：警报类型的可能性

**不要局限于价格警报！** 系统框架支持任意维度的监控，只要 `check()` 返回布尔值即可。

**可实现的警报类型（举例，非穷尽）**：

| 警报类型 | 实现思路 | 适用场景 |
|---------|---------|---------|
| **价格警报** | 价格 >= 或 <= 目标位 | 支撑/阻力位监控 |
| **定时器警报** | 纯时间判断，无数据依赖 | 计划入场时间提醒、定时检查 |
| **延迟触发警报** | 条件满足后等待N分钟 | 确认突破有效性、避免假突破 |
| **交易量异动** | 小时交易量 > N日均值 × M | 大资金进出 |
| **振幅警报** | 1小时 high-low > 阈值% | 剧烈波动 |
| **波动率收窄** | 连续N小时振幅递减 | 变盘前夕 |
| **快速涨跌** | N分钟内涨跌幅 > 阈值% | 突发行情 |
| **连阳/连阴** | 连续N根同向K线 | 趋势加速 |
| **交易量萎缩** | 交易量 < 均值 × 0.5 | 市场冷清 |
| **持仓量变化** | OI 24h内增减 > 阈值% | 多空博弈 |
| **多空比反转** | 多空比从 <1 反转为 >1.2 | 散户情绪反转 |
| **Taker买卖比** | Taker比偏离常态 | 主动交易意愿 |
| **资金费率异常** | 费率 > 0.01% 或 < -0.01% | 多空付费压力 |
| **突破失败确认** | 突破后N小时内跌回 | 假突破 |
| **...** | **自由发挥** | **不限** |

**警示**：每次设定警报时，主动问自己：

1. 当前市场有什么异常？
2. 有哪些维度的变化值得提前预警？
3. 是否只盯着价格而忽略了其他信号？

**如果连续多次只设定价格警报，说明思维已固化，需要主动打破。**

---

## 12. ⭐ 多价位监控规则模板（推荐）

**单规则监控多个价位，一次触发传递组合信息。**

**核心特性：**
- 单个规则文件可包含 ≤6 个价位
- 使用K线区间数据判断触发（而非瞬时价格）
- 单次触发传递所有被触发的价位信息（组合触发）
- 避免多次触发导致的冗余即时分析

**完整模板：**

```javascript
/**
 * 多价位监控警报
 * 监控多个关键价位，使用K线区间数据捕捉瞬时突破
 * 单次触发传递组合信息
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-23';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// ⭐ 多价位配置（最多6个）
// 每个价位包含：价格、类型（resistance/support）、标签、触发动作、优先级
const PRICE_LEVELS = [
  { price: 79443, type: 'resistance', label: '旗形顶部', action: '做多B', priority: 'high' },
  { price: 80000, type: 'resistance', label: '整数关口', action: null, priority: 'low' },
  { price: 81500, type: 'resistance', label: '前高压力', action: '趋势反转', priority: 'medium' },
  { price: 77500, type: 'support', label: '关键支撑', action: '情景C', priority: 'high' },
  { price: 74980, type: 'support', label: '情景C目标', action: '止盈', priority: 'medium' },
  { price: 73596, type: 'support', label: '深度支撑', action: null, priority: 'medium' }
];

module.exports = {
  name: '多价位监控警报',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,
  
  // ⭐ 当前触发的价位组合（供 collect() 使用）
  currentTriggeredLevels: [],
  
  // 触发历史记录（可选，用于调试）
  triggeredHistory: [],

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      // ⭐ 获取K线片段（而非瞬时价格）
      // 获取覆盖检查间隔的K线数量：interval=3分钟 → 3根1分钟K线
      const klines = await api.getKlines('BTC', '1m', 3);
      
      // 计算区间高低价
      const periodHigh = Math.max(...klines.map(k => k.high));
      const periodLow = Math.min(...klines.map(k => k.low));
      const latestPrice = klines[klines.length - 1].close;

      // ⭐ 批量检查所有价位
      const triggeredLevels = [];
      
      for (const level of PRICE_LEVELS) {
        const wasTriggered = 
          (level.type === 'resistance' && periodHigh >= level.price) ||
          (level.type === 'support' && periodLow <= level.price);
        
        if (wasTriggered) {
          triggeredLevels.push(level);
        }
      }

      // ⭐ 组合触发：如果有任何价位被触发，返回true
      if (triggeredLevels.length > 0) {
        // 存储触发的价位组合，供 collect() 使用
        this.currentTriggeredLevels = triggeredLevels;
        
        // 记录日志（组合信息）
        const levelStr = triggeredLevels.map(l => `$${l.price}(${l.label})`).join(', ');
        console.log(`[🔍警报检查] [API] CryptoCompare获取BTC 3分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(0)}-$${periodHigh.toFixed(0)} | 当前: $${latestPrice.toFixed(0)} | 触发价位: ${levelStr} | 触发: true`);
        
        return true;
      }

      // 未触发日志
      console.log(`[🔍警报检查] [API] CryptoCompare获取BTC 3分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(0)}-$${periodHigh.toFixed(0)} | 当前: $${latestPrice.toFixed(0)} | 触发: false`);
      
      return false;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      // ⭐ 传递组合触发信息
      const triggeredLevels = this.currentTriggeredLevels || [];
      
      const ticker = await api.getTicker('BTC');
      const klines15m = await api.getKlines('BTC', '15m', 8);
      
      // 尝试获取OKX数据（如果可用）
      let oiData = null;
      let takerData = null;
      try {
        oiData = await api.getOKXOpenInterest ? await api.getOKXOpenInterest() : null;
        takerData = await api.getOKXTakerRatio ? await api.getOKXTakerRatio() : null;
      } catch (e) {
        console.log('[数据收集] OKX数据获取失败，继续使用其他数据');
      }

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        
        // ⭐ 组合触发信息（关键字段）
        triggeredLevels: triggeredLevels.map(l => ({
          price: l.price,
          type: l.type,
          label: l.label,
          action: l.action,
          priority: l.priority
        })),
        
        // 区间信息（证明触发依据）
        periodRange: {
          high: Math.max(...klines15m.slice(-3).map(k => k.high)),
          low: Math.min(...klines15m.slice(-3).map(k => k.low))
        },
        
        // 其他市场数据
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        openInterest: oiData?.currentOI,
        takerBuyRatio: takerData?.currentRatio,
        klines15m: klines15m.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        
        alertType: '多价位触发',
        significance: this.buildSignificance(triggeredLevels)
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  // ⭐ 构建组合触发的重要性描述
  buildSignificance(levels) {
    if (levels.length === 0) return '无触发';
    
    const actions = levels.filter(l => l.action).map(l => l.action);
    const labels = levels.map(l => `${l.label}($${l.price})`);
    
    if (levels.length === 1) {
      const l = levels[0];
      return l.action 
        ? `价格触及${l.label}($${l.price})，触发动作: ${l.action}`
        : `价格触及${l.label}($${l.price})`;
    }
    
    // 多价位组合触发
    const actionStr = actions.length > 0 ? `，触发动作: ${actions.join(' / ')}` : '';
    return `价格区间跨越多个关键位: ${labels.join('、')}${actionStr}`;
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-multi-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}`;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--session', 'isolated',
      '--at', now,
      '--message', message,
      '--name', jobName,
      '--delete-after-run',
      '--no-deliver'
    ], {
      detached: true,
      stdio: 'ignore'
    });

    // 记录触发历史
    this.triggeredHistory.push({
      time: new Date().toISOString(),
      levels: data.triggeredLevels
    });
    
    console.log(`[警报触发] 已创建即时分析任务: ${jobName}，触发价位: ${data.triggeredLevels.length}个`);
    this.lastTriggered = Date.now();
    
    // 清空当前触发记录
    this.currentTriggeredLevels = [];
  },

  lifetime() {
    const today = api.getLocalDate();
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
```

**组合触发说明：**

| 场景 | 区间示例 | 触发价位 | collect返回 |
|------|---------|---------|------------|
| 单价位触发 | $78,000-$78,500 | 仅$77,500(支撑跌破) | `triggeredLevels: [{price:77500,...}]` |
| 多价位组合 | $77,000-$79,500 | $77,500+$74,980+$79,443 | `triggeredLevels: [{...},{...},{...}]` |
| 无触发 | $78,200-$78,400 | 无 | 不触发 |

**即时分析如何处理组合信息：**

阶段二收到 `triggeredLevels` 数组后：
- 单价位 → 按原逻辑处理
- 多价位 → 综合判断优先级：
  - `priority: 'high'` 且有 `action` → 优先执行
  - 多个高位价位同时触发 → 可能意味着剧烈波动，需谨慎

---

**⚠️ 多价位规则命名建议：**

使用格式：`YYYY-MM-DD-multi-price.js`

例如：`2026-04-23-multi-price.js`