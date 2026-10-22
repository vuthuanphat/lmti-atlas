// Private operator façade. Called with launcher-owned locations, never Agent/browser paths.
#include "project_operations.hpp"
#include "project_operation_writes.hpp"
#include "project_upgrade_recovery.hpp"
#include "logical_hierarchy.hpp"
#include "physical_hierarchy.hpp"
#include "original_binding_read.hpp"
#include "lmti/mcp_profile_store.hpp"
#include "lmti/project_library.hpp"
#include "../common/local_owner_path.hpp"
#include "../common/strict_json.hpp"
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSet>
#include <QRegularExpression>
#include <algorithm>
#include <cmath>
#include <optional>

namespace {
struct Refused { QString code; };
void need(bool condition, const char *code = "INVALID_INPUT") {
    if (!condition) throw Refused{QString::fromLatin1(code)};
}
void fields(const QJsonObject &o, const QSet<QString> &keys) {
    need(o.size() == keys.size());
    for (auto i = o.begin(); i != o.end(); ++i) need(keys.contains(i.key()));
}
QString text(const QJsonObject &o, const char *key, int cap = 1024) {
    need(o.value(key).isString()); const auto s = o.value(key).toString();
    need(s.toUtf8().size() <= cap && !s.contains(QChar(0))); return s;
}
bool boolean(const QJsonObject &o, const char *key) { need(o.value(key).isBool()); return o.value(key).toBool(); }
qint64 revision(const QJsonObject &o, const char *key) {
    need(o.value(key).isDouble()); auto n = o.value(key).toDouble();
    need(std::isfinite(n) && n >= 0 && n <= 9007199254740991.0 && std::floor(n) == n);
    return static_cast<qint64>(n);
}
void safe_path(const QString &s, bool required = true, bool folder = false) {
    try { lmti::detail::local_owner_path(s,required,folder); }
    catch (const lmti::Error &) { throw Refused{"OWNER_UNAVAILABLE"}; }
}
using LibraryView = std::optional<lmti::LibraryInspection>;
LibraryView library_view(const QString &path) {
    safe_path(path,false);
    if (!QFileInfo::exists(path)) return std::nullopt;
    return lmti::inspect_project_library(path);
}
QJsonValue library_identity(const LibraryView &view) {
    if (!view) return QJsonValue(QJsonValue::Null);
    const auto &token = view->token;
    return QJsonObject{{"schema",token.schema},{"canonicalPath",token.canonical_path},
        {"uuid",token.schema == 1 ? QJsonValue(QJsonValue::Null) : QJsonValue(token.library_uuid)},
        {"generation",token.schema == 1 ? QJsonValue(QJsonValue::Null) : QJsonValue(token.generation)},
        {"digest",token.digest}};
}
const lmti::LibraryEntry *selected_entry(const LibraryView &view,const QString &id) {
    if (!view) return nullptr;
    const auto entry = std::find_if(view->entries.begin(),view->entries.end(),[&](const auto &e) { return e.id == id; });
    return entry == view->entries.end() ? nullptr : &*entry;
}
void recheck_library(const QString &path,const LibraryView &before,const QSet<QString> &ids = {}) {
    const auto current = library_view(path);
    need(before.has_value() == current.has_value(),"CONFIG_CHANGED");
    if (!before) return;
    need(before->token == current->token,"CONFIG_CHANGED");
    for (const auto &id : ids) {
        const auto a = selected_entry(before,id), b = selected_entry(current,id);
        // Labels, pins and opened timestamps are cosmetic. The token separately
        // protects nullable root-key distinctions and every authority binding.
        need(a && b && a->id == b->id && a->path == b->path && a->folder == b->folder,"CONFIG_CHANGED");
    }
}
QJsonObject project_identity(const lmti::ProjectDocument &document) {
    const auto &lineage = document.storage_lineage;
    return {{"schema",lineage ? lineage->schema_version : 1},
        {"storeUuid",lineage ? QJsonValue(QString::fromStdString(lineage->store_uuid)) : QJsonValue(QJsonValue::Null)},
        {"revision",document.topology.revision}};
}
QJsonObject binding_json(const LibraryView &library,const lmti::LibraryEntry &entry,
                         const lmti::ProjectDocument &document) {
    need(library.has_value(),"SCOPE_DENIED");
    return {{"id",entry.id},{"name",QString::fromStdString(document.project.label)},
        {"database",entry.path},{"root",entry.folder},{"projectRevision",document.topology.revision},
        {"libraryIdentity",library_identity(library)},{"projectIdentity",project_identity(document)}};
}
lmti::McpIntegrationBinding integration(const QJsonValue &value, const QString &project) {
    need(value.isObject()); const auto o = value.toObject();
    fields(o,{"configPath","projectId","site","target","sha256"});
    const auto path = text(o,"configPath"), id = text(o,"projectId",64), site = text(o,"site",64);
    const auto target = text(o,"target",8), sha = text(o,"sha256",64);
    need(QRegularExpression("^[0-9a-f]{64}$").match(sha).hasMatch());
    try { lmti::validate_id(id.toStdString()); lmti::validate_id(site.toStdString()); }
    catch (const lmti::Error &) { throw Refused{"INVALID_INPUT"}; }
    need(id == project && target == "external","SCOPE_DENIED");
    safe_path(path);
    return {path,id.toStdString(),site.toStdString(),target.toStdString(),sha.toLatin1()};
}
QJsonObject profile_json(const lmti::McpProfile &p) {
    QJsonArray servers;
    for (const auto &s : p.servers) {
        QJsonObject o{{"id", QString::fromStdString(s.id)}, {"label", QString::fromStdString(s.label)}, {"enabled", s.enabled}};
        if (s.transport == lmti::McpTransport::LmtiLocal) {
            o["transport"] = "lmti_local"; o["auth"] = "none"; o["site"] = QString::fromStdString(s.site);
        } else {
            o["transport"] = "remote_https"; o["auth"] = "client_oauth";
            o["endpoint"] = QString::fromStdString(s.endpoint); o["privateEndpoint"] = s.private_endpoint;
        }
        servers.append(o);
    }
    return {{"projectId", QString::fromStdString(p.project_id)}, {"revision", p.revision}, {"servers", servers}};
}
lmti::McpProfile parse_profile(const QJsonObject &request, const lmti::ProjectDocument &d) {
    lmti::McpProfile p{d.project.id, revision(request, "expectedRevision"), {}};
    need(request.value("servers").isArray() && request.value("servers").toArray().size() <= 32);
    for (const auto &v : request.value("servers").toArray()) {
        need(v.isObject()); const auto o = v.toObject(); lmti::McpServer s;
        s.id = text(o,"id",48).toStdString(); s.label = text(o,"label",120).toStdString(); s.enabled = boolean(o,"enabled");
        const auto transport = text(o,"transport",20), auth = text(o,"auth",20);
        if (transport == "lmti_local") {
            fields(o,{"id","label","enabled","transport","auth","site"}); need(auth == "none");
            s.transport = lmti::McpTransport::LmtiLocal; s.auth = lmti::McpAuth::None; s.site = text(o,"site",64).toStdString();
            need(std::any_of(d.topology.assets.begin(), d.topology.assets.end(), [&](const auto &a) { return a.site == s.site; }));
        } else {
            fields(o,{"id","label","enabled","transport","auth","endpoint","privateEndpoint"});
            need(transport == "remote_https" && auth == "client_oauth");
            s.endpoint = text(o,"endpoint",512).toStdString(); s.private_endpoint = boolean(o,"privateEndpoint");
        }
        p.servers.push_back(s);
    }
    try { lmti::validate_mcp_endpoints(p); } catch (const lmti::Error &) { throw Refused{"INVALID_INPUT"}; }
    return p;
}
} // namespace
int main(int argc, char **argv) {
    QCoreApplication app(argc,argv); QJsonObject result;
    if (app.arguments().size() > 1 && app.arguments()[1] == "--original-binding-read")
        return original_binding_read_main(app.arguments());
    if (app.arguments().size() > 1 && app.arguments()[1] == "--project-operations")
        return project_operations_main(app.arguments());
    if (app.arguments().size() > 1 && app.arguments()[1] == "--project-operation-write")
        return project_operation_writes_main(app.arguments());
    if (app.arguments().size() > 1 && app.arguments()[1] == "--project-operation-recovery")
        return project_upgrade_recovery_main(app.arguments());
    if (app.arguments().size() > 1 && (app.arguments()[1] == "--logical-hierarchy-read" ||
        app.arguments()[1] == "--logical-hierarchy-write"))
        return logical_hierarchy_main(app.arguments());
    if (app.arguments().size() > 1 && (app.arguments()[1] == "--physical-hierarchy-read" ||
        app.arguments()[1] == "--physical-hierarchy-write"))
        return physical_hierarchy_main(app.arguments());
    QFile output; if (!output.open(stdout,QIODevice::WriteOnly)) return 1;
    QByteArray committed_output;
    bool committed_save = false;
    try {
        const auto args = app.arguments(); need(args.size() == 11);
        for (int i = 1; i < 11; i += 2) need(args[i] == QStringList{"--library","--profiles","--python","--entry","--binary"}[(i-1)/2]);
        safe_path(args[2],false); safe_path(args[4],false);
        QFile input; need(input.open(stdin,QIODevice::ReadOnly)); const auto bytes = input.read(128*1024+1); need(bytes.size() <= 128*1024);
        QJsonObject request;
        try { request = lmti::detail::strict_json_object(bytes,128*1024); }
        catch (const lmti::Error &) { throw Refused{"INVALID_INPUT"}; }
        const auto action = text(request,"action",20);
        const auto library = library_view(args[2]);
        const auto entries = library ? library->entries : std::vector<lmti::LibraryEntry>{};
        if (action == "library" || action == "summaries") {
            QSet<QString> selected, reviewed;
            if (action == "library") fields(request,{"action"});
            else {
                fields(request,{"action","ids"}); need(request.value("ids").isArray() && request.value("ids").toArray().size() <= 100);
                for (const auto &v : request.value("ids").toArray()) { need(v.isString()); need(!selected.contains(v.toString())); selected.insert(v.toString()); }
                reviewed = selected;
            }
            QJsonArray items;
            for (const auto &e : entries) {
                if (action == "library") items.append(QJsonObject{{"id",e.id},{"name",e.label},{"database",e.path},{"root",e.folder}});
                else if (selected.remove(e.id)) {
                    safe_path(e.path); if (!e.folder.isEmpty()) safe_path(e.folder,true,true);
                    const auto d = lmti::load_project_metadata(e.path); need(d.project.id == e.id.toStdString(),"SCOPE_DENIED");
                    const auto p = lmti::load_mcp_profile(args[4],d.project.id);
                    items.append(QJsonObject{{"id",e.id},{"name",QString::fromStdString(d.project.label)},
                        {"projectRevision",d.revision},{"profileRevision",p.revision},{"linkedRoot",!e.folder.isEmpty()}});
                }
            }
            need(selected.isEmpty(),"SCOPE_DENIED");
            recheck_library(args[2],library,reviewed);
            result = {{"ok",true},{"libraryIdentity",library_identity(library)},{"items",items}};
        } else {
            const auto id = text(request,"projectId",64);
            auto entry = std::find_if(entries.begin(),entries.end(),[&](const auto &e) { return e.id == id; });
            need(entry != entries.end(),"SCOPE_DENIED"); safe_path(entry->path);
            if (!entry->folder.isEmpty()) safe_path(entry->folder,true,true);
            const auto document = lmti::load_project(entry->path); need(document.project.id == id.toStdString(),"SCOPE_DENIED");
            auto profile = lmti::load_mcp_profile(args[4],document.project.id);
            if (action == "read") fields(request,{"action","projectId"});
            else if (action == "save") {
                fields(request,{"action","projectId","expectedRevision","servers"}); profile = parse_profile(request,document);
                need(profile.revision < 9007199254740991LL,"REVISION_CONFLICT");
                // The profile owner guarantees expected revision + 1 under CAS.
                // Prepare the entire success payload before writing. The binding
                // denotes this checked prewrite snapshot, not a cross-store lock.
                auto saved = profile; ++saved.revision;
                const QJsonObject success{{"ok",true},{"profile",profile_json(saved)},
                    {"binding",binding_json(library,*entry,document)}};
                committed_output = QJsonDocument(success).toJson(QJsonDocument::Compact)+"\n";
                recheck_library(args[2],library,{id});
                (void)lmti::save_mcp_profile(args[4],profile);
                committed_save = true;
            } else if (action == "generate") {
                if (request.contains("integration")) fields(request,{"action","projectId","client","expectedRevision","integration"});
                else fields(request,{"action","projectId","client","expectedRevision"});
                need(profile.revision == revision(request,"expectedRevision"),"REVISION_CONFLICT"); need(profile.revision > 0);
                const auto client = text(request,"client",8); need(client == "codex" || client == "cursor");
                for (const auto &s : profile.servers) if (s.transport == lmti::McpTransport::LmtiLocal) {
                    need(std::any_of(document.topology.assets.begin(),document.topology.assets.end(),[&](const auto &a) { return a.site == s.site; }),"SCOPE_DENIED");
                }
                safe_path(args[6]); safe_path(args[8]); safe_path(args[10]);
                lmti::McpRuntime runtime{args[6],args[8],args[10],entry->path};
                if (request.contains("integration")) runtime.integration = integration(request.value("integration"),id);
                const auto generated = lmti::generate_mcp_config(profile,client == "codex" ? lmti::McpClient::Codex : lmti::McpClient::Cursor,runtime);
                result["content"] = QString::fromUtf8(generated.content);
                result["servers"] = QJsonDocument::fromJson(generated.servers_json).object();
            } else throw Refused{"INVALID_INPUT"};
            if (!committed_save) {
                recheck_library(args[2],library,{id});
                result["ok"] = true; result["profile"] = profile_json(profile);
                result["binding"] = binding_json(library,*entry,document);
            }
        }
    } catch (const lmti::McpRevisionConflict &) { result = {{"ok",false},{"code","REVISION_CONFLICT"}};
    } catch (const lmti::McpIntegrationScopeDenied &) { result = {{"ok",false},{"code","SCOPE_DENIED"}};
    } catch (const lmti::McpIntegrationChanged &) { result = {{"ok",false},{"code","CONFIG_CHANGED"}};
    } catch (const Refused &e) { result = {{"ok",false},{"code",e.code}};
    } catch (const std::exception &) { result = {{"ok",false},{"code","OWNER_UNAVAILABLE"}}; }
    // Do not turn a confirmed mutation into a simple CONFIG_CHANGED failure by
    // adding a postwrite recheck. Transport loss is still an unknown outcome.
    if (committed_save) output.write(committed_output);
    else output.write(QJsonDocument(result).toJson(QJsonDocument::Compact)+"\n");
    return 0;
}
