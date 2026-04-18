import fs from 'fs/promises';

const automationDefaults = {
  enabled: false,
  autoSubmit: false,
  pollIntervalSeconds: 300,
  timeframe: '5Min',
  lookbackBars: 20,
  minSweepPercent: 0.05,
  minBodyToRangeRatio: 0.4,
  rewardToRisk: 2,
  maxOpenPositions: 3,
  maxConcurrentOrdersPerSymbol: 1,
  watchlistScope: 'watchlist',
  maxWatchlistSymbols: 30,
  riskPerTrade: 50,
  stopBufferPercent: 0.1,
  takeProfitBufferPercent: 0,
  minimumPrice: 5,
  maximumPrice: 1000,
};

const automationStatusDefaults = {
  lastRunAt: null,
  lastRunStartedAt: null,
  lastHeartbeatAt: null,
  lastError: null,
  lastSummary: 'Automation has not run yet.',
  runCount: 0,
  candidates: [],
  activity: [],
};

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function normalizeTimeframe(timeframe, alpaca) {
  if (!timeframe || timeframe === '5Min') return alpaca.newTimeframe(5, alpaca.timeframeUnit.MIN);
  if (timeframe === '15Min') return alpaca.newTimeframe(15, alpaca.timeframeUnit.MIN);
  if (timeframe === '1Hour') return alpaca.newTimeframe(1, alpaca.timeframeUnit.HOUR);
  throw new Error(`Unsupported timeframe: ${timeframe}`);
}

async function collectBars(alpaca, symbol, timeframe, limit) {
  const bars = [];
  const iterator = alpaca.getBarsV2(symbol, {
    start: new Date(Date.now() - (limit + 5) * 60 * 60 * 1000).toISOString(),
    end: new Date().toISOString(),
    timeframe: normalizeTimeframe(timeframe, alpaca),
    feed: 'iex',
    limit,
  });

  for await (const bar of iterator) {
    bars.push({
      timestamp: bar.Timestamp,
      open: Number(bar.OpenPrice),
      high: Number(bar.HighPrice),
      low: Number(bar.LowPrice),
      close: Number(bar.ClosePrice),
      volume: Number(bar.Volume ?? 0),
    });
  }

  return bars;
}

function evaluateLiquiditySweep({ symbol, bars, settings }) {
  if (!Array.isArray(bars) || bars.length < Math.max(6, settings.lookbackBars)) {
    return { status: 'skipped', symbol, reason: 'Not enough bars yet.' };
  }

  const recent = bars.slice(-settings.lookbackBars);
  const triggerBar = recent[recent.length - 1];
  const previousBars = recent.slice(0, -1);
  const swingHigh = Math.max(...previousBars.map((bar) => bar.high));
  const swingLow = Math.min(...previousBars.map((bar) => bar.low));
  const range = triggerBar.high - triggerBar.low;
  const body = Math.abs(triggerBar.close - triggerBar.open);
  const bodyRatio = range > 0 ? body / range : 0;
  const minSweepDistance = triggerBar.close * (settings.minSweepPercent / 100);

  if (triggerBar.close < settings.minimumPrice || triggerBar.close > settings.maximumPrice) {
    return { status: 'blocked', symbol, reason: `Price ${round(triggerBar.close, 2)} outside configured range.` };
  }

  if (bodyRatio < settings.minBodyToRangeRatio) {
    return {
      status: 'blocked',
      symbol,
      reason: `Displacement too weak. Body/range ${round(bodyRatio, 2)} below ${settings.minBodyToRangeRatio}.`,
      metrics: { bodyRatio: round(bodyRatio, 2), swingHigh: round(swingHigh, 2), swingLow: round(swingLow, 2) },
    };
  }

  const buySweepDistance = swingLow - triggerBar.low;
  const sellSweepDistance = triggerBar.high - swingHigh;

  if (buySweepDistance >= minSweepDistance && triggerBar.close > swingLow && triggerBar.close > triggerBar.open) {
    const stopPrice = triggerBar.low * (1 - settings.stopBufferPercent / 100);
    const riskPerShare = triggerBar.close - stopPrice;
    const qty = Math.max(1, Math.floor(settings.riskPerTrade / riskPerShare));
    const targetPrice = triggerBar.close + (riskPerShare * settings.rewardToRisk * (1 + settings.takeProfitBufferPercent / 100));

    return {
      status: 'candidate',
      symbol,
      side: 'buy',
      reason: `Sell-side liquidity sweep below ${round(swingLow, 2)} reclaimed with bullish displacement.`,
      timeframe: settings.timeframe,
      entryPrice: round(triggerBar.close, 2),
      stopPrice: round(stopPrice, 2),
      targetPrice: round(targetPrice, 2),
      riskPerShare: round(riskPerShare, 2),
      qty,
      metrics: {
        bodyRatio: round(bodyRatio, 2),
        sweepDistance: round(buySweepDistance, 2),
        swingLow: round(swingLow, 2),
      },
      triggerBar,
    };
  }

  if (sellSweepDistance >= minSweepDistance && triggerBar.close < swingHigh && triggerBar.close < triggerBar.open) {
    const stopPrice = triggerBar.high * (1 + settings.stopBufferPercent / 100);
    const riskPerShare = stopPrice - triggerBar.close;
    const qty = Math.max(1, Math.floor(settings.riskPerTrade / riskPerShare));
    const targetPrice = triggerBar.close - (riskPerShare * settings.rewardToRisk * (1 + settings.takeProfitBufferPercent / 100));

    return {
      status: 'candidate',
      symbol,
      side: 'sell',
      reason: `Buy-side liquidity sweep above ${round(swingHigh, 2)} rejected with bearish displacement.`,
      timeframe: settings.timeframe,
      entryPrice: round(triggerBar.close, 2),
      stopPrice: round(stopPrice, 2),
      targetPrice: round(targetPrice, 2),
      riskPerShare: round(riskPerShare, 2),
      qty,
      metrics: {
        bodyRatio: round(bodyRatio, 2),
        sweepDistance: round(sellSweepDistance, 2),
        swingHigh: round(swingHigh, 2),
      },
      triggerBar,
    };
  }

  return {
    status: 'blocked',
    symbol,
    reason: 'No qualifying liquidity sweep on the latest bar.',
    metrics: {
      bodyRatio: round(bodyRatio, 2),
      swingHigh: round(swingHigh, 2),
      swingLow: round(swingLow, 2),
    },
  };
}

function normalizeAutomationSettings(settings = {}) {
  return {
    ...automationDefaults,
    ...settings,
    enabled: Boolean(settings.enabled),
    autoSubmit: Boolean(settings.autoSubmit),
    pollIntervalSeconds: Math.max(60, Number(settings.pollIntervalSeconds || automationDefaults.pollIntervalSeconds)),
    lookbackBars: Math.max(6, Number(settings.lookbackBars || automationDefaults.lookbackBars)),
    minSweepPercent: Math.max(0.01, Number(settings.minSweepPercent || automationDefaults.minSweepPercent)),
    minBodyToRangeRatio: Math.min(1, Math.max(0.05, Number(settings.minBodyToRangeRatio || automationDefaults.minBodyToRangeRatio))),
    rewardToRisk: Math.max(1, Number(settings.rewardToRisk || automationDefaults.rewardToRisk)),
    maxOpenPositions: Math.max(1, Number(settings.maxOpenPositions || automationDefaults.maxOpenPositions)),
    maxConcurrentOrdersPerSymbol: Math.max(1, Number(settings.maxConcurrentOrdersPerSymbol || automationDefaults.maxConcurrentOrdersPerSymbol)),
    riskPerTrade: Math.max(1, Number(settings.riskPerTrade || automationDefaults.riskPerTrade)),
    stopBufferPercent: Math.max(0, Number(settings.stopBufferPercent || automationDefaults.stopBufferPercent)),
    takeProfitBufferPercent: Math.max(0, Number(settings.takeProfitBufferPercent || automationDefaults.takeProfitBufferPercent)),
    minimumPrice: Math.max(0.01, Number(settings.minimumPrice || automationDefaults.minimumPrice)),
    maximumPrice: Math.max(1, Number(settings.maximumPrice || automationDefaults.maximumPrice)),
  };
}

function normalizeAutomationStatus(status = {}) {
  return {
    ...automationStatusDefaults,
    ...status,
    candidates: Array.isArray(status.candidates) ? status.candidates.slice(0, 20) : [],
    activity: Array.isArray(status.activity) ? status.activity.slice(0, 60) : [],
  };
}

async function writeAutomationStatus(storage, status) {
  const next = normalizeAutomationStatus(status);
  await fs.writeFile(storage.automationStatusPath, JSON.stringify(next, null, 2));
  return next;
}

function pushActivity(status, item) {
  const next = normalizeAutomationStatus(status);
  next.activity.unshift(item);
  next.activity = next.activity.slice(0, 60);
  return next;
}

async function runAutomationCycle({ storage, createAlpacaClient, logger = () => {}, onCandidates = null }) {
  await storage.ensureDataFiles();
  const settings = await storage.readSettings();
  const automationSettings = normalizeAutomationSettings(settings.automation);
  let status = normalizeAutomationStatus(await storage.readAutomationStatus());
  status.lastRunStartedAt = new Date().toISOString();
  status.lastHeartbeatAt = status.lastRunStartedAt;
  await writeAutomationStatus(storage, status);

  if (!automationSettings.enabled) {
    status.lastRunAt = new Date().toISOString();
    status.lastSummary = 'Automation disabled. No scan executed.';
    status.lastError = null;
    status.runCount += 1;
    await writeAutomationStatus(storage, status);
    return { ok: true, skipped: true, settings: automationSettings, status };
  }

  const alpaca = createAlpacaClient();
  if (!alpaca) {
    status.lastRunAt = new Date().toISOString();
    status.lastError = 'Missing Alpaca paper credentials.';
    status.lastSummary = 'Automation blocked because paper credentials are missing.';
    status.runCount += 1;
    await writeAutomationStatus(storage, status);
    return { ok: false, settings: automationSettings, status };
  }

  try {
    const watchlist = (settings.watchlist || []).slice(0, automationSettings.maxWatchlistSymbols);
    const [positions, orders] = await Promise.all([
      alpaca.getPositions(),
      alpaca.getOrders({ status: 'open', direction: 'desc' }),
    ]);

    const positionSymbols = new Set(positions.map((position) => position.symbol));
    const openOrdersBySymbol = orders.reduce((map, order) => {
      map.set(order.symbol, (map.get(order.symbol) || 0) + 1);
      return map;
    }, new Map());

    const activity = [];
    const candidates = [];

    for (const symbol of watchlist) {
      const bars = await collectBars(alpaca, symbol, automationSettings.timeframe, automationSettings.lookbackBars + 2);
      const result = evaluateLiquiditySweep({ symbol, bars, settings: automationSettings });

      if (result.status !== 'candidate') {
        activity.push({
          at: new Date().toISOString(),
          symbol,
          type: result.status,
          detail: result.reason,
        });
        continue;
      }

      if (positionSymbols.has(symbol)) {
        activity.push({ at: new Date().toISOString(), symbol, type: 'blocked', detail: 'Skipped, position already open for symbol.' });
        continue;
      }

      if ((openOrdersBySymbol.get(symbol) || 0) >= automationSettings.maxConcurrentOrdersPerSymbol) {
        activity.push({ at: new Date().toISOString(), symbol, type: 'blocked', detail: 'Skipped, open order already exists for symbol.' });
        continue;
      }

      if (positions.length >= automationSettings.maxOpenPositions) {
        activity.push({ at: new Date().toISOString(), symbol, type: 'blocked', detail: 'Skipped, max open positions reached.' });
        continue;
      }

      const candidate = {
        id: `${symbol}-${result.timeframe}-${result.triggerBar.timestamp}`,
        createdAt: new Date().toISOString(),
        status: automationSettings.autoSubmit ? 'submitted' : 'candidate',
        autoSubmitted: automationSettings.autoSubmit,
        ...result,
      };

      if (automationSettings.autoSubmit) {
        await alpaca.createOrder({
          symbol,
          side: result.side,
          qty: result.qty,
          type: 'limit',
          limit_price: result.entryPrice,
          time_in_force: 'day',
          order_class: 'bracket',
          take_profit: { limit_price: result.targetPrice },
          stop_loss: { stop_price: result.stopPrice },
        });
        openOrdersBySymbol.set(symbol, (openOrdersBySymbol.get(symbol) || 0) + 1);
        activity.push({ at: new Date().toISOString(), symbol, type: 'submitted', detail: `Paper ${result.side} bracket order submitted at ${result.entryPrice}.` });
      } else {
        activity.push({ at: new Date().toISOString(), symbol, type: 'candidate', detail: `${result.side.toUpperCase()} candidate ready for review at ${result.entryPrice}.` });
      }

      candidates.push(candidate);
    }

    status = normalizeAutomationStatus(await storage.readAutomationStatus());
    status.candidates = [...candidates, ...status.candidates]
      .filter((candidate, index, list) => list.findIndex((item) => item.id === candidate.id) === index)
      .slice(0, 20);
    for (const item of activity.reverse()) {
      status = pushActivity(status, item);
    }
    status.lastRunAt = new Date().toISOString();
    status.lastError = null;
    status.runCount += 1;
    status.lastSummary = candidates.length
      ? `Scanned ${watchlist.length} symbols and produced ${candidates.length} ${automationSettings.autoSubmit ? 'submitted order(s)' : 'candidate(s)'}.`
      : `Scanned ${watchlist.length} symbols, no trades taken.`;
    await writeAutomationStatus(storage, status);
    if (typeof onCandidates === 'function' && candidates.length) {
      await onCandidates(candidates);
    }
    logger(status.lastSummary);
    return { ok: true, settings: automationSettings, status, candidates, positions, orders };
  } catch (error) {
    status = normalizeAutomationStatus(await storage.readAutomationStatus());
    status.lastRunAt = new Date().toISOString();
    status.lastError = error.message;
    status.lastSummary = 'Automation run failed.';
    status.runCount += 1;
    status = pushActivity(status, { at: new Date().toISOString(), symbol: 'SYSTEM', type: 'error', detail: error.message });
    await writeAutomationStatus(storage, status);
    return { ok: false, settings: automationSettings, status, error };
  }
}

function createAutomationEngine({ storage, createAlpacaClient, logger = () => {}, onCandidates = null }) {
  let timer = null;
  let inFlight = false;

  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      await runAutomationCycle({ storage, createAlpacaClient, logger, onCandidates });
    } finally {
      inFlight = false;
    }
  }

  async function start() {
    const settings = await storage.readSettings();
    const automationSettings = normalizeAutomationSettings(settings.automation);
    if (timer) globalThis.clearInterval(timer);
    timer = globalThis.setInterval(tick, automationSettings.pollIntervalSeconds * 1000);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) globalThis.clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick };
}

export {
  automationDefaults,
  automationStatusDefaults,
  createAutomationEngine,
  evaluateLiquiditySweep,
  normalizeAutomationSettings,
  normalizeAutomationStatus,
  runAutomationCycle,
};
