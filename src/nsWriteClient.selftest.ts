/**
 * Offline test for NsWriteClient — device create/get/delete against a recording mock fetch (no live
 * creds). Asserts the exact v2 paths, methods, bodies (incl. synchronous:'yes'), auth header, URI
 * encoding, the inline created-device return (with its generated SIP password), error shape, and the
 * bare-server SSRF guard. tsx src/nsWriteClient.selftest.ts
 */
import { NsWriteClient } from './index.js';
import { NsApiError } from './nsClient.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); };

interface Recorded { method: string; url: string; headers: Record<string, string>; body?: any }
let last: Recorded = { method: '', url: '', headers: {} };
const mk = (status: number, body: unknown) =>
  (async (input: any, init: any = {}) => {
    last = {
      method: init.method ?? 'GET',
      url: String(input),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

const client = (status = 200, body: unknown = {}) =>
  new NsWriteClient({ server: 'api.example.com', token: 'tok', fetchImpl: mk(status, body) });

const B = 'https://api.example.com/ns-api/v2';

(async () => {
  // createDevice → POST .../devices with { device, synchronous:'yes' }, returns the created device inline.
  const created = await client(200, { device: '100r', 'device-sip-registration-password': 'SEKRET1234567890' })
    .createDevice('acme.example', '100', '100r');
  ok(last.method === 'POST', 'createDevice uses POST');
  ok(last.url === `${B}/domains/acme.example/users/100/devices`, 'createDevice hits the devices collection path');
  ok(last.body?.device === '100r', 'createDevice body carries the device id');
  ok(last.body?.synchronous === 'yes', 'createDevice injects synchronous:yes (200 + inline resource, no 202 lag)');
  ok(last.headers.Authorization === 'Bearer tok', 'createDevice sends bearer auth');
  ok((created as any)['device-sip-registration-password'] === 'SEKRET1234567890', 'createDevice returns the inline device incl. the generated SIP password');

  // getDevices → GET .../devices (returns an array even for a single object)
  const list = await client(200, { device: '100r' }).getDevices('acme.example', '100');
  ok(last.method === 'GET' && last.url === `${B}/domains/acme.example/users/100/devices`, 'getDevices GETs the collection');
  ok(Array.isArray(list) && (list[0] as any).device === '100r', 'getDevices normalizes a single object to an array');

  // getDevice → GET .../devices/{device}
  await client(200, { device: '100r' }).getDevice('acme.example', '100', '100r');
  ok(last.method === 'GET' && last.url === `${B}/domains/acme.example/users/100/devices/100r`, 'getDevice GETs the specific device');

  // deleteDevice → DELETE .../devices/{device}
  await client(200, {}).deleteDevice('acme.example', '100', '100r');
  ok(last.method === 'DELETE' && last.url === `${B}/domains/acme.example/users/100/devices/100r`, 'deleteDevice DELETEs the specific device');
  ok(last.body === undefined, 'deleteDevice sends no body');

  // Path params are URI-encoded.
  await client(200, []).getDevices('a b.example', '10@0');
  ok(last.url === `${B}/domains/a%20b.example/users/10%400/devices`, 'path params are URI-encoded');

  // A non-2xx write throws NsApiError carrying status + method.
  let err: any;
  try { await client(403, { message: 'nope' }).createDevice('acme.example', '100', '100r'); } catch (e) { err = e; }
  ok(err instanceof NsApiError && err.status === 403 && err.method === 'POST', 'a non-ok write throws NsApiError with status + method');

  // Bare-server SSRF guard (reused from the read client).
  let guarded = false;
  try { new NsWriteClient({ server: 'api.example.com@evil.example', token: 't' }); } catch { guarded = true; }
  ok(guarded, 'NsWriteClient rejects a non-bare server (SSRF guard)');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
