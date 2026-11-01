# FireShell Framework Instructions for AI Agents

Welcome to **FireShell**—a lightweight, high-performance desktop application framework built on top of **Bun**, **Gecko (Firefox WebExtensions)**, and **stdin/stdout Native Messaging**.

---

## 1. Core Architectural Pillars & Tooling Rules
* **Tooling Standard:** **Bun is the single source of truth for ALL developer workflows.** Use `bun` exclusively for package installation, running scripts, bundling, testing, and dev servers. **Do NOT use `npm`, `yarn`, `pnpm`, or `npx` under any circumstances.**
* **Frontend Runtime:** Gecko (Firefox WebExtension engine rendering modern HTML/CSS/JS).
* **Backend Runtime:** **Bun** (compiled standalone binary handling business logic, file systems, and system calls).
* **IPC Channel:** Length-prefixed binary/JSON stream over standard input/output (`stdin`/`stdout`) via Firefox Native Messaging (`browser.runtime.nativeConnect`).
* **Zero Bloat:** No Chromium bundle, no heavy Node modules, and optional host-system or portable Gecko runtimes.

---

## 2. Developer Commands Cheatsheet (Bun-First)
Always run commands using `bun`:

* **Install dependencies:** `bun install` (or `bun add <package>`)
* **Run development server:** `bun run dev`
* **Run tests:** `bun test`
* **Execute scripts:** `bun run <script>`
* **Execute local binaries:** `bunx <command>` (replacing `npx`)
* **Compile standalone binary:** `bun build --compile --minify ./src/main/index.ts --outfile=dist/backend`

---

## 3. Project Directory Structure
```text
my-fireshell-app/
├── src/
│   ├── main/           # Bun backend logic & RPC handlers
│   │   ├── index.ts    # Main entry point & server bootstrap
│   │   └── handlers/   # Modular IPC action controllers
│   ├── ui/             # Gecko WebExtension Frontend
│   │   ├── index.html  # App UI entry point
│   │   ├── fireshell.js# Client-side IPC bridge wrapper
│   │   └── app.js      # Frontend UI components/logic
│   └── shared/         # Shared TypeScript interfaces & types
├── manifest.json       # Firefox WebExtension manifest
├── native-host.json    # Firefox Native Messaging Host manifest
└── fireshell.config.json # Framework build and packaging config
```

---

## 4. Writing Backend Code (Bun RPC Server)
When adding backend features in `src/main/`, use the registered RPC handler pattern. 

> ⚠️ **CRITICAL:** Never write unformatted text or `console.log` directly to `process.stdout` in the backend process, as doing so pollutes stdout and breaks the length-prefixed binary IPC framing. Always use `console.error` for debug logging.

### Example Backend Handler (`src/main/handlers/system.ts`)
```typescript
import { FireShellServer } from "../server";

export function registerSystemHandlers(server: FireShellServer) {
  server.handle("get-system-info", async () => {
    return {
      platform: process.platform,
      arch: process.arch,
      bunVersion: Bun.version,
    };
  });
}
```

---

## 5. Writing Frontend Code (Gecko UI Client)
In the UI layer (`src/ui/`), communicate with the Bun backend exclusively using `window.fireshell.invoke()`. It returns a standard JavaScript Promise.

### Example Frontend Call (`src/ui/app.js`)
```javascript
async function loadSystemData() {
  try {
    const info = await window.fireshell.invoke("get-system-info");
    document.getElementById("status").innerText = `Running on ${info.platform} (${info.arch})`;
  } catch (err) {
    console.error("Failed to fetch system info:", err);
  }
}
```

---

## 6. Critical Rules for AI Agents
1. **Strict Bun Usage:** Always output commands using `bun`, `bun run`, `bun test`, `bun add`, or `bunx`. Never suggest `npm`, `pnpm`, or `yarn`.
2. **Never break IPC Framing:** The IPC stream relies on a strict 4-byte little-endian length prefix followed by a UTF-8 JSON payload.
3. **TypeScript First:** Ensure all new IPC methods have corresponding request and response interfaces defined in `src/shared/`.
4. **Error Serialization:** Always catch errors inside backend RPC handlers and return them cleanly in the response object `{ status: "error", error: err.message }` so the frontend promise rejects correctly instead of hanging.
5. **Compilation Target:** Build production binaries using `bun build --compile --minify ./src/main/index.ts --outfile=dist/backend`.
