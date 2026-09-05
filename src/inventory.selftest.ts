/** Offline test for the domain inventory counter. pnpm test:inventory */
import { countDomainInventory, listDomainInventory, itemsFor, itemLabel, destinationOf, usersByExt } from './inventory.js';
import type { Rec, Snapshot } from './model.js';

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); };

const snap: Snapshot = {
  meta: { domain: 'acme.example' },
  users: [
    { user: '100', 'user-scope': 'Basic User', 'service-code': '', 'voicemail-transcription-enabled': 'no', 'name-first-name': 'Ann', 'name-last-name': 'Lee', site: 'North' },
    { user: '101', 'user-scope': 'Basic User', 'service-code': 'premium', 'voicemail-transcription-enabled': 'yes' },
    { user: '102', 'user-scope': 'Office Manager', 'service-code': 'premium', 'voicemail-transcription-enabled': 'voicebase' },
    { user: '103', 'user-scope': 'Basic User', 'service-code': '' },
    { user: '104', 'user-scope': 'Basic User', 'service-code': '' },
    { user: '700', 'user-scope': 'Basic User', 'service-code': 'system-aa' },
    { user: '701', 'user-scope': 'Basic User', 'service-code': 'system-queue', 'name-first-name': 'Sales' },
    { user: '702', 'user-scope': 'Basic User', 'service-code': 'system-tod' },
  ],
  devicesByUser: {
    '100': [{ aor: 'sip:100@acme.example', 'device-models-model': 'Yealink T54W' }],
    '101': [
      { aor: 'sip:101a@acme.example', 'device-models-model': 'Yealink T54W' },
      { aor: 'sip:101b@acme.example', 'device-models-model': 'Yealink T31P' },
      { aor: 'sip:101c@acme.example', 'device-models-model': '' },
    ],
    '102': [{ aor: 'sip:102@acme.example', 'device-models-model': 'Yealink T31P' }],
    '103': [{ aor: 'sip:103t@acme.example', 'device-models-model': 'Teams' }],
  },
  phonenumbers: [
    { phonenumber: '13175550100', 'dial-rule-translation-destination-user': '100', 'dial-rule-description': '  Portal Created: User - 1001  ' },
    { phonenumber: '13175550101' },
    { phonenumber: '18005550102', 'dial-rule-translation-destination-user': '701' },
    { phonenumber: '18335550103' },
  ],
  addresses: [
    { 'emergency-address-id': 'a-1', 'address-name': 'HQ', 'address-line-1': '1 Main St', 'address-city': 'Springfield' },
    { 'emergency-address-id': 'a-2', 'address-name': 'Annex' },
  ],
  smsnumbers: [{ number: '13175550100' }],
} as Snapshot;

const inv = countDomainInventory(snap);

ok(inv.extensions.total === 5, 'five real extensions — the three system-* users are not extensions');
ok(inv.extensions.byScope['Basic User'] === 4, 'four Basic User extensions');
ok(inv.extensions.byScope['Office Manager'] === 1, 'one Office Manager extension');
ok(inv.extensions.byScope['system-aa'] === undefined, 'byScope never carries a system user');
ok(inv.extensions.byServiceCode[''] === 3, 'the empty service code is a key, not a dropped bucket');
ok(inv.extensions.byServiceCode['premium'] === 2, 'two premium-coded extensions');
ok(inv.extensions.byDeviceCount['0'] === 2, 'two extensions with no device');
ok(inv.extensions.byDeviceCount['1'] === 2, 'two extensions with one device');
ok(inv.extensions.byDeviceCount['2'] === 0, 'none with exactly two');
ok(inv.extensions.byDeviceCount['3+'] === 1, 'one extension with three devices lands in 3+');
ok(inv.systemUsers.total === 3, 'three system users');
ok(inv.systemUsers.byServiceCode['system-aa'] === 1, 'one auto attendant');
ok(inv.systemUsers.byServiceCode['system-queue'] === 1, 'one queue');
ok(inv.systemUsers.byServiceCode['system-tod'] === 1, 'one time-of-day');
ok(inv.transcriptionEnabled === 2, 'yes and a provider name both count; no and absent do not');
ok(inv.dids.total === 4, 'four phone numbers');
ok(inv.dids.tollFree === 2, '800 and 833 are toll-free');
ok(inv.dids.local === 2, 'and the rest are local');
ok(inv.e911Addresses === 2, 'two address records');
ok(inv.smsNumbers === 1, 'one SMS number');
ok(inv.devices.total === 5, 'five devices across all extensions');
ok(inv.devices.byModel['Yealink T54W'] === 2, 'two T54W');
ok(inv.devices.byModel['Yealink T31P'] === 2, 'two T31P');
ok(inv.devices.byModel['(unknown)'] === 1, 'a device with no model is counted under (unknown), never dropped');

// An empty snapshot must answer zeros, not throw — a domain can genuinely have nothing.
const empty = countDomainInventory({ meta: { domain: 'empty.example' } } as Snapshot);
ok(empty.extensions.total === 0, 'empty snapshot: no extensions');
ok(empty.dids.total === 0 && empty.dids.tollFree === 0 && empty.dids.local === 0, 'empty snapshot: no numbers');
ok(empty.devices.total === 0, 'empty snapshot: no devices');
ok(empty.smsNumbers === 0 && empty.e911Addresses === 0, 'empty snapshot: no addresses and no SMS numbers');

// Devices belonging to a system user are not counted: they are not seats and never appear on a bill.
const sysDev = countDomainInventory({
  meta: { domain: 'sys.example' },
  users: [{ user: '700', 'service-code': 'system-aa' }],
  devicesByUser: { '700': [{ aor: 'sip:700@sys.example', 'device-models-model': 'Yealink T54W' }] },
} as Snapshot);
ok(sysDev.devices.total === 0, 'a system user device is not counted');

// ── listDomainInventory ─────────────────────────────────────────────────────────────────────────────
{
  const d = listDomainInventory(snap);
  ok(d.extensions.length === 5, '[list] five real extensions');
  ok(d.systemUsers.length === 3, '[list] three system users, listed apart');
  const e100 = d.extensions.find((x) => x.ext === '100')!;
  ok(e100.key === 'ext:100', '[list] an extension key is ext:<user>');
  ok(e100.name === 'Ann Lee', '[list] name is first + last');
  ok(e100.site === 'North', '[list] site is carried');
  ok(e100.deviceCount === 1 && e100.deviceModels[0] === 'Yealink T54W', '[list] device count and models, never the MAC');
  ok(e100.teams === false, '[list] a desk phone is not Teams');
  const e101 = d.extensions.find((x) => x.ext === '101')!;
  ok(
    JSON.stringify(e101.devices) === JSON.stringify([
      { name: '101a', model: 'Yealink T54W', teams: false },
      { name: '101b', model: 'Yealink T31P', teams: false },
      { name: '101c', model: '(unknown)', teams: false },
    ]),
    '[list] devices lists every device with its name, model and teams flag, in order',
  );
  const e103 = d.extensions.find((x) => x.ext === '103')!;
  ok(e103.teams === true, '[list] a device whose aor local part is <ext>t marks the extension Teams-connected');
  ok(e103.deviceCount === 0 && e103.deviceModels.length === 0, '[list] and that connector is not counted as a device');
  ok(
    JSON.stringify(e103.devices) === JSON.stringify([{ name: '103t', model: '', teams: true }]),
    '[list] devices includes the Teams connector with an empty model, even though deviceCount excludes it',
  );
  ok(d.extensions.find((x) => x.ext === '104')!.devices.length === 0, '[list] no devices means an empty devices list, not a throw');
  ok(d.extensions.find((x) => x.ext === '101')!.transcription === true, '[list] transcription flag');
  ok(d.extensions.find((x) => x.ext === '103')!.name === '', '[list] a user with no name has an empty name, not "undefined undefined"');
  ok(d.extensions.find((x) => x.ext === '103')!.anyDevice === true, '[list] an extension with only the Teams connector still has a device');
  ok(d.extensions.find((x) => x.ext === '104')!.anyDevice === false, '[list] and one with nothing has none');
  ok(d.dids.length === 4 && d.dids.filter((n) => n.kind === 'tollFree').length === 2, '[list] numbers with kind');
  ok(d.dids[0]!.key === 'did:13175550100', '[list] a number key is did:<phonenumber>');
  ok(d.dids[0]!.destination === 'to user 100 — Ann Lee', '[list] a number routed to a real user names them');
  ok(d.dids[0]!.description === 'Portal Created: User - 1001', '[list] dial-rule-description is carried and trimmed');
  ok(d.dids[1]!.destination === '' && d.dids[1]!.description === '', '[list] a number with no routing fields is blank, not "undefined"');
  ok(d.dids[2]!.destination === 'to queue 701 — Sales', '[list] a number routed to a system queue names the queue');
  ok(d.e911Addresses.length === 2, '[list] two address items');
  ok(d.e911Addresses[0]!.key === 'addr:a-1', '[list] an address key is addr:<emergency-address-id>');
  ok(d.e911Addresses[0]!.label === 'HQ — 1 Main St, Springfield', '[list] an address label is name — line 1, city');
  ok(d.e911Addresses[1]!.label === 'Annex', '[list] and degrades to whatever parts exist');
  ok(d.smsNumbers.length === 1 && d.smsNumbers[0]!.key === 'sms:13175550100', '[list] an SMS key is sms:<number>');
  for (const x of d.extensions) ok(!JSON.stringify(x).includes('aor') && !JSON.stringify(x).includes('sip:'), `[list] no aor leaks on ${x.ext}`);
}

// ── counts are a fold over the lists ─────────────────────────────────────────────────────────────────
{
  const c = countDomainInventory(snap);
  const d = listDomainInventory(snap);
  ok(c.extensions.total === d.extensions.length, '[fold] extensions.total equals the list length');
  ok(c.transcriptionEnabled === d.extensions.filter((x) => x.transcription).length, '[fold] transcription count equals the flagged items');
  ok(c.teamsConnected === 1, '[fold] teamsConnected is a new numeric leaf');
  ok(c.devices.total === 5, '[fold] the Teams connector is excluded from devices.total (still 5)');
  ok(c.extensions.byDeviceCount['0'] === 2, '[fold] and from byDeviceCount — 103 and 104 have zero handsets');
  ok(c.extensions.withAnyDevice === 4 && c.extensions.withNoDevice === 1, '[fold] device presence counts, connector included');
  ok(c.extensions.withAnyDevice + c.extensions.withNoDevice === c.extensions.total, '[fold] the two presence leaves partition the total');
  ok(c.dids.total === d.dids.length, '[fold] dids.total equals the number list length');
  ok(c.dids.tollFree === d.dids.filter((n) => n.kind === 'tollFree').length, '[fold] dids.tollFree equals the toll-free items');
  ok(c.e911Addresses === d.e911Addresses.length && c.smsNumbers === d.smsNumbers.length, '[fold] address and SMS counts equal the lists');
}

// ── itemsFor ──────────────────────────────────────────────────────────────────────────────────────────
{
  const d = listDomainInventory(snap);
  const keys = (p: string) => (itemsFor(d, p) ?? []).map((x) => x.key).join(',');
  ok(keys('extensions.total') === 'ext:100,ext:101,ext:102,ext:103,ext:104', '[itemsFor] extensions.total is every extension');
  ok(keys('extensions.byScope.Office Manager') === 'ext:102', '[itemsFor] byScope filters on scope');
  ok(keys('extensions.byServiceCode.premium') === 'ext:101,ext:102', '[itemsFor] byServiceCode filters on service code');
  ok(keys('extensions.byServiceCode.') === 'ext:100,ext:103,ext:104', '[itemsFor] the empty service code is addressable with a trailing dot');
  ok(keys('extensions.byDeviceCount.3+') === 'ext:101', '[itemsFor] byDeviceCount buckets');
  ok(keys('extensions.withAnyDevice') === 'ext:100,ext:101,ext:102,ext:103', '[itemsFor] withAnyDevice includes the Teams-only extension');
  ok(keys('extensions.withNoDevice') === 'ext:104', '[itemsFor] withNoDevice is the rest');
  ok(keys('transcriptionEnabled') === 'ext:101,ext:102', '[itemsFor] transcriptionEnabled is the flagged extensions');
  ok(keys('teamsConnected') === 'ext:103', '[itemsFor] teamsConnected is the Teams extensions');
  ok(keys('dids.total').split(',').length === 4, '[itemsFor] dids.total is every number');
  ok(keys('dids.tollFree') === 'did:18005550102,did:18335550103', '[itemsFor] dids.tollFree is the toll-free numbers');
  ok(keys('dids.local') === 'did:13175550100,did:13175550101', '[itemsFor] dids.local is the rest');
  ok(keys('e911Addresses') === 'addr:a-1,addr:a-2', '[itemsFor] addresses');
  ok(keys('smsNumbers') === 'sms:13175550100', '[itemsFor] SMS numbers');
  ok(itemsFor(d, 'devices.total') === undefined, '[itemsFor] devices have no item list');
  ok(itemsFor(d, 'devices.byModel.Yealink T54W') === undefined, '[itemsFor] not even per model');
  ok(itemsFor(d, 'systemUsers.total') === undefined, '[itemsFor] system users are never compared, so no list');
  ok(itemsFor(d, 'nonsense.path') === undefined, '[itemsFor] an unknown path is undefined, not []');
  ok(itemLabel(d.extensions[0]!) === '100 — Ann Lee, North', '[label] extension: ext — name, site');
  ok(itemLabel(d.extensions[3]!) === '103', '[label] extension with no name and no site is just the number');
  ok(itemLabel(d.dids[2]!) === '18005550102 (toll-free)', '[label] number with kind');
  ok(itemLabel(d.e911Addresses[0]!) === 'HQ — 1 Main St, Springfield', '[label] address is its label');
  ok(itemLabel(d.smsNumbers[0]!) === '13175550100', '[label] SMS is its number');
}

// ── blank identity fields never collide onto one key ─────────────────────────────────────────────────
{
  const blank = {
    meta: { domain: 'blank.example' },
    users: [{ 'user-scope': 'Basic User', 'service-code': '', 'name-first-name': 'No', 'name-last-name': 'Id' }],
    devicesByUser: { '': [{ aor: 'sip:t@blank.example', 'device-models-model': 'Yealink T31P' }] },
    phonenumbers: [{ phonenumber: '' }, { phonenumber: '' }],
    addresses: [
      { 'emergency-address-id': '', 'address-name': 'Suite A', 'address-line-1': '1 Main St', 'address-city': 'Springfield' },
      { 'emergency-address-id': '', 'address-name': 'Suite B', 'address-line-1': '2 Main St', 'address-city': 'Springfield' },
    ],
    smsnumbers: [{ number: '' }, { number: '' }],
  } as Snapshot;
  const d = listDomainInventory(blank);
  const again = listDomainInventory(blank);

  const [a0, a1] = d.e911Addresses;
  ok(a0!.key.startsWith('addr:~'), '[blank] a blank address id falls back to addr:~<hash>');
  ok(a1!.key.startsWith('addr:~'), '[blank] and so does the second one');
  ok(a0!.key !== a1!.key, '[blank] two blank-id addresses on different streets get different keys');
  ok(a0!.key === again.e911Addresses[0]!.key, '[blank] the derived key is stable across two calls');
  ok(a1!.key === again.e911Addresses[1]!.key, '[blank] for the second address too');
  ok(a0!.label !== '', '[blank] a blank-id address still has a non-empty label');
  ok(a0!.label === 'Suite A — 1 Main St, Springfield', '[blank] and it is the same name — line 1, city label');

  const [n0, n1] = d.dids;
  ok(n0!.key.startsWith('did:~'), '[blank] a blank number falls back to did:~<hash>');
  ok(n0!.key === n1!.key, '[blank] two blank numbers share one derived key: nothing distinguishes them');
  ok(n0!.key === again.dids[0]!.key, '[blank] and that key is stable across two calls');

  const [s0, s1] = d.smsNumbers;
  ok(s0!.key.startsWith('sms:~'), '[blank] a blank SMS number falls back to sms:~<hash>');
  ok(s0!.key === s1!.key, '[blank] and two blank SMS numbers do the same');

  const x = d.extensions[0]!;
  ok(x.key.startsWith('ext:~'), '[blank] a blank user falls back to ext:~<hash>');
  ok(x.teams === false, '[blank] and a bare `t` aor is not a Teams connector without an extension number to match');
  ok(x.deviceCount === 1, '[blank] that device is counted as a handset rather than dropped');
  ok(x.key === again.extensions[0]!.key, '[blank] the extension key is stable across two calls');
}

// ── a derived key does not depend on where the record sat in the array ───────────────────────────────
{
  const numbers = [
    { phonenumber: '' },
    { phonenumber: '13175550100' },
    { phonenumber: '' , 'dial-rule-application': 'to-user' },
  ];
  const forward = listDomainInventory({ meta: { domain: 'order.example' }, phonenumbers: numbers } as Snapshot);
  const reversed = listDomainInventory({ meta: { domain: 'order.example' }, phonenumbers: [...numbers].reverse() } as Snapshot);
  const derived = (d: ReturnType<typeof listDomainInventory>) =>
    d.dids.map((n) => n.key).filter((k) => k.startsWith('did:~')).sort().join(',');
  ok(derived(forward) !== '', '[order] the fixture really does produce derived keys');
  ok(derived(forward) === derived(reversed), '[order] reversing the phonenumbers array leaves the did:~ keys unchanged');
}

// ── usersByExt / destinationOf ───────────────────────────────────────────────────────────────────────
{
  const usersFx: Rec[] = [
    { user: '100', 'name-first-name': 'Ann', 'name-last-name': 'Lee' },
    { user: '701', 'service-code': 'system-queue', 'name-first-name': 'Sales' },
  ];
  const byExt = usersByExt(usersFx);
  ok(byExt.size === 2, '[usersByExt] one entry per non-blank user');
  const deduped = usersByExt([...usersFx, { user: '100', 'name-first-name': 'Duplicate' }]);
  ok(deduped.get('100')!['name-first-name'] === 'Ann', '[usersByExt] the FIRST record for a repeated extension wins');

  ok(destinationOf({ 'dial-rule-translation-destination-user': '100' }, byExt) === 'to user 100 — Ann Lee', '[destinationOf] a real extension names the person');
  ok(destinationOf({ 'dial-rule-translation-destination-user': '701' }, byExt) === 'to queue 701 — Sales', '[destinationOf] a system-queue destination strips the system- prefix and names the queue');
  ok(destinationOf({ 'dial-rule-translation-destination-user': '999', 'dial-rule-application': 'to-user' }, byExt) === 'to user 999', '[destinationOf] an unknown destination falls back to the application, to- stripped');
  ok(destinationOf({ 'dial-rule-application': 'to-connection' }, byExt) === 'to connection', '[destinationOf] no destination, application only — to- stripped so it does not read "to to-connection"');
  ok(destinationOf({}, byExt) === '', '[destinationOf] neither field set is empty, not "to undefined"');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
