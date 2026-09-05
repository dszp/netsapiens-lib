/**
 * Offline end-to-end test for the portable NS client (no live creds):
 *   tsx src/nsClient.selftest.ts <snapshot.json> [attendantsDir]
 *
 * Serves the NS v2 read endpoints from a real fixture snapshot via a mock fetch, then asserts
 * that fetchDomainSnapshot() reconstructs a Snapshot which resolveFlow() turns into the SAME
 * FlowGraph as resolving the raw fixture directly. Proves the client's endpoint map + assembly.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NsApiError, NsClient, fetchDomainSnapshot } from './nsClient.js';
import { resolveFlow, listEntities } from './resolver.js';
import type { Snapshot } from './model.js';

// The fixture-diff test below (fetchDomainSnapshot vs a raw fixture, resolved both ways) needs a
// snapshot file and is skipped without one. The fake-client test further down needs nothing but
// the client, so it always runs — `pnpm exec tsx src/nsClient.selftest.ts` with no args exercises it.
const snapPath = process.argv[2];
const raw = snapPath ? (JSON.parse(readFileSync(snapPath, 'utf8')) as Snapshot) : undefined;
const domain = String(raw?.meta?.domain ?? raw?.domain?.domain ?? '');

// Optional AA menu sidecars keyed by ext.
const attendantsDir = snapPath ? (process.argv[3] ?? join(resolve(snapPath, '..'), 'attendants')) : undefined;
const aaByExt: Record<string, unknown> = {};
try {
  if (attendantsDir) {
    for (const f of readdirSync(attendantsDir).filter((f) => f.endsWith('.json'))) {
      const d = JSON.parse(readFileSync(join(attendantsDir, f), 'utf8'));
      aaByExt[String(d.user ?? f.replace(/\.json$/, ''))] = d;
    }
  }
} catch {
  /* no sidecars */
}

// Mock fetch: route NS v2 read paths to fixture data.
const j = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const notFound = () => new Response('[]', { status: 404 });
const mockFetch = (async (input: string) => {
  const path = new URL(String(input)).pathname.replace(/^\/ns-api\/v2/, '');
  const b = `/domains/${domain}`;
  if (path === b) return j(raw?.domain ?? { domain });
  if (path === `${b}/timeframes`) return j(raw?.timeframes ?? []);
  if (path === `${b}/users`) return j(raw?.users ?? []);
  if (path === `${b}/callqueues`) return j(raw?.callqueues ?? []);
  if (path === `${b}/phonenumbers`) return j(raw?.phonenumbers ?? []);
  if (path === `${b}/autoattendants`) return j(raw?.autoattendants ?? []);
  let m = path.match(new RegExp(`^${b}/users/([^/]+)/answerrules$`));
  if (m) return j(raw?.answerrulesByUser?.[decodeURIComponent(m[1]!)] ?? []);
  m = path.match(new RegExp(`^${b}/callqueues/([^/]+)/agents$`));
  if (m) return j(raw?.agentsByQueue?.[decodeURIComponent(m[1]!)] ?? []);
  m = path.match(new RegExp(`^${b}/users/([^/]+)/autoattendants/([^/]+)$`));
  if (m) {
    const detail = aaByExt[decodeURIComponent(m[1]!)];
    return detail ? j(detail) : notFound();
  }
  if (path === `${b}/dialplans/${domain}/dialrules`) return j(raw?.dialrulesByPlan?.[domain] ?? []);
  return notFound();
}) as unknown as typeof fetch;

let pass = 0;
let fail = 0;
const ok = (c: boolean, msg: string) => {
  c ? pass++ : fail++;
  console.log(`${c ? '✓' : '✗ FAIL'} ${msg}`);
};

(async () => {
  if (raw) {
    const client = new NsClient({ server: 'mock.local', token: 'x', fetchImpl: mockFetch });
    const rebuilt = await fetchDomainSnapshot(client, domain, { includeDialrules: true });

    // Feed the raw fixture its sidecar AA details too, so both sides render menus identically.
    const rawWithAa: Snapshot = { ...raw, attendantDetails: aaByExt as Record<string, any> };

    const ents = listEntities(rebuilt);
    const cases = [
      ...ents.dids.map((d) => ({ kind: 'did' as const, ref: d.ref })),
      ...ents.queues.map((q) => ({ kind: 'queue' as const, ref: q.ref })),
      ...ents.attendants.map((a) => ({ kind: 'attendant' as const, ref: a.ref })),
      ...ents.users.map((u) => ({ kind: 'user' as const, ref: u.ref })),
    ];
    ok(cases.length > 0, `enumerated ${cases.length} entities from the rebuilt snapshot`);

    let mismatches = 0;
    for (const c of cases) {
      const a = JSON.stringify(resolveFlow(rawWithAa, c));
      const b = JSON.stringify(resolveFlow(rebuilt, c));
      if (a !== b) {
        mismatches++;
        console.log(`   ✗ graph differs for ${c.kind} ${c.ref}`);
      }
    }
    ok(mismatches === 0, `all ${cases.length} flows identical: rebuilt-from-API vs raw fixture`);
  } else {
    console.log('(no fixture given — skipping the rebuilt-vs-raw comparison; usage: tsx src/nsClient.selftest.ts <snapshot.json> [attendantsDir])');
  }

  // -- the optional inventory reads ----------------------------------------------------------------
  {
    const seen: string[] = [];
    const fake = {
      get: async (p: string) => {
        seen.push(p);
        if (/\/users$/.test(p)) return [
          { user: '100', 'service-code': '' },
          { user: '700', 'service-code': 'system-aa' },
        ];
        if (/\/users\/100\/devices$/.test(p)) return [{ aor: 'sip:100@acme.example', 'device-models-model': 'Yealink T54W' }];
        if (/\/addresses$/.test(p)) return [{ 'address-id': '1' }];
        if (/\/smsnumbers/.test(p)) return [{ number: '13175550100' }];
        return [];
      },
    } as unknown as NsClient;

    const snap = await fetchDomainSnapshot(fake, 'acme.example', {
      includeAttendantMenus: false, includeAddresses: true, includeSmsNumbers: true, includeDevices: true,
    });

    ok(Array.isArray(snap.addresses) && snap.addresses.length === 1, 'addresses are read into the snapshot');
    ok(Array.isArray(snap.smsnumbers) && snap.smsnumbers.length === 1, 'SMS numbers are read into the snapshot');
    ok(seen.some((p) => p === '/domains/acme.example/smsnumbers?dest=*'), 'the SMS read carries dest=* - the live server refuses the documented no-parameter call');
    ok(snap.devicesByUser?.['100']?.length === 1, 'a real extension devices are read');
    ok(snap.devicesByUser?.['700'] === undefined, 'a system user costs no device call');
    ok(!seen.some((p) => /\/users\/700\/devices$/.test(p)), 'and none was made');

    const off = await fetchDomainSnapshot(fake, 'acme.example', { includeAttendantMenus: false });
    ok(off.addresses === undefined && off.smsnumbers === undefined && off.devicesByUser === undefined,
      'all three reads are opt-in - a caller that wants routing pays for none of them');
  }

  // -- a per-extension devices read that fails is reported, not swallowed -------------------------
  {
    const failFake = {
      get: async (p: string) => {
        if (/\/users$/.test(p)) return [
          { user: '100', 'service-code': '' },
          { user: '102', 'service-code': '' },
          { user: '103', 'service-code': '' },
        ];
        if (/\/users\/100\/devices$/.test(p)) return [{ aor: 'sip:100@acme.example' }];
        if (/\/users\/102\/devices$/.test(p)) throw new NsApiError('GET .../devices → 500', 500, p, null);
        if (/\/users\/103\/devices$/.test(p)) throw new NsApiError('GET .../devices → 404', 404, p, null);
        return [];
      },
    } as unknown as NsClient;

    const failSnap = await fetchDomainSnapshot(failFake, 'acme.example', { includeAttendantMenus: false, includeDevices: true });
    ok(failSnap.devicesByUser?.['100']?.length === 1, 'the extension whose read succeeded keeps its devices');
    ok(failSnap.devicesByUser?.['102'] === undefined, 'the extension whose read failed has no devicesByUser entry');
    ok(failSnap.devicesByUser?.['103'] === undefined, 'a 404 extension also has no devicesByUser entry');
    ok(JSON.stringify(failSnap.deviceReadFailures) === JSON.stringify(['102']),
      'deviceReadFailures names only the non-404 failure, not the 404');

    const okFake = {
      get: async (p: string) => {
        if (/\/users$/.test(p)) return [{ user: '100', 'service-code': '' }];
        if (/\/users\/100\/devices$/.test(p)) return [{ aor: 'sip:100@acme.example' }];
        return [];
      },
    } as unknown as NsClient;

    const okSnap = await fetchDomainSnapshot(okFake, 'acme.example', { includeAttendantMenus: false, includeDevices: true });
    ok(Array.isArray(okSnap.deviceReadFailures) && okSnap.deviceReadFailures.length === 0,
      'no failures - deviceReadFailures is an empty array, not absent');

    const noDevicesSnap = await fetchDomainSnapshot(okFake, 'acme.example', { includeAttendantMenus: false });
    ok(noDevicesSnap.deviceReadFailures === undefined, 'without includeDevices, deviceReadFailures is absent entirely');
  }

  // -- per-user SMS numbers: one call per REAL extension, opt-in, failures named like device reads --
  {
    const seen: string[] = [];
    const client = { get: async (p: string) => {
      seen.push(p);
      if (p.endsWith('/users')) return [{ user: '100', 'service-code': '' }, { user: '101', 'service-code': '' }, { user: '700', 'service-code': 'system-aa' }];
      if (p.endsWith('/users/100/smsnumbers')) return [{ number: '13175550100' }];
      if (p.endsWith('/users/101/smsnumbers')) throw new NsApiError('GET .../smsnumbers → 500', 500, p, null);
      if (/\/domains\/[^/]+$/.test(p)) return [{ domain: 'acme.example' }];
      return [];
    } } as unknown as NsClient;
    const snap = await fetchDomainSnapshot(client, 'acme.example', { includeAttendantMenus: false, includeUserSmsNumbers: true });
    ok(JSON.stringify(snap.smsNumbersByUser) === JSON.stringify({ '100': [{ number: '13175550100' }] }), 'per-user SMS numbers are filed under the extension');
    ok(JSON.stringify(snap.smsReadFailures) === JSON.stringify(['101']), 'a failed per-user SMS read is named');
    ok(!seen.some((p) => p.endsWith('/users/700/smsnumbers')), 'system users are not read');
    const plain = await fetchDomainSnapshot(client, 'acme.example', { includeAttendantMenus: false });
    ok(plain.smsNumbersByUser === undefined && plain.smsReadFailures === undefined, 'without the option neither field is present');

    // PRESENT AND EMPTY when every read answered — the same contract deviceReadFailures has, and the
    // distinction a consumer needs: absent means nobody asked, empty means nothing failed. An absent
    // field read as "nothing failed" would be a page claiming a clean read it never performed.
    const allOk = { get: async (p: string) => {
      if (p.endsWith('/users')) return [{ user: '100', 'service-code': '' }];
      if (p.endsWith('/users/100/smsnumbers')) return [{ number: '13175550100' }];
      if (/\/domains\/[^/]+$/.test(p)) return [{ domain: 'acme.example' }];
      return [];
    } } as unknown as NsClient;
    const clean = await fetchDomainSnapshot(allOk, 'acme.example', { includeAttendantMenus: false, includeUserSmsNumbers: true });
    ok(Array.isArray(clean.smsReadFailures) && clean.smsReadFailures.length === 0,
      'no failures - smsReadFailures is an empty array, not absent');

    // SORTED, not in completion order. These fill under mapLimit, so the fixture makes the FIRST-sorting
    // extension answer last; an unsorted list would come back ['101','100'] and the panel that prints it
    // would reshuffle between two reads of the same broken domain.
    const twoFails = { get: async (p: string) => {
      if (p.endsWith('/users')) return [{ user: '100', 'service-code': '' }, { user: '101', 'service-code': '' }];
      if (p.endsWith('/users/100/smsnumbers')) { await new Promise((r) => setTimeout(r, 10)); throw new NsApiError('GET .../smsnumbers → 500', 500, p, null); }
      if (p.endsWith('/users/101/smsnumbers')) throw new NsApiError('GET .../smsnumbers → 500', 500, p, null);
      if (/\/domains\/[^/]+$/.test(p)) return [{ domain: 'acme.example' }];
      return [];
    } } as unknown as NsClient;
    const sorted = await fetchDomainSnapshot(twoFails, 'acme.example', { includeAttendantMenus: false, includeUserSmsNumbers: true });
    ok(JSON.stringify(sorted.smsReadFailures) === JSON.stringify(['100', '101']),
      'two failures come back sorted, whichever order they completed in');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
