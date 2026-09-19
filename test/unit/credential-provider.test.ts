import { describe, expect, test } from "bun:test";

import {
  lookupTypeSafeApiKeyFromSecretService,
  lookupTypeSafeApiKeyFromSecretServiceWithDiagnostics,
  resolveTypeSafeApiKey,
  resolveTypeSafeApiKeyWithDiagnostics,
  SECRET_TOOL_LOOKUP_ARGS,
  type SecretToolExecutor,
} from "../../src/credential-provider.ts";

describe("TypeSafe credential provider", () => {
  test("prefers the inherited environment and skips Secret Service", async () => {
    let lookupCalls = 0;
    const result = await resolveTypeSafeApiKey(
      { TYPESAFE_API_KEY: "  inherited-key  " },
      async () => {
        lookupCalls += 1;
        return "secret-service-key";
      },
    );

    expect(result).toBe("inherited-key");
    expect(lookupCalls).toBe(0);
  });

  test("uses Secret Service when the environment has no key", async () => {
    let lookupCalls = 0;
    const result = await resolveTypeSafeApiKey({}, async () => {
      lookupCalls += 1;
      return "secret-service-key";
    });

    expect(result).toBe("secret-service-key");
    expect(lookupCalls).toBe(1);
  });

  test("executes a bounded shell-free lookup with the documented attributes", async () => {
    const calls: unknown[] = [];
    const execute: SecretToolExecutor = async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: "  secret-service-key\n" };
    };

    expect(await lookupTypeSafeApiKeyFromSecretService(execute)).toBe("secret-service-key");
    expect(calls).toEqual([{
      file: "secret-tool",
      args: SECRET_TOOL_LOOKUP_ARGS,
      options: {
        timeout: 5_000,
        maxBuffer: 8_192,
        encoding: "utf8",
        windowsHide: true,
      },
    }]);
  });

  test("fails open without exposing command errors or empty output", async () => {
    const privateError = "PRIVATE_SECRET_SERVICE_ERROR_91e7";
    const reject: SecretToolExecutor = async () => {
      throw Object.assign(new Error(privateError), { stderr: privateError, stdout: privateError });
    };
    const blank: SecretToolExecutor = async () => ({ stdout: "  \n" });

    const reasons: string[] = [];
    expect(await lookupTypeSafeApiKeyFromSecretServiceWithDiagnostics(reject, (reason) => reasons.push(reason))).toBeUndefined();
    expect(await lookupTypeSafeApiKeyFromSecretService(blank)).toBeUndefined();
    expect(reasons).toEqual(["credential-process-failed"]);
  });

  test("classifies a missing credential without exposing lookup output", async () => {
    const reasons: string[] = [];
    const result = await resolveTypeSafeApiKeyWithDiagnostics(
      {},
      (reason) => reasons.push(reason),
      async () => undefined,
    );
    expect(result).toBeUndefined();
    expect(reasons).toEqual(["missing-api-key"]);
  });
});
