/**
 * Offline test for the `synchronous` capability table — that concrete, URI-encoded paths match the
 * templated operations, that the near-misses (user update, device update) answer false, and that the
 * table itself stays consistent. tsx src/nsSynchronous.selftest.ts
 */
import { supportsSynchronous, SYNCHRONOUS_OPERATIONS } from './index.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗ FAIL'} ${m}`); };

// ── supported operations ──────────────────────────────────────────────────────
ok(supportsSynchronous('POST', '/domains'), 'POST /domains (domain create) is supported');
ok(supportsSynchronous('POST', '/domains/acme.example/users'), 'POST users (user CREATE) is supported');
ok(supportsSynchronous('POST', '/domains/acme.example/users/100/devices'), 'POST devices (device create) is supported');
ok(supportsSynchronous('PUT', '/domains/acme.example/sites/HQ'), 'PUT sites is supported (one of the few PUTs)');
ok(supportsSynchronous('PUT', '/domains/acme.example/users/100/greetings/1'), 'PUT greetings/{index} is supported');
ok(supportsSynchronous('PUT', '/domains/acme.example/moh/2'), 'PUT domain moh/{index} is supported');

// ── the near-misses that motivate an explicit table ───────────────────────────
ok(!supportsSynchronous('PUT', '/domains/acme.example/users/100'), 'PUT user (UPDATE) is NOT supported — the case that started this');
ok(!supportsSynchronous('PUT', '/domains/acme.example/users/100/devices/100r'), 'PUT device (update) is NOT supported');
ok(!supportsSynchronous('DELETE', '/domains/acme.example/users/100'), 'DELETE is never supported');
ok(!supportsSynchronous('GET', '/domains/acme.example/users'), 'GET is never supported');
ok(!supportsSynchronous('POST', '/domains/acme.example/phonenumbers'), 'an unlisted POST is not supported');

// ── path-shape handling ───────────────────────────────────────────────────────
ok(supportsSynchronous('post', '/domains/acme.example/users'), 'method is case-insensitive');
ok(!supportsSynchronous('POST', '/domains/acme.example/users/100'), 'segment COUNT must match — collection vs member');
ok(!supportsSynchronous('POST', '/domains/acme.example/users/100/devices/extra'), 'a deeper path does not match a shorter template');
ok(supportsSynchronous('POST', '/domains/acme.example/users?foo=bar'), 'a query string is ignored');
ok(supportsSynchronous('POST', '/domains/acme.example/users/'), 'a trailing slash is ignored');

// An encoded value stays ONE segment, so it cannot masquerade as a deeper path.
ok(
  supportsSynchronous('POST', `/domains/${encodeURIComponent('a/b.example')}/users`),
  'an encoded slash inside a segment still matches the single-segment template',
);
ok(
  !supportsSynchronous('POST', '/domains/a/b.example/users'),
  'an UNencoded slash does not match — extra segment, correctly rejected',
);

// ── table integrity ───────────────────────────────────────────────────────────
ok(SYNCHRONOUS_OPERATIONS.length === 17, `table holds all 17 spec operations (got ${SYNCHRONOUS_OPERATIONS.length})`);
ok(
  SYNCHRONOUS_OPERATIONS.every((op) => op.method === 'POST' || op.method === 'PUT'),
  'every entry is a POST or PUT',
);
ok(
  SYNCHRONOUS_OPERATIONS.every((op) => op.path.startsWith('/')),
  'every path is rooted (relative to the /ns-api/v2 base)',
);
ok(
  new Set(SYNCHRONOUS_OPERATIONS.map((op) => `${op.method} ${op.path}`)).size === SYNCHRONOUS_OPERATIONS.length,
  'no duplicate (method, path) entries',
);
ok(
  SYNCHRONOUS_OPERATIONS.every((op) => supportsSynchronous(op.method, op.path.replace(/\{[^}]+\}/g, 'x'))),
  'every table entry matches its own path with the templates filled in',
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
