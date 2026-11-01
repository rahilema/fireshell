#!/usr/bin/env bun
import { main } from "../src/cli.ts";

// Under `bun run ./bin/fireshell.ts` or `bunx`, argv is [bun, script, ...args].
// A compiled standalone binary gets [self, ...args].
const runtime = process.argv[0] ?? "";
const runningUnderBun = /(^|[\\/])bun(x)?(\.exe)?$/.test(runtime);

await main(process.argv.slice(runningUnderBun ? 2 : 1));
