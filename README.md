# OpenCode TypeSafe Variant Router

This repository contains a local OpenCode plugin that uses TypeSafe to route each eligible turn through an exact model-bound primary agent and a validated reasoning variant. The default route is capability-gated and fail-closed; the previous variant-only router remains available through an explicit migration setting.

## Primary-agent routing (default)

The only primary agents are:

| Agent | Fixed model | Task-fit criterion |
|---|---|---|
| `luna` | `openai/gpt-5.6-luna` | Boilerplate, extraction, formatting, and simple objectively verifiable helper tasks. |
| `terra` | `openai/gpt-5.6-terra` | Clearly specified local code changes and bounded, structured subtasks. |
| `sol` | `openai/gpt-5.6-sol` | Normal backend/frontend/mobile implementation, medium refactorings, reviews, and stronger autonomous repository work. |

Built-in `build` and `plan` are disabled. OpenCode 1.18.31 exposes the visible primary order as `luna`, `sol`, `terra`; the public `agent.cycle.reverse` command therefore follows the configured logical ring `luna -> terra -> sol -> luna` and wraps. The three agents have equal project-owned prompt, permission, tool, skill, temperature, and top-p behavior; only identity, description, and fixed model differ.

`agentSelection.enabled` defaults to `true`, `agentSelection.manualAgentPolicy` defaults to `typesafe-first`, and `agentSelection.tuiSync.enabled` defaults to `true`. This is a breaking default. To retain the previous variant-only mode, configure:

```jsonc
{
  "agentSelection": {
    "enabled": false
  }
}
```

An eligible agent-routed turn sends exactly one TypeSafe request with four independent questions: `target_agent`, `reasoning_for_luna`, `reasoning_for_terra`, and `reasoning_for_sol`. Deterministic code validates the full response, uses the tie order `luna`, `terra`, `sol`, and consumes the selected agent's model-conditioned Score. `typesafe-first` may choose any ring agent. Under a conservative `manual-first` lock, the same four questions are sent, `target_agent` is ignored, and only the locked agent's Score is consumed; observable unexplained transitions create the lock, without claiming human intent.

G1 is **PASS** and G2 is **PASS** for OpenCode 1.18.31. G3 is **UNAVAILABLE** because the targetless publication scope and timeout delivery cannot be established authoritatively. Current-turn agent routing remains active, but unavailable synchronization emits no `agent.cycle.reverse` or other agent command; it emits only a sanitized `agent-sync-unavailable` diagnostic when enabled.

All validation and deadline checks complete before the synchronous agent/model/variant assignments. Any precommit failure leaves all three message fields unchanged and does not fall back to variant-only routing. A `chat.params` tuple or fingerprint mismatch aborts before provider invocation. Later host or provider failures do not trigger substitution, a second TypeSafe request, another provider attempt, prompt resend, or rollback.

The bounded current prompt and, in `recent-messages` mode, bounded chronological user/assistant text history are disclosed to TypeSafe together with task-fit agent profiles, fixed model premises, and validated runtime catalog names/descriptions. Source agent/model and topology metadata remain local and are not part of the TypeSafe judgment state. Credentials, credential metadata, tool outputs, reasoning parts, attachments, provider option objects, raw effective prompts/permissions/tool definitions, raw TypeSafe requests/responses, probability vectors, unused Score details, and error bodies are forbidden from logs and retained routing or synchronization state.

## Variant-only compatibility

When `agentSelection.enabled=false`, the router uses TypeSafe [`Score`](https://docs.typesafe.ai/primitives/score.md) over the validated variant catalog in its runtime order. Under the contract, `chat.message` provides only the provider and model ID; the complete runtime catalog is validated later from the full model supplied to `chat.params`, then passed to the prepared routing operation for the same message turn. The built-in profiles follow the official OpenAI semantics for [`none`, `low`, `medium`, `high`, `xhigh`, and `max`](https://platform.openai.com/docs/guides/reasoning), ranging from no or efficient reasoning work to the greatest available reasoning depth. A valid Score response always selects the variant with the highest probability. On an exact tie, the lower reasoning level that appears earlier in the catalog wins. There is no `confidenceThreshold` or low-confidence fallback. When present, confidence remains diagnostic metadata only.

`recent-messages` remains the default context mode. Complete, recognized `## Gortex Session Orientation` blocks are removed from the current prompt and from historical user and assistant text; text before and after each block is preserved. A prompt containing exactly this block remains a routable turn: its sanitized current text is empty, permitted history may still provide context, and the variant actually applied produces exactly one notification when required by `notify`. In explicit variant-only mode, technical errors and invalid responses continue to use the validated deterministic fallback. Prompts, history, credentials, raw responses, and error bodies are neither logged nor persisted. Notifications are created only after application in `chat.params`, name the applied variant, and are not duplicated from early selection or diagnostic events; identical safe diagnostic logs remain deduplicated. Repeated or parallel `chat.params` calls for the same turn use the same bounded result and apply identical options, while notification and TUI synchronization are triggered exactly once. Session deletion, plugin disposal, and active TTL expiration timers cancel prepared history and TypeSafe work on a best-effort basis.

In explicit variant-only mode, after the actually selected, manually retained, or fallback reasoning variant has been applied to the model options, the plugin makes a best-effort attempt to synchronize the visible TUI variant in OpenCode 1.18.31 through `client.tui.publish`. It directly publishes the event `{ type: "tui.command.execute", properties: { command: "variant.cycle" } }`. The legacy `executeCommand` endpoint is deliberately not used: its alias table in 1.18.31 does not contain `variant.cycle`, so the endpoint can return `data: true` despite an ineffective `undefined` dispatch. Provider routing may still extend the runtime catalog with configured variants, but the plugin uses only runtime variants for TUI cycles. A configured target without a runtime position is not synchronized in the TUI. If the variant already matches, synchronization is a no-op. Turn order is assigned during `chat.message`, preventing older turns that complete late from overwriting a newer TUI projection. Before publishing, stale work is discarded in favor of the latest observation. Publish responses with an `error`, missing or incorrect `data`, and exceptions count as failures and do not advance speculative variant state. If observed model or session ownership changes while a command is in flight, the ambiguous state is invalidated; synchronization can be attempted safely again only after a new authoritative observation. An unavailable TUI publisher in headless operation or a publishing failure affects neither provider routing nor the applied model options.

The OpenCode API provides only a global `variant.cycle`: the command affects the model visible when the TUI processes it and provides no model identity, exact setter, or processing acknowledgment. A model change after the final preflight check therefore cannot be prevented without races or corrected exactly. Consequently, the visible display remains best effort across model and session changes; provider routing and the applied model options remain independently correct.

## Enable globally in OpenCode

The router is registered once as a development installation in `~/.config/opencode/opencode.jsonc`, using an absolute `file://` path to [`.opencode/plugins/typesafe-variant-router/index.ts`](.opencode/plugins/typesafe-variant-router/index.ts). The same plugin configuration therefore applies to every OpenCode project. [`.opencode/opencode.jsonc`](.opencode/opencode.jsonc) deliberately has no second router entry, so this repository does not load the plugin twice. If the checkout path changes, the global file path must be updated. Configuration or plugin changes take effect only after OpenCode restarts.

The global installation uses a total budget of `5000 ms`. Successful selection, a manual variant, and fallback use different wording. For example, a successful message is `Selected variant "low" for openai/gpt-5.6-sol.`; fallback messages instead include a readable technical reason. Internal combinations such as `selected:selected` are not displayed.

## Set up the Linux/KDE prototype

When OpenCode starts, the prototype first reads `TYPESAFE_API_KEY` from the process environment. If the variable is missing, it queries the Linux Secret Service once with `secret-tool`. On KDE, this requires an active Secret Service integration for KWallet.

Depending on the distribution, `secret-tool` is provided by a package such as `libsecret-tools`. Store the key once under the attributes expected by the plugin:

```sh
secret-tool store --label="TypeSafe API Key" service typesafe credential api-key
```

The command requests the secret value interactively; the key must not appear in the command line, configuration, or a file. Then restart OpenCode. Internally, the plugin uses exactly this lookup:

```sh
secret-tool lookup service typesafe credential api-key
```

The lookup runs without a shell, with a five-second timeout and bounded output. The key, stdout, stderr, and error details are not logged. If `secret-tool`, the Secret Service, or the entry is unavailable, OpenCode starts normally and the router uses its existing deterministic fallback.

This credential path is deliberately specific to Linux/KDE in the prototype. See [`docs/typesafe-variant-router.md`](docs/typesafe-variant-router.md) for complete configuration, privacy boundaries, and operating guidance.
