"""Bounded read-only observations; replay files are a test/API boundary, not storage.

The launcher selects the source and its grant. Requests may only narrow to an
asset already authorized by the project owner. A provider can implement the
ObservationSource protocol without introducing network/device actions here.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
from typing import Any, Callable, Protocol

from lmti_common.boundary import identifier, reject_nonfinite, strict_object
from lmti_common.metadata import metadata
from lmti_project import Grant

MAX_BYTES = 256 * 1024
MAX_SAMPLES = 1024
MAX_STREAMS = 128
MAX_CLOCK_SKEW_SECONDS = 30
MAX_SAFE_INTEGER = 9007199254740991
_STATES = {"available", "unavailable", "invalid", "revoked"}
_ERRORS = {
    "INVALID_ARGUMENT": "Observation arguments are invalid.",
    "UNAVAILABLE": "Observation source is unavailable in this scope.",
    "SOURCE_CHANGED": "Observation source changed during the read.",
    "INVALID_SOURCE_RESPONSE": "Observation source response is invalid.",
    "BUDGET_EXCEEDED": "Observation result budget was exceeded.",
}


class ObservationError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(_ERRORS[code])


@dataclass(frozen=True)
class ObservationSample:
    sample_id: str
    asset_id: str
    device_id: str
    metric: str
    unit: str
    value: int | float | bool | str
    sample_at: str
    received_at: str
    ttl_seconds: int
    quality: str
    sequence: int
    connection_id: str
    classification: str


@dataclass(frozen=True)
class ObservationRead:
    revision: int | None
    fingerprint: str | None
    checked_at: str
    state: str
    samples: tuple[ObservationSample, ...]


class ObservationSource(Protocol):
    """Owner adapter: reauthorize and reread on every call, never return a cache."""
    grant: Grant
    source_id: str
    kind: str

    def read(self, asset_id: str) -> ObservationRead: ...


def _id(value: Any) -> str:
    identifier(value)
    metadata(value, 64, required=True)
    return value


def _utc(value: Any) -> datetime:
    if not isinstance(value, str) or not re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", value):
        raise ValueError("Invalid observation timestamp.")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _checked() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def _sample(row: Any) -> ObservationSample:
    keys = {"sampleId", "assetId", "deviceId", "metric", "unit", "value", "sampleAt",
            "receivedAt", "ttlSeconds", "quality", "sequence", "connectionId", "classification"}
    if not isinstance(row, dict) or set(row) != keys:
        raise ValueError("Invalid observation sample.")
    sample = ObservationSample(row["sampleId"], row["assetId"], row["deviceId"],
                               row["metric"], row["unit"], row["value"], row["sampleAt"],
                               row["receivedAt"], row["ttlSeconds"], row["quality"],
                               row["sequence"], row["connectionId"], row["classification"])
    _validate_sample(sample)
    return sample


def _validate_sample(row: ObservationSample) -> None:
    if not isinstance(row, ObservationSample):
        raise ValueError("Invalid observation sample.")
    for value in (row.sample_id, row.asset_id, row.device_id, row.metric, row.connection_id):
        _id(value)
    if (not isinstance(row.unit, str) or not re.fullmatch(r"[A-Za-z0-9%/_.-]{0,24}", row.unit)
            or row.quality not in ("good", "uncertain", "bad")
            or row.classification not in ("public", "internal")
            or type(row.ttl_seconds) is not int or not 1 <= row.ttl_seconds <= 86400
            or type(row.sequence) is not int or not 0 <= row.sequence <= MAX_SAFE_INTEGER):
        raise ValueError("Invalid observation sample metadata.")
    metadata(row.unit, 24)
    _utc(row.sample_at)
    _utc(row.received_at)
    if type(row.value) in (int, float):
        if not math.isfinite(row.value) or abs(row.value) > MAX_SAFE_INTEGER:
            raise ValueError("Invalid observation measurement.")
    elif type(row.value) is bool:
        pass
    elif isinstance(row.value, str) and row.metric in ("software_version", "firmware_version"):
        metadata(row.value, 64, required=True)
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}", row.value):
            raise ValueError("Invalid observed version.")
    else:
        raise ValueError("Raw observation text is not supported.")


def _validate_identities(samples: tuple[ObservationSample, ...]) -> None:
    # A sample identity is global within its source. An exact duplicate is fine,
    # but reusing it for another asset/device/metric breaks evidence references.
    references: dict[str, tuple[str, str, str]] = {}
    for row in samples:
        identity = (row.asset_id, row.device_id, row.metric)
        if row.sample_id in references and references[row.sample_id] != identity:
            raise ValueError("Observation identity is ambiguous.")
        references[row.sample_id] = identity


def _path_state(path: Path) -> tuple[os.stat_result, tuple[tuple[int, int], ...]]:
    """Reject every symlink/junction component, including the selected file."""
    signatures = []
    for part in (*reversed(path.parents), path):
        info = part.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(
                stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
            raise ValueError("Linked observation paths are not permitted.")
        if part != path and not stat.S_ISDIR(info.st_mode):
            raise ValueError("Invalid observation path.")
        signatures.append((info.st_dev, info.st_ino))
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
        raise ValueError("Invalid observation file.")
    return info, tuple(signatures)


class ReplayObservationSource:
    """Explicitly selected nonsecret synthetic replay; never a live-provider claim.

    `authorize` belongs to the trusted launcher and must reevaluate permission.
    Revocation is permanent for this instance. No sample, permission or failed
    read is cached. Recreate an instance for a newly granted connection.
    """
    kind = "controlled_replay"

    def __init__(self, path: str | Path, grant: Grant, source_id: str = "controlled-observations",
                 *, authorize: Callable[[], bool] | None = None):
        try:
            selected = Path(path)
            spelling = str(selected)
            # Reject network/device namespaces and NTFS alternate streams before
            # any filesystem lookup. Opening a UNC replay could initiate SMB
            # authentication even though this adapter is intentionally local.
            if (spelling.replace("\\", "/").startswith("//")
                    or any(ord(char) < 32 for char in spelling)
                    or ":" in spelling[len(selected.drive):]
                    or (os.name == "nt" and not re.fullmatch(r"[A-Za-z]:", selected.drive))
                    or not selected.is_absolute() or ".." in selected.parts or selected.suffix.lower() != ".json"
                    or not isinstance(grant, Grant) or (authorize is not None and not callable(authorize))):
                raise ValueError()
            _id(source_id)
            _id(grant.project_id)
            _id(grant.site)
        except (TypeError, ValueError) as error:
            raise ObservationError("INVALID_ARGUMENT") from error
        self._path = selected
        self.grant = grant
        self.source_id = source_id
        self._authorize = authorize
        self._revoked = False

    def revoke(self) -> None:
        self._revoked = True

    def _allowed(self) -> bool:
        if self._revoked:
            return False
        try:
            return self._authorize is None or self._authorize() is True
        except Exception:
            # A failing permission service must not turn a previous read into access.
            return False

    def _read_bytes(self) -> bytes:
        before, paths_before = _path_state(self._path)
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(self._path, flags)
        with os.fdopen(descriptor, "rb") as stream:
            opened = os.fstat(stream.fileno())
            if ((before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino)
                    or not stat.S_ISREG(opened.st_mode) or opened.st_size > MAX_BYTES):
                raise ValueError("Observation file changed during read.")
            raw = stream.read(MAX_BYTES + 1)
            after_handle = os.fstat(stream.fileno())
        after, paths_after = _path_state(self._path)
        if (len(raw) > MAX_BYTES or paths_before != paths_after
                or (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
                != (after_handle.st_size, after_handle.st_mtime_ns, after_handle.st_ctime_ns)
                # On Windows Python versions, lstat and fstat may give different
                # ctime semantics (creation vs change time). Compare each family
                # to itself; device/inode/size/mtime remain comparable across both.
                or (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                or (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
                != (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)):
            raise ValueError("Observation file changed during read.")
        return raw

    def read(self, asset_id: str) -> ObservationRead:
        try:
            _id(asset_id)
        except ValueError as error:
            raise ObservationError("INVALID_ARGUMENT") from error
        empty = lambda state: ObservationRead(None, None, _checked(), state, ())
        if not self._allowed():
            return empty("revoked")
        try:
            raw = self._read_bytes()
            data = json.loads(raw.decode("utf-8"), parse_constant=reject_nonfinite,
                              object_pairs_hook=strict_object)
            if (not isinstance(data, dict) or set(data) != {"schema", "sourceId", "projectId", "site",
                                                          "revision", "state", "samples"}
                    or data["schema"] != "lmti.observations.replay.v1"
                    or data["sourceId"] != self.source_id or data["projectId"] != self.grant.project_id
                    or data["site"] != self.grant.site or type(data["revision"]) is not int
                    or not 1 <= data["revision"] <= MAX_SAFE_INTEGER
                    or data["state"] not in ("available", "unavailable", "revoked")
                    or not isinstance(data["samples"], list) or len(data["samples"]) > MAX_SAMPLES):
                raise ValueError("Invalid observation replay.")
            if data["state"] != "available":
                if data["samples"]:
                    raise ValueError("Inactive sources must not return samples.")
                return empty(data["state"] if self._allowed() else "revoked")
            samples = tuple(_sample(row) for row in data["samples"])
            _validate_identities(samples)
            # Filter only after validating the full boundary; no unvalidated fields escape.
            visible = tuple(row for row in samples if row.asset_id == asset_id and
                            (self.grant.target == "local" or row.classification == "public"))
            if len({(row.device_id, row.metric) for row in visible}) > MAX_STREAMS:
                raise ValueError("Observation stream limit exceeded.")
            if not self._allowed():
                return empty("revoked")
            return ObservationRead(data["revision"], hashlib.sha256(raw).hexdigest(),
                                   _checked(), "available", visible)
        except OSError:
            return empty("unavailable" if self._allowed() else "revoked")
        except (ValueError, TypeError, UnicodeError, RecursionError, OverflowError):
            return empty("invalid" if self._allowed() else "revoked")


def _validate_read(snapshot: ObservationRead, grant: Grant, asset_id: str) -> None:
    if (not isinstance(snapshot, ObservationRead) or snapshot.state not in _STATES
            or not isinstance(snapshot.samples, tuple) or len(snapshot.samples) > MAX_SAMPLES):
        raise ValueError("Invalid observation source response.")
    _utc(snapshot.checked_at)
    if snapshot.state != "available":
        if snapshot.samples or snapshot.revision is not None or snapshot.fingerprint is not None:
            raise ValueError("Inactive source exposed observation data.")
        return
    if (type(snapshot.revision) is not int or not 1 <= snapshot.revision <= MAX_SAFE_INTEGER
            or not isinstance(snapshot.fingerprint, str)
            or not re.fullmatch(r"[a-f0-9]{64}", snapshot.fingerprint)):
        raise ValueError("Invalid observation source version.")
    for row in snapshot.samples:
        _validate_sample(row)
        if row.asset_id != asset_id or (grant.target == "external" and row.classification != "public"):
            raise ValueError("Observation source exceeded its scope.")
    _validate_identities(snapshot.samples)
    if len({(row.device_id, row.metric) for row in snapshot.samples}) > MAX_STREAMS:
        raise ObservationError("BUDGET_EXCEEDED")


def _select(samples: tuple[ObservationSample, ...]) -> list[tuple[ObservationSample, list[str]]]:
    streams: dict[tuple[str, str], list[ObservationSample]] = {}
    for row in samples:
        streams.setdefault((row.device_id, row.metric), []).append(row)
    result = []
    for stream in sorted(streams):
        seen_ids: dict[str, ObservationSample] = {}
        connections: set[str] = set()
        selected: ObservationSample | None = None
        reasons: set[str] = set()
        for row in sorted(streams[stream], key=lambda item: (_utc(item.received_at), item.sequence, item.sample_id)):
            previous = seen_ids.get(row.sample_id)
            if previous is not None:
                reasons.add("DUPLICATE_SAMPLE" if previous == row else "CONFLICTING_SAMPLE")
                continue
            seen_ids[row.sample_id] = row
            if selected is not None:
                if row.connection_id != selected.connection_id:
                    if row.connection_id in connections:
                        reasons.add("OUT_OF_ORDER_SAMPLE")
                        continue
                    reasons.add("RECONNECT_GAP")
                elif row.sequence <= selected.sequence:
                    reasons.add("CONFLICTING_SEQUENCE" if row.sequence == selected.sequence else "OUT_OF_ORDER_SAMPLE")
                    continue
                elif _utc(row.sample_at) < _utc(selected.sample_at):
                    reasons.add("OUT_OF_ORDER_SAMPLE")
                    continue
                elif row.sequence > selected.sequence + 1:
                    reasons.add("SEQUENCE_GAP")
            connections.add(row.connection_id)
            selected = row
        if selected is not None:
            result.append((selected, sorted(reasons)))
    return result


def read_observations(source: ObservationSource, grant: Grant, asset_id: str, *,
                      now: datetime | None = None) -> dict[str, Any]:
    """Read, validate, recheck and expose only scoped latest measurements.

    Returned keys merge into an Agent response: source, evidence, observations,
    unknowns, conflicts. Native asset authorization is required before this call.
    No raw path, payload, credential, runtime command or database handle is exposed.
    """
    try:
        _id(asset_id)
        if not isinstance(grant, Grant):
            raise ValueError()
        current_time = now if now is not None else datetime.now(timezone.utc)
        if not isinstance(current_time, datetime) or current_time.utcoffset() != timezone.utc.utcoffset(None):
            raise ValueError()
        source_id = _id(source.source_id)
        kind = source.kind
        if kind not in ("controlled_replay", "read_only_provider"):
            raise ValueError()
    except (ValueError, TypeError, AttributeError) as error:
        raise ObservationError("INVALID_ARGUMENT") from error
    try:
        if source.grant != grant:
            raise ObservationError("UNAVAILABLE")
        first = source.read(asset_id)
        _validate_read(first, grant, asset_id)
        second = source.read(asset_id)
        _validate_read(second, grant, asset_id)
        if source.grant != grant or source.source_id != source_id or source.kind != kind:
            raise ObservationError("UNAVAILABLE")
        # A failed second read discards all first-read data. A failed first read
        # never upgrades into success in the same response.
        snapshot = second if second.state != "available" else first
        if first.state == second.state == "available":
            if ((first.revision, first.fingerprint, first.samples)
                    != (second.revision, second.fingerprint, second.samples)):
                raise ObservationError("SOURCE_CHANGED")
            snapshot = second
        controlled = kind == "controlled_replay"
        result: dict[str, Any] = {
            "source": {"sourceId": source_id, "kind": kind,
                       "version": None if snapshot.revision is None else {
                           "type": "replay_revision" if controlled else "provider_revision",
                           "value": snapshot.revision, "fingerprint": snapshot.fingerprint},
                       "checkedAt": snapshot.checked_at,
                       "authority": "controlled_observation" if controlled else "provider_observation",
                       "freshness": {"state": "unknown", "basis": kind,
                                     "sampleAt": None, "ttlSeconds": None}},
            "evidence": [], "observations": [], "unknowns": [], "conflicts": []}
        if snapshot.state != "available":
            result["source"]["freshness"]["state"] = snapshot.state
            result["unknowns"].append({"code": "OBSERVATION_SOURCE_" + snapshot.state.upper(),
                                       "sourceId": source_id})
            return result
        states = []
        for row, reasons in _select(snapshot.samples):
            sample_time, receive_time = _utc(row.sample_at), _utc(row.received_at)
            sample_age = (current_time - sample_time).total_seconds()
            receive_age = (current_time - receive_time).total_seconds()
            age = max(0.0, sample_age, receive_age)
            if (min(sample_age, receive_age) < -MAX_CLOCK_SKEW_SECONDS
                    or (sample_time - receive_time).total_seconds() > MAX_CLOCK_SKEW_SECONDS):
                reasons.append("CLOCK_SKEW")
            if row.quality == "bad":
                reasons.append("BAD_QUALITY")
            if row.quality == "uncertain":
                reasons.append("UNCERTAIN_QUALITY")
            if any(code in reasons for code in ("CLOCK_SKEW", "BAD_QUALITY", "CONFLICTING_SAMPLE", "CONFLICTING_SEQUENCE")):
                state = "invalid"
            elif age > row.ttl_seconds:
                state = "stale"
                reasons.append("TTL_EXPIRED")
            elif any(code in reasons for code in ("UNCERTAIN_QUALITY", "RECONNECT_GAP", "SEQUENCE_GAP")):
                state = "unknown"
            else:
                state = "fresh"
            states.append(state)
            evidence_id = "obs-" + hashlib.sha256(_json([source_id, snapshot.fingerprint, row.sample_id,
                                                         row.device_id, row.metric])).hexdigest()[:32]
            result["evidence"].append({"evidenceId": evidence_id, "sourceId": source_id,
                                       "sourceRevision": snapshot.revision,
                                       "reference": {"kind": "observation", "sourceEntityId": row.sample_id},
                                       "basis": "controlled_replay" if controlled else "provider_observation"})
            result["observations"].append({
                "identity": {"sourceId": source_id, "kind": "observation", "sourceEntityId": row.sample_id},
                "projectId": grant.project_id, "site": grant.site, "assetId": row.asset_id,
                "deviceId": row.device_id, "metric": row.metric, "unit": row.unit,
                "value": None if state == "invalid" else row.value,
                "sampleAt": row.sample_at, "receivedAt": row.received_at,
                "checkedAt": snapshot.checked_at, "ttlSeconds": row.ttl_seconds,
                "quality": row.quality, "classification": row.classification,
                "freshness": {"state": state, "ageSeconds": age, "reasons": sorted(set(reasons))},
                "evidenceIds": [evidence_id]})
            if state != "fresh":
                result["unknowns"].append({"code": "OBSERVATION_" + state.upper(), "sourceId": source_id,
                                           "assetId": row.asset_id, "metric": row.metric})
            if any(code in reasons for code in ("CONFLICTING_SAMPLE", "CONFLICTING_SEQUENCE")):
                result["conflicts"].append({"code": "OBSERVATION_CONFLICT", "sourceId": source_id,
                                            "assetId": row.asset_id, "metric": row.metric})
        priority = {"fresh": 0, "unknown": 1, "stale": 2, "invalid": 3}
        result["source"]["freshness"]["state"] = max(states, key=priority.get) if states else "unknown"
        if not states:
            result["unknowns"].append({"code": "NO_OBSERVATION_IN_SCOPE", "sourceId": source_id})
        if len(_json(result)) > MAX_BYTES:
            raise ObservationError("BUDGET_EXCEEDED")
        return result
    except ObservationError:
        raise
    except OSError as error:
        raise ObservationError("UNAVAILABLE") from error
    except (ValueError, TypeError, AttributeError, OverflowError, UnicodeError, RecursionError) as error:
        raise ObservationError("INVALID_SOURCE_RESPONSE") from error
