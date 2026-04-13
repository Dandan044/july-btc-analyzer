# TOOLS.md - 七月工具笔记

## OKX 交易 API

七月已接入OKX实盘交易API，可执行现货、合约、期权交易。

### CLI 安装
```bash
npm install -g @okx_ai/okx-trade-cli
okx --version  # 1.3.0
```

### 配置文件
路径：`~/.okx/config.toml`

### 代理访问（重要！）
国内网络需要通过代理访问OKX API。使用 wrapper 脚本：

```bash
# 正确方式（自动使用代理）
~/.openclaw/july-btc-analyzer/scripts/okx-proxy.sh --profile live account balance

# 错误方式（直连会超时）
okx --profile live account balance  # ❌ 不工作
```

### Profile 模式
| --profile | 模式 | 资金 |
|-----------|------|------|
| `live` | 实盘 | 真实资金 |
| `demo` | 模拟盘 | 虚拟资金（测试） |

### 常用命令

```bash
# 查看余额
okx-proxy.sh --profile live account balance USDT

# 查看持仓
okx-proxy.sh --profile live account positions

# 查看BTC价格
okx-proxy.sh market ticker BTC-USDT

# 市价买入 0.01 BTC（现货）
okx-proxy.sh --profile live spot place --instId BTC-USDT --side buy --ordType market --sz 0.01

# 开仓 BTC 合约（做多1张）
okx-proxy.sh --profile live swap place --instId BTC-USDT-SWAP --side buy --ordType market --sz 1 --tdMode cross --posSide long

# 设置杠杆
okx-proxy.sh --profile live swap leverage --instId BTC-USDT-SWAP --lever 10 --mgnMode cross

# 平仓
okx-proxy.sh --profile live swap close --instId BTC-USDT-SWAP --mgnMode cross --posSide long
```

### 技能文档
完整命令参考见：
- `~/.agents/skills/okx-cex-trade/SKILL.md` - 交易命令
- `~/.agents/skills/okx-cex-market/SKILL.md` - 市场数据
- `~/.agents/skills/okx-cex-portfolio/SKILL.md` - 账户余额/持仓

---

## PM2 进程管理 - 警报器引擎

服务名称：`btc-alert`

### 查看服务状态
```bash
pm2 list                    # 查看所有进程状态
pm2 logs btc-alert          # 查看实时日志
pm2 info btc-alert          # 查看详细信息
```

### 服务管理
```bash
pm2 start ecosystem.config.js   # 启动服务（使用配置文件）
pm2 stop btc-alert              # 停止服务
pm2 restart btc-alert           # 重启服务
pm2 delete btc-alert            # 删除服务
```

### 重要：保存配置
每次修改PM2进程后，记得保存：
```bash
pm2 save                    # 保存当前进程列表（重要！）
```

### 开机自启
已经配置完成，系统重启后会自动启动服务。

### 日志位置
- `logs/btc-alert-out.log` - 标准输出
- `logs/btc-alert-error.log` - 错误日志
- `logs/alert-engine.log` - 警报器引擎日志
- `logs/alert-management.log` - 规则管理日志

---

## GitHub SSH 配置

SSH 密钥位置: `~/.openclaw/workspace-july/.ssh/id_ed25519`

推送时需要指定密钥：
```bash
cd ~/.openclaw/workspace-july
GIT_SSH_COMMAND="ssh -i ~/.openclaw/workspace-july/.ssh/id_ed25519" git push origin dev
```

---

## 定时任务

| 任务 | 时间 (GMT+8) | 描述 |
|------|--------------|------|
| btc-daily-report | 09:00 | 早间分析报告 |
| btc-daily-report-2 | 21:00 | 晚间分析报告 |

定时任务由 OpenClaw 主服务管理，触发后调用七月执行分析。

---

## 飞书机器人

配置存放在 `.openclaw/credentials.json`，运行时读取：

- **App ID**: 从配置文件读取 (`feishu.appId`)
- **Account ID**: `july`
- **接收者**: 从配置文件读取 (`feishu.targetOpenId`)

**获取配置示例**：
```javascript
const config = require('./.openclaw/credentials.json');
const appId = config.feishu.appId;
const targetId = config.feishu.targetOpenId;
```

---

## 报告发送方式

发送完整日报到飞书时，按以下顺序执行：

### 方式一：飞书文档（优先）

1. 创建文档：
```
feishu_doc action=create title="比特币技术分析日报 - YYYY-MM-DD HH:MM"
```

2. 写入内容：
```
feishu_doc action=write doc_token=<返回的doc_token> content=<完整Markdown内容>
```

3. 发送链接：
```
从配置读取 targetOpenId，然后：
message action=send channel=feishu target="<targetOpenId>" message="文档链接: https://feishu.cn/docx/<doc_token>"
```

### 方式二：分段消息（备选）

若飞书文档失败（如 API 不可用），使用 message 工具分段发送：

- 飞书单条消息限制约 4KB
- 将报告按章节拆分为 4-5 段
- 每段独立调用 message 发送

### 接收者

从 `.openclaw/credentials.json` 读取 `feishu.targetOpenId`

---

## ⭐ API数据源选择规则

**核心原则：不要猜测API endpoint，先查看现有代码！**

### 已验证的数据源

| 数据类型 | API endpoint | 来源 |
|---------|-------------|------|
| 多空比 | `https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1D` | OKX |
| Taker买卖比 | `https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=BTC-USDT-SWAP&instType=CONTRACTS&ccy=BTC&period=1D` | OKX |
| 持仓量 | `https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1D` | OKX |
| 恐惧贪婪指数 | `https://api.alternative.me/fng/?limit=N` | alternative.me |

### 如何找到正确endpoint

1. **查看现有脚本**：`skills/btc-market-lite/scripts/get_enhanced_analysis.js`
2. **搜索关键词**：找到你需要的数据类型对应的endpoint
3. **验证可用性**：用curl测试endpoint是否返回有效数据

### ⚠️ 禁止使用Binance API

国内网络无法访问Binance API（地区限制）：
```
❌ https://fapi.binance.com/futures/data/globalLongShortAccountRatio
   → 返回 "Service unavailable from a restricted location"
```

**必须使用OKX API替代**，endpoint已在日报脚本中验证。

### 警报器数据获取

创建警报规则时，如果需要使用代理：
```javascript
const PROXY_URL = 'http://127.0.0.1:7890';
const result = execSync(`curl -s --max-time 15 --proxy "${PROXY_URL}" "${url}"`, {
  encoding: 'utf8',
  timeout: 20000
});
```