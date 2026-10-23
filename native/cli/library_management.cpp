// Fixed local operator library boundary. Every path is launcher-owned.
#include "library_management.hpp"
#include "project_operation_json.hpp"
#include "lmti/project_library.hpp"
#include "../common/local_owner_path.hpp"
#include "../common/strict_json.hpp"
#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QSet>
#include <QTemporaryDir>
#include <QTextStream>

namespace {
struct Refused{const char*code;};
void need(bool v,const char*c="INVALID_INPUT"){if(!v)throw Refused{c};}
void keys(const QJsonObject&o,const QSet<QString>&wanted){QSet<QString>a;for(auto i=o.begin();i!=o.end();++i)a.insert(i.key());need(a==wanted);}
QString text(const QJsonObject&o,const char*k){need(o.value(k).isString());auto v=o.value(k).toString();need(v.toUtf8().size()<=1024&&lmti::valid_metadata_utf8(v.toStdString())&&!lmti::secret_like(v.toStdString()));return v;}
struct State{std::optional<lmti::LibraryInspection> view;QJsonObject json;};
State state(const QString&path){
    State out;QJsonArray entries,privateRows;QJsonValue token(QJsonValue::Null);
    if(QFileInfo::exists(path)){
        out.view=lmti::inspect_project_library(path);token=lmti::cli::project_operation_json::library_json(out.view->token);
        for(const auto&e:out.view->entries){
            entries.append(QJsonObject{{"id",e.id},{"label",e.label},{"pinned",e.pinned},{"folderLinked",!e.folder.isEmpty()}});
            privateRows.append(QJsonObject{{"id",e.id},{"label",e.label},{"path",e.path},{"folder",e.folder},{"pinned",e.pinned},{"opened",e.opened}});
        }
    }
    const auto signature=QString::fromLatin1(QCryptographicHash::hash(QJsonDocument(QJsonObject{{"token",token},{"rows",privateRows}}).toJson(QJsonDocument::Compact),QCryptographicHash::Sha256).toHex());
    out.json={{"ok",true},{"schema","lmti.library.management.v1"},{"signature",signature},{"format",out.view?out.view->token.schema:0},{"uuid",out.view?out.view->token.library_uuid:QString{}},{"entries",entries}};return out;
}
}
int library_management_main(const QStringList&args){
    QJsonObject result;bool writing=false;
    try{
        need(args.size()==3);const auto mode=args[1];need(mode=="library-state"||mode=="library-recover"||mode=="library-review"||mode=="library-commit");
        const auto library=lmti::detail::local_owner_path(args[2],false);
        QFile input;need(input.open(stdin,QIODevice::ReadOnly));const auto request=lmti::detail::strict_json_object(input.read(16385),16384);
        auto before=state(library);
        if(mode=="library-state"){keys(request,{});result=before.json;}
        else if(mode=="library-recover"){
            keys(request,{"database","id"});const auto target=text(request,"database"),id=text(request,"id");
            result=before.json;
            if(!target.isEmpty()&&QFileInfo::exists(target)){
                const auto path=lmti::detail::local_owner_path(target,true);const auto d=lmti::load_project(path);
                need(QString::fromStdString(d.project.id)==id,"CONFIG_CHANGED");
                result["projectRevision"]=d.topology.revision;
            }else result["projectRevision"]=QJsonValue(QJsonValue::Null);
        }
        else{
            keys(request,{"action","expected","id","label","folder","database","parent"});
            need(text(request,"expected")==before.json.value("signature").toString(),"CONFIG_CHANGED");
            const auto action=text(request,"action"),id=text(request,"id"),label=text(request,"label"),folder=text(request,"folder"),database=text(request,"database"),parent=text(request,"parent");
            lmti::validate_id(id.toStdString());need(action=="create"||action=="register"||action=="link"||action=="pin"||action=="forget");
            const lmti::LibraryEntry*existing=nullptr;
            if(before.view)for(const auto&e:before.view->entries)if(e.id==id)existing=&e;
            QString target;std::optional<lmti::ProjectDocument> document;
            if(action=="create"||action=="register"){
                need(!existing,"CONFIG_CHANGED");need(!before.view||before.view->token.schema>=2,"NOT_SUPPORTED");
                need(!before.view||before.view->entries.size()<lmti::max_library_entries,"LIMIT_EXCEEDED");
                lmti::checked_project_folder(folder);
                if(action=="create"){
                    need(database.isEmpty());const auto base=lmti::checked_project_folder(parent);
                    need(!QDir(base).isRoot());target=QDir(base).filePath(id+".sqlite");lmti::detail::local_owner_path(target,false);
                    need(!QFileInfo::exists(target),"CONFIG_CHANGED");
                    document.emplace();document->project={id.toStdString(),label.toStdString(),"",lmti::Privacy::Internal};lmti::validate(*document);
                }else{
                    need(parent.isEmpty()&&label.isEmpty());target=lmti::detail::local_owner_path(database,true);
                    const auto metadata=lmti::load_project_metadata(target);need(metadata.project.id==id.toStdString(),"CONFIG_CHANGED");
                }
            }else{
                need(existing&&database.isEmpty()&&parent.isEmpty(),"CONFIG_CHANGED");
                if(action=="link"){need(label.isEmpty()&&before.view->token.schema>=2,"NOT_SUPPORTED");lmti::checked_project_folder(folder);}
                if(action=="pin")need(folder.isEmpty()&&(label=="true"||label=="false"));
                if(action=="forget")need(folder.isEmpty()&&label.isEmpty()&&before.view->token.schema>=2,"NOT_SUPPORTED");
            }
            result={{"ok",true},{"schema","lmti.library.management.v1"},{"action",action},{"id",id},{"label",action=="create"?label:action=="register"?QString::fromStdString(lmti::load_project_metadata(target).project.label):existing->label},
                {"sourcePreserved",true},{"requiresRelaunch",action=="create"||action=="register"||action=="link"||action=="forget"}};
            if(mode=="library-commit"){
                writing=true;
                if(action=="create"){
                    // An exclusive staging directory and no-overwrite rename preserve an
                    // existing destination. Retain staging on every failure for inspection.
                    QTemporaryDir staging(QDir(parent).filePath("lmti-create-XXXXXX"));need(staging.isValid(),"OWNER_UNAVAILABLE");staging.setAutoRemove(false);
                    const auto stage=QDir(staging.path()).filePath("project.sqlite");lmti::save_project(stage,*document);
                    need(QFile::rename(stage,target),"CONFIG_CHANGED");
                }
                if(action=="create"||action=="register"){
                    const auto metadata=lmti::load_project_metadata(target);const lmti::LibraryEntry entry{id,QString::fromStdString(metadata.project.label),target,folder};
                    if(before.view)lmti::register_library_project_cas(library,entry,before.view->token);else lmti::initialize_project_library(library,entry);
                }else if(action=="link")lmti::link_library_folder_cas(library,id,folder,before.view->token);
                else if(action=="forget")lmti::forget_library_project_cas(library,id,before.view->token);
                else lmti::pin_library_project_cas(library,id,label=="true",existing->pinned,before.view->token);
                result["state"]=state(library).json;
            }
        }
    }catch(const Refused&e){result={{"ok",false},{"error",QJsonObject{{"code",writing?"OWNER_UNAVAILABLE":e.code}}}};}
    catch(const lmti::LibraryError&e){result={{"ok",false},{"error",QJsonObject{{"code",writing?"OWNER_UNAVAILABLE":lmti::cli::project_operation_json::library_code(e.code)}}}};}
    catch(const std::exception&){result={{"ok",false},{"error",QJsonObject{{"code",writing?"OWNER_UNAVAILABLE":"INVALID_INPUT"}}}};}
    QTextStream(stdout)<<QJsonDocument(result).toJson(QJsonDocument::Compact)<<'\n';return result.value("ok").toBool()?0:1;
}
