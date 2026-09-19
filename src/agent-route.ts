import type { TypeSafeContext } from "./context-assembler.ts";
import {
  AGENT_MODEL_BINDINGS,
  LOGICAL_AGENT_RING,
  type AgentTopologySnapshot,
  type RingAgentID,
  type TopologyObservation,
  validateTopologyObservation,
} from "./agent-topology.ts";
import type { ScoreLevel } from "./typesafe-router.ts";

export const AGENT_ROUTE_QUESTION_IDS = Object.freeze([
  "target_agent",
  "reasoning_for_luna",
  "reasoning_for_terra",
  "reasoning_for_sol",
] as const);

const PROBABILITY_TOLERANCE = 0.001;
const RESPONSE_KEYS = Object.freeze(["answers", "model", "usage"]);
const CHOICE_KEYS = Object.freeze(["choice", "confidence", "probabilities", "type"]);
const SCORE_KEYS = Object.freeze(["confidence", "legend", "probabilities", "score", "type"]);
const USAGE_KEYS = Object.freeze(["input_tokens", "output_tokens"]);

type AgentProfiles = Readonly<Record<RingAgentID, string>>;
type VariantDescriptions = Readonly<Partial<Record<RingAgentID, Readonly<Record<string, string>>>>>;

export type AgentChoiceCriterion = Readonly<{
  profile: string;
  modelPremise: string;
}>;

export type AgentChoiceQuestion = Readonly<{
  type: "choice";
  instructions: string;
  criteria: Readonly<Record<RingAgentID, AgentChoiceCriterion>>;
}>;

export type AgentScoreQuestion = Readonly<{
  type: "score";
  instructions: Readonly<{
    task: string;
    modelPremise: string;
    ordering: string;
    output: string;
  }>;
  criteria: readonly [ScoreLevel, ScoreLevel, ...ScoreLevel[]];
  modelPremise: string;
}>;

export type TypeSafeAgentRouteState = Readonly<{
  currentPrompt: string;
  recentMessages: TypeSafeContext["recentMessages"];
}>;

export type TypeSafeAgentRouteRequest = Readonly<{
  state: TypeSafeAgentRouteState;
  questions: Readonly<{
    target_agent: AgentChoiceQuestion;
    reasoning_for_luna: AgentScoreQuestion;
    reasoning_for_terra: AgentScoreQuestion;
    reasoning_for_sol: AgentScoreQuestion;
  }>;
}>;

export type TypeSafeAgentRouteClient = Readonly<{
  route(
    request: TypeSafeAgentRouteRequest,
    options: Readonly<{ signal?: AbortSignal; timeoutMs: number }>,
  ): Promise<unknown>;
}>;

export type AgentRouteInput = Readonly<{
  state: TypeSafeContext;
  sourceAgent: RingAgentID;
  sourceModel: string;
  topology: AgentTopologySnapshot;
  observation: TopologyObservation;
  observeCurrentTopology: () => TopologyObservation;
  agentProfiles: AgentProfiles;
  variantDescriptionsByAgent: VariantDescriptions;
  manualLock?: RingAgentID;
  timeoutMs: number;
  signal?: AbortSignal;
}>;

export type SelectedAgentRoute = Readonly<{
  status: "selected";
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

export type RejectedAgentRoute = Readonly<{
  status: "rejected";
  reason: "invalid-request" | "invalid-response" | "stale-topology" | "missing-api-key" | "client-error" | "cancelled";
  createdAt: number;
}>;

export type AgentRouteDecision = SelectedAgentRoute | RejectedAgentRoute;

export type AgentRouteTransportFailureReason =
  | "network-error" | "auth-error" | "request-timeout" | "rate-limited"
  | "client-error" | "server-error";

type AgentRouteDependencies = Readonly<{
  client?: TypeSafeAgentRouteClient;
  now?: () => number;
  onTransportFailure?: (reason: AgentRouteTransportFailureReason) => void;
  onResponse?: (response: unknown) => void;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function transportFailureReason(error: unknown): AgentRouteTransportFailureReason {
  const status = isRecord(error) && typeof error.status === "number" ? error.status : undefined;
  if (status === 401 || status === 403) return "auth-error";
  if (status === 408) return "request-timeout";
  if (status === 429) return "rate-limited";
  if (status !== undefined && status >= 500 && status <= 599) return "server-error";
  const name = error instanceof Error ? error.name : isRecord(error) && typeof error.name === "string" ? error.name : "";
  if (name === "APITimeoutError" || name === "TimeoutError") return "request-timeout";
  if (name === "APIConnectionError" || name === "TypeError") return "network-error";
  return "client-error";
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function exactAgentKeys(value: unknown): value is Record<RingAgentID, unknown> {
  return hasExactKeys(value, LOGICAL_AGENT_RING);
}

function validProbabilityMap(
  value: unknown,
  candidates: readonly string[],
): Readonly<Record<string, number>> | undefined {
  if (!hasExactKeys(value, candidates)) return undefined;
  let total = 0;
  const probabilities: Record<string, number> = Object.create(null);
  for (const candidate of candidates) {
    const probability = value[candidate];
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      return undefined;
    }
    probabilities[candidate] = probability;
    total += probability;
  }
  return Math.abs(total - 1) <= PROBABILITY_TOLERANCE ? probabilities : undefined;
}

function highestProbability(
  probabilities: Readonly<Record<string, number>>,
  tieOrder: readonly string[],
): string | undefined {
  let selected: string | undefined;
  let maximum = -1;
  for (const candidate of tieOrder) {
    const probability = probabilities[candidate];
    if (probability === undefined) return undefined;
    if (probability > maximum) {
      maximum = probability;
      selected = candidate;
    }
  }
  return selected;
}

function finiteUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => deepEqual(entry, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
}

function levelFor(agent: RingAgentID, model: string, name: string, description?: string): ScoreLevel {
  return {
    profile: description ?? `Reasoning variant ${name} for ${agent}'s fixed model.`,
    boundaries: `Use only when the task independently fits ${name} under the fixed ${model} model premise.`,
    examples: [`A software task matching the ${name} reasoning profile for ${agent}.`],
  };
}

function buildScoreQuestion(
  agent: RingAgentID,
  topology: AgentTopologySnapshot,
  descriptions: VariantDescriptions,
): AgentScoreQuestion | undefined {
  const catalog = topology.catalogsByAgent[agent];
  if (catalog.names.length < 2 || catalog.names.length > 10) return undefined;
  const criteria = catalog.names.map((name) => levelFor(
    agent,
    catalog.modelKey,
    name,
    descriptions[agent]?.[name],
  )) as [ScoreLevel, ScoreLevel, ...ScoreLevel[]];
  return Object.freeze({
    type: "score" as const,
    instructions: Object.freeze({
      task: `Rate the reasoning effort required if ${agent} handles the current software task.`,
      modelPremise: `${agent} is fixed to ${catalog.modelKey}; judge only that model's validated runtime variants.`,
      ordering: "The criteria are standalone descriptions in the target model's runtime catalog order.",
      output: "Place the task on this reasoning-effort spectrum without inventing variants or provider options.",
    }),
    criteria: Object.freeze(criteria),
    modelPremise: catalog.modelKey,
  });
}

export function buildAgentRouteRequest(input: AgentRouteInput): TypeSafeAgentRouteRequest | undefined {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) return undefined;
  if (input.sourceModel !== AGENT_MODEL_BINDINGS[input.sourceAgent]) return undefined;
  if (!validateTopologyObservation(input.topology, input.observation)) return undefined;
  if (!exactAgentKeys(input.agentProfiles)) return undefined;
  for (const agent of LOGICAL_AGENT_RING) {
    const profile = input.agentProfiles[agent];
    if (typeof profile !== "string" || !profile.trim() || profile.length > 4_000) return undefined;
  }

  const luna = buildScoreQuestion("luna", input.topology, input.variantDescriptionsByAgent);
  const terra = buildScoreQuestion("terra", input.topology, input.variantDescriptionsByAgent);
  const sol = buildScoreQuestion("sol", input.topology, input.variantDescriptionsByAgent);
  if (!luna || !terra || !sol) return undefined;

  const choiceCriteria = Object.freeze(Object.fromEntries(LOGICAL_AGENT_RING.map((agent) => [agent, Object.freeze({
    profile: input.agentProfiles[agent],
    modelPremise: `${agent} is always bound to ${input.topology.agentToModel[agent]}.`,
  })]))) as AgentChoiceQuestion["criteria"];

  return Object.freeze({
    state: Object.freeze({
      currentPrompt: input.state.currentPrompt,
      recentMessages: input.state.recentMessages,
    }),
    questions: Object.freeze({
      target_agent: Object.freeze({
        type: "choice" as const,
        instructions: "Choose the approved primary agent solely by task fit using the supplied criteria. Do not prefer the source or currently selected agent, and do not apply balancing, rotation, or stickiness.",
        criteria: choiceCriteria,
      }),
      reasoning_for_luna: luna,
      reasoning_for_terra: terra,
      reasoning_for_sol: sol,
    }),
  });
}

function validateChoice(value: unknown): Readonly<{ agent: RingAgentID; confidence: number }> | undefined {
  if (!hasExactKeys(value, CHOICE_KEYS) || value.type !== "choice" || !finiteUnit(value.confidence)) return undefined;
  const probabilities = validProbabilityMap(value.probabilities, LOGICAL_AGENT_RING);
  if (!probabilities) return undefined;
  const selected = highestProbability(probabilities, LOGICAL_AGENT_RING);
  return typeof value.choice === "string"
    && selected === value.choice
    && LOGICAL_AGENT_RING.includes(value.choice as RingAgentID)
    ? Object.freeze({ agent: value.choice as RingAgentID, confidence: value.confidence })
    : undefined;
}

function isValidScore(
  value: unknown,
  question: AgentScoreQuestion,
  candidates: readonly string[],
): value is Record<string, unknown> & { confidence: number; probabilities: Record<string, number> } {
  if (!hasExactKeys(value, SCORE_KEYS) || value.type !== "score" || !finiteUnit(value.confidence)) return false;
  if (typeof value.score !== "number" || !Number.isFinite(value.score)
    || value.score < 0 || value.score > candidates.length - 1) return false;
  const indexCandidates = candidates.map((_candidate, index) => String(index));
  if (!validProbabilityMap(value.probabilities, indexCandidates) || !hasExactKeys(value.legend, indexCandidates)) return false;
  const expectedLegend = Object.fromEntries(question.criteria.map((criterion, index) => [String(index), criterion]));
  return deepEqual(value.legend, expectedLegend);
}

function selectScore(
  value: unknown,
  question: AgentScoreQuestion,
  candidates: readonly string[],
): Readonly<{ variant: string; confidence: number }> | undefined {
  if (!isValidScore(value, question, candidates)) return undefined;
  const indexCandidates = candidates.map((_candidate, index) => String(index));
  const selectedIndex = highestProbability(value.probabilities, indexCandidates);
  const variant = selectedIndex === undefined ? undefined : candidates[Number(selectedIndex)];
  return variant ? { variant, confidence: value.confidence } : undefined;
}

function validUsage(value: unknown): boolean {
  return hasExactKeys(value, USAGE_KEYS)
    && Number.isInteger(value.input_tokens) && (value.input_tokens as number) >= 0
    && Number.isInteger(value.output_tokens) && (value.output_tokens as number) >= 0;
}

function composeDecision(
  response: unknown,
  request: TypeSafeAgentRouteRequest,
  input: AgentRouteInput,
  createdAt: number,
): SelectedAgentRoute | undefined {
  if (!hasExactKeys(response, RESPONSE_KEYS)
    || typeof response.model !== "string" || !response.model.trim()
    || !validUsage(response.usage)
    || !hasExactKeys(response.answers, AGENT_ROUTE_QUESTION_IDS)) return undefined;

  const selectedChoice = validateChoice(response.answers.target_agent);
  if (!selectedChoice) return undefined;
  const selectedAgent = input.manualLock ?? selectedChoice.agent;
  if (!LOGICAL_AGENT_RING.includes(selectedAgent)) return undefined;

  const scores = {
    luna: [response.answers.reasoning_for_luna, request.questions.reasoning_for_luna],
    terra: [response.answers.reasoning_for_terra, request.questions.reasoning_for_terra],
    sol: [response.answers.reasoning_for_sol, request.questions.reasoning_for_sol],
  } as const;
  for (const agent of LOGICAL_AGENT_RING) {
    const [answer, question] = scores[agent];
    if (!isValidScore(answer, question, input.topology.catalogsByAgent[agent].names)) return undefined;
  }
  const [selectedAnswer, selectedQuestion] = scores[selectedAgent];
  const selectedScore = selectScore(
    selectedAnswer,
    selectedQuestion,
    input.topology.catalogsByAgent[selectedAgent].names,
  );
  if (!selectedScore) return undefined;
  const targetModel = input.topology.agentToModel[selectedAgent];
  if (targetModel !== AGENT_MODEL_BINDINGS[selectedAgent]) return undefined;
  const selectedOptions = input.topology.catalogsByAgent[selectedAgent].optionsByVariant[selectedScore.variant];
  if (!selectedOptions || Object.keys(selectedOptions).length === 0) return undefined;

  return Object.freeze({
    status: "selected" as const,
    targetAgent: selectedAgent,
    targetModel,
    targetVariant: selectedScore.variant,
    confidence: selectedChoice.confidence,
    topologyGenerationID: input.topology.generationID,
    behaviorFingerprint: input.topology.behaviorFingerprint,
    catalogFingerprint: input.topology.catalogFingerprints[selectedAgent],
    optionsFingerprint: input.topology.optionsFingerprints[selectedAgent],
    createdAt,
  });
}

export function createAgentRouteRouter(dependencies: AgentRouteDependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const rejected = (reason: RejectedAgentRoute["reason"], createdAt: number): RejectedAgentRoute => (
    Object.freeze({ status: "rejected", reason, createdAt })
  );

  return Object.freeze({
    async route(input: AgentRouteInput): Promise<AgentRouteDecision> {
      const createdAt = now();
      if (input.signal?.aborted) return rejected("cancelled", createdAt);
      const request = buildAgentRouteRequest(input);
      if (!request) {
        const stale = !validateTopologyObservation(input.topology, input.observation);
        return rejected(stale ? "stale-topology" : "invalid-request", createdAt);
      }
      if (!dependencies.client) return rejected("missing-api-key", createdAt);

      let response: unknown;
      try {
        response = await dependencies.client.route(request, {
          ...(input.signal ? { signal: input.signal } : {}),
          timeoutMs: input.timeoutMs,
        });
      } catch (error) {
        if (!input.signal?.aborted) {
          try { dependencies.onTransportFailure?.(transportFailureReason(error)); } catch { /* observational */ }
        }
        return rejected(input.signal?.aborted ? "cancelled" : "client-error", createdAt);
      }
      if (input.signal?.aborted) return rejected("cancelled", createdAt);
      try { dependencies.onResponse?.(response); } catch { /* debug observers are nonfatal */ }
      if (!validateTopologyObservation(input.topology, input.observeCurrentTopology())) {
        return rejected("stale-topology", createdAt);
      }
      return composeDecision(response, request, input, createdAt)
        ?? rejected("invalid-response", createdAt);
    },
  });
}
