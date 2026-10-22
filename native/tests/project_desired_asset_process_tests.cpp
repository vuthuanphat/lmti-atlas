#include "lmti/project_store.hpp"
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
#include <QSqlRecord>
#include <QTemporaryDir>
#include <QUuid>
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
using namespace lmti;
constexpr qsizetype input_cap = 64 * 1024, output_cap = 128 * 1024;
int cases = 0, checks = 0, failures = 0, skips = 0;
void need(bool ok, const char *message = "Desired process fixture setup failed.") {
    if (!ok) throw Error(message);
}
void check(bool ok, const char *message) {
    ++checks; if (!ok) { ++failures; std::cerr << "FAIL: " << message << '\n'; }
}
QString s(const std::string &v) { return QString::fromStdString(v); }
QByteArray json(const QJsonObject &o) { return QJsonDocument(o).toJson(QJsonDocument::Compact); }
QByteArray bytes(const QString &path) {
    QFile f(path); need(f.open(QIODevice::ReadOnly)); return f.readAll();
}
QByteArray hash(const QByteArray &v) { return QCryptographicHash::hash(v, QCryptographicHash::Sha256).toHex(); }
using Tree = QMap<QString, QByteArray>;
void scan(const QString &root, const QString &prefix, Tree &result) {
    const auto folder = prefix.isEmpty() ? root : QDir(root).filePath(prefix);
    for (const auto &entry : QDir(folder).entryInfoList(
             QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden | QDir::System, QDir::Name)) {
        const auto key = prefix.isEmpty() ? entry.fileName() : prefix + '/' + entry.fileName();
        need(!entry.isSymLink() && !entry.isJunction());
        if (entry.isDir()) { result[key] = "directory"; scan(root, key, result); }
        else result[key] = hash(bytes(entry.filePath()));
    }
}
Tree tree(const QString &root) { Tree result; scan(root, {}, result); return result; }
void fields(const QJsonObject &o, const QSet<QString> &wanted) {
    QSet<QString> actual; for (auto it = o.begin(); it != o.end(); ++it) actual.insert(it.key());
    check(actual == wanted, "Unexpected response fields.");
}
QJsonObject physical(const QString &path) {
    const auto normalized = QDir::cleanPath(path);
    QStringList parts;
    for (auto cursor = normalized;;) {
        parts.prepend(cursor); const auto parent = QFileInfo(cursor).dir().absolutePath();
        if (parent == cursor) break; cursor = parent;
    }
    QJsonArray chain;
#ifdef Q_OS_WIN
    for (qsizetype i = 0; i < parts.size(); ++i) {
        const bool directory = i + 1 < parts.size();
        const auto handle = CreateFileW(reinterpret_cast<LPCWSTR>(parts[i].utf16()), FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr);
        need(handle != INVALID_HANDLE_VALUE);
        BY_HANDLE_FILE_INFORMATION info{};
        const auto ok = GetFileInformationByHandle(handle, &info), closed = CloseHandle(handle);
        need(ok && closed && !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
             bool(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == directory && (directory || info.nNumberOfLinks == 1));
        const auto ticks = (quint64(info.ftCreationTime.dwHighDateTime) << 32) | info.ftCreationTime.dwLowDateTime;
        need(ticks > 116444736000000000ULL);
        chain.append(QJsonObject{{"dev", QString::number(info.dwVolumeSerialNumber)},
            {"ino", QString::number((quint64(info.nFileIndexHigh) << 32) | info.nFileIndexLow)},
            {"birthtimeNs", QString::number(ticks - 116444736000000000ULL) + "00"}});
    }
#endif
    return {{"version", 1}, {"path", normalized}, {"kind", "file"}, {"state", "present"}, {"chain", chain}};
}
class Sql {
    QString connection_ = QUuid::createUuid().toString();
  public:
    QSqlDatabase db;
    explicit Sql(const QString &path) {
        need(QFileInfo(path).isFile());
        db = QSqlDatabase::addDatabase("QSQLITE", connection_);
        db.setDatabaseName(path); db.setConnectOptions("QSQLITE_OPEN_READONLY"); need(db.open());
    }
    ~Sql() { db.close(); db = {}; QSqlDatabase::removeDatabase(connection_); }
    QJsonArray rows(const QString &statement) {
        QSqlQuery q(db); need(q.exec(statement)); QJsonArray result;
        while (q.next()) {
            QJsonArray row;
            for (int i = 0; i < q.record().count(); ++i)
                row.append(q.isNull(i) ? QJsonValue(QJsonValue::Null) : QJsonValue(q.value(i).toString()));
            result.append(row);
        }
        return result;
    }
};
struct Frame { QJsonObject value; QByteArray raw; int exit; };
Frame process(const QString &binary, const QStringList &args, const QByteArray &input,
              bool discard = false, bool prove_eof = false) {
    QProcess child; child.setProgram(binary); child.setArguments(args);
    child.setProcessChannelMode(QProcess::SeparateChannels);
    if (discard) child.setStandardOutputFile(QProcess::nullDevice());
    QByteArray output, errors; bool overflow = false;
    const auto drain = [&] {
        const auto out = child.readAllStandardOutput(), err = child.readAllStandardError();
        if (output.size() + out.size() > output_cap || errors.size() + err.size() > 8192) overflow = true;
        if (!overflow) { output += out; errors += err; }
    };
    QObject::connect(&child, &QProcess::readyReadStandardOutput, drain);
    QObject::connect(&child, &QProcess::readyReadStandardError, drain);
    child.start(); need(child.waitForStarted(5000), "Fixed desired CLI did not start.");
    need(child.write(input) == input.size());
    if (prove_eof) {
        child.waitForBytesWritten(5000);
        check(!child.waitForFinished(150), "CLI treated an open pipe as complete JSON input.");
    }
    child.closeWriteChannel();
    QElapsedTimer elapsed; elapsed.start();
    while (child.state() != QProcess::NotRunning && elapsed.elapsed() < 40000) {
        child.waitForFinished(50); drain();
    }
    if (child.state() != QProcess::NotRunning) {
        child.kill(); const auto closed = child.waitForFinished(5000);
        need(closed, "Direct desired CLI child did not close after deadline.");
        need(false, "Desired CLI exceeded the bounded process deadline.");
    }
    drain(); need(!overflow && child.exitStatus() == QProcess::NormalExit && errors.isEmpty(),
                  "CLI framing/channel/close failure.");
    if (discard) return {{}, {}, child.exitCode()};
    need(!output.isEmpty() && output.endsWith('\n') && output.size() <= output_cap);
    check(output.count('\n') == 1, "CLI emitted more than one complete LF frame.");
    QJsonParseError error; const auto parsed = QJsonDocument::fromJson(output, &error);
    need(error.error == QJsonParseError::NoError && parsed.isObject());
    return {parsed.object(), output, child.exitCode()};
}
void refused(const Frame &f, const QString &code, bool write, bool format = false,
             const QJsonValue &action = QJsonValue(QJsonValue::Null)) {
    const auto schema = format ? (write ? "lmti.project.proposal-format.write.v1" : "lmti.project.proposal-format.owner.v1")
                               : (write ? "lmti.project.desired-asset.write.v1" : "lmti.project.desired-asset.owner.v1");
    fields(f.value, write ? QSet<QString>{"ok", "schema", "action", "outcome", "operationId", "details", "error"}
                         : QSet<QString>{"ok", "schema", "action", "details", "error"});
    check(f.exit == 1 && f.value["ok"] == false && f.value["schema"] == schema &&
          f.value["action"] == action && f.value["details"].isNull() &&
          f.value["error"].toObject() == QJsonObject{{"code", code}}, "Unexpected bounded refusal.");
    if (write) {
        check(f.value["outcome"] == "refused", "A proven refusal was reported as another outcome.");
        if (code == "INVALID_INPUT" || code == "BUDGET_EXCEEDED")
            check(f.value["operationId"].isNull(), "Malformed pre-owner input exposed an unauthorized operation ID.");
    }
}
QJsonObject success(const Frame &f, bool write, bool format, const QString &action) {
    fields(f.value, write ? QSet<QString>{"ok", "schema", "action", "outcome", "operationId", "details", "error"}
                         : QSet<QString>{"ok", "schema", "action", "details", "error"});
    const auto schema = format ? (write ? "lmti.project.proposal-format.write.v1" : "lmti.project.proposal-format.owner.v1")
                               : (write ? "lmti.project.desired-asset.write.v1" : "lmti.project.desired-asset.owner.v1");
    need(f.exit == 0 && f.value["ok"] == true && f.value["schema"] == schema &&
         f.value["action"] == action && f.value["error"].isNull() && f.value["details"].isObject(),
         "Expected successful private operation was refused.");
    if (write) check(f.value["outcome"] == "confirmed" && f.value["operationId"].isString(),
                     "Confirmed operation lost native identity.");
    return f.value["details"].toObject();
}
ProjectDocument document() {
    ProjectDocument d; d.project = {"desired-project", "Synthetic project", "", Privacy::Public};
    d.structure.emplace(); auto &v = *d.structure;
    v.sites = {{"site-a", "Site A", Privacy::Public}, {"site-b", "Site B", Privacy::Public}};
    v.areas = {{"floor", "Floor", "site-a", "", Privacy::Public}, {"cell", "Cell", "site-a", "floor", Privacy::Public}};
    v.environments = {{"production", "Production", Privacy::Public}, {"unused", "Unused", Privacy::Public}};
    v.subsystems = {{"logical-root", "Logic", "", Privacy::Public}};
    v.component_memberships = {{"component", "logical-root"}};
    d.repositories = {{"repository", "Repository", "src/synthetic", Privacy::Public}};
    d.components = {{"component", "Component", "repository", ComponentKind::Firmware, Privacy::Public}};
    d.knowledge = {{"knowledge", "Knowledge", "component", "docs/synthetic", "synthetic", Privacy::Public}};
    d.topology.assets = {{"parent", "Parent", "site-a", Kind::Gateway, Privacy::Public},
        {"target", "Target", "site-a", Kind::Sensor, Privacy::Public},
        {"other", "Other", "site-b", Kind::Service, Privacy::Public}};
    v.asset_placements = {{"parent", "cell", "", "production", PhysicalRole::Host},
        {"target", "cell", "parent", "production", std::nullopt}};
    d.topology.assets[1].observed = Observation::Online;
    d.topology.assets[1].observed_at = 1234; d.topology.assets[1].x = 12.5;
    validate(d); return d;
}
struct Fixture {
    QTemporaryDir temp{QDir(QDir::tempPath()).filePath("lmti-desired-process-XXXXXX")};
    QString db, backups, store_uuid;
    QJsonObject pin2, pin3;
    explicit Fixture(ProjectDocument d = document()) {
        need(temp.isValid()); db = temp.filePath(QString::fromUtf8("project-測試.sqlite"));
        backups = temp.filePath("backups"); need(QDir(temp.path()).mkdir("backups"));
        d.topology.revision = save_project(db, d);
        const auto saved = load_project(db); need(saved.storage_lineage.has_value());
        store_uuid = s(saved.storage_lineage->store_uuid);
        pin2 = {{"schema", 2}, {"storeUuid", store_uuid}, {"physical", physical(db)}};
        pin3 = pin2; pin3["schema"] = 3;
    }
    QStringList args(bool write = false, bool format = false, bool internal = true) const {
        QStringList result{format ? (write ? "proposal-format-write" : "proposal-format-read")
                                  : (write ? "desired-asset-write" : "desired-asset-read"),
            db, "desired-project", store_uuid, "synthetic-operator", QString(64, 'a')};
        if (format) result << backups; else result << "site-a" << "production" << (internal ? "local" : "external");
        return result;
    }
    QJsonObject upgrade(const QString &binary) const {
        const auto p = success(process(binary, args(false, true), json({{"action", "preview-upgrade"}, {"original", pin2}})),
                               false, true, "preview-upgrade");
        success(process(binary, args(true, true), json({{"action", "upgrade"}, {"expected", p["expected"]}})),
                true, true, "upgrade");
        return p["expected"].toObject();
    }
    QJsonObject inspect(const QString &binary, bool internal = true) const {
        return success(process(binary, args(false, false, internal),
            json({{"action", "inspect"}, {"original", pin3}, {"assetId", "target"}})), false, false, "inspect")["state"].toObject();
    }
    QJsonObject preview(const QString &binary, bool internal = true) const {
        const auto state = inspect(binary, internal);
        return success(process(binary, args(false, false, internal), json({{"action", "preview"}, {"original", pin3},
            {"proposal", QJsonObject{{"assetId", "target"}, {"expectedRevision", state["revision"]},
                {"expected", QJsonObject{{"enabled", state["enabled"]}, {"pollMs", state["pollMs"]}}},
                {"desired", QJsonObject{{"enabled", !state["enabled"].toBool()}, {"pollMs", 1250}}},
                {"handoffDigest", QString(64, 'b')}}}})), false, false, "preview")["expected"].toObject();
    }
    QJsonObject commit_request(const QJsonObject &token) const { return {{"action", "commit"}, {"original", pin3}, {"expected", token}}; }
    QJsonObject receipt_request(const QJsonObject &token) const {
        return {{"action", "receipt"}, {"original", pin3}, {"operationId", token["operationId"]}, {"requestDigest", token["requestDigest"]}};
    }
    void change(const std::function<void(ProjectDocument &)> &fn) const {
        auto d = load_project(db); fn(d); d.topology.revision = save_project(db, d);
    }
};
void format_shape(const QJsonObject &v) {
    fields(v, {"singleton", "upgradeOperationId", "storeUuid", "fromSchema", "sourceRevision",
               "sourceContentDigest", "sourceRegistryDigest", "backupSha256", "formatDigest"});
}
void receipt_shape(const QJsonObject &v) {
    fields(v, {"schema", "originStoreUuid", "operationId", "requestDigest", "handoffDigest", "projectId", "principalId",
        "grantFingerprint", "siteId", "environmentId", "allowInternal", "assetId", "effectivePrivacy", "baseRevision",
        "committedRevision", "expectedEnabled", "expectedPollMs", "desiredEnabled", "desiredPollMs",
        "originalTargetDigest", "beforeContentDigest", "afterContentDigest", "registryDigest",
        "targetAncestryDigest", "receiptDigest"});
    check(v["schema"] == "lmti.project.desired-asset.receipt.v1", "Receipt schema differs.");
}
void explicit_upgrade(const QString &binary) {
    Fixture f; const auto before = load_project(f.db); const auto original_tree = tree(f.temp.path());
    refused(process(binary, f.args(), json({{"action", "inspect"}, {"original", f.pin3}, {"assetId", "target"}})),
            "UNSUPPORTED_SCHEMA", false, false, "inspect");
    check(tree(f.temp.path()) == original_tree, "Desired read silently upgraded or changed schema2.");
    const auto p = success(process(binary, f.args(false, true),
        json({{"action", "preview-upgrade"}, {"original", f.pin2}})), false, true, "preview-upgrade");
    check(tree(f.temp.path()) == original_tree, "Upgrade preview created backup/source output.");
    const auto token = p["expected"].toObject();
    fields(token, {"schema", "operationId", "scope", "original", "backupParent", "snapshot", "reviewDigest"});
    const auto initial = success(process(binary, f.args(false, true),
        json({{"action", "inspect-upgrade"}, {"expected", token}})), false, true, "inspect-upgrade");
    check(initial["state"] == "original" && initial["format"].isNull(), "Original upgrade status fabricated a committed format.");
    const auto done = success(process(binary, f.args(true, true), json({{"action", "upgrade"}, {"expected", token}})),
                              true, true, "upgrade");
    fields(done, {"format", "backupVerified"}); format_shape(done["format"].toObject());
    check(done["backupVerified"] == true, "Upgrade did not confirm its verified backup.");
    auto after = load_project(f.db); auto expected = before; expected.storage_lineage->schema_version = 3;
    check(after == expected, "Format upgrade changed graph, UUID, registry lineage or revision.");
    const auto backup = QDir(f.backups).filePath(token["operationId"].toString() + "/project-v2.sqlite");
    check(QFileInfo(backup).isFile() && !QFileInfo::exists(backup + "-wal") && !QFileInfo::exists(backup + "-shm"),
          "Upgrade backup is missing or depends on sidecars.");
    auto saved_backup = load_project(backup); auto saved_before = before;
    saved_backup.storage_lineage.reset(); saved_before.storage_lineage.reset();
    check(saved_backup == saved_before && done["format"].toObject()["backupSha256"] == QString::fromLatin1(hash(bytes(backup))),
          "Backup does not retain the original complete typed snapshot.");
    const auto status = success(process(binary, f.args(false, true),
        json({{"action", "inspect-upgrade"}, {"expected", token}})), false, true, "inspect-upgrade");
    check(status["state"] == "upgraded" && status["backupVerified"] == true &&
          status["format"] == done["format"], "Upgrade status does not identify the exact committed transition.");
}
void targeted_commit(const QString &binary) {
    Fixture f; f.upgrade(binary);
    const auto before = load_project(f.db); const auto token = f.preview(binary);
    const auto before_tree = tree(f.temp.path());
    const auto done = success(process(binary, f.args(true), json(f.commit_request(token))), true, false, "commit");
    fields(done, {"receipt", "historical", "replayed"}); const auto receipt = done["receipt"].toObject();
    receipt_shape(receipt);
    check(done["historical"] == true && done["replayed"] == false, "First commit lost historical receipt semantics.");
    check(receipt["operationId"] == token["operationId"] && receipt["requestDigest"] == token["requestDigest"] &&
          receipt["handoffDigest"] == QString(64, 'b') && receipt["committedRevision"].toInteger() == before.topology.revision + 1,
          "Receipt/request/revision correlation differs.");
    auto expected = before;
    for (auto &a : expected.topology.assets) if (a.id == "target") { a.enabled = false; a.poll_ms = 1250; }
    ++expected.topology.revision;
    check(load_project(f.db) == expected, "Desired edit changed data beyond enabled, poll and revision.");
    check(!json(receipt).contains(f.temp.path().toUtf8()) && !json(receipt).contains("canonicalPath"),
          "Receipt leaked private filesystem paths.");
    const auto looked_up = success(process(binary, f.args(), json(f.receipt_request(token))), false, false, "receipt");
    check(looked_up == QJsonObject{{"receipt", receipt}, {"historical", true}}, "Exact receipt lookup changed evidence.");
    Sql sql(f.db);
    check(sql.rows("SELECT COUNT(*) FROM desired_asset_receipts")[0].toArray()[0] == "1", "Commit inserted duplicate/missing receipt.");
    check(before_tree != tree(f.temp.path()), "Commit produced no persisted change.");
}
void restart_and_lost_ack(const QString &binary) {
    Fixture f; f.upgrade(binary); const auto token = f.preview(binary);
    const auto lost = process(binary, f.args(true), json(f.commit_request(token)), true);
    check(lost.exit == 0, "Actual discarded-output commit process failed.");
    const auto receipt = success(process(binary, f.args(), json(f.receipt_request(token))), false, false, "receipt").value("receipt");
    need(receipt.isObject());
    f.change([](ProjectDocument &d) {
        d.project.label = "Later label";
        for (auto &a : d.topology.assets) if (a.id == "target") { a.enabled = true; a.poll_ms = 1800; }
    });
    const auto later = load_project(f.db); const auto before = tree(f.temp.path());
    const auto replay = success(process(binary, f.args(true), json(f.commit_request(token))), true, false, "commit");
    check(replay["receipt"] == receipt && replay["replayed"] == true && replay["historical"] == true,
          "Restart replay failed to recover the old receipt after later edits.");
    check(load_project(f.db) == later && tree(f.temp.path()) == before, "Receipt replay reapplied old desired values or mutated history.");
    auto absent = f.receipt_request(token); absent["operationId"] = QUuid::createUuid().toString(QUuid::WithoutBraces);
    const auto result = success(process(binary, f.args(), json(absent)), false, false, "receipt");
    check(result == QJsonObject{{"receipt", QJsonValue(QJsonValue::Null)}, {"historical", true}},
          "Unknown ID did not return exact null historical shape.");
    auto mismatch = f.receipt_request(token); mismatch["requestDigest"] = QString(64, 'c');
    refused(process(binary, f.args(), json(mismatch)), "OPERATION_CONFLICT", false, false, "receipt");
}
void scope_and_history(const QString &binary) {
    Fixture f; f.upgrade(binary); const auto external = f.preview(binary, false);
    success(process(binary, f.args(true, false, false), json(f.commit_request(external))), true, false, "commit");
    auto wrong = f.args(false, false, false); wrong[4] = "other-principal";
    check(success(process(binary, wrong, json(f.receipt_request(external))), false, false, "receipt")["receipt"].isNull(),
          "Receipt was disclosed under another principal.");
    f.change([](ProjectDocument &d) { d.structure->areas.front().privacy = Privacy::Internal; });
    const auto before = tree(f.temp.path());
    check(success(process(binary, f.args(false, false, false), json(f.receipt_request(external))),
                  false, false, "receipt")["receipt"].isNull(), "External receipt survived hidden original ancestry.");
    refused(process(binary, f.args(true, false, false), json(f.commit_request(external))), "SCOPE_DENIED", true, false, "commit");
    auto stale = QJsonObject{{"action", "preview"}, {"original", f.pin3}, {"proposal", external["proposal"]}};
    refused(process(binary, f.args(false, false, false), json(stale)), "SCOPE_DENIED", false, false, "preview");
    check(tree(f.temp.path()) == before, "Unauthorized history/query mutated the store.");

    Fixture local; local.upgrade(binary); const auto token = local.preview(binary);
    const auto original_receipt = success(process(binary, local.args(true), json(local.commit_request(token))),
                                          true, false, "commit").value("receipt");
    local.change([](ProjectDocument &d) {
        std::erase_if(d.topology.assets, [](const Asset &a) { return a.id == "target"; });
        std::erase_if(d.structure->asset_placements, [](const AssetPlacement &p) { return p.asset_id == "target"; });
    });
    check(success(process(binary, local.args(), json(local.receipt_request(token))), false, false, "receipt")["receipt"] == original_receipt,
          "Exact local history disappeared after target retirement.");
    check(success(process(binary, local.args(true), json(local.commit_request(token))), true, false, "commit")["replayed"] == true,
          "Exact local replay after retirement was incorrectly treated as a new edit.");
}
void original_copy_and_conflicts(const QString &binary) {
    Fixture f; f.upgrade(binary); const auto token = f.preview(binary);
    success(process(binary, f.args(true), json(f.commit_request(token))), true, false, "commit");
    const auto copy = f.temp.filePath("same-uuid-copy.sqlite");
    need(!QFileInfo::exists(copy) && QFile::copy(f.db, copy));
    auto args = f.args(); args[1] = copy;
    auto lookup = f.receipt_request(token); auto copied_original = f.pin3; copied_original["physical"] = physical(copy);
    lookup["original"] = copied_original;
    const auto before = tree(f.temp.path());
    check(success(process(binary, args, json(lookup)), false, false, "receipt")["receipt"].isNull(),
          "Same-UUID copy acquired original receipt authority from fresh file pins.");
    auto commit = f.commit_request(token); commit["original"] = copied_original; args[0] = "desired-asset-write";
    refused(process(binary, args, json(commit)), "SCOPE_DENIED", true, false, "commit");
    check(tree(f.temp.path()) == before, "Copied-file receipt probe changed a store.");
    // Scope from stdin is never an authority grant, even if token values look valid.
    auto altered = token; auto scope = altered["scope"].toObject(); scope["principalId"] = "another-principal";
    altered["scope"] = scope;
    refused(process(binary, f.args(true), json(f.commit_request(altered))), "SCOPE_DENIED", true, false, "commit");
}
void strict_read_frames(const QString &binary) {
    Fixture f; f.upgrade(binary);
    const QJsonObject valid{{"action", "inspect"}, {"original", f.pin3}, {"assetId", "target"}};
    const auto input = json(valid); const auto before = tree(f.temp.path());
    success(process(binary, f.args(), input, false, true), false, false, "inspect");
    QByteArray exact = input; exact.append(input_cap - exact.size(), ' ');
    success(process(binary, f.args(), exact), false, false, "inspect");
    refused(process(binary, f.args(), exact + " "), "BUDGET_EXCEEDED", false);
    const std::vector<QByteArray> malformed{
        "", input + '\0', input + char(0x1a), input + "{}",
        QByteArray("{\"action\":\"inspect\",\"action\":\"inspect\"}"),
        QByteArray("{\"action\":\"inspect\",\"\\u0061ction\":\"inspect\"}"),
        QByteArray("{\"action\":\"inspect\",\"unused\":") + QByteArray(17, '[') + "0" + QByteArray(17, ']') + "}",
        QByteArray("{\"action\":\"inspect\",\"assetId\":\"\\ud800\"}"),
        QByteArray("{\"action\":\"inspect\",\"assetId\":\"\\udc00\"}"),
        QByteArray("{\"action\":\"inspect\",\"assetId\":\"") + QByteArray::fromHex("ff") + "\"}"};
    for (const auto &raw : malformed) refused(process(binary, f.args(), raw), "INVALID_INPUT", false);
    auto extra = valid; extra["authority"] = true;
    refused(process(binary, f.args(), json(extra)), "INVALID_INPUT", false, false, "inspect");
    auto pin = f.pin3; auto p = pin["physical"].toObject(); auto c = p["chain"].toArray();
    auto identity = c.last().toObject(); identity["ino"] = 1; c[c.size()-1] = identity; p["chain"] = c; pin["physical"] = p;
    auto invalid_identity = valid; invalid_identity["original"] = pin;
    refused(process(binary, f.args(), json(invalid_identity)), "INVALID_INPUT", false, false, "inspect");
    auto args = f.args(); args << "extra";
    refused(process(binary, args, input), "INVALID_INPUT", false, false, "inspect");
    args = f.args(); args[8] = "not-a-visibility";
    refused(process(binary, args, input), "INVALID_INPUT", false, false, "inspect");
    check(tree(f.temp.path()) == before, "Invalid/read-only frames mutated source or output namespace.");
}
void strict_write_frames(const QString &binary) {
    Fixture f; f.upgrade(binary); const auto token = f.preview(binary); const auto before = tree(f.temp.path());
    auto valid = f.commit_request(token);
    refused(process(binary, f.args(true), QByteArray(input_cap + 1, ' ')), "BUDGET_EXCEEDED", true);
    refused(process(binary, f.args(true), "{\"action\":\"not-commit\"}"), "INVALID_INPUT", true);
    auto extra = valid; extra["allowInternal"] = true;
    refused(process(binary, f.args(true), json(extra)), "INVALID_INPUT", true, false, "commit");
    auto altered = token; auto snap = altered["snapshot"].toObject(); snap["revision"] = "1"; altered["snapshot"] = snap;
    refused(process(binary, f.args(true), json(f.commit_request(altered))), "INVALID_INPUT", true, false, "commit");
    altered = token; altered["requestDigest"] = QString(64, 'd') + '\n';
    refused(process(binary, f.args(true), json(f.commit_request(altered))), "INVALID_INPUT", true, false, "commit");
    auto args = f.args(true); args[4] = QString::fromUtf8("operator-😀"); // Valid Unicode scalar in fixed authority, different scope.
    refused(process(binary, args, json(valid)), "SCOPE_DENIED", true, false, "commit");
    auto proposal = token["proposal"].toObject(); proposal["desired"] = proposal["expected"];
    refused(process(binary, f.args(), json({{"action", "preview"}, {"original", f.pin3}, {"proposal", proposal}})),
            "INVALID_INPUT", false, false, "preview");
    auto range = proposal["desired"].toObject(); range["pollMs"] = 99; proposal["desired"] = range;
    refused(process(binary, f.args(), json({{"action", "preview"}, {"original", f.pin3}, {"proposal", proposal}})),
            "INVALID_INPUT", false, false, "preview");
    check(tree(f.temp.path()) == before, "Rejected commit/preview changed source.");
    const auto done = success(process(binary, f.args(true), json(valid)), true, false, "commit");
    receipt_shape(done["receipt"].toObject());
}
void graph_compatibility(const QString &binary) {
    Fixture f; f.upgrade(binary); const auto token = f.preview(binary);
    success(process(binary, f.args(true), json(f.commit_request(token))), true, false, "commit");
    const auto before = tree(f.temp.path());
    const auto snapshot = process(binary, {"structure-snapshot", f.db, "desired-project", "site-a", "local"}, "");
    check(snapshot.exit == 0 && !snapshot.raw.contains("desired_asset_receipts") &&
          !snapshot.raw.contains("proposal_format") && !snapshot.raw.contains(token["operationId"].toString().toUtf8()) &&
          !snapshot.raw.contains("principalId") && !snapshot.raw.contains(f.temp.path().toUtf8()),
          "Graph-only schema3 projection leaked receipt/operator paths.");
    const auto legacy = process(binary, {"proposal-asset", f.db, "desired-project", "site-a", "local", "target"}, "");
    check(legacy.exit == 1 && legacy.value == QJsonObject{{"ok", false}, {"error", QJsonObject{{"code", "SCOPE_DENIED"}}}},
          "Legacy flat proposal unexpectedly gained schema3 write capability.");
    check(tree(f.temp.path()) == before, "Graph/legacy compatibility read mutated schema3.");
}
} // namespace

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    if (app.arguments().size() != 2) { std::cerr << "Expected one shipped lmti-project executable.\n"; return 1; }
#ifdef Q_OS_WIN
    const auto binary = app.arguments()[1];
    const std::pair<const char *, void (*)(const QString &)> tests[]{
        {"explicit_upgrade", explicit_upgrade}, {"targeted_commit", targeted_commit},
        {"restart_and_lost_ack", restart_and_lost_ack}, {"scope_and_history", scope_and_history},
        {"original_copy_and_conflicts", original_copy_and_conflicts}, {"strict_read_frames", strict_read_frames},
        {"strict_write_frames", strict_write_frames}, {"graph_compatibility", graph_compatibility}};
    for (const auto &[name, fn] : tests) {
        ++cases; const auto prior = failures;
        try { fn(binary); } catch (const std::exception &e) { ++failures; std::cerr << "FAIL: " << name << ": " << e.what() << '\n'; }
        std::cout << (prior == failures ? "PASS: " : "FAIL: ") << name << '\n';
    }
#else
    ++skips; std::cout << "SKIP: original physical identity process fixtures require Windows.\n";
#endif
    std::cout << cases << " cases, " << checks << " checks, " << failures << " failures, " << skips << " skips\n";
    return failures ? 1 : 0;
}
