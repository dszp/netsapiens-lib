/** Offline test for the domain inventory counter. pnpm test:inventory */
import { countDomainInventory, emergencyDigits, legacyEmergencyNumber, listDomainInventory, itemsFor, itemLabel, destinationOf, resolveEmergency, usersByExt, DEFAULT_DEVICE_SUFFIXES } from './inventory.js';
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
ok(inv.dids.fax === 0 && inv.dids.all === 4, 'no fax-server hosts were supplied, so nothing is a fax line and all equals total');
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
ok(empty.dids.fax === 0 && empty.dids.all === 0, 'empty snapshot: no fax lines either');
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
      { name: '101a', model: 'Yealink T54W', teams: false, suffix: 'a', kind: '' },
      { name: '101b', model: 'Yealink T31P', teams: false, suffix: 'b', kind: '' },
      { name: '101c', model: '(unknown)', teams: false, suffix: 'c', kind: '' },
    ]),
    '[list] devices lists every device with its name, model and teams flag, in order',
  );
  const e103 = d.extensions.find((x) => x.ext === '103')!;
  ok(e103.teams === true, '[list] a device whose aor local part is <ext>t marks the extension Teams-connected');
  ok(e103.deviceCount === 0 && e103.deviceModels.length === 0, '[list] and that connector is not counted as a device');
  ok(
    JSON.stringify(e103.devices) === JSON.stringify([{ name: '103t', model: '', teams: true, suffix: 't', kind: 'Teams' }]),
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
  ok(c.dids.all === d.dids.length && c.dids.fax === d.dids.filter((n) => n.fax).length, '[fold] dids.all is the whole list and dids.fax the fax lines in it');
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

// ── a device is named by `device`, and only falls back to `aor` ──────────────────────────────────────
// A LIVE /users/<ext>/devices record names the device in `device` and frequently carries no `aor` at all.
// Reading `aor` alone blanked every device name and — worse — broke the `<ext>t` Teams test, so a Teams
// connector read as a handset and inflated deviceCount, devices.total and byDeviceCount while
// teamsConnected read zero. That is the shape this block pins.
{
  const live = {
    meta: { domain: 'live.example' },
    users: [
      { user: '1001', 'user-scope': 'Basic User', 'service-code': '' },
      { user: '1002', 'user-scope': 'Basic User', 'service-code': '' },
      { user: '1003', 'user-scope': 'Basic User', 'service-code': '' },
    ],
    devicesByUser: {
      // `device` only — the live shape.
      '1001': [
        { device: 'sip:1001a@live.example', 'device-models-model': 'Yealink T54W' },
        { device: 'sip:1001t@live.example', 'device-models-model': 'Teams' },
      ],
      // BOTH, disagreeing: `device` wins, being the field the system names the device by.
      '1002': [{ device: 'sip:1002a@live.example', aor: 'sip:wrong@live.example', 'device-models-model': 'Yealink T31P' }],
      // NEITHER: the name is empty rather than guessed, and an empty name is not a `t`.
      '1003': [{ 'device-models-model': 'Yealink T31P' }],
    },
  } as Snapshot;

  const d = listDomainInventory(live);
  const e1 = d.extensions.find((x) => x.ext === '1001')!;
  ok(e1.devices[0]!.name === '1001a', '[device] a record with `device` and no `aor` is still named');
  ok(e1.teams === true, '[device] and its <ext>t connector is detected — reading `aor` alone made this false on every live domain');
  ok(e1.devices[1]!.teams === true && e1.devices[1]!.model === '', '[device] the connector row is marked and prints no model');
  ok(e1.deviceCount === 1 && JSON.stringify(e1.deviceModels) === JSON.stringify(['Yealink T54W']),
    '[device] so the connector is excluded from the handset count rather than inflating it');

  const e2 = d.extensions.find((x) => x.ext === '1002')!;
  ok(e2.devices[0]!.name === '1002a', '[device] where a record carries both, `device` wins');

  const e3 = d.extensions.find((x) => x.ext === '1003')!;
  ok(e3.devices[0]!.name === '', '[device] a record with neither field has an empty name, not "undefined"');
  ok(e3.teams === false && e3.deviceCount === 1, '[device] and an unnamed device is a handset, never a connector');

  const c = countDomainInventory(live);
  ok(c.teamsConnected === 1, '[device] teamsConnected counts the one connector');
  ok(c.devices.total === 3, '[device] and devices.total is the three handsets, the connector excluded');

  // The `aor`-only fixture at the top of this file still behaves exactly as it did — the fallback is a
  // fallback, not a replacement.
  ok(listDomainInventory(snap).extensions.find((x) => x.ext === '103')!.teams === true,
    '[device] a record carrying only `aor` is unchanged');
}

// ── fax lines ────────────────────────────────────────────────────────────────────────────────────────
// The portal's "Fax Server" treatment is an ordinary phone number whose dial rule hands it to a host:
// to-connection, plus dial-rule-translation-destination-host. There is no fax endpoint in the API and
// the ATA is not a device on any user, so the host is the only thing that says "fax line" — and the host
// belongs to the deployment, not to this library, which is why it arrives as an option.
{
  const faxSnap = {
    meta: { domain: 'fax.example' },
    users: [{ user: '100', 'user-scope': 'Basic User', 'service-code': '', 'name-first-name': 'Ann', 'name-last-name': 'Lee' }],
    phonenumbers: [
      { phonenumber: '13175550100', 'dial-rule-translation-destination-user': '100' },
      {
        phonenumber: '13175550199',
        'dial-rule-application': 'to-connection',
        'dial-rule-translation-destination-host': '203.0.113.7',
        'dial-rule-description': 'Portal Created: Phonenumber -> FaxServer',
      },
    ],
  } as Snapshot;
  const HOSTS = { faxServerHosts: ['203.0.113.7'] };

  const d = listDomainInventory(faxSnap, HOSTS);
  const fx = d.dids[1]!;
  ok(fx.fax === true, '[fax] a number whose destination host is the fax server is a fax line');
  ok(d.dids[0]!.fax === false, '[fax] and the one routed to a user is not');
  ok(fx.kind === 'local', '[fax] a fax line still has a kind — it is a local or toll-free number like any other');
  ok(fx.destination === 'to fax server', '[fax] its destination reads "to fax server" — never the bare host');
  ok(!fx.destination.includes('203.0.113.7'), '[fax] the fax server address does not reach a reader');
  ok(fx.description === 'Portal Created: Phonenumber -> FaxServer', '[fax] the portal note is carried as written; it is not what the test reads');

  const c = countDomainInventory(faxSnap, HOSTS);
  ok(c.dids.fax === 1, '[fax] dids.fax counts it');
  ok(c.dids.total === 1 && c.dids.local === 1 && c.dids.tollFree === 0, '[fax] and dids.total/local/tollFree leave it out — it is billed as a fax line, not as a DID');
  ok(c.dids.all === 2, '[fax] dids.all is every number, fax lines included');
  ok(c.dids.total + c.dids.fax === c.dids.all, '[fax] total + fax partitions all');

  const keys = (p: string) => (itemsFor(d, p) ?? []).map((x) => x.key).join(',');
  ok(keys('dids.fax') === 'did:13175550199', '[fax] itemsFor dids.fax is the fax lines');
  ok(keys('dids.total') === 'did:13175550100', '[fax] itemsFor dids.total excludes them, exactly as the count does');
  ok(keys('dids.local') === 'did:13175550100', '[fax] and so does dids.local');
  ok(keys('dids.all') === 'did:13175550100,did:13175550199', '[fax] dids.all is everything');
  ok(itemLabel(fx) === '13175550199', '[fax] the label is unchanged — a fax line is named by its number like any other');

  // The SAME snapshot with no hosts supplied. A library that guessed a fax server would be wrong on
  // every deployment but the one it was written against, so it guesses nothing.
  const bare = listDomainInventory(faxSnap);
  ok(bare.dids[1]!.fax === false, '[fax] no hosts supplied, nothing is a fax line');
  ok(bare.dids[1]!.destination === 'to connection', '[fax] and the destination falls back to the application');
  const bareCounts = countDomainInventory(faxSnap);
  ok(bareCounts.dids.fax === 0 && bareCounts.dids.total === 2 && bareCounts.dids.local === 2,
    '[fax] the fax line is counted as the local DID it otherwise looks like');
  ok(bareCounts.dids.all === bareCounts.dids.total, '[fax] all equals total when nothing is a fax line');
  ok(countDomainInventory(faxSnap, { faxServerHosts: [] }).dids.fax === 0, '[fax] an empty host list is the same as none');
  ok(countDomainInventory(faxSnap, { faxServerHosts: ['', '   '] }).dids.fax === 0, '[fax] and so is a list of blanks — a blank host must not match a number with no host');

  // Host matching is trimmed and case-insensitive on BOTH sides: a hostname is not case-sensitive, and
  // a comma-separated setting arrives with spaces around its entries.
  const named = {
    meta: { domain: 'fax2.example' },
    phonenumbers: [{ phonenumber: '13175550198', 'dial-rule-application': 'to-connection', 'dial-rule-translation-destination-host': '  Fax.Example.COM  ' }],
  } as Snapshot;
  ok(countDomainInventory(named, { faxServerHosts: [' fax.example.com '] }).dids.fax === 1, '[fax] host matching trims and lower-cases both sides');
  ok(countDomainInventory(named, { faxServerHosts: ['other.example.com'] }).dids.fax === 0, '[fax] a host that is not on the list is not a fax line');

  // The description is a note the portal writes and an operator can edit, so it is never the test.
  const noteOnly = {
    meta: { domain: 'fax3.example' },
    phonenumbers: [{ phonenumber: '13175550197', 'dial-rule-application': 'to-connection', 'dial-rule-description': 'Portal Created: Phonenumber -> FaxServer' }],
  } as Snapshot;
  ok(countDomainInventory(noteOnly, { faxServerHosts: ['203.0.113.7'] }).dids.fax === 0, '[fax] the "-> FaxServer" description alone does not make a fax line');
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
    { user: '702', 'service-code': 'system-' },
  ];
  const byExt = usersByExt(usersFx);
  ok(byExt.size === 3, '[usersByExt] one entry per non-blank user');
  const deduped = usersByExt([...usersFx, { user: '100', 'name-first-name': 'Duplicate' }]);
  ok(deduped.get('100')!['name-first-name'] === 'Ann', '[usersByExt] the FIRST record for a repeated extension wins');

  ok(destinationOf({ 'dial-rule-translation-destination-user': '100' }, byExt) === 'to user 100 — Ann Lee', '[destinationOf] a real extension names the person');
  ok(destinationOf({ 'dial-rule-translation-destination-user': '701' }, byExt) === 'to queue 701 — Sales', '[destinationOf] a system-queue destination strips the system- prefix and names the queue');
  ok(destinationOf({ 'dial-rule-translation-destination-user': '702' }, byExt) === 'to system 702', '[destinationOf] a bare "system-" service code has nothing left to strip, so kind falls back to "system" rather than a double space');
  ok(destinationOf({ 'dial-rule-translation-destination-user': '999', 'dial-rule-application': 'to-user' }, byExt) === 'to user 999', '[destinationOf] an unknown destination falls back to the application, to- stripped');
  ok(
    destinationOf({ 'dial-rule-translation-destination-user': '999', 'dial-rule-translation-destination-host': 'other.example' }, byExt) === 'to user 999@other.example',
    '[destinationOf] an unknown destination with a host appends @host',
  );
  ok(destinationOf({ 'dial-rule-application': 'to-connection' }, byExt) === 'to connection', '[destinationOf] no destination, application only — to- stripped so it does not read "to to-connection"');
  ok(destinationOf({}, byExt) === '', '[destinationOf] neither field set is empty, not "to undefined"');
  const faxRule: Rec = { 'dial-rule-application': 'to-connection', 'dial-rule-translation-destination-host': '203.0.113.7' };
  ok(destinationOf(faxRule, byExt) === 'to connection', '[destinationOf] with no host list a fax rule is just a connection');
  ok(destinationOf(faxRule, byExt, ['203.0.113.7']) === 'to fax server', '[destinationOf] with the host on the list it reads "to fax server"');
  ok(
    destinationOf({ ...faxRule, 'dial-rule-translation-destination-user': '100' }, byExt, ['203.0.113.7']) === 'to fax server',
    '[destinationOf] the fax test wins over a destination user, so no reader is shown a bare IP',
  );
}

// ── the device-suffix legend ────────────────────────────────────────────────────────────────────────
// A device's SUFFIX is what its name carries after the extension number, and the legend says what that
// suffix IS. The default is the three NetSapiens ships; a supplied legend replaces it wholesale, which
// is how a deployment without TeamMate turns Teams detection off and how one with its own app names it.
{
  const sufSnap = (devices: Rec[]): Snapshot => ({
    meta: { domain: 'suffix.example' },
    users: [{ user: '1001', 'user-scope': 'Basic User', 'service-code': '' }],
    devicesByUser: { '1001': devices },
  } as Snapshot);
  const dev = (name: string, model = ''): Rec => ({ device: `sip:${name}@suffix.example`, 'device-models-model': model });
  const one = (snapshot: Snapshot, opts?: Parameters<typeof listDomainInventory>[1]) =>
    listDomainInventory(snapshot, opts).extensions[0]!;

  // The default legend, one device at a time.
  {
    const x = one(sufSnap([dev('1001wp'), dev('1001m'), dev('1001t'), dev('1001b'), dev('1001', 'Yealink T54W')]));
    const by = (name: string) => x.devices.find((d) => d.name === name)!;
    ok(by('1001wp').suffix === 'wp' && by('1001wp').kind === 'SNAPmobile Web', '[suffix] wp is SNAPmobile Web');
    ok(by('1001m').suffix === 'm' && by('1001m').kind === 'SNAPmobile', '[suffix] m is SNAPmobile');
    ok(by('1001t').suffix === 't' && by('1001t').kind === 'Teams', '[suffix] t is Teams');
    ok(by('1001t').teams === true, '[suffix] and the t entry carries teams: true');
    ok(by('1001b').suffix === 'b' && by('1001b').kind === '', '[suffix] a suffix the legend does not carry has no kind, rather than a guessed one');
    ok(by('1001b').teams === false, '[suffix] and it is a handset');
    ok(by('1001').suffix === '' && by('1001').kind === '', '[suffix] a bare extension name has no suffix and no kind');
    ok(x.teams === true, '[suffix] the extension is Teams-connected');
    ok(x.deviceCount === 4 && x.devices.length === 5, '[suffix] the connector is in the display list and out of the count');
    ok(x.anyDevice === true, '[suffix] anyDevice is unchanged');
  }

  // A legend WITHOUT `t` — a deployment with no TeamMate. Teams detection is off entirely, so the
  // device that used to be a connector is a handset like any other and is counted as one.
  {
    const x = one(sufSnap([dev('1001t', 'Yealink T54W')]), { deviceSuffixes: { wp: { label: 'SNAPmobile Web' } } });
    ok(x.teams === false, '[suffix] a legend without t means no Teams connectors at all');
    ok(x.devices[0]!.teams === false && x.devices[0]!.kind === '', '[suffix] that device is a plain handset with no kind');
    ok(x.deviceCount === 1 && x.deviceModels[0] === 'Yealink T54W', '[suffix] and it is counted, model and all');
    ok(x.devices[0]!.model === 'Yealink T54W', '[suffix] a handset keeps its model — the blank is only for a connector');
  }

  // A supplied legend REPLACES the default rather than merging into it.
  {
    const x = one(sufSnap([dev('1001r'), dev('1001wp')]), { deviceSuffixes: { r: { label: 'Acme App' } } });
    ok(x.devices.find((d) => d.name === '1001r')!.kind === 'Acme App', '[suffix] a supplied suffix is labelled from the supplied legend');
    ok(x.devices.find((d) => d.name === '1001wp')!.kind === '', '[suffix] and wp is unknown again, because the supplied legend replaced the default wholesale');
  }

  // Case-insensitive on both sides of the comparison.
  {
    const x = one(sufSnap([dev('1001WP'), dev('1001T')]));
    ok(x.devices[0]!.suffix === 'wp' && x.devices[0]!.kind === 'SNAPmobile Web', '[suffix] an upper-case device suffix matches the legend');
    ok(x.devices[1]!.teams === true, '[suffix] including the Teams test');
    const y = one(sufSnap([dev('1001r')]), { deviceSuffixes: { R: { label: 'Acme App' } } });
    ok(y.devices[0]!.kind === 'Acme App', '[suffix] and an upper-case LEGEND key matches a lower-case device suffix');
  }

  // A name that does not start with the extension has no suffix — `sales1` is a differently-named
  // device, not a device of kind `sales1`.
  {
    const x = one(sufSnap([dev('sales1')]));
    ok(x.devices[0]!.suffix === '' && x.devices[0]!.kind === '', '[suffix] a name that does not start with the extension has no suffix');
  }

  // A user with NO extension number. The suffix is the whole of the Teams test now, and a suffix needs
  // an extension to come after — so a device NAMED a bare `t` is a handset, counted as one.
  {
    const x = listDomainInventory({
      meta: { domain: 'suffix.example' },
      users: [{ user: '', 'user-scope': 'Basic User', 'service-code': '' }],
      devicesByUser: { '': [dev('t', 'Yealink T54W')] },
    } as Snapshot).extensions[0]!;
    ok(x.devices[0]!.suffix === '' && x.devices[0]!.kind === '', '[suffix] a device named a bare t on a blank extension has no suffix');
    ok(x.teams === false && x.devices[0]!.teams === false, '[suffix] so it is not a Teams connector');
    ok(x.deviceCount === 1 && x.deviceModels[0] === 'Yealink T54W', '[suffix] and it is counted as the handset it reads as');
  }

  // The legend is keyed by a device-name suffix off a snapshot, so an inherited Object name is a
  // reachable key. On a plain object `legend['constructor']` answers a function rather than undefined.
  for (const evil of ['constructor', 'toString', 'hasOwnProperty']) {
    const x = one(sufSnap([dev(`1001${evil}`)]));
    ok(x.devices[0]!.kind === '' && x.devices[0]!.teams === false,
      `[suffix] a suffix named ${evil} reads as unknown rather than picking up an inherited value`);
  }

  ok(DEFAULT_DEVICE_SUFFIXES.t!.teams === true && DEFAULT_DEVICE_SUFFIXES.wp!.teams === undefined,
    '[suffix] the exported default marks only t as the Teams connector');
}

// ── E911: endpoints bill, addresses locate, legacy numbers are derived ──────────────────────────────
{
  // One domain default address, one endpoint bound to it by name, and a second endpoint that nothing
  // defaults to. `emergency-address-id` on an ENDPOINT is the callback number; on an ADDRESS it is the
  // `a-…` id — the same field name meaning two things is the trap this fixture pins down.
  const e911: Snapshot = {
    meta: { domain: 'acme.example' },
    users: [
      { user: '100', 'service-code': '', site: 'North', 'emergency-address-id': 'a-1', 'caller-id-number-emergency': '3175550100' },
      // Eleven digits where the endpoint says ten — the same endpoint, and the point of `emergencyDigits`.
      { user: '101', 'service-code': '', site: 'North', 'emergency-address-id': 'a-2', 'caller-id-number-emergency': '13175550101' },
      // Both fields blank: inherits the domain default address AND its endpoint. Not legacy.
      { user: '102', 'service-code': '', site: 'South' },
      // The wildcard is "not set", not a value.
      { user: '103', 'service-code': '', site: 'South', 'caller-id-number-emergency': '[*]' },
      { user: '700', 'service-code': 'system-aa', 'caller-id-number-emergency': '3175559999' },
    ],
    addresses: [
      { 'emergency-address-id': 'a-1', 'address-name': 'HQ', 'address-line-1': '1 Main St', 'address-city': 'Springfield', domain_default: true },
      { 'emergency-address-id': 'a-2', 'address-name': 'Annex', 'address-line-1': '2 Side St', 'address-city': 'Springfield' },
    ],
    addressEndpoints: [
      { 'emergency-address-id': '3175550100', 'address-name': 'HQ', 'caller-name': 'Acme HQ', 'address-line-1': '1 Main St', 'address-city': 'Springfield', 'count-users-configured': 3, sub_count_total: 9 },
      { 'emergency-address-id': '3175550101', 'address-name': 'Annex', 'caller-name': '', 'address-line-1': '', 'address-city': '' },
    ],
  } as Snapshot;

  const inv = countDomainInventory(e911);
  const d = listDomainInventory(e911);
  ok(inv.e911Endpoints === 2, '[e911] two provisioned endpoints');
  ok(inv.e911Addresses === 2, '[e911] and the two addresses are still counted, as information');
  ok(inv.e911Legacy === 0, '[e911] a domain on the endpoint model has no legacy numbers');

  const hq = d.e911Endpoints[0]!;
  ok(hq.key === 'e911:3175550100', '[e911] the key is the callback, taken from the endpoint’s emergency-address-id');
  ok(hq.callback === '3175550100' && hq.callerName === 'Acme HQ', '[e911] the callback and the caller name come off the record');
  ok(hq.billingAddress === '1 Main St, Springfield', '[e911] the billing address is one line, no wider than the address list');
  ok(hq.users === 3, '[e911] users is count-users-configured, not sub_count_total');
  ok(itemLabel(hq) === '3175550100 — Acme HQ, 1 Main St, Springfield', '[e911] the label names the number, then who and where');
  ok(itemLabel(d.e911Endpoints[1]!) === '3175550101', '[e911] and an endpoint with neither is just its number — no dangling dash');
  ok(itemsFor(d, 'e911Endpoints')!.length === 2, '[e911] itemsFor answers the endpoints path');
  ok(itemsFor(d, 'e911Addresses')!.length === 2, '[e911] and the addresses path still answers separately');

  const em = resolveEmergency(e911);
  ok(em.defaultAddressId === 'a-1', '[e911] the domain default is the address flagged domain_default');
  ok(em.defaultCallback === '3175550100', '[e911] whose callback is joined through the endpoint naming the same address');
  ok(em.addressIdFor(e911.users![2]!) === 'a-1', '[e911] a user with a blank address id inherits the domain default');
  ok(em.addressIdFor(e911.users![1]!) === 'a-2', '[e911] and one that sets its own keeps it');
  ok(em.callbackFor(e911.users![2]!) === '3175550100', '[e911] a user with a blank caller ID inherits the default address’s callback');
  ok(em.callbackFor(e911.users![1]!) === '3175550101', '[e911] an 11-digit caller ID resolves to the 10-digit endpoint');
  ok(em.setCallbackFor(e911.users![3]!) === '', '[e911] the [*] wildcard is not set');
  ok(em.callbackFor(e911.users![3]!) === '3175550100', '[e911] so that user inherits the default too');

  // An endpoint whose record names no callback still has to be a distinguishable row.
  const blank = listDomainInventory({ ...e911, addressEndpoints: [{ 'address-name': 'Dock', 'caller-name': 'Acme Dock' }] } as Snapshot).e911Endpoints[0]!;
  ok(blank.key.startsWith('e911:~'), '[e911] an endpoint with no callback falls back to a derived key');
}

{
  // A LEGACY domain: no endpoints at all, every user with a blank emergency-address-id and one of two
  // numbers set by hand. Measured shape — a 100-user domain with exactly two such numbers.
  const legacy: Snapshot = {
    meta: { domain: 'demo.12345.service' },
    users: [
      { user: '100', 'service-code': '', site: 'North', 'caller-id-number-emergency': '3175550200' },
      { user: '101', 'service-code': '', site: 'North', 'caller-id-number-emergency': '13175550200' },
      { user: '102', 'service-code': '', site: 'South', 'caller-id-number-emergency': '3175550201' },
      // Nothing set anywhere and no domain default to inherit: not legacy, and not anything else.
      { user: '103', 'service-code': '', site: 'South' },
      // On its device rather than on the user.
      { user: '104', 'service-code': '', site: 'South' },
      // A system user is not a seat and does not make a number legacy.
      { user: '700', 'service-code': 'system-queue', 'caller-id-number-emergency': '3175550299' },
    ],
    devicesByUser: { '104': [{ device: 'sip:104@demo.12345.service', 'caller-id-number-emergency': '3175550201' }] },
  } as Snapshot;

  const inv = countDomainInventory(legacy);
  const d = listDomainInventory(legacy);
  ok(inv.e911Legacy === 2, '[legacy] two DISTINCT numbers across five seats, matching the carrier’s two lines');
  ok(inv.e911Endpoints === 0 && inv.e911Addresses === 0, '[legacy] and no endpoints or addresses to count');
  ok(d.e911Legacy.map((x) => x.key).join() === 'e911legacy:3175550200,e911legacy:3175550201', '[legacy] keyed by the digits');
  ok(d.e911Legacy[0]!.users === 2, '[legacy] the 10- and 11-digit spellings are one number');
  ok(d.e911Legacy[1]!.users === 2, '[legacy] and a device’s number counts when the user sets none');
  ok(itemLabel(d.e911Legacy[0]!) === '3175550200 — legacy E911 (2 users)', '[legacy] the label says why a bare number is on an E911 row');
  ok(itemsFor(d, 'e911Legacy')!.length === 2, '[legacy] itemsFor answers the legacy path');

  // HALF-MIGRATED: one of the two numbers is now a provisioned endpoint. It must be counted once, as an
  // endpoint, or the domain pays for the same place twice.
  const half = { ...legacy, addressEndpoints: [{ 'emergency-address-id': '3175550200', 'address-name': 'HQ', 'caller-name': 'Demo HQ' }] } as Snapshot;
  const hi = countDomainInventory(half);
  ok(hi.e911Endpoints === 1 && hi.e911Legacy === 1, '[legacy] a number that became an endpoint leaves the legacy count');
  ok(listDomainInventory(half).e911Legacy[0]!.number === '3175550201', '[legacy] and the one still on the old model stays');

  // A user with BOTH fields blank on a domain that HAS a default is on the new model, not the old one.
  const withDefault = {
    ...legacy,
    users: [{ user: '110', 'service-code': '', site: 'North' }],
    devicesByUser: {},
    addresses: [{ 'emergency-address-id': 'a-9', 'address-name': 'HQ', domain_default: true }],
    addressEndpoints: [{ 'emergency-address-id': '3175550300', 'address-name': 'HQ', 'caller-name': 'Demo HQ' }],
  } as Snapshot;
  ok(countDomainInventory(withDefault).e911Legacy === 0, '[legacy] both fields blank is the domain default, not a legacy number');
  const em = resolveEmergency(withDefault);
  ok(legacyEmergencyNumber(withDefault.users![0]!, em) === '', '[legacy] and the predicate says so directly');
}

ok(emergencyDigits('+1 (317) 555-0100') === '3175550100' && emergencyDigits('13175550100') === '3175550100',
  '[e911] a caller ID normalises to ten digits however it is punctuated');
ok(emergencyDigits('[*]') === '' && emergencyDigits('') === '' && emergencyDigits(undefined) === '',
  '[e911] and the three ways of saying "not set" all answer empty');


console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
