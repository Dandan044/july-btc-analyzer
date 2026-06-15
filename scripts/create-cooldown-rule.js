#!/usr/bin/env node
/**
 * create-cooldown-rule.js
 *
 * 为被监督者驳回的周期创建冷却计时器警报规则。
 * 替代原有的 nohup sleep 脆弱延迟触发机制。
 *
 * 用法:
 *   node scripts/create-cooldown-rule.js <COIN> <CYCLE_DIR> <DELAY_SEC> "<REASON>"
 *
 * 参数:
 *   COIN       - 币种代号 (e.g. BEAT)
 *   CYCLE_DIR  - 周期目录名 (e.g. alt-BEAT-20260608-0145)
 *   DELAY_SEC  - 延迟秒数 (1800/3600/7200)
 *   REASON     - 驳回原因 (用于规则描述和触发日志)
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = '/home/administrator/.openclaw/july-btc-analyzer';
const RULES_DIR = path.join(WORKSPACE, 'skills', 'btc-alert', 'rules');

const args = process.argv.slice(2);
if (args.length < 4) {
  console.error('用法: node create-cooldown-rule.js <COIN> <CYCLE_DIR> <DELAY_SEC> "<REASON>"');
  process.exit(1);
}

const [COIN, CYCLE_DIR, delaySecStr, reason] = args;
const DELAY_SEC = parseInt(delaySecStr, 10);
if (isNaN(DELAY_SEC) || DELAY_SEC <= 0) {
  console.error('DELAY_SEC 必须是正整数');
  process.exit(1);
}

const now = new Date();
const fireAt = new Date(now.getTime() + DELAY_SEC * 1000);
const fireAtMs = fireAt.getTime();
const reasonEscaped = reason.replace(/["\\]/g, '\\$&').replace(/\n/g, ' ');

// 生成唯一文件名
const timestamp = Date.now();
const filename = `${COIN}-cooldown-timer-${timestamp}.js`;
const filePath = path.join(RULES_DIR, filename);

// 提取 coin 代号用于 name 字段（处理带连字符的币名如 FARTCOIN）
const coinUpper = COIN.toUpperCase();

const ruleContent = `// ═══════════════════════════════════════════════
// 监督者驳回冷却计时器 — 自动生成
// ═══════════════════════════════════════════════
// 币种: ${COIN}
// 周期: ${CYCLE_DIR}
// 生成时间: ${now.toISOString()}
// 触发时间: ${fireAt.toISOString()}
// 延迟: ${DELAY_SEC}s (${Math.round(DELAY_SEC / 60)}min)
// 原因: ${reason}
// ═══════════════════════════════════════════════

const COIN = '${COIN}';
const CYCLE_ID = '${CYCLE_DIR}';
const FIRE_AT = ${fireAtMs};
const FIRE_AT_ISO = '${fireAt.toISOString()}';
const DELAY_SEC = ${DELAY_SEC};
const REASON = '${reasonEscaped}';
const WORKSPACE = '/home/administrator/.openclaw/july-btc-analyzer';

module.exports = {
  name: \`\${COIN}-CoolDown-\${DELAY_SEC}s\`,
  coin: COIN,
  ruleType: 'cooldown-timer',
  cycleId: CYCLE_ID,
  triggerLevel: 'notify',
  triggerPolicy: 'per-rule',
  description: \`监督者驳回冷却计时器 | 触发: \${FIRE_AT_ISO} | 原因: \${REASON}\`,

  check() {
    // 只有到达预定触发时间后才返回 true
    return Date.now() >= FIRE_AT;
  },

  collect() {
    const now = new Date();
    return {
      coin: COIN,
      cycleId: CYCLE_ID,
      triggerType: 'supervisor-cooldown-expired',
      firedAt: now.toISOString(),
      scheduledFireAt: FIRE_AT_ISO,
      delaySeconds: DELAY_SEC,
      actualDelaySeconds: Math.round((now.getTime() - (FIRE_AT - DELAY_SEC * 1000)) / 1000),
      reason: REASON
    };
  },

  trigger(alert) {
    const { execSync } = require('child_process');
    const path = require('path');
    const fs = require('fs');

    const retryData = {
      coin: COIN,
      alertName: 'supervisor-cooldown-timer',
      alertType: 'cooldown-timer',
      priority: 'high-2',
      cycleId: CYCLE_ID,
      reviewNotes: REASON,
      cooldownFiredAt: alert.firedAt
    };

    const tmpFile = \`/tmp/cooldown-\${COIN}-\${Date.now()}.json\`;
    fs.writeFileSync(tmpFile, JSON.stringify(retryData));

    try {
      const cmd = \`node "\${path.join(WORKSPACE, 'scripts', 'stage1-instant.js')}" "\$(cat \${tmpFile})"\`;
      execSync(cmd, { encoding: 'utf8', timeout: 120000, cwd: WORKSPACE });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  },

  lifetime() {
    // 始终 active，由 check() 控制触发时机。
    // 触发后引擎自动归档为 'triggered'。
    return 'active';
  }
};
`;

// 确保规则目录存在
fs.mkdirSync(RULES_DIR, { recursive: true });
fs.writeFileSync(filePath, ruleContent, 'utf8');

console.log(`✅ cooldown-timer 规则已创建: ${filename}`);
console.log(`   币种: ${COIN}`);
console.log(`   周期: ${CYCLE_DIR}`);
console.log(`   触发时间: ${fireAt.toISOString()} (${Math.round(DELAY_SEC / 60)}分钟后)`);
console.log(`   原因: ${reason}`);
