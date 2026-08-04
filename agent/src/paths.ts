import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locates the built client. The agent runs from three different layouts —
 * `tsx` on the TypeScript source, a bundled .mjs in agent/dist, and eventually a
 * packaged executable with the client copied next to it — so this probes rather
 * than assumes.
 */

function thisDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function looksLikeClientBuild(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'index.html')).isFile();
  } catch {
    return false;
  }
}

export interface ClientLocation {
  dir: string | undefined;
  /** Everywhere that was checked, for the error message when nothing is found. */
  searched: string[];
}

export function findClientDir(): ClientLocation {
  const here = thisDir();
  const exeDir = path.dirname(process.execPath);

  const candidates = [
    process.env['PCR_CLIENT_DIR'],
    // tsx on source: agent/src -> client/dist
    path.resolve(here, '..', '..', 'client', 'dist'),
    // bundled: agent/dist -> client/dist
    path.resolve(here, '..', '..', 'client', 'dist'),
    // client copied into the agent's own dist
    path.resolve(here, 'client'),
    path.resolve(here, 'public'),
    // packaged executable with a sibling client folder
    path.resolve(exeDir, 'client'),
    path.resolve(exeDir, 'public'),
    path.resolve(process.cwd(), 'client', 'dist'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  const searched: string[] = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (searched.includes(resolved)) continue;
    searched.push(resolved);
    if (looksLikeClientBuild(resolved)) return { dir: resolved, searched };
  }
  return { dir: undefined, searched };
}

/** Where the bundled Windows helper binaries live (svcl.exe, nircmd.exe). */
export function findVendorDir(): string {
  const override = process.env['PCR_VENDOR_DIR'];
  if (override) return path.resolve(override);
  const here = thisDir();
  const candidates = [
    path.resolve(here, '..', '..', 'vendor'),
    path.resolve(here, 'vendor'),
    path.resolve(path.dirname(process.execPath), 'vendor'),
    path.resolve(process.cwd(), 'vendor'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      continue;
    }
  }
  // Return the conventional location anyway; callers report the missing tool.
  return candidates[0] as string;
}
