import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import crypto from 'crypto';
import Alpaca from '@alpacahq/alpaca-trade-api';
import { z } from 'zod';
import {
  automationDefaults,
  createAutomationEngine,
  normalizeAutomationSettings,
  normalizeAutomationStatus,
  runAutomationCycle,
} from './automation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const defaultWatchlist = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL',
  'META', 'AVGO', 'JPM', 'V', 'MA',
  'LLY', 'JNJ', 'XOM', 'CVX', 'CAT',
  'GE', 'UNH', 'HD', 'COST', 'WMT',
  'VXUS', 'EFA', 'EWJ', 'EEM',
];
const maxJournalEntries = 200;

const checklistItems = [
  'Mark higher-timeframe liquidity levels before the session starts.',
  'Wait for price to sweep a recent high or low into a clear liquidity pool.',
  'Confirm displacement away from the sweep, not just a wick.',
  'Look for structure shift or rejection that supports the intended direction.',
  'Define invalidation beyond the sweep, and keep risk per trade capped.',
  'Paper-trade only. No live orders from this app.',
];

const journalStatusOptions = ['planned', 'submitted', 'open', 'won', 'lost', 'scratched', 'canceled', 'auto-candidate', 'auto-submitted'];
const automationTimeframes = ['5Min', '15Min', '1Hour'];

const journalEntrySchema = z.object({
  symbol: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  thesis: z.string().min(5),
  liquidityLevel: z.string().min(1),
  displacementSeen: z.string().optional().default(''),
  structureShiftSeen: z.string().optional().default(''),
  entryPrice: z.coerce.number().positive(),
  stopPrice: z.coerce.number().positive(),
  targetPrice: z.coerce.number().positive(),
  riskAmount: z.union([z.coerce.number().positive(), z.literal(''), z.nan()]).optional(),
  plannedQty: z.union([z.coerce.number().positive(), z.literal(''), z.nan()]).optional(),
  checklistScore: z.coerce.number().min(0).max(6),
  status: z.enum(journalStatusOptions).default('planned'),
  notes: z.string().optional().default(''),
}).superRefine((entry, ctx) => {
  if (entry.side === 'buy') {
    if (entry.stopPrice >= entry.entryPrice) ctx.addIssue({ code: 'custom', path: ['stopPrice'], message: 'For buy setups, stop must stay below entry.' });
    if (entry.targetPrice <= entry.entryPrice) ctx.addIssue({ code: 'custom', path: ['targetPrice'], message: 'For buy setups, target must stay above entry.' });
  }

  if (entry.side === 'sell') {
    if (entry.stopPrice <= entry.entryPrice) ctx.addIssue({ code: 'custom', path: ['stopPrice'], message: 'For sell setups, stop must stay above entry.' });
    if (entry.targetPrice >= entry.entryPrice) ctx.addIssue({ code: 'custom', path: ['targetPrice'], message: 'For sell setups, target must stay below entry.' });
  }
});

const journalReviewSchema = z.object({
  status: z.enum(journalStatusOptions),
  realizedR: z.union([z.coerce.number(), z.literal(''), z.nan()]).optional(),
  outcomeNotes: z.string().optional().default(''),
});

const orderSchema = z.object({
  symbol: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  qty: z.coerce.number().positive(),
  type: z.enum(['market', 'limit']),
  limitPrice: z.union([z.coerce.number().positive(), z.literal(''), z.nan()]).optional(),
  timeInForce: z.enum(['day', 'gtc']).default('day'),
  useBracket: z.string().optional(),
  takeProfitPrice: z.union([z.coerce.number().positive(), z.literal(''), z.nan()]).optional(),
  stopLossPrice: z.union([z.coerce.number().positive(), z.literal(''), z.nan()]).optional(),
}).superRefine((order, ctx) => {
  if (order.type === 'limit') {
    const normalizedLimitPrice = Number(order.limitPrice);
    if (order.limitPrice === '' || !Number.isFinite(normalizedLimitPrice) || normalizedLimitPrice <= 0) {
      ctx.addIssue({ code: 'custom', path: ['limitPrice'], message: 'Limit price is required for limit orders' });
    }
  }

  if (order.useBracket) {
    const takeProfit = Number(order.takeProfitPrice);
    const stopLoss = Number(order.stopLossPrice);

    if (!Number.isFinite(takeProfit) || takeProfit <= 0) ctx.addIssue({ code: 'custom', path: ['takeProfitPrice'], message: 'Take-profit price is required for bracket orders.' });
    if (!Number.isFinite(stopLoss) || stopLoss <= 0) ctx.addIssue({ code: 'custom', path: ['stopLossPrice'], message: 'Stop-loss price is required for bracket orders.' });
  }
});

const plannerSchema = z.object({
  symbol: z.string().optional().default(''),
  side: z.enum(['buy', 'sell']),
  entryPrice: z.coerce.number().positive(),
  stopPrice: z.coerce.number().positive(),
  targetPrice: z.coerce.number().positive(),
  riskAmount: z.coerce.number().positive(),
}).superRefine((plan, ctx) => {
  if (plan.side === 'buy') {
    if (plan.stopPrice >= plan.entryPrice) ctx.addIssue({ code: 'custom', path: ['stopPrice'], message: 'For buy setups, stop must stay below entry.' });
    if (plan.targetPrice <= plan.entryPrice) ctx.addIssue({ code: 'custom', path: ['targetPrice'], message: 'For buy setups, target must stay above entry.' });
  }

  if (plan.side === 'sell') {
    if (plan.stopPrice <= plan.entryPrice) ctx.addIssue({ code: 'custom', path: ['stopPrice'], message: 'For sell setups, stop must stay above entry.' });
    if (plan.targetPrice >= plan.entryPrice) ctx.addIssue({ code: 'custom', path: ['targetPrice'], message: 'For sell setups, target must stay below entry.' });
  }
});

const automationSettingsSchema = z.object({
  enabled: z.string().optional(),
  autoSubmit: z.string().optional(),
  rotateWatchlist: z.string().optional(),
  pollIntervalSeconds: z.coerce.number().min(60).max(3600),
  timeframe: z.enum(automationTimeframes),
  lookbackBars: z.coerce.number().min(6).max(100),
  signalWindowBars: z.coerce.number().min(1).max(5),
  minSweepPercent: z.coerce.number().min(0.01).max(5),
  etfMinSweepPercent: z.coerce.number().min(0.01).max(5),
  minBodyToRangeRatio: z.coerce.number().min(0.05).max(1),
  confirmationBodyToRangeRatio: z.coerce.number().min(0.05).max(1),
  rewardToRisk: z.coerce.number().min(1).max(10),
  maxOpenPositions: z.coerce.number().min(1).max(20),
  maxConcurrentOrdersPerSymbol: z.coerce.number().min(1).max(5),
  maxWatchlistSymbols: z.coerce.number().min(1).max(30),
  symbolsPerCycle: z.coerce.number().min(1).max(30),
  riskPerTrade: z.coerce.number().min(1).max(10000),
  stopBufferPercent: z.coerce.number().min(0).max(5),
  takeProfitBufferPercent: z.coerce.number().min(0).max(5),
  minimumPrice: z.coerce.number().min(0.01).max(10000),
  maximumPrice: z.coerce.number().min(1).max(100000),
}).superRefine((settings, ctx) => {
  if (settings.maximumPrice <= settings.minimumPrice) {
    ctx.addIssue({ code: 'custom', path: ['maximumPrice'], message: 'Maximum price must be above minimum price.' });
  }

  if (settings.symbolsPerCycle > settings.maxWatchlistSymbols) {
    ctx.addIssue({ code: 'custom', path: ['symbolsPerCycle'], message: 'Symbols per cycle cannot exceed the watchlist cap.' });
  }
});

function createDefaultAlpacaClient() {
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) return null;
  return new Alpaca({
    keyId: process.env.ALPACA_API_KEY,
    secretKey: process.env.ALPACA_SECRET_KEY,
    paper: true,
    usePolygon: false,
  });
}

function createStorage({ dataDir = process.env.APP_DATA_DIR || path.join(rootDir, 'data') } = {}) {
  const resolvedDataDir = path.resolve(dataDir);
  const journalPath = path.join(resolvedDataDir, 'journal.json');
  const settingsPath = path.join(resolvedDataDir, 'settings.json');
  const automationStatusPath = path.join(resolvedDataDir, 'automation-status.json');

  async function ensureDataFiles() {
    await fs.mkdir(resolvedDataDir, { recursive: true });
    try { await fs.access(journalPath); } catch { await fs.writeFile(journalPath, '[]'); }
    try {
      await fs.access(settingsPath);
    } catch {
      await fs.writeFile(settingsPath, JSON.stringify({ watchlist: defaultWatchlist, automation: automationDefaults }, null, 2));
    }
    try {
      await fs.access(automationStatusPath);
    } catch {
      await fs.writeFile(automationStatusPath, JSON.stringify(normalizeAutomationStatus(), null, 2));
    }
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

  async function readJournal() { return readJson(journalPath, []); }
  async function readSettings() {
    const settings = await readJson(settingsPath, { watchlist: defaultWatchlist, automation: automationDefaults });
    return {
      watchlist: settings.watchlist?.length ? settings.watchlist : defaultWatchlist,
      automation: normalizeAutomationSettings(settings.automation),
    };
  }
  async function readAutomationStatus() { return readJson(automationStatusPath, normalizeAutomationStatus()); }
  async function saveJournal(journal) { await writeJson(journalPath, journal); }
  async function saveSettings(settings) {
    await writeJson(settingsPath, {
      watchlist: settings.watchlist?.length ? settings.watchlist : defaultWatchlist,
      automation: normalizeAutomationSettings(settings.automation),
    });
  }

  return {
    dataDir: resolvedDataDir,
    journalPath,
    settingsPath,
    automationStatusPath,
    ensureDataFiles,
    readJournal,
    readSettings,
    readAutomationStatus,
    saveJournal,
    saveSettings,
  };
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function calculateTradePlan({ entryPrice, stopPrice, targetPrice, riskAmount }) {
  const riskPerShare = Math.abs(entryPrice - stopPrice);
  const rewardPerShare = Math.abs(targetPrice - entryPrice);
  if (!Number.isFinite(riskPerShare) || riskPerShare <= 0) return { error: 'Risk per share must be greater than zero.' };

  const qty = Math.max(1, Math.floor(riskAmount / riskPerShare));
  const notional = qty * entryPrice;
  const totalRisk = qty * riskPerShare;
  const totalReward = qty * rewardPerShare;

  return {
    qty,
    riskPerShare: round(riskPerShare),
    rewardPerShare: round(rewardPerShare),
    notional: round(notional),
    totalRisk: round(totalRisk),
    totalReward: round(totalReward),
    rewardToRisk: round(rewardPerShare / riskPerShare),
  };
}

function normalizeJournalEntry(entry) {
  const entryPrice = Number(entry.entryPrice ?? 0);
  const stopPrice = Number(entry.stopPrice ?? 0);
  const targetPrice = Number(entry.targetPrice ?? 0);
  const riskPerShare = Math.abs(entryPrice - stopPrice);
  const rewardPerShare = Math.abs(targetPrice - entryPrice);
  const plannedQty = Number(entry.plannedQty);
  const riskAmount = Number(entry.riskAmount);
  const realizedR = Number(entry.realizedR);

  return {
    ...entry,
    status: journalStatusOptions.includes(entry.status) ? entry.status : 'planned',
    entryPrice,
    stopPrice,
    targetPrice,
    checklistScore: Number(entry.checklistScore ?? 0),
    plannedQty: Number.isFinite(plannedQty) && plannedQty > 0 ? plannedQty : null,
    riskAmount: Number.isFinite(riskAmount) && riskAmount > 0 ? riskAmount : null,
    realizedR: Number.isFinite(realizedR) ? realizedR : null,
    riskPerShare: round(riskPerShare),
    rewardPerShare: round(rewardPerShare),
    plannedR: riskPerShare > 0 ? round(rewardPerShare / riskPerShare) : null,
  };
}

function summarizeJournal(journal) {
  const normalized = journal.map(normalizeJournalEntry);
  const closed = normalized.filter((entry) => ['won', 'lost', 'scratched'].includes(entry.status));
  const wins = closed.filter((entry) => entry.status === 'won');
  const losses = closed.filter((entry) => entry.status === 'lost');
  const open = normalized.filter((entry) => ['planned', 'submitted', 'open', 'auto-candidate', 'auto-submitted'].includes(entry.status));
  const totalRealizedR = closed.reduce((sum, entry) => sum + (entry.realizedR ?? 0), 0);
  const avgChecklist = normalized.length ? round(normalized.reduce((sum, entry) => sum + entry.checklistScore, 0) / normalized.length, 1) : null;

  const symbolMap = new Map();
  for (const entry of normalized) {
    const current = symbolMap.get(entry.symbol) ?? { symbol: entry.symbol, count: 0, realizedR: 0, wins: 0 };
    current.count += 1;
    current.realizedR += entry.realizedR ?? 0;
    if (entry.status === 'won') current.wins += 1;
    symbolMap.set(entry.symbol, current);
  }

  const topSymbols = Array.from(symbolMap.values()).sort((a, b) => b.count - a.count || b.realizedR - a.realizedR).slice(0, 4).map((item) => ({
    ...item,
    realizedR: round(item.realizedR),
    winRate: item.count ? round((item.wins / item.count) * 100) : null,
  }));

  return {
    total: normalized.length,
    open: open.length,
    closed: closed.length,
    wins: wins.length,
    losses: losses.length,
    canceled: normalized.filter((entry) => entry.status === 'canceled').length,
    avgChecklist,
    winRate: closed.length ? round((wins.length / closed.length) * 100) : null,
    expectancyR: closed.length ? round(totalRealizedR / closed.length, 2) : null,
    totalRealizedR: round(totalRealizedR, 2) ?? 0,
    avgRealizedR: closed.length ? round(totalRealizedR / closed.length, 2) : null,
    topSymbols,
  };
}

function buildWorkflow({ credsConfigured, watchlist, journal, account, automationSettings, automationStatus, automationCandidates }) {
  const latest = journal[0] ? normalizeJournalEntry(journal[0]) : null;
  return [
    {
      label: 'Paper API',
      status: credsConfigured ? 'ready' : 'setup',
      detail: credsConfigured ? 'Paper credentials configured.' : 'Add Alpaca paper keys to unlock account data and automation.',
    },
    {
      label: 'Watchlist scope',
      status: watchlist.length >= 1 ? 'ready' : 'setup',
      detail: watchlist.length ? `${watchlist.length} symbols queued for automation and review.` : 'Add symbols to the watchlist before enabling automation.',
    },
    {
      label: 'Automation',
      status: automationSettings.enabled ? 'ready' : 'review',
      detail: automationSettings.enabled ? `Enabled on ${automationSettings.timeframe}, polling every ${automationSettings.pollIntervalSeconds}s.` : 'Disabled. Signals will not scan until you turn it on.',
    },
    {
      label: 'Risk guardrails',
      status: automationSettings.riskPerTrade > 0 ? 'ready' : 'review',
      detail: `$${automationSettings.riskPerTrade} per trade, max ${automationSettings.maxOpenPositions} open positions, auto submit ${automationSettings.autoSubmit ? 'on' : 'off'}.`,
    },
    {
      label: 'Current workflow',
      status: latest || automationCandidates.length ? 'ready' : 'review',
      detail: latest ? `Latest journal idea: ${latest.symbol} ${latest.side}, ${latest.status}.` : automationCandidates.length ? `Latest automation candidate: ${automationCandidates[0].symbol} ${automationCandidates[0].side}.` : 'No manual or automated trade workflows logged yet.',
    },
    {
      label: 'Account health',
      status: account ? 'ready' : 'review',
      detail: account ? `Status ${account.status}, buying power $${Number(account.buying_power).toFixed(2)}. Last run: ${automationStatus.lastRunAt ? new Date(automationStatus.lastRunAt).toLocaleString() : 'never'}.` : 'Connect paper account to confirm equity and buying power before testing.',
    },
  ];
}

function summarizeOpenOrders(orders) {
  const grouped = new Map();
  for (const order of orders || []) {
    const symbol = String(order.symbol || 'UNKNOWN');
    if (!grouped.has(symbol)) grouped.set(symbol, []);
    const intent = String(order.position_intent || '').toLowerCase();
    const label = intent.includes('open')
      ? 'entry'
      : intent.includes('close')
        ? (String(order.type || order.order_type || '').toLowerCase() === 'stop' ? 'stop_loss' : 'take_profit')
        : 'other';
    grouped.get(symbol).push({
      id: order.id,
      side: order.side,
      type: order.type || order.order_type,
      status: order.status,
      orderClass: order.order_class,
      intent: order.position_intent || 'unknown',
      label,
      limitPrice: order.limit_price,
      stopPrice: order.stop_price,
      submittedAt: order.submitted_at,
    });
  }

  return Array.from(grouped.entries()).map(([symbol, symbolOrders]) => {
    const entries = symbolOrders.filter((o) => o.label === 'entry').length;
    const takeProfits = symbolOrders.filter((o) => o.label === 'take_profit').length;
    const stopLosses = symbolOrders.filter((o) => o.label === 'stop_loss').length;
    return {
      symbol,
      count: symbolOrders.length,
      entries,
      takeProfits,
      stopLosses,
      likelyStale: entries > 0 && symbolOrders.every((o) => o.status === 'new'),
      orders: symbolOrders,
    };
  }).sort((a, b) => b.count - a.count || a.symbol.localeCompare(b.symbol));
}

function summarizeAutomationJournalRisk(journal, automationSettings) {
  const autoSubmitted = (journal || []).filter((entry) => entry.status === 'auto-submitted');
  const legacyAutoSubmitted = !automationSettings.autoSubmit ? autoSubmitted : [];
  return {
    autoSubmittedCount: autoSubmitted.length,
    legacyAutoSubmittedCount: legacyAutoSubmitted.length,
    legacySymbols: [...new Set(legacyAutoSubmitted.map((entry) => entry.symbol))].slice(0, 20),
  };
}

function maybeCreateAutomationJournalEntries(existingJournal, candidates) {
  const seenIds = new Set(existingJournal.filter((entry) => entry.automationCandidateId).map((entry) => entry.automationCandidateId));
  const additions = candidates
    .filter((candidate) => !seenIds.has(candidate.id))
    .map((candidate) => ({
      id: crypto.randomUUID(),
      automationCandidateId: candidate.id,
      createdAt: candidate.createdAt,
      symbol: candidate.symbol,
      side: candidate.side,
      thesis: candidate.reason,
      liquidityLevel: `${candidate.timeframe} automation sweep`,
      displacementSeen: `Trigger/confirm body ${candidate.metrics?.triggerBodyRatio ?? 'n/a'}/${candidate.metrics?.confirmationBodyRatio ?? 'n/a'}`,
      structureShiftSeen: `Automation pattern match${candidate.metrics?.barsSinceSignal ? `, confirmed ${candidate.metrics.barsSinceSignal} bar(s) after sweep` : ''}`,
      entryPrice: candidate.entryPrice,
      stopPrice: candidate.stopPrice,
      targetPrice: candidate.targetPrice,
      riskAmount: round(candidate.qty * candidate.riskPerShare),
      plannedQty: candidate.qty,
      checklistScore: 4,
      status: candidate.autoSubmitted ? 'auto-submitted' : 'auto-candidate',
      notes: `Automation ${candidate.autoSubmitted ? 'submitted' : 'flagged'} this setup. Review trigger bar ${candidate.triggerBar?.timestamp || ''}.`,
      realizedR: null,
      outcomeNotes: '',
    }));

  return additions.length ? [...additions, ...existingJournal].slice(0, maxJournalEntries) : existingJournal;
}

async function getDashboardData({ storage, createAlpacaClient, plannerInput, plannerResult }) {
  const journal = await storage.readJournal();
  const settings = await storage.readSettings();
  const automationStatus = normalizeAutomationStatus(await storage.readAutomationStatus());
  const alpaca = createAlpacaClient();

  const state = {
    credsConfigured: Boolean(alpaca),
    paperOnly: true,
    account: null,
    positions: [],
    orders: [],
    watchQuotes: [],
    errors: [],
    journal: journal.map(normalizeJournalEntry),
    journalSummary: summarizeJournal(journal),
    watchlist: settings.watchlist?.length ? settings.watchlist : defaultWatchlist,
    automationSettings: settings.automation,
    automationStatus,
    automationCandidates: automationStatus.candidates || [],
    orderDiagnostics: [],
    automationRisk: { autoSubmittedCount: 0, legacyAutoSubmittedCount: 0, legacySymbols: [] },
    plannerInput,
    plannerResult,
    workflow: [],
  };

  if (!alpaca) {
    state.workflow = buildWorkflow(state);
    return state;
  }

  try {
    const latestMarketDataPromise = typeof alpaca.getLatestQuotes === 'function' && typeof alpaca.getLatestTrades === 'function'
      ? Promise.all([alpaca.getLatestQuotes(state.watchlist), alpaca.getLatestTrades(state.watchlist)])
      : Promise.all([
        Promise.all(state.watchlist.map(async (symbol) => [symbol, await alpaca.getLatestQuote(symbol)])),
        Promise.all(state.watchlist.map(async (symbol) => [symbol, await alpaca.getLatestTrade(symbol)])),
      ]).then(([quotes, trades]) => [new Map(quotes), new Map(trades)]);

    const [account, positions, orders, [latestQuotes, latestTrades]] = await Promise.all([
      alpaca.getAccount(),
      alpaca.getPositions(),
      alpaca.getOrders({ status: 'open', direction: 'desc' }),
      latestMarketDataPromise,
    ]);

    state.account = account;
    state.positions = positions;
    state.orders = orders;
    state.orderDiagnostics = summarizeOpenOrders(orders);
    state.watchQuotes = state.watchlist.map((symbol) => {
      const quote = latestQuotes?.get?.(symbol);
      const trade = latestTrades?.get?.(symbol);
      return {
        symbol,
        bid: Number(quote?.BidPrice || 0),
        ask: Number(quote?.AskPrice || 0),
        last: Number(trade?.Price || 0),
        timestamp: trade?.Timestamp || quote?.Timestamp || null,
      };
    });
  } catch (error) {
    state.errors.push(error.message);
  }

  state.automationRisk = summarizeAutomationJournalRisk(state.journal, state.automationSettings);
  state.workflow = buildWorkflow(state);
  return state;
}

function createApp({ storage = createStorage(), createAlpacaClient = createDefaultAlpacaClient, startAutomation = true } = {}) {
  const app = express();
  const persistAutomationCandidates = async (candidates) => {
    const currentJournal = await storage.readJournal();
    await storage.saveJournal(maybeCreateAutomationJournalEntries(currentJournal, candidates));
  };
  const automationEngine = createAutomationEngine({
    storage,
    createAlpacaClient,
    logger: (message) => console.log(`[automation] ${message}`),
    onCandidates: persistAutomationCandidates,
  });

  app.set('view engine', 'ejs');
  app.set('views', path.join(rootDir, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(rootDir, 'public')));

  app.get('/', async (req, res) => {
    await storage.ensureDataFiles();

    let plannerInput = null;
    let plannerResult = null;
    if (Object.keys(req.query).some((key) => key.startsWith('plan'))) {
      const candidate = {
        symbol: req.query.planSymbol,
        side: req.query.planSide,
        entryPrice: req.query.planEntryPrice,
        stopPrice: req.query.planStopPrice,
        targetPrice: req.query.planTargetPrice,
        riskAmount: req.query.planRiskAmount,
      };
      const parsedPlan = plannerSchema.safeParse(candidate);
      if (parsedPlan.success) {
        plannerInput = parsedPlan.data;
        plannerResult = calculateTradePlan(parsedPlan.data);
      } else {
        res.locals.plannerError = parsedPlan.error.issues[0].message;
      }
    }

    const data = await getDashboardData({ storage, createAlpacaClient, plannerInput, plannerResult });
    res.render('index', {
      ...data,
      orderDiagnostics: data.orderDiagnostics || [],
      automationRisk: data.automationRisk || { autoSubmittedCount: 0, legacyAutoSubmittedCount: 0, legacySymbols: [] },
      checklistItems,
      success: req.query.success,
      error: req.query.error || res.locals.plannerError,
      statusOptions: journalStatusOptions,
      automationTimeframes,
    });
  });

  app.post('/watchlist', async (req, res) => {
    await storage.ensureDataFiles();
    const watchlist = String(req.body.watchlist || '').split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean).slice(0, 30);
    const settings = await storage.readSettings();
    await storage.saveSettings({ ...settings, watchlist: watchlist.length ? [...new Set(watchlist)] : defaultWatchlist });
    res.redirect('/?success=Watchlist updated');
  });

  app.post('/automation/settings', async (req, res) => {
    await storage.ensureDataFiles();
    const parsed = automationSettingsSchema.safeParse(req.body);
    if (!parsed.success) return res.redirect(`/?error=${encodeURIComponent(parsed.error.issues[0].message)}`);

    const settings = await storage.readSettings();
    await storage.saveSettings({
      ...settings,
      automation: {
        ...parsed.data,
        enabled: Boolean(req.body.enabled),
        autoSubmit: Boolean(req.body.autoSubmit),
        rotateWatchlist: Boolean(req.body.rotateWatchlist),
      },
    });
    await automationEngine.start();
    return res.redirect('/?success=Automation settings updated');
  });

  app.post('/automation/run', async (req, res) => {
    await storage.ensureDataFiles();
    const result = await runAutomationCycle({
      storage,
      createAlpacaClient,
      logger: (message) => console.log(`[automation] ${message}`),
      onCandidates: persistAutomationCandidates,
    });
    res.redirect(`/?success=${encodeURIComponent(result.status.lastSummary)}`);
  });

  app.post('/journal', async (req, res) => {
    await storage.ensureDataFiles();
    const parsed = journalEntrySchema.safeParse(req.body);
    if (!parsed.success) return res.redirect(`/?error=${encodeURIComponent(parsed.error.issues[0].message)}`);

    const journal = await storage.readJournal();
    const plan = calculateTradePlan(parsed.data);
    journal.unshift({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      realizedR: null,
      outcomeNotes: '',
      ...parsed.data,
      plannedQty: Number.isFinite(Number(parsed.data.plannedQty)) ? Number(parsed.data.plannedQty) : plan.qty,
      riskAmount: Number.isFinite(Number(parsed.data.riskAmount)) ? Number(parsed.data.riskAmount) : plan.totalRisk,
    });
    await storage.saveJournal(journal.slice(0, maxJournalEntries));
    return res.redirect('/?success=Journal entry saved');
  });

  app.post('/journal/:id/review', async (req, res) => {
    await storage.ensureDataFiles();
    const parsed = journalReviewSchema.safeParse(req.body);
    if (!parsed.success) return res.redirect(`/?error=${encodeURIComponent(parsed.error.issues[0].message)}`);

    const journal = await storage.readJournal();
    const index = journal.findIndex((entry) => entry.id === req.params.id);
    if (index === -1) return res.redirect('/?error=Journal entry not found');

    journal[index] = {
      ...journal[index],
      status: parsed.data.status,
      outcomeNotes: parsed.data.outcomeNotes || '',
      realizedR: Number.isFinite(Number(parsed.data.realizedR)) ? Number(parsed.data.realizedR) : null,
      reviewedAt: new Date().toISOString(),
    };

    await storage.saveJournal(journal);
    return res.redirect('/?success=Journal review updated');
  });

  app.post('/order', async (req, res) => {
    const alpaca = createAlpacaClient();
    if (!alpaca) return res.redirect('/?error=Missing Alpaca paper credentials');

    const parsed = orderSchema.safeParse(req.body);
    if (!parsed.success) return res.redirect(`/?error=${encodeURIComponent(parsed.error.issues[0].message)}`);

    try {
      const order = parsed.data;
      const payload = {
        symbol: order.symbol.toUpperCase(),
        side: order.side,
        qty: order.qty,
        type: order.type,
        time_in_force: order.timeInForce,
      };

      if (order.type === 'limit') payload.limit_price = Number(order.limitPrice);
      if (order.useBracket) {
        payload.order_class = 'bracket';
        payload.take_profit = { limit_price: Number(order.takeProfitPrice) };
        payload.stop_loss = { stop_price: Number(order.stopLossPrice) };
      }

      await alpaca.createOrder(payload);
      return res.redirect('/?success=Paper order submitted');
    } catch (error) {
      return res.redirect(`/?error=${encodeURIComponent(error.message)}`);
    }
  });

  app.post('/orders/cancel-open', async (req, res) => {
    const alpaca = createAlpacaClient();
    if (!alpaca) return res.redirect('/?error=Missing Alpaca paper credentials');

    try {
      const orders = await alpaca.getOrders({ status: 'open', direction: 'desc' });
      for (const order of orders) {
        if (typeof alpaca.cancelOrder === 'function') await alpaca.cancelOrder(order.id);
        else if (typeof alpaca.cancelOrderById === 'function') await alpaca.cancelOrderById(order.id);
        else throw new Error('Alpaca client does not expose order cancellation');
      }
      return res.redirect(`/?success=${encodeURIComponent(`Canceled ${orders.length} open paper order(s)`)}`);
    } catch (error) {
      return res.redirect(`/?error=${encodeURIComponent(error.message)}`);
    }
  });

  app.post('/positions/flatten', async (req, res) => {
    const alpaca = createAlpacaClient();
    if (!alpaca) return res.redirect('/?error=Missing Alpaca paper credentials');

    try {
      const positions = await alpaca.getPositions();
      for (const position of positions) {
        if (typeof alpaca.closePosition === 'function') await alpaca.closePosition(position.symbol);
        else if (typeof alpaca.closeAllPositions === 'function') {
          await alpaca.closeAllPositions();
          break;
        } else {
          throw new Error('Alpaca client does not expose position-closing helpers');
        }
      }
      return res.redirect(`/?success=${encodeURIComponent(`Requested flatten for ${positions.length} paper position(s)`)}`);
    } catch (error) {
      return res.redirect(`/?error=${encodeURIComponent(error.message)}`);
    }
  });

  app.get('/api/orders', async (req, res) => {
    const alpaca = createAlpacaClient();
    if (!alpaca) return res.status(400).json({ ok: false, error: 'Missing Alpaca paper credentials' });

    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    const status = String(req.query.status || 'all');

    try {
      const orders = await alpaca.getOrders({ status, direction: 'desc' });
      return res.json({ ok: true, count: orders.length, orders: orders.slice(0, limit) });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  if (startAutomation) {
    storage.ensureDataFiles().then(() => automationEngine.start()).catch((error) => console.error('[automation] failed to start', error));
  }

  return app;
}

export {
  automationDefaults,
  automationTimeframes,
  calculateTradePlan,
  checklistItems,
  createApp,
  createDefaultAlpacaClient,
  createStorage,
  defaultWatchlist,
  getDashboardData,
  journalStatusOptions,
  normalizeJournalEntry,
  summarizeJournal,
};
