/**
 * Selftests for device orchestration: ensureNsDevice + generateSipPassword. Fully offline.
 *
 * Run: pnpm test:nsdevice
 */
import { ensureNsDevice, generateSipPassword, SIP_PW_FIELD, type NsDeviceWriter } from './nsDevice.js';
import { NsWriteClient } from './nsWriteClient.js';
import type { Rec } from './model.js';

let pass = 0,
  fail = 0;
const ok = (c: boolean, m: string) => {
  c ? pass++ : fail++;
  console.log(`${c ? '✓' : '✗ FAIL'} ${m}`);
};

/** In-memory device store, recording every call. */
function mockWriter(seed: Record<string, string> = {}) {
  const store = new Map<string, Rec>();
  for (const [name, pw] of Object.entries(seed)) store.set(name, { device: name, [SIP_PW_FIELD]: pw });
  const calls: string[] = [];
  let failUpdate = false;
  let omitPwOnUpdate = false;
  let seq = 0;
  const w: NsDeviceWriter = {
    async getDevices() {
      calls.push('getDevices');
      return [...store.values()];
    },
    async getDevice(_d, _u, device) {
      calls.push(`getDevice:${device}`);
      return store.get(device) ?? {};
    },
    async createDevice(_d, _u, device) {
      calls.push(`createDevice:${device}`);
      const rec = { device, [SIP_PW_FIELD]: `GEN${++seq}` };
      store.set(device, rec);
      return rec;
    },
    async updateDevice(_d, _u, device, changes) {
      calls.push(`updateDevice:${device}`);
      if (failUpdate) throw new Error('404 No Route Found');
      const rec = { ...(store.get(device) ?? { device }), ...changes };
      store.set(device, rec);
      return omitPwOnUpdate ? { device } : rec;
    },
  };
  return { w, calls, store, failUpdate: (v: boolean) => (failUpdate = v), omitPwOnUpdate: (v: boolean) => (omitPwOnUpdate = v) };
}
const O = { domain: 'acme.example.com', user: '100', device: '100r' };

// ── generateSipPassword ───────────────────────────────────────────────────────
ok(generateSipPassword().length === 20, 'defaults to 20 characters');
ok(/^[A-Za-z0-9]{20}$/.test(generateSipPassword()), 'alphanumeric only — nothing to mis-escape in SIP auth or provisioning');
ok(generateSipPassword(40).length === 40, 'length is configurable');
ok(generateSipPassword(1).length === 1, 'a length of 1 works');
ok(new Set(Array.from({ length: 200 }, () => generateSipPassword(8))).size === 200, '200 generated passwords are all distinct');
{
  // A uniform draw omits digits ~3% of the time at length 20 — often enough to look like a bug when you
  // eyeball one, and enough to trip a downstream complexity rule. Every candidate must carry all three.
  const sample = Array.from({ length: 500 }, () => generateSipPassword());
  ok(sample.every((p) => /[0-9]/.test(p)), 'EVERY password contains at least one digit (500 samples)');
  ok(sample.every((p) => /[a-z]/.test(p)), 'every password contains at least one lowercase letter');
  ok(sample.every((p) => /[A-Z]/.test(p)), 'every password contains at least one uppercase letter');
  ok(sample.every((p) => /^[A-Za-z0-9]{20}$/.test(p)), 'and they stay alphanumeric at the requested length');
  ok(Array.from({ length: 200 }, () => generateSipPassword(3)).every((p) => p.length === 3 && /[0-9]/.test(p) && /[a-z]/.test(p) && /[A-Z]/.test(p)), 'the guarantee holds at the minimum viable length of 3');
  ok([1, 2].every((n) => generateSipPassword(n).length === n), 'lengths below 3 still work (the guarantee is impossible there)');
}
{
  // Uniformity sanity: with rejection sampling every symbol class should appear across a large sample.
  const big = Array.from({ length: 400 }, () => generateSipPassword(16)).join('');
  ok(/[A-Z]/.test(big) && /[a-z]/.test(big) && /[0-9]/.test(big), 'the whole alphabet is reachable');
  ok(new Set(big).size >= 55, 'nearly every symbol appears in a large sample (no modulo dead zone)');
}
for (const bad of [0, -1, 1.5, NaN]) {
  let threw = false;
  try {
    generateSipPassword(bad);
  } catch {
    threw = true;
  }
  ok(threw, `an invalid length (${bad}) throws rather than looping or returning junk`);
}

// ── absent device ─────────────────────────────────────────────────────────────
{
  const m = mockWriter();
  const r = await ensureNsDevice(m.w, O);
  ok(r.created === true && r.password === 'GEN1', 'a missing device is created and its generated password returned');
  ok(m.calls.includes('createDevice:100r'), 'createDevice was called');
  ok(r.rotated === undefined, 'a newly created device reports no rotation — it is already exclusive');
}
{
  const m = mockWriter();
  const r = await ensureNsDevice(m.w, { ...O, mayCreate: false });
  ok(r.password === '' && r.created === false, 'mayCreate:false on a missing device yields a blank password (a refusal signal)');
  ok(!m.calls.some((c) => c.startsWith('createDevice')), 'and nothing is created');
}
{
  const m = mockWriter();
  const r = await ensureNsDevice(m.w, { ...O, mayCreate: false, rotateExisting: true });
  ok(r.password === '' && !m.calls.some((c) => c.startsWith('updateDevice')), 'a missing device is never rotated');
}

// ── existing device, no rotation ───────────────────────────────────────────────
{
  const m = mockWriter({ '100r': 'STORED_PASSWORD' });
  const r = await ensureNsDevice(m.w, O);
  ok(r.password === 'STORED_PASSWORD' && r.created === false, 'an existing device returns its stored password');
  ok(m.calls.includes('getDevice:100r'), 'a per-device GET is issued because a device LIST may omit the password');
  ok(!m.calls.some((c) => c.startsWith('updateDevice')), 'nothing is rotated by default — this is the pre-existing behaviour');
}
{
  // The list carries the password but the per-device GET does not: fall back to the list value.
  const m = mockWriter();
  m.store.set('100r', { device: '100r' });
  const w2: NsDeviceWriter = { ...m.w, async getDevices() { return [{ device: '100r', [SIP_PW_FIELD]: 'FROM_LIST' }]; } };
  const r = await ensureNsDevice(w2, O);
  ok(r.password === 'FROM_LIST', 'falls back to the list password when the per-device read omits it');
}
{
  const m = mockWriter({ other: 'X' });
  const r = await ensureNsDevice(m.w, O);
  ok(r.created === true, 'a device with a different name does not satisfy the requested one');
}

// ── rotation ──────────────────────────────────────────────────────────────────
{
  const m = mockWriter({ '100r': 'STORED_PASSWORD' });
  const r = await ensureNsDevice(m.w, { ...O, rotateExisting: true });
  ok(r.rotated === true && r.created === false, 'an existing device is rotated on request');
  ok(r.password !== 'STORED_PASSWORD' && /^[A-Za-z0-9]{20}$/.test(r.password), 'a fresh password is returned');
  ok(m.calls.includes('updateDevice:100r'), 'rotation is a PUT');
  ok(!m.calls.some((c) => c.startsWith('deleteDevice')) && !m.calls.some((c) => c.startsWith('createDevice')), 'rotation never deletes and recreates — other device settings must survive');
  ok(String(m.store.get('100r')?.[SIP_PW_FIELD]) === r.password, 'the stored device now carries the new password');
}
{
  const m = mockWriter({ '100r': 'STORED_PASSWORD' });
  m.omitPwOnUpdate(true);
  const r = await ensureNsDevice(m.w, { ...O, rotateExisting: true });
  ok(r.rotated === true && /^[A-Za-z0-9]{20}$/.test(r.password), 'when NS echoes nothing back, the value we set is returned');
  ok(r.password !== 'STORED_PASSWORD', 'and it is definitely not the old one');
}
{
  // The case that matters most: a release without the device PUT must not break the caller.
  const m = mockWriter({ '100r': 'STORED_PASSWORD' });
  m.failUpdate(true);
  const r = await ensureNsDevice(m.w, { ...O, rotateExisting: true });
  ok(r.rotated === false, 'a failed rotation is REPORTED, never thrown');
  ok(r.password === 'STORED_PASSWORD', 'and it falls back to the existing password so the client still works');
  ok((r.rotateError ?? '').includes('No Route Found'), 'the failure reason is carried for logging');
}
{
  const m = mockWriter({ '100r': 'STORED' });
  const r = await ensureNsDevice(m.w, { ...O, rotateExisting: true, passwordLength: 32 });
  ok(r.password.length === 32, 'passwordLength is honoured');
}
{
  const m = mockWriter({ '100r': '' });
  const r = await ensureNsDevice(m.w, O);
  ok(r.password === '' && r.created === false, 'a device with no readable password yields blank rather than throwing');
}
{
  // A writer whose getDevices returns a non-array must not crash the caller.
  const m = mockWriter();
  const w2: NsDeviceWriter = { ...m.w, async getDevices() { return null as unknown as Rec[]; } };
  const r = await ensureNsDevice(w2, O);
  ok(r.created === true, 'a non-array device list degrades to "absent" instead of throwing');
}

// ── the delegating client method ──────────────────────────────────────────────
{
  const seen: { method: string; url: string }[] = [];
  const fetchImpl = (async (input: unknown, init: { method?: string } = {}) => {
    seen.push({ method: init.method ?? 'GET', url: String(input) });
    // devices list → one device; per-device GET → with password
    return new Response(JSON.stringify(seen.length === 1 ? [{ device: '100r' }] : { device: '100r', [SIP_PW_FIELD]: 'VIA_CLIENT' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const client = new NsWriteClient({ server: 'api.example.com', token: 'tok', fetchImpl });
  const r = await client.ensureDevice(O);
  ok(r.password === 'VIA_CLIENT' && r.created === false, 'NsWriteClient.ensureDevice delegates and works end to end');
  ok(seen[0]!.url.endsWith('/domains/acme.example.com/users/100/devices'), 'it drives the real device paths');
  ok(seen.every((s) => s.method === 'GET'), 'no write was needed for an existing device');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
