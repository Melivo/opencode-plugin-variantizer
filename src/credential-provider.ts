import { readTypeSafeApiKey } from "./config.ts";

const SECRET_TOOL_TIMEOUT_MS = 5_000;
const SECRET_TOOL_MAX_BUFFER_BYTES = 8_192;

export const SECRET_TOOL_LOOKUP_ARGS = [
  "lookup",
  "service",
  "typesafe",
  "credential",
  "api-key",
] as const;

type SecretToolResult = { stdout: string };

export type CredentialFailureReason =
  | "missing-api-key" | "credential-process-unavailable" | "credential-process-timeout"
  | "credential-output-limit" | "credential-process-failed";

class CredentialLookupError extends Error {
  constructor(readonly reason: Exclude<CredentialFailureReason, "missing-api-key">) {
    super("credential lookup failed");
    this.name = "CredentialLookupError";
  }
}

export type SecretToolExecutor = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; encoding: "utf8"; windowsHide: true },
) => Promise<SecretToolResult>;

export type SecretLookup = () => Promise<string | undefined>;

type BunSubprocess = {
  stdout: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill: () => void;
};

type BunRuntime = {
  spawn: (
    command: readonly string[],
    options: { stdin: "ignore"; stdout: "pipe"; stderr: "ignore" },
  ) => BunSubprocess;
};

const executeSecretTool: SecretToolExecutor = async (file, args, options) => {
  const runtime = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
  if (!runtime) throw new CredentialLookupError("credential-process-unavailable");

  const subprocess = runtime.spawn([file, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = globalThis.setTimeout(() => {
      subprocess.kill();
      reject(new CredentialLookupError("credential-process-timeout"));
    }, options.timeout);
  });
  const collect = async (): Promise<SecretToolResult> => {
    if (!subprocess.stdout) throw new CredentialLookupError("credential-process-failed");
    const reader = subprocess.stdout.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > options.maxBuffer) {
        subprocess.kill();
        throw new CredentialLookupError("credential-output-limit");
      }
      chunks.push(chunk.value);
    }
    if (await subprocess.exited !== 0) throw new CredentialLookupError("credential-process-failed");
    const output = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { stdout: new TextDecoder().decode(output) };
  };

  try {
    return await Promise.race([collect(), timeout]);
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }
};

async function lookupSecretService(
  execute: SecretToolExecutor,
  onFailure?: (reason: Exclude<CredentialFailureReason, "missing-api-key">) => void,
): Promise<string | undefined> {
  try {
    const { stdout } = await execute("secret-tool", SECRET_TOOL_LOOKUP_ARGS, {
      timeout: SECRET_TOOL_TIMEOUT_MS,
      maxBuffer: SECRET_TOOL_MAX_BUFFER_BYTES,
      encoding: "utf8",
      windowsHide: true,
    });
    const value = stdout.trim();
    return value || undefined;
  } catch (error) {
    onFailure?.(error instanceof CredentialLookupError ? error.reason : "credential-process-failed");
    return undefined;
  }
}

export async function lookupTypeSafeApiKeyFromSecretService(
  execute: SecretToolExecutor = executeSecretTool,
): Promise<string | undefined> {
  return lookupSecretService(execute);
}

export async function lookupTypeSafeApiKeyFromSecretServiceWithDiagnostics(
  execute: SecretToolExecutor = executeSecretTool,
  onFailure?: (reason: Exclude<CredentialFailureReason, "missing-api-key">) => void,
): Promise<string | undefined> {
  return lookupSecretService(execute, onFailure);
}

export async function resolveTypeSafeApiKey(
  environment: Readonly<Record<string, string | undefined>>,
  lookup: SecretLookup = lookupTypeSafeApiKeyFromSecretService,
): Promise<string | undefined> {
  return readTypeSafeApiKey(environment) ?? await lookup();
}

export async function resolveTypeSafeApiKeyWithDiagnostics(
  environment: Readonly<Record<string, string | undefined>>,
  onFailure: (reason: CredentialFailureReason) => void,
  lookup: SecretLookup = lookupTypeSafeApiKeyFromSecretService,
): Promise<string | undefined> {
  const inherited = readTypeSafeApiKey(environment);
  if (inherited) return inherited;
  let processFailure = false;
  const value = lookup === lookupTypeSafeApiKeyFromSecretService
    ? await lookupSecretService(executeSecretTool, (reason) => {
        processFailure = true;
        onFailure(reason);
      })
    : await lookup();
  if (!value && !processFailure) onFailure("missing-api-key");
  return value;
}
