import type { VariantCatalog } from "../plugins/typesafe-variant-router/open-code-variant-adapter.ts";
import {
  createTypeSafeRouter,
  type RouterReason,
  type ScoreLevel,
  type TypeSafeScoreAnswer,
  type TypeSafeScoreClient,
  type TypeSafeScoreRequest,
} from "../plugins/typesafe-variant-router/typesafe-router.ts";

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
