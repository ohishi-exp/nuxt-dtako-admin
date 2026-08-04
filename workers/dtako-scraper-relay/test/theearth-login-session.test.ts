import { describe, expect, it } from "vitest";
import {
  ABSOLUTE_TTL_MS,
  decideRelogin,
  IDLE_TTL_MS,
  isEntryReusable,
  MAX_RELOGIN_ATTEMPTS_PER_JOB,
  MIN_SESSION_LIFETIME_MS,
  type LoginSessionEntry,
} from "../src/theearth-login-session";

const COMP_ID = "27324455";
const NOW = 1_800_000_000_000;

function entry(overrides: Partial<LoginSessionEntry<string>> = {}): LoginSessionEntry<string> {
  return {
    compId: COMP_ID,
    jar: "jar",
    loggedInAt: NOW,
    lastUsedAt: NOW,
    ...overrides,
  };
}

describe("isEntryReusable", () => {
  it("entry が無ければ false", () => {
    expect(isEntryReusable(null, COMP_ID, NOW)).toBe(false);
  });

  it("comp_id が違えば false", () => {
    expect(isEntryReusable(entry(), "別のcomp", NOW)).toBe(false);
  });

  it("idle TTL 超過なら false", () => {
    const e = entry({ lastUsedAt: NOW - IDLE_TTL_MS });
    expect(isEntryReusable(e, COMP_ID, NOW)).toBe(false);
  });

  it("idle TTL ちょうど手前なら true になりうる (絶対上限内なら)", () => {
    const e = entry({ loggedInAt: NOW - (IDLE_TTL_MS - 1), lastUsedAt: NOW - (IDLE_TTL_MS - 1) });
    expect(isEntryReusable(e, COMP_ID, NOW)).toBe(true);
  });

  it("絶対上限超過なら (idle 内でも) false", () => {
    const e = entry({ loggedInAt: NOW - ABSOLUTE_TTL_MS, lastUsedAt: NOW });
    expect(isEntryReusable(e, COMP_ID, NOW)).toBe(false);
  });

  it("comp_id 一致・両 TTL 内なら true", () => {
    const e = entry({ loggedInAt: NOW - 1000, lastUsedAt: NOW - 500 });
    expect(isEntryReusable(e, COMP_ID, NOW)).toBe(true);
  });
});

describe("decideRelogin", () => {
  it("予算 (MAX_RELOGIN_ATTEMPTS_PER_JOB) を使い切っていたら discardedEntry に関わらず false", () => {
    const d = decideRelogin(entry({ loggedInAt: NOW - 10 * 60 * 1000 }), NOW, MAX_RELOGIN_ATTEMPTS_PER_JOB);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/予算/);
  });

  it("discardedEntry のログインからの経過が最短寿命未満なら false", () => {
    const d = decideRelogin(entry({ loggedInAt: NOW - (MIN_SESSION_LIFETIME_MS - 1) }), NOW, 0);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/並行ログイン/);
  });

  it("discardedEntry のログインからの経過が最短寿命ちょうどなら許可 (未満のみ拒否)", () => {
    const d = decideRelogin(entry({ loggedInAt: NOW - MIN_SESSION_LIFETIME_MS }), NOW, 0);
    expect(d.allow).toBe(true);
    expect(d.reason).toBeUndefined();
  });

  it("discardedEntry が null (最短寿命ガード適用不能) でも予算内なら許可", () => {
    const d = decideRelogin(null, NOW, 0);
    expect(d.allow).toBe(true);
  });

  it("予算内・最短寿命クリアなら許可", () => {
    const d = decideRelogin(entry({ loggedInAt: NOW - 5 * 60 * 1000 }), NOW, MAX_RELOGIN_ATTEMPTS_PER_JOB - 1);
    expect(d.allow).toBe(true);
    expect(d.reason).toBeUndefined();
  });
});
