import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { FireShellConfig } from "../config.ts";
import { nativeHostName } from "../config.ts";
import { nativeHostManifest } from "./layout.ts";
import { FireShellError, log, run } from "../util.ts";

export interface HostLocation {
  /** Directory holding <appId>.json, or null on Windows (registry key instead). */
  dir: string | null;
  manifestPath: string;
  registryKey: string | null;
}

export function hostLocation(config: FireShellConfig, platform = process.platform, home = homedir()): HostLocation {
  const name = nativeHostName(config);
  switch (platform) {
    case "linux": {
      const dir = join(home, ".mozilla", "native-messaging-hosts");
      return { dir, manifestPath: join(dir, `${name}.json`), registryKey: null };
    }
    case "darwin": {
      const dir = join(home, "Library", "Application Support", "Mozilla", "NativeMessagingHosts");
      return { dir, manifestPath: join(dir, `${name}.json`), registryKey: null };
    }
    case "win32": {
      const dir = join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "FireShell");
      return {
        dir,
        manifestPath: join(dir, `${name}.json`),
        registryKey: `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${name}`,
      };
    }
    default:
      throw new FireShellError(`native messaging host registration is unsupported on ${platform}`);
  }
}

/**
 * Registers the native messaging host for the current user.
 * Must run as the user — an installer running as root/system would write to the wrong home.
 */
export async function installNativeHost(config: FireShellConfig, binaryPath: string, opts: { dryRun?: boolean } = {}): Promise<HostLocation> {
  const location = hostLocation(config);
  if (opts.dryRun) {
    log.dim(`$ write ${location.manifestPath} (path=${binaryPath})`);
    if (location.registryKey) log.dim(`$ reg add "${location.registryKey}" /ve /d "${location.manifestPath}" /f`);
    return location;
  }

  if (location.dir) mkdirSync(location.dir, { recursive: true });
  await Bun.write(location.manifestPath, JSON.stringify(nativeHostManifest(config, binaryPath), null, 2));

  if (location.registryKey) {
    await run([
      "reg",
      "add",
      location.registryKey,
      "/ve",
      "/t",
      "REG_SZ",
      "/d",
      location.manifestPath,
      "/f",
    ]);
  }
  log.ok(`native host registered for ${config.appId}`);
  log.dim(location.manifestPath);
  return location;
}

export async function uninstallNativeHost(config: FireShellConfig, opts: { dryRun?: boolean } = {}) {
  const location = hostLocation(config);
  if (opts.dryRun) {
    log.dim(`$ rm ${location.manifestPath}`);
    if (location.registryKey) log.dim(`$ reg delete "${location.registryKey}" /f`);
    return;
  }
  try {
    await Bun.file(location.manifestPath).delete();
  } catch {
    // never registered
  }
  if (location.registryKey) {
    try {
      await run(["reg", "delete", location.registryKey, "/f"]);
    } catch {
      // key already absent
    }
  }
  log.ok(`native host unregistered for ${config.appId}`);
}

export function hasNativeHost(config: FireShellConfig): Promise<boolean> {
  return Bun.file(hostLocation(config).manifestPath).exists();
}
