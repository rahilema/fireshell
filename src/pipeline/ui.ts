import { existsSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { join, extname } from "node:path";
import type { FireShellConfig } from "../config.ts";
import { extensionId } from "../config.ts";
import type { BuildMode } from "./backend.ts";
import type { IconSet } from "./icon.ts";
import { FireShellError, log, requireTool, run, sizeOf, human } from "../util.ts";

/** Minimum Gecko that understands browser_specific_settings + policies.json ExtensionSettings. */
const STRICT_MIN_VERSION = "115.0";

export interface ExtensionManifest extends Record<string, unknown> {
  manifest_version: 2;
}

export function buildManifest(
  config: FireShellConfig,
  mode: BuildMode,
  iconFiles: Record<string, string> = {},
): ExtensionManifest {
  const permissions = [
    ...(config.features.bunIntegration ? ["nativeMessaging"] : []),
    // Loopback fetch for the bulk transport tier requires an explicit host permission.
    ...(config.features.bulkTransfer ? ["http://127.0.0.1/*"] : []),
  ];

  // Only the background script belongs here. UI scripts are loaded by index.html;
  // putting them in the background page makes them run against an empty document.
  const backgroundScripts = ["background.js"].filter((s) => existsSync(join(config.uiDir, s)));

  const manifest: ExtensionManifest = {
    manifest_version: 2,
    name: config.productName,
    version: config.version,
    description: config.packaging.description ?? `${config.productName} — built with FireShell`,
    browser_specific_settings: {
      gecko: {
        id: extensionId(config),
        strict_min_version: STRICT_MIN_VERSION,
      },
    },
    permissions: permissions.filter((p) => p.length > 0),
  };

  if (backgroundScripts.length > 0) {
    // MV2 persistent background is load-bearing: an MV3 event page is suspended when
    // idle, which drops the connectNative port.
    manifest.background = { scripts: backgroundScripts, persistent: true };
  }

  if (Object.keys(iconFiles).length > 0) {
    manifest.icons = iconFiles;
  }
  if (mode === "dev") {
    manifest.applications = manifest.browser_specific_settings;
    manifest.content_security_policy = "script-src 'self' 'unsafe-eval'; object-src 'self'";
  }
  return manifest;
}

/**
 * Copies the UI tree and writes the generated manifest.
 * The outcome is platform independent: an unpacked extension directory that can be
 * loaded temporarily (dev) or zipped into an xpi (production).
 */
export async function stageUi(
  config: FireShellConfig,
  outDir: string,
  mode: BuildMode,
  opts: { dryRun?: boolean; icons?: IconSet | null } = {},
): Promise<{ dir: string; manifest: ExtensionManifest }> {
  // Firefox resolves manifest icons relative to the extension root.
  const iconFiles: Record<string, string> = {};

  if (!existsSync(join(config.uiDir, "background.js"))) {
    log.warn("no src/ui/background.js: nothing will open the app window");
  }

  if (!opts.dryRun) {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    if (!existsSync(config.uiDir)) {
      throw new FireShellError(`uiDir does not exist: ${config.uiDir}`, "run `fireshell init`");
    }
    cpSync(config.uiDir, outDir, { recursive: true });

    if (opts.icons) {
      for (const size of [48, 96]) {
        const source = opts.icons.png(size);
        if (!source) continue;
        mkdirSync(join(outDir, "icons"), { recursive: true });
        cpSync(source, join(outDir, "icons", `${size}.png`));
        iconFiles[String(size)] = `icons/${size}.png`;
      }
    }
  }

  const manifest = buildManifest(config, mode, iconFiles);
  if (!opts.dryRun) {
    await Bun.write(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  }
  log.ok(`ui staged at ${outDir}`);
  return { dir: outDir, manifest };
}

/**
 * Packs a staged UI directory into an xpi (a plain zip).
 * NOTE: signature enforcement is a distribution decision, not a packaging one — see docs/distribution.md.
 */
export async function packXpi(
  uiDir: string,
  outFile: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ outFile: string; bytes: number }> {
  if (!opts.dryRun) {
    requireTool("zip", "install zip (Debian: apt install zip)");
    try {
      await Bun.file(outFile).delete();
    } catch {
      // nothing to replace
    }
  }
  log.step(`packing ${extname(outFile).slice(1).toUpperCase()}`);
  // -X strips extra attributes so the archive is byte-stable across machines.
  await run(["zip", "-q", "-r", "-X", outFile, "."], { cwd: uiDir, dryRun: opts.dryRun });
  const bytes = opts.dryRun ? 0 : sizeOf(outFile);
  log.ok(`extension ${human(bytes)} at ${outFile}`);
  return { outFile, bytes };
}
