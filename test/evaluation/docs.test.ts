import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { parseRouterConfig } from "../../src/config.ts";

const runbookUrl = new URL("../../docs/typesafe-variant-router.md", import.meta.url);
const designUrl = new URL("../../docs/plans/designs/001-typesafe-openai-variant-router.md", import.meta.url);
const runbook = readFileSync(runbookUrl, "utf8");
const historicalDesign = readFileSync(designUrl, "utf8");
const defaults = parseRouterConfig({ fallbackVariant: "medium" });

describe("TypeSafe variant router operations documentation", () => {
  test("documents the complete live configuration defaults and hard limits", () => {
    expect(runbook).toContain("`fallbackVariant` is required");
    expect(runbook).toContain(`\`${defaults.timeoutMs}\``);
    expect(runbook).toContain(`\`${defaults.manualVariantPolicy}\``);
    expect(runbook).toContain(`\`${defaults.context.mode}\``);
    expect(runbook).toContain(`\`${defaults.context.maxMessages}\``);
    expect(runbook).toContain(`\`${defaults.context.maxChars}\``);
    expect(runbook).toContain("maximum `30000`");
    expect(runbook).toContain("maximum `100`");
    expect(runbook).toContain("maximum `100000`");
    expect(runbook).toContain("Unknown fields are rejected");
    expect(runbook).toContain("`typesafe-first`");
    expect(runbook).toContain("`manual-first`");
    expect(runbook).toContain("fresh `timeoutMs` budget");
    expect(runbook).toContain("original turn-routing deadline");
    expect(runbook).toContain("User notifications");
    expect(runbook).toContain("`missing-api-key`");
    expect(runbook).toContain("`server-error`");
    expect(runbook).toContain("https://platform.openai.com/docs/guides/reasoning");
    expect(runbook).toContain("https://docs.typesafe.ai/primitives/score.md");
    expect(runbook).toContain("`argmax(probabilities)`");
    expect(runbook).toContain("If probabilities are exactly equal, the lower reasoning level wins");
    expect(runbook).toContain("Each legend value must structurally equal its submitted typed criterion, with JSON object key order ignored");
    expect(runbook).not.toContain("its text does not have to reproduce the submitted criteria byte for byte");
    expect(runbook).toContain("**`recent-messages`**: This is the default");
    expect(runbook).toContain("`## Gortex Session Orientation`");
    expect(runbook).toContain("Text before and after the block is preserved");
    expect(runbook).toContain("OpenCode 1.18.31");
    expect(runbook).toContain(`\`agentSelection.enabled\` | boolean | \`${defaults.agentSelection.enabled}\``);
    expect(runbook).toContain(`\`agentSelection.manualAgentPolicy\` | \`typesafe-first\` or \`manual-first\` | \`${defaults.agentSelection.manualAgentPolicy}\``);
    expect(runbook).toContain(`\`agentSelection.tuiSync.enabled\` | boolean | \`${defaults.agentSelection.tuiSync.enabled}\``);
    expect(runbook).toContain("`luna` | `openai/gpt-5.6-luna`");
    expect(runbook).toContain("`terra` | `openai/gpt-5.6-terra`");
    expect(runbook).toContain("`sol` | `openai/gpt-5.6-sol`");
    expect(runbook).toContain("`luna -> terra -> sol -> luna`");
    expect(runbook).toContain("built-in `build` and `plan`");
    expect(runbook).toContain("G1 current-turn tuple | **PASS**");
    expect(runbook).toContain("G2 exact primary ring | **PASS**");
    expect(runbook).toContain("G3 selector projection | **UNAVAILABLE**");
    expect(runbook).toContain("publishes no `agent.cycle.reverse` or other agent command");
    expect(runbook).toContain("`target_agent`");
    expect(runbook).toContain("`reasoning_for_luna`");
    expect(runbook).toContain("`reasoning_for_terra`");
    expect(runbook).toContain("`reasoning_for_sol`");
    expect(runbook).toContain("does not establish human intent");
    expect(runbook).toContain("No failure substitutes a different route, starts a second provider attempt, resends the prompt, or reverses the bound route");
    expect(runbook).toContain("`variant.cycle`");
    expect(runbook).toContain("already matches the target variant");
    expect(runbook).toContain("headless operation");
    expect(runbook).toContain("Work classified as `skipped` or bypassed completely");
    expect(runbook).toContain("`client.tui.publish`");
    expect(runbook).toContain("\"type\": \"tui.command.execute\"");
    expect(runbook).toContain("`/tui/execute-command`");
    expect(runbook).toContain("`commandAliases`");
    expect(runbook).toContain("known false-positive no-op");
    expect(runbook).toContain("The catalog used for provider routing remains the merge");
    expect(runbook).toContain("only names from the runtime model");
    expect(runbook).toContain("TUI synchronization is skipped");
    expect(runbook).toContain("receives a monotonic order during `chat.message`");
    expect(runbook).toContain("stale observation is ignored");
    expect(runbook).toContain("Only a publish response with `data: true` and no `error`");
    expect(runbook).toContain("no model identity, exact variant setter, or processing acknowledgment");
    expect(runbook).toContain("cannot guarantee race-free, exact TUI convergence");
    expect(runbook).toContain("provider options already set remain correct and independent");
    expect(runbook).not.toContain("confidenceThreshold");
    expect(runbook).not.toContain("dynamische Choice");
    expect(runbook).not.toContain("`low-confidence`");
  });

  test("marks the retired Choice design as a non-normative historical snapshot", () => {
    expect(historicalDesign).toContain("- Status: Superseded");
    expect(historicalDesign).toContain("[TypeSafe primary-agent and variant router](../../typesafe-variant-router.md)");
    expect(historicalDesign).not.toContain("../work/002-typesafe-score-routing.md");
    expect(historicalDesign).toContain("Historical design snapshot - not current normative guidance");
    expect(historicalDesign).toContain("`argmax(probabilities)` without a confidence threshold");
    expect(historicalDesign).toContain("the lower catalog position");
    expect(historicalDesign).toContain("fallbacks only for technical errors or invalid responses");
    expect(historicalDesign).toContain("best-effort synchronization of the variant shown in the OpenCode UI");
    expect(historicalDesign).toContain("All following sections describe only the former, superseded design");
    expect(historicalDesign).toContain("HTML/JSON snapshot intentionally remains unchanged");
  });

  test("states external transfer, minimization, forbidden data, and future gates", () => {
    for (const requiredStatement of [
      "sent to TypeSafe",
      "current prompt",
      "chat history",
      "`TYPESAFE_API_KEY`",
      "TypeSafe request state",
      "raw TypeSafe response",
      "error response body",
      "live evaluation against TypeSafe is not authorized",
      "npm publishing are also not authorized",
      "There is no confidence threshold",
      "task-fit agent profiles",
      "tool outputs, reasoning parts, attachments",
      "probability vectors and detailed unused Score answers",
      "provider option objects and error response bodies",
      "raw effective prompts, permissions, tool definitions, or skill definitions",
    ]) {
      expect(runbook).toContain(requiredStatement);
    }
    for (const command of [
      "npm test",
      "npm run test:contract",
      "npm run test:unit",
      "npm run test:integration",
      "npm run test:evaluation",
      "npm run test:docs",
      "npm run test:privacy",
      "npm run typecheck",
    ]) {
      expect(runbook).toContain(command);
    }
  });
});
