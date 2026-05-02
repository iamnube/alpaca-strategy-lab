import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const settingsPath = path.join(rootDir, 'data', 'settings.json');
const journalPath = path.join(rootDir, 'data', 'journal.json');

function easternHourMinute(now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  return { hour, minute, totalMinutes: hour * 60 + minute };
}

const settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
const automation = settings.automation || {};
const openStatuses = new Set(['planned', 'submitted', 'open', 'auto-candidate', 'auto-submitted']);
const openCount = journal.filter((entry) => openStatuses.has(entry.status)).length;
const now = easternHourMinute();
const startHour = Number(automation.allowedStartHour ?? 14);
const endHour = Number(automation.allowedEndHour ?? 16);
const inSession = now.totalMinutes >= startHour * 60 && now.totalMinutes < endHour * 60;

console.log('Session readiness');
console.log('-----------------');
console.log(`Automation enabled: ${automation.enabled ? 'yes' : 'no'}`);
console.log(`Auto-submit enabled: ${automation.autoSubmit ? 'yes' : 'no'}`);
console.log(`Session window: ${startHour}:00-${endHour}:00 ET`);
console.log(`In session now: ${inSession ? 'yes' : 'no'}`);
console.log(`Watchlist cap: ${automation.maxWatchlistSymbols}`);
console.log(`Symbols per cycle: ${automation.symbolsPerCycle}`);
console.log(`Timeframe: ${automation.timeframe}`);
console.log(`Open/unreviewed journal entries: ${openCount}`);

const issues = [];
if (!automation.enabled) issues.push('Automation is disabled.');
if (automation.autoSubmit) issues.push('Auto-submit is ON; expected review-only mode.');
if (openCount > 0) issues.push(`Journal still has ${openCount} open/unreviewed entries.`);
if (startHour !== 14 || endHour !== 16) issues.push(`Session window drifted to ${startHour}:00-${endHour}:00 ET.`);
if (automation.symbolsPerCycle !== 10) issues.push(`Symbols per cycle drifted to ${automation.symbolsPerCycle}.`);
if (automation.maxWatchlistSymbols !== 50) issues.push(`Watchlist cap drifted to ${automation.maxWatchlistSymbols}.`);

if (issues.length) {
  console.log('\nNot ready:');
  for (const issue of issues) console.log(`- ${issue}`);
  process.exitCode = 1;
} else {
  console.log('\nReady for the next review-only session.');
}
