import { describe, it, expect } from "vitest";
import {
  checkServerCaps,
  REQUIRED_CAPS,
  CompatibilityError,
  serverSupportsCapability,
} from "../../src/caps";

const OK_CAPS = {
  restApi: REQUIRED_CAPS.restApi[0],
  oauth: REQUIRED_CAPS.oauth[0],
  pluginDbSync: REQUIRED_CAPS.pluginDbSync[0],
  attachmentShim: REQUIRED_CAPS.attachmentShim[0],
  documentEpoch: REQUIRED_CAPS.documentEpoch[0],
  documentInvalidation: REQUIRED_CAPS.documentInvalidation[0],
};

describe("checkServerCaps", () => {
  it("fails when caps is undefined", () => {
    expect(checkServerCaps(undefined)).toEqual({
      ok: false,
      reason: "server-incompatible",
      detail: "server did not advertise compatibility caps",
    });
    expect(checkServerCaps(undefined, [])).toEqual({
      ok: false,
      reason: "server-incompatible",
      detail: "server did not advertise compatibility caps",
    });
  });

  it("fails when caps is null", () => {
    expect(checkServerCaps(null)).toEqual({
      ok: false,
      reason: "server-incompatible",
      detail: "server did not advertise compatibility caps",
    });
  });

  it("fails when caps is a non-object", () => {
    expect(checkServerCaps("oops")).toEqual({
      ok: false,
      reason: "server-incompatible",
      detail: "server did not advertise compatibility caps",
    });
    expect(checkServerCaps(42)).toEqual({
      ok: false,
      reason: "server-incompatible",
      detail: "server did not advertise compatibility caps",
    });
  });

  it("fails when caps is an array", () => {
    expect(checkServerCaps([])).toEqual({
      ok: false,
      reason: "server-incompatible",
      detail: "server did not advertise compatibility caps",
    });
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

  it("accepts an older server without invalidations but does not enable the feature", () => {
    const { documentInvalidation: _omit, ...olderCaps } = OK_CAPS;
    void _omit;
    expect(checkServerCaps(olderCaps)).toEqual({ ok: true });
    expect(serverSupportsCapability(olderCaps, "documentInvalidation")).toBe(false);
  });

  it("enables invalidations only for the accepted cap value", () => {
    expect(serverSupportsCapability(OK_CAPS, "documentInvalidation")).toBe(true);
    expect(
      serverSupportsCapability(
        { ...OK_CAPS, documentInvalidation: "future-incompatible" },
        "documentInvalidation",
      ),
    ).toBe(false);
  });

  it("rejects a missing optional cap when the server marks it required", () => {
    const { documentInvalidation: _omit, ...olderCaps } = OK_CAPS;
    void _omit;
    const result = checkServerCaps(olderCaps, ["documentInvalidation"]);
    expect(result).toEqual({
      ok: false,
      reason: "server-incompatible",
      detail: 'server requires unsupported cap "documentInvalidation"',
    });
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
