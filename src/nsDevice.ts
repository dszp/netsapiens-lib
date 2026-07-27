/**
 * NetSapiens device orchestration — ensure a named device exists and hand back its SIP registration
 * password, optionally rotating it.
 *
 * This lives in the library because two separate consumers had grown their own copy of it, and a
 * divergence between them is expensive: they both provision the same softphone device for the same
 * extension, and disagreeing about whether to reuse or replace its credentials produces bugs that look
 * like a phone problem rather than a code problem. One implementation, one set of tests.
 *
 * Mechanism only — no policy. The device NAME is a caller-supplied string (a consumer's `<ext><suffix>`
 * convention is its own business), *whether* creation is permitted is the caller's decision, and *when*
 * rotation is appropriate is very much the caller's decision. See {@link ensureNsDevice}.
 */
import type { Rec } from './model.js';

/** The NS device field carrying the auto-generated SIP registration password (API v2). */
export const SIP_PW_FIELD = 'device-sip-registration-password';

/** The subset of a write client this needs. Structural, so a consumer can inject a mock or a subset. */
export interface NsDeviceWriter {
  getDevices(domain: string, user: string): Promise<Rec[]>;
  getDevice(domain: string, user: string, device: string): Promise<Rec>;
  createDevice(domain: string, user: string, device: string, extra?: Rec): Promise<Rec>;
  updateDevice(domain: string, user: string, device: string, changes: Rec): Promise<Rec>;
}

const PW_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PW_LOWER = 'abcdefghijklmnopqrstuvwxyz';
const PW_DIGIT = '0123456789';
const PW_ALPHABET = PW_UPPER + PW_LOWER + PW_DIGIT;

/** Uniformly-drawn characters from the alphabet, rejection-sampled so no symbol is over-represented. */
function randomChars(n: number): string[] {
  const out: string[] = [];
  const buf = new Uint8Array(n * 2);
  const limit = Math.floor(256 / PW_ALPHABET.length) * PW_ALPHABET.length; // 248 for a 62-symbol alphabet
  while (out.length < n) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= limit) continue; // reject, to keep the distribution uniform
      out.push(PW_ALPHABET[b % PW_ALPHABET.length]!);
      if (out.length === n) break;
    }
  }
  return out;
}

const hasEach = (s: string): boolean => /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s);

/**
 * Generate a SIP registration password.
 *
 * Alphanumeric only: the value travels through SIP digest auth, device provisioning templates, and
 * whatever the consuming app stores it in, and punctuation buys no meaningful entropy while risking an
 * escaping bug in any one of those. Characters are rejection-sampled rather than modulo-reduced, so every
 * symbol is equally likely.
 *
 * **Guarantees at least one uppercase, one lowercase, and one digit** (for `length >= 3`). A uniform draw
 * from a 62-symbol alphabet omits digits entirely about 3% of the time at length 20, which looks like a
 * bug to anyone who eyeballs one and can trip a downstream password-complexity rule. The whole candidate
 * is redrawn until it qualifies — never patched in place, which would bias the positions it patched.
 */
export function generateSipPassword(length = 20): string {
  if (!Number.isInteger(length) || length < 1) throw new Error('generateSipPassword: length must be a positive integer');
  // Below 3 characters the guarantee is arithmetically impossible; return a uniform draw.
  if (length < 3) return randomChars(length).join('');
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = randomChars(length).join('');
    if (hasEach(candidate)) return candidate;
  }
  // Unreachable in practice (the odds compound to ~0). Draw one character from each class DIRECTLY —
  // upper-casing an arbitrary draw is not a guarantee, since upper-casing a digit yields the same digit.
  const pick = (alphabet: string): string => {
    const b = new Uint8Array(1);
    const limit = Math.floor(256 / alphabet.length) * alphabet.length;
    for (;;) {
      crypto.getRandomValues(b);
      if (b[0]! < limit) return alphabet[b[0]! % alphabet.length]!;
    }
  };
  return [pick(PW_UPPER), pick(PW_LOWER), pick(PW_DIGIT), ...randomChars(length - 3)].join('');
}

export interface EnsureNsDeviceOptions {
  domain: string;
  /** The NS user / extension that owns the device. */
  user: string;
  /** The device name, e.g. `100r`. */
  device: string;
  /**
   * May this create the device when it is absent? Default `true`. Pass `false` to look without creating —
   * the result's `password` is then `''` for a missing device, which a caller can treat as "refuse".
   */
  mayCreate?: boolean;
  /**
   * Replace the password of a device that **already existed**.
   *
   * This closes a subtle and genuinely hard-to-diagnose failure: reusing the stored password leaves any
   * *other* endpoint still holding it with valid credentials for the same address-of-record. Both clients
   * then register, the most recent wins, and they trade the registration back and forth — intermittent
   * call failures with nothing obviously wrong in either system.
   *
   * Rotate only where something has just declared this device to belong to one client — a deliberate
   * activation or a first-time provision. **Do not rotate on a per-login or per-request path**: concurrent
   * runs would churn the credential and can race a re-registration.
   *
   * Rotation is **best-effort** and never throws: on failure the result carries the pre-existing password
   * plus `rotated: false` and `rotateError`, because failing the whole operation over a hardening step
   * would be worse than the contention it prevents. Notably a NetSapiens release without the device `PUT`
   * lands here.
   */
  rotateExisting?: boolean;
  /** Length for a rotated password. Default 20. */
  passwordLength?: number;
}

export interface EnsureNsDeviceResult {
  /** The SIP password to give the client. `''` means "absent and not created" — treat as a refusal. */
  password: string;
  /** True when this call created the device. */
  created: boolean;
  /** Present only when `rotateExisting` was requested: whether the rotation actually happened. */
  rotated?: boolean;
  /** Why rotation failed, when it did. */
  rotateError?: string;
}

/**
 * Ensure the device exists and return its SIP password.
 *
 * Present: read it back with a per-device GET, because a device *list* may omit the password. Absent:
 * create it (NetSapiens generates the password; a `synchronous` write returns it inline) unless
 * `mayCreate` is false.
 *
 * A newly created device is never rotated — it already has a fresh, exclusive password.
 */
export async function ensureNsDevice(writer: NsDeviceWriter, opts: EnsureNsDeviceOptions): Promise<EnsureNsDeviceResult> {
  const { domain, user, device } = opts;
  const devices = await writer.getDevices(domain, user);
  const existing = Array.isArray(devices) ? devices.find((d) => String(d['device'] ?? '') === device) : undefined;

  if (existing) {
    const dev = await writer.getDevice(domain, user, device);
    const current = String(dev[SIP_PW_FIELD] ?? existing[SIP_PW_FIELD] ?? '');
    if (!opts.rotateExisting) return { password: current, created: false };

    const fresh = generateSipPassword(opts.passwordLength ?? 20);
    try {
      const updated = await writer.updateDevice(domain, user, device, { [SIP_PW_FIELD]: fresh });
      // Prefer what NS echoes back if it echoes anything; otherwise the value we just set.
      // `||` not `??`: an echoed empty string would otherwise be handed back as the password, and the
      // caller's blank-password guard would refuse AFTER the device was already rotated.
      return { password: String(updated?.[SIP_PW_FIELD] || fresh), created: false, rotated: true };
    } catch (e) {
      return {
        password: current,
        created: false,
        rotated: false,
        rotateError: String((e as Error)?.message ?? e).slice(0, 200),
      };
    }
  }

  if (opts.mayCreate === false) return { password: '', created: false };
  const created = await writer.createDevice(domain, user, device);
  return { password: String(created?.[SIP_PW_FIELD] ?? ''), created: true };
}
