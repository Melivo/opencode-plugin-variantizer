import { LOGICAL_AGENT_RING, type RingAgentID } from "./agent-contract.ts";

export type DecisionMetadata = {
  messageID: string;
  sessionID: string;
  modelID: string;
  deadlineAt: number;
  turnOrder: number;
  sourceVariant?: string;
  variantCatalog?: readonly string[];
};

export type StoredDecision<T> = Readonly<DecisionMetadata & {
  createdAt: number;
  expiresAt: number;
  promise: Promise<T>;
  claimSideEffects(): boolean;
}>;

export type DecisionStore<T> = {
  readonly size: number;
  produce(
    metadata: DecisionMetadata,
    producer: () => Promise<T> | T,
    onRemove?: (value: T) => void,
  ): StoredDecision<T>;
  get(messageID: string): StoredDecision<T> | undefined;
  delete(messageID: string): void;
  consume(messageID: string): StoredDecision<T> | undefined;
  cleanupSession(sessionID: string): void;
  clear(): void;
  inspect(): ReadonlyArray<Readonly<Omit<StoredDecision<T>, "promise" | "claimSideEffects">>>;
};

type TimerFactory = (callback: () => void, delayMs: number) => () => void;

type StoreOptions = {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
  setTimer?: TimerFactory;
  onLifecycle?: (reason: "ttl-expiry" | "capacity-eviction") => void;
};

type ManagedEntry<T> = {
  entry: StoredDecision<T>;
  cancelExpiry: () => void;
  onRemove?: (value: T) => void;
  hasValue: boolean;
  value?: T;
};

function defaultSetTimer(callback: () => void, delayMs: number): () => void {
  const timer = globalThis.setTimeout(callback, delayMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => globalThis.clearTimeout(timer);
}

function validateOptions(options: Readonly<{ ttlMs: number; maxEntries: number }>): void {
  if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) {
    throw new RangeError("ttlMs must be a positive integer");
  }
  if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0) {
    throw new RangeError("maxEntries must be a positive integer");
  }
}

export function createDecisionStore<T = unknown>(options: StoreOptions): DecisionStore<T> {
  validateOptions(options);
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const entries = new Map<string, ManagedEntry<T>>();

  const notifyRemoval = (managed: ManagedEntry<T>): void => {
    if (!managed.onRemove) return;
    if (managed.hasValue) {
      managed.onRemove(managed.value as T);
      return;
    }
    void managed.entry.promise.then(managed.onRemove, () => undefined);
  };

  const remove = (
    messageID: string,
    expected?: ManagedEntry<T>,
    notify = true,
    lifecycleReason?: "ttl-expiry" | "capacity-eviction",
  ): StoredDecision<T> | undefined => {
    const managed = entries.get(messageID);
    if (!managed || (expected && managed !== expected)) return undefined;
    entries.delete(messageID);
    managed.cancelExpiry();
    if (notify) {
      managed.entry.claimSideEffects();
      notifyRemoval(managed);
    }
    if (lifecycleReason) {
      try { options.onLifecycle?.(lifecycleReason); } catch { /* observational */ }
    }
    return managed.entry;
  };

  const cleanupExpired = (): void => {
    const current = now();
    for (const [messageID, managed] of entries) {
      if (managed.entry.expiresAt <= current) remove(messageID, managed, true, "ttl-expiry");
    }
  };

  const store: DecisionStore<T> = {
    get size() {
      cleanupExpired();
      return entries.size;
    },

    produce(metadata, producer, onRemove) {
      cleanupExpired();
      const existing = entries.get(metadata.messageID);
      if (existing) return existing.entry;

      const createdAt = now();
      let produced: Promise<T> | T;
      try {
        produced = producer();
      } catch (error) {
        produced = Promise.reject(error);
      }
      const hasValue = !(produced instanceof Promise);
      const promise = Promise.resolve(produced);
      let sideEffectsClaimed = false;
      const entry = Object.freeze({
        ...metadata,
        createdAt,
        expiresAt: createdAt + options.ttlMs,
        promise,
        claimSideEffects(): boolean {
          if (sideEffectsClaimed) return false;
          sideEffectsClaimed = true;
          return true;
        },
      });
      const managed: ManagedEntry<T> = {
        entry,
        cancelExpiry: () => undefined,
        ...(onRemove ? { onRemove } : {}),
        hasValue,
        ...(hasValue ? { value: produced as T } : {}),
      };
      entries.set(metadata.messageID, managed);
      managed.cancelExpiry = setTimer(() => remove(metadata.messageID, managed, true, "ttl-expiry"), options.ttlMs);
      while (entries.size > options.maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        remove(oldest, undefined, true, "capacity-eviction");
      }
      return entry;
    },

    get(messageID) {
      cleanupExpired();
      return entries.get(messageID)?.entry;
    },

    delete(messageID) {
      cleanupExpired();
      remove(messageID);
    },

    consume(messageID) {
      cleanupExpired();
      return remove(messageID, undefined, false);
    },

    cleanupSession(sessionID) {
      for (const [messageID, managed] of entries) {
        if (managed.entry.sessionID === sessionID) remove(messageID, managed);
      }
    },

    clear() {
      for (const [messageID, managed] of entries) remove(messageID, managed);
    },

    inspect() {
      cleanupExpired();
      return [...entries.values()].map(({ entry }) => {
        const { promise: _promise, claimSideEffects: _claimSideEffects, ...metadata } = entry;
        return Object.freeze(metadata);
      });
    },
  };
  return store;
}

export type CommittedAgentRoute = Readonly<{
  sessionID: string;
  messageID: string;
  turnOrder: number;
  sourceAgent: RingAgentID;
  sourceModel: string;
  targetAgent: RingAgentID;
  targetModel: string;
  targetVariant: string;
  confidence: number;
  topologyGenerationID: string;
  behaviorFingerprint: string;
  catalogFingerprint: string;
  optionsFingerprint: string;
  createdAt: number;
}>;

export type AgentRouteReservation = Readonly<{
  sessionID: string;
  messageID: string;
  commit(route: CommittedAgentRoute): boolean;
  release(): void;
}>;

export type AgentRouteStore = Readonly<{
  readonly size: number;
  reserve(identity: Readonly<{ sessionID: string; messageID: string }>, onCancel: () => void): AgentRouteReservation | undefined;
  get(sessionID: string, messageID: string): CommittedAgentRoute | undefined;
  wasCommitted(sessionID: string, messageID: string): boolean;
  claimSideEffects(sessionID: string, messageID: string): boolean;
  invalidate(sessionID: string, messageID: string): void;
  delete(sessionID: string, messageID: string): void;
  cleanupSession(sessionID: string): void;
  clear(): void;
  inspect(): readonly Readonly<{ state: "reserved" | "committed"; sessionID: string; messageID: string; route?: CommittedAgentRoute }>[];
}>;

type AgentRouteStoreOptions = Readonly<{
  ttlMs: number;
  committedTtlMs?: number;
  maxEntries: number;
  now?: () => number;
  setTimer?: TimerFactory;
  onLifecycle?: (reason: "ttl-expiry") => void;
}>;

type AgentRouteEntry = {
  sessionID: string;
  messageID: string;
  state: "reserved" | "committed";
  route?: CommittedAgentRoute;
  sideEffectsClaimed: boolean;
  expiresAt: number;
  onCancel: () => void;
  cancelExpiry: () => void;
};

function compositeKey(sessionID: string, messageID: string): string | undefined {
  if (!sessionID || !messageID || sessionID.length > 512 || messageID.length > 512) return undefined;
  return `${sessionID}\u0000${messageID}`;
}

function validRoute(route: CommittedAgentRoute, sessionID: string, messageID: string): boolean {
  const bounded = [
    route.sourceModel,
    route.targetModel,
    route.targetVariant,
    route.topologyGenerationID,
    route.behaviorFingerprint,
    route.catalogFingerprint,
    route.optionsFingerprint,
  ];
  return route.sessionID === sessionID
    && route.messageID === messageID
    && Number.isSafeInteger(route.turnOrder)
    && route.turnOrder > 0
    && Number.isFinite(route.confidence)
    && route.confidence >= 0
    && route.confidence <= 1
    && Number.isFinite(route.createdAt)
    && bounded.every((value) => typeof value === "string" && value.length > 0 && value.length <= 512);
}

export function createAgentRouteStore(options: AgentRouteStoreOptions): AgentRouteStore {
  validateOptions(options);
  const committedTtlMs = options.committedTtlMs ?? options.ttlMs;
  validateOptions({ ttlMs: committedTtlMs, maxEntries: options.maxEntries });
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const entries = new Map<string, AgentRouteEntry>();
  const committedTombstones = new Map<string, number>();
  let tombstoneOverflowExpiresAt = 0;

  const purgeTombstones = (): void => {
    const current = now();
    for (const [key, expiresAt] of committedTombstones) {
      if (expiresAt <= current) committedTombstones.delete(key);
    }
    if (tombstoneOverflowExpiresAt <= current) tombstoneOverflowExpiresAt = 0;
  };
  const retainCommittedTombstone = (key: string): void => {
    purgeTombstones();
    const expiresAt = now() + committedTtlMs;
    if (committedTombstones.has(key) || committedTombstones.size < options.maxEntries) {
      committedTombstones.set(key, expiresAt);
      return;
    }
    tombstoneOverflowExpiresAt = Math.max(tombstoneOverflowExpiresAt, expiresAt);
  };

  const remove = (key: string, expected?: AgentRouteEntry, lifecycleReason?: "ttl-expiry"): void => {
    const entry = entries.get(key);
    if (!entry || (expected && entry !== expected)) return;
    entries.delete(key);
    entry.cancelExpiry();
    entry.onCancel();
    if (lifecycleReason && entry.state === "committed") retainCommittedTombstone(key);
    if (lifecycleReason) {
      try { options.onLifecycle?.(lifecycleReason); } catch { /* observational */ }
    }
  };
  const cleanupExpired = (): void => {
    const current = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= current) remove(key, entry, "ttl-expiry");
    }
  };

  return Object.freeze({
    get size(): number {
      cleanupExpired();
      return entries.size;
    },
    reserve(identity, onCancel): AgentRouteReservation | undefined {
      cleanupExpired();
      purgeTombstones();
      const key = compositeKey(identity.sessionID, identity.messageID);
      if (!key || entries.has(key) || committedTombstones.has(key)
        || tombstoneOverflowExpiresAt > now() || entries.size >= options.maxEntries) return undefined;
      const entry: AgentRouteEntry = {
        sessionID: identity.sessionID,
        messageID: identity.messageID,
        state: "reserved",
        sideEffectsClaimed: false,
        expiresAt: now() + options.ttlMs,
        onCancel,
        cancelExpiry: () => undefined,
      };
      entries.set(key, entry);
      entry.cancelExpiry = setTimer(() => {
        if (entry.state === "reserved") remove(key, entry, "ttl-expiry");
      }, options.ttlMs);
      return Object.freeze({
        sessionID: identity.sessionID,
        messageID: identity.messageID,
        commit(route): boolean {
          if (entries.get(key) !== entry || entry.state !== "reserved" || !validRoute(route, entry.sessionID, entry.messageID)) {
            return false;
          }
          entry.cancelExpiry();
          entry.state = "committed";
          entry.route = Object.freeze({ ...route });
          entry.expiresAt = route.createdAt + committedTtlMs;
          entry.cancelExpiry = setTimer(
            () => remove(key, entry, "ttl-expiry"),
            Math.max(0, entry.expiresAt - now()),
          );
          return true;
        },
        release(): void {
          remove(key, entry);
        },
      });
    },
    get(sessionID, messageID): CommittedAgentRoute | undefined {
      cleanupExpired();
      const key = compositeKey(sessionID, messageID);
      if (!key) return undefined;
      const entry = entries.get(key);
      return entry?.state === "committed" ? entry.route : undefined;
    },
    wasCommitted(sessionID, messageID): boolean {
      cleanupExpired();
      purgeTombstones();
      const key = compositeKey(sessionID, messageID);
      return key !== undefined
        && (committedTombstones.has(key) || tombstoneOverflowExpiresAt > now());
    },
    claimSideEffects(sessionID, messageID): boolean {
      cleanupExpired();
      const key = compositeKey(sessionID, messageID);
      if (!key) return false;
      const entry = entries.get(key);
      if (!entry || entry.state !== "committed" || entry.sideEffectsClaimed) return false;
      entry.sideEffectsClaimed = true;
      return true;
    },
    invalidate(sessionID, messageID): void {
      const key = compositeKey(sessionID, messageID);
      if (!key) return;
      const entry = entries.get(key);
      if (entry?.state === "committed") retainCommittedTombstone(key);
      remove(key, entry);
    },
    delete(sessionID, messageID): void {
      const key = compositeKey(sessionID, messageID);
      if (key) {
        remove(key);
        committedTombstones.delete(key);
      }
    },
    cleanupSession(sessionID): void {
      for (const [key, entry] of entries) {
        if (entry.sessionID === sessionID) remove(key, entry);
      }
      const prefix = `${sessionID}\u0000`;
      for (const key of committedTombstones.keys()) {
        if (key.startsWith(prefix)) committedTombstones.delete(key);
      }
    },
    clear(): void {
      for (const key of [...entries.keys()]) remove(key);
      committedTombstones.clear();
      tombstoneOverflowExpiresAt = 0;
    },
    inspect() {
      cleanupExpired();
      return [...entries.values()].map((entry) => Object.freeze({
        state: entry.state,
        sessionID: entry.sessionID,
        messageID: entry.messageID,
        ...(entry.route ? { route: entry.route } : {}),
      }));
    },
  });
}

export type ManualAgentPolicyState = Readonly<{
  observe(sessionID: string, sourceAgent: RingAgentID, turnOrder: number): RingAgentID | undefined;
  expectPath(sessionID: string, path: readonly RingAgentID[], generation: number): void;
  reset(sessionID: string): void;
  cleanupSession(sessionID: string): void;
  clear(): void;
  inspect(): readonly Readonly<{
    sessionID: string;
    currentAgent: RingAgentID;
    lock?: RingAgentID;
    expectedPath?: readonly RingAgentID[];
    generation?: number;
  }>[];
}>;

export function createManualAgentPolicyState(policy: "typesafe-first" | "manual-first"): ManualAgentPolicyState {
  const sessions = new Map<string, {
    currentAgent: RingAgentID;
    lock?: RingAgentID;
    expectedPath: readonly RingAgentID[] | undefined;
    generation: number | undefined;
  }>();
  return Object.freeze({
    observe(sessionID, sourceAgent, turnOrder): RingAgentID | undefined {
      if (policy === "typesafe-first" || !sessionID || !Number.isSafeInteger(turnOrder) || turnOrder <= 0) return undefined;
      const state = sessions.get(sessionID);
      if (!state) {
        sessions.set(sessionID, { currentAgent: sourceAgent, expectedPath: undefined, generation: undefined });
        return undefined;
      }
      if (state.lock) return state.lock;
      if (state.expectedPath) {
        const pluginConsistent = sourceAgent === state.currentAgent || state.expectedPath.includes(sourceAgent);
        state.expectedPath = undefined;
        state.generation = undefined;
        if (pluginConsistent) {
          state.currentAgent = sourceAgent;
          return undefined;
        }
      } else if (sourceAgent === state.currentAgent) {
        return undefined;
      }
      state.currentAgent = sourceAgent;
      state.lock = sourceAgent;
      return state.lock;
    },
    expectPath(sessionID, path, generation): void {
      if (policy !== "manual-first" || !Number.isSafeInteger(generation) || generation <= 0 || path.length > 2) return;
      const state = sessions.get(sessionID);
      if (!state || state.lock || path.some((agent) => !LOGICAL_AGENT_RING.includes(agent))) return;
      state.expectedPath = Object.freeze([...path]);
      state.generation = generation;
    },
    reset(sessionID): void {
      sessions.delete(sessionID);
    },
    cleanupSession(sessionID): void {
      sessions.delete(sessionID);
    },
    clear(): void {
      sessions.clear();
    },
    inspect() {
      return [...sessions.entries()].map(([sessionID, state]) => Object.freeze({
        sessionID,
        currentAgent: state.currentAgent,
        ...(state.lock ? { lock: state.lock } : {}),
        ...(state.expectedPath ? { expectedPath: state.expectedPath } : {}),
        ...(state.generation ? { generation: state.generation } : {}),
      }));
    },
  });
}
