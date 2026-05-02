import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const journalPath = path.join(dataDir, 'journal.json');
const settingsPath = path.join(dataDir, 'settings.json');

const openStatuses = new Set(['planned', 'submitted', 'open', 'auto-candidate', 'auto-submitted']);
const filledReviewStatuses = new Set(['won', 'lost', 'scratched']);
const resolvedStatuses = new Set(['won', 'lost', 'scratched', 'canceled']);

function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function daysSince(isoString) {
  if (!isoString) return null;
  const created = new Date(isoString);
  if (Number.isNaN(created.getTime())) return null;
  return (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

const journal = await readJson(journalPath, []);
const settings = await readJson(settingsPath, {});
const activeWatchlist = new Set(settings.watchlist || []);

const summary = {
  total: journal.length,
  activeWatchlistEntries: 0,
  legacyEntries: 0,
  openEntries: 0,
  closedEntries: 0,
  resolvedEntries: 0,
  canceledEntries: 0,
  reviewedEntries: 0,
  unreviewedEntries: 0,
  staleOpenOver1Day: 0,
  staleOpenOver7Days: 0,
  expectancyR: null,
  winRate: null,
  activeFilledExpectancyR: null,
  activeFilledWinRate: null,
  activeFilledCount: 0,
  topSymbols: [],
};

const symbolStats = new Map();
let wins = 0;
let totalRealizedR = 0;
let activeFilledWins = 0;
let activeFilledRealizedR = 0;

for (const entry of journal) {
  const status = entry.status || 'planned';
  const symbol = String(entry.symbol || '').toUpperCase();
  const realizedR = Number(entry.realizedR);
  const ageDays = daysSince(entry.createdAt);

  if (activeWatchlist.has(symbol)) summary.activeWatchlistEntries += 1;
  else summary.legacyEntries += 1;

  if (openStatuses.has(status)) {
    summary.openEntries += 1;
    summary.unreviewedEntries += 1;
    if (ageDays !== null && ageDays > 1) summary.staleOpenOver1Day += 1;
    if (ageDays !== null && ageDays > 7) summary.staleOpenOver7Days += 1;
  }

  if (filledReviewStatuses.has(status)) {
    summary.closedEntries += 1;
    summary.reviewedEntries += 1;
    if (status === 'won') wins += 1;
    if (Number.isFinite(realizedR)) totalRealizedR += realizedR;
    if (activeWatchlist.has(symbol)) {
      summary.activeFilledCount += 1;
      if (status === 'won') activeFilledWins += 1;
      if (Number.isFinite(realizedR)) activeFilledRealizedR += realizedR;
    }
  }

  if (resolvedStatuses.has(status)) {
    summary.resolvedEntries += 1;
  }

  if (status === 'canceled') {
    summary.canceledEntries += 1;
  }

  const current = symbolStats.get(symbol) || { symbol, count: 0, realizedR: 0 };
  current.count += 1;
  if (Number.isFinite(realizedR)) current.realizedR += realizedR;
  symbolStats.set(symbol, current);
}

if (summary.closedEntries > 0) {
  summary.winRate = round((wins / summary.closedEntries) * 100);
  summary.expectancyR = round(totalRealizedR / summary.closedEntries);
}

if (summary.activeFilledCount > 0) {
  summary.activeFilledWinRate = round((activeFilledWins / summary.activeFilledCount) * 100);
  summary.activeFilledExpectancyR = round(activeFilledRealizedR / summary.activeFilledCount);
}

summary.topSymbols = Array.from(symbolStats.values())
  .sort((a, b) => b.count - a.count || b.realizedR - a.realizedR)
  .slice(0, 8)
  .map((item) => ({ ...item, realizedR: round(item.realizedR) }));

console.log('Journal baseline');
console.log('----------------');
console.log(`Total entries: ${summary.total}`);
console.log(`Active watchlist entries: ${summary.activeWatchlistEntries}`);
console.log(`Legacy entries: ${summary.legacyEntries}`);
console.log(`Open/unreviewed entries: ${summary.openEntries}`);
console.log(`Resolved entries: ${summary.resolvedEntries}`);
console.log(`Filled-trade reviews: ${summary.closedEntries}`);
console.log(`Canceled/no-fill entries: ${summary.canceledEntries}`);
console.log(`Stale open >1 day: ${summary.staleOpenOver1Day}`);
console.log(`Stale open >7 days: ${summary.staleOpenOver7Days}`);
console.log(`Filled-trade win rate: ${summary.winRate === null ? 'n/a' : `${summary.winRate}%`}`);
console.log(`Filled-trade expectancy: ${summary.expectancyR === null ? 'n/a' : `${summary.expectancyR}R`}`);
console.log(`Active filled trades: ${summary.activeFilledCount}`);
console.log(`Active filled win rate: ${summary.activeFilledWinRate === null ? 'n/a' : `${summary.activeFilledWinRate}%`}`);
console.log(`Active filled expectancy: ${summary.activeFilledExpectancyR === null ? 'n/a' : `${summary.activeFilledExpectancyR}R`}`);
console.log('Top symbols:', summary.topSymbols.map((item) => `${item.symbol} (${item.count})`).join(', ') || 'n/a');
