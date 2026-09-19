// @ts-expect-error OpenCode's Bun runtime provides node:crypto; this project intentionally omits Node ambient types.
import { createHash } from "node:crypto";

import {
  AGENT_MODEL_BINDINGS,
  LOGICAL_AGENT_RING,
  type RingAgentID,
} from "./agent-contract.ts";
import { cloneSafeOptions, type JsonValue } from "./safe-json.ts";

export { AGENT_MODEL_BINDINGS, LOGICAL_AGENT_RING, type RingAgentID } from "./agent-contract.ts";

export const OBSERVED_PRIMARY_ORDER = Object.freeze(["luna", "sol", "terra"] as const);
export const AGENT_CYCLE_COMMAND = "agent.cycle.reverse" as const;
type Fingerprints = Readonly<Record<RingAgentID, string>>;
type ImmutableOptions = Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;

export type AgentCatalogInput = Readonly<{
  modelKey: string;
  names: readonly string[];
  runtimeNames: readonly string[];
  optionsByVariant: Readonly<Record<string, unknown>>;
}>;

export type AgentTopologyInput = Readonly<{
  generationID: string;
  orderedPrimaryAgents: readonly string[];
  agentToModel: Readonly<Record<string, string>>;
  behaviorByAgent: Readonly<Record<string, unknown>>;
  providerBoundaryByAgent: Readonly<Record<string, unknown>>;
  catalogsByAgent: Readonly<Record<string, AgentCatalogInput>>;
}>;

export type AgentTopologySnapshot = Readonly<{
  generationID: string;
  orderedPrimaryAgents: typeof OBSERVED_PRIMARY_ORDER;
  logicalRing: typeof LOGICAL_AGENT_RING;
  cycleCommand: typeof AGENT_CYCLE_COMMAND;
  agentToModel: typeof AGENT_MODEL_BINDINGS;
  behaviorFingerprints: Fingerprints;
  behaviorFingerprint: string;
  providerBoundaryFingerprints: Fingerprints;
  providerBoundaryFingerprint: string;
  catalogsByAgent: Readonly<Record<RingAgentID, Readonly<{
    modelKey: string;
    names: readonly string[];
    runtimeNames: readonly string[];
    optionsByVariant: ImmutableOptions;
  }>>>;
  catalogFingerprints: Fingerprints;
  optionsFingerprints: Fingerprints;
  topologyFingerprint: string;
}>;

export type TopologyObservation = Readonly<{
  generationID: string;
  sourceAgent: string;
  sourceModel: string;
  orderedPrimaryAgents: readonly string[];
  agentToModel: Readonly<Record<string, string>>;
  behaviorFingerprint: string;
  providerBoundaryFingerprint: string;
  catalogFingerprints: Readonly<Record<string, string>>;
  optionsFingerprints: Readonly<Record<string, string>>;
}>;

export class AgentTopologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentTopologyError";
  }
}

function canonicalize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AgentTopologyError("fingerprint input contains a non-finite number");
    return value;
  }
  if (typeof value !== "object") throw new AgentTopologyError("fingerprint input is not safe JSON");
  if (seen.has(value)) throw new AgentTopologyError("fingerprint input contains a cycle");
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry) => canonicalize(entry, seen));
    seen.delete(value);
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AgentTopologyError("fingerprint input has an unsupported prototype");
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new AgentTopologyError("fingerprint input contains a forbidden key");
    }
    result[key] = canonicalize(entry, seen);
  }
  seen.delete(value);
  return result;
}

export function fingerprintCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function exactRecordKeys(value: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === LOGICAL_AGENT_RING.length
    && keys.every((key, index) => key === [...LOGICAL_AGENT_RING].sort()[index]);
}

function exactStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
}

function freezeOptions(value: unknown): Readonly<Record<string, JsonValue>> {
  const cloned = cloneSafeOptions(value);
  if (!cloned) throw new AgentTopologyError("catalog options must be a non-empty safe JSON object");
  const freezeValue = (entry: JsonValue): JsonValue => {
    if (Array.isArray(entry)) return Object.freeze(entry.map(freezeValue)) as unknown as JsonValue;
    if (entry !== null && typeof entry === "object") {
      for (const [key, nested] of Object.entries(entry)) entry[key] = freezeValue(nested);
      return Object.freeze(entry);
    }
    return entry;
  };
  return freezeValue(cloned) as Readonly<Record<string, JsonValue>>;
}

function fingerprintsFor(input: Readonly<Record<string, unknown>>, label: string): Fingerprints {
  if (!exactRecordKeys(input)) throw new AgentTopologyError(`${label} must contain exactly the ring agents`);
  const result = Object.fromEntries(LOGICAL_AGENT_RING.map((agent) => [agent, fingerprintCanonical(input[agent])])) as Record<RingAgentID, string>;
  if (new Set(Object.values(result)).size !== 1) throw new AgentTopologyError(`${label} must be equal across ring agents`);
  return Object.freeze(result);
}

export function createAgentTopologySnapshot(input: AgentTopologyInput): AgentTopologySnapshot {
  if (!input.generationID.trim() || input.generationID.length > 256) {
    throw new AgentTopologyError("generationID must be a bounded non-empty string");
  }
  if (!exactStrings(input.orderedPrimaryAgents, OBSERVED_PRIMARY_ORDER)) {
    throw new AgentTopologyError("runtime primaries must match the observed luna, sol, terra order");
  }
  if (!exactRecordKeys(input.agentToModel)) throw new AgentTopologyError("agent bindings must contain exactly the ring agents");
  for (const agent of LOGICAL_AGENT_RING) {
    if (input.agentToModel[agent] !== AGENT_MODEL_BINDINGS[agent]) {
      throw new AgentTopologyError(`invalid model binding for ${agent}`);
    }
  }

  const behaviorFingerprints = fingerprintsFor(input.behaviorByAgent, "canonical behavior");
  const providerBoundaryFingerprints = fingerprintsFor(input.providerBoundaryByAgent, "provider-boundary behavior");
  if (!exactRecordKeys(input.catalogsByAgent)) throw new AgentTopologyError("catalogs must contain exactly the ring agents");

  const catalogs = {} as Record<RingAgentID, AgentTopologySnapshot["catalogsByAgent"][RingAgentID]>;
  const catalogFingerprints = {} as Record<RingAgentID, string>;
  const optionsFingerprints = {} as Record<RingAgentID, string>;
  for (const agent of LOGICAL_AGENT_RING) {
    const catalog = input.catalogsByAgent[agent];
    if (!catalog || catalog.modelKey !== AGENT_MODEL_BINDINGS[agent]) {
      throw new AgentTopologyError(`catalog model binding is invalid for ${agent}`);
    }
    if (catalog.names.length === 0 || new Set(catalog.names).size !== catalog.names.length) {
      throw new AgentTopologyError(`catalog names are malformed for ${agent}`);
    }
    if (catalog.names.some((name) => !name.trim() || name.length > 128)) {
      throw new AgentTopologyError(`catalog name is invalid for ${agent}`);
    }
    if (catalog.runtimeNames.length === 0
      || new Set(catalog.runtimeNames).size !== catalog.runtimeNames.length
      || catalog.runtimeNames.some((name) => !catalog.names.includes(name))) {
      throw new AgentTopologyError(`runtime catalog names are malformed for ${agent}`);
    }
    if (!exactStrings(Object.keys(catalog.optionsByVariant), catalog.names)) {
      throw new AgentTopologyError(`catalog options do not match ordered names for ${agent}`);
    }
    const optionsByVariant = Object.freeze(Object.fromEntries(catalog.names.map((name) => [
      name,
      freezeOptions(catalog.optionsByVariant[name]),
    ]))) as ImmutableOptions;
    const immutableCatalog = Object.freeze({
      modelKey: catalog.modelKey,
      names: Object.freeze([...catalog.names]),
      runtimeNames: Object.freeze([...catalog.runtimeNames]),
      optionsByVariant,
    });
    catalogs[agent] = immutableCatalog;
    catalogFingerprints[agent] = fingerprintCanonical({
      modelKey: immutableCatalog.modelKey,
      names: immutableCatalog.names,
      runtimeNames: immutableCatalog.runtimeNames,
    });
    optionsFingerprints[agent] = fingerprintCanonical(optionsByVariant);
  }

  const immutableCatalogs = Object.freeze(catalogs);
  const immutableCatalogFingerprints = Object.freeze(catalogFingerprints);
  const immutableOptionsFingerprints = Object.freeze(optionsFingerprints);
  const behaviorFingerprint = behaviorFingerprints.luna;
  const providerBoundaryFingerprint = providerBoundaryFingerprints.luna;
  const topologyFingerprint = fingerprintCanonical({
    generationID: input.generationID,
    orderedPrimaryAgents: OBSERVED_PRIMARY_ORDER,
    logicalRing: LOGICAL_AGENT_RING,
    cycleCommand: AGENT_CYCLE_COMMAND,
    agentToModel: AGENT_MODEL_BINDINGS,
    behaviorFingerprint,
    providerBoundaryFingerprint,
    catalogFingerprints: immutableCatalogFingerprints,
    optionsFingerprints: immutableOptionsFingerprints,
  });

  return Object.freeze({
    generationID: input.generationID,
    orderedPrimaryAgents: OBSERVED_PRIMARY_ORDER,
    logicalRing: LOGICAL_AGENT_RING,
    cycleCommand: AGENT_CYCLE_COMMAND,
    agentToModel: AGENT_MODEL_BINDINGS,
    behaviorFingerprints,
    behaviorFingerprint,
    providerBoundaryFingerprints,
    providerBoundaryFingerprint,
    catalogsByAgent: immutableCatalogs,
    catalogFingerprints: immutableCatalogFingerprints,
    optionsFingerprints: immutableOptionsFingerprints,
    topologyFingerprint,
  });
}

export function validateTopologyObservation(
  snapshot: AgentTopologySnapshot,
  observation: TopologyObservation,
): boolean {
  if (!Object.hasOwn(AGENT_MODEL_BINDINGS, observation.sourceAgent)) return false;
  const sourceAgent = observation.sourceAgent as RingAgentID;
  return observation.generationID === snapshot.generationID
    && observation.sourceModel === snapshot.agentToModel[sourceAgent]
    && exactStrings(observation.orderedPrimaryAgents, snapshot.orderedPrimaryAgents)
    && fingerprintCanonical(observation.agentToModel) === fingerprintCanonical(snapshot.agentToModel)
    && observation.behaviorFingerprint === snapshot.behaviorFingerprint
    && observation.providerBoundaryFingerprint === snapshot.providerBoundaryFingerprint
    && fingerprintCanonical(observation.catalogFingerprints) === fingerprintCanonical(snapshot.catalogFingerprints)
    && fingerprintCanonical(observation.optionsFingerprints) === fingerprintCanonical(snapshot.optionsFingerprints);
}
