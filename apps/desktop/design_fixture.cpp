#include "design_fixture.hpp"
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QProcess>
#include <QProcessEnvironment>
#include <stdexcept>
#include <utility>
#include <vector>

namespace {
QJsonObject owner_command(const QString &directory, const QStringList &arguments,
                          const QByteArray &input = {}) {
    const QFileInfo node(qEnvironmentVariable("LMTI_STUDIO_NODE_BINARY"));
    const QFileInfo cli(qEnvironmentVariable("LMTI_STUDIO_CLI"));
    if (!node.isAbsolute() || !cli.isAbsolute() || !node.isFile() || !cli.isFile() || node.isSymLink() ||
        cli.isSymLink())
        throw std::runtime_error("Fixture requires the trusted local Node/CLI runtime.");
    QProcess process;
    const auto launcher = QProcessEnvironment::systemEnvironment();
    QProcessEnvironment environment;
    for (const auto &key : {"SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"})
        if (launcher.contains(key))
            environment.insert(key, launcher.value(key));
    environment.insert("LMTI_STUDIO_ALLOW_LESSON_REVIEW",
                       launcher.value("LMTI_STUDIO_ALLOW_LESSON_REVIEW", "0"));
    process.setProcessEnvironment(environment);
    process.setWorkingDirectory(directory);
    process.start(node.canonicalFilePath(), QStringList{cli.canonicalFilePath()} + arguments);
    process.write(input);
    process.closeWriteChannel();
    if (!process.waitForFinished(10000)) {
        process.kill();
        process.waitForFinished(1000);
        throw std::runtime_error("Fixture owner process timed out.");
    }
    const auto output = process.readAllStandardOutput();
    if (process.exitStatus() != QProcess::NormalExit || process.exitCode() != 0 ||
        output.size() > 2 * 1024 * 1024)
        throw std::runtime_error("Fixture owner command failed.");
    QJsonParseError error;
    const auto parsed = QJsonDocument::fromJson(output, &error);
    if (error.error != QJsonParseError::NoError || !parsed.isObject())
        throw std::runtime_error("Fixture owner returned invalid JSON.");
    return parsed.object();
}
} // namespace

bool create_design_knowledge_fixture(const QString &directory, const QString &project_id) {
    try {
        const QFileInfo root(directory);
        // Refuse an existing source rather than populating real project memory.
        if (!root.isDir() || root.isSymLink() || QFileInfo::exists(QDir(directory).filePath(".lmti")) ||
            !QDir(directory).mkdir(".lmti"))
            return false;
        const QJsonObject amf{
            {"version", "0.1.0"},
            {"project", QJsonObject{{"name", "Synthetic Factory Monitor"},
                                    {"root", root.canonicalFilePath()},
                                    {"compiledAt", "2026-10-12T00:00:00Z"}}},
            {"modules",
             QJsonArray{
                 QJsonObject{{"name", "Sampling pipeline"},
                             {"summary", "Coordinate firmware sampling and the declared gateway contract."},
                             {"privacy", "public"}},
                 QJsonObject{{"name", "Project boundary"},
                             {"summary", "Keep saved native metadata separate from project memory."},
                             {"privacy", "public"}}}},
            {"files", QJsonArray{}},
            {"architecture", QJsonArray{}},
            {"rules", QJsonArray{}},
            {"summaries", QJsonArray{}}};
        QFile map(QDir(directory).filePath(".lmti/project.amf.json"));
        const auto bytes = QJsonDocument(amf).toJson();
        if (!map.open(QIODevice::WriteOnly | QIODevice::NewOnly) || map.write(bytes) != bytes.size())
            return false;
        map.close();
        const std::vector<std::pair<QString, QString>> records{
            {"Sampling contract",
             "Use the declared sampling contract for the synthetic firmware and gateway."},
            {"Desired version boundary",
             "Desired software bindings are project metadata. Observed versions remain unknown."},
            {"Saved revision review",
             "Review work proposals against the current saved revision before applying a draft change."}};
        for (const auto &[title, content] : records)
            owner_command(directory, {"memory", "add", "--title", title, "--content", content, "--zone",
                                      "architecture", "--privacy-level", "internal"});
        // Actually verify the owning adapter before recording fixture evidence.
        const auto snapshot =
            owner_command(directory, {"desktop-bridge"},
                          QJsonDocument(QJsonObject{{"schema", "lmti.desktop.knowledge.v1"},
                                                    {"operation", "snapshot"},
                                                    {"projectId", project_id},
                                                    {"sourceRoot", root.canonicalFilePath()},
                                                    {"sourceId", ""},
                                                    {"target", "external"}})
                              .toJson(QJsonDocument::Compact));
        if (snapshot.value("schema") != "lmti.desktop.knowledge.v1" ||
            snapshot.value("projectId") != project_id || snapshot.value("target") != "external" ||
            snapshot.value("projectMap").toArray().size() != 2 ||
            snapshot.value("memories").toArray().size() != 3)
            return false;
        for (const auto &memory : snapshot.value("memories").toArray())
            if (memory.toObject().value("privacy") != "internal")
                return false;
        owner_command(directory, {"memory", "lesson", "propose", "--task",
                                  "Verify the disposable source fixture", "--summary",
                                  "The owning adapter returned two public modules and three synthetic memory "
                                  "summaries in the requested project scope.",
                                  "--commands", "desktop-bridge fixture scope check:0", "--tests",
                                  "scoped synthetic metadata check:pass", "--outcome", "pass", "--lesson",
                                  "Keep project memory reads within the verified source and project scope.",
                                  "--suggested-verification", "Repeat the bounded source scope check"});
        return true;
    } catch (const std::exception &) {
        return false;
    }
}
