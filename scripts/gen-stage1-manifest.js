#!/usr/bin/env node
/**
 * gen-stage1-manifest.js — 生成阶段一数据清单 JSON
 *
 * 用法: node gen-stage1-manifest.js <COIN> <CYCLE_DIR> [--contract-ok] [--sentiment-media-ok] [--sentiment-onchain-ok]
 *
 * 参数说明:
 *   COIN        币种代码 (如 DOGE)
 *   CYCLE_DIR   周期目录名 (如 alt-DOGE-20260521-1602)
 *
 *   状态标志（可选）:
 *     --contract-ok          合约数据获取成功（默认检查文件是否存在）
 *     --sentiment-media-ok   消息面数据获取成功（默认检查文件是否存在）
 *     --sentiment-onchain-ok 链上数据获取成功（默认检查文件是否存在）
 *
 *   历史报告：脚本自动从 active/ 下收集该币种的历史报告路径，无需手动传入。
 *
 * 输出: JSON 写入 active/{CYCLE_DIR}/data-context/data-manifest-{COIN}-YYYY-MM-DD-HHMM.json
 *       同时输出路径到 stdout
 */

const fs = require('fs');
const path = require('path');

// ─── 参数解析 ───
const args = process.argv.slice(2);
const COIN = args[0];
let CYCLE_DIR = args[1];

if (!COIN || !CYCLE_DIR) {
  console.error('用法: node gen-stage1-manifest.js <COIN> <CYCLE_DIR> [flags...]');
  process.exit(1);
}

// 容错：去除可能的 active/ 前缀
CYCLE_DIR = CYCLE_DIR.replace(/^active\//, '');

const WORKSPACE = path.resolve(__dirname, '..');

// 解析标志
const flags = {};
for (let i = 2; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
}

// ─── 自动收集历史报告路径 ───
const activeDir = path.join(WORKSPACE, 'active');
const reportPaths = [];
try {
  const allCycles = fs.readdirSync(activeDir)
    .filter(d => d.startsWith(`alt-${COIN}-`) && d !== CYCLE_DIR)
    .sort()
    .reverse()
    .slice(0, 5);

  for (const cycle of allCycles) {
    const cycleReportsDir = path.join(activeDir, cycle, 'reports');
    if (fs.existsSync(cycleReportsDir)) {
      const reports = fs.readdirSync(cycleReportsDir)
        .filter(f => f.startsWith(`alt-report-${COIN}-`) && f.endsWith('.md'));
      for (const r of reports) {
        reportPaths.push(`active/${cycle}/reports/${r}`);
      }
    }
  }
} catch (e) {
  // 静默失败
}

// ─── 时间戳 ───
const now = new Date();
const nowISO = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 19) + '+08:00';
const dateStr = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const timeStr = new Date(now.getTime() + 8 * 3600000).toISOString().slice(11, 16).replace(':', '');
const hhmm = new Date(now.getTime() + 8 * 3600000).toISOString().slice(11, 16);
const hhmmStr = hhmm.replace(':', '');

// ─── 路径计算 ───
const cycleDir = `active/${CYCLE_DIR}`;

// 合约数据文件：data/{COIN}-YYYY-MM-DD.json
const contractFile = `data/${COIN}-${dateStr}.json`;

// 消息面文件
const mediaFile = `${cycleDir}/data-context/sentiment-media.md`;

// 链上数据文件
const onchainFile = `${cycleDir}/data-context/sentiment-onchain.md`;

// 链上 JSON 数据文件（最新）
let onchainJsonFile = null;
let onchainJsonUpdatedAt = null;
try {
  const dataDir = path.join(WORKSPACE, 'data');
  if (fs.existsSync(dataDir)) {
    const jsonFiles = fs.readdirSync(dataDir)
      .filter(f => f.startsWith(`onchain-${COIN}-`) && f.endsWith('.json'))
      .sort().reverse();
    if (jsonFiles.length > 0) {
      onchainJsonFile = `data/${jsonFiles[0]}`;
      const jsonPath = path.join(dataDir, jsonFiles[0]);
      const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      onchainJsonUpdatedAt = jsonData['元数据(meta)']?.['采集时间(collected_at)'] || null;
    }
  }
} catch (e) {}

// 持仓文件
const positionsFile = `${cycleDir}/positions.json`;

// 自动检测文件是否存在
const contractOk = flags['contract-ok'] || fs.existsSync(path.join(WORKSPACE, contractFile));
const mediaOk = flags['sentiment-media-ok'] || fs.existsSync(path.join(WORKSPACE, mediaFile));
const onchainOk = flags['sentiment-onchain-ok'] || fs.existsSync(path.join(WORKSPACE, onchainFile));

// 自动检测持仓文件
let positionsCount = 0;
let hasExisting = false;
try {
  if (fs.existsSync(path.join(WORKSPACE, positionsFile))) {
    const posData = JSON.parse(fs.readFileSync(path.join(WORKSPACE, positionsFile), 'utf8'));
    positionsCount = (posData['当前持仓'] || []).length;
    hasExisting = positionsCount > 0;
  }
} catch (e) {}

// 历史报告
const reportCount = reportPaths.length;
const reports = reportPaths.map((rp) => {
  const parts = rp.split('/');
  const cycleId = parts[1] || '';
  return { path: rp, cycle_id: cycleId, date: dateStr };
});

// ─── 生成 JSON ───
const manifest = {
  manifest_version: '1.0',
  stage: 'altcoin-intel',
  generated_at: nowISO,

  coin: {
    symbol: COIN,
    cycle_dir: CYCLE_DIR,
    started_at: nowISO,
  },

  positions: {
    file: positionsFile,
    current_count: positionsCount,
    has_existing: hasExisting,
  },

  history_reports: {
    coin: COIN,
    reports: reports,
    total_count: reportCount,
    note: reportCount > 0 ? `${reportCount}天前历史报告` : `${COIN} 首次分析，无历史报告`,
  },

  data_collected: {
    sentiment_media: {
      file: mediaFile,
      status: mediaOk ? 'success' : 'failed',
    },
    sentiment_onchain: {
      file: onchainFile,
      json_file: onchainJsonFile,
      json_updated_at: onchainJsonUpdatedAt,
      json_ttl_minutes: onchainJsonFile ? 240 : null,
      status: onchainOk ? 'success' : 'failed',
    },
    contract: {
      status: contractOk ? 'success' : 'failed',
      data_file: contractFile,
      source: 'OKX API',
      generated_at: nowISO,
    },
  },

  next_stage: {
    task_file: 'tasks/alt-pipeline/alt-intel-stage2.md',
    spawn_instruction: `阶段一三维信息收集已完成，请读取 data-manifest 开始阶段二交叉验证分析。`,
  },
};

// ─── 写入文件 ───
const manifestDir = path.join(cycleDir, 'data-context');
if (!fs.existsSync(manifestDir)) {
  fs.mkdirSync(manifestDir, { recursive: true });
}

const manifestFile = path.join(manifestDir, `data-manifest-${COIN}-${dateStr}-${hhmmStr}.json`);
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

// stdout 输出文件路径
console.log(manifestFile);
