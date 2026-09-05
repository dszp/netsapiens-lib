/**
 * Count a domain's inventory along the dimensions a VoIP operator actually sells on.
 *
 * Pure: it fetches nothing. Feed it a `Snapshot` — from `fetchDomainSnapshot`, a backup, or a
 * fixture — and it returns fixed, named counts and nothing else.
 *
 * ## Counts, and the lists behind them
 *
 * A device record from NetSapiens carries the SIP registration password. `listDomainInventory` builds
 * per-item lists — an extension's name and site, a number's kind, an address's label — from an
 * allowlist of named fields, and `countDomainInventory` is a fold over those same lists. Either way, a
 * device's MAC and SIP credentials never appear: nothing here returns a raw record, and nothing should
 * be added that does.
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
  };
  /** `system-aa`, `system-queue`, `system-tod` and any other `system-*` code. Informational. */
  systemUsers: { total: number; byServiceCode: Record<string, number> };
  /** Extensions whose `voicemail-transcription-enabled` is anything but empty or `no`. */
  transcriptionEnabled: number;
  /**
   * Extensions with a Microsoft Teams connector device — one whose SIP `aor` local part is the
   * extension number followed by `t` (`1000t`), which is how the TeamMate connector registers.
   * That device is NOT counted under `devices`: it is a connector, not a handset.
   */
  teamsConnected: number;
  /** Phone numbers on the domain, split by NANP toll-free prefix. */
  dids: { total: number; tollFree: number; local: number };
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
  /** `ext:<user>` — the stable identity a consumer records a decision against. */
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
}
export interface NumberItem { key: string /* did:<phonenumber> */; number: string; kind: 'local' | 'tollFree' }
export interface AddressItem { key: string /* addr:<emergency-address-id> */; label: string }
export interface SmsItem { key: string /* sms:<number> */; number: string }
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

/** NANP toll-free area codes, 800 through 888. A number outside this set is counted local. */
const TOLL_FREE = new Set(['800', '833', '844', '855', '866', '877', '888']);

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const bump = (into: Record<string, number>, key: string): void => { into[key] = (into[key] ?? 0) + 1; };

/** Is this user one of NetSapiens' internal routing objects rather than a seat? */
function isSystemUser(user: Rec): boolean {
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

/** The local part of a device's `aor` (`sip:103t@acme.example` → `103t`), read only to test for Teams. */
function aorLocal(device: Rec): string {
  const a = str(device.aor).replace(/^sip:/i, '');
  const at = a.indexOf('@');
  return at === -1 ? a : a.slice(0, at);
}

function extensionItem(u: Rec, devices: Rec[]): ExtensionItem {
  const ext = str(u.user);
  const handsets = devices.filter((d) => aorLocal(d) !== `${ext}t`);
  const transcription = str(u['voicemail-transcription-enabled']).toLowerCase();
  return {
    key: `ext:${ext}`,
    ext,
    name: `${str(u['name-first-name'])} ${str(u['name-last-name'])}`.trim(),
    site: str(u.site),
    scope: str(u['user-scope']),
    serviceCode: str(u['service-code']),
    transcription: transcription !== '' && transcription !== 'no',
    teams: handsets.length !== devices.length,
    deviceCount: handsets.length,
    // A device whose model is blank is listed under a named bucket rather than dropped: a missing
    // model is a provisioning gap worth seeing, and a silently smaller total hides it.
    deviceModels: handsets.map((d) => str(d['device-models-model']) || '(unknown)'),
  };
}

/**
 * The items behind every count. Pure. Fields are copied by name from an allowlist; no record passes
 * through, so a device's MAC or SIP password cannot reach a consumer by accident.
 */
export function listDomainInventory(snapshot: Snapshot): DomainInventoryDetail {
  const users: Rec[] = Array.isArray(snapshot.users) ? snapshot.users : [];
  const devicesByUser: Record<string, Rec[]> = (snapshot.devicesByUser ?? {}) as Record<string, Rec[]>;
  const phonenumbers: Rec[] = Array.isArray(snapshot.phonenumbers) ? snapshot.phonenumbers : [];
  const addresses: Rec[] = Array.isArray(snapshot.addresses) ? snapshot.addresses : [];
  const smsnumbers: Rec[] = Array.isArray(snapshot.smsnumbers) ? snapshot.smsnumbers : [];

  const extensions: ExtensionItem[] = [];
  const systemUsers: ExtensionItem[] = [];
  for (const u of users) {
    const ext = str(u.user);
    const item = extensionItem(u, ext ? (devicesByUser[ext] ?? []) : []);
    (isSystemUser(u) ? systemUsers : extensions).push(item);
  }
  const dids: NumberItem[] = phonenumbers.map((p) => {
    const number = str(p.phonenumber);
    return { key: `did:${number}`, number, kind: isTollFree(number) ? 'tollFree' : 'local' };
  });
  const e911Addresses: AddressItem[] = addresses.map((a) => {
    const id = str(a['emergency-address-id']);
    const name = str(a['address-name']);
    const where = [str(a['address-line-1']), str(a['address-city'])].filter(Boolean).join(', ');
    const label = [name, where].filter(Boolean).join(' — ');
    return { key: `addr:${id}`, label: label || id };
  });
  const smsNumbers: SmsItem[] = smsnumbers.map((s) => { const number = str(s.number); return { key: `sms:${number}`, number }; });
  return { extensions, systemUsers, dids, e911Addresses, smsNumbers };
}

/** The counts, as a fold over {@link listDomainInventory} so the two can never disagree. */
export function countDomainInventory(snapshot: Snapshot): DomainInventory {
  const d = listDomainInventory(snapshot);
  const inv: DomainInventory = {
    extensions: { total: 0, byScope: {}, byServiceCode: {}, byDeviceCount: { '0': 0, '1': 0, '2': 0, '3+': 0 } },
    systemUsers: { total: d.systemUsers.length, byServiceCode: {} },
    transcriptionEnabled: 0,
    teamsConnected: 0,
    dids: { total: d.dids.length, tollFree: 0, local: 0 },
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
    const bucket = x.deviceCount >= 3 ? '3+' : (String(x.deviceCount) as '0' | '1' | '2');
    inv.extensions.byDeviceCount[bucket]++;
    inv.devices.total += x.deviceCount;
    for (const m of x.deviceModels) bump(inv.devices.byModel, m);
  }
  for (const n of d.dids) { if (n.kind === 'tollFree') inv.dids.tollFree++; else inv.dids.local++; }
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
  if (path === 'transcriptionEnabled') return ex.filter((x) => x.transcription);
  if (path === 'teamsConnected') return ex.filter((x) => x.teams);
  if (path === 'dids.total') return detail.dids;
  if (path === 'dids.tollFree') return detail.dids.filter((n) => n.kind === 'tollFree');
  if (path === 'dids.local') return detail.dids.filter((n) => n.kind === 'local');
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
