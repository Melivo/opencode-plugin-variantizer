export const LOGICAL_AGENT_RING = Object.freeze(["luna", "terra", "sol"] as const);

export const AGENT_MODEL_BINDINGS = Object.freeze({
  luna: "openai/gpt-5.6-luna",
  terra: "openai/gpt-5.6-terra",
  sol: "openai/gpt-5.6-sol",
} as const);

export type RingAgentID = keyof typeof AGENT_MODEL_BINDINGS;
