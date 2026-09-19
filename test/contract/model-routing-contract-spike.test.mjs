import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CANDIDATE_MODEL_IDS,
  createImmutableRuntimeSnapshot,
  createModelRoutingHooks,
  verifySnapshotCandidate,
} from "./model-routing-fixture-plugin.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const promptMarker = "MODEL_ROUTING_CONTRACT_PROMPT_6d7b";

const variantCatalog = () => ({
  low: { reasoningEffort: "low", textVerbosity: "low" },
  high: { reasoningEffort: "high", textVerbosity: "high" },
});

function registryObservation() {
  return {
    all: [{
      id: "openai",
      models: Object.fromEntries(CANDIDATE_MODEL_IDS.map((modelID) => [
        modelID.slice("openai/".length),
        {
          id: modelID.slice("openai/".length),
          reasoning: true,
          variants: variantCatalog(),
        },
      ])),
    }],
  };
}

const expectedRuntimeSummary = () => Object.fromEntries(CANDIDATE_MODEL_IDS.map((modelID) => [modelID, {
  present: true,
  reasoning: true,
  variantKeys: ["none", "low", "medium", "high", "xhigh", "max"],
}]));

async function waitForFile(path, predicate = () => true, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (predicate(value)) return value;
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for model-routing evidence: ${path}`);
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
  await mkdir(pluginDir, { recursive: true });
  await mkdir(supportDir, { recursive: true });
  await copyFile(join(here, "model-routing-fixture-plugin.mjs"), join(supportDir, "model-routing-fixture-plugin.mjs"));
  await writeFile(
    join(pluginDir, "model-routing-contract.mjs"),
    'export { ModelRoutingFixturePlugin } from "../contract-support/model-routing-fixture-plugin.mjs";\n',
  );

  const model = (modelID) => ({
    name: modelID,
    reasoning: true,
    temperature: true,
    tool_call: false,
    limit: { context: 8_192, output: 1_024 },
    variants: variantCatalog(),
  });
  await writeFile(join(configDir, "opencode.json"), JSON.stringify({
    plugin: ["./plugins/model-routing-contract.mjs"],
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
  }, null, 2));
}

async function runOpenCode(mode) {
  const root = await mkdtemp(join(tmpdir(), "opencode-model-routing-contract-"));
  const home = join(root, "home");
  const evidencePath = join(root, `${mode}-evidence.json`);
  const boundary = await startProviderBoundary();
  await mkdir(home, { recursive: true });
  await createFixture(root, boundary.baseURL);

  const child = spawn(process.env.OPENCODE_BIN ?? "opencode", [
    "run",
    "--print-logs",
    "--log-level", "DEBUG",
    "--format", "json",
    "--model", "openai/gpt-5.6-luna",
    "--variant", "low",
    promptMarker,
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
      MODEL_ROUTING_CONTRACT_EVIDENCE_PATH: evidencePath,
      MODEL_ROUTING_CONTRACT_MODE: mode,
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
  const exit = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));

  try {
    let evidence = await waitForFile(
      evidencePath,
      (value) => value.paramsObservations?.some(
        (entry) => entry.boundModelID === (mode === "success" ? "openai/gpt-5.6-sol" : "openai/gpt-5.6-luna"),
      ),
    ).catch(async (error) => {
      const termination = await Promise.race([
        exit,
        new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: "still-running" }), 100)),
      ]);
      throw new Error(`${error.message}\ntermination=${JSON.stringify(termination)}\nstdout=${stdout}\nstderr=${stderr}`);
    });
    const termination = await exit;
    evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    return { evidence, requests: boundary.requests, stdout, stderr, termination };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await boundary.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("output.message is the authoritative source when optional input disagrees", async () => {
  const observation = registryObservation();
  const { hooks, trace } = createModelRoutingHooks({
    mode: "success",
    observeRegistry: async () => observation,
  });
  const output = {
    message: {
      id: "message-authority",
      sessionID: "session-authority",
      role: "user",
      agent: "build",
      time: { created: 1 },
      model: { providerID: "openai", modelID: "gpt-5.6-luna" },
      variant: "low",
    },
    parts: [{ type: "text", text: "contract" }],
  };

  await hooks["chat.message"]({
    sessionID: "session-authority",
    model: { providerID: "openai", modelID: "gpt-5.6-terra" },
    variant: "high",
  }, output);

  assert.deepEqual(trace.source, { modelID: "openai/gpt-5.6-luna", variant: "low" });
  assert.deepEqual(output.message.model, { providerID: "openai", modelID: "gpt-5.6-sol" });
  assert.equal(output.message.variant, "high");
  assert.equal(trace.registryObservationCount, 1);
});

test("one immutable three-candidate snapshot detects catalog and option drift", async () => {
  let observations = 0;
  const source = registryObservation();
  const snapshot = await createImmutableRuntimeSnapshot(async () => {
    observations += 1;
    return source;
  });

  assert.equal(observations, 1, "one bounded registry observation");
  assert.deepEqual(Object.keys(snapshot.candidates), CANDIDATE_MODEL_IDS);
  assert(Object.isFrozen(snapshot));
  assert(Object.isFrozen(snapshot.candidates));
  assert(Object.isFrozen(snapshot.candidates["openai/gpt-5.6-sol"].variants.high.options));
  assert.throws(() => {
    snapshot.candidates["openai/gpt-5.6-sol"].catalog.push("max");
  }, TypeError);

  assert.equal(verifySnapshotCandidate(snapshot, source, "openai/gpt-5.6-sol").ok, true);
  const catalogDrift = structuredClone(source);
  catalogDrift.all[0].models["gpt-5.6-sol"].variants.max = { reasoningEffort: "max" };
  assert.deepEqual(
    verifySnapshotCandidate(snapshot, catalogDrift, "openai/gpt-5.6-sol"),
    { ok: false, reason: "catalog-fingerprint-drift" },
  );
  const optionDrift = structuredClone(source);
  optionDrift.all[0].models["gpt-5.6-sol"].variants.high.reasoningEffort = "max";
  assert.deepEqual(
    verifySnapshotCandidate(snapshot, optionDrift, "openai/gpt-5.6-sol"),
    { ok: false, reason: "options-fingerprint-drift" },
  );
});

test("historical design-002 characterization records the source-variant blocker while target commit still binds", { timeout: 60_000 }, async () => {
  const result = await runOpenCode("success");
  assert.equal(result.evidence.events[0], "chat.message");
  const bound = result.evidence.paramsObservations.find(
    (entry) => entry.boundModelID === "openai/gpt-5.6-sol",
  );
  assert(bound, "target model must reach chat.params");
  assert.equal(result.evidence.chatMessageID, bound.messageID);
  assert.equal(result.evidence.registryObservationCount, 1);
  assert.deepEqual(result.evidence.snapshotPrerequisite, { ok: true });
  assert.deepEqual(result.evidence.registryObservationSummary, expectedRuntimeSummary());
  assert.deepEqual(result.evidence.committed, { modelID: "openai/gpt-5.6-sol", variant: "high" });
  assert.equal(bound.boundMessageModelID, "openai/gpt-5.6-sol");
  assert.equal(bound.boundVariant, "high");
  assert.equal(result.evidence.sameMessageRouteVisible, true);
  const promptRequests = result.requests.filter(
    (request) => request.body?.model === "gpt-5.6-sol" && JSON.stringify(request.body).includes(promptMarker),
  );
  assert.equal(promptRequests.length, 1, "one provider attempt for the user prompt");
  const request = promptRequests[0];
  assert.equal(request.body.model, "gpt-5.6-sol");
  assert.equal(request.body.reasoning_effort ?? request.body.reasoning?.effort, "high");
  assert.equal(request.body.text?.verbosity, "high");
  assert.equal(JSON.stringify(request.body).includes('"verbosity":"low"'), false, "no source option residue");
  assert.deepEqual(
    {
      outputMessageVariantPresent: result.evidence.outputMessageVariantPresent,
      source: result.evidence.source,
    },
    {
      outputMessageVariantPresent: false,
      source: { modelID: "openai/gpt-5.6-luna", variant: null },
    },
    "historical design-002 blocker must remain characterized: output.message has no authoritative source variant",
  );
});

test("historical design-002 precommit characterization preserves source model and records absent source variant", { timeout: 60_000 }, async () => {
  const result = await runOpenCode("precommit-failure");
  assert.deepEqual(result.evidence.snapshotPrerequisite, { ok: true });
  assert.deepEqual(result.evidence.registryObservationSummary, expectedRuntimeSummary());
  assert.equal(result.evidence.committed, undefined);
  const bound = result.evidence.paramsObservations.find(
    (entry) => entry.boundModelID === "openai/gpt-5.6-luna",
  );
  assert(bound, "source model must reach chat.params after precommit failure");
  assert.equal(result.evidence.chatMessageID, bound.messageID);
  assert.equal(bound.boundMessageModelID, "openai/gpt-5.6-luna");
  const promptRequests = result.requests.filter(
    (request) => request.body?.model === "gpt-5.6-luna" && JSON.stringify(request.body).includes(promptMarker),
  );
  assert.equal(promptRequests.length, 1, "one provider attempt after precommit failure");
  assert.equal(promptRequests[0].body.model, "gpt-5.6-luna");
  assert.equal(promptRequests[0].body.reasoning_effort ?? promptRequests[0].body.reasoning?.effort, "low");
  const transmitted = promptRequests.reduce(
    (count, request) => count + (JSON.stringify(request.body).match(new RegExp(promptMarker, "g"))?.length ?? 0),
    0,
  );
  assert.equal(transmitted, 1, "prompt reaches the provider exactly once");
  assert.deepEqual(
    {
      outputMessageVariantPresent: result.evidence.outputMessageVariantPresent,
      source: result.evidence.source,
    },
    {
      outputMessageVariantPresent: false,
      source: { modelID: "openai/gpt-5.6-luna", variant: null },
    },
    "historical design-002 blocker must remain characterized: source preservation cannot include an omitted variant",
  );
});
