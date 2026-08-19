import { describe, expect, test } from "bun:test";
import { redactText, sanitizeValue } from "../src/bootstrap/redact.ts";

describe("bootstrap redaction", () => {
  test("redacts common credential forms", () => {
    const text = "Bearer abcdefghijklmnop sk-secretsecretsecret --password hunter2 P='secret' redis://:secret@host BareSecret2026!";
    expect(redactText(text)).toBe(
      "Bearer [REDACTED] [REDACTED_KEY] --password [REDACTED] P=[REDACTED] redis://:[REDACTED]@host [REDACTED_CREDENTIAL]",
    );
  });

  test("redacts secret object fields without hiding ordinary keys", () => {
    expect(sanitizeValue({ apiKey: "secret", redisKey: "user:online", nested: { password: "pw" } }))
      .toEqual({ apiKey: "[REDACTED]", redisKey: "user:online", nested: { password: "[REDACTED]" } });
  });
});
