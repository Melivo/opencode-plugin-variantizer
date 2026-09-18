import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";

import { parseRouterConfig, type RouterConfig } from "./config.ts";
import { assembleContext } from "./context-assembler.ts";
import { resolveTypeSafeApiKey } from "./credential-provider.ts";
import { createDecisionStore, type DecisionStore } from "./decision-store.ts";
import {
  getFallbackOptions,
  getVariantOptions,
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
import { createTypeSafeSdkScoreClient } from "./typesafe-sdk-client.ts";
import { createVariantSyncQueue, type VariantSyncQueue } from "./variant-sync.ts";

const DEFAULT_STORE_TTL_MS = 30_000;
const DEFAULT_STORE_CAPACITY = 256;

type TimerFactory = (callback: () => void, delayMs: number) => () => void;

export type AppliedVariant = Readonly<{
  modelID: string;
  variant: string;
  status: "selected" | "manual" | "fallback";
  reason: RouterReason;
  detail?: InvalidResponseDetail;
}>;

type DeferredRouting = Readonly<{
  start(catalog: VariantCatalog): Promise<RouterDecision>;
  timeout(catalog: VariantCatalog): RouterDecision;
  terminal(): RouterDecision | undefined;
  cancel(): void;
}>;

type PreparedHistory =
  | { messages: readonly unknown[] }
  | { failed: true }
  | { cancelled: true };

type PipelineDependencies = {
  client?: TypeSafeScoreClient;
  historyProvider?: (sessionID: string, signal: AbortSignal) => Promise<readonly unknown[]>;
  now?: () => number;
  setTimer?: TimerFactory;
  store?: DecisionStore<DeferredRouting>;
  onDiagnostic?: (diagnostic: RouterDiagnostic) => void;
  onAppliedVariant?: (application: AppliedVariant) => void;
  variantSync?: VariantSyncQueue;
};

export type VariantRouterHooks = Pick<Hooks, "chat.message" | "chat.params" | "event" | "dispose">;

type MessageInput = Parameters<NonNullable<Hooks["chat.message"]>>[0];
type MessageOutput = Parameters<NonNullable<Hooks["chat.message"]>>[1];
type ParamsInput = Parameters<NonNullable<Hooks["chat.params"]>>[0];
type ParamsOutput = Parameters<NonNullable<Hooks["chat.params"]>>[1];

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
      () => finish(signal.aborted ? { cancelled: true } : { failed: true }),
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
  const store = dependencies.store ?? createDecisionStore<DeferredRouting>({
    ttlMs: Math.max(DEFAULT_STORE_TTL_MS, config.timeoutMs * 2),
    maxEntries: DEFAULT_STORE_CAPACITY,
    now,
    setTimer,
  });
  const variantSync = dependencies.variantSync;
  let nextTurnOrder = 0;
  const router = createTypeSafeRouter({
    ...(dependencies.client ? { client: dependencies.client } : {}),
    now,
    setTimer,
    ...(dependencies.onDiagnostic ? { onDiagnostic: dependencies.onDiagnostic } : {}),
  });

  return {
    "chat.message": async (input: MessageInput, output: MessageOutput): Promise<void> => {
      if (!config.enabled || input.model?.providerID !== "openai") return;
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
                return safeFailure(modelID, config.fallbackVariant, catalog, createdAt, dependencies.onDiagnostic);
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
                return controller.signal.aborted
                  ? skippedDecision(modelID, createdAt)
                  : safeFailure(modelID, config.fallbackVariant, catalog, createdAt, dependencies.onDiagnostic);
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
            terminal ??= skippedDecision(modelID, createdAt);
          },
        };
        return routing;
      }, (routing) => routing.cancel());
    },

    "chat.params": async (input: ParamsInput, output: ParamsOutput): Promise<void> => {
      const messageID = input.message.id;
      if (!config.enabled) {
        variantSync?.discard(messageID);
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
        variantSync?.discard(messageID);
        return;
      }

      const entry = messageID ? store.get(messageID) : undefined;
      if (!entry || entry.modelID !== catalog.modelKey) {
        if (entry) store.delete(messageID);
        variantSync?.discard(messageID);
        applyFallback(output, catalog, config);
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
        if (diagnostic) dependencies.onDiagnostic?.(diagnostic);
        if (application) dependencies.onAppliedVariant?.(application);
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
        Object.assign(output.options, options);
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
      const sessionID = sessionIDFromEvent(input);
      if (sessionID) {
        store.cleanupSession(sessionID);
        variantSync?.cleanupSession(sessionID);
      }
    },

    dispose: async (): Promise<void> => {
      store.clear();
      variantSync?.clear();
    },
  };
}

export function formatAppliedVariantNotification(application: AppliedVariant): {
  message: string;
  variant: "warning" | "info";
} {
  if (application.status === "selected") {
    return { message: `Selected variant "${application.variant}" for ${application.modelID}.`, variant: "info" };
  }
  if (application.status === "manual") {
    return { message: `Using manual variant "${application.variant}" for ${application.modelID}.`, variant: "info" };
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
    message: `Using fallback variant "${application.variant}" for ${application.modelID} because ${reason}.`,
    variant: "warning",
  };
}

function productionObservers(input: PluginInput, config: RouterConfig) {
  const levelPriority = { error: 0, warn: 1, info: 2, debug: 3 } as const;
  const loggedDiagnostics = new Set<string>();
  const emitLog = (level: "error" | "warn" | "info", message: string): void => {
    if (levelPriority[level] > levelPriority[config.logLevel]) return;
    void input.client.app.log({ body: { service: "typesafe-variant-router", level, message } }).catch(() => undefined);
  };
  const notify = (message: string, variant: "warning" | "info"): void => {
    void input.client.tui.showToast({ body: { title: "TypeSafe variant router", message, variant } }).catch(() => undefined);
  };
  return {
    onDiagnostic(diagnostic: RouterDiagnostic): void {
      const level = diagnostic.code === "auth-error" || diagnostic.code === "server-error" || diagnostic.code === "client-error"
        ? "error" as const
        : "warn" as const;
      const detail = diagnostic.detail ? `/${diagnostic.detail}` : "";
      const diagnosticKey = `${diagnostic.modelID}:${diagnostic.code}${detail}:${diagnostic.status}`;
      if (!loggedDiagnostics.has(diagnosticKey)) {
        loggedDiagnostics.add(diagnosticKey);
        emitLog(level, `${diagnostic.status}:${diagnostic.code}${detail}:${diagnostic.modelID}`);
      }
    },
    onAppliedVariant(application: AppliedVariant): void {
      if (application.status !== "fallback") {
        emitLog("info", `selected:${application.reason}:${application.modelID}`);
      }
      if (config.notify === "off") return;
      if (application.status !== "fallback" && config.notify !== "always") return;
      const notification = formatAppliedVariantNotification(application);
      notify(notification.message, notification.variant);
    },
  };
}

type ApiKeyResolver = (
  environment: Readonly<Record<string, string | undefined>>,
) => Promise<string | undefined>;

type PluginDependencies = {
  resolveApiKey?: ApiKeyResolver;
  createScoreClient?: (apiKey: string) => TypeSafeScoreClient;
};

export function createTypeSafeVariantRouterPlugin(dependencies: PluginDependencies = {}): Plugin {
  const resolveApiKey = dependencies.resolveApiKey ?? resolveTypeSafeApiKey;
  const createScoreClient = dependencies.createScoreClient ?? createTypeSafeSdkScoreClient;
  return (async (input, options: PluginOptions = {}) => {
    const config = parseRouterConfig(options);
    const environment = (globalThis as typeof globalThis & {
      process?: { env?: Readonly<Record<string, string | undefined>> };
    }).process?.env ?? {};
    const apiKey = await resolveApiKey(environment);
    const observers = productionObservers(input, config);
    const publish = input.client.tui.publish;
    const variantSync = typeof publish === "function"
      ? createVariantSyncQueue(async () => {
          const result = await publish.call(input.client.tui, {
            body: {
              type: "tui.command.execute",
              properties: { command: "variant.cycle" },
            },
          });
          return commandSucceeded(result);
        })
      : undefined;
    return createVariantRouterHooks(config, {
      ...(apiKey ? { client: createScoreClient(apiKey) } : {}),
      historyProvider: async (sessionID, signal) => {
        const response = await input.client.session.messages({ path: { id: sessionID }, signal });
        return (response.data ?? []).map((message) => ({ role: message.info.role, parts: message.parts }));
      },
      ...observers,
      ...(variantSync ? { variantSync } : {}),
    });
  }) satisfies Plugin;
}

export const TypeSafeVariantRouterPlugin = createTypeSafeVariantRouterPlugin();

export default TypeSafeVariantRouterPlugin;
