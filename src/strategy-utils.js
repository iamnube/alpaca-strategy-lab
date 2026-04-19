function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null
  return Number(value.toFixed(digits))
}

function isEtfSymbol(symbol) {
  return ['SPY', 'QQQ', 'IWM', 'DIA', 'XLF', 'XLE', 'XLK', 'SMH', 'SOXX', 'ARKK', 'EEM', 'EFA', 'EWJ', 'VXUS'].includes(String(symbol || '').toUpperCase())
}

function getBarBodyRatio(bar) {
  const range = bar.high - bar.low
  if (!(range > 0)) return 0
  return Math.abs(bar.close - bar.open) / range
}

function averageTrueRange(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < 2) return null
  const p = Math.max(2, Math.min(period, bars.length - 1))
  const slice = bars.slice(-1 - p)
  const trs = []
  for (let i = 1; i < slice.length; i += 1) {
    const prev = slice[i - 1]
    const cur = slice[i]
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    )
    trs.push(tr)
  }
  const sum = trs.reduce((acc, v) => acc + v, 0)
  return sum / trs.length
}

export { round, isEtfSymbol, getBarBodyRatio, averageTrueRange }

