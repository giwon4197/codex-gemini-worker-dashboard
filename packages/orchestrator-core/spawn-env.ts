export function sanitizeSpawnEnv(
  env?: Record<string, string | undefined>
): NodeJS.ProcessEnv {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env || process.env)) {
    if (typeof value === 'string') clean[key] = value;
  }
  delete clean.ELECTRON_RUN_AS_NODE;
  delete clean.ELECTRON_NO_ASAR;
  return clean as NodeJS.ProcessEnv;
}
