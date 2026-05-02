import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import Alpaca from '@alpacahq/alpaca-trade-api';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const journalPath = path.join(dataDir, 'journal.json');
const apply = process.argv.includes('--apply');

dotenv.config({ path: path.join(rootDir, '.env') });

function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function plannedR(entry) {
  const risk = Math.abs(Number(entry.entryPrice || 0) - Number(entry.stopPrice || 0));
  const reward = Math.abs(Number(entry.targetPrice || 0) - Number(entry.entryPrice || 0));
  return risk > 0 ? round(reward / risk) : null;
}

function priceMatches(a, b, tolerance = 0.05) {
  return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && Math.abs(Number(a) - Number(b)) <= tolerance;
}

function hoursBetween(a, b) {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / (1000 * 60 * 60);
}

function buildNote(result) {
  if (result.outcome === 'won') return `Reconciled from Alpaca paper orders: target filled ${result.exitOrder?.filled_at || result.exitOrder?.submitted_at || 'unknown time'} (${result.exitOrder?.type || 'limit'} close).`;
  if (result.outcome === 'lost') return `Reconciled from Alpaca paper orders: stop filled ${result.exitOrder?.filled_at || result.exitOrder?.submitted_at || 'unknown time'} (${result.exitOrder?.type || 'stop'} close).`;
  if (result.outcome === 'scratched') return `Reconciled from Alpaca paper orders: position closed via market exit ${result.exitOrder?.filled_at || result.exitOrder?.submitted_at || 'unknown time'}.`;
  if (result.outcome === 'canceled') return `Reconciled from Alpaca paper orders: entry order never filled and was canceled.`;
  return '';
}

const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
  throw new Error('Missing Alpaca paper credentials in .env');
}

const staleCandidates = journal.filter((entry) => ['auto-submitted', 'auto-candidate'].includes(entry.status) && (entry.realizedR === null || entry.realizedR === undefined));
const after = staleCandidates.reduce((min, entry) => {
  if (!entry.createdAt) return min;
  const ts = new Date(entry.createdAt).getTime();
  return Number.isFinite(ts) ? Math.min(min, ts) : min;
}, Date.now());

const alpaca = new Alpaca({
  keyId: process.env.ALPACA_API_KEY,
  secretKey: process.env.ALPACA_SECRET_KEY,
  paper: true,
  usePolygon: false,
});

const orders = await alpaca.getOrders({
  status: 'all',
  direction: 'desc',
  limit: 500,
  after: new Date(after - (24 * 60 * 60 * 1000)).toISOString(),
});

const ordersBySymbol = new Map();
for (const order of orders) {
  const symbol = String(order.symbol || '').toUpperCase();
  if (!ordersBySymbol.has(symbol)) ordersBySymbol.set(symbol, []);
  ordersBySymbol.get(symbol).push(order);
}

const results = [];
let updated = 0;
const updatedJournal = journal.map((entry) => {
  if (!(['auto-submitted', 'auto-candidate'].includes(entry.status) && (entry.realizedR === null || entry.realizedR === undefined))) return entry;

  const symbol = String(entry.symbol || '').toUpperCase();
  const symbolOrders = ordersBySymbol.get(symbol) || [];
  const entryOrders = symbolOrders
    .filter((order) => String(order.position_intent || '').includes('_to_open'))
    .filter((order) => String(order.side || '').toLowerCase() === String(entry.side || '').toLowerCase())
    .filter((order) => priceMatches(order.limit_price, entry.entryPrice) || priceMatches(order.filled_avg_price, entry.entryPrice))
    .filter((order) => hoursBetween(order.submitted_at || order.filled_at, entry.createdAt) <= 36)
    .sort((a, b) => new Date(a.submitted_at || a.filled_at).getTime() - new Date(b.submitted_at || b.filled_at).getTime());

  const filledEntry = entryOrders.find((order) => order.status === 'filled');
  const canceledEntry = entryOrders.find((order) => order.status === 'canceled');

  let result = {
    id: entry.id,
    symbol,
    createdAt: entry.createdAt,
    priorStatus: entry.status,
    entryOrder: filledEntry || canceledEntry || null,
    exitOrder: null,
    outcome: 'unmatched',
    suggestedStatus: null,
    suggestedRealizedR: null,
  };

  if (filledEntry) {
    const exitOrders = symbolOrders
      .filter((order) => String(order.position_intent || '').includes('_to_close'))
      .filter((order) => new Date(order.submitted_at || order.filled_at).getTime() >= new Date(filledEntry.filled_at || filledEntry.submitted_at).getTime())
      .sort((a, b) => new Date(a.submitted_at || a.filled_at).getTime() - new Date(b.submitted_at || b.filled_at).getTime());

    const filledExit = exitOrders.find((order) => order.status === 'filled');
    result.exitOrder = filledExit || null;

    if (filledExit?.type === 'limit') {
      result.outcome = 'won';
      result.suggestedStatus = 'won';
      result.suggestedRealizedR = plannedR(entry);
    } else if (filledExit?.type === 'stop') {
      result.outcome = 'lost';
      result.suggestedStatus = 'lost';
      result.suggestedRealizedR = -1;
    } else if (filledExit?.type === 'market') {
      result.outcome = 'scratched';
      result.suggestedStatus = 'scratched';
      result.suggestedRealizedR = 0;
    } else if (exitOrders.some((order) => ['new', 'accepted', 'pending_new'].includes(order.status))) {
      result.outcome = 'open';
    } else {
      result.outcome = 'filled_no_exit_match';
    }
  } else if (canceledEntry) {
    result.outcome = 'canceled';
    result.suggestedStatus = 'canceled';
    result.suggestedRealizedR = 0;
  } else if (entry.status === 'auto-candidate') {
    result.outcome = 'no_order_match';
    result.suggestedStatus = 'canceled';
    result.suggestedRealizedR = 0;
  }

  results.push(result);

  if (!apply || !result.suggestedStatus) return entry;

  updated += 1;
  const note = result.outcome === 'no_order_match'
    ? 'Marked stale automation candidate as canceled: no matching Alpaca paper entry order was found.'
    : buildNote(result);
  return {
    ...entry,
    status: result.suggestedStatus,
    realizedR: result.suggestedRealizedR,
    outcomeNotes: entry.outcomeNotes ? `${entry.outcomeNotes} | ${note}` : note,
  };
});

console.log(`Reconciled candidates: ${results.length}`);
for (const result of results) {
  console.log(JSON.stringify({
    symbol: result.symbol,
    createdAt: result.createdAt,
    outcome: result.outcome,
    suggestedStatus: result.suggestedStatus,
    suggestedRealizedR: result.suggestedRealizedR,
    entrySubmittedAt: result.entryOrder?.submitted_at || null,
    exitFilledAt: result.exitOrder?.filled_at || null,
  }));
}

if (apply) {
  await fs.writeFile(journalPath, `${JSON.stringify(updatedJournal, null, 2)}\n`);
  console.log(`Updated journal entries: ${updated}`);
} else {
  console.log('Dry run only. Re-run with --apply to write suggested reviews into data/journal.json');
}
