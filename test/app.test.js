import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import request from 'supertest';
import { calculateTradePlan, createApp, createStorage, defaultWatchlist } from '../src/app.js';
import { evaluateLiquiditySweep, normalizeAutomationStatus, runAutomationCycle } from '../src/automation.js';

async function createTempStorage() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alpaca-strategy-lab-'));
  const storage = createStorage({ dataDir });
  await storage.ensureDataFiles();
  return storage;
}

function createMockAlpaca() {
  const submittedOrders = [];
  const candidateBars = [
    { Timestamp: '2026-01-01T09:30:00Z', OpenPrice: 100, HighPrice: 101, LowPrice: 99.5, ClosePrice: 100.4, Volume: 1000 },
    { Timestamp: '2026-01-01T09:35:00Z', OpenPrice: 100.5, HighPrice: 101.1, LowPrice: 99.8, ClosePrice: 100.8, Volume: 1000 },
    { Timestamp: '2026-01-01T09:40:00Z', OpenPrice: 100.7, HighPrice: 101.2, LowPrice: 99.9, ClosePrice: 100.9, Volume: 1000 },
    { Timestamp: '2026-01-01T09:45:00Z', OpenPrice: 100.6, HighPrice: 101.3, LowPrice: 99.7, ClosePrice: 101.0, Volume: 1000 },
    { Timestamp: '2026-01-01T09:50:00Z', OpenPrice: 100.8, HighPrice: 101.4, LowPrice: 99.6, ClosePrice: 101.1, Volume: 1000 },
    { Timestamp: '2026-01-01T09:55:00Z', OpenPrice: 100.1, HighPrice: 101.2, LowPrice: 99.2, ClosePrice: 101.15, Volume: 1000 },
    { Timestamp: '2026-01-01T10:00:00Z', OpenPrice: 100.9, HighPrice: 101.6, LowPrice: 99.1, ClosePrice: 101.4, Volume: 1000 },
  ];
  const blockedBars = [
    { Timestamp: '2026-01-01T09:30:00Z', OpenPrice: 100, HighPrice: 101, LowPrice: 99.6, ClosePrice: 100.4, Volume: 1000 },
    { Timestamp: '2026-01-01T09:35:00Z', OpenPrice: 100.3, HighPrice: 100.9, LowPrice: 99.8, ClosePrice: 100.5, Volume: 1000 },
    { Timestamp: '2026-01-01T09:40:00Z', OpenPrice: 100.4, HighPrice: 100.8, LowPrice: 99.9, ClosePrice: 100.2, Volume: 1000 },
    { Timestamp: '2026-01-01T09:45:00Z', OpenPrice: 100.1, HighPrice: 100.7, LowPrice: 99.7, ClosePrice: 100.0, Volume: 1000 },
    { Timestamp: '2026-01-01T09:50:00Z', OpenPrice: 100.0, HighPrice: 100.6, LowPrice: 99.8, ClosePrice: 100.1, Volume: 1000 },
    { Timestamp: '2026-01-01T09:55:00Z', OpenPrice: 100.1, HighPrice: 100.5, LowPrice: 99.9, ClosePrice: 100.0, Volume: 1000 },
    { Timestamp: '2026-01-01T10:00:00Z', OpenPrice: 100.0, HighPrice: 100.4, LowPrice: 99.95, ClosePrice: 100.05, Volume: 1000 },
  ];

  return {
    submittedOrders,
    client: {
      async getAccount() {
        return { equity: '10000', buying_power: '20000', status: 'ACTIVE', pattern_day_trader: false };
      },
      async getPositions() {
        return [];
      },
      async getOrders() {
        return [];
      },
      async getLatestQuote(symbol) {
        return { BidPrice: 99.5, AskPrice: 100.5, Timestamp: `2026-01-01T00:00:00Z-${symbol}` };
      },
      async getLatestTrade() {
        return { Price: 100, Timestamp: '2026-01-01T00:00:00Z' };
      },
      async getLatestQuotes(symbols) {
        return new Map(symbols.map((symbol) => [symbol, { BidPrice: 99.5, AskPrice: 100.5, Timestamp: `2026-01-01T00:00:00Z-${symbol}` }]));
      },
      async getLatestTrades(symbols) {
        return new Map(symbols.map((symbol) => [symbol, { Price: 100, Timestamp: `2026-01-01T00:00:00Z-${symbol}` }]));
      },
      async createOrder(payload) {
        submittedOrders.push(payload);
        return { id: 'paper-order-1', ...payload };
      },
      newTimeframe(amount, unit) {
        return { amount, unit };
      },
      timeframeUnit: { MIN: 'Min', HOUR: 'Hour' },
      getBarsV2(symbol) {
        const bars = symbol === 'AAPL' ? candidateBars : blockedBars;
        return (async function* generator() {
          for (const bar of bars) yield bar;
        }());
      },
      async getMultiBarsV2(symbols) {
        return new Map(symbols.map((symbol) => [symbol, symbol === 'AAPL' ? candidateBars : blockedBars]));
      },
    },
  };
}

test('GET / renders with default watchlist and creates isolated data files', async () => {
  const storage = await createTempStorage();
  const app = createApp({ storage, createAlpacaClient: () => null, startAutomation: false });

  const response = await request(app).get('/');

  assert.equal(response.status, 200);
  assert.match(response.text, /No API creds yet/);
  assert.match(response.text, /Automation controls/);
  const settings = JSON.parse(await fs.readFile(storage.settingsPath, 'utf8'));
  assert.deepEqual(settings.watchlist, defaultWatchlist);
  assert.equal(settings.automation.enabled, false);
  assert.equal(settings.automation.timeframe, '15Min');
  assert.deepEqual(JSON.parse(await fs.readFile(storage.journalPath, 'utf8')), []);
  assert.deepEqual(JSON.parse(await fs.readFile(storage.automationStatusPath, 'utf8')), normalizeAutomationStatus());
});

test('POST /watchlist normalizes, deduplicates, and persists symbols', async () => {
  const storage = await createTempStorage();
  const app = createApp({ storage, createAlpacaClient: () => null, startAutomation: false });

  const response = await request(app)
    .post('/watchlist')
    .type('form')
    .send({ watchlist: ' spy, qqq,SPY, nvda ' });

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/?success=Watchlist%20updated');
  const settings = JSON.parse(await fs.readFile(storage.settingsPath, 'utf8'));
  assert.deepEqual(settings.watchlist, ['SPY', 'QQQ', 'NVDA']);
  assert.equal(settings.automation.enabled, false);
});

test('POST /watchlist accepts expanded diversified lists up to 30 symbols', async () => {
  const storage = await createTempStorage();
  const app = createApp({ storage, createAlpacaClient: () => null, startAutomation: false });
  const symbols = Array.from({ length: 32 }, (_, index) => `SYM${index + 1}`);

  const response = await request(app)
    .post('/watchlist')
    .type('form')
    .send({ watchlist: symbols.join(', ') });

  assert.equal(response.status, 302);
  const settings = JSON.parse(await fs.readFile(storage.settingsPath, 'utf8'));
  assert.equal(settings.watchlist.length, 30);
  assert.deepEqual(settings.watchlist.slice(0, 3), ['SYM1', 'SYM2', 'SYM3']);
  assert.deepEqual(settings.watchlist.slice(-2), ['SYM29', 'SYM30']);
});

test('POST /automation/settings persists guardrails and toggles', async () => {
  const storage = await createTempStorage();
  const app = createApp({ storage, createAlpacaClient: () => null, startAutomation: false });

  const response = await request(app)
    .post('/automation/settings')
    .type('form')
    .send({
      enabled: '1',
      autoSubmit: '',
      pollIntervalSeconds: '180',
      timeframe: '15Min',
      lookbackBars: '24',
      signalWindowBars: '3',
      minSweepPercent: '0.15',
      etfMinSweepPercent: '0.1',
      minBodyToRangeRatio: '0.5',
      confirmationBodyToRangeRatio: '0.2',
      rewardToRisk: '2.5',
      maxOpenPositions: '2',
      maxConcurrentOrdersPerSymbol: '1',
      maxWatchlistSymbols: '18',
      symbolsPerCycle: '6',
      rotateWatchlist: '1',
      riskPerTrade: '75',
      stopBufferPercent: '0.2',
      takeProfitBufferPercent: '0',
      minimumPrice: '10',
      maximumPrice: '500',
    });

  assert.equal(response.status, 302);
  const settings = JSON.parse(await fs.readFile(storage.settingsPath, 'utf8'));
  assert.equal(settings.automation.enabled, true);
  assert.equal(settings.automation.autoSubmit, false);
  assert.equal(settings.automation.rotateWatchlist, true);
  assert.equal(settings.automation.timeframe, '15Min');
  assert.equal(settings.automation.signalWindowBars, 3);
  assert.equal(settings.automation.etfMinSweepPercent, 0.1);
  assert.equal(settings.automation.confirmationBodyToRangeRatio, 0.2);
  assert.equal(settings.automation.maxWatchlistSymbols, 18);
  assert.equal(settings.automation.symbolsPerCycle, 6);
  assert.equal(settings.automation.riskPerTrade, 75);
});

test('POST /journal validates and stores a journal entry with planning fields', async () => {
  const storage = await createTempStorage();
  const app = createApp({ storage, createAlpacaClient: () => null, startAutomation: false });

  const response = await request(app)
    .post('/journal')
    .type('form')
    .send({
      symbol: 'AAPL',
      side: 'buy',
      thesis: 'Sweep of lows and reclaim into displacement candle',
      liquidityLevel: 'Equal lows',
      displacementSeen: 'Strong reclaim',
      structureShiftSeen: '5m MSS',
      entryPrice: '190.50',
      stopPrice: '189.50',
      targetPrice: '194.00',
      riskAmount: '50',
      plannedQty: '20',
      checklistScore: '5',
      status: 'planned',
      notes: 'Test note',
    });

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/?success=Journal%20entry%20saved');

  const journal = JSON.parse(await fs.readFile(storage.journalPath, 'utf8'));
  assert.equal(journal.length, 1);
  assert.equal(journal[0].symbol, 'AAPL');
  assert.equal(journal[0].checklistScore, 5);
  assert.equal(journal[0].entryPrice, 190.5);
  assert.equal(journal[0].plannedQty, 20);
});

test('POST /journal rejects invalid buy structure', async () => {
  const storage = await createTempStorage();
  const app = createApp({ storage, createAlpacaClient: () => null, startAutomation: false });

  const response = await request(app)
    .post('/journal')
    .type('form')
    .send({
      symbol: 'AAPL',
      side: 'buy',
      thesis: 'Sweep and reclaim',
      liquidityLevel: 'Equal lows',
      entryPrice: '190',
      stopPrice: '191',
      targetPrice: '194',
      checklistScore: '4',
      status: 'planned',
    });

  assert.equal(response.status, 302);
  assert.match(response.headers.location, /stop%20must%20stay%20below%20entry/i);
});

test('POST /journal/:id/review updates realized outcome', async () => {
  const storage = await createTempStorage();
  await storage.saveJournal([{
    id: 'entry-1',
    createdAt: new Date().toISOString(),
    symbol: 'AAPL',
    side: 'buy',
    thesis: 'Sweep of lows and reclaim into displacement candle',
    liquidityLevel: 'Equal lows',
    entryPrice: 190,
    stopPrice: 189,
    targetPrice: 194,
    checklistScore: 5,
    status: 'open',
  }]);
  const app = createApp({ storage, createAlpacaClient: () => null, startAutomation: false });

  const response = await request(app)
    .post('/journal/entry-1/review')
    .type('form')
    .send({ status: 'won', realizedR: '2.5', outcomeNotes: 'Held runner into target.' });

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/?success=Journal%20review%20updated');

  const journal = JSON.parse(await fs.readFile(storage.journalPath, 'utf8'));
  assert.equal(journal[0].status, 'won');
  assert.equal(journal[0].realizedR, 2.5);
  assert.equal(journal[0].outcomeNotes, 'Held runner into target.');
});

test('planner helper returns rounded trade sizing', () => {
  const result = calculateTradePlan({ side: 'buy', entryPrice: 100, stopPrice: 98, targetPrice: 106, riskAmount: 55 });

  assert.deepEqual(result, {
    qty: 27,
    riskPerShare: 2,
    rewardPerShare: 6,
    notional: 2700,
    totalRisk: 54,
    totalReward: 162,
    rewardToRisk: 3,
  });
});

test('evaluateLiquiditySweep returns a buy candidate when a recent sweep confirms a bar later', () => {
  const result = evaluateLiquiditySweep({
    symbol: 'AAPL',
    settings: {
      timeframe: '15Min',
      lookbackBars: 8,
      signalWindowBars: 3,
      minSweepPercent: 0.05,
      etfMinSweepPercent: 0.02,
      minBodyToRangeRatio: 0.2,
      confirmationBodyToRangeRatio: 0.15,
      riskPerTrade: 50,
      rewardToRisk: 2,
      stopBufferPercent: 0.1,
      takeProfitBufferPercent: 0,
      minimumPrice: 5,
      maximumPrice: 1000,
    },
    bars: [
      { open: 100, high: 101, low: 99.6, close: 100.5 },
      { open: 100.4, high: 101.1, low: 99.7, close: 100.7 },
      { open: 100.7, high: 101.0, low: 99.8, close: 100.6 },
      { open: 100.5, high: 101.2, low: 99.5, close: 100.9 },
      { open: 100.9, high: 101.3, low: 99.4, close: 100.8 },
      { timestamp: '2026-01-01T09:55:00Z', open: 100.7, high: 101.0, low: 99.2, close: 99.95 },
      { timestamp: '2026-01-01T10:00:00Z', open: 99.95, high: 101.4, low: 99.5, close: 101.2 },
      { timestamp: '2026-01-01T10:15:00Z', open: 101.1, high: 101.5, low: 100.8, close: 101.35 },
    ],
  });

  assert.equal(result.status, 'candidate');
  assert.equal(result.side, 'buy');
  assert.equal(result.entryPrice, 101.2);
  assert.equal(result.metrics.barsSinceSignal, 1);
  assert.ok(result.qty > 0);
});

test('evaluateLiquiditySweep returns near-miss when a recent sweep lacks confirmation', () => {
  const result = evaluateLiquiditySweep({
    symbol: 'QQQ',
    settings: {
      timeframe: '15Min',
      lookbackBars: 8,
      signalWindowBars: 3,
      minSweepPercent: 0.05,
      etfMinSweepPercent: 0.02,
      minBodyToRangeRatio: 0.2,
      confirmationBodyToRangeRatio: 0.15,
      riskPerTrade: 50,
      rewardToRisk: 2,
      stopBufferPercent: 0.1,
      takeProfitBufferPercent: 0,
      minimumPrice: 5,
      maximumPrice: 1000,
    },
    bars: [
      { open: 100, high: 101, low: 99.7, close: 100.5 },
      { open: 100.4, high: 101.1, low: 99.8, close: 100.7 },
      { open: 100.7, high: 101.0, low: 99.9, close: 100.6 },
      { open: 100.5, high: 101.2, low: 99.6, close: 100.9 },
      { open: 100.9, high: 101.3, low: 99.5, close: 100.8 },
      { timestamp: '2026-01-01T09:55:00Z', open: 100.7, high: 100.95, low: 99.2, close: 99.85 },
      { timestamp: '2026-01-01T10:00:00Z', open: 99.9, high: 100.2, low: 99.6, close: 99.95 },
      { timestamp: '2026-01-01T10:15:00Z', open: 99.95, high: 100.1, low: 99.7, close: 99.9 },
    ],
  });

  assert.equal(result.status, 'near-miss');
  assert.match(result.reason, /lacked a strong reclaim close/i);
});

test('evaluateLiquiditySweep returns near-miss when sweep confirms but displacement stays borderline', () => {
  const result = evaluateLiquiditySweep({
    symbol: 'AAPL',
    settings: {
      timeframe: '15Min',
      lookbackBars: 8,
      signalWindowBars: 2,
      minSweepPercent: 0.05,
      etfMinSweepPercent: 0.02,
      minBodyToRangeRatio: 0.2,
      confirmationBodyToRangeRatio: 0.15,
      riskPerTrade: 50,
      rewardToRisk: 2,
      stopBufferPercent: 0.1,
      takeProfitBufferPercent: 0,
      minimumPrice: 5,
      maximumPrice: 1000,
    },
    bars: [
      { open: 100, high: 101, low: 99.6, close: 100.5 },
      { open: 100.4, high: 101.1, low: 99.7, close: 100.7 },
      { open: 100.7, high: 101.0, low: 99.8, close: 100.6 },
      { open: 100.5, high: 101.2, low: 99.5, close: 100.9 },
      { open: 100.9, high: 101.3, low: 99.4, close: 100.8 },
      { timestamp: '2026-01-01T09:55:00Z', open: 100.4, high: 100.6, low: 99.2, close: 99.35 },
      { timestamp: '2026-01-01T10:00:00Z', open: 99.32, high: 99.95, low: 99.15, close: 99.18 },
      { timestamp: '2026-01-01T10:15:00Z', open: 99.18, high: 99.98, low: 99.18, close: 99.33 },
    ],
  });

  assert.equal(result.status, 'near-miss');
  assert.match(result.reason, /displacement stayed below 0\.200/i);
  assert.equal(result.metrics.confirmationBodyRatio, 0.187);
});

test('POST /order rejects missing limit price for limit orders', async () => {
  const storage = await createTempStorage();
  const mock = createMockAlpaca();
  const app = createApp({ storage, createAlpacaClient: () => mock.client, startAutomation: false });

  const response = await request(app)
    .post('/order')
    .type('form')
    .send({ symbol: 'AAPL', side: 'buy', qty: '1', type: 'limit', limitPrice: '', timeInForce: 'day' });

  assert.equal(response.status, 302);
  assert.match(response.headers.location, /Limit%20price%20is%20required/);
  assert.equal(mock.submittedOrders.length, 0);
});

test('POST /order submits normalized paper order payload', async () => {
  const storage = await createTempStorage();
  const mock = createMockAlpaca();
  const app = createApp({ storage, createAlpacaClient: () => mock.client, startAutomation: false });

  const response = await request(app)
    .post('/order')
    .type('form')
    .send({ symbol: 'aapl', side: 'sell', qty: '3', type: 'market', timeInForce: 'gtc' });

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/?success=Paper%20order%20submitted');
  assert.deepEqual(mock.submittedOrders, [{ symbol: 'AAPL', side: 'sell', qty: 3, type: 'market', time_in_force: 'gtc' }]);
});

test('POST /order supports bracket payloads', async () => {
  const storage = await createTempStorage();
  const mock = createMockAlpaca();
  const app = createApp({ storage, createAlpacaClient: () => mock.client, startAutomation: false });

  const response = await request(app)
    .post('/order')
    .type('form')
    .send({
      symbol: 'nvda',
      side: 'buy',
      qty: '2',
      type: 'limit',
      limitPrice: '800',
      timeInForce: 'day',
      useBracket: '1',
      takeProfitPrice: '820',
      stopLossPrice: '790',
    });

  assert.equal(response.status, 302);
  assert.equal(mock.submittedOrders.length, 1);
  assert.deepEqual(mock.submittedOrders[0], {
    symbol: 'NVDA',
    side: 'buy',
    qty: 2,
    type: 'limit',
    time_in_force: 'day',
    limit_price: 800,
    order_class: 'bracket',
    take_profit: { limit_price: 820 },
    stop_loss: { stop_price: 790 },
  });
});

test('runAutomationCycle can auto-submit a paper candidate and persist status', async () => {
  const storage = await createTempStorage();
  const mock = createMockAlpaca();
  await storage.saveSettings({
    watchlist: ['AAPL'],
    automation: {
      enabled: true,
      autoSubmit: true,
      pollIntervalSeconds: 300,
      timeframe: '5Min',
      lookbackBars: 6,
      signalWindowBars: 2,
      minSweepPercent: 0.05,
      etfMinSweepPercent: 0.02,
      minBodyToRangeRatio: 0.15,
      confirmationBodyToRangeRatio: 0.15,
      rewardToRisk: 2,
      maxOpenPositions: 3,
      maxConcurrentOrdersPerSymbol: 1,
      maxWatchlistSymbols: 1,
      symbolsPerCycle: 1,
      rotateWatchlist: true,
      riskPerTrade: 50,
      stopBufferPercent: 0.1,
      takeProfitBufferPercent: 0,
      minimumPrice: 5,
      maximumPrice: 1000,
    },
  });

  const result = await runAutomationCycle({ storage, createAlpacaClient: () => mock.client });

  assert.equal(result.ok, true);
  assert.equal(result.candidates.length, 1);
  assert.equal(mock.submittedOrders.length, 1);
  const status = JSON.parse(await fs.readFile(storage.automationStatusPath, 'utf8'));
  assert.match(status.lastSummary, /produced 1 submitted order/);
});

test('runAutomationCycle rotates watchlist chunks and skips unchanged bars on revisit', async () => {
  const storage = await createTempStorage();
  const mock = createMockAlpaca();
  await storage.saveSettings({
    watchlist: ['AAPL', 'MSFT', 'NVDA'],
    automation: {
      enabled: true,
      autoSubmit: false,
      pollIntervalSeconds: 600,
      timeframe: '5Min',
      lookbackBars: 6,
      signalWindowBars: 2,
      minSweepPercent: 0.04,
      etfMinSweepPercent: 0.02,
      minBodyToRangeRatio: 0.15,
      confirmationBodyToRangeRatio: 0.15,
      rewardToRisk: 1.8,
      maxOpenPositions: 3,
      maxConcurrentOrdersPerSymbol: 1,
      maxWatchlistSymbols: 3,
      symbolsPerCycle: 1,
      rotateWatchlist: true,
      riskPerTrade: 50,
      stopBufferPercent: 0.1,
      takeProfitBufferPercent: 0,
      minimumPrice: 5,
      maximumPrice: 1000,
    },
  });

  const first = await runAutomationCycle({ storage, createAlpacaClient: () => mock.client });
  const second = await runAutomationCycle({ storage, createAlpacaClient: () => mock.client });
  const third = await runAutomationCycle({ storage, createAlpacaClient: () => mock.client });
  const fourth = await runAutomationCycle({ storage, createAlpacaClient: () => mock.client });

  assert.match(first.status.lastSummary, /Scanned 1\/3 symbols/);
  assert.match(second.status.lastSummary, /Scanned 1\/3 symbols/);
  assert.match(third.status.lastSummary, /Scanned 1\/3 symbols/);
  assert.ok(fourth.status.activity.some((item) => item.type === 'deferred' && /Rotation active\. Scanning 1\/3 symbols this cycle, deferred 2\./.test(item.detail)));
  assert.ok(fourth.status.activity.some((item) => item.type === 'deferred' && /unchanged since last scan/i.test(item.detail)));
});

test('GET / renders connected account data when Alpaca client is available', async () => {
  const storage = await createTempStorage();
  const mock = createMockAlpaca();
  const app = createApp({ storage, createAlpacaClient: () => mock.client, startAutomation: false });

  const response = await request(app).get('/');

  assert.equal(response.status, 200);
  assert.match(response.text, /Paper account connected/);
  assert.match(response.text, /Workflow state/);
  assert.match(response.text, /Automation activity log/);
  assert.match(response.text, /\$10000\.00/);
  assert.match(response.text, /AAPL/);
  assert.match(response.text, /VXUS/);
});
