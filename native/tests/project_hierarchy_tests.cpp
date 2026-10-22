#include "lmti/project_hierarchy.hpp"
#include <algorithm>
#include <functional>
#include <iostream>
#include <set>

namespace {
using namespace lmti;
int checks = 0, failures = 0;
void check(bool value, const char *message) {
    ++checks;
    if (!value) { std::cerr << message << '\n'; ++failures; }
}
void refuses(const std::function<void()> &operation, HierarchyCode code, const char *message) {
    try { operation(); check(false, message); }
    catch (const HierarchyError &error) {
        check(error.code() == code, message);
        check(std::string(error.what()) == "Logical hierarchy operation was refused.",
              "domain error exposed nonconstant details");
    }
    catch (...) { check(false, "domain refusal escaped the typed error contract"); }
}
Subsystem subsystem(const ProjectDocument &d, const std::string &id) {
    const auto &rows = d.structure->subsystems;
    const auto found = std::find_if(rows.begin(), rows.end(), [&](const auto &row) { return row.id == id; });
    if (found == rows.end()) throw std::runtime_error("invalid test subsystem");
    return *found;
}
SoftwareComponent component(const ProjectDocument &d, const std::string &id) {
    const auto found = std::find_if(d.components.begin(), d.components.end(),
        [&](const auto &row) { return row.id == id; });
    if (found == d.components.end()) throw std::runtime_error("invalid test component");
    return *found;
}
LogicalHierarchyScope scope(const ProjectDocument &d, bool internal = true) {
    return {d.project.id, true, internal};
}
LogicalHierarchyProposal proposal(const ProjectDocument &d, std::vector<LogicalHierarchyChange> changes) {
    return {d.project.id, d.topology.revision, std::move(changes)};
}
const HierarchyAffectedIdentity *affected(const LogicalHierarchyDiff &diff,
                                        HierarchyEntityKind kind, const std::string &id) {
    const auto found = std::find_if(diff.affected.begin(), diff.affected.end(),
        [&](const auto &row) { return row.kind == kind && row.id == id; });
    return found == diff.affected.end() ? nullptr : &*found;
}
ProjectDocument fixture() {
    auto d = demo_project();
    d.topology.revision = 7;
    d.structure.emplace();
    auto &s = *d.structure;
    // Deliberately not parent/topological or ID order.
    s.subsystems = {{"branch", "Branch", "logical-root", Privacy::Public},
                    {"private-child", "Nested private path", "private-root", Privacy::Public},
                    {"logical-root", "Logical root", "", Privacy::Public},
                    {"spare", "Spare", "", Privacy::Public},
                    {"private-root", "Private root", "", Privacy::Internal},
                    {"retire-empty", "Empty", "", Privacy::Public}};
    s.component_memberships = {{"sensor-firmware", "branch"}, {"gateway-agent", "logical-root"}};
    std::set<std::string> sites;
    for (const auto &a : d.topology.assets) sites.insert(a.site);
    for (const auto &id : sites) s.sites.push_back({id, "Site", Privacy::Public});
    s.areas = {{"floor", "Floor", "factory-demo", "", Privacy::Public}};
    s.environments = {{"test-env", "Test environment", Privacy::Internal}};
    s.asset_placements = {{"machine-a", "floor", "gateway-b", "test-env", PhysicalRole::Device},
                          {"gateway-b", "floor", "", "test-env", PhysicalRole::Gateway}};
    d.knowledge = {{"design", "Design notes", "sensor-firmware", "declared-doc", "revision-one", Privacy::Internal}};
    d.storage_lineage = ProjectDocument::StorageLineage{
        d.project.id, 2, "native-private-lineage", "11111111-1111-4111-8111-111111111111"};
    validate(d);
    return d;
}
void normalization_tests() {
    const auto d = fixture();
    auto p = proposal(d, {RenameSubsystem{subsystem(d, "branch"), "Renamed"}});
    auto denied = scope(d); denied.allow_logical_write = false;
    refuses([&] { normalize_logical_hierarchy_proposal(denied, p); }, HierarchyCode::ScopeDenied, "implicit write grant");
    denied = scope(d); denied.project_id = "another-project";
    refuses([&] { normalize_logical_hierarchy_proposal(denied, p); }, HierarchyCode::ScopeDenied, "wrong scope project");
    auto bad = p; bad.project_id = "../project";
    refuses([&] { normalize_logical_hierarchy_proposal(scope(d), bad); }, HierarchyCode::InvalidArgument, "unsafe project ID");
    for (const auto revision : {std::int64_t{0}, std::int64_t{-1}, std::int64_t{9007199254740991LL}}) {
        bad = p; bad.expected_revision = revision;
        refuses([&] { normalize_logical_hierarchy_proposal(scope(d), bad); }, HierarchyCode::InvalidArgument, "invalid revision");
    }
    bad = p; bad.changes.clear();
    refuses([&] { normalize_logical_hierarchy_proposal(scope(d), bad); }, HierarchyCode::InvalidArgument, "empty batch");
    for (std::size_t i = 0; i < max_logical_hierarchy_changes; ++i)
        bad.changes.push_back(AddSubsystem{{"new-" + std::to_string(i), "New", "", Privacy::Internal}});
    check(normalize_logical_hierarchy_proposal(scope(d), bad).changes.size() == 32, "32-operation boundary");
    bad.changes.push_back(AddSubsystem{{"overflow", "New", "", Privacy::Internal}});
    refuses([&] { normalize_logical_hierarchy_proposal(scope(d), bad); }, HierarchyCode::BudgetExceeded, "33-operation boundary");
    bad = proposal(d, {RenameSubsystem{subsystem(d, "branch"), "New"},
                       ReparentSubsystem{subsystem(d, "branch"), "spare"}});
    refuses([&] { normalize_logical_hierarchy_proposal(scope(d), bad); }, HierarchyCode::InvalidArgument, "duplicate target");
    bad = proposal(d, {AddSubsystem{{"new", "New", "", Privacy::Public}}});
    refuses([&] { normalize_logical_hierarchy_proposal(scope(d), bad); }, HierarchyCode::ScopeDenied, "public addition widened classification policy");
    for (const auto &bad_label : {std::string{}, std::string(121, 'x'), std::string("line\nbreak"),
                                  std::string(1, static_cast<char>(0xff))}) {
        bad = proposal(d, {RenameSubsystem{subsystem(d, "branch"), bad_label}});
        refuses([&] { normalize_logical_hierarchy_proposal(scope(d), bad); }, HierarchyCode::InvalidArgument, "invalid desired label");
    }
    auto old = subsystem(d, "branch"); old.privacy = static_cast<Privacy>(100);
    bad = proposal(d, {RetireEmptySubsystem{old}});
    refuses([&] { normalize_logical_hierarchy_proposal(scope(d), bad); }, HierarchyCode::InvalidArgument, "invalid privacy enum");
    auto c = component(d, "sensor-firmware"); c.kind = static_cast<ComponentKind>(100);
    bad = proposal(d, {SetComponentMembership{c, ComponentMembership{c.id, "branch"}, std::nullopt}});
    refuses([&] { normalize_logical_hierarchy_proposal(scope(d), bad); }, HierarchyCode::InvalidArgument, "invalid component enum");
    c = component(d, "sensor-firmware");
    bad = proposal(d, {SetComponentMembership{c, ComponentMembership{"another-component", "branch"}, "spare"}});
    refuses([&] { normalize_logical_hierarchy_proposal(scope(d), bad); }, HierarchyCode::InvalidArgument, "mismatched expected member ID");
    bad = proposal(d, {SetComponentMembership{c, ComponentMembership{c.id, "branch"}, std::string{}}});
    refuses([&] { normalize_logical_hierarchy_proposal(scope(d), bad); }, HierarchyCode::InvalidArgument, "empty desired optional ID");
    bad = proposal(d, {ReparentSubsystem{subsystem(d, "branch"), "../outside"}});
    refuses([&] { normalize_logical_hierarchy_proposal(scope(d), bad); }, HierarchyCode::InvalidArgument, "invalid parent ID");
    // Individually valid maximum-size rows can still exceed total escaped framing.
    bad = proposal(d, {});
    for (int i = 0; i < 32; ++i) {
        SoftwareComponent row{"c" + std::string(60, 'x') + std::to_string(i), std::string(120, '"'),
                              "r" + std::string(63, 'x'), ComponentKind::Firmware, Privacy::Public};
        bad.changes.push_back(SetComponentMembership{row,
            ComponentMembership{row.id, "s" + std::string(63, 'x')}, "t" + std::string(63, 'x')});
    }
    refuses([&] { normalize_logical_hierarchy_proposal(scope(d), bad); }, HierarchyCode::BudgetExceeded, "total serialized budget");
}
void five_operations_and_preservation() {
    const auto d = fixture(), preserved = d;
    auto p = proposal(d, {
        AddSubsystem{{"z-parent", "Added parent", "logical-root", Privacy::Internal}},
        AddSubsystem{{"a-child", "Added child", "z-parent", Privacy::Internal}},
        RenameSubsystem{subsystem(d, "branch"), "Renamed branch"},
        ReparentSubsystem{subsystem(d, "spare"), "logical-root"},
        SetComponentMembership{component(d, "monitor-backend"), std::nullopt, "a-child"},
        RetireEmptySubsystem{subsystem(d, "retire-empty")}
    });
    const auto original_proposal = p;
    const auto result = apply_logical_hierarchy(d, scope(d), p);
    auto expected = d;
    auto &s = *expected.structure;
    for (auto &row : s.subsystems) {
        if (row.id == "branch") row.label = "Renamed branch";
        if (row.id == "spare") row.parent_subsystem_id = "logical-root";
    }
    s.subsystems.push_back({"a-child", "Added child", "z-parent", Privacy::Internal});
    s.subsystems.push_back({"z-parent", "Added parent", "logical-root", Privacy::Internal});
    std::erase_if(s.subsystems, [](const auto &row) { return row.id == "retire-empty"; });
    s.component_memberships.push_back({"monitor-backend", "a-child"});
    check(result.document == expected, "transition altered unrelated fields/order, revision or lineage");
    check(d == preserved && p == original_proposal, "transition modified caller inputs");
    check(result.diff.subsystems.size() == 5 && result.diff.memberships.size() == 1, "typed diff lacks exact changed rows");
    const auto sensor = affected(result.diff, HierarchyEntityKind::Component, "sensor-firmware");
    check(sensor && sensor->before_classification == Privacy::Public && sensor->after_classification == Privacy::Public &&
          sensor->before_ancestors == std::vector<std::string>{"logical-root", "branch"} &&
          sensor->after_ancestors == sensor->before_ancestors,
          "renamed parent's unchanged-classification member missing from review");
    const auto added = affected(result.diff, HierarchyEntityKind::Subsystem, "a-child");
    check(added && !added->before_classification && added->after_classification == Privacy::Internal &&
          added->after_ancestors == std::vector<std::string>{"logical-root", "z-parent"}, "new descendant ancestry missing");
    const auto retired = affected(result.diff, HierarchyEntityKind::Subsystem, "retire-empty");
    check(retired && retired->before_classification == Privacy::Public && !retired->after_classification, "retirement diff missing");
    check(!affected(result.diff, HierarchyEntityKind::Subsystem, "private-root"), "unrelated hidden row disclosed");
    std::reverse(p.changes.begin(), p.changes.end());
    const auto reordered = apply_logical_hierarchy(d, scope(d), p);
    check(result.document == reordered.document && result.diff == reordered.diff, "input order changed final draft/diff");
    check(normalize_logical_hierarchy_proposal(scope(d), p) ==
          normalize_logical_hierarchy_proposal(scope(d), original_proposal), "normalization order unstable");
}
void retirement_conflicts_and_noops() {
    const auto d = fixture();
    auto p = proposal(d, {RetireEmptySubsystem{subsystem(d, "branch")},
        SetComponentMembership{component(d, "sensor-firmware"), ComponentMembership{"sensor-firmware", "branch"}, "spare"}});
    const auto result = apply_logical_hierarchy(d, scope(d), p);
    check(result.diff.subsystems.size() == 1 && !result.diff.subsystems[0].after &&
          result.diff.memberships.size() == 1, "detach+retire final-draft batch refused");
    p = proposal(d, {RetireEmptySubsystem{subsystem(d, "branch")}});
    refuses([&] { apply_logical_hierarchy(d, scope(d), p); }, HierarchyCode::Conflict, "retirement orphaned member");
    p = proposal(d, {RetireEmptySubsystem{subsystem(d, "logical-root")}});
    refuses([&] { apply_logical_hierarchy(d, scope(d), p); }, HierarchyCode::Conflict, "retirement orphaned child");
    p = proposal(d, {RenameSubsystem{subsystem(d, "branch"), "Branch"}});
    refuses([&] { apply_logical_hierarchy(d, scope(d), p); }, HierarchyCode::InvalidArgument, "no-op rename accepted");
    p = proposal(d, {ReparentSubsystem{subsystem(d, "branch"), "logical-root"}});
    refuses([&] { apply_logical_hierarchy(d, scope(d), p); }, HierarchyCode::InvalidArgument, "no-op parent accepted");
    p = proposal(d, {SetComponentMembership{component(d, "sensor-firmware"),
        ComponentMembership{"sensor-firmware", "branch"}, "branch"}});
    refuses([&] { apply_logical_hierarchy(d, scope(d), p); }, HierarchyCode::InvalidArgument, "no-op membership accepted");
    p = proposal(d, {SetComponentMembership{component(d, "monitor-backend"), std::nullopt, std::nullopt}});
    refuses([&] { apply_logical_hierarchy(d, scope(d), p); }, HierarchyCode::InvalidArgument, "no-op unassignment accepted");
    p = proposal(d, {SetComponentMembership{component(d, "sensor-firmware"),
        ComponentMembership{"sensor-firmware", "branch"}, std::nullopt}});
    check(apply_logical_hierarchy(d, scope(d), p).diff.memberships[0].after == std::nullopt,
          "explicit public unassignment failed");
    auto old = subsystem(d, "branch"); old.label = "Stale label";
    p = proposal(d, {RenameSubsystem{old, "New"}});
    refuses([&] { apply_logical_hierarchy(d, scope(d), p); }, HierarchyCode::Conflict, "stale old row accepted");
    p = proposal(d, {SetComponentMembership{component(d, "sensor-firmware"), std::nullopt, "spare"}});
    refuses([&] { apply_logical_hierarchy(d, scope(d), p); }, HierarchyCode::Conflict, "stale absent membership accepted");
    auto c = component(d, "sensor-firmware"); c.label = "Stale component";
    p = proposal(d, {SetComponentMembership{c, ComponentMembership{c.id, "branch"}, "spare"}});
    refuses([&] { apply_logical_hierarchy(d, scope(d), p); }, HierarchyCode::Conflict, "stale full component accepted");
    p = proposal(d, {AddSubsystem{{"branch", "Existing", "", Privacy::Internal}}});
    refuses([&] { apply_logical_hierarchy(d, scope(d), p); }, HierarchyCode::Conflict, "existing ID add accepted");
    p = proposal(d, {RenameSubsystem{subsystem(d, "branch"), "New"}}); --p.expected_revision;
    refuses([&] { apply_logical_hierarchy(d, scope(d), p); }, HierarchyCode::Conflict, "stale revision accepted");
}
void privacy_tests() {
    auto d = fixture();
    auto p = proposal(d, {RenameSubsystem{subsystem(d, "branch"), "Public edit"}});
    check(apply_logical_hierarchy(d, scope(d, false), p).document.project == d.project,
          "unrelated hidden subtree prevented public edit");
    p = proposal(d, {RenameSubsystem{subsystem(d, "private-child"), "Unavailable"}});
    refuses([&] { apply_logical_hierarchy(d, scope(d, false), p); }, HierarchyCode::ScopeDenied, "hidden ancestor bypass");
    p = proposal(d, {RenameSubsystem{{"missing", "Unavailable", "", Privacy::Public}, "New"}});
    refuses([&] { apply_logical_hierarchy(d, scope(d, false), p); }, HierarchyCode::ScopeDenied, "missing identity exposed distinct denial");
    for (auto &row : d.structure->subsystems)
        if (row.id == "private-root") row.parent_subsystem_id = "logical-root";
    p = proposal(d, {RenameSubsystem{subsystem(d, "logical-root"), "Public root rename"}});
    refuses([&] { apply_logical_hierarchy(d, scope(d, false), p); }, HierarchyCode::ScopeDenied, "hidden descendant omitted from review");
    // A mismatched expected value must not disclose conflict before hidden checks.
    std::get<RenameSubsystem>(p.changes[0]).expected.label = "Stale";
    refuses([&] { apply_logical_hierarchy(d, scope(d, false), p); }, HierarchyCode::ScopeDenied, "old-value check leaked hidden subtree");
    d = fixture();
    for (auto &row : d.components) if (row.id == "sensor-firmware") row.privacy = Privacy::Internal;
    p = proposal(d, {RenameSubsystem{subsystem(d, "branch"), "New"}});
    refuses([&] { apply_logical_hierarchy(d, scope(d, false), p); }, HierarchyCode::ScopeDenied, "internal member omitted from review");
    d = fixture();
    p = proposal(d, {ReparentSubsystem{subsystem(d, "private-child"), ""}});
    refuses([&] { apply_logical_hierarchy(d, scope(d), p); }, HierarchyCode::ScopeDenied, "subsystem declassification accepted");
    d.structure->component_memberships[0].subsystem_id = "private-child";
    p = proposal(d, {SetComponentMembership{component(d, "sensor-firmware"),
        ComponentMembership{"sensor-firmware", "private-child"}, std::nullopt}});
    refuses([&] { apply_logical_hierarchy(d, scope(d), p); }, HierarchyCode::ScopeDenied, "membership removal declassified component");
    d = fixture();
    p = proposal(d, {ReparentSubsystem{subsystem(d, "spare"), "private-child"}});
    refuses([&] { apply_logical_hierarchy(d, scope(d, false), p); }, HierarchyCode::ScopeDenied, "hidden new ancestry allowed");
    p = proposal(d, {ReparentSubsystem{subsystem(d, "branch"), "private-root"}});
    const auto result = apply_logical_hierarchy(d, scope(d), p);
    check(subsystem(result.document, "branch").privacy == Privacy::Public &&
          component(result.document, "sensor-firmware").privacy == Privacy::Public, "stored classification silently rewritten");
    const auto member = affected(result.diff, HierarchyEntityKind::Component, "sensor-firmware");
    check(member && member->before_classification == Privacy::Public && member->after_classification == Privacy::Internal &&
          member->after_ancestors == std::vector<std::string>{"private-root", "branch"}, "raised effective classification not reviewed");
    // A linked Internal repository hides both assigned and unassigned components
    // in snapshot v3; the hierarchy review must use that same effective privacy.
    d = fixture();
    for (auto &row : d.repositories) if (row.id == "repo-sensor") row.privacy = Privacy::Internal;
    p = proposal(d, {SetComponentMembership{component(d, "sensor-firmware"),
        ComponentMembership{"sensor-firmware", "branch"}, "spare"}});
    refuses([&] { apply_logical_hierarchy(d, scope(d, false), p); }, HierarchyCode::ScopeDenied,
            "assigned component bypassed Internal repository");
    const auto assigned_result = apply_logical_hierarchy(d, scope(d), p);
    const auto assigned = affected(assigned_result.diff, HierarchyEntityKind::Component, "sensor-firmware");
    check(assigned && assigned->before_classification == Privacy::Internal &&
          assigned->after_classification == Privacy::Internal, "assigned branch erased repository inheritance");
    p = proposal(d, {RenameSubsystem{subsystem(d, "branch"), "New"}});
    refuses([&] { apply_logical_hierarchy(d, scope(d, false), p); }, HierarchyCode::ScopeDenied,
            "renamed ancestor omitted repository-hidden member");
    for (auto &row : d.components) if (row.id == "monitor-backend") row.repository_id = "repo-sensor";
    p = proposal(d, {SetComponentMembership{component(d, "monitor-backend"), std::nullopt, "spare"}});
    refuses([&] { apply_logical_hierarchy(d, scope(d, false), p); }, HierarchyCode::ScopeDenied,
            "unassigned component bypassed Internal repository");
    const auto unassigned_result = apply_logical_hierarchy(d, scope(d), p);
    const auto unassigned = affected(unassigned_result.diff, HierarchyEntityKind::Component, "monitor-backend");
    check(unassigned && unassigned->before_classification == Privacy::Internal &&
          unassigned->after_classification == Privacy::Internal, "unassigned repository privacy misreported");
    // Moving a Public subtree out of an Internal path must check all descendants.
    d = fixture();
    for (auto &row : d.structure->subsystems)
        if (row.id == "branch") row.parent_subsystem_id = "private-root";
    p = proposal(d, {ReparentSubsystem{subsystem(d, "branch"), "logical-root"}});
    refuses([&] { apply_logical_hierarchy(d, scope(d), p); }, HierarchyCode::ScopeDenied, "public subtree declassification accepted");
    d = fixture(); d.project.privacy = Privacy::Internal;
    p = proposal(d, {RenameSubsystem{subsystem(d, "branch"), "New"}});
    refuses([&] { apply_logical_hierarchy(d, scope(d, false), p); }, HierarchyCode::ScopeDenied, "project ancestry ignored");
}
ProjectDocument chain(std::size_t length) {
    ProjectDocument d;
    d.project = {"logical-project", "Logical project", "", Privacy::Public};
    d.topology.revision = 1; d.structure.emplace();
    d.components = {{"leaf", "Leaf", "", ComponentKind::Library, Privacy::Public}};
    for (std::size_t i = 1; i <= length; ++i)
        d.structure->subsystems.push_back({"s" + std::to_string(i), "Subsystem",
            i == 1 ? "" : "s" + std::to_string(i - 1), Privacy::Public});
    std::reverse(d.structure->subsystems.begin(), d.structure->subsystems.end());
    validate(d);
    return d;
}
void limits_and_integrity() {
    auto d = fixture();
    auto p = proposal(d, {ReparentSubsystem{subsystem(d, "branch"), "branch"}});
    refuses([&] { apply_logical_hierarchy(d, scope(d), p); }, HierarchyCode::InvalidArgument, "self cycle accepted");
    p = proposal(d, {ReparentSubsystem{subsystem(d, "logical-root"), "branch"}});
    refuses([&] { apply_logical_hierarchy(d, scope(d), p); }, HierarchyCode::InvalidArgument, "ancestor cycle accepted");
    p = proposal(d, {AddSubsystem{{"new", "New", "missing", Privacy::Internal}}});
    refuses([&] { apply_logical_hierarchy(d, scope(d), p); }, HierarchyCode::ScopeDenied, "missing final parent accepted");
    p = proposal(d, {AddSubsystem{{"new-a", "New A", "new-b", Privacy::Internal}},
                       AddSubsystem{{"new-b", "New B", "new-a", Privacy::Internal}}});
    refuses([&] { apply_logical_hierarchy(d, scope(d), p); }, HierarchyCode::InvalidArgument, "added parent cycle accepted");
    p = proposal(d, {RenameSubsystem{subsystem(d, "branch"), "New"}});
    auto flat = d; flat.structure.reset(); flat.storage_lineage.reset();
    refuses([&] { apply_logical_hierarchy(flat, scope(d), p); }, HierarchyCode::Unsupported, "flat document implicitly upgraded");
    auto unsaved = d; unsaved.topology.revision = 0;
    refuses([&] { apply_logical_hierarchy(unsaved, scope(d), p); }, HierarchyCode::Unsupported, "unsaved document accepted");
    auto corrupt = d; corrupt.structure->subsystems[1].label = "private\nmetadata";
    refuses([&] { apply_logical_hierarchy(corrupt, scope(d), p); }, HierarchyCode::InvalidArgument, "corrupt graph details leaked");
    d = chain(31);
    p = proposal(d, {SetComponentMembership{d.components[0], std::nullopt, "s31"}});
    check(apply_logical_hierarchy(d, scope(d), p).diff.memberships.size() == 1, "component depth32 refused");
    p = proposal(d, {AddSubsystem{{"s32", "At limit", "s31", Privacy::Internal}}});
    check(apply_logical_hierarchy(d, scope(d), p).document.structure->subsystems.size() == 32, "subsystem depth32 refused");
    p.changes.push_back(SetComponentMembership{d.components[0], std::nullopt, "s32"});
    refuses([&] { apply_logical_hierarchy(d, scope(d), p); }, HierarchyCode::InvalidArgument, "component depth33 accepted");
    p = proposal(d, {AddSubsystem{{"s32", "At limit", "s31", Privacy::Internal}},
                       AddSubsystem{{"s33", "Too deep", "s32", Privacy::Internal}}});
    refuses([&] { apply_logical_hierarchy(d, scope(d), p); }, HierarchyCode::InvalidArgument, "subsystem depth33 accepted");
    d = chain(0);
    for (std::size_t i = 0; i < max_project_records; ++i)
        d.structure->subsystems.push_back({"catalog-" + std::to_string(i), "Catalog", "", Privacy::Public});
    validate(d);
    p = proposal(d, {AddSubsystem{{"overflow", "Overflow", "", Privacy::Internal}}});
    const auto original = d;
    refuses([&] { apply_logical_hierarchy(d, scope(d), p); }, HierarchyCode::BudgetExceeded, "catalog cap exceeded");
    check(d == original, "rejected transition changed input");
}
}

int main() {
    try {
        normalization_tests();
        five_operations_and_preservation();
        retirement_conflicts_and_noops();
        privacy_tests();
        limits_and_integrity();
    } catch (const std::exception &) {
        check(false, "unexpected pure hierarchy fixture failure");
    }
    std::cout << "Logical hierarchy domain checks: " << checks << ", failures: " << failures << ".\n";
    return failures == 0 ? 0 : 1;
}
