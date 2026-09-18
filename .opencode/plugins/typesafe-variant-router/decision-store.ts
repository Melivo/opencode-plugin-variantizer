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

function validateOptions(options: StoreOptions): void {
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

  const remove = (messageID: string, expected?: ManagedEntry<T>, notify = true): StoredDecision<T> | undefined => {
    const managed = entries.get(messageID);
    if (!managed || (expected && managed !== expected)) return undefined;
    entries.delete(messageID);
    managed.cancelExpiry();
    if (notify) {
      managed.entry.claimSideEffects();
      notifyRemoval(managed);
    }
    return managed.entry;
  };

  const cleanupExpired = (): void => {
    const current = now();
    for (const [messageID, managed] of entries) {
      if (managed.entry.expiresAt <= current) remove(messageID, managed);
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
      managed.cancelExpiry = setTimer(() => remove(metadata.messageID, managed), options.ttlMs);
      while (entries.size > options.maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        remove(oldest);
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
