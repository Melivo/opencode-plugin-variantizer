# Run the TypeSafe primary-agent and variant router locally

> **Privacy notice:** Every eligible agent-routed `openai` user prompt is sent to TypeSafe. The request also contains task-fit agent profiles, fixed model premises, and validated runtime reasoning-catalog names and descriptions. Source agent/model and topology metadata remain local and are not part of the TypeSafe judgment state. The configuration default is `context.mode=recent-messages`, which may additionally disclose a strictly bounded chronological history of user and assistant text. Set `context.mode=prompt-only` to omit history. Disable the plugin or remove the API key to avoid sending the current prompt.

## Global activation

To activate the router in every OpenCode project, register it once in `~/.config/opencode/opencode.jsonc`. This development installation points to the committed plugin source in this checkout:

```jsonc
[
  "file:///home/visimeos/Projects/opencode-plugin-variantizer/.opencode/plugins/typesafe-variant-router/index.ts",
  {
    "fallbackVariant": "medium",
    "timeoutMs": 5000,
    "notify": "always",
    "agentSelection": {
      "enabled": true,
      "manualAgentPolicy": "typesafe-first",
      "agents": {
        "luna": "openai/gpt-5.6-luna",
        "terra": "openai/gpt-5.6-terra",
        "sol": "openai/gpt-5.6-sol"
      },
      "ring": ["luna", "terra", "sol"],
      "tuiSync": { "enabled": true }
    }
  }
]
```

The project-local [`.opencode/opencode.jsonc`](../.opencode/opencode.jsonc) does not register the router again, so this repository loads it exactly once, just like other projects. If the checkout is moved or deleted, update the absolute global file path. `fallbackVariant` is required. When the plugin starts, a non-empty `TYPESAFE_API_KEY` process variable takes precedence. If it is missing, the Linux/KDE prototype performs the following Secret Service lookup once and without a shell:

```sh
secret-tool lookup service typesafe credential api-key
```

Depending on the distribution, `secret-tool` is provided by a package such as `libsecret-tools`. On KDE, KWallet must provide an active Secret Service integration. Store the key once and interactively under the fixed attribute schema:

```sh
secret-tool store --label="TypeSafe API Key" service typesafe credential api-key
```

Enter the secret value at the interactive prompt, not as a command-line argument. The lookup has a five-second timeout and an output limit of 8192 bytes. The key, stdout, stderr, and error details are not logged or persisted. If `secret-tool` is not installed, the Secret Service is unavailable, or the entry does not exist, no TypeSafe client is created. OpenCode starts normally, and a demonstrably valid fallback can still be applied.

A process variable remains available for CI or a single process, for example:

```sh
TYPESAFE_API_KEY="..." opencode
```

The key must not appear in `opencode.jsonc`, `.env` files, logs, test fixtures, or documentation. The plugin processes only real text user turns with `providerID=openai`. Other providers, synthetic messages, and non-text turns remain unchanged and do not trigger a TypeSafe request. The automatic Secret Service path is deliberately specific to Linux/KDE in this prototype.

## Complete configuration contract

Unknown fields are rejected. All variant names must be non-empty and at most 128 characters long; model keys may be at most 256 characters long.

| Field | Accepted value | Default / effect |
|---|---|---|
| `enabled` | boolean | `true`; complete bypass when `false` |
| `fallbackVariant` | non-empty string | **no default; required**; must be an active, verified reasoning variant in every explicitly configured model |
| `timeoutMs` | positive integer, maximum `30000` | `1500`; bounded per-invocation budget in milliseconds |
| `manualVariantPolicy` | `typesafe-first` or `manual-first` | `typesafe-first`; used by variant-only mode |
| `agentSelection.enabled` | boolean | `true`; enables primary-agent routing; `false` preserves variant-only mode |
| `agentSelection.manualAgentPolicy` | `typesafe-first` or `manual-first` | `typesafe-first` |
| `agentSelection.agents.luna` | exact model ID | `openai/gpt-5.6-luna` |
| `agentSelection.agents.terra` | exact model ID | `openai/gpt-5.6-terra` |
| `agentSelection.agents.sol` | exact model ID | `openai/gpt-5.6-sol` |
| `agentSelection.ring` | exact tuple | `["luna", "terra", "sol"]` |
| `agentSelection.tuiSync.enabled` | boolean | `true`; capability-gated and currently unavailable on the pinned host |
| `context.mode` | `prompt-only` or `recent-messages` | `recent-messages` |
| `context.maxMessages` | positive integer, maximum `100` | `6` |
| `context.maxChars` | positive integer, maximum `100000` | `12000`; shared hard character budget for the current prompt and permitted history |
| `variantsByModel` | map `provider/model -> variant -> definition` | `{}` |
| `variantDescriptions` | map `variant -> String` (1 to 4000 characters) | `{}`; known profiles receive built-in criteria |
| `notify` | `off`, `fallback`, or `always` | `fallback`; `off` displays nothing, `fallback` displays only fallbacks that were actually applied, and `always` also displays applied TypeSafe and manual selections; every message names the applied variant |
| `logLevel` | `error`, `warn`, `info`, or `debug` | `warn`; controls production logs. At `debug`, the router additionally records TypeSafe responses and the correlated agent/variant decision events locally; the request payload and API key are never logged. The TypeSafe SDK logger remains fixed at `off`. |

### Breaking migration and exact primary topology

`agentSelection.enabled=true` is an intentional breaking default. Existing installations that require the previous variant-only behavior must explicitly set:

```jsonc
{
  "agentSelection": {
    "enabled": false
  }
}
```

The plugin does not rewrite existing user configuration. When enabled, the static schema requires the exact IDs, bindings, and ring shown above; unknown fields, alternate bindings, reordered or duplicate ring entries, and extra candidates are startup configuration errors rather than silent downgrades.

| Agent | Fixed model | TypeSafe task-fit criterion |
|---|---|---|
| `luna` | `openai/gpt-5.6-luna` | Boilerplate, extraction, formatting, and simple helper tasks with objective verification. Use only for narrow, low-risk, repeatable work with clear checks. |
| `terra` | `openai/gpt-5.6-terra` | Clearly specified local code changes and structured subtasks with bounded scope and clear acceptance criteria; not difficult architecture or broad ambiguous changes. |
| `sol` | `openai/gpt-5.6-sol` | Normal backend/frontend/mobile implementation, medium refactorings, code review, cross-file work, behavior preservation, integration, lifecycle/state complexity, and stronger autonomous repository work. |

The OpenCode host configuration disables built-in `build` and `plan`, leaving exactly the build-capable `luna`, `terra`, and `sol` primaries. Their project-owned effective behavior is equal except for name, description, and model.

OpenCode 1.18.31 lists the visible primaries in the order `luna`, `sol`, `terra`. The public `agent.cycle.reverse` command therefore traverses the logical reverse-cycle ring `luna -> terra -> sol -> luna`. Configuration order alone is not treated as runtime evidence.

### Capability outcomes

| Gate | Outcome | Operational effect |
|---|---|---|
| G1 current-turn tuple | **PASS** | Source agent/model authority, complete pre-binding tuple propagation, composite hook correlation, provider abort on mismatch, and no resend are proven. |
| G2 exact primary ring | **PASS** | Disabled built-ins, exact primary membership and bindings, behavior equality, secondary exclusion, and reverse-cycle order/wrap are proven. |
| G3 selector projection | **UNAVAILABLE** | Current-turn routing continues, but selector synchronization publishes no `agent.cycle.reverse` or other agent command. |

G3 is unavailable because a targetless publish payload has no session identifier, cross-session selector scope is not authoritatively observable, and timeout delivery state is not authoritatively observable. The production unavailable branch has no command publisher or scheduling API. With `agentSelection.tuiSync.enabled=true`, it retains no session or turn entries and may emit one sanitized `agent-sync-unavailable` diagnostic containing only bounded reason codes. Publication success is not used as selector confirmation.

### Mixed TypeSafe request and manual-agent policies

Each eligible agent-routed turn makes one `systemOne` request containing exactly four independent questions:

1. `target_agent`: Choice over exactly `luna`, `terra`, and `sol`.
2. `reasoning_for_luna`: Score over Luna's validated runtime catalog under `openai/gpt-5.6-luna`.
3. `reasoning_for_terra`: Score over Terra's validated runtime catalog under `openai/gpt-5.6-terra`.
4. `reasoning_for_sol`: Score over Sol's validated runtime catalog under `openai/gpt-5.6-sol`.

`target_agent` is judged solely from the current task context and these task-fit criteria. The source or currently selected agent, topology generation, and behavior fingerprints are intentionally absent from the TypeSafe state; no balancing, rotation, or stickiness preference participates in model choice. Source identity remains local for eligibility validation, unchanged-message fallback, correlation, and `manual-first` locking.

The response must contain exactly these IDs and types, exact candidate/legend keys, finite values in range, and probabilities summing within the implementation tolerance. Agent ties use `luna`, `terra`, `sol`; variant ties use runtime catalog order. Deterministic code consumes only the selected agent's Score, although all four answers are validated. Detailed unused Score answers are not logged or retained.

- **`typesafe-first`**: every eligible turn may route to any ring agent according only to task fit. The source remains local fallback and validation input, is not disclosed in the TypeSafe judgment state, and does not create a persistent lock.
- **`manual-first`**: the first eligible source establishes a baseline. A transition explained by the active plugin path does not lock; unchanged source while synchronization is pending means failed or unobserved synchronization. An unexplained source transition creates a session lock on agent and model, not variant. While locked, the request still contains all four questions, deterministic code ignores `target_agent`, and only the locked agent's Score is consumed. Session cleanup or explicit reset clears the lock. This policy uses operational transition rules and does not establish human intent.

### Failure and lifecycle boundaries

The initial `chat.message` route uses one absolute `timeoutMs` deadline for bounded context preparation, topology/catalog acquisition, TypeSafe work, final validation, and the immediate precommit check. Each later `chat.params` call starts a fresh `timeoutMs` budget for topology revalidation because the original turn-routing deadline is necessarily expired during long tool cycles; that fresh budget applies only to the current validation and never authorizes rerouting. Capacity is reserved before routing; in-flight committed-route records are not evicted. Exact unexpired invalidation tombstones are never evicted under capacity pressure. If their bounded map fills, one bounded overflow marker makes ambiguous missing identities fail closed until the committed-route TTL elapses without consuming or evicting pending route entries. Session deletion, TTL cleanup, cancellation, and plugin disposal clear or abort their bounded work, and late completion cannot mutate a later turn.

After complete validation, `chat.message` synchronously assigns `output.message.agent` and the complete `output.message.model` object, including `model.variant`, before model binding. This is a sequence of validated assignments, not a transaction guarantee. Credential, context, timeout, cancellation, TypeSafe, topology, catalog, response, fingerprint, storage, or validation failure before those assignments leaves all three fields unchanged. Agent-selection mode does not invoke variant-only fallback afterward and makes no second TypeSafe request.

At `chat.params`, the same `(sessionID, messageID)` must match the committed agent/model/variant and topology, behavior, catalog, and options fingerprints. The active route and canonical input agent/model/variant tuple are checked both before and immediately after awaited topology acquisition, before provider options can change. A mismatch aborts before provider invocation; repeated valid application is idempotent. Later host, registry, option, resolution, or provider failures are reported as late failures. No failure substitutes a different route, starts a second provider attempt, resends the prompt, or reverses the bound route.

A definition in `variantsByModel` has this strict form:

```json
{
  "reasoning": true,
  "disabled": false,
  "options": {
    "reasoningEffort": "medium"
  }
}
```

`reasoning` is required and must be `true` for a selectable variant. `disabled` is optional. `options` must be a non-empty, safely cloneable JSON object. The plugin invents neither variants nor provider options: it accepts only defensively validated runtime options or explicitly configured option objects. Runtime definitions take precedence on name collisions. Model keys use the form `openai/<modelID>`.

## Variant-only TypeSafe Score selection and catalog order

The router supplies TypeSafe [`Score`](https://docs.typesafe.ai/primitives/score.md) with the revalidated variant catalog as an ordered criteria list. Runtime order is preserved; explicitly configured variants that are not already present are placed deterministically after it. The built-in profiles follow the official OpenAI semantics for [`none`, `low`, `medium`, `high`, `xhigh`, and `max`](https://platform.openai.com/docs/guides/reasoning):

- `none`: no additional reasoning work for direct, latency-sensitive tasks;
- `low`: efficient reasoning for simple planning, search, and tool use;
- `medium`: balanced reasoning for substantial work with several coordinated steps;
- `high`: deeper reasoning for difficult debugging, planning, and complex tradeoffs;
- `xhigh`: very deep reasoning for especially demanding, long-running, or high-risk tasks;
- `max`: the greatest available reasoning depth for exceptional cases of the highest complexity.

A valid response always selects `argmax(probabilities)`. If probabilities are exactly equal, the lower reasoning level wins, meaning the earlier entry in the catalog. There is no confidence threshold or low-confidence fallback. `confidence` may remain in the normalized decision as safe metadata, but it does not affect selection. `score` must be finite and within `0..(criteria.length-1)`, but it is not recalculated from the probabilities: TypeSafe may round `score` and `probabilities` independently, and selection uses only the validated probabilities. The legend must contain exactly the catalog's index keys. Each legend value must structurally equal its submitted typed criterion, with JSON object key order ignored.

## Priority, context, and limits

- **`typesafe-first`**: A catalog-valid TypeSafe Score selection may replace a manually set variant. Only technical errors or an invalid response lead to the valid fallback.
- **`manual-first`**: An explicit manual variant that is valid in the current catalog ends routing before any TypeSafe request. Without a valid manual variant, the normal TypeSafe path applies.
- **`prompt-only`**: Sends the current prompt and model ID, but no history list.
- **`recent-messages`**: This is the default and permits only chronological user and assistant text messages from the session history. System prompts, reasoning parts, tools, attachments, and metadata are excluded.
- Complete, recognized sections beginning with `## Gortex Session Orientation` and ending at the next level-2 heading or the end of the text are removed from the current prompt and from every historical user and assistant text. Text before and after the block is preserved; incomplete or differently marked sections are not removed heuristically. A turn containing exactly such a block deliberately remains routable: `currentPrompt` becomes empty, permitted history may still provide context, and an actually applied selection or fallback produces a normal notification.
- `maxChars` is applied first to the sanitized current prompt and then to the newest permitted messages, which are also sanitized. `maxMessages` additionally limits their count.

When `agentSelection.enabled=false`, under the variant-only OpenCode hook contract, `chat.message` receives only `providerID` and `modelID`. It filters the current user text, starts safe history preparation when needed, and stores bounded routing work that has not yet started. Only the correlated `chat.params` supplies the full model. The plugin validates the runtime variant catalog from that model and then starts selection with the catalog. Users therefore do not need to duplicate OpenCode's model variants in `variantsByModel`; that configuration remains only an optional explicit extension.

`chat.message` sets `deadlineAt = start + timeoutMs` once. History preparation, waiting for the TypeSafe SDK, and `chat.params` share this single absolute budget; it is not restarted for each phase. The remaining time is recalculated immediately before the SDK request, so no TypeSafe request starts after the deadline. If the deadline expires, `chat.params` is missing, or the model differs, the prepared classification is not started. Late responses are not transferred to later turns.

The store is limited to 256 entries per process and uses a TTL of at least 30 seconds, or twice `timeoutMs` if that is greater. An active timer that does not keep the process alive removes and cancels every entry even if no subsequent store operation occurs; capacity eviction, session deletion, and plugin disposal do the same and remove their timers. Until then, repeated or parallel `chat.params` calls access the same in-progress or completed decision non-destructively. Provider options are applied idempotently on every call; bounded claim state prevents duplicate diagnostic, notification, and TUI side effects for a message ID.

## Visible OpenCode TUI variant in variant-only mode

When `agentSelection.enabled=false`, after the actually selected, retained under `manual-first`, or valid fallback variant has been applied to `output.options`, the plugin makes a best-effort attempt to synchronize the visible TUI variant in OpenCode 1.18.31. It uses the `client.tui.publish` SDK endpoint and publishes exactly this direct TUI command event:

```json
{
  "type": "tui.command.execute",
  "properties": { "command": "variant.cycle" }
}
```

The legacy `/tui/execute-command` endpoint and `client.tui.executeCommand` are unsuitable for this purpose: OpenCode 1.18.31 maps their payload through an old `commandAliases` table that does not contain `variant.cycle`. The unknown name is therefore dispatched as `undefined`, while the endpoint may still report a successful `true`. For this reason, the plugin does not fall back to this known false-positive no-op. The catalog used for provider routing remains the merge of runtime and explicitly configured variants. In contrast, the queue uses only names from the runtime model for the visible TUI because only those names have real `variant.cycle` positions. If an applied configured variant is absent from the runtime catalog, its provider options remain effective and TUI synchronization is skipped. If the observed visible variant already matches the target variant, synchronization is a no-op. Work classified as `skipped` or bypassed completely is discarded and not synchronized.

Every prepared turn receives a monotonic order during `chat.message`, which is retained through TUI observation and the synchronization request. If an older turn completes after a newer one, its stale observation is ignored. The queue serializes commands, gives synchronously arriving work a microtask handoff, and discards stale targets in favor of the latest observation before publishing. Only a publish response with `data: true` and no `error` counts as a successful cycle. `{ error }`, `data: false`, missing `data`, and exceptions do not advance speculative variant state. If a newer model or session observation arrives while a command is in flight, the recipient of the global command becomes ambiguous. The queue then invalidates its projections and does not treat queued work based on them as synchronized. A later, new authoritative observation and request can safely retry synchronization. If no TUI publisher is available in headless operation or publishing fails, provider routing and the applied model options remain unaffected.

These safeguards eliminate avoidable stale cycles but cannot guarantee race-free, exact TUI convergence across model or session changes. OpenCode 1.18.31 provides only the global `variant.cycle`: it addresses the model visible when the TUI processes the command and contains no model identity, exact variant setter, or processing acknowledgment. A visibility change after the final preflight check may therefore go undetected; without a subsequent authoritative observation, safe compensation is impossible. The visible TUI display remains best effort during this narrow handoff window, while the provider options already set remain correct and independent of it.

## Fallbacks, diagnostics, and notifications

A Score response is accepted only if its probabilities, score, legend, and confidence are complete and formally valid, and the selected variant exists in the revalidated current catalog. Every valid response uses argmax selection without a confidence gate. After a technical or invalid response, the configured fallback variant is applied only if it is also currently valid; otherwise, OpenCode's options remain unchanged. The field-by-field merge preserves unrelated `output.options`.

Safe diagnostic codes are:

- `missing-api-key`
- `invalid-response`
- `pre-request-timeout` when the shared budget expires before the TypeSafe request begins
- `request-timeout` when the budget expires during the TypeSafe request or the server returns HTTP 408
- `network-error`
- `auth-error` for HTTP 401/403
- `rate-limited` for HTTP 429
- `server-error` for HTTP 5xx
- `client-error` for other errors

Diagnostics contain only `code`, `modelID`, `status` (`fallback` or `skipped`), and, for `invalid-response`, an optional safe `detail`. The details `request`, `type`, `probabilities`, `score`, `confidence`, `legend`, and `variant` name only the violated invariant group and contain no response values. The router invokes the injectable `onDiagnostic` callback for every technical or invalid routing decision; identical safe diagnostic logs are deduplicated by model, code, detail, and status. User notifications, by contrast, come only from `onAppliedVariant` after `chat.params` has actually applied the validated options. The callback contains only `modelID`, the applied `variant`, `status` (`selected`, `manual`, or `fallback`), `reason`, the validated `confidence` for TypeSafe selections, and optionally the same safe `detail`. Agent routes use the `target_agent` choice confidence; variant-only routes use the selected Score confidence. With `notify=always`, every TypeSafe selection message includes the rounded routing-confidence percentage and appends `Low routing confidence.` below 60%; manual and fallback decisions do not fabricate a confidence value. `notify=off` suppresses all messages, `fallback` reports only applied fallbacks, and `always` additionally reports TypeSafe and manual selections. Each correlated routable turn with an applied variant therefore produces exactly one message. A deadline fallback before the TypeSafe request begins is classified as `pre-request-timeout`; a timeout during an active request or reported by the SDK is classified as `request-timeout`; other technical router fallbacks retain their reason. Successful selection, a manual variant, and fallback have separate readable text without internal duplications such as `selected:selected`. For example, a field-related error appears as `Using fallback variant "medium" ... because TypeSafe response validation failed (score).` Missing store entries and entries associated with a different model still receive only current fallback options, but without a safely correlated routable prompt they produce no message. No message contains the prompt, history, credentials, error content, or other raw data.

## Privacy and data minimization

Agent-routing requests disclose only the sanitized and truncated current prompt; optional user/assistant text history bounded by mode, role, block filtering, `maxMessages`, and `maxChars`; task-fit agent profiles and fixed model premises; and validated ordered runtime catalog names/descriptions. Source agent/model and topology metadata remain local. Variant-only requests disclose the corresponding prompt/history, model ID, and validated catalog criteria. This is bounded disclosure, not secret redaction. The SDK logger is disabled.

The following content must **neither be logged nor retained in decision, route, diagnostic, notification, fingerprint, synchronization, or evaluation output**:

- current prompt or chat history text;
- `TYPESAFE_API_KEY`, other credentials, or credential metadata;
- tool outputs, reasoning parts, attachments, and unrelated metadata;
- raw TypeSafe request state or raw TypeSafe response;
- probability vectors and detailed unused Score answers;
- provider option objects and error response bodies; each error response body is forbidden;
- raw effective prompts, permissions, tool definitions, or skill definitions used to derive fingerprints.

Allowed bounded operational metadata includes agent/model IDs, variant names, sanitized reason codes, non-reversible fingerprints, generation and turn numbers, uncertainty flags, and latency measurements.

The observable store metadata surface retains only the message, session, and model ID, `turnOrder`, and deadline and TTL timestamps. Timers, abort controllers, side-effect claims, the prompt, and history are not accessible through `inspect()` or logs. The internal routing closure, bounded per message ID, must temporarily retain the prompt and history promise until completion, cancellation, or active TTL removal. Session deletion and disposal abort it immediately. The same per-message AbortSignal is passed both to the TypeSafe SDK and to OpenCode's `session.messages`. Session deletion, disposal, and active expiration cleanup therefore also abort the production history request. If a transport nevertheless ignores the abort, the plugin safely stops waiting locally and discards any response that arrives later. A variant-only normalized decision may contain status, variant name, reason code, timestamp, confidence, and validated probabilities, but no credential, request state, raw response, or error body. Agent-routing retained state omits probability vectors and unused Score details.

## Deterministic offline evaluation

The non-sensitive corpus is stored in [`test/evaluation/corpus.json`](../test/evaluation/corpus.json). It contains at least two labeled examples each for `simple`, `medium`, `complex`, `ambiguous`, and `adversarial`. The prompts are synthetic and contain no real user, project, or credential data.

The [`test/evaluation/evaluation-harness.ts`](../test/evaluation/evaluation-harness.ts) harness uses only an injected fixture client. It evaluates the following deterministically:

- acceptable target-agent selection and selected-model variant appropriateness;
- agent and model/variant distributions plus confidence calibration;
- precommit rejection, parameter-binding abort, and provider-failure outcomes;
- G3 synchronization outcomes and manual-lock precision;
- deterministic p50/p95 added latency;
- the existing variant-only agreement, fallback, and invalid-Score metrics.

Run:

```sh
npm test
npm run test:contract
npm run test:unit
npm run test:integration
npm run test:evaluation
npm run test:docs
npm run test:privacy
npm run typecheck
```

The harness does not import a live SDK client and makes neither TypeSafe nor OpenAI network requests. Fixture responses contain only deterministic Score, legend, confidence, and probability values; confidence is not evaluated as a gate.

## Separate release gates

A **live evaluation against TypeSafe is not authorized** and requires separate future approval because it transmits data externally and incurs costs. **Build, bundle, packaging, and npm publishing are also not authorized**; npm publication is a separate future gate. The offline result does not imply approval to publish.
