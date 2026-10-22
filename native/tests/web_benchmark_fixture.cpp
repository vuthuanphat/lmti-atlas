// Bounded synthetic WEB-03 data producer. Test-only; never installed.
#include "lmti/project_store.hpp"
#include "lmti/project_library.hpp"
#include "lmti/mcp_profile_store.hpp"
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QTextStream>

namespace {
void need(bool value) { if (!value) throw lmti::Error("Synthetic benchmark rejected."); }
lmti::ProjectDocument dense_document() {
    lmti::ProjectDocument d;
    for (int i=0;i<100;++i) {
        const auto id="component-"+std::to_string(i);
        d.components.push_back({id,"Synthetic component","",lmti::ComponentKind::Library,lmti::Privacy::Public});
        d.releases.push_back({"release-"+std::to_string(i),"0.1.0",id,"","synthetic",lmti::ReleaseState::Candidate,lmti::Privacy::Public});
    }
    for (int i=0;i<200;++i) {
        lmti::Asset a;a.id="asset-"+std::to_string(i);a.label="Synthetic declared device";a.site="bench-site";a.privacy=lmti::Privacy::Public;
        d.topology.assets.push_back(a);
    }
    for (int i=0;i<500;++i) {
        const auto asset="asset-"+std::to_string(i%200),component="component-"+std::to_string(i/200),release="release-"+std::to_string(i/200);
        d.bindings.push_back({"binding-"+std::to_string(i),asset,component,release,"",lmti::Privacy::Public});
        d.work.push_back({"work-"+std::to_string(i),"Synthetic validation",component,asset,release,"","Check synthetic metadata","",
                          lmti::WorkKind::Validation,lmti::WorkState::Todo,lmti::Privacy::Public});
    }
    return d;
}
}
int main(int argc,char **argv) {
    QCoreApplication app(argc,argv);
    try {
        need(argc==2);
        const auto root=lmti::checked_project_folder(QString::fromLocal8Bit(argv[1]));
        need(root.startsWith(QDir(QString::fromUtf8(LMTI_INTEROP_BUILD_ROOT)).absolutePath()+'/',Qt::CaseInsensitive));
        const auto library=QDir(root).filePath("project-library.sqlite"),profiles=QDir(root).filePath("mcp-profiles.sqlite");
        need(!QFileInfo::exists(library)&&!QFileInfo::exists(profiles));
        const auto dense=dense_document();QJsonArray ids; qint64 database_bytes=0;
        for (int i=0;i<500;++i) {
            const auto id=QString("bench-%1").arg(i,3,10,QChar('0'));
            need(QDir(root).mkdir(id));const auto folder=QDir(root).filePath(id),database=QDir(folder).filePath("project.sqlite");
            auto d=i<50?dense:lmti::ProjectDocument{};
            d.project={id.toStdString(),("Synthetic "+id).toStdString(),"Locked synthetic baseline; no live or production claim",lmti::Privacy::Public};
            if(i>=50) {lmti::Asset a;a.id="asset-0";a.label="Synthetic declared device";a.site="bench-site";a.privacy=lmti::Privacy::Public;d.topology.assets.push_back(a);}
            d.topology.revision=lmti::save_project(database,d);
            const auto loaded=lmti::load_project(database);need(loaded==d);
            lmti::McpProfile profile{id.toStdString(),0,{
                {"lmti_context","LMTI context","","bench-site",lmti::McpTransport::LmtiLocal,lmti::McpAuth::None},
                {"project_docs","Synthetic docs","https://example.com/mcp","",lmti::McpTransport::RemoteHttps,lmti::McpAuth::ClientOAuth}
            }};
            profile.revision=lmti::save_mcp_profile(profiles,profile);need(profile.revision==1);
            lmti::remember_library_project(library,{id,d.project.label.c_str(),database,folder,i<50,0});
            ids.append(id);database_bytes+=QFileInfo(database).size();
        }
        const auto entries=lmti::project_library(library);need(entries.size()==500);
        for(int i=0;i<50;++i)need(entries[static_cast<std::size_t>(i)].pinned);
        QJsonObject report{{"schema","lmti.web03.fixture.v1"},{"projects",500},{"dense",50},{"ids",ids},{"projectDatabaseBytes",database_bytes}};
        const auto bytes=QJsonDocument(report).toJson(QJsonDocument::Compact);
        QFile record(QDir(root).filePath("fixture.json"));need(record.open(QIODevice::WriteOnly|QIODevice::NewOnly));need(record.write(bytes)==bytes.size());
        QTextStream(stdout)<<"Synthetic WEB-03 fixture created and verified: 500 projects, 50 dense.\n";
        return 0;
    } catch (...) {QTextStream(stderr)<<"Synthetic benchmark fixture rejected.\n";return 1;}
}
