#!/usr/bin/env node
// Print a markdown changelog of commits in a range.
// Default range: <last-tag>..HEAD. Pass a custom range as arg 1.
//
//   node scripts/changelog.mjs                # since last tag
//   node scripts/changelog.mjs v0.1.0..HEAD   # explicit range
//   node scripts/changelog.mjs v0.1.0..v0.1.1
//
// Pipe into `gh release create` or copy into the marketplace release notes.

import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

function resolveRange(arg) {
  if (arg) return arg;
  try {
    const last = git('describe', '--tags', '--abbrev=0');
    return `${last}..HEAD`;
  } catch {
    return '';
  }
}

const range = resolveRange(process.argv[2]);
const fmt = '--pretty=format:- %s (%h)';
const log = range
  ? git('log', '--no-merges', fmt, range)
  : git('log', '--no-merges', fmt);

const heading = range ? `## ${range}` : '## All commits';
process.stdout.write(`${heading}\n\n${log || '_(no commits)_'}\n`);
