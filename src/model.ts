/**
 * Normalized call-flow graph — renderer-agnostic. The resolver emits this from a
 * NetSapiens domain snapshot; the Mermaid emitter (and, later, any other renderer)
 * consumes it. This is the "real IP" contract from the handoff: a normalized graph JSON.
 *
 * Runtime-portable by design: no Node-only imports here or in resolver.ts, so the same
 * code can run in the ns-onboard CLI and in a Cloudflare Worker.
 */

export type NodeKind =
  | 'did' // inbound phone number
  | 'timeframe' // time-of-day / schedule decision
  | 'user' // a subscriber extension
  | 'devices' // "ring the user's registered devices"
  | 'queue' // ACD call queue
  | 'agents' // the agent roster of a queue
  | 'attendant' // auto attendant
  | 'prompt' // a played greeting / announcement
  | 'voicemail' // a mailbox (terminal)
  | 'external' // off-net / PSTN forward (terminal)
  | 'trunk' // SIP connection / trunk (e.g. fax server) (terminal)
  | 'hangup' // dead end / no route
  | 'unknown';

export type EdgeKind =
  | 'route' // plain "goes to"
  | 'time' // a time-of-day branch
  | 'always' // forward-always (unconditional)
  | 'noanswer' // ring-no-answer timeout
  | 'busy' // forward-on-busy
  | 'unreg' // forward-when-unregistered
  | 'dnd' // do-not-disturb path
  | 'dispatch' // queue -> agents
  | 'overflow' // queue overflow
  | 'menu' // auto-attendant keypress
  | 'ref'; // link back to an already-drawn node (breaks a cycle)

export interface FlowNode {
  id: string;
  kind: NodeKind;
  /** Primary label line. */
  label: string;
  /** Optional secondary line (e.g. dispatch type, schedule). */
  sub?: string;
  /** Optional additional lines rendered one-per-line under the label (e.g. a bulleted agent list). */
  lines?: string[];
  /** Full text for a hover tooltip (e.g. a long greeting shown truncated in the label). Viewer-only. */
  title?: string;
}

export interface FlowEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** Edge caption (e.g. "open hrs", "no answer 30s"). */
  label?: string;
}

export interface FlowGraph {
  /** Entity the flow was resolved for. */
  entity: { kind: string; ref: string; label: string };
  domain: string;
  rootId: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Human-facing caveats surfaced during resolution (gaps, unmapped params, cycles). */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Loose snapshot typings. The snapshot is raw NetSapiens JSON with hyphenated
// keys; we type only what the resolver reads and keep everything index-signature
// loose so drift in unrelated fields never breaks the build.
// ---------------------------------------------------------------------------

export type Rec = Record<string, any>;

export interface Snapshot {
  meta: Rec;
  domain?: Rec;
  timeframes?: Rec[];
  users?: Rec[];
  devicesByUser?: Record<string, Rec[]>;
  callqueues?: Rec[];
  agentsByQueue?: Record<string, Rec[]>;
  phonenumbers?: Rec[];
  autoattendants?: Rec[];
  dialrulesByPlan?: Record<string, Rec[]>;
  answerrulesByUser?: Record<string, Rec[]>;
  /**
   * Optional per-attendant menu detail, keyed by AA extension — the response of
   * GET /domains/{d}/users/{ext}/autoattendants/{prompt} (an `auto-attendant` tier +
   * top-level greeting `audio` + `intro-greetings[]` + `time-frame`). When present, the
   * resolver renders the real keypress menu; when absent, it emits a "not captured" note.
   *
   * Two shapes are accepted:
   *  - `attendantDetails[ext]`        — a single detail (current live fetch; SV builds AAs on `*`).
   *  - `attendantDetailsByUser[ext]`  — an ARRAY of details (ns-onboard enriched backup: an AA may
   *    have multiple prompts/timeframes). The resolver picks the `*`/Default one as primary and
   *    flags the rest as a deviation (see the AA backup enrichment spec, Addendum 2026-07-11).
   */
  attendantDetails?: Record<string, Rec>;
  attendantDetailsByUser?: Record<string, Rec[]>;
  /**
   * Per-AA dialplan dialrules, keyed by AA extension — the AUTHORITATIVE menu + default routing that
   * the /autoattendants detail omits (no-key/star/option). From GET /domains/{d}/dialplans/{domain}_{ext}/dialrules.
   * The resolver reads `Prompt_<startingPrompt-id>.<suffix>` rules: .Default (no-key/timeout), .* (unassigned),
   * .<digit> (press N), .Case_[...] (dial-by-ext). See CLAUDE.md → NetSapiens API notes.
   */
  attendantDialrulesByExt?: Record<string, Rec[]>;
  [k: string]: any;
}
