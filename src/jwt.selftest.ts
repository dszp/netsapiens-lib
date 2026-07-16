/**
 * Runnable self-test for the portable JWT module (no test framework needed):
 *   npm run test:jwt   (or: tsx src/jwt.selftest.ts)
 *
 * Crafts synthetic tokens (test-side base64url via Buffer is fine — the module under test is
 * Buffer-free) and a mock fetch, then asserts the local gate, context extraction, live check,
 * and the cache behavior that keeps the NS API from being hammered.
 */
import { createHmac } from 'node:crypto';
import { validateJwtFormat, verify, assertClaims, MemoryVerdictCache, tokenKey } from './jwt.js';

const b64url = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const mk = (payload: Record<string, unknown>) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`;
/** HS256-sign a token with a real HMAC (test-side node crypto; the module under test stays portable). */
const sign = (payload: Record<string, unknown>, secret: string) => {
  const h = b64url({ alg: 'HS256', typ: 'JWT' });
  const p = b64url(payload);
  const s = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
};

const now = Date.UTC(2026, 6, 10, 12, 0, 0);
const ISS = 'manage.example.com';
const AUD_ISS = { aud: 'ns', iss: ISS };
const future = mk({ ...AUD_ISS, sub: '9000@acme.12345.service', user_scope: 'Office Manager', exp: Math.floor(now / 1000) + 3600, name_u: 'Ünïçödé' });
const past = mk({ ...AUD_ISS, sub: '100@acme.12345.service', exp: Math.floor(now / 1000) - 10 });

let pass = 0;
let fail = 0;
const ok = (c: boolean, m: string) => {
  c ? pass++ : fail++;
  console.log(`${c ? '✓' : '✗ FAIL'} ${m}`);
};

(async () => {
  const f = validateJwtFormat(future, now);
  ok(f.validFormat && f.unexpired, 'format: valid & unexpired');
  ok(f.context.domain === 'acme.12345.service' && f.context.user === '9000' && f.context.scope === 'Office Manager', 'format: domain/user/scope from sub+claim');
  ok((f.payload as Record<string, unknown>)['name_u'] === 'Ünïçödé', 'format: UTF-8 payload decodes (no Buffer)');
  ok(!validateJwtFormat(past, now).unexpired, 'format: expired token flagged');
  ok(!validateJwtFormat('a.b', now).validFormat, 'format: 2-segment token rejected');

  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return { status: 200, ok: true };
  }) as unknown as typeof fetch;
  const cache = new MemoryVerdictCache();
  const v1 = await verify(future, { server: 'api.example.com', mode: 'live', expectedIss: ISS, cache, fetchImpl, nowMs: now });
  ok(v1.ok && v1.live === 'valid' && !v1.fromCache && calls === 1, 'live: first call hits server, valid');
  const v2 = await verify(future, { server: 'api.example.com', mode: 'live', expectedIss: ISS, cache, fetchImpl, nowMs: now });
  ok(v2.ok && v2.fromCache === true && calls === 1, 'live: second call from cache (no extra roundtrip)');
  // The persisted verdict must NOT carry the full decoded claims blob (PII): nothing downstream reads
  // verdict.payload (toPrincipal uses the typed context fields), so it's trimmed before caching.
  const stored = await cache.get(await tokenKey(future));
  ok(!!stored && !('payload' in stored), 'cache: decoded claims payload NOT persisted (PII trim)');
  ok(!('payload' in v2), 'cache: verdict served from cache carries no raw payload');

  let calls2 = 0;
  const bad = (async () => {
    calls2++;
    return { status: 401, ok: false };
  }) as unknown as typeof fetch;
  const c2 = new MemoryVerdictCache();
  const b1 = await verify(future, { server: 'x', mode: 'live', expectedIss: ISS, cache: c2, fetchImpl: bad, nowMs: now });
  const b2 = await verify(future, { server: 'x', mode: 'live', expectedIss: ISS, cache: c2, fetchImpl: bad, nowMs: now });
  ok(!b1.ok && b1.live === 'invalid' && b1.statusCode === 401, 'live: 401 → invalid');
  ok(b2.fromCache === true && calls2 === 1, 'live: negative verdict cached');

  let calls3 = 0;
  const spy = (async () => {
    calls3++;
    return { status: 200, ok: true };
  }) as unknown as typeof fetch;
  const e = await verify(past, { server: 'x', mode: 'live', expectedIss: ISS, fetchImpl: spy, nowMs: now });
  ok(!e.ok && calls3 === 0, 'gate: expired token short-circuits before roundtrip');

  // forceFresh: a logged-out/revoked token still passes from a stale cached verdict, but a
  // force-fresh check (writes / sensitive reads) re-hits the server AND overwrites the stale entry.
  let ffStatus = 200;
  let ffCalls = 0;
  const ffFetch = (async () => {
    ffCalls++;
    return { status: ffStatus, ok: ffStatus < 400 };
  }) as unknown as typeof fetch;
  const c3 = new MemoryVerdictCache();
  const ffOpt = { server: 'x', mode: 'live' as const, expectedIss: ISS, cache: c3, fetchImpl: ffFetch, nowMs: now };
  const f1 = await verify(future, ffOpt);
  ok(f1.ok && ffCalls === 1, 'forceFresh: initial live check valid + cached');
  ffStatus = 401; // token now logged out server-side
  const f2 = await verify(future, ffOpt);
  ok(f2.ok && f2.fromCache === true && ffCalls === 1, 'forceFresh: stale cached verdict still passes (the gap)');
  const f3 = await verify(future, { ...ffOpt, forceFresh: true });
  ok(!f3.ok && f3.live === 'invalid' && !f3.fromCache && ffCalls === 2, 'forceFresh: bypasses cache, catches revocation');
  const f4 = await verify(future, ffOpt);
  ok(!f4.ok && f4.fromCache === true && ffCalls === 2, 'forceFresh: overwrote cache → later cheap reads reject too');

  // aud / iss assertions — pure claim check (independent of signature/roundtrip).
  ok(assertClaims({ aud: 'ns', iss: ISS }, { iss: ISS }).ok, 'claims: aud=ns + matching iss pass');
  ok(!assertClaims({ aud: 'notns', iss: ISS }, { iss: ISS }).ok, 'claims: wrong aud rejected (default aud=ns)');
  ok(!assertClaims({ aud: 'ns', iss: 'evil.example.com' }, { iss: ISS }).ok, 'claims: wrong iss rejected');
  // `iss` has NO default: a default would be one specific portal, silently binding every consumer to
  // it. Omitting the expectation must FAIL CLOSED, not skip the check.
  const noIssExp = assertClaims({ aud: 'ns', iss: ISS });
  ok(!noIssExp.ok && /iss expectation missing/.test(noIssExp.reason ?? ''),
    'claims: no iss expectation ⇒ fails CLOSED (no default issuer)');

  // Several portal hostnames can front the same backend (a branded host + the vendor's unbranded one),
  // so `iss` takes a list, mirroring `aud`. Exact match only — no wildcards.
  const MULTI = ['manage.example.com', 'manage.vendor.example'];
  ok(assertClaims({ aud: 'ns', iss: 'manage.example.com' }, { iss: MULTI }).ok, 'claims: iss list — first issuer accepted');
  ok(assertClaims({ aud: 'ns', iss: 'manage.vendor.example' }, { iss: MULTI }).ok, 'claims: iss list — second issuer accepted');
  ok(!assertClaims({ aud: 'ns', iss: 'evil.example.com' }, { iss: MULTI }).ok, 'claims: iss list — an unlisted issuer is still rejected');
  ok(!assertClaims({ aud: 'ns', iss: 'evil.vendor.example' }, { iss: ['*.vendor.example'] }).ok,
    'claims: NO wildcard matching — "*.vendor.example" is a literal, not a pattern');
  ok(!assertClaims({ aud: 'ns', iss: ISS }, { iss: [] }).ok, 'claims: empty iss list ⇒ fails CLOSED (not "allow any")');
  ok(!assertClaims({ aud: 'ns', iss: ISS }, { iss: ['  ', ''] }).ok, 'claims: blank-only iss list ⇒ fails CLOSED');
  ok(assertClaims({ aud: 'ns', iss: 'evil.example.com' }, { validateIss: false }).ok, 'claims: validateIss:false lets a foreign issuer through');
  ok(assertClaims({ aud: ['ns', 'other'] }, { validateIss: false }).ok, 'claims: aud as array accepted');

  // verify() rejects wrong aud locally, before any roundtrip (reason carries the cause).
  const fmtOpt = { server: 'x', mode: 'format' as const, expectedIss: ISS, nowMs: now };
  const badAud = mk({ aud: 'notns', iss: 'manage.example.com', sub: 'a@b', exp: Math.floor(now / 1000) + 3600 });
  const rAud = await verify(badAud, fmtOpt);
  ok(!rAud.ok && /aud mismatch/.test(rAud.reason ?? ''), 'verify: wrong aud rejected locally (no roundtrip)');

  // #4: format-mode `ok` requires a LOCALLY-VERIFIED signature (else 'unverified' ⇒ NOT ok).
  const SECRET = 'test-ns-shared-secret';
  const goodClaims = { ...AUD_ISS, sub: '100@acme', exp: Math.floor(now / 1000) + 3600 };
  const signed = sign(goodClaims, SECRET);
  const sv = await verify(signed, { ...fmtOpt, signingSecret: SECRET });
  ok(sv.ok && sv.signature === 'valid', 'format: ok ONLY with a verified signature');
  const noSecret = await verify(future, fmtOpt);
  ok(!noSecret.ok && noSecret.signature === 'unverified', 'format: no secret ⇒ NOT ok (unverified — use mode:live to authenticate)');
  const swrong = await verify(signed, { ...fmtOpt, signingSecret: 'wrong-secret' });
  ok(!swrong.ok && swrong.signature === 'invalid', 'sig: wrong secret rejected');
  const tampered = `${signed.split('.')[0]}.${b64url({ ...goodClaims, sub: 'attacker@evil' })}.${signed.split('.')[2]}`;
  ok(!(await verify(tampered, { ...fmtOpt, signingSecret: SECRET })).ok, 'sig: tampered payload rejected');
  const algNone = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(goodClaims)}.`;
  ok(!(await verify(algNone, { ...fmtOpt, signingSecret: SECRET })).ok, 'sig: alg:none rejected when a secret is set');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
