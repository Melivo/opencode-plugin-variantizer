import { describe, expect, test } from "bun:test";

import {
  DIAGNOSTIC_POLICIES,
  createDiagnostic,
  createDiagnosticEmitter,
  sanitizeDiagnosticIdentifier,
  serializeDiagnostic,
  type DiagnosticPolicyName,
} from "../../src/diagnostics.ts";

const expectedLevelByKey = {
  "startup/fatal-startup": "error",
  "credential/unchanged": "warn",
  "host-read/unchanged": "warn",
  "host-write/unchanged": "warn",
  "host-write/fatal-turn": "error",
  "topology/unchanged": "warn",
  "topology/skipped": "info",
  "history/unchanged": "warn",
  "history/fallback": "warn",
  "typesafe/unchanged": "warn",
  "typesafe/fallback": "warn",
  "typesafe/skipped": "info",
  "deadline/unchanged": "warn",
  "deadline/fallback": "warn",
  "lifecycle/cancelled": "debug",
  "binding/fatal-turn": "error",
  "binding/unchanged": "warn",
  "binding/fallback": "warn",
  "notification/best-effort-failed": "warn",
  "tui-sync/unavailable": "info",
  "tui-sync/best-effort-failed": "warn",
  "logging/best-effort-failed": "warn",
  "lifecycle/best-effort-failed": "warn",
} as const;

const requiredOperations = [
  "parse-config", "initialize-plugin", "resolve-credential", "read-agents", "read-providers",
  "write-message-route", "write-provider-options", "acquire-topology", "revalidate-topology",
  "read-history", "build-route-request", "route-request", "validate-route-response",
  "session-cleanup", "ttl-expiry", "capacity-eviction", "dispose", "validate-binding",
  "reserve-route-capacity", "show-toast", "publish-toast", "sync-agent-selector", "sync-variant",
  "write-log", "cleanup-component",
] as const;

const requiredReasons = [
  "config-invalid", "startup-initialization-error", "missing-api-key", "credential-process-unavailable",
  "credential-process-timeout", "credential-output-limit", "credential-process-failed",
  "host-agents-read-error", "host-provider-read-error", "topology-response-error", "binding-unavailable",
  "host-message-write-error", "host-options-write-error", "primary-ring-error", "provider-registry-error",
  "reasoning-catalog-error", "topology-error", "topology-drift", "stale-topology", "history-error",
  "history-response-invalid", "context-invalid", "network-error", "auth-error", "request-timeout",
  "rate-limited", "client-error", "server-error", "invalid-request", "invalid-response",
  "pre-request-timeout", "routing-timeout", "cancelled", "binding-mismatch",
  "route-capacity-unavailable", "toast-show-failed", "toast-publish-failed",
  "notification-delivery-failed", "agent-sync-unavailable", "variant-sync-unavailable",
  "variant-sync-publish-failed", "variant-sync-ambiguous", "log-delivery-failed", "cleanup-failed",
  "disposal-failed", "stale-side-effect-suppressed",
] as const;

describe("central diagnostic contract", () => {
  test("closes the policy vocabulary and derives every level deterministically", () => {
    const policies = Object.values(DIAGNOSTIC_POLICIES);
    expect(new Set(policies.map((policy) => policy.operation))).toEqual(new Set(requiredOperations));
    expect(new Set(policies.map((policy) => policy.reasonCode))).toEqual(new Set(requiredReasons));
    for (const policy of policies) {
      const key = `${policy.boundary}/${policy.disposition}` as keyof typeof expectedLevelByKey;
      expect(policy.level, policy.name).toBe(expectedLevelByKey[key]);
    }
  });

  test("constructs only allowlisted bounded fields in deterministic order", () => {
    const record = createDiagnostic("invalidTypeSafeResponseFallback", {
      modelID: `openai/${"m".repeat(300)}`,
      agentID: "terra",
      variant: "v".repeat(200),
      detail: "probabilities",
      httpStatusClass: "server",
      durationMs: 99_999.8,
      reasons: ["ambiguous-delivery", "targetless-command", "unproven-selector-scope", "ambiguous-delivery"],
    });
    expect(record).toEqual({
      schemaVersion: 1,
      service: "typesafe-variant-router",
      level: "warn",
      boundary: "typesafe",
      operation: "validate-route-response",
      reasonCode: "invalid-response",
      disposition: "fallback",
      modelID: `openai/${"m".repeat(249)}`,
      agentID: "terra",
      variant: "v".repeat(128),
      detail: "probabilities",
      httpStatusClass: "server",
      durationMs: 30_000,
      reasons: ["ambiguous-delivery", "targetless-command", "unproven-selector-scope"],
    });
    expect(serializeDiagnostic(record)).toBe(JSON.stringify(record));
  });

  test("strictly sanitizes control-bearing identifiers without escaping them", () => {
    expect(sanitizeDiagnosticIdentifier("safe/id", 256)).toBe("safe/id");
    expect(sanitizeDiagnosticIdentifier("bad\nidentifier", 256)).toBe("[redacted-id]");
    expect(sanitizeDiagnosticIdentifier("bad\u007fidentifier", 256)).toBe("[redacted-id]");
    expect(sanitizeDiagnosticIdentifier("bad\u2028identifier", 256)).toBe("[redacted-id]");
    expect(sanitizeDiagnosticIdentifier("", 256)).toBe("[redacted-id]");
  });

  test("retains at most 256 keys with non-sliding 600000ms TTL and live-key LRU eviction", async () => {
    let now = 0;
    const delivered: string[] = [];
    const emitter = createDiagnosticEmitter({ now: () => now, sink: async (serialized) => { delivered.push(serialized); } });
    const emit = (policy: DiagnosticPolicyName, modelID: string) => emitter.emit(createDiagnostic(policy, { modelID }));

    expect(await emit("missingApiKey", "first")).toBe(true);
    now = 599_999;
    expect(await emit("missingApiKey", "first")).toBe(false);
    now = 600_000;
    expect(await emit("missingApiKey", "first")).toBe(true);

    now = 700_000;
    for (let index = 0; index < 256; index += 1) await emit("missingApiKey", `model-${index}`);
    expect(emitter.inspect().retainedKeys).toBe(256);
    await emit("missingApiKey", "model-0");
    await emit("missingApiKey", "overflow");
    expect(emitter.inspect().retainedKeys).toBe(256);
    expect(await emit("missingApiKey", "model-1")).toBe(true);
    expect(await emit("missingApiKey", "model-0")).toBe(false);
    expect(delivered.length).toBeGreaterThan(256);
  });

  test("sink failure is nonrecursive, nonthrowing, and observable without retaining a failed key", async () => {
    let calls = 0;
    const failures: unknown[] = [];
    const emitter = createDiagnosticEmitter({
      sink: async () => { calls += 1; throw new Error("PRIVATE_STACK_AND_EXCEPTION"); },
      onSinkFailure: (health) => failures.push(health),
    });
    const diagnostic = createDiagnostic("logDeliveryFailed");
    expect(await emitter.emit(diagnostic)).toBe(false);
    expect(await emitter.emit(diagnostic)).toBe(false);
    expect(calls).toBe(2);
    expect(emitter.inspect()).toEqual({ retainedKeys: 0, sinkFailures: 2 });
    expect(failures).toEqual([
      { reasonCode: "log-delivery-failed", sinkFailures: 1 },
      { reasonCode: "log-delivery-failed", sinkFailures: 2 },
    ]);
  });

  test("reconstructs forged records from validated fields and drops unknown or tainted optional values", () => {
    const forged = {
      ...createDiagnostic("bindingMismatch", { modelID: "openai/gpt-5" }),
      agentID: "PRIVATE_AGENT",
      detail: "PRIVATE_DETAIL",
      comparisonReason: "PRIVATE_COMPARISON",
      httpStatusClass: "PRIVATE_STATUS",
      reasons: ["PRIVATE_REASON"],
      message: "PRIVATE_PROMPT",
      stack: "PRIVATE_STACK",
      cause: { path: "/home/private/PRIVATE_PATH" },
      arbitrary: { token: "PRIVATE_TOKEN" },
    } as never;

    expect(JSON.parse(serializeDiagnostic(forged))).toEqual({
      schemaVersion: 1,
      service: "typesafe-variant-router",
      level: "error",
      boundary: "binding",
      operation: "validate-binding",
      reasonCode: "binding-mismatch",
      disposition: "fatal-turn",
      modelID: "openai/gpt-5",
    });
    expect(serializeDiagnostic(forged)).not.toContain("PRIVATE_");
  });

  test("rejects forged core tuples and redacts absolute paths, traversal, controls, and bidi identifiers", () => {
    const valid = createDiagnostic("bindingMismatch");
    expect(() => serializeDiagnostic({ ...valid, reasonCode: "PRIVATE_REASON" } as never)).toThrow("invalid diagnostic record");
    expect(() => serializeDiagnostic({ ...valid, level: "info" } as never)).toThrow("invalid diagnostic record");
    for (const identifier of [
      "/home/private/PRIVATE_PATH",
      "../PRIVATE_PATH",
      "bad\\PRIVATE_PATH",
      "bad\nPRIVATE_PATH",
      "bad\u202ePRIVATE_PATH",
      "https://private.example/PRIVATE_PATH",
    ]) expect(sanitizeDiagnosticIdentifier(identifier, 256)).toBe("[redacted-id]");
  });
});
