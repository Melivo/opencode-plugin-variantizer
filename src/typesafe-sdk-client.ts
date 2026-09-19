import {
  choice,
  score,
  TypeSafeClient,
  type EntryType,
  type JsonValue,
  type Question,
} from "@typesafe-ai/sdk";

import type {
  TypeSafeAgentRouteClient,
  TypeSafeAgentRouteRequest,
} from "./agent-route.ts";
import type {
  TypeSafeScoreAnswer,
  TypeSafeScoreClient,
} from "./typesafe-router.ts";

type TypeSafeSystemOneRequest = Readonly<{
  state: EntryType;
  questions: Readonly<Record<string, Question>>;
}>;

type TypeSafeSystemOneOptions = Readonly<{
  signal?: AbortSignal;
  timeout?: number;
}>;

export type TypeSafeSystemOneCaller = Readonly<{
  systemOne(request: TypeSafeSystemOneRequest, options?: TypeSafeSystemOneOptions): PromiseLike<unknown>;
}>;

function responseAnswers(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return Object.create(null);
  const answers = (value as Record<string, unknown>).answers;
  return answers !== null && typeof answers === "object" && !Array.isArray(answers)
    ? answers as Record<string, unknown>
    : Object.create(null);
}

export function adaptTypeSafeSdkScoreClient(client: TypeSafeSystemOneCaller): TypeSafeScoreClient {
  return {
    async score(request, options) {
      const state: JsonValue = {
        currentPrompt: request.state.currentPrompt,
        recentMessages: request.state.recentMessages.map((message) => ({
          role: message.role,
          text: message.text,
        })),
        model: request.state.model,
      };
      const answer = await client.systemOne({
        state,
        questions: {
          variant: score(request.instructions, request.criteria),
        },
      }, {
        signal: options.signal,
        timeout: Math.max(1, options.timeoutMs),
      });
      return responseAnswers(answer).variant as TypeSafeScoreAnswer;
    },
  };
}

function scoreQuestion(question: TypeSafeAgentRouteRequest["questions"]["reasoning_for_luna"]) {
  return score(question.instructions, question.criteria);
}

export function adaptTypeSafeSdkAgentRouteClient(client: TypeSafeSystemOneCaller): TypeSafeAgentRouteClient {
  return Object.freeze({
    async route(request, options) {
      return client.systemOne({
        state: request.state as unknown as EntryType,
        questions: {
          target_agent: choice(
            request.questions.target_agent.instructions,
            request.questions.target_agent.criteria,
          ),
          reasoning_for_luna: scoreQuestion(request.questions.reasoning_for_luna),
          reasoning_for_terra: scoreQuestion(request.questions.reasoning_for_terra),
          reasoning_for_sol: scoreQuestion(request.questions.reasoning_for_sol),
        },
      }, {
        ...(options.signal ? { signal: options.signal } : {}),
        timeout: Math.max(1, options.timeoutMs),
      });
    },
  });
}

export function createTypeSafeSdkClient(apiKey: string): TypeSafeClient {
  return new TypeSafeClient({
    apiKey,
    logLevel: "off",
    retry: { maxRetries: 0 },
  });
}

function createSystemOneCaller(apiKey: string): TypeSafeSystemOneCaller {
  const client = createTypeSafeSdkClient(apiKey);
  return {
    systemOne(request, options) {
      return client.systemOne(request, options);
    },
  };
}

export function createTypeSafeSdkScoreClient(apiKey: string): TypeSafeScoreClient {
  return adaptTypeSafeSdkScoreClient(createSystemOneCaller(apiKey));
}

export function createTypeSafeSdkAgentRouteClient(apiKey: string): TypeSafeAgentRouteClient {
  return adaptTypeSafeSdkAgentRouteClient(createSystemOneCaller(apiKey));
}
