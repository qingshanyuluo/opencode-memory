const SECRET_KEY = /^(?:api|app|access|secret|private)[_-]?(?:key|secret|token)$|^(?:password|passwd|authorization|credential|accessToken|refreshToken)$/i;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk[-_][A-Za-z0-9_-]{16,}\b/g, "[REDACTED_KEY]"],
  [/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]"],
  [/(--(?:password|passwd|token|api-key|secret)\s+)([^\s]+)/gi, "$1[REDACTED]"],
  [/(--(?:access-key-id|access-key-secret|app-key|app-secret)\s+)([^\s]+)/gi, "$1[REDACTED]"],
  [/(\bredis-cli\b[^\n]*?\s-a\s+)([^\s]+)/gi, "$1[REDACTED]"],
  [/\b((?:A|P|PASS|PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|APP_SECRET|ACCESS_KEY|[A-Z0-9_]+_(?:AUTH|PASS|PASSWORD|TOKEN|SECRET|KEY))\s*=\s*)([^\s;]+)/g, "$1[REDACTED]"],
  [/(\b(?:password|passwd|apiKey|appKey|appSecret|accessKey|secretKey|token)\b["']?\s*[:=]\s*["'])([^"']+)(["'])/gi, "$1[REDACTED]$3"],
  [/((?:https?|redis|postgres(?:ql)?|mysql):\/\/[^\s/:]*:)([^@\s]+)(@)/g, "$1[REDACTED]$3"],
];

export function redactText(text: string): string {
  const redacted = SECRET_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    text,
  );
  return redacted.replace(/[A-Za-z0-9!@#$%^&*._-]{12,}/g, (token) => {
    const looksCredentialLike = /[a-z]/.test(token)
      && /[A-Z]/.test(token)
      && /\d/.test(token)
      && /[!@#$%^&*]/.test(token);
    return looksCredentialLike ? "[REDACTED_CREDENTIAL]" : token;
  });
}

export function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      SECRET_KEY.test(key) ? "[REDACTED]" : sanitizeValue(child),
    ]),
  );
}
