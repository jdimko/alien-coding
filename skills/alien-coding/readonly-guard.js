#!/usr/bin/env node
// readonly-guard.js — PreToolUse hook for the /alien-coding read-only agents
// (alien-plan-critic, alien-code-reviewer, alien-fable-reviewer), on the Bash and PowerShell tools.
//
// THIS IS A DENY-LIST THAT CATCHES MISTAKES, NOT A SANDBOX. A determined command
// (node -e "fs.rmSync(...)", a script file, an alias it doesn't know) gets
// through. The agents' own rules are the real boundary; this catches slips.
//
// Reads the hook JSON from stdin and exits 2 with a one-line reason on stderr for:
//   - git write verbs (commit, push, add, rm, mv, reset, checkout, switch, restore,
//     merge, rebase, cherry-pick, stash, clean, tag, branch -d/-D/-m/-M,
//     worktree add/remove/move/prune)
//   - package installs (npm/pnpm/yarn install|i|ci|add, dotnet add,
//     dotnet tool install, pip install, python -m pip install)
//   - in-place edits and deletes (sed -i, perl -i, rm, rmdir, mv, del, erase, rd,
//     Remove-Item, Move-Item and their aliases, find -delete / -exec rm)
//   - output written to a file outside .claude/alien-coding/ (>, >>, tee,
//     Tee-Object, Out-File, Set-Content, Add-Content); 2>&1, >/dev/null and
//     > $null are allowed
// Anything else exits 0.

'use strict';

const RUN_DIR = '.claude/alien-coding/';

const GIT_WRITE = new Set([
  'commit', 'push', 'add', 'rm', 'mv', 'reset', 'checkout', 'switch', 'restore',
  'merge', 'rebase', 'cherry-pick', 'stash', 'clean', 'tag',
]);
const GIT_BRANCH_WRITE = new Set(['-d', '-D', '-m', '-M', '--delete', '--move']);
const GIT_WORKTREE_WRITE = new Set(['add', 'remove', 'move', 'prune']);
// git global options that take a separate value
const GIT_OPT_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

const DELETE_MOVE = new Set([
  'rm', 'rmdir', 'mv', 'del', 'erase', 'rd', 'move',
  'remove-item', 'ri', 'move-item', 'mi',
]);
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'xargs', '&', '.']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'pwsh', 'powershell', 'cmd']);
const WRITE_CMDLETS = new Set(['out-file', 'set-content', 'add-content', 'sc', 'ac']);
const NULL_TARGETS = new Set(['/dev/null', '$null', 'nul', 'null']);

function deny(reason) {
  process.stderr.write(`readonly-guard: ${reason}. This agent is read-only; write output only under ${RUN_DIR}.\n`);
  process.exit(2);
}

// Split a command line into segments of words, with redirects pulled out.
// Quote-aware for '...' and "..."; separators: ; && || | & newline ( ) { }.
// Heredoc bodies (<<EOF ... EOF) are dropped, since they are data.
function lex(input) {
  let src = input;
  const segments = [];
  let words = [];
  let redirects = [];
  let cur = '';
  let inWord = false;
  let pendingRedirect = null; // { op } waiting for its target word

  const endWord = () => {
    if (!inWord) return;
    if (pendingRedirect) {
      redirects.push({ op: pendingRedirect.op, target: cur });
      pendingRedirect = null;
    } else {
      words.push(cur);
    }
    cur = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (pendingRedirect) { redirects.push({ op: pendingRedirect.op, target: '' }); pendingRedirect = null; }
    if (words.length || redirects.length) segments.push({ words, redirects });
    words = [];
    redirects = [];
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j === -1 ? src.length : j;
      cur += src.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length && '"\\$`'.includes(src[j + 1])) { cur += src[j + 1]; j += 2; continue; }
        cur += src[j];
        j++;
      }
      inWord = true;
      i = j;
      continue;
    }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    if (c === '\n' || c === '\r' || c === ';' || c === '|' || c === '(' || c === ')' || c === '}') { endSegment(); continue; }
    if (c === '{') {
      if (cur.endsWith('$') || cur.endsWith('@')) { cur += c; inWord = true; continue; } // ${VAR}, @{...}
      endSegment();
      continue;
    }
    if (c === '&') {
      if (src[i + 1] === '>') { // &> or &>> : redirect stdout+stderr
        endWord();
        const op = src[i + 2] === '>' ? '&>>' : '&>';
        i += op.length - 1;
        pendingRedirect = { op };
        continue;
      }
      if (!inWord && src[i + 1] !== '&' && words.length === 0) { cur = '&'; inWord = true; endWord(); continue; } // PowerShell call operator
      endSegment();
      if (src[i + 1] === '&') i++;
      continue;
    }
    if (c === '>') {
      // fd prefix such as 2> or *> belongs to the redirect, not to a word
      let fd = '';
      if (inWord && /^(\d+|\*)$/.test(cur)) { fd = cur; cur = ''; inWord = false; } else { endWord(); }
      let op = fd + '>';
      if (src[i + 1] === '>') { op += '>'; i++; }
      if (src[i + 1] === '&') { // dup like 2>&1 or >&2
        let j = i + 2;
        let t = '';
        while (j < src.length && /[\d-]/.test(src[j])) { t += src[j]; j++; }
        redirects.push({ op: op + '&', target: t });
        i = j - 1;
        continue;
      }
      pendingRedirect = { op };
      continue;
    }
    if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      // heredoc: its body is data, not commands, so skip it up to the delimiter line
      endWord();
      let j = i + 2;
      const stripTabs = src[j] === '-';
      if (stripTabs) j++;
      while (src[j] === ' ' || src[j] === '\t') j++;
      let delim = '';
      while (j < src.length && !/[\s;&|<>()]/.test(src[j])) { if (src[j] !== "'" && src[j] !== '"' && src[j] !== '\\') delim += src[j]; j++; }
      const nl = src.indexOf('\n', j);
      if (!delim || nl === -1) { i = j - 1; continue; }
      // the rest of the heredoc's first line is still command text
      const head = src.slice(j, nl);
      let k = nl + 1;
      let bodyEnd = src.length;
      while (k < src.length) {
        const e = src.indexOf('\n', k);
        const line = src.slice(k, e === -1 ? src.length : e).replace(/\r$/, '');
        if ((stripTabs ? line.replace(/^\t+/, '') : line) === delim) { bodyEnd = e === -1 ? src.length : e; break; }
        k = e === -1 ? src.length : e + 1;
      }
      src = src.slice(0, j) + head + '\n' + src.slice(bodyEnd);
      i = j - 1;
      continue;
    }
    if (c === '<') { endWord(); continue; } // input redirects are harmless; the file name becomes a word
    if (c === '\\' && i + 1 < src.length && !/[A-Za-z0-9_.\-]/.test(src[i + 1])) { cur += src[i + 1]; inWord = true; i++; continue; }
    cur += c;
    inWord = true;
  }
  endSegment();
  return segments;
}

function norm(p) {
  return p.replace(/\\/g, '/').toLowerCase();
}

function insideRunDir(p) {
  const n = norm(p);
  const k = n.indexOf(RUN_DIR);
  if (k === -1) return false;
  if (k > 0 && n[k - 1] !== '/') return false;
  return !n.slice(k).split('/').includes('..');
}

function cmdName(word) {
  return norm(word).split('/').pop().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

function checkRedirects(redirects) {
  for (const r of redirects) {
    if (r.op.endsWith('&')) continue; // 2>&1, >&2: fd duplication, no file
    const t = r.target.trim();
    if (NULL_TARGETS.has(t.toLowerCase())) continue;
    if (insideRunDir(t)) continue;
    deny(`output redirect '${r.op} ${t || '?'}' writes outside ${RUN_DIR}`);
  }
}

function checkGit(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    i += GIT_OPT_WITH_VALUE.has(a) ? 2 : 1;
  }
  const sub = args[i];
  if (!sub) return;
  const rest = args.slice(i + 1);
  if (GIT_WRITE.has(sub)) deny(`'git ${sub}' is a git write`);
  if (sub === 'branch' && rest.some((a) => GIT_BRANCH_WRITE.has(a))) deny(`'git branch ${rest.find((a) => GIT_BRANCH_WRITE.has(a))}' is a git write`);
  if (sub === 'worktree' && GIT_WORKTREE_WRITE.has(rest[0])) deny(`'git worktree ${rest[0]}' is a git write`);
}

function checkSegment(words, depth) {
  // drop leading VAR=value assignments and wrapper commands
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
    const n = cmdName(w);
    if (WRAPPERS.has(n)) {
      i++;
      while (i < words.length && words[i].startsWith('-')) i++; // wrapper flags, e.g. xargs -0
      continue;
    }
    break;
  }
  if (i >= words.length) return;
  const name = cmdName(words[i]);
  const args = words.slice(i + 1);

  if (name === 'git') return checkGit(args);

  if (['npm', 'pnpm', 'yarn'].includes(name) && ['install', 'i', 'ci', 'add'].includes(args[0])) deny(`'${name} ${args[0]}' installs packages`);
  if (name === 'dotnet' && args[0] === 'add') deny(`'dotnet add' changes project references`);
  if (name === 'dotnet' && args[0] === 'tool' && args[1] === 'install') deny(`'dotnet tool install' installs packages`);
  if (/^pip\d*(\.\d+)?$/.test(name) && args[0] === 'install') deny(`'${name} install' installs packages`);
  if (/^(python\d*(\.\d+)?|py)$/.test(name)) {
    const m = args.indexOf('-m');
    if (m !== -1 && /^pip\d*$/.test(args[m + 1] || '') && args[m + 2] === 'install') deny(`'${name} -m pip install' installs packages`);
  }

  if (name === 'sed' && args.some((a) => a === '--in-place' || a.startsWith('--in-place=') || /^-[^-]*i/.test(a))) deny(`'sed -i' edits files in place`);
  if (name === 'perl' && args.some((a) => /^-[^-]*i/.test(a))) deny(`'perl -i' edits files in place`);
  if (DELETE_MOVE.has(name)) deny(`'${words[i]}' deletes or moves files`);
  if (name === 'find') {
    if (args.includes('-delete')) deny(`'find -delete' deletes files`);
    const x = args.findIndex((a) => a === '-exec' || a === '-execdir' || a === '-ok');
    if (x !== -1) checkSegment(args.slice(x + 1).filter((a) => a !== ';' && a !== '{}' && a !== '+'), depth);
  }

  if (name === 'tee' || name === 'tee-object') {
    const files = [];
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (/^-(filepath|literalpath|path|variable)$/i.test(a)) { if (!/^-variable$/i.test(a)) files.push(args[k + 1] || ''); k++; continue; }
      if (a.startsWith('-')) continue;
      files.push(a);
    }
    for (const f of files) if (!NULL_TARGETS.has(f.toLowerCase()) && !insideRunDir(f)) deny(`'${words[i]} ${f}' writes outside ${RUN_DIR}`);
  }
  if (WRITE_CMDLETS.has(name)) {
    let target = '';
    for (let k = 0; k < args.length; k++) {
      if (/^-(filepath|literalpath|path)$/i.test(args[k])) { target = args[k + 1] || ''; break; }
      if (/^-(value|encoding|inputobject|width|stream)$/i.test(args[k])) { k++; continue; }
      if (!args[k].startsWith('-') && !target) { target = args[k]; break; }
    }
    if (!insideRunDir(target)) deny(`'${words[i]} ${target || '?'}' writes outside ${RUN_DIR}`);
  }

  // nested shells: bash -c "...", pwsh -Command "...", cmd /c ...
  if (SHELLS.has(name) && depth < 3) {
    const flag = args.findIndex((a) => /^(-c|-command|\/c|\/k)$/i.test(a));
    if (flag !== -1 && args[flag + 1] !== undefined) {
      const inner = name === 'cmd' ? args.slice(flag + 1).join(' ') : args[flag + 1];
      checkCommand(inner, depth + 1);
    }
  }
}

function checkCommand(command, depth) {
  for (const seg of lex(command)) {
    checkRedirects(seg.redirects);
    checkSegment(seg.words, depth);
  }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    deny('could not parse the hook input, so the command was refused');
  }
  const command = input && input.tool_input && input.tool_input.command;
  if (typeof command !== 'string') process.exit(0); // not a shell call
  checkCommand(command, 0);
  process.exit(0);
});
