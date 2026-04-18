import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import crypto from 'crypto';
import dotenv from 'dotenv';
import Alpaca from '@alpacahq/alpaca-trade-api';
import { z } from 'zod';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const journalPath = path.join(dataDir, 'journal.json');
const settingsPath = path.join(dataDir, 'settings.json');

const app = express();
const port = Number(process.env.PORT || 3000);
const defaultWatchlist = ['SPY', 'QQQ', 'AAPL', 'NVDA', 'TSLA', 'MSFT'];

app.set('view engine', 'ejs');
app.set('views', path.join(rootDir, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(rootDir, 'public')));

const checklistItems = [
  'Mark higher-timeframe liquidity levels before the session starts.',
  'Wait for price to sweep a recent high or low into a clear liquidity pool.',
  'Confirm displacement away from the sweep, not just a wick.',
  'Look for structure shift or rejection that supports the intended direction.',
  'Define invalidation beyond the sweep, and keep risk per trade capped.',
  'Paper-trade only. No live orders from this app.',
];

const journalEntrySchema = z.object({
  symbol: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  thesis: z.string().min(5),
  liquidityLevel: z.string().min(1),
  displacementSeen: z.string().optional().default(''),
  structureShiftSeen: z.string().optional().default(''),
  stopPrice: z.coerce.number().positive(),
  targetPrice: z.coerce.number().positive(),
  notes: z.string().optional().default(''),
  checklistScore: z.coerce.number().min(0).max(6),
});

const orderSchema = z.object({
  symbol: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  qty: z.coerce.number().positive(),
  type: z.enum(['market', 'limit']),
  limitPrice: z.union([z.coerce.number().positive(), z.literal(''), z.nan()]).optional(),
  timeInForce: z.enum(['day', 'gtc']).default('day'),
});

function alpacaClient() {
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) return null;
  return new Alpaca({
    keyId: process.env.ALPACA_API_KEY,
    secretKey: process.env.ALPACA_SECRET_KEY,
    paper: true,
    usePolygon: false,
  });
}

async function ensureDataFiles() {
  await fs.mkdir(dataDir, { recursive: true });
  try { await fs.access(journalPath); } catch { await fs.writeFile(journalPath, '[]'); }
  try { await fs.access(settingsPath); } catch { await fs.writeFile(settingsPath, JSON.stringify({ watchlist: defaultWatchlist }, null, 2)); }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function getDashboardData() {
  const journal = await readJson(journalPath, []);
  const settings = await readJson(settingsPath, { watchlist: defaultWatchlist });
  const alpaca = alpacaClient();

  const state = {
    credsConfigured: Boolean(alpaca),
    paperOnly: true,
    account: null,
    positions: [],
    orders: [],
    watchQuotes: [],
    errors: [],
    journal,
    watchlist: settings.watchlist?.length ? settings.watchlist : defaultWatchlist,
  };

  if (!alpaca) return state;

  try {
    const [account, positions, orders, quotes] = await Promise.all([
      alpaca.getAccount(),
      alpaca.getPositions(),
      alpaca.getOrders({ status: 'open', direction: 'desc' }),
      Promise.all(state.watchlist.map(async (symbol) => {
        try {
          const quote = await alpaca.getLatestQuote(symbol);
          const trade = await alpaca.getLatestTrade(symbol);
          return {
            symbol,
            bid: Number(quote.BidPrice || 0),
            ask: Number(quote.AskPrice || 0),
            last: Number(trade.Price || 0),
            timestamp: trade.Timestamp || quote.Timestamp,
          };
        } catch (error) {
          return { symbol, error: error.message };
        }
      })),
    ]);

    state.account = account;
    state.positions = positions;
    state.orders = orders;
    state.watchQuotes = quotes;
  } catch (error) {
    state.errors.push(error.message);
  }

  return state;
}

app.get('/', async (req, res) => {
  await ensureDataFiles();
  const data = await getDashboardData();
  res.render('index', {
    ...data,
    checklistItems,
    success: req.query.success,
    error: req.query.error,
  });
});

app.post('/watchlist', async (req, res) => {
  await ensureDataFiles();
  const watchlist = String(req.body.watchlist || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 15);

  await writeJson(settingsPath, { watchlist: watchlist.length ? [...new Set(watchlist)] : defaultWatchlist });
  res.redirect('/?success=Watchlist updated');
});

app.post('/journal', async (req, res) => {
  await ensureDataFiles();
  const parsed = journalEntrySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.redirect(`/?error=${encodeURIComponent(parsed.error.issues[0].message)}`);
  }

  const journal = await readJson(journalPath, []);
  journal.unshift({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...parsed.data });
  await writeJson(journalPath, journal.slice(0, 100));
  res.redirect('/?success=Journal entry saved');
});

app.post('/order', async (req, res) => {
  const alpaca = alpacaClient();
  if (!alpaca) return res.redirect('/?error=Missing Alpaca paper credentials');

  const parsed = orderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.redirect(`/?error=${encodeURIComponent(parsed.error.issues[0].message)}`);
  }

  try {
    const order = parsed.data;
    const payload = {
      symbol: order.symbol.toUpperCase(),
      side: order.side,
      qty: order.qty,
      type: order.type,
      time_in_force: order.timeInForce,
    };

    if (order.type === 'limit') {
      if (!Number.isFinite(Number(order.limitPrice))) {
        return res.redirect('/?error=Limit price is required for limit orders');
      }
      payload.limit_price = Number(order.limitPrice);
    }

    await alpaca.createOrder(payload);
    return res.redirect('/?success=Paper order submitted');
  } catch (error) {
    return res.redirect(`/?error=${encodeURIComponent(error.message)}`);
  }
});

app.listen(port, () => {
  console.log(`alpaca-strategy-lab running on http://localhost:${port}`);
});
