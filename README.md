# 七月 📈 - 比特币技术分析师

> 专注于比特币技术分析的智能体，每天定时提供市场报告，并可根据分析结果动态创建市场警报。

## 简介

七月是一个专门负责比特币技术分析的 AI 智能体。他会：

- ⏰ 每天定时触发（9:00 和 21:00 GMT+8）
- 📊 获取市场数据（价格、市值、恐惧贪婪指数）
- 🧠 计算技术指标（SMA、EMA、RSI、动量、波动率）
- 📤 发送分析报告到飞书
- 🔔 **动态创建市场警报** - 根据分析发现的关键点位

## 技术栈

### 数据源

| 数据 | API | 说明 |
|------|-----|------|
| 比特币价格 | CryptoCompare | K线、实时价格、交易量 |
| 恐惧贪婪指数 | alternative.me | 每日更新 |

### 技术指标

- **SMA** (简单移动平均): 7/14/20/30/50 日
- **EMA** (指数移动平均): 7/12/20/26 日
- **RSI** (相对强弱指标): 14 日
- **动量指标**: 7/14 日变化率
- **波动率**: 30 日标准差

### 技能

| 技能 | 说明 |
|------|------|
| `btc-market-lite` | 比特币市场数据获取 |
| `btc-alert` | 灵活的市场警报系统 |

## 警报器系统 🔔

七月可以根据分析结果，动态创建市场警报规则。

### 架构设计

```
七月分析 ──────► 发现关键点位 ──────► 编写警报规则
    ▲                                    │
    │                                    ▼
执行即时分析 ◄─────── 触发通知 ◄─────── 警报器监控
```

### 规则接口

每个警报规则由智能体现场编写，实现4个抽象方法：

| 方法 | 返回 | 说明 |
|------|------|------|
| `check()` | boolean | 检测条件是否满足 |
| `collect()` | any | 收集要传递的数据 |
| `trigger(data)` | void | 触发动作 |
| `lifetime()` | string | 规则状态：active/expired/completed |

### 生命周期管理

- `active` - 规则正常运行
- `expired` / `completed` - 规则自动归档到 `rules-archive/`
- **热更新支持** - 手动移动规则文件到归档目录后，引擎最多 1 分钟内自动卸载该规则

### 日志系统

- `logs/alert-engine.log` - 警报器引擎执行日志
- `logs/alert-setup.log` - 规则设定日志

### 示例：创建压力位警报

```javascript
// 七月分析后发现70000是关键压力位，现场编写：
module.exports = {
  name: '突破70000压力位',
  interval: 5 * 60 * 1000,  // 每5分钟检查
  
  async check() {
    const ticker = await api.getTicker('BTC');
    return ticker.price >= 70000;
  },
  
  async collect() {
    const klines = await api.getKlines('BTC', '15m', 5);
    return { klines, triggerTime: new Date().toISOString() };
  },
  
  async trigger(data) {
    // 调用七月执行即时分析
    execSync(`openclaw agent --agent july --message "..."`);
  },
  
  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    return today === '2026-03-04' ? 'active' : 'expired';
  }
};
```

## 配置

### 飞书机器人

七月绑定了独立的飞书机器人账户：

- **App ID**: `cli_a92ff0d3dab85cef`
- **DM 策略**: 白名单模式

### 定时任务

| 任务 | 时间 (GMT+8) | 描述 |
|------|--------------|------|
| btc-daily-report | 09:00 | 早间分析报告 |
| btc-daily-report-2 | 21:00 | 晚间分析报告 |

### 任务路由

| 任务 | 规则文件 |
|------|---------|
| 执行日报任务 | `tasks/daily-report.md` |
| 设定市场警报 | `tasks/set-alert.md` |
| 警报调试报告 | `tasks/alert-debug.md` |
| 即时分析任务 | `tasks/instant-analysis.md` |
| 警报器管理任务 | `tasks/alert-management.md` |

### 任务触发流程

```
定时任务 ───► 日报任务 ──────┐
                            ├──► 警报器管理任务 ───► 更新规则
警报触发 ───► 即时分析任务 ──┘
                                   │
                                   ▼
                           警报器监控 ───► 触发即时分析任务
```

**说明**：
- 日报任务和即时分析任务完成后，会自动触发警报器管理任务
- 警报器管理任务不通过 AGENTS.md 路由，而是由其他任务直接调用
- 所有新规则默认触发即时分析任务

## 部署

### PM2 配置

警报器通过 PM2 托管，实现开机自启和崩溃重启：

```bash
# 启动服务
pm2 start ecosystem.config.js

# 保存配置（开机自启）
pm2 save

# 查看状态
pm2 list
pm2 logs btc-alert
```

### 配置文件说明

`ecosystem.config.js` 定义了警报器的启动参数：

- **自动重启**: 崩溃后自动恢复
- **内存限制**: 超过 500M 自动重启
- **日志位置**: `logs/btc-alert-*.log`
- **时区**: Asia/Shanghai

## 目录结构

```
workspace-july/
├── AGENTS.md              # 身份定义 + 任务路由
├── IDENTITY.md            # 身份元数据
├── SOUL.md                # 核心原则
├── TOOLS.md               # 工具笔记
├── MEMORY.md              # 长期记忆
├── ecosystem.config.js    # PM2 部署配置
├── tasks/                 # 任务规则
│   ├── daily-report.md
│   ├── set-alert.md
│   ├── alert-debug.md
│   ├── instant-analysis.md
│   └── alert-management.md
├── skills/            # 技能目录
│   ├── btc-market-lite/
│   │   └── scripts/
│   │       ├── get_enhanced_analysis.js
│   │       └── api.js
│   └── btc-alert/
│       ├── SKILL.md
│       ├── engine.js
│       ├── rules/          # 活跃规则
│       └── rules-archive/  # 归档规则
├── data/              # 分析数据存档（当天覆盖）
├── logs/              # 日志文件
│   ├── btc-reports.log
│   ├── instant-reports.log
│   ├── alert-engine.log
│   └── alert-setup.log
└── reports/           # 报告存档
    ├── btc-report-YYYY-MM-DD-HHMM.md
    ├── instant-report-YYYY-MM-DD-HHMM.md
    └── alert-report-YYYY-MM-DD-HHMM.md
```

## 更新日志

### 2026-03-09
- **报告发送方式优化** 📄
  - 优先使用飞书文档发送完整日报（无长度限制、格式美观、可编辑）
  - 备选方案：分段消息发送（飞书单条消息限制约 4KB）
  - 更新 TOOLS.md 添加发送方式说明

### 2026-03-06
- **引擎时区修复** 🕐
  - 警报器引擎日志时间戳改为北京时间 (GMT+8)
  - 解决日志时间与实际时间相差8小时的问题
- **即时分析任务优化**
  - 明确要求发送保存的报告 md 文件到飞书
- **警报规则更新**
  - 新增阻力位突破警报 ($72,000)
  - 新增心理支撑跌破警报 ($70,000)
  - 新增关键支撑跌破警报 (7日EMA $69,678)
  - 归档 3 月 5 日的过期规则

### 2026-03-05
- **即时分析任务** 🎯
  - 新增 `tasks/instant-analysis.md` 任务规则
  - 警报触发时自动调用，进行针对性分析
  - 回顾24小时内所有报告（日报+即时分析）
  - 独立日志文件 `logs/instant-reports.log`
- **警报器管理任务** 🛠️
  - 新增 `tasks/alert-management.md` 任务规则
  - 日报/即时分析完成后自动调用
  - 查看当前规则、归档过期规则、创建新规则
  - 所有新规则默认触发即时分析任务
  - 独立日志文件 `logs/alert-management.log`
- **任务流程优化**
  - 日报和即时分析任务末尾新增警报器管理触发
  - 形成完整闭环：分析 → 管理警报 → 监控 → 触发分析
- **警报器热更新支持**
  - 新增文件扫描定时器（每分钟检查规则文件是否存在）
  - 手动归档规则文件后，引擎自动感知并卸载该规则
  - 无需重启引擎即可移除运行中的规则

### 2026-03-04
- **警报器系统上线** 🎉
  - 灵活的规则接口：check/collect/trigger/lifetime
  - 智能体可动态编写警报规则
  - 自动归档过期规则
  - 完整的日志系统
- 新增 `api.js` 模块，提供可复用的市场数据 API
- 新增任务路由：设定市场警报、警报调试报告
- 警报报告自动保存到 `reports/` 并发送飞书
- 数据源迁移到 CryptoCompare API
- 新增 get24hVolume() 函数，聚合24小时交易量
- 修复 volumeRatio 计算失真问题

### 2026-03-03
- **架构重构**：AGENTS.md 改为路由模式，任务规则独立到 `tasks/` 目录
- 绑定独立飞书机器人账户 (`july`)
- 配置 DM 白名单策略
- 新增历史日报关联能力（回顾 3 天内报告）
- 脚本新增 `--save` 参数，自动保存数据
- **日报存储改造**：
  - 新建 `reports/` 文件夹专门存放日报
  - 日报命名格式改为 `btc-report-YYYY-MM-DD-HHMM.md`

### 2026-03-02
- 更新 AGENTS.md 工作流程
- 优化报告格式和存储

### 2026-02-27
- 创建七月智能体
- 集成 btc-market-lite 技能
- 配置定时任务 (9:00/21:00)
- 实现飞书报告推送

---

*创建于 2026-02-27 · 由 OpenClaw 驱动*