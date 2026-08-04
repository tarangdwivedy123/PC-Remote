import legacy from '@vitejs/plugin-legacy';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Build configuration tuned for an old Android phone.
 *
 * Chrome 70 already understands `<script type="module">` (61+), dynamic import
 * (63+) and import.meta (64+), so the phone loads the *modern* bundle and never
 * fetches the legacy one. The modern bundle's syntax level is therefore what
 * actually has to be old enough — see forceModernTarget below for why setting
 * it is less direct than it looks.
 */

/** The syntax floor for the bundle the phone will actually download. */
const MODERN_TARGET = 'es2015';

/**
 * The legacy (`nomodule`) bundle. Its real job is not syntax but the fallback
 * path for a browser that ignores `type="module"` altogether — anything before
 * Chrome 61 — which would otherwise render a blank page with no clue as to why.
 * It costs build time and disk on the PC but zero bytes over the air, since
 * Chrome 70 skips it.
 */
const LEGACY_TARGETS = ['chrome >= 49', 'android >= 5', 'safari >= 10', 'firefox >= 52'];

/**
 * Puts `build.target` back after plugin-legacy takes it.
 *
 * Whenever renderLegacyChunks is enabled, plugin-legacy unconditionally
 * overwrites build.target with its own baseline (es2020 / chrome64 / safari12)
 * and logs "plugin-legacy overrode 'build.target'". So a plain
 * `build: { target: 'es2015' }` in this file is silently discarded.
 *
 * The plugin's own `modernTargets` option is not the answer either: it runs the
 * value through browserslist-to-esbuild, and the earliest ES2015-capable
 * browsers that produces (notably edge15) have `const` bugs that esbuild refuses
 * to work around — the build fails outright with "Transforming const to the
 * configured target environment is not supported yet".
 *
 * Setting the esbuild target directly from a `post` plugin sidesteps both. This
 * only affects the modern chunk's syntax level; the legacy chunk is produced by
 * Babel from LEGACY_TARGETS and is unaffected. es2015 is strictly more
 * conservative than the chrome64 baseline it replaces.
 */
function forceModernTarget(target: string): Plugin {
  return {
    name: 'pcr:force-modern-target',
    enforce: 'post',
    config() {
      return { build: { target } };
    },
  };
}

const AGENT_PORT = Number(process.env.PCR_PORT ?? 8765);
const AGENT_ORIGIN = `http://127.0.0.1:${AGENT_PORT}`;

export default defineConfig({
  plugins: [
    react(),
    legacy({
      targets: LEGACY_TARGETS,
      /**
       * Injects core-js into the *modern* bundle for built-ins the phone lacks
       * (Object.fromEntries, Array.prototype.flat, String.replaceAll, …).
       * Without it the syntax parses and then dies at runtime on a missing
       * method, which is the harder failure to diagnose on a device you cannot
       * easily attach devtools to.
       *
       * Which polyfills get included is decided against the plugin's default
       * baseline of chrome>=64 / chromeAndroid>=64 — deliberately left alone,
       * since 64 sits below the Chrome 70 floor and is therefore conservative
       * in the right direction.
       */
      modernPolyfills: true,
      renderLegacyChunks: true,
    }),
    forceModernTarget(MODERN_TARGET),
  ],

  build: {
    // `target` is deliberately absent: plugin-legacy overwrites it and then
    // warns on every build that it did. forceModernTarget() above sets the same
    // value in a way that actually survives.
    //
    // Without this, esbuild's CSS minifier is free to emit modern colour and
    // nesting syntax that Chrome 70 drops on the floor — silently, with no
    // console error, leaving an unstyled page. plugin-legacy would otherwise
    // default this to chrome61.
    cssTarget: 'chrome70',
    outDir: 'dist',
    // scripts/clean-dist.mjs does this instead, with retries. Vite's version has
    // none, and fails with EPERM when OneDrive still holds the previous build's
    // files open.
    emptyOutDir: false,
    assetsInlineLimit: 4096,
    // terser (not esbuild) because plugin-legacy's SystemJS output needs it.
    minify: 'terser',
    terserOptions: {
      // Safari 10 nested-function-name bug; harmless elsewhere and cheap.
      safari10: true,
    },
    sourcemap: true,
    modulePreload: { polyfill: true },
    rollupOptions: {
      output: {
        // uPlot is the one dependency worth splitting: it is stable, so the
        // phone keeps it cached across app rebuilds. Written as a function
        // rather than an object map so no empty chunk is emitted before the
        // charts actually import it.
        manualChunks(id) {
          if (id.includes('node_modules/uplot')) return 'uplot';
          return undefined;
        },
      },
    },
    // A ~600 KB warning is noise on a LAN where the bundle travels over Wi-Fi in
    // a few milliseconds.
    chunkSizeWarningLimit: 1200,
  },

  server: {
    // 0.0.0.0, so the phone can reach the dev server directly for hot reload.
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: AGENT_ORIGIN,
        changeOrigin: false,
      },
      '/ws': {
        target: AGENT_ORIGIN,
        ws: true,
        changeOrigin: false,
      },
    },
  },

  preview: {
    host: true,
    port: 5174,
  },

  esbuild: {
    // Keep console output: it is how you debug a phone you cannot easily attach
    // devtools to.
    legalComments: 'none',
  },
});
