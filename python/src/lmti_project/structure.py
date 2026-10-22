"""Read-only validation of declared hierarchy; no inferred placement or SQL model."""
from __future__ import annotations

from lmti_common.boundary import identifier

CATALOG_FIELDS = {
    "subsystems": {"id", "label", "parentSubsystemId", "privacy"},
    "sites": {"id", "label", "privacy"},
    "areas": {"id", "label", "siteId", "parentAreaId", "privacy"},
    "environments": {"id", "label", "privacy"},
}
ASSET_FIELDS = {"placementDeclared", "areaId", "parentAssetId", "environmentId", "physicalRole"}
MAX_DEPTH = 32


def validate_structure(rows, declared: bool, site: str) -> None:
    """Rows are identity-indexed, shape/classification-checked boundary records."""
    if type(declared) is not bool:
        raise ValueError("Invalid structure declaration.")

    def reference(row, field, group, optional=True):
        value = row[field]
        if not isinstance(value, str) or (not optional and not value):
            raise ValueError("Invalid structure reference.")
        if not value:
            return None
        identifier(value)
        parent = rows[group].get(value)
        if parent is None or (parent["privacy"] == "internal" and row["privacy"] != "internal"):
            raise ValueError("Missing or denied structure parent.")
        return parent

    def depths(group, parent_field, bases=None):
        result = {}
        for start in rows[group]:
            if start in result:
                continue
            chain, active, current = [], set(), start
            while current and current not in result:
                if current in active:
                    raise ValueError("Invalid containment cycle.")
                active.add(current)
                chain.append(current)
                if len(chain) > MAX_DEPTH:
                    raise ValueError("Containment depth exceeded.")
                current = rows[group][current][parent_field]
            depth = result.get(current, 0)
            for current in reversed(chain):
                depth = depth + 1 if rows[group][current][parent_field] else (bases or {}).get(current, 1)
                if depth > MAX_DEPTH:
                    raise ValueError("Containment depth exceeded.")
                result[current] = depth
        return result

    if not declared and any(rows[group] for group in CATALOG_FIELDS):
        raise ValueError("Undeclared catalogs cannot be inferred.")
    if any(key != site for key in rows["sites"]):
        raise ValueError("Site exceeds authorized scope.")
    for row in rows["subsystems"].values():
        reference(row, "parentSubsystemId", "subsystems")
    logical_depths = depths("subsystems", "parentSubsystemId")
    for row in rows["components"].values():
        parent = reference(row, "subsystemId", "subsystems")
        if parent is not None and logical_depths[parent["id"]] + 1 > MAX_DEPTH:
            raise ValueError("Component containment depth exceeded.")
        if not declared and row["subsystemId"]:
            raise ValueError("Undeclared component membership.")
    for row in rows["areas"].values():
        if row["siteId"] != site:
            raise ValueError("Area exceeds authorized scope.")
        reference(row, "siteId", "sites", False)
        parent = reference(row, "parentAreaId", "areas")
        if parent is not None and parent["siteId"] != row["siteId"]:
            raise ValueError("Cross-site area containment.")
    area_depths = depths("areas", "parentAreaId")
    bases, environments = {}, set()
    for row in rows["assets"].values():
        if type(row["placementDeclared"]) is not bool or row["physicalRole"] not in ("unknown", "host", "gateway", "device"):
            raise ValueError("Invalid declared placement or role.")
        if row["site"] != site:
            raise ValueError("Asset exceeds authorized scope.")
        if declared:
            reference(row, "site", "sites", False)
        area = reference(row, "areaId", "areas")
        parent = reference(row, "parentAssetId", "assets")
        environment = reference(row, "environmentId", "environments")
        if environment is not None:
            environments.add(environment["id"])
        if not row["placementDeclared"] and (row["areaId"] or row["parentAssetId"] or row["environmentId"] or row["physicalRole"] != "unknown"):
            raise ValueError("Undeclared placement cannot carry inferred values.")
        if not declared and row["placementDeclared"]:
            raise ValueError("Undeclared structure cannot carry placement.")
        if area is not None and area["siteId"] != row["site"]:
            raise ValueError("Cross-site asset placement.")
        if parent is not None and (not parent["placementDeclared"] or
                any(parent[key] != row[key] for key in ("site", "areaId", "environmentId"))):
            raise ValueError("Inconsistent physical parent.")
        bases[row["id"]] = area_depths[row["areaId"]] + 1 if area else 1
    depths("assets", "parentAssetId", bases)
    if environments != set(rows["environments"]):
        raise ValueError("Unreferenced environment exceeds scoped projection.")
