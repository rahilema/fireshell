import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ALL_TARGETS, type TargetId, TARGET_PLATFORMS, loadConfig } from "../config.ts";
import { scanSharedLibs, type NativeScan } from "../pipeline/native.ts";
import { build as runBuild } from "./build.ts";
import { executeSteps, type Target, type TargetContext } from "../targets/index.ts";
import { linuxTargets } from "../targets/linux.ts";
import { macTargets } from "../targets/macos.ts";
import { windowsTargets } from "../targets/windows.ts";
import { FireShellError, log, sizeOf, human } from "../util.ts";

export interface PackageOptions {
  targets?: string[];
  dryRun?: boolean;
  skipBuild?: boolean;
}

function registry(): Target[] {
  return [...linuxTargets(), ...macTargets(), ...windowsTargets()];
}

export async function packageApp(opts: PackageOptions) {
  const { config, root } = await loadConfig();
  const requested = (opts.targets ?? config.targets) as TargetId[];

  for (const id of requested) {
    if (!ALL_TARGETS.includes(id)) {
      throw new FireShellError(`unknown target: ${id}`, `valid targets: ${ALL_TARGETS.join(", ")}`);
    }
  }

  const available = registry();
  const selected: Target[] = [];
  for (const id of requested) {
    const target = available.find((t) => t.id === id);
    if (!target) continue;
    if (!TARGET_PLATFORMS[id].includes(process.platform)) {
      log.warn(`${id} must be built on ${TARGET_PLATFORMS[id].join("/")}; skipping (current: ${process.platform})`);
      continue;
    }
    selected.push(target);
  }
  if (selected.length === 0) {
    throw new FireShellError(
      `no buildable targets for ${process.platform}`,
      "build other platforms in CI: AppImage/deb on ubuntu, app/dmg on macos, msi on windows",
    );
  }

  const result = opts.skipBuild ? null : await runBuild({ mode: "prod", dryRun: opts.dryRun });
  if (!result) {
    throw new FireShellError("--skip-build requires a previous build in build/prod");
  }

  const distDir = join(root, "dist");
  if (!opts.dryRun) mkdirSync(distDir, { recursive: true });

  const nativeScans: NativeScan[] = [];
  if (existsSync(result.app.backend) && process.platform !== "win32") {
    nativeScans.push(await scanSharedLibs(result.app.backend, config.native.allowSystem));
  }

  const ctx: TargetContext = {
    config,
    app: result.app,
    buildDir: result.buildDir,
    distDir,
    platform: process.platform,
    dryRun: opts.dryRun === true,
    nativeScans,
    artifactName(ext: string) {
      const platform = process.platform === "win32" ? "windows" : process.platform;
      return join(distDir, `${config.productName.replace(/\s+/g, "-")}-${config.version}-${platform}-${process.arch}.${ext}`);
    },
  };

  log.title("packaging");
  const artifacts: string[] = [];
  for (const target of selected) {
    log.step(`${target.label} (${target.id})`);
    const prepared = await target.prepare(ctx);
    const steps = target.plan(ctx, prepared);
    await executeSteps(steps, ctx.dryRun);
    // The .app target produces a directory; everything else publishes a single file.
    const produced = target.id === "app" ? prepared : ctx.artifactName(target.id);
    if (!ctx.dryRun && existsSync(produced)) {
      artifacts.push(produced);
      log.ok(`${human(sizeOf(produced))} → ${produced}`);
    }
  }

  log.title("artifacts");
  if (artifacts.length === 0) log.dim(opts.dryRun ? "dry run: nothing written" : "no artifacts produced");
  for (const artifact of artifacts) log.info(artifact);
  return artifacts;
}
