#include "lmti/mcp_profile_store.hpp"
#include "../common/local_owner_path.hpp"
#include "../common/strict_json.hpp"
#include <QCryptographicHash>
#include <QDir>
#include <QFileInfo>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QUrl>
#include <QUuid>
#include <QVariant>

namespace lmti {
namespace {
constexpr int application_id = 0x4c4d4350; // LMCP, separate from project/library/memory.
class Db {
    QString connection;
  public:
    QSqlDatabase db;
    explicit Db(const QString &path, bool read) {
        QFileInfo file(path);
        const bool existed = file.exists();
        if (!file.isAbsolute() || file.isSymLink() || file.isJunction() || !file.dir().exists() ||
            (file.exists() && (!file.isFile() || file.size() > 8 * 1024 * 1024)))
            throw Error("MCP profile storage is unavailable.");
        // Reject symlink/junction ancestors rather than resolving writes elsewhere.
        auto ancestor = file.dir().absolutePath();
        while (true) {
            QFileInfo parent(ancestor);
            if (parent.isSymLink() || parent.isJunction())
                throw Error("Linked MCP storage directories are unsupported.");
            const auto next = parent.dir().absolutePath();
            if (next == ancestor)
                break;
            ancestor = next;
        }
        connection = QUuid::createUuid().toString(QUuid::Id128);
        db = QSqlDatabase::addDatabase("QSQLITE", connection);
        db.setDatabaseName(path);
        db.setConnectOptions(read ? "QSQLITE_OPEN_READONLY;QSQLITE_BUSY_TIMEOUT=2000" :
                                   "QSQLITE_BUSY_TIMEOUT=2000");
        try {
            if (!db.open())
                throw Error("Cannot open MCP profile storage.");
            run("PRAGMA trusted_schema=OFF");
            if (existed) {
                if (number("PRAGMA application_id") != application_id || number("PRAGMA user_version") != 1 ||
                    number("SELECT count(*) FROM sqlite_schema WHERE type IN('trigger','view')") != 0)
                    throw Error("Unsupported MCP profile format.");
            } else {
                run("BEGIN IMMEDIATE");
                run(QString("PRAGMA application_id=%1").arg(application_id));
                run("PRAGMA user_version=1");
                run("CREATE TABLE profiles(project TEXT PRIMARY KEY,revision INTEGER NOT NULL)");
                run("CREATE TABLE servers(project TEXT NOT NULL,id TEXT NOT NULL,label TEXT NOT NULL,"
                    "transport INTEGER NOT NULL,auth INTEGER NOT NULL,endpoint TEXT NOT NULL,"
                    "site TEXT NOT NULL,enabled INTEGER NOT NULL,private_endpoint INTEGER NOT NULL,"
                    "PRIMARY KEY(project,id))");
                run("COMMIT");
            }
            if (read)
                run("PRAGMA query_only=ON");
            if (number("SELECT count(*) FROM profiles") > 1000 ||
                number("SELECT count(*) FROM servers") > 32000)
                throw Error("MCP store exceeds metadata limits.");
        } catch (...) {
            db.close(); db = {}; QSqlDatabase::removeDatabase(connection); throw;
        }
    }
    ~Db() { db.close(); db = {}; QSqlDatabase::removeDatabase(connection); }
    void run(const QString &sql) {
        QSqlQuery q(db);
        if (!q.exec(sql)) throw Error("MCP storage operation failed.");
    }
    qint64 number(const QString &sql) {
        QSqlQuery q(db);
        if (!q.exec(sql) || !q.next()) throw Error("Invalid MCP storage metadata.");
        bool ok = false;
        auto value = q.value(0).toLongLong(&ok);
        if (!ok) throw Error("Invalid MCP storage integer.");
        return value;
    }
    QSqlQuery query(const QString &sql, const QVariantList &values) {
        QSqlQuery q(db);
        if (!q.prepare(sql)) throw Error("Cannot prepare MCP storage operation.");
        for (const auto &value : values) q.addBindValue(value);
        if (!q.exec()) throw Error("MCP storage operation failed.");
        return q;
    }
};
std::string text(const QVariant &value, int limit) {
    if (value.metaType().id() != QMetaType::QString || value.toString().toUtf8().size() > limit)
        throw Error("Invalid MCP stored text.");
    return value.toString().toStdString();
}
qint64 integer(const QVariant &value) {
    if (value.metaType().id() != QMetaType::Int && value.metaType().id() != QMetaType::LongLong)
        throw Error("Invalid MCP stored integer.");
    return value.toLongLong();
}
QString quote(const QString &value) {
    const auto bytes = QJsonDocument(QJsonArray{value}).toJson(QJsonDocument::Compact);
    return QString::fromUtf8(bytes.mid(1, bytes.size() - 2));
}
void runtime_file(const QString &path) {
    QFileInfo file(path);
    if (!file.isAbsolute() || !file.isFile() || file.isSymLink() || file.canonicalFilePath().isEmpty())
        throw Error("Configure trusted LMTI launcher paths and save the project first.");
}
QString integration_path(const McpProfile &profile, const McpRuntime &runtime) {
    if (!runtime.integration) return {};
    const auto &binding = *runtime.integration;
    validate_id(binding.project_id); validate_id(binding.site);
    if (binding.project_id != profile.project_id || binding.target != "external")
        throw McpIntegrationScopeDenied("Integration scope is unavailable.");
    for (const auto &server : profile.servers)
        if (server.enabled && server.transport == McpTransport::LmtiLocal && server.site != binding.site)
            throw McpIntegrationScopeDenied("Integration scope is unavailable.");
    if (!QRegularExpression("^[0-9a-f]{64}$").match(QString::fromLatin1(binding.sha256)).hasMatch())
        throw Error("Invalid integration fingerprint.");
    const auto path = detail::local_owner_path(binding.config_path);
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly) || file.size() > 64*1024)
        throw Error("Integration configuration unavailable.");
    const auto bytes = file.read(64*1024+1);
    if (bytes.isEmpty() || bytes.size() > 64*1024 || file.error() != QFileDevice::NoError || file.size() != bytes.size())
        throw Error("Integration configuration unavailable.");
    if (QCryptographicHash::hash(bytes,QCryptographicHash::Sha256).toHex() != binding.sha256)
        throw McpIntegrationChanged("Integration configuration changed.");
    const auto object = detail::strict_json_object(bytes,64*1024);
    const bool reviewed = object.value("schema") == "lmti.agent.integration.v3";
    const bool structure = reviewed || object.value("schema") == "lmti.agent.integration.v2";
    QSet<QString> keys{"schema","projectId","site","target","knowledge","observations"};
    if (structure) keys.insert("structure");
    if (object.size() != keys.size()) throw Error("Invalid integration configuration.");
    for (auto it = object.begin(); it != object.end(); ++it)
        if (!keys.contains(it.key())) throw Error("Invalid integration configuration.");
    if ((!structure && object.value("schema") != "lmti.agent.integration.v1") ||
        (structure && (!object.value("structure").isBool() || !object.value("structure").toBool())) ||
        !(object.value("knowledge").isNull() || object.value("knowledge").isObject()) ||
        !(object.value("observations").isNull() || object.value("observations").isObject()) ||
        (reviewed && (!object.value("knowledge").isObject() ||
            object.value("knowledge").toObject().value("mode") != "reviewed")))
        throw Error("Invalid integration configuration.");
    if (object.value("projectId") != QString::fromStdString(binding.project_id) ||
        object.value("site") != QString::fromStdString(binding.site) || object.value("target") != "external")
        throw McpIntegrationScopeDenied("Integration scope is unavailable.");
    // Python validates the complete schema again and checks this pin at launch.
    if (detail::local_owner_path(binding.config_path) != path)
        throw McpIntegrationChanged("Integration configuration changed.");
    return path;
}
} // namespace
void validate_mcp_endpoints(const McpProfile &profile) {
    validate(profile);
    for (const auto &server : profile.servers) {
        if (server.transport != McpTransport::RemoteHttps) continue;
        const auto value = QString::fromStdString(server.endpoint);
        const QUrl url(value, QUrl::StrictMode);
        const auto host = url.host().toLower();
        if (!url.isValid() || url.scheme() != "https" || host.isEmpty() ||
            !url.userInfo().isEmpty() || url.hasQuery() || url.hasFragment() ||
            url.port(443) != 443 || value.contains('%') ||
            host == "metadata.google.internal" || host.startsWith("169.254.") ||
            host == "0.0.0.0" || host == "::" || host.startsWith("fe80:"))
            throw Error("MCP endpoint must be HTTPS on port 443 without URL credentials or metadata hosts.");
    }
}
McpProfile load_mcp_profile(const QString &path, const std::string &project) {
    validate_id(project);
    McpProfile result{project, 0, {}};
    if (!QFileInfo::exists(path)) return result;
    Db storage(path, true);
    storage.run("BEGIN");
    auto q = storage.query("SELECT revision FROM profiles WHERE project=?", {QString::fromStdString(project)});
    if (!q.next()) return result;
    result.revision = integer(q.value(0));
    q = storage.query("SELECT id,label,transport,auth,endpoint,site,enabled,private_endpoint FROM servers "
                      "WHERE project=? ORDER BY id LIMIT 33", {QString::fromStdString(project)});
    while (q.next()) {
        const auto transport = integer(q.value(2)), auth = integer(q.value(3));
        const auto enabled = integer(q.value(6)), priv = integer(q.value(7));
        if (transport < 0 || transport > 1 || auth < 0 || auth > 1 || enabled < 0 || enabled > 1 || priv < 0 || priv > 1)
            throw Error("Invalid MCP stored enum.");
        result.servers.push_back({text(q.value(0), 48), text(q.value(1), 120), text(q.value(4), 512),
                                 text(q.value(5), 64), static_cast<McpTransport>(transport),
                                 static_cast<McpAuth>(auth), enabled == 1, priv == 1});
    }
    validate_mcp_endpoints(result);
    return result;
}
std::int64_t save_mcp_profile(const QString &path, const McpProfile &profile) {
    validate_mcp_endpoints(profile);
    Db storage(path, false);
    storage.run("BEGIN IMMEDIATE");
    try {
        const auto project = QString::fromStdString(profile.project_id);
        auto current = storage.query("SELECT revision FROM profiles WHERE project=?", {project});
        const auto exists = current.next();
        if ((exists ? integer(current.value(0)) : 0) != profile.revision)
            throw McpRevisionConflict("MCP profile changed elsewhere. Reload before saving.");
        current.finish();
        if (!exists && storage.number("SELECT count(*) FROM profiles") >= 1000)
            throw Error("MCP project limit exceeded.");
        const auto revision = profile.revision + 1;
        if (revision > 9007199254740991LL) throw Error("MCP revision exhausted.");
        storage.query("INSERT INTO profiles VALUES(?,?) ON CONFLICT(project) DO UPDATE SET revision=excluded.revision",
                      {project, revision});
        storage.query("DELETE FROM servers WHERE project=?", {project});
        for (const auto &s : profile.servers)
            storage.query("INSERT INTO servers VALUES(?,?,?,?,?,?,?,?,?)",
                          {project, QString::fromStdString(s.id), QString::fromStdString(s.label),
                           static_cast<int>(s.transport), static_cast<int>(s.auth),
                           QString::fromStdString(s.endpoint), QString::fromStdString(s.site),
                           s.enabled ? 1 : 0, s.private_endpoint ? 1 : 0});
        if (!storage.db.commit()) throw Error("Cannot commit MCP profile.");
        return revision;
    } catch (...) { storage.db.rollback(); throw; }
}
McpGeneration generate_mcp_config(const McpProfile &profile, McpClient client, const McpRuntime &runtime) {
    validate_mcp_endpoints(profile);
    if (client != McpClient::Codex && client != McpClient::Cursor)
        throw Error("Unsupported MCP client.");
    const auto integrated_path = integration_path(profile,runtime);
    QJsonObject servers;
    QString toml = "# LMTI project MCP profile revision " + QString::number(profile.revision) + "\n";
    for (const auto &s : profile.servers) {
        if (!s.enabled) continue;
        QJsonObject config;
        const auto key = QString::fromStdString(s.id);
        toml += "\n[mcp_servers." + quote(key) + "]\n";
        if (s.transport == McpTransport::RemoteHttps) {
            const auto url = QString::fromStdString(s.endpoint);
            config["url"] = url;
            toml += "url = " + quote(url) + "\n";
            // Both clients own their OAuth state; no credential values exported.
        } else {
            for (const auto &path : {runtime.python, runtime.entry, runtime.binary, runtime.database}) runtime_file(path);
            QJsonArray args{"-I", runtime.entry, "--binary", runtime.binary, "--database", runtime.database,
                            "--project", QString::fromStdString(profile.project_id), "--site",
                            QString::fromStdString(s.site), "--target", "external"};
            if (runtime.integration) {
                args.append("--integration-config"); args.append(integrated_path);
                args.append("--integration-sha256"); args.append(QString::fromLatin1(runtime.integration->sha256));
            }
            config["command"] = runtime.python;
            config["args"] = args;
            toml += "command = " + quote(runtime.python) + "\nargs = " +
                    QString::fromUtf8(QJsonDocument(args).toJson(QJsonDocument::Compact)) + "\n";
        }
        servers[key] = config;
    }
    const auto json = QJsonDocument(servers).toJson(QJsonDocument::Compact);
    const auto content = client == McpClient::Codex ? toml.toUtf8() :
        QJsonDocument(QJsonObject{{"mcpServers", servers}}).toJson(QJsonDocument::Indented);
    return {client, content, json, QCryptographicHash::hash(content, QCryptographicHash::Sha256).toHex(),
            profile.revision};
}
} // namespace lmti
