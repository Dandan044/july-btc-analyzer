# 2026-05-13: 工作区文件注入机制修改

## 背景

TRADE_LESSONS.md（原 LEARNINGS.md）记录复盘提炼的行为模式，需要在我每次醒来时自动加载到上下文中。但 OpenClaw 的 workspace bootstrap 注入机制是硬编码的，不支持自定义文件名。

## 修改

**文件：** `~/.npm-global/lib/node_modules/openclaw/dist/workspace-Ddypv-c6.js`

**4 处改动：**

1. **Line 56** — 添加常量声明：
   `const DEFAULT_TRADE_LESSONS_FILENAME = "TRADE_LESSONS.md";`

2. **Line 152** — 加入 VALID_BOOTSTRAP_NAMES 白名单：
   `DEFAULT_TRADE_LESSONS_FILENAME,`

3. **Line 460-461** — 加入 entries 扫描列表（排在 MEMORY.md 之前）：
   ```
   { name: DEFAULT_TRADE_LESSONS_FILENAME, filePath: path.join(resolvedDir, DEFAULT_TRADE_LESSONS_FILENAME) },
   ```

4. **Line 470** — 添加跳过保护（文件不存在时静默跳过，不影响其他 agent）：
   `if (entry.name === DEFAULT_TRADE_LESSONS_FILENAME && !await exactWorkspaceEntryExists(resolvedDir, DEFAULT_TRADE_LESSONS_FILENAME)) continue;`

## 生效条件

**必须完整重启 systemd 服务**（`systemctl --user restart openclaw-gateway.service`），SIGUSR1 热重载不生效（它只重载配置，不重载 JS 代码）。

## 风险

`npm update -g openclaw` 会覆盖此改动。如果更新后 TRADE_LESSONS.md 不再自动注入，需重新应用此 patch。

## 影响范围

仅 workspace 根目录下有 `TRADE_LESSONS.md` 的 agent（目前仅七月）会注入此文件。其他 agent 静默跳过。

Source: 2026-05-13 会话，用户指令
