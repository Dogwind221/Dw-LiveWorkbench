/** First authenticated startup and restart, using an isolated copy of the app. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = fs.mkdtempSync(path.join(root, '.startup-smoke-'));
let running;

async function start() {
  const reservation = http.createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const { port } = reservation.address();
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: fixture,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), WORKBENCH_AUTH: 'required' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.once('close', resolve));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Startup timed out')), 120000);
    child.stdout.on('data', () => {
      if (stdout.includes('PPT 引擎：')) {
        clearTimeout(timer);
        resolve(base);
      }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      reject(new Error(`Startup exited (${code}): ${stderr}`));
    });
  });
  return { child, closed, ready, output: () => stdout };
}

async function stop() {
  if (!running) return;
  if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill();
  await running.closed;
  running = undefined;
}

try {
  for (const item of ['server', 'web', 'package.json']) {
    fs.cpSync(path.join(root, item), path.join(fixture, item), { recursive: true });
  }

  running = await start();
  const base = await running.ready;
  const loginPage = await fetch(`${base}/login`, { signal: AbortSignal.timeout(5000) });
  assert.equal(loginPage.status, 200, 'fresh authenticated startup serves the login page');
  await loginPage.text();
  // Credentials stay in memory; never print the captured startup output.
  const password = running.output().match(/密\s*码：([^\r\n]+)/)?.[1].trim();
  assert.ok(password, 'fresh startup prints a generated admin password');
  const loginAddress = running.output().match(/登录地址：([^\r\n]+)/)?.[1];
  assert.equal(loginAddress, `${base}/login`, 'startup prints the working login URL');
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }), signal: AbortSignal.timeout(5000),
  });
  assert.equal(login.status, 200, 'the generated admin can log in');
  const result = await login.json();
  assert.equal(result.user.username, 'admin');
  assert.equal(result.user.isAdmin, true);
  console.log('[PASS] Fresh authenticated startup and generated-admin login');
  await stop();

  const usersFile = path.join(fixture, 'data/users.json');
  const usersBefore = fs.readFileSync(usersFile, 'utf8');
  running = await start();
  const restartBase = await running.ready;
  const restartPage = await fetch(`${restartBase}/login`, { signal: AbortSignal.timeout(5000) });
  assert.equal(restartPage.status, 200);
  await restartPage.text();
  assert.ok(!/密\s*码：/.test(running.output()), 'restart does not print another password');
  assert.equal(fs.readFileSync(usersFile, 'utf8'), usersBefore, 'restart preserves existing users');
  console.log('[PASS] Authenticated restart preserves the admin without printing another password');
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  await stop();
  assert.equal(path.dirname(fixture), root);
  assert.ok(path.basename(fixture).startsWith('.startup-smoke-'));
  fs.rmSync(fixture, { recursive: true, force: true });
}
