/**
 * Offline test for NsAuthClient — OAuth2 password-grant against a recording mock fetch (no live
 * creds). Asserts the token endpoint URL + form body, the token body passthrough, NsAuthError on a
 * non-2xx, and the verifyCredentials fail-closed contract (4xx -> ok:false, 5xx -> rethrow).
 * tsx src/nsAuthClient.selftest.ts
 */
import { NsAuthClient, NsAuthError } from './index.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); };

interface Recorded { url: string; body: string }
let last: Recorded = { url: '', body: '' };
const mk = (status: number, body: unknown) =>
  (async (input: any, init: any = {}) => {
    last = { url: String(input), body: String(init.body ?? '') };
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

const cfg = (fetchImpl: typeof fetch) => ({ server: 'api.example.com', clientId: 'cid', clientSecret: 'csec', fetchImpl });

(async () => {
  // passwordGrant posts a form to the token endpoint and returns the token body.
  const okBody = { access_token: 'tok', user: '100', domain: 'demo.12345.service' };
  const res = await new NsAuthClient(cfg(mk(200, okBody))).passwordGrant('100@demo', 'pw');
  ok(last.url === 'https://api.example.com/ns-api/oauth2/token/', 'passwordGrant posts to the token endpoint');
  ok(last.body.includes('grant_type=password'), 'passwordGrant body carries grant_type=password');
  ok(last.body.includes('client_id=cid'), 'passwordGrant body carries client_id');
  ok(last.body.includes('username=100%40demo'), 'passwordGrant body URI-encodes the username');
  ok(res.access_token === 'tok' && res.user === '100', 'passwordGrant returns the token body incl. user');

  // passwordGrant throws NsAuthError on a 400 (bad credentials).
  let err400: any;
  try { await new NsAuthClient(cfg(mk(400, { error: 'invalid_grant' }))).passwordGrant('x', 'y'); } catch (e) { err400 = e; }
  ok(err400 instanceof NsAuthError, 'passwordGrant throws NsAuthError on a 400');

  // verifyCredentials returns ok:true with the token on 200.
  const verifiedOk = await new NsAuthClient(cfg(mk(200, { access_token: 'tok', user: '100' }))).verifyCredentials('100@demo', 'pw');
  ok(verifiedOk.ok === true && verifiedOk.token?.access_token === 'tok', 'verifyCredentials returns ok:true with the token on 200');

  // verifyCredentials returns ok:false on a 401 (invalid creds).
  const verified401 = await new NsAuthClient(cfg(mk(401, { error: 'invalid_grant' }))).verifyCredentials('x', 'y');
  ok(verified401.ok === false && verified401.token === undefined, 'verifyCredentials returns ok:false on a 401');

  // verifyCredentials RETHROWS on a 5xx (caller fails closed).
  let err503: any;
  try { await new NsAuthClient(cfg(mk(503, 'upstream down'))).verifyCredentials('x', 'y'); } catch (e) { err503 = e; }
  ok(err503 instanceof NsAuthError, 'verifyCredentials rethrows NsAuthError on a 503');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
