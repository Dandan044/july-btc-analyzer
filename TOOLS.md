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

# 平仓（关闭全部仓位）
okx-proxy.sh --profile live swap close --instId BTC-USDT-SWAP --mgnMode isolated --posSide long

# ⚠️ 减仓（部分平仓）—— 不能用 swap close！swap close 会全平！
# 正确方式：反向市价单减少仓位
okx-proxy.sh --profile live swap place --instId BTC-USDT-SWAP --side sell --ordType market --sz 0.13 --tdMode isolated --posSide long
```

### 技能文档
完整命令参考见：
- `~/.agents/skills/okx-cex-trade/SKILL.md` - 交易命令
- `~/.agents/skills/okx-cex-market/SKILL.md` - 市场数据
- `~/.agents/skills/okx-cex-portfolio/SKILL.md` - 账户余额/持仓

---

## 警报器规则 API 合约 ⚠️

创建警报规则时必须遵守引擎 API 合约（见 `skills/btc-alert/engine.js` `runRule()`）：

| 方法 | 返回值类型 | 说明 |
|------|-----------|------|
| `check()` | `boolean` | 触发条件是否满足 |
| `collect()` | `object` | 收集触发数据 |
| `trigger(alert)` | `void` | 触发动作 |
| `lifetime()` | **`'active'` \| `'expired'` \| `'completed'`** | ⚠️ 必须返回字符串，**不是 boolean！** |

**常见错误**：`return ageHours < 72` ❌ → 应写 `return ageHours < 72 ? 'active' : 'expired'` ✅

引擎会判断 `lifetime() !== 'active'`，返回 `true`/`false` 会导致被误判为过期 → 无限重载循环。

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

### ⚡ OKX Public API 速率限制（实测 2026-04-30）

**实测结论：OKX 公开接口短窗口内约 40-50 个请求后触发 429 限流。**

实测数据（通过代理 `127.0.0.1:7890`，单请求延迟 ~1.3s）：

| 并发数 | 总请求 | 成功 | 429 | 首次429 | 安全？ |
|--------|--------|------|-----|---------|--------|
| 2-10 | 10-50 | 100% | 0 | - | ✅ |
| 15 | 60 | 40 | 20 | #16 | ❌ |
| 20 | 80 | 40 | 40 | #21 | ❌ |

关键发现：
- **安全阈值：≤ 5 req/s**，此范围内零限流
- **限流恢复：10 秒后可恢复**（等待即可）
- **警报器实际负载：~0.05 req/s**（3规则×5接口/5分钟），距离限流线 ~100 倍余量
- 混合接口（ticker+klines+OI+taker 同时请求）不限流
- 限流表现为 HTTP 429，不是连接拒绝
- 测试脚本：`scripts/test_okx_ratelimit_v3.js`

---

## 🌐 Web Search 配置（2026-04-30）

### 主力引擎：DuckDuckGo

- **Provider**: `duckduckgo`
- **费用**: 免费，无需 API Key
- **方式**: HTML 网页抓取（非官方 API）
- **国内**: 需通过代理 `127.0.0.1:7890` 访问
- **代理配置**: 在 systemd service 中设置了 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 环境变量
- **速度**: 英文 ~450ms，中文 ~1900ms
- **特点**: 结果精准度高，噪音少，覆盖中英文源

### 备用引擎：MiniMax

- **Provider**: `minimax`
- **费用**: 按量计费
- **API Key**: 已配置在 `plugins.entries.minimax.config.webSearch.apiKey`
- **国内**: 直连
- **速度**: ~1800ms
- **特点**: 对中文快讯更敏感，但结果噪音较多

### 切换方式

```bash
# 编辑配置文件
python3 -c "
import json
with open('/home/administrator/.openclaw/openclaw.json') as f:
    c = json.load(f)
c['tools']['web']['search']['provider'] = 'minimax'  # 或 'duckduckgo'
with open('/home/administrator/.openclaw/openclaw.json', 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
"
# 重启服务
systemctl --user restart openclaw-gateway.service
```

### ⚠️ 注意事项

- `tools.web.search.provider` 是受保护路径，不能通过 `config.patch` 修改，必须直接编辑文件后重启
- DuckDuckGo 依赖代理，如果代理挂了会自动不可用
- 如需新增其他 provider（Brave/Tavily 等），参考 `plugins.entries.<provider>.config.webSearch` 模式
- 配置日期：2026-04-30

---

## 🔗 OnchainOS 链上数据 CLI

### 安装位置
```bash
onchainos --version  # 2.5.0
which onchainos      # /home/administrator/.local/bin/onchainos
```

### 技能目录
`~/.openclaw/onchainos-skills/`

安装日期：2026-04-29

### 常用命令

```bash
# 代币搜索
onchainos token search --query DOGE

# 持有人分布（Top 100，含 KOL/鲸鱼/聪明钱标签）
onchainos token holders --address <addr>

# 高级信息（风险等级、创建者、持仓集中度）
onchainos token advanced-info --address <addr>

# 持仓集群分析（集群集中度、跑路风险、新钱包占比）
onchainos token cluster-overview --address <addr>

# 近期 DEX 成交记录
onchainos token trades --address <addr>
```

### 适用场景
- 山寨币链上数据分析（持有人结构、筹码集中度、聪明钱动向）
- 代币安全风险评估
- 持仓集群跑路风险检测

### API Key 配置
- 凭证文件：`~/.onchainos/.env`
- 备份路径：`~/.okx/onchainos.env`

### 完整参考
`~/.openclaw/onchainos-skills/skills/okx-dex-token/SKILL.md`