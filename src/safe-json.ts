const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function cloneJsonValue(value: unknown, seen: WeakSet<object>): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value) {
      const cloned = cloneJsonValue(item, seen);
      if (cloned === undefined) return undefined;
      result.push(cloned);
    }
    seen.delete(value);
    return result;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;

  const result: { [key: string]: JsonValue } = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) return undefined;
    const cloned = cloneJsonValue(item, seen);
    if (cloned === undefined) return undefined;
    result[key] = cloned;
  }
  seen.delete(value);
  return result;
}

export function cloneSafeOptions(value: unknown): Record<string, JsonValue> | undefined {
  const cloned = cloneJsonValue(value, new WeakSet());
  if (cloned === null || Array.isArray(cloned) || typeof cloned !== "object") return undefined;
  return Object.keys(cloned).length > 0 ? cloned : undefined;
}

export function cloneJsonObject(value: Record<string, JsonValue>): Record<string, JsonValue> {
  const cloned = cloneSafeOptions(value);
  if (!cloned) throw new TypeError("Expected a validated non-empty options object");
  return cloned;
}
