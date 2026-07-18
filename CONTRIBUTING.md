# Contributing to `@dszp/netsapiens-lib`

Bug reports, ideas, and pull requests are welcome. This library is small and opinionated; the rules
below are the opinions, and each exists for a concrete reason rather than taste.

## Getting started

**Package manager: pnpm.** No runtime dependencies — please keep it that way.

```
pnpm install
pnpm build         # tsc → dist/ (dist/index.js + dist/index.d.ts)
pnpm test          # the offline suite — must pass with NO credentials and no setup
```

`pnpm test` must be green on a fresh clone with nothing configured. (`pnpm test:ns` is deliberately
excluded from it: that one needs a domain snapshot, which is customer data and correctly absent from
this repo.)

## The rules

### 1. Fixtures and examples must be fictional

Every domain, host, org, person, phone number, extension, and identifier in this repo — in code,
comments, tests, and the README — must be invented or reserved. No exceptions, including "just while
I debug."

Use [RFC 2606](https://www.rfc-editor.org/rfc/rfc2606) reserved names:

| Use | Prefer |
|---|---|
| domains / hosts | `example.com`, `example.net`, `example.org`, `*.example` |
| NetSapiens domains | `acme`, `testco` (bare) — or `acme.12345.service` when a suffix is the point |
| orgs / tenants | `acme`, `acme42`, `demo` |
| portal host | `manage.example.com` |
| people | `Alex Reseller`, `jordan@acme.example` |
| phone numbers | `555-01xx` / `13175550100`-style fictional-use numbers |

**A NetSapiens domain is an opaque string. Treat it as an identifier, never as parseable data.**

A domain may be **bare** (`acme`) or carry a **territory suffix** (`acme.12345.service`). Both shapes
are legitimate, both are common, and they coexist inside a single scope. Two facts drive this, and both
are permanent because **NetSapiens domains cannot be renamed**:

- **A suffix may be absent.** Plenty of domains are bare. A territory-using scope still contains them.
- **A suffix does not identify the owner.** Domains move between scopes and keep the name — and the
  suffix — they were created with, so one scope routinely spans *several* different territory suffixes.
  New domains take the current territory's suffix (that's what prevents collisions), which means the
  suffix records **where a domain was created, not who holds it now**.

Therefore: never infer ownership, scope, tenancy, or territory from a domain string, and never split
on `.` expecting three parts or a `.service` tail. Scope comes from the API and the token — ask, don't
parse. Any transform must be shape-agnostic (take the first label, don't require a suffix).

In fixtures, prefer **bare** domains, and reach for a suffixed one only when the suffix is the thing
under test. A test suite where every domain looks like `x.12345.service` quietly teaches the wrong
model and hides exactly this class of bug.

`src/resolver.selftest.ts` is the reference for what good looks like.

### 2. No real customer data, ever

Not in code, comments, tests, the README, **or a commit message**. That includes real customer names,
domains, DIDs, extensions, carrier hostnames, territory IDs, portal hosts, people, and email
addresses. A domain snapshot pulled from a live API is customer data end to end — never paste one into
an issue, a PR, or a fixture.

If you need a real value to reproduce a bug, describe its *shape* (`a DID whose dial rule targets an
AA whose menu routes into a time-of-day router`), not the value.

### 3. No defaults that bind the library to one deployment

A default encoding *someone's specific* server, tenant, issuer, or brand is a bug, not a convenience:
it silently couples every other consumer to a stranger's infrastructure, and — for an issuer — means
accepting tokens minted by a portal you don't control.

That's why `NsClient` requires `server`, and `verify()` requires `expectedIss` (or an explicit
`validateIss: false`) and **fails closed** when neither is given. `aud` defaults to `"ns"` because that
is fixed by the platform and true for every deployment. Apply that test to any default you add: *is
this true for everyone, or just for us?*

### 4. Branding arrives at runtime, never in source

`THEMES` ships vendor-neutral themes only. `ns-portal` matches the stock NetSapiens Manager Portal
scheme, which every deployment shares. A host that wants its own brand assigns into the registry at
startup from its own config — a brand color or white-label name must never be a literal here.

### 5. Doc comments are published API

They ship in `dist/*.d.ts` and surface on IDE hover for every consumer. A comment here is as public as
a function signature. Write for a stranger, and never park context in one that you wouldn't put in the
README. (`policy.ts`'s examples once read as a customer roster. Don't repeat that.)

### 6. Keep it Node-free

Never import `node:*` (`fs`, `path`, `crypto`, `Buffer`, …) anywhere in `src/`, except `*.selftest.ts`
files, which are excluded from the build. Use Web APIs — `fetch`, `atob`, `TextDecoder`,
`crypto.subtle`. `jwt.ts` decodes base64url without `Buffer` for exactly this reason.

It's enforced structurally: `tsconfig.json` sets `"types": []` with no `@types/node`, so a stray
`node:*` import fails `pnpm build`. Please don't add `@types/node` to make an error go away — the error
is the feature. It's what lets the same built output run in a Cloudflare Worker, in Node, and in a
browser.

### 7. The read/write split is a charter, not an oversight

`NsClient` exposes only `get()`. **Never add a mutating method to it.** Writes live in a separate,
explicitly-reviewed client — `NsWriteClient` — the point being that a consumer can hold `NsClient` and know
it cannot write. A new write capability extends `NsWriteClient` (or a sibling), never `NsClient`.

### 8. Never put data in a Mermaid ID position

`toMermaid()` emits synthetic `n<i>` IDs; NetSapiens data (hosts, params, applications containing
`.` `:` `@` `*` `<>` or spaces) goes only inside quoted labels. Data in an ID makes `mermaid.render()`
throw on real domains.

## Pull requests

- One logical change per PR; include a test.
- Run `pnpm build && pnpm test` before opening.
- Add a `CHANGELOG.md` entry under "Unreleased" for anything user-visible.
- Public API changes need a note on why the surface should grow — this library aims to stay small.
