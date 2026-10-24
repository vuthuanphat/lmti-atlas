// Local operator content owner. No Agent/MCP tool or raw document replacement.
#include "project_content.hpp"
#include "lmti/project_store.hpp"
#include "lmti/storage.hpp"
#include "../common/local_owner_path.hpp"
#include "../common/strict_json.hpp"
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QSet>
#include <QTextStream>
#include <algorithm>
#include <cmath>

namespace {
struct Refused { const char *code; };
void need(bool value,const char *code="INVALID_INPUT") { if(!value)throw Refused{code}; }
void keys(const QJsonObject&o,const QSet<QString>&wanted) {
    QSet<QString> actual; for(auto i=o.begin();i!=o.end();++i)actual.insert(i.key()); need(actual==wanted);
}
std::string text(const QJsonObject&o,const char *key) {
    const auto v=o.value(key);need(v.isString());const auto s=v.toString().toStdString();
    need(s.size()<=8192 && lmti::valid_metadata_utf8(s) && !lmti::secret_like(s));return s;
}
qint64 number(const QJsonObject&o,const char *key) {
    const auto v=o.value(key);const auto n=v.toDouble(-1);need(v.isDouble()&&std::isfinite(n)&&std::floor(n)==n&&n>=0&&n<=9007199254740990.0);return v.toInteger();
}
bool boolean(const QJsonObject&o,const char *key) {need(o.value(key).isBool());return o.value(key).toBool();}
QString s(const std::string&v){return QString::fromStdString(v);}
QJsonObject encode_project(const lmti::ProjectInfo&v){return {{"id",s(v.id)},{"label",s(v.label)},{"goal",s(v.goal)},{"privacy",s(lmti::name(v.privacy))}};}
lmti::ProjectInfo parse_project(const QJsonObject&o,lmti::ProjectInfo v={}){
    keys(o,{"id","label","goal","privacy"});
    v.id=text(o,"id");
    v.label=text(o,"label");
    v.goal=text(o,"goal");
    v.privacy=lmti::parse_privacy(text(o,"privacy"));
    return v;
}
QJsonObject encode_repositories(const lmti::RepositoryRef&v){return {{"id",s(v.id)},{"label",s(v.label)},{"locator",s(v.locator)},{"privacy",s(lmti::name(v.privacy))}};}
lmti::RepositoryRef parse_repositories(const QJsonObject&o,lmti::RepositoryRef v={}){
    keys(o,{"id","label","locator","privacy"});
    v.id=text(o,"id");
    v.label=text(o,"label");
    v.locator=text(o,"locator");
    v.privacy=lmti::parse_privacy(text(o,"privacy"));
    return v;
}
QJsonObject encode_components(const lmti::SoftwareComponent&v){return {{"id",s(v.id)},{"label",s(v.label)},{"repositoryId",s(v.repository_id)},{"kind",s(lmti::name(v.kind))},{"privacy",s(lmti::name(v.privacy))}};}
lmti::SoftwareComponent parse_components(const QJsonObject&o,lmti::SoftwareComponent v={}){
    keys(o,{"id","label","repositoryId","kind","privacy"});
    v.id=text(o,"id");
    v.label=text(o,"label");
    v.repository_id=text(o,"repositoryId");
    v.kind=lmti::component_kind(text(o,"kind"));
    v.privacy=lmti::parse_privacy(text(o,"privacy"));
    return v;
}
QJsonObject encode_targets(const lmti::HardwareTarget&v){return {{"id",s(v.id)},{"label",s(v.label)},{"hardwareRevision",s(v.hardware_revision)},{"architecture",s(v.architecture)},{"privacy",s(lmti::name(v.privacy))}};}
lmti::HardwareTarget parse_targets(const QJsonObject&o,lmti::HardwareTarget v={}){
    keys(o,{"id","label","hardwareRevision","architecture","privacy"});
    v.id=text(o,"id");
    v.label=text(o,"label");
    v.hardware_revision=text(o,"hardwareRevision");
    v.architecture=text(o,"architecture");
    v.privacy=lmti::parse_privacy(text(o,"privacy"));
    return v;
}
QJsonObject encode_releases(const lmti::SoftwareRelease&v){return {{"id",s(v.id)},{"label",s(v.label)},{"componentId",s(v.component_id)},{"targetId",s(v.target_id)},{"sourceRevision",s(v.source_revision)},{"state",s(lmti::name(v.state))},{"privacy",s(lmti::name(v.privacy))}};}
lmti::SoftwareRelease parse_releases(const QJsonObject&o,lmti::SoftwareRelease v={}){
    keys(o,{"id","label","componentId","targetId","sourceRevision","state","privacy"});
    v.id=text(o,"id");
    v.label=text(o,"label");
    v.component_id=text(o,"componentId");
    v.target_id=text(o,"targetId");
    v.source_revision=text(o,"sourceRevision");
    v.state=lmti::release_state(text(o,"state"));
    v.privacy=lmti::parse_privacy(text(o,"privacy"));
    return v;
}
QJsonObject encode_bindings(const lmti::SoftwareBinding&v){return {{"id",s(v.id)},{"assetId",s(v.asset_id)},{"componentId",s(v.component_id)},{"releaseId",s(v.release_id)},{"targetId",s(v.target_id)},{"privacy",s(lmti::name(v.privacy))}};}
lmti::SoftwareBinding parse_bindings(const QJsonObject&o,lmti::SoftwareBinding v={}){
    keys(o,{"id","assetId","componentId","releaseId","targetId","privacy"});
    v.id=text(o,"id");
    v.asset_id=text(o,"assetId");
    v.component_id=text(o,"componentId");
    v.release_id=text(o,"releaseId");
    v.target_id=text(o,"targetId");
    v.privacy=lmti::parse_privacy(text(o,"privacy"));
    return v;
}
QJsonObject encode_dependencies(const lmti::ComponentDependency&v){return {{"id",s(v.id)},{"from",s(v.from)},{"to",s(v.to)},{"contract",s(v.contract)},{"privacy",s(lmti::name(v.privacy))}};}
lmti::ComponentDependency parse_dependencies(const QJsonObject&o,lmti::ComponentDependency v={}){
    keys(o,{"id","from","to","contract","privacy"});
    v.id=text(o,"id");
    v.from=text(o,"from");
    v.to=text(o,"to");
    v.contract=text(o,"contract");
    v.privacy=lmti::parse_privacy(text(o,"privacy"));
    return v;
}
QJsonObject encode_verification(const lmti::VerificationRecord&v){return {{"id",s(v.id)},{"releaseId",s(v.release_id)},{"assetId",s(v.asset_id)},{"evidence",s(v.evidence)},{"source",s(v.source)},{"at",v.at},{"result",s(lmti::name(v.result))},{"privacy",s(lmti::name(v.privacy))}};}
lmti::VerificationRecord parse_verification(const QJsonObject&o,lmti::VerificationRecord v={}){
    keys(o,{"id","releaseId","assetId","evidence","source","at","result","privacy"});
    v.id=text(o,"id");
    v.release_id=text(o,"releaseId");
    v.asset_id=text(o,"assetId");
    v.evidence=text(o,"evidence");
    v.source=text(o,"source");
    v.at=number(o,"at");
    v.result=lmti::evidence_result(text(o,"result"));
    v.privacy=lmti::parse_privacy(text(o,"privacy"));
    return v;
}
QJsonObject encode_milestones(const lmti::Milestone&v){return {{"id",s(v.id)},{"label",s(v.label)},{"criteria",s(v.criteria)},{"dueDate",s(v.due_date)},{"accepted",v.accepted},{"evidence",s(v.evidence)},{"privacy",s(lmti::name(v.privacy))}};}
lmti::Milestone parse_milestones(const QJsonObject&o,lmti::Milestone v={}){
    keys(o,{"id","label","criteria","dueDate","accepted","evidence","privacy"});
    v.id=text(o,"id");
    v.label=text(o,"label");
    v.criteria=text(o,"criteria");
    v.due_date=text(o,"dueDate");
    v.accepted=boolean(o,"accepted");
    v.evidence=text(o,"evidence");
    v.privacy=lmti::parse_privacy(text(o,"privacy"));
    return v;
}
QJsonObject encode_work(const lmti::WorkItem&v){return {{"id",s(v.id)},{"label",s(v.label)},{"componentId",s(v.component_id)},{"assetId",s(v.asset_id)},{"releaseId",s(v.release_id)},{"milestoneId",s(v.milestone_id)},{"checklist",s(v.checklist)},{"evidence",s(v.evidence)},{"kind",s(lmti::name(v.kind))},{"state",s(lmti::name(v.state))},{"privacy",s(lmti::name(v.privacy))}};}
lmti::WorkItem parse_work(const QJsonObject&o,lmti::WorkItem v={}){
    keys(o,{"id","label","componentId","assetId","releaseId","milestoneId","checklist","evidence","kind","state","privacy"});
    v.id=text(o,"id");
    v.label=text(o,"label");
    v.component_id=text(o,"componentId");
    v.asset_id=text(o,"assetId");
    v.release_id=text(o,"releaseId");
    v.milestone_id=text(o,"milestoneId");
    v.checklist=text(o,"checklist");
    v.evidence=text(o,"evidence");
    v.kind=lmti::work_kind(text(o,"kind"));
    v.state=lmti::work_state(text(o,"state"));
    v.privacy=lmti::parse_privacy(text(o,"privacy"));
    return v;
}
QJsonObject encode_knowledge(const lmti::KnowledgeRef&v){return {{"id",s(v.id)},{"label",s(v.label)},{"componentId",s(v.component_id)},{"reference",s(v.reference)},{"fingerprint",s(v.fingerprint)},{"privacy",s(lmti::name(v.privacy))}};}
lmti::KnowledgeRef parse_knowledge(const QJsonObject&o,lmti::KnowledgeRef v={}){
    keys(o,{"id","label","componentId","reference","fingerprint","privacy"});
    v.id=text(o,"id");
    v.label=text(o,"label");
    v.component_id=text(o,"componentId");
    v.reference=text(o,"reference");
    v.fingerprint=text(o,"fingerprint");
    v.privacy=lmti::parse_privacy(text(o,"privacy"));
    return v;
}
QJsonObject encode_assets(const lmti::Asset&v){return {{"id",s(v.id)},{"label",s(v.label)},{"site",s(v.site)},{"kind",s(lmti::name(v.kind))},{"privacy",s(lmti::name(v.privacy))},{"enabled",v.enabled},{"pollMs",v.poll_ms}};}
lmti::Asset parse_assets(const QJsonObject&o,lmti::Asset v={}){
    keys(o,{"id","label","site","kind","privacy","enabled","pollMs"});
    v.id=text(o,"id");
    v.label=text(o,"label");
    v.site=text(o,"site");
    v.kind=lmti::parse_kind(text(o,"kind"));
    v.privacy=lmti::parse_privacy(text(o,"privacy"));
    v.enabled=boolean(o,"enabled");
    need(number(o,"pollMs")<=3600000);
    v.poll_ms=static_cast<int>(number(o,"pollMs"));
    return v;
}
QJsonObject encode_connections(const lmti::Link&v){return {{"id",s(v.id)},{"from",s(v.from)},{"to",s(v.to)},{"protocol",s(lmti::name(v.protocol))}};}
lmti::Link parse_connections(const QJsonObject&o,lmti::Link v={}){
    keys(o,{"id","from","to","protocol"});
    v.id=text(o,"id");
    v.from=text(o,"from");
    v.to=text(o,"to");
    v.protocol=lmti::parse_protocol(text(o,"protocol"));
    return v;
}
QJsonArray rows(const lmti::ProjectDocument&d,const QString&collection) {
    QJsonArray result;
    if(collection=="project"){result.append(encode_project(d.project));return result;}
    if(collection=="repositories"){for(const auto&v:d.repositories)result.append(encode_repositories(v));return result;}
    if(collection=="components"){for(const auto&v:d.components)result.append(encode_components(v));return result;}
    if(collection=="targets"){for(const auto&v:d.targets)result.append(encode_targets(v));return result;}
    if(collection=="releases"){for(const auto&v:d.releases)result.append(encode_releases(v));return result;}
    if(collection=="bindings"){for(const auto&v:d.bindings)result.append(encode_bindings(v));return result;}
    if(collection=="dependencies"){for(const auto&v:d.dependencies)result.append(encode_dependencies(v));return result;}
    if(collection=="verification"){for(const auto&v:d.verification)result.append(encode_verification(v));return result;}
    if(collection=="milestones"){for(const auto&v:d.milestones)result.append(encode_milestones(v));return result;}
    if(collection=="work"){for(const auto&v:d.work)result.append(encode_work(v));return result;}
    if(collection=="knowledge"){for(const auto&v:d.knowledge)result.append(encode_knowledge(v));return result;}
    if(collection=="assets"){for(const auto&v:d.topology.assets)result.append(encode_assets(v));return result;}
    if(collection=="connections"){for(const auto&v:d.topology.links)result.append(encode_connections(v));return result;}
    throw Refused{"INVALID_INPUT"};
}
template<class T,class Parse>void change(std::vector<T>&values,const QString&operation,const QJsonObject&record,Parse parse){
    const auto id=text(record,"id");lmti::validate_id(id);
    const auto found=std::find_if(values.begin(),values.end(),[&](const T&v){return v.id==id;});
    if(operation=="remove"){keys(record,{"id"});need(found!=values.end());values.erase(found);return;}
    need(operation=="add"||operation=="update");
    need(operation=="add"?found==values.end():found!=values.end(),"CONFIG_CONFLICT");
    // Preserve native-only fields (e.g. observed health and canvas position).
    auto value=parse(record,found==values.end()?T{}:*found);
    if(found==values.end())values.push_back(std::move(value));else *found=std::move(value);
}
void apply(lmti::ProjectDocument&d,const QString&collection,const QString&operation,const QJsonObject&record){
    if(collection=="project"){need(operation=="update");auto value=parse_project(record,d.project);need(value.id==d.project.id);d.project=std::move(value);return;}
    if(collection=="repositories"){change(d.repositories,operation,record,parse_repositories);return;}
    if(collection=="components"){change(d.components,operation,record,parse_components);return;}
    if(collection=="targets"){change(d.targets,operation,record,parse_targets);return;}
    if(collection=="releases"){change(d.releases,operation,record,parse_releases);return;}
    if(collection=="bindings"){change(d.bindings,operation,record,parse_bindings);return;}
    if(collection=="dependencies"){change(d.dependencies,operation,record,parse_dependencies);return;}
    if(collection=="verification"){change(d.verification,operation,record,parse_verification);return;}
    if(collection=="milestones"){change(d.milestones,operation,record,parse_milestones);return;}
    if(collection=="work"){change(d.work,operation,record,parse_work);return;}
    if(collection=="knowledge"){change(d.knowledge,operation,record,parse_knowledge);return;}
    if(collection=="assets"){change(d.topology.assets,operation,record,parse_assets);return;}
    if(collection=="connections"){change(d.topology.links,operation,record,parse_connections);return;}
    throw Refused{"INVALID_INPUT"};
}
}
int project_content_main(const QStringList&args){
    QJsonObject result;bool writing=false;
    try{
        need(args.size()==4);need(args[1]=="content-read"||args[1]=="content-review"||args[1]=="content-commit");
        lmti::validate_id(args[3].toStdString());
        const auto path=lmti::detail::local_owner_path(args[2],true);
        QFile input;need(input.open(stdin,QIODevice::ReadOnly));
        const auto request=lmti::detail::strict_json_object(input.read(131073),131072);
        auto document=lmti::load_project(path);need(document.project.id==args[3].toStdString(),"SCOPE_DENIED");
        const auto collection=s(text(request,"collection"));const auto all=rows(document,collection);
        const auto revision=document.topology.revision;
        if(args[1]=="content-read"){
            keys(request,{"collection","offset","limit"});const auto offset=number(request,"offset"),limit=number(request,"limit");
            need(limit>=1&&limit<=100&&offset<=all.size());QJsonArray page;
            for(auto i=offset;i<std::min<qint64>(offset+limit,all.size());++i)page.append(all.at(i));
            result={{"ok",true},{"schema","lmti.project.content.v1"},{"collection",collection},{"revision",revision},{"items",page},{"total",all.size()},
                {"nextOffset",offset+limit<all.size()?QJsonValue(offset+limit):QJsonValue(QJsonValue::Null)}};
        }else{
            keys(request,{"collection","operation","expectedRevision","record"});
            need(number(request,"expectedRevision")==revision,"REVISION_CONFLICT");need(request.value("record").isObject());
            const auto record=request.value("record").toObject();const auto id=text(record,"id");QJsonValue before(QJsonValue::Null),after(QJsonValue::Null);
            for(const auto&v:all)if(v.toObject().value("id").toString().toStdString()==id)before=v;
            auto next=document;apply(next,collection,s(text(request,"operation")),record);lmti::validate(next);lmti::validate_update(document,next);
            for(const auto&v:rows(next,collection))if(v.toObject().value("id").toString().toStdString()==id)after=v;
            result={{"ok",true},{"schema","lmti.project.content.v1"},{"collection",collection},{"revision",revision},{"before",before},{"after",after},{"deviceActions",false}};
            need(QJsonDocument(result).toJson(QJsonDocument::Compact).size()<=240*1024,"LIMIT_EXCEEDED");
            if(args[1]=="content-commit"){
                // Once save starts, an exception/lost reply is never proof of rollback.
                writing=true;result["revision"]=lmti::save_project(path,next);
            }
        }
        need(QJsonDocument(result).toJson(QJsonDocument::Compact).size()<=240*1024,"LIMIT_EXCEEDED");
    }catch(const Refused&e){result={{"ok",false},{"error",QJsonObject{{"code",writing?"OWNER_UNAVAILABLE":e.code}}}};}
    catch(const std::exception&){result={{"ok",false},{"error",QJsonObject{{"code",writing?"OWNER_UNAVAILABLE":"INVALID_INPUT"}}}};}
    QTextStream(stdout)<<QJsonDocument(result).toJson(QJsonDocument::Compact)<<'\n';return result.value("ok").toBool()?0:1;
}
