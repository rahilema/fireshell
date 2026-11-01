import { chmodSync, cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FireShellConfig } from "../config.ts";
import { debDepends, DEB_SONAME_MAP } from "../pipeline/native.ts";
import { human, log, sizeOf } from "../util.ts";
import { debArch, desktopEntry, executeSteps, pickIcon, slug, type Step, type Target, type TargetContext } from "./index.ts";

const APP_RUN = `#!/bin/sh
# FireShell AppImage entry point.
# Never let the bundled runtime's library paths leak into the Gecko child process.
HERE="$(dirname "$(readlink -f "$0")")"
unset LD_LIBRARY_PATH LD_PRELOAD LD_AUDIT
exec "$HERE/usr/app/bin/backend" --role=launcher "$@"
`;

export const appImageTarget: Target = {
  id: "appimage",
  label: "AppImage",
  platforms: ["linux"],
  async prepare(ctx) {
    const appDir = join(ctx.buildDir, "appimage", `${slug(ctx.config)}.AppDir`);
    mkdirSync(join(appDir, "usr"), { recursive: true });
    cpSync(ctx.app.root, join(appDir, "usr/app"), { recursive: true });

    await Bun.write(join(appDir, "AppRun"), APP_RUN);
    chmodSync(join(appDir, "AppRun"), 0o755);
    await Bun.write(join(appDir, `${slug(ctx.config)}.desktop`), desktopEntry(ctx.config, "AppRun"));

    const icon = pickIcon(ctx, [512, 256, 128, 96, 48]);
    if (icon) {
      cpSync(icon, join(appDir, `${slug(ctx.config)}.png`));
      cpSync(icon, join(appDir, ".DirIcon"));
    }
    log.ok(`AppDir prepared at ${appDir} (${human(sizeOf(appDir))})`);
    return appDir;
  },
  plan(ctx, appDir): Step[] {
    const out = ctx.artifactName("AppImage");
    return [
      {
        note: "appimagetool needs FUSE on the build host; use --appimage-extract-and-run in CI containers",
        cmd: [
          "appimagetool",
          "--appimage-extract-and-run",
          appDir,
          out,
        ],
        env: { ARCH: process.arch === "arm64" ? "aarch64" : "x86_64" },
      },
    ];
  },
};

export const debTarget: Target = {
  id: "deb",
  label: "Debian package",
  platforms: ["linux"],
  async prepare(ctx) {
    const root = join(ctx.buildDir, "deb", slug(ctx.config));
    const appRoot = join(root, "opt", ctx.config.appId);
    cpSync(ctx.app.root, appRoot, { recursive: true });

    const binDir = join(root, "usr/bin");
    mkdirSync(binDir, { recursive: true });
    const wrapper = join(binDir, slug(ctx.config));
    await Bun.write(wrapper, `#!/bin/sh\nexec "/opt/${ctx.config.appId}/bin/backend" --role=launcher "$@"\n`);
    chmodSync(wrapper, 0o755);

    const appsDir = join(root, "usr/share/applications");
    mkdirSync(appsDir, { recursive: true });
    await Bun.write(join(appsDir, `${slug(ctx.config)}.desktop`), desktopEntry(ctx.config, slug(ctx.config)));

    const icon = pickIcon(ctx, [512, 256, 128, 96, 48]);
    if (icon) {
      const iconsDir = join(root, "usr/share/icons/hicolor/512x512/apps");
      mkdirSync(iconsDir, { recursive: true });
      cpSync(icon, join(iconsDir, `${slug(ctx.config)}.png`));
    }

    const installedKb = Math.ceil(sizeOf(root) / 1024);
    const depends = debDepends(ctx.nativeScans, ctx.config.packaging.debDepends);

    mkdirSync(join(root, "DEBIAN"), { recursive: true });
    await Bun.write(
      join(root, "DEBIAN", "control"),
      [
        `Package: ${slug(ctx.config)}`,
        `Version: ${ctx.config.version}`,
        `Architecture: ${debArch()}`,
        `Maintainer: ${ctx.config.packaging.maintainer}`,
        `Installed-Size: ${installedKb}`,
        `Depends: ${depends.join(", ")}`,
        `Section: utils`,
        `Priority: optional`,
        `Homepage: ${ctx.config.packaging.homepage ?? ""}`,
        `Description: ${ctx.config.packaging.description ?? ctx.config.productName}`,
        ` FireShell desktop application (Bun backend, Gecko frontend).`,
        ``,
      ].join("\n"),
    );

    log.ok(`deb tree prepared (${installedKb} KiB, ${depends.length} runtime deps)`);
    return root;
  },
  plan(ctx, root): Step[] {
    const out = ctx.artifactName("deb");
    return [
      { note: "dpkg-deb produces a reproducible, root-owned archive", cmd: ["dpkg-deb", "--root-owner-group", "-Zxz", "--build", root, out] },
    ];
  },
};

export function linuxTargets(): Target[] {
  return [appImageTarget, debTarget];
}

/** Exposed for `doctor`: sonames the deb target knows how to translate into Depends. */
export const KNOWN_SONAMES = Object.keys(DEB_SONAME_MAP);
export { executeSteps };
export type { TargetContext, FireShellConfig };
