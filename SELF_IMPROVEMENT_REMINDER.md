## Self-Improvement Reminder

After completing tasks, evaluate if any learnings should be captured:

**Log when:**
- User corrects you → `LEARNINGS.md`（根目录）
- Command/operation fails → `TOOLS.md`
- You discover your knowledge was wrong → `LEARNINGS.md`
- You find a better approach → `LEARNINGS.md`

**Promote when pattern is proven:**
- Behavioral patterns → `LEARNINGS.md`
- Workflow improvements → `AGENTS.md`
- Tool gotchas → `TOOLS.md`

Keep entries simple: date, title, what happened, what to do differently.

---

## 2026-05-06: 山寨币警报器 trigger() 批量失效

**问题：** 10条山寨币警报规则的 `trigger()` 使用了不存在的 CLI 命令 `openclaw sessions spawn`，导致全部报警触发后子会话无法创建。

**根因链：**
1. `tasks/alt-instant-stage1.md` 底部存在一个越界的 `## 警报规则 trigger() 参考` 节
2. 该节内包含错误的 `spawn('openclaw', ['sessions', 'spawn', ...])` 模板
3. `alt-intel-stage4.md` §B.6 的「模板覆盖」规则指引 AI 去这个位置取模板
4. 阶段四 AI 照此模板创建规则 → 10条规则全部感染

**修复（5步）：**
1. 从 `alt-instant-stage1.md` 删除「警报规则 trigger() 参考」节
2. 在 `set-alert.md` 末尾新增 §14「山寨币 trigger() 参考」，使用正确的 `cron add` 模板
3. `alt-intel-stage4.md` §B.6 引用改为指向 `set-alert.md` §14
4. 批量替换 10 条规则文件的 `trigger()` 为 `cron add`
5. 重启 `btc-alert` PM2 进程

**教训：**
- 任务文件的职责边界必须清晰：阶段一不教如何创建规则，阶段四不应跨文件引用模板
- CLI 模板不应分散在多个任务文件中——单一真相源（set-alert.md）
- 跨文件引用（「完整模板见某文件底部」）是脆弱的反模式
