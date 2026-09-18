import { describe, expect, test } from "bun:test";

import { createDecisionStore } from "../plugins/typesafe-variant-router/decision-store.ts";
import type { VariantCatalog } from "../plugins/typesafe-variant-router/open-code-variant-adapter.ts";
import {
  createTypeSafeVariantRouterPlugin,
  createVariantRouterHooks,
  formatAppliedVariantNotification,
  TypeSafeVariantRouterPlugin,
} from "../plugins/typesafe-variant-router/plugin.ts";
import type { RouterDecision, RouterDiagnostic, TypeSafeScoreClient } from "../plugins/typesafe-variant-router/typesafe-router.ts";

const markers = {
  prompt: "PRIVATE_PROMPT_2f58",
  history: "PRIVATE_HISTORY_a911",
  credential: "PRIVATE_CREDENTIAL_773c",
  requestState: "PRIVATE_REQUEST_STATE_c90e",
  rawResponse: "PRIVATE_RAW_RESPONSE_013b",
  errorBody: "PRIVATE_ERROR_BODY_4c81",
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
      } as never, { fallbackVariant: "low", notify: "always", logLevel: "info" });

      for (const messageID of ["production-privacy-1", "production-privacy-2"]) {
        await hooks["chat.message"]?.(messageInput() as never, messageOutput(messageID) as never);
        await hooks["chat.params"]?.(paramsInput(messageID) as never, paramsOutput() as never);
      }

      expect(credentialResolutions).toBe(1);
      expect(historyCalls).toBe(2);
      expect(logs).toEqual([{
        body: {
          service: "typesafe-variant-router",
          level: "warn",
          message: "fallback:missing-api-key:openai/gpt-5",
        },
      }]);
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
      } as never, { fallbackVariant: "low" });

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
      } as never, { fallbackVariant: "high", notify: "off" });

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
    } as never, { fallbackVariant: "low", notify: "fallback", logLevel: "info" });

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
    expect(logs).toEqual([{
      body: {
        service: "typesafe-variant-router",
        level: "error",
        message: "fallback:client-error:openai/gpt-5",
      },
    }]);
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
            probabilities: { 0: 1, 1: 0 },
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
    } as never, { fallbackVariant: "low", notify: "fallback", logLevel: "info" });

    await hooks["chat.message"]?.(messageInput() as never, messageOutput("invalid-response-detail") as never);
    await hooks["chat.params"]?.(paramsInput("invalid-response-detail") as never, paramsOutput() as never);

    expect(logs).toEqual([{
      body: {
        service: "typesafe-variant-router",
        level: "warn",
        message: "fallback:invalid-response/type:openai/gpt-5",
      },
    }]);
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
    });
    const manual = formatAppliedVariantNotification({
      modelID: "openai/gpt-5.6-sol",
      variant: "high",
      status: "manual",
      reason: "selected",
    });
    expect(selected).toEqual({
      message: "Selected variant \"low\" for openai/gpt-5.6-sol.",
      variant: "info",
    });
    expect(manual).toEqual({
      message: "Using manual variant \"high\" for openai/gpt-5.6-sol.",
      variant: "info",
    });

    const fallbackCases = [
      ["missing-api-key", undefined, "the TypeSafe API key is unavailable"],
      ["invalid-response", "score", "TypeSafe response validation failed (score)"],
      ["timeout", undefined, "the TypeSafe request timed out"],
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
        });
      },
    };
    const hooks = createVariantRouterHooks({ fallbackVariant: "low" }, {
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
});
