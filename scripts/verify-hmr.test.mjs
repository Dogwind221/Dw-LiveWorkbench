/** Test the verifier's evidence checks, not DSH's module-replacement implementation. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const original = 'export const value = 1;\n';
const edited = '// concurrent user edit\n';

async function runScenario(mode, { keep = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workbench-hmr-test-'));
  let child;
  let done = false;
  let watcher;
  try {
    for (const dir of ['scripts', 'server/lib', 'plugin/dsh-live-workbench']) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    const script = join(root, 'scripts/verify-hmr.mjs');
    copyFileSync(new URL('./verify-hmr.mjs', import.meta.url), script);
    const files = Object.fromEntries(['handler', 'paths'].map(name => [name, join(root, `server/lib/${name}.mjs`)]));
    for (const file of Object.values(files)) writeFileSync(file, original);
    const log = join(root, 'plugin/dsh-live-workbench/.activation.log');
    const logLine = message => appendFileSync(log, `${new Date().toISOString()} ${message}\n`);
    writeFileSync(log, '');
    const seen = new Set();
    let restoreReported = false;
    child = spawn(process.execPath, [script, '--wait', '700', ...(keep ? ['--keep'] : [])]);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const finished = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    // Minimal host fixture: selectively evaluate actual edited ESM modules.
    watcher = (async () => {
      while (!done) {
        for (const [name, file] of Object.entries(files)) {
          const source = readFileSync(file, 'utf8');
          const token = source.match(/\/\/ hmr-verify ([a-f0-9]+)/)?.[1];
          if (!token || seen.has(name)) continue;
          seen.add(name);
          if (mode === 'unrelated') {
            logLine('apply() basePath=/unrelated');
            logLine('activated basePath=/unrelated');
            continue;
          }
          if (mode === 'entry-only' && name === 'paths') continue;
          if (mode === 'dependency-only' && name === 'handler') continue;
          await import(`${pathToFileURL(file).href}?probe=${token}`);
          if (mode === 'failed-activation') {
            logLine('activate failed: simulated registration failure');
          } else {
            logLine('activated basePath=/live-workbench');
            logLine('apply() basePath=/live-workbench');
          }
          if (mode === 'concurrent-edit') appendFileSync(file, edited);
        }
        if (mode === 'entry-only' && seen.has('paths') && !restoreReported
          && readFileSync(files.handler, 'utf8') === original) {
          restoreReported = true;
          // Restoration of the previous case can finish during the next case.
          logLine('disposed basePath=/live-workbench');
          logLine('activated basePath=/live-workbench');
          logLine('apply() basePath=/live-workbench');
        }
        await sleep(10);
      }
    })();
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Verifier timed out')), 10000);
    });
    let result;
    try {
      result = await Promise.race([finished, timeoutPromise, watcher]);
    } finally {
      clearTimeout(timeout);
    }
    done = true;
    await watcher;
    assert.equal(result.signal, null, output);
    assert.deepEqual([...seen], ['handler', 'paths'], output);
    const contents = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, readFileSync(file, 'utf8')]));
    return { ...result, output, contents, restoreReported };
  } finally {
    done = true;
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve));
      child.kill();
      await closed;
    }
    if (watcher) await watcher.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

test('passes when both edited modules execute and activation follows; restores sources', async () => {
  const result = await runScenario('success');
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.contents, { handler: original, paths: original });
});

test('failed activation does not pass even after the module executes', async () => {
  const result = await runScenario('failed-activation');
  assert.equal(result.code, 1, result.output);
  assert.deepEqual(result.contents, { handler: original, paths: original });
});

test('unrelated successful activation is insufficient without this module evaluating', async () => {
  const result = await runScenario('unrelated');
  assert.equal(result.code, 1, result.output);
});

test('restoring the handler cannot pass the dependency case', async () => {
  const result = await runScenario('entry-only');
  assert.equal(result.code, 2, result.output);
  assert.equal(result.restoreReported, true);
});

test('dependency-only success is reported as incomplete', async () => {
  const result = await runScenario('dependency-only');
  assert.equal(result.code, 1, result.output);
  assert.doesNotMatch(result.output, /两类重载都没观察到/);
});

test('cleanup preserves edits made while waiting', async () => {
  const result = await runScenario('concurrent-edit');
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.contents, { handler: original + edited, paths: original + edited });
});

test('--keep leaves the requested evaluation probes in place', async () => {
  const result = await runScenario('success', { keep: true });
  assert.equal(result.code, 0, result.output);
  for (const source of Object.values(result.contents)) assert.match(source, /hmr-verify-evaluated/);
});
