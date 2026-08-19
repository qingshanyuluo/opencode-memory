export function bigrams(text: string): Map<string, number> {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const counts = new Map<string, number>();
  for (let i = 0; i < normalized.length - 1; i += 1) {
    const gram = normalized.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

export function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [gram, count] of a) {
    normA += count * count;
    const other = b.get(gram);
    if (other) dot += count * other;
  }
  for (const count of b.values()) normB += count * count;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface SimilarPair {
  a: string;
  b: string;
  score: number;
}

export function similarPairs(
  items: Array<{ id: string; text: string }>,
  threshold: number,
): SimilarPair[] {
  const vectors = new Map(items.map(({ id, text }) => [id, bigrams(text)]));
  const inverted = new Map<string, string[]>();
  for (const [id, vector] of vectors) {
    for (const gram of vector.keys()) {
      const bucket = inverted.get(gram);
      if (bucket) bucket.push(id);
      else inverted.set(gram, [id]);
    }
  }
  const candidatePairs = new Set<string>();
  for (const bucket of inverted.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i] as string;
        const b = bucket[j] as string;
        candidatePairs.add(a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
      }
    }
  }
  const result: SimilarPair[] = [];
  for (const key of candidatePairs) {
    const [a, b] = key.split("\u0000") as [string, string];
    const score = cosineSimilarity(vectors.get(a) as Map<string, number>, vectors.get(b) as Map<string, number>);
    if (score >= threshold) result.push({ a, b, score });
  }
  return result.sort((left, right) => right.score - left.score);
}
