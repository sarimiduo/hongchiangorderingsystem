'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { send, readBody, bearerOk, requireEnv } = require('../server/http-util');

test('bearerOk compares the Authorization header exactly', () => {
  assert.equal(bearerOk({ headers: { authorization: 'Bearer abc' } }, 'abc'), true);
  assert.equal(bearerOk({ headers: { authorization: 'Bearer abd' } }, 'abc'), false);
  assert.equal(bearerOk({ headers: {} }, 'abc'), false);
  assert.equal(bearerOk({ headers: { authorization: 'Bearer ' } }, ''), false, 'empty token never matches');
});

test('send writes JSON with no-store; readBody parses JSON', async () => {
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req);
    send(res, 201, { echo: body });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: JSON.stringify({ a: 1 }) });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { echo: { a: 1 } });
  srv.close();
});

test('requireEnv exits with the missing names', () => {
  const calls = [];
  const origExit = process.exit, origErr = console.error;
  process.exit = c => { calls.push(['exit', c]); };
  console.error = m => { calls.push(['err', m]); };
  try {
    requireEnv(['DEFINITELY_UNSET_X', 'DEFINITELY_UNSET_Y'], 'test');
  } finally { process.exit = origExit; console.error = origErr; }
  assert.deepEqual(calls[1], ['exit', 1]);
  assert.match(calls[0][1], /DEFINITELY_UNSET_X, DEFINITELY_UNSET_Y/);
});
