#include "project_desired_asset.hpp"
#include "project_mapping_observation.hpp"
#include "project_content.hpp"
#include "library_management.hpp"
#include "lmti/project_store.hpp"
#include "lmti/project_library.hpp"
#include "lmti/storage.hpp"
#include "../common/strict_json.hpp"
#include "../common/local_owner_path.hpp"
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QTextStream>
#include <algorithm>
#include <cmath>

namespace {
// Private operator commands. The launcher supplies every location and grant;
// the Agent-facing SDK/MCP only creates proposals and has no write operation.
struct Refused {
    const char *code;
};
void need(bool condition, const char *code = "INVALID_INPUT") {
    if (!condition)
        throw Refused{code};
}
void owner_path(const QString &path) {
    // Reject network/extended paths before probing the filesystem.
    need(!path.isEmpty() && !path.contains(QChar(0)) &&
             !QDir::fromNativeSeparators(path).startsWith("//"),
         "OWNER_UNAVAILABLE");
    const QFileInfo info(path);
    need(info.isAbsolute() && info.isFile() && info.size() <= 64 * 1024 * 1024,
         "OWNER_UNAVAILABLE");
    for (auto part = info.absoluteFilePath();;) {
        const QFileInfo current(part);
        need(!current.isSymLink() && !current.isJunction(), "OWNER_UNAVAILABLE");
        const auto parent = current.dir().absolutePath();
        if (parent == part)
            break;
        part = parent;
    }
}
QJsonObject proposal_request() {
    QFile input;
    need(input.open(stdin, QIODevice::ReadOnly));
    const auto bytes = input.read(4097);
    QJsonObject request;
    try {
        request = lmti::detail::strict_json_object(bytes, 4096);
    } catch (const lmti::Error &) {
        throw Refused{"INVALID_INPUT"};
    }
    need(request.size() == 2 && request.contains("expectedProjectRevision") &&
         request.value("proposal").isObject());
    return request;
}
qint64 expected_revision(const QJsonValue &value) {
    const auto number = value.toDouble(-1);
    need(value.isDouble() && std::isfinite(number) && std::floor(number) == number &&
         number >= 1 && number <= 9007199254740990.0);
    return value.toInteger();
}
const lmti::Asset &scoped_asset(const lmti::ProjectDocument &document, const std::string &id,
                               const std::string &site, bool external) {
    const auto found = std::find_if(document.topology.assets.begin(), document.topology.assets.end(),
                                    [&](const auto &asset) { return asset.id == id; });
    need(found != document.topology.assets.end() && found->site == site &&
             (!external || found->privacy == lmti::Privacy::Public),
         "SCOPE_DENIED");
    return *found;
}
int proposal_owner(const QStringList &args) {
    QJsonObject result;
    try {
        const bool inspect = args[1] == "proposal-asset";
        need(args.size() == (inspect ? 7 : 6));
        need(args[5] == "local" || args[5] == "external");
        const auto project = args[3].toStdString(), site = args[4].toStdString();
        try {
            lmti::validate_id(project);
            lmti::validate_id(site);
            if (inspect)
                lmti::validate_id(args[6].toStdString());
        } catch (const lmti::Error &) {
            throw Refused{"INVALID_INPUT"};
        }
        lmti::ConfigProposal proposal;
        qint64 expected = 0;
        if (!inspect) {
            const auto request = proposal_request();
            expected = expected_revision(request.value("expectedProjectRevision"));
            try {
                proposal = lmti::parse_proposal(request.value("proposal").toObject());
            } catch (const lmti::Error &) {
                throw Refused{"INVALID_INPUT"};
            }
            need(proposal.site == site, "SCOPE_DENIED");
        }
        owner_path(args[2]);
        auto document = lmti::load_project(args[2]);
        // This owner version has no hierarchy-aware ancestor policy yet.
        need(!document.structure, "SCOPE_DENIED");
        const bool external = args[5] == "external";
        need(document.project.id == project &&
                 (!external || document.project.privacy == lmti::Privacy::Public),
             "SCOPE_DENIED");
        const auto &asset = scoped_asset(document, inspect ? args[6].toStdString() : proposal.asset_id,
                                        site, external);
        result = {{"ok", true},
                  {"projectId", args[3]},
                  {"projectRevision", document.topology.revision},
                  {"topologyRevision", document.topology.revision}};
        if (inspect) {
            result["asset"] = lmti::asset_json(asset);
        } else {
            // Project v1 owns one revision, shared by the embedded topology.
            // Keep both expectations explicit for the browser's reviewed state.
            need(expected == document.topology.revision &&
                     proposal.base_revision == document.topology.revision,
                 "REVISION_CONFLICT");
            need(asset.enabled == proposal.expected_enabled && asset.poll_ms == proposal.expected_poll_ms,
                 "CONFIG_CONFLICT");
            document.topology = lmti::apply_proposal(document.topology, proposal);
            const bool commit = args[1] == "commit-proposal";
            if (commit) {
                // save_project checks revision again inside BEGIN IMMEDIATE. A
                // concurrent save after review/load cannot overwrite newer state.
                owner_path(args[2]);
                try {
                    document.topology.revision = lmti::save_project(args[2], document);
                } catch (const lmti::Error &) {
                    bool changed = false;
                    try {
                        changed = lmti::load_project(args[2]).topology.revision != expected;
                    } catch (const std::exception &) {
                    }
                    throw Refused{changed ? "REVISION_CONFLICT" : "OWNER_UNAVAILABLE"};
                }
            }
            result["projectRevision"] = document.topology.revision;
            result["topologyRevision"] = document.topology.revision;
            const auto json = lmti::proposal_json(proposal);
            result["proposal"] = json;
            result["diff"] = QJsonObject{{"expected", json.value("expected")},
                                         {"desired", json.value("desired")}};
            result["status"] = commit ? "committed" : "reviewed";
            result["deviceActions"] = false;
        }
    } catch (const Refused &error) {
        result = {{"ok", false}, {"error", QJsonObject{{"code", error.code}}}};
    } catch (const std::exception &) {
        result = {{"ok", false}, {"error", QJsonObject{{"code", "OWNER_UNAVAILABLE"}}}};
    }
    // Output contains only bounded typed metadata; never raw diagnostics or paths.
    QTextStream(stdout) << QJsonDocument(result).toJson(QJsonDocument::Compact) << '\n';
    return result.value("ok").toBool() ? 0 : 1;
}
} // namespace

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    const auto args = app.arguments();
    if(args.size()>1 && (args[1]=="content-read" || args[1]=="content-review" || args[1]=="content-commit"))
        return project_content_main(args);
    if (args.size() > 1 && (args[1] == "desired-asset-read" || args[1] == "desired-asset-write" ||
                            args[1] == "proposal-format-read" || args[1] == "proposal-format-write"))
        return project_desired_asset_main(args);
    if (args.size() > 1 && (args[1] == "mapping-observation" || args[1] == "mapping-observation-v2"))
        return project_mapping_observation_main(args);
    if (args.size() > 1 && (args[1] == "proposal-asset" || args[1] == "review-proposal" ||
                            args[1] == "commit-proposal"))
        return proposal_owner(args);
    try {
        // Local operator setup only; neither command is exposed by Agent MCP or HTTP.
        if (args.size()>=2 && (args[1]=="library-state"||args[1]=="library-recover"||args[1]=="library-review"||args[1]=="library-commit")) return library_management_main(args);
        if (args.size() == 5 && args[1] == "init-project") {
            if (QFileInfo::exists(args[2]))
                throw lmti::Error("Project initialization requires a new file.");
            lmti::ProjectDocument document;
            document.project = {args[3].toStdString(), args[4].toStdString(), "", lmti::Privacy::Internal};
            lmti::validate(document);
            lmti::save_project(args[2], document);
            return 0;
        }
        if (args.size() == 5 && args[1] == "library-register") {
            const auto libraryPath = lmti::detail::local_owner_path(args[2], false);
            const auto projectPath = lmti::detail::local_owner_path(args[3], true);
            const auto folder = lmti::checked_project_folder(args[4]);
            const auto metadata = lmti::load_project_metadata(projectPath);
            const lmti::LibraryEntry entry{QString::fromStdString(metadata.project.id),
                QString::fromStdString(metadata.project.label), projectPath, folder};
            if (!QFileInfo::exists(libraryPath)) {
                lmti::initialize_project_library(libraryPath, entry);
            } else {
                const auto library = lmti::inspect_project_library(libraryPath);
                lmti::register_library_project_cas(libraryPath, entry, library.token);
            }
            return 0;
        }
        if (args.size() == 3 && args[1] == "init-demo") {
            if (QFileInfo::exists(args[2]))
                throw lmti::Error("Demo initialization requires a new file.");
            auto d = lmti::demo_project();
            lmti::save_project(args[2], d);
            return 0;
        }
        if (args.size() == 6 && args[1] == "structure-snapshot" &&
            (args[5] == "local" || args[5] == "external")) {
            const lmti::ProjectScope scope{args[3].toStdString(), args[4].toStdString(),
                                           args[5] == "external"};
            const auto result = lmti::project_structure_snapshot(args[2], scope);
            QTextStream(stdout) << QJsonDocument(result).toJson(QJsonDocument::Compact) << '\n';
            return 0;
        }
        if (args.size() == 6 && (args[1] == "snapshot" || args[1] == "agent-snapshot") &&
            (args[5] == "local" || args[5] == "external")) {
            const lmti::ProjectScope scope{args[3].toStdString(), args[4].toStdString(),
                                           args[5] == "external"};
            const auto result = lmti::project_snapshot(args[2], scope, args[1] == "agent-snapshot");
            QTextStream(stdout) << QJsonDocument(result).toJson(QJsonDocument::Compact) << '\n';
            return 0;
        }
        if (args.size() != 7 || (args[1] != "context" && args[1] != "impact") ||
            (args[5] != "local" && args[5] != "external"))
            throw lmti::Error("Usage: context <db> <project-id> <site> <local|external> <limit 1-200> | "
                              "impact <db> <project-id> <site> <local|external> <component-id> | "
                              "snapshot | agent-snapshot | structure-snapshot <db> <project-id> <site> <local|external>");
        bool valid = false;
        auto limit = args[1] == "impact" ? 200 : args[6].toInt(&valid);
        if (args[1] == "context" && (!valid || limit < 1 || limit > 200))
            throw lmti::Error("Invalid context limit.");
        auto d = lmti::load_project(args[2]);
        lmti::ProjectScope scope{args[3].toStdString(), args[4].toStdString(), args[5] == "external",
                                 static_cast<std::size_t>(limit)};
        auto result = args[1] == "impact" ? lmti::project_impact(d, scope, args[6].toStdString())
                                          : lmti::project_context(d, scope);
        QTextStream(stdout) << QJsonDocument(result).toJson(QJsonDocument::Compact) << '\n';
        return 0;
    } catch (const std::exception &) {
        // No raw database paths, labels, secrets or SQL errors at the Agent boundary.
        QTextStream(stderr)
            << "Project runtime rejected the request; check schema, trusted scope and metadata." << '\n';
        return 1;
    }
}
