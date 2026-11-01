import { rmSync, statSync, existsSync } from "node:fs";
import { basename } from "node:path";

export class FireShellError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "FireShellError";
  }
}

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

export const log = {
  step: (m: string) => console.log(`${c.cyan("▸")} ${m}`),
  ok: (m: string) => console.log(`${c.green("✓")} ${m}`),
  warn: (m: string) => console.warn(`${c.yellow("!")} ${m}`),
  error: (m: string) => console.error(`${c.red("✗")} ${m}`),
  info: (m: string) => console.log(`  ${m}`),
  dim: (m: string) => console.log(c.dim(`  ${m}`)),
  title: (m: string) => console.log(`\n${c.bold(m)}`),
};

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: "inherit" | "ignore";
  dryRun?: boolean;
}

/** Execute a command, inheriting stdio. Throws FireShellError on non-zero exit. */
export async function run(cmd: string[], opts: RunOptions = {}): Promise<void> {
  if (opts.dryRun) {
    log.dim(`$ ${cmd.join(" ")}${opts.cwd ? `  (cwd: ${opts.cwd})` : ""}`);
    return;
  }
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: opts.stdin ?? "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...opts.env },
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new FireShellError(`command failed with exit ${code}`, cmd.join(" "));
  }
}

/** Run a command and capture trimmed stdout. Returns null on non-zero exit. */
export async function capture(cmd: string[], opts: RunOptions = {}): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...opts.env },
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) return null;
    return (out.trim() || err.trim()) || null;
  } catch {
    return null;
  }
}

export function have(tool: string): boolean {
  return Bun.which(tool) !== null;
}

export function requireTool(tool: string, installHint: string): string {
  const path = Bun.which(tool);
  if (!path) {
    throw new FireShellError(`required tool not found on PATH: ${tool}`, installHint);
  }
  return path;
}

export function human(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

/** Total size in bytes of a file, directory tree, or glob of paths. Returns 0 when absent. */
export function sizeOf(path: string): number {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const entry of new Bun.Glob("**/*").scanSync({ cwd: path, onlyFiles: true })) {
    try {
      total += statSync(`${path}/${entry}`).size;
    } catch {
      // raced with deletion; ignore
    }
  }
  return total;
}

export function removePath(path: string): number {
  const bytes = sizeOf(path);
  rmSync(path, { recursive: true, force: true });
  return bytes;
}

export async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).bytes());
  return hasher.digest("hex");
}

export function platformLabel(): string {
  return `${process.platform}-${process.arch}`;
}

export function baseName(path: string): string {
  return basename(path);
}

/** Minimal argv parser: --flag, --key=value, -k, positionals. */
export function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=", 2) as [string, string | undefined];
      flags[key] = value ?? true;
    } else if (arg.startsWith("-") && arg.length > 1) {
      flags[arg.slice(1)] = true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}
