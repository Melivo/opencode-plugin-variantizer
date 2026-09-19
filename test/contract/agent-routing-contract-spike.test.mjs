import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  AGENT_MODELS,
  TARGET_TUPLE,
  createAgentRoutingHooks,
} from "./agent-routing-fixture-plugin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const resultPath = join(here, "agent-routing-contract-result.json");
const expectedVersion = "1.18.31";
const promptPrefix = "AGENT_ROUTING_CONTRACT_PROMPT_92f1";

function variantCatalog() {
  return {
    low: { reasoningEffort: "low", textVerbosity: "low" },
    high: { reasoningEffort: "high", textVerbosity: "high" },
  };
}

function sourceMessage({ sessionID, messageID, agent = "luna", variant } = {}) {
  const message = {
    id: messageID,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent,
    model: {
      providerID: "openai",
      modelID: AGENT_MODELS[agent].slice("openai/".length),
    },
  };
  if (variant !== undefined) message.model.variant = variant;
  return message;
}

function paramsInput(message) {
  return {
    sessionID: message.sessionID,
    agent: message.agent,
    model: message.model,
    provider: {},
    message,
  };
}

async function waitForJson(path, predicate = () => true, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (predicate(value)) return value;
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for agent-routing evidence: ${path}`);
}

async function startProviderBoundary() {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      requests.push({ method: request.method, url: request.url, body });
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "contract_stop", message: "local boundary reached" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function createFixture(root, baseURL) {
  const configDir = join(root, ".opencode");
  const pluginDir = join(configDir, "plugins");
  const supportDir = join(configDir, "contract-support");
  const agentDir = join(configDir, "agents");
  await mkdir(pluginDir, { recursive: true });
  await mkdir(supportDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await copyFile(
    join(here, "agent-routing-fixture-plugin.mjs"),
    join(supportDir, "agent-routing-fixture-plugin.mjs"),
  );
  await writeFile(
    join(pluginDir, "agent-routing-contract.mjs"),
    'export { AgentRoutingFixturePlugin } from "../contract-support/agent-routing-fixture-plugin.mjs";\n',
  );

  for (const [agent, model] of Object.entries(AGENT_MODELS)) {
    await writeFile(join(agentDir, `${agent}.md`), [
      "---",
      `description: Contract ${agent} agent`,
      "mode: primary",
      `model: ${model}`,
      "---",
      "Identical contract-fixture instructions.",
      "",
    ].join("\n"));
  }

  const model = (modelID) => ({
    name: modelID,
    reasoning: true,
    temperature: true,
    tool_call: false,
    limit: { context: 8_192, output: 1_024 },
    variants: variantCatalog(),
  });
  await writeFile(join(configDir, "opencode.json"), `${JSON.stringify({
    plugin: ["./plugins/agent-routing-contract.mjs"],
    agent: { title: { disable: true } },
    provider: {
      openai: {
        options: { baseURL },
        models: {
          "gpt-5.6-luna": model("gpt-5.6-luna"),
          "gpt-5.6-terra": model("gpt-5.6-terra"),
          "gpt-5.6-sol": model("gpt-5.6-sol"),
        },
      },
    },
  }, null, 2)}\n`);
}

async function runOpenCode(mode) {
  const root = await mkdtemp(join(tmpdir(), "opencode-agent-routing-contract-"));
  const home = join(root, "home");
  const evidencePath = join(root, `${mode}-evidence.json`);
  const boundary = await startProviderBoundary();
  const marker = `${promptPrefix}_${mode}`;
  await mkdir(home, { recursive: true });
  await createFixture(root, boundary.baseURL);

  const child = spawn(process.env.OPENCODE_BIN ?? "opencode", [
    "run",
    "--print-logs",
    "--log-level", "DEBUG",
    "--format", "json",
    "--agent", "luna",
    marker,
  ], {
    cwd: root,
    env: {
      ...process.env,
      PWD: root,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      AGENT_ROUTING_CONTRACT_EVIDENCE_PATH: evidencePath,
      AGENT_ROUTING_CONTRACT_MODE: mode,
      OPENAI_API_KEY: "contract-local-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 25_000);
  const exit = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));

  try {
    await waitForJson(evidencePath, (value) => value.paramsObservations?.length > 0).catch(async (error) => {
      const termination = await Promise.race([
        exit,
        new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: "still-running" }), 100)),
      ]);
      throw new Error(`${error.message}\ntermination=${JSON.stringify(termination)}\nstdout=${stdout}\nstderr=${stderr}`);
    });
    const termination = await exit;
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    return { evidence, requests: boundary.requests, stdout, stderr, termination, marker };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await boundary.close();
    await rm(root, { recursive: true, force: true });
  }
}

function promptRequests(result) {
  return result.requests.filter((request) => JSON.stringify(request.body).includes(result.marker));
}

function assertOrdinaryWritable(summary) {
  assert.deepEqual(summary, {
    present: true,
    dataProperty: true,
    writable: true,
    enumerable: true,
    configurable: true,
    accessor: false,
  });
}

test("G1 current-turn agent tuple contract passes on pinned OpenCode 1.18.31", { timeout: 120_000 }, async () => {
  const version = spawnSync(process.env.OPENCODE_BIN ?? "opencode", ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), expectedVersion);

  const authority = createAgentRoutingHooks();
  const authoritativeMessage = sourceMessage({
    sessionID: "session-authority",
    messageID: "message-authority",
    agent: "luna",
  });
  await authority.hooks["chat.message"]({
    sessionID: "session-authority",
    agent: "terra",
    model: { providerID: "openai", modelID: "gpt-5.6-terra" },
    variant: "low",
  }, { message: authoritativeMessage, parts: [] });
  const authorityObservation = authority.trace.messageObservations[0];
  assert.deepEqual(authorityObservation.source, {
    agent: "luna",
    modelID: "openai/gpt-5.6-luna",
    variant: null,
    variantPresent: false,
  });
  assert.equal(authorityObservation.optionalInput.agent, "terra");
  assert.deepEqual(authorityObservation.descriptorsBefore.modelVariant, { present: false });
  assertOrdinaryWritable(authorityObservation.descriptorsBefore.agent);
  assertOrdinaryWritable(authorityObservation.descriptorsBefore.model);
  assertOrdinaryWritable(authorityObservation.descriptorsAfter.agent);
  assertOrdinaryWritable(authorityObservation.descriptorsAfter.model);
  assertOrdinaryWritable(authorityObservation.descriptorsAfter.modelVariant);
  assert.deepEqual(
    {
      agent: authoritativeMessage.agent,
      modelID: `${authoritativeMessage.model.providerID}/${authoritativeMessage.model.modelID}`,
      variant: authoritativeMessage.model.variant,
    },
    TARGET_TUPLE,
  );

  const overlap = createAgentRoutingHooks();
  const messages = [
    sourceMessage({ sessionID: "session-a", messageID: "shared-message", agent: "luna" }),
    sourceMessage({ sessionID: "session-b", messageID: "shared-message", agent: "terra" }),
    sourceMessage({ sessionID: "session-a", messageID: "message-2", agent: "luna" }),
  ];
  await Promise.all(messages.map((message) => overlap.hooks["chat.message"]({
    sessionID: message.sessionID,
    agent: message.agent,
    model: message.model,
  }, { message, parts: [] })));
  const callParams = async (message) => {
    const output = { options: { reasoningEffort: "low", textVerbosity: "low" } };
    await overlap.hooks["chat.params"](paramsInput(message), output);
    assert.deepEqual(output.options, { reasoningEffort: "high", textVerbosity: "high" });
  };
  await callParams(messages[1]);
  await callParams(messages[2]);
  await callParams(messages[0]);
  await callParams(messages[1]);
  assert.deepEqual(
    overlap.trace.paramsObservations.map(({ sessionID, messageID, retry, turnOrder }) => ({
      sessionID,
      messageID,
      retry,
      turnOrder,
    })),
    [
      { sessionID: "session-b", messageID: "shared-message", retry: 1, turnOrder: 2 },
      { sessionID: "session-a", messageID: "message-2", retry: 1, turnOrder: 3 },
      { sessionID: "session-a", messageID: "shared-message", retry: 1, turnOrder: 1 },
      { sessionID: "session-b", messageID: "shared-message", retry: 2, turnOrder: 2 },
    ],
  );
  assert.equal(overlap.trace.paramsObservations.every((entry) => entry.completeTupleVisible), true);
  assert.equal(overlap.trace.paramsObservations.every((entry) => entry.targetOnlyOptions), true);
  assert.deepEqual(overlap.trace.cardinality, {
    committedRoutes: 3,
    chatMessageCalls: 3,
    chatParamsCalls: 4,
  });

  const success = await runOpenCode("success");
  const successMessage = success.evidence.messageObservations[0];
  const successParams = success.evidence.paramsObservations.find(
    (entry) => entry.actual.agent === TARGET_TUPLE.agent,
  );
  assert(successParams, "target-agent chat.params invocation must be observed");
  assert.deepEqual(successMessage.source, {
    agent: "luna",
    modelID: "openai/gpt-5.6-luna",
    variant: null,
    variantPresent: true,
  });
  assert.equal(successParams.sessionID, successMessage.sessionID);
  assert.equal(successParams.messageID, successMessage.messageID);
  assert.equal(successParams.actual.agent, "sol");
  assert.equal(successParams.actual.inputModelID, "openai/gpt-5.6-sol");
  assert.equal(successParams.actual.messageAgent, "sol");
  assert.equal(successParams.actual.messageModelID, "openai/gpt-5.6-sol");
  assert.equal(successParams.actual.variant, "high");
  assert.equal(successParams.completeTupleVisible, true);
  assert.equal(successParams.targetOnlyOptions, true);
  const successProviderRequests = promptRequests(success);
  assert.equal(successProviderRequests.length, 1, "one provider attempt and no resend");
  assert.equal(successProviderRequests[0].body.model, "gpt-5.6-sol");
  assert.equal(
    successProviderRequests[0].body.reasoning_effort ?? successProviderRequests[0].body.reasoning?.effort,
    "high",
  );
  assert.equal(successProviderRequests[0].body.text?.verbosity, "high");
  assert.equal(JSON.stringify(successProviderRequests[0].body).includes('"verbosity":"low"'), false);

  const mismatch = await runOpenCode("binding-mismatch");
  const mismatchParams = mismatch.evidence.paramsObservations.find((entry) => entry.providerAborted);
  assert(mismatchParams, "target-route mismatch must reach the aborting chat.params gate");
  assert.equal(mismatchParams.correlated, true);
  assert.equal(mismatchParams.completeTupleVisible, false);
  assert.equal(mismatchParams.providerAborted, true);
  assert.deepEqual(mismatch.evidence.aborts, [{
    compositeKey: mismatchParams.compositeKey,
    reason: "committed-route-mismatch",
  }]);
  assert.equal(
    promptRequests(mismatch).filter((request) => request.body?.model === "gpt-5.6-sol").length,
    0,
    "binding mismatch aborts before target provider invocation",
  );

  const preserved = await runOpenCode("precommit-failure");
  const preservedMessage = preserved.evidence.messageObservations[0];
  const preservedParams = preserved.evidence.paramsObservations.find(
    (entry) => entry.actual.agent === "luna",
  );
  assert(preservedParams, "unchanged source-agent chat.params invocation must be observed");
  assert.deepEqual(preservedMessage.preserved, preservedMessage.source);
  assert.deepEqual(preservedMessage.source, {
    agent: "luna",
    modelID: "openai/gpt-5.6-luna",
    variant: null,
    variantPresent: true,
  });
  assert.equal(preservedParams.correlated, false);
  assert.equal(preservedParams.actual.agent, "luna");
  assert.equal(preservedParams.actual.inputModelID, "openai/gpt-5.6-luna");
  assert.equal(preservedParams.actual.messageAgent, "luna");
  assert.equal(preservedParams.actual.messageModelID, "openai/gpt-5.6-luna");
  assert.equal(preservedParams.actual.variant, null);
  const preservedProviderRequests = promptRequests(preserved);
  assert.equal(preservedProviderRequests.length, 1, "unchanged source uses one provider attempt and no resend");
  assert.equal(preservedProviderRequests[0].body.model, "gpt-5.6-luna");
  assert.equal(
    JSON.stringify(preservedProviderRequests[0].body).match(new RegExp(preserved.marker, "g"))?.length,
    1,
    "prompt is transmitted exactly once",
  );

  const result = {
    schemaVersion: 1,
    openCodeVersion: expectedVersion,
    gate: "G1",
    outcome: "PASS",
    invariants: {
      authoritativeSourceAgentModel: true,
      ordinaryWritableTupleProperties: true,
      synchronousCompleteTupleBeforeBinding: true,
      sameCompositeTupleAtChatParams: true,
      overlappingSessionsAndTurnsCorrelate: true,
      deterministicRetriesAndCardinality: true,
      providerAbortOnMismatch: true,
      targetOnlyOptions: true,
      sourcePreservedWithoutVariant: true,
      oneProviderAttemptNoResend: true,
    },
    sourceVariantRequired: false,
    historicalDesign002: {
      outcome: "BLOCKED",
      blocker: "OpenCode 1.18.31 does not expose the authoritative source variant as output.message.variant; the canonical field is output.message.model.variant.",
      preservedAsPassingCharacterization: true,
    },
  };
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  assert.equal(Object.values(result.invariants).every(Boolean), true);
});
