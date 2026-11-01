import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { human, log, removePath } from "../util.ts";

export async function clean() {
  const { root, config } = await loadConfig();
  const targets = [join(root, "build"), join(root, "dist"), config.gecko.cacheDir ?? join(root, ".fireshell/cache")];

  let freed = 0;
  for (const target of targets) {
    const bytes = removePath(target);
    if (bytes > 0) log.dim(`- ${target} (${human(bytes)})`);
    freed += bytes;
  }

  if (freed === 0) log.info("nothing to clean");
  else log.ok(`freed ${human(freed)}`);
}
