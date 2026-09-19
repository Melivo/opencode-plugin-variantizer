import { describe, expect, test } from "bun:test";

import {
  adaptTypeSafeSdkAgentRouteClient,
  adaptTypeSafeSdkScoreClient,
  createTypeSafeSdkClient,
  type TypeSafeSystemOneCaller,
} from "../../src/typesafe-sdk-client.ts";
import type { TypeSafeAgentRouteRequest } from "../../src/agent-route.ts";
import type { TypeSafeScoreRequest } from "../../src/typesafe-router.ts";

const level = (profile: string) => ({ profile, boundaries: `${profile} boundary`, examples: [`${profile} example`] });

const mixedRequest: TypeSafeAgentRouteRequest = {
  state: {
    currentPrompt: "private prompt",
    recentMessages: [{ role: "user", text: "private history" }],

  },
  questions: {
    target_agent: {
      type: "choice",
      instructions: "choose",
      criteria: {
        luna: { profile: "luna", modelPremise: "luna model" },
        terra: { profile: "terra", modelPremise: "terra model" },
        sol: { profile: "sol", modelPremise: "sol model" },
      },
    },
    reasoning_for_luna: scoreQuestion("luna"),
    reasoning_for_terra: scoreQuestion("terra"),
    reasoning_for_sol: scoreQuestion("sol"),
  },
};

function scoreQuestion(agent: "luna" | "terra" | "sol") {
  const modelPremise = `openai/gpt-5.6-${agent}`;
  return {
    type: "score" as const,
    instructions: {
      task: `score ${agent}`,
      modelPremise,
      ordering: "ordered",
      output: "score",
    },
    criteria: [level("low"), level("high")] as const,
    modelPremise,
  };
}

describe("TypeSafe SDK clients", () => {
  test("constructs the pinned SDK client with transport retries disabled without making a request", () => {
    const client = createTypeSafeSdkClient("unit-test-api-key");

    expect(client.logLevel).toBe("off");
    expect(client.retry.maxRetries).toBe(0);
  });

  test("adapts one mixed systemOne call with exact Choice and Score question IDs", async () => {
    let calls = 0;
    let capturedRequest: unknown;
    let capturedOptions: unknown;
    const envelope = {
      model: "jev-latest",
      answers: { target_agent: {}, reasoning_for_luna: {}, reasoning_for_terra: {}, reasoning_for_sol: {} },
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const caller: TypeSafeSystemOneCaller = {
      async systemOne(request, options) {
        calls += 1;
        capturedRequest = request;
        capturedOptions = options;
        return envelope;
      },
    };
    const client = adaptTypeSafeSdkAgentRouteClient(caller);
    const controller = new AbortController();

    const result = await client.route(mixedRequest, { signal: controller.signal, timeoutMs: 321 });

    expect(calls).toBe(1);
    expect(result).toBe(envelope);
    expect(capturedRequest).toEqual({
      state: mixedRequest.state,
      questions: {
        target_agent: mixedRequest.questions.target_agent,
        reasoning_for_luna: {
          type: "score",
          instructions: mixedRequest.questions.reasoning_for_luna.instructions,
          criteria: mixedRequest.questions.reasoning_for_luna.criteria,
        },
        reasoning_for_terra: {
          type: "score",
          instructions: mixedRequest.questions.reasoning_for_terra.instructions,
          criteria: mixedRequest.questions.reasoning_for_terra.criteria,
        },
        reasoning_for_sol: {
          type: "score",
          instructions: mixedRequest.questions.reasoning_for_sol.instructions,
          criteria: mixedRequest.questions.reasoning_for_sol.criteria,
        },
      },
    });
    expect(capturedOptions).toEqual({ signal: controller.signal, timeout: 321 });
  });

  test("preserves the legacy single-model Score adapter contract", async () => {
    let capturedRequest: unknown;
    const expectedAnswer = { type: "score", score: 1, confidence: 1, legend: {}, probabilities: {} };
    const caller: TypeSafeSystemOneCaller = {
      async systemOne(request) {
        capturedRequest = request;
        return { model: "jev-latest", answers: { variant: expectedAnswer }, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
    const request: TypeSafeScoreRequest = {
      state: { currentPrompt: "prompt", recentMessages: [], model: "openai/gpt-5" },
      instructions: { task: "task", ordering: "order", output: "output" },
      criteria: [level("low"), level("high")],
    };

    const answer = await adaptTypeSafeSdkScoreClient(caller).score(request, {
      signal: new AbortController().signal,
      timeoutMs: 99,
    });

    expect(answer).toBe(expectedAnswer);
    expect(capturedRequest).toMatchObject({
      state: { currentPrompt: "prompt", recentMessages: [], model: "openai/gpt-5" },
      questions: { variant: { type: "score" } },
    });
  });
});
