import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { compileBackend } from "../pipeline/backend.ts";
import { ensureRuntime } from "../pipeline/gecko.ts";
import { writeProfileSeed } from "../pipeline/layout.ts";
import { installNativeHost } from "../pipeline/host.ts";
import { stageUi } from "../pipeline/ui.ts";
import { FireShellError, have, log, run } from "../util.ts";

export interface DevOptions {
  devtools?: boolean;
  dryRun?: boolean;
}

/**
 * Dev loop:
 *  - compiles the backend unminified into build/dev
 *  - registers the native host manifest against that binary (per-user, absolute path)
 *  - seeds a throwaway profile and hands Firefox to web-ext for add-on reloading
 */
export async function dev(opts: DevOptions) {
  const { config, root } = await loadConfig();
  const buildDir = join(root, "build", "dev");
  const backendPath = join(buildDir, "backend");
  const uiDir = join(buildDir, "ui");
  const profileDir = join(buildDir, "profile");

  if (opts.devtools) config.dev.devtools = true;

  log.title("FireShell dev");
  const runtime = await ensureRuntime(config, { dryRun: opts.dryRun });

  await compileBackend(config, backendPath, "dev", { dryRun: opts.dryRun });
  await stageUi(config, uiDir, "dev", { dryRun: opts.dryRun });

  if (config.features.bunIntegration) {
    await installNativeHost(config, backendPath, { dryRun: opts.dryRun });
  }

  if (!opts.dryRun) {
    mkdirSync(profileDir, { recursive: true });
    writeProfileSeed(config, profileDir, "dev");
  }

  if (!have("bun")) {
    throw new FireShellError("bun is required", "https://bun.sh");
  }

  // The singleton daemon owns the socket; the host role (spawned by Firefox) proxies into it.
  const daemon = Bun.spawn([backendPath, "--role=daemon"], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, FIRESHELL_DEV: "1" },
  });

  const cleanup = () => {
    try {
      daemon.kill();
    } catch {
      // already gone
    }
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  log.step(`starting Firefox (${runtime.version}) with web-ext`);
  if (!existsSync(uiDir)) {
    throw new FireShellError(`ui directory missing: ${uiDir}`);
  }

  const args = [
    "web-ext",
    "run",
    "--source-dir",
    uiDir,
    "--firefox",
    runtime.executable,
    "--firefox-profile",
    profileDir,
    "--keep-profile-changes",
    "--no-input",
  ];

  try {
    await run(["bun", "x", ...args], { dryRun: opts.dryRun });
  } finally {
    cleanup();
  }
}
