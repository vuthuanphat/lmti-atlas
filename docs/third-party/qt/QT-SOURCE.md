# Qt corresponding source and replacement

The local Windows candidate uses unmodified Qt 6.12.0 dynamic libraries.
SDK SBOM revision: `025bdad181de241e81bf853c8a2d7bf3d19261a9`. Source archive tag: `025bdad181de241e81bf853c8a2d7bf3d19261a9`.

The offline candidate assets include `qtbase-everywhere-src-6.12.0.tar.xz`.
SHA-256: `a951bd163c7b80fc6b8c88d7668fb56abf91c152373e13c10666763238131307`.
Official source: https://download.qt.io/official_releases/qt/6.12/6.12.0/submodules/qtbase-everywhere-src-6.12.0.tar.xz
Official checksum: https://download.qt.io/official_releases/qt/6.12/6.12.0/submodules/qtbase-everywhere-src-6.12.0.tar.xz.sha256

This archive includes QtBase and its bundled third-party sources. Applicable
license/attribution texts are copied under `source-notices/`; the full source
archive remains the reference. The SDK SPDX SBOM is included alongside them.
Configuration choices are in `config_qtbase.opt` and `config_qtbase.summary`;
publisher-local paths are redacted. No Qt source modifications are applied.

Use the Qt 6.12 build instructions and the MSVC x64 toolchain to rebuild matching
libraries: https://doc.qt.io/qt-6/windows-building.html . Replace matching DLLs and
plugins in a separate copy of the application. Modified Qt libraries change
package hashes; the application integrity check must be rebuilt/re-manifested
from trusted source for that modified package. The complete application source
and build scripts are provided to permit that rebuild. This integrity check is
not a contractual restriction on debugging, modifying or replacing Qt.

Qt licensing: https://doc.qt.io/qt-6/licensing.html . QtEntryPoint and incorporated
third-party components retain their specific license alternatives/exceptions.
Before public distribution, keep this source archive accessible with the exact
runtime ZIP rather than relying only on a third-party URL.
