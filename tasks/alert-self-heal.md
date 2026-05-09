# 警报器自愈诊断任务

你收到此任务是因为警报器引擎检测到某个规则连续失败 5 次，需要你进行诊断和修复。

---

## 任务参数

引擎会通过消息传入以下信息：

```
规则文件: <relative path from skills/btc-alert/rules/>
规则名称: <rule.name>
错误信息: <error.message>
错误堆栈: <error.stack>
错误次数: <consecutiveErrors>
```

---

## 执行步骤

### 步骤 1：读取错误规则文件

```bash
cat skills/btc-alert/rules/<filename>
```

### 步骤 2：错误分类

根据错误信息和堆栈，判断错误属于哪个类别：

#### A 类 — 规则代码问题（修复）

以下错误属于 A 类，**修复规则文件即可**：

| 错误特征 | 示例 | 修复方式 |
|---------|------|---------|
| `require` 路径错误 | `Cannot find module '../../xxx/api'` | 修正 require 路径 |
| 变量未定义 | `xxx is not defined` | 添加变量声明或修正引用 |
| 拼写错误 | `this.interva1`（应为 `this.interval`） | 修正拼写 |
| API 参数传递错误 | `Cannot read property 'xxx' of undefined` | 检查 API 调用参数是否正确 |
| `lifetime()` 返回非字符串 | 引擎判断 `status !== 'active'` → 意外停止 | 修正 lifetime() 返回 `'active'`/`'expired'`/`'completed'` |
| 属性访问链断裂 | `data.result.list[0].xxx` 其中 `list` 为空 | 加空值保护 |
| 语法错误 | `SyntaxError: Unexpected token` | 修正语法 |

**⚠️ 引擎 API 合约（核心）**：

`lifetime()` **必须返回字符串** `'active'` / `'expired'` / `'completed'`，不能返回 `true`/`false`！

```javascript
// ❌ 常见错误
lifetime() {
  return ageHours < 72;  // 返回 boolean，引擎误判
}

// ✅ 正确写法
lifetime() {
  const ageHours = (Date.now() - created) / 3600000;
  return ageHours < 72 ? 'active' : 'expired';
}
```

#### B 类 — 接口/源码问题（归档，不修改）

以下错误属于 B 类，**不能擅自修改源码，直接归档**：

| 错误特征 | 说明 |
|---------|------|
| `api.xxx is not a function` | API 模块缺少方法，需要修改 `btc-market-lite/scripts/api.js` |
| engine.js 自身逻辑缺陷 | 引擎代码问题，不是你该动的 |
| 规则依赖的 npm 包不存在 | 环境问题，需要管理员处理 |

#### C 类 — 外部不可控问题（归档）

以下错误属于 C 类，**无法通过代码修复，直接归档**：

| 错误特征 | 说明 |
|---------|------|
| HTTP 429 (Too Many Requests) | OKX API 限流 |
| `ETIMEDOUT` / `ECONNREFUSED` | 网络/代理问题 |
| `socket hang up` / `ECONNRESET` | 连接中断 |
| OKX API 返回结构变更 | API 字段名变更导致解析失败 |
| curl/proxy 相关错误 | 代理不可达 |

---

### 步骤 3：执行操作

#### 如果是 A 类 → 修复规则文件

1. 使用 `edit` 工具直接修改 `skills/btc-alert/rules/<filename>`
2. 修复后引擎扫描器（60s 间隔）会自动检测到文件变化并热重载
3. 记录修复日志到 `logs/alert-selfheal.log`：
```
[YYYY-MM-DD HH:mm:ss] FIXED | 规则: <ruleName> | 文件: <filename> | 问题: <简述> | 修复: <简述>
```

#### 如果是 B 类 → 归档 + 说明原因

1. 将规则文件移动到归档目录：
```bash
mv skills/btc-alert/rules/<filename> skills/btc-alert/rules-archive/
```
2. 记录归档日志到 `logs/alert-selfheal.log`：
```
[YYYY-MM-DD HH:mm:ss] ARCHIVED | 规则: <ruleName> | 文件: <filename> | 类别: B-源码问题 | 原因: <简述>
```

#### 如果是 C 类 → 归档 + 说明原因

1. 将规则文件移动到归档目录：
```bash
mv skills/btc-alert/rules/<filename> skills/btc-alert/rules-archive/
```
2. 记录归档日志到 `logs/alert-selfheal.log`：
```
[YYYY-MM-DD HH:mm:ss] ARCHIVED | 规则: <ruleName> | 文件: <filename> | 类别: C-外部问题 | 原因: <简述>
```

---

### 步骤 4：通知十四月（必须执行，无论结果）

无论自愈成功还是失败，都必须通知十四月。使用 `sessions_send`：

```
sessions_send:
  label: "shisiyue"
  message: |
    请告诉主人：

    警报器自愈诊断结果：
    规则：{ruleName}
    结果：{FIXED | ARCHIVED}
    类别：{A-代码修复 | B-源码问题 | C-外部问题}
    详情：{简述问题和操作}

    文件：{filename}
```

**通知模板示例**：

```
修复成功：
  主人～警报器自愈完成！
  规则「持仓量异动警报」连续报错5次后已自动修复（require路径错误 → 已修正）。
  规则已恢复正常运行～

归档-B类：
  主人～警报器自愈诊断完成。
  规则「XXX」因接口源码问题（api.getXXX 方法不存在）已自动归档，未修改引擎源码。
  需管理员检查 btc-market-lite/scripts/api.js。

归档-C类：
  主人～警报器自愈诊断完成。
  规则「XXX」因网络问题（OKX API 频繁429限流）已自动归档。
  等网络恢复后可重新创建规则。
```

---

## 完成

执行完毕后，无需等待引擎反馈。你的文件操作会被引擎扫描器自动检测并生效。

📈 七月
