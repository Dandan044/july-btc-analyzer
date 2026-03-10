# 警报器管理任务

此任务在日报或即时分析任务**完成后**被调用，负责管理警报器规则。

**注意**：七月具有当前分析的上下文，可以直接使用分析结果（趋势判断、关键位置等）进行警报管理。

---

## 执行步骤

### 1. 查看当前规则

查看 `skills/btc-alert/rules/` 文件夹，查看所有活跃规则：

```bash
ls -la skills/btc-alert/rules/
```

对每个规则文件，读取其 `name` 和 `lifetime()` 状态。

### 2. 评估规则状态

根据本次分析结果和当前规则，决定操作：

| 情况 | 操作 |
|------|------|
| 规则目标已失效（如压力位已突破） | 归档到 `rules-archive/` |
| 规则已过期（lifetime 返回 expired） | 归档到 `rules-archive/` |
| 经过分析规则也不再适用但仍在活跃 | 归档活跃规则 |
| 分析发现新的关键位置 | 创建新规则 |
| 规则仍在有效期内且目标有效 | 保持不变 |

### 3. 归档过期规则

将不再需要的规则文件移动到归档目录：

```bash
mv skills/btc-alert/rules/<rule-name>.js skills/btc-alert/rules-archive/
```

记录到日志：`logs/alert-management.log`

```
[YYYY-MM-DD HH:mm:ss] 归档规则: <rule-name>.js | 原因: xxx
```

### 4. 设定新规则

根据分析结论，设定0到3个新的最关键警报。参考 `tasks/set-alert.md` 的规范。

**新规则默认设定**：
- 触发动作：执行"即时分析任务"
- 冷却时间：至少 1 小时
- 有效期：根据分析结果设定（如突破后当天有效），或一次性触发（触发后即归档）

### 5. 记录管理日志

所有操作记录到 `logs/alert-management.log`：

```
[YYYY-MM-DD HH:mm:ss] 警报器管理开始 | 来源: daily-report
[YYYY-MM-DD HH:mm:ss] 当前活跃规则: 3 个
[YYYY-MM-DD HH:mm:ss] 归档规则: xxx.js | 原因: 压力位已突破
[YYYY-MM-DD HH:mm:ss] 新增规则: yyy.js | 目标: 监控92000压力位
[YYYY-MM-DD HH:mm:ss] 当前活跃规则: 3 个
[YYYY-MM-DD HH:mm:ss] 警报器管理完成
```

---

⚠️ 所有新规则默认触发即时分析任务。七月。