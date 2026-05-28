# Dashboard 严重事故复盘 — 2026-05-24 23:00~23:49

**级别**: 🔴 严重事故（前端面板不可用约 49 分钟）
**影响**: Dashboard 完全无数据展示，用户无法查看周期、规则、持仓、警报

---

## 一、事故时间线

| 时间 | 事件 |
|------|------|
| 23:12 前 | Dashboard 正常运行中 |
| 23:12 | Dashboard 因 `openclaw cron list` 超时进入崩溃循环（3分钟130次重启） |
| 23:14 | 用户报告无法访问前端面板 |
| 23:14-23:18 | 诊断：Dashboard 进程正常运行，API 正确返回，但用户从 Windows 浏览器无法连接 |
| 23:18-23:22 | **修复1**: 加固 `server.js`（熔断器/全局异常保护/请求超时/safeExec 替换裸 execSync） |
| 23:22 | 用户仍无法访问 → 发现是 **WSL2 网络隔离**，非 Dashboard 问题 |
| 23:22-23:31 | **修复2**: 添加/清理 netsh portproxy，诊断 wslrelay 僵尸连接，指导用户 `wsl --shutdown` |
| 23:31 | 用户重启 WSL，页面可打开但卡片全是 `--` |
| 23:31-23:45 | **诊断3**: API 正常返回数据（200），但前端 JS 不消费数据 → 逐步缩小到 JS 层 |
| 23:45-23:49 | **定位根因3**: `uploadBackground()` 函数缺少 `async` 关键字导致 SyntaxError，主脚本全部失效 |
| 23:49 | **修复3**: 补上 `async` → 页面恢复正常 |

---

## 二、三层事故链

本次事故是**三个独立 Bug 的级联触发**，每个都能独立造成严重问题：

### Bug 1：Dashboard 崩溃循环（首因）

**位置**: `dashboard/server.js`

**现象**: PM2 显示 `restarts: 130`，3 分钟内重启 130 次。

**根因**: `safeExec('openclaw cron list --json')` 超时（`spawnSync /bin/sh ETIMEDOUT`），进程崩溃 → PM2 自动重启 → 浏览器重连 → 再次触发 → 循环。

**修复**:
- `safeExec` 超时从 25s 降低到 10s
- 新增**熔断器**: 同命令连续失败 3 次 → 60s 内不再执行
- 新增 `uncaughtException` / `unhandledRejection` 全局保护
- 新增请求级 30s 超时
- 3 处裸 `execSync()` 替换为 `safeExec()`

### Bug 2：WSL2 端口转发层雪崩（传导）

**位置**: Windows WSL2 `wslrelay.exe`

**现象**: Windows 浏览器完全无法连接 `localhost:3100`（TCP 可达但 HTTP 层卡死）。

**根因**: Bug 1 的崩溃循环期间，浏览器每崩一次就重连一次 → `wslrelay.exe` 积压大量 `CLOSE_WAIT` 僵尸 TCP 连接 → 转发层耗尽 → 新 HTTP 请求被丢弃。

**修复**:
- 清理误加的 `netsh portproxy`
- 用户执行 `wsl --shutdown` 重置网络栈

### Bug 3：前端 JS SyntaxError（终因）

**位置**: `dashboard/public/index.html` 第 394 行

**现象**: 页面能加载 HTML，但所有卡片数据为 `--`，警报区空白，周期表格不渲染。

**根因**:
```js
function uploadBackground() {        // ← 缺少 async
  ...
  const res = await fetch(...);      // ← await 在非 async 函数中
  const data = await res.json();     // ← 浏览器报 SyntaxError
}
```

浏览器遇到 `await` 在非 async 函数中 → **SyntaxError** → **整个 `<script>` 块报废**。

后果链：
1. 主 script 块中所有函数定义失效（`refreshOverview`, `renderCycleGrid`, `API.get` 等）
2. `boot()` 不会被调用，`refreshOverview()` 永远不会执行
3. 独立的第二个 `<script>` 块（quick test）不受影响，所以能显示 `OK:46`

**修复**: `function uploadBackground()` → `async function uploadBackground()`

---

## 三、为什么排查花了这么长时间

| 误判 | 正确 |
|------|------|
| 以为 Dashboard API 没返回数据 → 实际 API 一直正常（200） | 问题在 JS 层 |
| 以为 WSL 端口转发彻底断了 → 实际重启后恢复了 | HTML 能过但 JS 失效 |
| 以为 `refreshOverview` 内部某步报错 → 加了逐步骤诊断后才意识到函数从未被调用 | SyntaxError 导致整块报废 |
| Node `--check` 把 top-level await 当错误报 → 掩盖了真正的 SyntaxError | 浏览器环境支持 top-level await |

---

## 四、经验总结

### 应立即改进

1. **HTML 不应包含语法错误**: 发布前用 `eslint` / `acorn` 验证 JS 语法。浏览器环境的 `SyntaxError` 在 Node `--check` 下不一定能检出（取决于 parser 模式）。

2. **Dashboard server.js 防御层已到位**: 熔断器 + 全局异常 + 请求超时。这些加固即使没有本次 Bug 3 也值得，因为 Bug 1 是真实的 risk。

3. **前端诊断机制应留存**: `js-diag` 诊断条保留在 HTML 中。以后出现"页面空白卡"问题，第一眼看顶部的诊断条就能判断 JS 是否执行。

### 不应重复的错误

- **裸 `execSync` + 无超时 = 定时炸弹**: 已全部替换为 `safeExec`
- **等待过多层级诊断才看基础语法**: 应该第一步就检查 HTML 的 JS 是否有效

### 后续 TODO

- [ ] 将 `dashboard/public/index.html` 的 JS 提取为独立 `.js` 文件，避免 inline script 语法错误影响调试
- [ ] 在部署流程中加入 HTML 语法检查步骤
- [ ] `index.html.bak` 为旧版（136KB），考虑清理避免混淆

---

*记录时间: 2026-05-24 23:50 GMT+8*
*复盘人: 七月*
