export type DiagnosticBoundary =
  | "startup" | "credential" | "host-read" | "host-write" | "topology" | "history"
  | "typesafe" | "deadline" | "binding" | "notification" | "tui-sync" | "logging" | "lifecycle";

export type DiagnosticDisposition =
  | "fatal-startup" | "fatal-turn" | "fallback" | "unchanged" | "skipped" | "cancelled"
  | "best-effort-failed" | "unavailable";

export type DiagnosticOperation =
  | "parse-config" | "initialize-plugin" | "resolve-credential" | "read-agents" | "read-providers"
  | "write-message-route" | "write-provider-options" | "acquire-topology" | "revalidate-topology"
  | "read-history" | "build-route-request" | "route-request" | "validate-route-response"
  | "session-cleanup" | "ttl-expiry" | "capacity-eviction" | "dispose" | "validate-binding"
  | "reserve-route-capacity" | "show-toast" | "publish-toast" | "sync-agent-selector"
  | "sync-variant" | "write-log" | "cleanup-component";

export type DiagnosticReasonCode =
  | "config-invalid" | "startup-initialization-error" | "missing-api-key"
  | "credential-process-unavailable" | "credential-process-timeout" | "credential-output-limit"
  | "credential-process-failed" | "host-agents-read-error" | "host-provider-read-error"
  | "topology-response-error" | "binding-unavailable" | "host-message-write-error"
  | "host-options-write-error" | "primary-ring-error" | "provider-registry-error"
  | "reasoning-catalog-error" | "topology-error" | "topology-drift" | "stale-topology"
  | "history-error" | "history-response-invalid" | "context-invalid" | "network-error"
  | "auth-error" | "request-timeout" | "rate-limited" | "client-error" | "server-error"
  | "invalid-request" | "invalid-response" | "pre-request-timeout" | "routing-timeout"
  | "cancelled" | "binding-mismatch" | "route-capacity-unavailable" | "toast-show-failed"
  | "toast-publish-failed" | "notification-delivery-failed" | "agent-sync-unavailable"
  | "variant-sync-unavailable" | "variant-sync-publish-failed" | "variant-sync-ambiguous"
  | "log-delivery-failed" | "cleanup-failed" | "disposal-failed" | "stale-side-effect-suppressed";

export type DiagnosticComparisonReason =
  | "agent-equal" | "agent-mismatch" | "model-equal" | "model-mismatch"
  | "variant-equal" | "variant-mismatch" | "topology-equal" | "topology-mismatch"
  | "catalog-equal" | "catalog-mismatch" | "options-equal" | "options-mismatch";

export type DiagnosticDetail =
  | "request" | "type" | "probabilities" | "score" | "confidence" | "legend" | "variant";
export type DiagnosticHttpStatusClass = "auth" | "timeout" | "rate-limit" | "client" | "server";
export type DiagnosticUnavailableReason =
  | "targetless-command" | "unproven-selector-scope" | "ambiguous-delivery";
export type DiagnosticLevel = "error" | "warn" | "info" | "debug";

export type DiagnosticRecord = Readonly<{
  schemaVersion: 1;
  service: "typesafe-variant-router";
  level: DiagnosticLevel;
  boundary: DiagnosticBoundary;
  operation: DiagnosticOperation;
  reasonCode: DiagnosticReasonCode;
  disposition: DiagnosticDisposition;
  modelID?: string;
  agentID?: "luna" | "terra" | "sol";
  variant?: string;
  detail?: DiagnosticDetail;
  comparisonReason?: DiagnosticComparisonReason;
  httpStatusClass?: DiagnosticHttpStatusClass;
  durationMs?: number;
  reasons?: readonly DiagnosticUnavailableReason[];
}>;

const LEVEL_BY_DISPOSITION = Object.freeze({
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
} as const);

type LevelKey = keyof typeof LEVEL_BY_DISPOSITION;
type AllowedBoundaryDisposition = {
  [Key in LevelKey]: Key extends `${infer Boundary}/${infer Disposition}`
    ? Readonly<{
        boundary: Boundary & DiagnosticBoundary;
        disposition: Disposition & DiagnosticDisposition;
      }>
    : never;
}[LevelKey];
type PolicySeed = AllowedBoundaryDisposition & Readonly<{
  operation: DiagnosticOperation;
  reasonCode: DiagnosticReasonCode;
}>;

function policy<const Name extends string>(name: Name, seed: PolicySeed) {
  const levelKey = `${seed.boundary}/${seed.disposition}` as LevelKey;
  const level = LEVEL_BY_DISPOSITION[levelKey];
  if (!level) throw new Error("undeclared diagnostic boundary/disposition policy");
  return Object.freeze({ name, ...seed, level });
}

export const DIAGNOSTIC_POLICIES = Object.freeze({
  configInvalid: policy("configInvalid", { boundary: "startup", operation: "parse-config", reasonCode: "config-invalid", disposition: "fatal-startup" }),
  startupInitializationError: policy("startupInitializationError", { boundary: "startup", operation: "initialize-plugin", reasonCode: "startup-initialization-error", disposition: "fatal-startup" }),
  missingApiKey: policy("missingApiKey", { boundary: "credential", operation: "resolve-credential", reasonCode: "missing-api-key", disposition: "unchanged" }),
  credentialProcessUnavailable: policy("credentialProcessUnavailable", { boundary: "credential", operation: "resolve-credential", reasonCode: "credential-process-unavailable", disposition: "unchanged" }),
  credentialProcessTimeout: policy("credentialProcessTimeout", { boundary: "credential", operation: "resolve-credential", reasonCode: "credential-process-timeout", disposition: "unchanged" }),
  credentialOutputLimit: policy("credentialOutputLimit", { boundary: "credential", operation: "resolve-credential", reasonCode: "credential-output-limit", disposition: "unchanged" }),
  credentialProcessFailed: policy("credentialProcessFailed", { boundary: "credential", operation: "resolve-credential", reasonCode: "credential-process-failed", disposition: "unchanged" }),
  hostAgentsReadError: policy("hostAgentsReadError", { boundary: "host-read", operation: "read-agents", reasonCode: "host-agents-read-error", disposition: "unchanged" }),
  hostAgentsResponseError: policy("hostAgentsResponseError", { boundary: "host-read", operation: "read-agents", reasonCode: "topology-response-error", disposition: "unchanged" }),
  hostProviderReadError: policy("hostProviderReadError", { boundary: "host-read", operation: "read-providers", reasonCode: "host-provider-read-error", disposition: "unchanged" }),
  hostProviderResponseError: policy("hostProviderResponseError", { boundary: "host-read", operation: "read-providers", reasonCode: "topology-response-error", disposition: "unchanged" }),
  messageBindingUnavailable: policy("messageBindingUnavailable", { boundary: "host-write", operation: "write-message-route", reasonCode: "binding-unavailable", disposition: "unchanged" }),
  hostMessageWriteError: policy("hostMessageWriteError", { boundary: "host-write", operation: "write-message-route", reasonCode: "host-message-write-error", disposition: "fatal-turn" }),
  hostOptionsWriteError: policy("hostOptionsWriteError", { boundary: "host-write", operation: "write-provider-options", reasonCode: "host-options-write-error", disposition: "fatal-turn" }),
  primaryRingError: policy("primaryRingError", { boundary: "topology", operation: "acquire-topology", reasonCode: "primary-ring-error", disposition: "unchanged" }),
  providerRegistryError: policy("providerRegistryError", { boundary: "topology", operation: "acquire-topology", reasonCode: "provider-registry-error", disposition: "unchanged" }),
  reasoningCatalogError: policy("reasoningCatalogError", { boundary: "topology", operation: "acquire-topology", reasonCode: "reasoning-catalog-error", disposition: "unchanged" }),
  reasoningCatalogSkipped: policy("reasoningCatalogSkipped", { boundary: "topology", operation: "acquire-topology", reasonCode: "reasoning-catalog-error", disposition: "skipped" }),
  topologyError: policy("topologyError", { boundary: "topology", operation: "acquire-topology", reasonCode: "topology-error", disposition: "unchanged" }),
  topologyDrift: policy("topologyDrift", { boundary: "topology", operation: "revalidate-topology", reasonCode: "topology-drift", disposition: "unchanged" }),
  staleTopology: policy("staleTopology", { boundary: "topology", operation: "revalidate-topology", reasonCode: "stale-topology", disposition: "unchanged" }),
  historyErrorUnchanged: policy("historyErrorUnchanged", { boundary: "history", operation: "read-history", reasonCode: "history-error", disposition: "unchanged" }),
  historyErrorFallback: policy("historyErrorFallback", { boundary: "history", operation: "read-history", reasonCode: "history-error", disposition: "fallback" }),
  historyResponseInvalid: policy("historyResponseInvalid", { boundary: "history", operation: "read-history", reasonCode: "history-response-invalid", disposition: "unchanged" }),
  historyResponseInvalidFallback: policy("historyResponseInvalidFallback", { boundary: "history", operation: "read-history", reasonCode: "history-response-invalid", disposition: "fallback" }),
  contextInvalid: policy("contextInvalid", { boundary: "history", operation: "read-history", reasonCode: "context-invalid", disposition: "unchanged" }),
  contextInvalidFallback: policy("contextInvalidFallback", { boundary: "history", operation: "read-history", reasonCode: "context-invalid", disposition: "fallback" }),
  networkErrorUnchanged: policy("networkErrorUnchanged", { boundary: "typesafe", operation: "route-request", reasonCode: "network-error", disposition: "unchanged" }),
  networkErrorFallback: policy("networkErrorFallback", { boundary: "typesafe", operation: "route-request", reasonCode: "network-error", disposition: "fallback" }),
  networkErrorSkipped: policy("networkErrorSkipped", { boundary: "typesafe", operation: "route-request", reasonCode: "network-error", disposition: "skipped" }),
  authErrorUnchanged: policy("authErrorUnchanged", { boundary: "typesafe", operation: "route-request", reasonCode: "auth-error", disposition: "unchanged" }),
  authErrorFallback: policy("authErrorFallback", { boundary: "typesafe", operation: "route-request", reasonCode: "auth-error", disposition: "fallback" }),
  authErrorSkipped: policy("authErrorSkipped", { boundary: "typesafe", operation: "route-request", reasonCode: "auth-error", disposition: "skipped" }),
  requestTimeoutUnchanged: policy("requestTimeoutUnchanged", { boundary: "deadline", operation: "route-request", reasonCode: "request-timeout", disposition: "unchanged" }),
  requestTimeoutFallback: policy("requestTimeoutFallback", { boundary: "deadline", operation: "route-request", reasonCode: "request-timeout", disposition: "fallback" }),
  rateLimitedUnchanged: policy("rateLimitedUnchanged", { boundary: "typesafe", operation: "route-request", reasonCode: "rate-limited", disposition: "unchanged" }),
  rateLimitedFallback: policy("rateLimitedFallback", { boundary: "typesafe", operation: "route-request", reasonCode: "rate-limited", disposition: "fallback" }),
  rateLimitedSkipped: policy("rateLimitedSkipped", { boundary: "typesafe", operation: "route-request", reasonCode: "rate-limited", disposition: "skipped" }),
  clientErrorUnchanged: policy("clientErrorUnchanged", { boundary: "typesafe", operation: "route-request", reasonCode: "client-error", disposition: "unchanged" }),
  clientErrorFallback: policy("clientErrorFallback", { boundary: "typesafe", operation: "route-request", reasonCode: "client-error", disposition: "fallback" }),
  clientErrorSkipped: policy("clientErrorSkipped", { boundary: "typesafe", operation: "route-request", reasonCode: "client-error", disposition: "skipped" }),
  serverErrorUnchanged: policy("serverErrorUnchanged", { boundary: "typesafe", operation: "route-request", reasonCode: "server-error", disposition: "unchanged" }),
  serverErrorFallback: policy("serverErrorFallback", { boundary: "typesafe", operation: "route-request", reasonCode: "server-error", disposition: "fallback" }),
  serverErrorSkipped: policy("serverErrorSkipped", { boundary: "typesafe", operation: "route-request", reasonCode: "server-error", disposition: "skipped" }),
  invalidTypeSafeRequestUnchanged: policy("invalidTypeSafeRequestUnchanged", { boundary: "typesafe", operation: "build-route-request", reasonCode: "invalid-request", disposition: "unchanged" }),
  invalidTypeSafeRequestFallback: policy("invalidTypeSafeRequestFallback", { boundary: "typesafe", operation: "build-route-request", reasonCode: "invalid-request", disposition: "fallback" }),
  invalidTypeSafeRequestSkipped: policy("invalidTypeSafeRequestSkipped", { boundary: "typesafe", operation: "build-route-request", reasonCode: "invalid-request", disposition: "skipped" }),
  invalidTypeSafeResponseUnchanged: policy("invalidTypeSafeResponseUnchanged", { boundary: "typesafe", operation: "validate-route-response", reasonCode: "invalid-response", disposition: "unchanged" }),
  invalidTypeSafeResponseFallback: policy("invalidTypeSafeResponseFallback", { boundary: "typesafe", operation: "validate-route-response", reasonCode: "invalid-response", disposition: "fallback" }),
  invalidTypeSafeResponseSkipped: policy("invalidTypeSafeResponseSkipped", { boundary: "typesafe", operation: "validate-route-response", reasonCode: "invalid-response", disposition: "skipped" }),
  preRequestTimeoutUnchanged: policy("preRequestTimeoutUnchanged", { boundary: "deadline", operation: "build-route-request", reasonCode: "pre-request-timeout", disposition: "unchanged" }),
  preRequestTimeoutFallback: policy("preRequestTimeoutFallback", { boundary: "deadline", operation: "build-route-request", reasonCode: "pre-request-timeout", disposition: "fallback" }),
  routingTimeoutUnchanged: policy("routingTimeoutUnchanged", { boundary: "deadline", operation: "acquire-topology", reasonCode: "routing-timeout", disposition: "unchanged" }),
  routingTimeoutHistoryUnchanged: policy("routingTimeoutHistoryUnchanged", { boundary: "deadline", operation: "read-history", reasonCode: "routing-timeout", disposition: "unchanged" }),
  routingTimeoutRevalidateUnchanged: policy("routingTimeoutRevalidateUnchanged", { boundary: "deadline", operation: "revalidate-topology", reasonCode: "routing-timeout", disposition: "unchanged" }),
  routingTimeoutFallback: policy("routingTimeoutFallback", { boundary: "deadline", operation: "read-history", reasonCode: "routing-timeout", disposition: "fallback" }),
  sessionCleanupCancelled: policy("sessionCleanupCancelled", { boundary: "lifecycle", operation: "session-cleanup", reasonCode: "cancelled", disposition: "cancelled" }),
  ttlExpiryCancelled: policy("ttlExpiryCancelled", { boundary: "lifecycle", operation: "ttl-expiry", reasonCode: "cancelled", disposition: "cancelled" }),
  capacityEvictionCancelled: policy("capacityEvictionCancelled", { boundary: "lifecycle", operation: "capacity-eviction", reasonCode: "cancelled", disposition: "cancelled" }),
  disposeCancelled: policy("disposeCancelled", { boundary: "lifecycle", operation: "dispose", reasonCode: "cancelled", disposition: "cancelled" }),
  routeRequestCancelled: policy("routeRequestCancelled", { boundary: "lifecycle", operation: "route-request", reasonCode: "cancelled", disposition: "cancelled" }),
  bindingMismatch: policy("bindingMismatch", { boundary: "binding", operation: "validate-binding", reasonCode: "binding-mismatch", disposition: "fatal-turn" }),
  bindingUnavailable: policy("bindingUnavailable", { boundary: "binding", operation: "validate-binding", reasonCode: "binding-unavailable", disposition: "unchanged" }),
  bindingFallback: policy("bindingFallback", { boundary: "binding", operation: "validate-binding", reasonCode: "binding-unavailable", disposition: "fallback" }),
  routeCapacityUnavailable: policy("routeCapacityUnavailable", { boundary: "binding", operation: "reserve-route-capacity", reasonCode: "route-capacity-unavailable", disposition: "unchanged" }),
  toastShowFailed: policy("toastShowFailed", { boundary: "notification", operation: "show-toast", reasonCode: "toast-show-failed", disposition: "best-effort-failed" }),
  toastPublishFailed: policy("toastPublishFailed", { boundary: "notification", operation: "publish-toast", reasonCode: "toast-publish-failed", disposition: "best-effort-failed" }),
  notificationDeliveryFailed: policy("notificationDeliveryFailed", { boundary: "notification", operation: "publish-toast", reasonCode: "notification-delivery-failed", disposition: "best-effort-failed" }),
  agentSyncUnavailable: policy("agentSyncUnavailable", { boundary: "tui-sync", operation: "sync-agent-selector", reasonCode: "agent-sync-unavailable", disposition: "unavailable" }),
  variantSyncUnavailable: policy("variantSyncUnavailable", { boundary: "tui-sync", operation: "sync-variant", reasonCode: "variant-sync-unavailable", disposition: "unavailable" }),
  variantSyncPublishFailed: policy("variantSyncPublishFailed", { boundary: "tui-sync", operation: "sync-variant", reasonCode: "variant-sync-publish-failed", disposition: "best-effort-failed" }),
  variantSyncAmbiguous: policy("variantSyncAmbiguous", { boundary: "tui-sync", operation: "sync-variant", reasonCode: "variant-sync-ambiguous", disposition: "best-effort-failed" }),
  logDeliveryFailed: policy("logDeliveryFailed", { boundary: "logging", operation: "write-log", reasonCode: "log-delivery-failed", disposition: "best-effort-failed" }),
  cleanupFailed: policy("cleanupFailed", { boundary: "lifecycle", operation: "cleanup-component", reasonCode: "cleanup-failed", disposition: "best-effort-failed" }),
  disposalFailed: policy("disposalFailed", { boundary: "lifecycle", operation: "dispose", reasonCode: "disposal-failed", disposition: "best-effort-failed" }),
  staleSideEffectSuppressed: policy("staleSideEffectSuppressed", { boundary: "lifecycle", operation: "dispose", reasonCode: "stale-side-effect-suppressed", disposition: "best-effort-failed" }),
});

export type DiagnosticPolicyName = keyof typeof DIAGNOSTIC_POLICIES;

export class DiagnosticError extends Error {
  readonly diagnostic: DiagnosticRecord;

  constructor(diagnostic: DiagnosticRecord) {
    super(`${diagnostic.boundary}:${diagnostic.reasonCode}`);
    this.name = "DiagnosticError";
    this.diagnostic = diagnostic;
  }
}

export type DiagnosticFields = Readonly<{
  modelID?: string;
  agentID?: "luna" | "terra" | "sol";
  variant?: string;
  detail?: DiagnosticDetail;
  comparisonReason?: DiagnosticComparisonReason;
  httpStatusClass?: DiagnosticHttpStatusClass;
  durationMs?: number;
  reasons?: readonly DiagnosticUnavailableReason[];
}>;

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._/+:-]*$/;
const UNAVAILABLE_REASON_SET = new Set<DiagnosticUnavailableReason>([
  "targetless-command", "unproven-selector-scope", "ambiguous-delivery",
]);

export function sanitizeDiagnosticIdentifier(value: string, maxLength: number): string {
  const bounded = Array.from(value).slice(0, maxLength).join("");
  if (
    bounded.length === 0
    || !SAFE_IDENTIFIER.test(bounded)
    || bounded.includes("..")
    || bounded.includes("://")
  ) return "[redacted-id]";
  return bounded;
}

export function createDiagnostic(policyName: DiagnosticPolicyName, fields: DiagnosticFields = {}): DiagnosticRecord {
  const selected = DIAGNOSTIC_POLICIES[policyName];
  const reasons = fields.reasons
    ? [...new Set(fields.reasons.filter((reason) => UNAVAILABLE_REASON_SET.has(reason)))].slice(0, 3)
    : undefined;
  return Object.freeze({
    schemaVersion: 1,
    service: "typesafe-variant-router",
    level: selected.level,
    boundary: selected.boundary,
    operation: selected.operation,
    reasonCode: selected.reasonCode,
    disposition: selected.disposition,
    ...(fields.modelID !== undefined ? { modelID: sanitizeDiagnosticIdentifier(fields.modelID, 256) } : {}),
    ...(fields.agentID !== undefined ? { agentID: fields.agentID } : {}),
    ...(fields.variant !== undefined ? { variant: sanitizeDiagnosticIdentifier(fields.variant, 128) } : {}),
    ...(fields.detail !== undefined ? { detail: fields.detail } : {}),
    ...(fields.comparisonReason !== undefined ? { comparisonReason: fields.comparisonReason } : {}),
    ...(fields.httpStatusClass !== undefined ? { httpStatusClass: fields.httpStatusClass } : {}),
    ...(fields.durationMs !== undefined && Number.isFinite(fields.durationMs)
      ? { durationMs: Math.min(30_000, Math.max(0, Math.trunc(fields.durationMs))) }
      : {}),
    ...(reasons && reasons.length > 0 ? { reasons } : {}),
  });
}

const AGENT_ID_SET = new Set(["luna", "terra", "sol"]);
const DETAIL_SET = new Set(["request", "type", "probabilities", "score", "confidence", "legend", "variant"]);
const COMPARISON_REASON_SET = new Set([
  "agent-equal", "agent-mismatch", "model-equal", "model-mismatch",
  "variant-equal", "variant-mismatch", "topology-equal", "topology-mismatch",
  "catalog-equal", "catalog-mismatch", "options-equal", "options-mismatch",
]);
const HTTP_STATUS_CLASS_SET = new Set(["auth", "timeout", "rate-limit", "client", "server"]);

function normalizeDiagnosticRecord(value: unknown): DiagnosticRecord {
  if (value === null || typeof value !== "object") throw new Error("invalid diagnostic record");
  const input = value as Record<string, unknown>;
  const selected = Object.values(DIAGNOSTIC_POLICIES).find((candidate) =>
    input.schemaVersion === 1
    && input.service === "typesafe-variant-router"
    && input.level === candidate.level
    && input.boundary === candidate.boundary
    && input.operation === candidate.operation
    && input.reasonCode === candidate.reasonCode
    && input.disposition === candidate.disposition
  );
  if (!selected) throw new Error("invalid diagnostic record");

  const modelID = typeof input.modelID === "string" ? sanitizeDiagnosticIdentifier(input.modelID, 256) : undefined;
  const variant = typeof input.variant === "string" ? sanitizeDiagnosticIdentifier(input.variant, 128) : undefined;
  const durationMs = typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
    ? Math.min(30_000, Math.max(0, Math.trunc(input.durationMs)))
    : undefined;
  const reasons = Array.isArray(input.reasons)
    && input.reasons.length <= 3
    && input.reasons.every((reason) => typeof reason === "string" && UNAVAILABLE_REASON_SET.has(reason as DiagnosticUnavailableReason))
    ? Object.freeze([...input.reasons]) as readonly DiagnosticUnavailableReason[]
    : undefined;

  return Object.freeze({
    schemaVersion: 1,
    service: "typesafe-variant-router",
    level: selected.level,
    boundary: selected.boundary,
    operation: selected.operation,
    reasonCode: selected.reasonCode,
    disposition: selected.disposition,
    ...(modelID ? { modelID } : {}),
    ...(typeof input.agentID === "string" && AGENT_ID_SET.has(input.agentID) ? { agentID: input.agentID as NonNullable<DiagnosticRecord["agentID"]> } : {}),
    ...(variant ? { variant } : {}),
    ...(typeof input.detail === "string" && DETAIL_SET.has(input.detail) ? { detail: input.detail as DiagnosticDetail } : {}),
    ...(typeof input.comparisonReason === "string" && COMPARISON_REASON_SET.has(input.comparisonReason) ? { comparisonReason: input.comparisonReason as DiagnosticComparisonReason } : {}),
    ...(typeof input.httpStatusClass === "string" && HTTP_STATUS_CLASS_SET.has(input.httpStatusClass) ? { httpStatusClass: input.httpStatusClass as DiagnosticHttpStatusClass } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(reasons && reasons.length > 0 ? { reasons } : {}),
  });
}

export function serializeDiagnostic(record: DiagnosticRecord): string {
  return JSON.stringify(normalizeDiagnosticRecord(record));
}

const DEFAULT_DEDUP_CAPACITY = 256;
const DEFAULT_DEDUP_TTL_MS = 600_000;
const LEVEL_PRIORITY: Readonly<Record<DiagnosticLevel, number>> = Object.freeze({
  error: 0, warn: 1, info: 2, debug: 3,
});

type RetainedDiagnostic = { createdAt: number; lastUsedAt: number; sequence: number };

export type DiagnosticSinkHealth = Readonly<{
  reasonCode: "log-delivery-failed";
  sinkFailures: number;
}>;

type DiagnosticEmitterOptions = Readonly<{
  sink(serialized: string, record: DiagnosticRecord): Promise<unknown> | unknown;
  onSinkFailure?: (health: DiagnosticSinkHealth) => void;
  now?: () => number;
  maxEntries?: number;
  ttlMs?: number;
  minLevel?: DiagnosticLevel;
}>;

function diagnosticKey(record: DiagnosticRecord): string {
  return JSON.stringify([
    record.boundary, record.operation, record.reasonCode, record.disposition, record.modelID ?? null,
    record.agentID ?? null, record.variant ?? null, record.detail ?? null, record.comparisonReason ?? null,
  ]);
}

export function createDiagnosticEmitter(options: DiagnosticEmitterOptions) {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? DEFAULT_DEDUP_CAPACITY;
  const ttlMs = options.ttlMs ?? DEFAULT_DEDUP_TTL_MS;
  const minLevel = options.minLevel ?? "debug";
  const retained = new Map<string, RetainedDiagnostic>();
  let sequence = 0;
  let sinkFailures = 0;

  const purgeExpired = (at: number): void => {
    for (const [key, value] of retained) {
      if (at - value.createdAt >= ttlMs) retained.delete(key);
    }
  };

  return Object.freeze({
    async emit(record: DiagnosticRecord): Promise<boolean> {
      let normalized: DiagnosticRecord;
      try {
        normalized = normalizeDiagnosticRecord(record);
      } catch {
        return false;
      }
      if (LEVEL_PRIORITY[normalized.level] > LEVEL_PRIORITY[minLevel]) return false;
      const at = now();
      purgeExpired(at);
      const key = diagnosticKey(normalized);
      const previous = retained.get(key);
      if (previous) {
        previous.lastUsedAt = at;
        previous.sequence = ++sequence;
        return false;
      }
      while (retained.size >= maxEntries) {
        let oldestKey: string | undefined;
        let oldest: RetainedDiagnostic | undefined;
        for (const [candidateKey, candidate] of retained) {
          if (!oldest || candidate.lastUsedAt < oldest.lastUsedAt
            || (candidate.lastUsedAt === oldest.lastUsedAt && candidate.sequence < oldest.sequence)) {
            oldestKey = candidateKey;
            oldest = candidate;
          }
        }
        if (oldestKey === undefined) break;
        retained.delete(oldestKey);
      }
      const pending = { createdAt: at, lastUsedAt: at, sequence: ++sequence };
      retained.set(key, pending);
      try {
        await options.sink(JSON.stringify(normalized), normalized);
      } catch {
        sinkFailures += 1;
        if (retained.get(key) === pending) retained.delete(key);
        try {
          options.onSinkFailure?.({ reasonCode: "log-delivery-failed", sinkFailures });
        } catch { /* Health observers are isolated and never recurse into the sink. */ }
        return false;
      }
      return true;
    },
    clear(): void {
      retained.clear();
    },
    inspect(): Readonly<{ retainedKeys: number; sinkFailures: number }> {
      purgeExpired(now());
      return Object.freeze({ retainedKeys: retained.size, sinkFailures });
    },
  });
}
