#include "lmti/mcp_profile_store.hpp"
#include "lmti/project_library.hpp"
#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QProcess>
#include <QTemporaryDir>
#include <functional>
#include <iostream>

namespace {
void check(bool value, const char *message) { if (!value) throw lmti::Error(message); }
QByteArray bytes(const QString &path) {
    QFile file(path); check(file.open(QIODevice::ReadOnly),"Read fixture"); return file.readAll();
}
void write(const QString &path, const QByteArray &value) {
    QFile file(path); check(file.open(QIODevice::WriteOnly|QIODevice::Truncate),"Write fixture");
    check(file.write(value)==value.size(),"Complete fixture write");
}
QByteArray encoded(const QJsonObject &value) { return QJsonDocument(value).toJson(QJsonDocument::Compact); }
QJsonObject run(const QString &binary, const QStringList &args, const QByteArray &input) {
    QProcess child; child.setProgram(binary); child.setArguments(args); child.start();
    check(child.waitForStarted(5000),"Start native admin");
    check(child.write(input)==input.size(),"Write native request"); child.closeWriteChannel();
    check(child.waitForFinished(10000),"Native admin deadline");
    check(child.exitStatus()==QProcess::NormalExit && child.exitCode()==0,"Native admin exit");
    check(child.readAllStandardError().isEmpty(),"Native admin emitted private error output");
    const auto output=child.readAllStandardOutput(); check(output.size()<=256*1024,"Bounded native output");
    QJsonParseError error; const auto document=QJsonDocument::fromJson(output,&error);
    check(error.error==QJsonParseError::NoError && document.isObject(),"Native admin JSON");
    return document.object();
}
void refused(const QJsonObject &result, const char *code) {
    check(result==QJsonObject{{"ok",false},{"code",code}},"Exact bounded refusal code");
}
}
int main(int argc,char **argv) {
    QCoreApplication app(argc,argv);
    try {
        check(argc==2,"Provide the native admin executable");
        QTemporaryDir temporary; check(temporary.isValid(),"Disposable fixture directory");
        const auto root=temporary.path(), database=temporary.filePath("project.sqlite");
        const auto profiles=temporary.filePath("profiles.sqlite"), library=temporary.filePath("library.sqlite");
        const auto config=temporary.filePath("integration source.json"), dummy=temporary.filePath("trusted runtime file");
        write(dummy,{});
        auto document=lmti::demo_project(); document.topology.assets.back().site="other-site";
        document.topology.revision=lmti::save_project(database,document);
        lmti::remember_library_project(library,{QString::fromStdString(document.project.id),"Synthetic",database,root,false,0});
        lmti::McpProfile profile{document.project.id,0,{
            {"lmti_context","LMTI context","","factory-demo",lmti::McpTransport::LmtiLocal,lmti::McpAuth::None},
            {"remote","Remote","https://example.com/mcp","",lmti::McpTransport::RemoteHttps,lmti::McpAuth::ClientOAuth},
            {"disabled","Disabled","","other-site",lmti::McpTransport::LmtiLocal,lmti::McpAuth::None,false}}};
        profile.revision=lmti::save_mcp_profile(profiles,profile);
        const QStringList args{"--library",library,"--profiles",profiles,"--python",dummy,"--entry",dummy,"--binary",dummy};
        const auto invoke=[&](const QByteArray &input) {
            const auto oldProject=bytes(database),oldProfile=bytes(profiles),oldLibrary=bytes(library);
            const auto result=run(QString::fromLocal8Bit(argv[1]),args,input);
            check(bytes(database)==oldProject && bytes(profiles)==oldProfile && bytes(library)==oldLibrary,"Generation must not write native stores");
            return result;
        };
        QJsonObject source{{"schema","lmti.agent.integration.v1"},{"projectId",QString::fromStdString(profile.project_id)},
            {"site","factory-demo"},{"target","external"},{"knowledge",QJsonValue::Null},{"observations",QJsonValue::Null}};
        write(config,encoded(source));
        auto fingerprint=[&] { return QCryptographicHash::hash(bytes(config),QCryptographicHash::Sha256).toHex(); };
        QJsonObject binding{{"configPath",config},{"projectId",QString::fromStdString(profile.project_id)},
            {"site","factory-demo"},{"target","external"},{"sha256",QString::fromLatin1(fingerprint())}};
        QJsonObject request{{"action","generate"},{"projectId",QString::fromStdString(profile.project_id)},
            {"client","codex"},{"expectedRevision",profile.revision}};
        const auto legacy=invoke(encoded(request)); check(legacy.value("ok").toBool(),"Legacy generation");
        check(!legacy.value("content").toString().contains("--integration"),"Legacy arguments unchanged");
        request["integration"]=binding;
        QJsonObject shared;
        for(const auto &client : {"codex","cursor"}) {
            request["client"]=client;
            const auto result=invoke(encoded(request)); check(result.value("ok").toBool(),"Integrated generation");
            const auto servers=result.value("servers").toObject();
            const auto arguments=servers.value("lmti_context").toObject().value("args").toArray();
            check(arguments.size()==16 && arguments.at(12)=="--integration-config" &&
                  arguments.at(13)==QFileInfo(config).canonicalFilePath() && arguments.at(14)=="--integration-sha256" &&
                  arguments.at(15)==QString::fromLatin1(fingerprint()),"Native-owned pinned argv");
            check(arguments.at(10)=="--target" && arguments.at(11)=="external","External client scope");
            check(servers.value("remote")==legacy.value("servers").toObject().value("remote"),"Remote entries unchanged");
            check(!servers.contains("disabled"),"Disabled mismatched local entry omitted");
            if(shared.isEmpty()) shared=servers; else check(shared==servers,"Client formats share pinned generation");
            check(result.value("content").toString().contains("--integration-sha256"),"Export contains pin");
        }
        // v2 adds one reviewed capability to the pinned source, never another
        // argv flag or a wider project/site/target grant.
        auto structured=source; structured["schema"]="lmti.agent.integration.v2"; structured["structure"]=true;
        write(config,encoded(structured));
        auto structuredBinding=binding; structuredBinding["sha256"]=QString::fromLatin1(fingerprint());
        auto structuredRequest=request; structuredRequest["integration"]=structuredBinding;
        const auto baselineArgs=shared.value("lmti_context").toObject().value("args").toArray();
        for(const auto &client : {"codex","cursor"}) {
            structuredRequest["client"]=client;
            const auto before=bytes(config);
            const auto result=invoke(encoded(structuredRequest));
            check(result.value("ok").toBool(),"Structured integration generation");
            const auto servers=result.value("servers").toObject();
            const auto arguments=servers.value("lmti_context").toObject().value("args").toArray();
            check(arguments.size()==16 && arguments.at(15)==QString::fromLatin1(fingerprint()),"v2 preserves 16 pinned arguments");
            for(qsizetype i=0;i<15;++i) check(arguments.at(i)==baselineArgs.at(i),"v2 changed fixed launcher or scope");
            check(servers.value("remote")==shared.value("remote") && !servers.contains("disabled"),"v2 changed unrelated entries");
            check(bytes(config)==before,"v2 generation changed trusted source");
        }
        // v3 selects reviewed mappings through the same pinned launch arguments.
        // Nested reviewed owner configuration is validated by the Python launcher.
        auto reviewed=structured;reviewed["schema"]="lmti.agent.integration.v3";
        reviewed["knowledge"]=QJsonObject{{"mode","reviewed"}};
        write(config,encoded(reviewed));
        auto reviewedBinding=binding;reviewedBinding["sha256"]=QString::fromLatin1(fingerprint());
        auto reviewedRequest=request;reviewedRequest["integration"]=reviewedBinding;
        for(const auto &client : {"codex","cursor"}) {
            reviewedRequest["client"]=client;
            const auto before=bytes(config);
            const auto result=invoke(encoded(reviewedRequest));
            check(result.value("ok").toBool(),"Reviewed integration generation");
            const auto servers=result.value("servers").toObject();
            const auto arguments=servers.value("lmti_context").toObject().value("args").toArray();
            check(arguments.size()==16 && arguments.at(15)==QString::fromLatin1(fingerprint()),"v3 preserves pinned argv");
            for(qsizetype i=0;i<15;++i) check(arguments.at(i)==baselineArgs.at(i),"v3 changed fixed launcher or scope");
            check(servers.value("remote")==shared.value("remote") && !servers.contains("disabled"),"v3 changed unrelated entries");
            check(bytes(config)==before,"v3 generation changed trusted source");
        }
        write(config,encoded(reviewed)+" ");refused(invoke(encoded(reviewedRequest)),"CONFIG_CHANGED");
        for(const auto &field : {"projectId","site","target"}) {
            auto wrong=reviewed;wrong[field]=field==QString("target")?"local":"different";
            write(config,encoded(wrong));reviewedBinding["sha256"]=QString::fromLatin1(fingerprint());
            reviewedRequest["integration"]=reviewedBinding;refused(invoke(encoded(reviewedRequest)),"SCOPE_DENIED");
        }
        for(const auto &value : QJsonArray{QJsonValue::Null,false,QJsonArray{},QJsonObject{},QJsonObject{{"mode","manual"}}}) {
            auto wrong=reviewed;wrong["knowledge"]=value;
            write(config,encoded(wrong));reviewedBinding["sha256"]=QString::fromLatin1(fingerprint());
            reviewedRequest["integration"]=reviewedBinding;refused(invoke(encoded(reviewedRequest)),"OWNER_UNAVAILABLE");
        }
        auto malformedReviewed=reviewed;malformedReviewed["observations"]=false;
        write(config,encoded(malformedReviewed));reviewedBinding["sha256"]=QString::fromLatin1(fingerprint());
        reviewedRequest["integration"]=reviewedBinding;refused(invoke(encoded(reviewedRequest)),"OWNER_UNAVAILABLE");
        write(config,encoded(structured)+" ");refused(invoke(encoded(structuredRequest)),"CONFIG_CHANGED");
        for(const auto &field : {"projectId","site","target"}) {
            auto wrong=structured;wrong[field]=field==QString("target")?"local":"different";
            write(config,encoded(wrong));structuredBinding["sha256"]=QString::fromLatin1(fingerprint());
            structuredRequest["integration"]=structuredBinding;refused(invoke(encoded(structuredRequest)),"SCOPE_DENIED");
        }
        std::vector<QJsonObject> invalidStructures;
        for(const auto &value : QJsonArray{false,0,1,QJsonValue::Null,"true",QJsonObject{},QJsonArray{}}) {
            auto invalid=structured;invalid["structure"]=value;invalidStructures.push_back(invalid);
        }
        auto missing=structured;missing.remove("structure");invalidStructures.push_back(missing);
        auto extra=structured;extra["extra"]=true;invalidStructures.push_back(extra);
        auto legacyExtra=source;legacyExtra["structure"]=true;invalidStructures.push_back(legacyExtra);
        auto unsupported=structured;unsupported["schema"]="lmti.agent.integration.v3";invalidStructures.push_back(unsupported);
        for(const auto &invalid : invalidStructures) {
            write(config,encoded(invalid));structuredBinding["sha256"]=QString::fromLatin1(fingerprint());
            structuredRequest["integration"]=structuredBinding;refused(invoke(encoded(structuredRequest)),"OWNER_UNAVAILABLE");
        }
        auto duplicateStructure=encoded(structured);duplicateStructure.insert(1,"\"\\u0073tructure\":true,");
        write(config,duplicateStructure);structuredBinding["sha256"]=QString::fromLatin1(fingerprint());
        structuredRequest["integration"]=structuredBinding;refused(invoke(encoded(structuredRequest)),"OWNER_UNAVAILABLE");
        write(config,encoded(source));
        auto changed=request; auto changedBinding=binding;
        changedBinding["target"]="local";changed["integration"]=changedBinding;refused(invoke(encoded(changed)),"SCOPE_DENIED");
        changedBinding=binding;changedBinding["projectId"]="different-project";changed["integration"]=changedBinding;refused(invoke(encoded(changed)),"SCOPE_DENIED");
        changedBinding=binding;changedBinding["site"]="other-site";changed["integration"]=changedBinding;refused(invoke(encoded(changed)),"SCOPE_DENIED");
        changedBinding=binding;changedBinding["sha256"]=QString(64,'A');changed["integration"]=changedBinding;refused(invoke(encoded(changed)),"INVALID_INPUT");
        changedBinding=binding;changedBinding["extra"]=true;changed["integration"]=changedBinding;refused(invoke(encoded(changed)),"INVALID_INPUT");
        changed=request;changed["integration"]=QJsonValue::Null;refused(invoke(encoded(changed)),"INVALID_INPUT");
        changed=request;changed["root"]=root;refused(invoke(encoded(changed)),"INVALID_INPUT");
        auto duplicate=encoded(request);duplicate.insert(1,"\"projectId\":\"duplicate\",");refused(invoke(duplicate),"INVALID_INPUT");
        duplicate=encoded(request);const auto site=duplicate.indexOf("\"site\":");check(site>=0,"Find binding site");
        duplicate.insert(site,"\"\\u0073ite\":\"factory-demo\",");refused(invoke(duplicate),"INVALID_INPUT");
        for(const auto &path : {QString("relative.json"),QString("//untrusted.invalid/share/source.json"),config+":stream",config+"\n",
                               temporary.filePath("NUL.json"),temporary.filePath("trailing. "),root+"/../integration.json"}) {
            changedBinding=binding;changedBinding["configPath"]=path;changed=request;changed["integration"]=changedBinding;
            refused(invoke(encoded(changed)),"OWNER_UNAVAILABLE");
        }
        write(config,encoded(source)+" ");refused(invoke(encoded(request)),"CONFIG_CHANGED");
        write(config,encoded(source));
        profile.servers.back().enabled=true;profile.revision=lmti::save_mcp_profile(profiles,profile);
        request["expectedRevision"]=profile.revision;refused(invoke(encoded(request)),"SCOPE_DENIED");
        profile.servers.back().enabled=false;profile.revision=lmti::save_mcp_profile(profiles,profile);request["expectedRevision"]=profile.revision;
        for(const auto &field : {"projectId","site","target"}) {
            auto wrong=source;wrong[field]=field==QString("target")?"local":"different";write(config,encoded(wrong));
            changedBinding=binding;changedBinding["sha256"]=QString::fromLatin1(fingerprint());changed=request;changed["integration"]=changedBinding;
            refused(invoke(encoded(changed)),"SCOPE_DENIED");
        }
        auto invalid=encoded(source);invalid.insert(1,"\"\\u0073ite\":\"factory-demo\",");write(config,invalid);
        changedBinding=binding;changedBinding["sha256"]=QString::fromLatin1(fingerprint());changed=request;changed["integration"]=changedBinding;
        refused(invoke(encoded(changed)),"OWNER_UNAVAILABLE");
        auto unknown=source;unknown["extra"]=true;write(config,encoded(unknown));changedBinding["sha256"]=QString::fromLatin1(fingerprint());changed["integration"]=changedBinding;
        refused(invoke(encoded(changed)),"OWNER_UNAVAILABLE");
        write(config,QByteArray(64*1024+1,' '));refused(invoke(encoded(request)),"OWNER_UNAVAILABLE");
        write(config,encoded(source));check(QFile::remove(config),"Remove disposable integration fixture");refused(invoke(encoded(request)),"OWNER_UNAVAILABLE");
        std::cout<<"Pinned MCP integration generation, strict input, scope and no-write checks passed\n";
        return 0;
    } catch(const std::exception &error) { std::cerr<<error.what()<<'\n';return 1; }
}
