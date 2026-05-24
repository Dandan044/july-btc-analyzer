# 2026-05-24 — Gateway OOM 崩溃记录

## 发现问题

周期系统健康检查中发现 Gateway 在 5/24 08:51 CST 发生真实崩溃（SIGABRT），中断了 2 个正在运行的 ARKM 即时分析 cron job。

## 崩溃详情

| 项目 | 详情 |
|------|------|
| **时间** | 2026-05-24 08:51:30 CST |
| **进程状态** | code=dumped, status=6/ABRT |
| **直接原因** | JavaScript heap out of memory（堆内存耗尽） |
| **堆大小** | ~4GB 打满，GC 无法回收（Mark-Compact 4028→4025 MB） |
| **进程 RSS 峰值** | 1.4 GB（systemd 记录） |
| **进程 CPU 累计** | 1h47min |
| **崩溃位置** | `node::worker::Message::Deserialize` → `ValueDeserializer::ReadValue` → 反序列化巨型 JS 对象时 OOM |
| **恢复方式** | systemd 自动重启（08:51:57 拉起，08:52:05 就绪） |

## 触发条件

三个因素同时满足：

1. **一个 session 卡住 6 分钟**（`e8bdd47f`，state=processing），会话上下文在此期间不断膨胀
2. **两个新 ARKM cron job 同时启动**，都需要反序列化同一份膨胀的会话存储数据
3. **V8 堆上限 4GB**，反序列化巨型对象时突破上限

崩溃前 20 秒内密集发生了 5 次 `sessions/store` 备份轮转操作，说明会话存储文件已达到相当大的规模。

## 附：同时发现的配置问题（关联）

崩溃前日志持续报出 7 个 skill symlink 越界警告（每个 cron job 创建 session 时重复）：

```
okx-cex-bot → ~/.agents/skills/okx-cex-bot
okx-cex-earn / okx-cex-market / okx-cex-portfolio / okx-cex-trade
onchainos-skills → ~/.openclaw/onchainos-skills/skills
```

## 处理状态

- **暂不处理** — 仅记录，不确定是否复现
- 若再次发生，需排查：session 存储膨胀根因 / Node.js `--max-old-space-size` 是否需调整
