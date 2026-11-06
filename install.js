#!/usr/bin/env node
// Copies the skill and agents into ~/.claude, then installs the ui-ux-pro-max plugin.
// Pass --no-plugin to skip the plugin. A failed plugin install warns and leaves the skill usable.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MARKETPLACE_REPO = 'nextlevelbuilder/ui-ux-pro-max-skill';
const PLUGIN = 'ui-ux-pro-max@ui-ux-pro-max-skill';

const here = __dirname;
const claudeDir = path.join(os.homedir(), '.claude');

function copyFiles() {
  fs.cpSync(path.join(here, 'skills', 'alien-coding'), path.join(claudeDir, 'skills', 'alien-coding'), {
    recursive: true,
  });
  const agentsDir = path.join(claudeDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const name of fs.readdirSync(path.join(here, 'agents'))) {
    fs.copyFileSync(path.join(here, 'agents', name), path.join(agentsDir, name));
  }
  console.log(`Installed the skill and agents in ${claudeDir}`);
}

function claude(args) {
  // A shell finds claude.cmd on Windows; every argument here is a fixed string.
  const run = spawnSync(`claude ${args}`, { shell: true, encoding: 'utf8' });
  return { ok: run.status === 0, output: `${run.stdout || ''}${run.stderr || ''}`.trim() };
}

function installPlugin() {
  if (!claude('--version').ok) {
    return 'the claude command was not found';
  }
  const added = claude(`plugin marketplace add ${MARKETPLACE_REPO}`);
  if (!added.ok && !/already/i.test(added.output)) {
    return added.output;
  }
  const installed = claude(`plugin install ${PLUGIN}`);
  if (!installed.ok && !/already/i.test(installed.output)) {
    return installed.output;
  }
  console.log(`Installed the plugin ${PLUGIN}`);
  return null;
}

copyFiles();

if (process.argv.includes('--no-plugin')) {
  console.log('Skipped the ui-ux-pro-max plugin.');
} else {
  const problem = installPlugin();
  if (problem) {
    console.warn(`Could not install ${PLUGIN}: ${problem}`);
    console.warn('alien-coding still works without it. UI specs then come from your project\'s own rules.');
  }
}

console.log('Restart Claude Code so it finds the new agents.');
