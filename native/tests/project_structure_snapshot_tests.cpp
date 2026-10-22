#include "lmti/project_store.hpp"
#include <QCoreApplication>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QDir>
#include <QJsonArray>
#include <QJsonDocument>
#include <QProcess>
#include <QRegularExpression>
#include <QTemporaryDir>
#include <algorithm>
#include <functional>
#include <iostream>
#include <utility>
#include <vector>
#ifdef Q_OS_WIN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace {
int failures = 0;
void check(bool ok, const char *message) {
    if (!ok) { std::cerr << message << '\n'; ++failures; }
}
void rejects(const std::function<void()> &operation, const char *message) {
    try { operation(); check(false, message); } catch (const lmti::Error &) {}
}
QByteArray bytes(const QString &path) {
    QFile file(path);
    check(file.open(QIODevice::ReadOnly), "cannot read disposable snapshot fixture");
    return file.readAll();
}
QJsonObject row(const QJsonObject &snapshot, const char *group, const char *id) {
    for (const auto &value : snapshot[group].toArray())
        if (value.toObject()["id"] == id) return value.toObject();
    return {};
}
QJsonObject read(const QString &path, bool external = true, const std::string &site = "factory-demo") {
    const auto before = bytes(path);
    const auto result = lmti::project_structure_snapshot(path, {"factory-monitor", site, external, 1});
    check(bytes(path) == before, "structure projection mutated graph, lineage or registry bytes");
    return result;
}
void save(const QString &path, lmti::ProjectDocument &d) { d.topology.revision = lmti::save_project(path, d); }
lmti::ProjectDocument fixture() {
    auto d = lmti::demo_project();
    d.repositories.front().locator = "private-repository-location";
    d.knowledge = {{"design", "Design", "sensor-firmware", "private-document-location", "declared-revision", lmti::Privacy::Public},
                   {"overview", "Overview", "", "private-overview-location", "declared-overview-revision", lmti::Privacy::Public}};
    d.dependencies.push_back({"return-contract", "gateway-agent", "sensor-firmware", "reply", lmti::Privacy::Public});
    d.topology.assets.push_back({"root-device", "Same label", "factory-demo", lmti::Kind::Sensor, lmti::Privacy::Public});
    d.topology.assets.push_back({"unknown-device", "Same label", "factory-demo", lmti::Kind::Sensor, lmti::Privacy::Public});
    d.topology.assets.push_back({"other-device", "Other device", "other-site", lmti::Kind::Sensor, lmti::Privacy::Public});
    d.topology.assets.push_back({"denied-device", "Private-site device", "denied-site", lmti::Kind::Sensor, lmti::Privacy::Public});
    d.structure.emplace();
    auto &s = *d.structure;
    s.subsystems = {{"sensors", "Same label", "control", lmti::Privacy::Public},
                    {"control", "Same label", "", lmti::Privacy::Public}};
    s.component_memberships = {{"sensor-firmware", "sensors"}};
    s.sites = {{"other-site", "Other site", lmti::Privacy::Public},
               {"factory-demo", "Factory", lmti::Privacy::Public},
               {"denied-site", "Private site", lmti::Privacy::Internal}};
    s.areas = {{"cell", "Cell", "factory-demo", "floor", lmti::Privacy::Public},
               {"floor", "Floor", "factory-demo", "", lmti::Privacy::Public},
               {"other-area", "Other area", "other-site", "", lmti::Privacy::Public},
               {"denied-area", "Private-site area", "denied-site", "", lmti::Privacy::Public}};
    s.environments = {{"unused", "Unused", lmti::Privacy::Public},
                      {"test", "Test", lmti::Privacy::Public},
                      {"other-env", "Other environment", lmti::Privacy::Public},
                      {"denied-env", "Private-site environment", lmti::Privacy::Public}};
    // Child-before-parent input is intentional. Role is never derived from kind.
    s.asset_placements = {{"machine-a", "cell", "gateway-b", "test", lmti::PhysicalRole::Device},
                          {"gateway-b", "cell", "broker-c", "test", lmti::PhysicalRole::Gateway},
                          {"broker-c", "cell", "", "test", lmti::PhysicalRole::Host},
                          {"root-device", "", "", "", std::nullopt},
                          {"other-device", "other-area", "", "other-env", lmti::PhysicalRole::Device},
                          {"denied-device", "denied-area", "", "denied-env", lmti::PhysicalRole::Device}};
    return d;
}

QString fresh_fixture_directory(const QString &requested) {
    // Qt native path conversion can remove a Windows device prefix. Reject
    // authority-bearing spelling before any library normalization or I/O.
    if (requested.startsWith("\\\\") || requested.startsWith("//"))
        throw lmti::Error("Invalid fixture output.");
    for (const auto character : requested)
        if (character.unicode() < 32 || character.unicode() == 127)
            throw lmti::Error("Invalid fixture output.");
    auto path = requested;
    path.replace('\\', '/');
    const QRegularExpression device("^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\..*)?$",
                                    QRegularExpression::CaseInsensitiveOption);
    if (path.isEmpty() || path.startsWith("//") || path.contains("//") || path.endsWith('/'))
        throw lmti::Error("Invalid fixture output.");
    for (qsizetype i = 0; i < path.size(); ++i)
        if (path[i].unicode() < 32 || path[i].unicode() == 127 ||
            (path[i] == ':' && !(i == 1 && path[0].isLetter())))
            throw lmti::Error("Invalid fixture output.");
    QString current;
#ifdef Q_OS_WIN
    if (!QRegularExpression("^[A-Za-z]:/").match(path).hasMatch())
        throw lmti::Error("Fixture output must be local and absolute.");
    current = path.left(3);
    const auto native_root = QDir::toNativeSeparators(current);
    if (GetDriveTypeW(reinterpret_cast<LPCWSTR>(native_root.utf16())) != DRIVE_FIXED)
        throw lmti::Error("Fixture output must use a local fixed drive.");
#else
    if (!path.startsWith('/') || path.contains(':'))
        throw lmti::Error("Fixture output must be local and absolute.");
    current = "/";
#endif
    const auto parts = path.mid(current.size()).split('/');
    for (const auto &part : parts)
        if (part.isEmpty() || part == "." || part == ".." || part.endsWith('.') || part.endsWith(' ') ||
            device.match(part).hasMatch())
            throw lmti::Error("Invalid fixture output.");
    auto directory = [](const QString &parent) {
#ifdef Q_OS_WIN
        const auto native_parent = QDir::toNativeSeparators(parent);
        const auto attributes = GetFileAttributesW(reinterpret_cast<LPCWSTR>(native_parent.utf16()));
        if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
            !(attributes & FILE_ATTRIBUTE_DIRECTORY))
            throw lmti::Error("Fixture parent is unavailable.");
#endif
        const QFileInfo info(parent);
        if (!info.isDir() || info.isSymLink()) throw lmti::Error("Fixture parent is unavailable.");
    };
    // Probe from the drive/root down, never a child beneath an unchecked link.
    directory(current);
    for (qsizetype i = 0; i + 1 < parts.size(); ++i) {
        current = QDir(current).filePath(parts[i]);
        directory(current);
    }
    const auto target = QDir(current).filePath(parts.back());
    if (QFileInfo::exists(target) || !QDir(current).mkdir(parts.back()))
        throw lmti::Error("Fixture output must be new.");
    directory(target);
    return target;
}

int emit_fixtures(const QString &requested, bool receipt = true) {
    const QDir output(fresh_fixture_directory(requested));
    auto structured = fixture();
    save(output.filePath("structure.sqlite"), structured);
    auto internal = fixture();
    for (auto &subsystem : internal.structure->subsystems)
        if (subsystem.id == "control") subsystem.privacy = lmti::Privacy::Internal;
    save(output.filePath("internal.sqlite"), internal);
    auto flat = lmti::demo_project();
    save(output.filePath("flat.sqlite"), flat);
    if (receipt)
        std::cout << "{\"schema\":\"lmti.test.structure-fixtures.v1\",\"files\":[\"structure.sqlite\",\"internal.sqlite\",\"flat.sqlite\"]}\n";
    return 0;
}

void fixture_export_tests(const QTemporaryDir &temp) {
    const std::vector<std::pair<QString, const char *>> unsafe = {
        {"//server/share/new", "UNC spelling accepted"},
        {QString("\\\\?\\") + QDir::toNativeSeparators(temp.filePath("device-output")), "device namespace accepted"},
        {temp.filePath("new:stream"), "alternate stream accepted"},
        {"relative", "relative spelling accepted"},
        {temp.path() + "/../new", "parent segment accepted"},
        {temp.path() + "/./new", "dot segment accepted"},
        {temp.filePath("NUL.txt"), "reserved device accepted"},
        {temp.filePath("control\n"), "control character accepted"},
        {temp.filePath("trailing."), "trailing dot accepted"},
        {temp.filePath("trailing "), "trailing space accepted"},
        {temp.path() + "/double//leaf", "duplicate separator accepted"}};
    for (const auto &[path, message] : unsafe)
        rejects([&] { fresh_fixture_directory(path); }, message);
    rejects([&] { fresh_fixture_directory(temp.path()); }, "existing fixture directory was accepted");
    const auto destination = temp.filePath("exported");
    check(emit_fixtures(destination, false) == 0, "typed fixture export failed");
    const QDir output(destination);
    const auto before = bytes(output.filePath("structure.sqlite"));
    check(lmti::load_project(output.filePath("structure.sqlite")).structure.has_value() &&
              !lmti::load_project(output.filePath("flat.sqlite")).structure.has_value(),
          "fixture export changed declared/legacy structure state");
    rejects([&] { emit_fixtures(destination, false); }, "fixture export overwrote an existing output");
    check(bytes(output.filePath("structure.sqlite")) == before, "refused fixture export changed database bytes");
}
void shape(const QTemporaryDir &temp) {
    const auto path = temp.filePath("shape.sqlite");
    auto d = fixture(); save(path, d);
    const auto snapshot = read(path);
    check(snapshot["schema"] == "lmti.project.snapshot.v3" && snapshot["structureDeclared"] == true &&
              snapshot["complete"] == true && snapshot["semantics"] == "declared" && snapshot["revision"] == 1,
          "v3 completeness, declaration or revision differs");
    check(snapshot.size() == 20 && snapshot["components"].toArray().size() == 3 && snapshot["assets"].toArray().size() == 5,
          "v3 exact envelope or nontruncating scope.limit behavior differs");
    check(row(snapshot, "components", "sensor-firmware").size() == 6 &&
              row(snapshot, "components", "sensor-firmware")["subsystemId"] == "sensors" &&
              row(snapshot, "components", "monitor-backend")["subsystemId"] == "",
          "component membership lost or inferred");
    const auto device = row(snapshot, "assets", "machine-a");
    check(device.size() == 10 && device["placementDeclared"] == true && device["areaId"] == "cell" &&
              device["parentAssetId"] == "gateway-b" && device["environmentId"] == "test" && device["physicalRole"] == "device",
          "asset placement shape differs");
    check(row(snapshot, "assets", "gateway-b")["physicalRole"] == "gateway" &&
              row(snapshot, "assets", "broker-c")["physicalRole"] == "host" &&
              row(snapshot, "assets", "root-device")["placementDeclared"] == true &&
              row(snapshot, "assets", "root-device")["physicalRole"] == "unknown" &&
              row(snapshot, "assets", "unknown-device")["placementDeclared"] == false &&
              row(snapshot, "assets", "unknown-device")["physicalRole"] == "unknown",
          "missing placement, explicit root or unknown role was fabricated");
    check(row(snapshot, "subsystems", "sensors").size() == 4 &&
              row(snapshot, "subsystems", "sensors")["parentSubsystemId"] == "control" &&
              row(snapshot, "areas", "cell").size() == 5 && row(snapshot, "areas", "cell")["parentAreaId"] == "floor" &&
              row(snapshot, "areas", "cell")["siteId"] == "factory-demo" &&
              snapshot["sites"].toArray().size() == 1 && row(snapshot, "sites", "factory-demo").size() == 3 &&
              snapshot["environments"].toArray().size() == 1 && row(snapshot, "environments", "test").size() == 3,
          "catalog scope, ancestry or exact fields differ");
    check(snapshot["dependencies"].toArray().size() == 3, "valid dependency cycle was lost");
    for (const auto *group : {"components", "assets", "releases", "bindings", "dependencies", "connections",
                              "repositories", "knowledge", "subsystems", "sites", "areas", "environments"}) {
        QString previous;
        for (const auto &value : snapshot[group].toArray()) {
            const auto id = value.toObject()["id"].toString();
            check(previous.isEmpty() || previous < id, "snapshot group is not ordered by stable ID");
            previous = id;
        }
    }
    check(read(path) == snapshot, "repeated structure read is not deterministic");
    const auto encoded = QJsonDocument(snapshot).toJson(QJsonDocument::Compact);
    check(!encoded.contains("private-repository-location") && !encoded.contains("private-document-location") &&
              !encoded.contains("declared-revision") && !encoded.contains("storage_lineage") &&
              !encoded.contains("store_uuid") && !encoded.contains("identity_registry") &&
              !encoded.contains(d.storage_lineage->store_uuid.c_str()) && !encoded.contains(path.toUtf8()),
          "snapshot exposed raw source locations or native lineage");
    const auto before = bytes(path);
    rejects([&] { lmti::project_snapshot(path, {d.project.id, "factory-demo", true}, false); }, "v1 flattened structure");
    rejects([&] { lmti::project_snapshot(path, {d.project.id, "factory-demo", true}, true); }, "v2 flattened structure");
    rejects([&] { lmti::project_structure_snapshot(path, {"wrong-project", "factory-demo", true}); }, "wrong project authorized");
    rejects([&] { lmti::project_structure_snapshot(path, {d.project.id, "../site", true}); }, "invalid scope accepted");
    check(bytes(path) == before, "denied snapshot modified source");
}
void ancestry(const QTemporaryDir &temp) {
    const auto run = [&](const QString &name, const std::function<void(lmti::ProjectDocument &)> &mutate,
                         bool physical, const char *local_group, const char *local_id) {
        const auto path = temp.filePath(name + ".sqlite");
        auto d = fixture(); mutate(d); save(path, d);
        const auto external = read(path), local = read(path, false);
        check(row(local, local_group, local_id)["privacy"] == "internal", "local descendant lost inherited classification");
        if (name == "subsystem")
            check(external["subsystems"].toArray().isEmpty() && row(local, "subsystems", "sensors")["privacy"] == "internal",
                  "hidden logical ancestor was re-rooted or lost inherited privacy");
        if (name == "area")
            check(external["areas"].toArray().isEmpty() && row(local, "areas", "cell")["privacy"] == "internal",
                  "hidden area ancestor was re-rooted or lost inherited privacy");
        if (name == "environment")
            check(external["environments"].toArray().isEmpty(), "denied environment leaked a catalog row");
        if (physical) {
            check(row(external, "assets", "machine-a").isEmpty() && row(external, "bindings", "sensor-binding").isEmpty() &&
                      row(external, "connections", "link-ab").isEmpty(), "physical ancestor leaked child or endpoints");
            check(row(local, "bindings", "sensor-binding")["privacy"] == "internal" &&
                      row(local, "connections", "link-ab")["privacy"] == "internal", "local physical edge lost inherited privacy");
        } else {
            check(row(external, "components", "sensor-firmware").isEmpty() && row(external, "knowledge", "design").isEmpty() &&
                      row(external, "releases", "sensor-v020").isEmpty() && row(external, "dependencies", "sensor-gateway").isEmpty() &&
                      row(external, "bindings", "sensor-binding").isEmpty(), "logical ancestor leaked child or references");
            check(row(local, "knowledge", "design")["privacy"] == "internal" &&
                      row(local, "dependencies", "sensor-gateway")["privacy"] == "internal", "local logical reference lost inherited privacy");
        }
    };
    run("subsystem", [](auto &d) { d.structure->subsystems[1].privacy = lmti::Privacy::Internal; }, false, "components", "sensor-firmware");
    run("repository", [](auto &d) { d.repositories[0].privacy = lmti::Privacy::Internal; }, false, "components", "sensor-firmware");
    run("component", [](auto &d) { d.components[0].privacy = lmti::Privacy::Internal; }, false, "components", "sensor-firmware");
    run("site", [](auto &d) { d.structure->sites[1].privacy = lmti::Privacy::Internal; }, true, "assets", "machine-a");
    run("area", [](auto &d) { d.structure->areas[1].privacy = lmti::Privacy::Internal; }, true, "assets", "machine-a");
    run("parent", [](auto &d) { d.topology.assets[2].privacy = lmti::Privacy::Internal; }, true, "assets", "machine-a");
    run("environment", [](auto &d) { d.structure->environments[1].privacy = lmti::Privacy::Internal; }, true, "assets", "machine-a");
    const auto path = temp.filePath("project-private.sqlite");
    auto d = fixture(); d.project.privacy = lmti::Privacy::Internal; save(path, d);
    const auto before = bytes(path);
    rejects([&] { lmti::project_structure_snapshot(path, {d.project.id, "factory-demo", true}); }, "internal project exposed externally");
    check(bytes(path) == before && row(read(path, false), "subsystems", "sensors")["privacy"] == "internal" &&
              row(read(path, false), "environments", "test")["privacy"] == "internal", "project inheritance or rejected read differs");
}
void indistinguishable_site_and_software(const QTemporaryDir &temp) {
    const auto path = temp.filePath("site-scope.sqlite");
    auto d = fixture(); save(path, d);
    auto denied = read(path, true, "denied-site"), unknown = read(path, true, "unknown-site");
    denied.remove("site"); unknown.remove("site");
    check(denied == unknown && denied["components"].toArray().size() == 3 && denied["knowledge"].toArray().size() == 2,
          "unknown and denied sites differ or erase authorized logical records");
    for (const auto *group : {"assets", "sites", "areas", "environments", "bindings", "connections"})
        check(denied[group].toArray().isEmpty(), "unknown/denied site leaked physical records");
    const auto local_denied = read(path, false, "denied-site");
    check(row(local_denied, "assets", "denied-device")["privacy"] == "internal" &&
              row(local_denied, "areas", "denied-area")["privacy"] == "internal" &&
              row(local_denied, "sites", "denied-site")["privacy"] == "internal" &&
              row(local_denied, "environments", "denied-env")["privacy"] == "public",
          "site ancestry did not scope assets correctly or invented environment containment");
    const auto other = read(path, true, "other-site");
    check(other["assets"].toArray().size() == 1 && other["environments"].toArray().size() == 1 &&
              row(other, "environments", "other-env")["privacy"] == "public" &&
              row(other, "environments", "test").isEmpty(), "environment scope leaked across sites");
    const auto software_path = temp.filePath("software-only.sqlite");
    lmti::ProjectDocument software;
    software.project = {"factory-monitor", "Software only", "", lmti::Privacy::Public};
    software.components = {{"library", "Library", "", lmti::ComponentKind::Library, lmti::Privacy::Public}};
    software.structure.emplace(); save(software_path, software);
    const auto software_view = read(software_path);
    check(software_view["structureDeclared"] == true && software_view["components"].toArray().size() == 1 &&
              software_view["sites"].toArray().isEmpty(), "software-only structure fabricated a site or failed");
}
void maximum_depth(const QTemporaryDir &temp) {
    const auto path = temp.filePath("maximum-depth.sqlite");
    lmti::ProjectDocument d;
    d.project = {"factory-monitor", "Depth boundary", "", lmti::Privacy::Public};
    d.components = {{"leaf", "Leaf", "", lmti::ComponentKind::Library, lmti::Privacy::Public}};
    d.topology.assets = {{"device", "Device", "factory-demo", lmti::Kind::Sensor, lmti::Privacy::Public}};
    d.structure.emplace(); auto &s = *d.structure;
    s.sites = {{"factory-demo", "Factory", lmti::Privacy::Public}};
    // The leaf occupies edge 32. Reverse ordering forces parent traversal.
    for (int i = 30; i >= 0; --i) {
        const auto parent = i == 0 ? std::string{} : "node-" + std::to_string(i - 1);
        s.subsystems.push_back({"node-" + std::to_string(i), "Subsystem", parent, lmti::Privacy::Public});
        s.areas.push_back({"area-" + std::to_string(i), "Area", "factory-demo",
                          i == 0 ? std::string{} : "area-" + std::to_string(i - 1), lmti::Privacy::Public});
    }
    s.component_memberships = {{"leaf", "node-30"}};
    s.asset_placements = {{"device", "area-30", "", "", std::nullopt}};
    save(path, d);
    const auto public_view = read(path);
    check(public_view["subsystems"].toArray().size() == 31 && public_view["areas"].toArray().size() == 31 &&
              !row(public_view, "components", "leaf").isEmpty() && !row(public_view, "assets", "device").isEmpty(),
          "maximum valid depth lost descendants");
    s.subsystems.back().privacy = lmti::Privacy::Internal;
    s.areas.back().privacy = lmti::Privacy::Internal; save(path, d);
    const auto hidden = read(path);
    check(hidden["revision"] == 2 && hidden["subsystems"].toArray().isEmpty() && hidden["areas"].toArray().isEmpty() &&
              hidden["components"].toArray().isEmpty() && hidden["assets"].toArray().isEmpty(),
          "deep ancestor privacy change failed to hide current descendants");
    check(row(read(path, false), "components", "leaf")["privacy"] == "internal" &&
              row(read(path, false), "assets", "device")["privacy"] == "internal", "deep local leaf lost inherited classification");
}
void legacy(const QTemporaryDir &temp) {
    const auto path = temp.filePath("legacy.sqlite");
    auto d = fixture(); d.structure.reset(); save(path, d);
    const lmti::ProjectScope scope{d.project.id, "factory-demo", true};
    const auto v2 = lmti::project_snapshot(path, scope, true);
    auto v3 = read(path);
    check(v3["structureDeclared"] == false, "legacy structure declaration fabricated");
    for (const auto *group : {"subsystems", "sites", "areas", "environments"}) {
        check(v3[group].toArray().isEmpty(), "legacy catalog fabricated"); v3.remove(group);
    }
    v3.remove("structureDeclared"); v3["schema"] = "lmti.project.snapshot.v2";
    for (const auto *group : {"components", "assets"}) {
        auto rows = v3[group].toArray();
        for (qsizetype i = 0; i < rows.size(); ++i) {
            auto r = rows[i].toObject();
            if (QString(group) == "components") {
                check(r["subsystemId"] == "", "legacy membership fabricated"); r.remove("subsystemId");
            } else {
                check(r["placementDeclared"] == false && r["areaId"] == "" && r["parentAssetId"] == "" &&
                          r["environmentId"] == "" && r["physicalRole"] == "unknown", "legacy placement fabricated");
                for (const auto *key : {"placementDeclared", "areaId", "parentAssetId", "environmentId", "physicalRole"}) r.remove(key);
            }
            rows[i] = r;
        }
        v3[group] = rows;
    }
    check(v3 == v2, "legacy v3 changed v2 authorization, fields or reference fingerprints");
}
struct ProcessResult { int exit = -1; QByteArray output, error; };
ProcessResult command(const QString &binary, const QStringList &args) {
    QProcess process;
    process.setProgram(binary); process.setArguments(args); process.start();
    check(process.waitForStarted(5000), "snapshot CLI failed to start");
    process.closeWriteChannel();
    ProcessResult result;
    QElapsedTimer timer; timer.start();
    while (process.state() != QProcess::NotRunning && timer.elapsed() < 20000) {
        process.waitForFinished(50);
        result.output += process.readAllStandardOutput(); result.error += process.readAllStandardError();
        if (result.output.size() > 4 * 1024 * 1024 + 2 || result.error.size() > 4096) break;
    }
    if (process.state() != QProcess::NotRunning) { process.kill(); process.waitForFinished(5000); check(false, "snapshot CLI exceeded bound"); }
    result.output += process.readAllStandardOutput(); result.error += process.readAllStandardError();
    result.exit = process.exitCode();
    check(process.exitStatus() == QProcess::NormalExit, "snapshot CLI crashed");
    return result;
}
void cli_and_budget(const QTemporaryDir &temp, const QString &binary) {
    const auto path = temp.filePath("cli.sqlite");
    auto d = fixture(); save(path, d);
    const auto before = bytes(path);
    const auto good = command(binary, {"structure-snapshot", path, "factory-monitor", "factory-demo", "external"});
    check(good.exit == 0 && good.error.isEmpty() && QJsonDocument::fromJson(good.output).object() == read(path), "fixed v3 CLI differs from owner");
    for (const auto &args : std::vector<QStringList>{
             {"structure-snapshot", path, "factory-monitor", "factory-demo", "bad-target"},
             {"structure-snapshot", path, "wrong-project", "factory-demo", "external"},
             {"structure-snapshot", path, "factory-monitor", "factory-demo", "external", "extra"},
             {"agent-snapshot", path, "factory-monitor", "factory-demo", "external"}}) {
        const auto bad = command(binary, args);
        check(bad.exit != 0 && bad.output.isEmpty() && !bad.error.contains(path.toUtf8()), "invalid or legacy CLI exposed output/path");
    }
    check(bytes(path) == before, "CLI reads changed native bytes");
    // Valid dense topology exceeds serialized bytes while remaining inside all
    // domain count bounds; the owner must refuse the whole projection.
    lmti::ProjectDocument large;
    large.project = {"factory-monitor", "Bounded large fixture", "", lmti::Privacy::Public};
    large.structure.emplace(); large.structure->sites = {{"factory-demo", "Factory", lmti::Privacy::Public}};
    for (int i = 0; i < 230; ++i)
        large.topology.assets.push_back({"device-" + std::to_string(i), "Device", "factory-demo", lmti::Kind::Sensor, lmti::Privacy::Public});
    for (int from = 0; from < 230 && large.topology.links.size() < 45000; ++from)
        for (int to = 0; to < 230 && large.topology.links.size() < 45000; ++to)
            if (from != to) large.topology.links.push_back({"link-" + std::to_string(large.topology.links.size()),
                "device-" + std::to_string(from), "device-" + std::to_string(to), lmti::Protocol::Dependency});
    const auto large_path = temp.filePath("oversize.sqlite"); save(large_path, large);
    const auto large_before = bytes(large_path);
    rejects([&] { lmti::project_structure_snapshot(large_path, {large.project.id, "factory-demo", true}); }, "oversized v3 snapshot returned partial data");
    const auto oversize = command(binary, {"structure-snapshot", large_path, "factory-monitor", "factory-demo", "external"});
    check(oversize.exit != 0 && oversize.output.isEmpty() && bytes(large_path) == large_before, "oversized CLI emitted partial output or mutated source");
}
} // namespace
int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    if (argc == 3 && QString::fromLocal8Bit(argv[1]) == "--emit-fixtures") {
        try { return emit_fixtures(QString::fromLocal8Bit(argv[2])); }
        catch (const std::exception &) { std::cerr << "Fixture export failed\n"; return 1; }
    }
    if (argc != 2) return 2;
    QTemporaryDir temp;
    if (!temp.isValid()) return 2;
    try {
        fixture_export_tests(temp);
        shape(temp); ancestry(temp); indistinguishable_site_and_software(temp); maximum_depth(temp); legacy(temp);
        cli_and_budget(temp, QString::fromLocal8Bit(argv[1]));
    } catch (const std::exception &error) {
        std::cerr << "Unexpected fixture error: " << error.what() << '\n'; return 1;
    }
    return failures ? 1 : 0;
}
