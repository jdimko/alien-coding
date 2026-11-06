#!/usr/bin/env node
// Copies the skill and agents into ~/.claude. The skill installs the ui-ux-pro-max plugin on its first run.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const here = __dirname;
const claudeDir = path.join(os.homedir(), '.claude');

fs.cpSync(path.join(here, 'skills', 'alien-coding'), path.join(claudeDir, 'skills', 'alien-coding'), {
  recursive: true,
});
const agentsDir = path.join(claudeDir, 'agents');
fs.mkdirSync(agentsDir, { recursive: true });
for (const name of fs.readdirSync(path.join(here, 'agents'))) {
  fs.copyFileSync(path.join(here, 'agents', name), path.join(agentsDir, name));
}

console.log(`Installed the skill and agents in ${claudeDir}`);
console.log('Restart Claude Code so it finds the new agents.');
