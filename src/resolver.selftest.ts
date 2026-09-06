/**
 * Cascade tier + queue-priority rendering proof. Run: `pnpm test:resolver`.
 *
 * Tiers group by RING ORDER (ordinal-order, or the manifest write-key
 * callqueue-agent-dispatch-order-ordinal) — the real Linear Cascade rounds, NOT the
 * cross-queue priority. Queue priority (lower = higher) is shown once when the queue
 * shares one non-default value, per-agent when it varies, and hidden at the default (0).
 */
import { deviceKindBySuffix, resolveFlow } from './resolver.js';
import type { Snapshot, FlowGraph, NodeKind } from './model.js';

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean) => {
  cond ? (pass++, console.log('  ok   ' + name)) : (fail++, console.log('  FAIL ' + name));
};

function snap(agents: Record<string, unknown>[]): Snapshot {
  return {
    meta: { domain: 'testco.12345.service' },
    callqueues: [{ callqueue: '9100', description: 'open', 'callqueue-dispatch-type': 'Linear Cascade' }],
    agentsByQueue: { '9100': agents },
    users: [
      { user: '100', 'name-first-name': 'Debbi', 'name-last-name': 'Smith' },
      { user: '103', 'name-first-name': 'Emily', 'name-last-name': 'Laugle' },
      { user: '102', 'name-first-name': 'Elizabeth', 'name-last-name': 'Ross' },
    ],
  };
}
const linesOf = (g: FlowGraph, kind: NodeKind) => (g.nodes.find((n) => n.kind === kind)?.lines ?? []).join('\n');

// ---- ring-order tiers + uniform non-default priority shown once ----
{
  const g = resolveFlow(
    snap([
      { 'callqueue-agent-id': 'sip:100@x', 'ordinal-order': 1, 'callqueue-agent-dispatch-queue-priority-ordinal': 3 },
      { 'callqueue-agent-id': 'sip:103@x', 'ordinal-order': 1, 'callqueue-agent-dispatch-queue-priority-ordinal': 3 },
      { 'callqueue-agent-id': 'sip:102@x', 'ordinal-order': 2, 'callqueue-agent-dispatch-queue-priority-ordinal': 3 },
    ]),
    { kind: 'queue', ref: '9100' },
  );
  const a = linesOf(g, 'agents');
  check('tier by ring order: Tier 1 present', a.includes('Tier 1:'));
  check('tier by ring order: Tier 2 present', a.includes('Tier 2:'));
  check('round 1 = Debbi + Emily', /Tier 1:[\s\S]*Debbi[\s\S]*Emily[\s\S]*Tier 2:/.test(a));
  check('round 2 = Elizabeth', /Tier 2:[\s\S]*Elizabeth/.test(a));
  const q = linesOf(g, 'queue');
  check('uniform 2+ priority → compact badge once at queue (P3️⃣)', q.includes('P3️⃣'));
  check('no verbose "priority 3" wording', !/priority 3\b/.test(q));
  check('priority NOT repeated per agent when uniform', !a.includes('P3️⃣'));
}

// ---- concise priority badge: nothing for 0 (blank) / 1 (baseline); P<keycap> for 2+ ----
{
  const g = resolveFlow(
    snap([
      { 'callqueue-agent-id': 'sip:100@x', 'ordinal-order': 1, 'callqueue-agent-dispatch-queue-priority-ordinal': 1 }, // baseline
      { 'callqueue-agent-id': 'sip:103@x', 'ordinal-order': 1, 'callqueue-agent-dispatch-queue-priority-ordinal': 0 }, // blank
      { 'callqueue-agent-id': 'sip:102@x', 'ordinal-order': 1, 'callqueue-agent-dispatch-queue-priority-ordinal': 2 }, // set → P2️⃣
    ]),
    { kind: 'queue', ref: '9100' },
  );
  const a = linesOf(g, 'agents');
  check('concise: no Tier header (ring order uniform)', !a.includes('Tier 1:'));
  check('concise: priority 2 shows P2️⃣ once', (a.match(/P2️⃣/g) ?? []).length === 1);
  check('concise: baseline priority 1 shows no badge', !a.includes('P1️⃣'));
  check('concise: blank priority 0 shows no badge', !a.includes('P0️⃣'));
  check('concise: no verbose "priority" word on the roster', !/·\s*priority\b/.test(a));
}

// ---- manifest-preview write-key fallback still tiers ----
{
  const g = resolveFlow(
    snap([
      { 'callqueue-agent-id': 'sip:100@x', 'callqueue-agent-dispatch-order-ordinal': 1 },
      { 'callqueue-agent-id': 'sip:102@x', 'callqueue-agent-dispatch-order-ordinal': 2 },
    ]),
    { kind: 'queue', ref: '9100' },
  );
  check('write-key fallback tiers (manifest preview)', linesOf(g, 'agents').includes('Tier 2:'));
}

// ---- all-default priority (0) → hidden ----
{
  const g = resolveFlow(
    snap([
      { 'callqueue-agent-id': 'sip:100@x', 'ordinal-order': 1 },
      { 'callqueue-agent-id': 'sip:102@x', 'ordinal-order': 2 },
    ]),
    { kind: 'queue', ref: '9100' },
  );
  check('default (0) priority hidden', !/queue priority/.test(linesOf(g, 'queue')));
}

// ---- unanswered disposition: "Stay in queue" is drawn explicitly, not silently dropped ----
// forward-no-answer disabled/empty = portal "If unanswered → Stay in queue"; forward-on-busy → vmail.
{
  const base: Snapshot = {
    meta: { domain: 'testco.12345.service' },
    callqueues: [{ callqueue: '9102', description: 'office', 'callqueue-dispatch-type': 'Linear Cascade' }],
    agentsByQueue: { '9102': [{ 'callqueue-agent-id': 'sip:100@x', 'ordinal-order': 1 }] },
    users: [{ user: '100', 'name-first-name': 'Debbi', 'name-last-name': 'Smith' }],
  };
  const stay = resolveFlow(
    {
      ...base,
      answerrulesByUser: {
        '9102': [
          {
            'time-frame': '*',
            enabled: 'yes',
            'forward-no-answer': { parameters: [], enabled: 'no' }, // Stay in queue
            'forward-on-busy': { parameters: ['vmail_500'], enabled: 'yes' },
          },
        ],
      },
    },
    { kind: 'queue', ref: '9102' },
  );
  const stayEdge = stay.edges.find((e) => e.label === 'if unanswered · stays in queue');
  check('stay-in-queue: explicit unanswered edge is drawn', !!stayEdge);
  check('stay-in-queue: unanswered edge emanates from the agents node', !!stayEdge && stayEdge.from === 'agents_9102');
  check('stay-in-queue: back-edge leaf points at the queue node', !!stayEdge && stayEdge.to.startsWith('ref_queue_9102'));
  check('stay-in-queue: if-unavailable → voicemail still shown', stay.edges.some((e) => e.label === 'if unavailable' && stay.nodes.find((n) => n.id === e.to)?.kind === 'voicemail'));

  // When forward-no-answer IS a real target, route there (no "stays in queue" leaf).
  const toVm = resolveFlow(
    {
      ...base,
      callqueues: [{ callqueue: '9101', description: 'tech', 'callqueue-dispatch-type': 'Linear Cascade' }],
      agentsByQueue: { '9101': [{ 'callqueue-agent-id': 'sip:100@x', 'ordinal-order': 1 }] },
      answerrulesByUser: {
        '9101': [
          {
            'time-frame': '*',
            enabled: 'yes',
            'forward-no-answer': { parameters: ['vmail_500'], enabled: 'yes' },
          },
        ],
      },
    },
    { kind: 'queue', ref: '9101' },
  );
  check('routed unanswered: no "stays in queue" leaf when a target is set', !toVm.edges.some((e) => e.label === 'if unanswered · stays in queue'));
  check('routed unanswered: no answer / timeout edge present', toVm.edges.some((e) => e.label === 'no answer / timeout'));
}

// ---- AA "Add Tier": a keypress that opens a second-level menu ----
// Shape (confirmed live): the tier's prompt id (900185) exists ONLY in the dialplan, as a sibling
// `Prompt_900185.` rule family in the SAME AA dialplan. The /autoattendants detail nests the tier as
// `option-5.auto-attendant` with no id, so the two join on the keypress digit. Fictional ids here.
{
  const aaSnap: Snapshot = {
    meta: { domain: 'testco.12345.service' },
    autoattendants: [{ user: '9000', 'attendant-name': 'aa_open', 'starting-prompt': 'Prompt_900001' }],
    users: [{ user: '1043', 'name-first-name': 'Ada', 'name-last-name': 'Byron' }],
    attendantDetails: {
      '9000': {
        'attendant-name': 'aa_open',
        user: '9000',
        'starting-prompt': 'Prompt_900001',
        'time-frame': '*',
        'auto-attendant': {
          'option-2': { 'destination-application': 'to-user-residential', 'destination-user': '1043' },
          'option-5': {
            description: 'AA designer: press 5 for tier More options',
            audio: { 'file-script-text': 'More options' },
            'auto-attendant': {
              'option-1': { 'destination-application': 'sip:start@directory', 'destination-user': '900186' },
            },
          },
        },
      },
    },
    attendantDialrulesByExt: {
      '9000': [
        { 'dial-rule-matching-to-uri': 'Prompt_900001.Case_1', 'dial-rule-application': 'Announce', 'dial-rule-translation-destination-user': '900013' },
        { 'dial-rule-matching-to-uri': 'Announce_900013.Done', 'dial-rule-application': 'Prompt', 'dial-rule-translation-destination-user': '900001' },
        { 'dial-rule-matching-to-uri': 'Prompt_900001.Case_2', 'dial-rule-application': 'to-user-residential', 'dial-rule-translation-destination-user': '1043' },
        { 'dial-rule-matching-to-uri': 'Prompt_900001.Case_4', 'dial-rule-application': 'Announce', 'dial-rule-translation-destination-user': '900014' },
        { 'dial-rule-matching-to-uri': 'Announce_900014.Done', 'dial-rule-application': 'hangup', 'dial-rule-translation-destination-user': '' },
        { 'dial-rule-matching-to-uri': 'Prompt_900001.Case_5', 'dial-rule-application': 'Prompt', 'dial-rule-translation-destination-user': '900185' },
        { 'dial-rule-matching-to-uri': 'Prompt_900001.Default', 'dial-rule-application': 'Prompt', 'dial-rule-translation-destination-user': '900001' },
        { 'dial-rule-matching-to-uri': 'Prompt_900185.Case_1', 'dial-rule-application': 'sip:start@directory', 'dial-rule-translation-destination-user': '900186' },
        { 'dial-rule-matching-to-uri': 'Prompt_900185.Case_9', 'dial-rule-application': 'Prompt', 'dial-rule-translation-destination-user': '900001' },
        { 'dial-rule-matching-to-uri': 'Prompt_900185.Default', 'dial-rule-application': 'Prompt', 'dial-rule-translation-destination-user': '900185' },
      ],
    },
  };
  const g = resolveFlow(aaSnap, { kind: 'attendant', ref: '9000' });
  const sub = g.nodes.find((n) => n.id === 'aa_9000_p900185');

  check('tier: press 5 is a submenu node, not a "Play prompt" leaf', !!sub && sub.kind === 'attendant');
  check('tier: no dead-end Play prompt for the tier id', !g.nodes.some((n) => n.id === 'aaprompt_9000_900185'));
  check('tier: submenu is labelled with its keypress', !!sub && sub.label === '🔀 Submenu (press 5)');
  check('tier: submenu carries its own menu-prompt script', !!sub && sub.sub === '“More options”');
  check('tier: menu edge "press 5" lands on the submenu', g.edges.some((e) => e.label === 'press 5' && e.to === 'aa_9000_p900185'));
  check(
    'tier: the tier\'s own options render below it',
    g.edges.some((e) => e.from === 'aa_9000_p900185' && e.label === 'press 1' && e.to === 'directory'),
  );
  check(
    'tier: the tier\'s no-key default repeats ITS greeting, not the top menu\'s',
    g.edges.some((e) => e.from === 'aa_9000_p900185' && e.label === 'no key / timeout' && e.to === 'aarepeat_9000_900185'),
  );
  check(
    'tier: a key back to the parent prompt draws a loops-back leaf, not infinite recursion',
    g.edges.some((e) => e.from === 'aa_9000_p900185' && e.kind === 'ref' && e.label === 'press 9'),
  );
  check('tier: top-level keys still resolve', g.edges.some((e) => e.label === 'press 2' && e.to === 'user_1043'));

  // A played message is never a dead end: `Announce_<id>.Done` says where the call goes next.
  check(
    'announce: message returning to its menu reuses the shared Repeat greeting node',
    g.edges.some((e) => e.from === 'aaannounce_9000_900013' && e.label === 'then' && e.to === 'aarepeat_9000_900001'),
  );
  check(
    'announce: a non-menu .Done target routes normally (hang up)',
    g.edges.some((e) => e.from === 'aaannounce_9000_900014' && e.label === 'then' && g.nodes.find((n) => n.id === e.to)?.kind === 'hangup'),
  );
  check('announce: no message node is left without an outgoing edge', ['aaannounce_9000_900013', 'aaannounce_9000_900014'].every((id) => g.edges.some((e) => e.from === id)));
}

// ── the device-suffix legend, as the resolver reads it ──────────────────────────────────────────────
// The KINDS come from DEFAULT_DEVICE_SUFFIXES so a suffix means one thing across the library; the icons
// and two fallbacks are the resolver's own. Asserted here because a diagram is where the labels are SEEN,
// and a drift between this and the inventory's legend would show up nowhere else.
{
  const k = (s: string) => deviceKindBySuffix(s);
  check('suffix wp reads the legend label SNAPmobile Web, with the resolver\'s globe', k('wp').kind === 'SNAPmobile Web' && k('wp').icon === '🌐');
  check('suffix m reads SNAPmobile', k('m').kind === 'SNAPmobile' && k('m').icon === '📱');
  check('suffix t reads Teams', k('t').kind === 'Teams' && k('t').icon === '💻');
  check('an upper-case suffix reads the same', k('WP').kind === 'SNAPmobile Web' && k('T').kind === 'Teams');
  check('suffix r is the resolver\'s own fallback, not the legend\'s', k('r').kind === 'app' && k('r').icon === '📱');
  check('any other letter is a desk phone', k('b').kind === 'desk phone' && k('b').icon === '📞');
  check('no suffix is no kind and no icon', k('').kind === '' && k('').icon === '');
  // The key is a device-name suffix off a snapshot, so an inherited Object name is a reachable key. On a
  // plain object literal `SUFFIX_ICONS['constructor']` answers a function and `?? '📞'` never fires.
  for (const evil of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    check(`a suffix named ${evil} falls to the defaults rather than an inherited value`,
      k(evil).kind === 'desk phone' && k(evil).icon === '📞');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) throw new Error(`${fail} check(s) failed`);
