"""Qt 6.12 MSVC repository compatibility for aqtinstall 3.3.0.

Uses aqt's verified archive downloads. This only corrects the documented
repository suffix; it never disables TLS or checksum validation.
"""
from aqt.installer import Cli
from aqt.metadata import QtRepoProperty

_original_extension = QtRepoProperty.extension_for_arch

def _extension(architecture: str, is_version_ge_6: bool) -> str:
    if architecture == "win64_msvc2022_64" and is_version_ge_6:
        return "msvc2022_64"
    return _original_extension(architecture, is_version_ge_6)

QtRepoProperty.extension_for_arch = staticmethod(_extension)

if __name__ == "__main__":
    raise SystemExit(Cli().run())
