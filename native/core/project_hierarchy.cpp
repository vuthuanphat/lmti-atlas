#include "lmti/project_hierarchy.hpp"
#include <algorithm>
#include <map>
#include <set>
#include <type_traits>
#include <utility>

namespace lmti {
HierarchyError::HierarchyError(HierarchyCode code)
    : Error("Logical hierarchy operation was refused."), code_(code) {}

namespace {
[[noreturn]] void fail(HierarchyCode code) { throw HierarchyError(code); }
constexpr std::int64_t max_revision = 9007199254740991LL;
using Target = std::pair<HierarchyEntityKind, std::string>;
using Ids = std::set<std::string>;

void optional_id(const std::string &id) {
    if (!id.empty()) validate_id(id);
}
void label(const std::string &id, const std::string &value, Privacy privacy) {
    // Bound before constructing the temporary validated metadata record.
    if (value.size() > 120) fail(HierarchyCode::InvalidArgument);
    validate_project_info({id, value, "", privacy});
}
void subsystem_shape(const Subsystem &row) {
    label(row.id, row.label, row.privacy);
    optional_id(row.parent_subsystem_id);
}
void component_shape(const SoftwareComponent &row) {
    label(row.id, row.label, row.privacy);
    optional_id(row.repository_id);
    name(row.kind);
}
void add_string_budget(std::size_t &budget, const std::string &value) {
    // Exact quoted UTF-8 string footprint; controls are already invalid.
    budget += 2;
    for (unsigned char ch : value) budget += ch == '"' || ch == '\\' ? 2 : 1;
    if (budget > max_logical_hierarchy_request_bytes)
        fail(HierarchyCode::BudgetExceeded);
}
void subsystem_budget(std::size_t &budget, const Subsystem &row) {
    for (const auto *field : {&row.id, &row.label, &row.parent_subsystem_id})
        add_string_budget(budget, *field);
    add_string_budget(budget, name(row.privacy));
}
Target target(const LogicalHierarchyChange &change) {
    return std::visit([](const auto &row) -> Target {
        using T = std::decay_t<decltype(row)>;
        if constexpr (std::is_same_v<T, AddSubsystem>)
            return {HierarchyEntityKind::Subsystem, row.desired.id};
        else if constexpr (std::is_same_v<T, SetComponentMembership>)
            return {HierarchyEntityKind::Component, row.expected_component.id};
        else
            return {HierarchyEntityKind::Subsystem, row.expected.id};
    }, change);
}
Privacy inherited(Privacy a, Privacy b) {
    return a == Privacy::Public && b == Privacy::Public ? Privacy::Public : Privacy::Internal;
}
void visible(Privacy privacy, const LogicalHierarchyScope &scope) {
    if (privacy == Privacy::Internal && !scope.allow_internal)
        fail(HierarchyCode::ScopeDenied);
}
struct Path {
    std::vector<std::string> ancestors;
    Privacy privacy = Privacy::Internal;
};
struct LogicalView {
    std::map<std::string, const Subsystem *> subsystems;
    std::map<std::string, const SoftwareComponent *> components;
    std::map<std::string, ComponentMembership> memberships;
    std::map<std::string, Path> subsystem_paths, component_paths;
};
LogicalView logical_view(const ProjectDocument &document) {
    // Callers first validate the complete document: references/cycles/depth are
    // certified. Each node is unwound once; copied review paths are depth-bounded.
    LogicalView result;
    std::map<std::string, Privacy> repository_privacy;
    for (const auto &row : document.repositories)
        repository_privacy.emplace(row.id, row.privacy);
    for (const auto &row : document.structure->subsystems)
        result.subsystems.emplace(row.id, &row);
    for (const auto &row : document.components)
        result.components.emplace(row.id, &row);
    for (const auto &row : document.structure->component_memberships)
        result.memberships.emplace(row.component_id, row);
    for (const auto &[id, unused] : result.subsystems) {
        std::vector<std::string> pending;
        auto current = id;
        while (!current.empty() && !result.subsystem_paths.contains(current)) {
            if (pending.size() >= max_structure_depth) fail(HierarchyCode::InvalidArgument);
            pending.push_back(current);
            current = result.subsystems.at(current)->parent_subsystem_id;
        }
        while (!pending.empty()) {
            const auto child = pending.back();
            pending.pop_back();
            const auto &row = *result.subsystems.at(child);
            Path path;
            path.privacy = inherited(document.project.privacy, row.privacy);
            if (!row.parent_subsystem_id.empty()) {
                const auto &parent = result.subsystem_paths.at(row.parent_subsystem_id);
                path.ancestors = parent.ancestors;
                path.ancestors.push_back(row.parent_subsystem_id);
                path.privacy = inherited(parent.privacy, row.privacy);
            }
            result.subsystem_paths.emplace(child, std::move(path));
        }
    }
    for (const auto &[id, row] : result.components) {
        Path path;
        path.privacy = inherited(document.project.privacy, row->privacy);
        // Snapshot v3 also inherits the linked repository's classification.
        // A repository is not a containment parent, but can hide a component.
        if (!row->repository_id.empty())
            path.privacy = inherited(path.privacy, repository_privacy.at(row->repository_id));
        if (const auto found = result.memberships.find(id); found != result.memberships.end()) {
            const auto &parent = result.subsystem_paths.at(found->second.subsystem_id);
            path.ancestors = parent.ancestors;
            path.ancestors.push_back(found->second.subsystem_id);
            path.privacy = inherited(parent.privacy, path.privacy);
        }
        result.component_paths.emplace(id, std::move(path));
    }
    return result;
}
bool touches(const std::vector<std::string> &path, const Ids &subsystems) {
    return std::any_of(path.begin(), path.end(), [&](const auto &id) { return subsystems.contains(id); });
}
void authorize_path(const LogicalView &view, const Path &path, const LogicalHierarchyScope &scope) {
    visible(path.privacy, scope);
    for (const auto &id : path.ancestors)
        visible(view.subsystem_paths.at(id).privacy, scope);
}
void authorize_original(const LogicalView &view, const Ids &subsystems, const Ids &components,
                        const LogicalHierarchyScope &scope) {
    for (const auto &[id, path] : view.subsystem_paths)
        if (subsystems.contains(id) || touches(path.ancestors, subsystems))
            authorize_path(view, path, scope);
    for (const auto &[id, path] : view.component_paths)
        if (components.contains(id) || touches(path.ancestors, subsystems))
            authorize_path(view, path, scope);
}
std::optional<ComponentMembership> membership(const LogicalView &view, const std::string &id) {
    const auto found = view.memberships.find(id);
    return found == view.memberships.end() ? std::nullopt : std::optional(found->second);
}
void authorize_existing_parent(const LogicalView &before, const std::string &id,
                               const LogicalHierarchyScope &scope) {
    if (const auto found = before.subsystem_paths.find(id); found != before.subsystem_paths.end())
        authorize_path(before, found->second, scope);
}
void append_affected(LogicalHierarchyDiff &diff, HierarchyEntityKind kind, const std::string &id,
                     const LogicalView &before, const LogicalView &after,
                     const LogicalHierarchyScope &scope) {
    const auto &old_paths = kind == HierarchyEntityKind::Subsystem ? before.subsystem_paths : before.component_paths;
    const auto &new_paths = kind == HierarchyEntityKind::Subsystem ? after.subsystem_paths : after.component_paths;
    const auto old = old_paths.find(id), next = new_paths.find(id);
    HierarchyAffectedIdentity row{kind, id, std::nullopt, std::nullopt, {}, {}};
    if (old != old_paths.end()) {
        authorize_path(before, old->second, scope);
        row.before_classification = old->second.privacy;
        row.before_ancestors = old->second.ancestors;
    }
    if (next != new_paths.end()) {
        authorize_path(after, next->second, scope);
        row.after_classification = next->second.privacy;
        row.after_ancestors = next->second.ancestors;
    }
    if (row.before_classification == Privacy::Internal && row.after_classification == Privacy::Public)
        fail(HierarchyCode::ScopeDenied);
    diff.affected.push_back(std::move(row));
}
}

LogicalHierarchyProjection project_logical_hierarchy(const ProjectDocument &current,
    const LogicalHierarchyScope &scope) {
    try {
        validate_id(scope.project_id);
        if (!scope.allow_logical_write || current.project.id != scope.project_id)
            fail(HierarchyCode::ScopeDenied);
        validate(current);
        visible(current.project.privacy, scope);
        if (!current.structure || current.topology.revision < 1)
            fail(HierarchyCode::Unsupported);
        const auto view = logical_view(current);
        // Check every original ancestor, even though inherited privacy already
        // hides descendants. No hidden node can become an apparent root.
        const auto allowed = [&](const Path &path) {
            if (path.privacy == Privacy::Internal && !scope.allow_internal) return false;
            return std::all_of(path.ancestors.begin(), path.ancestors.end(), [&](const auto &id) {
                return scope.allow_internal ||
                    view.subsystem_paths.at(id).privacy == Privacy::Public;
            });
        };
        LogicalHierarchyProjection result{current.project.id, current.topology.revision, {}, {}};
        for (const auto &[id, row] : view.subsystems) {
            const auto &path = view.subsystem_paths.at(id);
            if (allowed(path))
                result.subsystems.push_back({*row, path.ancestors, path.privacy});
        }
        for (const auto &[id, row] : view.components) {
            const auto &path = view.component_paths.at(id);
            if (allowed(path))
                result.components.push_back({*row, membership(view, id), path.ancestors, path.privacy});
        }
        return result;
    } catch (const HierarchyError &) {
        throw;
    } catch (const Error &) {
        fail(HierarchyCode::InvalidArgument);
    }
}

LogicalHierarchyProposal normalize_logical_hierarchy_proposal(
    const LogicalHierarchyScope &scope, const LogicalHierarchyProposal &proposal) {
    try {
        validate_id(scope.project_id);
        validate_id(proposal.project_id);
        if (!scope.allow_logical_write || scope.project_id != proposal.project_id)
            fail(HierarchyCode::ScopeDenied);
        if (proposal.expected_revision < 1 || proposal.expected_revision >= max_revision ||
            proposal.changes.empty())
            fail(HierarchyCode::InvalidArgument);
        if (proposal.changes.size() > max_logical_hierarchy_changes)
            fail(HierarchyCode::BudgetExceeded);
        std::size_t budget = 256; // Envelope, revision and trusted scope framing.
        add_string_budget(budget, proposal.project_id);
        add_string_budget(budget, scope.project_id);
        std::set<Target> seen;
        for (const auto &change : proposal.changes) {
            if (change.valueless_by_exception()) fail(HierarchyCode::InvalidArgument);
            budget += 512; // Upper bound for fixed field names/enums/nesting.
            std::visit([&](const auto &row) {
                using T = std::decay_t<decltype(row)>;
                if constexpr (std::is_same_v<T, AddSubsystem>) {
                    subsystem_shape(row.desired);
                    if (row.desired.privacy != Privacy::Internal) fail(HierarchyCode::ScopeDenied);
                    subsystem_budget(budget, row.desired);
                } else if constexpr (std::is_same_v<T, SetComponentMembership>) {
                    component_shape(row.expected_component);
                    for (const auto *field : {&row.expected_component.id, &row.expected_component.label,
                                              &row.expected_component.repository_id})
                        add_string_budget(budget, *field);
                    add_string_budget(budget, name(row.expected_component.kind));
                    add_string_budget(budget, name(row.expected_component.privacy));
                    if (row.expected) {
                        validate_id(row.expected->component_id);
                        validate_id(row.expected->subsystem_id);
                        if (row.expected->component_id != row.expected_component.id)
                            fail(HierarchyCode::InvalidArgument);
                        add_string_budget(budget, row.expected->component_id);
                        add_string_budget(budget, row.expected->subsystem_id);
                    }
                    if (row.desired_subsystem_id) {
                        validate_id(*row.desired_subsystem_id);
                        add_string_budget(budget, *row.desired_subsystem_id);
                    }
                } else {
                    subsystem_shape(row.expected);
                    subsystem_budget(budget, row.expected);
                    if constexpr (std::is_same_v<T, RenameSubsystem>) {
                        label(row.expected.id, row.desired_label, row.expected.privacy);
                        add_string_budget(budget, row.desired_label);
                    } else if constexpr (std::is_same_v<T, ReparentSubsystem>) {
                        optional_id(row.desired_parent_id);
                        add_string_budget(budget, row.desired_parent_id);
                    }
                }
            }, change);
            if (budget > max_logical_hierarchy_request_bytes) fail(HierarchyCode::BudgetExceeded);
            if (!seen.insert(target(change)).second) fail(HierarchyCode::InvalidArgument);
        }
        auto normalized = proposal;
        std::sort(normalized.changes.begin(), normalized.changes.end(),
                  [](const auto &a, const auto &b) { return target(a) < target(b); });
        return normalized;
    } catch (const HierarchyError &) {
        throw;
    } catch (const Error &) {
        fail(HierarchyCode::InvalidArgument);
    }
}

LogicalHierarchyTransition apply_logical_hierarchy(const ProjectDocument &current,
    const LogicalHierarchyScope &scope, const LogicalHierarchyProposal &proposal) {
    try {
        const auto normalized = normalize_logical_hierarchy_proposal(scope, proposal);
        validate(current);
        if (current.project.id != scope.project_id) fail(HierarchyCode::ScopeDenied);
        visible(current.project.privacy, scope);
        if (!current.structure || current.topology.revision < 1)
            fail(HierarchyCode::Unsupported);
        if (current.topology.revision != normalized.expected_revision) fail(HierarchyCode::Conflict);
        const auto before = logical_view(current);
        Ids touched_subsystems, touched_components, retired;
        for (const auto &change : normalized.changes) {
            const auto key = target(change);
            (key.first == HierarchyEntityKind::Subsystem ? touched_subsystems : touched_components).insert(key.second);
        }
        // Authorize whole old affected subtrees before comparing expected values
        // or revealing a conflict for an otherwise visible parent.
        authorize_original(before, touched_subsystems, touched_components, scope);
        for (const auto &change : normalized.changes)
            std::visit([&](const auto &row) {
                using T = std::decay_t<decltype(row)>;
                if constexpr (std::is_same_v<T, AddSubsystem>)
                    authorize_existing_parent(before, row.desired.parent_subsystem_id, scope);
                else if constexpr (std::is_same_v<T, ReparentSubsystem>)
                    authorize_existing_parent(before, row.desired_parent_id, scope);
                else if constexpr (std::is_same_v<T, SetComponentMembership>) {
                    if (row.desired_subsystem_id) authorize_existing_parent(before, *row.desired_subsystem_id, scope);
                }
            }, change);

        auto draft = current;
        auto &structure = *draft.structure;
        for (const auto &change : normalized.changes)
            std::visit([&](const auto &row) {
                using T = std::decay_t<decltype(row)>;
                if constexpr (std::is_same_v<T, AddSubsystem>) {
                    if (before.subsystems.contains(row.desired.id)) fail(HierarchyCode::Conflict);
                    structure.subsystems.push_back(row.desired);
                } else if constexpr (std::is_same_v<T, SetComponentMembership>) {
                    const auto found = before.components.find(row.expected_component.id);
                    if (found == before.components.end()) fail(HierarchyCode::ScopeDenied);
                    if (*found->second != row.expected_component ||
                        membership(before, row.expected_component.id) != row.expected)
                        fail(HierarchyCode::Conflict);
                    auto item = std::find_if(structure.component_memberships.begin(),
                        structure.component_memberships.end(), [&](const auto &m) {
                            return m.component_id == row.expected_component.id;
                        });
                    if (!row.desired_subsystem_id) {
                        if (item != structure.component_memberships.end()) structure.component_memberships.erase(item);
                    } else if (item != structure.component_memberships.end()) {
                        item->subsystem_id = *row.desired_subsystem_id;
                    } else {
                        structure.component_memberships.push_back({row.expected_component.id, *row.desired_subsystem_id});
                    }
                } else {
                    const auto found = before.subsystems.find(row.expected.id);
                    if (found == before.subsystems.end()) fail(HierarchyCode::ScopeDenied);
                    if (*found->second != row.expected) fail(HierarchyCode::Conflict);
                    auto item = std::find_if(structure.subsystems.begin(), structure.subsystems.end(),
                        [&](const auto &s) { return s.id == row.expected.id; });
                    if constexpr (std::is_same_v<T, RenameSubsystem>)
                        item->label = row.desired_label;
                    else if constexpr (std::is_same_v<T, ReparentSubsystem>)
                        item->parent_subsystem_id = row.desired_parent_id;
                    else
                        retired.insert(row.expected.id);
                }
            }, change);

        std::erase_if(structure.subsystems, [&](const auto &row) { return retired.contains(row.id); });
        for (const auto &row : structure.subsystems)
            if (retired.contains(row.parent_subsystem_id)) fail(HierarchyCode::Conflict);
        for (const auto &row : structure.component_memberships)
            if (retired.contains(row.subsystem_id)) fail(HierarchyCode::Conflict);
        if (structure.subsystems.size() > max_project_records) fail(HierarchyCode::BudgetExceeded);
        Ids final_ids;
        for (const auto &row : structure.subsystems) final_ids.insert(row.id);
        for (const auto &row : structure.subsystems)
            if (!row.parent_subsystem_id.empty() && !final_ids.contains(row.parent_subsystem_id))
                fail(HierarchyCode::ScopeDenied);
        for (const auto &row : structure.component_memberships)
            if (!final_ids.contains(row.subsystem_id)) fail(HierarchyCode::ScopeDenied);
        validate_update(current, draft);
        const auto after = logical_view(draft);
        LogicalHierarchyDiff diff;
        for (const auto &id : touched_subsystems) {
            const auto old = before.subsystems.find(id), next = after.subsystems.find(id);
            const auto old_row = old == before.subsystems.end() ? std::nullopt : std::optional(*old->second);
            const auto new_row = next == after.subsystems.end() ? std::nullopt : std::optional(*next->second);
            if (old_row != new_row) diff.subsystems.push_back({id, old_row, new_row});
        }
        for (const auto &id : touched_components) {
            const auto old = membership(before, id), next = membership(after, id);
            if (old != next) diff.memberships.push_back({id, old, next});
        }
        if (diff.subsystems.empty() && diff.memberships.empty()) fail(HierarchyCode::InvalidArgument);
        Ids affected_subsystems = touched_subsystems, affected_components = touched_components;
        for (const auto *view : {&before, &after}) {
            for (const auto &[id, path] : view->subsystem_paths)
                if (touches(path.ancestors, touched_subsystems)) affected_subsystems.insert(id);
            for (const auto &[id, path] : view->component_paths)
                if (touches(path.ancestors, touched_subsystems)) affected_components.insert(id);
        }
        for (const auto &id : affected_subsystems)
            append_affected(diff, HierarchyEntityKind::Subsystem, id, before, after, scope);
        for (const auto &id : affected_components)
            append_affected(diff, HierarchyEntityKind::Component, id, before, after, scope);
        return {std::move(draft), std::move(diff)};
    } catch (const HierarchyError &) {
        throw;
    } catch (const Error &) {
        fail(HierarchyCode::InvalidArgument);
    }
}
} // namespace lmti
