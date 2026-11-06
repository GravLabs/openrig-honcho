import { describe, expect, test } from "bun:test";
import { loadConfig, type Config } from "../../plugin/src/env.ts";

// Minimal valid environment. Unit tests never touch the network.
const base: Record<string, string> = {
  HONCHO_URL: "http://localhost:8000/v3",
  HONCHO_WORKSPACE: "honcho-bridge-scratch-unit",
  HONCHO_PEER: "dev-build",
  HOME: "/home/test",
};

function full(overrides: Record<string, string | undefined> = {}): Config {
  const res = loadConfig({ ...base, ...overrides });
  if (!res.enabled) throw new Error(`expected Config, got Disabled: ${res.reason}`);
  return res;
}

function reason(overrides: Record<string, string | undefined>): string {
  const res = loadConfig({ ...base, ...overrides });
  if (res.enabled) throw new Error("expected Disabled, got Config");
  return res.reason;
}

describe("HONCHO_ENABLED", () => {
  test("defaults to enabled", () => {
    expect(full().enabled).toBe(true);
  });

  for (const off of ["false", "FALSE", "False", "0", "no", "off", " OFF "]) {
    test(`"${off}" disables`, () => {
      const res = loadConfig({ ...base, HONCHO_ENABLED: off });
      expect(res.enabled).toBe(false);
    });
  }

  test("kill switch with all other vars missing still returns Disabled, not an error", () => {
    const res = loadConfig({ HONCHO_ENABLED: "false" });
    expect(res.enabled).toBe(false);
    if (!res.enabled) expect(res.reason.length).toBeGreaterThan(0);
  });

  test("an unrecognised value keeps the default (enabled)", () => {
    expect(full({ HONCHO_ENABLED: "maybe" }).enabled).toBe(true);
  });
});

describe("HONCHO_URL", () => {
  test("is required", () => {
    expect(reason({ HONCHO_URL: undefined })).toContain("HONCHO_URL");
  });

  test("api.honcho.dev is refused", () => {
    const r = reason({ HONCHO_URL: "https://api.honcho.dev/v3" });
    expect(r).toContain("HONCHO_URL");
  });

  test("*.honcho.dev is refused", () => {
    expect(reason({ HONCHO_URL: "https://acme.honcho.dev/v3" })).toContain("HONCHO_URL");
  });

  test("a non-cloud host is accepted", () => {
    expect(full({ HONCHO_URL: "http://localhost:8000/v3" }).url).toBe(
      "http://localhost:8000/v3",
    );
  });

  test("an unparseable URL disables", () => {
    expect(reason({ HONCHO_URL: "not a url" })).toContain("HONCHO_URL");
  });

  // F3: new URL() parses any scheme; only http(s) can reach a Honcho server.
  test("a non-http scheme disables", () => {
    expect(reason({ HONCHO_URL: "gopher://x.invalid/v3" })).toContain("HONCHO_URL");
    expect(reason({ HONCHO_URL: "file:///v3" })).toContain("HONCHO_URL");
    expect(reason({ HONCHO_URL: "ftp://localhost:8000/v3" })).toContain("HONCHO_URL");
    expect(reason({ HONCHO_URL: "localhost:8000/v3" })).toContain("HONCHO_URL");
  });

  test("http to a self-hosted host is accepted", () => {
    expect(full({ HONCHO_URL: "http://localhost:8000/v3" }).url).toBe(
      "http://localhost:8000/v3",
    );
  });

  test("https to a self-hosted host is accepted", () => {
    expect(full({ HONCHO_URL: "https://honcho.internal:8443/v3" }).url).toBe(
      "https://honcho.internal:8443/v3",
    );
  });
});

describe("HONCHO_WORKSPACE", () => {
  test("is required", () => {
    expect(reason({ HONCHO_WORKSPACE: undefined })).toContain("HONCHO_WORKSPACE");
  });

  test("a bad id disables", () => {
    expect(reason({ HONCHO_WORKSPACE: "bad workspace!" })).toContain("HONCHO_WORKSPACE");
  });
});

describe("HONCHO_PEER", () => {
  test("is required", () => {
    expect(reason({ HONCHO_PEER: undefined })).toContain("HONCHO_PEER");
  });

  test("a bad peer id is refused", () => {
    expect(reason({ HONCHO_PEER: "has spaces" })).toContain("HONCHO_PEER");
  });

  test("100 id characters are accepted", () => {
    const id = "a".repeat(100);
    expect(full({ HONCHO_PEER: id }).peer).toBe(id);
  });

  test("101 id characters are refused", () => {
    expect(reason({ HONCHO_PEER: "a".repeat(101) })).toContain("HONCHO_PEER");
  });
});

describe("HONCHO_OBSERVE_OTHERS", () => {
  test("defaults to false", () => {
    expect(full().observeOthers).toBe(false);
  });

  test("true marks the leader", () => {
    expect(full({ HONCHO_OBSERVE_OTHERS: "true" }).observeOthers).toBe(true);
  });
});

describe("HONCHO_LEADER_PEER (T6a-fix, F-T6a-1)", () => {
  test("unset stays undefined", () => {
    expect(full().leaderPeer).toBeUndefined();
  });

  test("set is exposed as config.leaderPeer", () => {
    expect(full({ HONCHO_LEADER_PEER: "lead" }).leaderPeer).toBe("lead");
  });

  test("empty string behaves as unset", () => {
    expect(full({ HONCHO_LEADER_PEER: "" }).leaderPeer).toBeUndefined();
  });

  test("a bad id disables, naming the variable", () => {
    expect(reason({ HONCHO_LEADER_PEER: "bad leader!" })).toContain("HONCHO_LEADER_PEER");
  });

  test("observe_others true without a leader: leaderPeer defaults to this peer", () => {
    expect(full({ HONCHO_OBSERVE_OTHERS: "true" }).leaderPeer).toBe("dev-build");
  });

  test("an explicit leader wins over the observe_others default", () => {
    expect(full({ HONCHO_OBSERVE_OTHERS: "true", HONCHO_LEADER_PEER: "chief" }).leaderPeer).toBe("chief");
  });
});

describe("HONCHO_OWNER_PEER", () => {
  test("defaults to owner", () => {
    expect(full().ownerPeer).toBe("owner");
  });

  test("can be overridden", () => {
    expect(full({ HONCHO_OWNER_PEER: "chief" }).ownerPeer).toBe("chief");
  });

  test("a bad id disables", () => {
    expect(reason({ HONCHO_OWNER_PEER: "bad id!" })).toContain("HONCHO_OWNER_PEER");
  });
});

describe("HONCHO_PROFILE_WORKSPACE", () => {
  test("defaults to unset (null)", () => {
    expect(full().profileWorkspace).toBeNull();
  });

  test("when set, is carried through", () => {
    expect(full({ HONCHO_PROFILE_WORKSPACE: "my-profile" }).profileWorkspace).toBe(
      "my-profile",
    );
  });

  test("a bad id disables", () => {
    expect(reason({ HONCHO_PROFILE_WORKSPACE: "bad/id" })).toContain(
      "HONCHO_PROFILE_WORKSPACE",
    );
  });
});

describe("HONCHO_RECORD_AUTOMATION", () => {
  test("defaults to false", () => {
    expect(full().recordAutomation).toBe(false);
  });

  test("true enables recording automation", () => {
    expect(full({ HONCHO_RECORD_AUTOMATION: "true" }).recordAutomation).toBe(true);
  });
});

describe("HONCHO_API_KEY", () => {
  test("defaults to local", () => {
    expect(full().apiKey).toBe("local");
  });

  test("when set, is carried through", () => {
    expect(full({ HONCHO_API_KEY: "anything" }).apiKey).toBe("anything"); // fake-secret
  });

  test("set-but-empty disables, naming the variable", () => {
    expect(reason({ HONCHO_API_KEY: "" })).toContain("HONCHO_API_KEY");
  });

  test("the key value never appears in a disabled reason", () => {
    const fakeKey = "sk-ant-fakekey-DO-NOT-LOG-0123456789abcdef"; // fake-secret
    const r = reason({ HONCHO_API_KEY: fakeKey, HONCHO_WORKSPACE: "bad workspace!" }); // fake-secret
    expect(r).not.toContain(fakeKey);
  });
});

describe("HONCHO_STATE_DIR", () => {
  test("defaults to $HOME/.openrig-honcho", () => {
    expect(full().stateDir).toBe("/home/test/.openrig-honcho");
  });

  test("when set, is used as given", () => {
    expect(full({ HONCHO_STATE_DIR: "/tmp/honcho-state" }).stateDir).toBe("/tmp/honcho-state");
  });

  test("unset with no HOME disables", () => {
    const res = loadConfig({ ...base, HOME: undefined, HONCHO_STATE_DIR: undefined });
    expect(res.enabled).toBe(false);
  });
});

describe("HONCHO_TIMEOUT_MS", () => {
  test("defaults to 3000", () => {
    expect(full().timeoutMs).toBe(3000);
  });

  test("when set, is parsed as a number", () => {
    expect(full({ HONCHO_TIMEOUT_MS: "1500" }).timeoutMs).toBe(1500);
  });

  test("a non-integer disables", () => {
    expect(reason({ HONCHO_TIMEOUT_MS: "soon" })).toContain("HONCHO_TIMEOUT_MS");
  });

  // ADR-0001 (T2c): integer 1..60000, no clamping - anything else disables
  // with a reason naming the variable.
  test("boundaries accepted: 1 and 60000", () => {
    expect(full({ HONCHO_TIMEOUT_MS: "1" }).timeoutMs).toBe(1);
    expect(full({ HONCHO_TIMEOUT_MS: "60000" }).timeoutMs).toBe(60000);
  });

  for (const bad of ["0", "60001", "99999999999", "1.5", "abc", "1e3"]) {
    test(`rejected: "${bad}" disables naming the variable`, () => {
      expect(reason({ HONCHO_TIMEOUT_MS: bad })).toContain("HONCHO_TIMEOUT_MS");
    });
  }
});

describe("loadConfig purity", () => {
  test("does not read process.env", () => {
    // The env passed in is fully explicit; process.env here has no HONCHO_* names
    // that differ from `base`, so a pure function cannot be distinguished from
    // an impure one that also got exactly these values. Assert the concrete
    // defaults we rely on instead: no HOME from process.env leaks in.
    const res = loadConfig({ ...base, HOME: "/explicit/home" });
    if (res.enabled) expect(res.stateDir).toBe("/explicit/home/.openrig-honcho");
  });
});

// ADR-0008 Decision 2 (T12a): per-seat defaults for a shared working
// directory. An explicit HONCHO_PEER always wins; the session name is only a
// fallback, and its VALUE never appears in a disabled reason.
describe("OPENRIG_SESSION_NAME peer fallback (ADR-0008, T12a)", () => {
  const noPeer = { HONCHO_PEER: undefined };

  test("peer taken from the session name up to the first @", () => {
    expect(full({ ...noPeer, OPENRIG_SESSION_NAME: "dev-build@openrig-honcho" }).peer).toBe("dev-build");
  });

  test("a@b@c resolves to a (split on the FIRST @ only)", () => {
    expect(full({ ...noPeer, OPENRIG_SESSION_NAME: "a@b@c" }).peer).toBe("a");
  });

  test("explicit HONCHO_PEER beats the session name", () => {
    expect(full({ OPENRIG_SESSION_NAME: "someone-else@r" }).peer).toBe("dev-build");
  });

  test("a blank (whitespace) HONCHO_PEER falls back like an unset one", () => {
    expect(full({ HONCHO_PEER: "   ", OPENRIG_SESSION_NAME: "seat-x@r" }).peer).toBe("seat-x");
  });

  test("@x -> disabled: the reason names OPENRIG_SESSION_NAME, never the value", () => {
    const r = reason({ ...noPeer, OPENRIG_SESSION_NAME: "@x" });
    expect(r).toContain("OPENRIG_SESSION_NAME");
    expect(r).not.toContain("@x");
  });

  test("a session prefix failing the id rule -> same named-variable reason, value unprinted", () => {
    const r = reason({ ...noPeer, OPENRIG_SESSION_NAME: "not an id@weird rig" });
    expect(r).toContain("OPENRIG_SESSION_NAME");
    expect(r).not.toContain("not an id");
    expect(r).not.toContain("weird");
  });

  test("neither set -> required, and the reason mentions the fallback too", () => {
    const r = reason(noPeer);
    expect(r).toContain("HONCHO_PEER");
    expect(r).toContain("OPENRIG_SESSION_NAME");
  });

  test("plain claude with no session name stays disabled (ADR-0008: off for people)", () => {
    expect(reason({ ...noPeer, OPENRIG_SESSION_NAME: "" })).toContain("HONCHO_PEER");
  });
});

describe("rig derivation from OPENRIG_SESSION_NAME (T16b, ADR-0011 decision 3)", () => {
  test("part after the LAST @ becomes cfg.rig (one place, both bins use it)", () => {
    expect(full({ OPENRIG_SESSION_NAME: "dev-build@rig-x" }).rig).toBe("rig-x");
    expect(full({ OPENRIG_SESSION_NAME: "a@b@c" }).rig).toBe("c"); // peerIdFromSession's rule
  });

  test("no @, or a rig part failing the id rule -> rig absent (use sites fall back to workspace)", () => {
    expect(full({}).rig).toBeUndefined(); // base env: no session name at all
    expect(full({ OPENRIG_SESSION_NAME: "plainseat" }).rig).toBeUndefined();
    expect(full({ OPENRIG_SESSION_NAME: "x@bad rig" }).rig).toBeUndefined();
    expect(full({ OPENRIG_SESSION_NAME: "x@" }).rig).toBeUndefined();
  });

  test("a session name with a valid rig does not disturb an explicit HONCHO_PEER", () => {
    const c = full({ HONCHO_PEER: "review", OPENRIG_SESSION_NAME: "build@pilot" });
    expect(c.peer).toBe("review");
    expect(c.rig).toBe("pilot");
  });
});

describe("HONCHO_RECALL_MAX_DISTANCE (T16b, ADR-0011 decision 1)", () => {
  test("default 0.45; unset or empty keeps it", () => {
    expect(full().recallMaxDistance).toBe(0.45);
    expect(full({ HONCHO_RECALL_MAX_DISTANCE: "" }).recallMaxDistance).toBe(0.45);
    expect(full({ HONCHO_RECALL_MAX_DISTANCE: "  " }).recallMaxDistance).toBe(0.45);
  });

  for (const v of ["0.05", "0.45", "1", " 0.6 ", "1.0", "0.050"]) {
    test(`"${v}" is accepted as a number`, () => {
      expect(full({ HONCHO_RECALL_MAX_DISTANCE: v }).recallMaxDistance).toBe(Number(v.trim()));
    });
  }

  for (const v of ["0.049", "0", "-0.5", "1.01", "2", "abc", "0.5.5", "0x0.5", "nan"]) {
    test(`"${v}" disables the plugin with the named reason`, () => {
      const r = reason({ HONCHO_RECALL_MAX_DISTANCE: v });
      expect(r).toContain("HONCHO_RECALL_MAX_DISTANCE");
      // reason never carries the value (skipped for one-char values, whose
      // digits appear inside the rule text itself: "0.05 and 1")
      if (v.trim().length >= 3) expect(r).not.toContain(v.trim());
    });
  }
});

describe("HONCHO_RECALL_HOLDOUT (T18b, ADR-0013 decision 2)", () => {
  test("default 0; unset, empty or blank keeps it", () => {
    expect(full().recallHoldout).toBe(0);
    expect(full({ HONCHO_RECALL_HOLDOUT: "" }).recallHoldout).toBe(0);
    expect(full({ HONCHO_RECALL_HOLDOUT: "  " }).recallHoldout).toBe(0);
  });

  for (const v of ["0", "0.1", "0.5", " 0.7 ", "0.9", "0.90"]) {
    test(`"${v}" is accepted as a number`, () => {
      expect(full({ HONCHO_RECALL_HOLDOUT: v }).recallHoldout).toBe(Number(v.trim()));
    });
  }

  for (const v of ["0.95", "1", "-0.1", "2", "abc", "0.5.5", "nan"]) {
    test(`"${v}" disables the plugin with the named reason`, () => {
      const r = reason({ HONCHO_RECALL_HOLDOUT: v });
      expect(r).toContain("HONCHO_RECALL_HOLDOUT");
      // reason names the variable, never the value
      if (v.trim().length >= 3) expect(r).not.toContain(v.trim());
    });
  }
});

describe("HONCHO_OBSERVE_OTHERS leader default (ADR-0008, T12a)", () => {
  test("leader peer set to the resolved seat + unset observe -> true", () => {
    const c = full({ HONCHO_LEADER_PEER: "dev-build" });
    expect(c.observeOthers).toBe(true);
    expect(c.leaderPeer).toBe("dev-build");
  });

  test('leader + explicit "false" -> false (explicit wins, even on the leader)', () => {
    expect(full({ HONCHO_LEADER_PEER: "dev-build", HONCHO_OBSERVE_OTHERS: "false" }).observeOthers).toBe(false);
  });

  test("leader unset + unset observe -> false (v0.1.0 meaning kept)", () => {
    expect(full().observeOthers).toBe(false);
  });

  test("leader is ANOTHER seat + unset observe -> false", () => {
    expect(full({ HONCHO_LEADER_PEER: "lead-seat" }).observeOthers).toBe(false);
  });

  test("explicit true without a leader still makes the seat its own leader (E4 kept)", () => {
    const c = full({ HONCHO_OBSERVE_OTHERS: "true" });
    expect(c.observeOthers).toBe(true);
    expect(c.leaderPeer).toBe("dev-build");
  });
});

describe("OPENRIG_URL / OPENRIG_SESSION_NAME (T16f, ADR-0012 d2)", () => {
  test("http(s) URL is accepted with trailing slashes trimmed", () => {
    expect(full({ OPENRIG_URL: "http://127.0.0.1:7433" }).daemonUrl).toBe("http://127.0.0.1:7433");
    expect(full({ OPENRIG_URL: "https://rig.example/api///" }).daemonUrl).toBe("https://rig.example/api");
  });

  test("garbage or non-http scheme behaves like unset - and never disables the plugin", () => {
    expect("daemonUrl" in full({ OPENRIG_URL: "not a url" })).toBe(false);
    expect("daemonUrl" in full({ OPENRIG_URL: "ftp://x" })).toBe(false);
    expect("daemonUrl" in full({ OPENRIG_URL: "   " })).toBe(false);
    expect("daemonUrl" in full({ OPENRIG_URL: "" })).toBe(false);
  });

  test("sessionName is the raw session name; empty or unset gives no field", () => {
    expect(full({ OPENRIG_SESSION_NAME: "dev-build@openrig-honcho" }).sessionName).toBe(
      "dev-build@openrig-honcho",
    );
    expect("sessionName" in full({ OPENRIG_SESSION_NAME: "" })).toBe(false);
    expect("sessionName" in full({})).toBe(false);
  });
});
