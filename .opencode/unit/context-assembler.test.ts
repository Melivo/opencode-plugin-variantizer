import { describe, expect, test } from "bun:test";

import { assembleContext, stripGortexSessionOrientation } from "../plugins/typesafe-variant-router/context-assembler.ts";

describe("context assembler", () => {
  test("keeps only chronological user/assistant text and excludes sensitive non-text parts", () => {
    const state = assembleContext({
      currentPrompt: "current question",
      modelID: "gpt-5",
      messages: [
        { role: "system", parts: [{ type: "text", text: "SYSTEM_SECRET" }] },
        { role: "user", parts: [{ type: "text", text: "first" }, { type: "file", url: "ATTACHMENT_SECRET" }] },
        { role: "assistant", parts: [{ type: "reasoning", text: "REASONING_SECRET" }, { type: "text", text: "second" }] },
        { role: "tool", parts: [{ type: "text", text: "TOOL_SECRET" }] },
        { role: "user", parts: [{ type: "text", text: "third" }], metadata: "METADATA_SECRET" },
      ],
      policy: { mode: "recent-messages", maxMessages: 3, maxChars: 100 },
    });

    expect(state).toEqual({
      currentPrompt: "current question",
      recentMessages: [
        { role: "user", text: "first" },
        { role: "assistant", text: "second" },
        { role: "user", text: "third" },
      ],
      model: "gpt-5",
    });
    expect(JSON.stringify(state)).not.toMatch(/SYSTEM_SECRET|ATTACHMENT_SECRET|REASONING_SECRET|TOOL_SECRET|METADATA_SECRET/);
  });

  test("enforces maxMessages using the most recent messages while preserving chronology", () => {
    const state = assembleContext({
      currentPrompt: "now",
      modelID: "gpt-5",
      messages: [
        { role: "user", parts: [{ type: "text", text: "one" }] },
        { role: "assistant", parts: [{ type: "text", text: "two" }] },
        { role: "user", parts: [{ type: "text", text: "three" }] },
      ],
      policy: { mode: "recent-messages", maxMessages: 2, maxChars: 100 },
    });

    expect(state.recentMessages).toEqual([
      { role: "assistant", text: "two" },
      { role: "user", text: "three" },
    ]);
  });

  test("prioritizes and truncates the current prompt within the hard character budget", () => {
    const state = assembleContext({
      currentPrompt: "12345678",
      modelID: "gpt-5",
      messages: [
        { role: "assistant", parts: [{ type: "text", text: "abcdef" }] },
        { role: "user", parts: [{ type: "text", text: "uvwxyz" }] },
      ],
      policy: { mode: "recent-messages", maxMessages: 5, maxChars: 10 },
    });

    expect(state.currentPrompt).toBe("12345678");
    expect(state.recentMessages).toEqual([{ role: "user", text: "uv" }]);
    expect(state.currentPrompt.length + state.recentMessages.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(10);
  });

  test("prompt-only omits all history and still enforces maxChars", () => {
    const state = assembleContext({
      currentPrompt: "123456789",
      modelID: "gpt-5",
      messages: [{ role: "assistant", parts: [{ type: "text", text: "HISTORY_SECRET" }] }],
      policy: { mode: "prompt-only", maxMessages: 4, maxChars: 5 },
    });

    expect(state).toEqual({ currentPrompt: "12345", recentMessages: [], model: "gpt-5" });
  });
  test("removes repeated complete Gortex orientation blocks at boundaries without changing other Markdown or roles", () => {
    const orientation = "## Gortex Session Orientation\n- injected machine context\n### Nested detail\nignored";
    const state = assembleContext({
      currentPrompt: `${orientation}\n## User Request\nkeep current\n${orientation}`,
      modelID: "gpt-5",
      messages: [
        { role: "user", parts: [{ type: "text", text: `before\n${orientation}\n## Genuine\nafter` }] },
        { role: "assistant", parts: [{ type: "text", text: orientation }] },
        { role: "user", parts: [{ type: "text", text: "# Gortex Session Orientation\nnonmatching Markdown" }] },
      ],
      policy: { mode: "recent-messages", maxMessages: 5, maxChars: 1_000 },
    });

    expect(state).toEqual({
      currentPrompt: "## User Request\nkeep current\n",
      recentMessages: [
        { role: "user", text: "before\n## Genuine\nafter" },
        { role: "user", text: "# Gortex Session Orientation\nnonmatching Markdown" },
      ],
      model: "gpt-5",
    });
  });

  test("strips repeated exact markers at boundaries while preserving prefixed and suffixed near misses", () => {
    const source = [
      "prefix ## Gortex Session Orientation",
      "## Gortex Session Orientation user suffix",
      "keep suffixed heading content",
      "## Gortex Session Orientation   ",
      "remove first block",
      "## User Section",
      "keep middle",
      "## Gortex Session Orientation\t",
      "remove final block",
    ].join("\n");

    expect(stripGortexSessionOrientation(source)).toBe([
      "prefix ## Gortex Session Orientation",
      "## Gortex Session Orientation user suffix",
      "keep suffixed heading content",
      "## User Section",
      "keep middle",
      "",
    ].join("\n"));
  });

  test("handles orientation-only current prompts and messages without losing available bounded history", () => {
    const state = assembleContext({
      currentPrompt: "## Gortex Session Orientation\nonly injected text",
      modelID: "gpt-5",
      messages: [
        { role: "assistant", parts: [{ type: "text", text: "## Gortex Session Orientation\ninjected" }] },
        { role: "user", parts: [{ type: "text", text: "genuine" }] },
      ],
      policy: { mode: "recent-messages", maxMessages: 2, maxChars: 7 },
    });

    expect(state).toEqual({
      currentPrompt: "",
      recentMessages: [{ role: "user", text: "genuine" }],
      model: "gpt-5",
    });
  });
});
