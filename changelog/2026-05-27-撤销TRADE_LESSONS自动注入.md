# 2026-05-27 撤销 TRADE_LESSONS.md 自动注入

## 背景

2026-05-13 在 OpenClaw 源码 `workspace-Ddypv-c6.js` 中增加了 4 处改动，使 agent 每次唤醒时自动加载 workspace 根目录下的 `TRADE_LESSONS.md` 到上下文。

## 变更

撤销该 patch，不再在唤醒时自动读取 `TRADE_LESSONS.md`。

**文件：** `~/.npm-global/lib/node_modules/openclaw/dist/workspace-Ddypv-c6.js`

**回退的 4 处：**

| # | 行 | 内容 |
|---|-----|------|
| 1 | ~56 | 移除 `const DEFAULT_TRADE_LESSONS_FILENAME = "TRADE_LESSONS.md";` |
| 2 | ~152 | 从 `VALID_BOOTSTRAP_NAMES` 白名单中移除 |
| 3 | ~460-461 | 从 entries 扫描列表中移除 |
| 4 | ~470 | 移除文件不存在时的跳过保护 |

## 生效方式

`systemctl --user restart openclaw-gateway.service`（SIGUSR1 热重载无效，必须完整重启）。

## 影响

- 本次对话的 Project Context 中 `TRADE_LESSONS.md` 不再被注入（重启后生效）
- 不影响 `TRADE_LESSONS.md` 文件本身，文件仍保留在 workspace 根目录
- 其他 agent 无影响
