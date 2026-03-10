# TOOLS.md - 七月工具笔记

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

- **App ID**: `cli_a92ff0d3dab85cef`
- **Account ID**: `july`
- **Dandan 的 open_id**: `ou_4b65a3a145ee00ae60ae2283a839f46c`

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
message action=send channel=feishu target="ou_4b65a3a145ee00ae60ae2283a839f46c" message="文档链接: https://feishu.cn/docx/<doc_token>"
```

### 方式二：分段消息（备选）

若飞书文档失败（如 API 不可用），使用 message 工具分段发送：

- 飞书单条消息限制约 4KB
- 将报告按章节拆分为 4-5 段
- 每段独立调用 message 发送

### 接收者

Dandan 的飞书 open_id: `ou_4b65a3a145ee00ae60ae2283a839f46c`