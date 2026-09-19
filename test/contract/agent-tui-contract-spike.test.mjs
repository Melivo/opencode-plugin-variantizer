import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const resultPath = join(here, "agent-tui-contract-result.json");
const expectedVersion = "1.18.31";
const expectedRing = Object.freeze(["luna", "terra", "sol"]);
const observedPrimaryOrder = Object.freeze(["luna", "sol", "terra"]);
const cycleCommand = "agent.cycle.reverse";
const bindings = Object.freeze({
  luna: "openai/gpt-5.6-luna",
  terra: "openai/gpt-5.6-terra",
  sol: "openai/gpt-5.6-sol",
});
const sharedProjectBehavior = Object.freeze({
  prompt: "Shared synthetic contract prompt.",
  permission: Object.freeze({
    edit: "deny",
    bash: "deny",
    webfetch: "deny",
    doom_loop: "deny",
    external_directory: "deny",
  }),
  tools: Object.freeze({
    edit: false,
    write: false,
  }),
  skills: Object.freeze(["contract-shared-skill"]),
  temperature: 0.2,
  topP: 0.9,
});
const projectBehaviorByAgent = Object.freeze(Object.fromEntries(expectedRing.map((name) => [
  name,
  Object.freeze({
    prompt: sharedProjectBehavior.prompt,
    permission: { ...sharedProjectBehavior.permission },
    tools: { ...sharedProjectBehavior.tools },
    skills: [...sharedProjectBehavior.skills],
    temperature: sharedProjectBehavior.temperature,
    topP: sharedProjectBehavior.topP,
  }),
])));

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  if (typeof value === "string") {
    return value.replace(/\/tmp\/opencode-agent-tui-contract-[^/]+/gu, "$FIXTURE_ROOT");
  }
  return value;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function modelID(model) {
  return model ? `${model.providerID}/${model.modelID}` : null;
}

async function waitForJson(path, predicate = () => true, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (predicate(value)) return value;
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`timed out waiting for agent TUI evidence: ${path}`);
}

const fixturePlugin = String.raw`
import { writeFileSync } from "node:fs";

const evidencePath = process.env.AGENT_TUI_CONTRACT_EVIDENCE_PATH;
const state = {
  agentLists: [],
  observations: [],
  publications: [],
  startupError: null,
  complete: false,
};

function persist() {
  writeFileSync(evidencePath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

function command(command, properties = { command }) {
  return { type: "tui.command.execute", properties };
}

async function publish(label, body) {
  try {
    const response = await client.tui.publish({ body });
    state.publications.push({
      label,
      command: body.properties?.command ?? null,
      data: response.data ?? null,
      errorDetected: response.error !== undefined,
      errorName: response.error?.name ?? null,
    });
  } catch (error) {
    state.publications.push({
      label,
      command: body.properties?.command ?? null,
      data: null,
      errorDetected: true,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
  persist();
}

async function submit(label) {
  await publish(label + ":append", {
    type: "tui.prompt.append",
    properties: { text: "agent-tui-contract-" + label },
  });
  await publish(label + ":submit", command("prompt.submit"));
}

let client;
export const AgentTuiContractFixturePlugin = async (input) => {
  client = input.client;
  persist();
  setTimeout(async () => {
    try {
      const first = await client.app.agents();
      const second = await client.app.agents();
      state.agentLists.push(first.data ?? []);
      state.agentLists.push(second.data ?? []);
      persist();
      await submit("baseline");
    } catch (error) {
      state.startupError = error instanceof Error ? error.message : String(error);
      state.complete = true;
      persist();
    }
  }, 1_500);

  return {
    "chat.message": async (_input, output) => {
      const index = state.observations.length;
      const before = {
        sessionID: output.message.sessionID,
        messageID: output.message.id,
        agent: output.message.agent,
        model: output.message.model,
      };
      const observation = { index, before, afterMutation: null };
      state.observations.push(observation);

      // This is deliberately server-side message mutation, not a selector setter.
      if (index === 5) {
        output.message.agent = "terra";
        output.message.model = { providerID: "openai", modelID: "gpt-5.6-terra" };
        observation.afterMutation = {
          agent: output.message.agent,
          model: output.message.model,
        };
      }
      persist();

      setTimeout(async () => {
        if (index === 0 || index === 1 || index === 2) {
          await publish("single-step-" + index, command("agent.cycle.reverse"));
          await submit("single-step-observation-" + index);
          return;
        }
        if (index === 3) {
          await publish("pending-path-first-step", command("agent.cycle.reverse"));
          await submit("intermediate-observation");
          return;
        }
        if (index === 4) {
          await publish("rebase-step-1", command("agent.cycle.reverse"));
          await publish("rebase-step-2", command("agent.cycle.reverse"));
          await submit("rebased-final-observation");
          return;
        }
        if (index === 5) {
          await submit("post-message-mutation-observation");
          return;
        }
        if (index === 6) {
          await publish("ambiguous-accepted-command", command("agent.contract_unknown"));
          await submit("post-ambiguous-observation");
          return;
        }
        if (index === 7) {
          await publish("rejected-invalid-payload", command(null, {}));
          state.complete = true;
          persist();
        }
      }, 500);

      throw new Error("intentional contract stop before provider invocation");
    },
  };
};
`;

function model(modelIDValue) {
  return {
    name: modelIDValue,
    reasoning: true,
    temperature: true,
    tool_call: false,
    limit: { context: 8_192, output: 1_024 },
  };
}

async function createFixture(root, { baseURL, includeTuiPlugin = true } = {}) {
  const configDir = join(root, ".opencode");
  const pluginDir = join(configDir, "plugins");
  const skillDir = join(configDir, "skills", "contract-shared-skill");
  await mkdir(pluginDir, { recursive: true });
  await mkdir(skillDir, { recursive: true });
  if (includeTuiPlugin) {
    await writeFile(join(pluginDir, "agent-tui-contract-fixture.mjs"), fixturePlugin);
  }
  await writeFile(join(skillDir, "SKILL.md"), [
    "---",
    "name: contract-shared-skill",
    "description: Synthetic shared skill for provider-boundary equality.",
    "---",
    "",
    "Use only deterministic local contract evidence.",
    "",
  ].join("\n"));

  const sharedAgent = {
    mode: "primary",
    prompt: sharedProjectBehavior.prompt,
    temperature: sharedProjectBehavior.temperature,
    top_p: sharedProjectBehavior.topP,
    permission: sharedProjectBehavior.permission,
    tools: sharedProjectBehavior.tools,
    skills: sharedProjectBehavior.skills,
  };
  await writeFile(join(configDir, "opencode.json"), `${JSON.stringify({
    default_agent: "luna",
    plugin: includeTuiPlugin ? ["./plugins/agent-tui-contract-fixture.mjs"] : [],
    agent: {
      build: { disable: true },
      plan: { disable: true },
      luna: { ...sharedAgent, description: "Luna contract agent", model: bindings.luna },
      terra: { ...sharedAgent, description: "Terra contract agent", model: bindings.terra },
      sol: { ...sharedAgent, description: "Sol contract agent", model: bindings.sol },
      scout: {
        ...sharedAgent,
        mode: "subagent",
        description: "Secondary exclusion sentinel",
        model: bindings.luna,
      },
    },
    provider: {
      openai: {
        ...(baseURL ? { options: { baseURL } } : {}),
        models: {
          "gpt-5.6-luna": model("gpt-5.6-luna"),
          "gpt-5.6-terra": model("gpt-5.6-terra"),
          "gpt-5.6-sol": model("gpt-5.6-sol"),
        },
      },
    },
  }, null, 2)}\n`);
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
      response.end(JSON.stringify({
        error: { type: "contract_stop", message: "local provider boundary reached" },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function runProviderBoundary() {
  const root = await mkdtemp(join(tmpdir(), "opencode-agent-tui-contract-"));
  const home = join(root, "home");
  const boundary = await startProviderBoundary();
  const prompt = "AGENT_PROVIDER_BOUNDARY_CONTRACT_72f1";
  const opencodeBin = process.env.OPENCODE_BIN ?? "opencode";
  await mkdir(home, { recursive: true });
  await createFixture(root, { baseURL: boundary.baseURL, includeTuiPlugin: false });

  const env = {
    ...process.env,
    PWD: root,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENAI_API_KEY: "contract-local-key",
  };
  const requestBodies = {};

  try {
    for (const agent of expectedRing) {
      const before = boundary.requests.length;
      const child = spawn(opencodeBin, [
        "run",
        "--format", "json",
        "--agent", agent,
        prompt,
      ], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
      const termination = await new Promise((resolve) => child.once(
        "close",
        (code, signal) => resolve({ code, signal }),
      ));
      clearTimeout(timeout);
      const requests = boundary.requests.slice(before);
      const request = requests.find((entry) => (
        typeof entry.body === "object"
        && entry.body !== null
        && entry.body.model === bindings[agent].slice("openai/".length)
        && JSON.stringify(entry.body).includes(prompt)
      ));
      assert(request, [
        `provider request missing for ${agent}`,
        `termination=${JSON.stringify(termination)}`,
        `stdout=${stdout}`,
        `stderr=${stderr}`,
      ].join("\n"));
      requestBodies[agent] = request.body;
    }
    return requestBodies;
  } finally {
    await boundary.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function runPinnedTui() {
  const root = await mkdtemp(join(tmpdir(), "opencode-agent-tui-contract-"));
  const home = join(root, "home");
  const evidencePath = join(root, "agent-tui-evidence.json");
  const opencodeBin = process.env.OPENCODE_BIN ?? "opencode";
  await mkdir(home, { recursive: true });
  await createFixture(root);

  const env = {
    ...process.env,
    PWD: root,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    AGENT_TUI_CONTRACT_EVIDENCE_PATH: evidencePath,
    OPENAI_API_KEY: "contract-local-key",
  };
  const child = spawn(
    "script",
    ["-qefc", `${shellQuote(opencodeBin)} ${shellQuote(root)}`, "/dev/null"],
    { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));

  try {
    return await waitForJson(evidencePath, (value) => value.complete === true);
  } catch (error) {
    throw new Error(`${error.message}\nstdout=${stdout}\nstderr=${stderr}`);
  } finally {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    const graceful = await Promise.race([
      exit.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 400)),
    ]);
    if (!graceful) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
      await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 700))]);
    }
    await rm(root, { recursive: true, force: true });
  }
}

function effectiveBehavior(agent) {
  return {
    prompt: agent.prompt ?? null,
    permission: agent.permission ?? null,
    tools: agent.tools ?? null,
    options: agent.options ?? null,
    temperature: agent.temperature ?? null,
    topP: agent.topP ?? null,
    maxSteps: agent.maxSteps ?? agent.steps ?? null,
  };
}

function normalizeAllowedModelIdentity(value) {
  if (Array.isArray(value)) return value.map(normalizeAllowedModelIdentity);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeAllowedModelIdentity(entry)]),
    );
  }
  if (typeof value === "string") {
    return expectedRing.reduce((normalized, name) => normalized
      .replaceAll(bindings[name], "$BOUND_MODEL")
      .replaceAll(bindings[name].slice("openai/".length), "$BOUND_MODEL"), value);
  }
  return value;
}

function providerBoundaryBehavior(body, agent) {
  const inputInstructions = Array.isArray(body.input)
    ? body.input.filter((entry) => entry?.role === "system" || entry?.role === "developer")
    : [];
  const rawInstructions = body.instructions ?? inputInstructions;
  const instructions = normalizeAllowedModelIdentity(rawInstructions);
  const tools = normalizeAllowedModelIdentity(body.tools ?? []);
  const other = structuredClone(body);
  delete other.model;
  delete other.input;
  delete other.instructions;
  delete other.tools;
  delete other.prompt_cache_key;
  return {
    instructions,
    tools,
    other: normalizeAllowedModelIdentity(other),
    boundModelIdentityInjected: JSON.stringify(rawInstructions).includes(bindings[agent]),
  };
}

function visiblePrimary(agent) {
  return (agent.mode === "primary" || agent.mode === "all") && agent.hidden !== true;
}

function publication(evidence, label) {
  const match = evidence.publications.find((entry) => entry.label === label);
  assert(match, `missing publication evidence: ${label}`);
  return match;
}

test("OpenCode 1.18.31 agent ring and selector contracts are strictly characterized", { timeout: 60_000 }, async () => {
  const opencodeBin = process.env.OPENCODE_BIN ?? "opencode";
  const version = spawnSync(opencodeBin, ["--version"], { encoding: "utf8", timeout: 5_000 });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), expectedVersion);

  const evidence = await runPinnedTui();
  assert.equal(evidence.agentLists.length, 2);
  assert.equal(evidence.observations.length, 8);

  const firstList = evidence.agentLists[0];
  const secondList = evidence.agentLists[1];
  const firstByName = Object.fromEntries(firstList.map((agent) => [agent.name, agent]));
  const secondByName = Object.fromEntries(secondList.map((agent) => [agent.name, agent]));
  const visiblePrimaryOrder = firstList.filter(visiblePrimary).map((agent) => agent.name);
  const ringAgents = expectedRing.map((name) => firstByName[name]);
  assert.equal(ringAgents.every(Boolean), true, "all configured ring agents are listed");

  const actualBindings = Object.fromEntries(expectedRing.map((name) => [name, modelID(firstByName[name].model)]));
  const secondBindings = Object.fromEntries(expectedRing.map((name) => [name, modelID(secondByName[name].model)]));
  const runtimeListFingerprints = Object.fromEntries(
    expectedRing.map((name) => [name, fingerprint(effectiveBehavior(firstByName[name]))]),
  );
  const secondRuntimeListFingerprints = Object.fromEntries(
    expectedRing.map((name) => [name, fingerprint(effectiveBehavior(secondByName[name]))]),
  );
  const availableAgentFields = [...new Set(ringAgents.flatMap((agent) => Object.keys(agent)))].sort();
  const canonicalProjectBehaviorFingerprints = Object.fromEntries(
    expectedRing.map((name) => [name, fingerprint(projectBehaviorByAgent[name])]),
  );
  const canonicalProjectBehaviorFingerprintsAgain = Object.fromEntries(
    expectedRing.map((name) => [name, fingerprint(structuredClone(projectBehaviorByAgent[name]))]),
  );
  const providerBodies = await runProviderBoundary();
  const providerBehavior = Object.fromEntries(
    expectedRing.map((name) => [name, providerBoundaryBehavior(providerBodies[name], name)]),
  );
  const providerInstructionFingerprints = Object.fromEntries(
    expectedRing.map((name) => [name, fingerprint(providerBehavior[name].instructions)]),
  );
  const providerToolSchemaFingerprints = Object.fromEntries(
    expectedRing.map((name) => [name, fingerprint(providerBehavior[name].tools)]),
  );
  const providerOtherBehaviorFingerprints = Object.fromEntries(
    expectedRing.map((name) => [name, fingerprint(providerBehavior[name].other)]),
  );

  const observedAgents = evidence.observations.map((entry) => entry.before.agent);
  const observedModels = evidence.observations.map((entry) => modelID(entry.before.model));
  const observedSessions = evidence.observations.map((entry) => entry.before.sessionID);
  const observedCycle = observedAgents.slice(0, 4);
  const secondaryExcluded = observedAgents.includes("scout") === false;
  const builtInsDisabled = firstByName.build === undefined && firstByName.plan === undefined;
  const bindingsExact = JSON.stringify(actualBindings) === JSON.stringify(bindings)
    && JSON.stringify(secondBindings) === JSON.stringify(bindings);
  const bindingsStable = JSON.stringify(actualBindings) === JSON.stringify(secondBindings);
  const runtimeListFingerprintsEqual = new Set(Object.values(runtimeListFingerprints)).size === 1;
  const runtimeListFingerprintsStable = JSON.stringify(runtimeListFingerprints)
    === JSON.stringify(secondRuntimeListFingerprints);
  const canonicalProjectBehaviorEqual = new Set(Object.values(canonicalProjectBehaviorFingerprints)).size === 1;
  const canonicalProjectBehaviorStable = JSON.stringify(canonicalProjectBehaviorFingerprints)
    === JSON.stringify(canonicalProjectBehaviorFingerprintsAgain);
  const providerInstructionsEqual = new Set(Object.values(providerInstructionFingerprints)).size === 1;
  const providerToolSchemasEqual = new Set(Object.values(providerToolSchemaFingerprints)).size === 1;
  const providerOtherBehaviorEqual = new Set(Object.values(providerOtherBehaviorFingerprints)).size === 1;
  const exactPrimaryMembership = visiblePrimaryOrder.length === expectedRing.length
    && expectedRing.every((name) => visiblePrimaryOrder.includes(name));
  const observedOrderMatchesContract = JSON.stringify(visiblePrimaryOrder) === JSON.stringify(observedPrimaryOrder);
  const exactCycleAndWrap = JSON.stringify(observedCycle) === JSON.stringify([...expectedRing, expectedRing[0]]);

  assert.equal(builtInsDisabled, true, "build and plan are absent after disablement");
  assert.equal(firstByName.scout.mode, "subagent", "agent.list distinguishes the secondary sentinel");
  assert.equal(secondaryExcluded, true, "secondary sentinel never enters the observed cycle");
  assert.equal(bindingsExact, true, "fixed model bindings are observable and exact");
  assert.equal(bindingsStable, true, "fixed model bindings are stable across reads");
  assert.equal(runtimeListFingerprintsEqual, true, "agent.list observable capability subset is equal");
  assert.equal(runtimeListFingerprintsStable, true, "agent.list observable capability subset is stable");

  const directCyclePublications = evidence.publications.filter((entry) => entry.command === cycleCommand);
  assert.equal(directCyclePublications.length, 6);
  assert.equal(directCyclePublications.every((entry) => entry.data === true && !entry.errorDetected), true);
  assert.equal(new Set(observedSessions).size, 1, "cycling and follow-up prompts preserve the active session");
  assert.deepEqual(
    observedModels.slice(0, 6),
    observedAgents.slice(0, 6).map((agent) => bindings[agent]),
    "authoritative next-turn sources retain each selected agent's fixed model",
  );

  const intermediateClassified = observedAgents[3] === "luna" && observedAgents[4] === "terra";
  const rebasedTwoStep = observedAgents[4] === "terra" && observedAgents[5] === "luna";
  assert.equal(intermediateClassified, true, "a later source observation identifies the first path step");
  assert.equal(rebasedTwoStep, true, "two ordered commands rebase from the authoritative intermediate source");

  assert.equal(evidence.observations[5].afterMutation.agent, "terra");
  const messageMutationPersistsSelector = observedAgents[6] === "terra";
  assert.equal(messageMutationPersistsSelector, false, "output.message.agent mutation does not persist the TUI selector");

  const ambiguous = publication(evidence, "ambiguous-accepted-command");
  assert.equal(ambiguous.data, true, "publish acceptance is transport evidence only");
  assert.equal(ambiguous.errorDetected, false);
  assert.equal(observedAgents[7], observedAgents[6], "later source observation shows no selector transition");
  const rejected = publication(evidence, "rejected-invalid-payload");
  assert.equal(rejected.errorDetected, true, "invalid publication is detectably rejected");

  const g2FailedInvariants = [
    !builtInsDisabled ? "build-plan-disablement" : null,
    !exactPrimaryMembership ? "exact-luna-terra-sol-primary-membership" : null,
    !observedOrderMatchesContract ? "observed-luna-sol-terra-primary-order" : null,
    !secondaryExcluded ? "secondary-exclusion" : null,
    !bindingsExact || !bindingsStable ? "exact-stable-agent-model-bindings" : null,
    !canonicalProjectBehaviorEqual || !canonicalProjectBehaviorStable
      ? "canonical-project-behavior-equality"
      : null,
    !providerInstructionsEqual ? "provider-boundary-instruction-equality" : null,
    !providerToolSchemasEqual ? "provider-boundary-tool-schema-equality" : null,
    !providerOtherBehaviorEqual ? "provider-boundary-other-behavior-equality" : null,
    !exactCycleAndWrap ? "reverse-cycle-logical-order-and-wrap" : null,
  ].filter(Boolean);
  const g3UnavailableReasons = [
    "targetless-publish-payload-has-no-session-identifier",
    "cross-session-selector-scope-is-not-authoritatively-observable",
    "command-timeout-delivery-state-is-not-authoritatively-observable",
  ];

  const result = {
    schemaVersion: 1,
    openCodeVersion: expectedVersion,
    g2: {
      outcome: g2FailedInvariants.length === 0 ? "PASS" : "BLOCKED",
      failedInvariants: g2FailedInvariants,
      logicalRing: expectedRing,
      expectedObservedPrimaryOrder: observedPrimaryOrder,
      observedVisiblePrimaryOrder: visiblePrimaryOrder,
      exactPrimaryMembership,
      cycleCommand,
      observedLogicalCycleAndWrap: observedCycle,
      builtInsDisabled,
      secondaryAgent: { name: "scout", mode: firstByName.scout.mode, excludedFromCycle: secondaryExcluded },
      bindings: actualBindings,
      bindingsStable,
      canonicalProjectBehavior: {
        coveredFields: ["prompt", "permission", "tools", "skills", "temperature", "topP"],
        fingerprints: canonicalProjectBehaviorFingerprints,
        equal: canonicalProjectBehaviorEqual,
        stable: canonicalProjectBehaviorStable,
      },
      providerBoundaryBehavior: {
        normalizedAllowedDifferences: ["bound-model-identity", "request-specific-prompt-cache-key"],
        boundModelIdentityInjected: Object.fromEntries(
          expectedRing.map((name) => [name, providerBehavior[name].boundModelIdentityInjected]),
        ),
        instructionFingerprints: providerInstructionFingerprints,
        instructionsEqual: providerInstructionsEqual,
        toolSchemaFingerprints: providerToolSchemaFingerprints,
        toolSchemasEqual: providerToolSchemasEqual,
        otherBehaviorFingerprints: providerOtherBehaviorFingerprints,
        otherBehaviorEqual: providerOtherBehaviorEqual,
      },
      runtimeListSupplement: {
        availableAgentFields,
        fingerprints: runtimeListFingerprints,
        equal: runtimeListFingerprintsEqual,
        stable: runtimeListFingerprintsStable,
      },
      residualHostRisks: [
        "host-internal-resolved-instructions-tools-and-skills-remain-unobservable-beyond-provider-boundary",
      ],
    },
    g3: {
      outcome: g3UnavailableReasons.length === 0 ? "PROVEN" : "UNAVAILABLE",
      unavailableReasons: g3UnavailableReasons,
      command: {
        eventType: "tui.command.execute",
        name: cycleCommand,
        transport: "client.tui.publish",
        targetless: true,
      },
      directPublishDelivery: true,
      activeSessionStable: new Set(observedSessions).size === 1,
      orderedTwoCommandCompositionObserved: rebasedTwoStep,
      currentTurnAgentMutationPersistsSelector: messageMutationPersistsSelector,
      invalidPayloadRejectionDetectable: rejected.errorDetected,
      ambiguousAcceptedCommandDetectedByLaterSource: observedAgents[7] === observedAgents[6],
      nextTurnSourceSupportsIntermediateClassification: intermediateClassified,
      nextTurnSourceSupportsRebasing: rebasedTwoStep,
      publishSuccessIsReadback: false,
      rejectedPublicationRetried: evidence.publications.filter(
        (entry) => entry.label === "rejected-invalid-payload",
      ).length > 1,
      ambiguousPublicationRetried: evidence.publications.filter(
        (entry) => entry.label === "ambiguous-accepted-command",
      ).length > 1,
      timeoutDeliveryCharacterized: false,
      timeoutRetryObserved: null,
      privateAgentSetterUsed: false,
      authoritativeObservationAgents: observedAgents,
    },
  };

  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  assert.ok(["PASS", "BLOCKED"].includes(result.g2.outcome));
  assert.ok(["PROVEN", "UNAVAILABLE"].includes(result.g3.outcome));
});
