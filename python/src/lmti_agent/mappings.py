"""Fixed accepted-current mapping transport. No SQL or source-content access."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import threading
import time
from typing import Any

from lmti_common.boundary import reject_nonfinite, strict_object
from lmti_project import Grant

FRAME = 4 * 1024 * 1024
CONFIG = 128 * 1024
MAX_SAFE = 9007199254740991
KINDS = {"area", "asset", "component", "environment", "knowledge", "repository", "site", "subsystem"}
CODES = {"INVALID_INPUT", "UNSUPPORTED_FORMAT", "UNSUPPORTED_MAPPING", "SCOPE_DENIED",
         "BUSY", "BUDGET_EXCEEDED", "CONFIG_CHANGED", "SOURCE_UNAVAILABLE", "SOURCE_CHANGED",
         "NATIVE_UNAVAILABLE", "NATIVE_CHANGED", "OWNER_UNAVAILABLE"}


class MappingFailure(Exception):
    def __init__(self, code: str = "OWNER_UNAVAILABLE"):
        self.code = code if code in CODES else "OWNER_UNAVAILABLE"
        super().__init__("Reviewed mappings are unavailable within the fixed scope.")


def require(value: Any) -> None:
    if not value:
        raise ValueError("Invalid reviewed mapping data.")


def exact(value: Any, keys: set[str], optional: set[str] = frozenset()) -> dict:
    require(type(value) is dict and keys <= set(value) <= keys | optional)
    return value


def text(value: Any, limit: int) -> str:
    require(type(value) is str and value.strip() and len(value.encode("utf-16-be")) // 2 <= limit
            and not any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in value))
    return value


def byte_text(value: Any, limit: int) -> str:
    text(value, limit)
    require(len(value.encode("utf-8")) <= limit)
    return value


def ident(value: Any, native: bool = False) -> str:
    text(value, 64 if native else 100)
    require(re.fullmatch(r"[A-Za-z][A-Za-z0-9._-]*" if native else r"[A-Za-z][A-Za-z0-9._:-]*", value))
    return value


def hex64(value: Any) -> str:
    require(type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value))
    return value


def uuid(value: Any) -> str:
    require(type(value) is str and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", value)
            and value != "00000000-0000-0000-0000-000000000000")
    return value


def integer(value: Any, minimum: int = 0, maximum: int = MAX_SAFE) -> int:
    require(type(value) is int and minimum <= value <= maximum)
    return value


def privacy(value: Any) -> str:
    require(type(value) is str and value in {"public", "internal"})
    return value


def timestamp(value: Any) -> str:
    text(value, 40)
    require(re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z", value))
    datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value


def scalar_data(value: Any, depth: int = 0, nodes: list[int] | None = None) -> None:
    if nodes is None:
        nodes = [0]
    nodes[0] += 1
    require(depth <= 32 and nodes[0] <= 1_000_000)
    if value is None or type(value) is bool:
        return
    if type(value) is int:
        require(-MAX_SAFE <= value <= MAX_SAFE)
        return
    if type(value) is str:
        require(not any(0xD800 <= ord(c) <= 0xDFFF for c in value))
        return
    require(type(value) in (list, dict))
    if type(value) is list:
        require(len(value) <= 100000)
        for item in value:
            scalar_data(item, depth + 1, nodes)
    else:
        for key, item in value.items():
            require(type(key) is str)
            scalar_data(key, depth + 1, nodes)
            scalar_data(item, depth + 1, nodes)


def canonical(value: Any) -> bytes:
    """Current DTO contains only safe integers; UTF-16 key order matches TS."""
    scalar_data(value)

    def encode(item):
        if type(item) is dict:
            return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + encode(item[k])
                                  for k in sorted(item, key=lambda s: s.encode("utf-16-be"))) + "}"
        if type(item) is list:
            return "[" + ",".join(encode(v) for v in item) + "]"
        return json.dumps(item, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return encode(value).encode("utf-8")


def tagged(domain: str, value: Any) -> str:
    return hashlib.sha256(domain.encode() + b"\n" + canonical(value)).hexdigest()


def strict_json(raw: bytes, maximum: int, framed: bool = False) -> dict:
    require(type(raw) is bytes and 0 < len(raw) <= maximum and not raw.startswith(b"\xef\xbb\xbf"))
    if framed:
        require(raw.startswith(b"{") and raw.endswith(b"}\n"))
        raw = raw[:-1]
    result = json.loads(raw.decode("utf-8"), parse_constant=reject_nonfinite, object_pairs_hook=strict_object)
    scalar_data(result)
    require(type(result) is dict)
    return result


def lexical(value: Any) -> str:
    byte_text(value, 4096)
    require(not value.startswith(("\\\\", "//")))
    path = Path(value)
    require(path.is_absolute() and (os.name != "nt" or re.match(r"^[A-Za-z]:[\\/]", value)))
    suffix = re.sub(r"^[A-Za-z]:[\\/]", "", value) if os.name == "nt" else value[1:]
    parts = re.split(r"[\\/]", suffix)
    require(1 <= len(parts) <= 64)
    for part in parts:
        require(part and part not in {".", ".."} and not part.endswith((".", " "))
                and not re.search(r'[<>:"|?*\x00-\x1f\x7f]', part)
                and not re.match(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", part, re.I))
    return value


def same_path(left: str, right: str) -> bool:
    return lexical(left).replace("\\", "/") == lexical(right).replace("\\", "/")


def relative(value: Any) -> str:
    byte_text(value, 512)
    require(not Path(value).is_absolute() and ":" not in value)
    parts = re.split(r"[\\/]", value)
    for part in parts:
        require(part and part not in {".", ".."} and not part.endswith((".", " "))
                and not re.search(r'[<>:"|?*\x00-\x1f\x7f]', part)
                and not re.match(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", part, re.I)
                and part.lower() not in {".git", ".lmti", ".ssh", ".aws"})
    return value


def ordinary(value: str, directory: bool = False) -> os.stat_result:
    path = Path(lexical(value))
    for part in (*reversed(path.parents), path):
        info = part.lstat()
        require(not stat.S_ISLNK(info.st_mode) and not getattr(info, "st_file_attributes", 0) & 0x400)
        if part != path or directory:
            require(stat.S_ISDIR(info.st_mode))
        else:
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
    return info


def file_identity(info):
    # Windows path and handle stat may expose different ctime semantics.
    # Compare their common identity/content metadata, retaining both clocks
    # separately below rather than discarding either change detector.
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
            getattr(info, "st_birthtime_ns", None), info.st_nlink, stat.S_IFMT(info.st_mode))


def file_signature(info):
    return file_identity(info) + (info.st_ctime_ns,)


def wait_closed(child) -> int:
    """A wait API error is not child closure; admission remains held."""
    while True:
        try:
            return child.wait()
        except (OSError, subprocess.SubprocessError):
            time.sleep(.01)


class FilePin:
    """Captured ordinary identity plus an explicitly reviewed byte hash."""
    def __init__(self, path: str, digest: str, maximum: int = 256 * 1024 * 1024):
        self.path, self.digest, self.maximum = lexical(path), hex64(digest), maximum
        self.signature = None
        self.handle_signature = None
        self.verify()

    def verify(self, contents: bool = False) -> bytes:
        before = ordinary(self.path)
        require(before.st_size <= self.maximum)
        digest, parts, length = hashlib.sha256(), [], 0
        with open(self.path, "rb") as handle:
            opened = os.fstat(handle.fileno())
            require(file_identity(before) == file_identity(opened))
            handle_signature = file_signature(opened)
            while True:
                chunk = handle.read(65536)
                if not chunk:
                    break
                length += len(chunk)
                require(length <= self.maximum)
                digest.update(chunk)
                if contents:
                    parts.append(chunk)
            require(handle_signature == file_signature(os.fstat(handle.fileno())))
        after = ordinary(self.path)
        signature = file_signature(after)
        require(signature == file_signature(before) and length == before.st_size
                and hmac.compare_digest(digest.hexdigest(), self.digest))
        if self.signature is not None:
            require(signature == self.signature and handle_signature == self.handle_signature)
        else:
            self.signature = signature
            self.handle_signature = handle_signature
        return b"".join(parts)


def _native_storage_schema(tag: Any) -> int:
    # Fixed opt-in; neither unknown tags nor observation contents choose a mode.
    require(type(tag) is str and tag in {
        "lmti.impact.mapping-native.v1", "lmti.impact.mapping-native.v2"})
    return 2 if tag == "lmti.impact.mapping-native.v1" else 3


def checked_config(value: Any, binding: dict, grant: Grant, binary: str, database: str) -> dict:
    c = deepcopy(exact(value, {"schema", "storePath", "storeUuid", "sourceIdentityDigest", "grant", "authority", "native", "source"}))
    require(c["schema"] == "lmti.agent.mapping-owner.v1")
    lexical(c["storePath"]); uuid(c["storeUuid"]); hex64(c["sourceIdentityDigest"])
    g = exact(c["grant"], {"principalId", "projectId", "siteIds", "environmentIds", "allowInternal", "policyVersion"})
    ident(g["principalId"]); ident(g["projectId"], True); text(g["policyVersion"], 160)
    require(type(g["allowInternal"]) is bool and g["allowInternal"] == (grant.target == "local"))
    a = exact(c["authority"], {"sourceId", "projectId", "siteId", "environmentId", "kind", "minimumClassification",
                              "sourceAuthorityFingerprint", "nativeProjectId", "nativeStoreUuid", "nativeAuthorityFingerprint", "policyVersion"})
    ident(a["sourceId"]); uuid(a["nativeStoreUuid"]); privacy(a["minimumClassification"]); text(a["policyVersion"], 160)
    for key in ("projectId", "siteId", "environmentId", "nativeProjectId"):
        ident(a[key], True)
    for key in ("sourceAuthorityFingerprint", "nativeAuthorityFingerprint"):
        hex64(a[key])
    require(a["kind"] in {"manifest", "code"} and a["sourceId"] == binding["mappingOwner"]["sourceId"]
            and a["projectId"] == a["nativeProjectId"] == g["projectId"] == grant.project_id
            and a["siteId"] == grant.site and g["siteIds"] == [a["siteId"]]
            and g["environmentIds"] == [a["environmentId"]]
            and (g["allowInternal"] or a["minimumClassification"] == "public"))
    n = exact(c["native"], {"schema", "executable", "executableDigest", "database", "projectId", "storeUuid", "siteId", "environmentId", "visibility"})
    _native_storage_schema(n["schema"])
    require(n["visibility"] == grant.target
            and same_path(n["executable"], binary) and same_path(n["database"], database)
            and n["projectId"] == a["projectId"] and n["storeUuid"] == a["nativeStoreUuid"]
            and n["siteId"] == a["siteId"] and n["environmentId"] == a["environmentId"])
    hex64(n["executableDigest"])
    require(Path(n["executable"]).name.lower() in {"lmti-project", "lmti-project.exe"})
    s = exact(c["source"], {"schema", "sourceId", "projectId", "siteId", "environmentId", "root", "descriptorFile",
                             "parserVersion", "policyVersion", "kind", "minimumClassification", "allowInternal"},
              {"allowedInputs"} if a["kind"] == "code" else set())
    require(s["schema"] == "lmti.impact.mapping-source.v1" and s["kind"] == a["kind"]
            and same_path(s["root"], binding["root"]) and s["sourceId"] == a["sourceId"]
            and all(s[key] == a[key] for key in ("projectId", "siteId", "environmentId", "minimumClassification", "policyVersion"))
            and type(s["allowInternal"]) is bool and (g["allowInternal"] or not s["allowInternal"]))
    relative(s["descriptorFile"]); text(s["parserVersion"], 80)
    if s["kind"] == "code":
        require(s["parserVersion"] == "mapped-named-function-1"
                and s["minimumClassification"] == "public" and s["allowInternal"] is False
                and type(s.get("allowedInputs")) is list and 1 <= len(s["allowedInputs"]) <= 100)
        for name in s["allowedInputs"]:
            relative(name); require(re.search(r"\.(?:ts|js)$", name, re.I))
        require(len(set(v.replace("\\", "/") for v in s["allowedInputs"])) == len(s["allowedInputs"]))
        s["allowedInputs"].sort(key=lambda v: v.encode("utf-16-be"))
    require(tagged("lmti.impact.mapping.native-authority.v1", n) == a["nativeAuthorityFingerprint"]
            and tagged("lmti.impact.mapping.source-authority.v1", s) == a["sourceAuthorityFingerprint"])
    return c


def _target(value: Any, authority: dict) -> dict:
    t = exact(value, {"projectId", "storeUuid", "kind", "id"})
    ident(t["id"], True)
    require(t["projectId"] == authority["nativeProjectId"] and t["storeUuid"] == authority["nativeStoreUuid"]
            and type(t["kind"]) is str and t["kind"] in KINDS)
    return t


def _key(target: dict) -> tuple:
    return tuple(target[k] for k in ("projectId", "storeUuid", "kind", "id"))


def _ordered(rows: list, key) -> None:
    keys = [key(row) for row in rows]
    require(keys == sorted(keys) and len(set(keys)) == len(keys))


def checked_snapshot(value: Any, c: dict) -> dict:
    r = exact(value, {"schema", "storeUuid", "graphRevision", "sourceId", "grantFingerprint", "authorityFingerprint",
                     "accepted", "source", "sourceObservation", "sourceContentFingerprint", "nativeObservation",
                     "mappings", "evidenceBindings", "complete", "checkedAt", "fingerprint"})
    a, g = c["authority"], c["grant"]
    require(r["schema"] == "lmti.impact.mapping-current.v1" and r["complete"] is True
            and r["storeUuid"] == c["storeUuid"] and r["sourceId"] == a["sourceId"])
    integer(r["graphRevision"]); timestamp(r["checkedAt"]); hex64(r["fingerprint"])
    require(r["grantFingerprint"] == hashlib.sha256(canonical(g)).hexdigest()
            and r["authorityFingerprint"] == tagged("lmti.impact.mapping.read-authority.v1", a))
    accepted = exact(r["accepted"], {"batchId", "mappingVersion", "payloadDigest", "reviewedAt"})
    ident(accepted["batchId"]); ident(accepted["mappingVersion"]); hex64(accepted["payloadDigest"]); timestamp(accepted["reviewedAt"])
    require(accepted["batchId"] == "mapping-" + hashlib.sha256(("lmti.impact.mapping.batch.v1\n" + accepted["payloadDigest"]).encode()).hexdigest())
    source = exact(r["source"], {"id", "projectId", "siteId", "environmentId", "privacy", "kind", "revision",
                                 "digest", "capturedAt", "parserVersion", "complete"}, {"maxAgeSeconds"})
    require(source["id"] == a["sourceId"] and all(source[k] == a[k] for k in ("projectId", "siteId", "environmentId", "kind"))
            and source["complete"] is True)
    privacy(source["privacy"]); text(source["revision"], 160); hex64(source["digest"])
    timestamp(source["capturedAt"]); text(source["parserVersion"], 80)
    require(source["parserVersion"] == c["source"]["parserVersion"])
    if "maxAgeSeconds" in source:
        integer(source["maxAgeSeconds"], 1, 31536000)
    so = exact(r["sourceObservation"], {"sourceId", "authorityFingerprint", "revision", "digest", "classification", "checkedAt", "fingerprint"})
    require(so["sourceId"] == a["sourceId"] and so["authorityFingerprint"] == a["sourceAuthorityFingerprint"]
            and so["revision"] == source["revision"] and so["digest"] == source["digest"])
    privacy(so["classification"]); timestamp(so["checkedAt"])
    require(g["allowInternal"] or source["privacy"] == so["classification"] == "public")
    require(so["fingerprint"] == tagged("lmti.impact.mapping.source-observation.v1", {k: v for k, v in so.items() if k not in {"checkedAt", "fingerprint"}}))
    hex64(r["sourceContentFingerprint"])
    no = exact(r["nativeObservation"], {"schema", "projectId", "storeUuid", "revision", "authorityFingerprint", "checkedAt", "fingerprint", "targets"})
    require(type(no["schema"]) is int and no["schema"] == _native_storage_schema(c["native"]["schema"])
            and no["projectId"] == a["nativeProjectId"]
            and no["storeUuid"] == a["nativeStoreUuid"] and no["authorityFingerprint"] == a["nativeAuthorityFingerprint"])
    integer(no["revision"], 1, MAX_SAFE - 1); timestamp(no["checkedAt"])
    require(type(no["targets"]) is list and len(no["targets"]) <= 4000)
    observed = {}
    for o in no["targets"]:
        exact(o, {"target", "effectiveClassification", "ancestryFingerprint", "referenceFingerprint", "identityState"})
        t = _target(o["target"], a); privacy(o["effectiveClassification"]); hex64(o["ancestryFingerprint"])
        require(g["allowInternal"] or o["effectiveClassification"] == "public")
        reference = t["kind"] in {"repository", "knowledge"}
        require(o["identityState"] == ("present_reference" if reference else "active"))
        hex64(o["referenceFingerprint"]) if reference else require(o["referenceFingerprint"] is None)
        observed[_key(t)] = o
    _ordered(no["targets"], lambda row: _key(row["target"]))
    require(no["fingerprint"] == tagged("lmti.impact.mapping.native-observation.v1", {k: v for k, v in no.items() if k not in {"checkedAt", "fingerprint"}}))
    require(type(r["mappings"]) is list and len(r["mappings"]) <= 2000
            and type(r["evidenceBindings"]) is list and len(r["evidenceBindings"]) <= 40000)
    rows, targets, expected_bindings = {}, set(), set()
    for current in r["mappings"]:
        exact(current, {"mapping", "effectiveClassification"}); privacy(current["effectiveClassification"])
        m = current["mapping"]
        common = {"mappingId", "externalKey", "generation", "aliases", "classification", "evidenceIds", "state",
                  "impactEntityId", "replacesMappingId", "kind", "target"}
        require(type(m) is dict and m.get("kind") in {"identity", "code", "document", "memory"})
        exact(m, common | ({"selection", "referenceFingerprint"} if m["kind"] in {"code", "document"}
                           else {"disclosure"} if m["kind"] == "memory" else set()))
        uuid(m["mappingId"]); byte_text(m["externalKey"], 240); ident(m["generation"]); privacy(m["classification"])
        require(m["state"] == "active" and type(m["aliases"]) is list and len(m["aliases"]) <= 32)
        for alias in m["aliases"]:
            byte_text(alias, 240)
        require(m["aliases"] == sorted(set(m["aliases"]), key=lambda v: v.encode("utf-16-be")) and m["externalKey"] not in m["aliases"])
        if m["impactEntityId"] is not None: ident(m["impactEntityId"])
        if m["replacesMappingId"] is not None: uuid(m["replacesMappingId"])
        require(m["mappingId"] != m["replacesMappingId"])
        t = _target(m["target"], a); target_key = _key(t); targets.add(target_key)
        require(target_key in observed)
        if m["kind"] in {"code", "document"}:
            relative(m["selection"]); hex64(m["referenceFingerprint"])
            require("\\" not in m["selection"] and all(part.lower() not in {".azure", "node_modules", ".env"}
                and not part.lower().startswith(".env.") for part in m["selection"].split("/")))
            require(t["kind"] == ("repository" if m["kind"] == "code" else "knowledge")
                    and m["referenceFingerprint"] == observed[target_key]["referenceFingerprint"])
        elif m["kind"] == "memory":
            require(t["kind"] == "component" and m["disclosure"] == "owner_safe_summary")
        else:
            require(t["kind"] not in {"repository", "knowledge"})
        require(type(m["evidenceIds"]) is list and 1 <= len(m["evidenceIds"]) <= 20)
        for eid in m["evidenceIds"]:
            ident(eid); expected_bindings.add((m["mappingId"], eid))
        require(m["evidenceIds"] == sorted(set(m["evidenceIds"])))
        floor = {m["classification"], source["privacy"], so["classification"], a["minimumClassification"], observed[target_key]["effectiveClassification"]}
        require(current["effectiveClassification"] == "internal" or "internal" not in floor)
        require(g["allowInternal"] or current["effectiveClassification"] == "public")
        rows[m["mappingId"]] = current
    _ordered(r["mappings"], lambda row: row["mapping"]["mappingId"])
    require(targets == set(observed))
    for binding in r["evidenceBindings"]:
        exact(binding, {"mappingId", "evidenceId", "evidenceBatchId", "evidence"})
        require((binding["mappingId"], binding["evidenceId"]) in expected_bindings)
        ident(binding["evidenceBatchId"])
        evidence = exact(binding["evidence"], {"id", "locator", "summary", "capturedAt", "privacy"}, {"observedAt", "entityId"})
        require(evidence["id"] == binding["evidenceId"])
        text(evidence["locator"], 512); text(evidence["summary"], 2000); timestamp(evidence["capturedAt"]); privacy(evidence["privacy"])
        if "observedAt" in evidence: timestamp(evidence["observedAt"])
        if "entityId" in evidence: ident(evidence["entityId"])
        require(evidence["privacy"] != "internal" or rows[binding["mappingId"]]["effectiveClassification"] == "internal")
    _ordered(r["evidenceBindings"], lambda row: (row["mappingId"], row["evidenceId"]))
    require({(b["mappingId"], b["evidenceId"]) for b in r["evidenceBindings"]} == expected_bindings)
    body = deepcopy(r); body.pop("fingerprint"); body.pop("checkedAt")
    body["sourceObservation"].pop("checkedAt"); body["nativeObservation"].pop("checkedAt")
    require(r["fingerprint"] == tagged("lmti.impact.mapping.current.v1", body))
    now = datetime.now(timezone.utc)
    for value in (r["checkedAt"], so["checkedAt"], no["checkedAt"]):
        age = (now - datetime.fromisoformat(value.replace("Z", "+00:00"))).total_seconds()
        require(-60 <= age <= 300)
    return deepcopy(r)


class MappingSource:
    """One configured source. Pending workers stay admitted through actual close."""
    def __init__(self, binding: dict, grant: Grant, binary: str, database: str, authorize):
        self.grant, self.binding, self._authorize = grant, deepcopy(binding), authorize
        self._revoked, self._native_revoked, self._lock, self._pending = False, False, threading.Lock(), False
        try:
            exact(binding, {"mode", "node", "nodeSha256", "cli", "cliSha256", "root", "sourceId", "mappingOwner", "memoryDisclosure"})
            require(binding["mode"] == "reviewed" and binding["memoryDisclosure"] in {"none", "owner_safe_summary"})
            exact(binding["mappingOwner"], {"cli", "cliSha256", "config", "configSha256", "sourceId"})
            ident(binding["mappingOwner"]["sourceId"]); hex64(binding["sourceId"])
            require(Path(binding["node"]).name.lower() in {"node", "node.exe"}
                    and Path(binding["cli"]).name == Path(binding["mappingOwner"]["cli"]).name == "index.js")
            self._config_pin = FilePin(binding["mappingOwner"]["config"], binding["mappingOwner"]["configSha256"], CONFIG)
            self.config = checked_config(strict_json(self._config_pin.verify(True), CONFIG), binding, grant, binary, database)
            self._pins = [FilePin(binding["node"], binding["nodeSha256"]),
                          FilePin(binding["cli"], binding["cliSha256"]),
                          FilePin(binding["mappingOwner"]["cli"], binding["mappingOwner"]["cliSha256"]),
                          FilePin(binary, self.config["native"]["executableDigest"])]
            root = ordinary(binding["root"], True)
            self._root_identity = (root.st_dev, root.st_ino)
            self.check()
        except (OSError, ValueError, TypeError, KeyError, UnicodeError, RecursionError) as error:
            raise MappingFailure("INVALID_INPUT") from error

    def check(self):
        if self._revoked:
            raise MappingFailure("CONFIG_CHANGED")
        try:
            require(self._authorize() is True)
            self._config_pin.verify()
            for pin in self._pins: pin.verify()
            root = ordinary(self.binding["root"], True)
            require((root.st_dev, root.st_ino) == self._root_identity)
        except Exception as error:
            self._revoked = True
            raise MappingFailure("CONFIG_CHANGED") from error

    def is_idle(self):
        with self._lock:
            return not self._pending

    def check_native(self):
        # A mapping-config revocation may leave safe native-only reads available;
        # native executable replacement cannot.
        if self._native_revoked:
            raise MappingFailure("CONFIG_CHANGED")
        try:
            require(self._authorize() is True)
            self._pins[-1].verify()
        except Exception as error:
            self._native_revoked = True
            raise MappingFailure("CONFIG_CHANGED") from error

    def read(self, deadline: float) -> dict:
        with self._lock:
            if self._pending:
                raise MappingFailure("BUSY")
            self._pending = True
        done, abandoned = threading.Event(), threading.Event()
        result = {}

        def work():
            try:
                self.check()
                if abandoned.is_set() or time.monotonic() >= deadline:
                    raise MappingFailure("BUDGET_EXCEEDED")
                result["value"] = self._run(abandoned)
                self.check()
            except MappingFailure as error:
                result["error"] = error
            except Exception:
                result["error"] = MappingFailure()
            finally:
                with self._lock: self._pending = False
                done.set()

        try:
            # Normal stdin EOF must not abandon an admitted owner child.
            threading.Thread(target=work, daemon=False).start()
        except Exception as error:
            with self._lock: self._pending = False
            raise MappingFailure() from error
        if not done.wait(max(0, min(95, deadline - time.monotonic()))):
            abandoned.set()
            raise MappingFailure("BUDGET_EXCEEDED")
        if "error" in result:
            raise result["error"]
        return result["value"]

    def _run(self, abandoned: threading.Event) -> dict:
        b = self.binding
        env = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "TEMP", "TMP") if key in os.environ}
        env["PATH"] = str(Path(b["node"]).parent)
        if os.name == "nt":
            env["PATH"] += os.pathsep + str(Path(env.get("SystemRoot", r"C:\Windows")) / "System32")
        child = subprocess.Popen([b["node"], b["mappingOwner"]["cli"], "accepted-mappings",
                                  "--config", b["mappingOwner"]["config"], "--config-sha256", b["mappingOwner"]["configSha256"]],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False,
                                 cwd=str(Path(b["mappingOwner"]["cli"]).parent), env=env,
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        output, errors = bytearray(), []
        overflow = threading.Event()

        def drain(stream, cap, target):
            count = 0
            try:
                while True:
                    chunk = stream.read(65536)
                    if not chunk: break
                    count += len(chunk)
                    if count > cap: overflow.set()
                    elif target is not None: target.extend(chunk)
            except OSError:
                errors.append(True)

        def send():
            try:
                child.stdin.write(canonical({"sourceId": b["mappingOwner"]["sourceId"]}))
                child.stdin.close()
            except (OSError, ValueError):
                errors.append(True)

        started, closed = [], False
        try:
            workers = [threading.Thread(target=drain, args=(child.stdout, FRAME, output), daemon=True),
                       threading.Thread(target=drain, args=(child.stderr, 65536, None), daemon=True),
                       threading.Thread(target=send, daemon=True)]
            try:
                for worker in workers:
                    worker.start()
                    started.append(worker)
            except Exception as error:
                # Closing input requests the fixed entry's bounded input abort.
                # Never infer child closure from setup failure or kill a parent
                # that may already have admitted its own native reader.
                errors.append(True)
                try: child.stdin.close()
                except (OSError, ValueError): pass
                # Drain streams whose workers never started synchronously. The
                # fixed entry bounds its stdout/stderr; admission stays held
                # even if a broken entry never closes.
                if workers[0] not in started: drain(child.stdout, FRAME, output)
                if workers[1] not in started: drain(child.stderr, 65536, None)
                wait_closed(child); closed = True
                for worker in started: worker.join()
                raise MappingFailure() from error
            # No Python parent kill: the fixed entry aborts/drains its native owner.
            # This worker stays admitted even after its caller timed out.
            code = wait_closed(child); closed = True
            for worker in started: worker.join()
            if abandoned.is_set() or overflow.is_set():
                raise MappingFailure("BUDGET_EXCEEDED")
            require(not errors)
            value = strict_json(bytes(output), FRAME, True)
            if set(value) == {"schema", "error"}:
                require(code == 3 and value["schema"] == "lmti.impact.mapping-current.v1"
                        and type(value["error"]) is str and value["error"] in CODES)
                raise MappingFailure(value["error"])
            require(code == 0)
            return checked_snapshot(value, self.config)
        finally:
            if not closed:
                try: child.stdin.close()
                except (OSError, ValueError): pass
                wait_closed(child)
            for worker in started: worker.join()
            for stream in (child.stdin, child.stdout, child.stderr):
                if stream is not None:
                    stream.close()
