# Build a local release candidate

This procedure prepares artifacts locally. It does not push, tag, publish a
GitHub release or upload registry packages. Use a fresh checkout and synthetic
test data. Do not copy `.lmti/`, client configuration, credentials or databases
from another development directory.

## Toolchain

- Node.js 24 x64, pnpm 10.13.1 (the `packageManager` pin), Python 3.11+ x64.
- CMake 3.24+, Visual Studio 2022 C++ x64 build tools and Qt 6.12.0 MSVC x64.
- Go 1.22+ with the Node SQLite bridge for compatibility tests.

Obtain toolchains from official publishers and verify downloads. Existing native
CI uses a pinned aqtinstall release and verified Qt archives. Runtime prerequisites
must be tested separately on a fresh Windows installation.

## Build

```powershell
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm build
corepack pnpm web:build
& .\scripts\build-studio.ps1 -QtRoot 'C:\trusted\Qt\6.12.0\msvc2022_64'
& .\scripts\package-local-web.ps1 -NativePackage build/studio -AdminPackage build/studio -OutputDirectory build/lmti-v0.2.0-alpha.1-windows-x64
```

Use a fresh native install and web output directory; existing installations are
preserved and stale desktop runtime files are rejected. Build outputs stay under `build/`. The native build also supplies the trusted
source-CLI helper at `build/audit-acl/bin/lmti-audit-acl.exe`. The release package
contains its own helper under `bin/`; it never searches PATH for a replacement.

## Verification

Run the complete TS suite, UI Node tests, native CTest, Python integration,
Go compatibility, native owner/API integration and browser workflows. Desktop
QtTest and Qt/API coexistence trials were removed with the desktop application. The optional integration
environment must point at binaries and fixtures built from the same candidate.
Record skipped tests and run platform-specific cases on their target platform.
The [development guide](development.md) and [package verifier](../scripts/verify-local-web.ps1)
document entry points. Use package mirrors for tests that may generate caches.

For startup/readiness changes, exercise the actual Windows PowerShell 5 setup
and saved-workspace opener from a fresh extracted package. Cover demo/empty,
review cancellation, existing/linked/path refusals, profile/grant/package changes,
Unicode paths, fresh-tab O, graceful Q/EOF and retained writer/recovery gates.
Run package doctor, tests and a real-browser journey on the changed payload;
green CI for baseline `771fc40` is historical evidence, not the next build's result.
Clean-Windows installation and independent operator acceptance remain separate.

## Distribution contents

Create the source archive from the reviewed commit. Include the built Windows
package, SHA-256 checksums, release notes, SBOM/inventory and third-party notices.
Qt Core/Sql corresponding source and applicable license texts must accompany the offline
distribution as described in `THIRD-PARTY-NOTICES.txt`; preserve the unmodified
Qt dynamic libraries and their replacement/rebuild rights. Do not package build
logs, developer paths, test stores or reports containing private metadata.

Check the exact ZIP after extraction. Checksums detect byte changes; they are
not publisher signatures. Registry publishing and hosted CI require separate
authorization and verification. Run `lmti publish preflight` before any future
public push, PR, remote change or release.
