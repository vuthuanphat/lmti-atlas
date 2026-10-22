#include "lmti/project_mapping_observation.hpp"
#include "lmti/project_store.hpp"
#include "lmti/project_desired_asset_store.hpp"
#include "../storage/original_read_p.hpp"
#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QMap>
#include <QProcess>
#include <QSet>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QTemporaryDir>
#include <QUuid>
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <iostream>
#include <set>
#include <utility>
#ifdef Q_OS_WIN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <winioctl.h>
#endif

#ifndef LMTI_ORIGINAL_READ_TEST_HOOKS
#error Compile this suite only in the isolated original-read hook target.
#endif
namespace {
using namespace lmti;
using K = MappingObservationKind;
using C = MappingObservationCode;
using P = Privacy;
using Phase = detail::OriginalReadPhase;
using Target = MappingObservationTarget;
using Scope = MappingObservationScope;
constexpr qsizetype cap = 4 * 1024 * 1024;
int cases = 0, checks = 0, failures = 0, skips = 0;
void check(bool value, const char *message) {
    ++checks;
    if (!value) { ++failures; std::cerr << "FAIL: " << message << '\n'; }
}
void need(bool value, const char *message = "Controlled mapping fixture setup failed.") {
    if (!value) throw Error(message);
}
QString s(const std::string &value) { return QString::fromStdString(value); }
QString at(const QString &root, const QString &leaf) { return QDir(root).filePath(leaf); }
QString uuid() { return QUuid::createUuid().toString(QUuid::WithoutBraces); }
QByteArray digest(const QByteArray &data) {
    return QCryptographicHash::hash(data, QCryptographicHash::Sha256).toHex();
}
QByteArray bytes(const QString &path) {
    QFile file(path); need(file.open(QIODevice::ReadOnly)); return file.readAll();
}
void put(const QString &path, const QByteArray &data) {
    QFile file(path); need(file.open(QIODevice::WriteOnly | QIODevice::NewOnly));
    need(file.write(data) == data.size());
}
using Tree = QMap<QString, QByteArray>;
void tree_into(const QString &root, const QString &prefix, Tree &out) {
    for (const auto &item : QDir(prefix.isEmpty() ? root : at(root, prefix)).entryInfoList(
             QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden | QDir::System, QDir::Name)) {
        const auto key = prefix.isEmpty() ? item.fileName() : prefix + '/' + item.fileName();
        if (item.isSymLink() || item.isJunction()) out[key] = "redirect";
        else if (item.isDir()) { out[key] = "directory"; tree_into(root, key, out); }
        else out[key] = QByteArray::number(item.size()) + ":" +
            (key.endsWith("-shm") ? QByteArray("existing-shm-coordination") : digest(bytes(item.filePath())));
    }
}
Tree tree(const QString &root) { Tree out; tree_into(root, {}, out); return out; }
class Sql {
    QString connection_ = uuid();
  public:
    QSqlDatabase db;
    explicit Sql(const QString &path) {
        need(QFileInfo(path).isFile());
        db = QSqlDatabase::addDatabase("QSQLITE", connection_);
        db.setDatabaseName(path); db.setConnectOptions("QSQLITE_BUSY_TIMEOUT=1000"); need(db.open());
    }
    ~Sql() { db.close(); db = {}; QSqlDatabase::removeDatabase(connection_); }
    void exec(const QString &text, const QVariantList &values = {}) {
        QSqlQuery q(db); need(q.prepare(text));
        for (const auto &value : values) q.addBindValue(value);
        need(q.exec());
    }
};
std::function<void(Phase, const QString &)> callback;
void dispatch(Phase phase, const QString &path) { if (callback) callback(phase, path); }
class Hook {
  public:
    explicit Hook(std::function<void(Phase, const QString &)> fn) {
        need(!callback); callback = std::move(fn); detail::set_original_read_test_hook(dispatch);
    }
    ~Hook() { detail::set_original_read_test_hook(nullptr); callback = {}; }
};
void refused(const std::function<void()> &fn, C expected) {
    try { fn(); check(false, "Expected typed mapping refusal was missing."); }
    catch (const MappingObservationError &e) {
        check(e.code == expected, "Unexpected mapping refusal code.");
        check(QByteArray(e.what()) == "Native mapping observation was refused.", "Mapping refusal leaked diagnostics.");
    }
}
template<class Row> Row &find(std::vector<Row> &rows, const std::string &id) {
    const auto it = std::find_if(rows.begin(), rows.end(), [&](const auto &r) { return r.id == id; });
    need(it != rows.end()); return *it;
}
Asset asset(const std::string &id, const std::string &site = "shared") {
    Asset a; a.id = id; a.label = "Synthetic asset"; a.site = site; a.privacy = P::Public; return a;
}
ProjectDocument document() {
    ProjectDocument d;
    d.project = {"mapping-project", "Synthetic mapping project", "", P::Public};
    d.structure.emplace(); auto &v = *d.structure;
    d.repositories = {{"shared", "Reference", "src/declared-reference", P::Public}};
    d.components = {{"shared", "Component", "shared", ComponentKind::Firmware, P::Public}};
    d.knowledge = {{"shared", "Knowledge", "shared", "docs/declared-reference", std::string(64, 'a'), P::Public}};
    v.subsystems = {{"root", "Root", "", P::Public}, {"shared", "Child", "root", P::Public},
                    {"other-subsystem", "Other", "", P::Public}};
    v.component_memberships = {{"shared", "shared"}};
    v.sites = {{"shared", "Site", P::Public}, {"other-site", "Other", P::Public}};
    v.areas = {{"parent-area", "Floor", "shared", "", P::Public},
               {"shared", "Cell", "shared", "parent-area", P::Public}};
    v.environments = {{"shared", "Environment", P::Public}, {"other-env", "Other", P::Public},
                      {"unused-env", "Unused", P::Public}};
    d.topology.assets = {asset("parent-asset"), asset("shared"), asset("unplaced"), asset("empty-placement"),
                         asset("other-asset", "other-site")};
    v.asset_placements = {{"parent-asset", "shared", "", "shared", PhysicalRole::Host},
                         {"shared", "shared", "parent-asset", "shared", std::nullopt},
                         {"empty-placement", "", "", "", std::nullopt},
                         {"other-asset", "", "", "shared", std::nullopt}};
    validate(d); return d;
}
const std::vector<Target> all_targets{
    {K::Subsystem, "shared"}, {K::Site, "shared"}, {K::Repository, "shared"}, {K::Knowledge, "shared"},
    {K::Environment, "shared"}, {K::Component, "shared"}, {K::Asset, "shared"}, {K::Area, "shared"}};
struct Fixture {
    QTemporaryDir temp{QDir(QDir::tempPath()).filePath("lmti-mapping-observation-XXXXXX")};
    QString directory, path;
    ProjectDocument saved;
    explicit Fixture(ProjectDocument initial = document()) {
        need(temp.isValid()); directory = at(temp.path(), "stores");
        need(QDir(temp.path()).mkdir("stores")); path = at(directory, QString::fromUtf8("project-測試.sqlite"));
        initial.topology.revision = save_project(path, initial); saved = load_project(path);
        put(at(temp.path(), "mapping-fixture.marker"), "lmti.mapping.observation.fixture.v1\n");
    }
    Scope scope(bool internal = true) const {
        return {saved.project.id, saved.storage_lineage ? saved.storage_lineage->store_uuid :
                "11111111-1111-4111-8111-111111111111", "shared", "shared", internal};
    }
    ProjectMappingObservation read(const std::vector<Target> &targets = all_targets, bool internal = true) const {
        return read_project_mapping_observation(path, scope(internal), targets);
    }
    void change(const std::function<void(ProjectDocument &)> &fn) {
        auto d = load_project(path); fn(d); d.topology.revision = save_project(path, d); saved = std::move(d);
    }
};
const MappingObservedTarget &observed(const ProjectMappingObservation &o, K kind, const std::string &id = "shared") {
    const auto it = std::find_if(o.targets.begin(), o.targets.end(), [&](const auto &r) {
        return r.target.kind == kind && r.target.id == id;
    });
    need(it != o.targets.end()); return *it;
}
bool hex64(const std::string &text) {
    return text.size() == 64 && std::all_of(text.begin(), text.end(), [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    });
}
QByteArray json(const QJsonObject &value) { return QJsonDocument(value).toJson(QJsonDocument::Compact); }
QJsonObject request(const std::vector<Target> &targets) {
    QJsonArray rows;
    for (const auto &t : targets) rows.append(QJsonObject{{"kind", s(name(t.kind))}, {"id", s(t.id)}});
    return {{"targets", rows}};
}
QStringList arguments(const Fixture &f, bool internal = true) {
    return {"mapping-observation", f.path, s(f.saved.project.id), s(f.scope().store_uuid),
            "shared", "shared", internal ? "local" : "external"};
}
struct Frame { QJsonObject value; QByteArray raw; int exit; };
Frame process(const QString &binary, const QStringList &args, const QByteArray &input) {
    QProcess child; child.setProgram(binary); child.setArguments(args);
    child.setProcessChannelMode(QProcess::SeparateChannels);
    QByteArray output, errors; bool overflow = false;
    const auto drain = [&] {
        const auto part = child.readAllStandardOutput(), err = child.readAllStandardError();
        if (output.size() + part.size() > cap || errors.size() + err.size() > 16384) overflow = true;
        if (!overflow) { output += part; errors += err; }
    };
    QObject::connect(&child, &QProcess::readyReadStandardOutput, drain);
    QObject::connect(&child, &QProcess::readyReadStandardError, drain);
    child.start(); need(child.waitForStarted(5000), "Read-only CLI did not start.");
    need(child.write(input) == input.size()); child.closeWriteChannel();
    QElapsedTimer timer; timer.start();
    while (child.state() != QProcess::NotRunning && timer.elapsed() < 40000) {
        child.waitForFinished(50); drain();
    }
    if (child.state() != QProcess::NotRunning) { child.kill(); child.waitForFinished(5000); need(false, "Read-only CLI deadline."); }
    drain();
    need(!overflow && child.exitStatus() == QProcess::NormalExit && errors.isEmpty(), "CLI transport/framing failed.");
    check(!output.isEmpty() && output.endsWith('\n') && output.size() <= cap, "CLI response is incomplete or exceeds cap.");
    QJsonParseError error; const auto parsed = QJsonDocument::fromJson(output, &error);
    need(error.error == QJsonParseError::NoError && parsed.isObject());
    return {parsed.object(), output, child.exitCode()};
}
void keys(const QJsonObject &value, const QSet<QString> &expected) {
    QSet<QString> actual; for (auto it = value.begin(); it != value.end(); ++it) actual.insert(it.key());
    check(actual == expected, "Unexpected private response fields.");
}
void error(const Frame &frame, const QString &code) {
    check(frame.exit == 1 && frame.value == QJsonObject{{"ok", false}, {"code", code}},
          "CLI refusal leaked partial data or wrong bounded code/exit.");
}
void success(const Frame &frame, const Fixture &f, std::size_t count) {
    keys(frame.value, {"ok", "schema", "projectId", "storeUuid", "revision", "targets"});
    check(frame.exit == 0 && frame.value["ok"] == true &&
          frame.value["schema"] == "lmti.project.mapping-observation.v1" &&
          frame.value["projectId"] == s(f.saved.project.id) &&
          frame.value["storeUuid"] == s(f.scope().store_uuid) &&
          frame.value["revision"].toInteger() == f.saved.topology.revision &&
          frame.value["targets"].toArray().size() == static_cast<qsizetype>(count), "CLI success identity/count mismatch.");
    std::pair<QString, QString> previous; bool first = true;
    for (const auto &value : frame.value["targets"].toArray()) {
        const auto row = value.toObject(); keys(row, {"target", "effectiveClassification", "ancestryFingerprint", "referenceFingerprint", "identityState"});
        const auto target = row["target"].toObject(); keys(target, {"projectId", "storeUuid", "kind", "id"});
        const auto key = std::make_pair(target["kind"].toString(), target["id"].toString());
        check(first || previous < key, "Returned targets are not unique raw kind/ID sorted.");
        first = false; previous = key;
        const bool reference = key.first == "repository" || key.first == "knowledge";
        check(target["projectId"] == s(f.saved.project.id) && target["storeUuid"] == s(f.scope().store_uuid) &&
              hex64(row["ancestryFingerprint"].toString().toStdString()) &&
              (reference ? hex64(row["referenceFingerprint"].toString().toStdString()) : row["referenceFingerprint"].isNull()) &&
              row["identityState"] == (reference ? "present_reference" : "active"),
              "Returned target omitted identity/reference proof.");
    }
    check(!frame.raw.contains(f.path.toUtf8()) && !frame.raw.contains("Synthetic") &&
          !frame.raw.contains("src/declared-reference") && !frame.raw.contains("docs/declared-reference"),
          "Observation exported private paths/labels/reference text.");
}

void immutable_gate() {
    Fixture f; const auto before = tree(f.temp.path());
    for (const bool project : {false, true}) {
        auto scope = f.scope(); if (project) scope.project_id = "other-project"; else scope.store_uuid = uuid().toStdString();
        int content = 0; Hook hook([&](Phase p, const QString &) { if (p == Phase::BeforeProjectContent) ++content; });
        refused([&] { read_project_mapping_observation(f.path, scope, all_targets); }, C::ConfigChanged);
        check(content == 0, "Wrong immutable identity reached graph content.");
    }
    check(tree(f.temp.path()) == before, "Identity refusal changed the store.");
    for (const int variant : {0, 1, 2}) {
        auto d = document(); if (variant == 0) d.structure.reset();
        Fixture changed(d); const auto scope = changed.scope();
        { Sql sql(changed.path);
          if (variant == 1) sql.exec("UPDATE project SET id='changed-project'");
          if (variant == 2) sql.exec("UPDATE store_identity SET store_uuid=?", {uuid()});
          sql.exec("UPDATE assets SET kind='invalid-fixture-kind'"); }
        int content = 0; const auto snapshot = tree(changed.temp.path());
        Hook hook([&](Phase p, const QString &) { if (p == Phase::BeforeProjectContent) ++content; });
        refused([&] { read_project_mapping_observation(changed.path, scope, all_targets); },
                variant == 0 ? C::NotSupported : C::ConfigChanged);
        check(content == 0 && tree(changed.temp.path()) == snapshot, "Identity gate followed malformed graph content.");
    }
    { Sql sql(f.path); sql.exec("UPDATE project SET revision=9007199254740990"); }
    const auto maximum = tree(f.temp.path());
    check(f.read().revision == 9007199254740990LL && tree(f.temp.path()) == maximum,
          "Read incorrectly required writable revision headroom.");
}

void namespaces_and_registry(const QString &binary) {
    Fixture f; const auto before = tree(f.temp.path()); const auto result = f.read();
    check(result.targets.size() == 8 && result.project_id == f.saved.project.id &&
          result.store_uuid == f.scope().store_uuid, "Eight independent namespaces were collapsed.");
    for (const auto &target : all_targets) {
        const auto &row = observed(result, target.kind);
        const bool reference = target.kind == K::Repository || target.kind == K::Knowledge;
        check(row.identity_state == (reference ? MappingObservationIdentityState::PresentReference :
              MappingObservationIdentityState::Active) && row.reference_fingerprint.has_value() == reference,
              "References were given invented registry state.");
    }
    success(process(binary, arguments(f), json(request(all_targets))), f, 8);
    check(tree(f.temp.path()) == before, "Successful typed/CLI reads wrote native artifacts.");
    f.change([](auto &d) {
        d.components.clear(); d.repositories.clear(); d.knowledge.clear(); d.topology.assets.clear();
        d.structure = ProjectStructure{};
    });
    const auto retired = tree(f.temp.path()); QByteArray refusal;
    for (const auto &target : all_targets) {
        refused([&] { f.read({target}); }, C::NativeUnavailable);
        const auto frame = process(binary, arguments(f), json(request({target})));
        error(frame, "NATIVE_UNAVAILABLE");
        if (refusal.isEmpty()) refusal = frame.raw; else check(frame.raw == refusal, "Retired/reference absence leaked target kind.");
    }
    error(process(binary, arguments(f), json(request({{K::Component, "unknown"}}))), "NATIVE_UNAVAILABLE");
    check(tree(f.temp.path()) == retired, "Absence checks changed registry tombstones.");
    for (const auto &statement : {
            "DELETE FROM identity_registry WHERE kind='component' AND entity_id='shared'",
            "INSERT INTO identity_registry VALUES('component','ghost','active')",
            "UPDATE identity_registry SET state='retired' WHERE kind='component' AND entity_id='shared'"}) {
        Fixture bad; { Sql sql(bad.path); sql.exec(QString::fromLatin1(statement)); }
        const auto baseline = tree(bad.temp.path());
        refused([&] { bad.read({{K::Site, "shared"}}); }, C::OwnerUnavailable);
        refused([&] { bad.read({}); }, C::OwnerUnavailable);
        check(tree(bad.temp.path()) == baseline, "Malformed full registry was repaired or partially trusted.");
    }
    { Fixture bad; { Sql sql(bad.path); sql.exec("PRAGMA ignore_check_constraints=ON");
                    sql.exec("UPDATE identity_registry SET state='invalid' WHERE kind='component' AND entity_id='shared'"); }
      const auto baseline = tree(bad.temp.path()); refused([&] { bad.read({}); }, C::OwnerUnavailable);
      check(tree(bad.temp.path()) == baseline, "Invalid registry state was normalized."); }
}

void privacy_and_scope(const QString &binary) {
    for (const int variant : {0, 1, 2, 3, 4, 5, 6}) {
        Fixture f;
        f.change([&](auto &d) {
            if (variant == 0) d.project.privacy = P::Internal;
            if (variant == 1) d.repositories[0].privacy = P::Internal;
            if (variant == 2) find(d.structure->subsystems, "root").privacy = P::Internal;
            if (variant == 3) find(d.structure->sites, "shared").privacy = P::Internal;
            if (variant == 4) find(d.structure->areas, "parent-area").privacy = P::Internal;
            if (variant == 5) find(d.topology.assets, "parent-asset").privacy = P::Internal;
            if (variant == 6) find(d.structure->environments, "shared").privacy = P::Internal;
        });
        const K target = variant < 3 ? K::Knowledge : K::Asset;
        const auto baseline = tree(f.temp.path());
        refused([&] { f.read({{target, "shared"}}, false); }, C::NativeUnavailable);
        check(observed(f.read({{target, "shared"}}), target).effective_classification == P::Internal,
              "Local read downgraded inherited Internal classification.");
        if (variant == 0) {
            int content = 0; Hook hook([&](Phase p, const QString &) { if (p == Phase::BeforeProjectContent) ++content; });
            refused([&] { f.read({}, false); }, C::NativeUnavailable);
            check(content == 0, "Empty external request bypassed project privacy gate.");
        } else if (variant < 3) refused([&] { f.read({{K::Component, "shared"}}, false); }, C::NativeUnavailable);
        else check(f.read({{K::Component, "shared"}}, false).targets.size() == 1,
                   "Unrelated hidden physical row denied project-wide component.");
        check(tree(f.temp.path()) == baseline, "Privacy read changed native state.");
    }
    Fixture f;
    auto scope = f.scope(false); scope.site_id = "absent-site"; scope.environment_id = "unused-env";
    const auto wide = read_project_mapping_observation(f.path, scope,
        {{K::Component, "shared"}, {K::Repository, "shared"}, {K::Knowledge, "shared"}, {K::Environment, "unused-env"}});
    check(wide.targets.size() == 4, "Unrelated site suppressed project-wide/unused environment observation.");
    check(f.read({{K::Asset, "shared"}}, false).targets.size() == 1,
          "Unknown role denied explicit matching environment.");
    const auto unknown = process(binary, arguments(f, false), json(request({{K::Asset, "unknown"}})));
    error(unknown, "NATIVE_UNAVAILABLE");
    for (const auto &id : {"unplaced", "empty-placement", "other-asset"})
        check(process(binary, arguments(f, false), json(request({{K::Asset, id}}))).raw == unknown.raw,
              "Unknown/unplaced/empty-environment/other-site refusal differs.");
    auto other_env = f.scope(); other_env.environment_id = "other-env";
    refused([&] { read_project_mapping_observation(f.path, other_env, {{K::Asset, "shared"}}); }, C::NativeUnavailable);
    for (const std::size_t position : {0U, 1U, 2U}) {
        std::vector<Target> selected{{K::Component, "shared"}, {K::Knowledge, "shared"}};
        selected.insert(selected.begin() + static_cast<std::ptrdiff_t>(position), {K::Asset, "unknown"});
        check(process(binary, arguments(f), json(request(selected))).raw == unknown.raw, "Mixed batch leaked a partial subset/position.");
    }
    f.change([](auto &d) { d.repositories[0].privacy = P::Internal; });
    check(process(binary, arguments(f, false), json(request({{K::Knowledge, "shared"}}))).raw == unknown.raw,
          "Hidden reference refusal differs from unknown target.");
    Fixture empty([] { auto d = document(); d.topology.assets.clear(); d.structure = ProjectStructure{}; return d; }());
    check(empty.read({{K::Component, "shared"}, {K::Repository, "shared"}, {K::Knowledge, "shared"}}, false).targets.size() == 3,
          "Declared empty schema2 catalogs suppressed independent references.");
}

std::string ancestry(const Fixture &f, K kind, QJsonArray rows) {
    // Independent fixed positional vector, no production fingerprint helper.
    const QJsonArray frame{s(f.saved.project.id), s(f.scope().store_uuid), "public", "shared", "shared", "local",
                           s(name(kind)), "shared", true, rows};
    return digest("lmti.project.mapping.ancestry.v1\n" + QJsonDocument(frame).toJson(QJsonDocument::Compact)).toStdString();
}
QString reference(const ProjectDocument &d, bool knowledge) {
    return QString::fromLatin1(knowledge ?
        digest(json({{"reference", s(d.knowledge[0].reference)}, {"fingerprint", s(d.knowledge[0].fingerprint)}})) :
        digest(QByteArray::fromStdString(d.repositories[0].locator)));
}
void exact_fingerprints() {
    Fixture f; const auto read = f.read();
    const auto repo = reference(f.saved, false), knowledge = reference(f.saved, true);
    const QJsonValue nil(QJsonValue::Null);
    const QJsonArray logical{
        QJsonArray{"component", "shared", "public", "shared", "shared"},
        QJsonArray{"knowledge", "shared", "public", "shared", knowledge},
        QJsonArray{"repository", "shared", "public", repo},
        QJsonArray{"subsystem", "root", "public", nil},
        QJsonArray{"subsystem", "shared", "public", "root"}};
    const QJsonArray physical{
        QJsonArray{"area", "parent-area", "public", "shared", nil},
        QJsonArray{"area", "shared", "public", "shared", "parent-area"},
        QJsonArray{"asset", "parent-asset", "public", "shared", QJsonArray{"shared", nil, "shared", "host"}},
        QJsonArray{"asset", "shared", "public", "shared", QJsonArray{"shared", "parent-asset", "shared", nil}},
        QJsonArray{"environment", "shared", "public"}, QJsonArray{"site", "shared", "public"}};
    check(observed(read, K::Knowledge).ancestry_fingerprint == ancestry(f, K::Knowledge, logical) &&
          observed(read, K::Asset).ancestry_fingerprint == ancestry(f, K::Asset, physical),
          "Exact independently framed ancestry differs.");
    const auto snapshot = project_structure_snapshot(f.path, {f.saved.project.id, "shared", false});
    check(snapshot["repositories"].toArray()[0].toObject()["locatorFingerprint"] == repo &&
          snapshot["knowledge"].toArray()[0].toObject()["referenceFingerprint"] == knowledge &&
          observed(read, K::Repository).reference_fingerprint == repo.toStdString() &&
          observed(read, K::Knowledge).reference_fingerprint == knowledge.toStdString(),
          "Mapping reference hashes broke v3 compatibility.");
    f.change([](auto &d) { d.project.label = "Cosmetic project"; find(d.structure->subsystems, "root").label = "Cosmetic";
                           find(d.structure->environments, "unused-env").label = "Unrelated"; });
    check(f.read().targets == read.targets && f.saved.topology.revision > read.revision,
          "Cosmetic/unrelated fields entered target fingerprints.");
    for (const int variant : {0, 1, 2, 3, 4, 5}) {
        Fixture changed; const auto old = changed.read();
        changed.change([&](auto &d) {
            if (variant == 0) d.structure->component_memberships[0].subsystem_id = "other-subsystem";
            if (variant == 1) find(d.structure->subsystems, "shared").parent_subsystem_id.clear();
            if (variant == 2) d.repositories[0].locator = "src/changed-reference";
            if (variant == 3) d.knowledge[0].reference = QString::fromUtf8("docs/測試-\xF0\x9F\x98\x80").toStdString();
            if (variant == 4) find(d.structure->areas, "shared").parent_area_id.clear();
            if (variant == 5) for (auto &p : d.structure->asset_placements) if (p.asset_id == "shared") p.parent_asset_id.clear();
        });
        const auto current = changed.read(); const auto kind = variant < 4 ? K::Knowledge : K::Asset;
        check(observed(old, kind).ancestry_fingerprint != observed(current, kind).ancestry_fingerprint,
              "Applicable native ancestry/reference drift was not fingerprinted.");
        const auto unrelated = variant < 4 ? K::Asset : K::Knowledge;
        check(observed(old, unrelated).ancestry_fingerprint == observed(current, unrelated).ancestry_fingerprint,
              "Unrelated target drift contaminated ancestry.");
    }
}

QString local_key(QString path) {
    path = QDir::cleanPath(QDir::fromNativeSeparators(path));
#ifdef Q_OS_WIN
    path = path.toCaseFolded();
#endif
    return path;
}
void ordinary_root(const QString &path) {
    const QFileInfo info(path);
    need(info.isAbsolute() && info.isDir() && !info.isSymLink() && !info.isJunction() &&
         !info.canonicalFilePath().isEmpty() && local_key(info.canonicalFilePath()) == local_key(path));
}
void contained_path(const QString &root, const QString &path) {
    ordinary_root(root);
    need(QFileInfo(path).isAbsolute() && local_key(path).startsWith(local_key(root) + "/") &&
         QDir::fromNativeSeparators(path) == QDir::cleanPath(QDir::fromNativeSeparators(path)));
    auto current = QFileInfo(path).dir().absolutePath();
    while (local_key(current) != local_key(root)) {
        need(local_key(current).startsWith(local_key(root) + "/")); ordinary_root(current);
        const auto next = QFileInfo(current).dir().absolutePath(); need(next != current); current = next;
    }
}
void ordinary_file(const QString &root, const QString &path) {
    contained_path(root, path); const QFileInfo info(path);
    need(info.isFile() && !info.isSymLink() && !info.isJunction() &&
         local_key(info.canonicalFilePath()) == local_key(path));
}
void new_leaf(const QString &root, const QString &path) {
    contained_path(root, path); const QFileInfo info(path);
    need(!info.exists() && !info.isSymLink() && !info.isJunction());
}
bool move_local(const QString &root, const QString &source, const QString &destination) {
    contained_path(root, source); new_leaf(root, destination);
    const QFileInfo info(source);
    need((info.isFile() || info.isDir()) && !info.isSymLink() && !info.isJunction() &&
         local_key(info.canonicalFilePath()) == local_key(source));
#ifdef Q_OS_WIN
    return MoveFileW(reinterpret_cast<LPCWSTR>(source.utf16()), reinterpret_cast<LPCWSTR>(destination.utf16())) != 0;
#else
    return QFile::rename(source, destination);
#endif
}
int leave_wal(const QString &root) {
    ordinary_root(root); ordinary_root(QDir::tempPath());
    const QFileInfo info(root);
    need(local_key(info.canonicalFilePath()).startsWith(local_key(QFileInfo(QDir::tempPath()).canonicalFilePath()) + "/") &&
         info.fileName().startsWith("lmti-mapping-observation-") &&
         info.fileName().size() == QString("lmti-mapping-observation-").size() + 6);
    const auto marker = at(root, "mapping-fixture.marker");
    ordinary_file(root, marker); need(bytes(marker) == "lmti.mapping.observation.fixture.v1\n");
    const auto path = at(at(root, "stores"), QString::fromUtf8("project-測試.sqlite"));
    ordinary_file(root, path);
    Sql writer(path); writer.exec("PRAGMA journal_mode=WAL"); writer.exec("PRAGMA wal_autocheckpoint=0");
    writer.exec("BEGIN IMMEDIATE");
    writer.exec("UPDATE project SET revision=2");
    writer.exec("UPDATE environments SET privacy='internal' WHERE id='shared'");
    writer.exec("COMMIT");
    // Test-only fixed action: actual committed WAL survives without a live
    // keeper or SQLite close/checkpoint. No caller-controlled SQL or filename.
    std::_Exit(0);
}
void make_wal(const Fixture &f) {
    QProcess child; child.setProgram(QCoreApplication::applicationFilePath());
    child.setArguments({"--leave-mapping-wal", f.temp.path()}); child.start();
    need(child.waitForStarted(5000));
    if (!child.waitForFinished(15000)) { child.kill(); child.waitForFinished(5000); need(false); }
    need(child.exitStatus() == QProcess::NormalExit && child.exitCode() == 0 &&
         child.readAllStandardOutput().isEmpty() && child.readAllStandardError().isEmpty());
    need(QFileInfo(f.path + "-wal").size() > 32 && QFileInfo(f.path + "-shm").size() > 0);
}
void wal_and_snapshot() {
    {
        Fixture f; make_wal(f); const auto baseline = tree(f.temp.path());
        const auto actual = f.read();
        check(actual.revision == 2 && observed(actual, K::Asset).effective_classification == P::Internal &&
              tree(f.temp.path()) == baseline, "Reader missed WAL commit or checkpointed/changed native files.");
        const auto moved = f.path + "-shm-retained";
        need(move_local(f.temp.path(), f.path + "-shm", moved));
        const auto missing = tree(f.temp.path());
        refused([&] { f.read(); }, C::OwnerUnavailable);
        check(tree(f.temp.path()) == missing, "Missing SHM was recreated or WAL was repaired.");
    }
    {
        Fixture f; Sql writer(f.path);
        writer.exec("PRAGMA journal_mode=WAL"); writer.exec("PRAGMA wal_autocheckpoint=0");
        writer.exec("UPDATE project SET label='WAL fixture'");
        need(QFileInfo(f.path + "-wal").size() > 32 && QFileInfo(f.path + "-shm").size() > 0);
        const auto old = f.read(); const auto new_uuid = uuid(); int contents = 0, final = 0;
        {
            Hook hook([&](Phase p, const QString &path) {
                check(path == f.path, "Owner hook substituted a database locator.");
                if (p == Phase::BeforeProjectContent) {
                    ++contents; writer.exec("BEGIN IMMEDIATE");
                    writer.exec("UPDATE store_identity SET store_uuid=?", {new_uuid});
                    writer.exec("UPDATE component_memberships SET subsystem_id='other-subsystem'");
                    writer.exec("UPDATE project SET revision=2"); writer.exec("COMMIT");
                }
                if (p == Phase::BeforeFinalVerification) ++final;
            });
            check(f.read() == old, "Immutable identity and graph/registry did not share a single read snapshot.");
        }
        check(contents == 1 && final == 1, "WAL snapshot test did not exercise both phases.");
        refused([&] { f.read(); }, C::ConfigChanged);
        auto current = f.scope(); current.store_uuid = new_uuid.toStdString();
        const auto fresh = read_project_mapping_observation(f.path, current, all_targets);
        check(fresh.revision == 2 && fresh.store_uuid == current.store_uuid &&
              observed(fresh, K::Knowledge).ancestry_fingerprint != observed(old, K::Knowledge).ancestry_fingerprint,
              "Fresh invocation did not see the later committed snapshot.");
    }
    for (const auto &suffix : {QString("-journal"), QString("-wal"), QString("-shm")}) {
        Fixture f; put(f.path + suffix, "unusable sidecar");
        const auto baseline = tree(f.temp.path()); refused([&] { f.read(); }, C::OwnerUnavailable);
        check(tree(f.temp.path()) == baseline, "Unsafe sidecar refusal changed data.");
    }
    {
        Fixture f;
        Hook hook([&](Phase p, const QString &) { if (p == Phase::BeforeFinalVerification) put(f.path + "-journal", {}); });
        refused([&] { f.read(); }, C::ConfigChanged);
    }
}
bool hardlink(const QString &root, const QString &alias, const QString &target) {
    new_leaf(root, alias); ordinary_file(root, target);
#ifdef Q_OS_WIN
    return CreateHardLinkW(reinterpret_cast<LPCWSTR>(alias.utf16()), reinterpret_cast<LPCWSTR>(target.utf16()), nullptr) != 0;
#else
    return false;
#endif
}
bool symlink(const QString &root, const QString &alias, const QString &target) {
    new_leaf(root, alias); ordinary_file(root, target);
#ifdef Q_OS_WIN
    if (CreateSymbolicLinkW(reinterpret_cast<LPCWSTR>(alias.utf16()), reinterpret_cast<LPCWSTR>(target.utf16()), 2)) return true;
    if (GetLastError() == ERROR_INVALID_PARAMETER)
        return CreateSymbolicLinkW(reinterpret_cast<LPCWSTR>(alias.utf16()), reinterpret_cast<LPCWSTR>(target.utf16()), 0) != 0;
#endif
    return false;
}
bool junction(const QString &root, const QString &alias, const QString &target) {
    new_leaf(root, alias); contained_path(root, target); ordinary_root(target);
#ifdef Q_OS_WIN
    if (!QDir().mkdir(alias)) return false;
    const auto handle = CreateFileW(reinterpret_cast<LPCWSTR>(alias.utf16()), GENERIC_WRITE, 0, nullptr,
        OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    if (handle == INVALID_HANDLE_VALUE) { QDir().rmdir(alias); return false; }
    struct Buffer { DWORD tag; WORD length, reserved, sub_offset, sub_length, print_offset, print_length; wchar_t names[2048]; } data{};
    const auto print = QDir::toNativeSeparators(target), sub = QString("\\??\\") + print;
    need(sub.size() + print.size() + 2 < 2048);
    data.tag = IO_REPARSE_TAG_MOUNT_POINT; data.sub_length = WORD(sub.size() * sizeof(wchar_t));
    data.print_offset = WORD(data.sub_length + sizeof(wchar_t)); data.print_length = WORD(print.size() * sizeof(wchar_t));
    std::memcpy(data.names, sub.utf16(), data.sub_length);
    std::memcpy(reinterpret_cast<char *>(data.names) + data.print_offset, print.utf16(), data.print_length);
    data.length = WORD(8 + data.print_offset + data.print_length + sizeof(wchar_t)); DWORD returned = 0;
    const auto ok = DeviceIoControl(handle, FSCTL_SET_REPARSE_POINT, &data, DWORD(data.length + 8), nullptr, 0, &returned, nullptr);
    CloseHandle(handle); if (!ok) QDir().rmdir(alias); return ok != 0;
#else
    return false;
#endif
}
void skip(const char *reason) { ++skips; std::cout << "SKIP: " << reason << '\n'; }
void namespace_and_release() {
    for (const bool fail : {false, true}) {
        Fixture f; const auto baseline = tree(f.temp.path()); int reached = 0;
        {
            Hook hook([&](Phase p, const QString &) {
                if (p != Phase::AfterLeasesAcquired) return; ++reached;
                check(!move_local(f.temp.path(), f.path, f.path + "-held") &&
                      !move_local(f.temp.path(), f.directory, f.directory + "-held"),
                      "File/ancestor rename succeeded while leased.");
                if (fail) throw Error("Controlled fixture interruption.");
            });
            if (fail) refused([&] { f.read(); }, C::OwnerUnavailable); else f.read();
        }
        check(reached == 1, "Lease fixture missed held phase.");
        for (const auto &path : {f.path, f.directory}) {
            need(move_local(f.temp.path(), path, path + "-released"));
            need(move_local(f.temp.path(), path + "-released", path));
        }
        check(tree(f.temp.path()) == baseline, "Lease failure leaked handles or modified files.");
    }
    {
        Fixture f; const auto old = f.scope(); const auto saved = f.path + "-original";
        need(move_local(f.temp.path(), f.path, saved));
        auto d = document(); d.topology.revision = save_project(f.path, d);
        need(load_project(f.path).storage_lineage->store_uuid != old.store_uuid);
        int content = 0; const auto baseline = tree(f.temp.path());
        Hook hook([&](Phase p, const QString &) { if (p == Phase::BeforeProjectContent) ++content; });
        refused([&] { read_project_mapping_observation(f.path, old, all_targets); }, C::ConfigChanged);
        check(content == 0 && tree(f.temp.path()) == baseline, "Same-path new UUID replacement reached content.");
    }
    {
        Fixture f; const auto alias = at(f.temp.path(), "main-alias");
        if (hardlink(f.temp.path(), alias, f.path)) {
            const auto baseline = tree(f.temp.path()); refused([&] { f.read(); }, C::OwnerUnavailable);
            check(tree(f.temp.path()) == baseline, "Hardlink refusal changed files.");
        } else skip("local main-file hardlink creation unavailable/denied.");
    }
    {
        Fixture f; const auto retained = f.path + "-retained";
        need(move_local(f.temp.path(), f.path, retained));
        if (symlink(f.temp.path(), f.path, retained)) {
            const auto baseline = tree(f.temp.path()); refused([&] { f.read(); }, C::OwnerUnavailable);
            check(tree(f.temp.path()) == baseline, "File symlink was followed/changed.");
        } else skip("local mapping file symlink creation unavailable/denied.");
    }
    {
        Fixture f; const auto retained = f.directory + "-retained";
        need(move_local(f.temp.path(), f.directory, retained));
        if (junction(f.temp.path(), f.directory, retained)) {
            const auto baseline = tree(f.temp.path()); refused([&] { f.read(); }, C::OwnerUnavailable);
            check(tree(f.temp.path()) == baseline, "Directory junction was followed/changed.");
            need(QDir().rmdir(f.directory)); // Remove only this fixed junction, never its target.
        } else skip("local mapping ancestor junction creation unavailable/denied.");
    }
    {
        Fixture f; const auto target = at(f.temp.path(), "sidecar-target"); need(QDir().mkdir(target));
        if (junction(f.temp.path(), f.path + "-shm", target)) {
            const auto baseline = tree(f.temp.path()); refused([&] { f.read(); }, C::OwnerUnavailable);
            check(tree(f.temp.path()) == baseline, "Sidecar junction was followed/changed.");
            need(QDir().rmdir(f.path + "-shm"));
        } else skip("local mapping sidecar junction creation unavailable/denied.");
    }
}

void strict_boundary(const QString &binary) {
    Fixture f; const auto baseline = tree(f.temp.path());
    const auto valid = json(request({{K::Component, "shared"}}));
    success(process(binary, arguments(f), valid), f, 1);
    const std::vector<QByteArray> malformed{
        "[]", "{}", "{\"targets\":null}", "{\"targets\":[],\"targets\":[]}",
        "{\"targets\":[],\"\\u0074argets\":[]}", "{\"targets\":[],\"path\":\"other.sqlite\"}",
        "{\"targets\":[{\"kind\":\"component\",\"id\":\"shared\",\"id\":\"shared\"}]}",
        "{\"targets\":[{\"kind\":\"component\",\"id\":\"shared\",\"scope\":\"local\"}]}",
        "{\"targets\":[{\"kind\":\"component\",\"id\":null}]}",
        "{\"targets\":[{\"kind\":\"component\",\"id\":1}]}",
        "{\"targets\":[{\"kind\":\"component\",\"id\":\"shared\"},{\"kind\":\"component\",\"id\":\"shared\"}]}",
        "{\"targets\":[{\"kind\":\"unsupported\",\"id\":\"shared\"}]}",
        "{\"targets\":[{\"kind\":\"component\",\"id\":\"a\\ud800\"}]}",
        "{\"targets\":[{\"kind\":\"component\",\"id\":\"a\\udc00\"}]}",
        "{\"targets\":[{\"kind\":\"component\",\"id\":\"a\\udc00\\ud800\"}]}",
        "{\"targets\":[{\"kind\":\"component\",\"id\":\"a\\ud83d\\ude00\"}]}",
        valid + QByteArray(1, '\0'), valid + QByteArray(1, '\x1a') + "garbage",
        QByteArray("{\"targets\":[{\"kind\":\"component\",\"id\":\"a") + QByteArray::fromHex("ff") + "\"}]}",
        "{\"targets\":[{\"kind\":\"component\",\"id\":\"a\\n\"}]}"};
    for (const auto &payload : malformed) error(process(binary, arguments(f), payload), "INVALID_INPUT");
    // Supplementary pair is scalar-valid but never a native ASCII ID. The
    // shared parser's direct suite proves scalar acceptance independently.
    for (const int variant : {0, 1, 2, 3, 4, 5, 6}) {
        auto args = arguments(f);
        if (variant == 0) args.append("extra");
        if (variant == 1) args.removeLast();
        if (variant == 2) args[3] += "\n";
        if (variant == 3) args[3] = "00000000-0000-0000-0000-000000000000";
        if (variant == 4) args[6] = "internal";
        if (variant == 5) args[1] = "\\\\server\\share\\mapping.sqlite";
        if (variant == 6) args[4] = QString(65, 'a');
        error(process(binary, args, valid), "INVALID_INPUT");
    }
    const auto missing = at(f.directory, "does-not-exist.sqlite");
    auto args = arguments(f); args[1] = missing;
    error(process(binary, args, valid), "OWNER_UNAVAILABLE");
    check(!QFileInfo::exists(missing) && tree(f.temp.path()) == baseline, "Malformed/missing requests changed files.");
    int phases = 0;
    Hook hook([&](Phase, const QString &) { ++phases; });
    auto scope = f.scope(); scope.store_uuid += "\n";
    refused([&] { read_project_mapping_observation(missing, scope, all_targets); }, C::InvalidInput);
    auto invalid = all_targets; invalid[0].kind = static_cast<K>(999);
    refused([&] { read_project_mapping_observation(missing, f.scope(), invalid); }, C::InvalidInput);
    refused([&] { read_project_mapping_observation(missing, f.scope(), {{K::Component, "shared"}, {K::Component, "shared"}}); }, C::InvalidInput);
    check(phases == 0 && !QFileInfo::exists(missing), "Pure refusal probed/created missing storage.");
}
ProjectDocument bulk_document() {
    ProjectDocument d; d.project = {"mapping-project", "Bounded bulk fixture", "", P::Public}; d.structure.emplace();
    d.structure->sites = {{"shared", "Site", P::Public}}; d.structure->environments = {{"shared", "Environment", P::Public}};
    for (int i = 0; i < 2000; ++i) {
        const auto id = (QString("r%1").arg(i, 4, 10, QLatin1Char('0')) + QString(59, 'x')).toStdString();
        need(id.size() == 64);
        d.components.push_back({id, "Component", "", ComponentKind::Library, P::Public});
        d.topology.assets.push_back(asset(id));
        d.structure->asset_placements.push_back({id, "", "", "shared", std::nullopt});
    }
    validate(d); return d;
}
void bounds_depth_and_no_writes(const QString &binary) {
    Fixture f(bulk_document()); std::vector<Target> targets;
    for (const auto &r : f.saved.components) targets.push_back({K::Component, r.id});
    for (const auto &r : f.saved.topology.assets) targets.push_back({K::Asset, r.id});
    std::reverse(targets.begin(), targets.end());
    const auto baseline = tree(f.temp.path()); const auto all = f.read(targets);
    check(all.targets.size() == 4000, "Valid exact 4000 request was truncated.");
    const auto frame = process(binary, arguments(f), json(request(targets))); success(frame, f, 4000);
    std::cout << "BOUND: 4000 legal 64-byte-ID targets, complete response " << frame.raw.size() << " bytes (cap " << cap << ")\n";
    std::set<std::pair<std::string, std::string>> returned;
    for (const auto &r : frame.value["targets"].toArray()) {
        const auto t = r.toObject()["target"].toObject();
        returned.emplace(t["kind"].toString().toStdString(), t["id"].toString().toStdString());
    }
    for (const auto &t : targets) check(returned.contains({name(t.kind), t.id}), "Full batch omitted a requested target.");
    targets.push_back({K::Environment, "shared"});
    int opens = 0;
    { Hook hook([&](Phase, const QString &) { ++opens; });
      refused([&] { read_project_mapping_observation(f.path, f.scope(), targets); }, C::BudgetExceeded); }
    check(opens == 0, "4001 target refusal opened native state.");
    error(process(binary, arguments(f), json(request(targets))), "BUDGET_EXCEEDED");
    auto too_long = json(request({{K::Component, std::string(65, 'a')}}));
    error(process(binary, arguments(f), too_long), "INVALID_INPUT");
    QByteArray padded = "{\"targets\":[]}"; padded.append(QByteArray(cap - padded.size(), ' '));
    need(padded.size() == cap);
    success(process(binary, arguments(f), padded), f, 0);
    padded.append(' '); error(process(binary, arguments(f), padded), "BUDGET_EXCEEDED");
    check(tree(f.temp.path()) == baseline, "Large/over-budget reads changed native bytes or created artifacts.");

    // Independent legal maxima: 31 Subsystems + Component, 32 Areas alone,
    // and 16 Areas + 16 Assets. The leaf counts toward depth32.
    auto deep = document(); auto &v = *deep.structure;
    v.subsystems.clear(); v.component_memberships.clear(); v.areas.clear(); v.asset_placements.clear(); deep.topology.assets.clear();
    for (int i = 0; i < 32; ++i) {
        const auto id = QString("depth%1").arg(i, 2, 10, QLatin1Char('0')).toStdString();
        const auto parent = i ? QString("depth%1").arg(i - 1, 2, 10, QLatin1Char('0')).toStdString() : std::string{};
        v.areas.push_back({id, "Depth area", "shared", parent, P::Public});
        if (i < 31) v.subsystems.push_back({id, "Depth subsystem", parent, P::Public});
        if (i < 16) {
            deep.topology.assets.push_back(asset(id));
            v.asset_placements.push_back({id, "depth15", parent, "shared", std::nullopt});
        }
    }
    v.component_memberships = {{"shared", "depth30"}}; validate(deep);
    Fixture depth(deep); const auto before = tree(depth.temp.path());
    const auto exact = depth.read({{K::Component, "shared"}, {K::Area, "depth31"}, {K::Asset, "depth15"}}, false);
    check(exact.targets.size() == 3 && tree(depth.temp.path()) == before, "Legal depth32 logical/area/asset paths were lost.");
    { Sql sql(depth.path); sql.exec("UPDATE areas SET parent_area_id='depth31' WHERE id='depth00'"); }
    const auto corrupt = tree(depth.temp.path()); refused([&] { depth.read({{K::Component, "shared"}}); }, C::OwnerUnavailable);
    check(tree(depth.temp.path()) == corrupt, "Malformed unrelated full graph was ignored/repaired.");
}

// Schema3 uses the same fixed scope/projection, reached only through an explicit
// upgraded format and sibling command. Fixture authority never comes from JSON.
OriginalPhysicalTarget schema3_physical(const QString &path) {
    OriginalPhysicalTarget result; result.path = QDir::cleanPath(path);
    QStringList parts;
    for (auto cursor = result.path;;) {
        parts.prepend(cursor); const auto parent = QFileInfo(cursor).dir().absolutePath();
        if (parent == cursor) break;
        cursor = parent;
    }
#ifdef Q_OS_WIN
    for (qsizetype i = 0; i < parts.size(); ++i) {
        const bool directory = i + 1 < parts.size();
        const auto h = CreateFileW(reinterpret_cast<LPCWSTR>(parts[i].utf16()), FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr);
        need(h != INVALID_HANDLE_VALUE);
        BY_HANDLE_FILE_INFORMATION info{};
        const auto ok = GetFileInformationByHandle(h, &info), closed = CloseHandle(h);
        need(ok && closed && !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
             bool(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == directory && (directory || info.nNumberOfLinks == 1));
        const auto ticks = (quint64(info.ftCreationTime.dwHighDateTime) << 32) | info.ftCreationTime.dwLowDateTime;
        need(ticks > 116444736000000000ULL);
        result.chain.push_back({QString::number(info.dwVolumeSerialNumber),
            QString::number((quint64(info.nFileIndexHigh) << 32) | info.nFileIndexLow),
            QString::number(ticks - 116444736000000000ULL) + "00"});
    }
#endif
    return result;
}
DesiredAssetOriginalExpected upgrade_schema3(Fixture &f) {
    const auto backup = at(f.temp.path(), "schema3-backups");
    need(QDir(f.temp.path()).mkdir("schema3-backups"));
    DesiredAssetOriginalExpected original{2, f.scope().store_uuid, schema3_physical(f.path)};
    const ProjectFormatMaintenanceScope scope{f.saved.project.id, f.scope().store_uuid,
        "schema3-fixture-operator", std::string(64, 'a'), true};
    const auto preview = preview_project_receipt_upgrade(f.path, backup, scope, original);
    const auto committed = commit_project_receipt_upgrade(f.path, backup, scope, preview);
    need(committed.state == ProjectReceiptUpgradeState::Confirmed && committed.format.has_value());
    f.saved = load_project(f.path); original.schema = 3;
    need(f.saved.storage_lineage && f.saved.storage_lineage->schema_version == 3);
    return original;
}
ProjectMappingObservation read3(const Fixture &f, const std::vector<Target> &targets = all_targets, bool internal = true) {
    return read_project_mapping_observation_v2(f.path, f.scope(internal), targets);
}
QStringList arguments3(const Fixture &f, bool internal = true) {
    auto args = arguments(f, internal); args[0] = "mapping-observation-v2"; return args;
}
void success3(const Frame &frame, const Fixture &f, std::size_t count) {
    keys(frame.value, {"ok", "schema", "storageSchema", "projectId", "storeUuid", "revision", "targets"});
    check(frame.value["schema"] == "lmti.project.mapping-observation.v2" && frame.value["storageSchema"] == 3,
          "Schema3 wire did not report its actual fixed storage format.");
    // Reuse all existing field/identity/ordering/privacy assertions after the
    // independently checked two version fields; the real frame is untouched.
    auto old_shape = frame; old_shape.value.remove("storageSchema");
    old_shape.value["schema"] = "lmti.project.mapping-observation.v1";
    success(old_shape, f, count);
}
DesiredAssetReceipt desired_schema3(Fixture &f, const DesiredAssetOriginalExpected &original) {
    const DesiredAssetScope scope{f.saved.project.id, f.scope().store_uuid, "schema3-fixture-operator",
        std::string(64, 'b'), "shared", "shared", true, true};
    const auto state = inspect_desired_asset(f.path, scope, original, "shared");
    const DesiredAssetProposal proposal{"shared", state.revision, state.values,
        {!state.values.enabled, 1250}, std::string(64, 'c')};
    const auto review = preview_desired_asset(f.path, scope, original, proposal);
    const auto committed = commit_desired_asset(f.path, scope, original, review);
    need(committed.state == DesiredAssetCommitState::Confirmed && committed.receipt.has_value());
    f.saved = load_project(f.path); return *committed.receipt;
}
void schema3_versioned_projection(const QString &binary) {
    Fixture f; const auto original = f.read();
    check(original.storage_schema == 2, "Old typed result lost actual schema2.");
    const auto old_frame = process(binary, arguments(f), json(request(all_targets))); success(old_frame, f, 8);
    refused([&] { read3(f); }, C::NotSupported);
    error(process(binary, arguments3(f), json(request(all_targets))), "NOT_SUPPORTED");
    const auto pin = upgrade_schema3(f); const auto stable = tree(f.temp.path());
    const auto upgraded = read3(f, all_targets, false);
    check(upgraded.storage_schema == 3 && upgraded.project_id == original.project_id &&
          upgraded.store_uuid == original.store_uuid && upgraded.revision == original.revision,
          "Upgrade observation lost original UUID/revision or fabricated schema.");
    // Visibility is a fingerprint input, so compare local with the old local
    // result, and independently exercise authorized external projection above.
    check(read3(f).targets == original.targets && upgraded.targets.size() == 8,
          "Format-only upgrade changed exact ancestry/reference/identity projection.");
    const auto frame = process(binary, arguments3(f), json(request(all_targets))); success3(frame, f, 8);
    auto expected = old_frame.value; expected["schema"] = "lmti.project.mapping-observation.v2";
    expected["storageSchema"] = 3;
    check(frame.value == expected, "Schema3 frame changed data beyond its explicit version fields.");
    refused([&] { f.read(); }, C::NotSupported);
    error(process(binary, arguments(f), json(request(all_targets))), "NOT_SUPPORTED");
    check(tree(f.temp.path()) == stable, "Version selection or read mutated schema3/backup files.");
    const auto receipt = desired_schema3(f, pin); const auto committed = tree(f.temp.path());
    const auto fresh = read3(f);
    check(fresh.storage_schema == 3 && fresh.revision == original.revision + 1 && fresh.targets == original.targets,
          "Desired edit did not expose a fresh revision while retaining structural identity hashes.");
    check(!find(f.saved.topology.assets, "shared").enabled && find(f.saved.topology.assets, "shared").poll_ms == 1250,
          "Actual owner did not persist the reviewed two-field desired edit.");
    const auto after = process(binary, arguments3(f), json(request(all_targets))); success3(after, f, 8);
    check(!after.raw.contains("proposal_format") && !after.raw.contains("desired_asset_receipts") &&
          !after.raw.contains("principalId") && !after.raw.contains("requestDigest") &&
          !after.raw.contains(s(receipt.operation_id).toUtf8()) && !after.raw.contains(s(receipt.receipt_digest).toUtf8()) &&
          tree(f.temp.path()) == committed, "Graph observation disclosed/mutated native receipt history.");
    { Sql sql(f.path); sql.exec("UPDATE project SET revision=9007199254740990"); }
    check(read3(f).revision == 9007199254740990LL, "Schema3 read incorrectly requires next-revision headroom.");
}
void schema3_identity_privacy_and_ledger(const QString &binary) {
    for (const int variant : {0, 1, 2}) {
        Fixture f; upgrade_schema3(f); auto scope = f.scope();
        { Sql sql(f.path); sql.exec("UPDATE proposal_format SET format_digest=?", {QString(64, '0')});
          if (variant == 2) sql.exec("UPDATE project SET privacy='internal'"); }
        if (variant == 0) scope.project_id = "different-project";
        if (variant == 1) scope.store_uuid = uuid().toStdString();
        if (variant == 2) scope.allow_internal = false;
        const auto before = tree(f.temp.path()); int contents = 0;
        { Hook hook([&](Phase p, const QString &) { if (p == Phase::BeforeProjectContent) ++contents; });
          refused([&] { read_project_mapping_observation_v2(f.path, scope, {}); },
                  variant == 2 ? C::NativeUnavailable : C::ConfigChanged); }
        check(contents == 0 && tree(f.temp.path()) == before, "Schema3 identity/privacy gate read corrupt ledger content.");
        refused([&] { read3(f); }, C::OwnerUnavailable);
        error(process(binary, arguments3(f), json(request(all_targets))), "OWNER_UNAVAILABLE");
    }
    for (const auto &sql_text : {"DELETE FROM proposal_format", "DROP TABLE desired_asset_receipts",
             "UPDATE identity_registry SET state='retired' WHERE kind='asset' AND entity_id='shared'",
             "UPDATE assets SET kind='malformed-kind' WHERE id='shared'"}) {
        Fixture f; upgrade_schema3(f); { Sql sql(f.path); sql.exec(sql_text); }
        const auto before = tree(f.temp.path()); refused([&] { read3(f); }, C::OwnerUnavailable);
        check(tree(f.temp.path()) == before, "Schema3 corruption was repaired or ignored.");
    }
    Fixture hidden; upgrade_schema3(hidden);
    hidden.change([](ProjectDocument &d) { d.repositories.front().privacy = P::Internal; });
    refused([&] { read3(hidden, all_targets, false); }, C::NativeUnavailable);
    error(process(binary, arguments3(hidden, false), json(request(all_targets))), "NATIVE_UNAVAILABLE");
    check(read3(hidden, {{K::Asset, "shared"}}, false).targets.size() == 1,
          "Unrelated private reference hid an authorized physical target.");
    hidden.change([](ProjectDocument &d) {
        std::erase_if(d.structure->asset_placements, [](const auto &r) { return r.asset_id == "shared"; });
        std::erase_if(d.topology.assets, [](const auto &r) { return r.id == "shared"; });
    });
    for (const auto &id : {"shared", "missing"})
        refused([&] { read3(hidden, {{K::Asset, id}}); }, C::NativeUnavailable);
    for (const int version : {1, 4}) {
        Fixture f; if (version == 4) { Sql sql(f.path); sql.exec("PRAGMA user_version=4"); }
        else { auto d = document(); d.structure.reset(); Fixture flat(d);
            refused([&] { read3(flat); }, C::NotSupported); continue; }
        refused([&] { read3(f); }, C::NotSupported);
    }
}
void schema3_wal_and_budget_mapping(const QString &binary) {
    {
        Fixture f; upgrade_schema3(f); make_wal(f); const auto before = tree(f.temp.path());
        const auto result = read3(f);
        check(result.storage_schema == 3 && result.revision == 2 &&
              observed(result, K::Asset).effective_classification == P::Internal && tree(f.temp.path()) == before,
              "Schema3 reader missed actual committed WAL or changed persisted files.");
    }
    {
        Fixture f; upgrade_schema3(f); Sql writer(f.path);
        writer.exec("PRAGMA journal_mode=WAL"); writer.exec("PRAGMA wal_autocheckpoint=0");
        writer.exec("UPDATE project SET label='Schema3 live WAL'");
        const auto old = read3(f); int content = 0, closed = 0;
        { Hook hook([&](Phase p, const QString &path) {
            check(path == f.path, "Schema3 snapshot hook followed another path.");
            if (p == Phase::BeforeProjectContent) {
                ++content; writer.exec("BEGIN IMMEDIATE");
                writer.exec("UPDATE component_memberships SET subsystem_id='other-subsystem'");
                writer.exec("UPDATE project SET revision=2"); writer.exec("COMMIT");
            }
            if (p == Phase::BeforeFinalVerification) ++closed;
          });
          check(read3(f) == old, "Schema3 identity, graph and ledger were read from different snapshots."); }
        const auto fresh = read3(f);
        check(content == 1 && closed == 1 && fresh.revision == 2 &&
              observed(fresh, K::Knowledge).ancestry_fingerprint != observed(old, K::Knowledge).ancestry_fingerprint,
              "Schema3 fresh invocation missed committed ancestry drift.");
    }
    {
        Fixture f; upgrade_schema3(f); Sql writer(f.path);
        writer.exec("PRAGMA journal_mode=WAL"); writer.exec("PRAGMA wal_autocheckpoint=0");
        writer.exec("UPDATE project SET label='Schema3 ledger snapshot'");
        const auto old = read3(f); int changed = 0;
        { Hook hook([&](Phase p, const QString &) {
            if (p == Phase::BeforeProjectContent) {
                ++changed; writer.exec("BEGIN IMMEDIATE");
                writer.exec("UPDATE proposal_format SET format_digest=?", {QString(64, '0')});
                writer.exec("COMMIT");
            }
          });
          check(read3(f) == old, "Schema3 ledger validation escaped the held original snapshot."); }
        check(changed == 1, "Controlled ledger drift was not committed.");
        refused([&] { read3(f); }, C::OwnerUnavailable);
    }
    Fixture f; upgrade_schema3(f); const auto before = tree(f.temp.path()); int reached = 0;
    { Hook hook([&](Phase p, const QString &) {
          if (p == Phase::BeforeProjectContent) { ++reached; throw DesiredAssetError(DesiredAssetCode::BudgetExceeded); }
      }); refused([&] { read3(f); }, C::BudgetExceeded); }
    check(reached == 1 && tree(f.temp.path()) == before,
          "Desired owner budget exception was hidden or wrote native state.");
    // This is an isolated exception-mapping check, not a claim that a valid
    // maximal ledger naturally reaches its separate eight-MiB byte budget.
    const auto moved = f.path + ".held"; bool denied = false;
    { Hook hook([&](Phase p, const QString &) {
          if (p == Phase::BeforeFinalVerification) denied = !move_local(f.temp.path(), f.path, moved);
      }); read3(f); }
    check(denied && move_local(f.temp.path(), f.path, moved) && move_local(f.temp.path(), moved, f.path),
          "Schema3 final check did not retain/release the original namespace lease.");
    error(process(binary, arguments3(f), json({{"targets", QJsonArray{}}, {"storageSchema", 2}})), "INVALID_INPUT");
}
void schema3_full_frame_bounds(const QString &binary) {
    Fixture f(bulk_document()); upgrade_schema3(f); std::vector<Target> targets;
    for (const auto &r : f.saved.components) targets.push_back({K::Component, r.id});
    for (const auto &r : f.saved.topology.assets) targets.push_back({K::Asset, r.id});
    const auto before = tree(f.temp.path());
    const auto frame = process(binary, arguments3(f), json(request(targets))); success3(frame, f, 4000);
    check(read3(f, targets).targets.size() == 4000, "Schema3 exact4000 batch was truncated.");
    std::cout << "BOUND: schema3 4000 legal targets, complete response " << frame.raw.size() << " bytes (cap " << cap << ")\n";
    targets.push_back({K::Environment, "shared"}); int opened = 0;
    { Hook hook([&](Phase, const QString &) { ++opened; }); refused([&] { read3(f, targets); }, C::BudgetExceeded); }
    check(opened == 0, "Schema3 count refusal probed a database.");
    error(process(binary, arguments3(f), json(request(targets))), "BUDGET_EXCEEDED");
    QByteArray exact = "{\"targets\":[]}"; exact.append(cap - exact.size(), ' ');
    success3(process(binary, arguments3(f), exact), f, 0);
    error(process(binary, arguments3(f), exact + ' '), "BUDGET_EXCEEDED");
    const auto valid = json(request({{K::Component, "shared"}}));
    for (const auto &raw : std::vector<QByteArray>{"{\"targets\":[],\"\\u0074argets\":[]}",
             "{\"targets\":[{\"kind\":\"component\",\"id\":\"a\\ud800\"}]}",
             QByteArray("{\"targets\":[{\"kind\":\"component\",\"id\":\"") + QByteArray::fromHex("ff") + "\"}]}",
             valid + '\0', valid + char(0x1a)})
        error(process(binary, arguments3(f), raw), "INVALID_INPUT");
    check(tree(f.temp.path()) == before, "Schema3 frame/cap refusal mutated graph/ledger/backup files.");
}

void run(const char *name, const std::function<void()> &test) {
    ++cases; std::cout << "CASE: " << name << '\n';
    try { test(); }
    catch (const std::exception &e) { ++failures; std::cerr << "FAIL: " << name << " [" << e.what() << "]\n"; }
    catch (...) { ++failures; std::cerr << "FAIL: " << name << " [unclassified fixture exception]\n"; }
}
} // namespace
int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    try {
        const auto args = app.arguments();
        if (args.size() == 3 && args[1] == "--leave-mapping-wal") return leave_wal(args[2]);
        need(args.size() == 2 && QFileInfo(args[1]).isAbsolute() && QFileInfo(args[1]).isFile(),
             "Pass the current shipped lmti-project executable.");
#ifdef Q_OS_WIN
        run("immutable schema/project/UUID before content", immutable_gate);
        run("eight namespaces and complete registry integrity", [&] { namespaces_and_registry(args[1]); });
        run("inherited privacy and uniform scoped whole-batch refusal", [&] { privacy_and_scope(args[1]); });
        run("independent exact ancestry and compatible reference fingerprints", exact_fingerprints);
        run("actual committed WAL and coherent one-connection snapshot", wal_and_snapshot);
        run("namespace lease causation/release/replacement/reparse", namespace_and_release);
        run("strict shipped process and pure pre-I/O validation", [&] { strict_boundary(args[1]); });
        run("exact 4000/4MiB/depth32 bounds and no writes", [&] { bounds_depth_and_no_writes(args[1]); });
        run("explicit schema3 projection and desired revision without receipt disclosure", [&] { schema3_versioned_projection(args[1]); });
        run("schema3 identity privacy and full ledger integrity", [&] { schema3_identity_privacy_and_ledger(args[1]); });
        run("schema3 WAL snapshot leases and explicit budget error mapping", [&] { schema3_wal_and_budget_mapping(args[1]); });
        run("schema3 complete4000 and strict four-MiB frames", [&] { schema3_full_frame_bounds(args[1]); });
#else
        skip("Windows invocation namespace guarantee unavailable; no native success claim.");
#endif
    } catch (const std::exception &e) { ++failures; std::cerr << "FAIL: setup [" << e.what() << "]\n"; }
    std::cout << "mapping observation: " << cases << " cases, " << checks << " checks, "
              << failures << " failures, " << skips << " skips\n";
    return failures ? 1 : 0;
}
