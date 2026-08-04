import { rimrafRetry } from '../../scripts/rimraf-retry.mjs';

/**
 * Clears client/dist before a build.
 *
 * Vite's own `emptyOutDir` does the same thing but without retrying, which fails
 * under OneDrive's sync handles (see scripts/rimraf-retry.mjs). `emptyOutDir` is
 * therefore turned off in vite.config.ts and this runs instead — the output
 * directory still gets emptied every build, so stale content-hashed assets do
 * not pile up.
 */
await rimrafRetry(new URL('../dist/', import.meta.url));
