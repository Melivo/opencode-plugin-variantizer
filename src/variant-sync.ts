export type VariantObservation = Readonly<{
  messageID: string;
  sessionID: string;
  modelID: string;
  sourceVariant: string;
  catalog: readonly string[];
  turnOrder: number;
}>;

export type VariantSyncRequest = VariantObservation & Readonly<{
  targetVariant: string;
}>;

export type VariantSyncDiagnostic = Readonly<{
  reason: "variant-sync-publish-failed" | "variant-sync-ambiguous";
}>;

export type VariantSyncQueue = {
  observe(observation: VariantObservation): void;
  schedule(request: VariantSyncRequest): void;
  discard(messageID: string): void;
  cleanupSession(sessionID: string): void;
  clear(): void;
  flush(): Promise<void>;
};

type PendingSync = { cancelled: boolean };
type ObservedVariant = VariantObservation;
type ModelState = {
  catalog: readonly string[];
  currentVariant: string;
  turnOrder: number;
};

const DEFAULT_UNMATCHED_OBSERVATION_CAPACITY = 256;

function sameCatalog(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function normalizedVariant(catalog: readonly string[], variant: string): string {
  return catalog.includes(variant) ? variant : "default";
}

function nextVariant(catalog: readonly string[], current: string): string {
  const currentIndex = catalog.indexOf(current);
  if (currentIndex < 0) return catalog[0] ?? "default";
  return catalog[currentIndex + 1] ?? "default";
}

export function createVariantSyncQueue(
  cycleVariant: () => Promise<unknown>,
  maxUnmatchedObservations = DEFAULT_UNMATCHED_OBSERVATION_CAPACITY,
): VariantSyncQueue {
  return createVariantSyncQueueWithDiagnostics(cycleVariant, maxUnmatchedObservations);
}

export function createVariantSyncQueueWithDiagnostics(
  cycleVariant: () => Promise<unknown>,
  maxUnmatchedObservations = DEFAULT_UNMATCHED_OBSERVATION_CAPACITY,
  onDiagnostic?: (diagnostic: VariantSyncDiagnostic) => void,
): VariantSyncQueue {
  const report = (reason: VariantSyncDiagnostic["reason"]): void => {
    try { onDiagnostic?.({ reason }); } catch { /* Observers never affect TUI projection. */ }
  };
  const pendingBySession = new Map<string, Set<PendingSync>>();
  const observationsByMessage = new Map<string, ObservedVariant>();
  const observationsBySession = new Map<string, Set<string>>();
  const stateByModel = new Map<string, ModelState>();
  let latestTurnOrder = 0;
  let tail = Promise.resolve();
  let disposed = false;

  const removeObservation = (messageID: string): ObservedVariant | undefined => {
    const observation = observationsByMessage.get(messageID);
    if (!observation) return undefined;
    observationsByMessage.delete(messageID);
    const sessionMessages = observationsBySession.get(observation.sessionID);
    sessionMessages?.delete(messageID);
    if (sessionMessages?.size === 0) observationsBySession.delete(observation.sessionID);
    return observation;
  };

  const removePending = (sessionID: string, pending: PendingSync): void => {
    const sessionPending = pendingBySession.get(sessionID);
    sessionPending?.delete(pending);
    if (sessionPending?.size === 0) pendingBySession.delete(sessionID);
  };

  const observe = (observation: VariantObservation): ObservedVariant | undefined => {
    const existing = observationsByMessage.get(observation.messageID);
    if (existing) return existing;
    if (observation.turnOrder < latestTurnOrder) return undefined;
    latestTurnOrder = observation.turnOrder;
    const catalog = [...observation.catalog];
    const observed = {
      ...observation,
      catalog,
      sourceVariant: normalizedVariant(catalog, observation.sourceVariant),
    };
    observationsByMessage.set(observation.messageID, observed);
    const sessionMessages = observationsBySession.get(observation.sessionID) ?? new Set<string>();
    sessionMessages.add(observation.messageID);
    observationsBySession.set(observation.sessionID, sessionMessages);
    stateByModel.set(observation.modelID, {
      catalog,
      currentVariant: observed.sourceVariant,
      turnOrder: observed.turnOrder,
    });
    while (observationsByMessage.size > maxUnmatchedObservations) {
      const oldestMessageID = observationsByMessage.keys().next().value;
      if (oldestMessageID === undefined) break;
      const evicted = removeObservation(oldestMessageID);
      const state = evicted ? stateByModel.get(evicted.modelID) : undefined;
      if (evicted && state?.turnOrder === evicted.turnOrder) stateByModel.delete(evicted.modelID);
    }
    return observed;
  };

  return {
    observe(observation) {
      if (!disposed) observe(observation);
    },

    schedule(request) {
      if (disposed) return;
      let observation = removeObservation(request.messageID);
      if (
        !observation
        || observation.sessionID !== request.sessionID
        || observation.modelID !== request.modelID
        || observation.turnOrder !== request.turnOrder
        || !request.catalog.includes(request.targetVariant)
      ) return;
      if (!sameCatalog(observation.catalog, request.catalog)) {
        const catalog = [...request.catalog];
        observation = {
          ...observation,
          catalog,
          sourceVariant: normalizedVariant(catalog, observation.sourceVariant),
        };
        const state = stateByModel.get(request.modelID);
        if (!state || state.turnOrder <= observation.turnOrder) {
          stateByModel.set(request.modelID, {
            catalog,
            currentVariant: observation.sourceVariant,
            turnOrder: observation.turnOrder,
          });
        }
      }

      const initialState = stateByModel.get(request.modelID);
      if (
        initialState
        && initialState.turnOrder === observation.turnOrder
        && sameCatalog(initialState.catalog, request.catalog)
        && initialState.currentVariant === request.targetVariant
      ) return;

      const pending: PendingSync = { cancelled: false };
      const sessionPending = pendingBySession.get(request.sessionID) ?? new Set<PendingSync>();
      sessionPending.add(pending);
      pendingBySession.set(request.sessionID, sessionPending);

      const run = async (): Promise<void> => {
        try {
          while (!disposed && !pending.cancelled) {
            if (observation.turnOrder < latestTurnOrder) return;
            const state = stateByModel.get(request.modelID);
            if (!state || state.turnOrder > observation.turnOrder || !sameCatalog(state.catalog, request.catalog)) return;
            const current = normalizedVariant(state.catalog, state.currentVariant);
            if (current === request.targetVariant) return;

            // Give synchronously queued observations one microtask to replace stale work
            // before dispatching a global command. This is a handoff, not a timing delay.
            await Promise.resolve();
            if (disposed || pending.cancelled || observation.turnOrder !== latestTurnOrder) return;
            const dispatchState = stateByModel.get(request.modelID);
            if (
              !dispatchState
              || dispatchState.turnOrder !== observation.turnOrder
              || !sameCatalog(dispatchState.catalog, request.catalog)
            ) return;
            const dispatchCurrent = normalizedVariant(dispatchState.catalog, dispatchState.currentVariant);
            if (dispatchCurrent === request.targetVariant) return;
            const next = nextVariant(dispatchState.catalog, dispatchCurrent);
            const dispatchTurnOrder = latestTurnOrder;
            let succeeded: boolean;
            try {
              succeeded = await cycleVariant() === true;
            } catch {
              // A transport exception cannot prove whether the global event was handled.
              stateByModel.clear();
              report("variant-sync-ambiguous");
              return;
            }
            if (!succeeded) {
              stateByModel.delete(request.modelID);
              report("variant-sync-publish-failed");
              return;
            }
            if (latestTurnOrder !== dispatchTurnOrder) {
              // The command has no model identity or processing acknowledgement. A newer
              // visible owner makes the completed transition ambiguous for every projection.
              stateByModel.clear();
              report("variant-sync-ambiguous");
              return;
            }
            if (disposed || pending.cancelled) {
              stateByModel.delete(request.modelID);
              return;
            }
            const latest = stateByModel.get(request.modelID);
            if (
              !latest
              || latest.turnOrder !== observation.turnOrder
              || !sameCatalog(latest.catalog, request.catalog)
            ) return;
            latest.currentVariant = next;
          }
        } finally {
          removePending(request.sessionID, pending);
        }
      };
      tail = tail.then(run, run);
    },

    discard(messageID) {
      removeObservation(messageID);
    },

    cleanupSession(sessionID) {
      const sessionPending = pendingBySession.get(sessionID);
      if (sessionPending) {
        for (const pending of sessionPending) pending.cancelled = true;
        pendingBySession.delete(sessionID);
      }
      for (const messageID of observationsBySession.get(sessionID) ?? []) removeObservation(messageID);
    },

    clear() {
      disposed = true;
      for (const sessionPending of pendingBySession.values()) {
        for (const pending of sessionPending) pending.cancelled = true;
      }
      pendingBySession.clear();
      observationsByMessage.clear();
      observationsBySession.clear();
      stateByModel.clear();
    },

    flush() {
      return tail;
    },
  };
}
