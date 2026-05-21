# CHANGELOG

## 2026-05-18

- **cron.maxConcurrentRuns: 1 → 2** — OpenClaw cron 调度器默认串行执行同一 tick 内触发的多个 job（`resolveRunConcurrency()` 默认值 1）。源码 `server.impl-hNr66nDN.js` 的 `onTimer` 使用 worker pool 模式，concurrency 取自 `cron.maxConcurrentRuns`。设为 2 后，同一时刻最多 2 个 cron job 并行执行。需保护路径，直接编辑 `openclaw.json` 后 `gateway restart` 生效。
