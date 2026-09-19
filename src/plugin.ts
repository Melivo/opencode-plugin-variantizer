import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";

import { parseRouterConfig, type RouterConfig } from "./config.ts";
import { assembleContext } from "./context-assembler.ts";
import { resolveTypeSafeApiKeyWithDiagnostics, type CredentialFailureReason } from "./credential-provider.ts";
import {
  createAgentRouteStore,
  createDecisionStore,
  createManualAgentPolicyState,
  type AgentRouteStore,
  type DecisionStore,
  type ManualAgentPolicyState,
} from "./decision-store.ts";
import {
  AGENT_MODEL_BINDINGS,
  LOGICAL_AGENT_RING,
  OBSERVED_PRIMARY_ORDER,
  createAgentTopologySnapshot,
  fingerprintCanonical,
  validateTopologyObservation,
  type AgentTopologySnapshot,
  type RingAgentID,
  type TopologyObservation,
} from "./agent-topology.ts";
import {
  createAgentRouteRouter,
  type AgentRouteTransportFailureReason,
  type RejectedAgentRoute,
  type TypeSafeAgentRouteClient,
} from "./agent-route.ts";
import {
  createUnavailableAgentSync,
  type AgentSync,
  type AgentSyncDiagnostic,
} from "./agent-sync.ts";
import {
  getFallbackOptions,
  getVariantOptions,
  resolveVariantCatalog,
  resolveVariantCatalogFromParams,
  type VariantCatalog,
} from "./open-code-variant-adapter.ts";
import {
  createTypeSafeRouter,
  type InvalidResponseDetail,
  type RouterDecision,
  type RouterDiagnostic,
  type RouterReason,
  type TypeSafeScoreClient,
} from "./typesafe-router.ts";
import {
  createTypeSafeSdkAgentRouteClient,
  createTypeSafeSdkScoreClient,
} from "./typesafe-sdk-client.ts";
import { createVariantSyncQueueWithDiagnostics, type VariantSyncQueue } from "./variant-sync.ts";
import {
  createDiagnostic,
  DiagnosticError,
  createDiagnosticEmitter,
  sanitizeDiagnosticIdentifier,
  type DiagnosticComparisonReason,
  type DiagnosticOperation,
  type DiagnosticPolicyName,
  type DiagnosticRecord,
} from "./diagnostics.ts";

const DEFAULT_STORE_TTL_MS = 30_000;
const DEFAULT_COMMITTED_AGENT_ROUTE_TTL_MS = 30 * 60_000;
const DEFAULT_STORE_CAPACITY = 256;
const AGENT_PROFILES = Object.freeze({
  luna: "Use Luna for boilerplate, extraction, formatting, and simple helper tasks with objective verification. Select it only for narrow, low-risk, repeatable work with clear checks; do not use it for ambiguous changes, difficult architecture, or demanding autonomous repository work.",
  terra: "Use Terra for clearly specified local code changes and structured subtasks with bounded scope and clear acceptance criteria. Select it when the task needs local implementation or reasoning beyond Luna's simple helper work; do not use it as the sole decision-maker for difficult architecture or broad, ambiguous, high-impact changes.",
  sol: "Use Sol for normal backend, frontend, and mobile implementation, medium refactorings, code review, and repository work that needs stronger autonomous coding or terminal performance. Select it for cross-file changes, behavior preservation, integration, lifecycle or state complexity, reviews, and work beyond a bounded Terra task.",
} as const);

type TimerFactory = (callback: () => void, delayMs: number) => () => void;

export type AppliedVariant = Readonly<{
  modelID: string;
  variant: string;
  status: "selected" | "manual" | "fallback";
  reason: RouterReason;
  detail?: InvalidResponseDetail;
}>;

type ProductionTopologyFailureReason = "topology-response-error"
  | "primary-ring-error"
  | "provider-registry-error"
  | "reasoning-catalog-error";

class ProductionHistoryError extends Error {
  constructor(readonly reason: "history-response-invalid" | "history-error") {
    super(reason);
    this.name = "ProductionHistoryError";
  }
}

class ProductionTopologyError extends Error {
  constructor(
    readonly reason: ProductionTopologyFailureReason | "host-agents-read-error" | "host-provider-read-error",
    readonly diagnosticPolicy?: DiagnosticPolicyName,
  ) {
    super(reason);
    this.name = "ProductionTopologyError";
  }
}

type AgentRouteFailureReason = RejectedAgentRoute["reason"]
  | ProductionTopologyFailureReason
  | "topology-error"
  | "topology-drift"
  | "history-error"
  | "history-response-invalid"
  | "routing-timeout"
  | "binding-unavailable"
  | "host-agents-read-error"
  | "host-provider-read-error";

type DeferredRouting = Readonly<{
  start(catalog: VariantCatalog): Promise<RouterDecision>;
  timeout(catalog: VariantCatalog): RouterDecision;
  terminal(): RouterDecision | undefined;
  cancel(): void;
}>;

type PreparedHistory =
  | { messages: readonly unknown[] }
  | { failed: true; reason: "history-error" | "history-response-invalid" }
  | { cancelled: true };

export type AgentTopologySource = Readonly<{
  acquire(input: Readonly<{
    sourceAgent: RingAgentID;
    sourceModel: string;
    signal: AbortSignal;
  }>): Promise<Readonly<{ topology: AgentTopologySnapshot; observation: TopologyObservation }>>;
  revalidate(input: Readonly<{
    topology: AgentTopologySnapshot;
    sourceAgent: RingAgentID;
    sourceModel: string;
    signal: AbortSignal;
  }>): Promise<TopologyObservation>;
}>;

export class AgentRouteBindingError extends Error {
  constructor() {
    super("committed agent route mismatch before provider invocation");
    this.name = "AgentRouteBindingError";
  }
}

type PipelineDependencies = {
  client?: TypeSafeScoreClient;
  agentClient?: TypeSafeAgentRouteClient;
  agentTopology?: AgentTopologySource;
  agentStore?: AgentRouteStore;
  manualAgentPolicy?: ManualAgentPolicyState;
  historyProvider?: (sessionID: string, signal: AbortSignal) => Promise<readonly unknown[]>;
  now?: () => number;
  setTimer?: TimerFactory;
  store?: DecisionStore<DeferredRouting>;
  onDiagnostic?: (diagnostic: RouterDiagnostic) => void;
  onRuntimeDiagnostic?: (diagnostic: DiagnosticRecord) => void;
  clearDiagnostics?: () => void;
  onAppliedVariant?: (application: AppliedVariant) => void;
  onAgentRouteRejected?: (rejection: Readonly<{
    modelID: string;
    reason: AgentRouteFailureReason;
    timeoutOperation?: Extract<DiagnosticOperation, "acquire-topology" | "read-history" | "route-request" | "revalidate-topology">;
  }>) => void;
  agentSync?: AgentSync;
  variantSync?: VariantSyncQueue;
};

export type VariantRouterHooks = Pick<Hooks, "chat.message" | "chat.params" | "event" | "dispose">;

type MessageInput = Parameters<NonNullable<Hooks["chat.message"]>>[0];
type MessageOutput = Parameters<NonNullable<Hooks["chat.message"]>>[1];
type ParamsInput = Parameters<NonNullable<Hooks["chat.params"]>>[0];
type ParamsOutput = Parameters<NonNullable<Hooks["chat.params"]>>[1];
type VariantMessage = Omit<MessageOutput["message"], "model"> & {
  model: MessageOutput["message"]["model"] & { variant?: string };
};

function defaultTimer(callback: () => void, delayMs: number): () => void {
  const timer = globalThis.setTimeout(callback, delayMs);
  return () => globalThis.clearTimeout(timer);
}

function commandSucceeded(result: unknown): boolean {
  if (result === null || typeof result !== "object") return false;
  const response = result as { data?: unknown; error?: unknown };
  return response.error === undefined && response.data === true;
}

function promptText(output: MessageOutput): string | undefined {
  const message = output.message as MessageOutput["message"] & { synthetic?: boolean };
  if (message.role !== "user" || message.synthetic === true) return undefined;
  const text = output.parts.flatMap((part) => part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0 ? [part.text] : []);
  return text.length > 0 ? text.join("\n") : undefined;
}

function safeFailure(
  modelID: string,
  fallbackVariant: string,
  catalog: VariantCatalog,
  createdAt: number,
  onDiagnostic?: (diagnostic: RouterDiagnostic) => void,
): RouterDecision {
  const hasFallback = catalog.names.includes(fallbackVariant);
  const status = hasFallback ? "fallback" : "skipped";
  onDiagnostic?.({ code: "client-error", modelID, status });
  return {
    status,
    modelID,
    ...(hasFallback ? { variant: fallbackVariant } : {}),
    reason: "client-error",
    createdAt,
  };
}

function manualDecision(modelID: string, variant: string, createdAt: number): RouterDecision {
  return { status: "selected", modelID, variant, reason: "selected", createdAt };
}

function skippedDecision(modelID: string, createdAt: number): RouterDecision {
  return { status: "skipped", modelID, reason: "not-routable", createdAt };
}

function timeoutDecision(
  modelID: string,
  fallbackVariant: string,
  catalog: VariantCatalog,
  createdAt: number,
  reason: "pre-request-timeout" | "request-timeout",
): RouterDecision {
  const hasFallback = catalog.names.includes(fallbackVariant);
  return {
    status: hasFallback ? "fallback" : "skipped",
    modelID,
    ...(hasFallback ? { variant: fallbackVariant } : {}),
    reason,
    createdAt,
  };
}

function prepareHistory(
  load: () => Promise<readonly unknown[]>,
  signal: AbortSignal,
): Promise<PreparedHistory> {
  if (signal.aborted) return Promise.resolve({ cancelled: true });
  let request: Promise<readonly unknown[]>;
  try {
    request = load();
  } catch {
    request = Promise.reject(new Error("history provider failed"));
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: PreparedHistory): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => finish({ cancelled: true });
    signal.addEventListener("abort", onAbort, { once: true });
    void request.then(
      (messages) => finish({ messages }),
      (error: unknown) => finish(signal.aborted
        ? { cancelled: true }
        : { failed: true, reason: error instanceof ProductionHistoryError ? error.reason : "history-error" }),
    );
  });
}

async function settleBeforeDeadline(
  promise: Promise<RouterDecision>,
  deadlineAt: number,
  now: () => number,
  setTimer: TimerFactory,
): Promise<RouterDecision | undefined> {
  const remainingMs = deadlineAt - now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return undefined;
  let resolveDeadline: (() => void) | undefined;
  const deadline = new Promise<undefined>((resolve) => { resolveDeadline = () => resolve(undefined); });
  const cancel = setTimer(() => resolveDeadline?.(), remainingMs);
  try {
    return await Promise.race([promise.catch(() => undefined), deadline]);
  } finally {
    cancel();
  }
}

function applyFallback(output: ParamsOutput, catalog: VariantCatalog | undefined, config: RouterConfig): string | undefined {
  const options = getFallbackOptions(catalog, config.fallbackVariant);
  if (!options) return undefined;
  Object.assign(output.options, options);
  return config.fallbackVariant;
}

function messageModelKey(model: { providerID?: unknown; modelID?: unknown }): string | undefined {
  return typeof model.providerID === "string" && typeof model.modelID === "string"
    ? `${model.providerID}/${model.modelID}`
    : undefined;
}

function ringAgent(value: unknown): RingAgentID | undefined {
  return typeof value === "string" && LOGICAL_AGENT_RING.includes(value as RingAgentID)
    ? value as RingAgentID
    : undefined;
}

function runtimePolicyForRouter(diagnostic: RouterDiagnostic): DiagnosticPolicyName {
  if (diagnostic.code === "missing-api-key") return "missingApiKey";
  if (diagnostic.code === "pre-request-timeout") return diagnostic.status === "fallback" ? "preRequestTimeoutFallback" : "preRequestTimeoutUnchanged";
  if (diagnostic.code === "request-timeout") return diagnostic.status === "fallback" ? "requestTimeoutFallback" : "requestTimeoutUnchanged";
  if (diagnostic.code === "invalid-response") {
    if (diagnostic.detail === "request") return diagnostic.status === "fallback" ? "invalidTypeSafeRequestFallback" : "invalidTypeSafeRequestSkipped";
    return diagnostic.status === "fallback" ? "invalidTypeSafeResponseFallback" : "invalidTypeSafeResponseSkipped";
  }
  const policies = {
    "network-error": { fallback: "networkErrorFallback", skipped: "networkErrorSkipped" },
    "auth-error": { fallback: "authErrorFallback", skipped: "authErrorSkipped" },
    "rate-limited": { fallback: "rateLimitedFallback", skipped: "rateLimitedSkipped" },
    "server-error": { fallback: "serverErrorFallback", skipped: "serverErrorSkipped" },
    "client-error": { fallback: "clientErrorFallback", skipped: "clientErrorSkipped" },
    "not-routable": { fallback: "clientErrorFallback", skipped: "clientErrorSkipped" },
  } as const;
  return policies[diagnostic.code][diagnostic.status];
}

function runtimePolicyForAgentFailure(reason: AgentRouteFailureReason): DiagnosticPolicyName {
  switch (reason) {
    case "missing-api-key": return "missingApiKey";
    case "invalid-request": return "invalidTypeSafeRequestUnchanged";
    case "invalid-response": return "invalidTypeSafeResponseUnchanged";
    case "stale-topology": return "staleTopology";
    case "client-error": return "clientErrorUnchanged";
    case "cancelled": return "routeRequestCancelled";
    case "host-agents-read-error": return "hostAgentsReadError";
    case "host-provider-read-error": return "hostProviderReadError";
    case "topology-response-error": return "hostAgentsResponseError";
    case "primary-ring-error": return "primaryRingError";
    case "provider-registry-error": return "providerRegistryError";
    case "reasoning-catalog-error": return "reasoningCatalogError";
    case "topology-error": return "topologyError";
    case "topology-drift": return "topologyDrift";
    case "history-error": return "historyErrorUnchanged";
    case "history-response-invalid": return "historyResponseInvalid";
    case "routing-timeout": return "routingTimeoutUnchanged";
    case "binding-unavailable": return "bindingUnavailable";
  }
}

function writableTuple(message: MessageOutput["message"]): boolean {
  for (const key of ["agent", "model"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(message, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.writable !== true) return false;
  }
  return true;
}

async function withinDeadline<T>(
  work: Promise<T>,
  deadlineAt: number,
  now: () => number,
  setTimer: TimerFactory,
  controller: AbortController,
  onExpire?: () => void,
): Promise<T | undefined> {
  const remainingMs = deadlineAt - now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    controller.abort();
    return undefined;
  }
  let expired = false;
  let expire: (() => void) | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    expire = () => {
      expired = true;
      onExpire?.();
      controller.abort();
      resolve(undefined);
    };
  });
  const cancel = setTimer(() => expire?.(), remainingMs);
  try {
    const result = await Promise.race([work.catch(() => undefined), deadline]);
    return expired ? undefined : result;
  } finally {
    cancel();
  }
}

function currentCatalogFingerprints(catalog: VariantCatalog): Readonly<{
  catalogFingerprint: string;
  optionsFingerprint: string;
}> {
  return {
    catalogFingerprint: fingerprintCanonical({
      modelKey: catalog.modelKey,
      names: catalog.names,
      runtimeNames: catalog.runtimeNames,
    }),
    optionsFingerprint: fingerprintCanonical(catalog.optionsByVariant),
  };
}

function sessionIDFromEvent(input: Parameters<NonNullable<Hooks["event"]>>[0]): string | undefined {
  if (input.event.type !== "session.deleted") return undefined;
  const properties = input.event.properties as Record<string, unknown>;
  if (typeof properties.sessionID === "string") return properties.sessionID;
  const info = properties.info;
  return info !== null && typeof info === "object" && typeof (info as { id?: unknown }).id === "string"
    ? (info as { id: string }).id
    : undefined;
}

export function createVariantRouterHooks(rawConfig: unknown, dependencies: PipelineDependencies = {}): VariantRouterHooks {
  const config = parseRouterConfig(rawConfig);
  const now = dependencies.now ?? Date.now;
  const setTimer = dependencies.setTimer ?? defaultTimer;
  let disposed = false;
  let disposing = false;
  const emitRuntime = (policyName: DiagnosticPolicyName, fields: Parameters<typeof createDiagnostic>[1] = {}): void => {
    if (disposed && !disposing) return;
    try { dependencies.onRuntimeDiagnostic?.(createDiagnostic(policyName, fields)); } catch { /* observational */ }
  };
  const reportRouterDiagnostic = (diagnostic: RouterDiagnostic): void => {
    try { dependencies.onDiagnostic?.(diagnostic); } catch { emitRuntime("logDeliveryFailed"); }
    emitRuntime(runtimePolicyForRouter(diagnostic), {
      modelID: diagnostic.modelID,
      ...(diagnostic.detail ? { detail: diagnostic.detail } : {}),
    });
  };
  const store = dependencies.store ?? createDecisionStore<DeferredRouting>({
    ttlMs: Math.max(DEFAULT_STORE_TTL_MS, config.timeoutMs * 2),
    maxEntries: DEFAULT_STORE_CAPACITY,
    now,
    setTimer,
    onLifecycle(reason) {
      emitRuntime(reason === "ttl-expiry" ? "ttlExpiryCancelled" : "capacityEvictionCancelled");
    },
  });
  const agentSync = dependencies.agentSync;
  const variantSync = dependencies.variantSync;
  let nextTurnOrder = 0;
  const router = createTypeSafeRouter({
    ...(dependencies.client ? { client: dependencies.client } : {}),
    now,
    setTimer,
    onDiagnostic: reportRouterDiagnostic,
  });
  const agentStore = dependencies.agentStore ?? createAgentRouteStore({
    ttlMs: Math.max(DEFAULT_STORE_TTL_MS, config.timeoutMs * 2),
    committedTtlMs: Math.max(DEFAULT_COMMITTED_AGENT_ROUTE_TTL_MS, config.timeoutMs * 2),
    maxEntries: DEFAULT_STORE_CAPACITY,
    now,
    setTimer,
    onLifecycle() { emitRuntime("ttlExpiryCancelled"); },
  });
  const manualAgentPolicy = dependencies.manualAgentPolicy
    ?? createManualAgentPolicyState(config.agentSelection.manualAgentPolicy);
  const agentRouter = createAgentRouteRouter({
    ...(dependencies.agentClient ? { client: dependencies.agentClient } : {}),
    now,
    onTransportFailure(reason: AgentRouteTransportFailureReason) {
      const policies: Record<AgentRouteTransportFailureReason, DiagnosticPolicyName> = {
        "network-error": "networkErrorUnchanged",
        "auth-error": "authErrorUnchanged",
        "request-timeout": "requestTimeoutUnchanged",
        "rate-limited": "rateLimitedUnchanged",
        "client-error": "clientErrorUnchanged",
        "server-error": "serverErrorUnchanged",
      };
      emitRuntime(policies[reason]);
    },
  });

  const timeoutPolicy = (operation: "acquire-topology" | "read-history" | "route-request" | "revalidate-topology"): DiagnosticPolicyName => {
    if (operation === "read-history") return "routingTimeoutHistoryUnchanged";
    if (operation === "revalidate-topology") return "routingTimeoutRevalidateUnchanged";
    if (operation === "route-request") return "requestTimeoutUnchanged";
    return "routingTimeoutUnchanged";
  };

  const runAgentMessage = async (output: MessageOutput): Promise<void> => {
    if (disposed) return;
    const message = output.message as VariantMessage;
    const sessionID = message.sessionID;
    const messageID = message.id;
    const sourceAgent = ringAgent(message.agent);
    const sourceModel = messageModelKey(message.model);
    const prompt = promptText(output);
    if (!sessionID || !messageID || !sourceAgent || !sourceModel || !prompt) return;
    if (sourceModel !== AGENT_MODEL_BINDINGS[sourceAgent]) return;

    const createdAt = now();
    const deadlineAt = createdAt + config.timeoutMs;
    const turnOrder = ++nextTurnOrder;
    const controller = new AbortController();
    const reservation = agentStore.reserve({ sessionID, messageID }, () => controller.abort());
    if (!reservation) {
      emitRuntime("routeCapacityUnavailable", { modelID: sourceModel, agentID: sourceAgent });
      return;
    }
    let rejectionReported = false;
    const reportRejection = (
      reason: AgentRouteFailureReason,
      policyName = runtimePolicyForAgentFailure(reason),
      timeoutOperation?: "acquire-topology" | "read-history" | "route-request" | "revalidate-topology",
    ): void => {
      if (rejectionReported) return;
      rejectionReported = true;
      emitRuntime(policyName, { modelID: sourceModel });
      if (reason === "cancelled") return;
      try {
        dependencies.onAgentRouteRejected?.({ modelID: sourceModel, reason, ...(timeoutOperation ? { timeoutOperation } : {}) });
      } catch {
        // Notification observers are nonfatal and cannot affect provider routing.
      }
    };

    let historyPending = false;
    let topologyPending = false;
    let routePending = false;
    let revalidationPending = false;
    let expiredOperation: "acquire-topology" | "read-history" | "route-request" | "revalidate-topology" | undefined;
    const routeWork = (async () => {
      if (!dependencies.agentTopology) {
        reportRejection("topology-error");
        return undefined;
      }
      historyPending = config.context.mode === "recent-messages" && dependencies.historyProvider !== undefined;
      const historyPromise = historyPending
        ? prepareHistory(() => dependencies.historyProvider!(sessionID, controller.signal), controller.signal)
            .finally(() => { historyPending = false; })
        : Promise.resolve({ messages: [] as readonly unknown[] } as const);
      topologyPending = true;
      const topologyPromise = dependencies.agentTopology.acquire({ sourceAgent, sourceModel, signal: controller.signal })
        .finally(() => { topologyPending = false; });
      const [preparedHistory, acquired] = await Promise.all([historyPromise, topologyPromise]);
      if ("cancelled" in preparedHistory || controller.signal.aborted) return undefined;
      if ("failed" in preparedHistory) {
        reportRejection(preparedHistory.reason);
        return undefined;
      }
      if (!validateTopologyObservation(acquired.topology, acquired.observation)) {
        reportRejection("topology-drift");
        return undefined;
      }
      const manualLock = manualAgentPolicy.observe(sessionID, sourceAgent, turnOrder);
      const state = assembleContext({
        currentPrompt: prompt,
        modelID: sourceModel,
        messages: preparedHistory.messages,
        policy: config.context,
      });
      const remainingMs = Math.max(0, deadlineAt - now());
      routePending = true;
      const decision = await agentRouter.route({
        state,
        sourceAgent,
        sourceModel,
        topology: acquired.topology,
        observation: acquired.observation,
        observeCurrentTopology: () => acquired.observation,
        agentProfiles: AGENT_PROFILES,
        variantDescriptionsByAgent: {
          luna: config.variantDescriptions,
          terra: config.variantDescriptions,
          sol: config.variantDescriptions,
        },
        ...(manualLock ? { manualLock } : {}),
        timeoutMs: remainingMs,
        signal: controller.signal,
      }).finally(() => { routePending = false; });
      if (decision.status !== "selected" || controller.signal.aborted) {
        if (decision.status === "rejected") reportRejection(decision.reason);
        return undefined;
      }
      revalidationPending = true;
      const observation = await dependencies.agentTopology.revalidate({
        topology: acquired.topology,
        sourceAgent,
        sourceModel,
        signal: controller.signal,
      }).finally(() => { revalidationPending = false; });
      if (!validateTopologyObservation(acquired.topology, observation)) {
        reportRejection("topology-drift");
        return undefined;
      }
      if (decision.topologyGenerationID !== acquired.topology.generationID
        || decision.behaviorFingerprint !== acquired.topology.behaviorFingerprint
        || decision.catalogFingerprint !== acquired.topology.catalogFingerprints[decision.targetAgent]
        || decision.optionsFingerprint !== acquired.topology.optionsFingerprints[decision.targetAgent]) {
        reportRejection("topology-drift");
        return undefined;
      }
      return { decision, topology: acquired.topology } as const;
    })().catch((error: unknown) => {
      if (error instanceof ProductionTopologyError) {
        reportRejection(error.reason, error.diagnosticPolicy ?? runtimePolicyForAgentFailure(error.reason));
      } else {
        reportRejection("topology-error");
      }
      return undefined;
    });

    const routed = await withinDeadline(routeWork, deadlineAt, now, setTimer, controller, () => {
      expiredOperation = historyPending
        ? "read-history"
        : topologyPending
          ? "acquire-topology"
          : revalidationPending
            ? "revalidate-topology"
            : routePending
              ? "route-request"
              : "acquire-topology";
    });
    if (!routed || disposed || controller.signal.aborted || now() >= deadlineAt) {
      if (!disposed && !rejectionReported) {
        if (expiredOperation) reportRejection("routing-timeout", timeoutPolicy(expiredOperation), expiredOperation);
        else reportRejection(controller.signal.aborted ? "cancelled" : "routing-timeout");
      }
      reservation.release();
      return;
    }
    if (!writableTuple(message)) {
      reportRejection("binding-unavailable");
      reservation.release();
      return;
    }
    const { decision } = routed;
    const committed = reservation.commit(Object.freeze({
      sessionID,
      messageID,
      turnOrder,
      sourceAgent,
      sourceModel,
      targetAgent: decision.targetAgent,
      targetModel: decision.targetModel,
      targetVariant: decision.targetVariant,
      topologyGenerationID: decision.topologyGenerationID,
      behaviorFingerprint: decision.behaviorFingerprint,
      catalogFingerprint: decision.catalogFingerprint,
      optionsFingerprint: decision.optionsFingerprint,
      createdAt: now(),
    }));
    if (!committed) return;

    const [providerID, modelID] = decision.targetModel.split("/", 2);
    if (!providerID || !modelID) {
      agentStore.delete(sessionID, messageID);
      return;
    }
    try {
      message.agent = decision.targetAgent;
      message.model = { providerID, modelID, variant: decision.targetVariant };
    } catch {
      agentStore.delete(sessionID, messageID);
      emitRuntime("hostMessageWriteError", { modelID: decision.targetModel, agentID: decision.targetAgent, variant: decision.targetVariant });
      throw new AgentRouteBindingError();
    }
  };

  const runAgentParams = async (input: ParamsInput, output: ParamsOutput): Promise<void> => {
    if (disposed) return;
    const messageID = input.message.id;
    const messageSessionID = input.message.sessionID;
    if (!messageID || !messageSessionID) return;
    const fail = (comparisonReason?: DiagnosticComparisonReason): never => {
      agentStore.invalidate(input.sessionID, messageID);
      emitRuntime("bindingMismatch", { ...(comparisonReason ? { comparisonReason } : {}) });
      throw new AgentRouteBindingError();
    };
    if (input.sessionID !== messageSessionID) return fail();
    const route = agentStore.get(input.sessionID, messageID);
    if (!route) {
      if (agentStore.wasCommitted(input.sessionID, messageID)) fail();
      return;
    }
    const boundMessage = input.message as VariantMessage;
    const validateActiveBinding = (): void => {
      if (agentStore.get(input.sessionID, messageID) !== route) fail();
      const inputModel = `${input.model.providerID}/${input.model.id}`;
      const boundMessageModel = messageModelKey(boundMessage.model);
      if (input.agent !== route.targetAgent || boundMessage.agent !== route.targetAgent) fail("agent-mismatch");
      if (inputModel !== route.targetModel || boundMessageModel !== route.targetModel
        || route.targetModel !== AGENT_MODEL_BINDINGS[route.targetAgent]) fail("model-mismatch");
      if (boundMessage.model.variant !== route.targetVariant) fail("variant-mismatch");
    };
    validateActiveBinding();

    const catalog = resolveVariantCatalogFromParams(input, config.variantsByModel);
    if (!catalog) return fail("catalog-mismatch");
    if (catalog.modelKey !== route.targetModel) return fail("model-mismatch");
    const fingerprints = currentCatalogFingerprints(catalog);
    if (fingerprints.catalogFingerprint !== route.catalogFingerprint) fail("catalog-mismatch");
    if (fingerprints.optionsFingerprint !== route.optionsFingerprint) fail("options-mismatch");
    const options = getVariantOptions(catalog, route.targetVariant);
    if (!options) fail("variant-mismatch");
    const agentTopology = dependencies.agentTopology;
    if (!agentTopology) return fail("topology-mismatch");
    const controller = new AbortController();
    const deadlineAt = now() + config.timeoutMs;
    const acquired = await withinDeadline(
      agentTopology.acquire({
        sourceAgent: route.targetAgent,
        sourceModel: route.targetModel,
        signal: controller.signal,
      }),
      deadlineAt,
      now,
      setTimer,
      controller,
    );
    if (disposed) return;
    if (!acquired || controller.signal.aborted
      || !validateTopologyObservation(acquired.topology, acquired.observation)
      || acquired.topology.generationID !== route.topologyGenerationID
      || acquired.topology.behaviorFingerprint !== route.behaviorFingerprint
      || acquired.topology.catalogFingerprints[route.targetAgent] !== route.catalogFingerprint
      || acquired.topology.optionsFingerprints[route.targetAgent] !== route.optionsFingerprint) fail("topology-mismatch");
    validateActiveBinding();
    try {
      Object.assign(output.options, options);
    } catch {
      emitRuntime("hostOptionsWriteError", { modelID: route.targetModel, agentID: route.targetAgent, variant: route.targetVariant });
      fail("options-mismatch");
    }
    if (agentStore.claimSideEffects(input.sessionID, messageID)) {
      try {
        dependencies.onAppliedVariant?.({
          modelID: route.targetModel,
          variant: route.targetVariant,
          status: "selected",
          reason: "selected",
        });
      } catch {
        // Notification observers are nonfatal and cannot affect provider routing.
      }
    }
    try {
      agentSync?.reportUnavailable();
    } catch {
      // Selector diagnostics are nonfatal and cannot affect provider routing.
    }
  };

  return {
    "chat.message": async (input: MessageInput, output: MessageOutput): Promise<void> => {
      if (disposed || !config.enabled) return;
      if (config.agentSelection.enabled) {
        await runAgentMessage(output);
        return;
      }
      if (input.model?.providerID !== "openai") return;
      const messageID = output.message.id;
      if (!messageID) return;

      const modelID = `${input.model.providerID}/${input.model.modelID}`;
      const createdAt = now();
      const deadlineAt = createdAt + config.timeoutMs;
      const turnOrder = ++nextTurnOrder;
      const sourceVariant = typeof input.variant === "string" ? input.variant : undefined;
      const prompt = promptText(output);
      store.produce({
        messageID,
        sessionID: input.sessionID,
        modelID,
        deadlineAt,
        turnOrder,
        ...(sourceVariant ? { sourceVariant } : {}),
      }, () => {
        const controller = new AbortController();
        const history = prompt && config.context.mode === "recent-messages" && dependencies.historyProvider
          ? prepareHistory(
              () => dependencies.historyProvider!(input.sessionID, controller.signal),
              controller.signal,
            )
          : Promise.resolve({ messages: [] as readonly unknown[] } as const);
        let decision: Promise<RouterDecision> | undefined;
        let terminal: RouterDecision | undefined;
        let requestStarted = false;
        const routing: DeferredRouting = {
          start(catalog): Promise<RouterDecision> {
            if (terminal) return Promise.resolve(terminal);
            if (decision) return decision;
            decision = (async () => {
              if (!prompt) return skippedDecision(modelID, createdAt);
              const manualVariant = sourceVariant && catalog.names.includes(sourceVariant)
                ? sourceVariant
                : undefined;
              if (config.manualVariantPolicy === "manual-first" && manualVariant) {
                return manualDecision(modelID, manualVariant, createdAt);
              }
              const preparedHistory = await history;
              if ("cancelled" in preparedHistory) return skippedDecision(modelID, createdAt);
              if ("failed" in preparedHistory) {
                const hasFallback = catalog.names.includes(config.fallbackVariant);
                const policyName = preparedHistory.reason === "history-response-invalid"
                  ? hasFallback ? "historyResponseInvalidFallback" : "historyResponseInvalid"
                  : hasFallback ? "historyErrorFallback" : "historyErrorUnchanged";
                emitRuntime(policyName, { modelID });
                return safeFailure(modelID, config.fallbackVariant, catalog, createdAt);
              }
              try {
                const state = assembleContext({
                  currentPrompt: prompt,
                  modelID,
                  messages: preparedHistory.messages,
                  policy: config.context,
                });
                return await router.route({
                  modelID,
                  state,
                  catalog,
                  fallbackVariant: config.fallbackVariant,
                  deadlineAt,
                  variantDescriptions: config.variantDescriptions,
                  signal: controller.signal,
                  onRequestStart: () => { requestStarted = true; },
                });
              } catch {
                if (controller.signal.aborted) {
                  emitRuntime("routeRequestCancelled", { modelID });
                  return skippedDecision(modelID, createdAt);
                }
                emitRuntime(catalog.names.includes(config.fallbackVariant) ? "contextInvalidFallback" : "contextInvalid", { modelID });
                return safeFailure(modelID, config.fallbackVariant, catalog, createdAt, reportRouterDiagnostic);
              }
            })().then((result) => {
              terminal ??= result;
              return terminal;
            });
            return decision;
          },
          timeout(catalog): RouterDecision {
            if (terminal) return terminal;
            controller.abort();
            terminal = timeoutDecision(
              modelID,
              config.fallbackVariant,
              catalog,
              createdAt,
              requestStarted ? "request-timeout" : "pre-request-timeout",
            );
            return terminal;
          },
          terminal(): RouterDecision | undefined {
            return terminal;
          },
          cancel(): void {
            controller.abort();
            emitRuntime("routeRequestCancelled", { modelID });
            terminal ??= skippedDecision(modelID, createdAt);
          },
        };
        return routing;
      }, (routing) => routing.cancel());
    },

    "chat.params": async (input: ParamsInput, output: ParamsOutput): Promise<void> => {
      if (disposed) return;
      const messageID = input.message.id;
      if (!config.enabled) {
        if (messageID) agentStore.delete(input.sessionID, messageID);
        variantSync?.discard(messageID);
        return;
      }
      if (config.agentSelection.enabled) {
        await runAgentParams(input, output);
        return;
      }
      if (input.model.providerID !== "openai") {
        if (messageID) store.delete(messageID);
        variantSync?.discard(messageID);
        return;
      }
      const catalog = resolveVariantCatalogFromParams(input, config.variantsByModel);
      if (!catalog) {
        if (messageID) store.delete(messageID);
        try { variantSync?.discard(messageID); } catch { emitRuntime("variantSyncUnavailable"); }
        emitRuntime("reasoningCatalogSkipped", { modelID: `${input.model.providerID}/${input.model.id}` });
        return;
      }

      const entry = messageID ? store.get(messageID) : undefined;
      if (!entry || entry.modelID !== catalog.modelKey) {
        if (entry) store.delete(messageID);
        try { variantSync?.discard(messageID); } catch { emitRuntime("variantSyncUnavailable"); }
        const fallback = applyFallback(output, catalog, config);
        emitRuntime(fallback ? "bindingFallback" : "bindingUnavailable", {
          modelID: catalog.modelKey,
          ...(fallback ? { variant: fallback } : {}),
          comparisonReason: "model-mismatch",
        });
        return;
      }
      const sourceVariant = entry.sourceVariant && catalog.names.includes(entry.sourceVariant)
        ? entry.sourceVariant
        : "default";
      const emitSideEffects = (
        targetVariant: string | undefined,
        application?: AppliedVariant,
        diagnostic?: RouterDiagnostic,
      ): void => {
        if (!entry.claimSideEffects()) return;
        const tuiCatalog = catalog.runtimeNames;
        const tuiSourceVariant = entry.sourceVariant && tuiCatalog.includes(entry.sourceVariant)
          ? entry.sourceVariant
          : "default";
        try {
          if (targetVariant && tuiCatalog.includes(targetVariant)) {
            variantSync?.observe({
              messageID,
              sessionID: entry.sessionID,
              modelID: entry.modelID,
              sourceVariant: tuiSourceVariant,
              catalog: tuiCatalog,
              turnOrder: entry.turnOrder,
            });
            variantSync?.schedule({
              messageID,
              sessionID: entry.sessionID,
              modelID: entry.modelID,
              sourceVariant: tuiSourceVariant,
              targetVariant,
              catalog: tuiCatalog,
              turnOrder: entry.turnOrder,
            });
          } else {
            variantSync?.discard(messageID);
          }
        } catch {
          emitRuntime("variantSyncUnavailable", { modelID: entry.modelID, ...(targetVariant ? { variant: targetVariant } : {}) });
        }
        if (diagnostic) {
          reportRouterDiagnostic(diagnostic);
        }
        if (application) {
          try { dependencies.onAppliedVariant?.(application); } catch { emitRuntime("notificationDeliveryFailed"); }
        }
      };
      const applyCorrelatedFallback = (reason: RouterDiagnostic["code"], reportDiagnostic: boolean): void => {
        const variant = applyFallback(output, catalog, config);
        if (!variant) {
          emitSideEffects(undefined);
          return;
        }
        emitSideEffects(
          variant,
          { modelID: catalog.modelKey, variant, status: "fallback", reason },
          reportDiagnostic ? { code: reason, modelID: catalog.modelKey, status: "fallback" } : undefined,
        );
      };

      const routing = await entry.promise.catch(() => undefined);
      if (disposed) return;
      if (!routing) {
        applyCorrelatedFallback("invalid-response", true);
        return;
      }
      let paramsTimeoutReason: "pre-request-timeout" | "request-timeout" | undefined;
      let result = routing.terminal();
      if (!result) {
        if (!Number.isFinite(entry.deadlineAt) || entry.deadlineAt <= now()) {
          result = routing.timeout(catalog);
          paramsTimeoutReason = result.reason === "request-timeout" ? "request-timeout" : "pre-request-timeout";
        } else {
          const settled = await settleBeforeDeadline(routing.start(catalog), entry.deadlineAt, now, setTimer);
          if (disposed) return;
          if (settled) {
            result = settled;
          } else {
            result = routing.timeout(catalog);
            paramsTimeoutReason = result.reason === "request-timeout" ? "request-timeout" : "pre-request-timeout";
          }
        }
      }
      if (result.status === "skipped") {
        emitSideEffects(undefined);
        return;
      }
      if (result.modelID !== catalog.modelKey || !result.variant) {
        applyCorrelatedFallback("invalid-response", true);
        return;
      }
      const options = getVariantOptions(catalog, result.variant);
      if (options) {
        try {
          Object.assign(output.options, options);
        } catch {
          emitRuntime("hostOptionsWriteError", { modelID: result.modelID, variant: result.variant });
          throw new AgentRouteBindingError();
        }
        const status: AppliedVariant["status"] = result.status === "fallback"
          ? "fallback"
          : config.manualVariantPolicy === "manual-first" && entry.sourceVariant === result.variant
            ? "manual"
            : "selected";
        emitSideEffects(
          result.variant,
          {
            modelID: result.modelID,
            variant: result.variant,
            status,
            reason: result.reason,
            ...(result.detail ? { detail: result.detail } : {}),
          },
          paramsTimeoutReason
            ? { code: paramsTimeoutReason, modelID: catalog.modelKey, status: "fallback" }
            : undefined,
        );
      } else {
        let reason: RouterDiagnostic["code"] = "invalid-response";
        let reportDiagnostic = true;
        if (result.status === "fallback" && result.reason !== "selected") {
          reason = result.reason;
          reportDiagnostic = false;
        }
        applyCorrelatedFallback(reason, reportDiagnostic);
      }
    },

    event: async (input): Promise<void> => {
      if (disposed) return;
      const sessionID = sessionIDFromEvent(input);
      if (!sessionID) return;
      emitRuntime("sessionCleanupCancelled");
      const cleanup = (action: () => void): void => {
        try { action(); } catch { emitRuntime("cleanupFailed"); }
      };
      cleanup(() => store.cleanupSession(sessionID));
      cleanup(() => agentStore.cleanupSession(sessionID));
      cleanup(() => manualAgentPolicy.cleanupSession(sessionID));
      cleanup(() => agentSync?.cleanupSession(sessionID));
      cleanup(() => variantSync?.cleanupSession(sessionID));
    },

    dispose: async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      disposing = true;
      emitRuntime("disposeCancelled");
      const cleanup = (action: () => void): void => {
        try { action(); } catch { emitRuntime("disposalFailed"); }
      };
      cleanup(() => store.clear());
      cleanup(() => agentStore.clear());
      cleanup(() => manualAgentPolicy.clear());
      cleanup(() => agentSync?.clear());
      cleanup(() => variantSync?.clear());
      cleanup(() => dependencies.clearDiagnostics?.());
      disposing = false;
    },
  };
}

export function formatAppliedVariantNotification(application: AppliedVariant): {
  message: string;
  variant: "warning" | "info";
} {
  const modelID = sanitizeDiagnosticIdentifier(application.modelID, 256);
  const variant = sanitizeDiagnosticIdentifier(application.variant, 128);
  if (application.status === "selected") {
    return { message: `Selected variant "${variant}" for ${modelID}.`, variant: "info" };
  }
  if (application.status === "manual") {
    return { message: `Using manual variant "${variant}" for ${modelID}.`, variant: "info" };
  }
  const reason = (() => {
    switch (application.reason) {
      case "missing-api-key": return "the TypeSafe API key is unavailable";
      case "invalid-response": return application.detail
        ? `TypeSafe response validation failed (${application.detail})`
        : "TypeSafe returned an invalid response";
      case "pre-request-timeout": return "the routing deadline expired before the TypeSafe request started";
      case "request-timeout": return "the TypeSafe request exceeded the routing deadline";
      case "network-error": return "the TypeSafe network request failed";
      case "auth-error": return "TypeSafe authentication failed";
      case "rate-limited": return "TypeSafe rate-limited the request";
      case "server-error": return "TypeSafe returned a server error";
      case "client-error": return "the TypeSafe client failed";
      default: return "routing could not select a variant";
    }
  })();
  return {
    message: `Using fallback variant "${variant}" for ${modelID} because ${reason}.`,
    variant: "warning",
  };
}

function productionObservers(
  input: PluginInput,
  config: RouterConfig,
  onSinkFailure?: Parameters<typeof createDiagnosticEmitter>[0]["onSinkFailure"],
) {
  let closed = false;
  const emitter = createDiagnosticEmitter({
    minLevel: config.logLevel,
    ...(onSinkFailure ? { onSinkFailure } : {}),
    sink: async (message, record) => {
      if (closed) return;
      await input.client.app.log({ body: { service: "typesafe-variant-router", level: record.level, message } });
    },
  });
  const emit = (diagnostic: DiagnosticRecord): void => {
    if (!closed) void emitter.emit(diagnostic);
  };
  const routerPolicy = (diagnostic: RouterDiagnostic): DiagnosticPolicyName => {
    if (diagnostic.code === "missing-api-key") return "missingApiKey";
    if (diagnostic.code === "pre-request-timeout") return diagnostic.status === "fallback" ? "preRequestTimeoutFallback" : "preRequestTimeoutUnchanged";
    if (diagnostic.code === "request-timeout") return diagnostic.status === "fallback" ? "requestTimeoutFallback" : "requestTimeoutUnchanged";
    if (diagnostic.code === "invalid-response") {
      if (diagnostic.detail === "request") return diagnostic.status === "fallback" ? "invalidTypeSafeRequestFallback" : "invalidTypeSafeRequestSkipped";
      return diagnostic.status === "fallback" ? "invalidTypeSafeResponseFallback" : "invalidTypeSafeResponseSkipped";
    }
    const policies = {
      "network-error": { fallback: "networkErrorFallback", skipped: "networkErrorSkipped" },
      "auth-error": { fallback: "authErrorFallback", skipped: "authErrorSkipped" },
      "rate-limited": { fallback: "rateLimitedFallback", skipped: "rateLimitedSkipped" },
      "server-error": { fallback: "serverErrorFallback", skipped: "serverErrorSkipped" },
      "client-error": { fallback: "clientErrorFallback", skipped: "clientErrorSkipped" },
      "not-routable": { fallback: "clientErrorFallback", skipped: "clientErrorSkipped" },
    } as const;
    return policies[diagnostic.code][diagnostic.status];
  };
  const agentPolicy = (
    reason: AgentRouteFailureReason,
    timeoutOperation?: "acquire-topology" | "read-history" | "route-request" | "revalidate-topology",
  ): DiagnosticPolicyName => {
    if (reason === "routing-timeout" && timeoutOperation) {
      if (timeoutOperation === "read-history") return "routingTimeoutHistoryUnchanged";
      if (timeoutOperation === "revalidate-topology") return "routingTimeoutRevalidateUnchanged";
      if (timeoutOperation === "route-request") return "requestTimeoutUnchanged";
    }
    switch (reason) {
      case "missing-api-key": return "missingApiKey";
      case "invalid-request": return "invalidTypeSafeRequestUnchanged";
      case "invalid-response": return "invalidTypeSafeResponseUnchanged";
      case "stale-topology": return "staleTopology";
      case "client-error": return "clientErrorUnchanged";
      case "cancelled": return "routeRequestCancelled";
      case "host-agents-read-error": return "hostAgentsReadError";
      case "host-provider-read-error": return "hostProviderReadError";
      case "topology-response-error": return "hostAgentsResponseError";
      case "primary-ring-error": return "primaryRingError";
      case "provider-registry-error": return "providerRegistryError";
      case "reasoning-catalog-error": return "reasoningCatalogError";
      case "topology-error": return "topologyError";
      case "topology-drift": return "topologyDrift";
      case "history-error": return "historyErrorUnchanged";
      case "history-response-invalid": return "historyResponseInvalid";
      case "routing-timeout": return "routingTimeoutUnchanged";
      case "binding-unavailable": return "bindingUnavailable";
    }
  };
  const notify = (message: string, variant: "warning" | "info"): void => {
    if (closed) return;
    const body = { title: "TypeSafe variant router", message, variant } as const;
    void (async () => {
      try {
        const response = await input.client.tui.showToast({ body });
        if (closed) return;
        if (response === null || typeof response !== "object" || (response as { error?: unknown }).error === undefined) return;
        emit(createDiagnostic("toastShowFailed"));
      } catch {
        if (closed) return;
        emit(createDiagnostic("toastShowFailed"));
      }
      if (closed) return;
      const publish = input.client.tui.publish;
      if (typeof publish === "function") {
        try {
          const response = await publish.call(input.client.tui, { body: { type: "tui.toast.show", properties: body } });
          if (commandSucceeded(response)) return;
          emit(createDiagnostic("toastPublishFailed"));
        } catch {
          emit(createDiagnostic("toastPublishFailed"));
        }
      }
      emit(createDiagnostic("notificationDeliveryFailed"));
    })();
  };
  return {
    onRuntimeDiagnostic: emit,
    onDiagnostic(diagnostic: RouterDiagnostic): void {
      emit(createDiagnostic(routerPolicy(diagnostic), {
        modelID: diagnostic.modelID,
        ...(diagnostic.detail ? { detail: diagnostic.detail } : {}),
      }));
    },
    onAgentSyncDiagnostic(diagnostic: AgentSyncDiagnostic): void {
      emit(createDiagnostic("agentSyncUnavailable", { reasons: diagnostic.reasons }));
    },
    onAgentRouteRejected(rejection: Readonly<{
      modelID: string;
      reason: AgentRouteFailureReason;
      timeoutOperation?: "acquire-topology" | "read-history" | "route-request" | "revalidate-topology";
    }>): void {
      emit(createDiagnostic(agentPolicy(rejection.reason, rejection.timeoutOperation), { modelID: rejection.modelID }));
      if (config.notify === "off" || rejection.reason === "cancelled") return;
      const reasons: Record<Exclude<AgentRouteFailureReason, "cancelled">, string> = {
        "missing-api-key": "the TypeSafe API key is unavailable",
        "invalid-request": "the routing request was invalid",
        "invalid-response": "the TypeSafe response was invalid",
        "stale-topology": "the agent topology changed during routing",
        "client-error": "the TypeSafe client failed",
        "host-agents-read-error": "the OpenCode agent catalog could not be read",
        "host-provider-read-error": "the OpenCode provider catalog could not be read",
        "topology-response-error": "OpenCode returned malformed topology data",
        "primary-ring-error": "the Luna/Terra/Sol primary-agent ring was unavailable or misconfigured",
        "provider-registry-error": "the OpenCode provider registry did not expose every ring model",
        "reasoning-catalog-error": "a ring model did not expose a verified reasoning-variant catalog",
        "topology-error": "the OpenCode agent topology could not be read",
        "topology-drift": "the OpenCode agent topology did not match the configured ring",
        "history-error": "the session history could not be read",
        "history-response-invalid": "the session history response was invalid",
        "routing-timeout": "agent routing exceeded its deadline",
        "binding-unavailable": "the current agent tuple could not be updated safely",
      };
      const modelID = sanitizeDiagnosticIdentifier(rejection.modelID, 256);
      notify(`Keeping the current agent for ${modelID} because ${reasons[rejection.reason]}.`, "warning");
    },
    onAppliedVariant(application: AppliedVariant): void {
      if (config.notify === "off") return;
      if (application.status !== "fallback" && config.notify !== "always") return;
      const notification = formatAppliedVariantNotification(application);
      notify(notification.message, notification.variant);
    },
    clearDiagnostics(): void {
      closed = true;
      emitter.clear();
    },
  };
}

type ApiKeyResolver = (
  environment: Readonly<Record<string, string | undefined>>,
  onFailure?: (reason: CredentialFailureReason) => void,
) => Promise<string | undefined>;

function responseData(value: unknown): unknown {
  if (value === null || typeof value !== "object") throw new Error("host topology observation failed");
  const response = value as { data?: unknown; error?: unknown };
  if (response.error !== undefined) throw new Error("host topology observation failed");
  return response.data ?? value;
}

function topologyObservation(snapshot: AgentTopologySnapshot, sourceAgent: RingAgentID, sourceModel: string): TopologyObservation {
  return Object.freeze({
    generationID: snapshot.generationID,
    sourceAgent,
    sourceModel,
    orderedPrimaryAgents: snapshot.orderedPrimaryAgents,
    agentToModel: snapshot.agentToModel,
    behaviorFingerprint: snapshot.behaviorFingerprint,
    providerBoundaryFingerprint: snapshot.providerBoundaryFingerprint,
    catalogFingerprints: snapshot.catalogFingerprints,
    optionsFingerprints: snapshot.optionsFingerprints,
  });
}

function createProductionAgentTopologySource(input: PluginInput, config: RouterConfig): AgentTopologySource {
  const observe = async (sourceAgent: RingAgentID, sourceModel: string, signal: AbortSignal) => {
    const [agentsResponse, providersResponse] = await Promise.all([
      Promise.resolve().then(() => input.client.app.agents({ query: { directory: input.directory }, signal }))
        .catch(() => { throw new ProductionTopologyError("host-agents-read-error"); }),
      Promise.resolve().then(() => input.client.provider.list({ query: { directory: input.directory }, signal }))
        .catch(() => { throw new ProductionTopologyError("host-provider-read-error"); }),
    ]);
    let agents: unknown;
    let providers: unknown;
    try {
      agents = responseData(agentsResponse);
    } catch {
      throw new ProductionTopologyError("topology-response-error", "hostAgentsResponseError");
    }
    try {
      providers = responseData(providersResponse);
    } catch {
      throw new ProductionTopologyError("topology-response-error", "hostProviderResponseError");
    }
    if (!Array.isArray(agents) || providers === null || typeof providers !== "object") {
      throw new ProductionTopologyError("topology-response-error");
    }
    const primaries = agents.filter((agent) => (
      agent !== null && typeof agent === "object" && (agent as { mode?: unknown }).mode === "primary"
    )) as Array<Record<string, unknown>>;
    const orderedPrimaryAgents = primaries
      .map((agent) => agent.name)
      .filter((name): name is RingAgentID => (
        typeof name === "string" && (LOGICAL_AGENT_RING as readonly string[]).includes(name)
      ));
    if (orderedPrimaryAgents.length !== OBSERVED_PRIMARY_ORDER.length
      || orderedPrimaryAgents.some((agent, index) => agent !== OBSERVED_PRIMARY_ORDER[index])) {
      throw new ProductionTopologyError("primary-ring-error");
    }
    const providerList = (providers as { all?: unknown }).all;
    if (!Array.isArray(providerList)) throw new ProductionTopologyError("provider-registry-error");
    const openai = providerList.find((provider) => (
      provider !== null && typeof provider === "object" && (provider as { id?: unknown }).id === "openai"
    )) as { models?: Record<string, unknown> } | undefined;
    if (!openai?.models) throw new ProductionTopologyError("provider-registry-error");

    const behaviorByAgent: Record<string, unknown> = Object.create(null);
    const providerBoundaryByAgent: Record<string, unknown> = Object.create(null);
    const catalogsByAgent: Record<string, unknown> = Object.create(null);
    for (const agent of LOGICAL_AGENT_RING) {
      const observedAgent = primaries.find((candidate) => candidate.name === agent);
      if (!observedAgent) throw new ProductionTopologyError("primary-ring-error");
      const model = observedAgent.model as { providerID?: unknown; modelID?: unknown } | undefined;
      const modelKey = model && typeof model.providerID === "string" && typeof model.modelID === "string"
        ? `${model.providerID}/${model.modelID}`
        : undefined;
      if (modelKey !== AGENT_MODEL_BINDINGS[agent]) throw new ProductionTopologyError("primary-ring-error");
      const behavior = Object.fromEntries(Object.entries({
        mode: observedAgent.mode,
        builtIn: observedAgent.builtIn,
        prompt: observedAgent.prompt,
        permission: observedAgent.permission,
        tools: observedAgent.tools,
        temperature: observedAgent.temperature,
        topP: observedAgent.topP,
        maxSteps: observedAgent.maxSteps,
      }).filter((entry) => entry[1] !== undefined));
      behaviorByAgent[agent] = behavior;
      providerBoundaryByAgent[agent] = behavior;
      const modelName = AGENT_MODEL_BINDINGS[agent].slice("openai/".length);
      const runtimeModel = openai.models[modelName];
      if (runtimeModel === null || typeof runtimeModel !== "object") {
        throw new ProductionTopologyError("provider-registry-error");
      }
      const catalog = resolveVariantCatalog({
        model: { ...(runtimeModel as Record<string, unknown>), id: modelName, providerID: "openai" },
        configuredVariants: config.variantsByModel,
      });
      if (!catalog) throw new ProductionTopologyError("reasoning-catalog-error");
      catalogsByAgent[agent] = catalog;
    }
    const generationID = fingerprintCanonical({
      orderedPrimaryAgents,
      agentToModel: AGENT_MODEL_BINDINGS,
      behaviorByAgent,
      providerBoundaryByAgent,
      catalogsByAgent,
    });
    const topology = createAgentTopologySnapshot({
      generationID,
      orderedPrimaryAgents,
      agentToModel: AGENT_MODEL_BINDINGS,
      behaviorByAgent,
      providerBoundaryByAgent,
      catalogsByAgent: catalogsByAgent as never,
    });
    return Object.freeze({ topology, observation: topologyObservation(topology, sourceAgent, sourceModel) });
  };
  return Object.freeze({
    acquire({ sourceAgent, sourceModel, signal }) {
      return observe(sourceAgent, sourceModel, signal);
    },
    async revalidate({ sourceAgent, sourceModel, signal }) {
      return (await observe(sourceAgent, sourceModel, signal)).observation;
    },
  });
}

type PluginDependencies = {
  resolveApiKey?: ApiKeyResolver;
  createScoreClient?: (apiKey: string) => TypeSafeScoreClient;
  createAgentRouteClient?: (apiKey: string) => TypeSafeAgentRouteClient;
  onDiagnosticSinkFailure?: Parameters<typeof createDiagnosticEmitter>[0]["onSinkFailure"];
};

export function createTypeSafeVariantRouterPlugin(dependencies: PluginDependencies = {}): Plugin {
  const createScoreClient = dependencies.createScoreClient ?? createTypeSafeSdkScoreClient;
  const createAgentClient = dependencies.createAgentRouteClient ?? createTypeSafeSdkAgentRouteClient;
  return (async (input, options: PluginOptions = {}) => {
    let config: RouterConfig;
    try {
      config = parseRouterConfig(options);
    } catch {
      const diagnostic = createDiagnostic("configInvalid");
      const emitter = createDiagnosticEmitter({
        minLevel: "debug",
        sink: async (message, record) => {
          await input.client.app.log({ body: { service: "typesafe-variant-router", level: record.level, message } });
        },
      });
      void emitter.emit(diagnostic);
      throw new DiagnosticError(diagnostic);
    }
    const observers = productionObservers(input, config, dependencies.onDiagnosticSinkFailure);
    try {
      const environment = (globalThis as typeof globalThis & {
        process?: { env?: Readonly<Record<string, string | undefined>> };
      }).process?.env ?? {};
      const credentialPolicies: Record<CredentialFailureReason, DiagnosticPolicyName> = {
        "missing-api-key": "missingApiKey",
        "credential-process-unavailable": "credentialProcessUnavailable",
        "credential-process-timeout": "credentialProcessTimeout",
        "credential-output-limit": "credentialOutputLimit",
        "credential-process-failed": "credentialProcessFailed",
      };
      const reportCredentialFailure = (reason: CredentialFailureReason): void => {
        observers.onRuntimeDiagnostic(createDiagnostic(credentialPolicies[reason]));
      };
      const apiKey = dependencies.resolveApiKey
        ? await dependencies.resolveApiKey(environment, reportCredentialFailure)
        : await resolveTypeSafeApiKeyWithDiagnostics(environment, reportCredentialFailure);
      const agentTopology = createProductionAgentTopologySource(input, config);
      const agentSync = createUnavailableAgentSync({
        enabled: config.agentSelection.enabled && config.agentSelection.tuiSync.enabled,
        onDiagnostic: observers.onAgentSyncDiagnostic,
      });
      const publish = input.client.tui.publish;
      if (typeof publish !== "function") observers.onRuntimeDiagnostic(createDiagnostic("variantSyncUnavailable"));
      const variantSync = typeof publish === "function"
        ? createVariantSyncQueueWithDiagnostics(async () => {
            const result = await publish.call(input.client.tui, {
              body: { type: "tui.command.execute", properties: { command: "variant.cycle" } },
            });
            return commandSucceeded(result);
          }, 256, (diagnostic) => {
            observers.onRuntimeDiagnostic(createDiagnostic(
              diagnostic.reason === "variant-sync-ambiguous" ? "variantSyncAmbiguous" : "variantSyncPublishFailed",
            ));
          })
        : undefined;
      return createVariantRouterHooks(config, {
        ...(apiKey ? {
          client: createScoreClient(apiKey),
          agentClient: createAgentClient(apiKey),
        } : {}),
        agentTopology,
        agentSync,
        historyProvider: async (sessionID, signal) => {
          const response = await input.client.session.messages({ path: { id: sessionID }, signal });
          if (!Array.isArray(response.data)) {
            throw new ProductionHistoryError("history-response-invalid");
          }
          return response.data.map((message) => ({ role: message.info.role, parts: message.parts }));
        },
        ...observers,
        ...(variantSync ? { variantSync } : {}),
      });
    } catch (error) {
      if (error instanceof DiagnosticError) throw error;
      const diagnostic = createDiagnostic("startupInitializationError");
      observers.onRuntimeDiagnostic(diagnostic);
      throw new DiagnosticError(diagnostic);
    }
  }) satisfies Plugin;
}

export const TypeSafeVariantRouterPlugin = createTypeSafeVariantRouterPlugin();

export default TypeSafeVariantRouterPlugin;
