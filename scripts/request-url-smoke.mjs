/** Invalid request URLs must not take down standalone or prefix-mounted handlers. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { createWorkbenchHandler } from '../server/lib/handler.mjs';

function request(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    // Use a raw request path so the HTTP client does not normalize bad URL input.
    const req = http.get({ hostname: '127.0.0.1', port, path: pathname, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
  });
}

let checks = 0;
try {
  for (const basePath of ['', '/live-workbench']) {
    const server = http.createServer(createWorkbenchHandler({ basePath }));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    try {
      for (const suffix of ['/%', '/%GG', '/%E0%A4%A', '/%FF']) {
        const response = await request(port, basePath + suffix);
        assert.equal(response.status, 400, suffix);
        assert.equal(JSON.parse(response.body).error, 'BAD_URL');
        checks++;
        const health = await request(port, `${basePath}/api/health`);
        assert.equal(health.status, 200, 'server remains usable after a malformed request');
        assert.equal(JSON.parse(health.body).ok, true);
        checks++;
      }

      const invalidHost = await request(port, `${basePath}/api/health`, { host: '[' });
      assert.equal(invalidHost.status, 400, 'invalid URL base is rejected');
      assert.equal(JSON.parse(invalidHost.body).error, 'BAD_URL');
      checks++;

      const invalidUrl = await request(port, '//[');
      assert.equal(invalidUrl.status, 400, 'invalid network-path URL is rejected');
      assert.equal(JSON.parse(invalidUrl.body).error, 'BAD_URL');
      checks++;

      for (const suffix of ['/api/health', '/%61pi/health', '/api/health?search=%']) {
        const response = await request(port, basePath + suffix);
        assert.equal(response.status, 200, suffix);
        assert.equal(JSON.parse(response.body).ok, true);
        checks++;
      }
      const unicode = await request(port, `${basePath}/api/${encodeURIComponent('茶')}`);
      assert.equal(unicode.status, 404, 'valid UTF-8 still reaches routing');
      assert.equal(JSON.parse(unicode.body).path, '/api/茶');
      checks++;
      if (basePath) {
        assert.equal((await request(port, '/api/health')).status, 404, 'mount boundary is preserved');
        checks++;
      }
      console.log(`[PASS] Request URL handling at ${basePath || '/'}`);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
  console.log(`[PASS] ${checks} request checks`);
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
}
