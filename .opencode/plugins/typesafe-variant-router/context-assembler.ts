export type ContextMode = "prompt-only" | "recent-messages";

export type ContextPolicy = {
  mode: ContextMode;
  maxMessages: number;
  maxChars: number;
};

export type SafeContextMessage = {
  role: "user" | "assistant";
  text: string;
};

export type TypeSafeContext = {
  currentPrompt: string;
  recentMessages: SafeContextMessage[];
  model: string;
};

type ContextInput = {
  currentPrompt: string;
  modelID: string;
  messages: readonly unknown[];
  policy: ContextPolicy;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSafeMessage(value: unknown): SafeContextMessage | undefined {
  if (!isRecord(value)) return undefined;
  const role = value.role;
  if (role !== "user" && role !== "assistant") return undefined;
  if (!Array.isArray(value.parts)) return undefined;

  const texts = value.parts.flatMap((part) => {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return [];
    return part.text.length > 0 ? [part.text] : [];
  });
  if (texts.length === 0) return undefined;
  return { role, text: texts.join("\n") };
}

const ORIENTATION_HEADING = /^## Gortex Session Orientation[ \t]*(?:\r?\n|$)/gm;
const LEVEL_TWO_HEADING = /^##(?:[ \t]+|$)/gm;

export function stripGortexSessionOrientation(text: string): string {
  let result = "";
  let cursor = 0;
  ORIENTATION_HEADING.lastIndex = 0;
  let marker = ORIENTATION_HEADING.exec(text);
  while (marker) {
    result += text.slice(cursor, marker.index);
    LEVEL_TWO_HEADING.lastIndex = ORIENTATION_HEADING.lastIndex;
    const nextHeading = LEVEL_TWO_HEADING.exec(text);
    cursor = nextHeading?.index ?? text.length;
    ORIENTATION_HEADING.lastIndex = cursor;
    marker = ORIENTATION_HEADING.exec(text);
  }
  return marker === null && cursor === 0 ? text : result + text.slice(cursor);
}

function validatePolicy(policy: ContextPolicy): void {
  if (!Number.isSafeInteger(policy.maxMessages) || policy.maxMessages <= 0) {
    throw new RangeError("maxMessages must be a positive integer");
  }
  if (!Number.isSafeInteger(policy.maxChars) || policy.maxChars <= 0) {
    throw new RangeError("maxChars must be a positive integer");
  }
}

export function assembleContext(input: ContextInput): TypeSafeContext {
  validatePolicy(input.policy);
  const currentPrompt = stripGortexSessionOrientation(input.currentPrompt).slice(0, input.policy.maxChars);
  const state: TypeSafeContext = {
    currentPrompt,
    recentMessages: [],
    model: input.modelID,
  };
  if (input.policy.mode === "prompt-only") return state;

  const candidates = input.messages
    .map(readSafeMessage)
    .filter((message): message is SafeContextMessage => message !== undefined)
    .map((message) => ({ ...message, text: stripGortexSessionOrientation(message.text) }))
    .filter((message) => message.text.length > 0)
    .slice(-input.policy.maxMessages);

  let remaining = input.policy.maxChars - currentPrompt.length;
  for (let index = candidates.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const candidate = candidates[index];
    if (!candidate) continue;
    const text = candidate.text.slice(0, remaining);
    if (text.length === 0) continue;
    state.recentMessages.unshift({ role: candidate.role, text });
    remaining -= text.length;
  }
  return state;
}
