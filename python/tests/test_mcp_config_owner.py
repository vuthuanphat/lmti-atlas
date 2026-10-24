from pathlib import Path
from contextlib import contextmanager
import importlib.util
import hashlib
from unittest.mock import patch
import json
import os
import sys
import tempfile
import tomllib
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("mcp_config_owner", ROOT / "scripts/mcp-config-owner.py")
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)


class ClientConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / "build")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def request(self, client="codex", servers=None, action="preview", revision=1):
        if servers is None:
            servers = {"project_docs": {"url": "https://example.com/mcp"}}
        content = json.dumps({"mcpServers": servers}) if client == "cursor" else "\n".join(
            f'[mcp_servers."{key}"]\nurl = {json.dumps(value["url"])}\n' for key, value in servers.items())
        return {"root": str(self.root), "project": "project-A", "client": client,
                "revision": revision, "action": action, "servers": servers, "content": content}

    def apply(self, request):
        preview = owner.operate(request)
        request = dict(request, action="apply", expected=preview["expected"])
        return owner.operate(request)

    def path(self, client):
        return self.root / (".codex/config.toml" if client == "codex" else ".cursor/mcp.json")

    def existing(self, client, value):
        path = self.path(client)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value)

    def test_preview_never_writes_or_returns_existing_secrets(self):
        for client in ("codex", "cursor"):
            data = b'private_value = "sensitive-existing-setting"\n' if client == "codex" else b'{"private_value":"sensitive-existing-setting"}'
            self.existing(client, data)
            result = owner.operate(self.request(client))
            self.assertNotIn("sensitive-existing-setting", json.dumps(result))
            self.assertEqual(data, self.path(client).read_bytes())
            self.assertFalse((self.root / ".lmti-client").exists())
            self.assertFalse(result["verified"])

    def integration_request(self, client="codex", *, structure=False):
        config = self.root / "integration.json"
        data = {"schema":"lmti.agent.integration.v1", "projectId":"project-A", "site":"factory-demo",
                "target":"external", "knowledge":None, "observations":None}
        if structure:
            data.update(schema="lmti.agent.integration.v2", structure=True)
        config.write_text(json.dumps(data), encoding="utf-8")
        arguments = ["-I",str(ROOT / "scripts/lmti-agent-mcp.py"),"--binary",str(self.root / "lmti-project.exe"),
                     "--database",str(self.root / "fixture.sqlite"),"--project","project-A","--site","factory-demo",
                     "--target","external","--integration-config",str(config),"--integration-sha256",hashlib.sha256(config.read_bytes()).hexdigest()]
        definition = {"command":str(Path(sys.executable).resolve()), "args":arguments}
        servers = {"lmti_local":definition}
        content = json.dumps({"mcpServers":servers}) if client == "cursor" else (
            '[mcp_servers.lmti_local]\ncommand = '+json.dumps(definition["command"])+
            '\nargs = '+json.dumps(arguments)+'\n')
        return {"root":str(self.root),"project":"project-A","client":client,"revision":1,
                "action":"preview","servers":servers,"content":content}, config

    def repin_integration(self, request, config, data):
        config.write_text(json.dumps(data), encoding="utf-8")
        definition = request["servers"]["lmti_local"]
        definition["args"][15] = hashlib.sha256(config.read_bytes()).hexdigest()
        request["content"] = (json.dumps({"mcpServers": request["servers"]}) if request["client"] == "cursor" else
            '[mcp_servers.lmti_local]\ncommand = ' + json.dumps(definition["command"]) +
            '\nargs = ' + json.dumps(definition["args"]) + '\n')

    def test_structure_v2_preview_preserves_exact_pinned_launcher(self):
        for client in ("codex", "cursor"):
            with self.subTest(client=client):
                request, config = self.integration_request(client, structure=True)
                before = config.read_bytes()
                arguments = request["servers"]["lmti_local"]["args"][:]
                preview = owner.operate(request)
                self.assertIn("expected", preview)
                self.assertEqual(len(arguments), 16)
                self.assertEqual(arguments, request["servers"]["lmti_local"]["args"])
                self.assertEqual(arguments[12::2], ["--integration-config", "--integration-sha256"])
                self.assertEqual(config.read_bytes(), before)
                self.assertFalse(self.path(client).exists())
                self.assertFalse((self.root / ".lmti-client").exists())

    def test_reviewed_v3_export_preserves_launcher_and_scope_without_mutation(self):
        for client in ("codex", "cursor"):
            with self.subTest(client=client):
                request, config = self.integration_request(client, structure=True)
                data = json.loads(config.read_bytes())
                data.update(schema="lmti.agent.integration.v3", knowledge={"mode": "reviewed"})
                self.repin_integration(request, config, data)
                before = config.read_bytes()
                arguments = request["servers"]["lmti_local"]["args"][:]
                self.assertIn("expected", owner.operate(request))
                self.assertEqual(arguments, request["servers"]["lmti_local"]["args"])
                self.assertEqual(config.read_bytes(), before)
                self.assertFalse(self.path(client).exists())
                self.assertFalse((self.root / ".lmti-client").exists())
                for field, value in (("projectId", "other"), ("site", "other"), ("target", "local")):
                    self.repin_integration(request, config, dict(data, **{field:value}))
                    with self.assertRaises(owner.Refused):
                        owner.operate(request)
                self.repin_integration(request, config, data)
                config.write_bytes(config.read_bytes() + b" ")
                with self.assertRaises(owner.Refused) as rejected:
                    owner.operate(request)
                self.assertEqual(rejected.exception.code, "CONFIG_CHANGED")

    def test_reviewed_v3_export_rejects_manual_or_malformed_capability(self):
        request, config = self.integration_request(structure=True)
        valid = json.loads(config.read_bytes())
        valid.update(schema="lmti.agent.integration.v3", knowledge={"mode":"reviewed"})
        invalid = [dict(valid, knowledge=value) for value in (None, False, [], {}, {"mode":"manual"})]
        invalid += [dict(valid, observations=value) for value in (False, 0, [], "source")]
        invalid += [dict(valid, structure=value) for value in (False, 1, None)]
        invalid += [dict(valid, schema="lmti.agent.integration.v4"), dict(valid, extra=True)]
        for data in invalid:
            with self.subTest(data=data):
                self.repin_integration(request, config, data)
                with patch.object(owner, "atomic") as writes, patch.object(owner, "crypt") as protection:
                    with self.assertRaises(owner.Refused):
                        owner.operate(request)
                writes.assert_not_called()
                protection.assert_not_called()

    def test_structure_capability_requires_exact_version_and_boolean_true(self):
        request, config = self.integration_request(structure=True)
        valid = json.loads(config.read_bytes())
        invalid = [dict(valid, structure=value) for value in (False, 0, 1, None, "true", {}, [])]
        invalid += [dict(valid, schema="lmti.agent.integration.v1"),
                    dict(valid, schema="lmti.agent.integration.v3"), dict(valid, extra=True),
                    {key:value for key,value in valid.items() if key != "structure"},
                    {key:value for key,value in valid.items() if key != "knowledge"}]
        for index, data in enumerate(invalid):
            with self.subTest(case=index):
                self.repin_integration(request, config, data)
                with patch.object(owner, "atomic") as writes, patch.object(owner, "crypt") as protection:
                    with self.assertRaises(owner.Refused):
                        owner.operate(request)
                writes.assert_not_called()
                protection.assert_not_called()
                self.assertFalse(self.path("codex").exists())

    def test_structure_v2_keeps_project_site_external_scope_and_sha_pin(self):
        request, config = self.integration_request(structure=True)
        valid = json.loads(config.read_bytes())
        for field, value in (("projectId", "other-project"), ("site", "other-site"), ("target", "local")):
            with self.subTest(field=field):
                self.repin_integration(request, config, dict(valid, **{field:value}))
                with self.assertRaises(owner.Refused) as rejected:
                    owner.operate(request)
                self.assertEqual(rejected.exception.code, "SCOPE_DENIED")
        self.repin_integration(request, config, valid)
        owner.operate(request)
        config.write_bytes(config.read_bytes() + b" ")
        with self.assertRaises(owner.Refused) as rejected:
            owner.operate(request)
        self.assertEqual(rejected.exception.code, "CONFIG_CHANGED")
        self.assertFalse(self.path("codex").exists())

    @unittest.skipUnless(os.name == "nt", "DPAPI apply/restore is Windows-only")
    def test_structure_v2_apply_and_restore_preserve_reviewed_argv(self):
        for client in ("codex", "cursor"):
            with self.subTest(client=client):
                request, config = self.integration_request(client, structure=True)
                original = b'model="preserved"\n' if client == "codex" else b'{"preserved":true}'
                self.existing(client, original)
                self.assertEqual(self.apply(request)["state"], "applied")
                content = self.path(client).read_bytes()
                parsed = tomllib.loads(content.decode()) if client == "codex" else json.loads(content)
                self.assertEqual(parsed["mcp_servers" if client == "codex" else "mcpServers"]["lmti_local"],
                                 request["servers"]["lmti_local"])
                config.unlink()  # An explicit restore must not require a withdrawn capability file.
                self.assertEqual(owner.operate(dict(request, action="restore"))["state"], "restored")
                self.assertEqual(self.path(client).read_bytes(), original)

    @unittest.skipUnless(os.name == "nt", "DPAPI apply is Windows-only")
    def test_structure_v2_downgrade_during_protection_cannot_write(self):
        request, config = self.integration_request(structure=True)
        preview = owner.operate(request)
        real_crypt = owner.crypt
        def withdraw_capability(value, decrypt=False):
            result = real_crypt(value, decrypt)
            data = json.loads(config.read_bytes())
            data["structure"] = False
            config.write_text(json.dumps(data), encoding="utf-8")
            return result
        with patch.object(owner, "crypt", side_effect=withdraw_capability), patch.object(owner, "atomic") as writes:
            with self.assertRaises(owner.Refused) as rejected:
                owner.operate(dict(request, action="apply", expected=preview["expected"]))
        self.assertEqual(rejected.exception.code, "CONFIG_CHANGED")
        writes.assert_not_called()
        self.assertFalse(self.path("codex").exists())
        self.assertFalse((self.root / ".lmti-client").exists())

    def test_integration_preview_accepts_only_reviewed_scope_and_bytes(self):
        for client in ("codex", "cursor"):
            request, config = self.integration_request(client)
            initial = config.read_bytes()
            preview = owner.operate(request)
            self.assertIn("expected", preview)
            self.assertFalse(self.path(client).exists())
            config.write_bytes(initial + b" ")
            with self.assertRaises(owner.Refused) as rejected:
                owner.operate(request)
            self.assertEqual(rejected.exception.code, "CONFIG_CHANGED")
            config.write_bytes(initial)
            args = request["servers"]["lmti_local"]["args"]
            args[9] = "other-site"
            with self.assertRaises(owner.Refused) as rejected:
                owner.operate(request)
            self.assertEqual(rejected.exception.code, "SCOPE_DENIED")

    @unittest.skipUnless(os.name == "nt", "DPAPI apply is Windows-only")
    def test_integration_apply_preserves_pin_and_changed_source_cannot_write(self):
        for client in ("codex", "cursor"):
            request, config = self.integration_request(client)
            self.assertEqual(self.apply(request)["state"], "applied")
            before = self.path(client).read_bytes()
            parsed = tomllib.loads(before.decode()) if client == "codex" else json.loads(before)
            definition = parsed["mcp_servers" if client == "codex" else "mcpServers"]["lmti_local"]
            self.assertEqual(definition, request["servers"]["lmti_local"])
            preview = owner.operate(request)
            config.write_bytes(config.read_bytes() + b" ")
            with self.assertRaises(owner.Refused):
                owner.operate(dict(request, action="apply", expected=preview["expected"]))
            self.assertEqual(self.path(client).read_bytes(), before)

    def test_integration_change_while_taking_lock_refuses_all_generated_operations(self):
        for client in ("codex", "cursor"):
            for action in ("preview", "status", "apply"):
                with self.subTest(client=client, action=action):
                    request, config = self.integration_request(client)
                    original = b'model="preserved"\n' if client == "codex" else b'{"preserved":true}'
                    self.existing(client, original)
                    preview = owner.operate(request)
                    real_lock = owner.writer_lock
                    @contextmanager
                    def changed_after_lock(root, selected_client):
                        with real_lock(root, selected_client):
                            config.write_bytes(config.read_bytes() + b" ")
                            yield
                    with patch.object(owner, "writer_lock", changed_after_lock), \
                            patch.object(owner, "atomic") as writes, patch.object(owner, "crypt") as protection:
                        with self.assertRaises(owner.Refused) as rejected:
                            owner.operate(dict(request, action=action, expected=preview["expected"]))
                    self.assertEqual(rejected.exception.code, "CONFIG_CHANGED")
                    writes.assert_not_called()
                    protection.assert_not_called()
                    self.assertEqual(self.path(client).read_bytes(), original)
                    self.assertFalse((self.root / ".lmti-client").exists())

    @unittest.skipUnless(os.name == "nt", "DPAPI apply is Windows-only")
    def test_integration_change_during_dpapi_writes_no_backup_journal_or_client(self):
        for client in ("codex", "cursor"):
            with self.subTest(client=client):
                request, config = self.integration_request(client)
                original = b'model="preserved"\n' if client == "codex" else b'{"preserved":true}'
                self.existing(client, original)
                preview = owner.operate(request)
                real_crypt = owner.crypt
                def change_after_protection(value, decrypt=False):
                    result = real_crypt(value, decrypt)
                    self.assertFalse(decrypt)
                    config.write_bytes(config.read_bytes() + b" ")
                    return result
                with patch.object(owner, "crypt", side_effect=change_after_protection) as protection, \
                        patch.object(owner, "atomic") as writes:
                    with self.assertRaises(owner.Refused) as rejected:
                        owner.operate(dict(request, action="apply", expected=preview["expected"]))
                self.assertEqual(rejected.exception.code, "CONFIG_CHANGED")
                protection.assert_called_once()
                writes.assert_not_called()
                self.assertEqual(self.path(client).read_bytes(), original)
                self.assertFalse((self.root / ".lmti-client").exists())

    @unittest.skipUnless(os.name == "nt", "DPAPI recovery is Windows-only")
    def test_apply_recovery_rechecks_pin_after_decrypt_before_restoring(self):
        for client in ("codex", "cursor"):
            with self.subTest(client=client):
                request, config = self.integration_request(client)
                original = b'model="preserved"\n' if client == "codex" else b'{"preserved":true}'
                self.existing(client, original)
                preview = owner.operate(request)
                result, new_state, _ = owner.merge(request, original, None)
                bundle = {"schema": 1, "config": owner.record_bytes(original), "state": None,
                          "after_config": owner.fingerprint(result), "after_state": owner.fingerprint(new_state)}
                journal = self.root / ".lmti-client" / f"{client}.recovery.dpapi"
                owner.atomic(journal, owner.crypt(owner.packed(bundle)))
                self.path(client).write_bytes(result)  # Interrupted transaction fixture.
                before = {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file() and p != config}
                real_crypt = owner.crypt
                def change_after_decrypt(value, decrypt=False):
                    decoded = real_crypt(value, decrypt)
                    self.assertTrue(decrypt)
                    config.write_bytes(config.read_bytes() + b" ")
                    return decoded
                with patch.object(owner, "crypt", side_effect=change_after_decrypt) as protection, \
                        patch.object(owner, "atomic") as writes:
                    with self.assertRaises(owner.Refused) as rejected:
                        owner.operate(dict(request, action="apply", expected=preview["expected"]))
                self.assertEqual(rejected.exception.code, "CONFIG_CHANGED")
                protection.assert_called_once()
                writes.assert_not_called()
                self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file() and p != config})
                # The refused apply leaves recovery available even without its source.
                restored = owner.operate(dict(request, action="restore"))
                self.assertEqual(restored["state"], "restored")
                self.assertEqual(self.path(client).read_bytes(), original)
                self.assertFalse(journal.exists())

    @unittest.skipUnless(os.name == "nt", "DPAPI apply/restore is Windows-only")
    def test_legacy_restore_ignores_changed_or_missing_integration_content(self):
        for client in ("codex", "cursor"):
            for withdrawn in ("changed", "missing"):
                with self.subTest(client=client, withdrawn=withdrawn):
                    request, config = self.integration_request(client)
                    original = b'model="preserved"\n' if client == "codex" else b'{"preserved":true}'
                    self.existing(client, original)
                    self.apply(request)
                    if withdrawn == "missing":
                        config.unlink()
                    else:
                        config.write_bytes(config.read_bytes() + b" ")
                    def guarded(method):
                        def checked(path, *args, **kwargs):
                            if path == config:
                                raise AssertionError("Restore must not inspect the withdrawn integration source")
                            return method(path, *args, **kwargs)
                        return checked
                    with patch.object(Path, "stat", guarded(Path.stat)), \
                            patch.object(Path, "lstat", guarded(Path.lstat)), \
                            patch.object(Path, "open", guarded(Path.open)):
                        result = owner.operate(dict(request, action="restore"))
                    self.assertEqual(result["state"], "restored")
                    self.assertEqual(self.path(client).read_bytes(), original)
                    self.assertFalse((self.root / ".lmti-client" / f"{client}.backup.dpapi").exists())
                    self.assertFalse((self.root / ".lmti-client" / f"{client}.recovery.dpapi").exists())

    def test_restore_pin_exemption_retains_argv_digest_and_local_path_syntax(self):
        request, _ = self.integration_request()
        original = request["servers"]["lmti_local"]["args"]
        for index, value in ((12, "--source-root"), (14, "--hash"), (15, "bad-digest"),
                             (13, r"\\untrusted.invalid\config.json"), (13, "C:/config.json:stream")):
            args = list(original)
            args[index] = value
            with self.subTest(index=index), patch.object(Path, "stat", side_effect=AssertionError("No source I/O")), \
                    patch.object(Path, "lstat", side_effect=AssertionError("No source I/O")), \
                    patch.object(Path, "open", side_effect=AssertionError("No source I/O")):
                with self.assertRaises(owner.Refused):
                    owner.validate_integration_export(args, request["project"], check_content=False)

    def test_remote_integration_paths_are_rejected_before_filesystem_access(self):
        for spelling in (r"\\untrusted.invalid\config.json", "//untrusted.invalid/config.json", "C:/config.json:stream"):
            with patch.object(Path,"lstat",side_effect=AssertionError("Unexpected remote I/O")) as access:
                with self.assertRaises(owner.Refused):
                    owner.safe_path(Path(spelling))
                access.assert_not_called()

    def test_duplicate_invalid_and_injected_input_rejected(self):
        with self.assertRaises(owner.Refused):
            owner.decode('{"a":1,"a":2}')
        for change in ({"project": "x\n"}, {"client": "unknown"}, {"revision": True}, {"revision": 0},
                       {"content": "[other]\nvalue=1"}, {"unknown": 1},
                       {"servers": {"bad": {"command": "powershell", "args": []}}}):
            with self.assertRaises((owner.Refused, ValueError)):
                owner.operate(dict(self.request(), **change))

    def test_unowned_name_collision_preserved(self):
        for client in ("codex", "cursor"):
            request = self.request(client)
            original = request["content"].encode()
            self.existing(client, original)
            with self.assertRaises(owner.Refused):
                owner.operate(request)
            self.assertEqual(self.path(client).read_bytes(), original)

    @unittest.skipUnless(os.name == "nt", "DPAPI apply is Windows-only")
    def test_apply_both_formats_same_profile_preserve_others_and_restore(self):
        for client in ("codex", "cursor"):
            old = b'model="keep"\n[mcp_servers.other]\nurl="https://other.example.com/mcp"\n' if client == "codex" else b'{"mcpServers":{"other":{"url":"https://other.example.com/mcp"}},"setting":true}'
            self.existing(client, old)
            self.assertEqual(self.apply(self.request(client))["state"], "applied")
            value = self.path(client).read_bytes()
            parsed = tomllib.loads(value.decode()) if client == "codex" else json.loads(value)
            servers = parsed["mcp_servers" if client == "codex" else "mcpServers"]
            self.assertEqual(set(servers), {"project_docs", "other"})
            backup = (self.root / ".lmti-client" / f"{client}.backup.dpapi").read_bytes()
            self.assertNotIn(old, backup)
            result = owner.operate(self.request(client, action="status"))
            self.assertEqual(result["state"], "applied")
            self.assertEqual(owner.operate(self.request(client, action="restore"))["state"], "restored")
            self.assertEqual(old, self.path(client).read_bytes())

    @unittest.skipUnless(os.name == "nt", "DPAPI apply is Windows-only")
    def test_revision_update_disable_and_project_isolation(self):
        for client in ("codex", "cursor"):
            self.apply(self.request(client))
            update = self.request(client, servers={}, revision=2)
            self.assertEqual(owner.operate(update)["state"], "update_pending")
            self.apply(update)
            parsed = owner.old_config(self.path(client).read_bytes(), client)[1]
            self.assertEqual(parsed, {})
            with self.assertRaises(owner.Refused):
                owner.operate(dict(update, project="project-B"))

    @unittest.skipUnless(os.name == "nt", "DPAPI apply is Windows-only")
    def test_stale_preview_and_outside_edits_fail_closed(self):
        for client in ("codex", "cursor"):
            request = self.request(client)
            expected = owner.operate(request)["expected"]
            old = b'model="changed"\n' if client == "codex" else b'{"changed":true}'
            self.existing(client, old)
            with self.assertRaises(owner.Refused):
                owner.operate(dict(request, action="apply", expected=expected))
            self.assertEqual(self.path(client).read_bytes(), old)
            self.apply(request)
            current = self.path(client).read_bytes()
            modified = current.replace(b"example.com", b"changed.example.com")
            self.path(client).write_bytes(modified)
            with self.assertRaises(owner.Refused):
                owner.operate(request)
            with self.assertRaises(owner.Refused):
                owner.operate(dict(request, action="restore"))
            self.assertEqual(self.path(client).read_bytes(), modified)

    @unittest.skipUnless(os.name == "nt", "DPAPI apply is Windows-only")
    def test_recovery_journal_restores_partial_commit(self):
        request = self.request("cursor")
        original = b'{"preserved":true}'
        self.existing("cursor", original)
        result, state, _ = owner.merge(request, original, None)
        bundle = {"schema":1, "config":owner.record_bytes(original), "state":None,
                  "after_config":owner.fingerprint(result), "after_state":owner.fingerprint(state)}
        journal = self.root / ".lmti-client/cursor.recovery.dpapi"
        encrypted = owner.crypt(owner.packed(bundle))
        owner.atomic(journal, encrypted)
        owner.atomic(journal.with_name("cursor.backup.dpapi"), encrypted)
        self.path("cursor").write_bytes(result)
        with self.assertRaises(owner.Refused):
            owner.operate(request)
        self.assertEqual(owner.operate(dict(request, action="restore"))["state"], "restored")
        self.assertEqual(self.path("cursor").read_bytes(), original)

    def test_junction_and_file_limits_rejected(self):
        self.existing("cursor", b"x" * (owner.LIMIT + 1))
        with self.assertRaises(owner.Refused):
            owner.operate(self.request("cursor"))
        linked = self.root / "linked"
        try:
            linked.symlink_to(self.root, target_is_directory=True)
        except OSError:
            return  # Windows without symlink privilege: junction coverage is a separate fixture.
        with self.assertRaises(owner.Refused):
            owner.operate(dict(self.request(), root=str(linked)))

    def inspect_request(self, client="cursor", action="inspect"):
        return {"action":action,"root":str(self.root),"client":client,"project":"project-A"}

    def test_inspect_empty_project_needs_no_generation_and_writes_nothing(self):
        result = owner.operate(self.inspect_request())
        self.assertEqual(result["state"], "not_applied")
        self.assertIsNone(result["appliedRevision"])
        self.assertEqual(list(self.root.iterdir()), [])
        with self.assertRaises(owner.Refused):
            owner.operate(dict(self.inspect_request(action="restore_commit"), expected="bad"))

    @unittest.skipUnless(os.name == "nt", "DPAPI is Windows-only")
    def test_restore_preview_is_read_only_and_commit_checks_every_file(self):
        self.existing("cursor", b'{"private":"synthetic-sensitive-setting"}')
        self.apply(self.request("cursor"))
        before = {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        preview = owner.operate(self.inspect_request(action="restore_preview"))
        self.assertNotIn("synthetic-sensitive-setting", json.dumps(preview))
        self.assertEqual(before, {p:p.read_bytes() for p in self.root.rglob('*') if p.is_file()})
        self.path("cursor").write_bytes(self.path("cursor").read_bytes() + b' ')
        with self.assertRaises(owner.Refused) as refused:
            owner.operate(dict(self.inspect_request(action="restore_commit"),expected=preview["expected"]))
        self.assertEqual(refused.exception.code,"CONFIG_CHANGED")
        self.path("cursor").write_bytes(before[self.path("cursor")])
        committed = owner.operate(dict(self.inspect_request(action="restore_commit"),expected=preview["expected"]))
        self.assertEqual(committed["state"],"restored")
        self.assertEqual(self.path("cursor").read_bytes(),b'{"private":"synthetic-sensitive-setting"}')

    @unittest.skipUnless(os.name == "nt", "DPAPI is Windows-only")
    def test_recovery_inspection_and_preview_do_not_recover_partial_write(self):
        request = self.request("cursor")
        original = b'{"preserved":true}'
        self.existing("cursor", original)
        result, state, _ = owner.merge(request, original, None)
        bundle = {"schema":1,"config":owner.record_bytes(original),"state":None,
                  "after_config":owner.fingerprint(result),"after_state":owner.fingerprint(state)}
        journal = self.root / ".lmti-client/cursor.recovery.dpapi"
        owner.atomic(journal,owner.crypt(owner.packed(bundle)))
        self.path("cursor").write_bytes(result)
        self.assertEqual(owner.operate(self.inspect_request())["state"],"recovery_required")
        preview = owner.operate(self.inspect_request(action="restore_preview"))
        self.assertEqual(self.path("cursor").read_bytes(),result)
        self.assertTrue(journal.exists())
        owner.operate(dict(self.inspect_request(action="restore_commit"),expected=preview["expected"]))
        self.assertEqual(self.path("cursor").read_bytes(),original)
        self.assertFalse(journal.exists())

    @unittest.skipUnless(os.name == "nt", "DPAPI is Windows-only")
    def test_typed_collision_and_cross_project_restore_refused(self):
        request = self.request("cursor")
        self.existing("cursor",request["content"].encode())
        with self.assertRaises(owner.Refused) as refused:
            owner.operate(request)
        self.assertEqual(refused.exception.code,"UNMANAGED_COLLISION")
        self.path("cursor").write_bytes(b'{}')
        self.apply(request)
        with self.assertRaises(owner.Refused) as refused:
            owner.operate(dict(self.inspect_request(action="restore_preview"),project="project-B"))
        self.assertEqual(refused.exception.code,"SCOPE_DENIED")


if __name__ == "__main__":
    unittest.main()
