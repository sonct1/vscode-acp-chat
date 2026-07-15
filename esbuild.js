const fs = require("fs/promises");
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function finalizeAntigravityArtifact() {
  await fs.mkdir("dist/antigravity-acp", { recursive: true });
  await fs.copyFile(
    "src/features/antigravity-agent/vendor/antigravity-acp/LICENSE",
    "dist/antigravity-acp/LICENSE"
  );
  if (production) {
    await fs.rm("dist/antigravity-acp/index.mjs.map", { force: true });
  }
}

const antigravityLicensePlugin = {
  name: "antigravity-license-copy",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length === 0) {
        await finalizeAntigravityArtifact();
      }
    });
  },
};

const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",
  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location == null) return;
        console.error(
          `    ${location.file}:${location.line}:${location.column}:`
        );
      });
      console.log("[watch] build finished");
    });
  },
};

async function main() {
  const extensionCtx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode"],
    logLevel: "warning",
    plugins: [esbuildProblemMatcherPlugin],
  });

  const webviewCtx = await esbuild.context({
    entryPoints: ["src/views/webview/main.ts"],
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "browser",
    outfile: "dist/webview.js",
    logLevel: "warning",
    plugins: [esbuildProblemMatcherPlugin],
  });

  const sessionManagerWebviewCtx = await esbuild.context({
    entryPoints: ["src/features/multi-session/manager-webview.ts"],
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "browser",
    outfile: "dist/session-manager-webview.js",
    logLevel: "warning",
    plugins: [esbuildProblemMatcherPlugin],
  });

  const piAcpCtx = await esbuild.context({
    entryPoints: ["src/features/pi-agent/vendor/pi-acp/src/index.ts"],
    bundle: true,
    format: "esm",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/pi-acp/index.mjs",
    external: ["vscode"],
    logLevel: "warning",
    banner: {
      js: "#!/usr/bin/env node",
    },
    plugins: [esbuildProblemMatcherPlugin],
  });

  const antigravityAcpCtx = await esbuild.context({
    entryPoints: ["src/features/antigravity-agent/vendor/antigravity-acp/index.ts"],
    bundle: true,
    format: "esm",
    target: "node22",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/antigravity-acp/index.mjs",
    external: ["vscode", "node:*"],
    logLevel: "warning",
    plugins: [esbuildProblemMatcherPlugin, antigravityLicensePlugin],
  });

  const swarmAcpCtx = await esbuild.context({
    entryPoints: ["src/features/swarm-agent/adapter/index.ts"],
    bundle: true,
    format: "esm",
    target: "node22",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/swarm-acp/index.mjs",
    external: ["vscode", "node:*"],
    logLevel: "warning",
    banner: {
      js: "#!/usr/bin/env node",
    },
    plugins: [esbuildProblemMatcherPlugin],
  });

  if (watch) {
    await Promise.all([
      extensionCtx.watch(),
      webviewCtx.watch(),
      sessionManagerWebviewCtx.watch(),
      piAcpCtx.watch(),
      antigravityAcpCtx.watch(),
      swarmAcpCtx.watch(),
    ]);
  } else {
    await Promise.all([
      extensionCtx.rebuild(),
      webviewCtx.rebuild(),
      sessionManagerWebviewCtx.rebuild(),
      piAcpCtx.rebuild(),
      antigravityAcpCtx.rebuild(),
      swarmAcpCtx.rebuild(),
    ]);
    await Promise.all([
      extensionCtx.dispose(),
      webviewCtx.dispose(),
      sessionManagerWebviewCtx.dispose(),
      piAcpCtx.dispose(),
      antigravityAcpCtx.dispose(),
      swarmAcpCtx.dispose(),
    ]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
