import { mkdirSync, cpSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { FireShellConfig } from "../config.ts";
import { extensionId } from "../config.ts";
import type { Runtime } from "./gecko.ts";
import { human, log, sizeOf } from "../util.ts";

export interface AppLayout {
  root: string;
  backend: string;
  gecko: string;
  resources: string;
  icons: string;
  uiDir: string;
  profileSeed: string;
}

export function appLayout(buildDir: string, platform = process.platform): AppLayout {
  const exe = platform === "win32" ? "backend.exe" : "backend";
  const root = join(buildDir, "app");
  return {
    root,
    backend: join(root, "bin", exe),
    gecko: join(root, "gecko"),
    resources: join(root, "resources"),
    icons: join(root, "resources", "icons"),
    uiDir: join(buildDir, "ui"),
    profileSeed: join(root, "profile-seed"),
  };
}

/**
 * Prefs written to the isolated profile on every launch. `user.js` is applied by Gecko
 * at startup and takes precedence over prefs.js, so it is the correct place to pin
 * behaviour for a runtime the app owns.
 */
export function prefsFile(config: FireShellConfig, mode: "dev" | "prod"): string {
  const prefs: Record<string, string | number | boolean> = {
    // Pin the runtime: no updates, no telemetry, no background services.
    "app.update.auto": false,
    "app.update.enabled": false,
    "app.update.background.scheduling.enabled": false,
    "datareporting.healthreport.uploadEnabled": false,
    "datareporting.policy.dataSubmissionEnabled": false,
    "toolkit.telemetry.enabled": false,
    "toolkit.telemetry.unified": false,
    "app.shield.optoutstudies.enabled": false,
    "browser.ping-centre.telemetry": false,
    "network.captive-portal-service.enabled": false,
    // No session restore, no new tab page, no first-run noise.
    "browser.startup.page": 0,
    "browser.startup.homepage": "about:blank",
    "browser.startup.homepage_override.mstone": "ignore",
    "browser.sessionstore.resume_from_crash": false,
    "browser.sessionstore.max_resumed_crashes": 0,
    "toolkit.startup.max_resumed_crashes": -1,
    "browser.newtabpage.enabled": false,
    "browser.tabs.warnOnClose": false,
    "browser.shell.checkDefaultBrowser": false,
    "browser.aboutConfig.showWarning": false,
    // Remove product surface the app does not use.
    "identity.fxaccounts.enabled": false,
    "extensions.pocket.enabled": false,
    "browser.discovery.enabled": false,
    "browser.newtabpage.activity-stream.feeds.system.topstories": false,
    // App chrome: userChrome.css is inert without this pref.
    "toolkit.legacyUserProfileCustomizations.stylesheets": true,
    "browser.tabs.inTitlebar": 0,
    "devtools.chrome.enabled": config.features.devtools,
    "devtools.debugger.remote-enabled": false,
    "devtools.selfxss.count": 0,
  };

  if (mode === "dev") {
    Object.assign(prefs, {
      "devtools.toolbox.host": "window",
      "devtools.inspector.enabled": true,
      "browser.dom.window.dump.enabled": true,
      "javascript.options.showInConsole": true,
    });
  }

  Object.assign(prefs, config.dev.extraPrefs);
  return Object.entries(prefs)
    .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`)
    .join("\n");
}

/** Hides browser chrome so the window reads as an app. Requires userChrome.css support. */
export const USER_CHROME_CSS = `/* FireShell app shell */
#TabsToolbar, #nav-bar, #PersonalToolbar { visibility: collapse !important; }
#titlebar { -moz-window-dragging: drag; }
#main-window { --lwt-accent-color: #000; --toolbar-bgcolor: transparent; }
`;

export async function writeProfileSeed(
  config: FireShellConfig,
  seedDir: string,
  mode: "dev" | "prod",
  opts: { dryRun?: boolean } = {},
) {
  if (opts.dryRun) return;
  await Bun.write(join(seedDir, "user.js"), `${prefsFile(config, mode)}\n`);
  await Bun.write(join(seedDir, "chrome", "userChrome.css"), USER_CHROME_CSS);
}

/** Native messaging host manifest template; the launcher substitutes BINARY at install time. */
export function nativeHostManifest(config: FireShellConfig, binaryPath: string) {
  return {
    name: config.appId,
    description: `${config.productName} native host`,
    path: binaryPath,
    type: "stdio",
    allowed_extensions: [extensionId(config)],
  };
}

export interface AssembleOptions {
  buildDir: string;
  runtime: Runtime;
  backend: string;
  uiDir: string;
  xpiFile: string;
  mode: "dev" | "prod";
  iconsDir?: string;
  platform?: NodeJS.Platform;
  dryRun?: boolean;
}

/** Builds the platform-independent app directory that every packager consumes. */
export async function assemble(
  config: FireShellConfig,
  opts: AssembleOptions,
): Promise<AppLayout & { bytes: number }> {
  const platform = opts.platform ?? process.platform;
  const layout = appLayout(opts.buildDir, platform);

  if (opts.dryRun) {
    log.dim(`would assemble ${layout.root}`);
    return { ...layout, bytes: 0 };
  }

  rmSync(layout.root, { recursive: true, force: true });
  mkdirSync(join(layout.root, "bin"), { recursive: true });
  mkdirSync(join(layout.resources, "lib"), { recursive: true });
  mkdirSync(join(layout.resources, "native"), { recursive: true });

  cpSync(opts.backend, layout.backend);
  cpSync(opts.xpiFile, join(layout.resources, "app.xpi"));
  if (opts.iconsDir && existsSync(opts.iconsDir)) {
    cpSync(opts.iconsDir, layout.icons, { recursive: true });
  }
  await writeProfileSeed(config, layout.profileSeed, opts.mode);

  await Bun.write(
    join(layout.resources, "native-host.json.tmpl"),
    JSON.stringify(nativeHostManifest(config, "__BINARY__"), null, 2),
  );

  await Bun.write(
    join(layout.resources, "build.json"),
    JSON.stringify(
      {
        appId: config.appId,
        productName: config.productName,
        version: config.version,
        gecko: { version: opts.runtime.version, source: opts.runtime.source },
        features: config.features,
        platform,
        arch: process.arch,
      },
      null,
      2,
    ),
  );

  if (opts.runtime.source === "portable") {
    log.step("copying Gecko runtime");
    cpSync(opts.runtime.dir, layout.gecko, { recursive: true });
  } else {
    log.warn("system Gecko selected: app tree will not be relocatable (dev builds only)");
  }

  const bytes = sizeOf(layout.root);
  log.ok(`app tree assembled (${human(bytes)}) at ${layout.root}`);
  return { ...layout, bytes };
}

export async function seedProfileMissing(seedDir: string): Promise<boolean> {
  return !(await Bun.file(join(seedDir, "user.js")).exists());
}
