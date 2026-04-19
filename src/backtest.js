import fs from 'node:fs/promises'
import path from 'node:path'
import { evaluateLiquiditySweep, normalizeAutomationSettings, isEtfSymbol } from './automation.js'

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const value = argv[i + 1]
    if (value && !value.startsWith('--')) {
      out[key] = value
      i += 1
    } else {
      out[key] = true
    }
  }
  return out
}

function toDate(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null
  return Number(value.toFixed(digits))
}

function outcomeForCandidate({ side, entryPrice: _entryPrice, stopPrice, targetPrice, futureBars }) {
  for (const bar of futureBars) {
    if (side === 'buy') {
      const hitStop = bar.low <= stopPrice
      const hitTarget = bar.high >= targetPrice
      if (hitStop && hitTarget) return { outcome: 'ambiguous', at: bar.timestamp }
      if (hitStop) return { outcome: 'stop', at: bar.timestamp }
      if (hitTarget) return { outcome: 'target', at: bar.timestamp }
    } else {
      const hitStop = bar.high >= stopPrice
      const hitTarget = bar.low <= targetPrice
      if (hitStop && hitTarget) return { outcome: 'ambiguous', at: bar.timestamp }
      if (hitStop) return { outcome: 'stop', at: bar.timestamp }
      if (hitTarget) return { outcome: 'target', at: bar.timestamp }
    }
  }
  return { outcome: 'open', at: null }
}

function outcomeUsingCloseOnly({ side, stopPrice, targetPrice, futureBars }) {
  for (const bar of futureBars) {
    if (side === 'buy') {
      if (bar.close <= stopPrice) return { outcome: 'stop', at: bar.timestamp }
      if (bar.close >= targetPrice) return { outcome: 'target', at: bar.timestamp }
    } else {
      if (bar.close >= stopPrice) return { outcome: 'stop', at: bar.timestamp }
      if (bar.close <= targetPrice) return { outcome: 'target', at: bar.timestamp }
    }
  }
  return { outcome: 'open', at: null }
}

function rMultiple({ side, entryPrice, stopPrice, exitPrice }) {
  const risk = side === 'buy' ? entryPrice - stopPrice : stopPrice - entryPrice
  if (!(risk > 0)) return null
  const pnl = side === 'buy' ? exitPrice - entryPrice : entryPrice - exitPrice
  return pnl / risk
}

function parseBarsFromFile(raw) {
  const data = JSON.parse(raw)
  const bars = Array.isArray(data) ? data : Array.isArray(data?.bars) ? data.bars : []
  return bars
    .map((bar) => ({
      timestamp: bar.timestamp || bar.t || bar.Timestamp,
      open: Number(bar.open ?? bar.o ?? bar.OpenPrice),
      high: Number(bar.high ?? bar.h ?? bar.HighPrice),
      low: Number(bar.low ?? bar.l ?? bar.LowPrice),
      close: Number(bar.close ?? bar.c ?? bar.ClosePrice),
      volume: Number(bar.volume ?? bar.v ?? bar.Volume ?? 0),
    }))
    .filter((bar) => bar.timestamp && Number.isFinite(bar.open) && Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
}

async function loadBars({ dataDir, symbol }) {
  const filePath = path.join(dataDir, `${symbol}.json`)
  const raw = await fs.readFile(filePath, 'utf8')
  return parseBarsFromFile(raw)
}

function sliceByDate(bars, start, end) {
  return bars.filter((bar) => {
    const t = new Date(bar.timestamp).getTime()
    if (start && t < start.getTime()) return false
    if (end && t > end.getTime()) return false
    return true
  })
}

function backtestSymbol({ symbol, bars, settings, lookaheadBars = 12, fillModel = 'touch' }) {
  const results = []
  const minWindow = Math.max(6, settings.lookbackBars)

  for (let i = minWindow; i < bars.length; i += 1) {
    const windowBars = bars.slice(0, i + 1)
    const evalResult = evaluateLiquiditySweep({ symbol, bars: windowBars, settings })
    if (evalResult?.status !== 'candidate') continue

    const confirmationTs = evalResult.confirmationBar?.timestamp
    if (!confirmationTs) continue
    if (results.length && results[results.length - 1].confirmationTs === confirmationTs) continue

    const future = bars.slice(i + 1, i + 1 + lookaheadBars)
    const outcome = fillModel === 'close'
      ? outcomeUsingCloseOnly({
        side: evalResult.side,
        stopPrice: evalResult.stopPrice,
        targetPrice: evalResult.targetPrice,
        futureBars: future,
      })
      : outcomeForCandidate({
        side: evalResult.side,
        entryPrice: evalResult.entryPrice,
        stopPrice: evalResult.stopPrice,
        targetPrice: evalResult.targetPrice,
        futureBars: future,
      })

    let exitPrice = null
    if (outcome.outcome === 'stop') exitPrice = evalResult.stopPrice
    if (outcome.outcome === 'target') exitPrice = evalResult.targetPrice
    const r = exitPrice != null ? rMultiple({ side: evalResult.side, entryPrice: evalResult.entryPrice, stopPrice: evalResult.stopPrice, exitPrice }) : null

      results.push({
      symbol,
      side: evalResult.side,
      confirmationTs,
      entryPrice: evalResult.entryPrice,
      stopPrice: evalResult.stopPrice,
      targetPrice: evalResult.targetPrice,
      lookaheadBars,
      fillModel,
      outcome: outcome.outcome,
      outcomeAt: outcome.at,
      rMultiple: r != null ? round(r, 3) : null,
      metrics: evalResult.metrics,
    })
  }

  return results
}

function summarize(trades) {
  const counts = trades.reduce((acc, t) => {
    acc[t.outcome] = (acc[t.outcome] || 0) + 1
    return acc
  }, {})

  const closed = trades.filter((t) => t.outcome === 'stop' || t.outcome === 'target')
  const wins = closed.filter((t) => t.outcome === 'target')
  const winRate = closed.length ? wins.length / closed.length : 0
  const avgR = closed.length ? closed.reduce((s, t) => s + (t.rMultiple ?? 0), 0) / closed.length : 0

  const bySymbol = {}
  for (const t of trades) {
    bySymbol[t.symbol] = bySymbol[t.symbol] || { total: 0, target: 0, stop: 0, open: 0, ambiguous: 0 }
    bySymbol[t.symbol].total += 1
    bySymbol[t.symbol][t.outcome] = (bySymbol[t.symbol][t.outcome] || 0) + 1
  }

  return {
    totals: {
      trades: trades.length,
      closed: closed.length,
      winRate: round(winRate, 3),
      avgR: round(avgR, 3),
      outcomes: counts,
    },
    bySymbol,
  }
}

async function main() {
  const args = parseArgs(process.argv)

  const dataDir = String(args.dataDir || 'backtest-data')
  const symbols = String(args.symbols || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  const start = toDate(args.from)
  const end = toDate(args.to)
  const lookaheadBars = args.lookaheadBars ? Number(args.lookaheadBars) : 12
  const fillModel = String(args.fillModel || 'touch')
  if (!['touch', 'close'].includes(fillModel)) {
    console.error("Unsupported --fillModel. Use 'touch' or 'close'.")
    process.exit(2)
  }

  if (!symbols.length) {
    console.error('Missing --symbols. Example: --symbols AAPL,MSFT,NVDA')
    process.exit(2)
  }

  const settings = normalizeAutomationSettings({})

  // Override any defaults with backtest CLI parameters (falls back to current strategy defaults).
  settings.minSweepPercent = args.minSweepPercent ? Number(args.minSweepPercent) : 0.03
  settings.etfMinSweepPercent = args.etfMinSweepPercent ? Number(args.etfMinSweepPercent) : 0.02
  settings.timeframe = String(args.timeframe || '15Min')
  settings.lookbackBars = args.lookbackBars ? Number(args.lookbackBars) : 24
  settings.signalWindowBars = args.signalWindowBars ? Number(args.signalWindowBars) : 3
  settings.minBodyToRangeRatio = args.minBodyToRangeRatio ? Number(args.minBodyToRangeRatio) : 0.18
  settings.confirmationBodyToRangeRatio = args.confirmationBodyToRangeRatio ? Number(args.confirmationBodyToRangeRatio) : 0.15
  settings.rewardToRisk = args.rewardToRisk ? Number(args.rewardToRisk) : 1.8
  settings.stopBufferPercent = args.stopBufferPercent ? Number(args.stopBufferPercent) : 0.1
  settings.takeProfitBufferPercent = args.takeProfitBufferPercent ? Number(args.takeProfitBufferPercent) : 0

  // Optional: drop known-bad symbols (comma-separated).
  const excludeSymbols = new Set(String(args.excludeSymbols || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))

  const allTrades = []
  for (const symbol of symbols) {
    if (excludeSymbols.has(symbol)) {
      console.log(`${symbol}: excluded by --excludeSymbols`)
      continue
    }
    const bars = await loadBars({ dataDir, symbol })
    const scoped = sliceByDate(bars, start, end)
    const trades = backtestSymbol({ symbol, bars: scoped, settings, lookaheadBars, fillModel })
    allTrades.push(...trades)
    console.log(`${symbol}: bars=${scoped.length} trades=${trades.length} (etf=${isEtfSymbol(symbol)})`)
  }

  const summary = summarize(allTrades)
  const outPath = path.join('data', 'backtest-results.json')
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  await fs.writeFile(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), args, summary, trades: allTrades }, null, 2))

  console.log('---')
  console.log(`Trades: ${summary.totals.trades} (closed=${summary.totals.closed})`) 
  console.log(`Win rate (closed): ${summary.totals.winRate}`)
  console.log(`Avg R (closed): ${summary.totals.avgR}`)
  console.log(`Outcomes: ${JSON.stringify(summary.totals.outcomes)}`)
  console.log(`Wrote: ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
