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
#include <QProcess>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QTemporaryDir>
#include <QUuid>
#include <iostream>
#include <algorithm>
#include <cstdio>
#ifdef Q_OS_WIN
#include <fcntl.h>
#include <io.h>
#endif

namespace {
void need(bool value,const char *message) { if (!value) throw lmti::Error(message); }
QString at(const QString &root,const QString &name) { return QDir(root).filePath(name); }
QByteArray bytes(const QString &path) {
    QFile file(path); need(file.open(QIODevice::ReadOnly),"Fixture read failed."); return file.readAll();
}
void write_new(const QString &path,const QByteArray &value) {
    QFile file(path); need(file.open(QIODevice::WriteOnly|QIODevice::NewOnly) && file.write(value) == value.size(),"Fixture write failed.");
}
QString key(QString path) {
    path = QDir::cleanPath(QDir::fromNativeSeparators(path));
#ifdef Q_OS_WIN
    path = path.toCaseFolded();
#endif
    return path;
}
QJsonObject run(const QString &binary,const QString &root,const QJsonObject &request) {
    QProcess child; child.setProgram(binary);
    child.setArguments({"--library",at(root,"library.sqlite"),"--profiles",at(root,"profiles.sqlite"),
        "--python",at(root,"runtime-file"),"--entry",at(root,"runtime-file"),"--binary",at(root,"runtime-file")});
    child.start(); need(child.waitForStarted(5000),"Native facade did not start.");
    const auto input = QJsonDocument(request).toJson(QJsonDocument::Compact);
    need(child.write(input) == input.size(),"Native input failed."); child.closeWriteChannel();
    if (!child.waitForFinished(15000)) { child.kill(); child.waitForFinished(5000); throw lmti::Error("Read-only facade deadline."); }
    need(child.exitStatus() == QProcess::NormalExit && child.exitCode() == 0 && child.readAllStandardError().isEmpty(),"Native facade failed privately.");
    const auto output = child.readAllStandardOutput(); need(output.size() <= 256*1024,"Facade output cap.");
    QJsonParseError error; const auto parsed = QJsonDocument::fromJson(output,&error);
    need(error.error == QJsonParseError::NoError && parsed.isObject(),"Facade JSON invalid."); return parsed.object();
}
QJsonObject fixture_manifest(const QString &root) {
    const auto value = QJsonDocument::fromJson(bytes(at(root,"binding-fixture.json"))).object();
    need(value.keys() == QStringList{"librarySchema","projectSchema","schema"} &&
        value.value("schema") == "lmti.binding.fixture.v1" &&
        (value.value("librarySchema") == 1 || value.value("librarySchema") == 2 || value.value("librarySchema") == 3) &&
        (value.value("projectSchema") == 1 || value.value("projectSchema") == 2),
        "Only an exactly marked disposable fixture can be mutated."); return value;
}
void make_fixture(const QString &root,int library_schema,int project_schema) {
    need(library_schema >= 1 && library_schema <= 3 && (project_schema == 1 || project_schema == 2),"Fixture schema invalid.");
    need(QFileInfo(root).isDir() && !QFileInfo(root).isSymLink() &&
        QDir(root).entryList(QDir::NoDotAndDotDot|QDir::AllEntries).isEmpty(),"Use a fresh empty fixture directory.");
    need(QDir(root).mkdir("project-root") && QDir(root).mkdir("other-root") && QDir(root).mkdir("backups"),"Fixture directory creation failed.");
    auto d = lmti::demo_project();
    if (project_schema == 2) { d.structure.emplace(); d.structure->sites = {{"factory-demo","Factory",lmti::Privacy::Internal}}; }
    for (const auto &name : {"project.sqlite","replacement-project.sqlite"}) {
        auto copy = d; copy.topology.revision = lmti::save_project(at(root,name),copy);
        need(copy.topology.revision == 1,"Fixture revision mismatch.");
    }
    auto offline = lmti::demo_project(); offline.project.id = "offline-project"; offline.project.label = "Offline project";
    offline.topology.revision = lmti::save_project(at(root,"offline.sqlite"),offline);
    for (const auto &name : {"library.sqlite","replacement-library.sqlite"}) {
        const auto path = at(root,name);
        lmti::remember_library_project(path,{"factory-monitor","Synthetic",at(root,"project.sqlite"),at(root,"project-root"),true,0});
        lmti::remember_library_project(path,{"offline-project","Offline project",at(root,"offline.sqlite"),{}});
        if (library_schema >= 2) {
            const auto upgraded = lmti::upgrade_project_library(path,at(root,"backups"),lmti::inspect_project_library(path).token);
            need(upgraded.state == lmti::LibraryUpgradeState::Upgraded,"Fixture v2 upgrade failed.");
        }
        if (library_schema == 3) {
            const auto upgraded = lmti::upgrade_library_activation_format(path,at(root,"backups"),lmti::inspect_library_activation_upgrade(path));
            need(upgraded.state == lmti::LibraryUpgradeState::Upgraded,"Fixture v3 upgrade failed.");
        }
    }
    need(QFile::remove(at(root,"offline.sqlite")),"Offline fixture removal failed.");
    lmti::McpProfile profile{"factory-monitor",0,{{"lmti_context","LMTI context","","factory-demo",lmti::McpTransport::LmtiLocal,lmti::McpAuth::None}}};
    profile.revision = lmti::save_mcp_profile(at(root,"profiles.sqlite"),profile);
    write_new(at(root,"runtime-file"),"Inert synthetic runtime path.\n");
    write_new(at(root,"binding-fixture.json"),QJsonDocument(QJsonObject{{"schema","lmti.binding.fixture.v1"},
        {"librarySchema",library_schema},{"projectSchema",project_schema}}).toJson(QJsonDocument::Compact));
}
void mutate(const QString &root,const QString &action) {
    const auto manifest = fixture_manifest(root); const auto library = at(root,"library.sqlite");
    if (action == "cosmetics") {
        lmti::remember_library_project(library,{"factory-monitor","Updated cosmetic name",at(root,"project.sqlite"),{}});
        lmti::pin_library_project(library,"factory-monitor",false);
    } else if (action == "root-aba") {
        need(manifest.value("librarySchema").toInt() >= 2,"ABA requires durable generation.");
        const auto current = lmti::inspect_project_library(library).token;
        const auto changed = lmti::link_library_folder_cas(library,"factory-monitor",at(root,"other-root"),current);
        lmti::link_library_folder_cas(library,"factory-monitor",at(root,"project-root"),changed);
    } else if (action == "replace-library") {
        need(manifest.value("librarySchema").toInt() >= 2,"Replacement requires durable UUID.");
        need(QFile::rename(library,at(root,"retained-library.sqlite")) &&
             QFile::rename(at(root,"replacement-library.sqlite"),library),"Fixture library replacement failed.");
    } else if (action == "replace-project") {
        need(manifest.value("projectSchema").toInt() == 2,"Replacement requires native UUID.");
        need(QFile::rename(at(root,"project.sqlite"),at(root,"retained-project.sqlite")) &&
             QFile::rename(at(root,"replacement-project.sqlite"),at(root,"project.sqlite")),"Fixture project replacement failed.");
    } else if (action == "corrupt-library") {
        // Test-only corrupt stored identity; no production path accepts SQL.
        const auto connection = QUuid::createUuid().toString();
        { auto db = QSqlDatabase::addDatabase("QSQLITE",connection); db.setDatabaseName(library);
          need(db.open(),"Corruption fixture open failed.");
          { QSqlQuery q(db); need(q.exec("UPDATE library_identity SET library_uuid='invalid'"),"Corruption fixture failed."); }
          db.close(); db = {}; }
        QSqlDatabase::removeDatabase(connection);
    } else throw lmti::Error("Unsupported fixed fixture mutation.");
}
// Fixed disposable integration-fixture operations only. Production upgrade and
// desired-value writes remain separate shipped-owner commands in the caller.
QString mapping_fixture_root(const QString &raw) {
    const auto lexical = lmti::detail::local_owner_path_lexical(raw);
    const auto root = lmti::checked_project_folder(raw);
    need(lexical == root,"Mapping fixture root must be its canonical ordinary path.");
    return root;
}
QString mapping_fixture_file(const QString &root,const QString &name,bool required = true) {
    const auto path = at(root,name);
    need(lmti::detail::local_owner_path(path,required,false) == path,"Mapping fixture file path changed.");
    return path;
}
QJsonObject mapping_fixture_json(const QString &root,const QString &name) {
    QFile file(mapping_fixture_file(root,name));
    need(file.open(QIODevice::ReadOnly),"Mapping fixture marker unavailable.");
    const auto input = file.read(4097);
    need(file.atEnd() && input.size() <= 4096,"Mapping fixture marker exceeds bound.");
    return lmti::detail::strict_json_object(input,4096);
}
QString mapping_fixture_project(const QString &root) {
    need(mapping_fixture_json(root,"binding-fixture.json") == QJsonObject{
        {"schema","lmti.binding.fixture.v1"},{"librarySchema",3},{"projectSchema",2}},
        "Mapping preparation requires the exact library3/project2 fixture marker.");
    const auto project = mapping_fixture_file(root,"project.sqlite");
    const auto folder = at(root,"project-root");
    need(lmti::detail::local_owner_path(folder,true,true) == folder,"Mapping fixture folder changed.");
    const auto library = lmti::inspect_project_library(mapping_fixture_file(root,"library.sqlite"));
    need(library.token.schema == 3,"Mapping fixture requires actual library3.");
    const auto selected = std::find_if(library.entries.begin(),library.entries.end(),
        [](const auto &entry) { return entry.id == "factory-monitor"; });
    need(selected != library.entries.end() && selected->path == project && selected->folder == folder,
        "Mapping fixture library selection changed.");
    return project;
}
QJsonObject mapping_preparation_marker(const lmti::ProjectDocument &document) {
    need(document.storage_lineage.has_value(),"Mapping fixture identity unavailable.");
    return {{"schema","lmti.mapping.schema3.fixture.v1"},{"projectId","factory-monitor"},
        {"storeUuid",QString::fromStdString(document.storage_lineage->store_uuid)},
        {"assetId","machine-a"},{"siteId","factory-demo"},{"areaId","mapping-test-area"},
        {"environmentId","test"},{"preparedRevision",2}};
}
QJsonObject mapping_fixture_result(const lmti::ProjectDocument &document) {
    need(document.storage_lineage.has_value(),"Mapping fixture identity unavailable.");
    return {{"ready",true},{"projectId","factory-monitor"},
        {"storeUuid",QString::fromStdString(document.storage_lineage->store_uuid)},
        {"assetId","machine-a"},{"siteId","factory-demo"},{"areaId","mapping-test-area"},
        {"environmentId","test"},{"schema",document.storage_lineage->schema_version},
        {"revision",static_cast<qint64>(document.topology.revision)}};
}
void save_mapping_fixture(const QString &path,lmti::ProjectDocument &document) {
    const auto prior_revision = document.topology.revision;
    const auto prior_lineage = document.storage_lineage;
    document.topology.revision = lmti::save_project(path,document);
    need(document.topology.revision == prior_revision+1 && document.storage_lineage == prior_lineage,
        "Mapping fixture save did not preserve identity/revision.");
    need(lmti::load_project(path) == document,"Mapping fixture save changed unrelated typed graph.");
}
QJsonObject prepare_mapping_schema3(const QString &raw) {
    const auto root = mapping_fixture_root(raw), path = mapping_fixture_project(root);
    const auto marker = mapping_fixture_file(root,"mapping-schema3-fixture.json",false);
    need(!QFileInfo::exists(marker),"Mapping fixture was already prepared.");
    auto document = lmti::load_project(path);
    need(document.project.id == "factory-monitor" && document.topology.revision == 1 &&
        document.storage_lineage && document.storage_lineage->schema_version == 2 &&
        document.structure.has_value(),"Mapping preparation requires the original schema2 fixture.");
    auto &structure = *document.structure;
    need(structure.sites == std::vector<lmti::Site>{{"factory-demo","Factory",lmti::Privacy::Internal}} &&
        structure.areas.empty() && structure.environments.empty() && structure.asset_placements.empty() &&
        structure.subsystems.empty() && structure.component_memberships.empty(),
        "Mapping preparation requires the unchanged fixture hierarchy.");
    const auto asset = std::find_if(document.topology.assets.begin(),document.topology.assets.end(),
        [](const auto &value) { return value.id == "machine-a"; });
    need(asset != document.topology.assets.end() && asset->site == "factory-demo" &&
        asset->privacy == lmti::Privacy::Public && document.project.privacy == lmti::Privacy::Public,
        "Mapping fixture target scope changed.");
    structure.sites.front().privacy = lmti::Privacy::Public;
    structure.areas.push_back({"mapping-test-area","Mapping test area","factory-demo","",lmti::Privacy::Public});
    structure.environments.push_back({"test","Mapping test environment",lmti::Privacy::Public});
    structure.asset_placements.push_back({"machine-a","mapping-test-area","","test",std::nullopt});
    save_mapping_fixture(path,document);
    write_new(marker,QJsonDocument(mapping_preparation_marker(document)).toJson(QJsonDocument::Compact));
    return mapping_fixture_result(document);
}
QJsonObject mutate_mapping_schema3(const QString &raw,const QString &action) {
    need(action == "asset-internal" || action == "site-internal" || action == "project-internal",
        "Unsupported fixed mapping privacy mutation.");
    const auto root = mapping_fixture_root(raw), path = mapping_fixture_project(root);
    const auto marker = mapping_fixture_json(root,"mapping-schema3-fixture.json");
    auto document = lmti::load_project(path);
    need(document.project.id == "factory-monitor" && document.topology.revision >= 2 &&
        document.storage_lineage && document.storage_lineage->schema_version == 3 && document.structure &&
        marker == mapping_preparation_marker(document),"Mapping privacy mutation requires prepared schema3 identity.");
    auto &structure = *document.structure;
    const auto asset = std::find_if(document.topology.assets.begin(),document.topology.assets.end(),
        [](const auto &value) { return value.id == "machine-a"; });
    const auto site = std::find_if(structure.sites.begin(),structure.sites.end(),
        [](const auto &value) { return value.id == "factory-demo"; });
    need(asset != document.topology.assets.end() && asset->site == "factory-demo" && site != structure.sites.end() &&
        structure.areas == std::vector<lmti::Area>{{"mapping-test-area","Mapping test area","factory-demo","",lmti::Privacy::Public}} &&
        structure.environments == std::vector<lmti::Environment>{{"test","Mapping test environment",lmti::Privacy::Public}} &&
        structure.asset_placements == std::vector<lmti::AssetPlacement>{{"machine-a","mapping-test-area","","test",std::nullopt}},
        "Prepared mapping target scope changed.");
    auto &privacy = action == "asset-internal" ? asset->privacy :
        action == "site-internal" ? site->privacy : document.project.privacy;
    need(privacy == lmti::Privacy::Public,"Mapping fixture privacy mutation must be a change.");
    privacy = lmti::Privacy::Internal;
    save_mapping_fixture(path,document);
    return mapping_fixture_result(document);
}
void print_mapping_fixture(const QJsonObject &value) {
#ifdef Q_OS_WIN
    const auto descriptor = _fileno(stdout);
    need(descriptor >= 0 && _setmode(descriptor,_O_BINARY) != -1,"Mapping fixture output mode unavailable.");
#endif
    const auto output = QJsonDocument(value).toJson(QJsonDocument::Compact);
    need(output.size()+1 <= 4096,"Mapping fixture result exceeds bound.");
    std::cout.write(output.constData(),output.size()); std::cout << '\n';
    need(static_cast<bool>(std::cout),"Mapping fixture result write failed.");
}
QJsonObject selected(const QString &binary,const QString &root) {
    const auto library_before = bytes(at(root,"library.sqlite")), project_before = bytes(at(root,"project.sqlite"));
    const auto profile_before = bytes(at(root,"profiles.sqlite"));
    const auto result = run(binary,root,{{"action","read"},{"projectId","factory-monitor"}});
    need(result.value("ok").toBool(),"Selected read failed.");
    need(bytes(at(root,"library.sqlite")) == library_before && bytes(at(root,"project.sqlite")) == project_before &&
         bytes(at(root,"profiles.sqlite")) == profile_before,"Binding read changed native stores.");
    return result.value("binding").toObject();
}
void check_schema(const QString &binary,const QString &root,int schema) {
    make_fixture(root,schema,schema == 1 ? 1 : 2);
    const auto inventory = run(binary,root,{{"action","library"}});
    need(inventory.value("ok").toBool() && inventory.keys() == QStringList{"items","libraryIdentity","ok"} &&
         inventory.value("items").toArray().size() == 2,"Inventory eagerly opened unavailable project or wrong contract.");
    const auto lib = inventory.value("libraryIdentity").toObject();
    need(lib.keys() == QStringList{"canonicalPath","digest","generation","schema","uuid"} &&
         lib.value("schema").toInt() == schema && lib.value("canonicalPath").toString() == key(at(root,"library.sqlite")),"Private library identity shape mismatch.");
    need(schema == 1 ? lib.value("uuid").isNull() && lib.value("generation").isNull() :
         !lib.value("uuid").toString().isEmpty() && lib.value("generation").toDouble() == 1,"Durable identity null semantics mismatch.");
    const auto read = selected(binary,root), project = read.value("projectIdentity").toObject();
    need(read.value("libraryIdentity").toObject() == lib && project.keys() == QStringList{"revision","schema","storeUuid"} &&
         project.value("revision") == read.value("projectRevision") && project.value("schema").toInt() == (schema == 1 ? 1 : 2),"Selected identity disagrees with inventory/revision.");
    need(schema == 1 ? project.value("storeUuid").isNull() : !project.value("storeUuid").toString().isEmpty(),"Native UUID availability was invented or lost.");
    const auto summary = run(binary,root,{{"action","summaries"},{"ids",QJsonArray{"factory-monitor"}}});
    need(summary.value("ok").toBool() && summary.value("libraryIdentity").toObject() == lib &&
         summary.value("items").toArray().size() == 1 &&
         summary.value("items").toArray().at(0).toObject().keys() == QStringList{"id","linkedRoot","name","profileRevision","projectRevision"},
         "Summary changed public fields or probed offline sibling.");
    mutate(root,"cosmetics"); const auto cosmetic = selected(binary,root).value("libraryIdentity").toObject();
    need(schema == 1 ? cosmetic.value("digest") != lib.value("digest") : cosmetic == lib,"Cosmetics identity semantics changed.");
    if (schema >= 2) {
        mutate(root,"root-aba"); const auto aba = selected(binary,root).value("libraryIdentity").toObject();
        need(aba.value("digest") == lib.value("digest") && aba.value("uuid") == lib.value("uuid") &&
             aba.value("generation").toDouble() == lib.value("generation").toDouble()+2,"Root ABA lost durable generation.");
    }
}
void process_tests(const QString &binary) {
    QTemporaryDir temp; need(temp.isValid(),"Temporary fixture unavailable.");
    need(QDir(temp.path()).mkdir("missing"),"Missing fixture directory."); const auto missing = at(temp.path(),"missing");
    const auto empty = run(binary,missing,{{"action","library"}});
    need(empty == QJsonObject{{"ok",true},{"libraryIdentity",QJsonValue::Null},{"items",QJsonArray{}}} &&
         !QFileInfo::exists(at(missing,"library.sqlite")),"Missing library identity was invented or storage created.");
    for (const int schema : {1,2,3}) {
        const auto name = QString("schema-%1").arg(schema); need(QDir(temp.path()).mkdir(name),"Fixture directory.");
        check_schema(binary,at(temp.path(),name),schema);
    }
    for (const auto &action : {QString("replace-library"),QString("replace-project")}) {
        need(QDir(temp.path()).mkdir(action),"Replacement directory."); const auto root = at(temp.path(),action);
        make_fixture(root,3,2); const auto before = selected(binary,root); mutate(root,action); const auto after = selected(binary,root);
        need(before.value("database") == after.value("database") && before.value("root") == after.value("root") &&
             before.value("projectRevision") == after.value("projectRevision"),"Replacement fixture failed to isolate stable path/revision.");
        if (action == "replace-library") {
            const auto a = before.value("libraryIdentity").toObject(), b = after.value("libraryIdentity").toObject();
            need(a.value("canonicalPath") == b.value("canonicalPath") && a.value("generation") == b.value("generation") &&
                 a.value("digest") == b.value("digest") && a.value("uuid") != b.value("uuid"),"Same-path library replacement retained old identity.");
        } else need(before.value("projectIdentity").toObject().value("storeUuid") != after.value("projectIdentity").toObject().value("storeUuid"),
                    "Same-path same-revision native replacement retained old identity.");
    }
}
} // namespace
int main(int argc,char **argv) {
    QCoreApplication app(argc,argv);
    try {
        const auto args = app.arguments();
        if (args.size() == 3 && args[1] == "--prepare-mapping-schema3") {
            print_mapping_fixture(prepare_mapping_schema3(args[2])); return 0;
        }
        if (args.size() == 4 && args[1] == "--mutate-mapping-schema3") {
            print_mapping_fixture(mutate_mapping_schema3(args[2],args[3])); return 0;
        }
        if (args.size() == 5 && args[1] == "--fixture") make_fixture(lmti::checked_project_folder(args[2]),args[3].toInt(),args[4].toInt());
        else if (args.size() == 4 && args[1] == "--mutate") mutate(lmti::checked_project_folder(args[2]),args[3]);
        else { need(args.size() == 2,"Provide native facade binary."); process_tests(args[1]); }
        std::cout << "Native binding identity fixture/check completed\n"; return 0;
    } catch (...) { std::cerr << "Native binding identity check failed\n"; return 1; }
}
