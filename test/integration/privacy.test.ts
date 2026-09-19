import { describe, expect, test } from "bun:test";

import {
  AGENT_MODEL_BINDINGS,
  OBSERVED_PRIMARY_ORDER,
  createAgentTopologySnapshot,
  type RingAgentID,
} from "../../src/agent-topology.ts";
import { createAgentRouteRouter, type TypeSafeAgentRouteRequest } from "../../src/agent-route.ts";
import { createDecisionStore, createAgentRouteStore } from "../../src/decision-store.ts";
import { createUnavailableAgentSync } from "../../src/agent-sync.ts";
import {
  evaluateAgentCorpus,
  type AgentEvaluationCase,
} from "../evaluation/evaluation-harness.ts";
import type { VariantCatalog } from "../../src/open-code-variant-adapter.ts";
import {
  createTypeSafeVariantRouterPlugin,
  createVariantRouterHooks,
  formatAppliedVariantNotification,
  TypeSafeVariantRouterPlugin,
} from "../../src/plugin.ts";
import type { RouterDecision, RouterDiagnostic, TypeSafeScoreClient } from "../../src/typesafe-router.ts";
import { createDiagnostic, serializeDiagnostic, type DiagnosticRecord } from "../../src/diagnostics.ts";

const markers = {
  prompt: "PRIVATE_PROMPT_2f58",
  history: "PRIVATE_HISTORY_a911",
  description: "PRIVATE_DESCRIPTION_f41a",
  resolvedPrompt: "PRIVATE_RESOLVED_PROMPT_614e",
  permissions: "PRIVATE_PERMISSIONS_384f",
  tools: "PRIVATE_TOOLS_992a",
  skills: "PRIVATE_SKILLS_519d",
  credential: "PRIVATE_CREDENTIAL_773c",
  requestState: "PRIVATE_REQUEST_STATE_c90e",
  probabilities: "PRIVATE_PROBABILITIES_2cc9",
  options: "PRIVATE_OPTIONS_b477",
  rawResponse: "PRIVATE_RAW_RESPONSE_013b",
  errorBody: "PRIVATE_ERROR_BODY_4c81",
  stack: "PRIVATE_STACK_92bd",
  fingerprint: "PRIVATE_FINGERPRINT_6bf2",
  sessionID: "PRIVATE_SESSION_ID_c2d3",
  messageID: "PRIVATE_MESSAGE_ID_d9aa",
  path: "/home/private/PRIVATE_PATH_f611",
  toolOutput: "PRIVATE_TOOL_OUTPUT_01f4",
};
const variants = { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } };

function messageInput() {
  return { sessionID: "privacy-session", model: { providerID: "openai", modelID: "gpt-5" } };
}

function messageOutput(id: string) {
  return {
    message: { id, sessionID: "privacy-session", role: "user", time: { created: 0 }, agent: "build", model: { providerID: "openai", modelID: "gpt-5" } },
    parts: [{ id: `part-${id}`, sessionID: "privacy-session", messageID: id, type: "text", text: markers.prompt }],
  };
}

function paramsInput(id: string) {
  return {
    sessionID: "privacy-session",
    agent: "build",
    model: { id: "gpt-5", providerID: "openai", reasoning: true, variants },
    provider: { source: "config", info: {}, options: { marker: markers.requestState } },
    message: { id, sessionID: "privacy-session", role: "user", time: { created: 0 }, agent: "build", model: { providerID: "openai", modelID: "gpt-5" } },
  };
}

function paramsOutput() {
  return { temperature: 1, topP: 1, topK: 0, maxOutputTokens: undefined, options: { foreign: true } };
}

function loggedDiagnostics(logs: unknown[]): DiagnosticRecord[] {
  return logs.map((entry) => {
    const message = (entry as { body?: { message?: unknown } }).body?.message;
    return JSON.parse(typeof message === "string" ? message : "null") as DiagnosticRecord;
  }).filter(Boolean);
}

describe("production privacy boundaries", () => {
  test("production export initializes from an inherited credential without external calls", async () => {
    const previousApiKey = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = markers.credential;
    try {
      const hooks = await TypeSafeVariantRouterPlugin({
        client: {
          app: { log: async () => ({} as never) },
          tui: { showToast: async () => ({} as never) },
          session: { messages: async () => ({ data: [] }) },
        },
      } as never, { fallbackVariant: "low", enabled: false });

      expect(typeof hooks["chat.message"]).toBe("function");
      expect(typeof hooks["chat.params"]).toBe("function");
      await hooks.dispose?.();
    } finally {
      if (previousApiKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previousApiKey;
    }
  });

  test("production history and observer wiring expose only safe code, model, status, and TUI command values", async () => {
    const logs: unknown[] = [];
    const toasts: unknown[] = [];
    const commands: unknown[] = [];
    let resolveCommands: (() => void) | undefined;
    const commandsCompleted = new Promise<void>((resolve) => { resolveCommands = resolve; });
    let historyCalls = 0;
    const previousApiKey = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      let credentialResolutions = 0;
      const plugin = createTypeSafeVariantRouterPlugin({
        resolveApiKey: async () => {
          credentialResolutions += 1;
          return undefined;
        },
      });
      const hooks = await plugin({
        client: {
          app: { log: async (request: unknown) => { logs.push(request); return {} as never; } },
          tui: {
            showToast: async (request: unknown) => { toasts.push(request); return {} as never; },
            publish: async (request: unknown) => {
              commands.push(request);
              if (commands.length === 1) resolveCommands?.();
              return {} as never;
            },
          },
          session: {
            messages: async () => {
              historyCalls += 1;
              return {
                data: [
                  { info: { role: "system" }, parts: [{ type: "text", text: markers.credential }] },
                  { info: { role: "user" }, parts: [{ type: "reasoning", text: markers.requestState }, { type: "text", text: markers.history }] },
                  { info: { role: "assistant" }, parts: [{ type: "tool", text: markers.rawResponse }, { type: "file", text: markers.errorBody }] },
                ],
              };
            },
          },
        },
      } as never, { fallbackVariant: "low", agentSelection: { enabled: false }, notify: "always", logLevel: "info" });

      for (const messageID of ["production-privacy-1", "production-privacy-2"]) {
        await hooks["chat.message"]?.(messageInput() as never, messageOutput(messageID) as never);
        await hooks["chat.params"]?.(paramsInput(messageID) as never, paramsOutput() as never);
      }

      expect(credentialResolutions).toBe(1);
      expect(historyCalls).toBe(2);
      expect(loggedDiagnostics(logs)).toEqual(expect.arrayContaining([
        expect.objectContaining({ boundary: "credential", reasonCode: "missing-api-key", modelID: "openai/gpt-5" }),
        expect.objectContaining({ boundary: "tui-sync", reasonCode: "variant-sync-publish-failed" }),
      ]));
      expect(toasts).toEqual([
        {
          body: {
            title: "TypeSafe variant router",
            message: "Using fallback variant \"low\" for openai/gpt-5 because the TypeSafe API key is unavailable.",
            variant: "warning",
          },
        },
        {
          body: {
            title: "TypeSafe variant router",
            message: "Using fallback variant \"low\" for openai/gpt-5 because the TypeSafe API key is unavailable.",
            variant: "warning",
          },
        },
      ]);
      await commandsCompleted;
      await hooks.dispose?.();
      expect(commands).toEqual([
        { body: { type: "tui.command.execute", properties: { command: "variant.cycle" } } },
        { body: { type: "tui.command.execute", properties: { command: "variant.cycle" } } },
      ]);
      const observableState = JSON.stringify({ logs, toasts, commands });
      for (const marker of Object.values(markers)) expect(observableState).not.toContain(marker);
    } finally {
      if (previousApiKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previousApiKey;
    }
  });

  test("G3 unavailable publishes zero agent commands and exposes only sanitized unavailable state", async () => {
    const commands: unknown[] = [];
    const logs: unknown[] = [];
    const toasts: unknown[] = [];
    const runtimeVariants = {
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
    };
    const hostAgents = [
      {
        name: "build",
        mode: "primary",
        builtIn: true,
        prompt: "unrelated built-in primary",
        permission: {},
        tools: {},
        model: { providerID: "openai", modelID: "gpt-5.6-sol" },
      },
      ...OBSERVED_PRIMARY_ORDER.map((name) => ({
        name,
        mode: "primary",
        builtIn: false,
        prompt: "shared prompt",
        permission: { edit: "allow" },
        tools: { edit: true },
        model: {
          providerID: "openai",
          modelID: AGENT_MODEL_BINDINGS[name].slice("openai/".length),
        },
      })),
    ];
    const routeResponse = (request: TypeSafeAgentRouteRequest) => {
      const score = (agent: RingAgentID, selected: number) => ({
        type: "score",
        score: selected,
        confidence: 1,
        legend: Object.fromEntries(request.questions[`reasoning_for_${agent}`].criteria.map((criterion, index) => [String(index), criterion])),
        probabilities: Object.fromEntries(request.questions[`reasoning_for_${agent}`].criteria.map((_criterion, index) => [String(index), index === selected ? 1 : 0])),
      });
      return {
        model: "offline-jev",
        answers: {
          target_agent: {
            type: "choice",
            choice: "terra",
            confidence: 1,
            probabilities: { luna: 0, terra: 1, sol: 0 },
          },
          reasoning_for_luna: score("luna", 0),
          reasoning_for_terra: score("terra", 1),
          reasoning_for_sol: score("sol", 0),
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    };
    const plugin = createTypeSafeVariantRouterPlugin({
      resolveApiKey: async () => "offline-test-key",
      createAgentRouteClient: () => ({ async route(request) { return routeResponse(request); } }),
    });
    const hooks = await plugin({
      directory: "/offline",
      client: {
        app: {
          agents: async () => ({ data: hostAgents }),
          log: async (request: unknown) => { logs.push(request); return {} as never; },
        },
        provider: {
          list: async () => ({
            data: {
              all: [{
                id: "openai",
                models: Object.fromEntries(Object.values(AGENT_MODEL_BINDINGS).map((modelKey) => [
                  modelKey.slice("openai/".length),
                  { providerID: "openai", id: modelKey.slice("openai/".length), reasoning: true, variants: runtimeVariants },
                ])),
              }],
            },
          }),
        },
        tui: {
          publish: async (request: unknown) => { commands.push(request); return { data: true } as never; },
          showToast: async (request: unknown) => { toasts.push(request); return {} as never; },
        },
        session: { messages: async () => ({ data: [] }) },
      },
    } as never, { fallbackVariant: "low", notify: "always", logLevel: "info" });
    const output = {
      message: {
        id: "g3-unavailable",
        sessionID: "privacy-session",
        role: "user",
        time: { created: 0 },
        agent: "luna",
        model: { providerID: "openai", modelID: "gpt-5.6-luna" },
      },
      parts: [{ id: "g3-part", sessionID: "privacy-session", messageID: "g3-unavailable", type: "text", text: markers.prompt }],
    };

    await hooks["chat.message"]?.({
      sessionID: "privacy-session",
      agent: "luna",
      model: { providerID: "openai", modelID: "gpt-5.6-luna" },
    } as never, output as never);
    await hooks["chat.params"]?.({
      sessionID: "privacy-session",
      agent: "terra",
      model: { id: "gpt-5.6-terra", providerID: "openai", reasoning: true, variants: runtimeVariants },
      provider: { source: "config", info: {}, options: {} },
      message: output.message,
    } as never, paramsOutput() as never);
    await Promise.resolve();

    expect(output.message).toMatchObject({
      agent: "terra",
      model: { providerID: "openai", modelID: "gpt-5.6-terra", variant: "high" },
    });
    expect(commands).toEqual([]);
    expect(loggedDiagnostics(logs)).toEqual([
      expect.objectContaining({
        level: "info",
        boundary: "tui-sync",
        reasonCode: "agent-sync-unavailable",
        reasons: ["targetless-command", "unproven-selector-scope", "ambiguous-delivery"],
      }),
    ]);
    expect(toasts).toEqual([{
      body: {
        title: "TypeSafe variant router",
        message: "Selected variant \"high\" for openai/gpt-5.6-terra (routing confidence: 100%).",
        variant: "info",
      },
    }]);
    const observable = JSON.stringify({ commands, logs, toasts });
    for (const marker of Object.values(markers)) expect(observable).not.toContain(marker);
    await hooks.dispose?.();
  });

  test("warns once when agent routing cannot start without a TypeSafe API key", async () => {
    const logs: unknown[] = [];
    const toasts: unknown[] = [];
    const runtimeVariants = {
      low: { reasoningEffort: "low" },
      high: { reasoningEffort: "high" },
    };
    const hostAgents = [
      {
        name: "build",
        mode: "primary",
        builtIn: true,
        prompt: "unrelated built-in primary",
        permission: {},
        tools: {},
        model: { providerID: "openai", modelID: "gpt-5.6-sol" },
      },
      ...OBSERVED_PRIMARY_ORDER.map((name) => ({
        name,
        mode: "primary",
        builtIn: false,
        prompt: "shared prompt",
        permission: { edit: "allow" },
        tools: { edit: true },
        model: {
          providerID: "openai",
          modelID: AGENT_MODEL_BINDINGS[name].slice("openai/".length),
        },
      })),
    ];
    const plugin = createTypeSafeVariantRouterPlugin({ resolveApiKey: async () => undefined });
    const hooks = await plugin({
      directory: "/offline",
      client: {
        app: {
          agents: async () => ({ data: hostAgents }),
          log: async (request: unknown) => { logs.push(request); return {} as never; },
        },
        provider: {
          list: async () => ({
            data: {
              all: [{
                id: "openai",
                models: Object.fromEntries(Object.values(AGENT_MODEL_BINDINGS).map((modelKey) => [
                  modelKey.slice("openai/".length),
                  { providerID: "openai", id: modelKey.slice("openai/".length), reasoning: true, variants: runtimeVariants },
                ])),
              }],
            },
          }),
        },
        tui: { showToast: async (request: unknown) => { toasts.push(request); return {} as never; } },
        session: { messages: async () => ({ data: [] }) },
      },
    } as never, { fallbackVariant: "low", notify: "always", logLevel: "info" });
    const output = {
      message: {
        id: "missing-agent-key",
        sessionID: "privacy-session",
        role: "user",
        time: { created: 0 },
        agent: "sol",
        model: { providerID: "openai", modelID: "gpt-5.6-sol" },
      },
      parts: [{ id: "missing-agent-key-part", sessionID: "privacy-session", messageID: "missing-agent-key", type: "text", text: markers.prompt }],
    };

    await hooks["chat.message"]?.({
      sessionID: "privacy-session",
      agent: "sol",
      model: { providerID: "openai", modelID: "gpt-5.6-sol" },
    } as never, output as never);
    await Promise.resolve();

    expect(loggedDiagnostics(logs)).toEqual(expect.arrayContaining([
      expect.objectContaining({ boundary: "credential", reasonCode: "missing-api-key", modelID: "openai/gpt-5.6-sol" }),
    ]));
    expect(toasts).toEqual([{
      body: {
        title: "TypeSafe variant router",
        message: "Keeping the current agent for openai/gpt-5.6-sol because the TypeSafe API key is unavailable.",
        variant: "warning",
      },
    }]);
    const observable = JSON.stringify({ logs, toasts });
    for (const marker of Object.values(markers)) expect(observable).not.toContain(marker);
    await hooks.dispose?.();
  });

  test("falls back to the TUI toast event when the show-toast endpoint rejects delivery", async () => {
    const logs: unknown[] = [];
    const events: unknown[] = [];
    const plugin = createTypeSafeVariantRouterPlugin({ resolveApiKey: async () => undefined });
    const hooks = await plugin({
      client: {
        app: { log: async (request: unknown) => { logs.push(request); return {} as never; } },
        tui: {
          showToast: async () => ({ error: { name: "TransportError" } } as never),
          publish: async (request: unknown) => { events.push(request); return { data: true } as never; },
        },
        session: { messages: async () => ({ data: [] }) },
      },
    } as never, { fallbackVariant: "low", agentSelection: { enabled: false }, notify: "always", logLevel: "info" });

    await hooks["chat.message"]?.(messageInput() as never, messageOutput("toast-transport-fallback") as never);
    await hooks["chat.params"]?.(paramsInput("toast-transport-fallback") as never, paramsOutput() as never);
    await Promise.resolve();

    expect(events).toContainEqual({
      body: {
        type: "tui.toast.show",
        properties: {
          title: "TypeSafe variant router",
          message: "Using fallback variant \"low\" for openai/gpt-5 because the TypeSafe API key is unavailable.",
          variant: "warning",
        },
      },
    });
    expect(logs).not.toContainEqual(expect.objectContaining({
      body: expect.objectContaining({ message: "notification-delivery-failed" }),
    }));
    await hooks.dispose?.();
  });

  test("passes the per-message AbortSignal to production history requests", async () => {
    for (const cleanup of ["session", "dispose"] as const) {
      let historyRequest: { path?: { id?: string }; signal?: AbortSignal } | undefined;
      const plugin = createTypeSafeVariantRouterPlugin({ resolveApiKey: async () => undefined });
      const hooks = await plugin({
        client: {
          app: { log: async () => ({} as never) },
          tui: { showToast: async () => ({} as never) },
          session: {
            messages: async (request: { path?: { id?: string }; signal?: AbortSignal }) => {
              historyRequest = request;
              return new Promise(() => undefined);
            },
          },
        },
      } as never, { fallbackVariant: "low", agentSelection: { enabled: false } });

      await hooks["chat.message"]?.(
        messageInput() as never,
        messageOutput(`production-history-abort-${cleanup}`) as never,
      );
      const signal = historyRequest?.signal;
      expect(historyRequest?.path?.id, cleanup).toBe("privacy-session");
      expect(signal, cleanup).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted, cleanup).toBe(false);

      if (cleanup === "session") {
        await hooks.event?.({
          event: { type: "session.deleted", properties: { info: { id: "privacy-session" } } },
        } as never);
      } else {
        await hooks.dispose?.();
      }

      expect(historyRequest?.signal, cleanup).toBe(signal);
      expect(signal?.aborted, cleanup).toBe(true);
    }
  });

  test("treats resolved publish errors, false or missing data, and throws as failed cycle commands", async () => {
    const cases = [
      { name: "resolved error", execute: async () => ({ data: undefined, error: { name: "BadRequest" } }) },
      { name: "false data", execute: async () => ({ data: false, error: undefined }) },
      { name: "missing data", execute: async () => ({}) },
      { name: "throw", execute: async () => { throw new Error(markers.errorBody); } },
    ] as const;

    for (const scenario of cases) {
      const commands: unknown[] = [];
      const plugin = createTypeSafeVariantRouterPlugin({ resolveApiKey: async () => undefined });
      const hooks = await plugin({
        client: {
          app: { log: async () => ({} as never) },
          tui: {
            showToast: async () => ({} as never),
            publish: async (request: unknown) => {
              commands.push(request);
              return scenario.execute() as never;
            },
          },
          session: { messages: async () => ({ data: [] }) },
        },
      } as never, { fallbackVariant: "high", agentSelection: { enabled: false }, notify: "off" });

      await hooks["chat.message"]?.(messageInput() as never, messageOutput(`command-${scenario.name}`) as never);
      const output = paramsOutput();
      await hooks["chat.params"]?.(paramsInput(`command-${scenario.name}`) as never, output as never);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await hooks.dispose?.();

      expect(output.options).toEqual({ foreign: true, reasoningEffort: "high" });
      expect(commands, scenario.name).toEqual([{
        body: {
          type: "tui.command.execute",
          properties: { command: "variant.cycle" },
        },
      }]);
      expect(JSON.stringify(commands)).not.toContain("PRIVATE_");
    }
  });

  test("rejected history loads fall back with per-prompt safe toasts and deduplicated logs", async () => {
    const logs: unknown[] = [];
    const toasts: unknown[] = [];
    let historyCalls = 0;
    const plugin = createTypeSafeVariantRouterPlugin({ resolveApiKey: async () => undefined });
    const hooks = await plugin({
      client: {
        app: { log: async (request: unknown) => { logs.push(request); return {} as never; } },
        tui: { showToast: async (request: unknown) => { toasts.push(request); return {} as never; } },
        session: {
          messages: async () => {
            historyCalls += 1;
            throw new Error(`${markers.errorBody}:${markers.prompt}:${markers.history}`);
          },
        },
      },
    } as never, { fallbackVariant: "low", agentSelection: { enabled: false }, notify: "fallback", logLevel: "info" });

    const outputs = [];
    for (const messageID of ["history-rejection-1", "history-rejection-2"]) {
      const output = paramsOutput();
      await hooks["chat.message"]?.(messageInput() as never, messageOutput(messageID) as never);
      await hooks["chat.params"]?.(paramsInput(messageID) as never, output as never);
      outputs.push(output);
    }

    expect(historyCalls).toBe(2);
    expect(outputs.map((output) => output.options)).toEqual([
      { foreign: true, reasoningEffort: "low" },
      { foreign: true, reasoningEffort: "low" },
    ]);
    expect(loggedDiagnostics(logs)).toEqual(expect.arrayContaining([
      expect.objectContaining({ boundary: "history", reasonCode: "history-error", disposition: "fallback", modelID: "openai/gpt-5" }),
    ]));
    expect(toasts).toEqual([
      {
        body: {
          title: "TypeSafe variant router",
          message: "Using fallback variant \"low\" for openai/gpt-5 because the TypeSafe client failed.",
          variant: "warning",
        },
      },
      {
        body: {
          title: "TypeSafe variant router",
          message: "Using fallback variant \"low\" for openai/gpt-5 because the TypeSafe client failed.",
          variant: "warning",
        },
      },
    ]);
    const observableState = JSON.stringify({ logs, toasts });
    for (const marker of Object.values(markers)) expect(observableState).not.toContain(marker);
  });

  test("reports the failed response invariant without exposing response values", async () => {
    const logs: unknown[] = [];
    const toasts: unknown[] = [];
    const plugin = createTypeSafeVariantRouterPlugin({
      resolveApiKey: async () => markers.credential,
      createScoreClient: () => ({
        async score() {
          return {
            type: markers.rawResponse,
            score: 0,
            confidence: 1,
            legend: { 0: markers.requestState, 1: markers.errorBody },
            probabilities: { 0: 1, 1: 0, [markers.probabilities]: 0 },
          };
        },
      }),
    });
    const hooks = await plugin({
      client: {
        app: { log: async (request: unknown) => { logs.push(request); return {} as never; } },
        tui: { showToast: async (request: unknown) => { toasts.push(request); return {} as never; } },
        session: { messages: async () => ({ data: [] }) },
      },
    } as never, { fallbackVariant: "low", agentSelection: { enabled: false }, notify: "fallback", logLevel: "info" });

    await hooks["chat.message"]?.(messageInput() as never, messageOutput("invalid-response-detail") as never);
    await hooks["chat.params"]?.(paramsInput("invalid-response-detail") as never, paramsOutput() as never);

    expect(loggedDiagnostics(logs)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        boundary: "typesafe",
        operation: "validate-route-response",
        reasonCode: "invalid-response",
        disposition: "fallback",
        modelID: "openai/gpt-5",
        detail: "type",
      }),
    ]));
    expect(toasts).toEqual([{
      body: {
        title: "TypeSafe variant router",
        message: "Using fallback variant \"low\" for openai/gpt-5 because TypeSafe response validation failed (type).",
        variant: "warning",
      },
    }]);
    const observableState = JSON.stringify({ logs, toasts });
    for (const marker of Object.values(markers)) expect(observableState).not.toContain(marker);
    await hooks.dispose?.();
  });

  test("logs raw TypeSafe responses and applied decisions only at debug level", async () => {
    const logs: unknown[] = [];
    const rawResponse = {
      type: markers.rawResponse,
      score: 0,
      confidence: 1,
      legend: { 0: markers.requestState, 1: markers.errorBody },
      probabilities: { 0: 1, 1: 0 },
    };
    const plugin = createTypeSafeVariantRouterPlugin({
      resolveApiKey: async () => markers.credential,
      createScoreClient: () => ({ async score() { return rawResponse as never; } }),
    });
    const hooks = await plugin({
      client: {
        app: { log: async (request: unknown) => { logs.push(request); return {} as never; } },
        tui: { showToast: async () => ({} as never) },
        session: { messages: async () => ({ data: [] }) },
      },
    } as never, { fallbackVariant: "low", agentSelection: { enabled: false }, notify: "off", logLevel: "debug" });

    await hooks["chat.message"]?.(messageInput() as never, messageOutput("debug-response") as never);
    await hooks["chat.params"]?.(paramsInput("debug-response") as never, paramsOutput() as never);

    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ body: expect.objectContaining({ level: "info" }) }),
    ]));
    const debugEvents = logs
      .map((entry) => (entry as { body?: { message?: string } }).body?.message)
      .filter((message): message is string => typeof message === "string")
      .map((message) => JSON.parse(message) as { event?: Record<string, unknown> });
    expect(debugEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: { event: "variant-response", response: rawResponse } }),
      expect.objectContaining({ event: expect.objectContaining({ event: "variant-decision", variant: "low", status: "fallback", reason: "invalid-response" }) }),
    ]));
    await hooks.dispose?.();
  });

  test("emits exactly one privacy-safe application toast according to each notify mode", async () => {
    const scenarios = [
      { name: "fallback off", notify: "off", manual: false, expected: [] },
      { name: "fallback enabled", notify: "fallback", manual: false, expected: ["Using fallback variant \"low\" for openai/gpt-5 because the TypeSafe API key is unavailable."] },
      { name: "fallback always", notify: "always", manual: false, expected: ["Using fallback variant \"low\" for openai/gpt-5 because the TypeSafe API key is unavailable."] },
      { name: "manual hidden for fallback-only", notify: "fallback", manual: true, expected: [] },
      { name: "manual always", notify: "always", manual: true, expected: ["Using manual variant \"high\" for openai/gpt-5."] },
    ] as const;

    for (const scenario of scenarios) {
      const toasts: Array<{ body?: { message?: string } }> = [];
      const plugin = createTypeSafeVariantRouterPlugin({ resolveApiKey: async () => undefined });
      const hooks = await plugin({
        client: {
          app: { log: async () => ({} as never) },
          tui: { showToast: async (request: { body?: { message?: string } }) => { toasts.push(request); return {} as never; } },
          session: { messages: async () => ({ data: [] }) },
        },
      } as never, {
        fallbackVariant: "low",
        agentSelection: { enabled: false },
        notify: scenario.notify,
        ...(scenario.manual ? { manualVariantPolicy: "manual-first" } : {}),
      });
      const input = scenario.manual ? { ...messageInput(), variant: "high" } : messageInput();
      const output = paramsOutput();

      await hooks["chat.message"]?.(input as never, messageOutput(`notify-${scenario.name}`) as never);
      await hooks["chat.params"]?.(paramsInput(`notify-${scenario.name}`) as never, output as never);
      await hooks["chat.params"]?.(paramsInput(`notify-${scenario.name}`) as never, paramsOutput() as never);

      expect(toasts.map((toast) => toast.body?.message), scenario.name).toEqual(scenario.expected);
      expect(JSON.stringify(toasts), scenario.name).not.toContain("PRIVATE_");
      await hooks.dispose?.();
    }
  });

  test("formats application notifications without duplicate internal labels", () => {
    const selected = formatAppliedVariantNotification({
      modelID: "openai/gpt-5.6-sol",
      variant: "low",
      status: "selected",
      reason: "selected",
      confidence: 0.59,
    });
    const manual = formatAppliedVariantNotification({
      modelID: "openai/gpt-5.6-sol",
      variant: "high",
      status: "manual",
      reason: "selected",
    });
    expect(selected).toEqual({
      message: "Selected variant \"low\" for openai/gpt-5.6-sol (routing confidence: 59%). Low routing confidence.",
      variant: "info",
    });
    expect(manual).toEqual({
      message: "Using manual variant \"high\" for openai/gpt-5.6-sol.",
      variant: "info",
    });

    const fallbackCases = [
      ["missing-api-key", undefined, "the TypeSafe API key is unavailable"],
      ["invalid-response", "score", "TypeSafe response validation failed (score)"],
      ["pre-request-timeout", undefined, "the routing deadline expired before the TypeSafe request started"],
      ["request-timeout", undefined, "the TypeSafe request exceeded the routing deadline"],
      ["network-error", undefined, "the TypeSafe network request failed"],
      ["auth-error", undefined, "TypeSafe authentication failed"],
      ["rate-limited", undefined, "TypeSafe rate-limited the request"],
      ["server-error", undefined, "TypeSafe returned a server error"],
      ["client-error", undefined, "the TypeSafe client failed"],
    ] as const;
    const fallbacks = fallbackCases.map(([reason, detail, expectedReason]) => {
      const notification = formatAppliedVariantNotification({
        modelID: "openai/gpt-5.6-sol",
        variant: "medium",
        status: "fallback",
        reason,
        ...(detail ? { detail } : {}),
      });
      expect(notification).toEqual({
        message: `Using fallback variant \"medium\" for openai/gpt-5.6-sol because ${expectedReason}.`,
        variant: "warning",
      });
      return notification;
    });
    expect(JSON.stringify({ selected, manual, fallbacks })).not.toContain("selected:selected");
  });

  test("agent routing exposes only filtered request fields and keeps every forbidden canary out of retained surfaces", async () => {
    const behavior = {
      prompt: markers.resolvedPrompt,
      permission: markers.permissions,
      tools: [markers.tools],
      skills: [markers.skills],
    };
    const catalog = (agent: RingAgentID) => ({
      modelKey: AGENT_MODEL_BINDINGS[agent],
      names: ["low", "high"],
      runtimeNames: ["low", "high"],
      optionsByVariant: {
        low: { reasoningEffort: "low", privateCanary: markers.options },
        high: { reasoningEffort: "high", privateCanary: markers.options },
      },
    });
    const topology = createAgentTopologySnapshot({
      generationID: "privacy-generation",
      orderedPrimaryAgents: OBSERVED_PRIMARY_ORDER,
      agentToModel: AGENT_MODEL_BINDINGS,
      behaviorByAgent: { luna: behavior, terra: behavior, sol: behavior },
      providerBoundaryByAgent: { luna: behavior, terra: behavior, sol: behavior },
      catalogsByAgent: { luna: catalog("luna"), terra: catalog("terra"), sol: catalog("sol") },
    });
    const observation = {
      generationID: topology.generationID,
      sourceAgent: "luna",
      sourceModel: AGENT_MODEL_BINDINGS.luna,
      orderedPrimaryAgents: topology.orderedPrimaryAgents,
      agentToModel: topology.agentToModel,
      behaviorFingerprint: topology.behaviorFingerprint,
      providerBoundaryFingerprint: topology.providerBoundaryFingerprint,
      catalogFingerprints: topology.catalogFingerprints,
      optionsFingerprints: topology.optionsFingerprints,
    } as const;
    let captured: TypeSafeAgentRouteRequest | undefined;
    const router = createAgentRouteRouter({
      now: () => 10,
      client: {
        async route(request) {
          captured = request;
          return {
            raw: markers.rawResponse,
            body: markers.errorBody,
            credential: markers.credential,
            probabilities: markers.probabilities,
            options: markers.options,
          };
        },
      },
    });

    const decision = await router.route({
      state: {
        currentPrompt: markers.prompt,
        recentMessages: [{ role: "user", text: markers.history }],
        model: AGENT_MODEL_BINDINGS.luna,
      },
      sourceAgent: "luna",
      sourceModel: AGENT_MODEL_BINDINGS.luna,
      topology,
      observation,
      observeCurrentTopology: () => observation,
      agentProfiles: { luna: markers.description, terra: markers.description, sol: markers.description },
      variantDescriptionsByAgent: { luna: { low: markers.description } },
      timeoutMs: 1_000,
    });

    expect(decision).toEqual({ status: "rejected", reason: "invalid-response", createdAt: 10 });
    expect(Object.keys(captured?.state ?? {}).sort()).toEqual([
      "currentPrompt",
      "recentMessages",
    ]);
    const disclosedRequest = JSON.stringify(captured);
    expect(disclosedRequest).toContain(markers.prompt);
    expect(disclosedRequest).toContain(markers.history);
    expect(disclosedRequest).toContain(markers.description);
    for (const marker of [
      markers.resolvedPrompt,
      markers.permissions,
      markers.tools,
      markers.skills,
      markers.credential,
      markers.probabilities,
      markers.options,
      markers.rawResponse,
      markers.errorBody,
    ]) expect(disclosedRequest).not.toContain(marker);

    const store = createAgentRouteStore({ ttlMs: 1_000, maxEntries: 2, now: () => 10 });
    const reservation = store.reserve({ sessionID: "privacy-session", messageID: "privacy-agent" }, () => undefined);
    expect(reservation?.commit({
      sessionID: "privacy-session",
      messageID: "privacy-agent",
      turnOrder: 1,
      sourceAgent: "luna",
      sourceModel: AGENT_MODEL_BINDINGS.luna,
      targetAgent: "terra",
      targetModel: AGENT_MODEL_BINDINGS.terra,
      targetVariant: "high",
      confidence: 0.9,
      topologyGenerationID: topology.generationID,
      behaviorFingerprint: topology.behaviorFingerprint,
      catalogFingerprint: topology.catalogFingerprints.terra,
      optionsFingerprint: topology.optionsFingerprints.terra,
      createdAt: 10,
    })).toBe(true);
    const sync = createUnavailableAgentSync({ enabled: true });
    sync.reportUnavailable();
    const evaluationCases: AgentEvaluationCase[] = [{
      id: "privacy-evaluation",
      prompt: markers.prompt,
      sourceAgent: "luna",
      acceptableAgents: ["luna"],
      expectedVariant: "low",
      targetAgent: "luna",
      targetVariant: "low",
      choiceConfidence: 0.9,
      variantConfidence: 0.9,
      latencyMs: 1,
      outcome: "selected",
      pipelineOutcome: "success",
      syncOutcome: "unavailable",
    }];
    const evaluation = await evaluateAgentCorpus(evaluationCases, []);
    const fingerprints = {
      behavior: topology.behaviorFingerprint,
      provider: topology.providerBoundaryFingerprint,
      options: topology.optionsFingerprints,
      catalogs: topology.catalogFingerprints,
    };
    const forbiddenSurfaces = JSON.stringify({
      decision,
      store: store.inspect(),
      fingerprints,
      sync: sync.inspect(),
      evaluation,
    });
    for (const marker of Object.values(markers)) expect(forbiddenSurfaces).not.toContain(marker);
    expect(forbiddenSurfaces).not.toContain("probabilities");
  });

  test("forbidden markers never enter diagnostics or Decision Store metadata", async () => {
    const diagnostics: RouterDiagnostic[] = [];
    const store = createDecisionStore<{
      start(catalog: VariantCatalog): Promise<RouterDecision>;
      timeout(catalog: VariantCatalog): RouterDecision;
      terminal(): RouterDecision | undefined;
      cancel(): void;
    }>({ ttlMs: 10_000, maxEntries: 8 });
    const client: TypeSafeScoreClient = {
      async score() {
        throw Object.assign(new Error("request failed"), {
          status: 500,
          body: markers.errorBody,
          raw: markers.rawResponse,
          credential: markers.credential,
          stack: markers.stack,
          fingerprint: markers.fingerprint,
          sessionID: markers.sessionID,
          messageID: markers.messageID,
          path: markers.path,
          toolOutput: markers.toolOutput,
        });
      },
    };
    const hooks = createVariantRouterHooks({ fallbackVariant: "low", agentSelection: { enabled: false } }, {
      client,
      store,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      historyProvider: async () => [
        { role: "user", parts: [{ type: "text", text: markers.history }] },
        { role: "assistant", parts: [{ type: "tool", text: markers.requestState }] },
      ],
    });

    await hooks["chat.message"]?.(messageInput() as never, messageOutput("privacy") as never);
    expect(JSON.stringify(store.inspect())).not.toContain("PRIVATE_");
    await hooks["chat.params"]?.(paramsInput("privacy") as never, paramsOutput() as never);

    const observableState = JSON.stringify({ diagnostics, store: store.inspect() });
    for (const marker of Object.values(markers)) expect(observableState).not.toContain(marker);
    expect(diagnostics).toEqual([{ code: "server-error", modelID: "openai/gpt-5", status: "fallback" }]);
  });

  test("the allowlisted serializer drops exception text, stacks, paths, IDs, arbitrary metadata, hashes, and fingerprints", () => {
    const diagnostic = createDiagnostic("bindingMismatch", {
      modelID: "openai/gpt-5",
      comparisonReason: "options-mismatch",
      error: new Error(markers.errorBody),
      message: markers.prompt,
      stack: markers.stack,
      path: markers.path,
      sessionID: markers.sessionID,
      messageID: markers.messageID,
      metadata: { toolOutput: markers.toolOutput },
      hash: markers.fingerprint,
      fingerprint: markers.fingerprint,
    } as never);
    const serialized = serializeDiagnostic(diagnostic);

    expect(JSON.parse(serialized)).toEqual({
      schemaVersion: 1,
      service: "typesafe-variant-router",
      level: "error",
      boundary: "binding",
      operation: "validate-binding",
      reasonCode: "binding-mismatch",
      disposition: "fatal-turn",
      modelID: "openai/gpt-5",
      comparisonReason: "options-mismatch",
    });
    for (const marker of Object.values(markers)) expect(serialized).not.toContain(marker);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    for (const prohibitedKey of ["error", "message", "stack", "path", "sessionID", "messageID", "metadata", "hash", "fingerprint"]) {
      expect(Object.hasOwn(parsed, prohibitedKey)).toBe(false);
    }
  });
});
