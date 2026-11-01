import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { compileBackend, type BuildMode } from "../pipeline/backend.ts";
import { ensureRuntime } from "../pipeline/gecko.ts";
import { buildIcons } from "../pipeline/icon.ts";
import { stageUi, packXpi } from "../pipeline/ui.ts";
import { assemble } from "../pipeline/layout.ts";
import { applyPrune, printPruneReport, repackOmni } from "../pipeline/strip.ts";
import { patchRpath, reportNative, scanSharedLibs, stageNativeLibraries, type NativeScan } from "../pipeline/native.ts";
import { human, log, sizeOf } from "../util.ts";

export interface BuildOptions {
  mode: BuildMode;
  dryRun?: boolean;
  verbose?: boolean;
}

export async function build(opts: BuildOptions) {
  const { config, root } = await loadConfig();
  const buildDir = join(root, "build", opts.mode);

  log.title(`FireShell build (${opts.mode})`);
  log.info(`${config.productName} ${config.version} · ${config.appId}`);

  const runtime = await ensureRuntime(config, { dryRun: opts.dryRun });

  const icons = await buildIcons(config, join(buildDir, "icons"), { dryRun: opts.dryRun });

  const backend = await compileBackend(config, join(buildDir, "backend"), opts.mode, { dryRun: opts.dryRun });

  const ui = await stageUi(config, join(buildDir, "ui"), opts.mode, { dryRun: opts.dryRun, icons });
  const xpi = await packXpi(ui.dir, join(buildDir, "app.xpi"), { dryRun: opts.dryRun });

  const app = await assemble(config, {
    buildDir,
    runtime,
    backend: backend.outfile,
    uiDir: ui.dir,
    xpiFile: xpi.outFile,
    mode: opts.mode,
    iconsDir: icons?.dir,
    dryRun: opts.dryRun,
  });

  // Native artifacts: .node addons and dlopen'd .so files cannot live inside the
  // compiled binary, so they are staged as sidecars and reported explicitly.
  if (!opts.dryRun) {
    const staged = await stageNativeLibraries(root, join(app.resources, "native"), config.native);
    if (staged.copied.length > 0) {
      const bytes = staged.copied.reduce((sum, f) => sum + f.bytes, 0);
      log.ok(`staged ${staged.copied.length} native artifacts (${human(bytes)})`);
    }
  }

  if (!opts.dryRun && (process.platform === "linux" || process.platform === "darwin")) {
    const scans: NativeScan[] = [];
    for (const binary of [app.backend]) {
      const scan = await scanSharedLibs(binary, config.native.allowSystem);
      scans.push(scan);
    }
    reportNative(scans, config.native.strict);
    if (config.native.patchRpath) {
      await patchRpath(app.backend, "../resources/lib", process.platform, opts.dryRun);
    }
  }

  if (opts.mode === "prod" && config.features.stripGecko) {
    log.step("pruning Gecko runtime");
    const report = applyPrune(app.gecko, config.features, process.platform, opts.dryRun);
    printPruneReport(report);
    if (config.gecko.repackOmni) {
      log.warn("repacking omni.ja (experimental; smoke-test this runtime version)");
      await repackOmni(app.gecko, config.features, { dryRun: opts.dryRun });
    }
  }

  const total = opts.dryRun ? 0 : sizeOf(app.root);
  log.title("summary");
  log.info(`app tree   ${human(total)}  ${app.root}`);
  log.info(`backend    ${human(backend.bytes)}`);
  log.info(`gecko      ${runtime.version} (${runtime.source})`);
  log.info(`targets    ${config.targets.join(", ")}`);
  return { config, root, buildDir, app };
}
