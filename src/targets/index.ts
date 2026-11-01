import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FireShellConfig, TargetId } from "../config.ts";
import type { NativeScan } from "../pipeline/native.ts";
import type { AppLayout } from "../pipeline/layout.ts";
import { FireShellError, log, run } from "../util.ts";

export interface Step {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Skip instead of failing when the tool is absent (used for optional signing steps). */
  optional?: boolean;
  note?: string;
}

export interface TargetContext {
  config: FireShellConfig;
  app: AppLayout & { bytes: number };
  buildDir: string;
  distDir: string;
  platform: NodeJS.Platform;
  dryRun: boolean;
  nativeScans: NativeScan[];
  artifactName(ext: string): string;
}

export interface Target {
  id: TargetId;
  label: string;
  platforms: NodeJS.Platform[];
  /** Creates the intermediate tree; returns the artifact path the plan will produce. */
  prepare(ctx: TargetContext): Promise<string>;
  /** Commands to turn the prepared tree into the final artifact. */
  plan(ctx: TargetContext, prepared: string): Step[];
}

export async function executeSteps(steps: Step[], dryRun: boolean) {
  for (const step of steps) {
    if (step.note) log.dim(step.note);
    if (step.optional && !Bun.which(step.cmd[0]!)) {
      log.warn(`skipping optional step (missing ${step.cmd[0]}): ${step.cmd.join(" ")}`);
      continue;
    }
    await run(step.cmd, { cwd: step.cwd, env: step.env, dryRun });
  }
}

export function slug(config: FireShellConfig): string {
  return config.productName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function debArch(arch = process.arch): string {
  if (arch === "x64") return "amd64";
  if (arch === "arm64") return "arm64";
  throw new FireShellError(`no deb architecture mapping for ${arch}`);
}

export function desktopEntry(config: FireShellConfig, exec: string): string {
  const categories = config.packaging.categories.join(";");
  return `[Desktop Entry]
Type=Application
Name=${config.productName}
Comment=${config.packaging.description ?? config.productName}
Exec=${exec}
Icon=${slug(config)}
Terminal=false
Categories=${categories};
StartupWMClass=${config.productName}
`;
}

export function darwinVersion(version: string): string {
  return version.split("-")[0] ?? version;
}

/** Highest-priority generated PNG for a packager, falling back to the configured source. */
export function pickIcon(ctx: TargetContext, sizes: number[]): string | null {
  for (const size of sizes) {
    const candidate = join(ctx.app.icons, `${size}.png`);
    if (existsSync(candidate)) return candidate;
  }
  const fallback = ctx.config.icon;
  return fallback && existsSync(fallback) ? fallback : null;
}

/** Generated multi-resolution Windows icon, when Bun.Image produced one. */
export function icoPath(ctx: TargetContext): string | null {
  const candidate = join(ctx.app.icons, "app.ico");
  return existsSync(candidate) ? candidate : null;
}
