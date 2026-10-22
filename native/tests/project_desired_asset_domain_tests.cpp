#include "lmti/project_desired_asset.hpp"
#include <algorithm>
#include <functional>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>

namespace {
using namespace lmti;
using Code = PhysicalHierarchyCode;
int checks = 0, failures = 0;
void check(bool value, const char *message) {
    ++checks;
    if (!value) { ++failures; std::cerr << message << '\n'; }
}
void refuses(const std::function<void()> &call, Code code, const char *message) {
    try { call(); check(false, message); }
    catch (const PhysicalHierarchyError &error) {
        check(error.code() == code, message);
        check(std::string(error.what()) == "Physical hierarchy operation was refused.",
              "targeted projection leaked variable refusal details");
    } catch (...) { check(false, "targeted projection escaped the typed refusal contract"); }
}
template<class Row> Row &row(std::vector<Row> &rows, const std::string &id) {
    const auto found = std::find_if(rows.begin(), rows.end(), [&](const auto &r) { return r.id == id; });
    if (found == rows.end()) throw std::runtime_error("invalid test fixture row");
    return *found;
}
AssetPlacement &placed(ProjectDocument &document, const std::string &id) {
    auto &rows = document.structure->asset_placements;
    const auto found = std::find_if(rows.begin(), rows.end(), [&](const auto &r) { return r.asset_id == id; });
    if (found == rows.end()) throw std::runtime_error("invalid test fixture placement");
    return *found;
}
ProjectDocument fixture() {
    ProjectDocument d;
    d.project = {"desired-project", "Desired project", "", Privacy::Public};
    d.topology.revision = 17;
    d.topology.assets = {
        {"asset", "Asset", "site", Kind::Machine, Privacy::Public, false, 1700,
         Observation::Online, 1700000000, -12.5, 42.25},
        {"parent", "Parent", "site", Kind::Gateway, Privacy::Public},
        {"grandparent", "Grandparent", "site", Kind::Service, Privacy::Public},
        {"unplaced", "Unplaced", "site", Kind::Sensor, Privacy::Public},
        {"unrelated", "Unrelated hidden", "other-site", Kind::Sensor, Privacy::Internal},
    };
    d.topology.links = {{"link", "asset", "parent", Protocol::Dependency}};
    d.structure.emplace();
    d.structure->sites = {
        {"site", "Site", Privacy::Public}, {"other-site", "Other site", Privacy::Internal}};
    d.structure->areas = {
        {"floor", "Floor", "site", "", Privacy::Public},
        {"cell", "Cell", "site", "floor", Privacy::Public},
        {"other-area", "Other area", "other-site", "", Privacy::Internal}};
    d.structure->environments = {
        {"environment", "Environment", Privacy::Public},
        {"other-environment", "Other environment", Privacy::Internal}};
    d.structure->asset_placements = {
        {"asset", "cell", "parent", "environment", std::nullopt},
        {"parent", "cell", "grandparent", "environment", PhysicalRole::Gateway},
        {"grandparent", "cell", "", "environment", PhysicalRole::Host},
        {"unrelated", "other-area", "", "other-environment", std::nullopt},
    };
    validate(d);
    return d;
}
PhysicalAssetRow selected(const ProjectDocument &d, bool internal = false, const std::string &id = "asset") {
    return project_physical_asset(d, d.project.id, id, internal);
}
void exact_target_without_write_authority() {
    const auto d = fixture(), original = d;
    const auto target = selected(d);
    check(target.value == PhysicalAssetAnchor{"asset", "Asset", "site", Kind::Machine, Privacy::Public},
          "target anchor differed from authorized stored row");
    check(target.placement == std::optional<AssetPlacement>(
              AssetPlacement{"asset", "cell", "parent", "environment", std::nullopt}),
          "declared placement or unknown role was altered");
    check(target.path == PhysicalHierarchyPath{"site", {"floor", "cell"}, {"grandparent", "parent"}, "environment"},
          "target path omitted a physical dependency or changed ancestor order");
    check(target.classification == Privacy::Public, "public target inherited unrelated hidden privacy");
    check(d == original, "targeted projection changed the input document");
    refuses([&] { project_physical_hierarchy(d, {d.project.id, false, false}); }, Code::ScopeDenied,
            "targeted helper changed the old whole-view physical-write gate");
    const auto old = project_physical_hierarchy(d, {d.project.id, true, false});
    const auto found = std::find_if(old.assets.begin(), old.assets.end(), [](const auto &r) { return r.value.id == "asset"; });
    check(found != old.assets.end() && found->value == target.value && found->placement == target.placement &&
          found->path == target.path && found->classification == target.classification,
          "targeted read disagreed with existing authorized projection");
}
void every_inherited_privacy_gate() {
    const std::vector<std::function<void(ProjectDocument &)>> elevate{
        [](auto &d) { d.project.privacy = Privacy::Internal; },
        [](auto &d) { row(d.topology.assets, "asset").privacy = Privacy::Internal; },
        [](auto &d) { row(d.structure->sites, "site").privacy = Privacy::Internal; },
        [](auto &d) { row(d.structure->areas, "floor").privacy = Privacy::Internal; },
        [](auto &d) { row(d.structure->areas, "cell").privacy = Privacy::Internal; },
        [](auto &d) { row(d.structure->environments, "environment").privacy = Privacy::Internal; },
        [](auto &d) { row(d.topology.assets, "parent").privacy = Privacy::Internal; },
        [](auto &d) { row(d.topology.assets, "grandparent").privacy = Privacy::Internal; },
    };
    for (const auto &change : elevate) {
        auto d = fixture();
        change(d);
        const auto original = d;
        refuses([&] { selected(d); }, Code::ScopeDenied, "inherited Internal target escaped the public gate");
        const auto target = selected(d, true);
        check(target.classification == Privacy::Internal, "internal-capable read lost inherited classification");
        check(target.path == PhysicalHierarchyPath{"site", {"floor", "cell"}, {"grandparent", "parent"}, "environment"},
              "privacy elevation altered the physical path");
        check(target.value.privacy == row(d.topology.assets, "asset").privacy,
              "effective privacy overwrote stored Asset privacy");
        check(d == original, "visibility refusal or read mutated the graph");
    }
}
void uniform_missing_hidden_and_project_scope() {
    const auto d = fixture();
    refuses([&] { selected(d, false, "missing"); }, Code::ScopeDenied, "missing target was not uniformly refused");
    refuses([&] { selected(d, false, "unrelated"); }, Code::ScopeDenied, "hidden target was not uniformly refused");
    refuses([&] { project_physical_asset(d, "other-project", "asset", true); }, Code::ScopeDenied,
            "wrong project was not uniformly refused");
    const auto target = selected(d);
    check(target.classification == Privacy::Public, "unrelated Internal Site/Area/Environment/Asset blocked target");
    auto removed = d;
    std::erase_if(removed.topology.assets, [](const auto &r) { return r.id == "asset"; });
    std::erase_if(removed.topology.links, [](const auto &r) { return r.from == "asset" || r.to == "asset"; });
    std::erase_if(removed.structure->asset_placements, [](const auto &r) { return r.asset_id == "asset"; });
    validate(removed);
    refuses([&] { selected(removed, true); }, Code::ScopeDenied,
            "absent live graph identity gained an existence-specific error");
    // Durable retired/active registry remains a same-snapshot storage responsibility.
}
void placement_absence_is_not_invented() {
    auto d = fixture();
    const auto absent = selected(d, false, "unplaced");
    check(!absent.placement && absent.path == PhysicalHierarchyPath{"site", {}, {}, ""},
          "read helper inferred placement/environment for an unplaced Asset");
    d.structure->asset_placements.push_back({"unplaced", "", "", "", std::nullopt});
    const auto declared = selected(d, false, "unplaced");
    check(declared.placement.has_value() && !declared.placement->role &&
          declared.path == PhysicalHierarchyPath{"site", {}, {}, ""},
          "declared-empty placement was collapsed into absence");
    placed(d, "unplaced").environment_id = "environment";
    const auto explicit_environment = selected(d, false, "unplaced");
    check(explicit_environment.placement && !explicit_environment.placement->role &&
          explicit_environment.path.environment_id == "environment",
          "unknown role denied an otherwise declared environment");
}
void shape_and_depth_limits() {
    const auto d = fixture();
    for (const std::string id : {"", "1bad", "bad:id", "bad\n"}) {
        refuses([&] { project_physical_asset(d, d.project.id, id, true); }, Code::InvalidArgument,
                "malformed Asset ID reached projection");
        refuses([&] { project_physical_asset(d, id, "asset", true); }, Code::InvalidArgument,
                "malformed project ID reached projection");
    }
    auto malformed = d;
    row(malformed.structure->areas, "floor").parent_area_id = "cell";
    refuses([&] { selected(malformed, true); }, Code::InvalidArgument, "cyclic current graph was accepted");
    malformed = d;
    row(malformed.topology.assets, "asset").privacy = static_cast<Privacy>(99);
    refuses([&] { selected(malformed, true); }, Code::InvalidArgument, "unknown privacy enum was accepted");
    malformed = d;
    row(malformed.topology.assets, "asset").label = std::string("\xed\xa0\x80", 3);
    refuses([&] { selected(malformed, true); }, Code::InvalidArgument, "non-scalar current label was accepted");
    auto old = d;
    old.structure.reset();
    refuses([&] { selected(old, true); }, Code::Unsupported, "undeclared structure gained a physical path");
    auto unsaved = d;
    unsaved.topology.revision = 0;
    refuses([&] { selected(unsaved, true); }, Code::Unsupported, "unsaved graph was projected as saved state");
    auto final_revision = d;
    final_revision.topology.revision = 9007199254740990LL;
    check(selected(final_revision).value.id == "asset", "last valid revision became unreadable");

    ProjectDocument chain;
    chain.project = {"chain-project", "Chain", "", Privacy::Public};
    chain.topology.revision = 1;
    chain.structure.emplace();
    chain.structure->sites = {{"site", "Site", Privacy::Public}};
    chain.structure->environments = {{"environment", "Environment", Privacy::Public}};
    for (int i = 0; i < 32; ++i) {
        const auto id = "asset-" + std::to_string(i);
        chain.topology.assets.push_back({id, "Asset", "site", Kind::Sensor, Privacy::Public});
        chain.structure->asset_placements.push_back(
            {id, "", i == 0 ? "" : "asset-" + std::to_string(i - 1), "environment", std::nullopt});
    }
    validate(chain);
    const auto deepest = project_physical_asset(chain, chain.project.id, "asset-31", false);
    check(deepest.path.asset_ancestors.size() == 31 && deepest.path.asset_ancestors.front() == "asset-0" &&
          deepest.path.asset_ancestors.back() == "asset-30", "valid depth32 target lost its complete path");
    chain.topology.assets.push_back({"asset-32", "Asset", "site", Kind::Sensor, Privacy::Public});
    chain.structure->asset_placements.push_back({"asset-32", "", "asset-31", "environment", std::nullopt});
    refuses([&] { project_physical_asset(chain, chain.project.id, "asset-32", true); }, Code::InvalidArgument,
            "depth33 graph passed shared structural validation");
}

using DesiredCode = DesiredAssetCode;
void desired_refuses(const std::function<void()> &call, DesiredCode code, const char *message) {
    try { call(); check(false, message); }
    catch (const DesiredAssetError &error) {
        check(error.code == code, message);
        check(std::string(error.what()) == "Desired Asset operation was refused.",
              "desired domain refusal disclosed variable details");
    } catch (...) { check(false, "desired refusal escaped its typed error contract"); }
}
DesiredAssetScope desired_scope(const ProjectDocument &d, bool internal = false) {
    return {d.project.id, "12345678-abcd-4def-8123-123456789abc", "local-operator",
            std::string(64, 'a'), "site", "environment", internal, true};
}
DesiredAssetProposal desired_proposal(const ProjectDocument &d, const std::string &id = "asset") {
    const auto &asset = find_asset(d.topology, id);
    return {id, d.topology.revision, {asset.enabled, asset.poll_ms},
            {!asset.enabled, asset.poll_ms + 100}, std::string(64, 'b')};
}
void desired_two_field_preservation() {
    auto d = demo_project();
    d.topology.revision = 51;
    d.topology.assets[0].observed = Observation::Online;
    d.topology.assets[0].observed_at = 1700000000;
    d.topology.assets[0].x = 13.25;
    d.topology.assets[0].y = -42.5;
    d.structure.emplace();
    d.structure->sites = {{"factory-demo", "Factory", Privacy::Public}};
    d.structure->areas = {{"floor", "Floor", "factory-demo", "", Privacy::Public}};
    d.structure->environments = {{"environment", "Environment", Privacy::Public}};
    d.structure->subsystems = {{"subsystem", "Subsystem", "", Privacy::Public}};
    for (const auto &asset : d.topology.assets)
        d.structure->asset_placements.push_back({asset.id, "floor", "", "environment", std::nullopt});
    d.structure->component_memberships = {{"sensor-firmware", "subsystem"}};
    d.storage_lineage = ProjectDocument::StorageLineage{
        d.project.id, 3, "private-original-locator", "12345678-abcd-4def-8123-123456789abc"};
    validate(d);
    const auto original = d;
    auto scope = desired_scope(d, true);
    scope.site_id = "factory-demo";
    const auto proposal = desired_proposal(d, "machine-a");
    check(normalize_desired_asset_proposal(scope, proposal) == proposal,
          "normalizer rewrote valid typed proposal scalars");
    const auto result = apply_desired_asset(d, scope, proposal);
    check(d == original, "desired transition mutated caller document");
    check(result.before.values == proposal.expected && result.before.revision == 51 &&
          result.before.asset.value.id == "machine-a" && result.before.asset.path.environment_id == "environment",
          "desired before selection lost exact authorized state");
    check(result.diff == DesiredAssetDiff{"machine-a", proposal.expected, proposal.desired},
          "desired diff was not the exact two-field change");
    const auto &edited = find_asset(result.document.topology, "machine-a");
    check(edited.enabled == proposal.desired.enabled && edited.poll_ms == proposal.desired.poll_ms,
          "desired values were not applied to the selected Asset");
    auto restored = result.document;
    auto &restore = row(restored.topology.assets, "machine-a");
    restore.enabled = proposal.expected.enabled;
    restore.poll_ms = proposal.expected.poll_ms;
    check(restored == original,
          "desired transition changed revision/lineage/observations/structure or unrelated typed graph data");
}
void desired_authorization_before_conflicts() {
    const std::vector<std::function<void(ProjectDocument &)>> elevate{
        [](auto &d) { d.project.privacy = Privacy::Internal; },
        [](auto &d) { row(d.topology.assets, "asset").privacy = Privacy::Internal; },
        [](auto &d) { row(d.structure->sites, "site").privacy = Privacy::Internal; },
        [](auto &d) { row(d.structure->areas, "floor").privacy = Privacy::Internal; },
        [](auto &d) { row(d.structure->areas, "cell").privacy = Privacy::Internal; },
        [](auto &d) { row(d.structure->environments, "environment").privacy = Privacy::Internal; },
        [](auto &d) { row(d.topology.assets, "parent").privacy = Privacy::Internal; },
        [](auto &d) { row(d.topology.assets, "grandparent").privacy = Privacy::Internal; },
    };
    for (const auto &change : elevate) {
        auto d = fixture();
        change(d);
        auto proposal = desired_proposal(d);
        proposal.expected_revision -= 1;
        proposal.expected.poll_ms += 7;
        desired_refuses([&] { apply_desired_asset(d, desired_scope(d), proposal); }, DesiredCode::ScopeDenied,
                        "hidden inherited target disclosed stale old revision/values");
        auto local = desired_scope(d, true);
        desired_refuses([&] { apply_desired_asset(d, local, proposal); }, DesiredCode::RevisionConflict,
                        "authorized target did not check revision first");
        proposal.expected_revision = d.topology.revision;
        desired_refuses([&] { apply_desired_asset(d, local, proposal); }, DesiredCode::ConfigConflict,
                        "authorized stale values did not report the bounded conflict");
    }
    const auto d = fixture();
    auto proposal = desired_proposal(d);
    proposal.expected_revision -= 1;
    proposal.expected.poll_ms += 7;
    auto scope = desired_scope(d, true);
    scope.site_id = "other-site";
    desired_refuses([&] { apply_desired_asset(d, scope, proposal); }, DesiredCode::ScopeDenied,
                    "wrong Site disclosed old-value/revision conflict");
    scope = desired_scope(d, true);
    scope.environment_id = "other-environment";
    desired_refuses([&] { apply_desired_asset(d, scope, proposal); }, DesiredCode::ScopeDenied,
                    "wrong Environment disclosed old-value/revision conflict");
    scope = desired_scope(d, true);
    proposal.asset_id = "missing";
    desired_refuses([&] { apply_desired_asset(d, scope, proposal); }, DesiredCode::ScopeDenied,
                    "missing target had a different stale-value outcome");
    scope.project_id = "other-project";
    proposal.asset_id = "asset";
    desired_refuses([&] { apply_desired_asset(d, scope, proposal); }, DesiredCode::ScopeDenied,
                    "wrong Project disclosed old-value/revision conflict");
}
void desired_placement_and_independent_read_capability() {
    auto d = fixture();
    auto scope = desired_scope(d);
    scope.allow_desired_write = false;
    const auto read = select_desired_asset(d, scope, "asset");
    check(read.values == DesiredAssetValues{false, 1700} && read.asset.placement && !read.asset.placement->role,
          "read-only scope lost explicit unknown-role placement or desired values");
    const auto proposal = desired_proposal(d);
    desired_refuses([&] { normalize_desired_asset_proposal(scope, proposal); }, DesiredCode::ScopeDenied,
                    "read capability enabled a desired edit");
    desired_refuses([&] { apply_desired_asset(d, scope, proposal); }, DesiredCode::ScopeDenied,
                    "read capability enabled an applied transition");
    desired_refuses([&] { select_desired_asset(d, scope, "unplaced"); }, DesiredCode::ScopeDenied,
                    "undeclared placement matched a delegated Environment");
    d.structure->asset_placements.push_back({"unplaced", "", "", "", std::nullopt});
    desired_refuses([&] { select_desired_asset(d, scope, "unplaced"); }, DesiredCode::ScopeDenied,
                    "empty Environment matched a delegated Environment");
    placed(d, "unplaced").environment_id = "environment";
    const auto declared = select_desired_asset(d, scope, "unplaced");
    check(declared.asset.placement && !declared.asset.placement->role &&
          declared.asset.path.environment_id == "environment", "unknown role became invented or refused");
    scope.allow_desired_write = true;
    const auto transition = apply_desired_asset(d, scope, desired_proposal(d, "unplaced"));
    check(transition.document.structure == d.structure, "desired edit silently changed placement or role");
}
void desired_strict_typed_input() {
    const auto d = fixture();
    const auto original_scope = desired_scope(d);
    const auto original_proposal = desired_proposal(d);
    validate_desired_asset_scope(original_scope, true);
    check(original_scope.store_uuid.size() == 36 && original_scope.store_uuid[8] == '-' &&
          original_scope.store_uuid[13] == '-' && original_scope.store_uuid[18] == '-' &&
          original_scope.store_uuid[23] == '-', "valid UUID baseline/grouping changed");
    const std::vector<std::function<void(DesiredAssetScope &)>> bad_scope{
        [](auto &s) { s.project_id = "bad:id"; },
        [](auto &s) { s.site_id = ""; },
        [](auto &s) { s.environment_id = "1bad"; },
        [](auto &s) { s.store_uuid = "00000000-0000-0000-0000-000000000000"; },
        [](auto &s) { s.store_uuid += "\n"; },
        [](auto &s) { s.store_uuid[9] = 'A'; },
        [](auto &s) { s.store_uuid.erase(18, 5); },
        [](auto &s) { s.grant_fingerprint += "\n"; },
        [](auto &s) { s.grant_fingerprint[0] = 'G'; },
        [](auto &s) { s.principal_id = ""; },
        [](auto &s) { s.principal_id = std::string(161, 'p'); },
        [](auto &s) { s.principal_id = "operator\n"; },
        [](auto &s) { s.principal_id = std::string("\xed\xa0\x80", 3); },
    };
    for (const auto &change : bad_scope) {
        auto scope = original_scope;
        change(scope);
        desired_refuses([&] { validate_desired_asset_scope(scope); }, DesiredCode::InvalidInput,
                        "invalid fixed-scope scalar passed validation");
    }
    auto unicode = original_scope;
    unicode.principal_id.clear();
    for (int i = 0; i < 80; ++i) unicode.principal_id += "\xc3\xa9";
    validate_desired_asset_scope(unicode);
    check(unicode.principal_id.size() == 160, "principal byte boundary baseline invalid");
    unicode.principal_id += "\xc3\xa9";
    desired_refuses([&] { validate_desired_asset_scope(unicode); }, DesiredCode::InvalidInput,
                    "principal UTF-8 byte cap was treated as a character cap");
    const std::vector<std::function<void(DesiredAssetProposal &)>> bad_proposal{
        [](auto &p) { p.asset_id = "bad:id"; },
        [](auto &p) { p.asset_id += "\n"; },
        [](auto &p) { p.expected_revision = 0; },
        [](auto &p) { p.expected_revision = 9007199254740991LL; },
        [](auto &p) { p.expected.poll_ms = 99; },
        [](auto &p) { p.expected.poll_ms = 3600001; },
        [](auto &p) { p.desired.poll_ms = 99; },
        [](auto &p) { p.desired.poll_ms = 3600001; },
        [](auto &p) { p.handoff_digest += "\n"; },
        [](auto &p) { p.handoff_digest[0] = 'B'; },
        [](auto &p) { p.desired = p.expected; },
    };
    for (const auto &change : bad_proposal) {
        auto proposal = original_proposal;
        change(proposal);
        desired_refuses([&] { normalize_desired_asset_proposal(original_scope, proposal); }, DesiredCode::InvalidInput,
                        "invalid proposal scalar/range/no-op passed normalization");
    }
    auto malformed_graph = d;
    row(malformed_graph.structure->areas, "floor").parent_area_id = "cell";
    auto malformed_input = original_proposal;
    malformed_input.asset_id = "bad:id";
    desired_refuses([&] { apply_desired_asset(malformed_graph, original_scope, malformed_input); },
                    DesiredCode::InvalidInput, "current graph was accessed before pure request validation");
}
void desired_revision_headroom_and_poll_boundaries() {
    auto d = fixture();
    const auto scope = desired_scope(d);
    auto proposal = desired_proposal(d);
    proposal.desired = {proposal.expected.enabled, 100};
    check(find_asset(apply_desired_asset(d, scope, proposal).document.topology, "asset").poll_ms == 100,
          "minimum desired poll was refused");
    proposal.desired.poll_ms = 3600000;
    check(find_asset(apply_desired_asset(d, scope, proposal).document.topology, "asset").poll_ms == 3600000,
          "maximum desired poll was refused");
    proposal.desired = {!proposal.expected.enabled, proposal.expected.poll_ms};
    const auto toggle = apply_desired_asset(d, scope, proposal);
    check(find_asset(toggle.document.topology, "asset").enabled == proposal.desired.enabled &&
          find_asset(toggle.document.topology, "asset").poll_ms == proposal.expected.poll_ms,
          "enabled-only transition changed another desired field");
    d.topology.revision = 9007199254740989LL;
    proposal = desired_proposal(d);
    check(apply_desired_asset(d, scope, proposal).document.topology.revision == d.topology.revision,
          "pure transition advanced the last available writer revision");
    d.topology.revision = 9007199254740990LL;
    proposal = desired_proposal(d);
    check(select_desired_asset(d, scope, "asset").revision == d.topology.revision,
          "exhausted writer revision became unreadable");
    check(normalize_desired_asset_proposal(scope, proposal) == proposal,
          "normalizer conflated valid saved revision with write headroom");
    desired_refuses([&] { apply_desired_asset(d, scope, proposal); }, DesiredCode::BudgetExceeded,
                    "exhausted next revision was not refused before transition");
    proposal.expected_revision -= 1;
    desired_refuses([&] { apply_desired_asset(d, scope, proposal); }, DesiredCode::RevisionConflict,
                    "unequal revision lost its distinct bounded conflict");
}
void desired_current_graph_errors_are_owner_errors() {
    const auto d = fixture();
    const auto scope = desired_scope(d, true);
    const auto proposal = desired_proposal(d);
    auto malformed = d;
    placed(malformed, "parent").environment_id = "other-environment";
    desired_refuses([&] { apply_desired_asset(malformed, scope, proposal); }, DesiredCode::OwnerUnavailable,
                    "inconsistent parent placement was attributed to caller input or accepted");
    malformed = d;
    row(malformed.topology.assets, "asset").poll_ms = 1;
    desired_refuses([&] { select_desired_asset(malformed, scope, "asset"); }, DesiredCode::OwnerUnavailable,
                    "corrupt stored desired values escaped graph validation");
    malformed = d;
    row(malformed.structure->areas, "floor").parent_area_id = "cell";
    desired_refuses([&] { apply_desired_asset(malformed, scope, proposal); }, DesiredCode::OwnerUnavailable,
                    "corrupt ancestry was not an owner refusal");
    auto unsupported = d;
    unsupported.structure.reset();
    desired_refuses([&] { select_desired_asset(unsupported, scope, "asset"); }, DesiredCode::UnsupportedSchema,
                    "legacy unstructured graph was implicitly upgraded");
    unsupported = d;
    unsupported.topology.revision = 0;
    desired_refuses([&] { select_desired_asset(unsupported, scope, "asset"); }, DesiredCode::UnsupportedSchema,
                    "unsaved graph was treated as a saved desired target");
}
} // namespace

int main() {
    const std::vector<std::pair<const char *, std::function<void()>>> cases{
        {"targeted physical path without hierarchy write authority", exact_target_without_write_authority},
        {"all inherited physical privacy gates", every_inherited_privacy_gate},
        {"uniform target and project scope refusal", uniform_missing_hidden_and_project_scope},
        {"placement absence and unknown role preservation", placement_absence_is_not_invented},
        {"pure scalar graph revision and depth boundaries", shape_and_depth_limits},
        {"desired two-field transition preserves the complete document", desired_two_field_preservation},
        {"desired target authorization precedes old-value conflicts", desired_authorization_before_conflicts},
        {"desired placement scope and independent read capability", desired_placement_and_independent_read_capability},
        {"desired typed scalar and byte boundaries", desired_strict_typed_input},
        {"desired revision headroom and poll boundaries", desired_revision_headroom_and_poll_boundaries},
        {"desired current graph corruption stays an owner error", desired_current_graph_errors_are_owner_errors},
    };
    int passed = 0;
    for (const auto &[name, run] : cases) {
        const auto before = failures;
        try { run(); }
        catch (const std::exception &) { check(false, "unexpected desired Asset domain test exception"); }
        if (failures == before) { ++passed; std::cout << "PASS " << name << '\n'; }
        else std::cout << "FAIL " << name << '\n';
    }
    std::cout << "Desired Asset domain: " << passed << '/' << cases.size() << " cases passed; "
              << checks << " behavioral checks; " << failures << " failures; 0 skipped.\n";
    return failures == 0 ? 0 : 1;
}
