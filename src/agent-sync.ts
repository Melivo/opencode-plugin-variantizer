export const AGENT_SYNC_UNAVAILABLE_REASONS = Object.freeze([
  "targetless-command",
  "unproven-selector-scope",
  "ambiguous-delivery",
] as const);

export type AgentSyncUnavailableReason = typeof AGENT_SYNC_UNAVAILABLE_REASONS[number];

export type AgentSyncDiagnostic = Readonly<{
  code: "agent-sync-unavailable";
  status: "unavailable";
  reasons: readonly AgentSyncUnavailableReason[];
}>;

export type AgentSyncSnapshot = Readonly<{
  capability: "unavailable";
  enabled: boolean;
  disposed: boolean;
  retainedEntries: 0;
  reasons: readonly AgentSyncUnavailableReason[];
}>;

export type AgentSync = Readonly<{
  reportUnavailable(): void;
  cleanupSession(sessionID: string): void;
  clear(): void;
  inspect(): AgentSyncSnapshot;
}>;

type UnavailableAgentSyncOptions = Readonly<{
  enabled: boolean;
  onDiagnostic?: (diagnostic: AgentSyncDiagnostic) => void;
}>;

const DIAGNOSTIC: AgentSyncDiagnostic = Object.freeze({
  code: "agent-sync-unavailable",
  status: "unavailable",
  reasons: AGENT_SYNC_UNAVAILABLE_REASONS,
});

/**
 * G3 is unavailable for the pinned host. This deliberately has no command
 * publisher or scheduling API, so selector projection cannot affect routing.
 */
export function createUnavailableAgentSync(options: UnavailableAgentSyncOptions): AgentSync {
  let disposed = false;
  let reported = false;

  return Object.freeze({
    reportUnavailable(): void {
      if (!options.enabled || disposed || reported) return;
      reported = true;
      try {
        options.onDiagnostic?.(DIAGNOSTIC);
      } catch {
        // Diagnostics are observational and must never affect provider routing.
      }
    },
    cleanupSession(_sessionID: string): void {
      // The unavailable branch retains no session or turn state.
    },
    clear(): void {
      disposed = true;
    },
    inspect(): AgentSyncSnapshot {
      return Object.freeze({
        capability: "unavailable",
        enabled: options.enabled,
        disposed,
        retainedEntries: 0,
        reasons: AGENT_SYNC_UNAVAILABLE_REASONS,
      });
    },
  });
}
