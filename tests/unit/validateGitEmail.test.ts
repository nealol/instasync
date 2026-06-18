import { describe, it, expect } from "vitest";
import { validateGitEmail } from "../../src/auth";

describe("validateGitEmail", () => {
  it("accepts a normal email", () => {
    expect(validateGitEmail("alice@example.com")).toBeNull();
  });

  it("accepts a plus-tagged local part", () => {
    expect(validateGitEmail("alice+git@example.com")).toBeNull();
  });

  it("accepts an empty/whitespace value (means: clear, fall back to login email)", () => {
    expect(validateGitEmail("")).toBeNull();
    expect(validateGitEmail("   ")).toBeNull();
  });

  it("rejects trailer injection via a closing angle bracket + newline", () => {
    expect(validateGitEmail("a@b.com>\nSigned-off-by: attacker <a@x>\n")).not.toBeNull();
  });

  it("rejects CRLF trailer injection", () => {
    expect(validateGitEmail("a@b.com\r\nX: y")).not.toBeNull();
  });

  it("rejects angle brackets in the local part", () => {
    expect(validateGitEmail("alice<@example.com")).not.toBeNull();
  });

  it("rejects whitespace in the local part", () => {
    expect(validateGitEmail("alice @example.com")).not.toBeNull();
  });

  it("rejects a newline in the local part", () => {
    expect(validateGitEmail("alice\n@example.com")).not.toBeNull();
  });

  it("rejects a value with no '@'", () => {
    expect(validateGitEmail("not-an-email")).not.toBeNull();
  });

  it("rejects an empty domain", () => {
    expect(validateGitEmail("alice@")).not.toBeNull();
  });

  it("rejects an empty local part", () => {
    expect(validateGitEmail("@example.com")).not.toBeNull();
  });

  it("rejects a domain without a dot", () => {
    expect(validateGitEmail("alice@example")).not.toBeNull();
  });

  it("rejects multiple '@'", () => {
    expect(validateGitEmail("a@b@example.com")).not.toBeNull();
  });

  it("rejects a NUL byte even in an otherwise-valid email", () => {
    expect(validateGitEmail("alice\x00@example.com")).not.toBeNull();
  });

  it("rejects an over-long value", () => {
    const local = "a".repeat(250);
    expect(validateGitEmail(`${local}@x.co`)).not.toBeNull();
  });
});
