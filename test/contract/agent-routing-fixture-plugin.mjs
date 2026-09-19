import { writeFileSync } from "node:fs";

export const AGENT_MODELS = Object.freeze({
  luna: "openai/gpt-5.6-luna",
  terra: "openai/gpt-5.6-terra",
  sol: "openai/gpt-5.6-sol",
});

export const TARGET_TUPLE = Object.freeze({
  agent: "sol",
  modelID: AGENT_MODELS.sol,
  variant: "high",
});

const TARGET_OPTIONS = Object.freeze({
  reasoningEffort: "high",
  textVerbosity: "high",
});

function modelID(model) {
  const id = model?.modelID ?? model?.id;
  if (typeof model?.providerID !== "string" || typeof id !== "string") {
    throw new Error("message model is not representable");
  }
  return `${model.providerID}/${id}`;
}

function compositeKey(sessionID, messageID) {
  if (typeof sessionID !== "string" || sessionID.length === 0) throw new Error("sessionID is required");
  if (typeof messageID !== "string" || messageID.length === 0) throw new Error("messageID is required");
  return `${sessionID}\u0000${messageID}`;
}

function copyTuple(message) {
  return {
    agent: message.agent,
    modelID: modelID(message.model),
    variant: typeof message.model.variant === "string" ? message.model.variant : null,
    variantPresent: Object.hasOwn(message.model, "variant"),
  };
}

function descriptorSummary(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return { present: false };
  return {
    present: true,
    dataProperty: Object.hasOwn(descriptor, "value"),
    writable: descriptor.writable === true,
    enumerable: descriptor.enumerable === true,
    configurable: descriptor.configurable === true,
    accessor: typeof descriptor.get === "function" || typeof descriptor.set === "function",
  };
}

function assertWritableTupleSurface(message) {
  for (const key of ["agent", "model"]) {
    const descriptor = Object.getOwnPropertyDescriptor(message, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.writable !== true) {
      throw new Error(`output.message.${key} is not an ordinary writable data property`);
    }
  }

}

function commitTupleSynchronously(message) {
  assertWritableTupleSurface(message);
  message.agent = TARGET_TUPLE.agent;
  message.model = { providerID: "openai", modelID: "gpt-5.6-sol", variant: TARGET_TUPLE.variant };
  const committed = copyTuple(message);
  if (
    committed.agent !== TARGET_TUPLE.agent
    || committed.modelID !== TARGET_TUPLE.modelID
    || committed.variant !== TARGET_TUPLE.variant
  ) {
    throw new Error("complete target tuple was not synchronously visible after commit");
  }
  return committed;
}

function cloneTargetOptions() {
  return { ...TARGET_OPTIONS };
}

export function createAgentRoutingHooks({ mode = "success", persist = () => {} } = {}) {
  const decisions = new Map();
  const invocationCounts = new Map();
  let turnOrder = 0;
  const trace = {
    events: [],
    messageObservations: [],
    paramsObservations: [],
    aborts: [],
  };

  const save = () => {
    trace.cardinality = {
      committedRoutes: decisions.size,
      chatMessageCalls: trace.messageObservations.length,
      chatParamsCalls: trace.paramsObservations.length,
    };
    persist(trace);
  };

  const hooks = {
    "chat.message": async (input, output) => {
      const message = output.message;
      const key = compositeKey(message.sessionID, message.id);
      const source = copyTuple(message);
      const observation = {
        hook: "chat.message",
        sessionID: message.sessionID,
        messageID: message.id,
        compositeKey: key,
        turnOrder: ++turnOrder,
        source,
        optionalInput: {
          sessionID: input.sessionID,
          agent: input.agent ?? null,
          modelID: input.model ? modelID(input.model) : null,
          variant: input.variant ?? null,
        },
        descriptorsBefore: {
          agent: descriptorSummary(message, "agent"),
          model: descriptorSummary(message, "model"),
          modelVariant: descriptorSummary(message.model, "variant"),
        },
      };
      trace.events.push({ hook: "chat.message", key, turnOrder: observation.turnOrder });
      trace.messageObservations.push(observation);

      if (AGENT_MODELS[source.agent] !== source.modelID) {
        observation.precommitFailure = "source-agent-model-mismatch";
        save();
        return;
      }
      if (mode === "precommit-failure") {
        observation.precommitFailure = "fixture-requested";
        observation.preserved = copyTuple(message);
        save();
        return;
      }
      if (mode !== "success" && mode !== "binding-mismatch") {
        throw new Error(`unsupported fixture mode: ${mode}`);
      }

      const committed = commitTupleSynchronously(message);
      observation.committed = committed;
      observation.descriptorsAfter = {
        agent: descriptorSummary(message, "agent"),
        model: descriptorSummary(message, "model"),
        modelVariant: descriptorSummary(message.model, "variant"),
      };
      decisions.set(key, {
        sessionID: message.sessionID,
        messageID: message.id,
        turnOrder: observation.turnOrder,
        source,
        target: {
          ...TARGET_TUPLE,
          variant: mode === "binding-mismatch" ? "low" : TARGET_TUPLE.variant,
        },
        targetOptions: cloneTargetOptions(),
      });
      save();
    },

    "chat.params": async (input, output) => {
      const key = compositeKey(input.sessionID, input.message.id);
      const decision = decisions.get(key);
      const retry = (invocationCounts.get(key) ?? 0) + 1;
      invocationCounts.set(key, retry);
      const actual = {
        agent: input.agent,
        inputModelID: modelID(input.model),
        messageAgent: input.message.agent,
        messageModelID: modelID(input.message.model),
        variant: typeof input.message.model.variant === "string" ? input.message.model.variant : null,
      };
      const correlated = Boolean(decision);
      const matches = correlated
        && actual.agent === decision.target.agent
        && actual.inputModelID === decision.target.modelID
        && actual.messageAgent === decision.target.agent
        && actual.messageModelID === decision.target.modelID
        && actual.variant === decision.target.variant;
      const observation = {
        hook: "chat.params",
        sessionID: input.sessionID,
        messageID: input.message.id,
        compositeKey: key,
        retry,
        correlated,
        turnOrder: decision?.turnOrder ?? null,
        actual,
        expected: decision?.target ?? null,
        completeTupleVisible: matches,
      };
      trace.events.push({ hook: "chat.params", key, retry });
      trace.paramsObservations.push(observation);

      if (decision && !Object.hasOwn(AGENT_MODELS, input.agent)) {
        observation.ancillaryAgent = true;
        observation.completeTupleVisible = false;
        save();
        return;
      }
      if (!decision) {
        save();
        return;
      }
      if (!matches) {
        observation.providerAborted = true;
        trace.aborts.push({ compositeKey: key, reason: "committed-route-mismatch" });
        save();
        throw new Error("committed agent route mismatch before provider invocation");
      }

      delete output.options.reasoningEffort;
      delete output.options.textVerbosity;
      Object.assign(output.options, cloneTargetOptions());
      observation.appliedOptions = cloneTargetOptions();
      observation.targetOnlyOptions = true;
      save();
    },
  };

  return { hooks, trace };
}

export const AgentRoutingFixturePlugin = async () => {
  const evidencePath = process.env.AGENT_ROUTING_CONTRACT_EVIDENCE_PATH;
  if (!evidencePath) throw new Error("AGENT_ROUTING_CONTRACT_EVIDENCE_PATH is required");
  const persist = (trace) => writeFileSync(evidencePath, `${JSON.stringify(trace, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const { hooks } = createAgentRoutingHooks({
    mode: process.env.AGENT_ROUTING_CONTRACT_MODE,
    persist,
  });
  return hooks;
};
