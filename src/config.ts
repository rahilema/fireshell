import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { FireShellError } from "./util.ts";

export type TargetId = "appimage" | "deb" | "msi" | "app" | "dmg";
export const ALL_TARGETS: TargetId[] = ["appimage", "deb", "msi", "app", "dmg"];

export interface FeatureConfig {
  /** Compile the Bun backend and register the native messaging host. */
  bunIntegration: boolean;
  /** Loopback HTTP transport for payloads above the native messaging cap. */
  bulkTransfer: boolean;
  /** Backend -> UI push events over the native port. */
  pushEvents: boolean;
  /** Keep devtools resources in the Gecko runtime (forced on in dev). */
  devtools: boolean;
  /** Keep pdf.js in the Gecko runtime. */
  pdf: boolean;
  /** Locales to retain; every other dictionary is pruned. First entry is the UI locale. */
  locales: string[];
  /** Prune unused Gecko resources during `build`/`package`. */
  stripGecko: boolean;
  /** Minify the compiled backend. */
  stripBackend: boolean;
}

export interface GeckoConfig {
  /** "portable" ships a runtime with the app; "system" uses the host Firefox (dev only). */
  source: "portable" | "system";
  channel: "release" | "esr";
  version?: string;
  /** Use an already-extracted runtime instead of downloading. */
  localPath?: string;
  cacheDir?: string;
  /** Extension id; must match allowed_extensions in the native host manifest. */
  extensionId?: string;
  /** Experimental: drop resources from omni.ja. Requires a smoke test per runtime version. */
  repackOmni: boolean;
}

export interface NativeLibraryRule {
  // Glob relative to the project root, in Bun.Glob syntax.
  // Example: vendor/native/libcodec.so
  glob: string;
  /** Subdirectory of resources/ to copy into. */
  target: string;
  /** "node" addons need a matching Bun ABI; "system" .so files are dlopen'd via bun:ffi. */
  kind: "node" | "system";
}

export interface NativeConfig {
  libraries: NativeLibraryRule[];
  /** Sonames that must come from the host and are never bundled. */
  allowSystem: string[];
  /** Set $ORIGIN rpath on bundled executables (Linux) / @executable_path (macOS). */
  patchRpath: boolean;
  /** Fail the build when ldd reports an unresolvable dependency. */
  strict: boolean;
}

export interface PackagingConfig {
  maintainer: string;
  homepage?: string;
  description?: string;
  categories: string[];
  icon?: string;
  /** Extra Debian dependencies beyond the computed ones. */
  debDepends: string[];
  macBundleId?: string;
  windowsManufacturer?: string;
}

export interface DevConfig {
  /** Path to a system Firefox binary; falls back to `firefox` on PATH. */
  firefoxPath?: string;
  /** Extra prefs merged into the dev profile user.js. */
  extraPrefs: Record<string, string | number | boolean>;
  /** Open devtools on start. */
  devtools: boolean;
}

export interface FireShellConfig {
  appId: string;
  productName: string;
  version: string;
  uiDir: string;
  mainEntry: string;
  icon?: string;
  gecko: GeckoConfig;
  features: FeatureConfig;
  native: NativeConfig;
  packaging: PackagingConfig;
  targets: TargetId[];
  dev: DevConfig;
}

export const DEFAULT_CONFIG: FireShellConfig = {
  appId: "com.example.fireshell",
  productName: "FireShell App",
  version: "0.1.0",
  uiDir: "src/ui",
  mainEntry: "src/main/index.ts",
  gecko: {
    source: "portable",
    channel: "release",
    repackOmni: false,
  },
  features: {
    bunIntegration: true,
    bulkTransfer: true,
    pushEvents: true,
    devtools: false,
    pdf: false,
    locales: ["en-US"],
    stripGecko: true,
    stripBackend: true,
  },
  native: {
    libraries: [],
    allowSystem: [
      "libc.so.6",
      "libm.so.6",
      "libdl.so.2",
      "libpthread.so.0",
      "librt.so.1",
      "libresolv.so.2",
      "libgcc_s.so.1",
      "ld-linux-x86-64.so.2",
      "ld-linux-aarch64.so.1",
    ],
    patchRpath: true,
    strict: true,
  },
  packaging: {
    maintainer: "FireShell <builds@fireshell.local>",
    categories: ["Utility"],
    debDepends: [],
  },
  targets: ["appimage", "deb", "app", "dmg"],
  dev: {
    extraPrefs: {},
    devtools: true,
  },
};

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K];
};

/** Identity helper so editors can type-check fireshell.config.ts without a build step. */
export function defineConfig(config: DeepPartial<FireShellConfig>): DeepPartial<FireShellConfig> {
  return config;
}

export interface LoadedConfig {
  config: FireShellConfig;
  root: string;
  configPath: string;
}

/**
 * Loads fireshell.config.ts (preferred) or fireshell.config.json from `cwd` upward.
 * User values are deep-merged over DEFAULT_CONFIG; unknown keys are ignored with a warning.
 */
export async function loadConfig(cwd = process.cwd()): Promise<LoadedConfig> {
  const found = findConfig(cwd);
  if (!found) {
    throw new FireShellError(
      "no fireshell.config.ts or fireshell.config.json found",
      "run `fireshell init` in the project root",
    );
  }
  const { path, root } = found;
  let user: Partial<FireShellConfig>;
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".js")) {
    const mod = await import(`${path}?t=${Date.now()}`);
    user = mod.default ?? mod.config ?? {};
    if (typeof user !== "object" || user === null) {
      throw new FireShellError(`${path} must export a config object (default export or named \`config\`)`);
    }
  } else {
    user = JSON.parse(await Bun.file(path).text());
  }

  const config = merge(DEFAULT_CONFIG, user) as FireShellConfig;
  validate(config);
  return { config: normalizePaths(config, root), root, configPath: path };
}

function findConfig(start: string): { path: string; root: string } | null {
  let dir = resolve(start);
  for (;;) {
    for (const name of ["fireshell.config.ts", "fireshell.config.mts", "fireshell.config.js", "fireshell.config.json"]) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return { path: candidate, root: dir };
    }
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

function merge<T>(base: T, over: unknown): T {
  if (over === undefined) return base;
  if (Array.isArray(base) || Array.isArray(over)) return (over ?? base) as T;
  if (typeof base === "object" && base !== null && typeof over === "object" && over !== null) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(over as Record<string, unknown>)) {
      out[key] = key in out ? merge(out[key], value) : value;
    }
    return out as T;
  }
  return over as T;
}

function validate(config: FireShellConfig) {
  const problems: string[] = [];
  if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/i.test(config.appId)) {
    problems.push(`appId "${config.appId}" must be a reverse-DNS identifier`);
  }
  if (!/^\d+\.\d+\.\d+/.test(config.version)) {
    problems.push(`version "${config.version}" must be semver`);
  }
  if (config.features.locales.length === 0) {
    problems.push("features.locales must list at least one locale");
  }
  if (config.gecko.source === "portable" && !config.gecko.localPath && !config.gecko.version) {
    problems.push("gecko.source=\"portable\" requires gecko.version or gecko.localPath");
  }
  if (problems.length > 0) {
    throw new FireShellError(`invalid fireshell config:\n  - ${problems.join("\n  - ")}`);
  }
}

function normalizePaths(config: FireShellConfig, root: string): FireShellConfig {
  const abs = (p: string) => (isAbsolute(p) ? p : join(root, p));
  return {
    ...config,
    uiDir: abs(config.uiDir),
    mainEntry: abs(config.mainEntry),
    icon: config.icon ? abs(config.icon) : undefined,
    gecko: {
      ...config.gecko,
      localPath: config.gecko.localPath ? abs(config.gecko.localPath) : undefined,
      // User-level by default: one runtime download serves every project.
      cacheDir: config.gecko.cacheDir ? abs(config.gecko.cacheDir) : defaultCacheDir(),
    },
  };
}

/** Shared runtime cache. Override per project with `gecko.cacheDir`. */
export function defaultCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "fireshell", "gecko");
}

/** Extension id used by the manifest and the native host allowlist. */
export function extensionId(config: FireShellConfig): string {
  return config.gecko.extensionId ?? `${config.appId.replace(/[^a-zA-Z0-9._-]/g, "-")}@fireshell`;
}

/**
 * Compile-time constants consumed by the app via `bun build --define`.
 * Declare them in src/shared/env.d.ts so the backend can branch without importing config.
 */
export function featureDefines(config: FireShellConfig, mode: "dev" | "prod"): Record<string, string> {
  const bool = (v: boolean) => (v ? "true" : "false");
  return {
    __FS_DEV__: bool(mode === "dev"),
    __FS_BUN__: bool(config.features.bunIntegration),
    __FS_BULK__: bool(config.features.bulkTransfer),
    __FS_PUSH__: bool(config.features.pushEvents),
    __FS_DEVTOOLS__: bool(mode === "dev" ? true : config.features.devtools),
    __FS_APP_ID__: JSON.stringify(config.appId),
    __FS_VERSION__: JSON.stringify(config.version),
  };
}

/** Target id -> host platform that can build it. */
export const TARGET_PLATFORMS: Record<TargetId, NodeJS.Platform[]> = {
  appimage: ["linux"],
  deb: ["linux"],
  msi: ["win32"],
  app: ["darwin"],
  dmg: ["darwin"],
};
