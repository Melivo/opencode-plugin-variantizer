import { describe, expect, test } from "bun:test";

import {
  createTypeSafeVariantRouterPlugin,
  createVariantRouterHooks,
  type AppliedVariant,
  type VariantRouterHooks,
} from "../plugins/typesafe-variant-router/plugin.ts";
import type {
  TypeSafeScoreAnswer,
  TypeSafeScoreRequest,
} from "../plugins/typesafe-variant-router/typesafe-router.ts";

const variants = {
  low: { reasoningEffort: "low" },
  high: { reasoningEffort: "high" },
};

function answer(request: TypeSafeScoreRequest): TypeSafeScoreAnswer {
  return {
    type: "score",
    score: 1,
    confidence: 1,
    legend: Object.fromEntries(request.criteria.map((criterion, index) => [String(index), criterion])),
    probabilities: { 0: 0, 1: 1 },
  };
}

const messageInput = {
  sessionID: "contract-session",
  model: { providerID: "openai", modelID: "contract-openai" },
};

const messageOutput = {
  message: {
    id: "contract-message",
    sessionID: "contract-session",
    role: "user",
    time: { created: 0 },
    agent: "build",
    model: { providerID: "openai", modelID: "contract-openai" },
  },
  parts: [{
    id: "contract-part",
    sessionID: "contract-session",
    messageID: "contract-message",
    type: "text",
    text: "Choose the appropriate reasoning effort.",
  }],
};

const paramsInput = {
  sessionID: "contract-session",
  agent: "build",
  model: {
    id: "contract-openai",
    providerID: "openai",
    reasoning: true,
    variants,
  },
  provider: { source: "config", info: {}, options: {} },
  message: messageOutput.message,
};

const paramsOutput = () => ({
  temperature: 1,
  topP: 1,
  topK: 0,
  maxOutputTokens: undefined,
  options: { foreign: true } as Record<string, unknown>,
});

async function runMessage(hooks: VariantRouterHooks): Promise<void> {
  await hooks["chat.message"]?.(messageInput as never, messageOutput as never);
}

async function runParams(hooks: VariantRouterHooks, output: ReturnType<typeof paramsOutput>): Promise<void> {
  await hooks["chat.params"]?.(paramsInput as never, output as never);
}

describe("production hook contract", () => {
  test("publishes variant.cycle directly instead of accepting the legacy alias no-op", async () => {
    const published: unknown[] = [];
    const legacyDispatches: unknown[] = [];
    const commandAliases: Record<string, string> = {
      "session.new": "session_new",
    };
    const legacyExecuteCommand = async ({ body }: { body: { command: string } }) => {
      legacyDispatches.push(commandAliases[body.command]);
      return { data: true } as const;
    };
    const legacyResult = await legacyExecuteCommand({ body: { command: "variant.cycle" } });
    expect(legacyResult).toEqual({ data: true });
    expect(legacyDispatches).toEqual([undefined]);
    legacyDispatches.length = 0;

    let resolveCommandAttempt: (() => void) | undefined;
    const commandAttempted = new Promise<void>((resolve) => { resolveCommandAttempt = resolve; });
    const plugin = createTypeSafeVariantRouterPlugin({ resolveApiKey: async () => undefined });
    const hooks = await plugin({
      client: {
        app: { log: async () => ({} as never) },
        tui: {
          showToast: async () => ({} as never),
          executeCommand: async (request: { body: { command: string } }) => {
            const result = await legacyExecuteCommand(request);
            resolveCommandAttempt?.();
            return result as never;
          },
          publish: async (request: unknown) => {
            published.push(request);
            resolveCommandAttempt?.();
            return { data: true } as never;
          },
        },
        session: { messages: async () => ({ data: [] }) },
      },
    } as never, { fallbackVariant: "low", notify: "off" });

    await hooks["chat.message"]?.(messageInput as never, messageOutput as never);
    const output = paramsOutput();
    await hooks["chat.params"]?.(paramsInput as never, output as never);
    await commandAttempted;
    await hooks.dispose?.();

    expect(output.options).toEqual({ foreign: true, reasoningEffort: "low" });
    expect(legacyDispatches).toEqual([]);
    expect(published).toEqual([{
      body: {
        type: "tui.command.execute",
        properties: { command: "variant.cycle" },
      },
    }]);
  });

  test("defers scoring until the full params model and reuses the correlated result", async () => {
    let scoreCalls = 0;
    const applied: AppliedVariant[] = [];
    const hooks = createVariantRouterHooks({ fallbackVariant: "low" }, {
      client: {
        async score(request) {
          scoreCalls += 1;
          return answer(request);
        },
      },
      onAppliedVariant: (application) => applied.push(application),
    });

    await runMessage(hooks);
    expect(scoreCalls).toBe(0);

    const first = paramsOutput();
    const repeated = paramsOutput();
    await runParams(hooks, first);
    await runParams(hooks, repeated);

    expect(scoreCalls).toBe(1);
    expect(first.options).toEqual({ foreign: true, reasoningEffort: "high" });
    expect(repeated.options).toEqual({ foreign: true, reasoningEffort: "high" });
    expect(applied).toEqual([{
      modelID: "openai/contract-openai",
      variant: "high",
      status: "selected",
      reason: "selected",
    }]);
    await hooks.dispose?.();
  });
});
