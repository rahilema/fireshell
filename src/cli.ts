import { FireShellError, log, parseArgs } from "./util.ts";
import { loadConfig } from "./config.ts";
import { init } from "./commands/init.ts";
import { dev } from "./commands/dev.ts";
import { build } from "./commands/build.ts";
import { packageApp } from "./commands/package.ts";
import { doctor } from "./commands/doctor.ts";
import { clean } from "./commands/clean.ts";

const HELP = `
fireshell — build, run and package FireShell apps

Usage:
  fireshell init [folder]               create a project (prompts for a name)
  fireshell init app --yes              non-interactive, defaults everywhere
  fireshell dev [--devtools]            run against a throwaway profile
  fireshell build [--mode=dev|prod]     compile backend + UI, assemble app dir
  fireshell package [--target=deb,...] [--dry-run]
  fireshell doctor                      check toolchain and native deps
  fireshell clean                       remove build output and caches

Global flags:
  --dry-run        print commands instead of executing them
  --verbose        extra logging
`;

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { flags, positional } = parseArgs(rest);

  try {
    switch (command) {
      case undefined:
      case "-h":
      case "--help":
      case "help":
        console.log(HELP);
        return;
      case "init":
        await init({
          force: flags.force === true,
          name: typeof flags.name === "string" ? flags.name : positional[0],
          appId: typeof flags["app-id"] === "string" ? flags["app-id"] : undefined,
          productName: typeof flags["product-name"] === "string" ? flags["product-name"] : undefined,
          yes: flags.yes === true || flags.y === true,
        });
        return;
      case "dev":
        await dev({ devtools: flags.devtools === true, dryRun: flags["dry-run"] === true });
        return;
      case "build":
        await build({
          mode: flags.mode === "dev" ? "dev" : "prod",
          dryRun: flags["dry-run"] === true,
          verbose: flags.verbose === true,
        });
        return;
      case "package":
      case "dist":
        await packageApp({
          targets: typeof flags.target === "string" ? flags.target.split(",") : undefined,
          dryRun: flags["dry-run"] === true,
          skipBuild: flags["skip-build"] === true,
        });
        return;
      case "doctor":
        await doctor();
        return;
      case "clean":
        await clean();
        return;
      case "version":
      case "--version": {
        const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version: string };
        console.log(pkg.version);
        return;
      }
      default:
        log.error(`unknown command: ${command}`);
        console.log(HELP);
        process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof FireShellError) {
      log.error(err.message);
      if (err.hint) log.dim(err.hint);
    } else {
      log.error(err instanceof Error ? err.message : String(err));
      if (flags.verbose && err instanceof Error) console.error(err.stack);
    }
    process.exitCode = 1;
  }
}

export async function withProject<T>(fn: (loaded: Awaited<ReturnType<typeof loadConfig>>) => Promise<T>): Promise<T> {
  return fn(await loadConfig());
}
