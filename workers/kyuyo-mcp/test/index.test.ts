import { describe, expect, it } from "vitest";
import app from "../src/index";
import type { Env } from "../src/env";

const baseEnv = { AUTH_WORKER_ORIGIN: "https://auth-staging.test" } as Env;

describe("GET /healthz", () => {
  it("returns ok + service without deploy metadata (local/dev 既定)", async () => {
    const res = await app.request("/healthz", {}, baseEnv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      service: "kyuyo-mcp",
      git_sha: "unknown",
      cf_version: null,
    });
  });

  it("returns git_sha and cf_version when the deploy injected them", async () => {
    const env: Env = {
      ...baseEnv,
      GIT_SHA: "abc123",
      CF_VERSION_METADATA: { id: "v-1", tag: "", timestamp: "2026-07-23T00:00:00Z" },
    };
    const res = await app.request("/healthz", {}, env);
    expect(await res.json()).toEqual({
      ok: true,
      service: "kyuyo-mcp",
      git_sha: "abc123",
      cf_version: { id: "v-1", tag: "" },
    });
  });
});
