#!/usr/bin/env node
// Reports what a session's tokens cost at Anthropic's API list prices, by agent and model.
// Usage: node run-cost.js [--session <id>] [--since <ISO time>] [--until <ISO time>]
// The session defaults to CLAUDE_CODE_SESSION_ID. Subagent transcripts are included.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// USD per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing
const PRICES_CHECKED = '2026-11-06';
const PRICES = {
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
  'claude-haiku-5-5': { input: 0.1, write5m: 0.125, write1h: 0.2, read: 0.01, output: 0.5 },
  'claude-haiku-4-5': { input: 1, write5m: 1.25, write1h: 2, read: 0.1, output: 5 },
};
const HAIKU_5_5_LONG = { input: 0.5, write5m: 0.625, write1h: 1, read: 0.05, output: 2.5 };
const HAIKU_5_5_LONG_ABOVE = 100000;
const WEB_SEARCH_USD = 0.01;
const US_ONLY_MULTIPLIER = 1.1;

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
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

function cost(key, usage) {
  let price = PRICES[key];
  if (!price) return null;
  const t = tokens(usage);
  const prompt = t.input + t.write5m + t.write1h + t.read;
  if (key === 'claude-haiku-5-5' && prompt > HAIKU_5_5_LONG_ABOVE) price = HAIKU_5_5_LONG;
  let usd =
    (t.input * price.input +
      t.write5m * price.write5m +
      t.write1h * price.write1h +
      t.read * price.read +
      t.output * price.output) /
    1e6;
  if (usage.speed === 'fast' && price.fast) usd *= price.fast;
  if (usage.inference_geo === 'us') usd *= US_ONLY_MULTIPLIER;
  const searches = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
  return usd + searches * WEB_SEARCH_USD;
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

function main() {
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
      const usd = cost(key, message.usage);
      row.requests += 1;
      row.input += t.input;
      row.write += t.write5m + t.write1h;
      row.read += t.read;
      row.output += t.output;
      if (usd === null) {
        row.priced = false;
        unpriced.add(key);
      } else {
        row.usd += usd;
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
  console.log(`\nTotal: ${money(total)} at API list prices checked ${PRICES_CHECKED}.`);
  console.log('On a Claude subscription this is what the tokens would cost through the API, not what you paid.');
  if (unpriced.size) console.log(`Not counted, no price known: ${[...unpriced].join(', ')}.`);
}

main();
