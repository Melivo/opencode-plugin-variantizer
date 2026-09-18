export function validatedVariants(candidate) {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const entries = Object.entries(candidate);
  if (entries.length === 0) return undefined;

  const result = {};
  for (const [name, options] of entries) {
    if (!name || options === null || typeof options !== "object" || Array.isArray(options)) return undefined;
    if (Object.keys(options).some((key) => ["__proto__", "prototype", "constructor"].includes(key))) {
      return undefined;
    }
    result[name] = { ...options };
  }
  return result;
}

export function resolveContractVariants(runtimeCandidate, configuredVariants) {
  const runtimeVariants = validatedVariants(runtimeCandidate);
  if (runtimeCandidate !== undefined && runtimeVariants === undefined) {
    throw new Error("runtime variant catalog is present but invalid");
  }
  return {
    catalog: runtimeVariants ?? configuredVariants,
    source: runtimeVariants ? "runtime" : "explicit-config",
  };
}
