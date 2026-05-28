#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');
const instId = process.argv[2] || 'BTC-USDT';
const step = parseFloat(process.argv[3]) || 100;
const layers = parseInt(process.argv[4]) || 10;

// Get full order book
const raw = execSync(
  `${path.join(__dirname, 'okx-proxy.sh')} market orderbook ${instId} --sz 400 --json 2>/dev/null`,
  { encoding: 'utf8', timeout: 20000 }
);

// Strip any non-JSON prefix (like "Update available" text)
const jsonStart = raw.indexOf('[');
const jsonEnd = raw.lastIndexOf(']');
const jsonStr = jsonStart >= 0 ? raw.slice(jsonStart, jsonEnd + 1) : raw;

const parsed = JSON.parse(jsonStr);
const book = Array.isArray(parsed) ? parsed[0] : parsed;

if (!book || !book.asks || !book.bids) {
  console.error('Failed to parse order book data');
  process.exit(1);
}

// Helper: get mid price from spread
function getMid(asks, bids) {
  const bestAsk = parseFloat(asks[0]?.[0] || 0);
  const bestBid = parseFloat(bids[0]?.[0] || 0);
  return (bestAsk + bestBid) / 2;
}

const mid = getMid(book.asks, book.bids);
const midBucket = Math.round(mid / step) * step;

function aggregate(sideEntries, fromBucket, toBucket, isAsk) {
  const buckets = {};
  for (const entry of sideEntries) {
    const price = parseFloat(entry[0]);
    const size = parseFloat(entry[1]);
    const orders = parseInt(entry[3]);
    const bucket = Math.round(price / step) * step;
    if (isAsk ? bucket >= fromBucket && bucket <= toBucket : bucket <= fromBucket && bucket >= toBucket) {
      if (!buckets[bucket]) buckets[bucket] = { price: bucket, totalSize: 0, totalOrders: 0, totalValue: 0 };
      buckets[bucket].totalSize += size;
      buckets[bucket].totalOrders += orders;
      buckets[bucket].totalValue += price * size;
    }
  }
  return Object.values(buckets).sort((a, b) => isAsk ? a.price - b.price : b.price - a.price);
}

const askBuckets = aggregate(book.asks, midBucket, midBucket + layers * step, true);
const bidBuckets = aggregate(book.bids, midBucket, midBucket - layers * step, false);

console.log(`\n📊 ${instId} 订单簿聚合 ${step}USDT 步长 | 当前价: $${mid.toFixed(1)}`);
console.log('━'.repeat(74));

console.log('\n🔴 卖盘 (Asks)');
console.log(` ${'价格区间'.padStart(12)}  ${'数量(BTC)'.padStart(10)}  ${'价值(USDT)'.padStart(14)}  挂单数`);
console.log('─'.repeat(54));
for (const b of askBuckets) {
  console.log(` $${String(b.price).padStart(8)}  ${b.totalSize.toFixed(4).padStart(10)}  $${b.totalValue.toFixed(0).padStart(12)}  ${b.totalOrders}`);
}

console.log('\n🟢 买盘 (Bids)');
console.log(` ${'价格区间'.padStart(12)}  ${'数量(BTC)'.padStart(10)}  ${'价值(USDT)'.padStart(14)}  挂单数`);
console.log('─'.repeat(54));
for (const b of bidBuckets) {
  console.log(` $${String(b.price).padStart(8)}  ${b.totalSize.toFixed(4).padStart(10)}  $${b.totalValue.toFixed(0).padStart(12)}  ${b.totalOrders}`);
}

// Summary
console.log('\n📌 聚合统计');
const totalAskValue = askBuckets.reduce((s, b) => s + b.totalValue, 0);
const totalBidValue = bidBuckets.reduce((s, b) => s + b.totalValue, 0);
console.log(`   卖盘总价值 (上${layers}层): $${totalAskValue.toFixed(0)}`);
console.log(`   买盘总价值 (下${layers}层): $${totalBidValue.toFixed(0)}`);
console.log(`   卖/买比: ${(totalAskValue / totalBidValue).toFixed(2)}`);
