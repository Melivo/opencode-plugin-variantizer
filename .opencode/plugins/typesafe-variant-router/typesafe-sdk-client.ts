import { score, TypeSafeClient, type JsonValue } from "@typesafe-ai/sdk";

import type { TypeSafeScoreClient } from "./typesafe-router.ts";

export function createTypeSafeSdkScoreClient(apiKey: string): TypeSafeScoreClient {
  const client = new TypeSafeClient({
    apiKey,
    logLevel: "off",
  });

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
      return answer.answers.variant;
    },
  };
}
