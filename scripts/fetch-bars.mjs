import fs from 'node:fs/promises'
import path from 'node:path'
import dotenv from 'dotenv'
import Alpaca from '@alpacahq/alpaca-trade-api'

dotenv.config()

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

function normalizeTimeframe(timeframe, alpaca) {
  if (!timeframe || timeframe === '5Min') return alpaca.newTimeframe(5, alpaca.timeframeUnit.MIN)
  if (timeframe === '15Min') return alpaca.newTimeframe(15, alpaca.timeframeUnit.MIN)
  if (timeframe === '1Hour') return alpaca.newTimeframe(1, alpaca.timeframeUnit.HOUR)
  throw new Error(`Unsupported timeframe: ${timeframe}`)
}

async function collectBars(alpaca, symbol, timeframe, startIso, endIso) {
  const bars = []
  const iterator = alpaca.getBarsV2(symbol, {
    start: startIso,
    end: endIso,
    timeframe: normalizeTimeframe(timeframe, alpaca),
    feed: 'iex',
    limit: 10_000,
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

async function main() {
  const args = parseArgs(process.argv)
  const symbols = String(args.symbols || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  const timeframe = String(args.timeframe || '15Min')
  const start = String(args.from || '')
  const end = String(args.to || '')
  const outDir = String(args.outDir || 'backtest-data')

  if (!symbols.length) {
    console.error('Missing --symbols (comma-separated).')
    process.exit(2)
  }
  if (!start || !end) {
    console.error('Missing --from and/or --to (ISO date like 2026-01-01).')
    process.exit(2)
  }

  const keyId = process.env.ALPACA_KEY_ID
  const secretKey = process.env.ALPACA_SECRET_KEY
  if (!keyId || !secretKey) {
    console.error('Missing ALPACA_KEY_ID / ALPACA_SECRET_KEY in environment (.env).')
    process.exit(2)
  }

  const alpaca = new Alpaca({
    keyId,
    secretKey,
    paper: true,
    feed: 'iex',
  })

  const startIso = new Date(start).toISOString()
  const endIso = new Date(end).toISOString()
  await fs.mkdir(outDir, { recursive: true })

  for (const symbol of symbols) {
    const bars = await collectBars(alpaca, symbol, timeframe, startIso, endIso)
    const filePath = path.join(outDir, `${symbol}.json`)
    await fs.writeFile(filePath, JSON.stringify(bars, null, 2))
    console.log(`${symbol}: wrote ${bars.length} bars -> ${filePath}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

