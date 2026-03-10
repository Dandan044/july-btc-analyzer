# 设定市场警报任务

当收到"设定市场警报"指令时，按以下流程执行：

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
  interval: 5 * 60 * 1000, // 检查间隔：5分钟

  // 冷却状态（必须）
  lastTriggered: 0,

  async check() {
    // 冷却检查（必须放在最前面）
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    // 检测条件，返回 true/false
    const ticker = await api.getTicker('BTC');
    return ticker.price >= TARGET_PRICE; // 或 <= TARGET_PRICE
  },

  async collect() {
    // 收集数据，返回要传递给触发器的数据
    const ticker = await api.getTicker('BTC');
    const klines = await api.getKlines('BTC', '15m', 5);
    const fgi = await api.getFearGreedIndex(7);

    return {
      alertTime: new Date().toISOString(),
      currentPrice: ticker.price,
      // ... 其他数据
    };
  },

  async trigger(data) {
    // 使用异步方式（spawn），避免阻塞引擎
    const message = `即时分析\n${JSON.stringify(data, null, 2)}`;

    spawn('openclaw', ['agent', '--agent', 'july', '--message', message], {
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

### 3.1 冷却机制（必须）

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

// ✅ 正确：异步方式，不阻塞引擎
const { spawn } = require('child_process');
spawn('openclaw', ['agent', '--agent', 'july', '--message', message], {
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

可用方法：
- `getKlines(symbol, interval, limit)` - 获取K线数据
- `getTicker(symbol)` - 获取实时价格
- `get24hVolume(symbol)` - 获取24小时交易量
- `getPriceHistory(symbol, days)` - 获取历史价格
- `getFearGreedIndex(days)` - 获取恐惧贪婪指数

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
  interval: 5 * 60 * 1000,
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
      return false;
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
      return { alertTime: new Date().toISOString(), error: error.message };
    }
  },

  async trigger(data) {
    const message = `即时分析\n${JSON.stringify(data, null, 2)}`;

    // 异步触发，不阻塞引擎
    spawn('openclaw', ['agent', '--agent', 'july', '--message', message], {
      detached: true,
      stdio: 'ignore'
    });

    console.log('[警报触发] 已发送即时分析任务');

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