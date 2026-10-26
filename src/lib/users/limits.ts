/**
 * Failure counters for sign-in and sign-up, per process and in memory (Locus
 * is one Node process on one laptop). `isLimited` turns true once `max`
 * failures have happened inside `windowMs`, and stays true until that window
 * has passed.
 */
export class FailureLimiter {
  private entries = new Map<string, { count: number; start: number }>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  isLimited(key: string): boolean {
    const e = this.entries.get(key);
    if (!e) return false;
    if (this.now() - e.start > this.windowMs) {
      this.entries.delete(key);
      return false;
    }
    return e.count >= this.max;
  }

  record(key: string): void {
    const e = this.entries.get(key);
    if (!e || this.now() - e.start > this.windowMs) this.entries.set(key, { count: 1, start: this.now() });
    else e.count += 1;
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  reset(): void {
    this.entries.clear();
  }
}

const MIN = 60_000;

// The existing one-passcode login keys on the first x-forwarded-for entry, which a caller can set to
// anything. These key on the address a proxy added (see callerIp) -- and every limit that guards the
// admin account or account creation also has a global ceiling that a spoofed address can't get around.
export const signInByAddress = new FailureLimiter(5, 5 * MIN);
export const signInByUsername = new FailureLimiter(5, 5 * MIN);
export const adminSignInGlobal = new FailureLimiter(10, 15 * MIN);
export const signUpByAddress = new FailureLimiter(5, 60 * MIN);
export const signUpGlobal = new FailureLimiter(30, 60 * MIN);

export function _resetUserLimitersForTests(): void {
  for (const l of [signInByAddress, signInByUsername, adminSignInGlobal, signUpByAddress, signUpGlobal]) l.reset();
}
