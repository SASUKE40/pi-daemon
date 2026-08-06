import { describe, expect, it } from "vitest";
import { redact } from "../src/log.js";

describe("redact", () => {
  it("redacts nested secret keys", () => {
    expect(redact({ token: "secret", nested: { apiKey: "key", safe: "value" } })).toEqual({
      token: "[REDACTED]",
      nested: { apiKey: "[REDACTED]", safe: "value" },
    });
  });

  it("redacts bearer tokens and JWTs in strings", () => {
    expect(redact("Bearer abc.def value eyJabc.eyJdef.signature")).not.toContain("abc.def");
  });
});
