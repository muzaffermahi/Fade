import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Type } from 'typebox';
import { validate } from '../src/contracts.js';
const Manifest = Type.Object({name:Type.String(),version:Type.String(),private:Type.Boolean(),license:Type.String(),bin:Type.Record(Type.String(),Type.String()),files:Type.Array(Type.String()),dependencies:Type.Record(Type.String(),Type.String())});
const manifest = validate(Manifest, JSON.parse(readFileSync('package.json','utf8')));
test('G47/G48/G50 F-RELEASE F24: scoped candidate/stable manifest has both aliases and an intentional product inventory', () => {
  assert.equal(manifest.name,'@muzaffermahi/fade');assert.match(manifest.version,/^1\.0\.0(?:-rc\.\d+)?$/);assert.equal(manifest.private,manifest.version.includes('-'));assert.equal(manifest.license,'MIT');
  assert.deepEqual(manifest.bin,{Fade:'dist/cli.js',fade:'dist/cli.js'});
  for(const name of ['pi-ai','pi-coding-agent','pi-tui','pi-agent-core','pi-codemode','pi-mcp'])assert.equal(manifest.dependencies['@earendil-works/'+name],'1.0.4');
  assert.equal(manifest.dependencies['@earendil-works/chord'],'1.0.4');
  for(const required of ['src/app.ts','dist/cli.js','src/diagnostics.ts','dist/diagnostics.js','docs/install.md','LICENSE','THIRD_PARTY_NOTICES.md','SECURITY.md'])assert.ok(manifest.files.includes(required),required);
  assert.ok(manifest.files.every(path=>!path.endsWith('/')&&!/(?:\.fade|\.git|node_modules|lmstudio-agent|run3|_debug|^tests\/|^scripts\/|^work-orders\/)/.test(path)));
  const lock=validate(Type.Object({name:Type.String(),version:Type.String(),packages:Type.Object({'':Type.Object({name:Type.String(),version:Type.String(),bin:Type.Record(Type.String(),Type.String())})})}),JSON.parse(readFileSync('package-lock.json','utf8')));
  assert.equal(lock.name,manifest.name);assert.equal(lock.version,manifest.version);assert.equal(lock.packages[''].version,manifest.version);assert.deepEqual(lock.packages[''].bin,manifest.bin);
  const notices=readFileSync('THIRD_PARTY_NOTICES.md','utf8');assert.match(notices,/pi-coding-agent/);assert.match(notices,/Permission is hereby granted/);
});
test('F-RELEASE: release and installation helpers parse under Node without shell-dependent npm shims', () => {
  for(const name of ['npm-cli','package-release','package-smoke','license-notices','qualify-live','verify'])execFileSync(process.execPath,['--check',resolve('scripts',name+'.mjs')]);
});
