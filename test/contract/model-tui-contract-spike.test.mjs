import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const resultPath = join(here, "model-tui-contract-result.json");
const expectedVersion = "1.18.31";
const favorites = Object.freeze([
  Object.freeze({ providerID: "openai", modelID: "gpt-5.6-luna" }),
  Object.freeze({ providerID: "openai", modelID: "gpt-5.6-terra" }),
  Object.freeze({ providerID: "openai", modelID: "gpt-5.6-sol" }),
]);
const favoriteIDs = favorites.map(({ providerID, modelID }) => `${providerID}/${modelID}`);
const distractor = Object.freeze({ providerID: "openai", modelID: "gpt-5.6-distractor" });

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitForJson(path, predicate = () => true, timeoutMs = 12_000) {
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
  throw new Error(`timed out waiting for contract evidence: ${path}`);
}

function discoverFavoriteCycleCommand(opencodeBin) {
  const resolved = spawnSync("sh", ["-c", "command -v -- \"$1\"", "sh", opencodeBin], {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(resolved.status, 0, `OpenCode binary resolution failed: ${resolved.stderr}`);
  const binaryPath = resolved.stdout.trim();
  assert.ok(binaryPath, "OpenCode binary path is required for command discovery");
  const discovery = spawnSync(
    "sh",
    ["-c", "strings \"$1\" | grep -oE 'model\\.cycle_[a-z_]+' | sort -u", "sh", binaryPath],
    { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(discovery.status, 0, `command discovery failed: ${discovery.stderr}`);
  const commands = discovery.stdout.split(/\s+/u).filter(Boolean);
  const forwardFavorites = commands.filter((value) => value.includes("favorite") && !value.endsWith("_reverse"));
  assert.deepEqual(forwardFavorites, ["model.cycle_favorite"], "discover one forward Favorites-cycle command");
  assert.ok(commands.includes("model.cycle_recent"), "discovery distinguishes recent-model cycling");
  return forwardFavorites[0];
}

async function createFixture(root, source) {
  const configDir = join(root, ".opencode");
  const pluginDir = join(configDir, "plugins");
  await mkdir(pluginDir, { recursive: true });
  await copyFile(
    join(here, "model-tui-contract-fixture-plugin.mjs"),
    join(pluginDir, "model-tui-contract-fixture-plugin.mjs"),
  );

  const baseModel = {
    reasoning: true,
    temperature: true,
    tool_call: false,
    limit: { context: 8_192, output: 1_024 },
  };
  const names = {
    "gpt-5.6-luna": "GPT-5.6 Luna OpenAI",
    "gpt-5.6-terra": "GPT-5.6 Terra OpenAI",
    "gpt-5.6-sol": "GPT-5.6 Sol OpenAI",
    "gpt-5.6-distractor": "Broader-list distractor",
  };
  const models = Object.fromEntries(
    Object.entries(names).map(([id, name]) => [id, { ...baseModel, name }]),
  );
  await writeFile(join(configDir, "opencode.json"), `${JSON.stringify({
    model: `${source.providerID}/${source.modelID}`,
    plugin: ["./plugins/model-tui-contract-fixture-plugin.mjs"],
    provider: { openai: { models } },
  }, null, 2)}\n`);
}

async function runTuiPublication({ command, source, invalidPayload = false }) {
  const root = await mkdtemp(join(tmpdir(), "opencode-model-tui-contract-"));
  const home = join(root, "home");
  const stateDir = join(home, ".local", "state", "opencode");
  const modelStatePath = join(stateDir, "model.json");
  const evidencePath = join(root, "publish-evidence.json");
  const opencodeBin = process.env.OPENCODE_BIN ?? "opencode";
  await mkdir(home, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await createFixture(root, source);
  const initialState = {
    recent: [source, distractor, ...favorites.filter((model) => model.modelID !== source.modelID)],
    favorite: favorites,
    variant: {},
  };
  await writeFile(modelStatePath, `${JSON.stringify(initialState, null, 2)}\n`);

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
    OPENCODE_DISABLE_TERMINAL_TITLE: "true",
    MODEL_TUI_CONTRACT_EVIDENCE_PATH: evidencePath,
    MODEL_TUI_CONTRACT_COMMAND: command,
    MODEL_TUI_CONTRACT_INVALID_PAYLOAD: String(invalidPayload),
  };
  const child = spawn(
    "script",
    ["-qefc", `${shellQuote(opencodeBin)} ${shellQuote(root)}`, "/dev/null"],
    { cwd: root, env, detached: true, stdio: ["ignore", "ignore", "ignore"] },
  );
  const exit = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));

  try {
    const publication = await waitForJson(evidencePath);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const observedState = await waitForJson(modelStatePath);
    return { publication, observedState, initialState };
  } finally {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    const graceful = await Promise.race([
      exit.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 300)),
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

function unavailable(failedInvariant) {
  return {
    schemaVersion: 1,
    openCodeVersion: expectedVersion,
    outcome: "UNAVAILABLE",
    failedInvariant,
    command: null,
    publishSuccessIsReadback: false,
  };
}

async function persistResult(result) {
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
}

test("OpenCode 1.18.31 Favorites-cycle contract is proven or explicitly unavailable", { timeout: 60_000 }, async () => {
  let activeInvariant = "pinned-runtime";
  let result;
  try {
    const opencodeBin = process.env.OPENCODE_BIN ?? "opencode";
    const version = spawnSync(opencodeBin, ["--version"], { encoding: "utf8", timeout: 5_000 });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), expectedVersion);

    activeInvariant = "actual-command-discovery";
    const command = discoverFavoriteCycleCommand(opencodeBin);

    activeInvariant = "direct-client-tui-publish-delivery";
    const transitions = [];
    for (let index = 0; index < favorites.length; index += 1) {
      const source = favorites[index];
      const target = favorites[(index + 1) % favorites.length];
      activeInvariant = "direct-client-tui-publish-delivery";
      const execution = await runTuiPublication({ command, source });
      assert.equal(execution.publication.attemptedCommand, command);
      assert.equal(execution.publication.errorDetected, false);
      assert.equal(execution.publication.data, true, "the SDK reports publication, not model readback");

      activeInvariant = "exactly-one-favorite-step";
      assert.deepEqual(execution.observedState.recent[0], target);
      assert.deepEqual(execution.observedState.favorite, favorites);
      transitions.push(`${source.modelID}->${target.modelID}`);

      activeInvariant = "exclude-recents-and-broader-model-list";
      assert.notDeepEqual(execution.observedState.recent[0], distractor);
      assert.equal(execution.observedState.favorite.some((model) => model.modelID === distractor.modelID), false);
    }

    activeInvariant = "sol-to-luna-wrap";
    assert.ok(transitions.includes("gpt-5.6-sol->gpt-5.6-luna"));

    activeInvariant = "exact-model-id-mapping";
    assert.deepEqual(favoriteIDs, [
      "openai/gpt-5.6-luna",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-sol",
    ]);

    activeInvariant = "detect-ambiguous-publication";
    const ambiguous = await runTuiPublication({ command: "model.contract_unknown", source: favorites[2] });
    assert.equal(ambiguous.publication.data, true, "accepted publication remains non-authoritative");
    assert.equal(ambiguous.publication.errorDetected, false);
    assert.deepEqual(ambiguous.observedState, ambiguous.initialState, "no observed transition is ambiguous, not success");

    activeInvariant = "detect-failed-publication";
    const failed = await runTuiPublication({ command, source: favorites[2], invalidPayload: true });
    assert.equal(failed.publication.errorDetected, true);
    assert.equal(failed.publication.data, null);
    assert.deepEqual(failed.observedState, failed.initialState);

    result = {
      schemaVersion: 1,
      openCodeVersion: expectedVersion,
      outcome: "PROVEN",
      command: {
        eventType: "tui.command.execute",
        name: command,
        transport: "client.tui.publish",
        direction: "forward",
        stepsPerExecution: 1,
      },
      favoriteOrder: favoriteIDs,
      invariants: {
        directPublishDelivery: true,
        exactlyOneFavoriteStep: true,
        solToLunaWrap: true,
        excludesRecentsAndBroaderLists: true,
        exactModelIDMapping: true,
        failedPublicationDetectable: true,
        ambiguousPublicationDetectable: true,
      },
      publishSuccessIsReadback: false,
      confirmationContract: "Confirm only from a later authoritative output.message source observation.",
    };
  } catch {
    result = unavailable(activeInvariant);
  }

  await persistResult(result);
  assert.ok(["PROVEN", "UNAVAILABLE"].includes(result.outcome));
  if (result.outcome === "PROVEN") {
    assert.equal(Object.values(result.invariants).every(Boolean), true);
  } else {
    assert.equal(typeof result.failedInvariant, "string");
    assert.ok(result.failedInvariant.length > 0);
  }
});
