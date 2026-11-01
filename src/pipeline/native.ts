import { join, resolve } from "node:path";
import type { NativeConfig } from "../config.ts";
import { FireShellError, capture, log, run } from "../util.ts";

export interface SharedLibInfo {
  name: string;
  path: string | null;
  kind: "system" | "glibc" | "bundled" | "missing";
}

export interface NativeScan {
  binary: string;
  libs: SharedLibInfo[];
  missing: string[];
}

const GLIBC = new Set([
  "libc.so.6", "libm.so.6", "libdl.so.2", "libpthread.so.0", "librt.so.1",
  "libresolv.so.2", "libutil.so.1", "libanl.so.1", "libnsl.so.1",
  "ld-linux-x86-64.so.2", "ld-linux-aarch64.so.1",
]);

/** Soname -> Debian package, used to generate `Depends:` for .deb output. */
export const DEB_SONAME_MAP: Record<string, string> = {
  "libgtk-3.so.0": "libgtk-3-0",
  "libgdk-3.so.0": "libgtk-3-0",
  "libgdk_pixbuf-2.0.so.0": "libgdk-pixbuf-2.0-0",
  "libglib-2.0.so.0": "libglib2.0-0",
  "libgobject-2.0.so.0": "libglib2.0-0",
  "libgio-2.0.so.0": "libglib2.0-0",
  "libX11.so.6": "libx11-6",
  "libX11-xcb.so.1": "libx11-xcb1",
  "libxcb.so.1": "libxcb1",
  "libXcomposite.so.1": "libxcomposite1",
  "libXdamage.so.1": "libxdamage1",
  "libXext.so.6": "libxext6",
  "libXfixes.so.3": "libxfixes3",
  "libXrandr.so.2": "libxrandr2",
  "libXrender.so.1": "libxrender1",
  "libXt.so.6": "libxt6",
  "libnss3.so": "libnss3",
  "libnspr4.so": "libnspr4",
  "libsmime3.so": "libnss3",
  "libssl3.so": "libnss3",
  "libasound.so.2": "libasound2",
  "libdbus-glib-1.so.2": "libdbus-glib-1-2",
  "libdbus-1.so.3": "libdbus-1-3",
  "libatk-1.0.so.0": "libatk1.0-0",
  "libatk-bridge-2.0.so.0": "libatk-bridge2.0-0",
  "libatspi.so.0": "libatspi2.0-0",
  "libcups.so.2": "libcups2",
  "libdrm.so.2": "libdrm2",
  "libgbm.so.1": "libgbm1",
  "libpango-1.0.so.0": "libpango-1.0-0",
  "libpangocairo-1.0.so.0": "libpango-1.0-0",
  "libcairo.so.2": "libcairo2",
  "libfreetype.so.6": "libfreetype6",
  "libfontconfig.so.1": "libfontconfig1",
  "libstdc++.so.6": "libstdc++6",
  "libgcc_s.so.1": "libgcc-s1",
  "libz.so.1": "zlib1g",
  "libffi.so.8": "libffi8",
  "libpulse.so.0": "libpulse0",
};

/** Parses `ldd` output. Never runs against untrusted binaries. */
export async function scanSharedLibs(binary: string, allowSystem: string[]): Promise<NativeScan> {
  const libs: SharedLibInfo[] = [];
  const missing: string[] = [];

  const out = await capture(["ldd", binary]);
  if (out === null) {
    throw new FireShellError(`ldd failed on ${binary}`, "ensure the binary targets this platform");
  }

  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const notFound = /^(\S+)\s+=>\s+not found$/.exec(trimmed);
    if (notFound?.[1]) {
      missing.push(notFound[1]);
      libs.push({ name: notFound[1], path: null, kind: "missing" });
      continue;
    }
    const match = /^(\S+)\s+=>\s+(\S+)(?:\s+\(0x[0-9a-f]+\))?$/.exec(trimmed);
    if (!match) continue;
    const [, name, path] = match;
    if (!name) continue;
    const kind = GLIBC.has(name) ? "glibc" : allowSystem.includes(name) ? "system" : "bundled";
    libs.push({ name, path: path ?? null, kind });
  }

  return { binary, libs, missing };
}

/**
 * Copies declared native artifacts (.node addons, dlopen'd .so files) into the
 * app resource tree. `bun build --compile` inlines JavaScript only; anything
 * loaded through dlopen must exist as a sidecar file at runtime.
 */
export async function stageNativeLibraries(
  root: string,
  resourcesDir: string,
  config: NativeConfig,
): Promise<{ copied: { from: string; to: string; bytes: number }[] }> {
  const copied: { from: string; to: string; bytes: number }[] = [];

  for (const rule of config.libraries) {
    const matches = [...new Bun.Glob(rule.glob).scanSync({ cwd: root, dot: true, onlyFiles: true })];
    if (matches.length === 0) {
      log.warn(`native.libraries glob matched nothing: ${rule.glob}`);
      continue;
    }
    for (const rel of matches) {
      const from = resolve(root, rel);
      const source = Bun.file(from);
      // `to` is intentionally flat: sidecars are located by name at runtime.
      const to = join(resourcesDir, rule.target, rel.split("/").pop() ?? "lib");
      await Bun.write(to, source);
      copied.push({ from, to, bytes: source.size });
    }
  }

  return { copied };
}

/** Sets a $ORIGIN-relative rpath so the app is relocatable after packaging. */
export async function patchRpath(binary: string, relativeLibDir: string, platform = process.platform, dryRun = false) {
  if (platform === "linux") {
    if (!Bun.which("patchelf")) {
      log.warn("patchelf not found; skipping rpath patch (bundle may not be relocatable)");
      return;
    }
    await run(["patchelf", "--set-rpath", `$ORIGIN/${relativeLibDir}`, binary], { dryRun });
  } else if (platform === "darwin") {
    if (!Bun.which("install_name_tool")) {
      log.warn("install_name_tool not found; skipping rpath patch");
      return;
    }
    await run(["install_name_tool", "-add_rpath", `@executable_path/../${relativeLibDir}`, binary], { dryRun });
  }
}

/**
 * Environment the Gecko process must NOT inherit.
 * Electron hits the same problem: a packaged runtime's LD_LIBRARY_PATH leaks into
 * the browser child process and makes it load our libs instead of its own.
 */
export const GECKO_ENV_DENYLIST = [
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LD_AUDIT",
  "DYLD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "PYTHONHOME",
  "PYTHONPATH",
  "NODE_OPTIONS",
];

export function sanitizeEnvForGecko(env: Record<string, string | undefined>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (GECKO_ENV_DENYLIST.includes(key)) continue;
    clean[key] = value;
  }
  return clean;
}

export function debDepends(scans: NativeScan[], extra: string[]): string[] {
  const names = new Set(extra);
  for (const scan of scans) {
    for (const lib of scan.libs) {
      const pkg = DEB_SONAME_MAP[lib.name];
      if (pkg) names.add(pkg);
    }
  }
  names.add("libc6");
  return [...names].sort();
}

export function reportNative(scans: NativeScan[], strict: boolean) {
  for (const scan of scans) {
    const bundled = scan.libs.filter((l) => l.kind === "bundled");
    if (bundled.length > 0) {
      log.warn(`${scan.binary}: depends on libs that will NOT exist on target systems:`);
      for (const lib of bundled) log.dim(`- ${lib.name} (${lib.path ?? "unresolved"})`);
      log.dim("add them to native.libraries, or link statically");
    }
    if (scan.missing.length > 0) {
      const message = `${scan.binary}: unresolved dependencies: ${scan.missing.join(", ")}`;
      if (strict) throw new FireShellError(message, "install the dev packages, or set native.strict = false");
      log.warn(message);
    }
  }
}
