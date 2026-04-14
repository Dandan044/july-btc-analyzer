# 设定市场警报任务

当你需要"设定市场警报"时，按以下流程执行：

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
    // 返回 'active' / 'expired' / 'completed'
    const today = new Date().toISOString().split('T')[0];
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
```

## 3. 必须遵守的规则

### 3.1 价格警报数量限制（必须）

为防止警报冗余，价格类警报最多同时存在：

| 类型 | 最大数量 | 说明 |
|------|---------|------|
| 支撑位跌破警报 | **1 个** | 只监控最接近当前价格的关键支撑 |
| 阻力位突破警报 | **1 个** | 只监控最接近当前价格的关键阻力 |

**新增警报时的处理逻辑**：

1. 检查 `skills/btc-alert/rules/` 目录下是否已有同类型价格警报
2. 若已有，评估新旧警报的目标位与当前价格的距离：
   - 保留更接近当前价格的警报（更紧迫）
   - 归档较远的警报（移动到 `rules/archive/`）
3. 若新警报目标位更接近，则替换旧警报

**示例**：
- 当前价格 $71,692，已有支撑警报 $70,500（距离 $1,192）
- 新增支撑警报 $69,500（距离 $2,192）
- 判断：$70,500 更接近 → 保留 $70,500，不创建 $69,500

**例外**：非价格类警报（多空比、交易量等）不受此限制。

### 3.2 禁止使用恐惧贪婪指数作为警报触发条件（必须）

❌ **FGI 不适合作为警报监控值**，原因：
- **更新频率低**：一天才更新一次，无法捕捉日内变化
- **警报器需要高频数据**：警报器检查间隔为分钟级，FGI 无法提供足够的敏感度
- **用途定位**：FGI 应作为**日报分析时的情绪参考**，而非**警报触发条件**

⚠️ 已存在的 FGI 警报必须删除。警报设计时禁止包含 FGI 相关的触发逻辑。

### 3.3 创造性警报设计（必须）

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
    const today = new Date().toISOString().split('T')[0];
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
    const today = new Date().toISOString().split('T')[0];
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
    const today = new Date().toISOString().split('T')[0];
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