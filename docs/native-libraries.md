# Native libraries (`.so`, `.dylib`, `.dll`, `.node`)

FireShell runs two processes. That single fact determines how shared objects are handled.

| Process | Who starts it | Native code it loads |
|---|---|---|
| `backend` (Bun) | Gecko, via native messaging | Bun itself, plus any `bun:ffi` `dlopen` target and any `.node` addon |
| `firefox` (Gecko) | The launcher | Gecko's own libraries, plus the system GTK/X11/NSS stack |

They never share an address space, so their symbols never collide. Everything below follows
from keeping it that way.

## The three classes

**1. System libraries — never bundle, always declare.**
`libc`, `libm`, `libpthread`, `libgtk-3`, `libX11`, `libnss3`, `libasound`, `libfontconfig`,
`libdbus`, `libcups`, `libdrm`, `libgbm`. Ship them and you get a binary that breaks when the
host updates them, and a DEB that conflicts with the OS.

The CLI resolves these from `ldd` output and maps sonames to Debian packages
(`DEB_SONAME_MAP` in `src/pipeline/native.ts`) to generate `Depends:`. Unknown sonames are
reported as `bundled` and fail the build under `native.strict`.

The user's `native.allowSystem` list is the authoritative allowlist. Add to it deliberately.

**2. Third-party libraries you own — bundle, version, isolate.**
`libsqlite3`, `libssl`/`libcrypto`, `libffmpeg`, image codecs. Put them in
`resources/lib/`, and rely on the rpath patch:

```
patchelf --set-rpath '$ORIGIN/../resources/lib' bin/backend      # Linux
install_name_tool -add_rpath '@executable_path/../resources/lib' # macOS
```

`native.patchRpath` does this during `fireshell build`. Because the rpath is relative to
`$ORIGIN`, the app stays relocatable across AppImage/`.deb`/`.app` staging.

**3. Runtime-loaded plugins — sidecars, never inlined.**
`bun build --compile` bundles JavaScript only. It cannot inline a `.node` addon or an
arbitrary `.so` you `dlopen`. Those files must exist on disk next to the executable.

Declare them so the CLI copies and reports them:

```ts
native: {
  libraries: [
    { glob: "node_modules/better-sqlite3/build/Release/*.node", target: "sqlite", kind: "node" },
    { glob: "vendor/libcodec/*.so*", target: "codec", kind: "system" },
  ],
}
```

They land in `resources/native/<target>/`. Resolve them at runtime relative to the
executable, never relative to the module:

```ts
import { dlopen } from "bun:ffi";
import { dirname, join } from "node:path";

// process.execPath is the compiled binary; import.meta.dir is a virtual $bunfs path.
const libDir = join(dirname(process.execPath), "..", "resources", "native", "codec");
const { symbols } = dlopen(join(libDir, "libcodec.so.1"), {
  decode: { args: ["ptr", "u32"], returns: "ptr" },
});
```

Getting this wrong is the most common FireShell packaging failure: it works under
`bun run dev` (where `import.meta.dir` is a real directory) and fails in the compiled binary.

## Do not leak the runtime's env into Gecko

An AppImage sets `LD_LIBRARY_PATH` for the whole process tree. Gecko's child processes
inherit it and then load *our* copies of `libnss3`, `libgtk-3`, or `libstdc++` instead of the
ones it shipped with — producing crashes that look like Gecko bugs but are packaging bugs.

The launcher must spawn Gecko with a sanitized environment. `sanitizeEnvForGecko()` in
`src/pipeline/native.ts` strips:

```
LD_LIBRARY_PATH  LD_PRELOAD  LD_AUDIT
DYLD_LIBRARY_PATH  DYLD_INSERT_LIBRARIES
PYTHONHOME  PYTHONPATH  NODE_OPTIONS
```

The AppImage `AppRun` and macOS bundle launcher emitted by the CLI already unset the
dynamic-loader variables. If you write your own launcher, keep that behaviour.

## Platform notes

**glibc vs musl.** Bun binaries are glibc-linked by default. A `bun-linux-x64` build will not
run on Alpine. Either build with a musl target (`FIRESHELL_BUN_TARGET=bun-linux-x64-musl`)
or document glibc as the requirement. The `.deb` `Depends: libc6` reflects this.

**AVX2.** Default x64 builds require AVX2. For older CPUs set `FIRESHELL_BUN_BASELINE=1`,
which selects `bun-linux-x64-baseline`. This is a ship-time decision: pick one, don't mix.

**Versioned sonames.** `libfoo.so.1` and `libfoo.so.2` are different ABIs. Bundle the exact
soname you linked against. Sidecars are staged flat with `Bun.write`, which follows
symlinks — if you depend on a `libfoo.so` → `libfoo.so.1` chain, declare the real versioned
file in `native.libraries[]` rather than the symlink.

**GPU/CUDA.** Driver libraries are per-machine and must never be bundled. `libcuda.so`,
`libnvidia-*`, `libvulkan.so.1` belong in `native.allowSystem`.

**Windows.** DLL search order ignores rpath. Place bundled DLLs next to `backend.exe`
(which is where `resources/native/*` already resolve if you keep the relative path short,
or use `SetDllDirectory` from `bun:ffi`). MSI installs them into the same component tree, so
they stay adjacent.

## Verifying a build

```
fireshell build          # prints every lib classified as "bundled" (i.e. unowned)
ldd build/prod/app/bin/backend          # Linux
otool -L build/prod/app/bin/backend     # macOS
patchelf --print-rpath build/prod/app/bin/backend
```

Anything reported as `bundled` but not present in `resources/lib/` will fail on a clean
machine. `fireshell doctor` reports the toolchain needed to inspect and fix this.
