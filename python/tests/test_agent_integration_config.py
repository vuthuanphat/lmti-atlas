"""Integration capability files reject remote/device/stream paths before I/O."""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import unittest

from lmti_agent.integration_config import _file, load_integrated_client


class IntegrationPathTests(unittest.TestCase):
    def test_malformed_export_pin_never_touches_configuration(self):
        for fingerprint in ("", "a" * 63, "A" * 64, "g" * 64, 123):
            with patch("lmti_agent.integration_config._file", side_effect=AssertionError("Unexpected I/O")) as access:
                with self.assertRaises(ValueError):
                    load_integrated_client(None, "native-project", "ignored", expected_config_sha256=fingerprint)
                access.assert_not_called()

    def test_remote_device_ads_and_reserved_paths_never_touch_filesystem(self):
        for path in (r"\\untrusted.invalid\config.json", "//untrusted.invalid/config.json",
                     r"\\?\C:\config.json", "C:/config.json:stream", "C:/NUL/config.json", "C:/path/../config.json"):
            with patch.object(Path, "lstat", side_effect=AssertionError("Unexpected filesystem access")) as access:
                with self.assertRaises(ValueError):
                    _file(path)
                access.assert_not_called()

    def test_windows_reparse_attribute_is_denied_without_is_junction_support(self):
        selected = Path("C:/fixture/config.json") if Path("C:/").is_absolute() else Path("/fixture/config.json")
        with patch.object(Path, "lstat", return_value=SimpleNamespace(st_mode=0o100600, st_file_attributes=0x400)):
            with self.assertRaises(ValueError):
                _file(selected)

    def test_parent_reparse_is_detected_before_child_metadata_is_requested(self):
        selected = Path("C:/fixture/config.json") if Path("C:/").is_absolute() else Path("/fixture/config.json")
        seen = []

        def inspect(path):
            seen.append(path)
            if path == selected:
                raise AssertionError("Child was touched through an unchecked parent")
            return SimpleNamespace(st_mode=0o040700, st_file_attributes=0x400 if path.name == "fixture" else 0)

        with patch.object(Path, "lstat", autospec=True, side_effect=inspect):
            with self.assertRaises(ValueError):
                _file(selected)
        self.assertNotIn(selected, seen)


if __name__ == "__main__":
    unittest.main()
