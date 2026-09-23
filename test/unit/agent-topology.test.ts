import { describe, expect, test } from "bun:test";

import {
  AGENT_MODEL_BINDINGS,
  LOGICAL_AGENT_RING,
  OBSERVED_PRIMARY_ORDER,
  AgentTopologyError,
  createAgentTopologySnapshot,
  validateTopologyObservation,
} from "../../src/agent-topology.ts";

const behavior = {
  prompt: "Shared build-capable primary-agent prompt.",
  permission: { edit: "allow", bash: "allow", webfetch: "allow" },
  tools: { edit: true, write: true, bash: true },
  skills: ["shared"],
};
const providerBoundary = {
  instructions: ["shared"],
  tools: [{ name: "edit" }],
  other: { temperature: 0.2, topP: 0.9 },
};

function validInput() {
  return {
    generationID: "generation-1",
    orderedPrimaryAgents: [...OBSERVED_PRIMARY_ORDER],
    agentToModel: { ...AGENT_MODEL_BINDINGS },
    behaviorByAgent: {
      luna: structuredClone(behavior),
      terra: structuredClone(behavior),
      sol: structuredClone(behavior),
    },
    providerBoundaryByAgent: {
      luna: structuredClone(providerBoundary),
      terra: structuredClone(providerBoundary),
      sol: structuredClone(providerBoundary),
    },
    catalogsByAgent: {
      luna: {
        modelKey: AGENT_MODEL_BINDINGS.luna,
        names: ["low", "high"],
        runtimeNames: ["low", "high"],
        optionsByVariant: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } },
      },
      terra: {
        modelKey: AGENT_MODEL_BINDINGS.terra,
        names: ["low"],
        runtimeNames: ["low"],
        optionsByVariant: { low: { reasoningEffort: "low" } },
      },
      sol: {
        modelKey: AGENT_MODEL_BINDINGS.sol,
        names: ["medium"],
        runtimeNames: ["medium"],
        optionsByVariant: { medium: { reasoningEffort: "medium" } },
      },
    },
  };
}

describe("agent topology snapshot", () => {
  test("defines the remediated reverse-cycle ring and exact fixed bindings", () => {
    expect(LOGICAL_AGENT_RING).toEqual(["luna", "terra", "sol"]);
    expect(OBSERVED_PRIMARY_ORDER).toEqual(["luna", "sol", "terra"]);
    expect(AGENT_MODEL_BINDINGS).toEqual({
      luna: "openai/gpt-5.6-luna",
      terra: "openai/gpt-5.6-terra",
      sol: "openai/gpt-5.6-sol",
    });
  });

  test("creates an immutable non-secret generation with equal behavior evidence", () => {
    const input = validInput();
    const snapshot = createAgentTopologySnapshot(input);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.catalogsByAgent.luna.optionsByVariant.low)).toBe(true);
    expect(snapshot.behaviorFingerprints.luna).toBe(snapshot.behaviorFingerprints.terra);
    expect(snapshot.behaviorFingerprints.terra).toBe(snapshot.behaviorFingerprints.sol);
    expect(snapshot.providerBoundaryFingerprints.luna).toBe(snapshot.providerBoundaryFingerprints.sol);
    expect(JSON.stringify(snapshot)).not.toContain("Shared build-capable primary-agent prompt.");
    input.catalogsByAgent.luna.optionsByVariant.low.reasoningEffort = "mutated";
    expect(snapshot.catalogsByAgent.luna.optionsByVariant.low).toEqual({ reasoningEffort: "low" });
  });

  test("rejects extra primaries, wrong bindings, behavior drift, malformed catalogs, and unsafe options", () => {
    const invalidInputs = [
      { ...validInput(), orderedPrimaryAgents: [...OBSERVED_PRIMARY_ORDER, "extra"] },
      { ...validInput(), agentToModel: { ...AGENT_MODEL_BINDINGS, luna: AGENT_MODEL_BINDINGS.sol } },
      { ...validInput(), behaviorByAgent: { ...validInput().behaviorByAgent, sol: { ...behavior, tools: {} } } },
      { ...validInput(), catalogsByAgent: { ...validInput().catalogsByAgent, terra: { ...validInput().catalogsByAgent.terra, names: [] } } },
      { ...validInput(), catalogsByAgent: { ...validInput().catalogsByAgent, sol: { ...validInput().catalogsByAgent.sol, optionsByVariant: { medium: {} } } } },
    ];
    for (const input of invalidInputs) expect(() => createAgentTopologySnapshot(input)).toThrow(AgentTopologyError);
  });

  test("rejects stale generation, wrong source binding, and topology/catalog drift", () => {
    const snapshot = createAgentTopologySnapshot(validInput());
    const observation = {
      generationID: snapshot.generationID,
      sourceAgent: "luna" as const,
      sourceModel: AGENT_MODEL_BINDINGS.luna,
      orderedPrimaryAgents: snapshot.orderedPrimaryAgents,
      agentToModel: snapshot.agentToModel,
      behaviorFingerprint: snapshot.behaviorFingerprint,
      providerBoundaryFingerprint: snapshot.providerBoundaryFingerprint,
      catalogFingerprints: snapshot.catalogFingerprints,
      optionsFingerprints: snapshot.optionsFingerprints,
    };
    expect(validateTopologyObservation(snapshot, observation)).toBe(true);
    expect(validateTopologyObservation(snapshot, { ...observation, generationID: "stale" })).toBe(false);
    expect(validateTopologyObservation(snapshot, { ...observation, sourceModel: AGENT_MODEL_BINDINGS.sol })).toBe(false);
    expect(validateTopologyObservation(snapshot, {
      ...observation,
      catalogFingerprints: { ...observation.catalogFingerprints, luna: "drift" },
    })).toBe(false);
  });
});
