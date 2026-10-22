"""Strict hierarchy DTO/graph/traversal contracts; fixtures contain no SQL writer."""
from copy import deepcopy
from dataclasses import replace
import json
import unittest
from unittest.mock import Mock, patch

from lmti_agent import Client, Grant, NativeProjectSource
from lmti_agent.integrated import IntegratedClient
from lmti_agent.source import Identity, Relation
from lmti_agent.structure import ENTITY_LIMITS, RELATION_LIMITS
from lmti_project import Client as ProjectClient, ProjectError
from lmti_project.snapshot import validate_snapshot
from lmti_project.structure import ASSET_FIELDS


def snapshot():
    def catalog(key, **extra):
        return {"id": key, "label": "Same label", "privacy": "public", **extra}
    def asset(key, role, parent=""):
        return catalog(key, kind="machine", site="factory", placementDeclared=True,
                       areaId="cell", parentAssetId=parent, environmentId="test", physicalRole=role)
    value = {"schema": "lmti.project.snapshot.v3", "projectId": "project", "site": "factory",
             "revision": 1, "external": True, "complete": True, "semantics": "declared", "structureDeclared": True,
             "components": [catalog("component-a", kind="firmware", repositoryId="repo-a", subsystemId="sensors"),
                            catalog("component-b", kind="firmware", repositoryId="", subsystemId="sensors")],
             "repositories": [catalog("repo-a", locatorFingerprint="a" * 64)],
             "knowledge": [catalog("doc-a", componentId="component-a", referenceFingerprint="b" * 64)],
             "releases": [catalog("release-a", componentId="component-a", state="approved")],
             "assets": [asset("device-a", "device", "gateway-a"), asset("gateway-a", "gateway", "host-a"),
                        asset("host-a", "host"), asset("peer-a", "device", "gateway-a")],
             "bindings": [{"id": "binding-a", "assetId": "device-a", "componentId": "component-a", "desiredReleaseId": "release-a", "privacy": "public"}],
             "dependencies": [], "connections": [],
             "subsystems": [catalog("control", parentSubsystemId=""), catalog("sensors", parentSubsystemId="control")],
             "sites": [catalog("factory")],
             "areas": [catalog("cell", siteId="factory", parentAreaId="floor"), catalog("floor", siteId="factory", parentAreaId="")],
             "environments": [catalog("test")]}
    return value


def graph(value=None):
    value = snapshot() if value is None else value
    validate_snapshot(value, "project", "factory", value["external"], include_structure=True)
    source = NativeProjectSource.__new__(NativeProjectSource)
    source.grant = Grant("project", "factory", "external" if value["external"] else "local")
    source._include_references = True
    source._include_structure = True
    source._owner = Mock()
    source._owner.snapshot.return_value = value
    return source.read()


class Source:
    kind = "native_project"
    def __init__(self, value=None, target="external"):
        self.grant = Grant("project", "factory", target)
        self.value = graph() if value is None else value
        self.include_structure = self.value.structure_declared is not None
    def read(self):
        return self.value


def ids(result):
    return {(row["identity"]["kind"], row["identity"]["sourceEntityId"]) for row in result["data"]["entities"]}


class StructureSnapshotTest(unittest.TestCase):
    def validate(self, value):
        validate_snapshot(value, "project", "factory", value["external"], include_structure=True)

    def test_exact_v3_and_reference_fingerprints(self):
        value = snapshot()
        self.validate(value)
        read = graph(value)
        self.assertTrue(read.structure_declared)
        repository = next(row for row in read.entities if row.identity.kind == "repository")
        self.assertEqual(repository.attributes["locatorFingerprint"], "a" * 64)
        self.assertEqual(sum(ENTITY_LIMITS.values()), 26000)
        self.assertEqual(sum(RELATION_LIMITS.values()), 86000)
        self.assertEqual(Client(Source(read)).context()["status"], "ok")

    def test_exact_fields_types_order_and_no_raw_locator(self):
        mutations = [lambda v: v.update(extra="ignored"), lambda v: v.update(structureDeclared=1),
            lambda v: v["assets"][0].update(placementDeclared=1),
            lambda v: v["assets"][0].update(physicalRole="machine"),
            lambda v: v["components"][0].update(locator="private-path"),
            lambda v: v["subsystems"].reverse(),
            lambda v: v["environments"][0].update(label="bad\nlabel"),
            lambda v: v["repositories"][0].update(locatorFingerprint="not-a-digest")]
        for index, change in enumerate(mutations):
            with self.subTest(index=index):
                value = snapshot(); change(value)
                with self.assertRaises((ValueError, TypeError)):
                    self.validate(value)

    def test_cross_site_missing_parent_and_unreferenced_environment_fail(self):
        mutations = [lambda v: v["sites"][0].update(id="other-site"),
            lambda v: v["areas"][0].update(siteId="other-site"),
            lambda v: v["areas"][0].update(parentAreaId="missing"),
            lambda v: v["components"][0].update(subsystemId="hidden"),
            lambda v: v["assets"][0].update(parentAssetId="hidden"),
            lambda v: v["assets"][0].update(areaId="floor"),
            lambda v: v["assets"][0].update(environmentId=""),
            lambda v: v["environments"].append({"id": "unused", "label": "Unused", "privacy": "public"})]
        for index, change in enumerate(mutations):
            with self.subTest(index=index):
                value = snapshot(); change(value)
                with self.assertRaises(ValueError): self.validate(value)

    def test_hidden_inherited_classification_cannot_be_promoted(self):
        for group, key in (("subsystems", "control"), ("sites", "factory"), ("areas", "floor"),
                           ("assets", "host-a"), ("environments", "test")):
            with self.subTest(group=group):
                value = snapshot(); value["external"] = False
                next(row for row in value[group] if row["id"] == key)["privacy"] = "internal"
                with self.assertRaises(ValueError): self.validate(value)
        value = snapshot(); value["external"] = False
        for group in ("repositories", "components", "knowledge", "releases", "bindings", "assets", "subsystems", "sites", "areas", "environments"):
            for row in value[group]: row["privacy"] = "internal"
        self.validate(value)
        self.assertEqual(Client(Source(graph(value), "local")).context()["status"], "ok")

    def test_cycles_and_combined_depth_include_leaves(self):
        for change in (lambda v: v["subsystems"][0].update(parentSubsystemId="sensors"),
                       lambda v: v["areas"][1].update(parentAreaId="cell"),
                       lambda v: v["assets"][2].update(parentAssetId="device-a")):
            value = snapshot(); change(value)
            with self.assertRaises(ValueError): self.validate(value)
        value = snapshot()
        value["subsystems"] = [{"id": f"sub-{n:02}", "label": "Nested", "privacy": "public", "parentSubsystemId": f"sub-{n-1:02}" if n else ""} for n in range(32)]
        for row in value["components"]: row["subsystemId"] = "sub-30"
        self.validate(value)
        value["components"][0]["subsystemId"] = "sub-31"
        with self.assertRaises(ValueError): self.validate(value)
        value = snapshot()
        value["areas"] = [{"id": f"area-{n:02}", "label": "Nested", "privacy": "public", "siteId": "factory", "parentAreaId": f"area-{n-1:02}" if n else ""} for n in range(30)]
        for row in value["assets"]: row["areaId"] = "area-29"
        with self.assertRaises(ValueError): self.validate(value)  # area30 + host + gateway + device

    def test_unknown_placement_differs_from_explicit_direct_site(self):
        value = snapshot()
        value["assets"] = [value["assets"][2]]
        value["bindings"] = []; value["environments"] = []
        row = value["assets"][0]
        row.update(areaId="", environmentId="", placementDeclared=False, physicalRole="unknown")
        first = graph(value)
        self.assertFalse(any(edge.type == "contains_asset" for edge in first.relations))
        row["placementDeclared"] = True
        second = graph(value)
        relation = next(edge for edge in second.relations if edge.type == "contains_asset")
        self.assertEqual(relation.start, Identity("site", "factory"))
        self.assertNotEqual(first.fingerprint, second.fingerprint)
        row.update(placementDeclared=False, physicalRole="host")
        with self.assertRaises(ValueError): self.validate(value)

    def test_flat_v3_and_absent_selected_site_are_explicit(self):
        value = snapshot(); value["structureDeclared"] = False
        for group in ("subsystems", "sites", "areas", "environments"): value[group] = []
        for row in value["components"]: row["subsystemId"] = ""
        for row in value["assets"]:
            row.update(placementDeclared=False, areaId="", parentAssetId="", environmentId="", physicalRole="unknown")
        self.assertIs(graph(value).structure_declared, False)
        value = snapshot()
        for group in ("sites", "areas", "environments", "assets", "bindings"): value[group] = []
        self.validate(value)  # Same physical result for unknown and denied selected site.

    def test_old_snapshots_stay_strict_and_are_not_silently_upgraded(self):
        value = snapshot()
        for key in ("structureDeclared", "subsystems", "sites", "areas", "environments"): value.pop(key)
        value["schema"] = "lmti.project.snapshot.v2"
        for row in value["components"]: row.pop("subsystemId")
        for row in value["assets"]:
            for key in ASSET_FIELDS: row.pop(key)
        validate_snapshot(value, "project", "factory", True, True)
        with self.assertRaises(ValueError): validate_snapshot(value, "project", "factory", True, include_structure=True)
        value["schema"] = "lmti.project.snapshot.v1"; value.pop("repositories"); value.pop("knowledge")
        for row in value["components"]: row.pop("repositoryId")
        validate_snapshot(value, "project", "factory", True)


class StructureGraphTest(unittest.TestCase):
    def test_adapter_capability_implies_references_and_never_falls_back(self):
        with patch("lmti_agent.source.ProjectClient") as owner:
            source = NativeProjectSource("binary", "database", Grant("project", "factory"), include_structure=True)
            self.assertTrue(source.include_structure)
            with self.assertRaises(AttributeError): source.include_structure = False
            owner.return_value.snapshot.return_value = snapshot()
            self.assertTrue(source.read().structure_declared)
            owner.return_value.snapshot.assert_called_once_with(True, include_structure=True)
            owner.return_value.snapshot.reset_mock()
            owner.return_value.snapshot.side_effect = ProjectError("Unavailable")
            self.assertEqual(Client(source).context()["error"]["code"], "UNAVAILABLE")
            owner.return_value.snapshot.assert_called_once_with(True, include_structure=True)

    def test_default_source_and_mcp_schema_stay_legacy(self):
        from lmti_agent.mcp import Server
        from lmti_agent.client import KINDS, RELATION_TYPES, ALL_KINDS, ALL_RELATION_TYPES
        self.assertEqual(KINDS, ("component", "asset", "release", "repository", "knowledge"))
        self.assertEqual(len(RELATION_TYPES), 6)
        self.assertIn("area", ALL_KINDS)
        self.assertIn("contains_area", ALL_RELATION_TYPES)
        self.assertEqual(len(Server.tools), 4)
        entity_tool = next(tool for tool in Server.tools if tool["name"] == "lmti_entity")
        self.assertEqual(entity_tool["inputSchema"]["properties"]["kind"]["enum"], list(KINDS))
        with patch("lmti_agent.source.ProjectClient") as owner:
            source = NativeProjectSource("binary", "database", Grant("project", "factory"))
            self.assertFalse(source.include_structure)
            owner.return_value.snapshot.side_effect = ProjectError("Unavailable")
            self.assertEqual(Client(source).context()["error"]["code"], "UNAVAILABLE")
            owner.return_value.snapshot.assert_called_once_with(False)
        client = Client(Source())
        self.assertTrue(client.include_structure)
        with self.assertRaises(AttributeError): client.include_structure = False

    def test_legacy_new_kinds_and_filters_fail_before_any_owner_read(self):
        source = Mock()
        source.grant = Grant("project", "factory")
        source.kind = "native_project"
        source.include_structure = False
        source.read.side_effect = AssertionError("Invalid request reached owner")
        for client_type in (Client, IntegratedClient):
            client = client_type(source)
            requests = [lambda: client.entity("site", "factory"),
                        lambda: client.related("area", "cell"),
                        lambda: client.related("component", "component-a", relation_types=["contains_component"]),
                        lambda: client.related("asset", "device-a", relation_types=["declared_connection", "in_environment"])]
            if client_type is IntegratedClient:
                requests.append(lambda: client.task_context("task", "subsystem", "control"))
            for request in requests:
                with self.subTest(client=client_type.__name__, request=request):
                    result = request()
                    self.assertEqual(result["error"]["code"], "INVALID_ARGUMENT")
                    self.assertIsNone(result["data"])
                    source.read.assert_not_called()

    def test_graph_marker_fields_endpoint_matrix_and_classification_are_strict(self):
        original = graph()
        edge = next(row for row in original.relations if row.type == "contains_component")
        mutations = [replace(original, structure_declared=None), replace(original, structure_declared=1),
            replace(original, relations=tuple(row for row in original.relations if row != edge)),
            replace(original, relations=tuple(replace(row, start=Identity("site", "factory")) if row == edge else row for row in original.relations)),
            replace(original, relations=tuple(replace(row, identity=Identity("component_containment", "wrong-child")) if row == edge else row for row in original.relations)),
            replace(original, entities=tuple(replace(row, attributes={**row.attributes, "rawPath": "denied"}) if row.identity.kind == "site" else row for row in original.entities))]
        for index, value in enumerate(mutations):
            with self.subTest(index=index):
                self.assertEqual(Client(Source(value)).context()["error"]["code"], "INVALID_SOURCE_RESPONSE")

    def test_normal_tasks_add_ancestors_without_sibling_shortcuts(self):
        client = IntegratedClient(Source())
        result = client.task_context("code memory", "component", "component-a", depth=4)
        found = ids(result)
        for expected in (("subsystem", "sensors"), ("subsystem", "control"), ("asset", "host-a"), ("site", "factory"), ("environment", "test")):
            self.assertIn(expected, found)
        self.assertNotIn(("component", "component-b"), found)
        self.assertNotIn(("asset", "peer-a"), found)
        asset_result = client.task_context("device", "asset", "device-a", depth=1)
        self.assertNotIn(("asset", "peer-a"), ids(asset_result))
        self.assertIn(("asset", "host-a"), ids(asset_result))

    def test_explicit_container_tasks_can_descend_and_environment_stays_separate(self):
        client = IntegratedClient(Source())
        self.assertIn(("component", "component-b"), ids(client.task_context("subsystem", "subsystem", "sensors", 1)))
        result = client.task_context("site", "site", "factory", 4)
        self.assertIn(("asset", "gateway-a"), ids(result))
        self.assertNotIn(("asset", "device-a"), ids(result))  # Five containment steps from site.
        self.assertIn(("asset", "device-a"), ids(client.task_context("cell", "area", "cell", 3)))
        self.assertNotIn(("component", "component-a"), ids(result))
        environment = client.task_context("environment", "environment", "test", 1)
        self.assertIn(("asset", "peer-a"), ids(environment))
        self.assertTrue(all(edge["type"] != "contains_environment" for edge in environment["data"]["relations"]))

    def test_related_cannot_use_ancestors_as_an_undirected_sibling_route(self):
        client = Client(Source())
        result = client.related("component", "component-a", depth=8)
        self.assertNotIn(("component", "component-b"), ids(result))
        self.assertNotIn(("asset", "peer-a"), ids(result))
        descendant = client.related("asset", "host-a", relation_types=["contains_asset"], direction="outbound", depth=2)
        self.assertIn(("asset", "peer-a"), ids(descendant))

    def test_cursor_invalidates_on_move_privacy_or_capability_change(self):
        source = Source(); client = Client(source)
        cursor = client.context(limit=1)["completeness"]["nextCursor"]
        value = snapshot(); value["components"][0]["subsystemId"] = "control"; value["revision"] = 2
        source.value = graph(value)
        self.assertEqual(client.context(limit=1, cursor=cursor)["error"]["code"], "STALE_CURSOR")
        token = client.context(limit=1)["completeness"]["nextCursor"]
        source.value = replace(source.value, fingerprint="f" * 64)
        self.assertEqual(client.context(limit=1, cursor=token)["error"]["code"], "STALE_CURSOR")

    def test_old_graph_fakes_keep_none_marker_and_original_attribute_contract(self):
        from lmti_agent.source import Entity, GraphRead
        read = GraphRead(1, "e" * 64, "2026-10-19T00:00:00Z", (Entity(Identity("component", "legacy"), "Legacy", "public", {"componentType": "firmware"}, "component"),), ())
        self.assertIsNone(read.structure_declared)
        self.assertEqual(Client(Source(read)).context()["status"], "ok")

    def test_project_client_selects_only_v3_and_never_retries_legacy(self):
        owner = ProjectClient.__new__(ProjectClient)
        owner._grant = Grant("project", "factory")
        for field in ("_binary", "_database"):
            path = Mock()
            path.is_symlink.return_value = False
            path.resolve.return_value = path
            path.is_file.return_value = True
            path.stat.return_value.st_size = 1
            setattr(owner, field, path)
        with patch("lmti_project.client.read_owner", return_value=json.dumps(snapshot()).encode()) as read:
            result = owner.snapshot(include_structure=True)
            self.assertEqual(result["schema"], "lmti.project.snapshot.v3")
            self.assertEqual(read.call_args.args[0][1], "structure-snapshot")
            read.assert_called_once()
        from lmti_common.process import ProcessError
        with patch("lmti_project.client.read_owner", side_effect=ProcessError("OWNER_FAILED")) as read:
            with self.assertRaises(ProjectError): owner.snapshot(include_structure=True)
            read.assert_called_once()
        with patch("lmti_project.client.read_owner") as read:
            with self.assertRaises(ProjectError): owner.snapshot(include_structure=1)
            read.assert_not_called()

    def test_v3_graph_cannot_hide_downgraded_child_classification(self):
        original = graph()
        internal = Identity("subsystem", "control")
        changed = replace(original,
            entities=tuple(replace(row, classification="internal") if row.identity == internal else row for row in original.entities),
            relations=tuple(replace(row, classification="internal") if internal in (row.start, row.end) else row for row in original.relations))
        self.assertEqual(Client(Source(changed, "local")).context()["error"]["code"], "INVALID_SOURCE_RESPONSE")

    def test_capability_marker_is_part_of_cursor_and_inflight_recheck(self):
        value = snapshot()
        for group in ("sites", "areas", "environments", "assets", "bindings", "subsystems"): value[group] = []
        for row in value["components"]: row["subsystemId"] = ""
        value["structureDeclared"] = False
        source = Source(graph(value)); client = Client(source)
        cursor = client.context(limit=1)["completeness"]["nextCursor"]
        old = source.value
        source.value = replace(old, structure_declared=True)
        self.assertEqual(client.context(limit=1, cursor=cursor)["error"]["code"], "STALE_CURSOR")
        with patch.object(source, "read", side_effect=[old, source.value]):
            self.assertEqual(client.context()["error"]["code"], "SOURCE_CHANGED")
        source.include_structure = 1
        with patch.object(source, "read") as read:
            self.assertEqual(client.context()["error"]["code"], "UNAVAILABLE")
            read.assert_not_called()

    def test_container_descendants_are_bounded_and_per_kind_capacity_is_real(self):
        value = snapshot()
        for group in ("sites", "areas", "environments", "assets", "bindings", "repositories", "knowledge", "releases"): value[group] = []
        value["components"] = [{"id": f"component-{n:04}", "label": "Same label", "privacy": "public", "kind": "firmware",
                                 "repositoryId": "", "subsystemId": "sensors"} for n in range(201)]
        result = IntegratedClient(Source(graph(value))).task_context("bounded", "subsystem", "sensors", 1)
        self.assertEqual(len(result["data"]["entities"]), 200)
        self.assertIn("NEIGHBORHOOD_BUDGET", result["completeness"]["reasons"])
        self.assertEqual(result["status"], "partial")
        value["components"] = [{**value["components"][0], "id": f"component-{n:04}"} for n in range(2001)]
        with self.assertRaises(ValueError): validate_snapshot(value, "project", "factory", True, include_structure=True)


if __name__ == "__main__":
    unittest.main()
