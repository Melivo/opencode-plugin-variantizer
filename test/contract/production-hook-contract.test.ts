import { describe, expect, test } from "bun:test";

import {
  AGENT_MODEL_BINDINGS,
  OBSERVED_PRIMARY_ORDER,
  createAgentTopologySnapshot,
  type TopologyObservation,
} from "../../src/agent-topology.ts";
import type { TypeSafeAgentRouteRequest } from "../../src/agent-route.ts";
import {
  createTypeSafeVariantRouterPlugin,
  createVariantRouterHooks,
  type AppliedVariant,
  type VariantRouterHooks,
} from "../../src/plugin.ts";
import type {
  TypeSafeScoreAnswer,
  TypeSafeScoreRequest,
} from "../../src/typesafe-router.ts";

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

function contractTopology() {
  const shared = { permission: { edit: "allow" }, prompt: "shared", tools: { edit: true } };
  const catalogsByAgent = Object.fromEntries(Object.entries(AGENT_MODEL_BINDINGS).map(([agent, modelKey]) => [agent, {
    modelKey,
    names: ["low", "high"],
    runtimeNames: ["low", "high"],
    optionsByVariant: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } },
  }])) as never;
  return createAgentTopologySnapshot({
    generationID: "production-generation",
    orderedPrimaryAgents: [...OBSERVED_PRIMARY_ORDER],
    agentToModel: { ...AGENT_MODEL_BINDINGS },
    behaviorByAgent: { luna: structuredClone(shared), terra: structuredClone(shared), sol: structuredClone(shared) },
    providerBoundaryByAgent: { luna: structuredClone(shared), terra: structuredClone(shared), sol: structuredClone(shared) },
    catalogsByAgent,
  });
}

function contractObservation(snapshot: ReturnType<typeof contractTopology>, sourceAgent: keyof typeof AGENT_MODEL_BINDINGS): TopologyObservation {
  return {
    generationID: snapshot.generationID,
    sourceAgent,
    sourceModel: snapshot.agentToModel[sourceAgent],
    orderedPrimaryAgents: snapshot.orderedPrimaryAgents,
    agentToModel: snapshot.agentToModel,
    behaviorFingerprint: snapshot.behaviorFingerprint,
    providerBoundaryFingerprint: snapshot.providerBoundaryFingerprint,
    catalogFingerprints: snapshot.catalogFingerprints,
    optionsFingerprints: snapshot.optionsFingerprints,
  };
}

function contractMixedResponse(request: TypeSafeAgentRouteRequest) {
  const score = (criteria: readonly unknown[]) => ({
    type: "score",
    score: 1,
    confidence: 1,
    legend: Object.fromEntries(criteria.map((entry, index) => [String(index), entry])),
    probabilities: { 0: 0, 1: 1 },
  });
  return {
    model: "jev-contract",
    answers: {
      target_agent: { type: "choice", choice: "sol", confidence: 1, probabilities: { luna: 0, terra: 0, sol: 1 } },
      reasoning_for_luna: score(request.questions.reasoning_for_luna.criteria),
      reasoning_for_terra: score(request.questions.reasoning_for_terra.criteria),
      reasoning_for_sol: score(request.questions.reasoning_for_sol.criteria),
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

describe("production hook contract", () => {
  test("commits and binds one exact composite agent route without an agent cycle command", async () => {
    const snapshot = contractTopology();
    const hooks = createVariantRouterHooks({
      fallbackVariant: "low",
      agentSelection: { enabled: true },
      variantsByModel: Object.fromEntries(Object.values(AGENT_MODEL_BINDINGS).map((model) => [model, {
        low: { reasoning: true, options: { reasoningEffort: "low" } },
        high: { reasoning: true, options: { reasoningEffort: "high" } },
      }])),
    }, {
      agentClient: { async route(request) { return contractMixedResponse(request); } },
      agentTopology: {
        async acquire({ sourceAgent }) {
          return { topology: snapshot, observation: contractObservation(snapshot, sourceAgent) };
        },
        async revalidate({ sourceAgent }) {
          return contractObservation(snapshot, sourceAgent);
        },
      },
    });
    const message = {
      id: "agent-contract-message",
      sessionID: "agent-contract-session",
      role: "user",
      time: { created: 0 },
      agent: "luna",
      model: { providerID: "openai", modelID: "gpt-5.6-luna" },
    };
    await hooks["chat.message"]?.({
      sessionID: message.sessionID,
      agent: "terra",
      model: { providerID: "openai", modelID: "gpt-5.6-terra" },
    } as never, {
      message,
      parts: [{ id: "part", sessionID: message.sessionID, messageID: message.id, type: "text", text: "Route me" }],
    } as never);
    expect(message).toMatchObject({
      agent: "sol",
      model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" },
    });
    const output = paramsOutput();
    await hooks["chat.params"]?.({
      sessionID: message.sessionID,
      agent: message.agent,
      model: { id: "gpt-5.6-sol", providerID: "openai", reasoning: true, variants },
      provider: { source: "config", info: {}, options: {} },
      message,
    } as never, output as never);
    expect(output.options).toEqual({ foreign: true, reasoningEffort: "high" });

    message.model.variant = "low";
    const mismatchOutput = paramsOutput();
    await expect(hooks["chat.params"]?.({
      sessionID: message.sessionID,
      agent: message.agent,
      model: { id: "gpt-5.6-sol", providerID: "openai", reasoning: true, variants },
      provider: { source: "config", info: {}, options: {} },
      message,
    } as never, mismatchOutput as never)).rejects.toThrow("committed agent route mismatch");
    expect(mismatchOutput.options).toEqual({ foreign: true });
  });
  test("production wiring observes runtime topology and never publishes an agent cycle command", async () => {
    const published: unknown[] = [];
    let routeCalls = 0;
    const agents = OBSERVED_PRIMARY_ORDER.map((name) => ({
      name,
      description: `${name} description`,
      mode: "primary",
      builtIn: false,
      prompt: "shared",
      permission: { edit: "allow", bash: {} },
      tools: { edit: true },
      options: {},
      model: {
        providerID: "openai",
        modelID: AGENT_MODEL_BINDINGS[name].slice("openai/".length),
      },
    }));
    const runtimeModel = (id: string) => ({
      id,
      reasoning: true,
      variants: {
        low: { reasoningEffort: "low" },
        high: { reasoningEffort: "high" },
      },
    });
    const plugin = createTypeSafeVariantRouterPlugin({
      resolveApiKey: async () => "test-key",
      createAgentRouteClient: () => ({
        async route(request) {
          routeCalls += 1;
          return contractMixedResponse(request);
        },
      }),
    });
    const hooks = await plugin({
      directory: "/contract",
      client: {
        app: {
          agents: async () => ({ data: agents }),
          log: async () => ({} as never),
        },
        provider: {
          list: async () => ({
            data: {
              all: [{
                id: "openai",
                models: {
                  "gpt-5.6-luna": runtimeModel("gpt-5.6-luna"),
                  "gpt-5.6-terra": runtimeModel("gpt-5.6-terra"),
                  "gpt-5.6-sol": runtimeModel("gpt-5.6-sol"),
                },
              }],
            },
          }),
        },
        session: { messages: async () => ({ data: [] }) },
        tui: {
          publish: async (request: unknown) => { published.push(request); return { data: true } as never; },
          showToast: async () => ({} as never),
        },
      },
    } as never, {
      fallbackVariant: "low",
      notify: "off",
      variantsByModel: Object.fromEntries(Object.values(AGENT_MODEL_BINDINGS).map((model) => [model, {
        low: { reasoning: true, options: { reasoningEffort: "low" } },
        high: { reasoning: true, options: { reasoningEffort: "high" } },
      }])),
    });
    const output = {
      message: {
        id: "production-agent-message",
        sessionID: "production-agent-session",
        role: "user",
        time: { created: 0 },
        agent: "luna",
        model: { providerID: "openai", modelID: "gpt-5.6-luna" },
      },
      parts: [{
        id: "production-agent-part",
        sessionID: "production-agent-session",
        messageID: "production-agent-message",
        type: "text",
        text: "Route with production topology",
      }],
    };
    await hooks["chat.message"]?.({
      sessionID: "production-agent-session",
      agent: "terra",
      model: { providerID: "openai", modelID: "gpt-5.6-terra" },
    } as never, output as never);
    expect(output.message).toMatchObject({
      agent: "sol",
      model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "high" },
    });
    const params = paramsOutput();
    await hooks["chat.params"]?.({
      sessionID: output.message.sessionID,
      agent: output.message.agent,
      model: { id: "gpt-5.6-sol", providerID: "openai", reasoning: true, variants },
      provider: { source: "config", info: {}, options: {} },
      message: output.message,
    } as never, params as never);
    expect(routeCalls).toBe(1);
    expect(params.options).toEqual({ foreign: true, reasoningEffort: "high" });
    expect(published).toEqual([]);
    await hooks.dispose?.();
  });

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
    } as never, { fallbackVariant: "low", agentSelection: { enabled: false }, notify: "off" });

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
    const hooks = createVariantRouterHooks({ fallbackVariant: "low", agentSelection: { enabled: false } }, {
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
