# 2026-05-18 — btc-log-rotate 从 PM2 迁移至系统 cron

## 变更概述

将每日日志归档任务 `btc-log-rotate` 从 PM2 `cron_restart` 管理迁移到系统 cron（`crontab -e`）。

## 原因

PM2 的 `cron_restart` 机制在该进程上表现不稳定：

- 2026-05-18 凌晨 00:05~00:10 间出现 4 次重复触发（00:05、00:09×2、00:10）
- 原因推测：PM2 守护进程重启后，cron_restart 的计时器评估出现重叠，加上 `autorestart: false` 的进程退出行为与 cron 调度产生竞态
- 此脚本是纯 shell 操作（日志提取、压缩、移动文件），不需要 AI 参与，用系统 cron 更合适

## 改动

### 删除 PM2 进程

```bash
pm2 delete btc-log-rotate
pm2 save
```

### 添加系统 cron（crontab -e）

```cron
# 每日 00:10 执行 btc-alert 日志归档（替代之前的 PM2 btc-log-rotate）
10 0 * * * /home/administrator/.openclaw/july-btc-analyzer/scripts/log-rotate.sh >> /home/administrator/.openclaw/july-btc-analyzer/logs/log-rotate-cron.log 2>&1
```

### 更新 ecosystem.config.js

移除了 `btc-log-rotate` 配置段。

## 影响范围

- 功能不变：脚本本身未改动，仍包含日志归档、数据归档、规则归档和通知（通过 `openclaw cron add` 调用十四月发 QQ）
- 触发方式：PM2 cron_restart → 系统 cron
- 日志输出：原 `logs/log-rotate.log` → `logs/log-rotate-cron.log`
- 脚本内的 `openclaw cron add` 调用不受影响，通知链路不变

## 验证

```bash
crontab -l          # 确认条目存在
pm2 list            # btc-log-rotate 已不在列表中
pm2 save            # 已保存
```

变更者：七月 (Dandan 指示)
变更时间：2026-05-18 23:35 CST
