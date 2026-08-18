/**
 * Agent version, reported in the `hello` frame and /api/health.
 * Kept as a literal rather than read from package.json so it survives bundling
 * into a single file. Bump alongside agent/package.json.
 */
export const AGENT_VERSION = '0.1.2';
