import { describe, expect, test } from "bun:test";

import corpusData from "./corpus.json";
import {
  EVALUATION_CATEGORIES,
  createFixtureScoreClient,
  evaluateAgentCorpus,
  evaluateCorpus,
  type AgentEvaluationCase,
  type EvaluationCase,
  type ManualLockEvaluationCase,
  type OfflineScoreClient,
} from "./evaluation-harness.ts";
import type {
  TypeSafeScoreAnswer,
  TypeSafeScoreRequest,
} from "../../src/typesafe-router.ts";

const corpus = corpusData as EvaluationCase[];

function validAnswer(request: TypeSafeScoreRequest): TypeSafeScoreAnswer {
  return {
    type: "score",
    score: 0,
    confidence: 0.9,
    legend: Object.fromEntries(request.criteria.map((criterion, index) => [String(index), criterion])),
    probabilities: { "0": 1, "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
  };
}

function answerClient(
  transform: (answer: TypeSafeScoreAnswer) => TypeSafeScoreAnswer,
  captured: TypeSafeScoreRequest[],
): OfflineScoreClient {
  return {
    async score(request) {
      captured.push(request);
      return transform(validAnswer(request));
    },
    latencyFor: () => 1,
  };
}

describe("deterministic offline evaluation", () => {
  test("covers every approved non-sensitive category", () => {
    const categories = new Set(corpus.map((testCase) => testCase.category));
    expect([...categories].sort()).toEqual([...EVALUATION_CATEGORIES].sort());
    for (const category of EVALUATION_CATEGORIES) {
      expect(corpus.filter((testCase) => testCase.category === category).length).toBeGreaterThanOrEqual(2);
    }
    expect(JSON.stringify(corpus)).not.toContain("TYPESAFE_API_KEY");
  });

  test("reports quality, distribution, fallback, confidence, latency, and high-impact errors", async () => {
    const metrics = await evaluateCorpus(corpus, createFixtureScoreClient(corpus), {
      fallbackVariant: "medium",
    });

    expect(metrics.total).toBe(10);
    expect(metrics.selectionAgreement).toEqual({ matched: 7, total: 10, rate: 0.7 });
    expect(metrics.fallbackRate).toBe(0);
    expect(metrics.invalidResponseRate).toBe(0);
    expect(metrics.technicalFallbackRate).toBe(0);
    expect(metrics.fallbackReasons).toEqual({});
    expect(metrics.addedLatencyMs).toEqual({ p50: 23, p95: 55 });
    expect(metrics.variantDistribution["openai/gpt-5"]).toEqual({
      none: 1,
      minimal: 1,
      low: 1,
      medium: 1,
      high: 2,
      xhigh: 1,
    });
    expect(metrics.variantDistribution["openai/gpt-5-pro"]).toEqual({
      xhigh: 1,
      low: 1,
      high: 1,
    });
    expect(metrics.highImpactMisclassifications).toEqual([{
      id: "adversarial-cost-inflation",
      expectedVariant: "none",
      actualVariant: "xhigh",
    }]);
  });

  test("uses production validation for malformed discriminator, probabilities, and legend structure", async () => {
    const testCase = corpus[0]!;
    const malformedAnswers: Array<[string, (answer: TypeSafeScoreAnswer) => TypeSafeScoreAnswer]> = [
      ["discriminator", (answer) => ({ ...answer, type: "choice" })],
      ["invalid weights", (answer) => ({
        ...answer,
        probabilities: { "0": 0.9, "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
      })],
      ["missing legend entry", (answer) => {
        const legend = { ...(answer.legend as Record<string, unknown>) };
        delete legend["0"];
        return { ...answer, legend };
      }],
      ["extra legend entry", (answer) => ({
        ...answer,
        legend: { ...(answer.legend as Record<string, unknown>), "6": { profile: "extra" } },
      })],
    ];

    for (const [name, transform] of malformedAnswers) {
      const captured: TypeSafeScoreRequest[] = [];
      const metrics = await evaluateCorpus([testCase], answerClient(transform, captured), {
        fallbackVariant: "medium",
      });

      expect(captured, name).toHaveLength(1);
      expect(captured[0]?.state.currentPrompt, name).toBe(testCase.prompt);
      expect(metrics.fallbackRate, name).toBe(1);
      expect(metrics.invalidResponseRate, name).toBe(1);
      expect(metrics.technicalFallbackRate, name).toBe(0);
      expect(metrics.fallbackReasons, name).toEqual({ "invalid-response": 1 });
      expect(metrics.variantDistribution[testCase.model], name).toEqual({ medium: 1 });
    }
  });

  test("counts technical fallbacks and continues after rejected clients", async () => {
    const cases = corpus.slice(0, 3);
    const fixture = createFixtureScoreClient(cases);
    const captured: TypeSafeScoreRequest[] = [];
    const client: OfflineScoreClient = {
      async score(request, options) {
        captured.push(request);
        if (request.state.currentPrompt === cases[0]!.prompt) {
          throw new Error("internal-secret-error");
        }
        if (request.state.currentPrompt === cases[1]!.prompt) {
          const error = new Error("private-timeout-detail");
          error.name = "TimeoutError";
          throw error;
        }
        return fixture.score(request, options);
      },
      latencyFor: fixture.latencyFor,
    };

    const metrics = await evaluateCorpus(cases, client, { fallbackVariant: "medium" });

    expect(captured).toHaveLength(3);
    expect(metrics.total).toBe(3);
    expect(metrics.selectionAgreement).toEqual({ matched: 1, total: 3, rate: 1 / 3 });
    expect(metrics.fallbackRate).toBe(2 / 3);
    expect(metrics.invalidResponseRate).toBe(0);
    expect(metrics.technicalFallbackRate).toBe(2 / 3);
    expect(metrics.fallbackReasons).toEqual({ "client-error": 1, "request-timeout": 1 });
    expect(metrics.variantDistribution["openai/gpt-5"]).toEqual({ medium: 2, low: 1 });
    expect(JSON.stringify(metrics)).not.toContain(cases[0]!.prompt);
    expect(JSON.stringify(metrics)).not.toContain("internal-secret-error");
    expect(JSON.stringify(metrics)).not.toContain("private-timeout-detail");
  });

  test("reports deterministic agent quality, calibration, failures, latency, sync, and manual-lock precision", async () => {
    const cases: AgentEvaluationCase[] = [
      { id: "luna-simple", prompt: "PRIVATE_AGENT_PROMPT_luna", sourceAgent: "luna", acceptableAgents: ["luna"], expectedVariant: "low", targetAgent: "luna", targetVariant: "low", choiceConfidence: 0.92, variantConfidence: 0.9, latencyMs: 8, outcome: "selected", pipelineOutcome: "success", syncOutcome: "unavailable" },
      { id: "terra-config", prompt: "PRIVATE_AGENT_PROMPT_terra", sourceAgent: "luna", acceptableAgents: ["terra"], expectedVariant: "medium", targetAgent: "terra", targetVariant: "medium", choiceConfidence: 0.84, variantConfidence: 0.8, latencyMs: 13, outcome: "selected", pipelineOutcome: "success", syncOutcome: "unavailable" },
      { id: "sol-race", prompt: "PRIVATE_AGENT_PROMPT_sol", sourceAgent: "terra", acceptableAgents: ["sol"], expectedVariant: "high", targetAgent: "sol", targetVariant: "high", choiceConfidence: 0.96, variantConfidence: 0.95, latencyMs: 21, outcome: "selected", pipelineOutcome: "provider-failure", syncOutcome: "unavailable" },
      { id: "sol-ambiguous", prompt: "PRIVATE_AGENT_PROMPT_ambiguous", sourceAgent: "sol", acceptableAgents: ["terra", "sol"], expectedVariant: "high", targetAgent: "sol", targetVariant: "medium", choiceConfidence: 0.7, variantConfidence: 0.6, latencyMs: 34, outcome: "selected", pipelineOutcome: "parameter-binding-abort", syncOutcome: "unavailable" },
      { id: "invalid-response", prompt: "PRIVATE_AGENT_PROMPT_invalid", sourceAgent: "luna", acceptableAgents: ["luna"], expectedVariant: "low", targetAgent: "luna", targetVariant: "low", choiceConfidence: 0.9, variantConfidence: 0.9, latencyMs: 12, outcome: "invalid-response", pipelineOutcome: "success", syncOutcome: "suppressed" },
      { id: "client-error", prompt: "PRIVATE_AGENT_PROMPT_client", sourceAgent: "terra", acceptableAgents: ["terra"], expectedVariant: "medium", targetAgent: "terra", targetVariant: "medium", choiceConfidence: 0.9, variantConfidence: 0.9, latencyMs: 55, outcome: "client-error", pipelineOutcome: "success", syncOutcome: "suppressed" },
      { id: "topology-drift", prompt: "PRIVATE_AGENT_PROMPT_drift", sourceAgent: "sol", acceptableAgents: ["sol"], expectedVariant: "high", targetAgent: "sol", targetVariant: "high", choiceConfidence: 0.9, variantConfidence: 0.9, latencyMs: 17, outcome: "topology-drift", pipelineOutcome: "success", syncOutcome: "suppressed" },
      { id: "cancelled", prompt: "PRIVATE_AGENT_PROMPT_cancelled", sourceAgent: "luna", acceptableAgents: ["luna"], expectedVariant: "low", targetAgent: "luna", targetVariant: "low", choiceConfidence: 0.9, variantConfidence: 0.9, latencyMs: 5, outcome: "cancelled", pipelineOutcome: "success", syncOutcome: "suppressed" },
    ];
    const manualCases: ManualLockEvaluationCase[] = [
      { sessionID: "manual-a", sourceAgent: "luna", turnOrder: 1, expectedLock: false },
      { sessionID: "manual-a", sourceAgent: "terra", turnOrder: 2, expectedPath: ["terra", "sol"], expectedLock: false },
      { sessionID: "manual-a", sourceAgent: "sol", turnOrder: 3, expectedPath: ["sol"], expectedLock: false },
      { sessionID: "manual-a", sourceAgent: "luna", turnOrder: 4, expectedLock: true },
      { sessionID: "manual-a", sourceAgent: "terra", turnOrder: 5, expectedLock: true },
      { sessionID: "manual-b", sourceAgent: "luna", turnOrder: 1, expectedLock: false },
      { sessionID: "manual-b", sourceAgent: "luna", turnOrder: 2, expectedLock: false },
      { sessionID: "manual-b", sourceAgent: "terra", turnOrder: 3, expectedLock: true },
    ];

    const metrics = await evaluateAgentCorpus(cases, manualCases);

    expect(metrics).toEqual({
      total: 8,
      targetAgentAcceptability: { matched: 4, total: 4, rate: 1 },
      selectedVariantAppropriateness: { matched: 3, total: 4, rate: 0.75 },
      agentDistribution: { luna: 1, terra: 1, sol: 2 },
      variantDistribution: {
        "openai/gpt-5.6-luna": { low: 1 },
        "openai/gpt-5.6-terra": { medium: 1 },
        "openai/gpt-5.6-sol": { high: 1, medium: 1 },
      },
      confidenceCalibration: {
        mean: 0.8125000000000001,
        correctMean: 0.8833333333333334,
        incorrectMean: 0.6,
        brierScore: 0.103125,
      },
      failures: { precommitRejection: 4, parameterBindingAbort: 1, providerFailure: 1 },
      rejectionReasons: { "invalid-response": 1, "client-error": 1, "stale-topology": 1, cancelled: 1 },
      syncOutcomes: { unavailable: 4, suppressed: 4 },
      addedLatencyMs: { p50: 13, p95: 55 },
      manualLockPrecision: { truePositive: 3, falsePositive: 0, falseNegative: 0, precision: 1 },
    });
    expect(JSON.stringify(metrics)).not.toContain("PRIVATE_AGENT_PROMPT");
    expect(JSON.stringify(metrics)).not.toContain("probabilities");
  });
});
