# deployment.md - 部署配置指南

此智能体在新环境中部署时，需要配置以下服务和定时任务。

---

## 前置条件

已安装 OpenClaw 框架。

### 系统环境依赖

| 工具 | 用途 | 安装命令 | 必需 |
|------|------|---------|------|
| Node.js >= 18 | JS 运行时 | `apt install nodejs` / `nvm install 18` | ✅ |
| npm | 包管理器 | Node.js 自带 | ✅ |
| PM2 | 进程守护（4 个后台进程） | `npm install -g pm2` | ✅ |
| Python 3 | 扫描脚本 / 数据处理 | `apt install python3`（系统通常自带） | ✅ |

### Python 依赖包

```bash
pip install -r config/requirements.txt
```

> 必需：`requests`（斐波那契分析）。可选：`pandas`/`mplfinance`/`matplotlib`/`numpy`（K线图表生成，缺失则图表功能跳过）。
| bash >= 4 | Shell 脚本执行 | Linux 默认已安装 | ✅ |
| curl | HTTP 请求（API 数据获取） | 系统通常自带 | ✅ |

### 外部 CLI 工具

| 工具 | 用途 | 安装命令 | 必需 |
|------|------|---------|------|
| OpenClaw CLI | cron 任务管理 / 智能体调度 | 随 OpenClaw 框架安装，需确保在 PATH 中 | ✅ |
| `okx` CLI | OKX 交易执行 + 市场数据 | `npm install -g @okx_ai/okx-trade-cli` | ⚠️ 交易功能必需 |
| `onchainos` CLI | 链上数据（持币分布/交易/集群） | 见「链上数据配置」章节 | ⚠️ 山寨币分析必需 |
| `proxychains4` | OKX CLI 代理包装（国内网络） | `apt install proxychains4` | ⚠️ 国内网络必需 |

> ⚠️ = 可选但功能受限：不装 OKX CLI 则无法交易和获取精确数据；不装 onchainos 则山寨币分析缺少链上维度；不装 proxychains4 则国内网络无法访问 OKX API。

### 代理服务（国内网络必需）

七月框架所有 OKX API 请求需要通过代理。请自行准备代理方案（机场/VPS 自建/企业代理），确保：
- 本地代理程序已运行
- 代理端口已确认（常见：7890、1080）
- `curl --proxy http://127.0.0.1:<端口> https://www.okx.com` 可正常返回

代理端口需配置到以下位置：
- Shell 环境变量（`http_proxy` / `https_proxy`）
- `ecosystem.config.js`（PM2 进程的 env 块）
- OKX CLI 配置（`~/.okx/config.toml`）

---

## 一、克隆与注册智能体

### 1. 克隆仓库

```bash
cd ~/.openclaw
git clone git@github.com:Dandan044/july-btc-analyzer.git
```

### 2. 注册智能体信息

七月是独立 OpenClaw 智能体，需要在 `~/.openclaw/openclaw.json` 中注册。

找到 `agents` 数组，添加七月配置：

```json
{
  "agents": [
    // ... 其他智能体 ...
    {
      "id": "july",
      "name": "july",
      "workspace": "<克隆路径>",
      "agentDir": "<克隆路径>/agent",
      "model": "bailian/glm-5",
      "identity": {
        "name": "七月",
        "theme": "加密货币分析师智能体",
        "emoji": "📈"
      },
      "subagents": {
        "allowAgents": ["july"]
      }
    }
  ]
}
```

**⚠️ 必填项**：
| 字段 | 说明 |
|------|------|
| `workspace` | 克隆目录的绝对路径，如 `/home/user/.openclaw/july-btc-analyzer` |
| `agentDir` | 智能体 agent 子目录，通常为 `<workspace>/agent` |
| `model` | 推荐使用 `bailian/glm-5` 或其他高上下文模型 |
| `subagents.allowAgents` | **必须包含 `"july"`**，否则智能体无法自 spawn 执行日报任务 |

**💡 自 spawn 权限说明**：
七月采用自触发机制，收到 `[SPAWN_DAILY_REPORT]` 消息后会 spawn 自己执行日报任务。
这要求 `subagents.allowAgents` 必须包含 `"july"`，否则 spawn 操作会被拒绝。

### 3. 创建 agent 目录结构

```bash
mkdir -p <workspace>/agent
mkdir -p <workspace>/logs
mkdir -p <workspace>/skills/btc-alert/rules
mkdir -p <workspace>/skills/btc-alert/rules-archive
```

---

## 二、代理配置

### 统一代理入口

七月框架所有脚本的代理地址统一通过 `PROXY_URL` 环境变量控制：

- **已设置 `PROXY_URL`** → 所有脚本使用该值
- **未设置** → 自动 fallback 到 `http://127.0.0.1:7890`（国内默认端口）
- **设为空字符串** → 不使用代理（国外用户直连）

### 初始化代理配置

**方式一：配置文件（推荐）**

```bash
cp config/proxy.env.example config/proxy.env
# 编辑 config/proxy.env，修改 PROXY_URL 为你的代理地址
vim config/proxy.env
# 加载配置
source config/proxy.env
```

> `config/proxy.env` 已在 `.gitignore` 中排除，不会被提交到 Git。

**方式二：Shell 环境变量（临时）**

```bash
export PROXY_URL="http://127.0.0.1:7890"    # 国内用户：替换为你的代理端口
```

**方式三：写入 ~/.bashrc（永久）**

```bash
echo 'export PROXY_URL="http://127.0.0.1:7890"' >> ~/.bashrc
source ~/.bashrc
```

### 国外用户（无需代理）

```bash
export PROXY_URL=""    # 空字符串 = 直连
```

### 代理覆盖范围

设置 `PROXY_URL` 后，以下组件自动使用该代理：

| 组件 | 读取方式 |
|------|----------|
| PM2 进程（btc-alert、july-dashboard） | `ecosystem.config.js` 启动时读取，自动设置 `http_proxy`/`https_proxy`/`all_proxy` |
| Shell 脚本（market-brief 等） | `${PROXY_URL:-fallback}` |
| Python 脚本（scanner-full 等） | `os.environ.get('PROXY_URL', fallback)` |
| Node.js 脚本（stage1/stage3/calc-* 等） | `process.env.PROXY_URL || fallback` |

### 需要单独配置的组件

以下组件有独立的代理配置，**不受 `PROXY_URL` 控制**：

| 组件 | 配置方式 |
|------|----------|
| OKX CLI | `~/.okx/config.toml` 中的 `proxy` 字段 |
| proxychains4 | `/etc/proxychains4.conf`（`okx-proxy.sh` 依赖） |

### 验证代理

```bash
# 测试代理是否可用
curl --proxy "$PROXY_URL" https://www.okx.com

# 测试 OKX CLI（需先配置 ~/.okx/config.toml）
./scripts/okx-proxy.sh --profile live account balance
```

---

## 三、PM2 进程配置

### 前置要求

安装 PM2 进程管理器：

```bash
npm install -g pm2
pm2 startup    # 配置开机自启（按提示执行输出的命令）
```

> **为什么需要 PM2**：七月框架包含 4 个常驻后台进程（警报引擎、任务调度器、缓存服务、监控面板），需要进程守护和自动重启能力。PM2 是 Node.js 生态的标准方案。

七月通过 `ecosystem.config.js` 管理所有后台进程。配置文件已自包含——使用 `__dirname` 动态解析路径，**无需修改 `cwd`**，克隆后可启动。

### 四个进程一览

| 进程名 | 脚本 | 角色 | 端口 |
|--------|------|------|------|
| `btc-alert` | `skills/btc-alert/engine.js` | 警报引擎：监控价格/持仓/OI 等指标，触发条件时创建即时分析任务 | - |
| `cron-dispatcher` | `scripts/cron-dispatcher.js` | 任务调度器：优先级队列 + 模型负载感知派发，统一管理 cron 任务的创建和路由 | 3102 |
| `cron-name-cache` | `scripts/cron-name-cache.js` | 缓存服务：每 60s 将活跃 cron job 名称写入缓存文件供 Dashboard 读取 | - |
| `july-dashboard` | `dashboard/server.js` | Web 监控面板：周期状态、仓位管理、警报规则、系统状态可视化 | 3100 |

### 环境配置说明

`ecosystem.config.js` 中的代理端口当前为 `7890`。如果你的代理端口不同，需要修改文件中所有 `http_proxy`、`https_proxy`、`all_proxy` 的值。

> 后续计划：代理端口统一为环境变量，届时无需修改配置文件。

### 启动命令

```bash
cd <克隆路径>
npm install                     # 安装 Node.js 依赖
pm2 start ecosystem.config.js   # 启动全部四个进程
pm2 save                        # 保存进程列表（重启后自动恢复）
```

### 验证运行

```bash
pm2 list                        # 应显示 4 个进程均为 online
pm2 logs btc-alert              # 警报引擎日志
pm2 logs cron-dispatcher        # 调度器日志
pm2 logs july-dashboard         # 面板日志
```

访问 `http://<服务器IP>:3100` 打开监控面板。

### 常用管理命令

```bash
pm2 restart btc-alert           # 重启单个进程
pm2 restart all                 # 重启全部
pm2 stop july-dashboard         # 停止面板（不影响核心功能）
pm2 flush                       # 清空日志
pm2 monit                       # 实时 CPU/内存监控
```

---

## 四、OKX CLI 配置

### 安装 OKX CLI

```bash
npm install -g @okx_ai/okx-trade-cli
okx --version
```

### 配置 API 凭证

创建 `~/.okx/config.toml`：

```toml
# OKX API Configuration

# 代理配置（国内网络必需）
proxy = "http://127.0.0.1:<代理端口>"

# 实盘配置
[profiles.live]
api_key = "<你的API Key>"
secret_key = "<你的Secret Key>"
passphrase = "<你的Passphrase>"
demo = false

# 模拟盘配置（可选）
[profiles.demo]
api_key = "<模拟盘API Key>"
secret_key = "<模拟盘Secret Key>"
passphrase = "<模拟盘Passphrase>"
demo = true
```

**⚠️ 安全提醒**：
- 此文件包含敏感凭证，**切勿提交到 Git**
- 已在项目 `.gitignore` 中排除

### 验证 OKX CLI

```bash
# 使用代理 wrapper（国内网络）
./scripts/okx-proxy.sh --profile live account balance

# 或直接使用（国外网络）
okx --profile live account balance
```

---

## 五、链上数据配置（OnchainOS）

> ⚠️ 可选：山寨币分析需要在阶段一收集链上数据（持币分布、交易记录、集群分析）。
> 不配置此项，山寨币分析仍可运行，但缺少链上维度数据。

### 安装 OnchainOS CLI

```bash
npm install -g onchainos
```

### 配置 API 认证

在用户目录创建 `~/.onchainos/.env`，写入你的 API 凭证：

```bash
mkdir -p ~/.onchainos
cat > ~/.onchainos/.env << 'EOF'
ONCHAINOS_API_KEY=<你的API Key>
ONCHAINOS_API_SECRET=<你的API Secret>
EOF
```

> 获取 API Key：访问 OnchainOS 平台注册并创建 API 凭证。

### 加载环境变量

每次使用前（或写入 `~/.bashrc` 自动加载）：

```bash
export $(cat ~/.onchainos/.env | grep -v '^#' | xargs)
```

### 验证

```bash
onchainos token search --query BTC --chains "1"
```

应返回代币搜索结果。

---

## 六、OpenClaw 技能安装

七月依赖多个 OKX 官方技能来执行交易、获取市场数据和链上数据。

### 安装 OKX 交易技能

```bash
npx skills add okx/agent-skills
```

> 此命令从 `https://github.com/okx/agent-skills.git` 克隆并安装全部 OKX CEX + DEX 技能。

| 技能 | 用途 |
|------|------|
| `okx-cex-trade` | 下单/撤单/改单、止盈止损、期权交易 |
| `okx-cex-market` | 行情数据：K线、深度、资金费率、技术指标 |
| `okx-cex-portfolio` | 账户余额、持仓查询、资金划转 |
| `okx-cex-bot` | 网格/DCA 马丁格尔机器人管理 |
| `okx-cex-earn` | 赚币/质押/双币赢理财 |

### 安装链上数据技能

```bash
npx skills add okx/onchainos-skills
```

> 此命令从 `https://github.com/okx/onchainos-skills.git` 安装 `okx-dex-token` 等链上数据技能，
> 为 `onchainos` CLI 提供命令参考。第五章已覆盖 `onchainos` CLI 安装和认证配置。

### 验证

```bash
ls ~/.agents/skills/okx-cex-*          # 应看到 OKX CEX 技能目录
ls ~/.agents/skills/onchainos-skills/  # 应看到链上数据技能目录
```

---

## 七、定时任务配置

### 核心循环 Cron 任务（四个初始任务）

一键创建四个核心循环 cron 任务（早间日报、晚间日报、周期健康检查、市场快报）：

```bash
bash scripts/init-cron-tasks.sh
```

脚本详情：`scripts/init-cron-tasks.sh`

| 任务名称 | 时间 (GMT+8) | 说明 |
|---------|-------------|------|
| `july-btc-morning-v2` | 每日 09:00 | BTC 早间日报（四阶段）|
| `july-btc-evening-v2` | 每日 21:00 | BTC 晚间日报（四阶段）|
| `cycle-health-check` | 每日 03:00 | 活跃周期健康检查 |
| `market-brief` | 22:30 / 06:30 / 14:30 | 市场快报（亚/欧/美盘）|

创建时使用默认模型（不指定 `--model`），参数与当前生产配置一致。

---

## 八、山寨币扫描链路配置

每小时自动运行的山寨币扫描引擎需要 Linux crontab 支持。

### 添加 crontab 定时任务

```bash
crontab -e
```

添加以下两行：

```cron
# 山寨币扫描 — 每小时整点
0 * * * * <克隆路径>/scripts/scanner-runner.sh >> <克隆路径>/logs/alt-scanner.log 2>&1

# 庄币扫描 — 每小时整点后 5 分钟（错峰）
5 * * * * <克隆路径>/scripts/scanner-zhuang-runner.sh >> <克隆路径>/logs/alt-scanner.log 2>&1
```

> 替换 `<克隆路径>` 为实际的仓库绝对路径。

### 验证

```bash
# 手动触发一次扫描
bash scripts/scanner-runner.sh
# 查看扫描日志
tail -20 logs/alt-scanner.log
```

---

## 九、市场快报配置（可选）

市场快报系统每 8 小时生成一份加密市场环境摘要，纯数据描述不做交易建议。

已包含在 `scripts/init-cron-tasks.sh` 中，无需单独配置。

### 验证

```bash
openclaw cron list | grep -E "(morning|evening|health|brief)"
```

---

## 十、飞书通知配置

日报发送到飞书需要配置飞书机器人凭证。

### credentials.json

在项目目录创建 `.openclaw/credentials.json`：

```json
{
  "feishu": {
    "appId": "<飞书应用App ID>",
    "accountId": "<账号标识，如 'july'>",
    "targetOpenId": "<目标用户的Open ID>",
    "targetName": "<目标用户名称>"
  }
}
```

**获取方式**：
- `appId`：飞书开放平台创建应用后获取
- `targetOpenId`：目标用户的飞书用户 ID（通过飞书 API 或管理后台获取）

**⚠️ 安全提醒**：
- 此文件包含敏感凭证，**切勿提交到 Git**
- 已在项目 `.gitignore` 中排除

---

## 十一、完整部署步骤

### 步骤清单

| 步骤 | 操作 | 验证命令 |
|------|------|---------|
| 1 | 克隆仓库 | `ls ~/.openclaw/july-btc-analyzer` |
| 2 | 注册智能体 | 检查 `openclaw.json` 中 `agents` 数组 |
| 3 | 验证目录结构 | `ls logs/.gitkeep skills/btc-alert/rules/.gitkeep`（clone 自带） |
| 4 | 安装 PM2 | `npm install -g pm2 && pm2 startup` |
| 5 | 配置代理 | `cp config/proxy.env.example config/proxy.env && source config/proxy.env` |
| 6 | 验证代理 | `curl --proxy "$PROXY_URL" https://www.okx.com` 返回正常 |
| 7 | 安装 Node.js 依赖 | `npm install` |
| 8 | 安装 Python 依赖 | `pip install -r config/requirements.txt` |
| 9 | 安装 OKX CLI | `okx --version` |
| 10 | 配置 OKX API | 创建 `~/.okx/config.toml` |
| 11 | 安装 OnchainOS（可选） | `onchainos token search --query BTC --chains "1"` |
| 12 | 安装 OpenClaw 技能 | `ls ~/.agents/skills/okx-cex-*` 存在 |
| 13 | 启动全部进程 | `pm2 start ecosystem.config.js && pm2 save` |
| 14 | 创建日报定时任务 | `openclaw cron list` 显示两个日报任务 |
| 15 | 配置山寨币扫描 crontab | `crontab -l` 含 scanner-runner 行 |
| 16 | 创建市场快报任务（可选） | `openclaw cron list` 含 market-brief |
| 17 | 配置飞书通知 | 创建 `.openclaw/credentials.json` |
| 18 | 配置 Web Search | 确保 `openclaw.json` 中 `webSearch` 已配置（见下方） |

### Web Search 配置

> ⚠️ 重要：山寨币分析阶段一需要通过 `web_search` 获取项目消息面数据。
> 未配置则媒体搜索返回空，阶段二交叉验证缺少媒体维度。

OpenClaw 的 web search 能力在 `~/.openclaw/openclaw.json` 中配置：

```json
{
  "webSearch": {
    "provider": "minimax",
    "fallback": "duckduckgo",
    "duckduckgo": {
      "proxy": "http://127.0.0.1:7890"
    }
  }
}
```

> 主力 MiniMax 直连即可；备用 DuckDuckGo 需要代理。
> 切换配置后需要重启 Gateway：`systemctl --user restart openclaw-gateway.service`（或 `openclaw gateway restart`）

### 工作区外配置文件汇总

以下配置文件在七月工作区之外，需单独创建：

| 文件 | 用途 | 章节 |
|------|------|------|
| `~/.okx/config.toml` | OKX CLI API 凭证 + 代理配置 | 四、OKX CLI 配置 |
| `~/.onchainos/.env` | 链上数据 API 认证 | 五、链上数据配置 |
| `~/.openclaw/openclaw.json` | 智能体注册 + Web Search 提供者 | 一、注册智能体 + 上述 |
| `.openclaw/credentials.json` | 飞书通知凭证 | 七、飞书通知配置 |

### 验证检查清单

| 检查项 | 命令 | 预期结果 |
|--------|------|---------|
| 目录结构 | `ls logs/.gitkeep skills/btc-alert/rules/.gitkeep` | 两个文件存在 |
| PM2 运行 | `pm2 list` | 4 个进程均为 online |
| 警报器日志 | `pm2 logs btc-alert --lines 20` | 有心跳日志输出 |
| 调度器运行 | `pm2 logs cron-dispatcher --lines 5` | 监听 3102 端口 |
| 监控面板 | `curl http://localhost:3100/api/system` | 返回 JSON |
| 代理可用 | `curl --proxy "$PROXY_URL" https://www.okx.com` | 返回正常 |
| OKX CLI | `./scripts/okx-proxy.sh --profile live account balance` | 显示账户余额 |
| OnchainOS | `onchainos token search --query BTC --chains "1"` | 返回搜索结果 |
| OpenClaw 技能 | `ls ~/.agents/skills/okx-cex-trade/` | 目录存在 |
| Web Search | 在智能体对话中测试 `web_search` | 正常返回搜索结果 |
| Cron 任务 | `openclaw cron list` | 两个日报任务已注册 |
| 智能体注册 | `openclaw agent list` | 显示 july |

---

## 十二、常见问题

### Q: PM2 启动失败 "script not found"

确保在项目根目录执行 `pm2 start ecosystem.config.js`。配置文件已使用 `__dirname` 动态解析路径，无需手动修改 `cwd`。

### Q: 警报器无法获取数据（ETIMEDOUT）

检查代理配置：
- 确认代理服务运行中
- 确认 `PROXY_URL` 已正确设置：`echo $PROXY_URL`
- 测试代理：`curl --proxy "$PROXY_URL" https://www.okx.com`
- 如需单独配置 proxychains4，编辑 `/etc/proxychains4.conf`

### Q: Cron 任务不触发

检查：
- 智能体 ID 是否与 `openclaw.json` 中注册一致
- 智能体是否正常运行

### Q: 飞书发送失败

检查：
- `credentials.json` 是否存在
- `appId` 和 `targetOpenId` 是否正确
- 飞书机器人是否有发送私聊消息权限

### Q: OKX CLI 调用失败

检查：
- `~/.okx/config.toml` 是否存在
- API 凭证是否正确
- 代理是否可用（国内网络）
- 使用 `./scripts/okx-proxy.sh` wrapper 而非直接 `okx`

### Q: okx-proxy.sh 执行失败

检查：
- `which okx` 是否返回有效路径
- 系统是否安装 proxychains4
- 代理端口是否正确（`HTTP_PROXY_PORT` 环境变量）