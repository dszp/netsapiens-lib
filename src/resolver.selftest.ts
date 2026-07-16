/**
 * Cascade tier + queue-priority rendering proof. Run: `pnpm test:resolver`.
 *
 * Tiers group by RING ORDER (ordinal-order, or the manifest write-key
 * callqueue-agent-dispatch-order-ordinal) — the real Linear Cascade rounds, NOT the
 * cross-queue priority. Queue priority (lower = higher) is shown once when the queue
 * shares one non-default value, per-agent when it varies, and hidden at the default (0).
 */
import { resolveFlow } from './resolver.js';
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) throw new Error(`${fail} check(s) failed`);
