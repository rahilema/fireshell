import { mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import inquirer from "inquirer";
import { projectReadme } from "../templates/project-readme.ts";
import { FireShellError, log } from "../util.ts";

export interface InitOptions {
  force?: boolean;
  /** Folder to create. Skips the prompt when provided. */
  name?: string;
  appId?: string;
  productName?: string;
  /** Accept defaults without prompting (CI). */
  yes?: boolean;
}

const CONFIG = `// Plain object so the project needs no local dependency.
// Add @fireshell/cli as a devDependency and wrap this in defineConfig({...}) for types.
export default {
  appId: "__APP_ID__",
  productName: "__PRODUCT_NAME__",
  version: "0.1.0",
  // icon: "assets/icon.png",   // optional; every size is generated with Bun.Image

  gecko: {
    source: "portable",
    channel: "release",
    version: "128.0",
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
    // Anything loaded through dlopen must ship as a sidecar file.
    libraries: [],
  },

  targets: ["appimage", "deb", "app", "dmg", "msi"],
};
`;

const MAIN = `// Role dispatcher. Firefox invokes the native host with no arguments, so
// "host" is the only safe default; the desktop entry passes --role=launcher.
const role = Bun.argv.find((arg) => arg.startsWith("--role="))?.split("=")[1] ?? "host";

switch (role) {
  case "launcher":
    await runLauncher();
    break;
  case "daemon":
    await runDaemon();
    break;
  case "host":
    await runHostProxy();
    break;
  default:
    console.error("unknown role: " + role);
    process.exit(1);
}

/** Creates the profile, registers the native host, starts the daemon, launches Gecko. */
async function runLauncher() {
  // TODO: profile setup, installNativeHost(), detached daemon spawn, exec portable Gecko.
}

/** Singleton process: owns the socket, RPC handlers and the loopback bulk server. */
async function runDaemon() {
  // TODO: bind socket, dispatch handlers, push events to the host proxy.
}

/** Spawned by Firefox. Pure byte pump between stdio and the daemon socket. */
async function runHostProxy() {
  // TODO: connect (or cold-start) the daemon, then forward stdin <-> socket.
}
`;

const PROTOCOL = `/** Mirrors the wire envelope. Keep in sync with the backend dispatcher. */
export interface Request<T = unknown> {
  id: string;
  action: string;
  payload?: T;
}

export type ResponseEnvelope<T = unknown> =
  | { id: string; status: "success"; data: T }
  | { id: string; status: "error"; error: { code: ErrorCode; message: string } };

export interface PushEvent<T = unknown> {
  event: string;
  payload?: T;
}

export type ErrorCode =
  | "FS_DAEMON_UNAVAILABLE"
  | "FS_HANDLER_TIMEOUT"
  | "FS_HANDLER_ERROR"
  | "FS_PROTOCOL_ERROR"
  | "FS_FRAME_TOO_LARGE"
  | "FS_CANCELED"
  | "FS_UNAUTHORIZED"
  | "FS_NOT_FOUND";
`;

const RUNTIME_JS = `// FireShell IPC bridge. Injected by the CLI; wraps connectNative with
// request ids, per-call timeouts and push-event subscriptions.
(function () {
  var APP = "__APP_ID__";
  var port = browser.runtime.connectNative(APP);
  var seq = 0;
  var pending = new Map();
  var listeners = new Map();

  port.onMessage.addListener(function (msg) {
    if (!msg || typeof msg !== "object") return;
    if (!("id" in msg) && typeof msg.event === "string") {
      var handlers = listeners.get(msg.event) || [];
      for (var i = 0; i < handlers.length; i++) handlers[i](msg.payload);
      return;
    }
    var entry = pending.get(msg.id);
    if (!entry) return; // late reply for a timed-out call: drop silently
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.status === "error") {
      var detail = msg.error && typeof msg.error === "object" ? msg.error : { code: "FS_HANDLER_ERROR", message: String(msg.error) };
      var err = new Error(detail.message || "backend error");
      err.code = detail.code;
      entry.reject(err);
    } else {
      entry.resolve(msg.data);
    }
  });

  port.onDisconnect.addListener(function () {
    pending.forEach(function (entry, id) {
      clearTimeout(entry.timer);
      var err = new Error("backend disconnected");
      err.code = "FS_DAEMON_UNAVAILABLE";
      entry.reject(err);
      pending.delete(id);
    });
  });

  function invoke(action, payload, options) {
    var id = "r" + (++seq);
    var timeout = (options && options.timeout) || 30000;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        pending.delete(id);
        var err = new Error("request timed out: " + action);
        err.code = "FS_HANDLER_TIMEOUT";
        reject(err);
      }, timeout);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      port.postMessage({ id: id, action: action, payload: payload });
    });
  }

  function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(handler);
    return function () {
      var list = listeners.get(event) || [];
      listeners.set(event, list.filter(function (h) { return h !== handler; }));
    };
  }

  window.fireshell = { invoke: invoke, on: on, port: port, appId: APP };
})();
`;

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>__PRODUCT_NAME__</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; font: 14px system-ui, sans-serif; background: #111; color: #eee; }
      main { padding: 24px; }
      #status { margin-top: 12px; color: #8f8; }
    </style>
  </head>
  <body>
    <main>
      <h1>__PRODUCT_NAME__</h1>
      <p>Edit <code>src/ui/app.js</code> and the backend in <code>src/main/</code>.</p>
      <p id="status">connecting…</p>
    </main>
    <script src="fireshell-runtime.js"></script>
    <script src="app.js"></script>
  </body>
</html>
`;

const APP_JS = `async function loadSystemData() {
  try {
    const info = await window.fireshell.invoke("get-system-info");
    document.getElementById("status").innerText =
      "Running on " + info.platform + " (" + info.arch + ") · Bun " + info.bunVersion;
  } catch (err) {
    document.getElementById("status").innerText = "Backend unavailable: " + err.message;
  }
}

loadSystemData();
`;

const GITIGNORE = `build/
dist/
.fireshell/
node_modules/
`;

const TSCONFIG = `{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "noUncheckedIndexedAccess": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src", "fireshell.config.ts"],
  "exclude": ["build", "dist", "node_modules", ".fireshell"]
}
`;

const PACKAGE_JSON = `{
  "name": "__PROJECT_NAME__",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "fireshell dev",
    "build": "fireshell build",
    "package": "fireshell package",
    "doctor": "fireshell doctor",
    "clean": "fireshell clean",
    "typecheck": "bunx tsc --noEmit"
  },
  "devDependencies": {
    "@types/bun": "latest"
  }
}
`;

const FILES: Record<string, string> = {
  "fireshell.config.ts": CONFIG,
  "package.json": PACKAGE_JSON,
  "tsconfig.json": TSCONFIG,
  "src/main/index.ts": MAIN,
  "src/shared/protocol.ts": PROTOCOL,
  "src/ui/index.html": INDEX_HTML,
  "src/ui/fireshell-runtime.js": RUNTIME_JS,
  "src/ui/app.js": APP_JS,
  ".gitignore": GITIGNORE,
};

export async function init(opts: InitOptions = {}) {
  const cwd = process.cwd();
  const interactive = !opts.yes && Boolean(process.stdin.isTTY);

  const projectName = await resolveProjectName(opts, cwd, interactive);
  const targetDir = projectName === "." ? cwd : resolve(cwd, projectName);

  // A folder that only holds dotfiles (e.g. a fresh `git init`) counts as empty.
  if (projectName !== ".") mkdirSync(targetDir, { recursive: true });
  const contents = [...new Bun.Glob("*").scanSync({ cwd: targetDir })];
  if (contents.length > 0 && !opts.force) {
    if (!interactive) {
      throw new FireShellError(
        `directory is not empty: ${targetDir}`,
        "pass --force to write into it, or --name=<folder> to pick another",
      );
    }
    const answer = await inquirer.prompt<{ proceed: boolean }>([
      {
        type: "confirm",
        name: "proceed",
        message: `${targetDir} is not empty. Continue?`,
        default: false,
      },
    ]);
    if (!answer.proceed) {
      log.info("aborted");
      return;
    }
  }

  const slug = slugify(projectName === "." ? basename(targetDir) : projectName);
  let appId = opts.appId ?? `com.example.${slug}`;
  let productName = opts.productName ?? titleCase(slug);

  // Re-running with --force keeps the identity already recorded in the project.
  const configPath = join(targetDir, "fireshell.config.ts");
  if (await Bun.file(configPath).exists()) {
    const source = await Bun.file(configPath).text();
    const existingId = /appId:\s*"([^"]+)"/.exec(source);
    const existingName = /productName:\s*"([^"]+)"/.exec(source);
    if (!opts.appId && existingId?.[1]) appId = existingId[1];
    if (!opts.productName && existingName?.[1]) productName = existingName[1];
  }

  const files: Record<string, string> = {
    ...FILES,
    "README.md": projectReadme({ appId, productName }),
  };

  log.title(`creating ${productName} in ${targetDir}`);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(targetDir, rel);
    if (!opts.force && (await Bun.file(path).exists())) {
      log.dim(`- ${rel} (kept)`);
      continue;
    }
    // Bun.write creates parent directories on demand.
    const rendered = content
      .replaceAll("__APP_ID__", appId)
      .replaceAll("__PRODUCT_NAME__", productName)
      .replaceAll("__PROJECT_NAME__", slug);
    await Bun.write(path, rendered);
    log.ok(rel);
  }

  log.title("next");
  if (targetDir !== cwd) log.info(`cd ${projectName}`);
  log.info("bun install");
  log.info("bun add -g @fireshell/cli");
  log.info("fireshell doctor");
  log.info("fireshell dev");
}

async function resolveProjectName(opts: InitOptions, cwd: string, interactive: boolean): Promise<string> {
  if (opts.name) return validateName(opts.name);
  if (!interactive) return basename(cwd);

  const answer = await inquirer.prompt<{ projectName: string }>([
    {
      type: "input",
      name: "projectName",
      message: "Project name",
      default: "my-fireshell-app",
      validate: (value: string) => {
        const problem = nameProblem(value);
        return problem ?? true;
      },
    },
  ]);
  return validateName(answer.projectName);
}

function nameProblem(value: string): string | null {
  const name = value.trim();
  if (!name) return "project name is required";
  if (name === ".") return null;
  if (name.includes("/") || name.includes("\\")) return "use a folder name, not a path";
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) return "use letters, digits, dot, dash or underscore";
  if (name.startsWith(".")) return "name cannot start with a dot";
  return null;
}

function validateName(value: string): string {
  const problem = nameProblem(value);
  if (problem) throw new FireShellError(`invalid project name: ${value}`, problem);
  return value.trim();
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "fireshell-app"
  );
}

function titleCase(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
