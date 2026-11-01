import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { human, log, removePath } from "../util.ts";

export interface CleanOptions {
  /** Also delete the shared Gecko runtime cache. */
  cache?: boolean;
}

export async function clean(opts: CleanOptions = {}) {
  const { root, config } = await loadConfig();
  const targets = [join(root, "build"), join(root, "dist")];
  // The runtime cache is shared across projects, so it is only removed on request.
  if (opts.cache) targets.push(config.gecko.cacheDir ?? join(root, ".fireshell/cache"));

  let freed = 0;
  for (const target of targets) {
    const bytes = removePath(target);
    if (bytes > 0) log.dim(`- ${target} (${human(bytes)})`);
    freed += bytes;
  }

  if (freed === 0) log.info("nothing to clean");
  else log.ok(`freed ${human(freed)}`);
  if (!opts.cache) log.dim("the shared Gecko cache was kept (fireshell clean --cache)");
}
