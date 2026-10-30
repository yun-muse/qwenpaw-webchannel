import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Computed once, when Vite evaluates this config, so every build gets a fresh
 * id while all three constants stay consistent within that build.
 */
const buildInfo = (() => {
  let git = 'unknown';
  try {
    git =
      execSync('git rev-parse --short HEAD', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || 'unknown';
  } catch {
    git = 'unknown';
  }
  return { git, time: new Date().toISOString(), build: `${git}-${Date.now()}` };
})();

/**
 * Emits `version.json` into the real build output directory (never into
 * `public/`, which is copied verbatim and would serve a stale probe).
 */
function versionJsonPlugin(): Plugin {
  let outDir = 'dist';
  return {
    name: 'webchannel-version-json',
    apply: 'build',
    configResolved(config) {
      outDir = isAbsolute(config.build.outDir)
        ? config.build.outDir
        : resolve(config.root, config.build.outDir);
    },
    writeBundle() {
      const payload = {
        build: buildInfo.build,
        git: buildInfo.git,
        time: buildInfo.time,
      };
      writeFileSync(join(outDir, 'version.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    },
  };
}

/**
 * Stamps the build id into the emitted `sw.js`.
 *
 * The worker's cache namespace and its bytes must change together on every
 * deploy: a byte-identical sw.js means `registration.update()` installs
 * nothing, so `activate` would never purge the old caches (M29). The
 * placeholder lives in `public/sw.js`; dev serves it literally and never
 * registers the worker (`startVersionWatch` is a no-op outside PROD).
 */
function serviceWorkerBuildPlugin(): Plugin {
  let outDir = 'dist';
  return {
    name: 'webchannel-sw-build-id',
    apply: 'build',
    configResolved(config) {
      outDir = isAbsolute(config.build.outDir)
        ? config.build.outDir
        : resolve(config.root, config.build.outDir);
    },
    writeBundle() {
      const file = join(outDir, 'sw.js');
      if (!existsSync(file)) return;
      const source = readFileSync(file, 'utf8');
      if (!source.includes('__WE_CHANNEL_BUILD__')) {
        throw new Error('sw.js lost its __WE_CHANNEL_BUILD__ placeholder');
      }
      writeFileSync(file, source.replaceAll('__WE_CHANNEL_BUILD__', buildInfo.build), 'utf8');
    },
  };
}

/**
 * M36: KaTeX ships every one of its 20 font families as woff2 + woff + ttf.
 * The extra formats triple the emitted font payload (~1.05 MiB instead of
 * ~250 KiB) for browsers that all understand woff2. Rewriting the `src:`
 * declaration before Vite's URL pipeline means only woff2 is emitted and
 * hashed; the fonts still ship from our own origin.
 */
function katexWoff2OnlyPlugin(): Plugin {
  return {
    name: 'webchannel-katex-woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('katex') || !id.endsWith('.css')) return undefined;
      return code.replace(
        /src:url\(([^)]+\.woff2)\) format\("woff2"\),url\([^)]+\.woff\) format\("woff"\),url\([^)]+\.ttf\) format\("truetype"\)/g,
        'src:url($1) format("woff2")',
      );
    },
  };
}

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildInfo.build),
    __BUILD_GIT__: JSON.stringify(buildInfo.git),
    __BUILD_TIME__: JSON.stringify(buildInfo.time),
  },
  plugins: [react(), versionJsonPlugin(), serviceWorkerBuildPlugin(), katexWoff2OnlyPlugin()],
  server: { port: 5173 },
});
