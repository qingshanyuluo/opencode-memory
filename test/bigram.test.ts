import { describe, expect, test } from "bun:test";
import { bigrams, cosineSimilarity, similarPairs } from "../src/similarity/bigram.ts";

describe("bigram similarity", () => {
  test("measures cosine similarity between Chinese short texts", () => {
    const a = bigrams("SLS 日志查询");
    const b = bigrams("SLS 日志排查");
    const c = bigrams("舔狗冷静期");
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.5);
    expect(cosineSimilarity(a, c)).toBe(0);
  });

  test("finds similar pairs above threshold via inverted index", () => {
    const pairs = similarPairs([
      { id: "a", text: "日志排障" },
      { id: "b", text: "日志诊断" },
      { id: "c", text: "Redis 缓存雪崩" },
    ], 0.2);
    expect(pairs.some(({ a, b }) => (a === "a" && b === "b") || (a === "b" && b === "a"))).toBeTrue();
    expect(pairs.some(({ a, b }) => a === "a" && b === "c")).toBeFalse();
  });

  test("handles ascii tokens and empty text", () => {
    expect(cosineSimilarity(bigrams(""), bigrams("x"))).toBe(0);
    expect(cosineSimilarity(bigrams("abc"), bigrams("abc"))).toBeGreaterThan(0.999);
  });
});
