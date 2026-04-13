# deployment.md - 部署配置指南

此技能在新环境中部署时，需要配置以下服务和定时任务。

---

## PM2 进程配置

### btc-alert - 警报器引擎

警报器引擎通过 PM2 运行，负责监控市场并在触发条件时创建即时分析任务。

#### ecosystem.config.js 配置

```javascript
module.exports = {
  apps: [{
    name: 'btc-alert',
    script: './skills/btc-alert/engine.js',
    cwd: '<技能安装目录>',  // ⚠️ 必填：替换为实际绝对路径
    
    // 自动重启配置
    autorestart: true,
    watch: false,
    max_restarts: 10,
    restart_delay: 3000,
    
    // 内存限制
    max_memory_restart: '500M',
    
    // 日志
    error_file: './logs/btc-alert-error.log',
    out_file: './logs/btc-alert-out.log',
    merge_logs: true,
    time: true,
    
    // 环境
    env: {
      NODE_ENV: 'production',
      TZ: 'Asia/Shanghai',
      http_proxy: 'http://127.0.0.1:<代理端口>',   // ⚠️ 替换端口
      https_proxy: 'http://127.0.0.1:<代理端口>',
      all_proxy: 'socks5://127.0.0.1:<代理端口>'
    }
  }]
};
```

**⚠️ 必填项**：
| 字段 | 说明 |
|------|------|
| `cwd` | 技能安装的绝对路径，如 `/home/user/.agents/skills/july-btc-analysis` |
| `http_proxy` 端口 | 代理端口，国内访问 OKX API 必需 |

#### 启动命令

```bash
cd <技能目录>
pm2 start ecosystem.config.js
pm2 save
```

**验证运行**：
```bash
pm2 list
pm2 logs btc-alert
```

---

## 定时任务配置

### 日报任务（Cron Jobs）

使用 OpenClaw cron 系统配置每天 9:00 和 21:00 的日报任务。

#### 早间日报（9:00 GMT+8）

```json
{
  "name": "btc-morning-report",
  "agentId": "<智能体ID>",
  "schedule": {
    "kind": "cron",
    "expr": "0 9 * * *",
    "tz": "Asia/Shanghai"
  },
  "sessionTarget": "isolated",
  "wakeMode": "now",
  "payload": {
    "kind": "agentTurn",
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
  "name": "btc-evening-report",
  "agentId": "<智能体ID>",
  "schedule": {
    "kind": "cron",
    "expr": "0 21 * * *",
    "tz": "Asia/Shanghai"
  },
  "sessionTarget": "isolated",
  "wakeMode": "now",
  "payload": {
    "kind": "agentTurn",
    "message": "[SPAWN_DAILY_REPORT]执行比特币技术分析日报：获取BTC价格、恐惧指数、技术指标数据，进行技术分析，生成报告并发送",
    "thinking": "high",
    "timeoutSeconds": 0
  },
  "delivery": {
    "mode": "none"
  }
}
```

**⚠️ 必填项**：
| 字段 | 说明 |
|------|------|
| `agentId` | 使用此技能的智能体 ID，如 `july` 或自定义名称 |
| `name` | 任务名称，建议格式 `<智能体ID>-btc-morning/evening` |

#### 创建任务命令

使用 cron 工具添加：

```bash
# 通过 OpenClaw 工具添加
cron action=add job=<上述JSON配置>
```

或通过智能体会话中调用：
```
使用 cron 工具，action=add，传入完整的 job JSON 配置
```

---

## 通知渠道配置

日报发送到飞书需要额外配置：

### 飞书私聊发送

在 `.openclaw/credentials.json` 中配置：
```json
{
  "feishu": {
    "targetOpenId": "ou_xxx"  // ⚠️ 替换为目标用户的 Open ID
  }
}
```

或直接在 cron 的 `delivery` 中指定：
```json
{
  "delivery": {
    "mode": "announce",
    "channel": "feishu",
    "to": "ou_xxx",
    "accountId": "<飞书机器人账号ID>"
  }
}
```

---

## 数据源配置

### OKX API

安装 OKX CLI 工具：
```bash
npm install -g @okx_ai/okx-trade-cli
okx --version  # 验证安装
```

配置 API 凭证（如需实盘交易）：
```bash
# 配置文件路径
~/.okx/config.toml
```

### 代理 Wrapper 脚本

国内网络访问 OKX API 需要代理。技能提供 wrapper 脚本：

```bash
# 使用方式
./scripts/okx-proxy.sh --profile live account balance

# 或指定完整路径
<技能目录>/scripts/okx-proxy.sh --profile live account balance
```

---

## 完整部署步骤

### 1. 安装依赖

```bash
cd <技能目录>
npm install
```

### 2. 编辑 ecosystem.config.js

填写必填项：
- `cwd` → 技能绝对路径
- `http_proxy` 端口 → 代理端口（如 7890）

### 3. 配置数据源

- 安装 OKX CLI：`npm install -g @okx_ai/okx-trade-cli`
- 配置 API 凭证（可选）

### 4. 启动警报器

```bash
pm2 start ecosystem.config.js
pm2 save
```

### 5. 配置定时任务

使用 cron 工具添加两个日报任务（9:00 和 21:00）。

### 6. 配置飞书通知（可选）

在 `credentials.json` 或 cron `delivery` 中配置目标用户。

---

## 配置检查清单

部署完成后，验证以下项目：

| 检查项 | 命令 | 预期结果 |
|--------|------|---------|
| PM2 运行 | `pm2 list` | `btc-alert` 状态 online |
| 警报器日志 | `pm2 logs btc-alert --lines 20` | 有心跳日志输出 |
| Cron 任务 | `cron action=list` | 两个日报任务已注册 |
| OKX CLI | `okx --version` | 显示版本号 |
| 代理可用 | `curl --proxy http://127.0.0.1:<端口> https://www.okx.com` | 返回正常 |

---

## 常见问题

### Q: PM2 启动失败 "script not found"

检查 `cwd` 是否为技能目录的绝对路径。

### Q: 警报器无法获取数据

检查代理配置：
- `ecosystem.config.js` 中 `http_proxy` 端口是否正确
- 代理服务是否运行

### Q: Cron 任务不触发

检查：
- `agentId` 是否与实际智能体 ID 一致
- 智能体是否已配置并运行

### Q: 飞书发送失败

检查：
- `credentials.json` 中的 `targetOpenId` 是否正确
- 飞书机器人是否有发送权限