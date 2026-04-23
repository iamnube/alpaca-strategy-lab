import {
  averageTrueRange,
  cumulativeVwap,
  getBarBodyRatio,
  isEtfSymbol,
  round,
  simpleMovingAverage,
} from './strategy-utils.js'

function classifyBasicCandidate({ symbol, side, timeframe, triggerBar, confirmationBar, entryPrice, stopPrice, targetPrice, reason, metrics, barsSinceSignal = null, settings }) {
  const maxAge = Math.max(0, Number(settings?.maxConfirmationAgeBars ?? 1))
  if (Number.isFinite(barsSinceSignal) && barsSinceSignal > maxAge) {
    return {
      status: 'blocked',
      symbol,
      reason: `Confirmation came ${barsSinceSignal} bar(s) after trigger, exceeding maxConfirmationAgeBars (${maxAge}). Setup is stale.`,
      metrics: {
        ...metrics,
        barsSinceSignal,
      },
    }
  }

  return {
    status: 'candidate',
    symbol,
    side,
    timeframe,
    reason,
    entryPrice: round(entryPrice, 2),
    stopPrice: round(stopPrice, 2),
    targetPrice: round(targetPrice, 2),
    qty: 1,
    metrics: {
      ...metrics,
      ...(Number.isFinite(barsSinceSignal) ? { barsSinceSignal } : {}),
    },
    triggerBar,
    confirmationBar,
  }
}

function computeStopsTargets({ side, entryPrice, extremePrice, settings }) {
  const stopPrice = side === 'buy'
    ? extremePrice * (1 - settings.stopBufferPercent / 100)
    : extremePrice * (1 + settings.stopBufferPercent / 100)
  const riskPerShare = side === 'buy' ? entryPrice - stopPrice : stopPrice - entryPrice
  const targetPrice = side === 'buy'
    ? entryPrice + (riskPerShare * settings.rewardToRisk * (1 + settings.takeProfitBufferPercent / 100))
    : entryPrice - (riskPerShare * settings.rewardToRisk * (1 + settings.takeProfitBufferPercent / 100))
  return { stopPrice, targetPrice, riskPerShare }
}

// Strategy A: Sweep + reclaim
function signalSweepReclaim({ symbol, bars, settings }) {
  if (!Array.isArray(bars) || bars.length < Math.max(6, settings.lookbackBars)) {
    return { status: 'skipped', symbol, reason: 'Not enough bars yet.' }
  }
  const recent = bars.slice(-settings.lookbackBars)
  const atr = averageTrueRange(recent, 14)
  const confirmLookahead = Math.min(3, Math.max(1, settings.signalWindowBars || 1))
  const signalWindowBars = Math.max(1, Math.min(settings.signalWindowBars || 1, recent.length - 1))
  const startIndex = Math.max(5, recent.length - signalWindowBars)
  const minSweepPercent = isEtfSymbol(symbol) ? (settings.etfMinSweepPercent || settings.minSweepPercent) : settings.minSweepPercent
  const reclaimMult = Number(settings.reclaimAtrMultiplier || 0)
  const reclaimDistance = reclaimMult > 0 && atr ? atr * reclaimMult : 0

  for (let triggerIndex = recent.length - 1; triggerIndex >= startIndex; triggerIndex -= 1) {
    const triggerBar = recent[triggerIndex]
    const previousBars = recent.slice(0, triggerIndex)
    if (previousBars.length < 5) continue

    const swingHigh = Math.max(...previousBars.map((b) => b.high))
    const swingLow = Math.min(...previousBars.map((b) => b.low))
    const minSweepDistance = triggerBar.close * (minSweepPercent / 100)
    const buySweepDistance = swingLow - triggerBar.low
    const sellSweepDistance = triggerBar.high - swingHigh
    const triggerBodyRatio = getBarBodyRatio(triggerBar)
    const confirmationBars = recent.slice(triggerIndex, Math.min(recent.length, triggerIndex + confirmLookahead + 1))

    const bullishConfirmation = confirmationBars.find(
      (bar) => bar.close > swingLow && bar.close >= Math.max(bar.open, triggerBar.close) && getBarBodyRatio(bar) >= settings.confirmationBodyToRangeRatio,
    )
    const bearishConfirmation = confirmationBars.find(
      (bar) => bar.close < swingHigh && bar.close <= Math.min(bar.open, triggerBar.close) && getBarBodyRatio(bar) >= settings.confirmationBodyToRangeRatio,
    )

    if (buySweepDistance >= minSweepDistance && bullishConfirmation) {
      const reclaimOk = !reclaimDistance || bullishConfirmation.close >= (swingLow + reclaimDistance)
      const dispOk = triggerBar.close > swingLow || triggerBodyRatio >= settings.minBodyToRangeRatio || getBarBodyRatio(bullishConfirmation) >= settings.minBodyToRangeRatio
      if (!reclaimOk || !dispOk) continue
      const entryPrice = bullishConfirmation.close
      const extreme = Math.min(...confirmationBars.map((b) => b.low))
      const barsSinceSignal = recent.indexOf(bullishConfirmation) - triggerIndex
      const { stopPrice, targetPrice } = computeStopsTargets({ side: 'buy', entryPrice, extremePrice: extreme, settings })
      return classifyBasicCandidate({ symbol, side: 'buy', timeframe: settings.timeframe, triggerBar, confirmationBar: bullishConfirmation, entryPrice, stopPrice, targetPrice, reason: `Sweep+reclaim buy below ${round(swingLow, 2)}`, metrics: { strategy: 'sweep_reclaim', swingLow: round(swingLow, 2), sweepDistance: round(buySweepDistance, 2) }, barsSinceSignal, settings })
    }

    if (sellSweepDistance >= minSweepDistance && bearishConfirmation) {
      const reclaimOk = !reclaimDistance || bearishConfirmation.close <= (swingHigh - reclaimDistance)
      const dispOk = triggerBar.close < swingHigh || triggerBodyRatio >= settings.minBodyToRangeRatio || getBarBodyRatio(bearishConfirmation) >= settings.minBodyToRangeRatio
      if (!reclaimOk || !dispOk) continue
      const entryPrice = bearishConfirmation.close
      const extreme = Math.max(...confirmationBars.map((b) => b.high))
      const barsSinceSignal = recent.indexOf(bearishConfirmation) - triggerIndex
      const { stopPrice, targetPrice } = computeStopsTargets({ side: 'sell', entryPrice, extremePrice: extreme, settings })
      return classifyBasicCandidate({ symbol, side: 'sell', timeframe: settings.timeframe, triggerBar, confirmationBar: bearishConfirmation, entryPrice, stopPrice, targetPrice, reason: `Sweep+reclaim sell above ${round(swingHigh, 2)}`, metrics: { strategy: 'sweep_reclaim', swingHigh: round(swingHigh, 2), sweepDistance: round(sellSweepDistance, 2) }, barsSinceSignal, settings })
    }
  }
  return { status: 'blocked', symbol, reason: `No qualifying sweep+reclaim in last ${signalWindowBars} bar(s).` }
}

// Strategy B: Breakout acceptance
function signalBreakoutAcceptance({ symbol, bars, settings }) {
  if (!Array.isArray(bars) || bars.length < Math.max(6, settings.lookbackBars)) {
    return { status: 'skipped', symbol, reason: 'Not enough bars yet.' }
  }
  const recent = bars.slice(-settings.lookbackBars)
  const atr = averageTrueRange(recent, 14)
  const vwaps = cumulativeVwap(recent)
  const closes = recent.map((b) => b.close)
  const sma20 = simpleMovingAverage(closes, 20)
  const confirmLookahead = Math.min(3, Math.max(1, settings.signalWindowBars || 1))
  const signalWindowBars = Math.max(1, Math.min(settings.signalWindowBars || 1, recent.length - 1))
  const startIndex = Math.max(5, recent.length - signalWindowBars)
  const minSweepPercent = isEtfSymbol(symbol) ? (settings.etfMinSweepPercent || settings.minSweepPercent) : settings.minSweepPercent
  const acceptMult = Number(settings.reclaimAtrMultiplier || 0)
  const acceptDistance = acceptMult > 0 && atr ? atr * acceptMult : 0

  for (let triggerIndex = recent.length - 1; triggerIndex >= startIndex; triggerIndex -= 1) {
    const triggerBar = recent[triggerIndex]
    const previousBars = recent.slice(0, triggerIndex)
    if (previousBars.length < 5) continue

    const swingHigh = Math.max(...previousBars.map((b) => b.high))
    const swingLow = Math.min(...previousBars.map((b) => b.low))
    const minSweepDistance = triggerBar.close * (minSweepPercent / 100)
    const buyBreakDistance = triggerBar.high - swingHigh
    const sellBreakDistance = swingLow - triggerBar.low
    const confirmationBars = recent.slice(triggerIndex, Math.min(recent.length, triggerIndex + confirmLookahead + 1))
    const confirmVwap = vwaps[Math.min(recent.length - 1, triggerIndex + 1)]

    const longConfirm = confirmationBars.find((bar) => bar.close > swingHigh && getBarBodyRatio(bar) >= settings.confirmationBodyToRangeRatio)
    if (buyBreakDistance >= minSweepDistance && longConfirm) {
      const acceptOk = !acceptDistance || longConfirm.close >= (swingHigh + acceptDistance)
      const trendOk = sma20 && longConfirm.close > confirmVwap && longConfirm.close > sma20
      if (!acceptOk || !trendOk) continue
      const entryPrice = longConfirm.close
      const extreme = Math.min(...confirmationBars.map((b) => b.low))
      const barsSinceSignal = recent.indexOf(longConfirm) - triggerIndex
      const { stopPrice, targetPrice } = computeStopsTargets({ side: 'buy', entryPrice, extremePrice: extreme, settings })
      return classifyBasicCandidate({ symbol, side: 'buy', timeframe: settings.timeframe, triggerBar, confirmationBar: longConfirm, entryPrice, stopPrice, targetPrice, reason: `Acceptance breakout buy above ${round(swingHigh, 2)}`, metrics: { strategy: 'breakout_accept', swingHigh: round(swingHigh, 2), breakDistance: round(buyBreakDistance, 2) }, barsSinceSignal, settings })
    }

    const shortConfirm = confirmationBars.find((bar) => bar.close < swingLow && getBarBodyRatio(bar) >= settings.confirmationBodyToRangeRatio)
    if (sellBreakDistance >= minSweepDistance && shortConfirm) {
      const acceptOk = !acceptDistance || shortConfirm.close <= (swingLow - acceptDistance)
      const trendOk = sma20 && shortConfirm.close < confirmVwap && shortConfirm.close < sma20
      if (!acceptOk || !trendOk) continue
      const entryPrice = shortConfirm.close
      const extreme = Math.max(...confirmationBars.map((b) => b.high))
      const barsSinceSignal = recent.indexOf(shortConfirm) - triggerIndex
      const { stopPrice, targetPrice } = computeStopsTargets({ side: 'sell', entryPrice, extremePrice: extreme, settings })
      return classifyBasicCandidate({ symbol, side: 'sell', timeframe: settings.timeframe, triggerBar, confirmationBar: shortConfirm, entryPrice, stopPrice, targetPrice, reason: `Acceptance breakdown sell below ${round(swingLow, 2)}`, metrics: { strategy: 'breakout_accept', swingLow: round(swingLow, 2), breakDistance: round(sellBreakDistance, 2) }, barsSinceSignal, settings })
    }
  }
  return { status: 'blocked', symbol, reason: `No qualifying acceptance breakout in last ${signalWindowBars} bar(s).` }
}

// Strategy C: ORB
// FIX: compute ET offset properly accounting for US DST instead of hardcoding UTC 14:30.
export function getEtOffset(date) {
  const year = date.getUTCFullYear()
  const marchFirst = new Date(Date.UTC(year, 2, 1))
  const dstStart = Date.UTC(year, 2, 8 + ((7 - marchFirst.getUTCDay()) % 7), 7)
  const novFirst = new Date(Date.UTC(year, 10, 1))
  const dstEnd = Date.UTC(year, 10, 1 + ((7 - novFirst.getUTCDay()) % 7), 6)
  return date.getTime() >= dstStart && date.getTime() < dstEnd ? -4 : -5
}

function signalORB({ symbol, bars, settings }) {
  if (!Array.isArray(bars) || bars.length < 8) {
    return { status: 'skipped', symbol, reason: 'Not enough bars yet.' }
  }
  const lastBar = bars[bars.length - 1]
  const lastDate = new Date(lastBar.timestamp)
  const etOffset = getEtOffset(lastDate)
  const openHourUtc = 9.5 - etOffset
  const closeHourUtc = 16 - etOffset
  const y = lastDate.getUTCFullYear()
  const m = lastDate.getUTCMonth()
  const d = lastDate.getUTCDate()
  const openUtc = Date.UTC(y, m, d, Math.floor(openHourUtc), (openHourUtc % 1) * 60, 0)
  const closeUtc = Date.UTC(y, m, d, Math.floor(closeHourUtc), 0, 0)

  const dayBars = bars.filter((b) => {
    const t = new Date(b.timestamp).getTime()
    return t >= openUtc && t <= closeUtc
  })
  if (dayBars.length < 6) return { status: 'skipped', symbol, reason: 'Not enough intraday bars for ORB.' }

  const orBars = dayBars.slice(0, 4)
  const orHigh = Math.max(...orBars.map((b) => b.high))
  const orLow = Math.min(...orBars.map((b) => b.low))
  const last = dayBars[dayBars.length - 1]
  const bodyOk = getBarBodyRatio(last) >= settings.confirmationBodyToRangeRatio

  if (last.close > orHigh && bodyOk) {
    const { stopPrice, targetPrice } = computeStopsTargets({ side: 'buy', entryPrice: last.close, extremePrice: orLow, settings })
    return classifyBasicCandidate({ symbol, side: 'buy', timeframe: settings.timeframe, triggerBar: orBars[orBars.length - 1], confirmationBar: last, entryPrice: last.close, stopPrice, targetPrice, reason: `ORB breakout buy above ${round(orHigh, 2)}`, metrics: { strategy: 'orb', orHigh: round(orHigh, 2), orLow: round(orLow, 2) } })
  }
  if (last.close < orLow && bodyOk) {
    const { stopPrice, targetPrice } = computeStopsTargets({ side: 'sell', entryPrice: last.close, extremePrice: orHigh, settings })
    return classifyBasicCandidate({ symbol, side: 'sell', timeframe: settings.timeframe, triggerBar: orBars[orBars.length - 1], confirmationBar: last, entryPrice: last.close, stopPrice, targetPrice, reason: `ORB breakdown sell below ${round(orLow, 2)}`, metrics: { strategy: 'orb', orHigh: round(orHigh, 2), orLow: round(orLow, 2) } })
  }
  return { status: 'blocked', symbol, reason: 'No ORB breakout on latest bar.' }
}

// Strategy D: VWAP pullback
function signalVwapPullback({ symbol, bars, settings }) {
  if (!Array.isArray(bars) || bars.length < Math.max(20, settings.lookbackBars)) {
    return { status: 'skipped', symbol, reason: 'Not enough bars yet.' }
  }
  const recent = bars.slice(-Math.max(settings.lookbackBars, 30))
  const vwaps = cumulativeVwap(recent)
  const sma20 = simpleMovingAverage(recent.map((b) => b.close), 20)
  if (!sma20) return { status: 'skipped', symbol, reason: 'Not enough bars for SMA.' }

  const last = recent[recent.length - 1]
  const prev = recent[recent.length - 2]
  const lastVwap = vwaps[vwaps.length - 1]
  const prevVwap = vwaps[vwaps.length - 2]
  const pullbackWindow = recent.slice(-4)
  const bodyOk = getBarBodyRatio(last) >= settings.confirmationBodyToRangeRatio

  if (last.close > lastVwap && last.close > sma20 && lastVwap > prevVwap &&
    pullbackWindow.some((b) => b.low <= lastVwap) && last.close > last.open && bodyOk) {
    const extreme = Math.min(...pullbackWindow.map((b) => b.low))
    const { stopPrice, targetPrice } = computeStopsTargets({ side: 'buy', entryPrice: last.close, extremePrice: extreme, settings })
    return classifyBasicCandidate({ symbol, side: 'buy', timeframe: settings.timeframe, triggerBar: prev, confirmationBar: last, entryPrice: last.close, stopPrice, targetPrice, reason: `VWAP pullback buy reclaiming session VWAP ${round(lastVwap, 2)}`, metrics: { strategy: 'vwap_pullback', vwap: round(lastVwap, 2), sma20: round(sma20, 2) } })
  }
  if (last.close < lastVwap && last.close < sma20 && lastVwap < prevVwap &&
    pullbackWindow.some((b) => b.high >= lastVwap) && last.close < last.open && bodyOk) {
    const extreme = Math.max(...pullbackWindow.map((b) => b.high))
    const { stopPrice, targetPrice } = computeStopsTargets({ side: 'sell', entryPrice: last.close, extremePrice: extreme, settings })
    return classifyBasicCandidate({ symbol, side: 'sell', timeframe: settings.timeframe, triggerBar: prev, confirmationBar: last, entryPrice: last.close, stopPrice, targetPrice, reason: `VWAP pullback sell rejecting session VWAP ${round(lastVwap, 2)}`, metrics: { strategy: 'vwap_pullback', vwap: round(lastVwap, 2), sma20: round(sma20, 2) } })
  }
  return { status: 'blocked', symbol, reason: 'No qualifying VWAP pullback.' }
}

function getSignalFn(strategyId) {
  if (strategyId === 'sweep_reclaim') return signalSweepReclaim
  if (strategyId === 'breakout_accept') return signalBreakoutAcceptance
  if (strategyId === 'orb') return signalORB
  if (strategyId === 'vwap_pullback') return signalVwapPullback
  throw new Error(`Unknown strategy: ${strategyId}`)
}

export { getSignalFn }
