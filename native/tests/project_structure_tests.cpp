#include "lmti/project_store.hpp"
#include <QCoreApplication>
#include <QFile>
#include <QFileInfo>
#include <QJsonObject>
#include <QTemporaryDir>
#include <algorithm>
#include <functional>
#include <iostream>

namespace {
int failures = 0;
void check(bool value, const char *message) {
    if (!value) {
        std::cerr << message << '\n';
        ++failures;
    }
}
void rejects(const std::function<void()> &operation, const char *message) {
    try {
        operation();
        check(false, message);
    } catch (const lmti::Error &) {
    }
}
QByteArray bytes(const QString &path) {
    QFile file(path);
    check(file.open(QIODevice::ReadOnly), "cannot read saved fixture");
    return file.readAll();
}
lmti::ProjectDocument fixture() {
    auto document = lmti::demo_project();
    document.structure.emplace();
    auto &structure = *document.structure;
    structure.subsystems = {{"control", "Control", "", lmti::Privacy::Internal},
                            {"sensor", "Sensors", "control", lmti::Privacy::Public}};
    structure.component_memberships = {{"sensor-firmware", "sensor"}, {"gateway-agent", "control"}};
    structure.sites = {{"factory-demo", "Factory", lmti::Privacy::Public},
                       {"other-site", "Factory", lmti::Privacy::Internal}};
    structure.areas = {{"floor", "Floor", "factory-demo", "", lmti::Privacy::Public},
                       {"cell", "Cell", "factory-demo", "floor", lmti::Privacy::Internal},
                       {"elsewhere", "Cell", "other-site", "", lmti::Privacy::Public}};
    structure.environments = {{"test", "Test", lmti::Privacy::Public},
                              {"production", "Production", lmti::Privacy::Internal}};
    structure.asset_placements = {
        {"machine-a", "cell", "gateway-b", "test", lmti::PhysicalRole::Device},
        {"gateway-b", "cell", "broker-c", "test", lmti::PhysicalRole::Gateway},
        {"broker-c", "cell", "", "test", lmti::PhysicalRole::Host}};
    return document;
}
void validation_tests() {
    const auto original = fixture();
    lmti::validate(original);
    check(lmti::physical_role("host") == lmti::PhysicalRole::Host &&
              lmti::name(lmti::PhysicalRole::Gateway) == "gateway", "role conversion failed");
    rejects([] { lmti::physical_role("machine"); }, "asset kind accepted as a physical role");
    // Privacy is inherited at projection: a declared public child beneath an
    // internal ancestor is valid data, never permission to bypass that ancestor.
    check(original.structure->subsystems[0].privacy == lmti::Privacy::Internal,
          "internal ancestor fixture missing");
    auto changed = original;
    changed.dependencies.push_back({"backend-sensor", "monitor-backend", "sensor-firmware", "cycle", lmti::Privacy::Public});
    lmti::validate(changed); // Dependency cycle must not become a containment cycle.
    changed.structure->sites[0].label = "Renamed factory";
    changed.structure->subsystems[1].label = "Control"; // Duplicate labels are allowed.
    changed.components[0].label = "Renamed firmware";
    changed.structure->component_memberships[0].subsystem_id = "control";
    lmti::validate_update(original, changed);
    check(changed.components[0].id == original.components[0].id &&
              changed.topology.assets[0].id == original.topology.assets[0].id &&
              changed.bindings == original.bindings && changed.knowledge == original.knowledge,
          "rename/reparent changed linked identities");
    changed = original;
    changed.structure->asset_placements.clear();
    lmti::validate(changed);
    check(changed.structure->asset_placements.empty(), "validation inferred physical placements");
    changed.structure->asset_placements = {{"gateway-b", "", "", "", std::nullopt}};
    lmti::validate(changed);
    check(!changed.structure->asset_placements[0].role &&
              changed.structure->asset_placements[0].environment_id.empty(), "validation inferred role/environment");
    changed = original;
    changed.structure.reset();
    rejects([&] { lmti::validate_update(original, changed); }, "declared structure silently removed");
    auto invalid = [&](const std::function<void(lmti::ProjectDocument &)> &edit, const char *message) {
        auto bad = original;
        edit(bad);
        rejects([&] { lmti::validate(bad); }, message);
    };
    invalid([](auto &d) { d.structure->subsystems[0].parent_subsystem_id = "sensor"; }, "subsystem cycle accepted");
    invalid([](auto &d) { d.structure->subsystems[0].parent_subsystem_id = "control"; }, "self containment accepted");
    invalid([](auto &d) { d.structure->subsystems[1].parent_subsystem_id = "missing"; }, "missing subsystem accepted");
    invalid([](auto &d) { d.structure->subsystems.push_back(d.structure->subsystems[0]); }, "duplicate subsystem ID accepted");
    invalid([](auto &d) { d.structure->subsystems[0].label = "invalid\nlabel"; }, "invalid structure metadata accepted");
    invalid([](auto &d) { d.structure->environments[0].privacy = static_cast<lmti::Privacy>(9); }, "invalid environment privacy accepted");
    invalid([](auto &d) { d.structure->component_memberships.push_back({"sensor-firmware", "control"}); }, "multiple component parents accepted");
    invalid([](auto &d) { d.structure->component_memberships[0].component_id = "missing"; }, "missing component accepted");
    invalid([](auto &d) { d.structure->component_memberships[0].subsystem_id = "machine-a"; }, "wrong parent kind accepted");
    invalid([](auto &d) { d.structure->sites.erase(d.structure->sites.begin()); }, "missing asset site accepted");
    invalid([](auto &d) { d.structure->areas[0].parent_area_id = "cell"; }, "area cycle accepted");
    invalid([](auto &d) { d.structure->areas[1].parent_area_id = "elsewhere"; }, "cross-site area parent accepted");
    invalid([](auto &d) { d.structure->areas[1].site_id = "missing"; }, "unknown area site accepted");
    invalid([](auto &d) { d.structure->asset_placements[2].parent_asset_id = "machine-a"; }, "asset containment cycle accepted");
    invalid([](auto &d) { d.structure->asset_placements[0].parent_asset_id = "missing"; }, "missing asset parent accepted");
    invalid([](auto &d) { d.structure->asset_placements.pop_back(); }, "undeclared parent placement accepted");
    invalid([](auto &d) { d.structure->asset_placements.push_back(d.structure->asset_placements[0]); }, "multiple placements accepted");
    invalid([](auto &d) { d.structure->asset_placements[0].asset_id = "missing"; }, "unknown placement asset accepted");
    invalid([](auto &d) { d.structure->asset_placements[0].area_id = "elsewhere"; }, "cross-site placement accepted");
    invalid([](auto &d) { d.structure->asset_placements[0].area_id = "floor"; }, "different parent area accepted");
    invalid([](auto &d) { d.structure->asset_placements[0].environment_id = "production"; }, "different parent environment accepted");
    invalid([](auto &d) { d.structure->asset_placements[0].environment_id.clear(); }, "unknown/known parent environment mismatch accepted");
    invalid([](auto &d) { d.structure->asset_placements[0].environment_id = "missing"; }, "unknown environment reference accepted");
    invalid([](auto &d) { d.structure->asset_placements[0].role = static_cast<lmti::PhysicalRole>(9); }, "invalid physical role accepted");
    invalid([](auto &d) {
        d.topology.assets[2].site = "other-site";
        for (auto &row : d.structure->asset_placements) row.area_id.clear();
    }, "cross-site asset parent accepted without area");
    check(original == fixture(), "validation modified the source document");
}
void depth_and_size_tests() {
    lmti::ProjectDocument document;
    document.project = {"structure-test", "Test", "", lmti::Privacy::Public};
    document.structure.emplace();
    auto &s = *document.structure;
    for (std::size_t i = 0; i < lmti::max_structure_depth; ++i)
        s.subsystems.push_back({"sub-" + std::to_string(i), "Subsystem",
                               i ? "sub-" + std::to_string(i-1) : "", lmti::Privacy::Public});
    std::reverse(s.subsystems.begin(), s.subsystems.end()); // Child-before-parent input.
    lmti::validate(document);
    document.components.push_back({"leaf", "Leaf", "", lmti::ComponentKind::Firmware, lmti::Privacy::Public});
    s.component_memberships = {{"leaf", "sub-31"}};
    rejects([&] { lmti::validate(document); }, "component leaf bypassed logical depth budget");
    s.component_memberships[0].subsystem_id = "sub-30";
    lmti::validate(document);
    s.subsystems.front().parent_subsystem_id = "sub-31";
    rejects([&] { lmti::validate(document); }, "reversed-order cycle accepted");
    s.subsystems.clear();
    s.component_memberships.clear();
    for (std::size_t i = 0; i < lmti::max_project_records; ++i)
        s.subsystems.push_back({"wide-" + std::to_string(i), "Same label", "", lmti::Privacy::Public});
    lmti::validate(document);
    s.subsystems.push_back({"over-limit", "One too many", "", lmti::Privacy::Public});
    rejects([&] { lmti::validate(document); }, "structure catalog exceeded record limit");
    s.subsystems.clear();
    s.sites = {{"factory-demo", "Site", lmti::Privacy::Public}};
    document.topology.assets = {lmti::demo_topology().assets[0]};
    for (std::size_t i = 0; i < lmti::max_structure_depth; ++i)
        s.areas.push_back({"area-" + std::to_string(i), "Area", "factory-demo",
                           i ? "area-" + std::to_string(i-1) : "", lmti::Privacy::Public});
    s.asset_placements = {{"machine-a", "area-30", "", "", std::nullopt}};
    lmti::validate(document);
    s.asset_placements[0].area_id = "area-31";
    rejects([&] { lmti::validate(document); }, "asset leaf bypassed combined physical depth budget");
    s.areas.clear();
    s.asset_placements.clear();
    document.topology.assets.clear();
    for (std::size_t i = 0; i < lmti::max_structure_depth; ++i) {
        auto asset = lmti::demo_topology().assets[0];
        asset.id = "asset-" + std::to_string(i);
        document.topology.assets.push_back(asset);
        s.asset_placements.push_back({asset.id, "", i ? "asset-" + std::to_string(i-1) : "", "", std::nullopt});
    }
    lmti::validate(document);
    auto asset = document.topology.assets.back();
    asset.id = "too-deep";
    document.topology.assets.push_back(asset);
    s.asset_placements.push_back({asset.id, "", "asset-31", "", std::nullopt});
    rejects([&] { lmti::validate(document); }, "asset chain exceeded depth budget");
}
void schema_one_guard_tests(const QTemporaryDir &temp) {
    const auto path = temp.filePath("legacy.sqlite");
    auto legacy = lmti::demo_project();
    legacy.topology.revision = lmti::save_project(path, legacy);
    const auto before = bytes(path);
    const auto loaded = lmti::load_project(path);
    check(loaded == legacy && !loaded.structure, "schema-1 read changed legacy structure state");
    auto structured = fixture();
    structured.topology.revision = legacy.topology.revision;
    rejects([&] { lmti::save_project(path, structured); }, "schema-1 writer silently dropped hierarchy");
    check(bytes(path) == before && lmti::load_project(path) == legacy, "refused structure save changed existing database");
    legacy.project.label = "Flat legacy edit";
    legacy.topology.revision = lmti::save_project(path, legacy);
    check(legacy.topology.revision == 2 && lmti::load_project(path) == legacy,
          "flat schema-1 save compatibility regressed");
}
void legacy_boundary_guard_tests() {
    auto structured = fixture();
    structured.topology.revision = 1;
    const auto unchanged = structured;
    const lmti::ProjectScope scope{structured.project.id, "factory-demo", true, 100};
    // Public firmware and assets beneath private subsystem/area ancestors must
    // not leak through a legacy projection that lacks ancestor filtering.
    rejects([&] { lmti::project_context(structured, scope); }, "legacy context exposed hierarchy without parent privacy");
    rejects([&] { lmti::project_impact(structured, scope, "sensor-firmware"); }, "legacy impact bypassed parent privacy");
    const lmti::WorkProposal proposal{structured.project.id, "validate-sampling", 1,
                                      lmti::WorkState::Todo, lmti::WorkState::Review};
    rejects([&] { lmti::apply_proposal(structured, proposal); }, "legacy proposal bypassed hierarchy boundary");
    check(structured == unchanged, "legacy boundary refusal mutated the document");
    structured.structure.reset();
    check(!lmti::project_context(structured, scope).isEmpty(), "flat legacy context regressed");
    check(!lmti::project_impact(structured, scope, "sensor-firmware").isEmpty(), "flat legacy impact regressed");
    const auto applied = lmti::apply_proposal(structured, proposal);
    check(applied.work[0].state == lmti::WorkState::Review && structured.work[0].state == lmti::WorkState::Todo,
          "flat legacy proposal behavior regressed");
}
} // namespace
int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    QTemporaryDir temp;
    check(temp.isValid(), "temporary fixture unavailable");
    if (!temp.isValid()) return 1;
    validation_tests();
    depth_and_size_tests();
    schema_one_guard_tests(temp);
    legacy_boundary_guard_tests();
    std::cout << "Typed project structure, containment limits and schema-1 no-loss guard checked\n";
    return failures ? 1 : 0;
}
