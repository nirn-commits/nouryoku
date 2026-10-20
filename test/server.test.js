import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.GEMINI_API_KEY;
const { createServer } = await import('../server.js');

test('APIキー未設定なら 503 を返し、キーを露出しない', async () => {
  const srv = createServer().listen(0);
  const port = srv.address().port;
  try {
    const st = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
    assert.equal(st.gemini, false);
    const r = await fetch(`http://127.0.0.1:${port}/api/plan`, { method: 'POST', body: JSON.stringify({ role: 'player', observation: {} }) });
    assert.equal(r.status, 503);
    const r2 = await fetch(`http://127.0.0.1:${port}/%2e%2e/server.js`);
    assert.notEqual(r2.status, 200);
    const idx = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(idx.status, 200);
  } finally {
    srv.close();
  }
});
