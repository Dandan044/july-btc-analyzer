# API 诉求列表

> 此文档记录规则创建过程中发现的需要封装到 `api.js` 的 API 需求。
> 定期审查后，将有价值的封装入 `skills/btc-market-lite/scripts/api.js`。
> 
> **规则**：禁止直接修改 api.js，所有诉求必须先记录在此。

---

## 已封装（历史诉求）

### [2026-05-09] OKX 资金费率 ✅ 已封装
- **需求**：获取指定币种的资金费率
- **API endpoint**：`GET /api/v5/public/funding-rate?instId={coin}-USDT-SWAP`
- **封装方法**：`api.getOKXFundingRate(symbol)`
- **状态**：已封装（2026-05-09）

### [2026-05-09] 合约统计方法支持山寨币 ✅ 已封装
- **需求**：getOKXOpenInterest / getOKXTakerRatio / getOKXLongShortRatio / getOKXTopTraderRatio 增加 symbol 参数
- **状态**：已封装（2026-05-09）

### [2026-05-09] Taker买卖比支持小时粒度 ✅ 已封装
- **需求**：现有 `getOKXTakerRatio()` 固定 `period=1D`，无法用于日内监控
- **封装方案**：增加 `period` 参数（默认 `1D`，可选 `5m`/`1H`/`1D`/`1W`/`1M`）+ `limit` 参数（默认 `7`）
- **日期格式自适应**：日级及以上用 `YYYY-MM-DD`，小时/分钟级用完整 ISO
- **规则**：`OP-taker-decline.js` 使用 `api.fetch()` + `period=1H` 直接获取小时级数据
- **状态**：已封装（2026-05-13）
