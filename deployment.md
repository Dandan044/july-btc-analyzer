# deployment.md - 部署配置指南

此智能体在新环境中部署时，需要配置以下服务和定时任务。

---

## 前置条件

已安装 OpenClaw 框架，具备以下环境：
- Node.js >= 18
- PM2 进程管理器
- Python 环境
- proxychains4（系统自带或已安装）

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

### 3. 创建 agent 目录结构

```bash
mkdir -p <workspace>/agent
mkdir -p <workspace>/logs
mkdir -p <workspace>/skills/btc-alert/rules
mkdir -p <workspace>/skills/btc-alert/rules-archive
```

---

## 二、代理配置

国内网络访问 OKX API 需要代理。七月采用**环境变量统一配置**方式。

### 代理环境变量

所有脚本和 PM2 进程通过以下环境变量获取代理配置：

| 环境变量 | 说明 | 示例 |
|---------|------|------|
| `http_proxy` | HTTP 代理地址 | `http://127.0.0.1:7890` |
| `https_proxy` | HTTPS 代理地址 | `http://127.0.0.1:7890` |
| `HTTP_PROXY_PORT` | 代理端口（okx-proxy.sh 使用） | `7890` |

### 配置方式

**方式一：Shell 环境变量（临时）**
```bash
export http_proxy="http://127.0.0.1:<端口>"
export https_proxy="http://127.0.0.1:<端口>"
export HTTP_PROXY_PORT="<端口>"
```

**方式二：写入 ~/.bashrc（永久）**
```bash
echo 'export http_proxy="http://127.0.0.1:<端口>"' >> ~/.bashrc
echo 'export https_proxy="http://127.0.0.1:<端口>"' >> ~/.bashrc
echo 'export HTTP_PROXY_PORT="<端口>"' >> ~/.bashrc
source ~/.bashrc
```

**方式三：PM2 ecosystem.config.js（警报器专用）**

见下一章节。

---

## 三、PM2 进程配置

### btc-alert - 警报器引擎

警报器引擎通过 PM2 运行，负责监控市场并在触发条件时创建即时分析任务。

#### ecosystem.config.js

```javascript
module.exports = {
  apps: [{
    name: 'btc-alert',
    script: './skills/btc-alert/engine.js',
    cwd: '<克隆路径>',  // ⚠️ 替换为实际绝对路径
    
    autorestart: true,
    watch: false,
    max_restarts: 10,
    restart_delay: 3000,
    max_memory_restart: '500M',
    
    // 日志
    error_file: './logs/btc-alert.log',
    out_file: './logs/btc-alert.log',
    merge_logs: true,
    time: true,
    
    // 环境（代理配置）
    env: {
      NODE_ENV: 'production',
      TZ: 'Asia/Shanghai',
      http_proxy: 'http://127.0.0.1:<代理端口>',   // ⚠️ 替换
      https_proxy: 'http://127.0.0.1:<代理端口>',
      HTTP_PROXY_PORT: '<代理端口>'
    }
  }]
};
```

**⚠️ 必填项**：
| 字段 | 说明 |
|------|------|
| `cwd` | 克隆目录的绝对路径 |
| `http_proxy` 端口 | 代理端口，与系统代理一致 |

#### 启动命令

```bash
cd <克隆路径>
npm install
pm2 start ecosystem.config.js
pm2 save
```

**验证运行**：
```bash
pm2 list
pm2 logs btc-alert
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

## 五、定时任务配置

### 日报任务（Cron Jobs）

使用 OpenClaw cron 系统配置每天 9:00 和 21:00 的日报任务。

#### 早间日报（9:00 GMT+8）

```json
{
  "name": "july-btc-morning",
  "schedule": {
    "kind": "cron",
    "expr": "0 9 * * *",
    "tz": "Asia/Shanghai"
  },
  "sessionTarget": "isolated",
  "payload": {
    "kind": "agentTurn",
    "agentId": "july",
    "message": "[SPAWN_DAILY_REPORT]执行比特币技术分析日报：获取BTC价格、恐惧指数、技术指标数据，进行技术分析，生成报告并发送",
    "thinking": "high",
    "timeoutSeconds": 0
  },
  "delivery": {
    "mode": "none"
  }
}
```

#### 晚间日报（21:00 GMT+8）

```json
{
  "name": "july-btc-evening",
  "schedule": {
    "kind": "cron",
    "expr": "0 21 * * *",
    "tz": "Asia/Shanghai"
  },
  "sessionTarget": "isolated",
  "payload": {
    "kind": "agentTurn",
    "agentId": "july",
    "message": "[SPAWN_DAILY_REPORT]执行比特币技术分析日报：获取BTC价格、恐惧指数、技术指标数据，进行技术分析，生成报告并发送",
    "thinking": "high",
    "timeoutSeconds": 0
  },
  "delivery": {
    "mode": "none"
  }
}
```

#### 创建任务

使用 OpenClaw cron 工具：

```bash
# 方式一：通过命令行
openclaw cron add --job "$(cat morning.json)"

# 方式二：在智能体对话中请求
# "帮我创建一个定时任务，每天9点触发七月执行日报"
```

---

## 六、飞书通知配置

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

## 七、完整部署步骤

### 步骤清单

| 步骤 | 操作 | 验证命令 |
|------|------|---------|
| 1 | 克隆仓库 | `ls ~/.openclaw/july-btc-analyzer` |
| 2 | 注册智能体 | 检查 `openclaw.json` 中 `agents` 数组 |
| 3 | 创建目录结构 | `ls logs/ skills/btc-alert/rules/` |
| 4 | 配置代理环境变量 | `echo $http_proxy` |
| 5 | 编辑 ecosystem.config.js | 填写 cwd 和代理端口 |
| 6 | 安装依赖 | `npm install` |
| 7 | 安装 OKX CLI | `okx --version` |
| 8 | 配置 OKX API | 创建 `~/.okx/config.toml` |
| 9 | 启动警报器 | `pm2 list` 显示 btc-alert online |
| 10 | 创建定时任务 | `openclaw cron list` 显示两个任务 |
| 11 | 配置飞书通知 | 创建 `credentials.json` |

### 验证检查清单

| 检查项 | 命令 | 预期结果 |
|--------|------|---------|
| PM2 运行 | `pm2 list` | `btc-alert` 状态 online |
| 警报器日志 | `pm2 logs btc-alert --lines 20` | 有心跳日志输出 |
| Cron 任务 | `openclaw cron list` | 两个日报任务已注册 |
| OKX CLI | `okx --version` | 显示版本号 |
| 代理可用 | `curl --proxy $http_proxy https://www.okx.com` | 返回正常 |
| 智能体注册 | `openclaw agent list` | 显示 july |

---

## 八、常见问题

### Q: PM2 启动失败 "script not found"

检查 `cwd` 是否为克隆目录的绝对路径。

### Q: 警报器无法获取数据（ETIMEDOUT）

检查代理配置：
- 确认代理服务运行中
- 确认 `http_proxy` 环境变量端口正确
- 确认 ecosystem.config.js 中 `env.http_proxy` 端口正确
- 测试：`curl --proxy http://127.0.0.1:<端口> https://www.okx.com`

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