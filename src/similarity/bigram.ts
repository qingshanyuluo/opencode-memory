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

export function seriate<T>(items: T[], text: (item: T) => string, threshold = 0.15): T[] {
  if (items.length <= 2) return items;
  const pairs = similarPairs(items.map((item) => ({ id: String(items.indexOf(item)), text: text(item) })), threshold);
  const indexOf = new Map(items.map((item, index) => [String(index), item]));
  const sim = new Map<string, Map<string, number>>();
  for (const pair of pairs) {
    let fa = sim.get(pair.a);
    if (!fa) sim.set(pair.a, (fa = new Map()));
    fa.set(pair.b, pair.score);
    let fb = sim.get(pair.b);
    if (!fb) sim.set(pair.b, (fb = new Map()));
    fb.set(pair.a, pair.score);
  }
  const result: T[] = [];
  const used = new Set<string>();
  let remaining = items.map((item, index) => String(index));
  while (remaining.length > 0) {
    let current = remaining[0] as string;
    result.push(indexOf.get(current) as T);
    used.add(current);
    remaining = remaining.filter((id) => !used.has(id));
    while (remaining.length > 0) {
      const neighbors = sim.get(current);
      let best: string | null = null;
      let bestScore = threshold;
      for (const id of remaining) {
        const score = neighbors?.get(id) ?? 0;
        if (score > bestScore) {
          bestScore = score;
          best = id;
        }
      }
      if (!best) break;
      result.push(indexOf.get(best) as T);
      used.add(best);
      remaining = remaining.filter((id) => !used.has(id));
      current = best;
    }
  }
  return result;
}
