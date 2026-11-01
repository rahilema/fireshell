import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { FireShellConfig } from "../config.ts";
import { FireShellError, capture, log, run, sizeOf, human } from "../util.ts";

export interface Runtime {
  /** Directory containing the browser executable and omni.ja. */
  dir: string;
  executable: string;
  version: string;
  source: "portable" | "system";
}

const MIN_GECKO: Record<FireShellConfig["gecko"]["channel"], string> = {
  release: "115",
  esr: "115",
};

/** archive.mozilla.org layout for the host platform. Cross-building a Gecko runtime is not supported. */
function downloadUrl(config: FireShellConfig): string | null {
  const { version, channel } = config.gecko;
  if (!version) return null;
  // ESR releases live under `releases/<version>esr/`, not `releases/esr/<version>/`.
  const releaseDir = channel === "esr" ? `${version}esr` : version;
  const base = `https://archive.mozilla.org/pub/firefox/releases/${releaseDir}`;
  switch (process.platform) {
    case "linux":
      return `${base}/linux-x86_64/en-US/firefox-${version}.tar.bz2`;
    case "darwin":
      return `${base}/mac/en-US/Firefox%20${version}.dmg`;
    case "win32":
      return `${base}/win64/en-US/Firefox%20Setup%20${version}.exe`;
    default:
      return null;
  }
}

export async function detectVersion(executable: string): Promise<string | null> {
  const out = await capture([executable, "--version"]);
  const match = out ? /(\d+\.\d+(?:\.\d+)?)/.exec(out) : null;
  return match?.[1] ?? null;
}

/**
 * Resolves the Gecko runtime for a build.
 * "system" is dev-only by design: production output must not depend on the host browser's
 * version, profile handling, or add-on policy.
 */
export async function ensureRuntime(config: FireShellConfig, opts: { dryRun?: boolean } = {}): Promise<Runtime> {
  if (config.gecko.source === "system") {
    const executable = config.dev.firefoxPath ?? Bun.which("firefox") ?? Bun.which("firefox-esr");
    if (!executable) {
      throw new FireShellError("no system Firefox found", "install Firefox, or set dev.firefoxPath");
    }
    const version = (await detectVersion(executable)) ?? "unknown";
    checkVersion(config, version);
    log.warn(`using system Gecko ${version} (${executable}) — not reproducible; production builds must use source="portable"`);
    return { dir: join(executable, ".."), executable, version, source: "system" };
  }

  const cacheRoot = config.gecko.cacheDir ?? join(process.cwd(), ".fireshell/cache");
  if (config.gecko.localPath) {
    const dir = locateRuntimeRoot(config.gecko.localPath);
    if (!dir) throw new FireShellError(`no browser executable under ${config.gecko.localPath}`);
    const executable = executableIn(dir);
    if (!executable) throw new FireShellError(`no browser executable found in ${dir}`);
    const version = (await detectVersion(executable)) ?? "unknown";
    checkVersion(config, version);
    return { dir, executable, version, source: "portable" };
  }

  const version = config.gecko.version!;
  const cacheDir = join(cacheRoot, `gecko-${config.gecko.channel}-${version}-${process.platform}-${process.arch}`);
  if (existsSync(cacheDir)) {
    const executable = executableIn(cacheDir);
    if (executable) {
      return { dir: cacheDir, executable, version, source: "portable" };
    }
    log.warn(`cached runtime at ${cacheDir} is incomplete; re-fetching`);
    rmSync(cacheDir, { recursive: true, force: true });
  }

  const url = downloadUrl(config);
  if (!url) {
    throw new FireShellError(
      `no download URL for ${process.platform}-${process.arch} at Gecko ${version}`,
      "set gecko.localPath to an extracted runtime instead",
    );
  }
  if (opts.dryRun) {
    log.dim(`$ curl -fL ${url} -o <cache>`);
    return { dir: cacheDir, executable: join(cacheDir, "firefox"), version, source: "portable" };
  }

  mkdirSync(cacheRoot, { recursive: true });
  const archive = join(cacheRoot, basename(new URL(url).pathname));
  log.step(`fetching Gecko ${version} (${config.gecko.channel})`);
  await run(["curl", "-fL", "--retry", "3", "-o", archive, url]);

  const stage = `${cacheDir}.partial`;
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  if (archive.endsWith(".tar.bz2") || archive.endsWith(".tar.xz")) {
    await run(["tar", "-xf", archive, "-C", stage]);
  } else if (archive.endsWith(".dmg")) {
    throw new FireShellError(
      "cannot extract a .dmg on this host",
      "on macOS mount it with `hdiutil attach` and copy Firefox.app, then set gecko.localPath",
    );
  } else if (archive.endsWith(".exe")) {
    throw new FireShellError(
      "cannot extract a Windows installer on this host",
      "use the Firefox zip distribution and set gecko.localPath",
    );
  } else {
    throw new FireShellError(`unsupported Gecko archive format: ${archive}`);
  }

  const located = locateRuntimeRoot(stage);
  if (!located) throw new FireShellError(`Gecko archive did not contain a browser layout`);
  rmSync(cacheDir, { recursive: true, force: true });
  renameSync(located, cacheDir);
  rmSync(stage, { recursive: true, force: true });
  try {
    await Bun.file(archive).delete();
  } catch {
    // archive already gone
  }

  const executable = executableIn(cacheDir);
  if (!executable) throw new FireShellError("fetched runtime has no executable");
  const detected = (await detectVersion(executable)) ?? version;
  checkVersion(config, detected);
  log.ok(`Gecko ${detected} cached at ${cacheDir} (${human(sizeOf(cacheDir))})`);
  return { dir: cacheDir, executable, version: detected, source: "portable" };
}

function checkVersion(config: FireShellConfig, version: string) {
  const [major] = version.split(".");
  const min = MIN_GECKO[config.gecko.channel];
  if (Number(major) < Number(min)) {
    throw new FireShellError(
      `Gecko ${version} is below the ${config.gecko.channel} minimum (${min})`,
      "policies.json ExtensionSettings requires Firefox 91+; MV2 + browser_specific_settings needs 115+",
    );
  }
}

/** Finds the directory that actually holds the browser payload inside an extracted archive. */
export function locateRuntimeRoot(dir: string): string | null {
  if (executableIn(dir)) return dir;
  for (const entry of new Bun.Glob("*").scanSync({ cwd: dir, onlyFiles: false })) {
    const nested = join(dir, entry);
    if (executableIn(nested)) return nested;
  }
  return null;
}

export function executableIn(dir: string): string | null {
  const candidates: Record<string, string[]> = {
    linux: [join(dir, "firefox"), join(dir, "firefox-bin")],
    darwin: [join(dir, "Contents/MacOS/firefox"), join(dir, "MacOS/firefox"), join(dir, "firefox")],
    win32: [join(dir, "firefox.exe")],
  };
  for (const candidate of candidates[process.platform] ?? []) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
