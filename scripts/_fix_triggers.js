const fs = require('fs');
let c = fs.readFileSync('scripts/stage4-executor.js', 'utf8');

// Find the two trigger() function boundaries
// They share the same structure, let's find by the spawn('openclaw' pattern

const triggerStart = '  async trigger(data) {';
const triggerEnd1 = '  },\n\n  lifetime()';

let parts = [];
let lastIdx = 0;
let count = 0;

while (true) {
  let startIdx = c.indexOf(triggerStart, lastIdx);
  if (startIdx === -1) break;
  
  let endIdx = c.indexOf(triggerEnd1, startIdx);
  if (endIdx === -1) {
    // Try alternate ending (non-price trigger ends at different spot)
    endIdx = c.indexOf('  },\n\n  lifetime()', startIdx);
    if (endIdx === -1) break;
  }
  
  parts.push({
    start: startIdx,
    end: endIdx + triggerEnd1.length,
    content: c.substring(startIdx, endIdx + triggerEnd1.length)
  });
  
  console.log(`Trigger #${++count}: bytes ${startIdx}-${endIdx + triggerEnd1.length}`);
  lastIdx = endIdx + triggerEnd1.length;
}

if (parts.length >= 1) {
  // Replace first trigger (price-level)
  const newPriceTrigger = `  async trigger(data) {
    // 调用 stage1-instant.js 采集即时数据 + 自动派发阶段二分析
    const scriptPath = path.resolve(__dirname, '..', '..', '..', 'scripts', 'stage1-instant.js');
    const json = JSON.stringify(data);
    try {
      execSync(\`node "\${scriptPath}" '\${json.replace(/'/g, "'\\\\\\\\''")}' 2>/dev/null\`, {
        timeout: 35000, stdio: 'pipe'
      });
      console.log(\`[🔔警报触发] \${this.name} | 即时数据采集完成 → 阶段二已派发\`);
    } catch (e) {
      console.error(\`[❌警报触发失败] \${e.message}\`);
    }

    this.lastTriggered = Date.now();
    this.currentTriggeredLevels = [];
    this.levelStates = {};
    this.breakoutExtremes = {};
  },

  lifetime()`;
  
  c = c.substring(0, parts[0].start) + newPriceTrigger + c.substring(parts[0].end);
  console.log('Price-level trigger replaced');
}

// Re-find for second trigger (offset shifted)
let startIdx2 = c.indexOf(triggerStart, parts[0] ? parts[0].start + 100 : 0);
if (startIdx2 >= 0) {
  let endIdx2 = c.indexOf(triggerEnd1, startIdx2);
  if (endIdx2 === -1) endIdx2 = c.indexOf('  },\n\n  lifetime()', startIdx2);
  if (endIdx2 >= 0) {
    const newNonPriceTrigger = `  async trigger(data) {
    // 调用 stage1-instant.js 采集即时数据 + 自动派发阶段二分析
    const scriptPath = path.resolve(__dirname, '..', '..', '..', 'scripts', 'stage1-instant.js');
    const json = JSON.stringify(data);
    try {
      execSync(\`node "\${scriptPath}" '\${json.replace(/'/g, "'\\\\\\\\''")}' 2>/dev/null\`, {
        timeout: 35000, stdio: 'pipe'
      });
      console.log(\`[🔔警报触发] \${this.name} | 即时数据采集完成 → 阶段二已派发\`);
    } catch (e) {
      console.error(\`[❌警报触发失败] \${e.message}\`);
    }

    this.lastTriggered = Date.now();
  },

  lifetime()`;
    
    c = c.substring(0, startIdx2) + newNonPriceTrigger + c.substring(endIdx2 + triggerEnd1.length);
    console.log('Non-price trigger replaced');
  }
}

// Update requires
c = c.replace(
  "const api = require('../../btc-market-lite/scripts/api');\nconst { spawn } = require('child_process');\n\nconst COIN = '${COIN}';\nconst COOLDOWN_MS = 60 * 60 * 1000;",
  "const api = require('../../btc-market-lite/scripts/api');\nconst { spawn, execSync } = require('child_process');\nconst path = require('path');\n\nconst COIN = '${COIN}';\nconst COOLDOWN_MS = 60 * 60 * 1000;"
);

fs.writeFileSync('scripts/stage4-executor.js', c);
console.log('Done');
