# Gateway OOM 诊断、修复与系统监控

**日期**: 2026-05-27 15:55
**严重度**: 高 — Gateway OOM 崩溃导致 4 个任务 cron add 失败
**影响范围**: gateway 进程稳定性、cron 调度成功率、Dashboard 系统监控

---

## 问题：Gateway 14:46 OOM 崩溃

### 现象
Gateway 堆内存冲到 4GB 上限，进程崩溃自动重启。期间 5 个 cron add 任务失败（EDEN、HOME、NOT、JELLYJELLY、TRUST），其中 3 个真正丢失。

### 根因
三重 `cron.list` 调用源叠加导致：
1. **Dashboard `/api/analysis/jobs`**：每 5s 调一次 `openclaw cron list --json`（早期「⚡ 分析」按钮的进度追踪轮询）
2. **Dispatcher 缓存刷新**：每 30s 一次（正常）
3. **Dashboard 名字缓存**：每 60s 一次（正常）

5-6 次/分 × 每次 1.2-1.6s 的 JSON.parse 在堆里反复分配大对象，GC 跟不上分配速度，最终 OOM。

### 崩溃时刻
```
14:44:05  EDEN 派发 → 14:44:20 失败（gateway 内存压力下响应迟缓）
14:46:18  FATAL ERROR: Reached heap limit - JavaScript heap out of memory
14:47:14  Gateway 重启，handshake timeout 持续到 14:48:23
14:47:33  HOME + NOT 派发 → 撞在重启窗口，真正丢失
14:48:03  JELLYJELLY 失败
14:58:01  恢复，后续任务正常
```

---

## 修复一：删除无用的分析任务轮询

### 删除内容
| 位置 | 删除 |
|------|------|
| `dashboard/server.js` | `POST /api/cycles/:id/analyze` — 创建 dash- cron job |
| `dashboard/server.js` | `GET /api/analysis/jobs` — 每 5s 调 CLI 的元凶 |
| `dashboard/server.js` | `DELETE /api/analysis/:jobId` |
| `dashboard/public/index.html` | 周期卡片 `⚡ 分析` 按钮 + 状态 div |
| `dashboard/public/index.html` | `triggerAnalysis()` 等 5 个函数 + 变量 + CSS |

### 效果
`cron.list` 调用从 5-6次/分 降至 ~3次/分，Gateway RSS 从 3.2GB 自然回落至 1.6GB。

---

## 修复二：新增 Gateway 实时监控面板

### 后端
- **新增** `GET /api/gateway/status`：轻量端点（仅 `ps` + `free` + `/proc/PID/status`，< 10ms）
- **新增** OOM 检测：PID 变化追踪（`data/gw-oom-track.json`），记录崩溃次数和时间
- `/api/system` 保留 `gateway.cronList5min`，仅 tab 加载时采样

### 前端（系统页面最上端）
- 🧠 **Gateway 内存**：进度条 (0-6GB)，红色竖线标峰值 VmHWM，OOM 告警行
- ⚡ **Gateway CPU**：进度条 (0-100%)，PID + 运行时间
- 💻 **系统内存**：进度条 + Swap 信息
- 📋 **cron.list/5min**：折叠区，点击展开详情
- **3 秒实时轮询**：切到系统 tab 启动，切走停止

---

## 修复三：Gateway 堆上限 4GB → 6GB

### 修改
`~/.config/systemd/user/openclaw-gateway.service`:
```
ExecStart=/usr/bin/node --max-old-space-size=6144 ... gateway --port 18789
```

### 影响评估
- 宿主机 32GB，WSL2 分配 15GB，当前用 ~6GB
- Gateway 最高可到 6GB，剩余 ~9GB 给系统
- Dashboard 进度条、色标阈值同步更新

---

## Dashboard 前端改动汇总

| 文件 | 改动 |
|------|------|
| `server.js` | +`/api/gateway/status` 端点，-3 个 analysis 端点，`/api/system` 加 `gateway` 字段 |
| `public/index.html` | +Gateway 进度条面板（含 CSS），+3s 轮询逻辑，+PID 变化 OOM 检测，-⚡分析按钮及全部关联代码 |

---

*后续观察：Gateway 是否会再次逼近 OOM，cron.list 频率是否稳定在 ≤ 6次/分*
