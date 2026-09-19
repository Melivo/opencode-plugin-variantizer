import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { resolveContractVariants, validatedVariants } from "./variant-validation.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const forbidden = Object.freeze({
  prompt: "CONTRACT_PRIVATE_PROMPT_7f63",
  history: "CONTRACT_PRIVATE_HISTORY_9ac1",
  credential: "CONTRACT_PRIVATE_CREDENTIAL_c42e",
  rawResponse: "CONTRACT_PRIVATE_RAW_RESPONSE_0fd8",
  errorBody: "CONTRACT_PRIVATE_ERROR_BODY_65bb",
});

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
  throw new Error(`timed out waiting for contract evidence: ${path}`);
}

async function startProviderBoundary() {
  const requests = [];
  let resolveRequest;
  const firstRequest = new Promise((resolve) => {
    resolveRequest = resolve;
  });

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
      const captured = { method: request.method, url: request.url, body };
      requests.push(captured);
      resolveRequest(captured);
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: { type: "contract_stop", message: "local contract boundary reached" },
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    firstRequest,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function createFixture(root, baseURL) {
  const configDir = join(root, ".opencode");
  const pluginDir = join(configDir, "plugins");
  await mkdir(pluginDir, { recursive: true });
  await copyFile(join(here, "fixture-plugin.mjs"), join(pluginDir, "contract-spike.mjs"));
  await copyFile(join(here, "variant-validation.mjs"), join(pluginDir, "variant-validation.mjs"));

  const model = {
    name: "Contract model",
    reasoning: true,
    temperature: true,
    tool_call: false,
    limit: { context: 8_192, output: 1_024 },
  };
  await writeFile(join(configDir, "opencode.json"), JSON.stringify({
    plugin: ["./plugins/contract-spike.mjs"],
    provider: {
      openai: {
        options: { baseURL },
        models: {
          "contract-openai": {
            ...model,
            variants: {
              low: { reasoningEffort: "low" },
              high: { reasoningEffort: "high" },
            },
          },
        },
      },
      anthropic: {
        options: { baseURL },
        models: { "contract-anthropic": model },
      },
    },
  }, null, 2));
}

async function runOpenCode({ provider, model }) {
  const root = await mkdtemp(join(tmpdir(), "opencode-contract-spike-"));
  const home = join(root, "home");
  const evidencePath = join(root, `${provider}-evidence.json`);
  const boundary = await startProviderBoundary();
  await mkdir(home, { recursive: true });
  await createFixture(root, boundary.baseURL);

  const child = spawn(process.env.OPENCODE_BIN ?? "opencode", [
    "run",
    "--print-logs",
    "--log-level", "DEBUG",
    "--format", "json",
    "--model", `${provider}/${model}`,
    forbidden.prompt,
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
      CONTRACT_EVIDENCE_PATH: evidencePath,
      OPENAI_API_KEY: forbidden.credential,
      ANTHROPIC_API_KEY: forbidden.credential,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const exit = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));

  try {
    let evidence;
    try {
      evidence = await waitForFile(evidencePath);
    } catch (error) {
      const termination = await Promise.race([
        exit,
        new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: "still-running" }), 100)),
      ]);
      throw new Error([
        error.message,
        `termination=${JSON.stringify(termination)}`,
        `stdout=${stdout}`,
        `stderr=${stderr}`,
      ].join("\n"));
    }
    let request;
    if (provider === "openai") {
      try {
        request = await Promise.race([
          boundary.firstRequest,
          new Promise((_, reject) => setTimeout(() => reject(new Error("provider boundary was not reached")), 15_000)),
        ]);
      } catch (error) {
        const termination = await Promise.race([
          exit,
          new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: "still-running" }), 100)),
        ]);
        throw new Error([
          error.message,
          `termination=${JSON.stringify(termination)}`,
          `stdout=${stdout}`,
          `stderr=${stderr}`,
        ].join("\n"));
      }
    }
    if (provider === "openai") {
      evidence = await waitForFile(evidencePath, (value) => value.events?.includes("chat.params"));
    }
    const termination = await exit;
    return { evidence, request, stdout, stderr, termination };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await boundary.close();
    await rm(root, { recursive: true, force: true });
  }
}

function assertPrivacySafeEvidence(evidence) {
  const serialized = JSON.stringify(evidence);
  for (const [kind, marker] of Object.entries(forbidden)) {
    assert.equal(serialized.includes(marker), false, `${kind} leaked into plugin evidence`);
  }
  assert.deepEqual(evidence.logs, []);
  assert.deepEqual(evidence.persistedFields, []);
}

test("present malformed runtime catalogs fail while absent catalogs use explicit config", () => {
  assert.equal(validatedVariants({ high: "not-options" }), undefined);
  assert.throws(
    () => resolveContractVariants({ high: "not-options" }, { low: { reasoningEffort: "low" } }),
    /runtime variant catalog is present but invalid/,
  );
  assert.deepEqual(
    resolveContractVariants(undefined, { low: { reasoningEffort: "low" } }),
    { catalog: { low: { reasoningEffort: "low" } }, source: "explicit-config" },
  );
});

test("pinned OpenCode runtime satisfies the five hard-gate contracts", { timeout: 50_000 }, async () => {
  const openai = await runOpenCode({ provider: "openai", model: "contract-openai" });

  assert.deepEqual(openai.evidence.events, ["chat.message", "chat.params"], "AC1.1 hook order");
  assert.equal(openai.evidence.chatMessageID, openai.evidence.chatParamsMessageID, "AC1.2 stable message ID");
  assert.ok(openai.evidence.chatMessageID, "AC1.2 must not use a session-ID substitute");
  assert.ok(["runtime", "explicit-config"].includes(openai.evidence.variantSource), "AC1.3 catalog source");
  if (openai.evidence.variantSource === "runtime") {
    assert.ok(openai.evidence.validatedVariants.includes("high"), "AC1.3 runtime catalog contains selected variant");
    assert.ok(openai.evidence.validatedVariants.includes("low"), "AC1.3 runtime catalog is defensively validated");
  } else {
    assert.deepEqual(openai.evidence.validatedVariants, ["high", "low"], "AC1.3 verified explicit catalog");
  }
  assert.equal(openai.evidence.fakeTypeSafeCalls, 1);
  assert.equal(openai.evidence.foreignOptionPreserved, true, "AC1.4 preserving merge");

  assert.equal(typeof openai.request.body, "object", "AC1.4 final provider request body");
  const appliedEffort = openai.request.body.reasoning_effort ?? openai.request.body.reasoning?.effort;
  assert.equal(appliedEffort, "high", "AC1.4 selected option reached final provider boundary");
  assert.equal(openai.request.body.store, false, "AC1.4 foreign option reached final provider boundary");
  assertPrivacySafeEvidence(openai.evidence);

  const nonOpenai = await runOpenCode({ provider: "anthropic", model: "contract-anthropic" });
  assert.equal(nonOpenai.evidence.provider, "anthropic");
  assert.equal(nonOpenai.evidence.variantSource, "bypassed");
  assert.equal(nonOpenai.evidence.fakeTypeSafeCalls, 0, "AC1.5 non-openai bypass");
  assertPrivacySafeEvidence(nonOpenai.evidence);
});
