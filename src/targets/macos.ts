import { chmodSync, cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { human, log, sizeOf } from "../util.ts";
import { darwinVersion, pickIcon, slug, type Step, type Target } from "./index.ts";

function infoPlist(ctx: Parameters<Target["prepare"]>[0], execName: string, iconName?: string): string {
  const bundleId = ctx.config.packaging.macBundleId ?? ctx.config.appId;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${ctx.config.productName}</string>
  <key>CFBundleDisplayName</key><string>${ctx.config.productName}</string>
  <key>CFBundleIdentifier</key><string>${bundleId}</string>
  <key>CFBundleExecutable</key><string>${execName}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${darwinVersion(ctx.config.version)}</string>
  <key>CFBundleVersion</key><string>${darwinVersion(ctx.config.version)}</string>
${iconName ? `  <key>CFBundleIconFile</key><string>${iconName}</string>\n` : ""}  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict>
</plist>
`;
}

const LAUNCH_SCRIPT = `#!/bin/sh
# Finder launches bundle executables with no arguments, so the role must be explicit.
HERE="$(cd "$(dirname "$0")" && pwd)"
unset DYLD_LIBRARY_PATH DYLD_INSERT_LIBRARIES
exec "$HERE/../Resources/app/bin/backend" --role=launcher "$@"
`;

export const macAppTarget: Target = {
  id: "app",
  label: "macOS .app bundle",
  platforms: ["darwin"],
  async prepare(ctx) {
    const exeName = ctx.config.productName.replace(/[^A-Za-z0-9 .-]/g, "");
    const bundle = join(ctx.buildDir, "macos", `${exeName}.app`);
    const contents = join(bundle, "Contents");
    mkdirSync(join(contents, "MacOS"), { recursive: true });
    mkdirSync(join(contents, "Resources"), { recursive: true });

    cpSync(ctx.app.root, join(contents, "Resources", "app"), { recursive: true });

    const icon = pickIcon(ctx, [256, 128, 512, 96, 48]);
    const iconName = icon ? `${slug(ctx.config)}.png` : undefined;
    if (icon) cpSync(icon, join(contents, "Resources", iconName!));

    await Bun.write(join(contents, "Info.plist"), infoPlist(ctx, exeName, iconName));

    const launcher = join(contents, "MacOS", exeName);
    await Bun.write(launcher, LAUNCH_SCRIPT);
    chmodSync(launcher, 0o755);

    log.ok(`bundle prepared at ${bundle} (${human(sizeOf(bundle))})`);
    return bundle;
  },
  plan(ctx, bundle): Step[] {
    const identity = process.env.FIRESHELL_MAC_SIGN_ID;
    if (!identity) {
      log.warn("FIRESHELL_MAC_SIGN_ID not set: bundle will be unsigned (Gatekeeper will block distribution)");
      return [];
    }
    return [
      { note: "deep signing covers the bundled Gecko runtime and its helper apps", cmd: ["codesign", "--deep", "--force", "--options", "runtime", "--timestamp", "--sign", identity, bundle] },
      { cmd: ["codesign", "--verify", "--deep", "--strict", bundle] },
    ];
  },
};

export const dmgTarget: Target = {
  id: "dmg",
  label: "macOS disk image",
  platforms: ["darwin"],
  async prepare(ctx) {
    // The dmg wraps the .app; build it through the same code path so the two never diverge.
    return macAppTarget.prepare(ctx);
  },
  plan(ctx, bundle): Step[] {
    const out = ctx.artifactName("dmg");
    return [
      {
        note: "UDZO = compressed read-only; add an Applications symlink for the drag-to-install affordance",
        cmd: [
          "hdiutil",
          "create",
          "-volname",
          ctx.config.productName,
          "-srcfolder",
          bundle,
          "-ov",
          "-format",
          "UDZO",
          out,
        ],
      },
    ];
  },
};

export function macTargets(): Target[] {
  return [macAppTarget, dmgTarget];
}
