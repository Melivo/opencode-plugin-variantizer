import { describe, expect, test } from "bun:test";

import {
  AGENT_MODEL_BINDINGS,
  OBSERVED_PRIMARY_ORDER,
  createAgentTopologySnapshot,
  type AgentTopologySnapshot,
  type RingAgentID,
  type TopologyObservation,
} from "../../src/agent-topology.ts";
import {
  AGENT_ROUTE_QUESTION_IDS,
  createAgentRouteRouter,
  type TypeSafeAgentRouteClient,
  type TypeSafeAgentRouteRequest,
} from "../../src/agent-route.ts";

const sharedBehavior = { prompt: "shared", permission: { edit: "allow" }, tools: ["edit"], skills: ["shared"] };
const sharedBoundary = { instructions: ["shared"], tools: [{ name: "edit" }] };

function topology(): AgentTopologySnapshot {
  return createAgentTopologySnapshot({
    generationID: "generation-7",
    orderedPrimaryAgents: [...OBSERVED_PRIMARY_ORDER],
    agentToModel: { ...AGENT_MODEL_BINDINGS },
    behaviorByAgent: {
      luna: structuredClone(sharedBehavior),
      terra: structuredClone(sharedBehavior),
      sol: structuredClone(sharedBehavior),
    },
    providerBoundaryByAgent: {
      luna: structuredClone(sharedBoundary),
      terra: structuredClone(sharedBoundary),
      sol: structuredClone(sharedBoundary),
    },
    catalogsByAgent: {
      luna: catalog("luna", ["low", "high"]),
      terra: catalog("terra", ["medium", "high"]),
      sol: catalog("sol", ["high", "xhigh"]),
    },
  });
}

function catalog(agent: RingAgentID, names: readonly string[]) {
  return {
    modelKey: AGENT_MODEL_BINDINGS[agent],
    names: [...names],
    runtimeNames: [...names],
    optionsByVariant: Object.fromEntries(names.map((name) => [name, { reasoningEffort: name }])),
  };
}

function observation(snapshot: AgentTopologySnapshot): TopologyObservation {
  return {
    generationID: snapshot.generationID,
    sourceAgent: "luna",
    sourceModel: AGENT_MODEL_BINDINGS.luna,
    orderedPrimaryAgents: snapshot.orderedPrimaryAgents,
    agentToModel: snapshot.agentToModel,
    behaviorFingerprint: snapshot.behaviorFingerprint,
    providerBoundaryFingerprint: snapshot.providerBoundaryFingerprint,
    catalogFingerprints: snapshot.catalogFingerprints,
    optionsFingerprints: snapshot.optionsFingerprints,
  };
}

function scoreAnswer(criteria: readonly unknown[], probabilities: Record<string, number>) {
  return {
    type: "score",
    score: Object.entries(probabilities).reduce((sum, [index, probability]) => sum + Number(index) * probability, 0),
    confidence: 0.75,
    legend: Object.fromEntries(criteria.map((entry, index) => [String(index), entry])),
    probabilities,
  };
}

function validResponse(request: TypeSafeAgentRouteRequest) {
  return {
    model: "jev-latest",
    answers: {
      target_agent: {
        type: "choice",
        choice: "terra",
        confidence: 0.5,
        probabilities: { luna: 0.2, terra: 0.6, sol: 0.2 },
      },
      reasoning_for_luna: scoreAnswer(request.questions.reasoning_for_luna.criteria, { 0: 0.9, 1: 0.1 }),
      reasoning_for_terra: scoreAnswer(request.questions.reasoning_for_terra.criteria, { 0: 0.1, 1: 0.9 }),
      reasoning_for_sol: scoreAnswer(request.questions.reasoning_for_sol.criteria, { 0: 0.8, 1: 0.2 }),
    },
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

function input(snapshot: AgentTopologySnapshot) {
  const observed = observation(snapshot);
  return {
    state: {
      currentPrompt: "PRIVATE_PROMPT",
      recentMessages: [{ role: "user" as const, text: "PRIVATE_HISTORY" }],
      model: AGENT_MODEL_BINDINGS.luna,
    },
    sourceAgent: "luna" as const,
    sourceModel: AGENT_MODEL_BINDINGS.luna,
    topology: snapshot,
    observation: observed,
    observeCurrentTopology: () => observed,
    agentProfiles: {
      luna: "General software implementation under Luna's fixed model premise.",
      terra: "General software implementation under Terra's fixed model premise.",
      sol: "General software implementation under Sol's fixed model premise.",
    },
    variantDescriptionsByAgent: {},
    timeoutMs: 500,
  };
}

function clientWith(handler: TypeSafeAgentRouteClient["route"]): TypeSafeAgentRouteClient {
  return { route: handler };
}

describe("mixed TypeSafe agent route", () => {
  test("issues one request with exactly target_agent plus three model-conditioned Scores", async () => {
    const snapshot = topology();
    let calls = 0;
    let captured: TypeSafeAgentRouteRequest | undefined;
    const router = createAgentRouteRouter({
      client: clientWith(async (request) => {
        calls += 1;
        captured = request;
        return validResponse(request);
      }),
      now: () => 123,
    });

    const result = await router.route(input(snapshot));

    expect(calls).toBe(1);
    expect(Object.keys(captured?.questions ?? {})).toEqual([...AGENT_ROUTE_QUESTION_IDS]);
    expect(captured?.questions.target_agent.type).toBe("choice");
    expect(Object.keys(captured?.questions.target_agent.criteria ?? {})).toEqual(["luna", "terra", "sol"]);
    expect(captured?.questions.reasoning_for_luna).toMatchObject({ type: "score", modelPremise: AGENT_MODEL_BINDINGS.luna });
    expect(captured?.questions.reasoning_for_terra).toMatchObject({ type: "score", modelPremise: AGENT_MODEL_BINDINGS.terra });
    expect(captured?.questions.reasoning_for_sol).toMatchObject({ type: "score", modelPremise: AGENT_MODEL_BINDINGS.sol });
    expect(result).toEqual({
      status: "selected",
      targetAgent: "terra",
      targetModel: AGENT_MODEL_BINDINGS.terra,
      targetVariant: "high",
      confidence: 0.75,
      topologyGenerationID: snapshot.generationID,
      behaviorFingerprint: snapshot.behaviorFingerprint,
      catalogFingerprint: snapshot.catalogFingerprints.terra,
      optionsFingerprint: snapshot.optionsFingerprints.terra,
      createdAt: 123,
    });
  });

  test("uses deterministic local tie orders and requires Choice consistency", async () => {
    const snapshot = topology();
    const router = createAgentRouteRouter({
      client: clientWith(async (request) => {
        const response = validResponse(request);
        response.answers.target_agent = {
          type: "choice",
          choice: "luna",
          confidence: 0,
          probabilities: { luna: 0.4, terra: 0.4, sol: 0.2 },
        };
        response.answers.reasoning_for_luna = scoreAnswer(request.questions.reasoning_for_luna.criteria, { 0: 0.5, 1: 0.5 });
        return response;
      }),
      now: () => 1,
    });
    expect(await router.route(input(snapshot))).toMatchObject({
      status: "selected",
      targetAgent: "luna",
      targetVariant: "low",
    });

    const inconsistent = createAgentRouteRouter({
      client: clientWith(async (request) => {
        const response = validResponse(request);
        response.answers.target_agent.choice = "sol";
        return response;
      }),
      now: () => 1,
    });
    expect(await inconsistent.route(input(snapshot))).toEqual({ status: "rejected", reason: "invalid-response", createdAt: 1 });
  });

  test("manual lock ignores target_agent and consumes only the locked agent Score", async () => {
    const snapshot = topology();
    const router = createAgentRouteRouter({
      client: clientWith(async (request) => {
        const response = validResponse(request);
        response.answers.reasoning_for_luna = scoreAnswer(request.questions.reasoning_for_luna.criteria, { 0: 0, 1: 1 });
        response.answers.reasoning_for_terra = scoreAnswer(request.questions.reasoning_for_terra.criteria, { 0: 1, 1: 0 });
        response.answers.reasoning_for_sol = scoreAnswer(request.questions.reasoning_for_sol.criteria, { 0: 0.2, 1: 0.8 });
        return response;
      }),
      now: () => 2,
    });

    const result = await router.route({ ...input(snapshot), manualLock: "sol" });

    expect(result).toMatchObject({
      status: "selected",
      targetAgent: "sol",
      targetModel: AGENT_MODEL_BINDINGS.sol,
      targetVariant: "xhigh",
    });
    expect(Object.keys(result)).not.toContain("probabilities");
    expect(Object.keys(result)).not.toContain("answers");
  });

  test("strictly rejects malformed envelopes, answers, probabilities, confidence, legends, and extra fields", async () => {
    const snapshot = topology();
    const mutations: Array<(response: ReturnType<typeof validResponse>) => unknown> = [
      (response) => ({ ...response, extra: true }),
      (response) => ({ ...response, answers: { ...response.answers, extra: response.answers.target_agent } }),
      (response) => ({ ...response, answers: { ...response.answers, target_agent: { ...response.answers.target_agent, type: "score" } } }),
      (response) => ({ ...response, answers: { ...response.answers, target_agent: { ...response.answers.target_agent, probabilities: { luna: 0.5, terra: 0.5 } } } }),
      (response) => ({ ...response, answers: { ...response.answers, target_agent: { ...response.answers.target_agent, probabilities: { luna: Number.NaN, terra: 0.5, sol: 0.5 } } } }),
      (response) => ({ ...response, answers: { ...response.answers, target_agent: { ...response.answers.target_agent, confidence: 1.1 } } }),
      (response) => ({ ...response, answers: { ...response.answers, reasoning_for_terra: { ...response.answers.reasoning_for_terra, legend: { 0: "wrong", 1: "wrong" } } } }),
      (response) => ({ ...response, answers: { ...response.answers, reasoning_for_sol: { ...response.answers.reasoning_for_sol, probabilities: { 0: 0.2, 1: 0.7 } } } }),
      (response) => ({ ...response, usage: { input_tokens: -1, output_tokens: 2 } }),
    ];

    for (const mutate of mutations) {
      const router = createAgentRouteRouter({
        client: clientWith(async (request) => mutate(validResponse(request))),
        now: () => 9,
      });
      expect(await router.route(input(snapshot))).toEqual({ status: "rejected", reason: "invalid-response", createdAt: 9 });
    }
  });

  test("rejects stale generations before and after the single external request", async () => {
    const snapshot = topology();
    let calls = 0;
    const staleBefore = input(snapshot);
    staleBefore.observation = { ...staleBefore.observation, generationID: "stale" };
    const beforeRouter = createAgentRouteRouter({
      client: clientWith(async (request) => {
        calls += 1;
        return validResponse(request);
      }),
      now: () => 4,
    });
    expect(await beforeRouter.route(staleBefore)).toEqual({ status: "rejected", reason: "stale-topology", createdAt: 4 });
    expect(calls).toBe(0);

    const afterRouter = createAgentRouteRouter({
      client: clientWith(async (request) => validResponse(request)),
      now: () => 5,
    });
    const staleAfter = input(snapshot);
    staleAfter.observeCurrentTopology = () => ({ ...staleAfter.observation, optionsFingerprints: { ...snapshot.optionsFingerprints, sol: "drift" } });
    expect(await afterRouter.route(staleAfter)).toEqual({ status: "rejected", reason: "stale-topology", createdAt: 5 });
  });
});
