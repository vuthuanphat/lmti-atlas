#include "lmti/project_store.hpp"
#include "lmti/storage.hpp"
#include <QCoreApplication>
#include <QFile>
#include <QJsonDocument>
#include <QProcess>
#include <QTemporaryDir>
#include <iostream>

namespace {
int failures = 0;
void check(bool ok, const char *message) {
    if (!ok) {
        std::cerr << message << '\n';
        ++failures;
    }
}
QByteArray bytes(const QString &path) {
    QFile file(path);
    check(file.open(QIODevice::ReadOnly), "cannot read fixture");
    return file.readAll();
}
QByteArray encode(const QJsonObject &object) {
    return QJsonDocument(object).toJson(QJsonDocument::Compact);
}
struct Response {
    int exit;
    QJsonObject json;
};
void start(QProcess &process, const QString &binary, const QStringList &args, const QByteArray &input) {
    process.start(binary, args);
    check(process.waitForStarted(10000), "owner did not start");
    if (!input.isEmpty())
        check(process.write(input) == input.size(), "cannot send proposal");
    process.closeWriteChannel();
}
Response finish(QProcess &process) {
    const auto finished = process.state() == QProcess::NotRunning || process.waitForFinished(10000);
    check(finished, "owner did not finish");
    if (!finished) {
        process.kill();
        process.waitForFinished(3000);
    }
    const auto output = process.readAllStandardOutput();
    check(process.exitStatus() == QProcess::NormalExit, "owner crashed");
    check(process.readAllStandardError().isEmpty(), "owner leaked raw stderr");
    check(output.size() <= 4096, "owner output exceeded bound");
    QJsonParseError error;
    const auto document = QJsonDocument::fromJson(output, &error);
    check(error.error == QJsonParseError::NoError && document.isObject(), "owner output was not JSON");
    return {process.exitCode(), document.object()};
}
Response run(const QString &binary, const QStringList &args, const QByteArray &input = {}) {
    QProcess process;
    start(process, binary, args, input);
    return finish(process);
}
void refused(const Response &response, const char *code) {
    check(response.exit == 1 && response.json == QJsonObject{{"ok", false},
                      {"error", QJsonObject{{"code", code}}}}, "owner returned an unsafe/wrong error");
}
QJsonObject envelope(qint64 revision, const lmti::ConfigProposal &proposal) {
    return {{"expectedProjectRevision", revision}, {"proposal", lmti::proposal_json(proposal)}};
}
} // namespace

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    check(app.arguments().size() == 2, "pass the built lmti-project executable");
    if (app.arguments().size() != 2)
        return 1;
    const auto binary = app.arguments()[1];
    QTemporaryDir temp;
    check(temp.isValid(), "cannot create owner test directory");
    if (!temp.isValid())
        return 1;
    const auto path = temp.filePath("project.sqlite");
    auto document = lmti::demo_project();
    document.topology.assets[1].privacy = lmti::Privacy::Internal;
    document.topology.assets[2].site = "other-site";
    document.topology.revision = lmti::save_project(path, document);
    const QStringList grant{path, "factory-monitor", "factory-demo", "external"};
    auto args = [&](const QString &operation) { return QStringList{operation} + grant; };
    auto proposal = lmti::ConfigProposal{1, "machine-a", "factory-demo", true, false, 1000, 2500};
    auto request = envelope(1, proposal);
    const auto initial = bytes(path);

    const auto inspected = run(binary, args("proposal-asset") + QStringList{"machine-a"});
    check(inspected.exit == 0 && inspected.json["projectRevision"].toInteger() == 1 &&
              inspected.json["topologyRevision"].toInteger() == 1 &&
              inspected.json["asset"].toObject()["desired"].toObject()["pollMs"] == 1000,
          "scoped desired configuration unavailable for review");
    check(bytes(path) == initial, "asset inspection changed database bytes");
    const auto review = run(binary, args("review-proposal"), encode(request));
    check(review.exit == 0 && review.json["status"] == "reviewed" &&
              review.json["proposal"].toObject() == lmti::proposal_json(proposal) &&
              review.json["deviceActions"].isBool() && !review.json["deviceActions"].toBool() &&
              review.json["projectRevision"].toInteger() == 1,
          "review failed to preserve the checked proposal");
    check(bytes(path) == initial && lmti::load_project(path) == document,
          "review wrote desired state or unrelated metadata");

    auto denied = [&](const QStringList &arguments, const QByteArray &payload, const char *code) {
        const auto before = bytes(path);
        refused(run(binary, arguments, payload), code);
        check(bytes(path) == before, "rejected owner operation changed database bytes");
    };
    denied(args("proposal-asset") + QStringList{"gateway-b"}, {}, "SCOPE_DENIED");
    denied(args("proposal-asset") + QStringList{"broker-c"}, {}, "SCOPE_DENIED");
    denied(args("proposal-asset") + QStringList{"missing-device"}, {}, "SCOPE_DENIED");
    auto wrong_project = args("commit-proposal");
    wrong_project[2] = "another-project";
    denied(wrong_project, encode(request), "SCOPE_DENIED");
    auto other = request;
    other["expectedProjectRevision"] = 2;
    denied(args("commit-proposal"), encode(other), "REVISION_CONFLICT");
    auto wrong_revision = proposal;
    wrong_revision.base_revision = 2;
    denied(args("commit-proposal"), encode(envelope(1, wrong_revision)), "REVISION_CONFLICT");
    auto wrong_old = proposal;
    wrong_old.expected_poll_ms = 2000;
    denied(args("commit-proposal"), encode(envelope(1, wrong_old)), "CONFIG_CONFLICT");
    auto wrong_site = proposal;
    wrong_site.site = "other-site";
    denied(args("commit-proposal"), encode(envelope(1, wrong_site)), "SCOPE_DENIED");
    auto hidden = proposal;
    hidden.asset_id = "gateway-b";
    denied(args("commit-proposal"), encode(envelope(1, hidden)), "SCOPE_DENIED");

    other = request;
    other["database"] = "not-an-authorized-location";
    denied(args("commit-proposal"), encode(other), "INVALID_INPUT");
    auto hostile_proposal = lmti::proposal_json(proposal);
    hostile_proposal["command"] = "not-an-allowed-command";
    other = request;
    other["proposal"] = hostile_proposal;
    denied(args("commit-proposal"), encode(other), "INVALID_INPUT");
    hostile_proposal = lmti::proposal_json(proposal);
    hostile_proposal["desired"] = QJsonObject{{"enabled", false}, {"pollMs", 2500}, {"extra", true}};
    other["proposal"] = hostile_proposal;
    denied(args("commit-proposal"), encode(other), "INVALID_INPUT");
    hostile_proposal["desired"] = QJsonObject{{"enabled", false}, {"pollMs", 99}};
    other["proposal"] = hostile_proposal;
    denied(args("commit-proposal"), encode(other), "INVALID_INPUT");
    for (const auto &value : {QJsonValue(true), QJsonValue(1.5), QJsonValue("1"), QJsonValue(-1),
                             QJsonValue(9007199254740992.0)}) {
        other = request;
        other["expectedProjectRevision"] = value;
        denied(args("commit-proposal"), encode(other), "INVALID_INPUT");
    }
    auto duplicate = encode(request);
    duplicate.insert(1, "\"expectedProjectRevision\":2,");
    denied(args("commit-proposal"), duplicate, "INVALID_INPUT");
    duplicate = encode(request);
    duplicate.replace("\"desired\":{", "\"desired\":{\"poll\\u004ds\":1000,");
    denied(args("commit-proposal"), duplicate, "INVALID_INPUT");
    // Inject raw JSON escapes into recognized, otherwise valid identifiers.
    // Dropping an unpaired code unit would recover the original granted ID;
    // the byte boundary must reject it before conversion or owner mutation.
    int unicode_cases = 0;
    for (const QByteArray surrogate : {QByteArray("\\ud800"), QByteArray("\\udc00"),
                                       QByteArray("\\udc00\\ud800")}) {
        for (const bool asset : {true, false}) {
            const QByteArray original = asset ? "\"assetId\":\"machine-a\"" : "\"site\":\"factory-demo\"";
            const QByteArray malformed = asset ? QByteArray("\"assetId\":\"machine") + surrogate + "-a\"" :
                                                 QByteArray("\"site\":\"factory") + surrogate + "-demo\"";
            auto raw = encode(request);
            check(raw.count(original) == 1, "Unicode fixture must mutate exactly one recognized identifier");
            raw.replace(original, malformed);
            denied(args("commit-proposal"), raw, "INVALID_INPUT");
            ++unicode_cases;
        }
    }
    denied(args("commit-proposal"), "{}\n{}", "INVALID_INPUT");
    denied(args("commit-proposal"), "[]", "INVALID_INPUT");
    denied(args("commit-proposal"), QByteArray(4097, ' '), "INVALID_INPUT");
    denied(args("commit-proposal"), {}, "INVALID_INPUT");
    denied(args("commit-proposal") + QStringList{"extra"}, encode(request), "INVALID_INPUT");
    auto relative = args("commit-proposal");
    relative[1] = "relative.sqlite";
    denied(relative, encode(request), "OWNER_UNAVAILABLE");
    auto network = args("commit-proposal");
    network[1] = "//untrusted.invalid/share/file.sqlite";
    denied(network, encode(request), "OWNER_UNAVAILABLE");
    auto missing = args("commit-proposal");
    missing[1] = temp.filePath("must-not-be-created.sqlite");
    denied(missing, encode(request), "OWNER_UNAVAILABLE");
    check(!QFile::exists(missing[1]), "commit created a missing project database");

    const auto committed = run(binary, args("commit-proposal"), encode(request));
    check(committed.exit == 0 && committed.json["status"] == "committed" &&
              committed.json["projectRevision"].toInteger() == 2 &&
              committed.json["topologyRevision"].toInteger() == 2 &&
              !committed.json["deviceActions"].toBool(true),
          "reviewed desired configuration did not commit once");
    auto expected = document;
    expected.topology = lmti::apply_proposal(document.topology, proposal);
    expected.topology.revision = 2;
    check(lmti::load_project(path) == expected, "commit changed unrelated project data");
    denied(args("commit-proposal"), encode(request), "REVISION_CONFLICT");
    proposal.base_revision = 2;
    denied(args("commit-proposal"), encode(envelope(2, proposal)), "CONFIG_CONFLICT");

    // Both processes start from the same checked version. Exactly one may save;
    // the loser must observe a conflict and cannot overwrite the winning value.
    proposal.expected_enabled = false;
    proposal.expected_poll_ms = 2500;
    proposal.desired_poll_ms = 3000;
    auto competing = proposal;
    competing.desired_poll_ms = 4000;
    QProcess first, second;
    start(first, binary, args("commit-proposal"), encode(envelope(2, proposal)));
    start(second, binary, args("commit-proposal"), encode(envelope(2, competing)));
    const auto a = finish(first), b = finish(second);
    check((a.exit == 0) != (b.exit == 0), "concurrent proposals did not have exactly one winner");
    refused(a.exit == 0 ? b : a, "REVISION_CONFLICT");
    expected.topology = lmti::apply_proposal(expected.topology, a.exit == 0 ? proposal : competing);
    expected.topology.revision = 3;
    check(lmti::load_project(path) == expected, "concurrent proposals corrupted or overwrote state");

    auto local = args("proposal-asset") + QStringList{"gateway-b"};
    local[4] = "local";
    check(run(binary, local).exit == 0, "trusted local scope lost internal metadata");
    const auto private_path = temp.filePath("private.sqlite");
    auto private_document = lmti::demo_project();
    private_document.project.privacy = lmti::Privacy::Internal;
    private_document.topology.revision = lmti::save_project(private_path, private_document);
    auto private_grant = args("proposal-asset") + QStringList{"machine-a"};
    private_grant[1] = private_path;
    const auto private_before = bytes(private_path);
    refused(run(binary, private_grant), "SCOPE_DENIED");
    check(bytes(private_path) == private_before, "denied private read changed database");
    private_grant[4] = "local";
    check(run(binary, private_grant).exit == 0, "local private project scope failed");

    const auto ordinary = temp.filePath("ordinary.sqlite");
    QFile ordinary_file(ordinary);
    check(ordinary_file.open(QIODevice::WriteOnly), "cannot create non-database fixture");
    ordinary_file.write("not a database; never return file content");
    ordinary_file.close();
    auto invalid_database = args("commit-proposal");
    invalid_database[1] = ordinary;
    const auto ordinary_before = bytes(ordinary);
    refused(run(binary, invalid_database, encode(request)), "OWNER_UNAVAILABLE");
    check(bytes(ordinary) == ordinary_before, "invalid database overwritten");

    std::cout << "Project owner scope, strict proposal review, no-write rejection and concurrent commits checked; "
              << unicode_cases << " raw Unicode rejection cases; " << failures << " failures\n";
    return failures ? 1 : 0;
}
