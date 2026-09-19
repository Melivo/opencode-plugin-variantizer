import {
  AGENT_MODEL_BINDINGS,
  OBSERVED_PRIMARY_ORDER,
  createAgentTopologySnapshot,
  type AgentTopologySnapshot,
  type RingAgentID,
  type TopologyObservation,
} from "../../src/agent-topology.ts";
import {
  createAgentRouteRouter,
  type RejectedAgentRoute,
  type TypeSafeAgentRouteRequest,
} from "../../src/agent-route.ts";
import { createManualAgentPolicyState } from "../../src/decision-store.ts";
import type { VariantCatalog } from "../../src/open-code-variant-adapter.ts";
import {
  createTypeSafeRouter,
  type RouterReason,
  type ScoreLevel,
  type TypeSafeScoreAnswer,
  type TypeSafeScoreClient,
  type TypeSafeScoreRequest,
} from "../../src/typesafe-router.ts";

export const EVALUATION_CATEGORIES = ["simple", "medium", "complex", "ambiguous", "adversarial"] as const;
export type EvaluationCategory = typeof EVALUATION_CATEGORIES[number];
export type EvaluationImpact = "low" | "medium" | "high";

export type EvaluationFakeAnswer = Pick<TypeSafeScoreAnswer, "score" | "confidence" | "probabilities"> & { latencyMs: number };

export type EvaluationCase = {
  id: string;
  category: EvaluationCategory;
  model: string;
  prompt: string;
  expectedVariant: string;
  impact: EvaluationImpact;
  fakeAnswer: EvaluationFakeAnswer;
};

export type OfflineScoreClient = TypeSafeScoreClient & {
  latencyFor(prompt: string): number;
};

export type EvaluationMetrics = {
  total: number;
  selectionAgreement: { matched: number; total: number; rate: number };
  variantDistribution: Record<string, Record<string, number>>;
  fallbackRate: number;
  invalidResponseRate: number;
  technicalFallbackRate: number;
  fallbackReasons: Partial<Record<Exclude<RouterReason, "selected">, number>>;
  addedLatencyMs: { p50: number; p95: number };
  highImpactMisclassifications: Array<{
    id: string;
    expectedVariant: string;
    actualVariant: string;
  }>;
};

const CANDIDATES = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
const FIXTURE_LEVELS = CANDIDATES.map((candidate) => ({
  profile: `Offline fixture profile for ${candidate}.`,
  boundaries: "Evaluation-only standalone level; not a production criterion.",
  examples: [`Fixture example for ${candidate}.`],
})) as [ScoreLevel, ScoreLevel, ...ScoreLevel[]];
const FIXTURE_CATALOG: VariantCatalog = {
  modelKey: "offline/evaluation",
  source: "explicit-config",
  names: [...CANDIDATES],
  runtimeNames: [],
  optionsByVariant: Object.fromEntries(CANDIDATES.map((candidate) => [candidate, {}])),
};

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function requestFor(testCase: EvaluationCase): TypeSafeScoreRequest {
  return {
    state: { currentPrompt: testCase.prompt, recentMessages: [], model: testCase.model },
    instructions: {
      task: "Offline fixture: rate required reasoning effort.",
      ordering: "Use the fixture levels in their supplied order.",
      output: "Return one fixture Score answer.",
    },
    criteria: FIXTURE_LEVELS,
  };
}

export function createFixtureScoreClient(corpus: readonly EvaluationCase[]): OfflineScoreClient {
  const byPrompt = new Map(corpus.map((testCase) => [testCase.prompt, testCase.fakeAnswer]));
  return {
    async score(request) {
      const answer = byPrompt.get(request.state.currentPrompt);
      if (!answer) throw new Error("offline fixture missing");
      return {
        type: "score",
        score: answer.score,
        confidence: answer.confidence,
        legend: Object.fromEntries(request.criteria.map((criterion, index) => [String(index), criterion])),
        probabilities: answer.probabilities,
      };
    },
    latencyFor(prompt) {
      return byPrompt.get(prompt)?.latencyMs ?? 0;
    },
  };
}

export async function evaluateCorpus(
  corpus: readonly EvaluationCase[],
  client: OfflineScoreClient,
  options: { fallbackVariant: string },
): Promise<EvaluationMetrics> {
  const distribution: Record<string, Record<string, number>> = Object.create(null);
  const latencies: number[] = [];
  const highImpactMisclassifications: EvaluationMetrics["highImpactMisclassifications"] = [];
  const fallbackReasons: EvaluationMetrics["fallbackReasons"] = Object.create(null);
  let matched = 0;
  let fallbackCount = 0;
  let invalidResponseCount = 0;
  let technicalFallbackCount = 0;
  const router = createTypeSafeRouter({ client, now: () => 0 });

  for (const testCase of corpus) {
    const decision = await router.route({
      modelID: testCase.model,
      state: requestFor(testCase).state,
      catalog: FIXTURE_CATALOG,
      fallbackVariant: options.fallbackVariant,
      deadlineAt: 1_500,
      variantDescriptions: Object.create(null),
    });
    latencies.push(client.latencyFor(testCase.prompt));

    const actualVariant = decision.variant ?? options.fallbackVariant;

    if (decision.status !== "selected") {
      fallbackCount += 1;
      fallbackReasons[decision.reason] = (fallbackReasons[decision.reason] ?? 0) + 1;
      if (decision.reason === "invalid-response") invalidResponseCount += 1;
      else technicalFallbackCount += 1;
    }
    if (actualVariant === testCase.expectedVariant) matched += 1;
    if (testCase.impact === "high" && actualVariant !== testCase.expectedVariant) {
      highImpactMisclassifications.push({
        id: testCase.id,
        expectedVariant: testCase.expectedVariant,
        actualVariant,
      });
    }

    const modelDistribution = distribution[testCase.model] ??= Object.create(null);
    modelDistribution[actualVariant] = (modelDistribution[actualVariant] ?? 0) + 1;
  }

  return {
    total: corpus.length,
    selectionAgreement: {
      matched,
      total: corpus.length,
      rate: corpus.length === 0 ? 0 : matched / corpus.length,
    },
    variantDistribution: distribution,
    fallbackRate: corpus.length === 0 ? 0 : fallbackCount / corpus.length,
    invalidResponseRate: corpus.length === 0 ? 0 : invalidResponseCount / corpus.length,
    technicalFallbackRate: corpus.length === 0 ? 0 : technicalFallbackCount / corpus.length,
    fallbackReasons,
    addedLatencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
    highImpactMisclassifications,
  };
}

export type AgentEvaluationCase = Readonly<{
  id: string;
  prompt: string;
  sourceAgent: RingAgentID;
  acceptableAgents: readonly RingAgentID[];
  expectedVariant: string;
  targetAgent: RingAgentID;
  targetVariant: string;
  choiceConfidence: number;
  variantConfidence: number;
  latencyMs: number;
  outcome: "selected" | "invalid-response" | "client-error" | "topology-drift" | "cancelled";
  pipelineOutcome: "success" | "parameter-binding-abort" | "provider-failure";
  syncOutcome: "unavailable" | "suppressed";
}>;

export type ManualLockEvaluationCase = Readonly<{
  sessionID: string;
  sourceAgent: RingAgentID;
  turnOrder: number;
  expectedPath?: readonly RingAgentID[];
  expectedLock: boolean;
}>;

export type AgentEvaluationMetrics = Readonly<{
  total: number;
  targetAgentAcceptability: Readonly<{ matched: number; total: number; rate: number }>;
  selectedVariantAppropriateness: Readonly<{ matched: number; total: number; rate: number }>;
  agentDistribution: Record<RingAgentID, number>;
  variantDistribution: Record<string, Record<string, number>>;
  confidenceCalibration: Readonly<{
    mean: number;
    correctMean: number;
    incorrectMean: number;
    brierScore: number;
  }>;
  failures: Readonly<{
    precommitRejection: number;
    parameterBindingAbort: number;
    providerFailure: number;
  }>;
  rejectionReasons: Partial<Record<RejectedAgentRoute["reason"], number>>;
  syncOutcomes: Record<AgentEvaluationCase["syncOutcome"], number>;
  addedLatencyMs: Readonly<{ p50: number; p95: number }>;
  manualLockPrecision: Readonly<{
    truePositive: number;
    falsePositive: number;
    falseNegative: number;
    precision: number;
  }>;
}>;

const AGENT_EVALUATION_VARIANTS = Object.freeze(["low", "medium", "high"] as const);
const EVALUATION_BEHAVIOR = Object.freeze({ prompt: "shared", permission: "same", tools: ["same"], skills: ["same"] });

function evaluationTopology(): AgentTopologySnapshot {
  const catalog = (agent: RingAgentID) => ({
    modelKey: AGENT_MODEL_BINDINGS[agent],
    names: AGENT_EVALUATION_VARIANTS,
    runtimeNames: AGENT_EVALUATION_VARIANTS,
    optionsByVariant: Object.fromEntries(AGENT_EVALUATION_VARIANTS.map((variant) => [variant, { reasoningEffort: variant }])),
  });
  return createAgentTopologySnapshot({
    generationID: "offline-agent-evaluation-v1",
    orderedPrimaryAgents: OBSERVED_PRIMARY_ORDER,
    agentToModel: AGENT_MODEL_BINDINGS,
    behaviorByAgent: { luna: EVALUATION_BEHAVIOR, terra: EVALUATION_BEHAVIOR, sol: EVALUATION_BEHAVIOR },
    providerBoundaryByAgent: { luna: EVALUATION_BEHAVIOR, terra: EVALUATION_BEHAVIOR, sol: EVALUATION_BEHAVIOR },
    catalogsByAgent: { luna: catalog("luna"), terra: catalog("terra"), sol: catalog("sol") },
  });
}

function evaluationObservation(topology: AgentTopologySnapshot, sourceAgent: RingAgentID): TopologyObservation {
  return {
    generationID: topology.generationID,
    sourceAgent,
    sourceModel: topology.agentToModel[sourceAgent],
    orderedPrimaryAgents: topology.orderedPrimaryAgents,
    agentToModel: topology.agentToModel,
    behaviorFingerprint: topology.behaviorFingerprint,
    providerBoundaryFingerprint: topology.providerBoundaryFingerprint,
    catalogFingerprints: topology.catalogFingerprints,
    optionsFingerprints: topology.optionsFingerprints,
  };
}

function selectedProbabilities(selected: number, confidence: number, length: number): Record<string, number> {
  const remainder = (1 - confidence) / (length - 1);
  return Object.fromEntries(Array.from({ length }, (_entry, index) => [String(index), index === selected ? confidence : remainder]));
}

function evaluationScore(criteria: readonly ScoreLevel[], selected: number, confidence: number) {
  const probabilities = selectedProbabilities(selected, confidence, criteria.length);
  return {
    type: "score",
    score: Object.entries(probabilities).reduce((total, [index, probability]) => total + Number(index) * probability, 0),
    confidence,
    legend: Object.fromEntries(criteria.map((criterion, index) => [String(index), criterion])),
    probabilities,
  };
}

function evaluationResponse(request: TypeSafeAgentRouteRequest, testCase: AgentEvaluationCase): unknown {
  const otherProbability = (1 - testCase.choiceConfidence) / 2;
  const choiceProbabilities = Object.fromEntries((["luna", "terra", "sol"] as const).map((agent) => [
    agent,
    agent === testCase.targetAgent ? testCase.choiceConfidence : otherProbability,
  ]));
  const targetIndex = AGENT_EVALUATION_VARIANTS.indexOf(testCase.targetVariant as typeof AGENT_EVALUATION_VARIANTS[number]);
  const score = (agent: RingAgentID) => evaluationScore(
    request.questions[`reasoning_for_${agent}`].criteria,
    agent === testCase.targetAgent ? targetIndex : 0,
    agent === testCase.targetAgent ? testCase.variantConfidence : 1,
  );
  return {
    model: "offline-jev-fixture",
    answers: {
      target_agent: {
        type: "choice",
        choice: testCase.outcome === "invalid-response"
          ? (testCase.targetAgent === "luna" ? "terra" : "luna")
          : testCase.targetAgent,
        confidence: testCase.choiceConfidence,
        probabilities: choiceProbabilities,
      },
      reasoning_for_luna: score("luna"),
      reasoning_for_terra: score("terra"),
      reasoning_for_sol: score("sol"),
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function evaluateManualLocks(cases: readonly ManualLockEvaluationCase[]) {
  const state = createManualAgentPolicyState("manual-first");
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const testCase of cases) {
    if (testCase.expectedPath) state.expectPath(testCase.sessionID, testCase.expectedPath, testCase.turnOrder);
    const actualLock = state.observe(testCase.sessionID, testCase.sourceAgent, testCase.turnOrder) !== undefined;
    if (actualLock && testCase.expectedLock) truePositive += 1;
    else if (actualLock) falsePositive += 1;
    else if (testCase.expectedLock) falseNegative += 1;
  }
  return {
    truePositive,
    falsePositive,
    falseNegative,
    precision: truePositive + falsePositive === 0 ? 1 : truePositive / (truePositive + falsePositive),
  };
}

export async function evaluateAgentCorpus(
  corpus: readonly AgentEvaluationCase[],
  manualLockCases: readonly ManualLockEvaluationCase[],
): Promise<AgentEvaluationMetrics> {
  const topology = evaluationTopology();
  const latencies: number[] = [];
  const agentDistribution: Record<RingAgentID, number> = { luna: 0, terra: 0, sol: 0 };
  const variantDistribution: Record<string, Record<string, number>> = {};
  const rejectionReasons: AgentEvaluationMetrics["rejectionReasons"] = {};
  const syncOutcomes: AgentEvaluationMetrics["syncOutcomes"] = { unavailable: 0, suppressed: 0 };
  const confidences: number[] = [];
  const correctConfidences: number[] = [];
  const incorrectConfidences: number[] = [];
  const brierTerms: number[] = [];
  let agentMatched = 0;
  let variantMatched = 0;
  let selectedTotal = 0;
  let precommitRejection = 0;
  let parameterBindingAbort = 0;
  let providerFailure = 0;

  for (const testCase of corpus) {
    latencies.push(testCase.latencyMs);
    syncOutcomes[testCase.syncOutcome] += 1;
    const observation = evaluationObservation(topology, testCase.sourceAgent);
    const controller = new AbortController();
    if (testCase.outcome === "cancelled") controller.abort();
    const router = createAgentRouteRouter({
      now: () => 0,
      client: {
        async route(request) {
          if (testCase.outcome === "client-error") throw new Error("PRIVATE fixture client error");
          return evaluationResponse(request, testCase);
        },
      },
    });
    const decision = await router.route({
      state: { currentPrompt: testCase.prompt, recentMessages: [], model: AGENT_MODEL_BINDINGS[testCase.sourceAgent] },
      sourceAgent: testCase.sourceAgent,
      sourceModel: AGENT_MODEL_BINDINGS[testCase.sourceAgent],
      topology,
      observation,
      observeCurrentTopology: () => testCase.outcome === "topology-drift"
        ? { ...observation, generationID: "drifted" }
        : observation,
      agentProfiles: { luna: "Luna profile", terra: "Terra profile", sol: "Sol profile" },
      variantDescriptionsByAgent: {},
      timeoutMs: 1_000,
      signal: controller.signal,
    });

    if (decision.status === "rejected") {
      precommitRejection += 1;
      rejectionReasons[decision.reason] = (rejectionReasons[decision.reason] ?? 0) + 1;
      continue;
    }

    selectedTotal += 1;
    agentDistribution[decision.targetAgent] += 1;
    const modelDistribution = variantDistribution[decision.targetModel] ??= {};
    modelDistribution[decision.targetVariant] = (modelDistribution[decision.targetVariant] ?? 0) + 1;
    const acceptableAgent = testCase.acceptableAgents.includes(decision.targetAgent);
    const appropriateVariant = decision.targetVariant === testCase.expectedVariant;
    if (acceptableAgent) agentMatched += 1;
    if (appropriateVariant) variantMatched += 1;
    const correct = acceptableAgent && appropriateVariant;
    confidences.push(decision.confidence);
    (correct ? correctConfidences : incorrectConfidences).push(decision.confidence);
    brierTerms.push((decision.confidence - (correct ? 1 : 0)) ** 2);
    if (testCase.pipelineOutcome === "parameter-binding-abort") parameterBindingAbort += 1;
    if (testCase.pipelineOutcome === "provider-failure") providerFailure += 1;
  }

  return {
    total: corpus.length,
    targetAgentAcceptability: {
      matched: agentMatched,
      total: selectedTotal,
      rate: selectedTotal === 0 ? 0 : agentMatched / selectedTotal,
    },
    selectedVariantAppropriateness: {
      matched: variantMatched,
      total: selectedTotal,
      rate: selectedTotal === 0 ? 0 : variantMatched / selectedTotal,
    },
    agentDistribution,
    variantDistribution,
    confidenceCalibration: {
      mean: mean(confidences),
      correctMean: mean(correctConfidences),
      incorrectMean: mean(incorrectConfidences),
      brierScore: Math.round(mean(brierTerms) * 1_000_000_000_000) / 1_000_000_000_000,
    },
    failures: { precommitRejection, parameterBindingAbort, providerFailure },
    rejectionReasons,
    syncOutcomes,
    addedLatencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    manualLockPrecision: evaluateManualLocks(manualLockCases),
  };
}
