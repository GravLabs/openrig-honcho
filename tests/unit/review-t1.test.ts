// Review T1 (dev.review). F1: the cloud-host guard misses the FQDN form of a
// honcho.dev hostname (single trailing dot): new URL("https://api.honcho.dev./v3")
// keeps the trailing dot in hostname, so isCloudHost's === / endsWith checks
// both miss it and the plugin ENABLES with a URL that resolves to the same
// cloud host (DNS treats "api.honcho.dev." and "api.honcho.dev" as identical).
// ADR-0001: "A host matching *.honcho.dev or api.honcho.dev is refused."
// Suggested fix: normalise `host.replace(/\.$/, "")` before comparing.
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../plugin/src/env.ts";

const base: Record<string, string> = {
  HONCHO_URL: "http://localhost:8000/v3",
  HONCHO_WORKSPACE: "honcho-bridge-scratch-unit",
  HONCHO_PEER: "dev-review",
  HOME: "/home/test",
};

function result(overrides: Record<string, string | undefined> = {}) {
  return loadConfig({ ...base, ...overrides });
}

function reason(url: string): string {
  const res = result({ HONCHO_URL: url });
  if (res.enabled) throw new Error(`expected Disabled for ${url}, got Config`);
  return res.reason;
}

describe("review T1 F1: cloud-host guard (ADR-0001)", () => {
  for (const url of [
    "https://api.honcho.dev/v3",
    "https://honcho.dev/v3",
    "https://acme.honcho.dev/v3",
    "https://API.HONCHO.DEV/v3",
    "http://x@api.honcho.dev/v3",
  ]) {
    test(`refuses ${url}`, () => {
      expect(reason(url)).toContain("cloud host");
    });
  }

  // These three FAIL on 2b62a8d: trailing-dot (FQDN) cloud hosts are enabled.
  for (const url of [
    "https://api.honcho.dev./v3",
    "https://honcho.dev./v3",
    "https://acme.honcho.dev./v3",
  ]) {
    test(`refuses trailing-dot ${url}`, () => {
      expect(reason(url)).toContain("cloud host");
    });
  }

  test("a non-cloud host with a trailing dot still enables (fix must not over-block)", () => {
    expect(result({ HONCHO_URL: "http://honcho.example./v3" }).enabled).toBe(true);
  });
});

describe("review T1: id edges", () => {
  for (const bad of ["../", "a b", "dév", "a\nb", "a".repeat(101)]) {
    test(`workspace id ${JSON.stringify(bad)} disables`, () => {
      expect(result({ HONCHO_WORKSPACE: bad }).enabled).toBe(false);
    });
  }

  test("empty required id disables as required", () => {
    const res = result({ HONCHO_PEER: "" });
    expect(res.enabled).toBe(false);
    if (!res.enabled) expect(res.reason).toContain("required");
  });
});
