import { writeFileSync } from "node:fs";

import { resolveContractVariants } from "./variant-validation.mjs";

const evidencePath = process.env.CONTRACT_EVIDENCE_PATH;
const configuredVariants = Object.freeze({
  low: Object.freeze({ reasoningEffort: "low" }),
  high: Object.freeze({ reasoningEffort: "high" }),
});

const trace = {
  events: [],
  fakeTypeSafeCalls: 0,
  logs: [],
  persistedFields: [],
};
const decisions = new Map();

function persistEvidence() {
  if (!evidencePath) throw new Error("CONTRACT_EVIDENCE_PATH is required");
  writeFileSync(evidencePath, `${JSON.stringify(trace, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

const fakeTypeSafeClient = Object.freeze({
  score(catalog) {
    trace.fakeTypeSafeCalls += 1;
    return Object.hasOwn(catalog, "high") ? "high" : Object.keys(catalog)[0];
  },
});

export const ContractSpikePlugin = async () => ({
  "chat.message": async (input, output) => {
    trace.events.push("chat.message");
    trace.chatMessageID = output.message.id;

    if (input.model?.providerID !== "openai") {
      trace.provider = input.model?.providerID ?? null;
      trace.variantSource = "bypassed";
      persistEvidence();
      return;
    }

    const catalog = configuredVariants;
    const selected = fakeTypeSafeClient.score(catalog);
    decisions.set(output.message.id, { selected });
    trace.provider = "openai";
    trace.selected = selected;
    persistEvidence();
  },

  "chat.params": async (input, output) => {
    trace.events.push("chat.params");
    trace.chatParamsMessageID = input.message.id;

    if (input.model.providerID !== "openai") {
      trace.provider = input.model.providerID;
      persistEvidence();
      return;
    }

    const { catalog, source } = resolveContractVariants(input.model.variants, configuredVariants);
    trace.variantSource = source;
    trace.validatedVariants = Object.keys(catalog).sort();

    const decision = decisions.get(input.message.id);
    if (!decision || !Object.hasOwn(catalog, decision.selected)) {
      throw new Error("message correlation or selected variant contract failed");
    }

    // Simulate an option supplied by another plugin, then perform the same
    // preserving field merge required of the future product implementation.
    output.options.store = false;
    Object.assign(output.options, catalog[decision.selected]);
    trace.appliedOptionKeys = Object.keys(catalog[decision.selected]).sort();
    trace.foreignOptionPreserved = output.options.store === false;
    persistEvidence();
  },
});
