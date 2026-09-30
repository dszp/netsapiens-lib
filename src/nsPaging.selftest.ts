/**
 * Selftests for list paging: NetSapiens v2 returns only the first 100 records of a list when the
 * request carries no `limit`, so `NsClient.get` / `NsWriteClient.get` must page. Fully offline — a
 * stub `fetch` serves the platform's observed behaviour (100 bare, `limit`/`start` honoured).
 *
 * Run: pnpm test:nspaging
 */
import { NsClient, NsIncompleteListError, fetchDomainSnapshot, listDomains } from './nsClient.js';
import { NsWriteClient } from './nsWriteClient.js';

let pass = 0,
  fail = 0;
const ok = (c: boolean, m: string) => {
  c ? pass++ : fail++;
  console.log(`${c ? '✓' : '✗ FAIL'} ${m}`);
};

type Route = (q: URLSearchParams) => unknown;
/** Serves `rows` like the platform: 100 when `limit` is absent; `limit`/`start` honoured. */
const paged = (rows: unknown[]): Route => (q) => {
  const limit = q.has('limit') ? Number(q.get('limit')) : 100;
  const start = q.has('start') ? Number(q.get('start')) : 0;
  return rows.slice(start, start + limit);
};
/** Caps at 100 and ignores `start` — paging cannot complete. */
const ignoresStart = (rows: unknown[]): Route => () => rows.slice(0, 100);
/** Ignores `limit` entirely and returns everything. */
const ignoresLimit = (rows: unknown[]): Route => () => rows;

const recs = (n: number, key = 'user') => Array.from({ length: n }, (_, i) => ({ [key]: String(1000 + i) }));

function stub(routes: Record<string, unknown | Route>) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string) => {
    const u = new URL(input);
    urls.push(u.pathname.replace('/ns-api/v2', '') + u.search);
    const path = u.pathname.replace('/ns-api/v2', '');
    if (!(path in routes)) return new Response(JSON.stringify({ code: 404 }), { status: 404 });
    const r = routes[path];
    const body = typeof r === 'function' ? (r as Route)(u.searchParams) : r;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

const D = 'testco.12345.service';
const base = `/domains/${D}`;

// ── NsClient.get ──
{
  const { fetchImpl, urls } = stub({ '/x': paged(recs(250)) });
  const c = new NsClient({ server: 'api.example.com', token: 't', fetchImpl });
  const all = (await c.get<unknown[]>('/x')) as { user: string }[];
  ok(all.length === 250, `get() pages a 250-record list to the end (got ${all.length})`);
  ok(all[249]?.user === '1249', 'the last record is the 250th, in order');
  ok(urls.length === 3 && urls[2]!.includes('start=200'), `three requests, the last at start=200 (${urls.join(' ')})`);
}
{
  const { fetchImpl, urls } = stub({ '/x': paged(recs(100)) });
  const c = new NsClient({ server: 'api.example.com', token: 't', fetchImpl });
  const all = (await c.get<unknown[]>('/x')) as unknown[];
  ok(all.length === 100 && urls.length === 2, 'exactly 100 records: a second, empty page confirms the end');
}
{
  const { fetchImpl, urls } = stub({ '/x': paged(recs(250)) });
  const c = new NsClient({ server: 'api.example.com', token: 't', fetchImpl });
  const one = (await c.get<unknown[]>('/x', { limit: 10 })) as unknown[];
  ok(one.length === 10 && urls.length === 1, 'a caller-supplied limit is one request, exactly as asked');
  const two = (await c.get<unknown[]>('/x?limit=20&start=5')) as unknown[];
  ok(two.length === 20 && urls.length === 2, 'a limit in the path query string is honoured the same way');
}
{
  const { fetchImpl } = stub({ '/d': { domain: D } });
  const c = new NsClient({ server: 'api.example.com', token: 't', fetchImpl });
  const d = await c.get<{ domain: string }>('/d');
  ok(!Array.isArray(d) && d.domain === D, 'a detail (object) response is returned unchanged');
}
{
  const { fetchImpl, urls } = stub({ '/x': ignoresLimit(recs(150)) });
  const c = new NsClient({ server: 'api.example.com', token: 't', fetchImpl });
  const all = (await c.get<unknown[]>('/x')) as unknown[];
  ok(all.length === 150 && urls.length === 1, 'a route that ignores `limit` and returns everything is taken as complete');
}
{
  const { fetchImpl } = stub({ '/x': ignoresStart(recs(150)) });
  const c = new NsClient({ server: 'api.example.com', token: 't', fetchImpl });
  const err = await c.get('/x').catch((e: unknown) => e);
  ok(err instanceof NsIncompleteListError, 'a route that ignores `start` throws NsIncompleteListError, never a short list');
  ok(err instanceof NsIncompleteListError && err.partial.length === 100, 'and carries the 100 records it did read');
}
{
  const { fetchImpl, urls } = stub({ '/x': paged(recs(150)) });
  const c = new NsClient({ server: 'api.example.com', token: 't', fetchImpl });
  const all = (await c.get<unknown[]>('/x', { dest: '*' })) as unknown[];
  ok(all.length === 150 && urls[0]!.includes('dest=') && urls[1]!.includes('dest='), 'other query parameters ride along on every page');
}

// ── NsWriteClient.get ──
{
  const { fetchImpl } = stub({ '/x': paged(recs(130)) });
  const w = new NsWriteClient({ server: 'api.example.com', token: 't', fetchImpl });
  const all = (await w.get<unknown[]>('/x')) as unknown[];
  ok(all.length === 130, `NsWriteClient.get pages the same way (got ${all.length})`);
}

// ── the consumers that were capped ──
{
  const { fetchImpl } = stub({ '/domains': paged(recs(120, 'domain')) });
  const c = new NsClient({ server: 'api.example.com', token: 't', fetchImpl });
  const doms = await listDomains(c);
  ok(doms.length === 120, `listDomains returns all 120 domains (got ${doms.length})`);
}
{
  const { fetchImpl } = stub({
    [base]: { domain: D },
    [`${base}/users`]: paged(recs(152)),
    [`${base}/phonenumbers`]: paged(recs(158, 'phonenumber')),
    [`${base}/dialplans/${D}/dialrules`]: paged(recs(112, 'dial-rule-matching-to-uri')),
  });
  const c = new NsClient({ server: 'api.example.com', token: 't', fetchImpl });
  const snap = await fetchDomainSnapshot(c, D, { shallow: true, includeDialrules: true });
  ok(snap.users?.length === 152, `fetchDomainSnapshot reads all 152 users (got ${snap.users?.length})`);
  ok(snap.phonenumbers?.length === 158, `fetchDomainSnapshot reads all 158 phone numbers (got ${snap.phonenumbers?.length})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
