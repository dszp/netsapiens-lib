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
import { NsClient, fetchDomainSnapshot } from './nsClient.js';
import { resolveFlow, listEntities } from './resolver.js';
import type { Snapshot } from './model.js';

const snapPath = process.argv[2];
if (!snapPath) {
  console.error('usage: tsx src/nsClient.selftest.ts <snapshot.json> [attendantsDir]');
  process.exit(2);
}
const raw = JSON.parse(readFileSync(snapPath, 'utf8')) as Snapshot;
const domain = String(raw.meta?.domain ?? raw.domain?.domain ?? '');

// Optional AA menu sidecars keyed by ext.
const attendantsDir = process.argv[3] ?? join(resolve(snapPath, '..'), 'attendants');
const aaByExt: Record<string, unknown> = {};
try {
  for (const f of readdirSync(attendantsDir).filter((f) => f.endsWith('.json'))) {
    const d = JSON.parse(readFileSync(join(attendantsDir, f), 'utf8'));
    aaByExt[String(d.user ?? f.replace(/\.json$/, ''))] = d;
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
  if (path === b) return j(raw.domain ?? { domain });
  if (path === `${b}/timeframes`) return j(raw.timeframes ?? []);
  if (path === `${b}/users`) return j(raw.users ?? []);
  if (path === `${b}/callqueues`) return j(raw.callqueues ?? []);
  if (path === `${b}/phonenumbers`) return j(raw.phonenumbers ?? []);
  if (path === `${b}/autoattendants`) return j(raw.autoattendants ?? []);
  let m = path.match(new RegExp(`^${b}/users/([^/]+)/answerrules$`));
  if (m) return j(raw.answerrulesByUser?.[decodeURIComponent(m[1]!)] ?? []);
  m = path.match(new RegExp(`^${b}/callqueues/([^/]+)/agents$`));
  if (m) return j(raw.agentsByQueue?.[decodeURIComponent(m[1]!)] ?? []);
  m = path.match(new RegExp(`^${b}/users/([^/]+)/autoattendants/([^/]+)$`));
  if (m) {
    const detail = aaByExt[decodeURIComponent(m[1]!)];
    return detail ? j(detail) : notFound();
  }
  if (path === `${b}/dialplans/${domain}/dialrules`) return j(raw.dialrulesByPlan?.[domain] ?? []);
  return notFound();
}) as unknown as typeof fetch;

let pass = 0;
let fail = 0;
const ok = (c: boolean, msg: string) => {
  c ? pass++ : fail++;
  console.log(`${c ? '✓' : '✗ FAIL'} ${msg}`);
};

(async () => {
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
