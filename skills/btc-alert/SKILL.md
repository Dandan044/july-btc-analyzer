# BTC 警报器技能

这是一个空白警报框架，供智能体根据分析结果现场编写规则。

## 概述

警报器引擎会挂载多个规则，每个规则按自己定义的间隔独立执行。你可以根据市场分析发现的关键点位，动态创建警报规则。

## 规则接口

每个规则文件必须导出一个对象，包含以下属性：

| 属性/方法 | 类型 | 必需 | 说明 |
|-----------|------|------|------|
| `name` | string | 是 | 规则名称，用于日志和调试 |
| `interval` | number | 是 | 执行间隔（毫秒） |
| `check()` | async function | 是 | 检测条件，返回 boolean |
| `collect()` | async function | 是 | 收集数据，返回任意数据结构 |
| `trigger(data)` | async function | 是 | 触发动作，接收 collect() 返回的数据 |
| `lifetime()` | function | 是 | 返回规则状态：'active' / 'expired' / 'completed' |

## 执行流程

```
引擎启动
    │
    ▼
加载 rules/ 目录下所有 .js 文件
    │
    ▼
为每个规则启动独立定时器（间隔 = rule.interval）
    │
    ▼
每次触发：
    1. 检查 lifetime() 是否为 'active'
    2. 执行 check()，若返回 true：
       - 执行 collect() 获取数据
       - 执行 trigger(data) 触发动作
    3. 若 lifetime() 非 'active'，停止该规则的定时器
```

## 可复用资源

### 市场数据 API

可直接使用 `btc-market-lite` 技能的数据获取能力：

```js
// 在规则中引入
const api = require('../btc-market-lite/scripts/api');

// 可用方法（需要确保 api.js 导出这些方法）
const { getKlines, getTicker, get24hVolume } = api;
```

### OpenClaw 能力

使用 `openclaw agent` 命令触发七月执行任务：

```js
const { execSync } = require('child_process');

// 触发七月执行任务
execSync(`openclaw agent --agent july --message "任务描述"`, {
  encoding: 'utf-8'
});
```

## 规则文件位置

```
skills/btc-alert/rules/<rule-name>.js
```

引擎会自动加载并执行。

## 规则示例

```js
// rules/breakthrough-70000.js
// 示例：监控BTC突破70000压力位

const api = require('../btc-market-lite/scripts/api');

module.exports = {
  name: '突破70000压力位',
  
  // 每15分钟检查一次
  interval: 15 * 60 * 1000,
  
  // 内部状态（用于冷却）
  lastTriggered: 0,
  
  async check() {
    // 冷却时间：触发后1小时内不重复触发
    if (Date.now() - this.lastTriggered < 60 * 60 * 1000) {
      return false;
    }
    
    // 获取当前价格
    const ticker = await api.getTicker('BTC');
    return ticker && parseFloat(ticker.high) >= 70000;
  },
  
  async collect() {
    // 收集最近5根15分钟K线
    const klines = await api.getKlines('BTC', '15m', 5);
    const volume = await api.get24hVolume();
    
    return {
      triggerTime: new Date().toISOString(),
      klines: klines,
      volume24h: volume,
      message: 'BTC价格触及70000压力位'
    };
  },
  
  async trigger(data) {
    // 触发七月智能体执行即时分析
    const { execSync } = require('child_process');
    
    const message = `警报触发：${data.message}\n\n` +
      `触发时间：${data.triggerTime}\n` +
      `K线数据：${JSON.stringify(data.klines, null, 2)}\n` +
      `24h交易量：${data.volume24h}`;
    
    execSync(`openclaw agent --agent july --message "${message}"`, {
      encoding: 'utf-8'
    });
    
    // 更新冷却时间
    this.lastTriggered = Date.now();
  },
  
  lifetime() {
    // 规则在当天有效，次日过期
    const now = new Date();
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    return now <= endOfToday ? 'active' : 'expired';
  }
};
```

## 最佳实践

### 1. 冷却机制

在 `check()` 中实现冷却，避免同一条件重复触发：

```js
async check() {
  if (Date.now() - this.lastTriggered < COOLDOWN) {
    return false;
  }
  // ... 实际检测逻辑
}
```

### 2. 错误处理

在方法中添加 try-catch，避免单个规则崩溃影响引擎：

```js
async check() {
  try {
    // 检测逻辑
  } catch (error) {
    console.error(`[${this.name}] check error:`, error.message);
    return false;
  }
}
```

### 3. 生命周期管理

合理设置 `lifetime()`，避免无效规则占用资源：

- `'active'`: 规则正常执行
- `'expired'`: 规则已过期，引擎会停止该规则的定时器
- `'completed'`: 规则已完成（如一次性警报），引擎会停止并可选择清理

## 引擎管理

### 启动引擎

```bash
pm2 start skills/btc-alert/engine.js --name btc-alert
pm2 save
```

### 查看日志

```bash
pm2 logs btc-alert
```

### 停止引擎

```bash
pm2 stop btc-alert
```

### 添加新规则

创建 `rules/<name>.js` 文件后，重启引擎：

```bash
pm2 restart btc-alert
```

## 注意事项

1. 规则文件必须是有效的 Node.js 模块
2. 规则间相互独立，可以定义任意数量
3. 引擎会自动过滤 `lifetime() !== 'active'` 的规则
4. 使用 `btc-market-lite` 的 API 时注意频率限制