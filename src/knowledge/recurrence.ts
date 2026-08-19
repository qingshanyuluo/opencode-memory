import { Database } from "bun:sqlite";
import type { EpisodeBehavior } from "../dashboard/behavior-repository.ts";

const STOPWORDS = new Set([
  "confirmed", "proposed", "unknown", "current", "default", "result", "return",
  "string", "value", "status", "user", "message", "config", "source", "service",
  "session", "false", "true", "tests", "test", "main", "release", "branch",
  "open", "http", "build", "exists", "already", "success", "failed", "failure",
]);

export interface RecurringTerm {
  term: string;
  sessions: number;
  sameDirectorySessions: number;
}

function candidateTerms(behavior: EpisodeBehavior): string[] {
  const text = behavior.nodes.map(({ content }) => content).join("\n");
  const terms = [...text.matchAll(/[A-Za-z][A-Za-z0-9_.:/-]{3,}/g)]
    .map(([term]) => term.replace(/^[./:-]+|[.,;:()\[\]{}'"`]+$/g, ""))
    .filter((term) => term.length >= 4 && term.length <= 64)
    .filter((term) => !STOPWORDS.has(term.toLowerCase()))
    .filter((term) => !/^\d|^[a-f0-9]{16,}$/i.test(term))
    .filter((term) => !term.includes("http") && !term.includes("/Users/"))
    .filter((term) => /[A-Z]/.test(term) || /[_.:/-]/.test(term));
  return [...new Set(terms)].slice(0, 80);
}

export function findRecurringTerms(
  bootstrapDbPath: string,
  behavior: EpisodeBehavior,
  directory: string,
): RecurringTerm[] {
  const database = new Database(bootstrapDbPath, { readonly: true, strict: true });
  try {
    const result: RecurringTerm[] = [];
    const count = database.query<{ all_sessions: number; same_directory: number }, [string, string]>(`
      SELECT count(*) AS all_sessions,
             sum(CASE WHEN directory = ? THEN 1 ELSE 0 END) AS same_directory
      FROM session_documents
      WHERE instr(lower(title || char(10) || user_intent || char(10) || artifact_text || char(10) || error_text), lower(?)) > 0
    `);
    for (const term of candidateTerms(behavior)) {
      const row = count.get(directory, term);
      if (row && row.all_sessions >= 2) {
        result.push({ term, sessions: row.all_sessions, sameDirectorySessions: row.same_directory ?? 0 });
      }
    }
    return result
      .sort((left, right) => {
        const leftSpecificity = left.sameDirectorySessions / left.sessions;
        const rightSpecificity = right.sameDirectorySessions / right.sessions;
        const leftScore = left.sameDirectorySessions * (0.5 + leftSpecificity);
        const rightScore = right.sameDirectorySessions * (0.5 + rightSpecificity);
        return rightScore - leftScore
          || right.sessions - left.sessions;
      })
      .slice(0, 30);
  } finally {
    database.close();
  }
}
