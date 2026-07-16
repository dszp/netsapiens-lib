/**
 * Flow resolver — deterministic walker over a NetSapiens domain snapshot that emits a
 * normalized FlowGraph. Rule-set driven; no Node-only deps (runtime-portable).
 *
 * NetSapiens routing model, as decoded from real snapshots:
 *   - An inbound DID (phonenumber) has a `dial-rule-application` (to-user[-residential],
 *     to-callqueue, to-voicemail, to-connection) + a destination extension/host.
 *   - Every "extension" is a user record. Some users are virtual: a queue (in callqueues),
 *     an auto attendant (in autoattendants), a time-of-day router (TOD), or a shared mailbox.
 *   - A user's routing is its answer rules, one per time-frame, ordered by ordinal-priority:
 *       forward-always (unconditional) | simultaneous-ring/<OwnDevices> then
 *       forward-no-answer (RNA timeout) | forward-on-busy | forward-when-unregistered.
 *   - Answer-rule / dial-rule params speak an alias language:
 *       <did>_callqueue_<ext>, queue_<ext>        -> queue
 *       <did>_attendant_<ext>                     -> auto attendant
 *       user_<ext>                                -> user
 *       vmail_<ext> / <did>_voicemail_<ext>       -> voicemail box
 *       <did>_pstn_<num> / bare 10-11 digits      -> external / off-net
 *       Prompt_<id>                               -> played greeting
 *       <OwnDevices>                              -> ring the user's registered devices
 *   - A queue dispatches to its agents (dispatch-type) then overflows via its own answer
 *     rule (forward-no-answer -> if-unanswered, forward-on-busy -> if-unavailable).
 *   - Auto-attendant keypress menus are NOT in the backup (inventory-only) — flagged as a gap.
 */

import type { EdgeKind, FlowGraph, FlowNode, NodeKind, Rec, Snapshot } from './model.js';

export interface EntityRef {
  kind: 'did' | 'user' | 'queue' | 'attendant';
  ref: string;
}

const s = (v: unknown): string => (v === undefined || v === null ? '' : String(v)).trim();
const digits = (v: unknown): string => s(v).replace(/\D/g, '');
/** Normalize a phone number to its national form (strip a leading US "1"). */
const nat = (v: unknown): string => {
  const d = digits(v);
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
};
/** Truncate long greeting/script text for a node label (full text goes to a hover tooltip). */
const GREET_MAX = 90;
const trim = (v: string, max = GREET_MAX): string => (v.length > max ? `${v.slice(0, max - 1).trimEnd()}…` : v);

/**
 * Endpoint type by the agent-id / extension letter suffix (heuristic):
 *   wp → SNAPmobile Web (browser phone) · t → Microsoft Teams · m → SNAPmobile (mobile) ·
 *   r → mobile/desktop app · b / other lower letters → usually a desk phone.
 * Exact device info (model, MAC, transport) IS available via the device API but isn't pulled yet —
 * see ARCHITECTURE.md → NetSapiens routing model; this suffix guess is the cheap approximation.
 */
function deviceKindBySuffix(suffix: string): { icon: string; kind: string } {
  switch (suffix.toLowerCase()) {
    case 'wp':
      return { icon: '🌐', kind: 'web app' };
    case 't':
      return { icon: '💻', kind: 'Teams' };
    case 'm':
      return { icon: '📱', kind: 'mobile app' };
    case 'r':
      return { icon: '📱', kind: 'app' };
    case '':
      return { icon: '', kind: '' };
    default:
      return { icon: '📞', kind: 'desk phone' }; // b and other letters
  }
}

/** Compact agent queue-priority badge: "P" + a keycap digit (e.g. P2️⃣). Priority is a cross-queue
 *  tie-breaker that only matters when an agent is in several queues, so we render it ONLY for 2+ —
 *  0 is the blank/unset portal dropdown and 1 is the baseline "set" value, both left unlabeled. */
const PRIORITY_MIN_SHOWN = 2;
function priorityBadge(n: number): string {
  const keycap = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
  return `P${n >= 0 && n <= 9 ? keycap[n] : n}`;
}

/** Index of a snapshot for O(1) lookups by extension / number. */
class Index {
  usersByExt = new Map<string, Rec>();
  queuesByExt = new Map<string, Rec>();
  attendantsByExt = new Map<string, Rec>();
  agentsByQueue = new Map<string, Rec[]>();
  answerRules = new Map<string, Rec[]>();
  didByNat = new Map<string, Rec>();
  tfByName = new Map<string, Rec>();
  aaDetailByExt = new Map<string, Rec>();
  /** All AA detail records per ext (>1 = multi-timeframe deviation). */
  aaDetailsByExt = new Map<string, Rec[]>();
  /** Per-AA dialplan dialrules (the authoritative menu/default routing). */
  aaDialrulesByExt = new Map<string, Rec[]>();
  /** Domain dial-rule aliases: `dial-rule-matching-to-uri` → the rule (application + destination).
   *  Lets us follow custom-named aliases like `aa_church_open` / `AAMain` that aren't in the
   *  auto-generated `<treatment>_<ext>` grammar. */
  dialruleByUri = new Map<string, Rec>();

  constructor(private snap: Snapshot) {
    for (const u of snap.users ?? []) this.usersByExt.set(s(u.user), u);
    for (const q of snap.callqueues ?? []) this.queuesByExt.set(s(q.callqueue), q);
    for (const a of snap.autoattendants ?? []) this.attendantsByExt.set(s(a.user), a);
    for (const [q, ags] of Object.entries(snap.agentsByQueue ?? {})) this.agentsByQueue.set(s(q), ags);
    for (const [u, rs] of Object.entries(snap.answerrulesByUser ?? {})) this.answerRules.set(s(u), rs);
    for (const p of snap.phonenumbers ?? []) this.didByNat.set(nat(p.phonenumber), p);
    for (const t of snap.timeframes ?? []) this.tfByName.set(s(t['timeframe-name']), t);
    // AA details from either shape: attendantDetailsByUser (array; enriched backup) or
    // attendantDetails (single; live). Primary = the `*`/Default-timeframe record, else the first.
    const aaSets: Record<string, Rec[]> = {};
    for (const [ext, arr] of Object.entries(snap.attendantDetailsByUser ?? {})) aaSets[s(ext)] = Array.isArray(arr) ? arr : [arr];
    for (const [ext, d] of Object.entries(snap.attendantDetails ?? {})) if (!aaSets[s(ext)]) aaSets[s(ext)] = [d];
    for (const [ext, arr] of Object.entries(aaSets)) {
      this.aaDetailsByExt.set(ext, arr);
      const primary = arr.find((d) => { const tf = s(d['time-frame']); return tf === '' || tf === '*'; }) ?? arr[0];
      if (primary) this.aaDetailByExt.set(ext, primary);
    }
    for (const [plan, rules] of Object.entries(snap.dialrulesByPlan ?? {})) {
      for (const r of rules) {
        const uri = s(r['dial-rule-matching-to-uri']);
        if (uri && !this.dialruleByUri.has(uri)) this.dialruleByUri.set(uri, r);
      }
      // An AA's own dialplan is keyed `<domain>_<ext>` and holds the AUTHORITATIVE menu (star /
      // no-key / dial-by-ext) the /autoattendants detail omits. Derive aaDialrulesByExt from it so
      // backups that store AA dialrules here (not in attendantDialrulesByExt) still render the full menu.
      const m = plan.match(/_(\d{2,6})$/);
      if (m) {
        const aaRules = rules.filter((r) => /^Prompt_/i.test(s(r['dial-rule-matching-to-uri'])));
        if (aaRules.length && !this.aaDialrulesByExt.has(s(m[1]!))) this.aaDialrulesByExt.set(s(m[1]!), aaRules);
      }
    }
    // Enriched-backup source (if present) is canonical — it overrides the dialrulesByPlan-derived set.
    for (const [ext, rules] of Object.entries(snap.attendantDialrulesByExt ?? {})) this.aaDialrulesByExt.set(s(ext), rules);
  }

  /** What IS this extension? Order matters: attendant/queue before plain user. */
  classifyExt(ext: string): NodeKind {
    const e = s(ext);
    if (this.attendantsByExt.has(e)) return 'attendant';
    if (this.queuesByExt.has(e)) return 'queue';
    if (this.usersByExt.has(e)) return 'user';
    if (digits(e).length >= 10) return 'external';
    return 'unknown';
  }

  userName(ext: string): string {
    const u = this.usersByExt.get(s(ext));
    if (!u) return s(ext);
    const n = `${s(u['name-first-name'])} ${s(u['name-last-name'])}`.trim();
    return n || s(ext);
  }

  /** Call-queue display name (its `description`), or '' if unknown. */
  queueName(ext: string): string {
    const q = this.queuesByExt.get(s(ext));
    return q ? s(q.description) : '';
  }

  /** Auto-attendant display name (`attendant-name`), or '' if unknown. */
  attendantName(ext: string): string {
    const a = this.attendantsByExt.get(s(ext));
    return a ? s(a['attendant-name']) : '';
  }
}

/** A single answer-rule condition block: { enabled, parameters }. */
function firstParam(block: any): string | null {
  if (!block || s(block.enabled) !== 'yes') return null;
  const p = block.parameters;
  if (!Array.isArray(p) || !p.length) return null;
  const v = s(p[0]);
  return v || null;
}

interface Target {
  kind: NodeKind;
  ext?: string;
  number?: string;
  promptId?: string;
  ownDevices?: boolean;
}

const TREATMENT: Record<string, NodeKind> = {
  attendant: 'attendant',
  user: 'user',
  callqueue: 'queue',
  queue: 'queue',
  voicemail: 'voicemail',
  vmail: 'voicemail',
  pstn: 'external',
};

/** Classify an answer-rule / dial-rule parameter into a routing target. */
function classifyParam(raw: string, idx: Index): Target {
  const p = s(raw);
  if (!p) return { kind: 'hangup' };
  if (/^<OwnDevices>$/i.test(p)) return { kind: 'devices', ownDevices: true };
  if (/^Prompt_/i.test(p)) return { kind: 'prompt', promptId: p };

  // <did>_<treatment>_<dest>  e.g. 13175550100_callqueue_9100
  let m = p.match(/^\d+_(attendant|user|callqueue|voicemail|pstn)_(.+)$/i);
  if (m) return mapTreatment(m[1]!, m[2]!);

  // <treatment>_<dest>  e.g. queue_9100, user_500, vmail_500
  m = p.match(/^(attendant|user|callqueue|queue|voicemail|vmail|pstn)_(.+)$/i);
  if (m) return mapTreatment(m[1]!, m[2]!);

  // bare numeric — resolve by what the extension IS
  if (/^\+?\d+$/.test(p)) {
    const kind = idx.classifyExt(digits(p));
    if (kind === 'external' || kind === 'unknown') return { kind: 'external', number: digits(p) };
    return { kind, ext: digits(p) };
  }
  // custom dial-plan alias (e.g. aa_church_open, AAMain) → follow the dialrule to its real target
  const dr = idx.dialruleByUri.get(p);
  if (dr) return dialruleTarget(dr, idx);
  return { kind: 'unknown', ext: p };
}

function mapTreatment(word: string, dest: string): Target {
  const kind = TREATMENT[word.toLowerCase()] ?? 'user';
  return kind === 'external' ? { kind, number: digits(dest) } : { kind, ext: digits(dest) || s(dest) };
}

/** Resolve a matched dial-rule alias to a routing target by its application + destination. */
function dialruleTarget(dr: Rec, idx: Index): Target {
  const app = s(dr['dial-rule-application']).toLowerCase();
  const dest = s(dr['dial-rule-translation-destination-user']);
  if (app.startsWith('to-callqueue')) return { kind: 'queue', ext: dest };
  if (app.startsWith('to-voicemail')) return { kind: 'voicemail', ext: dest };
  if (app.startsWith('to-connection')) return { kind: 'external', number: digits(dest) || dest };
  if (app.startsWith('to-user') || app.startsWith('to-single-device')) {
    const kind = idx.classifyExt(dest);
    if (kind === 'attendant') return { kind: 'attendant', ext: dest };
    if (kind === 'queue') return { kind: 'queue', ext: dest };
    return { kind: 'user', ext: dest };
  }
  if (app.startsWith('hangup')) return { kind: 'hangup' };
  return { kind: 'unknown', ext: s(dr['dial-rule-matching-to-uri']) || dest };
}

// ---------------------------------------------------------------------------
// Graph builder
// ---------------------------------------------------------------------------

class Builder {
  nodes = new Map<string, FlowNode>();
  edges: FlowGraph['edges'] = [];
  notes: string[] = [];
  private expanded = new Set<string>();

  node(id: string, kind: NodeKind, label: string, sub?: string, lines?: string[], title?: string): { id: string; isNew: boolean } {
    if (this.nodes.has(id)) return { id, isNew: false };
    this.nodes.set(id, { id, kind, label, ...(sub ? { sub } : {}), ...(lines && lines.length ? { lines } : {}), ...(title ? { title } : {}) });
    return { id, isNew: true };
  }
  edge(from: string, to: string, kind: EdgeKind, label?: string) {
    // Back-edge to an ANCESTOR (a cycle — e.g. an AA option that returns to the queue that feeds it):
    // draw a compact reference leaf instead of an edge that loops back UP to the ancestor. Layout
    // engines (ELK especially) route such up-edges confusingly, so the fallback reads as a detached
    // branch. The real node still shows in full where it was first expanded; this leaf just names it.
    if (kind !== 'ref' && to !== from && this.onPath(to)) {
      const rid = `ref_${to}__${from}`;
      if (!this.nodes.has(rid)) this.nodes.set(rid, { id: rid, kind: this.kindOf(to), label: `↩ ${this.labelOf(to)}`, sub: 'loops back ↑' });
      this.edges.push({ from, to: rid, kind: 'ref', ...(label ? { label } : {}) });
      return;
    }
    this.edges.push({ from, to, kind, ...(label ? { label } : {}) });
  }
  note(n: string) {
    if (!this.notes.includes(n)) this.notes.push(n);
  }
  /** Returns true the first time a node is expanded; false thereafter (cycle guard). */
  claim(id: string): boolean {
    if (this.expanded.has(id)) return false;
    this.expanded.add(id);
    return true;
  }

  // Current DFS expansion path (root → … → node being expanded). enter() after a successful
  // claim(), leave() at every return. onPath() lets routing detect a back-edge to an ANCESTOR
  // (a cycle) so it can draw a compact reference leaf instead of an edge that loops back up.
  //
  // TODO (loop safety — real but rare; NOT yet fully guaranteed): cross-object cyclic references can
  // form legitimately — e.g. an AA option jumps to another TOD/AA which (if configured) jumps back to
  // an AA earlier in the flow. Ancestor detection above prevents infinite recursion ONLY IF every
  // expandable kind on the path calls enter()/leave() (AA, queue, user do; audit that the TOD/timeframe
  // router and any future expandable kind do too — otherwise an untracked hop could recurse forever).
  // Add defense-in-depth so this can never hang regardless: a global per-object expansion cap (expand
  // any given target at most once, then emit a reference leaf) and/or a max-depth bound. The shape to
  // worry about has been seen in the wild: a DID lands on an AA whose menu option routes into a
  // time-of-day router that fans out to a second flow. That resolves correctly today, but nothing stops
  // an admin adding a back-link from the second flow to the first AA — a cycle through a hop that does
  // not currently enter()/leave().
  private path: string[] = [];
  enter(id: string): void {
    this.path.push(id);
  }
  leave<T>(v: T): T {
    this.path.pop();
    return v;
  }
  onPath(id: string): boolean {
    return this.path.includes(id);
  }
  labelOf(id: string): string {
    return this.nodes.get(id)?.label ?? id;
  }
  kindOf(id: string): NodeKind {
    return this.nodes.get(id)?.kind ?? 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Schedule summarizing
// ---------------------------------------------------------------------------

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtTime(hhmm: string): string {
  const t = s(hhmm).replace(':', '');
  if (!/^\d{3,4}$/.test(t)) return s(hhmm);
  let h = parseInt(t.slice(0, t.length - 2), 10);
  const m = t.slice(-2);
  const ap = h >= 12 ? 'p' : 'a';
  h = h % 12 || 12;
  return m === '00' ? `${h}${ap}` : `${h}:${m}${ap}`;
}

function compressDays(nums: number[]): string {
  const uniq = [...new Set(nums)].sort((a, b) => a - b);
  if (!uniq.length) return '';
  const parts: string[] = [];
  let start = uniq[0]!;
  let prev = uniq[0]!;
  for (let i = 1; i <= uniq.length; i++) {
    const cur = uniq[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    parts.push(start === prev ? DOW[start]! : `${DOW[start]}–${DOW[prev]}`);
    if (cur !== undefined) start = prev = cur;
  }
  return parts.join(', ');
}

/** Summarize an answer-rule's time_range_data into e.g. "Mon–Fri 8a–4:29p". */
function scheduleLabel(rule: Rec, tfName: string): string {
  const rows = Array.isArray(rule.time_range_data) ? rule.time_range_data : [];
  if (rows.length) {
    // group by (start,end) window
    const byWin = new Map<string, number[]>();
    for (const r of rows) {
      const start = s(r['start-time']);
      const end = s(r['end-time']);
      const dow = Number(r['day-of-week-number']);
      const key = `${start}-${end}`;
      if (!byWin.has(key)) byWin.set(key, []);
      if (Number.isFinite(dow)) byWin.get(key)!.push(dow % 7);
    }
    const segs = [...byWin.entries()].map(([win, days]) => {
      const [start, end] = win.split('-');
      return `${compressDays(days)} ${fmtTime(start!)}–${fmtTime(end!)}`.trim();
    });
    // Header line (timeframe name) + bulleted, left-aligned schedule segments — even for a single
    // window. The emitter turns `\n` into line breaks and left-aligns edge labels.
    if (segs.length) return `${tfName}:\n${segs.map((x) => `• ${x}`).join('\n')}`;
  }
  return tfName;
}

/** Format a domain timeframe by NAME (for labels that only have the name, e.g. AA intro greetings) —
 *  same "name:\n• <days times>" style as scheduleLabel, read from the domain timeframe's weekly
 *  schedule. Falls back to the bare name for non-weekly timeframes (holiday / specific-dates). */
function timeframeSchedule(tfName: string, idx: Index): string {
  const tf = idx.tfByName.get(tfName);
  const rows = tf && Array.isArray(tf['timeframe-days-of-week-array']) ? (tf['timeframe-days-of-week-array'] as Rec[]) : [];
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const byWin = new Map<string, number[]>();
  for (const row of rows) {
    days.forEach((d, i) => {
      for (const slot of ['1', '2']) {
        const begin = s(row[`timeframe-weekly-${d}-begin-time-${slot}`]);
        const end = s(row[`timeframe-weekly-${d}-end-time-${slot}`]);
        if (begin && end) {
          if (!byWin.has(`${begin}-${end}`)) byWin.set(`${begin}-${end}`, []);
          byWin.get(`${begin}-${end}`)!.push(i);
        }
      }
    });
  }
  const segs = [...byWin.entries()].map(([win, dayIdx]) => {
    const [begin, end] = win.split('-');
    return `${compressDays([...new Set(dayIdx)])} ${fmtTime(begin!)}–${fmtTime(end!)}`.trim();
  });
  if (segs.length) return `${tfName}:\n${segs.map((x) => `• ${x}`).join('\n')}`;

  // specific-dates (holidays) — format each date / date-range (with times if not all-day).
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDate = (d: string) => (/^\d{8}$/.test(d) ? `${M[+d.slice(4, 6) - 1]} ${+d.slice(6, 8)}, ${d.slice(0, 4)}` : d);
  const dateSegs = (Array.isArray(tf?.['timeframe-specific-dates-array']) ? (tf!['timeframe-specific-dates-array'] as Rec[]) : [])
    .map((r) => {
      const bd = s(r['timeframe-specific-dates-begin-date']);
      if (!bd) return '';
      const ed = s(r['timeframe-specific-dates-end-date']);
      const bt = s(r['timeframe-specific-dates-begin-time']);
      const et = s(r['timeframe-specific-dates-end-time']);
      let seg = fmtDate(bd) + (ed && ed !== bd ? `–${fmtDate(ed)}` : '');
      if ((bt && bt !== '0000') || (et && et !== '0000' && et !== '2359')) seg += ` ${fmtTime(bt)}–${fmtTime(et)}`;
      return seg;
    })
    .filter(Boolean);
  return dateSegs.length ? `${tfName}:\n${dateSegs.map((x) => `• ${x}`).join('\n')}` : tfName;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

export function resolveFlow(snap: Snapshot, entity: EntityRef): FlowGraph {
  const idx = new Index(snap);
  const b = new Builder();
  const domain = s(snap.meta?.domain) || s(snap.domain?.domain);

  let rootId: string;
  let entityLabel: string;

  switch (entity.kind) {
    case 'did': {
      const r = resolveDid(entity.ref, idx, b);
      rootId = r.id;
      entityLabel = r.label;
      break;
    }
    case 'queue': {
      const id = ensureQueue(entity.ref, idx, b);
      rootId = id;
      const qn = idx.queueName(entity.ref);
      entityLabel = qn ? `Queue ${entity.ref} (${qn})` : `Queue ${entity.ref}`;
      break;
    }
    case 'attendant': {
      const id = ensureAttendant(entity.ref, idx, b);
      rootId = id;
      const an = idx.attendantName(entity.ref);
      entityLabel = an ? `Auto Attendant ${entity.ref} (${an})` : `Auto Attendant ${entity.ref}`;
      break;
    }
    default: {
      const id = ensureExt(entity.ref, idx, b);
      rootId = id;
      entityLabel = `${idx.userName(entity.ref)} (${entity.ref})`;
    }
  }

  return {
    entity: { kind: entity.kind, ref: entity.ref, label: entityLabel },
    domain,
    rootId,
    nodes: [...b.nodes.values()],
    edges: b.edges,
    notes: b.notes,
  };
}

function resolveDid(ref: string, idx: Index, b: Builder): { id: string; label: string } {
  const p = idx.didByNat.get(nat(ref));
  const num = nat(ref);
  const pretty = prettyPhone(num);
  const id = `did_${num}`;
  const desc = p ? s(p['dial-rule-description']) : '';
  b.node(id, 'did', `📞 ${pretty}`, desc || 'inbound DID');
  if (!p) {
    b.note(`DID ${ref} not found in snapshot.`);
    return { id, label: pretty };
  }
  const app = s(p['dial-rule-application']);
  const destUser = s(p['dial-rule-translation-destination-user']);
  const destHost = s(p['dial-rule-translation-destination-host']);
  if (s(p.enabled) !== 'yes') b.note(`DID ${pretty} is disabled.`);

  if (/^to-connection/i.test(app)) {
    const t = b.node(`trunk_${destHost || destUser}`, 'trunk', `🔌 ${destHost || 'SIP connection'}`, desc || 'connection / trunk');
    b.edge(id, t.id, 'route', 'to connection');
  } else if (/^to-callqueue/i.test(app)) {
    b.edge(id, ensureQueue(destUser, idx, b), 'route');
  } else if (/^to-voicemail/i.test(app)) {
    b.edge(id, ensureVoicemail(destUser, idx, b), 'route');
  } else if (/^to-user/i.test(app)) {
    b.edge(id, ensureExt(destUser, idx, b), 'route');
  } else if (/^available-number/i.test(app)) {
    // "available-number" is a number parked in the available/unassigned pool — a legitimate dead-end,
    // not an unmodeled gap. Render it as the terminal it is (no "not modeled" warning).
    const t = b.node(`app_${id}`, 'unknown', 'available number', destUser || destHost || 'unassigned');
    b.edge(id, t.id, 'route', 'unassigned');
  } else {
    const t = b.node(`app_${id}`, 'unknown', app || 'unknown routing', destUser || destHost);
    b.edge(id, t.id, 'route');
    b.note(`DID ${pretty} uses application "${app}" — not modeled.`);
  }
  return { id, label: pretty };
}

/** Ensure a node for an extension and expand its routing. Dispatches by what it IS. */
function ensureExt(ext: string, idx: Index, b: Builder): string {
  const kind = idx.classifyExt(ext);
  if (kind === 'attendant') return ensureAttendant(ext, idx, b);
  if (kind === 'queue') return ensureQueue(ext, idx, b);
  if (kind === 'external' || kind === 'unknown') {
    return ensureExternal(digits(ext) || ext, b);
  }
  return ensureUser(ext, idx, b);
}

function ensureUser(ext: string, idx: Index, b: Builder): string {
  const id = `user_${ext}`;
  const u = idx.usersByExt.get(s(ext));
  const name = idx.userName(ext);
  b.node(id, 'user', `👤 ${name}`, `ext ${ext}`);
  if (!b.claim(id)) return id;
  b.enter(id);
  if (!u) {
    b.note(`Extension ${ext} referenced but not in snapshot.`);
    return b.leave(id);
  }
  const rules = (idx.answerRules.get(s(ext)) ?? []).filter((r) => s(r.enabled) === 'yes');
  if (!rules.length) {
    ringThenVoicemail(id, ext, idx, b, null, 'route');
    return b.leave(id);
  }
  if (rules.length === 1) {
    resolveRule(id, ext, rules[0]!, idx, b, 'route', null);
    return b.leave(id);
  }
  // multiple time-frames -> a time-of-day decision
  const tf = b.node(`tf_${ext}`, 'timeframe', '🕒 Time of day?').id;
  b.edge(id, tf, 'route');
  const sorted = [...rules].sort((a, c) => Number(a['ordinal-priority'] ?? 99) - Number(c['ordinal-priority'] ?? 99));
  for (const r of sorted) {
    const name2 = s(r['time-frame']);
    const label = !name2 || name2 === '*' ? 'otherwise' : scheduleLabel(r, name2);
    resolveRule(tf, ext, r, idx, b, 'time', label);
  }
  return b.leave(id);
}

/** Resolve one answer rule from `fromId`. */
function resolveRule(fromId: string, ext: string, rule: Rec, idx: Index, b: Builder, edgeKind: EdgeKind, edgeLabel: string | null) {
  const fa = firstParam(rule['forward-always']);
  if (fa) {
    routeParam(fa, fromId, idx, b, edgeKind === 'time' ? 'time' : 'always', edgeLabel ?? 'always');
    return;
  }
  if (rule['do-not-disturb'] && s(rule['do-not-disturb'].enabled) === 'yes') {
    b.edge(fromId, ensureVoicemail(ext, idx, b), 'dnd', 'DND');
    return;
  }
  ringThenVoicemail(fromId, ext, idx, b, rule, edgeKind, edgeLabel);
}

/** Ring the user's devices (optionally sim-ring extra exts) then apply no-answer/busy. */
function ringThenVoicemail(fromId: string, ext: string, idx: Index, b: Builder, rule: Rec | null, edgeKind: EdgeKind, edgeLabel: string | null = null) {
  const u = idx.usersByExt.get(s(ext));
  const rna = u ? s(u['ring-no-answer-timeout-seconds']) : '';
  const name = idx.userName(ext);

  // What this rule rings: the user's own registered devices (<OwnDevices> or the bare self ext) plus
  // any specific extra target — a mobile/Teams/app registration (…m/…t/…r) or another user. Note a
  // `2152m` is NOT the same as `2152` (it's the mobile app), so don't fold it into "self".
  // `<OwnDevices>` rings ALL the user's registrations (incl. mobile/desktop apps); the bare self ext
  // rings only the extension's primary — a real difference (e.g. time_open uses <OwnDevices> so the
  // mobile app rings, the default rings the ext only). Track them separately.
  let ownDevices = false;
  let selfExt = false;
  const extra: { v: string; line: string }[] = [];
  const sr = rule?.['simultaneous-ring'];
  if (sr && s(sr.enabled) === 'yes' && Array.isArray(sr.parameters)) {
    for (const p of sr.parameters) {
      const v = s(p);
      if (!v) continue;
      if (/^<OwnDevices>$/i.test(v)) {
        ownDevices = true;
        continue;
      }
      if (v === s(ext)) {
        selfExt = true;
        continue;
      }
      const suf = (v.match(/[a-z]+$/i)?.[0] ?? '').toLowerCase();
      const base = digits(v) || v;
      const dk = deviceKindBySuffix(suf);
      const iconChar = suf ? dk.icon : '👤'; // a bare other-ext is another user
      extra.push({ v, line: `${iconChar} ${base === s(ext) && dk.kind ? dk.kind : idx.userName(base) || v} (${v})` });
    }
  } else {
    selfExt = true; // no explicit sim-ring config → rings the user's extension
  }
  // Distinct node per ring-set, so timeframes that ring different sets (e.g. ext-only vs all devices)
  // render as separate nodes instead of collapsing into one.
  const ringKey = `${selfExt ? 'self_' : ''}${ownDevices ? 'own_' : ''}${extra.map((e) => e.v).sort().join('_')}` || 'x';
  const devId = `dev_${ext}_${ringKey}`;
  // Labels match the portal "Simultaneous ring" checkboxes.
  const devLines = [...(selfExt ? [`📞 user's extension (${ext})`] : []), ...(ownDevices ? [`📱 all user's phones`] : []), ...extra.map((e) => e.line)];
  b.node(devId, 'devices', `🔔 Ring ${name}`, rna ? `${rna}s` : undefined, devLines);
  b.edge(fromId, devId, edgeKind, edgeLabel ?? undefined);

  const na = rule ? firstParam(rule['forward-no-answer']) : null;
  if (na) {
    routeParam(na, devId, idx, b, 'noanswer', rna ? `no answer ${rna}s` : 'no answer');
  } else if (!u || s(u['voicemail-enabled']) !== 'no') {
    b.edge(devId, ensureVoicemail(ext, idx, b), 'noanswer', rna ? `no answer ${rna}s` : 'no answer');
  } else {
    b.edge(devId, b.node(`hangup_${ext}`, 'hangup', '☎️ No route').id, 'noanswer');
  }

  const busy = rule ? firstParam(rule['forward-on-busy']) : null;
  if (busy) routeParam(busy, devId, idx, b, 'busy', 'busy');
  const unreg = rule ? firstParam(rule['forward-when-unregistered']) : null;
  if (unreg && unreg !== busy) routeParam(unreg, devId, idx, b, 'unreg', 'unregistered');
}

function ensureQueue(ext: string, idx: Index, b: Builder): string {
  const id = `queue_${ext}`;
  const q = idx.queuesByExt.get(s(ext));
  const desc = q ? s(q.description) : '';
  const dispatch = q ? s(q['callqueue-dispatch-type']) : '';
  const agents = idx.agentsByQueue.get(s(ext)) ?? [];
  // A queue with no agents (or dispatch-type "-") is a call PARK: callers wait in an orbit and are
  // retrieved by dialing the park number (= this ext). Show it as a park, not an agent-less queue.
  const isPark = agents.length === 0 || dispatch === '-';

  // Cross-queue agent priority (lower number = higher; 0 = the blank/unset portal dropdown).
  // Computed once so it's shown at the queue node when uniform+set, and per-agent otherwise.
  const qPrios = agents.map((a) => Number(a['callqueue-agent-dispatch-queue-priority-ordinal'] ?? 0));
  const uniformPrio = new Set(qPrios).size === 1 ? qPrios[0]! : 0;

  if (isPark) {
    b.node(id, 'queue', `🅿️ Call Park ${ext}${desc ? ` · ${desc}` : ''}`, `dial ${ext} to retrieve`);
  } else {
    // "In Queue Options": queue ring timeout (on the queue's user record), agent ring timeout, and
    // for linear/cascade/hunt the initial agent group + group-to-add-per-round.
    const qUser = idx.usersByExt.get(s(ext));
    const queueRing = qUser ? s(qUser['ring-no-answer-timeout-seconds']) : '';
    const agentRing = q ? s(q['callqueue-agent-dispatch-timeout-seconds']) : '';
    const qLines: string[] = [];
    if (queueRing || agentRing) qLines.push(`⏱ queue ring ${queueRing || '∞'}s · agent ring ${agentRing || '?'}s`);
    if (/linear|cascade|hunt/i.test(dispatch)) {
      const first = q ? s(q['callqueue-sim-ring-1st-round']) : '';
      const inc = q ? s(q['callqueue-sim-ring-increment']) : '';
      if (first || inc) qLines.push(`initial group ${first || '1'} · +${inc || '0'} per agent-timeout`);
    }
    // Surface the shared queue priority ONCE when the whole queue is uniform at a notable value (2+);
    // a compact badge keeps it out of the way for the common single-queue / baseline case.
    if (uniformPrio >= PRIORITY_MIN_SHOWN) qLines.push(`⭐ queue priority ${priorityBadge(uniformPrio)}`);
    b.node(id, 'queue', `📋 Queue ${ext}${desc ? ` · ${desc}` : ''}`, dispatch || 'call queue', qLines);
  }
  if (!b.claim(id)) return id;
  b.enter(id);

  if (!isPark) {
    const parsed = agents.map((a) => {
      const aid = s(a['callqueue-agent-id']).replace(/^sip:/, '').split('@')[0]!;
      const base = aid.replace(/[a-z]+$/i, ''); // strip device suffix (e.g. 102r → 102) for name lookup
      const name = s(a['name-full-name']) || idx.userName(base) || aid;
      const type = s(a['callqueue-agent-entry-type']) || 'user'; // user | device
      const manual = s(a['callqueue-agent-availability-type']) === 'manual';
      // Ring ORDER = the Linear Cascade round ("Order in Linear Hunt"). Read `ordinal-order`
      // (live GET) or the manifest write-key `callqueue-agent-dispatch-order-ordinal` (preview).
      // This is the cascade tiering — NOT the cross-queue priority ordinal (shown at queue level).
      const order = Number(a['ordinal-order'] ?? a['callqueue-agent-dispatch-order-ordinal'] ?? 0);
      const priority = Number(a['callqueue-agent-dispatch-queue-priority-ordinal'] ?? 0);
      return { aid, name, type, manual, order, priority };
    });
    // Per-agent priority badge (P2️⃣, P3️⃣…) only for notable values (2+) and only when it isn't
    // already summarized once at the queue node (uniformPrio). Blank (0) / baseline (1) render
    // nothing — priority rarely matters unless an agent spans multiple queues.
    const showPerAgentPrio = !uniformPrio;
    // A USER-type entry → 👤 (rings per the user's own answering rules & devices). A DEVICE entry rings
    // JUST that device regardless of the user's rules → icon by suffix (wp→🌐 web, t→💻 Teams, m/r→📱
    // app), defaulting to 📞 a desk phone for a plain/unknown device.
    const icon = (p: (typeof parsed)[number]) => {
      if (p.type === 'user') return '👤';
      return deviceKindBySuffix((p.aid.match(/[a-z]+$/i)?.[0] ?? '').toLowerCase()).icon || '📞';
    };
    const fmt = (p: (typeof parsed)[number]) =>
      `${icon(p)} ${p.name} (${p.aid})${p.manual ? ' · manual' : ''}${showPerAgentPrio && p.priority >= PRIORITY_MIN_SHOWN ? ` · ${priorityBadge(p.priority)}` : ''}`;
    // Linear/cascade/hunt queues ring tier by tier — group by RING ORDER (the cascade rounds),
    // NOT the cross-queue priority. `ordinal-order` is already 1-based (round 1 = order 1); keep
    // gaps verbatim. Blank line above every tier (incl. the first) for consistent spacing.
    const tiered = /linear|cascade|hunt/i.test(dispatch) && new Set(parsed.map((p) => p.order)).size > 1;
    let lines: string[];
    if (tiered) {
      lines = [];
      [...new Set(parsed.map((p) => p.order))]
        .sort((a, c) => a - c)
        .forEach((t) => {
          lines.push('');
          lines.push(`Tier ${t}:`);
          for (const p of parsed.filter((p) => p.order === t)) lines.push(`  ${fmt(p)}`);
        });
    } else {
      lines = parsed.map((p) => fmt(p));
    }
    const ag = b.node(`agents_${ext}`, 'agents', `👥 ${parsed.length} agent${parsed.length > 1 ? 's' : ''}`, undefined, lines).id;
    b.edge(id, ag, 'dispatch', dispatch || 'dispatch');
  }

  // Overflow via the queue's own answer rule. Emanate it from the AGENTS node (not the queue) so it
  // reads as the post-ring fallback ("agents didn't answer → …"). Park queues have no agents node, so
  // fall back to the queue node itself.
  const overflowFrom = isPark ? id : `agents_${ext}`;
  const rule = (idx.answerRules.get(s(ext)) ?? [])[0];
  const na = rule ? firstParam(rule['forward-no-answer']) : null;
  if (na) {
    routeParam(na, overflowFrom, idx, b, 'overflow', 'no answer / timeout');
  } else if (!isPark) {
    // No forward-no-answer target = the portal's "If unanswered → Stay in queue": on the queue-ring
    // timeout the caller is NOT dropped to voicemail — they stay queued and the agents ring again.
    // Draw it explicitly (a back-edge to the queue, which renders as a "↩ loops back" leaf) so the
    // unanswered disposition is as visible as the if-unavailable one instead of silently vanishing.
    b.edge(overflowFrom, id, 'overflow', 'if unanswered · stays in queue');
  }
  const busy = rule ? firstParam(rule['forward-on-busy']) : null;
  if (busy) routeParam(busy, overflowFrom, idx, b, 'overflow', 'if unavailable');
  const unreg = rule ? firstParam(rule['forward-when-unregistered']) : null;
  if (unreg && unreg !== busy) routeParam(unreg, overflowFrom, idx, b, 'overflow', 'if unavailable');
  return b.leave(id);
}

/** destination-application (AA option / dial rule) -> a routing target. */
function aaApp(app: string, dest: string, idx: Index, b: Builder): string {
  if (/^to-callqueue/i.test(app)) return ensureQueue(dest, idx, b);
  if (/^to-voicemail/i.test(app)) return ensureVoicemail(dest, idx, b);
  if (/^to-connection/i.test(app)) return ensureExternal(digits(dest) || dest, b);
  if (/^to-user|^to-single-device/i.test(app)) return ensureExt(dest, idx, b);
  if (/directory/i.test(app)) return b.node('directory', 'user', '📇 Dial-by-name directory', 'sip:start@directory').id;
  if (/^hangup/i.test(app)) return b.node(`hangup_aa_${dest || app}`, 'hangup', '☎️ Hang up').id;
  const un = b.node(`unknown_${app}_${dest}`, 'unknown', app, dest || undefined).id;
  b.note(`AA option application "${app}" not modeled.`);
  return un;
}

/**
 * Render an AA's menu from its OWN dialplan dialrules (authoritative — the /autoattendants detail
 * omits no-key/star/option). Grammar (confirmed against live auto-attendants on two independent domains), suffix after
 * `<startingPrompt>.`:
 *   Case_<0-9>            → press that digit
 *   Case_[*] / Case_[#]   → the literal * / # key
 *   Case_[0-9][0-9]…      → dial-by-extension (bracket ranges)
 *   *                     → unassigned key ("Unknown Input")
 *   Default               → no-key timeout
 * Apps: Announce → play-message; Prompt→own prompt id → repeat greeting; else via aaApp().
 * `detailTier` (the /autoattendants option-N structure, when present) enriches each key with its
 * CNAM prefix + play-message script/audio, which the dialplan lacks.
 */
function renderAaFromDialrules(rules: Rec[], startingPrompt: string, fromId: string, ext: string, idx: Index, b: Builder, detailTier?: Rec) {
  const prefix = `${startingPrompt}.`;
  const promptId = startingPrompt.replace(/^Prompt_/i, ''); // e.g. "912201"
  let dialByExt = false;
  interface Opt { label: string; sort: string; dtmf: string; app: string; dest: string; }
  const opts: Opt[] = [];
  let noKey: Opt | null = null;
  let unknown: Opt | null = null;
  for (const r of rules) {
    const uri = s(r['dial-rule-matching-to-uri']);
    if (!uri.startsWith(prefix)) continue;
    const suffix = uri.slice(prefix.length);
    const e = { app: s(r['dial-rule-application']), dest: s(r['dial-rule-translation-destination-user']) };
    if (suffix === 'Default') noKey = { label: 'no key / timeout', sort: '~1', dtmf: '', ...e };
    else if (suffix === '*') unknown = { label: 'unknown input', sort: '~2', dtmf: '', ...e };
    else if (suffix.startsWith('Case_')) {
      const c = suffix.slice(5);
      if (/^[0-9]$/.test(c)) opts.push({ label: `press ${c}`, sort: c, dtmf: c, ...e });
      else if (c === '[*]') opts.push({ label: 'press *', sort: '*', dtmf: '*', ...e });
      else if (c === '[#]') opts.push({ label: 'press #', sort: '#', dtmf: '#', ...e });
      else if (c.includes('[')) dialByExt = true; // bracket ranges → dial-by-extension
    }
  }
  const seen = new Set<string>();
  const route = (o: Opt) => {
    const key = `${o.label}->${o.app}:${o.dest}`;
    if (seen.has(key)) return;
    seen.add(key);
    // enrich from the detail's matching option (CNAM + play-message script), when available
    const opt = o.dtmf ? (detailTier?.[`option-${o.dtmf}`] as Rec | undefined) : undefined;
    const cnam = opt ? s(opt['caller-name-translation']) : '';
    const script = opt ? s(opt.audio?.['file-script-text']) : '';
    const label = o.label + (cnam && cnam !== '[*]' ? ` · ${cnam}` : '');
    let target: string;
    if (/^announce/i.test(o.app)) target = b.node(`aaannounce_${ext}_${o.dest}`, 'prompt', `🔊 ${script ? `“${trim(script)}”` : 'Play message'}`, undefined, undefined, script.length > GREET_MAX ? script : undefined).id;
    else if (/^prompt/i.test(o.app)) target = o.dest === promptId ? b.node(`aarepeat_${ext}`, 'prompt', '🔁 Repeat greeting', 're-plays the menu').id : b.node(`aaprompt_${ext}_${o.dest}`, 'prompt', '🔊 Play prompt', o.dest || undefined).id;
    else target = aaApp(o.app, o.dest, idx, b);
    b.edge(fromId, target, 'menu', label);
  };
  for (const o of opts.sort((a, c) => a.sort.localeCompare(c.sort))) route(o);
  if (noKey) route(noKey);
  if (unknown) route(unknown);
  if (dialByExt) b.edge(fromId, b.node(`aadial_${ext}`, 'user', '⌨️ Dial by extension').id, 'menu', 'dial ext');
}

/** Render one AA menu tier from `fromId`, recursing into nested submenus. */
function renderAaTier(tier: Rec, fromId: string, ext: string, idx: Index, b: Builder, path: string) {
  const optKeys = Object.keys(tier)
    .filter((k) => /^option-/.test(k))
    .sort();
  for (const k of optKeys) {
    const o = tier[k];
    if (!o || typeof o !== 'object') continue;
    const dtmf = k.replace('option-', '');
    const app = s(o['destination-application']);
    const dest = s(o['destination-user']);
    const greet = s(o.audio?.['file-script-text']);
    const label = `press ${dtmf}`;

    if (o['auto-attendant'] && typeof o['auto-attendant'] === 'object') {
      const subId = b.node(`aa_${ext}_${path}${dtmf}`, 'attendant', `🔀 Submenu (press ${dtmf})`, greet ? `“${trim(greet)}”` : 'nested menu', undefined, greet.length > GREET_MAX ? greet : undefined).id;
      b.edge(fromId, subId, 'menu', label);
      renderAaTier(o['auto-attendant'], subId, ext, idx, b, `${path}${dtmf}_`);
      continue;
    }
    if (/^play-message/i.test(app)) {
      const pr = b.node(`prompt_${ext}_${path}${dtmf}`, 'prompt', `🔊 ${greet ? `“${trim(greet)}”` : 'Play message'}`, 'announcement', undefined, greet.length > GREET_MAX ? greet : undefined).id;
      b.edge(fromId, pr, 'menu', label);
      continue;
    }
    b.edge(fromId, aaApp(app, dest, idx, b), 'menu', greet ? `${label} · “${greet}”` : label);
  }
  // Default behaviors from the portal "Options" dialog — only on the top menu tier (submenus have
  // their own, but showing them everywhere clutters). no-key-press / unassigned-key-press + dial-by-ext.
  if (path === '') {
    // Empty ≠ "repeat": the /autoattendants detail returns empty no-key/unassigned when the real
    // behavior (incl. "Follow *" / star-to-voicemail) lives in the AA's OWN dialplan dialrules
    // (Prompt_<id>.Default / .*), which this endpoint omits. Only render explicit values; note the gap.
    const nk = s(tier['no-key-press']);
    const uk = s(tier['unassigned-key-press']);
    if (nk) resolveAaDefault(tier, nk, 'no key', fromId, ext, idx, b);
    if (uk) resolveAaDefault(tier, uk, 'invalid key', fromId, ext, idx, b);
    if (!nk || !uk) b.note(`AA ${ext}: the no-key / invalid-key default (and any "Follow *" star-to-voicemail) isn't in the /autoattendants detail — it lives in the AA's own dialplan dialrules (Prompt_<id>.Default / .*), not yet rendered here.`);
    const dialDigits = ['3', '4', '5'].filter((d) => s(tier[`${d}-digit-dial-by-extension`]) === 'yes');
    if (dialDigits.length) {
      const dn = b.node(`aadial_${ext}`, 'user', '⌨️ Dial by extension', `${dialDigits.join('/')}-digit`).id;
      b.edge(fromId, dn, 'menu', 'dial ext');
    }
  }
}

/** Render an AA no-key-press / unassigned-key-press default: repeat greeting, hang up, or "follow"
 *  another option (route as if that key were pressed). */
function resolveAaDefault(tier: Rec, value: unknown, label: string, fromId: string, ext: string, idx: Index, b: Builder) {
  const v = s(value) || 'repeat';
  if (v === 'repeat') {
    const rn = b.node(`aarepeat_${ext}`, 'prompt', '🔁 Repeat greeting', 're-plays the menu').id;
    b.edge(fromId, rn, 'menu', label);
    return;
  }
  if (v === 'hangup') {
    b.edge(fromId, b.node(`aahangup_${ext}`, 'hangup', '☎️ Hang up').id, 'menu', label);
    return;
  }
  const m = v.match(/^option-(.+)$/);
  if (m) {
    const dtmf = m[1]!;
    const opt = tier[`option-${dtmf}`];
    if (opt && typeof opt === 'object' && !opt['auto-attendant'] && !/^play-message/i.test(s(opt['destination-application']))) {
      b.edge(fromId, aaApp(s(opt['destination-application']), s(opt['destination-user']), idx, b), 'menu', `${label} → key ${dtmf}`);
      return;
    }
    b.edge(fromId, b.node(`aakey_${ext}_${dtmf}`, 'prompt', `↪ Follow key ${dtmf}`).id, 'menu', label);
    return;
  }
  b.edge(fromId, b.node(`aadef_${ext}_${v}`, 'unknown', v).id, 'menu', label);
}

function ensureAttendant(ext: string, idx: Index, b: Builder): string {
  const id = `aa_${ext}`;
  const aa = idx.attendantsByExt.get(s(ext));
  const detail = idx.aaDetailByExt.get(s(ext));
  const nm = s(detail?.['attendant-name']) || (aa ? s(aa['attendant-name']) : '');
  const greet = s(detail?.audio?.['file-script-text']);
  // SV builds AAs on the always-available `*` timeframe; a specific timeframe is unusual. Show it
  // plainly on the node (clear display) rather than as a loud warning — the loud validation belongs
  // in the ns-onboard/backup path, not the viewer.
  const aaTf = s(detail?.['time-frame']);
  const tfTag = aaTf && aaTf !== '*' ? ` · timeframe ${aaTf}` : '';
  b.node(id, 'attendant', `🔀 Auto Attendant ${ext}${nm ? ` · ${nm}` : ''}`, (greet ? `“${trim(greet)}”` : 'plays menu') + tfTag, undefined, greet.length > GREET_MAX ? greet : undefined);
  if (!b.claim(id)) return id;
  b.enter(id);

  // Menu source (dialplan-preferred), computed first so intros can be a preamble the menu flows out of.
  const startingPrompt = s(detail?.['starting-prompt']) || (aa ? s(aa['starting-prompt']) : '');
  const aaRules = idx.aaDialrulesByExt.get(s(ext));
  const hasDialruleMenu = !!(aaRules && aaRules.length && startingPrompt);
  const hasTierMenu = !hasDialruleMenu && !!detail?.['auto-attendant'];

  // Per-timeframe intro greetings play FIRST, before the menu. Render as a preamble the menu flows out
  // of (via a "Menu" hub), not as a sibling of the keypress options. Skip empty slots ({tf:null, audio:[]}).
  const introNode = (iv: { tf: string; audio: Rec }): string => {
    const script = s(iv.audio['file-script-text']);
    return b.node(`aaintro_${ext}_${iv.tf}`, 'prompt', `🔊 ${script ? `“${trim(script)}”` : 'Intro greeting'}`, 'intro greeting', undefined, script.length > GREET_MAX ? script : undefined).id;
  };
  const validIntros = (Array.isArray(detail?.['intro-greetings']) ? (detail!['intro-greetings'] as Rec[]) : [])
    .map((ig) => ({ tf: s(ig?.['time-frame']), audio: ig?.audio as Rec }))
    .filter((x) => x.tf && x.audio && !Array.isArray(x.audio) && typeof x.audio === 'object');

  let menuSource = id;
  if (validIntros.length && (hasDialruleMenu || hasTierMenu)) {
    const hub = b.node(`aamenu_${ext}`, 'attendant', '🔀 Menu', 'keypress options').id;
    let alwaysIntro = false;
    for (const iv of validIntros) {
      const isDefault = /^(default|\*)$/i.test(iv.tf);
      alwaysIntro ||= isDefault;
      const pr = introNode(iv);
      b.edge(id, pr, 'route', isDefault ? 'plays intro' : timeframeSchedule(iv.tf, idx));
      b.edge(pr, hub, 'route');
    }
    if (!alwaysIntro) b.edge(id, hub, 'route', 'otherwise'); // menu also reached outside the intro timeframe(s)
    menuSource = hub;
  } else {
    for (const iv of validIntros) b.edge(id, introNode(iv), 'time', timeframeSchedule(iv.tf, idx));
  }

  // Extra timeframe menus (rare) — a neutral, informational note so hidden menus aren't a surprise.
  const allDetails = idx.aaDetailsByExt.get(s(ext)) ?? [];
  if (allDetails.length > 1) {
    const others = allDetails.filter((d) => d !== detail).map((d) => s(d['time-frame']) || 'default').join(', ');
    b.note(`AA ${ext} has ${allDetails.length} timeframe menus (also: ${others}); showing the ${aaTf && aaTf !== '*' ? aaTf : 'default'} menu.`);
  }

  // The menu (dialplan-preferred; the /autoattendants detail omits no-key/star) flows out of menuSource.
  if (hasDialruleMenu) {
    renderAaFromDialrules(aaRules!, startingPrompt, menuSource, s(ext), idx, b, detail?.['auto-attendant'] as Rec | undefined);
    return b.leave(id);
  }
  if (hasTierMenu) {
    renderAaTier(detail!['auto-attendant'], menuSource, s(ext), idx, b, '');
    return b.leave(id);
  }

  // No menu detail (backup-only) -> show the greeting prompt + flag the gap.
  const rule = (idx.answerRules.get(s(ext)) ?? [])[0];
  const fa = rule ? firstParam(rule['forward-always']) : null;
  if (fa && /^Prompt_/i.test(fa)) {
    const pr = b.node(`prompt_${fa}`, 'prompt', `🔊 ${fa}`, 'greeting / announcement').id;
    b.edge(id, pr, 'route', 'plays');
  } else if (aa && s(aa['starting-prompt'])) {
    const sp = s(aa['starting-prompt']);
    const pr = b.node(`prompt_${sp}`, 'prompt', `🔊 ${sp}`, 'starting prompt').id;
    b.edge(id, pr, 'route', 'plays');
  }
  b.note(`Auto-attendant ${ext} keypress menu not in this snapshot — fetch GET /domains/{d}/users/${ext}/autoattendants/{prompt} to render options.`);
  return b.leave(id);
}

function ensureVoicemail(ext: string, idx: Index, b: Builder): string {
  const id = `vm_${ext}`;
  const name = idx.userName(ext);
  b.node(id, 'voicemail', `📭 Voicemail ${ext}`, name && name !== s(ext) ? name : undefined);
  return id;
}

function ensureExternal(number: string, b: Builder): string {
  const id = `ext_${number}`;
  b.node(id, 'external', `☎️ ${prettyPhone(number)}`, 'external / off-net');
  return id;
}

/** Route a raw param string from `fromId`: classify, ensure target, edge, recurse. */
function routeParam(param: string, fromId: string, idx: Index, b: Builder, edgeKind: EdgeKind, edgeLabel: string) {
  const t = classifyParam(param, idx);
  switch (t.kind) {
    case 'queue':
      b.edge(fromId, ensureQueue(t.ext!, idx, b), edgeKind, edgeLabel);
      break;
    case 'attendant':
      b.edge(fromId, ensureAttendant(t.ext!, idx, b), edgeKind, edgeLabel);
      break;
    case 'voicemail':
      b.edge(fromId, ensureVoicemail(t.ext!, idx, b), edgeKind, edgeLabel);
      break;
    case 'user':
      b.edge(fromId, ensureExt(t.ext!, idx, b), edgeKind, edgeLabel);
      break;
    case 'external':
      b.edge(fromId, ensureExternal(t.number!, b), edgeKind, edgeLabel);
      break;
    case 'prompt': {
      const pr = b.node(`prompt_${t.promptId}`, 'prompt', `🔊 ${t.promptId}`, 'greeting').id;
      b.edge(fromId, pr, edgeKind, edgeLabel);
      break;
    }
    case 'devices':
      // bare <OwnDevices> as a forward target is unusual; treat as ring-self terminal.
      b.edge(fromId, b.node(`dev_self_${fromId}`, 'devices', '📱 Ring own devices').id, edgeKind, edgeLabel);
      break;
    case 'hangup':
      b.edge(fromId, b.node(`hangup_${fromId}`, 'hangup', '☎️ Hang up').id, edgeKind, edgeLabel);
      break;
    default: {
      const un = b.node(`unknown_${param}`, 'unknown', param, 'unrecognized target').id;
      b.edge(fromId, un, edgeKind, edgeLabel);
      b.note(`Unrecognized routing target "${param}".`);
    }
  }
}

function prettyPhone(num: string): string {
  const d = digits(num);
  const n = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  if (n.length === 10) return `${n.slice(0, 3)}-${n.slice(3, 6)}-${n.slice(6)}`;
  return num;
}

// ---------------------------------------------------------------------------
// Entity enumeration (for the CLI picker / "list" mode)
// ---------------------------------------------------------------------------

/** DID action categories for the entity picker, in display order. */
export const DID_ACTIONS: Record<string, { order: number; label: string }> = {
  timeframe: { order: 1, label: 'Time-of-day routing' },
  extension: { order: 2, label: 'To extension' },
  queue: { order: 3, label: 'To call queue' },
  attendant: { order: 4, label: 'To auto attendant' },
  voicemail: { order: 5, label: 'To voicemail' },
  other: { order: 6, label: 'Other routing' },
  fax: { order: 7, label: 'Fax / connection' },
  available: { order: 8, label: 'Available (unassigned)' },
};

/** Categorize a DID by its routing. Time-of-day is detected from the destination user's answer
 *  rules (>1 enabled rule = TOD) when those rules are present in the snapshot; otherwise a
 *  to-user DID falls under "extension". */
function classifyDidAction(p: Rec, idx: Index): keyof typeof DID_ACTIONS {
  const app = s(p['dial-rule-application']).toLowerCase();
  const dest = s(p['dial-rule-translation-destination-user']);
  if (app.startsWith('available-number')) return 'available';
  if (app.startsWith('to-connection')) return 'fax';
  if (app.startsWith('to-callqueue')) return 'queue';
  if (app.startsWith('to-voicemail')) return 'voicemail';
  if (app.startsWith('to-user')) {
    const kind = idx.classifyExt(dest);
    if (kind === 'attendant') return 'attendant';
    if (kind === 'queue') return 'queue';
    const rules = (idx.answerRules.get(dest) ?? []).filter((r) => s(r.enabled) === 'yes');
    return rules.length >= 2 ? 'timeframe' : 'extension';
  }
  return 'other';
}

export function listEntities(snap: Snapshot) {
  const idx = new Index(snap);
  const dids = (snap.phonenumbers ?? [])
    .map((p) => {
      const action = classifyDidAction(p, idx);
      return { ref: nat(p.phonenumber), label: prettyPhone(s(p.phonenumber)), desc: s(p['dial-rule-description']), action, actionLabel: DID_ACTIONS[action].label, order: DID_ACTIONS[action].order };
    })
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  return {
    dids,
    users: (snap.users ?? [])
      .filter((u) => !idx.queuesByExt.has(s(u.user)) && !idx.attendantsByExt.has(s(u.user)))
      .map((u) => ({ ref: s(u.user), label: idx.userName(s(u.user)) })),
    queues: (snap.callqueues ?? []).map((q) => ({ ref: s(q.callqueue), label: s(q.description) })),
    attendants: (snap.autoattendants ?? []).map((a) => ({ ref: s(a.user), label: s(a['attendant-name']) })),
  };
}
