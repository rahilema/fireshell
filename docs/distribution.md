# Distribution (incomplete by design)

Everything upstream of packaging is implemented. This file records what is still
unverified, because the CLI's `package` target depends on it.

## Settled

- The app owns an isolated profile and its own portable Gecko runtime.
  `-profile <dir>` on the *host's* Firefox is dev-only (`gecko.source: "system"`).
- The native messaging host manifest is registered per user, at first launch, with an
  absolute `path`. Never from a root/SYSTEM installer script.
  - Linux: `~/.mozilla/native-messaging-hosts/<appId>.json`
  - macOS: `~/Library/Application Support/Mozilla/NativeMessagingHosts/<appId>.json`
  - Windows: `HKCU\Software\Mozilla\NativeMessagingHosts\<appId>` → point at the JSON file
- The extension is MV2 with `browser_specific_settings.gecko.id` pinned and
  `background.persistent: true`. An MV3 event page is suspended when idle and drops the
  `connectNative` port.
- `manifest.json` declares `nativeMessaging` and, when `features.bulkTransfer` is on,
  `http://127.0.0.1/*`.

## Pending verification

Run `bun run spikes/distribution.ts <path-to-portable-firefox>` before trusting the
installer. Three candidate install mechanisms exist and none is verified against a
current runtime:

| Mechanism | Where | Status |
|---|---|---|
| `policies.json` → `ExtensionSettings.install_url` | `<exe-dir>/distribution/policies.json` | unverified; may require `https://` |
| `distribution/extensions/<id>.xpi` | app install dir | unverified; legacy path |
| profile `extensions/<id>.xpi` | `<profile>/extensions/` | expected to fail on modern Firefox |

If `install_url` accepts `file://`, the offline installer story works with a signed or
unsigned xpi. If it does not, the options are:

1. AMO unlisted signing (`web-ext sign`) and an `https` install URL, or
2. an unbranded Gecko build where `xpinstall.signatures.required` can be disabled, plus a
   mechanism that actually installs the add-on.

Note that disabling signature enforcement installs nothing. Signature policy and install
mechanism are independent knobs.

## Trademark

Redistributing a *branded* Firefox with a pre-seeded profile and policy violates Mozilla's
trademark policy. An unbranded build is the clean route, and it is also what makes
signature enforcement configurable. That is a build-pipeline commitment, not a config flag.

## Per-user install steps the launcher performs

1. Create `<profile>` and write `profile-seed/user.js` + `chrome/userChrome.css`.
2. Write the native host manifest with the absolute path of the installed backend.
3. Install the bundled extension (mechanism: pending above).
4. Spawn Gecko with a sanitized environment (see `native-libraries.md`).

## Uninstall

The native host manifest and the Windows registry key are written outside the app
directory. An uninstaller, or `fireshell doctor`'s report, must remove them; deleting the
install directory alone leaves a stale host registration behind.
