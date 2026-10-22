#include "lmti/project_physical_hierarchy.hpp"
#include <algorithm>
#include <map>
#include <set>
#include <type_traits>
#include <utility>

namespace lmti {
PhysicalHierarchyError::PhysicalHierarchyError(PhysicalHierarchyCode code)
    : Error("Physical hierarchy operation was refused."), code_(code) {}

namespace {
using Code = PhysicalHierarchyCode;
using Entity = PhysicalHierarchyEntityKind;
using Key = std::pair<Entity, std::string>;
using Keys = std::set<Key>;
using Ids = std::set<std::string>;
constexpr std::int64_t max_revision = 9007199254740991LL;
[[noreturn]] void fail(Code code) { throw PhysicalHierarchyError(code); }

void optional_id(const std::string &id) { if (!id.empty()) validate_id(id); }
void label(const std::string &id, const std::string &value, Privacy privacy) {
    if (value.size() > 120) fail(Code::InvalidArgument);
    validate_project_info({id, value, "", privacy});
}
void shape(const Site &row) { label(row.id, row.label, row.privacy); }
void shape(const Environment &row) { label(row.id, row.label, row.privacy); }
void shape(const Area &row) {
    label(row.id, row.label, row.privacy);
    validate_id(row.site_id);
    optional_id(row.parent_area_id);
}
void shape(const PhysicalAssetAnchor &row) {
    label(row.id, row.label, row.privacy);
    validate_id(row.site);
    name(row.kind);
}
void shape(const AssetPlacement &row, const std::string &asset) {
    validate_id(row.asset_id);
    if (row.asset_id != asset) fail(Code::InvalidArgument);
    optional_id(row.area_id); optional_id(row.parent_asset_id); optional_id(row.environment_id);
    if (row.role) name(*row.role);
}
void add_string(std::size_t &budget, const std::string &value) {
    budget += 2;
    for (unsigned char ch : value) budget += ch == '"' || ch == '\\' ? 2 : 1;
    if (budget > max_physical_hierarchy_request_bytes) fail(Code::BudgetExceeded);
}
template<class Row> void catalog_budget(std::size_t &budget, const Row &row) {
    add_string(budget, row.id); add_string(budget, row.label); add_string(budget, name(row.privacy));
    if constexpr (std::is_same_v<Row, Area>) {
        add_string(budget, row.site_id); add_string(budget, row.parent_area_id);
    }
}
void placement_budget(std::size_t &budget, const std::optional<AssetPlacement> &row) {
    if (!row) return;
    for (const auto *field : {&row->asset_id, &row->area_id, &row->parent_asset_id, &row->environment_id})
        add_string(budget, *field);
    if (row->role) add_string(budget, name(*row->role));
}
template<class T> constexpr bool adding =
    std::is_same_v<T, AddSite> || std::is_same_v<T, AddArea> || std::is_same_v<T, AddEnvironment>;
template<class T> constexpr bool renaming =
    std::is_same_v<T, RenameSite> || std::is_same_v<T, RenameArea> || std::is_same_v<T, RenameEnvironment>;
template<class T> constexpr Entity entity_kind() {
    if constexpr (std::is_same_v<T, AddSite> || std::is_same_v<T, RenameSite> ||
                  std::is_same_v<T, RetireEmptySite>) return Entity::Site;
    else if constexpr (std::is_same_v<T, AddArea> || std::is_same_v<T, RenameArea> ||
                       std::is_same_v<T, ReparentArea> || std::is_same_v<T, RetireEmptyArea>)
        return Entity::Area;
    else if constexpr (std::is_same_v<T, SetAssetPlacement>) return Entity::Asset;
    else return Entity::Environment;
}
Key target(const PhysicalHierarchyChange &change) {
    return std::visit([](const auto &row) -> Key {
        using T = std::decay_t<decltype(row)>;
        if constexpr (adding<T>) return {entity_kind<T>(), row.desired.id};
        else if constexpr (std::is_same_v<T, SetAssetPlacement>)
            return {Entity::Asset, row.expected_asset.id};
        else return {entity_kind<T>(), row.expected.id};
    }, change);
}
Privacy inherited(Privacy a, Privacy b) {
    return a == Privacy::Public && b == Privacy::Public ? Privacy::Public : Privacy::Internal;
}
PhysicalAssetAnchor anchor(const Asset &asset) {
    return {asset.id, asset.label, asset.site, asset.kind, asset.privacy};
}
struct PathInfo {
    PhysicalHierarchyPath path;
    Privacy privacy = Privacy::Internal;
};
struct View {
    std::map<std::string, const Site *> sites;
    std::map<std::string, const Area *> areas;
    std::map<std::string, const Environment *> environments;
    std::map<std::string, const Asset *> assets;
    std::map<std::string, const AssetPlacement *> placements;
    std::map<Key, PathInfo> paths;
};
std::optional<AssetPlacement> placement(const View &view, const std::string &id) {
    const auto found = view.placements.find(id);
    return found == view.placements.end() ? std::nullopt : std::optional(*found->second);
}

View physical_view(const ProjectDocument &document) {
    // Full typed validation precedes this indexed, iterative walk. Each area
    // and asset is unwound once; copied paths stay within the domain depth cap.
    View view;
    const auto &structure = *document.structure;
    for (const auto &row : structure.sites) {
        view.sites.emplace(row.id, &row);
        view.paths.emplace(Key{Entity::Site, row.id},
            PathInfo{{row.id, {}, {}, ""}, inherited(document.project.privacy, row.privacy)});
    }
    for (const auto &row : structure.areas) view.areas.emplace(row.id, &row);
    for (const auto &row : structure.environments) {
        view.environments.emplace(row.id, &row);
        view.paths.emplace(Key{Entity::Environment, row.id},
            PathInfo{{}, inherited(document.project.privacy, row.privacy)});
    }
    for (const auto &row : document.topology.assets) view.assets.emplace(row.id, &row);
    for (const auto &row : structure.asset_placements) view.placements.emplace(row.asset_id, &row);
    for (const auto &[id, unused] : view.areas) {
        std::vector<std::string> pending;
        auto current = id;
        while (!current.empty() && !view.paths.contains({Entity::Area, current})) {
            if (pending.size() >= max_structure_depth) fail(Code::InvalidArgument);
            pending.push_back(current);
            current = view.areas.at(current)->parent_area_id;
        }
        while (!pending.empty()) {
            const auto child = pending.back(); pending.pop_back();
            const auto &row = *view.areas.at(child);
            PathInfo info{{row.site_id, {}, {}, ""},
                inherited(view.paths.at({Entity::Site, row.site_id}).privacy, row.privacy)};
            if (!row.parent_area_id.empty()) {
                const auto &parent = view.paths.at({Entity::Area, row.parent_area_id});
                info.path.area_ancestors = parent.path.area_ancestors;
                info.path.area_ancestors.push_back(row.parent_area_id);
                info.privacy = inherited(info.privacy, parent.privacy);
            }
            view.paths.emplace(Key{Entity::Area, child}, std::move(info));
        }
    }
    for (const auto &[id, unused] : view.assets) {
        std::vector<std::string> pending;
        auto current = id;
        while (!current.empty() && !view.paths.contains({Entity::Asset, current})) {
            if (pending.size() >= max_structure_depth) fail(Code::InvalidArgument);
            pending.push_back(current);
            const auto found = view.placements.find(current);
            current = found == view.placements.end() ? "" : found->second->parent_asset_id;
        }
        while (!pending.empty()) {
            const auto child = pending.back(); pending.pop_back();
            const auto &asset = *view.assets.at(child);
            PathInfo info{{asset.site, {}, {}, ""},
                inherited(view.paths.at({Entity::Site, asset.site}).privacy, asset.privacy)};
            if (const auto found = view.placements.find(child); found != view.placements.end()) {
                const auto &row = *found->second;
                info.path.environment_id = row.environment_id;
                if (!row.area_id.empty()) {
                    const auto &area = view.paths.at({Entity::Area, row.area_id});
                    info.path.area_ancestors = area.path.area_ancestors;
                    info.path.area_ancestors.push_back(row.area_id);
                    info.privacy = inherited(info.privacy, area.privacy);
                }
                if (!row.environment_id.empty())
                    info.privacy = inherited(info.privacy,
                        view.paths.at({Entity::Environment, row.environment_id}).privacy);
                if (!row.parent_asset_id.empty()) {
                    const auto &parent = view.paths.at({Entity::Asset, row.parent_asset_id});
                    info.path.asset_ancestors = parent.path.asset_ancestors;
                    info.path.asset_ancestors.push_back(row.parent_asset_id);
                    info.privacy = inherited(info.privacy, parent.privacy);
                }
            }
            view.paths.emplace(Key{Entity::Asset, child}, std::move(info));
        }
    }
    return view;
}
bool allowed(const View &view, const PathInfo &info, const PhysicalHierarchyScope &scope) {
    const auto permits = [&](Privacy p) { return scope.allow_internal || p == Privacy::Public; };
    if (!permits(info.privacy)) return false;
    const auto &path = info.path;
    if (!path.site_id.empty() && !permits(view.paths.at({Entity::Site, path.site_id}).privacy))
        return false;
    for (const auto &id : path.area_ancestors)
        if (!permits(view.paths.at({Entity::Area, id}).privacy)) return false;
    for (const auto &id : path.asset_ancestors)
        if (!permits(view.paths.at({Entity::Asset, id}).privacy)) return false;
    return path.environment_id.empty() ||
        permits(view.paths.at({Entity::Environment, path.environment_id}).privacy);
}
void authorize(const View &view, const PathInfo &info, const PhysicalHierarchyScope &scope) {
    if (!allowed(view, info, scope)) fail(Code::ScopeDenied);
}
void authorize_reference(const View &view, const Keys &added, Entity kind,
                         const std::string &id, const PhysicalHierarchyScope &scope) {
    if (id.empty()) return;
    if (const auto found = view.paths.find({kind, id}); found != view.paths.end())
        authorize(view, found->second, scope);
    else if (!added.contains({kind, id})) fail(Code::ScopeDenied);
}
Keys affected(const View &view, const Keys &touched) {
    Keys result = touched;
    for (const auto &[key, info] : view.paths) {
        const auto &path = info.path;
        if ((!path.site_id.empty() && touched.contains({Entity::Site, path.site_id})) ||
            (!path.environment_id.empty() && touched.contains({Entity::Environment, path.environment_id})) ||
            std::any_of(path.area_ancestors.begin(), path.area_ancestors.end(),
                [&](const auto &id) { return touched.contains({Entity::Area, id}); }) ||
            std::any_of(path.asset_ancestors.begin(), path.asset_ancestors.end(),
                [&](const auto &id) { return touched.contains({Entity::Asset, id}); }))
            result.insert(key);
    }
    return result;
}
void authorize_original(const View &before, const Keys &touched, const PhysicalHierarchyScope &scope) {
    for (const auto &key : affected(before, touched))
        if (const auto found = before.paths.find(key); found != before.paths.end())
            authorize(before, found->second, scope);
}
void authorize_desired(const View &before, const Keys &added, const PhysicalHierarchyChange &change,
                       const PhysicalHierarchyScope &scope) {
    std::visit([&](const auto &row) {
        using T = std::decay_t<decltype(row)>;
        if constexpr (std::is_same_v<T, AddArea>) {
            authorize_reference(before, added, Entity::Site, row.desired.site_id, scope);
            authorize_reference(before, added, Entity::Area, row.desired.parent_area_id, scope);
        } else if constexpr (std::is_same_v<T, ReparentArea>)
            authorize_reference(before, added, Entity::Area, row.desired_parent_id, scope);
        else if constexpr (std::is_same_v<T, SetAssetPlacement>) {
            if (row.desired) {
                authorize_reference(before, added, Entity::Area, row.desired->area_id, scope);
                authorize_reference(before, added, Entity::Asset, row.desired->parent_asset_id, scope);
                authorize_reference(before, added, Entity::Environment, row.desired->environment_id, scope);
            }
        }
    }, change);
}
template<class Row> void compare_expected(const std::map<std::string, const Row *> &rows, const Row &expected) {
    const auto found = rows.find(expected.id);
    if (found == rows.end()) fail(Code::ScopeDenied);
    if (*found->second != expected) fail(Code::Conflict);
}
template<class Row> Row &find(std::vector<Row> &rows, const std::string &id) {
    const auto found = std::find_if(rows.begin(), rows.end(), [&](const auto &row) { return row.id == id; });
    if (found == rows.end()) fail(Code::ScopeDenied);
    return *found;
}
template<class Row> Ids identities(const std::vector<Row> &rows) {
    Ids result;
    for (const auto &row : rows) result.insert(row.id);
    return result;
}
void final_references(const ProjectDocument &document, const Ids &retired_sites,
                      const Ids &retired_areas, const Ids &retired_environments) {
    const auto &structure = *document.structure;
    if (structure.sites.size() > max_project_records || structure.areas.size() > max_project_records ||
        structure.environments.size() > max_project_records || structure.asset_placements.size() > max_assets)
        fail(Code::BudgetExceeded);
    const auto sites = identities(structure.sites), areas = identities(structure.areas),
               environments = identities(structure.environments), assets = identities(document.topology.assets);
    Ids placements;
    for (const auto &row : structure.asset_placements) placements.insert(row.asset_id);
    for (const auto &row : structure.areas) {
        if (retired_sites.contains(row.site_id) || retired_areas.contains(row.parent_area_id)) fail(Code::Conflict);
        if (!sites.contains(row.site_id) || (!row.parent_area_id.empty() && !areas.contains(row.parent_area_id)))
            fail(Code::ScopeDenied);
    }
    for (const auto &asset : document.topology.assets) {
        if (retired_sites.contains(asset.site)) fail(Code::Conflict);
        if (!sites.contains(asset.site)) fail(Code::ScopeDenied);
    }
    for (const auto &row : structure.asset_placements) {
        if (retired_areas.contains(row.area_id) || retired_environments.contains(row.environment_id))
            fail(Code::Conflict);
        if (!assets.contains(row.asset_id) || (!row.area_id.empty() && !areas.contains(row.area_id)) ||
            (!row.environment_id.empty() && !environments.contains(row.environment_id)) ||
            (!row.parent_asset_id.empty() && !assets.contains(row.parent_asset_id)))
            fail(Code::ScopeDenied);
        if (!row.parent_asset_id.empty() && !placements.contains(row.parent_asset_id)) fail(Code::InvalidArgument);
    }
}
template<class Row> std::optional<Row> optional_row(
    const std::map<std::string, const Row *> &rows, const std::string &id) {
    const auto found = rows.find(id);
    return found == rows.end() ? std::nullopt : std::optional(*found->second);
}
void append_affected(PhysicalHierarchyDiff &diff, const Key &key, const View &before,
                     const View &after, const PhysicalHierarchyScope &scope) {
    PhysicalHierarchyAffectedIdentity row{key.first, key.second, std::nullopt, std::nullopt, {}, {}};
    if (const auto old = before.paths.find(key); old != before.paths.end()) {
        authorize(before, old->second, scope);
        row.before_classification = old->second.privacy;
        row.before_path = old->second.path;
    }
    if (const auto next = after.paths.find(key); next != after.paths.end()) {
        authorize(after, next->second, scope);
        row.after_classification = next->second.privacy;
        row.after_path = next->second.path;
    }
    if (row.before_classification == Privacy::Internal && row.after_classification == Privacy::Public)
        fail(Code::ScopeDenied);
    diff.affected.push_back(std::move(row));
}
void scope_shape(const PhysicalHierarchyScope &scope) {
    validate_id(scope.project_id);
    if (!scope.allow_physical_write) fail(Code::ScopeDenied);
}
void current_shape(const ProjectDocument &current, const std::string &project_id, bool allow_internal) {
    validate_id(project_id);
    if (current.project.id != project_id) fail(Code::ScopeDenied);
    validate(current);
    if (current.project.privacy == Privacy::Internal && !allow_internal) fail(Code::ScopeDenied);
    if (!current.structure || current.topology.revision < 1) fail(Code::Unsupported);
}
void current_shape(const ProjectDocument &current, const PhysicalHierarchyScope &scope) {
    scope_shape(scope);
    current_shape(current, scope.project_id, scope.allow_internal);
}
} // namespace

PhysicalHierarchyProposal normalize_physical_hierarchy_proposal(
    const PhysicalHierarchyScope &scope, const PhysicalHierarchyProposal &proposal) {
    try {
        scope_shape(scope);
        validate_id(proposal.project_id);
        if (scope.project_id != proposal.project_id) fail(Code::ScopeDenied);
        if (proposal.expected_revision < 1 || proposal.expected_revision >= max_revision || proposal.changes.empty())
            fail(Code::InvalidArgument);
        if (proposal.changes.size() > max_physical_hierarchy_changes) fail(Code::BudgetExceeded);
        std::size_t budget = 256;
        add_string(budget, scope.project_id); add_string(budget, proposal.project_id);
        Keys seen;
        for (const auto &change : proposal.changes) {
            if (change.valueless_by_exception()) fail(Code::InvalidArgument);
            budget += 512; // Conservative fixed JSON field/enum/nesting framing.
            std::visit([&](const auto &row) {
                using T = std::decay_t<decltype(row)>;
                if constexpr (adding<T>) {
                    shape(row.desired);
                    if (row.desired.privacy != Privacy::Internal) fail(Code::ScopeDenied);
                    catalog_budget(budget, row.desired);
                } else if constexpr (std::is_same_v<T, SetAssetPlacement>) {
                    shape(row.expected_asset);
                    for (const auto *field : {&row.expected_asset.id, &row.expected_asset.label, &row.expected_asset.site})
                        add_string(budget, *field);
                    add_string(budget, name(row.expected_asset.kind));
                    add_string(budget, name(row.expected_asset.privacy));
                    for (const auto *p : {&row.expected, &row.desired})
                        if (*p) shape(**p, row.expected_asset.id);
                    placement_budget(budget, row.expected); placement_budget(budget, row.desired);
                } else {
                    shape(row.expected); catalog_budget(budget, row.expected);
                    if constexpr (renaming<T>) {
                        label(row.expected.id, row.desired_label, row.expected.privacy);
                        add_string(budget, row.desired_label);
                    } else if constexpr (std::is_same_v<T, ReparentArea>) {
                        optional_id(row.desired_parent_id); add_string(budget, row.desired_parent_id);
                    }
                }
            }, change);
            if (budget > max_physical_hierarchy_request_bytes) fail(Code::BudgetExceeded);
            if (!seen.insert(target(change)).second) fail(Code::InvalidArgument);
        }
        auto normalized = proposal;
        std::sort(normalized.changes.begin(), normalized.changes.end(),
            [](const auto &a, const auto &b) { return target(a) < target(b); });
        return normalized;
    } catch (const PhysicalHierarchyError &) { throw; }
    catch (const Error &) { fail(Code::InvalidArgument); }
    catch (const std::exception &) { fail(Code::OwnerUnavailable); }
}

PhysicalHierarchyProjection project_physical_hierarchy(
    const ProjectDocument &current, const PhysicalHierarchyScope &scope) {
    try {
        current_shape(current, scope);
        const auto view = physical_view(current);
        PhysicalHierarchyProjection result{current.project.id, current.topology.revision, {}, {}, {}, {}};
        for (const auto &[id, row] : view.sites) {
            const auto &info = view.paths.at({Entity::Site, id});
            if (allowed(view, info, scope)) result.sites.push_back({*row, info.privacy});
        }
        for (const auto &[id, row] : view.areas) {
            const auto &info = view.paths.at({Entity::Area, id});
            if (allowed(view, info, scope)) result.areas.push_back({*row, info.path.area_ancestors, info.privacy});
        }
        for (const auto &[id, row] : view.environments) {
            const auto &info = view.paths.at({Entity::Environment, id});
            if (allowed(view, info, scope)) result.environments.push_back({*row, info.privacy});
        }
        for (const auto &[id, row] : view.assets) {
            const auto &info = view.paths.at({Entity::Asset, id});
            if (allowed(view, info, scope))
                result.assets.push_back({anchor(*row), placement(view, id), info.path, info.privacy});
        }
        return result;
    } catch (const PhysicalHierarchyError &) { throw; }
    catch (const Error &) { fail(Code::InvalidArgument); }
    catch (const std::exception &) { fail(Code::OwnerUnavailable); }
}

PhysicalAssetRow project_physical_asset(const ProjectDocument &current,
    const std::string &project_id, const std::string &asset_id, bool allow_internal) {
    try {
        validate_id(asset_id);
        current_shape(current, project_id, allow_internal);
        const auto view = physical_view(current);
        const auto found = view.paths.find({Entity::Asset, asset_id});
        if (found == view.paths.end()) fail(Code::ScopeDenied);
        // authorize consumes visibility only; this read never fabricates the
        // independent physical-edit capability required by the existing API.
        authorize(view, found->second, {project_id, false, allow_internal});
        const auto &asset = *view.assets.at(asset_id);
        return {anchor(asset), placement(view, asset_id), found->second.path, found->second.privacy};
    } catch (const PhysicalHierarchyError &) { throw; }
    catch (const Error &) { fail(Code::InvalidArgument); }
    catch (const std::exception &) { fail(Code::OwnerUnavailable); }
}

PhysicalHierarchyTransition apply_physical_hierarchy(const ProjectDocument &current,
    const PhysicalHierarchyScope &scope, const PhysicalHierarchyProposal &proposal) {
    try {
        const auto normalized = normalize_physical_hierarchy_proposal(scope, proposal);
        current_shape(current, scope);
        if (current.topology.revision != normalized.expected_revision) fail(Code::Conflict);
        const auto before = physical_view(current);
        Keys touched, added;
        for (const auto &change : normalized.changes) {
            const auto key = target(change);
            touched.insert(key);
            std::visit([&](const auto &row) {
                using T = std::decay_t<decltype(row)>;
                if constexpr (adding<T>) added.insert(key);
                else if (!before.paths.contains(key)) fail(Code::ScopeDenied);
            }, change);
        }
        // Whole old subtrees and desired existing references are authorized
        // before expected-value conflicts can disclose their existence.
        authorize_original(before, touched, scope);
        for (const auto &change : normalized.changes) authorize_desired(before, added, change, scope);

        auto draft = current;
        auto &structure = *draft.structure;
        Ids retired_sites, retired_areas, retired_environments;
        for (const auto &change : normalized.changes)
            std::visit([&](const auto &row) {
                using T = std::decay_t<decltype(row)>;
                if constexpr (std::is_same_v<T, AddSite>) {
                    if (before.sites.contains(row.desired.id)) fail(Code::Conflict);
                    structure.sites.push_back(row.desired);
                } else if constexpr (std::is_same_v<T, AddArea>) {
                    if (before.areas.contains(row.desired.id)) fail(Code::Conflict);
                    structure.areas.push_back(row.desired);
                } else if constexpr (std::is_same_v<T, AddEnvironment>) {
                    if (before.environments.contains(row.desired.id)) fail(Code::Conflict);
                    structure.environments.push_back(row.desired);
                } else if constexpr (std::is_same_v<T, SetAssetPlacement>) {
                    const auto found = before.assets.find(row.expected_asset.id);
                    if (found == before.assets.end()) fail(Code::ScopeDenied);
                    if (anchor(*found->second) != row.expected_asset || placement(before, found->first) != row.expected)
                        fail(Code::Conflict);
                    auto item = std::find_if(structure.asset_placements.begin(), structure.asset_placements.end(),
                        [&](const auto &p) { return p.asset_id == row.expected_asset.id; });
                    if (!row.desired) {
                        if (item != structure.asset_placements.end()) structure.asset_placements.erase(item);
                    } else if (item != structure.asset_placements.end()) *item = *row.desired;
                    else structure.asset_placements.push_back(*row.desired);
                } else if constexpr (entity_kind<T>() == Entity::Site) {
                    compare_expected(before.sites, row.expected);
                    if constexpr (renaming<T>) find(structure.sites, row.expected.id).label = row.desired_label;
                    else retired_sites.insert(row.expected.id);
                } else if constexpr (entity_kind<T>() == Entity::Area) {
                    compare_expected(before.areas, row.expected);
                    if constexpr (renaming<T>) find(structure.areas, row.expected.id).label = row.desired_label;
                    else if constexpr (std::is_same_v<T, ReparentArea>)
                        find(structure.areas, row.expected.id).parent_area_id = row.desired_parent_id;
                    else retired_areas.insert(row.expected.id);
                } else {
                    compare_expected(before.environments, row.expected);
                    if constexpr (renaming<T>) find(structure.environments, row.expected.id).label = row.desired_label;
                    else retired_environments.insert(row.expected.id);
                }
            }, change);
        std::erase_if(structure.sites, [&](const auto &row) { return retired_sites.contains(row.id); });
        std::erase_if(structure.areas, [&](const auto &row) { return retired_areas.contains(row.id); });
        std::erase_if(structure.environments, [&](const auto &row) { return retired_environments.contains(row.id); });
        final_references(draft, retired_sites, retired_areas, retired_environments);
        validate_update(current, draft);
        const auto after = physical_view(draft);
        PhysicalHierarchyDiff diff;
        for (const auto &[kind, id] : touched) {
            if (kind == Entity::Site) {
                const auto old = optional_row(before.sites, id), next = optional_row(after.sites, id);
                if (old != next) diff.sites.push_back({id, old, next});
            } else if (kind == Entity::Area) {
                const auto old = optional_row(before.areas, id), next = optional_row(after.areas, id);
                if (old != next) diff.areas.push_back({id, old, next});
            } else if (kind == Entity::Environment) {
                const auto old = optional_row(before.environments, id), next = optional_row(after.environments, id);
                if (old != next) diff.environments.push_back({id, old, next});
            } else {
                const auto old = placement(before, id), next = placement(after, id);
                if (old != next) diff.placements.push_back({id, old, next});
            }
        }
        if (diff.sites.empty() && diff.areas.empty() && diff.environments.empty() && diff.placements.empty())
            fail(Code::InvalidArgument);
        auto all_affected = affected(before, touched);
        const auto new_affected = affected(after, touched);
        all_affected.insert(new_affected.begin(), new_affected.end());
        for (const auto &key : all_affected) append_affected(diff, key, before, after, scope);
        return {std::move(draft), std::move(diff)};
    } catch (const PhysicalHierarchyError &) { throw; }
    catch (const Error &) { fail(Code::InvalidArgument); }
    catch (const std::exception &) { fail(Code::OwnerUnavailable); }
}
} // namespace lmti
