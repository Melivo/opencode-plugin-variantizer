import { describe, expect, test } from "bun:test";

import {
  AGENT_SYNC_UNAVAILABLE_REASONS,
  createUnavailableAgentSync,
  type AgentSyncDiagnostic,
} from "../../src/agent-sync.ts";

describe("unavailable agent selector synchronization", () => {
  test("reports one sanitized unavailable diagnostic and retains no turn state", () => {
    const diagnostics: AgentSyncDiagnostic[] = [];
    const sync = createUnavailableAgentSync({
      enabled: true,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    sync.reportUnavailable();
    sync.reportUnavailable();
    sync.cleanupSession("PRIVATE-session-canary");

    expect(diagnostics).toEqual([{
      code: "agent-sync-unavailable",
      status: "unavailable",
      reasons: AGENT_SYNC_UNAVAILABLE_REASONS,
    }]);
    expect(sync.inspect()).toEqual({
      capability: "unavailable",
      enabled: true,
      disposed: false,
      retainedEntries: 0,
      reasons: AGENT_SYNC_UNAVAILABLE_REASONS,
    });
    const retained = JSON.stringify(sync.inspect());
    for (const canary of ["PRIVATE", "prompt", "history", "credential", "probabilities", "options"]) {
      expect(retained).not.toContain(canary);
    }
  });

  test("suppresses diagnostics when disabled or disposed", () => {
    let disabledCalls = 0;
    const disabled = createUnavailableAgentSync({
      enabled: false,
      onDiagnostic: () => { disabledCalls += 1; },
    });
    disabled.reportUnavailable();
    expect(disabledCalls).toBe(0);
    expect(disabled.inspect()).toMatchObject({ enabled: false, retainedEntries: 0 });

    let disposedCalls = 0;
    const disposed = createUnavailableAgentSync({
      enabled: true,
      onDiagnostic: () => { disposedCalls += 1; },
    });
    disposed.clear();
    disposed.reportUnavailable();
    disposed.cleanupSession("session");
    expect(disposedCalls).toBe(0);
    expect(disposed.inspect()).toMatchObject({ disposed: true, retainedEntries: 0 });
  });

  test("contains observer failures and exposes no command publication surface", () => {
    const sync = createUnavailableAgentSync({
      enabled: true,
      onDiagnostic: () => { throw new Error("PRIVATE raw observer failure"); },
    });

    expect(() => sync.reportUnavailable()).not.toThrow();
    expect("publish" in sync).toBe(false);
    expect("schedule" in sync).toBe(false);
    expect(JSON.stringify(sync.inspect())).not.toContain("PRIVATE");
  });
});
