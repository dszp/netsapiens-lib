/**
 * Count a domain's inventory along the dimensions a VoIP operator actually sells on.
 *
 * Pure: it fetches nothing. Feed it a `Snapshot` — from `fetchDomainSnapshot`, a backup, or a
 * fixture — and it returns fixed, named counts and nothing else.
 *
 * ## Counts, and the lists behind them
 *
 * A device record from NetSapiens carries the SIP registration password. `listDomainInventory` builds
 * per-item lists — an extension's name and site, a number's kind and routing destination, an address's
 * label — from an allowlist of named fields, and `countDomainInventory` is a fold over those same
 * lists. The allowlist now includes a device's NAME (the local part of its `device` SIP URI, falling back
 * to `aor` — e.g. `101b`, the same short id the portal shows) alongside its model; a device's MAC, SIP
 * password and email never appear, and nothing here should be added that carries one.
 *
 * ## Every countable dimension is a numeric leaf
 *
 * A caller comparing this against a billing system addresses a dimension by dotted path —
 * `extensions.total`, `dids.tollFree`, `extensions.byServiceCode.premium`. Keeping every leaf numeric
 * is what makes that possible without this module knowing anything about the billing side.
 *
 * ## What counts as an extension
 *
 * A user whose `service-code` is empty or does not begin with `system-`. NetSapiens models auto
 * attendants, queues and time-of-day routers as users, and counting them as seats would overstate
 * every domain that has any. They are counted separately, as information, and never compared.
 *
 * ## What counts as a fax line
 *
 * On the portal's "Fax Server" treatment a number is an ordinary phone number whose dial rule hands it
 * to a fax server host — `dial-rule-application: to-connection` with
 * `dial-rule-translation-destination-host` set to that host. There is no fax-account endpoint and the
 * ATA is not a device on any user, so the host is the only thing in the API that says "this is a fax
 * line", and nothing in the API can tell an analog fax from a digital one.
 *
 * The host is therefore the whole test, and it is the CALLER's: pass `{ faxServerHosts }` to
 * {@link listDomainInventory} or {@link countDomainInventory}. Matching is on the trimmed host,
 * case-insensitively, and on nothing else — not the `dial-rule-description`, which is a portal-written
 * note an operator can edit. **With no hosts supplied nothing is a fax line**, because a library that
 * hardcoded one deployment's fax server would be wrong everywhere else.
 */
import type { Rec, Snapshot } from './model.js';

export interface DomainInventory {
  /** Real seats: users whose `service-code` is empty or non-`system-*`. */
  extensions: {
    total: number;
    /** Keyed by the raw `user-scope` value, e.g. "Basic User". */
    byScope: Record<string, number>;
    /** Keyed by the raw `service-code`, the empty string included. */
    byServiceCode: Record<string, number>;
    /** Multi-device extensions are a real billing shape (a restaurant with four handsets on one seat). */
    byDeviceCount: Record<'0' | '1' | '2' | '3+', number>;
    /** Extensions with `anyDevice` true — handset or Teams connector, either counts. */
    withAnyDevice: number;
    /** The rest: no handset and no Teams connector. `withAnyDevice + withNoDevice === total`. */
    withNoDevice: number;
  };
  /** `system-aa`, `system-queue`, `system-tod` and any other `system-*` code. Informational. */
  systemUsers: { total: number; byServiceCode: Record<string, number> };
  /** Extensions whose `voicemail-transcription-enabled` is anything but empty or `no`. */
  transcriptionEnabled: number;
  /**
   * Extensions with a Microsoft Teams connector device — one whose device NAME is the extension number
   * followed by `t` (`1000t`), which is how the TeamMate connector registers. See {@link deviceName} for
   * which field that name is read from, and why reading the wrong one silently miscounted this.
   * That device is NOT counted under `devices`: it is a connector, not a handset.
   */
  teamsConnected: number;
  /**
   * Phone numbers on the domain, split by NANP toll-free prefix — **fax lines excluded**.
   *
   * A number handed to the fax server is billed as a fax line, not as a DID, so `total`, `tollFree`
   * and `local` all leave it out and `fax` counts it instead. `all` is every phone number the domain
   * holds, fax lines included: `total + fax === all`.
   *
   * With no `faxServerHosts` supplied nothing is a fax line, `fax` is 0 and `total === all` — the
   * numbers this returned before 0.7.0, unchanged.
   */
  dids: { total: number; tollFree: number; local: number; fax: number; all: number };
  /** E911 address records on the domain. */
  e911Addresses: number;
  /** SMS-enabled numbers on the domain. */
  smsNumbers: number;
  /** Devices belonging to real extensions only — a system user's device is not a seat. */
  devices: { total: number; byModel: Record<string, number> };
}

/**
 * One extension, as a billing consumer may see it. An allowlist, not a record: name, site and the
 * device MODELS are here; the MAC, the SIP credentials and the email are not, and nothing here should
 * be added that carries one.
 */
export interface ExtensionItem {
  /**
   * `ext:<user>` — the stable identity a consumer records a decision against. When `user` is blank
   * the key falls back to `ext:~<hash>` of the remaining fields (see {@link listDomainInventory}),
   * which keeps two differently-named nameless records apart and deliberately merges two whose
   * fields are identical.
   */
  key: string;
  ext: string;
  /** `name-first-name` + `name-last-name`, trimmed; `''` when both are blank. */
  name: string;
  /** The user's `site`; `''` when none. */
  site: string;
  scope: string;
  /** `service-code`, `''` included. */
  serviceCode: string;
  transcription: boolean;
  /** See {@link DomainInventory.teamsConnected}. */
  teams: boolean;
  /** Handsets only — the Teams connector is excluded. */
  deviceCount: number;
  /** `device-models-model` per handset, `(unknown)` when blank. Never the MAC. */
  deviceModels: string[];
  /**
   * Every device on this extension, in record order, connector included: `name` is the local part of its
   * `device` SIP URI, or of `aor` when that is all the record has (`sip:101b@acme.example` → `101b`) —
   * the device NAME as the portal shows it — `model` is
   * `device-models-model` (`(unknown)` when blank on a handset, `''` for the Teams connector, which
   * has no model), and `teams` marks the connector entry itself. `deviceCount`/`deviceModels`/`teams`
   * above stay handset-only; this list is the one place a connector's own row shows up. Never the MAC
   * or the SIP password.
   */
  devices: Array<{ name: string; model: string; teams: boolean }>;
  /** `deviceCount > 0 || teams` — has a device of any kind, handset or connector. */
  anyDevice: boolean;
}
export interface NumberItem {
  key: string /* did:<phonenumber>, or did:~<hash> when the number is blank */;
  number: string;
  kind: 'local' | 'tollFree';
  /**
   * This number is handed to a fax server — see the module doc. `false` whenever the caller supplied no
   * `faxServerHosts`, since without a host list nothing here can tell a fax line from any other number.
   *
   * `kind` is still set on a fax line (a fax number is local or toll-free like any other), but the
   * COUNTS exclude it from `dids.total`/`local`/`tollFree` and count it under `dids.fax` instead.
   */
  fax: boolean;
  /** Where the number routes, for a person: see {@link destinationOf}. `''` when the record says nothing. */
  destination: string;
  /** `dial-rule-description` trimmed — the note the portal writes ("Portal Created: User - 1001"); `''` when blank. */
  description: string;
}
export interface AddressItem { key: string /* addr:<emergency-address-id>, or addr:~<hash> when the id is blank */; label: string }
export interface SmsItem { key: string /* sms:<number>, or sms:~<hash> when the number is blank */; number: string }
export type InventoryItem = ExtensionItem | NumberItem | AddressItem | SmsItem;

export interface DomainInventoryDetail {
  /** Real seats only, same rule as the count. */
  extensions: ExtensionItem[];
  /** Informational, never compared. */
  systemUsers: ExtensionItem[];
  dids: NumberItem[];
  e911Addresses: AddressItem[];
  smsNumbers: SmsItem[];
}

/**
 * What the caller has to tell the counter that the API cannot. Optional in full: every option absent is
 * the pre-0.7.0 behaviour, and no option changes what a snapshot has to contain.
 */
export interface InventoryOptions {
  /**
   * The hosts a fax line is handed to — an IP or a hostname, as it appears in
   * `dial-rule-translation-destination-host`. Compared trimmed and case-insensitively; blanks are
   * ignored. Absent or empty means NO number is a fax line. See the module doc for why this is the
   * caller's to supply.
   */
  faxServerHosts?: readonly string[];
}

/** NANP toll-free area codes, 800 through 888. A number outside this set is counted local. */
const TOLL_FREE = new Set(['800', '833', '844', '855', '866', '877', '888']);

export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const bump = (into: Record<string, number>, key: string): void => { into[key] = (into[key] ?? 0) + 1; };

/**
 * FNV-1a over a string, as eight lowercase hex digits. Synchronous and dependency-free on purpose:
 * `crypto.subtle.digest` is async, and an item key is built inside a pure, synchronous fold.
 * This is an identity, not a checksum — nothing here defends against a chosen collision.
 */
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * `<kind>:<id>` when the record names itself, `<kind>:~<hash of seed>` when it does not. A blank
 * identity field would otherwise hand every nameless record of that kind the same key, and a
 * consumer keying decisions by it would accept one record and believe it had accepted all of them.
 * The `~` is what tells a reader the key is derived rather than the system's own id.
 *
 * The seed is the record's OWN fields and nothing else — never its position in the array. A key that
 * depended on position would change under a re-fetch that reordered the list, orphaning every
 * decision a consumer had recorded against it. The price is that two blank records whose remaining
 * fields are identical collapse onto ONE key, and that is the right trade: a number with no number
 * is not a countable thing, and one derived row is more honest than two that shuffle.
 */
function identityKey(kind: string, id: string, seed: string): string {
  return id ? `${kind}:${id}` : `${kind}:~${hash32(seed)}`;
}

/** Is this user one of NetSapiens' internal routing objects rather than a seat? */
export function isSystemUser(user: Rec): boolean {
  return str(user['service-code']).toLowerCase().startsWith('system-');
}

/**
 * Toll-free test on the digits alone. `+1 (800) 555-0102`, `18005550102` and `8005550102` all read as
 * toll-free; anything that is not a 10- or 11-digit NANP number is counted local rather than guessed at.
 */
function isTollFree(raw: string): boolean {
  const digits = raw.replace(/\D+/g, '');
  const nanp = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return nanp.length === 10 && TOLL_FREE.has(nanp.slice(0, 3));
}

/** The fax-server hosts, trimmed, lower-cased and with blanks dropped — the shape {@link isFaxLine} tests against. */
function faxHosts(hosts: readonly string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const h of hosts ?? []) { const v = str(h).toLowerCase(); if (v) out.add(v); }
  return out;
}

/**
 * Is this number handed to a fax server? The `dial-rule-translation-destination-host` alone, matched
 * against the caller's list — never the `dial-rule-description`, which is a note the portal writes and
 * an operator can edit. An empty host set answers `false` for everything, which is the point: this
 * library knows no fax server of its own.
 */
function isFaxLine(p: Rec, hosts: Set<string>): boolean {
  if (!hosts.size) return false;
  return hosts.has(str(p['dial-rule-translation-destination-host']).toLowerCase());
}

/**
 * A device's NAME — the local part of its SIP URI (`sip:103t@acme.example` → `103t`), which is the short
 * id the portal shows and the string the Teams test matches against.
 *
 * **`device` first, `aor` second.** A live `/users/<ext>/devices` record names the device in `device` and
 * frequently carries no `aor` at all; reading `aor` alone therefore returned `''` on live data, which
 * blanked every device name on the page AND broke the `<ext>t` Teams test — so a Teams connector read as
 * `teams: false` and was counted as a handset in `deviceCount` and `devices.total`. Some records carry
 * both, and then `device` wins, being the field the system actually names the device by. Neither, and the
 * name is `''` rather than a guess.
 */
function deviceName(device: Rec): string {
  const a = (str(device.device) || str(device.aor)).replace(/^sip:/i, '');
  const at = a.indexOf('@');
  return at === -1 ? a : a.slice(0, at);
}

function extensionItem(u: Rec, devices: Rec[]): ExtensionItem {
  const ext = str(u.user);
  // The Teams test is `<ext>t`, so a blank ext would read every device NAMED a bare `t` as a connector.
  // No extension number, no Teams claim.
  const handsets = ext ? devices.filter((d) => deviceName(d) !== `${ext}t`) : devices;
  const transcription = str(u['voicemail-transcription-enabled']).toLowerCase();
  const teams = handsets.length !== devices.length;
  const name = `${str(u['name-first-name'])} ${str(u['name-last-name'])}`.trim();
  const scope = str(u['user-scope']);
  const serviceCode = str(u['service-code']);
  return {
    key: identityKey('ext', ext, `${scope}\u0000${serviceCode}\u0000${name}`),
    ext,
    name,
    site: str(u.site),
    scope,
    serviceCode,
    transcription: transcription !== '' && transcription !== 'no',
    teams,
    deviceCount: handsets.length,
    // A device whose model is blank is listed under a named bucket rather than dropped: a missing
    // model is a provisioning gap worth seeing, and a silently smaller total hides it.
    deviceModels: handsets.map((d) => str(d['device-models-model']) || '(unknown)'),
    // Every device, including the Teams connector — this is a display list, not a seat count.
    devices: devices.map((d) => {
      const name = deviceName(d);
      const isTeams = ext ? name === `${ext}t` : false;
      return { name, model: isTeams ? '' : str(d['device-models-model']) || '(unknown)', teams: isTeams };
    }),
    anyDevice: handsets.length > 0 || teams,
  };
}

/**
 * One record per non-blank `user`, first one wins. The same rule `attribution.ts` needs to join a
 * number's `dial-rule-translation-destination-user` (or an SMS number, or an address) back to the
 * user it belongs to — extracted here so there is exactly one copy of it in the library.
 */
export function usersByExt(users: Rec[]): Map<string, Rec> {
  const map = new Map<string, Rec>();
  for (const u of users) {
    const ext = str(u.user);
    if (ext && !map.has(ext)) map.set(ext, u);
  }
  return map;
}

/**
 * Where a phone number routes, in words a person reads at a glance — not the raw NetSapiens dial
 * rule fields. Pure; looks the destination user up in `userByExt` ({@link usersByExt}) so it can
 * name a real extension or a system object (`system-queue` → `queue`, `system-aa` → `aa`, and so
 * on) rather than just echoing back an extension number.
 *
 * - The destination names a REAL extension → `to user <ext> — <First Last>` (the name is omitted,
 *   dash and all, when both name fields are blank).
 * - The destination names a SYSTEM user (a queue, an attendant, a time-of-day router) →
 *   `to <kind> <ext> — <name>`, `kind` being the `service-code` with its `system-` prefix stripped
 *   (`queue`, `aa`, `tod`, the raw code for anything else, or `system` when stripping leaves
 *   nothing — a bare `system-` service code); name omitted the same way.
 * - The destination is set but names nobody NetSapiens knows about → `to <application> <dest>`
 *   (`dial-rule-application` with a leading `to-` stripped, so `to-user` reads as `user`; falls back
 *   to `user` itself when the application is blank), plus `@<host>` whenever
 *   `dial-rule-translation-destination-host` is non-empty — this module has no domain to compare it
 *   against, so any non-empty host is shown.
 * - No destination but an application is set → `to <application>` (`to-connection` → `to connection`,
 *   `to-voicemail` → `to voicemail`).
 * - Neither is set → `''`.
 *
 * A FAX LINE — a number whose destination host is one of `faxServerHosts` — short-circuits all of that
 * and reads `to fax server`, host omitted. Otherwise it would render as `to connection` (which names
 * plumbing, not a destination) or, on a rule that also carries a destination user, as a bare IP address
 * beside a customer's phone number. Nobody reading this line needs the fax server's address.
 */
export function destinationOf(p: Rec, userByExt: Map<string, Rec>, faxServerHosts?: readonly string[]): string {
  if (isFaxLine(p, faxHosts(faxServerHosts))) return 'to fax server';
  const dest = str(p['dial-rule-translation-destination-user']);
  const app = str(p['dial-rule-application']).replace(/^to-/i, '');
  const host = str(p['dial-rule-translation-destination-host']);

  if (dest) {
    const u = userByExt.get(dest);
    if (u) {
      const name = `${str(u['name-first-name'])} ${str(u['name-last-name'])}`.trim();
      if (isSystemUser(u)) {
        const kind = str(u['service-code']).replace(/^system-/i, '') || 'system';
        return name ? `to ${kind} ${dest} — ${name}` : `to ${kind} ${dest}`;
      }
      return name ? `to user ${dest} — ${name}` : `to user ${dest}`;
    }
    const hostPart = host ? `@${host}` : '';
    return `to ${app || 'user'} ${dest}${hostPart}`;
  }
  return app ? `to ${app}` : '';
}

/**
 * The items behind every count. Pure. Fields are copied by name from an allowlist; no record passes
 * through, so a device's MAC or SIP password cannot reach a consumer by accident.
 *
 * ## Item keys, and what happens when the identity field is blank
 *
 * Each item's `key` is `<kind>:<the record's own id>` — `ext:1000`, `did:13175550100`,
 * `addr:a-1`, `sms:13175550100`. NetSapiens will hand back a record whose id is blank, and a key of
 * `addr:` shared by two records is worse than no key: a consumer recording an acceptance against it
 * accepts both. So a blank id falls back to `<kind>:~<hash>`, an FNV-1a over whatever else names the
 * record — an address by its name, street line and city; an extension by scope, service code and
 * name; a number or SMS number by the (blank) number itself. No seed carries the array index, so a
 * re-fetch that reorders the list returns the same keys. Two blank records that agree on every
 * remaining field therefore land on ONE key rather than two: a number with no number is not a
 * countable thing, and one derived row is more honest than two that shuffle. A blank id is a
 * provisioning fault to fix; the fallback only keeps the distinguishable ones apart until it is.
 */
export function listDomainInventory(snapshot: Snapshot, opts?: InventoryOptions): DomainInventoryDetail {
  const users: Rec[] = Array.isArray(snapshot.users) ? snapshot.users : [];
  const devicesByUser: Record<string, Rec[]> = (snapshot.devicesByUser ?? {}) as Record<string, Rec[]>;
  const phonenumbers: Rec[] = Array.isArray(snapshot.phonenumbers) ? snapshot.phonenumbers : [];
  const addresses: Rec[] = Array.isArray(snapshot.addresses) ? snapshot.addresses : [];
  const smsnumbers: Rec[] = Array.isArray(snapshot.smsnumbers) ? snapshot.smsnumbers : [];

  const extensions: ExtensionItem[] = [];
  const systemUsers: ExtensionItem[] = [];
  for (let i = 0; i < users.length; i++) {
    const u = users[i]!;
    const ext = str(u.user);
    // A blank `user` is looked up too, rather than handed an empty device list. This library's own
    // `fetchDomainSnapshot` never files anything under `''` — it skips a blank extension before the
    // device read (see `nsClient.ts`) — so this lookup can only hit in a snapshot built elsewhere,
    // from a backup or a fixture. Dropping it would read as a clean match on a domain that has
    // handsets nobody can see; two blank users sharing one list overcount instead, which is a
    // visible drift an operator investigates, and that is the failure worth having.
    const item = extensionItem(u, devicesByUser[ext] ?? []);
    (isSystemUser(u) ? systemUsers : extensions).push(item);
  }
  const userByExt = usersByExt(users);
  // Normalised once, not per number: the host list is the caller's and does not change mid-fold.
  const hosts = faxHosts(opts?.faxServerHosts);
  const dids: NumberItem[] = phonenumbers.map((p) => {
    const number = str(p.phonenumber);
    const kind: 'local' | 'tollFree' = isTollFree(number) ? 'tollFree' : 'local';
    const fax = isFaxLine(p, hosts);
    // The KEY does not carry `fax`. It is a fact about how the number is routed today, and routing a
    // number to the fax server must not orphan every decision a consumer recorded against it.
    const destination = fax ? 'to fax server' : destinationOf(p, userByExt);
    const description = str(p['dial-rule-description']);
    return { key: identityKey('did', number, JSON.stringify({ number, kind })), number, kind, fax, destination, description };
  });
  const e911Addresses: AddressItem[] = addresses.map((a, i) => {
    const id = str(a['emergency-address-id']);
    const name = str(a['address-name']);
    const line1 = str(a['address-line-1']);
    const city = str(a['address-city']);
    const where = [line1, city].filter(Boolean).join(', ');
    const label = [name, where].filter(Boolean).join(' — ');
    return {
      key: identityKey('addr', id, `${name} ${line1} ${city}`),
      // An address with neither an id nor anything to name it by is still a row an operator has to
      // decide about, so it gets a positional label rather than an empty cell.
      label: label || id || `(address ${i + 1})`,
    };
  });
  const smsNumbers: SmsItem[] = smsnumbers.map((s) => {
    const number = str(s.number);
    return { key: identityKey('sms', number, JSON.stringify({ number })), number };
  });
  return { extensions, systemUsers, dids, e911Addresses, smsNumbers };
}

/** The counts, as a fold over {@link listDomainInventory} so the two can never disagree. */
export function countDomainInventory(snapshot: Snapshot, opts?: InventoryOptions): DomainInventory {
  return countInventoryDetail(listDomainInventory(snapshot, opts));
}

/**
 * Count an item list. Exposed separately so a consumer that has FILTERED the lists — to one site, to
 * one billing account — gets counts that agree with what it kept, rather than re-counting the snapshot.
 */
export function countInventoryDetail(d: DomainInventoryDetail): DomainInventory {
  const inv: DomainInventory = {
    extensions: { total: 0, byScope: {}, byServiceCode: {}, byDeviceCount: { '0': 0, '1': 0, '2': 0, '3+': 0 }, withAnyDevice: 0, withNoDevice: 0 },
    systemUsers: { total: d.systemUsers.length, byServiceCode: {} },
    transcriptionEnabled: 0,
    teamsConnected: 0,
    dids: { total: 0, tollFree: 0, local: 0, fax: 0, all: d.dids.length },
    e911Addresses: d.e911Addresses.length,
    smsNumbers: d.smsNumbers.length,
    devices: { total: 0, byModel: {} },
  };
  for (const s of d.systemUsers) bump(inv.systemUsers.byServiceCode, s.serviceCode);
  for (const x of d.extensions) {
    inv.extensions.total++;
    if (x.scope) bump(inv.extensions.byScope, x.scope);
    bump(inv.extensions.byServiceCode, x.serviceCode);
    if (x.transcription) inv.transcriptionEnabled++;
    if (x.teams) inv.teamsConnected++;
    if (x.anyDevice) inv.extensions.withAnyDevice++; else inv.extensions.withNoDevice++;
    const bucket = x.deviceCount >= 3 ? '3+' : (String(x.deviceCount) as '0' | '1' | '2');
    inv.extensions.byDeviceCount[bucket]++;
    inv.devices.total += x.deviceCount;
    for (const m of x.deviceModels) bump(inv.devices.byModel, m);
  }
  // A fax line is billed as a fax line, so it lands in `fax` and in NEITHER of the two DID buckets —
  // counting it as both would bill one number twice on a rulebook that has a rule for each. `fax` is
  // read off the item rather than recomputed: an item list a consumer FILTERED still carries it, and a
  // list built by a pre-0.7.0 lib has no `fax` at all, which reads as false and counts as it always did.
  for (const n of d.dids) {
    if (n.fax) { inv.dids.fax++; continue; }
    inv.dids.total++;
    if (n.kind === 'tollFree') inv.dids.tollFree++; else inv.dids.local++;
  }
  return inv;
}

/**
 * The items a `counts` path selects — the same vocabulary of dotted paths `countDomainInventory`
 * answers numbers for. `undefined` means that dimension has no item list (devices, system users, or a
 * path this module does not know), which is a different fact from an empty list.
 */
export function itemsFor(detail: DomainInventoryDetail, path: string): InventoryItem[] | undefined {
  const ex = detail.extensions;
  if (path === 'extensions.total') return ex;
  if (path.startsWith('extensions.byScope.')) { const v = path.slice('extensions.byScope.'.length); return ex.filter((x) => x.scope === v); }
  if (path.startsWith('extensions.byServiceCode.')) { const v = path.slice('extensions.byServiceCode.'.length); return ex.filter((x) => x.serviceCode === v); }
  if (path.startsWith('extensions.byDeviceCount.')) {
    const v = path.slice('extensions.byDeviceCount.'.length);
    return ex.filter((x) => (x.deviceCount >= 3 ? '3+' : String(x.deviceCount)) === v);
  }
  if (path === 'extensions.withAnyDevice') return ex.filter((x) => x.anyDevice);
  if (path === 'extensions.withNoDevice') return ex.filter((x) => !x.anyDevice);
  if (path === 'transcriptionEnabled') return ex.filter((x) => x.transcription);
  if (path === 'teamsConnected') return ex.filter((x) => x.teams);
  // The three DID paths exclude fax lines, exactly as the counts do — a `counts: "dids.total"` rule
  // whose observed number left the fax lines out but whose item list showed them would offer an
  // operator rows to accept that the number above them does not count.
  if (path === 'dids.total') return detail.dids.filter((n) => !n.fax);
  if (path === 'dids.tollFree') return detail.dids.filter((n) => !n.fax && n.kind === 'tollFree');
  if (path === 'dids.local') return detail.dids.filter((n) => !n.fax && n.kind === 'local');
  if (path === 'dids.fax') return detail.dids.filter((n) => n.fax);
  if (path === 'dids.all') return detail.dids;
  if (path === 'e911Addresses') return detail.e911Addresses;
  if (path === 'smsNumbers') return detail.smsNumbers;
  return undefined;
}

/** One line naming an item to a person: what an operator sees when they accept it, and what history keeps. */
export function itemLabel(item: InventoryItem): string {
  if ('ext' in item) {
    const who = [item.name, item.site].filter(Boolean).join(', ');
    return who ? `${item.ext} — ${who}` : item.ext;
  }
  if ('kind' in item) return item.kind === 'tollFree' ? `${item.number} (toll-free)` : item.number;
  if ('label' in item) return item.label;
  return item.number;
}
