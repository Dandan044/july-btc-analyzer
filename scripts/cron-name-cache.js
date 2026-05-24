#!/usr/bin/env node
/**
 * cron-name-cache.js — 独立后台进程，不依赖 dashboard
 *
 * 每 60 秒调用 openclaw cron list --json，将活跃 cron job 的 name
 * 写入 ~/.openclaw/cron/job-names.json 缓存文件。
 *
 * 解决问题：大多数 cron job 带 deleteAfterRun=true，完成后自动删除。
 * 如果不在其存活期间捕获名字，dashboard 只能显示原始 UUID。
 * 此进程确保每 60 秒刷新缓存，与 dashboard 是否打开无关。
 *
 * PM2 管理: pm2 start scripts/cron-name-cache.js --name cron-name-cache
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE_FILE = path.join(os.homedir(), '.openclaw', 'cron', 'job-names.json');
const INTERVAL_MS = 30000;

function tick() {
  const now = new Date().toISOString().slice(0, 19);
  const nameMap = {};

  // 加载已有缓存
  try {
    if (fs.existsSync(CACHE_FILE)) {
      Object.assign(nameMap, JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')));
    }
  } catch {}

  // 从当前活跃 cron 列表更新
  try {
    const raw = execSync('openclaw cron list --json', {
      encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe']
    });
    const data = JSON.parse(raw);
    let added = 0;
    for (const j of (data.jobs || [])) {
      if (j.name && !nameMap[j.id]) {
        nameMap[j.id] = j.name;
        added++;
      }
    }
    if (added > 0) {
      console.log(`[${now}] +${added} 个新名字 (总数 ${Object.keys(nameMap).length})`);
    }
  } catch (e) {
    console.error(`[${now}] cron list 失败: ${e.message}`);
  }

  // 写回
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(nameMap), 'utf8');
  } catch (e) {
    console.error(`[${now}] 写入缓存失败: ${e.message}`);
  }
}

console.log(`[cron-name-cache] 启动 – 每 ${INTERVAL_MS / 1000}s 刷新 → ${CACHE_FILE}`);
tick();
setInterval(tick, INTERVAL_MS);
