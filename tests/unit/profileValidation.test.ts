import { describe, it, expect } from "vitest";
import { validateAvatarUrl } from "../../src/auth";

describe("validateAvatarUrl", () => {
  it("accepts an empty/whitespace value (means: clear, fall back to OpenID picture)", () => {
    expect(validateAvatarUrl("")).toBeNull();
    expect(validateAvatarUrl("   ")).toBeNull();
  });

  it("accepts a valid https URL", () => {
    expect(validateAvatarUrl("https://example.com/a.png")).toBeNull();
  });

  it("accepts a valid http URL", () => {
    expect(validateAvatarUrl("http://localhost:8080/avatar.jpg")).toBeNull();
  });

  it("rejects a javascript: URL", () => {
    expect(validateAvatarUrl("javascript:alert(1)")).not.toBeNull();
  });

  it("rejects an ftp: URL", () => {
    expect(validateAvatarUrl("ftp://example.com/a.png")).not.toBeNull();
  });

  it("rejects a URL with whitespace", () => {
    expect(validateAvatarUrl("https://exa mple.com/a.png")).not.toBeNull();
  });

  it("rejects a URL with a newline", () => {
    expect(validateAvatarUrl("https://example.com/a\n.png")).not.toBeNull();
  });

  it("rejects an over-long URL (> 2048 bytes)", () => {
    const long = `https://example.com/${"a".repeat(2040)}`;
    expect(validateAvatarUrl(long)).not.toBeNull();
  });

  it("rejects a non-URL string", () => {
    expect(validateAvatarUrl("not a url")).not.toBeNull();
  });
});
