# Command reference

Install (Bun only — never npm/yarn/pnpm):

```sh
bun add -d @fireshell/cli    # inside a project (recommended)
bun add -g @fireshell/cli    # global `fireshell` binary
bunx @fireshell/cli <command> # one-off, no install
```

Every command resolves `fireshell.config.ts` (or `.json`) by walking up from the current
directory. Run commands from anywhere inside the project.

| Command | Purpose |
|---|---|
| `fireshell init` | create a project folder and scaffold it |
| `fireshell dev` | compile and run against a throwaway profile |
| `fireshell build` | produce `build/<mode>/app` (the tree every packager consumes) |
| `fireshell package` | run a production build and emit installers |
| `fireshell doctor` | check toolchain, runtime, native deps |
| `fireshell clean` | delete build output and caches |
| `fireshell version` | print CLI version |

---

## `fireshell init`

```
fireshell init [folder] [--name=<folder>] [--app-id=<reverse.dns>] [--product-name=<name>] [--force] [--yes]
```

Interactive by default: asks for a **project name** with `inquirer`, then creates that
folder inside the current directory and scaffolds into it.

```sh
$ fireshell init
? Project name my-fireshell-app

creating My Fireshell App in /home/you/code/my-fireshell-app
✓ fireshell.config.ts
✓ README.md
✓ src/main/index.ts
…

next
  cd my-fireshell-app
  bun install
  bun add -g @fireshell/cli
  fireshell doctor
  fireshell dev
```

Generated files (existing ones are kept):

- `fireshell.config.ts` — typed config via `defineConfig()`, with `appId` and `productName`
  derived from the folder name
- `package.json` — private package with `dev` / `build` / `package` / `doctor` / `typecheck`
  scripts and `@types/bun`, so `bun install` is enough for editor types
- `tsconfig.json` — ESNext, `moduleResolution: bundler`, `types: ["bun"]`, strict, `noEmit`
- `.gitignore` — `build/`, `dist/`, `.fireshell/`, `node_modules/`
- `README.md` — project intro, full command reference, structure, role model, packaging matrix
- `src/main/index.ts` — role dispatcher stub (`launcher` / `daemon` / `host`)
- `src/shared/protocol.ts` — request/response/push envelope types
- `src/ui/index.html`, `src/ui/app.js`, `src/ui/fireshell-runtime.js` — IPC bridge over `connectNative`

Flags:

| Flag | Effect |
|---|---|
| `<folder>` / `--name=<folder>` | skip the prompt and use this folder (`.`, or `.` via `--name=.`, scaffolds in place) |
| `--app-id=<reverse.dns>` | override the derived `appId` |
| `--product-name=<name>` | override the derived display name |
| `--force` | write into a non-empty folder, overwriting generated files |
| `--yes` | no prompts; use defaults (also implied when stdin is not a TTY) |

Re-running with `--force` preserves the `appId` and `productName` already recorded in
`fireshell.config.ts` unless you pass the flags explicitly.

## `fireshell dev`

```
fireshell dev [--devtools] [--dry-run]
```

1. Resolves Gecko (`gecko.source: "system"` uses the host Firefox; `"portable"` uses the cache).
2. Compiles the backend unminified to `build/dev/backend`.
3. Stages the UI to `build/dev/ui` with a dev manifest (adds `unsafe-eval` CSP, keeps devtools).
4. Registers the native-messaging host manifest against that binary, for the current user only.
5. Seeds `build/dev/profile` (`user.js` + `chrome/userChrome.css`).
6. Starts `build/dev/backend --role=daemon` with logs on your terminal.
7. Runs `bun x web-ext run --source-dir build/dev/ui --firefox <runtime> --firefox-profile build/dev/profile`.

Edit `src/ui/*` and web-ext reloads the extension. Restart the CLI after changing `src/main/*`
so the backend is recompiled.

`--devtools` forces the toolbox to open. `--dry-run` prints each step without executing it.
`FIRESHELL_DEV=1` is set for the daemon process.

## `fireshell build`

```
fireshell build [--mode=dev|prod] [--dry-run] [--verbose]
```

Default mode is `prod`. Steps, in order:

1. **Runtime** — resolve/cache portable Gecko in the shared cache
   (`$XDG_CACHE_HOME/fireshell/gecko`, default `~/.cache/fireshell/gecko`), verify the
   version floor. Mirrors are tried fastest-first (`download.mozilla.org` CDN, then
   `archive.mozilla.org`) and downloads resume; `aria2c` is used with 8 parallel
   connections when it is installed.
2. **Icons** — `config.icon` is resized with **`Bun.Image`** (no sharp, no native deps) into
   `build/<mode>/icons/` at 16/32/48/64/96/128/256/512 px, plus a PNG-in-ICO `app.ico` for
   Windows. If `Bun.Image` is unavailable the source is copied through per size so packaging
   still succeeds.
3. **Backend** — `bun build --compile --target=<bun-target> --outfile build/<mode>/backend`,
   with `--minify` when `features.stripBackend` is on. Feature flags become `--define`
   constants, so disabled subsystems are removed by dead-code elimination.
4. **UI** — stage `features.uiDir` to `build/<mode>/ui`, copy `icons/48.png` and
   `icons/96.png` into it, generate a `fireshell-background.js` when the project has no
   `background.js` (it opens `uiEntry` in a popup window), and generate `manifest.json`
   with matching `background.scripts` and `icons` entries.
5. **Extension** — `zip` the staged UI to `build/<mode>/app.xpi`.
6. **App tree** — assemble `build/<mode>/app`:
   ```
   app/bin/backend            compiled backend (also the native messaging host)
   app/gecko/                 portable runtime (optional for dev/system builds)
   app/resources/app.xpi      packaged extension
   app/resources/build.json   build metadata
   app/resources/icons/       generated PNGs + app.ico
   app/resources/lib/         bundled shared libraries (rpath target)
   app/resources/native/      dlopen'd .so / .node sidecars
   app/resources/native-host.json.tmpl
   app/profile-seed/          user.js + chrome/userChrome.css
   ```
7. **Native stage** — copy `native.libraries[]` globs into `resources/native/<target>/`.
8. **Native scan** — `ldd` the backend, classify every dependency as `glibc` / `system` /
   `bundled` / `missing`, then set `$ORIGIN` rpath (`native.patchRpath`).
9. **Prune** (prod only, `features.stripGecko`) — remove dictionaries, hyphenation, crash
   reporter, pingsender, updater, DRM modules, extra langpacks; report bytes saved.
10. **Summary** — total tree size, backend size, Gecko version.

```sh
fireshell build                      # production tree
fireshell build --mode=dev           # unpruned, dev-only tree
fireshell build --dry-run            # print commands, change nothing
```

## `fireshell package`

```
fireshell package [--target=appimage,deb,msi,app,dmg] [--dry-run] [--skip-build]
```

Runs `fireshell build --mode=prod` first (skip with `--skip-build`), then for every target:
prepare the intermediate tree, then execute the plan. Targets whose platform does not match
the host are skipped with a warning — there is no cross-building.

Artifacts land in `dist/` as `<ProductName>-<version>-<platform>-<arch>.<ext>`.

| Target | Host | Requires | Output |
|---|---|---|---|
| `appimage` | Linux | `appimagetool` (FUSE, or `--appimage-extract-and-run`) | `*.AppImage` |
| `deb` | Linux | `dpkg-deb` | `*.deb` |
| `msi` | Windows | `wixl` (Linux host) or `candle`/`light` (Windows host); `signtool` to sign | `*.msi` |
| `app` | macOS | — (`codesign` if `FIRESHELL_MAC_SIGN_ID` is set) | `*.app` bundle |
| `dmg` | macOS | `hdiutil` | `*.dmg` |

```sh
fireshell package                                   # uses config.targets
fireshell package --target=deb                      # one target
fireshell package --target=appimage,deb --dry-run   # inspect the command plan
```

Target details:

- **AppImage** — `build/prod/appimage/<slug>.AppDir` with `AppRun`, `.desktop`, icon.
  `AppRun` unsets `LD_LIBRARY_PATH`/`LD_PRELOAD`/`LD_AUDIT` before exec'ing the backend.
- **deb** — `/opt/<appId>/` payload, `/usr/bin/<slug>` wrapper, desktop entry, icon under
  `hicolor/512x512`. `Depends:` is computed from `ldd` sonames plus `packaging.debDepends`.
  Built with `dpkg-deb --root-owner-group -Zxz`, so the tree is root-owned and reproducible.
- **msi** — `build/prod/windows/<slug>.wxs` generated from the app tree with deterministic
  GUIDs (`sha1` of the relative path), per-machine install under `ProgramFiles64Folder`.
- **app** — `build/prod/macos/<Name>.app` with `Contents/MacOS/<Name>` launcher script and
  the app tree under `Contents/Resources/app`. Signing is skipped when the env var is unset,
  and reported as a warning because Gatekeeper will refuse the unsigned bundle.
- **dmg** — wraps the `.app` from the same code path, `hdiutil create -format UDZO`.

## `fireshell doctor`

```
fireshell doctor
```

Prints a check table and exits `1` if anything is blocking. Checks: Bun version, config
validity, Gecko availability/version (cached runtimes only — no network fetch), native-host
registration, distribution mode, required tools (`curl`, `tar`, `zip`), optional tools
(`unzip`, `patchelf`, `dpkg-deb`, `appimagetool`, `wixl`, `hdiutil`, `codesign`, `web-ext`),
and on Linux the glibc version and FUSE availability.

## `fireshell clean`

```
fireshell clean [--cache]
```

Removes `build/` and `dist/`. The Gecko runtime cache is shared across all projects and is
kept unless you pass `--cache`. Reports bytes freed per path. Does not touch `node_modules`
or the registered native host — use the app's uninstaller (or delete the manifest listed by
`doctor`) for that.

---

## Configuration

```ts
// fireshell.config.ts
// defineConfig is optional: it needs `bun add -d @fireshell/cli` and only adds types.
// A plain default export works too — these are the fields it expects.
export default {
  appId: "com.example.app",       // reverse DNS; also the native host name
  productName: "Example",
  version: "1.0.0",
  uiDir: "src/ui",
  uiEntry: "index.html",           // page the app window loads
  mainEntry: "src/main/index.ts",
  icon: "assets/icon.png",

  gecko: {
    source: "portable",           // "system" is dev-only
    channel: "release",           // "release" | "esr"
    version: "128.0",             // or set localPath to an extracted runtime
    extensionId: undefined,       // defaults to "<appId>@fireshell"
    repackOmni: false,            // experimental omni.ja pruning
  },

  features: {
    bunIntegration: true,         // compile backend + register native host
    bulkTransfer: true,           // loopback HTTP tier + http://127.0.0.1/* permission
    pushEvents: true,             // backend -> UI events over the port
    devtools: false,              // keep devtools resources in prod
    pdf: false,                   // keep pdf.js + math fonts
    locales: ["en-US"],           // dictionaries kept; the rest are pruned
    stripGecko: true,
    stripBackend: true,
  },

  native: {
    libraries: [
      { glob: "vendor/*.so*", target: "codec", kind: "system" },
    ],
    allowSystem: ["libc.so.6", "libm.so.6"],   // extend; never shrink blindly
    patchRpath: true,
    strict: true,                 // fail on unresolved ldd entries
  },

  packaging: {
    maintainer: "You <you@example.com>",
    homepage: "https://example.com",
    description: "Example app",
    categories: ["Utility"],
    debDepends: [],
    macBundleId: "com.example.app",
  },

  targets: ["appimage", "deb", "app", "dmg", "msi"],
};
```

Unknown keys are merged (arrays replace, objects deep-merge), so a partial config is valid.

### Compile-time constants

`build` emits these as `bun build --define`, so `if (__FS_BULK__)` branches are removed by
the bundler when the feature is off. Declare them once:

```ts
// src/shared/env.d.ts
declare const __FS_DEV__: boolean;
declare const __FS_BUN__: boolean;
declare const __FS_BULK__: boolean;
declare const __FS_PUSH__: boolean;
declare const __FS_DEVTOOLS__: boolean;
declare const __FS_APP_ID__: string;
declare const __FS_VERSION__: string;
```

## Environment variables

| Variable | Effect |
|---|---|
| `FIRESHELL_BUN_TARGET` | override the compile target, e.g. `bun-linux-x64-musl` |
| `FIRESHELL_BUN_BASELINE` | `1` builds `bun-linux-x64-baseline` (no AVX2 requirement) |
| `FIRESHELL_MAC_SIGN_ID` | codesign identity for `app`/`dmg`; unset means unsigned |
| `FIRESHELL_DEV` | set to `1` for the dev daemon |

## Exit codes

`0` success, `1` failure (including `doctor` reporting a blocking issue), `2` argument misuse
in the entry point. Errors print the message plus a hint line when one is available; pass
`--verbose` to also see the stack.
