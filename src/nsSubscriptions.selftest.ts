/**
 * Selftests for the Event Subscriptions client + planner. Offline: every HTTP call goes through an
 * injected fetch stub that records what was sent.
 *
 * Run: pnpm test:nssubs
 */
import {
  NsSubscriptionsClient,
  NsSubscriptionConflictError,
  SUBSCRIPTION_MODELS,
  isSubscriptionModel,
  nsDatetime,
  parseNsDatetime,
  subscriptionFromWire,
  createInputToWire,
  updateInputToWire,
  planSubscriptions,
  type Subscription,
  type DesiredSubscription,
  type SubscriptionAction,
} from './nsSubscriptions.js';
import { NsApiError } from './nsClient.js';
import type { Rec } from './model.js';

let pass = 0,
  fail = 0;
const ok = (c: boolean, m: string) => {
  c ? pass++ : fail++;
  console.log(`${c ? '✓' : '✗ FAIL'} ${m}`);
};

// ── fetch stub ────────────────────────────────────────────────────────────────
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}
let calls: Call[] = [];
type Responder = (call: Call) => { status?: number; json?: unknown; text?: string };
let responder: Responder = () => ({ status: 200, json: {} });

const stubFetch: typeof fetch = async (input, init) => {
  const call: Call = {
    url: String(input),
    method: init?.method ?? 'GET',
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
  calls.push(call);
  const r = responder(call);
  const status = r.status ?? 200;
  const text = r.text ?? (r.json === undefined ? '' : JSON.stringify(r.json));
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  } as Response;
};
const reset = (r?: Responder) => {
  calls = [];
  if (r) responder = r;
};
const mk = () => new NsSubscriptionsClient({ server: 'api.example.com', token: 'nsu_test', fetchImpl: stubFetch, pageSize: 2 });

// ── model enum ────────────────────────────────────────────────────────────────
ok(SUBSCRIPTION_MODELS.length === 11, 'eleven models are defined');
ok(SUBSCRIPTION_MODELS.includes('subscriber') && SUBSCRIPTION_MODELS.includes('auditlog_lite'), 'subscriber and auditlog_lite are present');
ok(!(SUBSCRIPTION_MODELS as readonly string[]).includes('device'), 'there is deliberately no device model');
ok(isSubscriptionModel('presence') && !isSubscriptionModel('contacts') && !isSubscriptionModel(''), 'isSubscriptionModel rejects unknown and empty');
ok(!isSubscriptionModel(undefined) && !isSubscriptionModel(3), 'isSubscriptionModel rejects non-strings');

// ── datetime ──────────────────────────────────────────────────────────────────
ok(nsDatetime(new Date(Date.UTC(2026, 6, 25, 3, 4, 5))) === '2026-07-25 03:04:05', 'nsDatetime emits the documented write format in UTC');
ok(nsDatetime(new Date(Date.UTC(2026, 0, 2, 0, 0, 0))) === '2026-01-02 00:00:00', 'nsDatetime zero-pads month/day/time');
ok(parseNsDatetime('2026-07-25 03:04:05')?.getTime() === Date.UTC(2026, 6, 25, 3, 4, 5), 'parseNsDatetime reads the documented bare format as UTC');
ok(parseNsDatetime('2026-07-24T16:46:17+00:00')?.getTime() === Date.UTC(2026, 6, 24, 16, 46, 17), 'parseNsDatetime reads the ISO-8601 form the API actually returns');
ok(parseNsDatetime('2026-07-24T16:46:17-04:00')?.getTime() === Date.UTC(2026, 6, 24, 20, 46, 17), 'parseNsDatetime honours a non-UTC offset');
{
  const d = new Date(Date.UTC(2046, 3, 4, 19, 39, 37));
  ok(parseNsDatetime(nsDatetime(d))?.getTime() === d.getTime(), 'nsDatetime round-trips through parseNsDatetime');
}
ok(parseNsDatetime('not a date') === undefined, 'parseNsDatetime returns undefined on garbage, not an Invalid Date');
ok(parseNsDatetime('') === undefined && parseNsDatetime(undefined) === undefined && parseNsDatetime(null) === undefined, 'parseNsDatetime handles empty/undefined/null');
ok(parseNsDatetime('2026-07-25 03:04') !== undefined, 'parseNsDatetime tolerates a missing seconds component');

// ── wire mapping ──────────────────────────────────────────────────────────────
{
  // Shaped exactly like a real API record.
  const wire: Rec = {
    id: 'da268bc8d6f46714c5933324aae107c2',
    'subscription-geo-support': 'yes',
    'post-url': 'https://hooks.example.com/ns-events/tok/acme.example.com',
    model: 'subscriber',
    'user-scope': 'Reseller',
    reseller: '12345.service',
    domain: 'acme.example.com',
    user: '*',
    'preferred-server': 'core1.example.com',
    'current-active-server': 'core1.example.com',
    status: 'active',
    'error-count': 15,
    'posts-count': 207,
    'subscription-creation-datetime': '2026-07-24T16:46:17+00:00',
    'subscription-expires-datetime': '2046-04-04T19:39:37+00:00',
  };
  const s = subscriptionFromWire(wire);
  ok(s.id === 'da268bc8d6f46714c5933324aae107c2', 'fromWire maps id');
  ok(s.postUrl === 'https://hooks.example.com/ns-events/tok/acme.example.com', 'fromWire maps post-url → postUrl');
  ok(s.geoSupport === 'yes' && s.userScope === 'Reseller', 'fromWire maps geo-support and user-scope');
  ok(s.currentActiveServer === 'core1.example.com' && s.preferredServer === 'core1.example.com', 'fromWire maps both server fields');
  ok(s.errorCount === 15 && s.postsCount === 207, 'fromWire maps the counters as numbers');
  ok(s.expiresAt === '2046-04-04T19:39:37+00:00', 'fromWire keeps the raw expiry string');
  ok(s.raw === wire, 'fromWire preserves the untouched record on .raw');
}
{
  const s = subscriptionFromWire({ id: 'x', 'error-count': '7', 'posts-count': '7043' });
  ok(s.errorCount === 7 && s.postsCount === 7043, 'fromWire coerces string counters to numbers');
  ok(s.model === undefined && s.domain === undefined, 'fromWire leaves unmodelled/missing fields absent rather than empty-string');
}
{
  const s = subscriptionFromWire({});
  ok(s.id === '', 'fromWire yields an empty id for a record without one (planner filters these out)');
}

{
  const body = createInputToWire({ model: 'subscriber', postUrl: 'https://hooks.example.com/e', domain: 'acme' });
  ok(body['post-url'] === 'https://hooks.example.com/e' && body['model'] === 'subscriber', 'createInputToWire hyphenates post-url');
  ok(body['domain'] === 'acme', 'createInputToWire passes the domain filter');
  ok(!('subscription-expires-datetime' in body) && !('user' in body), 'createInputToWire omits fields that were not supplied');
}
{
  const body = createInputToWire({
    model: 'subscriber',
    postUrl: 'https://hooks.example.com/e',
    expiresAt: new Date(Date.UTC(2030, 0, 1, 0, 0, 0)),
    geoSupport: 'yes',
    user: '*',
  });
  ok(body['subscription-expires-datetime'] === '2030-01-01 00:00:00', 'createInputToWire formats a Date expiry as the write format');
  ok(body['subscription-geo-support'] === 'yes', 'createInputToWire hyphenates geo-support');
}
{
  const body = createInputToWire({ model: 'subscriber', postUrl: 'u', expiresAt: '2030-01-01 00:00:00' });
  ok(body['subscription-expires-datetime'] === '2030-01-01 00:00:00', 'createInputToWire passes a string expiry through unchanged');
}
{
  const body = updateInputToWire({ postUrl: 'https://hooks.example.com/new', errorCount: 0 });
  ok(body['post-url'] === 'https://hooks.example.com/new' && body['error-count'] === 0, 'updateInputToWire maps post-url and a counter reset');
  ok(!('domain' in body) && !('user' in body) && !('reseller' in body), 'updateInputToWire cannot express the immutable filters');
  ok(Object.keys(updateInputToWire({})).length === 0, 'updateInputToWire of nothing is an empty body');
}

// ── client: transport ─────────────────────────────────────────────────────────
{
  reset(() => ({ status: 200, json: [{ id: 'a' }] }));
  await mk().list();
  const c = calls[0]!;
  ok(c.url.startsWith('https://api.example.com/ns-api/v2/subscriptions'), 'list hits /ns-api/v2/subscriptions over https');
  ok(c.method === 'GET' && c.headers['Authorization'] === 'Bearer nsu_test', 'list is a GET with the bearer token');
  ok(c.body === undefined, 'a GET carries no body');
  ok(!('Content-Type' in c.headers), 'a bodyless request sets no Content-Type');
}
{
  reset(() => ({ status: 200, json: [] }));
  await mk().listForDomain('acme.example.com');
  ok(calls[0]!.url.includes('/domains/acme.example.com/subscriptions'), 'listForDomain uses the domain-scoped path');
}
{
  let threw = '';
  try {
    new NsSubscriptionsClient({ server: 'api.example.com/evil', token: 't', fetchImpl: stubFetch });
  } catch (e) {
    threw = (e as Error).message;
  }
  ok(threw.includes('Invalid NS server'), 'the SSRF guard from the read client is applied to server');
}

// ── client: paging ────────────────────────────────────────────────────────────
{
  // pageSize is 2. A short first page means "done" — this is the real-world case today (5 records).
  reset(() => ({ status: 200, json: [{ id: 'a' }] }));
  const out = await mk().list();
  ok(out.length === 1 && calls.length === 1, 'a short page ends pagination after one request');
}
{
  // Full page, then a short page → two requests, both pages kept.
  let n = 0;
  reset(() => {
    n++;
    return { status: 200, json: n === 1 ? [{ id: 'a' }, { id: 'b' }] : [{ id: 'c' }] };
  });
  const out = await mk().list();
  ok(out.length === 3 && out.map((s) => s.id).join(',') === 'a,b,c', 'a full page is followed by the next page');
  ok(calls.length === 2 && calls[1]!.url.includes('start=2'), 'the second request advances the start offset');
  ok(calls[0]!.url.includes('limit=2'), 'the page size is sent as limit');
}
{
  // A server that IGNORES limit/start returns the same full page forever. Must not loop.
  reset(() => ({ status: 200, json: [{ id: 'a' }, { id: 'b' }] }));
  const out = await mk().list();
  ok(out.length === 2, 'a paging-ignorant server yields each record once');
  ok(calls.length === 2, 'a repeated identical page stops the loop instead of spinning');
}
{
  reset(() => ({ status: 200, json: [] }));
  const out = await mk().list();
  ok(out.length === 0 && calls.length === 1, 'an empty first page yields nothing and stops');
}
{
  // Records without an id are skipped rather than becoming phantom subscriptions.
  reset(() => ({ status: 200, json: [{ id: 'a' }, {}] }));
  const out = await mk().list();
  ok(out.length === 1 && out[0]!.id === 'a', 'records without an id are dropped');
}

// ── client: create / update / delete ──────────────────────────────────────────
{
  reset(() => ({ status: 200, json: { id: 'new1', status: 'pending' } }));
  const s = await mk().create({ model: 'subscriber', postUrl: 'https://hooks.example.com/e', domain: 'acme' });
  ok(s.id === 'new1' && s.status === 'pending', 'create returns the parsed subscription');
  ok(calls[0]!.method === 'POST' && calls[0]!.headers['Content-Type'] === 'application/json', 'create POSTs JSON');
  ok((calls[0]!.body as Rec)['post-url'] === 'https://hooks.example.com/e', 'create sends the hyphenated body');
  ok(!('synchronous' in (calls[0]!.body as Rec)), "create does NOT inject synchronous:'yes' (unlike NsWriteClient)");
}
{
  reset(() => ({ status: 200, json: { id: 'n' } }));
  await mk().createForDomain('acme.example.com', { model: 'subscriber', postUrl: 'u' });
  ok(calls[0]!.url.includes('/domains/acme.example.com/subscriptions'), 'createForDomain posts to the domain-scoped path');
}
{
  reset(() => ({ status: 409, json: { message: 'Subscription ID already Exists or matching set of parameters already exists' } }));
  let err: unknown;
  try {
    await mk().create({ model: 'subscriber', postUrl: 'u' });
  } catch (e) {
    err = e;
  }
  ok(err instanceof NsSubscriptionConflictError, '409 becomes NsSubscriptionConflictError');
  ok(err instanceof NsApiError, 'the conflict error is still an NsApiError so existing handlers keep working');
  ok((err as NsApiError).status === 409, 'the conflict error carries status 409');
}
{
  reset(() => ({ status: 401, json: { code: 401, message: 'nope' } }));
  let err: unknown;
  try {
    await mk().list();
  } catch (e) {
    err = e;
  }
  ok(err instanceof NsApiError && (err as NsApiError).status === 401, 'a 401 surfaces as NsApiError');
  ok(!(err instanceof NsSubscriptionConflictError), 'a non-409 is not turned into a conflict');
  ok((err as Error).message.includes('token expired/invalid'), 'the 401 hint is included');
}
{
  reset(() => ({ status: 202, json: { code: 202, message: 'ok' } }));
  await mk().update('abc', { expiresAt: new Date(Date.UTC(2030, 0, 1)) });
  ok(calls[0]!.method === 'PUT' && calls[0]!.url.endsWith('/subscriptions/abc'), 'update PUTs to the id path');
  ok((calls[0]!.body as Rec)['subscription-expires-datetime'] === '2030-01-01 00:00:00', 'update sends the formatted expiry — this is how renewal works');
}
{
  reset(() => ({ status: 202, json: {} }));
  await mk().remove('abc', { domain: 'acme.example.com' });
  const c = calls[0]!;
  ok(c.method === 'DELETE' && c.url.endsWith('/subscriptions/abc'), 'remove DELETEs the id path');
  ok((c.body as Rec)['subscription_id'] === 'abc', 'remove sends subscription_id IN THE BODY (the reason this client exists)');
  ok((c.body as Rec)['domain'] === 'acme.example.com', 'remove sends domain, required below Super User scope');
  ok(c.headers['Content-Type'] === 'application/json', 'the DELETE body is sent as JSON');
}
{
  reset(() => ({ status: 202, json: {} }));
  await mk().remove('abc');
  ok(!('domain' in (calls[0]!.body as Rec)), 'remove omits domain when not supplied');
}
{
  reset(() => ({ status: 200, text: '' }));
  const s = await mk().get('abc');
  ok(s.id === '' && calls[0]!.method === 'GET', 'an empty body does not throw');
}
{
  reset(() => ({ status: 200, json: { id: 'weird/id?x' } }));
  await mk().get('weird/id?x');
  ok(calls[0]!.url.includes('weird%2Fid%3Fx'), 'the id is percent-encoded into the path');
}

// ── planner ───────────────────────────────────────────────────────────────────
const PREFIX = 'https://hooks.example.com/ns-events/';
const NOW = Date.UTC(2026, 6, 25, 0, 0, 0);
const HOUR = 3600;
const DAY = 86400;
const OPTS = { ownedPrefix: PREFIX, renewHorizonSeconds: 3 * DAY, targetLifetimeSeconds: 30 * DAY };
const want = (domain: string): DesiredSubscription => ({ domain, model: 'subscriber', postUrl: `${PREFIX}tok/${domain}` });
const sub = (o: Partial<Subscription> & { id: string }): Subscription => ({ raw: {}, ...o });
const kinds = (a: SubscriptionAction[]) => a.map((x) => x.kind).sort().join(',');
const find = <K extends SubscriptionAction['kind']>(a: SubscriptionAction[], k: K) =>
  a.find((x) => x.kind === k) as Extract<SubscriptionAction, { kind: K }> | undefined;

{
  const a = planSubscriptions([want('acme')], [], NOW, OPTS);
  ok(kinds(a) === 'create', 'nothing present ⇒ create');
  ok(find(a, 'create')!.postUrl === `${PREFIX}tok/acme`, 'create carries the configured callback URL');
  ok(find(a, 'create')!.expiresAt === '2026-08-24 00:00:00', 'create requests the target lifetime as an explicit expiry');
}
{
  const healthy = sub({
    id: '1',
    domain: 'acme',
    model: 'subscriber',
    postUrl: `${PREFIX}tok/acme`,
    status: 'active',
    expiresAt: '2046-01-01T00:00:00+00:00',
  });
  ok(kinds(planSubscriptions([want('acme')], [healthy], NOW, OPTS)) === 'noop', 'present, correct and far from expiry ⇒ noop');
}
{
  // Phase 0 finding 2: a healthy live subscription really does sit at 7 errors / 7043 posts.
  const noisy = sub({
    id: '1',
    domain: 'acme',
    model: 'subscriber',
    postUrl: `${PREFIX}tok/acme`,
    status: 'active',
    errorCount: 7,
    postsCount: 7043,
    expiresAt: '2046-01-01T00:00:00+00:00',
  });
  ok(kinds(planSubscriptions([want('acme')], [noisy], NOW, OPTS)) === 'noop', 'errorCount > 0 on an active subscription is NOT a fault');
}
{
  const broken = sub({
    id: '1',
    domain: 'acme',
    model: 'subscriber',
    postUrl: `${PREFIX}tok/acme`,
    status: 'error',
    errorCount: 40,
    postsCount: 40,
    expiresAt: '2046-01-01T00:00:00+00:00',
  });
  const a = planSubscriptions([want('acme')], [broken], NOW, OPTS);
  ok(kinds(a) === 'noop,report', 'status=error is reported, and the record is otherwise left alone');
  ok(find(a, 'report')!.errorCount === 40, 'the report carries the counters');
  ok(!a.some((x) => x.kind === 'delete'), 'an unhealthy subscription is never deleted');
}
{
  const rate = sub({
    id: '1',
    domain: 'acme',
    model: 'subscriber',
    postUrl: `${PREFIX}tok/acme`,
    status: 'active',
    errorCount: 30,
    postsCount: 40,
    expiresAt: '2046-01-01T00:00:00+00:00',
  });
  ok(kinds(planSubscriptions([want('acme')], [rate], NOW, OPTS)) === 'noop,report', 'a sustained high error RATE is reported');
}
{
  const small = sub({
    id: '1',
    domain: 'acme',
    model: 'subscriber',
    postUrl: `${PREFIX}tok/acme`,
    status: 'active',
    errorCount: 3,
    postsCount: 3,
    expiresAt: '2046-01-01T00:00:00+00:00',
  });
  ok(kinds(planSubscriptions([want('acme')], [small], NOW, OPTS)) === 'noop', 'a tiny sample is not judged on error rate');
}
{
  const soon = sub({
    id: '1',
    domain: 'acme',
    model: 'subscriber',
    postUrl: `${PREFIX}tok/acme`,
    status: 'active',
    expiresAt: nsDatetime(new Date(NOW + 2 * HOUR * 1000)),
  });
  const a = planSubscriptions([want('acme')], [soon], NOW, OPTS);
  ok(kinds(a) === 'renew', 'expiry inside the horizon ⇒ renew');
  ok(find(a, 'renew')!.expiresAt === '2026-08-24 00:00:00', 'renew pushes the expiry out to the target lifetime');
  ok(find(a, 'renew')!.id === '1', 'renew targets the existing id (a PUT, not a recreate)');
}
{
  const expired = sub({
    id: '1',
    domain: 'acme',
    model: 'subscriber',
    postUrl: `${PREFIX}tok/acme`,
    expiresAt: nsDatetime(new Date(NOW - DAY * 1000)),
  });
  const a = planSubscriptions([want('acme')], [expired], NOW, OPTS);
  ok(kinds(a) === 'renew' && find(a, 'renew')!.reason === 'already expired', 'an already-expired subscription is renewed, not recreated');
}
{
  const noExp = sub({ id: '1', domain: 'acme', model: 'subscriber', postUrl: `${PREFIX}tok/acme`, expiresAt: 'garbage' });
  ok(kinds(planSubscriptions([want('acme')], [noExp], NOW, OPTS)) === 'renew', 'an unparseable expiry is treated as needing renewal');
}
{
  const drifted = sub({
    id: '1',
    domain: 'acme',
    model: 'subscriber',
    postUrl: `${PREFIX}OLDTOKEN/acme`,
    expiresAt: '2046-01-01T00:00:00+00:00',
  });
  const a = planSubscriptions([want('acme')], [drifted], NOW, OPTS);
  ok(kinds(a) === 'repair-url', 'a drifted callback URL ⇒ repair-url (this is what makes secret rotation possible)');
  ok(find(a, 'repair-url')!.postUrl === `${PREFIX}tok/acme`, 'repair-url carries the new URL');
}
{
  // The live-fleet case: another integration owns a subscriber subscription on the same domain.
  const foreign = sub({
    id: 'f1',
    domain: 'acme',
    model: 'subscriber',
    postUrl: 'https://automation.example.net/webhook/uuid',
    status: 'active',
    errorCount: 15,
    postsCount: 207,
  });
  const a = planSubscriptions([want('acme')], [foreign], NOW, OPTS);
  ok(a.every((x) => x.kind !== 'delete'), "a foreign subscription is NEVER deleted");
  ok(a.every((x) => x.kind !== 'renew' && x.kind !== 'repair-url'), 'a foreign subscription is never modified');
  ok(find(a, 'report')?.id === 'f1', 'a foreign subscription on a domain we want is reported (double delivery)');
  ok(find(a, 'create') !== undefined, 'we still create our own alongside it');
}
{
  const foreignElsewhere = sub({ id: 'f1', domain: 'other', model: 'message', postUrl: 'https://vendor.example.net/x' });
  const a = planSubscriptions([want('acme')], [foreignElsewhere], NOW, OPTS);
  ok(kinds(a) === 'create', 'an unrelated foreign subscription produces no noise at all');
}
{
  const stale = sub({ id: '1', domain: 'gone', model: 'subscriber', postUrl: `${PREFIX}tok/gone`, expiresAt: '2046-01-01T00:00:00+00:00' });
  const a = planSubscriptions([want('acme')], [stale], NOW, OPTS);
  ok(find(a, 'delete')?.id === '1', 'ours but no longer configured ⇒ delete');
  ok(find(a, 'create') !== undefined, 'and the newly-configured domain is created');
}
{
  const dupA = sub({ id: 'old', domain: 'acme', model: 'subscriber', postUrl: `${PREFIX}tok/acme`, status: 'pending', createdAt: '2026-01-01T00:00:00+00:00', expiresAt: '2046-01-01T00:00:00+00:00' });
  const dupB = sub({ id: 'live', domain: 'acme', model: 'subscriber', postUrl: `${PREFIX}tok/acme`, status: 'active', createdAt: '2025-01-01T00:00:00+00:00', expiresAt: '2046-01-01T00:00:00+00:00' });
  const a = planSubscriptions([want('acme')], [dupA, dupB], NOW, OPTS);
  ok(find(a, 'delete')?.id === 'old', 'among our own duplicates the ACTIVE one is kept even if older');
  ok(find(a, 'noop')?.id === 'live', 'the active duplicate is the canonical record');
}
{
  const d1 = sub({ id: 'a', domain: 'acme', model: 'subscriber', postUrl: `${PREFIX}tok/acme`, status: 'pending', createdAt: '2026-01-01T00:00:00+00:00', expiresAt: '2046-01-01T00:00:00+00:00' });
  const d2 = sub({ id: 'b', domain: 'acme', model: 'subscriber', postUrl: `${PREFIX}tok/acme`, status: 'pending', createdAt: '2026-06-01T00:00:00+00:00', expiresAt: '2046-01-01T00:00:00+00:00' });
  const a = planSubscriptions([want('acme')], [d1, d2], NOW, OPTS);
  ok(find(a, 'delete')?.id === 'a', 'with equal status the NEWER duplicate is kept');
}
{
  // Domain comparison must be case-insensitive; NS domains are.
  const mixed = sub({ id: '1', domain: 'ACME', model: 'subscriber', postUrl: `${PREFIX}tok/acme`, expiresAt: '2046-01-01T00:00:00+00:00' });
  ok(kinds(planSubscriptions([want('acme')], [mixed], NOW, OPTS)) === 'noop', 'domain matching is case-insensitive');
}
{
  // A bare domain (no dot) is real in the live fleet.
  const bare: DesiredSubscription = { domain: 'baredomain', model: 'subscriber', postUrl: `${PREFIX}tok/baredomain` };
  const s = sub({ id: '1', domain: 'baredomain', model: 'subscriber', postUrl: `${PREFIX}tok/baredomain`, expiresAt: '2046-01-01T00:00:00+00:00' });
  ok(kinds(planSubscriptions([bare], [s], NOW, OPTS)) === 'noop', 'a bare domain with no territory suffix works');
}
{
  // Same domain, different model → independent subscriptions, not duplicates.
  const other = sub({ id: 'm', domain: 'acme', model: 'message', postUrl: `${PREFIX}tok/acme`, expiresAt: '2046-01-01T00:00:00+00:00' });
  const a = planSubscriptions([want('acme')], [other], NOW, OPTS);
  ok(find(a, 'create') !== undefined, 'a different model on the same domain does not satisfy the desired one');
  ok(find(a, 'delete')?.id === 'm', 'and our unconfigured model is cleaned up');
}
{
  ok(planSubscriptions([], [], NOW, OPTS).length === 0, 'nothing wanted, nothing present ⇒ no actions');
}
{
  const a = planSubscriptions([want('acme'), want('beta')], [], NOW, OPTS);
  ok(a.filter((x) => x.kind === 'create').length === 2, 'multiple desired domains each get a create');
}
{
  // A subscription of ours with no domain recorded must not be mistaken for a wanted one.
  const weird = sub({ id: '1', postUrl: `${PREFIX}tok/x`, expiresAt: '2046-01-01T00:00:00+00:00' });
  const a = planSubscriptions([want('acme')], [weird], NOW, OPTS);
  ok(find(a, 'create') !== undefined && find(a, 'delete')?.id === '1', 'a domain-less record of ours is not matched, and is cleaned up');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
