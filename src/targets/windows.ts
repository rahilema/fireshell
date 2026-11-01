import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../util.ts";
import { icoPath, slug, type Step, type Target } from "./index.ts";

interface Node {
  children: Map<string, Node>;
  files: string[];
}

function tree(root: string, relPaths: string[]): Node {
  const base: Node = { children: new Map(), files: [] };
  for (const rel of relPaths) {
    const parts = rel.split("/");
    let node = base;
    for (const part of parts.slice(0, -1)) {
      if (!node.children.has(part)) node.children.set(part, { children: new Map(), files: [] });
      node = node.children.get(part)!;
    }
    node.files.push(parts[parts.length - 1]!);
  }
  return base;
}

/** Deterministic GUID so repeated builds produce stable component identities. */
function guidFor(seed: string): string {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(seed);
  const hex = hasher.digest("hex").toUpperCase();
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(parseInt(hex[16]!, 16) & 0x3 | 0x8).toString(16).toUpperCase()}${hex.slice(17, 20)}-${hex.slice(20, 32)}}`;
}

function emit(node: Node, sourceRoot: string, pathParts: string[], out: string[]) {
  const dirId = pathParts.length === 0 ? "INSTALLDIR" : `dir_${pathParts.map((p) => p.replace(/[^A-Za-z0-9]/g, "_")).join("_")}`;
  const open = pathParts.length === 0 ? "" : `<Directory Id="${dirId}" Name="${pathParts[pathParts.length - 1]}">`;
  if (open) out.push(open);

  for (const file of node.files) {
    const rel = [...pathParts, file].join("/");
    const id = `cmp_${rel.replace(/[^A-Za-z0-9]/g, "_")}`;
    out.push(`  <Component Id="${id}" Guid="${guidFor(rel)}" Directory="${dirId}">`);
    out.push(`    <File Id="fil_${rel.replace(/[^A-Za-z0-9]/g, "_")}" Source="${join(sourceRoot, rel)}" KeyPath="yes"/>`);
    out.push(`  </Component>`);
  }
  for (const [name, child] of node.children) emit(child, sourceRoot, [...pathParts, name], out);
  if (open) out.push("</Directory>");
}

function componentRefs(node: Node, pathParts: string[], out: string[]) {
  for (const file of node.files) {
    const rel = [...pathParts, file].join("/");
    out.push(`      <ComponentRef Id="cmp_${rel.replace(/[^A-Za-z0-9]/g, "_")}"/>`);
  }
  for (const [name, child] of node.children) componentRefs(child, [...pathParts, name], out);
}

export function buildWxs(appRoot: string, config: { appId: string; productName: string; version: string; manufacturer: string; description?: string; iconPath?: string }): string {
  const glob = new Bun.Glob("**/*").scanSync({ cwd: appRoot, onlyFiles: true, dot: true });
  const files = [...glob].map((p) => p.split("\\").join("/"));
  const root = tree(appRoot, files);

  const dirs: string[] = [];
  emit(root, appRoot, [], dirs);
  const refs: string[] = [];
  componentRefs(root, [], refs);

  return `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="${config.productName}" Language="1033" Version="${config.version}"
           Manufacturer="${config.manufacturer}" UpgradeCode="${guidFor(config.appId)}">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine"/>
    <MajorUpgrade DowngradeErrorMessage="A newer version of ${config.productName} is already installed."/>
    <MediaTemplate EmbedCab="yes"/>
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLDIR" Name="${config.productName}" >
${dirs.join("\n")}
        </Directory>
      </Directory>
    </Directory>
    <Feature Id="MainFeature" Title="${config.productName}" Level="1">
${refs.join("\n")}
    </Feature>
${config.iconPath ? `    <Icon Id="AppIcon" SourceFile="${config.iconPath}"/>\n    <Property Id="ARPPRODUCTICON" Value="AppIcon"/>\n` : ""}  </Product>
</Wix>
`;
}

export const msiTarget: Target = {
  id: "msi",
  label: "Windows MSI",
  platforms: ["win32"],
  async prepare(ctx) {
    const dir = join(ctx.buildDir, "windows");
    mkdirSync(dir, { recursive: true });
    const wxs = buildWxs(ctx.app.root, {
      appId: ctx.config.appId,
      productName: ctx.config.productName,
      version: ctx.config.version,
      manufacturer: ctx.config.packaging.windowsManufacturer ?? ctx.config.packaging.maintainer,
      description: ctx.config.packaging.description,
      iconPath: icoPath(ctx) ?? undefined,
    });
    const wxsPath = join(dir, `${slug(ctx.config)}.wxs`);
    await Bun.write(wxsPath, wxs);
    log.ok(`WiX source written to ${wxsPath}`);
    return wxsPath;
  },
  plan(ctx, wxsPath): Step[] {
    const out = ctx.artifactName("msi");
    // wixl (msitools) builds MSIs on Linux; candle+light is the Windows-native path.
    if (process.platform === "win32") {
      return [
        { cmd: ["candle.exe", "-out", join(ctx.buildDir, "windows", "app.wixobj"), wxsPath] },
        { cmd: ["light.exe", "-out", out, join(ctx.buildDir, "windows", "app.wixobj")] },
        { note: "MSIs must be signed with signtool for SmartScreen trust", optional: true, cmd: ["signtool.exe", "sign", "/fd", "SHA256", "/a", out] },
      ];
    }
    return [
      { note: "msitools provides wixl on non-Windows build hosts", cmd: ["wixl", "-o", out, wxsPath] },
    ];
  },
};

export function windowsTargets(): Target[] {
  return [msiTarget];
}
