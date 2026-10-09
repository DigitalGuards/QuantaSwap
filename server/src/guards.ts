/** Runtime guards keep wire and library values unknown until checked. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !isArray(value);
}

/** Preserve unknown elements when checking an untrusted array. */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function hasStringFields<K extends string>(
  value: unknown,
  keys: readonly K[],
): value is Record<string, unknown> & Record<K, string> {
  return isRecord(value) && keys.every((key) => typeof value[key] === "string");
}

export function hasErrorCode(value: unknown, code: string): boolean {
  return isRecord(value) && value["code"] === code;
}
