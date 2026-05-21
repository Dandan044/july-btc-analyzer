# 📈 七月 BTC 监控面板

七月交易周期系统的 Web 监控面板，实时查看周期状态、仓位、警报规则和系统运行情况。

## 快速启动

```bash
# 安装依赖（仅需一次）
npm install

# 启动服务（默认端口 3100）
npm start

# 指定端口
node server.js --port=3200
```

启动后访问：

- **本机**：http://localhost:3100
- **局域网/Tailscale**：http://100.117.118.11:3100（需在同一 Tailscale 网络）
- **SSH 隧道**：在 `~/.ssh/config` 的 Host 配置中添加 `LocalForward 3100 127.0.0.1:3100`

## 功能概览

### 总览

顶部统计行（5 个卡片 + 状态标签）：

| 卡片 | 数据来源 | 更新频率 |
|------|---------|---------|
| 活跃周期 | 本地文件系统 | 5 分钟 |
| 活跃规则 | query-rules.js | 5 分钟 |
| 持仓数 | positions.json 快照 | 5 分钟 |
| 未实现盈亏 | OKX 实盘 API（一次调用全账户） | 5 分钟 + 手动刷新 |
| 已实现盈亏 | 归档周期 positions.json 快照汇总（5.11 起） | 页面加载时 |

**已实现盈亏折线图**：
- 累计曲线，数据点按日着色（正绿负红）
- 面积填充渐变 + 零线虚线
- 时间范围切换：**周**（7天，默认）/ **月**（30天）/ **总**（5.11起全量）
- 周/月视图从 0 重新累计，不继承全局累计值
- 切换级别和首次加载有平滑过渡动画（ease-out cubic）
- 鼠标悬浮数据点：显示当日盈亏 + 累计 + 各周期明细（过滤盈亏=0）
- Tooltip 定位在 body 顶层，不受父容器 overflow 裁剪

**警报条**：近 6h 触发警报，高度限制 120px

**活跃周期卡片网格**：
- 搜索：按币种名或周期 ID
- 排序：默认/名称/时间/静默/持仓/规则/状态
- 展开详情（3 个子标签）：
  - 📊 仓位：实盘仓位（OKX API 实时查询）+ 快照仓位（positions.json，可折叠）
  - 🔔 规则：关联警报规则列表（活跃排前、归档排后）+ 规则日志查看
  - 📝 报告：点击文件名弹出模态窗口阅读报告（Markdown 渲染）
- 操作：⚡ 触发即时分析 / 📦 归档周期

**响应式**：
- PC：5 列统计卡片 + 3 列周期卡片
- 平板（<1200px）：2 列统计 + 2 列周期
- 手机（<600px）：1 列统计 + 1 列周期，JS 驱动断点检测

### 归档周期

- 200 个已归档周期卡片网格
- 卡片显示：币种 + 可读时间（05-15 04:27）+ 报告数/规则数/盈亏/持仓数
- 搜索 + 排序（默认时间排序/名称/规则/盈亏）
- 筛选：隐藏盈亏=0 的周期
- 展开详情（3 个子标签）：
  - 💰 盈亏：已实现/未实现盈亏卡片 + 最近平仓记录表格；无数据时显示空状态
  - 🔔 规则：同活跃周期
  - 📝 报告：同活跃周期
- 操作：🗑 删除（两次确认，仅允许删除归档目录下的周期）

### Cron 管理

- 查看所有定时任务（日报、扫描、健康检查等）
- 状态追踪：● 运行中（蓝色脉冲 + 已运行时长）/ ● 启用 / ○ 禁用
- 下次运行：倒计时显示（X天X时X分）+ 淡灰日期
- 手动执行 / 启用禁用 / 删除任务
- 查看运行状态、耗时、错误计数

### 系统监控

- PM2 进程状态（btc-alert 引擎等）
- 磁盘使用 / 规则文件统计
- 最新周期健康报告
- 操作日志（actions.log）

## 技术栈

| 层 | 技术 |
|---|------|
| 后端 | Express.js（`server.js`） |
| 前端 | 原生 HTML/CSS/JS（`public/index.html`，零框架 SPA） |
| 图表 | Canvas 2D 原生绘制（折线图 + 动画 + 鼠标交互） |
| 数据源 | 本地文件系统 + OKX CLI（proxychains4 代理）+ PM2 + OpenClaw CLI |

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/dashboard` | 仪表盘汇总数据（周期数/规则数/引擎状态/近期警报） |
| GET | `/api/cycles` | 活跃周期列表（`?archived=true` 查已归档，`?search=xxx` 搜索） |
| GET | `/api/cycles/:id` | 周期详情（报告、规则、快照仓位） |
| GET | `/api/cycles/:id/positions/live` | OKX 实盘仓位 |
| POST | `/api/cycles/:id/archive` | 归档周期 |
| POST | `/api/cycles/:id/analyze` | 触发即时分析（创建一次性 cron） |
| DELETE | `/api/cycles/:id` | 删除归档周期（仅允许删除 archived/ 下的） |
| GET | `/api/live-pnl` | 全账户实盘未实现盈亏（一次 OKX API 调用） |
| GET | `/api/realized-pnl-history` | 已实现盈亏按日汇总（5.11 起，含每周期明细） |
| GET | `/api/report?path=xxx` | 读取报告文件内容（Markdown） |
| GET | `/api/analysis/jobs` | 面板创建的分析任务状态 |
| DELETE | `/api/analysis/:jobId` | 删除分析任务 |
| GET | `/api/rules/:file/logs` | 规则日志 |
| GET | `/api/cron/jobs` | Cron 任务列表 |
| POST | `/api/cron/:id/run` | 手动执行 cron |
| PATCH | `/api/cron/:id` | 启用/禁用 cron（`{enabled: true/false}`） |
| DELETE | `/api/cron/:id` | 删除 cron |
| GET | `/api/system` | 系统状态（PM2、磁盘、健康报告） |
| GET | `/api/health/:date` | 指定日期的健康报告内容 |
| GET | `/api/logs` | 日志文件列表 |
| GET | `/api/logs/:name` | 日志内容（`?lines=N`） |

## 依赖说明

- **OKX CLI**：通过 `proxychains4 -q okx --profile live --json` 调用，获取实盘仓位和盈亏数据
- **PM2**：查询 btc-alert 引擎运行状态
- **OpenClaw CLI**：管理 cron 任务（触发分析、查看/执行/删除定时任务）
- **本地文件系统**：读取周期目录、positions.json、规则文件、健康报告、日志

## 项目结构

```
dashboard/
├── server.js          # Express 后端（API 路由 + 静态文件服务）
├── public/
│   └── index.html     # 前端 SPA（HTML + CSS + JS 单文件，含 Canvas 图表）
├── package.json       # 依赖声明（express）
└── README.md          # 本文件
```

## 注意事项

- 服务需在七月工作区所在主机运行，依赖本地 OKX CLI、PM2 和 OpenClaw
- OKX API 调用通过 proxychains4 代理，需确保代理可用
- 实盘盈亏（未实现）每 5 分钟自动刷新，支持手动刷新按钮
- 已实现盈亏基于归档周期 positions.json 快照汇总，非实时
- 归档操作会执行完整流程：实盘盈亏同步 → 规则归档 → 目录移动
- 删除归档周期需两次确认，仅允许删除 archived/ 目录下的周期
- 报告查看通过模态窗口内嵌显示，支持 Markdown 渲染，不跳转新标签页
- 手机端通过 Tailscale 网络直接访问（http://100.117.118.11:3100），无需 SSH 隧道

## 更新日志

### 2026-05-20

- **总览页面重构**：合并原「仪表盘」和「周期」两个 Tab 为单一滚动页面
- **实盘盈亏**：新增 `/api/live-pnl` 端点，一次 OKX API 调用获取全账户未实现盈亏，5 分钟自动刷新 + 手动刷新
- **已实现盈亏**：新增 `/api/realized-pnl-history` 端点，汇总 5.11 起归档周期快照盈亏
- **折线图**：Canvas 原生绘制累计盈亏曲线，支持周/月/总切换，切换动画，鼠标悬浮 Tooltip 显示当日盈亏 + 各周期明细
- **归档 Tab**：新增归档周期页面，卡片显示可读时间 + 盈亏，支持搜索/排序/筛选/删除
- **归档盈亏子标签**：展开归档周期可查看已实现/未实现盈亏 + 最近平仓记录
- **报告查看**：点击报告文件名弹出模态窗口，Markdown 渲染，Escape/遮罩点击关闭
- **Cron 运行状态**：检测 `runningAtMs` 显示「运行中」状态 + 已运行时长
- **Cron 下次运行**：倒计时显示（X天X时X分）+ 淡灰日期
- **规则排序**：活跃规则排前、归档排后
- **子面板滚动**：仓位/规则/报告子面板 max-height 480px + 滚动条
- **响应式**：JS 驱动断点检测，手机端统计卡片单列、周期卡片单列
- **删除归档周期**：`DELETE /api/cycles/:id`，两次确认，仅限 archived/ 目录
