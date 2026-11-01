import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { FireShellConfig } from "../config.ts";
import { featureDefines } from "../config.ts";
import { run, sizeOf, human, log, FireShellError } from "../util.ts";

export type BuildMode = "dev" | "prod";

export function bunTarget(platform = process.platform, arch = process.arch): string {
  const override = process.env.FIRESHELL_BUN_TARGET;
  if (override) return override;
  const os = platform === "win32" ? "windows" : platform;
  if (!["linux", "darwin", "windows"].includes(os)) {
    throw new FireShellError(`unsupported backend target platform: ${platform}`);
  }
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!cpu) throw new FireShellError(`unsupported backend architecture: ${arch}`);
  // x64-baseline avoids AVX2 requirements on older CPUs; opt in via env for maximum compatibility.
  const baseline = process.env.FIRESHELL_BUN_BASELINE === "1" && cpu === "x64" ? "-baseline" : "";
  return `bun-${os}-${cpu}${baseline}`;
}

export interface BackendBuild {
  outfile: string;
  bytes: number;
  defines: Record<string, string>;
}

/**
 * Compiles the Bun backend into a standalone executable.
 * Feature flags are inlined via --define, so disabled subsystems are removed by the
 * bundler's dead-code elimination instead of being shipped and switched off at runtime.
 */
export async function compileBackend(
  config: FireShellConfig,
  outfile: string,
  mode: BuildMode,
  opts: { dryRun?: boolean } = {},
): Promise<BackendBuild> {
  if (!config.features.bunIntegration) {
    log.warn("features.bunIntegration=false: backend will be a no-op stub (no native messaging host)");
  }

  mkdirSync(dirname(outfile), { recursive: true });
  if (!opts.dryRun) {
    try {
      await Bun.file(outfile).delete();
    } catch {
      // no previous build
    }
  }

  const defines = featureDefines(config, mode);
  const args = ["bun", "build", "--compile", `--target=${bunTarget()}`, "--outfile", outfile, config.mainEntry];

  if (config.features.stripBackend) args.push("--minify");
  args.push("--sourcemap=none");
  for (const [key, value] of Object.entries(defines)) {
    args.push("--define", `${key}=${value}`);
  }

  log.step(`compiling backend (${bunTarget()}, ${mode})`);
  await run(args, { dryRun: opts.dryRun });

  const bytes = opts.dryRun ? 0 : sizeOf(outfile);
  if (!opts.dryRun) log.ok(`backend ${human(bytes)} at ${outfile}`);
  return { outfile, bytes, defines };
}
