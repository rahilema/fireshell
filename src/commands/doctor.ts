import { existsSync } from "node:fs";
import { loadConfig } from "../config.ts";
import { ensureRuntime } from "../pipeline/gecko.ts";
import { hostLocation } from "../pipeline/host.ts";
import { capture, have, log, platformLabel } from "../util.ts";

interface Check {
  name: string;
  status: "ok" | "warn" | "fail" | "skip";
  detail: string;
}

export async function doctor() {
  const checks: Check[] = [];
  const push = (name: string, status: Check["status"], detail: string) => checks.push({ name, status, detail });

  push("platform", "ok", platformLabel());
  push("bun", "ok", Bun.version);

  const loaded = await loadConfig().catch(() => null);
  if (!loaded) {
    push("config", "fail", "fireshell.config.ts not found (run `fireshell init`)");
  } else {
    const { config } = loaded;
    push("config", "ok", `${config.appId} ${config.version}`);

    try {
      // dryRun avoids a network fetch during diagnostics; a cached runtime is still detected.
      const runtime = await ensureRuntime(config, { dryRun: true });
      push("gecko", "ok", `${runtime.version} (${runtime.source}) at ${runtime.dir}`);
    } catch (err) {
      push("gecko", "fail", err instanceof Error ? err.message : String(err));
    }

    const host = hostLocation(config);
    push(
      "native host",
      existsSync(host.manifestPath) ? "ok" : "warn",
      existsSync(host.manifestPath)
        ? host.manifestPath
        : `not registered — run \`fireshell dev\` once (${host.manifestPath})`,
    );

    if (config.gecko.source === "portable") push("distribution", "ok", "portable runtime (policy/signing must be verified per version)");
    else push("distribution", "warn", 'gecko.source="system" is dev-only; production requires a portable runtime');
  }

  const tools: [string, string, boolean][] = [
    ["curl", "fetch the Gecko runtime", true],
    ["tar", "extract runtime archives", true],
    ["zip", "pack the extension xpi", true],
    ["unzip", "repack omni.ja", false],
    ["patchelf", "relocatable rpath on Linux", false],
    ["dpkg-deb", "build .deb", false],
    ["appimagetool", "build AppImage", false],
    ["wixl", "build MSI on Linux", false],
    ["hdiutil", "build .app/.dmg", false],
    ["codesign", "sign macOS bundles", false],
    ["web-ext", "dev loop", false],
  ];

  for (const [tool, purpose, required] of tools) {
    const ok = have(tool);
    push(`tool:${tool}`, ok ? "ok" : required ? "fail" : "skip", ok ? purpose : `missing — ${purpose}`);
  }

  if (process.platform === "linux") {
    const glibc = await capture(["ldd", "--version"]);
    const version = glibc ? /(\d+\.\d+)$/m.exec(glibc)?.[1] : null;
    push("glibc", version ? "ok" : "warn", version ?? "unknown (statically linked host?)");
    push("fuse", have("fusermount") ? "ok" : "warn", have("fusermount") ? "AppImage can run in place" : "AppImage needs --appimage-extract-and-run");
  }

  const width = Math.max(...checks.map((c) => c.name.length));
  log.title("fireshell doctor");
  for (const check of checks) {
    const mark = check.status === "ok" ? "✓" : check.status === "warn" ? "!" : check.status === "skip" ? "-" : "✗";
    const color = check.status === "ok" ? "green" : check.status === "warn" ? "yellow" : "dim";
    console.log(`  ${mark} ${check.name.padEnd(width)}  \x1b[${color === "green" ? 32 : color === "yellow" ? 33 : 2}m${check.detail}\x1b[0m`);
  }

  const failures = checks.filter((c) => c.status === "fail");
  if (failures.length > 0) {
    log.error(`${failures.length} blocking issue(s)`);
    process.exitCode = 1;
  }
}
