#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Get current cycle dir
const cycleDir = execSync('ls -td active/cycle-* 2>/dev/null | head -1', {encoding: 'utf8'}).trim();
const positionsFile = path.join(cycleDir, 'positions.json');

console.log('Syncing positions to:', positionsFile);

// Get isolated positions
const positionsData = execSync(
  '~/.openclaw/july-btc-analyzer/scripts/okx-proxy.sh --profile live account positions --instId BTC-USDT-SWAP --tdMode isolated 2>&1 | grep -v "Update available" | tail -n +4',
  {encoding: 'utf8'}
);
console.log('Positions raw:');
console.log(positionsData);

// Parse positions
const posLines = positionsData.trim().split('\n').filter(l => l.trim() && !l.includes('---'));
console.log('Pos lines:', posLines.length);

// Get algo orders
const algoData = execSync(
  '~/.openclaw/july-btc-analyzer/scripts/okx-proxy.sh --profile live swap algo orders --instId BTC-USDT-SWAP --tdMode isolated 2>&1 | grep -v "Update available" | tail -n +4',
  {encoding: 'utf8'}
);
console.log('Algo orders raw:');
console.log(algoData);

// Get balance
const balanceData = execSync(
  '~/.openclaw/july-btc-analyzer/scripts/okx-proxy.sh --profile live account balance USDT 2>&1 | grep -v "Update available" | tail -n +4',
  {encoding: 'utf8'}
);
console.log('Balance raw:');
console.log(balanceData);

// Parse equity
const equityMatch = balanceData.match(/USDT\s+([\d.]+)/);
const equity = equityMatch ? parseFloat(equityMatch[1]) : 0;
console.log('Equity:', equity);

console.log('\nSync complete - manual verification needed');
