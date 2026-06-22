import { describe, it, expect } from "vitest";
import { checkServerCaps, REQUIRED_CAPS, CompatibilityError } from "../../src/caps";

const OK_CAPS = {
  restApi: REQUIRED_CAPS.restApi[0],
  oauth: REQUIRED_CAPS.oauth[0],
  pluginDbSync: REQUIRED_CAPS.pluginDbSync[0],
  attachmentShim: REQUIRED_CAPS.attachmentShim[0],
};

describe("checkServerCaps", () => {
  it("proceeds when caps is undefined (old server, rollout window)", () => {
    expect(checkServerCaps(undefined)).toEqual({ ok: true });
    expect(checkServerCaps(undefined, [])).toEqual({ ok: true });
  });

  it("proceeds when caps is null", () => {
    expect(checkServerCaps(null)).toEqual({ ok: true });
  });

  it("proceeds when caps is a non-object (treat as missing)", () => {
    expect(checkServerCaps("oops")).toEqual({ ok: true });
    expect(checkServerCaps(42)).toEqual({ ok: true });
  });

  it("proceeds when caps is an array (treat as missing, not a map)", () => {
    expect(checkServerCaps([])).toEqual({ ok: true });
  });

  it("succeeds when all known caps match accepted values", () => {
    expect(checkServerCaps(OK_CAPS)).toEqual({ ok: true });
    expect(checkServerCaps(OK_CAPS, [])).toEqual({ ok: true });
  });

  it("fails with server-incompatible when a mandatory cap is missing", () => {
    const { restApi: _omit, ...rest } = OK_CAPS;
    void _omit;
    const r = checkServerCaps(rest);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("server-incompatible");
      expect(r.detail).toContain("restApi");
    }
  });

  it("fails with server-incompatible when a cap value is not accepted", () => {
    const r = checkServerCaps({ ...OK_CAPS, restApi: "99" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("server-incompatible");
      // Direction is unknown for opaque strings; never "client-too-old" here.
      expect(r.detail).toContain("restApi");
    }
  });

  it("fails with server-incompatible when a cap value is non-string", () => {
    const r = checkServerCaps({ ...OK_CAPS, restApi: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("server-incompatible");
  });

  it("ignores unknown cap names not listed in requiredCaps", () => {
    const r = checkServerCaps({ ...OK_CAPS, futureOptionalCap: "v3" });
    expect(r).toEqual({ ok: true });
  });

  it("fails with client-too-old when an unknown cap is in requiredCaps", () => {
    const r = checkServerCaps(OK_CAPS, ["futureMandatoryCap"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("client-too-old");
      expect(r.detail).toContain("futureMandatoryCap");
    }
  });

  it("ignores requiredCaps entries that the client already knows", () => {
    const r = checkServerCaps(OK_CAPS, ["restApi"]);
    expect(r).toEqual({ ok: true });
  });

  it("ignores non-string requiredCaps entries", () => {
    const r = checkServerCaps(OK_CAPS, [42, null, "restApi"]);
    expect(r).toEqual({ ok: true });
  });

  it("ignores non-array requiredCaps", () => {
    const r = checkServerCaps(OK_CAPS, "not-an-array");
    expect(r).toEqual({ ok: true });
  });
});

describe("CompatibilityError", () => {
  it("carries reason and serverVersion separately from the message", () => {
    const err = new CompatibilityError("server-incompatible", "detail here", "0.4.2");
    expect(err.name).toBe("CompatibilityError");
    expect(err.reason).toBe("server-incompatible");
    expect(err.serverVersion).toBe("0.4.2");
    expect(err.message).toBe("detail here");
    expect(err).toBeInstanceOf(Error);
  });

  it("allows omitting serverVersion", () => {
    const err = new CompatibilityError("client-too-old", "detail");
    expect(err.serverVersion).toBeUndefined();
  });
});
