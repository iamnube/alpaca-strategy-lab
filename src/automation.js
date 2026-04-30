import fs from 'fs/promises'
import {
  round,
  isEtfSymbol,
  getBarBodyRatio,
  averageTrueRange,
} from './strategy-utils.js'

const automationDefaults = {
  enabled: false,
  autoSubmit: false,
  autoSubmitArmMinutes: 20,
  autoSubmitArmedUntil: null,
  pollIntervalSeconds: 600,
  timeframe: '15Min',
  lookbackBars: 24,
  signalWindowBars: 1,
  maxConfirmationAgeBars: 1,
  minSweepPercent: 0.03,
  etfMinSweepPercent: 0.02,
  minBodyToRangeRatio: 0.22,
  confirmationBodyToRangeRatio: 0.18,
  reclaimAtrMultiplier: 0.1,
  rewardToRisk: 1,
  maxOpenPositions: 2,
  maxConcurrentOrdersPerSymbol: 1,
  cooldownBars: 0,
  candidateMaxAgeHours: 2,
  closeHourAvoidMinutes: 0,
  openGuardMinutes: 0,
  allowedStartHour: 14,
  allowedEndHour: 16,
  watchlistScope: 'watchlist',
  maxWatchlistSymbols: 5,
  symbolsPerCycle: 5,
  rotateWatchlist: true,
  riskPerTrade: 25,
  maxNotionalPerTrade: 10000,
  stopBufferPercent: 0.1,
  takeProfitBufferPercent: 0,
  minimumPrice: 5,
  maximumPrice: 500,
  avoidMidday: false,
  middayStartHour: 11,
  middayEndHour: 13,
  etfCooldownBars: 1,
  stockCooldownBars: 3,
}

const automationStatusDefaults = {
  lastRunAt: null,
  lastRunStartedAt: null,
  lastHeartbeatAt: null,
  lastError: null,
  lastSummary: 'Automation has not run yet.',
  runCount: 0,
  candidates: [],
  activity: [],
  watchlistCursor: 0,
  symbolStates: {},
}

function normalizeTimeframe(timeframe, alpaca) {
  if (!timeframe || timeframe === '5Min') return alpaca.newTimeframe(5, alpaca.timeframeUnit.MIN)
  if (timeframe === '15Min') return alpaca.newTimeframe(15, alpaca.timeframeUnit.MIN)
  if (timeframe === '1Hour') return alpaca.newTimeframe(1, alpaca.timeframeUnit.HOUR)
  throw new Error(`Unsupported timeframe: ${timeframe}`)
}

async function collectBars(alpaca, symbol, timeframe, limit) {
  const bars = []
  const iterator = alpaca.getBarsV2(symbol, {
    start: new Date(Date.now() - (limit + 5) * 60 * 60 * 1000).toISOString(),
    end: new Date().toISOString(),
    timeframe: normalizeTimeframe(timeframe, alpaca),
    feed: 'iex',
    limit,
  })
  for await (const bar of iterator) {
    bars.push({
      timestamp: bar.Timestamp,
      open: Number(bar.OpenPrice),
      high: Number(bar.HighPrice),
      low: Number(bar.LowPrice),
      close: Number(bar.ClosePrice),
      volume: Number(bar.Volume ?? 0),
    })
  }
  return bars
}

async function collectBarsForSymbols(alpaca, symbols, timeframe, limit) {
  if (!symbols.length) return new Map()

  if (typeof alpaca.getMultiBarsV2 === 'function') {
    const multiBars = await alpaca.getMultiBarsV2(symbols, {
      start: new Date(Date.now() - (limit + 5) * 60 * 60 * 1000).toISOString(),
      end: new Date().toISOString(),
      timeframe: normalizeTimeframe(timeframe, alpaca),
      feed: 'iex',
      limit,
    })

    const mapped = new Map(symbols.map((symbol) => {
      const bars = (multiBars.get(symbol) || []).map((bar) => ({
        timestamp: bar.Timestamp,
        open: Number(bar.OpenPrice),
        high: Number(bar.HighPrice),
        low: Number(bar.LowPrice),
        close: Number(bar.ClosePrice),
        volume: Number(bar.Volume ?? 0),
      }))
      return [symbol, bars]
    }))

    const missingSymbols = symbols.filter((symbol) => !(mapped.get(symbol)?.length))
    if (missingSymbols.length) {
      const recovered = await Promise.all(
        missingSymbols.map(async (symbol) => [symbol, await collectBars(alpaca, symbol, timeframe, limit)]),
      )
      for (const [symbol, bars] of recovered) mapped.set(symbol, bars)
    }
    return mapped
  }

  const fallback = await Promise.all(
    symbols.map(async (symbol) => [symbol, await collectBars(alpaca, symbol, timeframe, limit)]),
  )
  return new Map(fallback)
}

function getWatchlistSlice(watchlist, settings, status) {
  const cappedWatchlist = watchlist.slice(0, settings.maxWatchlistSymbols)
  const symbolsPerCycle = Math.min(
    cappedWatchlist.length || 0,
    Math.max(1, settings.symbolsPerCycle || cappedWatchlist.length || 1),
  )
  if (!cappedWatchlist.length) {
    return { watchlist: cappedWatchlist, activeSymbols: [], deferredSymbols: [], nextCursor: 0, symbolsPerCycle }
  }

  if (!settings.rotateWatchlist || symbolsPerCycle >= cappedWatchlist.length) {
    return {
      watchlist: cappedWatchlist,
      activeSymbols: cappedWatchlist,
      deferredSymbols: [],
      nextCursor: 0,
      symbolsPerCycle,
    }
  }

  const cursor = Number.isInteger(status.watchlistCursor) ? status.watchlistCursor : 0
  const start = ((cursor % cappedWatchlist.length) + cappedWatchlist.length) % cappedWatchlist.length
  const activeSymbols = []
  for (let index = 0; index < symbolsPerCycle; index += 1) {
    activeSymbols.push(cappedWatchlist[(start + index) % cappedWatchlist.length])
  }
  const activeSet = new Set(activeSymbols)
  return {
    watchlist: cappedWatchlist,
    activeSymbols,
    deferredSymbols: cappedWatchlist.filter((symbol) => !activeSet.has(symbol)),
    nextCursor: (start + symbolsPerCycle) % cappedWatchlist.length,
    symbolsPerCycle,
  }
}

function formatRatio(value) {
  return Number.isFinite(value) ? value.toFixed(3) : 'n/a'
}

function classifySweepCandidate({
  symbol, direction, triggerBar, confirmationBar,
  swingLevel, sweepDistance, settings, barsSinceSignal, extremePrice,
}) {
  const maxAge = Math.max(0, Number(settings.maxConfirmationAgeBars ?? 1))
  if (barsSinceSignal > maxAge) {
    return {
      status: 'blocked',
      symbol,
      reason: `Confirmation came ${barsSinceSignal} bar(s) after trigger, exceeding maxConfirmationAgeBars (${maxAge}). Setup is stale.`,
    }
  }

  const entryPrice = confirmationBar.close
  if (entryPrice < settings.minimumPrice || entryPrice > settings.maximumPrice) {
    return {
      status: 'blocked',
      symbol,
      reason: `Price ${round(entryPrice, 2)} outside configured range [${settings.minimumPrice}, ${settings.maximumPrice}].`,
    }
  }

  const stopPrice = direction === 'buy'
    ? extremePrice * (1 - settings.stopBufferPercent / 100)
    : extremePrice * (1 + settings.stopBufferPercent / 100)
  const riskPerShare = direction === 'buy'
    ? entryPrice - stopPrice
    : stopPrice - entryPrice

  if (!(riskPerShare > 0)) {
    return { status: 'blocked', symbol, reason: 'Calculated risk per share is invalid (stop and entry overlap).' }
  }

  const rawQty = Math.max(1, Math.floor(settings.riskPerTrade / riskPerShare))
  const maxNotional = Number(settings.maxNotionalPerTrade ?? 10000)
  const qty = maxNotional > 0 && (rawQty * entryPrice) > maxNotional
    ? Math.max(1, Math.floor(maxNotional / entryPrice))
    : rawQty

  const targetPrice = direction === 'buy'
    ? entryPrice + (riskPerShare * settings.rewardToRisk * (1 + settings.takeProfitBufferPercent / 100))
    : entryPrice - (riskPerShare * settings.rewardToRisk * (1 + settings.takeProfitBufferPercent / 100))

  return {
    status: 'candidate',
    symbol,
    side: direction,
    reason: direction === 'buy'
      ? `Sell-side sweep below ${round(swingLevel, 2)} confirmed ${barsSinceSignal === 0 ? 'on the trigger bar' : `${barsSinceSignal} bar(s) later`} with reclaim.`
      : `Buy-side sweep above ${round(swingLevel, 2)} confirmed ${barsSinceSignal === 0 ? 'on the trigger bar' : `${barsSinceSignal} bar(s) later`} with rejection.`,
    timeframe: settings.timeframe,
    entryPrice: round(entryPrice, 2),
    stopPrice: round(stopPrice, 2),
    targetPrice: round(targetPrice, 2),
    riskPerShare: round(riskPerShare, 2),
    qty,
    notionalCapped: qty < rawQty,
    metrics: {
      triggerBodyRatio: round(getBarBodyRatio(triggerBar), 2),
      confirmationBodyRatio: round(getBarBodyRatio(confirmationBar), 2),
      sweepDistance: round(sweepDistance, 2),
      sweepLevel: round(swingLevel, 2),
      barsSinceSignal,
    },
    triggerBar,
    confirmationBar,
  }
}

function evaluateLiquiditySweep({ symbol, bars, settings }) {
  if (!Array.isArray(bars) || bars.length < Math.max(6, settings.lookbackBars)) {
    return { status: 'skipped', symbol, reason: 'Not enough bars yet.' }
  }

  const recent = bars.slice(-settings.lookbackBars)
  const atr = averageTrueRange(recent, 14)
  const confirmLookahead = Math.min(3, Math.max(1, settings.signalWindowBars || 1))
  const signalWindowBars = Math.max(1, Math.min(settings.signalWindowBars || 1, recent.length - 1))
  const startIndex = Math.max(5, recent.length - signalWindowBars)
  const minSweepPercent = isEtfSymbol(symbol)
    ? (settings.etfMinSweepPercent || settings.minSweepPercent)
    : settings.minSweepPercent
  const nearMisses = []

  for (let triggerIndex = recent.length - 1; triggerIndex >= startIndex; triggerIndex -= 1) {
    const triggerBar = recent[triggerIndex]
    const previousBars = recent.slice(0, triggerIndex)
    if (previousBars.length < 5) continue

    const swingHigh = Math.max(...previousBars.map((bar) => bar.high))
    const swingLow = Math.min(...previousBars.map((bar) => bar.low))
    const minSweepDistance = triggerBar.close * (minSweepPercent / 100)
    const buySweepDistance = swingLow - triggerBar.low
    const sellSweepDistance = triggerBar.high - swingHigh
    const triggerBodyRatio = getBarBodyRatio(triggerBar)

    const confirmationBars = recent.slice(
      triggerIndex,
      Math.min(recent.length, triggerIndex + confirmLookahead + 1),
    )

    const bullishConfirmation = confirmationBars.find(
      (bar) =>
        bar.close > swingLow &&
        bar.close >= Math.max(bar.open, triggerBar.close) &&
        getBarBodyRatio(bar) >= settings.confirmationBodyToRangeRatio,
    )
    const bearishConfirmation = confirmationBars.find(
      (bar) =>
        bar.close < swingHigh &&
        bar.close <= Math.min(bar.open, triggerBar.close) &&
        getBarBodyRatio(bar) >= settings.confirmationBodyToRangeRatio,
    )

    const bullishConfirmationBodyRatio = bullishConfirmation ? getBarBodyRatio(bullishConfirmation) : null
    const bearishConfirmationBodyRatio = bearishConfirmation ? getBarBodyRatio(bearishConfirmation) : null

    const reclaimMult = Number(settings.reclaimAtrMultiplier || 0)
    const reclaimDistance = reclaimMult > 0 && atr ? atr * reclaimMult : 0

    if (buySweepDistance >= minSweepDistance) {
      const reclaimOk = !reclaimDistance ||
        (bullishConfirmation && bullishConfirmation.close >= (swingLow + reclaimDistance))

      if (
        bullishConfirmation && reclaimOk &&
        (triggerBar.close > swingLow ||
          triggerBodyRatio >= settings.minBodyToRangeRatio ||
          bullishConfirmationBodyRatio >= settings.minBodyToRangeRatio)
      ) {
        const barsSinceSignal = recent.indexOf(bullishConfirmation) - triggerIndex
        return classifySweepCandidate({
          symbol, direction: 'buy', triggerBar, confirmationBar: bullishConfirmation,
          swingLevel: swingLow, sweepDistance: buySweepDistance, settings, barsSinceSignal,
          extremePrice: Math.min(...confirmationBars.map((bar) => bar.low)),
        })
      }

      nearMisses.push({
        direction: 'buy',
        detail: bullishConfirmation
          ? `Recent sell-side sweep below ${round(swingLow, 2)} reclaimed, but displacement stayed below ${formatRatio(settings.minBodyToRangeRatio)} (trigger ${formatRatio(triggerBodyRatio)}, confirmation ${formatRatio(bullishConfirmationBodyRatio)}).`
          : `Recent sell-side sweep below ${round(swingLow, 2)} lacked a strong reclaim close.`,
        sweepDistance: round(buySweepDistance, 2),
        triggerBodyRatio: round(triggerBodyRatio, 3),
        confirmationBodyRatio: round(bullishConfirmationBodyRatio, 3),
        swingLow: round(swingLow, 2),
      })
    }

    if (sellSweepDistance >= minSweepDistance) {
      const reclaimOk = !reclaimDistance ||
        (bearishConfirmation && bearishConfirmation.close <= (swingHigh - reclaimDistance))

      if (
        bearishConfirmation && reclaimOk &&
        (triggerBar.close < swingHigh ||
          triggerBodyRatio >= settings.minBodyToRangeRatio ||
          bearishConfirmationBodyRatio >= settings.minBodyToRangeRatio)
      ) {
        const barsSinceSignal = recent.indexOf(bearishConfirmation) - triggerIndex
        return classifySweepCandidate({
          symbol, direction: 'sell', triggerBar, confirmationBar: bearishConfirmation,
          swingLevel: swingHigh, sweepDistance: sellSweepDistance, settings, barsSinceSignal,
          extremePrice: Math.max(...confirmationBars.map((bar) => bar.high)),
        })
      }

      nearMisses.push({
        direction: 'sell',
        detail: bearishConfirmation
          ? `Recent buy-side sweep above ${round(swingHigh, 2)} rejected, but displacement stayed below ${formatRatio(settings.minBodyToRangeRatio)} (trigger ${formatRatio(triggerBodyRatio)}, confirmation ${formatRatio(bearishConfirmationBodyRatio)}).`
          : `Recent buy-side sweep above ${round(swingHigh, 2)} lacked a strong rejection close.`,
        sweepDistance: round(sellSweepDistance, 2),
        triggerBodyRatio: round(triggerBodyRatio, 3),
        confirmationBodyRatio: round(bearishConfirmationBodyRatio, 3),
        swingHigh: round(swingHigh, 2),
      })
    }
  }

  if (nearMisses.length) {
    return { status: 'near-miss', symbol, reason: nearMisses[0].detail, metrics: nearMisses[0] }
  }
  return {
    status: 'blocked',
    symbol,
    reason: `No qualifying liquidity sweep found in the last ${signalWindowBars} bar(s).`,
  }
}

function normalizeAutomationSettings(settings = {}) {
  return {
    ...automationDefaults,
    ...settings,
    enabled: Boolean(settings.enabled),
    autoSubmit: Boolean(settings.autoSubmit),
    autoSubmitArmMinutes: Math.max(1, Number(settings.autoSubmitArmMinutes ?? automationDefaults.autoSubmitArmMinutes)),
    autoSubmitArmedUntil: settings.autoSubmitArmedUntil ? new Date(settings.autoSubmitArmedUntil).toISOString() : null,
    pollIntervalSeconds: Math.max(60, Number(settings.pollIntervalSeconds || automationDefaults.pollIntervalSeconds)),
    lookbackBars: Math.max(6, Number(settings.lookbackBars || automationDefaults.lookbackBars)),
    signalWindowBars: Math.max(1, Math.min(5, Number(settings.signalWindowBars || automationDefaults.signalWindowBars))),
    maxConfirmationAgeBars: Math.max(0, Number(settings.maxConfirmationAgeBars ?? automationDefaults.maxConfirmationAgeBars)),
    minSweepPercent: Math.max(0.01, Number(settings.minSweepPercent || automationDefaults.minSweepPercent)),
    etfMinSweepPercent: Math.max(0.01, Number(settings.etfMinSweepPercent || automationDefaults.etfMinSweepPercent)),
    minBodyToRangeRatio: Math.min(1, Math.max(0.05, Number(settings.minBodyToRangeRatio || automationDefaults.minBodyToRangeRatio))),
    confirmationBodyToRangeRatio: Math.min(1, Math.max(0.05, Number(settings.confirmationBodyToRangeRatio || automationDefaults.confirmationBodyToRangeRatio))),
    reclaimAtrMultiplier: Math.max(0, Number(settings.reclaimAtrMultiplier || automationDefaults.reclaimAtrMultiplier)),
    rewardToRisk: Math.max(1, Number(settings.rewardToRisk || automationDefaults.rewardToRisk)),
    maxOpenPositions: Math.max(1, Number(settings.maxOpenPositions || automationDefaults.maxOpenPositions)),
    maxConcurrentOrdersPerSymbol: Math.max(1, Number(settings.maxConcurrentOrdersPerSymbol || automationDefaults.maxConcurrentOrdersPerSymbol)),
    symbolsPerCycle: Math.max(1, Math.min(
      Number(settings.maxWatchlistSymbols || automationDefaults.maxWatchlistSymbols),
      Number(settings.symbolsPerCycle || automationDefaults.symbolsPerCycle),
    )),
    rotateWatchlist: settings.rotateWatchlist !== undefined ? Boolean(settings.rotateWatchlist) : automationDefaults.rotateWatchlist,
    riskPerTrade: Math.max(1, Number(settings.riskPerTrade || automationDefaults.riskPerTrade)),
    maxNotionalPerTrade: Math.max(0, Number(settings.maxNotionalPerTrade ?? automationDefaults.maxNotionalPerTrade)),
    stopBufferPercent: Math.max(0, Number(settings.stopBufferPercent || automationDefaults.stopBufferPercent)),
    takeProfitBufferPercent: Math.max(0, Number(settings.takeProfitBufferPercent || automationDefaults.takeProfitBufferPercent)),
    minimumPrice: Math.max(0.01, Number(settings.minimumPrice || automationDefaults.minimumPrice)),
    maximumPrice: Math.max(1, Number(settings.maximumPrice || automationDefaults.maximumPrice)),
    avoidMidday: settings.avoidMidday !== undefined ? Boolean(settings.avoidMidday) : automationDefaults.avoidMidday,
    middayStartHour: Math.max(0, Math.min(23, Number(settings.middayStartHour ?? automationDefaults.middayStartHour))),
    middayEndHour: Math.max(1, Math.min(24, Number(settings.middayEndHour ?? automationDefaults.middayEndHour))),
    allowedStartHour: Math.max(0, Math.min(23, Number(settings.allowedStartHour ?? automationDefaults.allowedStartHour))),
    allowedEndHour: Math.max(1, Math.min(24, Number(settings.allowedEndHour ?? automationDefaults.allowedEndHour))),
    cooldownBars: Math.max(0, Number(settings.cooldownBars || automationDefaults.cooldownBars)),
    etfCooldownBars: Math.max(0, Number(settings.etfCooldownBars ?? automationDefaults.etfCooldownBars)),
    stockCooldownBars: Math.max(0, Number(settings.stockCooldownBars ?? automationDefaults.stockCooldownBars)),
    candidateMaxAgeHours: Math.max(1, Number(settings.candidateMaxAgeHours || automationDefaults.candidateMaxAgeHours)),
    closeHourAvoidMinutes: Math.max(0, Number(settings.closeHourAvoidMinutes ?? automationDefaults.closeHourAvoidMinutes)),
    openGuardMinutes: Math.max(0, Number(settings.openGuardMinutes ?? automationDefaults.openGuardMinutes)),
  }
}

function isWithinCloseAvoidWindow(now = new Date(), avoidMinutes = 60) {
  if (!avoidMinutes) return false
  const close = new Date(now)
  close.setHours(16, 0, 0, 0)
  const msToClose = close.getTime() - now.getTime()
  return msToClose >= 0 && msToClose <= avoidMinutes * 60 * 1000
}

function isWithinMiddayWindow(now = new Date(), settings = automationDefaults) {
  if (!settings.avoidMidday) return false
  const startHour = Number(settings.middayStartHour ?? 11)
  const endHour = Number(settings.middayEndHour ?? 13)
  const hour = now.getHours() + (now.getMinutes() / 60)
  return hour >= startHour && hour < endHour
}

function isWithinOpenGuardWindow(now = new Date(), guardMinutes = 15) {
  if (!guardMinutes) return false
  const open = new Date(now)
  open.setHours(9, 30, 0, 0)
  const msSinceOpen = now.getTime() - open.getTime()
  return msSinceOpen >= 0 && msSinceOpen <= guardMinutes * 60 * 1000
}

function isWithinAllowedSessionWindow(now = new Date(), settings = automationDefaults) {
  const startHour = Number(settings.allowedStartHour ?? 0)
  const endHour = Number(settings.allowedEndHour ?? 24)
  const hour = now.getHours() + (now.getMinutes() / 60)
  return hour >= startHour && hour < endHour
}

function isAutoSubmitArmed(settings = automationDefaults, now = new Date()) {
  if (!settings.autoSubmit) return false
  if (!settings.autoSubmitArmedUntil) return false
  return new Date(settings.autoSubmitArmedUntil).getTime() > now.getTime()
}

function pruneStaleCandidates(candidates, settings) {
  const maxAgeMs = Math.max(1, settings.candidateMaxAgeHours) * 60 * 60 * 1000
  const now = Date.now()
  return (candidates || []).filter((candidate) => {
    const createdAt = candidate?.createdAt ? new Date(candidate.createdAt).getTime() : 0
    if (!createdAt) return true
    return now - createdAt <= maxAgeMs
  })
}

function normalizeAutomationStatus(status = {}) {
  return {
    ...automationStatusDefaults,
    ...status,
    candidates: Array.isArray(status.candidates) ? status.candidates.slice(0, 20) : [],
    activity: Array.isArray(status.activity) ? status.activity.slice(0, 60) : [],
    watchlistCursor: Number.isInteger(status.watchlistCursor) ? status.watchlistCursor : 0,
    symbolStates: status.symbolStates && typeof status.symbolStates === 'object' ? status.symbolStates : {},
  }
}

async function writeAutomationStatus(storage, status) {
  const next = normalizeAutomationStatus(status)
  await fs.writeFile(storage.automationStatusPath, JSON.stringify(next, null, 2))
  return next
}

function pushActivity(status, item) {
  const next = normalizeAutomationStatus(status)
  next.activity.unshift(item)
  next.activity = next.activity.slice(0, 60)
  return next
}

function serializeError(error) {
  try {
    if (!error) return 'Unknown error'
    if (typeof error === 'string') return error
    const msg = typeof error.message === 'string' && error.message.trim() ? error.message.trim() : null
    const code = typeof error.code === 'string' && error.code.trim() ? `[${error.code}] ` : ''
    const status = error.response?.status ? ` (HTTP ${error.response.status})` : ''
    if (msg) return `${code}${msg}${status}`
    return error.stack || String(error)
  } catch {
    return 'Unknown error'
  }
}

async function runAutomationCycle({
  storage, createAlpacaClient, logger = () => {}, onCandidates = null, _inFlight = null,
}) {
  if (_inFlight && _inFlight.size > 0) {
    logger('Skipped: automation cycle already in flight.')
    return { ok: true, skipped: true, reason: 'in-flight' }
  }
  if (_inFlight) _inFlight.add(1)
  try {
    return await _runAutomationCycleImpl({ storage, createAlpacaClient, logger, onCandidates })
  } finally {
    if (_inFlight) _inFlight.clear()
  }
}

async function _runAutomationCycleImpl({ storage, createAlpacaClient, logger, onCandidates }) {
  await storage.ensureDataFiles()
  const settings = await storage.readSettings()
  const automationSettings = normalizeAutomationSettings(settings.automation)
  let status = normalizeAutomationStatus(await storage.readAutomationStatus())

  const prunedCandidates = pruneStaleCandidates(status.candidates, automationSettings)
  if (prunedCandidates.length !== (status.candidates || []).length) {
    status.candidates = prunedCandidates
  }

  status.lastRunStartedAt = new Date().toISOString()
  status.lastHeartbeatAt = status.lastRunStartedAt
  await writeAutomationStatus(storage, status)

  if (!automationSettings.enabled) {
    status.lastRunAt = new Date().toISOString()
    status.lastSummary = 'Automation disabled. No scan executed.'
    status.lastError = null
    status.runCount += 1
    await writeAutomationStatus(storage, status)
    return { ok: true, skipped: true, settings: automationSettings, status }
  }

  const alpaca = createAlpacaClient()
  if (!alpaca) {
    status.lastRunAt = new Date().toISOString()
    status.lastError = 'Missing Alpaca paper credentials.'
    status.lastSummary = 'Automation blocked because paper credentials are missing.'
    status.runCount += 1
    await writeAutomationStatus(storage, status)
    return { ok: false, settings: automationSettings, status }
  }

  const now = new Date()

  if (!isWithinAllowedSessionWindow(now, automationSettings)) {
    status.lastRunAt = now.toISOString()
    status.lastError = null
    status.lastSummary = `Skipped scan: allowed session is ${automationSettings.allowedStartHour}:00-${automationSettings.allowedEndHour}:00 ET.`
    status.runCount += 1
    status = pushActivity(status, { at: now.toISOString(), symbol: 'SYSTEM', type: 'skipped', detail: status.lastSummary })
    await writeAutomationStatus(storage, status)
    logger(status.lastSummary)
    return { ok: true, skipped: true, settings: automationSettings, status }
  }

  if (isWithinCloseAvoidWindow(now, automationSettings.closeHourAvoidMinutes)) {
    status.lastRunAt = now.toISOString()
    status.lastError = null
    status.lastSummary = `Skipped scan: within ${automationSettings.closeHourAvoidMinutes} minute(s) of market close.`
    status.runCount += 1
    status = pushActivity(status, { at: now.toISOString(), symbol: 'SYSTEM', type: 'skipped', detail: status.lastSummary })
    await writeAutomationStatus(storage, status)
    logger(status.lastSummary)
    return { ok: true, skipped: true, settings: automationSettings, status }
  }

  if (isWithinMiddayWindow(now, automationSettings)) {
    status.lastRunAt = now.toISOString()
    status.lastError = null
    status.lastSummary = `Skipped scan: midday filter active between ${automationSettings.middayStartHour}:00 and ${automationSettings.middayEndHour}:00 ET.`
    status.runCount += 1
    status = pushActivity(status, { at: now.toISOString(), symbol: 'SYSTEM', type: 'skipped', detail: status.lastSummary })
    await writeAutomationStatus(storage, status)
    logger(status.lastSummary)
    return { ok: true, skipped: true, settings: automationSettings, status }
  }

  if (isWithinOpenGuardWindow(now, automationSettings.openGuardMinutes)) {
    status.lastRunAt = now.toISOString()
    status.lastError = null
    status.lastSummary = `Skipped scan: within ${automationSettings.openGuardMinutes} minute(s) of market open (9:30 AM ET).`
    status.runCount += 1
    status = pushActivity(status, { at: now.toISOString(), symbol: 'SYSTEM', type: 'skipped', detail: status.lastSummary })
    await writeAutomationStatus(storage, status)
    logger(status.lastSummary)
    return { ok: true, skipped: true, settings: automationSettings, status }
  }

  try {
    const selection = getWatchlistSlice(settings.watchlist || [], automationSettings, status)
    const watchlist = selection.watchlist
    const activeSymbols = selection.activeSymbols
    const [positions, orders] = await Promise.all([
      alpaca.getPositions(),
      alpaca.getOrders({ status: 'open', direction: 'desc' }),
    ])

    const positionSymbols = new Set(positions.map((p) => p.symbol))
    const openOrdersBySymbol = orders.reduce((map, order) => {
      map.set(order.symbol, (map.get(order.symbol) || 0) + 1)
      return map
    }, new Map())

    const activity = []
    const candidates = []
    const autoSubmitArmed = isAutoSubmitArmed(automationSettings, now)
    const barsBySymbol = await collectBarsForSymbols(
      alpaca, activeSymbols, automationSettings.timeframe, automationSettings.lookbackBars + 2,
    )

    if (selection.deferredSymbols.length) {
      activity.push({
        at: new Date().toISOString(), symbol: 'SYSTEM', type: 'deferred',
        detail: `Rotation active. Scanning ${activeSymbols.length}/${watchlist.length} symbols this cycle, deferred ${selection.deferredSymbols.length}.`,
      })
    }

    for (const symbol of activeSymbols) {
      const bars = barsBySymbol.get(symbol) || []
      const latestBar = bars[bars.length - 1]
      const previousState = status.symbolStates?.[symbol] || {}

      if (!latestBar) {
        activity.push({ at: new Date().toISOString(), symbol, type: 'skipped', detail: 'No bars returned for symbol in this cycle.' })
        continue
      }

      status.symbolStates[symbol] = {
        lastBarTimestamp: latestBar.timestamp || null,
        lastProcessedAt: new Date().toISOString(),
        lastSignalBarTimestamp: previousState.lastSignalBarTimestamp || null,
      }

      if (previousState.lastBarTimestamp && previousState.lastBarTimestamp === latestBar.timestamp) {
        activity.push({ at: new Date().toISOString(), symbol, type: 'deferred', detail: 'Latest bar unchanged since last scan, skipping re-evaluation.' })
        continue
      }

      const cooldownBars = isEtfSymbol(symbol)
        ? Number(automationSettings.etfCooldownBars ?? automationSettings.cooldownBars ?? 0)
        : Number(automationSettings.stockCooldownBars ?? automationSettings.cooldownBars ?? 0)
      const lastSignalTs = previousState.lastSignalBarTimestamp
      if (cooldownBars > 0 && lastSignalTs && Array.isArray(bars)) {
        const lastIndex = bars.findIndex((bar) => bar.timestamp === lastSignalTs)
        if (lastIndex >= 0) {
          const barsSince = (bars.length - 1) - lastIndex
          if (barsSince >= 0 && barsSince < cooldownBars) {
            activity.push({ at: new Date().toISOString(), symbol, type: 'deferred', detail: `Cooldown active (${barsSince}/${cooldownBars} bars since last signal).` })
            continue
          }
        }
      }

      const result = evaluateLiquiditySweep({ symbol, bars, settings: automationSettings })

      if (result.status !== 'candidate') {
        activity.push({
          at: new Date().toISOString(), symbol, type: result.status,
          detail: result.metrics?.sweepDistance
            ? `${result.reason} (${result.metrics.direction || 'sweep'} distance ${result.metrics.sweepDistance}, trigger body ${result.metrics.triggerBodyRatio ?? 'n/a'})`
            : result.reason,
        })
        continue
      }

      if (positionSymbols.has(symbol)) {
        activity.push({ at: new Date().toISOString(), symbol, type: 'blocked', detail: 'Skipped, position already open for symbol.' })
        continue
      }
      if ((openOrdersBySymbol.get(symbol) || 0) >= automationSettings.maxConcurrentOrdersPerSymbol) {
        activity.push({ at: new Date().toISOString(), symbol, type: 'blocked', detail: 'Skipped, open order already exists for symbol.' })
        continue
      }
      if (positions.length >= automationSettings.maxOpenPositions) {
        activity.push({ at: new Date().toISOString(), symbol, type: 'blocked', detail: 'Skipped, max open positions reached.' })
        continue
      }

      const candidate = {
        id: `${symbol}-${result.timeframe}-${result.triggerBar.timestamp}`,
        createdAt: new Date().toISOString(),
        status: autoSubmitArmed ? 'submitted' : 'candidate',
        autoSubmitted: autoSubmitArmed,
        rewardToRisk: automationSettings.rewardToRisk,
        fillModel: 'close',
        ...result,
      }

      if (autoSubmitArmed) {
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
        })
        openOrdersBySymbol.set(symbol, (openOrdersBySymbol.get(symbol) || 0) + 1)
        const capNote = result.notionalCapped ? ' (qty capped by notional limit)' : ''
        activity.push({ at: new Date().toISOString(), symbol, type: 'submitted', detail: `Paper ${result.side} bracket order submitted at ${result.entryPrice}, qty ${result.qty}${capNote}.` })
      } else {
        const expiredNote = automationSettings.autoSubmit && !autoSubmitArmed
          ? ' Auto-submit arm is not active, so this stayed review-only.'
          : ''
        activity.push({ at: new Date().toISOString(), symbol, type: 'candidate', detail: `${result.side.toUpperCase()} candidate ready for review at ${result.entryPrice}.${expiredNote}` })
      }

      candidates.push(candidate)
      status.symbolStates[symbol].lastSignalBarTimestamp =
        result.confirmationBar?.timestamp || result.triggerBar?.timestamp || latestBar.timestamp || null
    }

    const latestPersistedStatus = normalizeAutomationStatus(await storage.readAutomationStatus())
    status = {
      ...latestPersistedStatus,
      watchlistCursor: selection.nextCursor,
      symbolStates: { ...latestPersistedStatus.symbolStates, ...status.symbolStates },
    }
    status.candidates = [...candidates, ...status.candidates]
      .filter((c, i, list) => list.findIndex((x) => x.id === c.id) === i)
      .slice(0, 20)
    for (const item of activity.reverse()) {
      status = pushActivity(status, item)
    }
    status.lastRunAt = new Date().toISOString()
    status.lastError = null
    status.watchlistCursor = selection.nextCursor
    status.runCount += 1
    status.lastSummary = candidates.length
      ? `Scanned ${activeSymbols.length}/${watchlist.length} symbols, produced ${candidates.length} ${autoSubmitArmed ? 'submitted order(s)' : 'candidate(s)'}, rotation ${automationSettings.rotateWatchlist ? 'on' : 'off'}${automationSettings.autoSubmit && !autoSubmitArmed ? ', auto-submit arm expired' : ''}.`
      : `Scanned ${activeSymbols.length}/${watchlist.length} symbols, no trades taken${selection.deferredSymbols.length ? `, deferred ${selection.deferredSymbols.length} by rotation` : ''}.`
    await writeAutomationStatus(storage, status)
    if (typeof onCandidates === 'function' && candidates.length) await onCandidates(candidates)
    logger(status.lastSummary)
    return { ok: true, settings: automationSettings, status, candidates, positions, orders }
  } catch (error) {
    const errorMessage = serializeError(error)
    status = normalizeAutomationStatus(await storage.readAutomationStatus())
    status.lastRunAt = new Date().toISOString()
    status.lastError = errorMessage
    status.lastSummary = 'Automation run failed.'
    status.runCount += 1
    status = pushActivity(status, { at: new Date().toISOString(), symbol: 'SYSTEM', type: 'error', detail: errorMessage })
    await writeAutomationStatus(storage, status)
    return { ok: false, settings: automationSettings, status, error }
  }
}

function createAutomationEngine({ storage, createAlpacaClient, logger = () => {}, onCandidates = null }) {
  let timer = null
  const inFlight = new Set()

  async function tick() {
    await runAutomationCycle({ storage, createAlpacaClient, logger, onCandidates, _inFlight: inFlight })
  }

  async function start() {
    const settings = await storage.readSettings()
    const automationSettings = normalizeAutomationSettings(settings.automation)
    if (timer) globalThis.clearInterval(timer)
    timer = globalThis.setInterval(tick, automationSettings.pollIntervalSeconds * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    globalThis.setTimeout(() => tick(), 2000)
  }

  function stop() {
    if (timer) globalThis.clearInterval(timer)
    timer = null
  }

  return { start, stop, tick, inFlight }
}

export {
  automationDefaults,
  automationStatusDefaults,
  createAutomationEngine,
  evaluateLiquiditySweep,
  isWithinAllowedSessionWindow,
  isWithinMiddayWindow,
  isWithinOpenGuardWindow,
  isAutoSubmitArmed,
  normalizeAutomationSettings,
  normalizeAutomationStatus,
  runAutomationCycle,
  serializeError,
}
