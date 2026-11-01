import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FireShellConfig } from "../config.ts";
import { log } from "../util.ts";

const SIZES = [16, 32, 48, 64, 96, 128, 256, 512];

export interface IconSet {
  dir: string;
  /** PNG at the requested size, or null when it was not generated. */
  png(size: number): string | null;
  /** Multi-resolution Windows icon, built from the PNGs above. */
  ico: string | null;
}

/** `Bun.Image` ships with the runtime: static JPEG/PNG/WebP codecs, no native deps. */
function hasImageSupport(): boolean {
  return typeof Bun.Image === "function";
}

/**
 * Generates the icon sizes the extension manifest, Linux hicolor theme, macOS bundle
 * and Windows MSI need, using Bun.Image. When the API is unavailable the source file is
 * copied through unchanged so packaging still succeeds.
 */
export async function buildIcons(
  config: FireShellConfig,
  outDir: string,
  opts: { dryRun?: boolean } = {},
): Promise<IconSet | null> {
  const source = config.icon;
  if (!source) return null;
  const sourceFile = Bun.file(source);
  if (!(await sourceFile.exists())) {
    log.warn(`icon not found: ${source}`);
    return null;
  }

  const dir = outDir;
  const produced = new Map<number, string>();

  if (opts.dryRun) {
    log.dim(`$ new Bun.Image(${source}).resize(…) -> ${SIZES.join(", ")} px`);
    return { dir, png: () => null, ico: null };
  }

  mkdirSync(dir, { recursive: true });

  if (!hasImageSupport()) {
    log.warn("Bun.Image is unavailable; copying the source icon at every size");
    for (const size of SIZES) {
      const target = join(dir, `${size}.png`);
      await Bun.write(target, sourceFile);
      produced.set(size, target);
    }
    return { dir, png: (size) => produced.get(size) ?? null, ico: null };
  }

  for (const size of SIZES) {
    const target = join(dir, `${size}.png`);
    try {
      // Square output is intentional: every consumer (manifest, hicolor, .ico) expects it.
      await new Bun.Image(source).resize(size, size).png().write(target);
      produced.set(size, target);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      log.warn(`icon ${size}px failed${code ? ` (${code})` : ""}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (produced.size === 0) {
    log.warn("no icon sizes generated; packaging will run without icons");
    return null;
  }

  const ico = await writeIco(dir, produced);
  log.ok(`icons: ${[...produced.keys()].sort((a, b) => a - b).join(", ")}px${ico ? " + .ico" : ""}`);

  return { dir, png: (size) => produced.get(size) ?? null, ico };
}

/**
 * Writes a PNG-in-ICO container. Vista and later accept PNG-compressed entries, so no
 * BMP encoder is needed; 256px is the largest size the format can address.
 */
async function writeIco(dir: string, produced: Map<number, string>): Promise<string | null> {
  const sizes = [...produced.keys()].filter((s) => s <= 256).sort((a, b) => a - b);
  if (sizes.length === 0) return null;

  const entries = sizes.map((size) => ({ size, bytes: Bun.file(produced.get(size)!).size }));

  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  let offset = header.length;
  entries.forEach((entry, index) => {
    const base = 6 + index * 16;
    header.writeUInt8(entry.size >= 256 ? 0 : entry.size, base); // 0 means 256
    header.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1);
    header.writeUInt8(0, base + 2); // palette
    header.writeUInt8(0, base + 3); // reserved
    header.writeUInt16LE(1, base + 4); // planes
    header.writeUInt16LE(32, base + 6); // bits per pixel
    header.writeUInt32LE(entry.bytes, base + 8);
    header.writeUInt32LE(offset, base + 12);
    offset += entry.bytes;
  });

  const payloads = await Promise.all(sizes.map((size) => Bun.file(produced.get(size)!).bytes()));
  const icoPath = join(dir, "app.ico");
  await Bun.write(icoPath, Buffer.concat([header, ...payloads.map((bytes) => Buffer.from(bytes))]));
  return icoPath;
}
