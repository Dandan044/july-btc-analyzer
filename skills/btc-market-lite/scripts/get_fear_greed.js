#!/usr/bin/env node
/**
 * 获取恐惧贪婪指数
 * 数据源: alternative.me
 * 
 * 用法: node get_fear_greed.js [--days=30] [--json]
 */

const https = require('https');

function fetch(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); } 
          catch (e) { reject(new Error('JSON解析失败')); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.end();
  });
}

async function getFearGreed(days = 30) {
  const data = await fetch(`https://api.alternative.me/fng/?limit=${days}`);
  const items = data.data;
  
  const current = parseInt(items[0].value);
  const avg7 = items.slice(0, 7).reduce((s, d) => s + parseInt(d.value), 0) / 7;
  const avg30 = items.slice(0, Math.min(30, items.length)).reduce((s, d) => s + parseInt(d.value), 0) / Math.min(30, items.length);
  
  return {
    current,
    classification: items[0].value_classification,
    avg7: parseFloat(avg7.toFixed(1)),
    avg30: parseFloat(avg30.toFixed(1)),
    trend: current > avg7 ? '上升' : current < avg7 ? '下降' : '稳定',
    weekAgo: items[6] ? { value: parseInt(items[6].value), class: items[6].value_classification } : null,
    monthAgo: items[29] ? { value: parseInt(items[29].value), class: items[29].value_classification } : null,
    history: items.map(d => ({ value: parseInt(d.value), date: new Date(parseInt(d.timestamp) * 1000).toISOString().split('T')[0] }))
  };
}

async function main() {
  try {
    const args = process.argv.slice(2);
    const daysIndex = args.indexOf('--days');
    const days = daysIndex >= 0 ? parseInt(args[daysIndex + 1]) || 30 : 30;
    const json = args.includes('--json');
    
    const result = await getFearGreed(days);
    
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const emoji = result.current <= 25 ? '😱' : result.current <= 45 ? '😰' : result.current <= 55 ? '😐' : result.current <= 75 ? '😊' : '🤑';
      console.log(`${emoji} 恐惧贪婪指数: ${result.current} (${result.classification})`);
      console.log(`7日均值: ${result.avg7} | 30日均值: ${result.avg30}`);
      console.log(`趋势: ${result.trend}`);
    }
  } catch (e) {
    console.error('错误:', e.message);
    process.exit(1);
  }
}

module.exports = { getFearGreed };

if (require.main === module) {
  main();
}