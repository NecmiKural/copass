import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { ADAPTERS } from '../agents/index.js';
import { handoverPaths, prepareStore, writeHandover } from '../lib/output.js';
import { tempDir } from './helpers.js';

test('writes owner-only files and a .gitignore, keeps the newest ten', () => {
  const project = tempDir('copass-out-');
  for (let i = 0; i < 12; i++) writeHandover(handoverPaths(project, Date.UTC(2026, 0, 1, 0, i)), `h${i}`, `t${i}`);
  const dir = join(project, '.copass');
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8').trim().split('\n').at(-1), '*');
  assert.equal(readFileSync(join(dir, 'latest.md'), 'utf8'), 'h11');
  assert.equal(statSync(join(dir, 'latest.md')).mode & 0o777, 0o600);
  assert.ok(!existsSync(join(dir, 'handover-2026-01-01T00-00-00.md')), 'oldest pruned');
  assert.ok(existsSync(join(dir, 'handover-2026-01-01T00-11-00.md')));
});

test('refuses a .copass symlink and never writes through a planted file symlink', () => {
  const victim = tempDir('copass-victim-');
  writeFileSync(join(victim, 'precious.txt'), 'keep me');

  const linkedStore = tempDir('copass-repo-');
  symlinkSync(victim, join(linkedStore, '.copass'));
  assert.throws(() => prepareStore(handoverPaths(linkedStore, Date.now())), /symlink/);

  const plantedFile = tempDir('copass-repo-');
  mkdirSync(join(plantedFile, '.copass'));
  symlinkSync(join(victim, 'precious.txt'), join(plantedFile, '.copass', 'latest.md'));
  writeHandover(handoverPaths(plantedFile, Date.now()), 'hand-over', 'transcript');
  assert.equal(readFileSync(join(victim, 'precious.txt'), 'utf8'), 'keep me');
  assert.ok(!lstatSync(join(plantedFile, '.copass', 'latest.md')).isSymbolicLink());
});

test('every adapter honours the contract', () => {
  const names = new Set();
  for (const a of ADAPTERS) {
    assert.match(a.name, /^[a-z][a-z0-9-]*$/);
    assert.ok(!names.has(a.name), `duplicate adapter name ${a.name}`);
    names.add(a.name);
    assert.equal(typeof a.label, 'string');
    for (const fn of ['findSessions', 'loadSession', 'launch']) assert.equal(typeof a[fn], 'function', `${a.name}.${fn}`);
    const launch = a.launch('hello');
    assert.ok(launch === null || (Array.isArray(launch) && typeof launch[0] === 'string' && Array.isArray(launch[1])), `${a.name}.launch`);
  }
});
