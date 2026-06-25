#!/usr/bin/env node
/**
 * market-watch/dispatcher.js
 *
 * 触发处理器 — 触发时异步调用 stage1-instant.js 采集即时数据，通过调度器派发 LLM 分析任务
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const CONFIG = require('./config.json');

const WORKSPACE = path.resolve(__dirname, '..', '..');

function log(level, msg, data) {
  const ts = new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  const tag = { INFO: '[DISP]', WARN: '[DISP] ⚠️', ERROR: '[DISP] ❌' }[level] || '[DISP]';
  const extra = data ? ' | ' + JSON.stringify(data) : '';
  console.log(`[${ts}] ${tag} ${msg}${extra}`);
}

/**
 * 异步处理触发列表
 * @param {string} coin - 币种
 * @param {Array} triggers - check() 返回的触发列表
 * @param {object} state - 币种的 data-store entry
 */
function dispatch(coin, triggers, state) {
  if (triggers.length === 0) return;

  const stage1Script = path.resolve(__dirname, CONFIG.dispatch.script);
  const dispatchScript = path.resolve(__dirname, CONFIG.dispatch.dispatcher);
  const priority = CONFIG.dispatch.defaultPriority;

  const triggerMsgs = triggers.map(t => t.message);
  const alertName = `market-watch-${triggers.map(t => t.type).join('+')}`;

  const alertData = {
    coin: coin,
    alertName: alertName,
    alertType: 'market-watch',
    triggerPrice: triggers.find(t => t.type === 'price')?.current || null,
    currentPrice: state.current?.price || null,
    triggers: triggers.map(t => ({
      type: t.type,
      direction: t.direction,
      deltaPct: t.deltaPct,
      deltaAbs: t.deltaAbs,
      baseline: t.baseline,
      current: t.current,
    })),
    reason: triggerMsgs.join('; '),
  };

  log('INFO', `${coin} 触发: ${triggerMsgs.join(' | ')}`);

  // 异步 spawn stage1-instant.js，不阻塞 WS 消息处理
  const json = JSON.stringify(alertData);
  const child = spawn('node', [stage1Script, json], {
    cwd: WORKSPACE,
    timeout: CONFIG.dispatch.timeoutMs,
    stdio: 'pipe',
  });

  let output = '';
  child.stdout.on('data', d => output += d.toString());
  child.stderr.on('data', d => output += d.toString());

  child.on('close', (code) => {
    if (code === 0) {
      const success = output.includes('"status":"success"') || output.includes('阶段二分析任务已提交');
      if (success) {
        log('INFO', `${coin} stage1-instant 完成 → 阶段二已派发`);
      } else {
        log('WARN', `${coin} stage1-instant 完成但未确认成功，阶段二应已自动派发`);
      }
    } else {
      log('ERROR', `${coin} stage1-instant 失败 code=${code}`, { err: output.slice(-200) });
      fallbackDirect(coin, triggerMsgs, state, dispatchScript, priority);
    }
  });

  child.on('error', (err) => {
    log('ERROR', `${coin} stage1-instant 启动失败: ${err.message}`);
    fallbackDirect(coin, triggerMsgs, state, dispatchScript, priority);
  });
}

/**
 * 定位活跃周期目录
 * @param {string} coin - 币种
 * @returns {string|null} 周期目录名，未找到则 null
 */
function findActiveCycle(coin) {
  try {
    const activeDir = path.join(WORKSPACE, 'active');
    const allPrefixes = ['alt-', 'zhuang-'];
    const existing = fs.readdirSync(activeDir)
      .filter(d => allPrefixes.some(p => d.startsWith(`${p}${coin}-`)))
      .sort()
      .reverse();
    return existing.length > 0 ? existing[0] : null;
  } catch (e) {
    log('WARN', `${coin} 周期查找失败`, { error: e.message });
    return null;
  }
}

/**
 * 降级：直接通过调度器派发 LLM 会话
 *
 * ⚠️ 必须先定位活跃周期；无周期则不派发，避免 LLM 自行创建重复周期
 */
function fallbackDirect(coin, triggerMsgs, state, dispatchScript, priority) {
  try {
    const cycleDir = findActiveCycle(coin);
    if (!cycleDir) {
      log('WARN', `${coin} 无活跃周期，跳过降级调度（避免创建重复周期）`);
      return;
    }

    const jobName = `alt-${coin}-${Date.now()}`;
    const message = `[market-watch 触发]

币种: ${coin}
周期目录: active/${cycleDir}
触发: ${triggerMsgs.join('; ')}
当前价格: ${state.current?.price || 'N/A'}
当前OI: ${state.current?.oi || 'N/A'}

请读取 tasks/pipeline/stage1.md 开始即时分析。`;

    spawn(process.execPath, [
      dispatchScript,
      '--priority', priority,
      '--source', 'market-watch',
      '--coin', coin,
      '--name', jobName,
      '--at', 'now',
      '--message', message,
    ], { detached: true, stdio: 'ignore' }).unref();

    log('INFO', `${coin} 已降级直连调度器: ${jobName} | 周期: ${cycleDir}`);
  } catch (e) {
    log('ERROR', `${coin} 降级调度也失败`, { error: e.message });
  }
}

module.exports = { dispatch };
