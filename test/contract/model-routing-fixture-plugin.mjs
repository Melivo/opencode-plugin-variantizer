import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

export const CANDIDATE_MODEL_IDS = Object.freeze([
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-sol",
]);

const TARGET_MODEL_ID = "openai/gpt-5.6-sol";
const TARGET_VARIANT = "high";
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneSafeJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite registry option");
    return value;
  }
  if (Array.isArray(value)) return value.map(cloneSafeJson);
  if (!isPlainObject(value)) throw new Error("registry option is not plain JSON");
  const clone = {};
  for (const [key, child] of Object.entries(value)) {
    if (unsafeKeys.has(key)) throw new Error("unsafe registry option key");
    clone[key] = cloneSafeJson(child);
  }
  return clone;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function providerData(observation) {
  const data = observation?.data ?? observation;
  if (!isPlainObject(data) || !Array.isArray(data.all)) {
    throw new Error("registry observation has no provider list");
  }
  return data;
}

function candidateFromObservation(observation, modelID) {
  const [providerID, modelName] = modelID.split("/", 2);
  const provider = providerData(observation).all.find((entry) => entry?.id === providerID);
  const model = provider?.models?.[modelName];
  const supportsReasoning = model?.reasoning === true || model?.capabilities?.reasoning === true;
  if (!model || !supportsReasoning || !isPlainObject(model.variants)) {
    throw new Error(`missing runtime reasoning catalog for ${modelID}`);
  }
  const catalog = Object.keys(model.variants);
  if (catalog.length === 0) throw new Error(`empty runtime reasoning catalog for ${modelID}`);
  const variants = {};
  for (const variant of catalog) {
    if (!variant || !isPlainObject(model.variants[variant])) {
      throw new Error(`invalid runtime variant ${modelID}/${variant}`);
    }
    const options = cloneSafeJson(model.variants[variant]);
    if (Object.keys(options).length === 0) throw new Error(`empty runtime options ${modelID}/${variant}`);
    variants[variant] = {
      options,
      optionsFingerprint: fingerprint({ modelID, variant, options }),
    };
  }
  return {
    modelID,
    providerID,
    reasoning: true,
    catalog,
    catalogFingerprint: fingerprint({ modelID, catalog }),
    variants,
  };
}

function summarizeCandidates(observation) {
  try {
    const data = providerData(observation);
    const provider = data.all.find((entry) => entry?.id === "openai");
    return Object.fromEntries(CANDIDATE_MODEL_IDS.map((modelID) => {
      const modelName = modelID.slice("openai/".length);
      const model = provider?.models?.[modelName];
      return [modelID, {
        present: Boolean(model),
        reasoning: model?.reasoning === true || model?.capabilities?.reasoning === true,
        variantKeys: isPlainObject(model?.variants) ? Object.keys(model.variants) : [],
      }];
    }));
  } catch {
    return {};
  }
}

export async function createImmutableRuntimeSnapshot(observeRegistry, now = Date.now) {
  if (typeof observeRegistry !== "function") throw new Error("registry observer is required");
  const observation = await observeRegistry();
  const candidates = {};
  for (const modelID of CANDIDATE_MODEL_IDS) {
    candidates[modelID] = candidateFromObservation(observation, modelID);
  }
  const createdAt = now();
  const snapshot = {
    snapshotID: fingerprint({
      createdAt,
      candidates: CANDIDATE_MODEL_IDS.map((modelID) => ({
        modelID,
        catalogFingerprint: candidates[modelID].catalogFingerprint,
        optionFingerprints: candidates[modelID].catalog.map(
          (variant) => candidates[modelID].variants[variant].optionsFingerprint,
        ),
      })),
    }),
    createdAt,
    candidates,
  };
  return deepFreeze(snapshot);
}

export function verifySnapshotCandidate(snapshot, observation, modelID) {
  const expected = snapshot?.candidates?.[modelID];
  if (!expected) return { ok: false, reason: "candidate-missing" };
  let actual;
  try {
    actual = candidateFromObservation(observation, modelID);
  } catch {
    return { ok: false, reason: "candidate-invalid" };
  }
  if (actual.catalogFingerprint !== expected.catalogFingerprint) {
    return { ok: false, reason: "catalog-fingerprint-drift" };
  }
  for (const variant of expected.catalog) {
    if (actual.variants[variant].optionsFingerprint !== expected.variants[variant].optionsFingerprint) {
      return { ok: false, reason: "options-fingerprint-drift" };
    }
  }
  return { ok: true };
}

function modelKey(model) {
  const modelID = model?.modelID ?? model?.id;
  if (!model || typeof model.providerID !== "string" || typeof modelID !== "string") {
    throw new Error("message model is not representable");
  }
  return `${model.providerID}/${modelID}`;
}

export function createModelRoutingHooks({
  mode = "success",
  observeRegistry,
  persist = () => {},
  now = Date.now,
} = {}) {
  const trace = {
    events: [],
    paramsObservations: [],
    registryObservationCount: 0,
    logs: [],
    persistedFields: [],
  };
  const decisions = new Map();

  const hooks = {
    "chat.message": async (input, output) => {
      trace.events.push("chat.message");
      trace.chatMessageID = output.message.id;
      const sourceModelID = modelKey(output.message.model);
      const sourceVariant = output.message.variant;
      trace.outputMessageVariantPresent = typeof sourceVariant === "string" && sourceVariant.length > 0;
      trace.source = { modelID: sourceModelID, variant: sourceVariant ?? null };
      trace.optionalInput = {
        modelID: input.model ? modelKey(input.model) : undefined,
        variant: input.variant,
      };

      let snapshot;
      try {
        snapshot = await createImmutableRuntimeSnapshot(async () => {
          trace.registryObservationCount += 1;
          const observation = await observeRegistry();
          trace.registryObservationSummary = summarizeCandidates(observation);
          return observation;
        }, now);
      } catch (error) {
        trace.snapshotPrerequisite = {
          ok: false,
          reason: error instanceof Error ? error.message : "runtime snapshot failed",
        };
        persist(trace);
        return;
      }
      trace.snapshotPrerequisite = { ok: true };
      trace.snapshotID = snapshot.snapshotID;
      trace.candidateCount = Object.keys(snapshot.candidates).length;

      if (mode === "precommit-failure") {
        trace.precommitFailure = true;
        persist(trace);
        return;
      }
      if (mode !== "success") throw new Error(`unsupported fixture mode: ${mode}`);

      const target = snapshot.candidates[TARGET_MODEL_ID];
      if (!target?.catalog.includes(TARGET_VARIANT)) throw new Error("target route is not prevalidated");
      const targetOptions = target.variants[TARGET_VARIANT]?.options;
      if (!targetOptions) throw new Error("target options are not prevalidated");

      output.message.model = { providerID: "openai", modelID: "gpt-5.6-sol" };
      output.message.variant = TARGET_VARIANT;
      trace.committed = { modelID: TARGET_MODEL_ID, variant: TARGET_VARIANT };
      decisions.set(output.message.id, {
        targetModelID: TARGET_MODEL_ID,
        targetVariant: TARGET_VARIANT,
        targetOptions,
        snapshotID: snapshot.snapshotID,
        catalogFingerprint: target.catalogFingerprint,
        optionsFingerprint: target.variants[TARGET_VARIANT].optionsFingerprint,
      });
      persist(trace);
    },

    "chat.params": async (input, output) => {
      trace.events.push("chat.params");
      const decision = decisions.get(input.message.id);
      const observation = {
        messageID: input.message.id,
        boundModelID: modelKey(input.model),
        boundMessageModelID: modelKey(input.message.model),
        boundVariant: input.message.variant ?? null,
        correlatedDecision: Boolean(decision),
      };
      observation.targetRouteVisible = Boolean(decision)
        && observation.boundModelID === decision.targetModelID
        && observation.boundMessageModelID === decision.targetModelID
        && observation.boundVariant === decision.targetVariant;
      trace.paramsObservations.push(observation);

      if (decision && observation.targetRouteVisible) {
        trace.sameMessageRouteVisible = true;
        delete output.options.reasoningEffort;
        delete output.options.textVerbosity;
        Object.assign(output.options, cloneSafeJson(decision.targetOptions));
        trace.appliedOptionKeys = Object.keys(decision.targetOptions).sort();
        trace.appliedCatalogFingerprint = decision.catalogFingerprint;
        trace.appliedOptionsFingerprint = decision.optionsFingerprint;
      }
      persist(trace);
    },
  };
  return { hooks, trace };
}

export const ModelRoutingFixturePlugin = async ({ client, directory }) => {
  const evidencePath = process.env.MODEL_ROUTING_CONTRACT_EVIDENCE_PATH;
  if (!evidencePath) throw new Error("MODEL_ROUTING_CONTRACT_EVIDENCE_PATH is required");
  const persist = (trace) => writeFileSync(evidencePath, `${JSON.stringify(trace, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const { hooks } = createModelRoutingHooks({
    mode: process.env.MODEL_ROUTING_CONTRACT_MODE,
    observeRegistry: async () => {
      const response = await client.provider.list({ query: { directory } });
      if (response?.error) throw new Error("provider registry observation failed");
      return response?.data ?? response;
    },
    persist,
  });
  return hooks;
};
