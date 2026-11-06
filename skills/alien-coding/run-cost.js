#!/usr/bin/env node
// Reports what a session's tokens cost at Anthropic's API list prices, by agent and model, and
// where its time went: model thinking, model writing, build and tests, other.
// Usage: node run-cost.js [--session <id>] [--since <ISO time>] [--until <ISO time>] [--prices-url <url>]
// The session defaults to CLAUDE_CODE_SESSION_ID. Subagent transcripts are included.
// Prices are fetched on each run. If the page is unreachable or no longer parses, the last list that
// loaded is used, kept in <claude dir>/alien-coding-prices.json, then the list built in below.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PRICES_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
const FETCH_TIMEOUT_MS = 8000;
const FIELDS = ['input', 'write5m', 'write1h', 'read', 'output'];

// USD per million tokens; fast is the fast-mode multiplier, long the tier above a prompt length.
const BUILT_IN_DATE = '2026-11-06';
const BUILT_IN_PRICES = {
  'claude-fable-5-1': { input: 10, write5m: 12.5, write1h: 20, read: 0.25, output: 50 },
  'claude-mythos-5-1': { input: 10, write5m: 12.5, write1h: 20, read: 0.25, output: 50 },
  'claude-fable-5': { input: 10, write5m: 12.5, write1h: 20, read: 1, output: 50 },
  'claude-mythos-5': { input: 10, write5m: 12.5, write1h: 20, read: 1, output: 50 },
  'claude-opus-5-5': { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20, fast: 2 },
  'claude-opus-5': { input: 5, write5m: 6.25, write1h: 10, read: 0.5, output: 25, fast: 2 },
  'claude-opus-4-8': { input: 5, write5m: 6.25, write1h: 10, read: 0.5, output: 25, fast: 2 },
  'claude-opus-4-7': { input: 5, write5m: 6.25, write1h: 10, read: 0.5, output: 25 },
  'claude-opus-4-6': { input: 5, write5m: 6.25, write1h: 10, read: 0.5, output: 25 },
  'claude-opus-4-5': { input: 5, write5m: 6.25, write1h: 10, read: 0.5, output: 25 },
  'claude-sonnet-5-5': { input: 2, write5m: 2.5, write1h: 4, read: 0.1, output: 10 },
  'claude-sonnet-5': { input: 2, write5m: 2.5, write1h: 4, read: 0.2, output: 10 },
  'claude-sonnet-4-6': { input: 3, write5m: 3.75, write1h: 6, read: 0.3, output: 15 },
  'claude-sonnet-4-5': { input: 3, write5m: 3.75, write1h: 6, read: 0.3, output: 15 },
  'claude-haiku-5-5': {
    input: 0.1,
    write5m: 0.125,
    write1h: 0.2,
    read: 0.01,
    output: 0.5,
    long: { above: 100000, input: 0.5, write5m: 0.625, write1h: 1, read: 0.05, output: 2.5 },
  },
  'claude-haiku-4-5': { input: 1, write5m: 1.25, write1h: 2, read: 0.1, output: 5 },
};
const BUILD = 1;
const THINKING = 2;
const WRITING = 3;
const OTHER = 4;
const SHELLS = new Set(['Bash', 'PowerShell']);
// Waiting on a person or a subagent is not work; a subagent's own transcript carries its work.
const NOT_WORK = new Set(['AskUserQuestion', 'Agent', 'Task', 'SendMessage']);
const BUILD_OR_TEST =
  /\b(build|tests?|prove|verify|mutations?|lint|compile|tsc|pytest|jest|vitest|karma|playwright|cargo|gradle|mvn|make|rspec|phpunit)\b/i;
const READ_ONLY_COMMAND = /^\s*(git|grep|rg|cat|ls|sed|awk|find|head|tail|wc|echo|printf|cut|sort|diff)\b/;
const BACKGROUND_CHECK = /\b(wave|verification|proof|checks?|tests?|build)\b/i;
const WEB_SEARCH_USD = 0.01;
const US_ONLY_MULTIPLIER = 1.1;

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

function tableRows(lines) {
  return lines
    .filter((line) => line.startsWith('|') && !/^\|\s*:?-/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

function usd(cell) {
  const match = /\$([\d.]+)/.exec(cell);
  return match ? Number(match[1]) : NaN;
}

function modelId(name) {
  return name.replace(/\(.*$/, '').trim().toLowerCase().replace(/[ .]/g, '-');
}

function validTier(p) {
  return (
    FIELDS.every((field) => Number.isFinite(p[field]) && p[field] > 0) &&
    p.read < p.input &&
    p.input < p.write5m &&
    p.write5m < p.write1h &&
    p.input < p.output
  );
}

// Throws on any shape it doesn't recognise, so a changed page can never price a run.
function parsePrices(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\|\s*Model\s*\|\s*Base input tokens/i.test(l));
  if (start === -1) throw new Error('the price table was not found');
  const header = lines[start].toLowerCase();
  const order = ['base input', '5m cache', '1h cache', 'cache hits', 'output'].map((s) => header.indexOf(s));
  if (order.some((at, i) => at === -1 || (i > 0 && at < order[i - 1]))) {
    throw new Error('the price table has different columns');
  }
  let end = start;
  while (lines[end + 1] && lines[end + 1].startsWith('|')) end += 1;

  const models = {};
  for (const cells of tableRows(lines.slice(start + 1, end + 1))) {
    if (cells.length !== 6) throw new Error('a price row has a different shape');
    const tier = Object.fromEntries(FIELDS.map((field, i) => [field, usd(cells[i + 1])]));
    if (!validTier(tier)) throw new Error(`the prices for ${cells[0]} look wrong`);
    const id = modelId(cells[0]);
    const over = /over ([\d,]+) tokens/.exec(cells[0]);
    if (over) {
      models[id] = { ...models[id], long: { above: Number(over[1].replace(/,/g, '')), ...tier } };
    } else {
      models[id] = { ...tier, ...(models[id] && { long: models[id].long }) };
    }
  }
  const families = ['claude-opus-', 'claude-sonnet-', 'claude-haiku-'];
  if (!families.every((family) => Object.keys(models).some((id) => id.startsWith(family)))) {
    throw new Error('a model family is missing');
  }

  const fastAt = lines.findIndex((l) => /^#+\s*Fast mode pricing/i.test(l));
  if (fastAt === -1) throw new Error('the fast mode section was not found');
  let fastEnd = fastAt + 1;
  while (fastEnd < lines.length && !/^#/.test(lines[fastEnd])) fastEnd += 1;
  let fastRows = 0;
  for (const cells of tableRows(lines.slice(fastAt, fastEnd))) {
    if (!cells[0].startsWith('Claude')) continue;
    for (const name of cells[0].split('/')) {
      const id = modelId(name);
      if (!models[id] || !(usd(cells[1]) > 0)) throw new Error(`the fast price for ${name.trim()} looks wrong`);
      models[id].fast = usd(cells[1]) / models[id].input;
      fastRows += 1;
    }
  }
  if (!fastRows) throw new Error('the fast mode table was not found');
  return models;
}

function readSavedPrices(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.date && saved.models && Object.values(saved.models).every(validTier)) return saved;
  } catch {
    // No saved list, or an unreadable one, leaves the built-in list.
  }
  return { date: BUILT_IN_DATE, models: BUILT_IN_PRICES };
}

async function loadPrices(root, url) {
  const file = path.join(root, 'alien-coding-prices.json');
  const last = readSavedPrices(file);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`the page answered ${response.status}`);
    // A model the page has dropped keeps its last price, so older transcripts stay priced.
    const models = { ...last.models, ...parsePrices(await response.text()) };
    const date = new Date().toISOString().slice(0, 10);
    try {
      fs.writeFileSync(file, JSON.stringify({ date, models }, null, 2));
    } catch {
      // Prices that can't be saved still price this run.
    }
    return { models, note: `at API list prices fetched today (${date})` };
  } catch (error) {
    const reason = error.cause ? error.cause.message || error.cause.code : error.message;
    return {
      models: last.models,
      note: `at the last loaded API list prices, from ${last.date}. The price page could not be used: ${reason}`,
    };
  }
}

function modelKey(model) {
  return String(model || '')
    .replace(/\[.*\]$/, '')
    .replace(/-\d{8}$/, '');
}

function tokens(usage) {
  const creation = usage.cache_creation || {};
  const write1h = creation.ephemeral_1h_input_tokens || 0;
  const split = creation.ephemeral_5m_input_tokens !== undefined;
  return {
    input: usage.input_tokens || 0,
    write5m: split ? creation.ephemeral_5m_input_tokens : usage.cache_creation_input_tokens || 0,
    write1h,
    read: usage.cache_read_input_tokens || 0,
    output: usage.output_tokens || 0,
  };
}

function cost(prices, key, usage) {
  const model = prices[key];
  if (!model) return null;
  const t = tokens(usage);
  const prompt = t.input + t.write5m + t.write1h + t.read;
  const price = model.long && prompt > model.long.above ? model.long : model;
  let total =
    (t.input * price.input +
      t.write5m * price.write5m +
      t.write1h * price.write1h +
      t.read * price.read +
      t.output * price.output) /
    1e6;
  if (usage.speed === 'fast' && model.fast) total *= model.fast;
  if (usage.inference_geo === 'us') total *= US_ONLY_MULTIPLIER;
  const searches = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
  return total + searches * WEB_SEARCH_USD;
}

// A response is logged once per content block, so keep one record per request: the last has the final counts.
function requests(file, since, until) {
  const byRequest = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"usage"')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const message = row.message;
    if (row.type !== 'assistant' || !message || !message.usage) continue;
    const at = Date.parse(row.timestamp);
    if (at < since || at > until) continue;
    byRequest.set(row.requestId || message.id || row.uuid, message);
  }
  return [...byRequest.values()];
}

function findTranscript(root, session) {
  const projects = path.join(root, 'projects');
  for (const folder of fs.readdirSync(projects)) {
    const file = path.join(projects, folder, `${session}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function transcripts(main) {
  const files = [{ agent: 'orchestrator', file: main }];
  const folder = path.join(main.replace(/\.jsonl$/, ''), 'subagents');
  if (!fs.existsSync(folder)) return files;
  for (const name of fs.readdirSync(folder).filter((n) => n.endsWith('.jsonl'))) {
    let agent = 'subagent';
    try {
      const meta = path.join(folder, name.replace(/\.jsonl$/, '.meta.json'));
      agent = JSON.parse(fs.readFileSync(meta, 'utf8')).agentType || agent;
    } catch {
      // A subagent with no readable metadata still counts, under the generic name.
    }
    files.push({ agent, file: path.join(folder, name) });
  }
  return files;
}

function isBuildOrTest(input) {
  const segments = String(input.command || '').split(/;|&&|\|\||\n/);
  if (segments.some((s) => !READ_ONLY_COMMAND.test(s) && BUILD_OR_TEST.test(s))) return true;
  return Boolean(input.run_in_background) && BACKGROUND_CHECK.test(input.description || '');
}

function category(name, input) {
  return SHELLS.has(name) && isBuildOrTest(input) ? BUILD : OTHER;
}

function eventRows(file, since, until) {
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"timestamp"')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== 'assistant' && row.type !== 'user') continue;
    const at = Date.parse(row.timestamp);
    if (at >= since && at <= until) rows.push({ row, at });
  }
  return rows;
}

function spans(rows) {
  const found = [];
  const tools = new Map();
  let previous = null;
  for (const { row, at } of rows) {
    const content = (row.message && row.message.content) || [];
    const blocks = Array.isArray(content) ? content : [];
    if (row.type === 'assistant') {
      if (previous !== null) {
        found.push([previous, at, WRITING]);
        found.push([Math.max(previous, at - (row.thinkingDurationMs || 0)), at, THINKING]);
      }
      for (const block of blocks) {
        if (block.type === 'tool_use') tools.set(block.id, { at, name: block.name, input: block.input || {} });
      }
    } else {
      for (const block of blocks) {
        const tool = block.type === 'tool_result' && tools.get(block.tool_use_id);
        if (!tool || NOT_WORK.has(tool.name) || tool.input.run_in_background) continue;
        found.push([tool.at, at, category(tool.name, tool.input)]);
      }
      const text = typeof content === 'string' ? content : blocks.map((b) => b.text || '').join(' ');
      const notified = tools.get((/<tool-use-id>(\w+)/.exec(text) || [])[1]);
      if (notified && notified.input.run_in_background) {
        found.push([notified.at, at, category(notified.name, notified.input)]);
      }
    }
    previous = at;
  }
  return found;
}

// Agents overlap, so each second counts once, under the highest-priority work happening in it.
function timeSpent(files, since, until) {
  const all = files.map(({ file }) => eventRows(file, since, until));
  const times = all.flat().map((r) => r.at);
  if (!times.length) return null;
  const start = times.reduce((a, b) => Math.min(a, b));
  const end = times.reduce((a, b) => Math.max(a, b));
  const seconds = new Uint8Array(Math.ceil((end - start) / 1000) + 1);
  for (const rows of all) {
    for (const [from, to, kind] of spans(rows)) {
      const last = Math.floor((to - start) / 1000);
      for (let i = Math.floor((from - start) / 1000); i < last; i += 1) {
        if (!seconds[i] || kind < seconds[i]) seconds[i] = kind;
      }
    }
  }
  const counts = { [BUILD]: 0, [THINKING]: 0, [WRITING]: 0, [OTHER]: 0 };
  for (const kind of seconds) if (kind) counts[kind] += 1;
  return { counts, elapsed: seconds.length };
}

function printTime(spent) {
  const clock = (s) => {
    const minutes = Math.round(s / 60);
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
  };
  const active = Object.values(spent.counts).reduce((a, b) => a + b, 0);
  const share = (s) => `${active ? Math.round((100 * s) / active) : 0}%`;
  console.log('\n| Where the time went | Time | Share |\n|---|---|---|');
  for (const [kind, label] of [
    [THINKING, 'Model thinking'],
    [WRITING, 'Model writing'],
    [BUILD, 'Build and tests'],
    [OTHER, 'Other'],
  ]) {
    console.log(`| ${label} | ${clock(spent.counts[kind])} | ${share(spent.counts[kind])} |`);
  }
  console.log(
    `\nActive ${clock(active)} of ${clock(spent.elapsed)} elapsed. The rest was waiting for you or idle.` +
      ' Work that overlapped counts once, build and tests first.',
  );
}

async function main() {
  const session = option('--session') || process.env.CLAUDE_CODE_SESSION_ID;
  if (!session) {
    console.error('No session: pass --session <id> or set CLAUDE_CODE_SESSION_ID.');
    process.exit(3);
  }
  const root = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const file = findTranscript(root, session);
  if (!file) {
    console.error(`No transcript found for session ${session} under ${root}.`);
    process.exit(3);
  }
  const since = option('--since') ? Date.parse(option('--since')) : -Infinity;
  const until = option('--until') ? Date.parse(option('--until')) : Infinity;
  const { models: prices, note } = await loadPrices(root, option('--prices-url') || PRICES_URL);

  const rows = new Map();
  const unpriced = new Set();
  for (const { agent, file: transcript } of transcripts(file)) {
    for (const message of requests(transcript, since, until)) {
      if (message.model === '<synthetic>') continue;
      const key = modelKey(message.model);
      const id = `${agent}\0${key}`;
      const row =
        rows.get(id) ||
        { agent, model: key, requests: 0, input: 0, write: 0, read: 0, output: 0, usd: 0, priced: true };
      const t = tokens(message.usage);
      const dollars = cost(prices, key, message.usage);
      row.requests += 1;
      row.input += t.input;
      row.write += t.write5m + t.write1h;
      row.read += t.read;
      row.output += t.output;
      if (dollars === null) {
        row.priced = false;
        unpriced.add(key);
      } else {
        row.usd += dollars;
      }
      rows.set(id, row);
    }
  }

  const ordered = [...rows.values()].sort((a, b) => b.usd - a.usd);
  const millions = (n) => `${(n / 1e6).toFixed(2)}M`;
  const money = (n) => `$${n.toFixed(2)}`;
  const table = [['Agent', 'Model', 'Requests', 'Input', 'Cache write', 'Cache read', 'Output', 'Cost']];
  for (const r of ordered) {
    table.push([
      r.agent,
      r.model,
      String(r.requests),
      millions(r.input),
      millions(r.write),
      millions(r.read),
      millions(r.output),
      r.priced ? money(r.usd) : 'no price',
    ]);
  }
  const total = ordered.reduce((sum, r) => sum + r.usd, 0);
  console.log(table.map((cells) => `| ${cells.join(' | ')} |`).join('\n').replace('\n', `\n|${'---|'.repeat(8)}\n`));
  console.log(`\nTotal: ${money(total)} ${note}.`);
  console.log('On a Claude subscription this is what the tokens would cost through the API, not what you paid.');
  if (unpriced.size) console.log(`Not counted, no price known: ${[...unpriced].join(', ')}.`);
  const spent = timeSpent(transcripts(file), since, until);
  if (spent) printTime(spent);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
