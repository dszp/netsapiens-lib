# Architecture

Why this library is shaped the way it is, and the non-obvious things that will bite you. For the rules
of contributing, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Module boundaries

Every module is portable (Node-free): the same built output runs in a Cloudflare Worker, in Node, and
in a browser.

| File | Role |
|---|---|
| `model.ts` | The `FlowGraph` contract — renderer-agnostic, the real interface. |
| `resolver.ts` | Deterministic snapshot → `FlowGraph` walker (`resolveFlow`, `listEntities`). |
| `mermaid.ts` | `FlowGraph` → Mermaid (shape + color per node kind). |
| `html.ts` | `renderGalleryHtml` / `renderFlowCards` — returns a string; the caller picks the sink. |
| `raster.ts` | Browser-side SVG → PNG rasterizer source. |
| `themes.ts` | Theme registry: node palettes + Mermaid base/look + app chrome, as plain data. |
| `jwt.ts` | `ns_t` validation: `verify` (cached, live) / `validateJwtFormat` (local). |
| `principal.ts` / `policy.ts` / `sensitivity.ts` | Identity normalization + a declarative allow-list policy engine. |
| `nsClient.ts` | Read-only NS API v2 client (`NsClient`) + `fetchDomainSnapshot`. |
| `index.ts` | The public barrel — the surface every host imports. |
| `*.selftest.ts` | Dev harnesses (Node, `tsx`). **Excluded from the build**, never shipped. |

`renderFlowCards()` exists so a host can embed cards in its **existing** page rather than taking a
whole HTML document.

## `ns_t` validation: the live call is the signature check

`ns_t` is **HS256**, signed with a secret held only by the NetSapiens core — there is no public JWKS
(we probed; all 404). So the signature **cannot** be verified locally, and `verify()` reports
`signature: 'unverified'`. The live `GET /jwt` roundtrip *is* the signature authority: the server holds
the key, validates it, and also confirms the token hasn't been logged out.

That has consequences worth stating plainly:

- **`mode: 'format'` does not mean authenticated.** It returns `ok: false` unless a `signingSecret`
  actually verified the signature locally. Never treat a format check as a login.
- **Only a literal 200 means valid.** 401/403 ⇒ invalid; 3xx/5xx/timeout ⇒ error → fail closed, and
  the verdict is *not* cached. `redirect: 'manual'` so a redirect-to-login can't be graded as 2xx, and
  a ~4s abort so a hung core can't tie up the request.
- **Don't call `/jwt` per request.** `verify()` gates on the cheap local check first (structure, `exp`,
  `aud`, `iss`), then serves a **cached** live verdict keyed by SHA-256 of the token, TTL capped by the
  token's own `exp`. A bad, expired, or wrong-issuer token never reaches the server. The cache is a
  pluggable `VerdictCache`.
- **Revocation gap.** Logout is server-side with no evict event, so a cached "valid" can survive up to
  the TTL. Sensitive reads and writes must pass `forceFresh: true`, which bypasses the cache read,
  re-hits `/jwt`, and overwrites the stale entry. Classify each route with `CallSensitivity`
  (`read | sensitive | write`) and derive `forceFresh` from it rather than remembering by hand.

`aud` defaults to `"ns"` (fixed by the platform, true everywhere). `iss` has **no default** and is
required unless you pass `validateIss: false` — a default issuer would mean accepting tokens minted by
a portal you don't control. It accepts a list, for one backend fronted by several portal hostnames;
matching is exact, with no wildcards.

## Rendering gotchas

These look like nitpicks and are not — each one is a bug that reached a real diagram.

- **`PAD` is a measurement kludge for NODE labels only** (`mermaid.ts` `quote()`). Mermaid
  under-measures emoji width and clips the node box; PAD buys slack. **Edge labels must NOT get PAD** —
  trailing padding biases the chip rightward.
- **Edge-label anti-clip is CSS, not padding.** Mermaid sizes each edge-label `foreignObject` from a
  font measurement that drifts ~10px under `look: neo`, so the rendered span is wider than its box and
  the right edge clips ("press 2" → "press "). The fix is `g.edgeLabel foreignObject { overflow:visible }`.
  **The trap:** that alone reveals Mermaid's oversized semi-transparent `.labelBkg` block (the "ugly big
  boxes"). Full recipe: `foreignObject { overflow:visible }` + `.labelBkg { background:transparent }` +
  `foreignObject > div { white-space:nowrap; line-height:1.35; max-width:none }` +
  `span.edgeLabel { display:inline-block; padding:1px 7px; border-radius:4px }`. Lives in `html.ts`
  `FLOW_LABEL_CSS`; a host that injects its own CSS must mirror it.
- **Mermaid IDs must never carry data.** `toMermaid()` emits synthetic `n<i>` IDs; NS data goes only in
  quoted labels. Data in an ID position makes `mermaid.render()` throw on real domains.
- **The legacy no-theme `toMermaid()` output is byte-stable.** Hosts depend on it. Don't add frontmatter
  to that path; theme by post-processing `classDef` lines instead.

## NetSapiens routing model (what the resolver decodes)

- **DID** (`phonenumbers[]`): `dial-rule-application` → `to-user[-residential]`, `to-callqueue`,
  `to-voicemail`, `to-connection*` (trunk/external).
- Every "extension" is a **user record**; some are virtual: a queue, an auto attendant, a time-of-day
  router, or a shared mailbox.
- **User routing** = answer rules, one per time-frame, by `ordinal-priority`: `forward-always` |
  `simultaneous-ring`/`<OwnDevices>` then `forward-no-answer` (RNA) | `forward-on-busy` |
  `forward-when-unregistered`.
- **Alias language** in params / dial-rule `to-uri`s: `<did>_callqueue_<ext>`, `queue_<ext>` → queue;
  `<did>_attendant_<ext>` → AA; `user_<ext>` → user; `vmail_<ext>` → voicemail; `<did>_pstn_<num>` or
  bare 10–11 digits → external; `Prompt_<id>` → greeting; `<OwnDevices>` → the user's devices.
- **Queue "Stay in queue" is a real state, not an absence.** A `forward-no-answer` block that is
  `{enabled: 'no', parameters: []}` is the portal's "If unanswered → Stay in queue": the caller is NOT
  dropped to voicemail, they re-queue and agents ring again. `ensureQueue` draws that explicitly as a
  loops-back leaf rather than rendering nothing. `forward-on-busy` → `vmail_<ext>` is the separate "if
  unavailable", and is orthogonal to the portal's "Enable voicemail: No".
- **Cycles render as reference leaves, not up-edges.** The builder keeps a DFS path stack; an edge
  whose target is an ancestor on the path (e.g. an AA option returning to the queue that feeds it) is
  drawn as a compact dashed `↩ <target>` leaf. Centralized in `edge()`, so it covers every call site —
  give any new expandable node kind matching `enter`/`leave` calls.
- **Auto-attendant menus are not in a backup** (inventory only). The authoritative menu lives in the
  AA's own dialplan, `<domain>_<ext>`: `Prompt_<id>` plays the greeting, `.Default` is the no-key/timeout
  target, `.*` is the unassigned-key catch-all, `.<digit>` is a keypress, `.Case_[...]` is
  dial-by-extension. The `/autoattendants/{prompt}` detail omits the no-key/star routing — read the
  dialplan for the truth.
