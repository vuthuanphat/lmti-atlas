"""Controlled observation contract: scope, freshness, replay gaps and revocation."""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

from lmti_agent.observations import (
    MAX_BYTES, MAX_SAMPLES, ObservationError, ObservationRead,
    ReplayObservationSource, read_observations,
)
from lmti_project import Grant


NOW = datetime(2026, 10, 19, 10, 0, 0, tzinfo=timezone.utc)


def timestamp(offset=0):
    return (NOW + timedelta(seconds=offset)).isoformat().replace("+00:00", "Z")


def sample(**changes):
    row = {"sampleId": "sample-a", "assetId": "machine-a", "deviceId": "sensor-a",
           "metric": "temperature", "unit": "C", "value": 24.5,
           "sampleAt": timestamp(-5), "receivedAt": timestamp(-4), "ttlSeconds": 30,
           "quality": "good", "sequence": 10, "connectionId": "session-a",
           "classification": "public"}
    row.update(changes)
    return row


class ObservationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="lmti-observation-")
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "replay.json"
        self.grant = Grant("project-a", "site-a")
        self.document = {"schema": "lmti.observations.replay.v1", "sourceId": "controlled-observations",
                         "projectId": "project-a", "site": "site-a", "revision": 1,
                         "state": "available", "samples": [sample()]}
        self.write()
        self.source = ReplayObservationSource(self.path, self.grant)

    def write(self, samples=None, **changes):
        if samples is not None:
            self.document["samples"] = samples
        self.document.update(changes)
        self.path.write_text(json.dumps(self.document), encoding="utf-8")

    def read(self, asset="machine-a", source=None):
        return read_observations(source or self.source, self.grant, asset, now=NOW)

    def state(self, result):
        return result["source"]["freshness"]["state"]

    def test_fresh_has_exact_identity_version_evidence_and_no_file_path(self):
        before = self.path.read_bytes()
        result = self.read()
        row = result["observations"][0]
        self.assertEqual(self.state(result), "fresh")
        self.assertEqual(row["value"], 24.5)
        self.assertEqual(row["freshness"]["ageSeconds"], 5)
        self.assertEqual(row["assetId"], "machine-a")
        self.assertEqual(row["projectId"], "project-a")
        self.assertEqual(result["source"]["kind"], "controlled_replay")
        self.assertEqual(result["source"]["authority"], "controlled_observation")
        self.assertEqual(result["source"]["version"]["value"], 1)
        self.assertEqual(result["evidence"][0]["basis"], "controlled_replay")
        self.assertEqual(row["evidenceIds"], [result["evidence"][0]["evidenceId"]])
        self.assertNotIn(str(self.path), json.dumps(result))
        self.assertEqual(before, self.path.read_bytes())

    def test_ttl_boundary_then_stale_even_when_received_recently(self):
        self.write([sample(sampleAt=timestamp(-30), receivedAt=timestamp(-1))])
        self.assertEqual(self.state(self.read()), "fresh")
        self.write([sample(sampleAt=timestamp(-31), receivedAt=timestamp(-1))])
        result = self.read()
        self.assertEqual(self.state(result), "stale")
        self.assertEqual(result["observations"][0]["value"], 24.5)
        self.assertIn("TTL_EXPIRED", result["observations"][0]["freshness"]["reasons"])

    def test_uncertain_and_bad_quality_are_not_current_truth(self):
        self.write([sample(quality="uncertain")])
        self.assertEqual(self.state(self.read()), "unknown")
        self.write([sample(quality="bad")])
        result = self.read()
        self.assertEqual(self.state(result), "invalid")
        self.assertIsNone(result["observations"][0]["value"])

    def test_future_sample_and_receive_clock_skew(self):
        for changes in ({"sampleAt": timestamp(31)}, {"receivedAt": timestamp(31)},
                        {"sampleAt": timestamp(-1), "receivedAt": timestamp(-40)}):
            with self.subTest(changes=changes):
                self.write([sample(**changes)])
                result = self.read()
                self.assertEqual(self.state(result), "invalid")
                self.assertIn("CLOCK_SKEW", result["observations"][0]["freshness"]["reasons"])

    def test_identical_duplicate_is_deduplicated(self):
        self.write([sample(), sample()])
        result = self.read()
        self.assertEqual(len(result["observations"]), 1)
        self.assertEqual(self.state(result), "fresh")
        self.assertIn("DUPLICATE_SAMPLE", result["observations"][0]["freshness"]["reasons"])

    def test_conflicting_duplicate_never_returns_a_measurement(self):
        self.write([sample(), sample(value=31)])
        result = self.read()
        self.assertEqual(self.state(result), "invalid")
        self.assertIsNone(result["observations"][0]["value"])
        self.assertEqual(result["conflicts"][0]["code"], "OBSERVATION_CONFLICT")

    def test_out_of_order_sequence_does_not_replace_newer_measurement(self):
        self.write([sample(), sample(sampleId="late-old", sequence=9, value=-1,
                                     sampleAt=timestamp(-10), receivedAt=timestamp(-1))])
        result = self.read()
        self.assertEqual(result["observations"][0]["value"], 24.5)
        self.assertEqual(self.state(result), "fresh")
        self.assertIn("OUT_OF_ORDER_SAMPLE", result["observations"][0]["freshness"]["reasons"])

    def test_same_sequence_different_id_is_conflict(self):
        self.write([sample(), sample(sampleId="duplicate-sequence", receivedAt=timestamp(-1))])
        result = self.read()
        self.assertEqual(self.state(result), "invalid")
        self.assertIsNone(result["observations"][0]["value"])

    def test_sample_identity_cannot_alias_a_different_stream(self):
        self.write([sample(), sample(deviceId="other-device")])
        result = self.read()
        self.assertEqual(self.state(result), "invalid")
        self.assertEqual(result["observations"], [])

    def test_time_regression_cannot_replace_latest_sequence(self):
        self.write([sample(), sample(sampleId="regressed-clock", sequence=11, value=99,
                                     sampleAt=timestamp(-20), receivedAt=timestamp(-1))])
        result = self.read()
        self.assertEqual(result["observations"][0]["value"], 24.5)
        self.assertIn("OUT_OF_ORDER_SAMPLE", result["observations"][0]["freshness"]["reasons"])

    def test_reconnect_allows_reset_but_exposes_gap(self):
        self.write([sample(), sample(sampleId="after-reconnect", connectionId="session-b",
                                     sequence=0, value=25, sampleAt=timestamp(-2), receivedAt=timestamp(-1))])
        result = self.read()
        self.assertEqual(result["observations"][0]["value"], 25)
        self.assertEqual(self.state(result), "unknown")
        self.assertIn("RECONNECT_GAP", result["observations"][0]["freshness"]["reasons"])

    def test_late_old_session_cannot_replace_reconnected_session(self):
        self.write([sample(), sample(sampleId="after-reconnect", connectionId="session-b", sequence=0,
                                     value=25, sampleAt=timestamp(-3), receivedAt=timestamp(-2)),
                    sample(sampleId="old-session", sequence=11, value=-10, receivedAt=timestamp(-1))])
        self.assertEqual(self.read()["observations"][0]["value"], 25)

    def test_sequence_gap_is_explicit(self):
        self.write([sample(), sample(sampleId="after-gap", sequence=13, value=25,
                                     sampleAt=timestamp(-2), receivedAt=timestamp(-1))])
        result = self.read()
        self.assertEqual(self.state(result), "unknown")
        self.assertIn("SEQUENCE_GAP", result["observations"][0]["freshness"]["reasons"])

    def test_asset_request_and_external_grant_only_narrow(self):
        self.write([sample(), sample(sampleId="other", assetId="machine-b", value=99),
                    sample(sampleId="private", deviceId="private-sensor", classification="internal", value=99)])
        result = self.read()
        self.assertEqual(len(result["observations"]), 1)
        self.assertNotIn("private-sensor", json.dumps(result))
        self.assertNotIn("machine-b", json.dumps(result))
        self.assertEqual(self.state(self.read("machine-unknown")), "unknown")
        local = Grant("project-a", "site-a", "local")
        result = read_observations(ReplayObservationSource(self.path, local), local, "machine-a", now=NOW)
        self.assertEqual(len(result["observations"]), 2)

    def test_project_site_source_mismatch_returns_no_samples(self):
        for field in ("projectId", "site", "sourceId"):
            original = self.document[field]
            self.write(**{field: "another-owner"})
            result = self.read()
            self.assertEqual(self.state(result), "invalid")
            self.assertEqual(result["observations"], [])
            self.document[field] = original

    def test_source_recheck_same_revision_changed_bytes_is_rejected(self):
        owner = self
        class ChangingSource(ReplayObservationSource):
            count = 0
            def read(self, asset_id):
                result = super().read(asset_id)
                self.count += 1
                if self.count == 1:
                    owner.write([sample(value=99)])
                return result
        with self.assertRaises(ObservationError) as error:
            self.read(source=ChangingSource(self.path, self.grant))
        self.assertEqual(error.exception.code, "SOURCE_CHANGED")

    def test_explicit_revocation_returns_no_cached_samples_ids_or_version(self):
        self.assertTrue(self.read()["observations"])
        self.source.revoke()
        result = self.read()
        self.assertEqual(self.state(result), "revoked")
        self.assertEqual(result["observations"], [])
        self.assertEqual(result["evidence"], [])
        self.assertIsNone(result["source"]["version"])
        self.assertNotIn("sample-a", json.dumps(result))

    def test_permission_callback_rechecks_and_can_revoke_between_reads(self):
        count = 0
        def allowed():
            nonlocal count
            count += 1
            return count < 3
        source = ReplayObservationSource(self.path, self.grant, authorize=allowed)
        result = self.read(source=source)
        self.assertEqual(self.state(result), "revoked")
        self.assertEqual(result["observations"], [])
        self.assertNotIn("sample-a", json.dumps(result))

    def test_failing_permission_check_is_revoked(self):
        def failure():
            raise RuntimeError("private-provider-details")
        result = self.read(source=ReplayObservationSource(self.path, self.grant, authorize=failure))
        self.assertEqual(self.state(result), "revoked")
        self.assertNotIn("private-provider-details", json.dumps(result))

    def test_unavailable_source_is_not_a_cache_hit_and_recovers(self):
        self.assertTrue(self.read()["observations"])
        self.path.unlink()
        result = self.read()
        self.assertEqual(self.state(result), "unavailable")
        self.assertEqual(result["observations"], [])
        self.write([sample(value=26)], revision=2)
        self.assertEqual(self.read()["observations"][0]["value"], 26)

    def test_revoked_and_unavailable_replay_state_withholds_measurements(self):
        for state in ("revoked", "unavailable"):
            self.write([], state=state)
            result = self.read()
            self.assertEqual(self.state(result), state)
            self.assertEqual(result["observations"], [])
            self.write([sample()], state=state)
            self.assertEqual(self.state(self.read()), "invalid")

    def test_malformed_duplicate_json_and_nonfinite_are_invalid(self):
        valid = json.dumps(self.document)
        invalids = ["{", valid.replace('"revision": 1', '"revision": 1, "revision": 2'),
                    valid.replace('24.5', 'NaN'), valid.replace('24.5', 'Infinity'),
                    valid.replace('24.5', '1e999'), valid.replace('"revision": 1', '"revision": true')]
        for raw in invalids:
            with self.subTest(raw=raw[:20]):
                self.path.write_text(raw, encoding="utf-8")
                result = self.read()
                self.assertEqual(self.state(result), "invalid")
                self.assertEqual(result["observations"], [])

    def test_raw_payload_secret_fields_and_arbitrary_text_are_rejected(self):
        invalid_samples = [sample(rawPayload="private fixture"), sample(value="private fixture"),
                           sample(metric="firmware_version", value="password=private-fixture"),
                           sample(password="private fixture"), sample(unit="user@example.invalid"),
                           sample(metric="firmware_version", value="ghp_" + "x" * 24)]
        for row in invalid_samples:
            self.write([row])
            result = self.read()
            self.assertEqual(self.state(result), "invalid")
            self.assertNotIn("private fixture", json.dumps(result))
        self.write([sample(metric="firmware_version", unit="", value="v1.2.3-rc.1")])
        self.assertEqual(self.read()["observations"][0]["value"], "v1.2.3-rc.1")

    def test_byte_sample_and_stream_budgets_are_bounded(self):
        self.path.write_bytes(b" " * (MAX_BYTES + 1))
        self.assertEqual(self.state(self.read()), "invalid")
        self.write([sample()] * (MAX_SAMPLES + 1))
        self.assertEqual(self.state(self.read()), "invalid")
        self.write([sample(sampleId=f"s-{index}", deviceId=f"device-{index}") for index in range(129)])
        self.assertEqual(self.state(self.read()), "invalid")

    def test_relative_parent_traversal_paths_and_invalid_request_rejected(self):
        for path in ("relative.json", self.path.parent / ".." / "replay.json"):
            with self.assertRaises(ObservationError):
                ReplayObservationSource(path, self.grant)
        with self.assertRaises(ObservationError) as error:
            self.read("../machine-a")
        self.assertEqual(error.exception.code, "INVALID_ARGUMENT")

    def test_network_device_and_alternate_stream_paths_rejected_before_io(self):
        forbidden = (
            r"\\fixture-host\share\replay.json", "//fixture-host/share/replay.json",
            r"\\?\C:\replay.json", r"\\?\UNC\fixture-host\share\replay.json",
            r"\\.\C:\replay.json", r"\\.\GLOBALROOT\Device\fixture\replay.json",
            str(self.path.parent / "file:stream.json"),
            str(self.path.parent / "file.json:stream.json"),
            str(self.path.parent / "file.json::$DATA"),
        )
        with patch("lmti_agent.observations._path_state") as checked, \
                patch("lmti_agent.observations.os.open") as opened, \
                patch.object(Path, "lstat") as inspected:
            for selected in forbidden:
                with self.subTest(path=selected), self.assertRaises(ObservationError) as error:
                    ReplayObservationSource(selected, self.grant)
                self.assertEqual(error.exception.code, "INVALID_ARGUMENT")
            checked.assert_not_called()
            opened.assert_not_called()
            inspected.assert_not_called()

    def test_reparse_point_in_parent_is_rejected_before_file_is_opened(self):
        original = Path.lstat
        def fake_lstat(path):
            info = original(path)
            if path == self.path.parent:
                class Linked:
                    st_mode = info.st_mode
                    st_file_attributes = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
                return Linked()
            return info
        with patch.object(Path, "lstat", fake_lstat), patch("lmti_agent.observations.os.open") as opened:
            result = self.read()
            self.assertEqual(self.state(result), "invalid")
            opened.assert_not_called()

    def test_owner_grant_changes_before_or_during_read_reject(self):
        self.source.grant = Grant("other-project", "site-a")
        with self.assertRaises(ObservationError) as error:
            self.read()
        self.assertEqual(error.exception.code, "UNAVAILABLE")
        source = ReplayObservationSource(self.path, self.grant)
        original = source.read
        def change_grant(asset):
            result = original(asset)
            source.grant = Grant("other-project", "site-a")
            return result
        source.read = change_grant
        with self.assertRaises(ObservationError) as error:
            self.read(source=source)
        self.assertEqual(error.exception.code, "UNAVAILABLE")

    def test_future_provider_protocol_revalidates_scope_and_data(self):
        snapshot = self.source.read("machine-a")
        class Provider:
            grant = self.grant
            source_id = "provider-a"
            kind = "read_only_provider"
            def read(self, asset_id):
                return snapshot
        provider = Provider()
        result = self.read(source=provider)
        self.assertEqual(result["source"]["authority"], "provider_observation")
        self.assertEqual(result["observations"][0]["value"], 24.5)
        snapshot = replace(snapshot, samples=(replace(snapshot.samples[0], asset_id="machine-b"),))
        with self.assertRaises(ObservationError) as error:
            self.read(source=provider)
        self.assertEqual(error.exception.code, "INVALID_SOURCE_RESPONSE")

    def test_provider_cannot_return_data_with_revoked_state(self):
        captured = self.source.read("machine-a")
        class InvalidProvider:
            grant = self.grant
            source_id = "provider-a"
            kind = "read_only_provider"
            def read(self, asset_id):
                return replace(captured, state="revoked")
        with self.assertRaises(ObservationError) as error:
            self.read(source=InvalidProvider())
        self.assertEqual(error.exception.code, "INVALID_SOURCE_RESPONSE")

    def test_provider_failure_is_typed_without_raw_diagnostic(self):
        class FailedProvider:
            grant = self.grant
            source_id = "provider-a"
            kind = "read_only_provider"
            def read(self, asset_id):
                raise OSError("private-provider-path")
        with self.assertRaises(ObservationError) as error:
            self.read(source=FailedProvider())
        self.assertEqual(error.exception.code, "UNAVAILABLE")
        self.assertNotIn("private-provider-path", str(error.exception))

    def test_source_disappearing_during_recheck_discards_first_values(self):
        owner = self
        class DisappearingSource(ReplayObservationSource):
            count = 0
            def read(self, asset_id):
                result = super().read(asset_id)
                self.count += 1
                if self.count == 1:
                    owner.path.unlink()
                return result
        result = self.read(source=DisappearingSource(self.path, self.grant))
        self.assertEqual(self.state(result), "unavailable")
        self.assertEqual(result["observations"], [])
        self.assertNotIn("sample-a", json.dumps(result))

    def test_permission_revocation_on_next_request_bypasses_old_sample(self):
        allowed = True
        source = ReplayObservationSource(self.path, self.grant, authorize=lambda: allowed)
        self.assertTrue(self.read(source=source)["observations"])
        allowed = False
        result = self.read(source=source)
        self.assertEqual(self.state(result), "revoked")
        self.assertEqual(result["observations"], [])


if __name__ == "__main__":
    unittest.main()
