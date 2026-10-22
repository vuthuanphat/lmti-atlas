#include "mcp_profile_panel.hpp"
#include "project_window.hpp"
#include <QApplication>
#include <QAbstractItemModel>
#include <QDialogButtonBox>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileDialog>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QLineEdit>
#include <QLabel>
#include <QPlainTextEdit>
#include <QPushButton>
#include <QScopeGuard>
#include <QStandardPaths>
#include <QTemporaryDir>
#include <QTimer>
#include <QTreeWidget>
#include <QtTest>
#include <functional>
#include <vector>

namespace {
void need(bool value) { if (!value) throw lmti::Error("Controlled MCP test assertion failed."); }
QString at(const QString &root,const QString &name) { return QDir(root).filePath(name); }
QByteArray read(const QString &path) { QFile f(path); need(f.open(QIODevice::ReadOnly)); return f.readAll(); }
void write(const QString &path,const QByteArray &bytes) { QFile f(path); need(f.open(QIODevice::WriteOnly|QIODevice::Truncate)); need(f.write(bytes)==bytes.size()); }
bool wait_until(const std::function<bool()> &ready,int timeout=12000) {
    QElapsedTimer time; time.start();
    while (!ready() && time.elapsed()<timeout) QTest::qWait(10);
    return ready();
}
class Environment {
    struct Value { QByteArray name,value; bool present; }; std::vector<Value> values;
  public:
    Environment() { for (const auto *name:{"LMTI_STUDIO_PYTHON_BINARY","LMTI_STUDIO_AGENT_ENTRY","LMTI_STUDIO_MCP_CONFIG_OWNER"}) values.push_back({name,qgetenv(name),qEnvironmentVariableIsSet(name)}); }
    ~Environment() { for (const auto &v:values) { if(v.present) qputenv(v.name.constData(),v.value); else qunsetenv(v.name.constData()); } }
    void clear() { for (const auto &v:values) qunsetenv(v.name.constData()); }
};
lmti::ProjectDocument document(const QString &path,const std::string &id,bool structured=true) {
    lmti::ProjectDocument d; d.project={id,"Synthetic MCP project","Controlled review",lmti::Privacy::Internal};
    if (structured) d.structure.emplace();
    d.topology.revision=lmti::save_project(path,d); return d;
}
void upgrade(const QString &library,const QString &root,int schema) {
    need(QDir().mkpath(at(root,"backups")));
    if (schema>=2) need(lmti::upgrade_project_library(library,at(root,"backups"),lmti::inspect_project_library(library).token).state==lmti::LibraryUpgradeState::Upgraded);
    if (schema==3) need(lmti::upgrade_library_activation_format(library,at(root,"backups"),lmti::inspect_library_activation_upgrade(library)).state==lmti::LibraryUpgradeState::Upgraded);
}
struct Fixture {
    QTemporaryDir temp; QString library,profiles,database,root,other_root,other_database;
    lmti::ProjectDocument saved,other; int schema;
    explicit Fixture(int version=3,bool rooted=true,bool structured=true):schema(version) {
        need(temp.isValid()); library=temp.filePath("project-library.sqlite"); profiles=temp.filePath("mcp-profiles.sqlite");
        database=temp.filePath("selected.sqlite"); other_database=temp.filePath("other.sqlite");
        need(QDir(temp.path()).mkdir("selected-root") && QDir(temp.path()).mkdir("other-root"));
        root=rooted?temp.filePath("selected-root"):QString{}; other_root=temp.filePath("other-root");
        saved=document(database,"selected-project",structured); other=document(other_database,"other-project",structured);
        make_library(library);
        for (const auto &id:{std::string("selected-project"),std::string("other-project")}) {
            lmti::McpProfile p{id,0,{{"remote","Remote fixture","https://example.com/mcp","",lmti::McpTransport::RemoteHttps,lmti::McpAuth::ClientOAuth}}};
            lmti::save_mcp_profile(profiles,p);
        }
    }
    void make_library(const QString &path) {
        lmti::remember_library_project(path,{"selected-project","Selected",database,root});
        lmti::remember_library_project(path,{"other-project","Other",other_database,other_root}); upgrade(path,temp.path(),schema);
    }
    McpSelection selection() const { return {library,"selected-project",database,root,saved,true}; }
    McpSelection alternate() const { return {library,"other-project",other_database,other_root,other,true}; }
    void mutate(const QString &kind) {
        if (kind=="cosmetics") { lmti::remember_library_project(library,{"selected-project","Cosmetic update",database,{}}); lmti::pin_library_project(library,"selected-project",true); }
        else if (kind=="root-aba") {
            // other_root belongs to another row and folder_key is unique.
            // A third, unassigned directory permits a genuine committed ABA.
            const auto interim=temp.filePath("aba-root"); need(QDir().mkpath(interim));
            const auto before=lmti::inspect_project_library(library).token;
            const auto changed=lmti::link_library_folder_cas(library,"selected-project",interim,before);
            const auto restored=lmti::link_library_folder_cas(library,"selected-project",root,changed);
            need(changed.generation==before.generation+1 && restored.generation==before.generation+2);
            need(restored.library_uuid==before.library_uuid && restored.digest==before.digest);
            need(lmti::inspect_project_library(library).token==restored);
        } else if (kind=="delete-readd") {
            const auto removed=lmti::forget_library_project_cas(library,"selected-project",lmti::inspect_project_library(library).token);
            lmti::register_library_project_cas(library,{"selected-project","Selected",database,root},removed);
        } else if (kind=="library-uuid") {
            const auto replacement=temp.filePath("replacement-library.sqlite"); make_library(replacement);
            need(QFile::rename(library,temp.filePath("retained-library.sqlite")) && QFile::rename(replacement,library));
        } else if (kind=="project-uuid" || kind=="same-revision-content") {
            const auto replacement=temp.filePath("replacement-project.sqlite");
            auto d=document(replacement,"selected-project",kind=="project-uuid");
            if (kind=="same-revision-content") {
                // Native owner produces a distinct valid v1 r1 document, with
                // changed semantics and no durable UUID to rely on.
                need(QFile::remove(replacement)); d.topology.revision=0; d.project.goal="Changed semantic snapshot";
                d.topology.revision=lmti::save_project(replacement,d);
            }
            need(QFile::rename(database,temp.filePath("retained-project.sqlite")) && QFile::rename(replacement,database));
        } else if (kind=="revision") {
            auto d=lmti::load_project(database); d.project.goal="New native revision"; lmti::save_project(database,d);
        } else if (kind=="profile") {
            auto p=lmti::load_mcp_profile(profiles,"selected-project"); p.servers.front().label="Changed profile"; lmti::save_mcp_profile(profiles,p);
        } else if (kind=="delete") lmti::forget_library_project_cas(library,"selected-project",lmti::inspect_project_library(library).token);
        else need(false);
    }
};
template<typename T> T *widget(QObject &parent,const char *name) { auto value=parent.findChild<T *>(name); need(value); return value; }
McpProfilePanel *panel(ProjectWindow &window) { return static_cast<McpProfilePanel *>(widget<QWidget>(window,"projectMcpPanel")); }
bool modal(McpProfilePanel &p,const char *button,const char *name,const std::function<void(QDialog &)> &body) {
    auto trigger=widget<QPushButton>(p,button); if(!trigger->isEnabled()) return false;
    bool success=false,failed=false; QTimer watchdog,dispatch; QElapsedTimer elapsed; elapsed.start();
    QObject::connect(&watchdog,&QTimer::timeout,&p,[&] {
        if (elapsed.elapsed()>25000) { failed=true; if (auto dialog=qobject_cast<QDialog *>(QApplication::activeModalWidget())) dialog->reject(); }
    });
    watchdog.start(20);
    dispatch.setSingleShot(true); QObject::connect(&dispatch,&QTimer::timeout,&p,[&] {
        auto dialog=p.findChild<QDialog *>(name);
        if (!dialog) { failed=true; return; }
        const auto close=qScopeGuard([&]{dialog->reject();});
        try { body(*dialog); success=true; } catch (...) { failed=true; }
    });
    dispatch.start(0); trigger->click(); dispatch.stop(); watchdog.stop(); return success && !failed;
}
void export_to(QDialog &setup,const QString &path,const std::function<void()> &inside_picker=[] {}) {
    bool chosen=false; QTimer dispatch; dispatch.setSingleShot(true);
    QObject::connect(&dispatch,&QTimer::timeout,&setup,[&] {
        auto picker=qobject_cast<QFileDialog *>(QApplication::activeModalWidget());
        if (!picker) return;
        const auto close=qScopeGuard([&]{if(picker->isVisible())picker->reject();});
        try { inside_picker(); picker->selectFile(path); chosen=QMetaObject::invokeMethod(picker,"accept",Qt::DirectConnection); } catch (...) {}
    });
    dispatch.start(0); widget<QPushButton>(setup,"exportMcpConfig")->click(); dispatch.stop(); need(chosen);
}
struct OwnerWrapper {
    QString directory,helper;
    explicit OwnerWrapper(Fixture &f,const QString &owner,const QString &python) {
        need(!owner.isEmpty() && !python.isEmpty() && QFileInfo(owner).isFile() && QFileInfo(python).isFile());
        directory=f.temp.filePath("controlled-owner"); need(QDir().mkpath(directory)); helper=at(directory,"mcp-config-owner.py");
        const auto encoded=QJsonDocument(QJsonArray{owner}).toJson(QJsonDocument::Compact);
        QByteArray script=R"PY(import json,pathlib,runpy,sys,time
owner=runpy.run_path(%OWNER%,run_name='lmti_controlled_owner')
directory=pathlib.Path(__file__).parent
payload=sys.stdin.buffer.read(owner['REQUEST_LIMIT']+1)
request=owner['decode'](payload)
mode=(directory/'mode').read_text(encoding='utf-8')
with (directory/'events.jsonl').open('a',encoding='utf-8') as stream:
    stream.write(json.dumps({key:request.get(key) for key in ('action','root','project')})+'\n')
def release():
    deadline=time.monotonic()+16
    while not (directory/'release').exists():
        if time.monotonic()>deadline: raise RuntimeError('Controlled fixture deadline')
        time.sleep(0.02)
action=request['action']
if mode=='refuse-before-write' and action=='apply':
    sys.stdout.buffer.write(owner['packed']({'ok':False,'error':'Controlled refusal before write.','code':'OWNER_UNAVAILABLE'})+b'\n')
    sys.exit(0)
if mode=='change-before-write' and action=='apply':
    target=pathlib.Path(request['root'])/('.cursor/mcp.json' if request['client']=='cursor' else '.codex/config.toml')
    target.write_bytes(target.read_bytes()+b'\n')
if mode=='read-timeout' and action=='preview': time.sleep(12)
if mode=='read-overflow' and action=='preview':
    sys.stdout.write('x'*40000); sys.stdout.flush(); sys.exit(0)
if mode=='hold-journal' and action=='apply':
    original=owner['operate'].__globals__['atomic']
    def controlled_atomic(path,value):
        original(path,value)
        if str(path).endswith('.recovery.dpapi'):
            (directory/'write-held').write_text('journal persisted',encoding='utf-8'); release()
    owner['operate'].__globals__['atomic']=controlled_atomic
try:
    result=owner['operate'](request)
except owner['Refused'] as error:
    result={'ok':False,'error':str(error),'code':error.code}
except Exception:
    result={'ok':False,'error':'Controlled owner unavailable.','code':'OWNER_UNAVAILABLE'}
if action=='restore_preview' and mode=='restore-drift' and result.get('ok'):
    target=pathlib.Path(request['root'])/('.cursor/mcp.json' if request['client']=='cursor' else '.codex/config.toml')
    target.write_bytes(target.read_bytes()+b'\n')
if action=='apply' and result.get('ok'):
    (directory/'committed').write_text('committed',encoding='utf-8')
    if mode=='hold-ack': release()
    if mode=='write-overflow':
        sys.stdout.write('x'*40000); sys.stdout.flush()
        (directory/'overflow-held').write_text('drain pending',encoding='utf-8'); release(); sys.exit(0)
    if mode=='bare': result={'ok':True}
    if mode=='extra': result['unexpected']=True
    if mode=='wrong-target': result['target']=str(directory/'unrelated.json')
    if mode=='wrong-revision': result['revision']+=1
    if mode=='missing': sys.exit(0)
    if mode=='duplicate':
        sys.stdout.write('{"ok":true,'+json.dumps(result,separators=(',',':'))[1:]); sys.exit(0)
sys.stdout.buffer.write(owner['packed'](result)+b'\n')
)PY";
        script.replace("%OWNER%",encoded.mid(1,encoded.size()-2)); write(helper,script); mode("normal");
        qputenv("LMTI_STUDIO_PYTHON_BINARY",python.toUtf8()); qputenv("LMTI_STUDIO_MCP_CONFIG_OWNER",helper.toUtf8());
        qunsetenv("LMTI_STUDIO_AGENT_ENTRY");
    }
    void mode(const QByteArray &value) { write(at(directory,"mode"),value); }
    void release() { write(at(directory,"release"),"release"); }
    bool marker(const char *name) const { return QFileInfo::exists(at(directory,QString::fromLatin1(name))); }
    int calls(const QString &action,const QString &root={}) const {
        int count=0; const auto path=at(directory,"events.jsonl"); if(!QFileInfo::exists(path)) return 0;
        for(const auto &line:read(path).split('\n')) if(!line.isEmpty()) {
            const auto row=QJsonDocument::fromJson(line).object();
            if(row.value("action").toString()==action && (root.isEmpty() || QDir(row.value("root").toString())==QDir(root))) ++count;
        }
        return count;
    }
};
const QByteArray original_config="{\"private_setting\":\"synthetic_keep\",\"mcpServers\":{\"unmanaged\":{\"url\":\"https://example.invalid/mcp\"}}}\n";
QString original_client(Fixture &f) {
    need(QDir().mkpath(at(f.root,".cursor"))); const auto path=at(f.root,".cursor/mcp.json"); write(path,original_config); return path;
}
}

class McpBindingTest : public QObject {
    Q_OBJECT
    QString python_,owner_,entry_;
  private slots:
    void initTestCase() {
        QStandardPaths::setTestModeEnabled(true); QApplication::setAttribute(Qt::AA_DontUseNativeDialogs,true);
        python_=qEnvironmentVariable("LMTI_STUDIO_PYTHON_BINARY"); owner_=qEnvironmentVariable("LMTI_STUDIO_MCP_CONFIG_OWNER");
        entry_=qEnvironmentVariable("LMTI_STUDIO_AGENT_ENTRY");
    }
    void remote_profile_edit_and_rootless_export_need_no_local_runtime() {
        Environment env; env.clear(); Fixture f(3,false); McpProfilePanel p(f.profiles); p.bind(f.selection(),{"default"}); p.show();
        auto tree=widget<QTreeWidget>(p,"projectMcpServers"); tree->setCurrentItem(tree->topLevelItem(0));
        QVERIFY(modal(p,"editMcpConnection","mcpConnectionDialog",[&](QDialog &dialog) {
            widget<QLineEdit>(dialog,"mcpConnectionName")->setText("Edited remote fixture");
            widget<QDialogButtonBox>(dialog,"")->button(QDialogButtonBox::Save)->click();
        }));
        QCOMPARE(lmti::load_mcp_profile(f.profiles,"selected-project").revision,2);
        for (const auto *button:{"setupMcpCodex","setupMcpCursor"}) {
            const auto destination=f.temp.filePath(QString(button)+".txt");
            QVERIFY(modal(p,button,"mcpClientSetupDialog",[&](QDialog &dialog) {
                need(widget<QPushButton>(dialog,"exportMcpConfig")->isEnabled());
                need(!widget<QPushButton>(dialog,"applyMcpConfig")->isEnabled()); export_to(dialog,destination);
                need(widget<QLabel>(dialog,"mcpSetupStatus")->text().contains("Exported"));
            }));
            QVERIFY(read(destination).contains("https://example.com/mcp"));
            QVERIFY(!read(destination).contains("libraryIdentity")); QVERIFY(!read(destination).contains("storeUuid"));
        }
    }
    void offline_linked_root_does_not_block_remote_export() {
        Environment env; env.clear(); Fixture f; need(QDir().rmdir(f.root));
        McpProfilePanel p(f.profiles); p.bind(f.selection(),{"default"}); p.show(); const auto destination=f.temp.filePath("offline-root-export.json");
        QVERIFY(modal(p,"setupMcpCursor","mcpClientSetupDialog",[&](QDialog &dialog) {
            need(widget<QPushButton>(dialog,"exportMcpConfig")->isEnabled());
            need(!widget<QPushButton>(dialog,"applyMcpConfig")->isEnabled()); export_to(dialog,destination);
        }));
        QVERIFY(read(destination).contains("https://example.com/mcp")); QVERIFY(!QFileInfo::exists(f.root));
    }
    void unavailable_selection_cannot_downgrade_to_standalone_data() {
        QTest::addColumn<QString>("change"); for(const auto *v:{"dirty","unsaved","missing-library","deleted","wrong-path"}) QTest::newRow(v)<<QString(v);
    }
    void unavailable_selection_cannot_downgrade_to_standalone() {
        QFETCH(QString,change); Environment env; env.clear(); Fixture f; auto selection=f.selection();
        if(change=="dirty") selection.clean=false;
        else if(change=="unsaved") selection.database.clear();
        else if(change=="missing-library") need(QFile::rename(f.library,f.temp.filePath("retained-library.sqlite")));
        else if(change=="deleted") f.mutate("delete");
        else selection.database=f.other_database;
        McpProfilePanel p(f.profiles); p.bind(selection,{"default"}); p.show();
        for(const auto *name:{"addMcpConnection","setupMcpCodex","setupMcpCursor","checkLocalMcp"}) QVERIFY(!widget<QPushButton>(p,name)->isEnabled());
        QCOMPARE(lmti::load_mcp_profile(f.profiles,"selected-project").revision,1);
    }
    void rootless_registered_check_uses_real_protocol_and_rejects_stale_evidence_data() {
        QTest::addColumn<QString>("drift");
        QTest::newRow("current")<<QString("none");
        QTest::newRow("before-start")<<QString("before");
        QTest::newRow("after-real-response")<<QString("after");
    }
    void rootless_registered_check_uses_real_protocol_and_rejects_stale_evidence() {
        QFETCH(QString,drift); QVERIFY(!python_.isEmpty() && !entry_.isEmpty());
        Environment env; Fixture f(3,false,false);
        auto profile=lmti::load_mcp_profile(f.profiles,"selected-project");
        profile.servers={{"lmti_context","LMTI context","","default",lmti::McpTransport::LmtiLocal,lmti::McpAuth::None}};
        lmti::save_mcp_profile(f.profiles,profile);
        // This fixed fixture wrapper buffers the actual local MCP response.
        // It mutates only its own library after the real protocol completed;
        // no provider, model turn, synthetic tool list, or SQL writer is used.
        const auto launcher=f.temp.filePath("lmti-agent-mcp.py"),marker=f.temp.filePath("protocol-completed");
        const auto values=QJsonDocument(QJsonArray{entry_,f.library,f.temp.filePath("retained-probe-library.sqlite"),marker,drift}).toJson(QJsonDocument::Compact);
        QByteArray script=R"PY(import contextlib,io,json,pathlib,runpy,sys
entry,library,retained,marker,drift=json.loads(%VALUES%)
buffer=io.BytesIO()
stream=io.TextIOWrapper(buffer,encoding='utf-8',write_through=True)
with contextlib.redirect_stdout(stream):
    runpy.run_path(entry,run_name='__main__')
stream.flush()
payload=buffer.getvalue()
responses=[json.loads(line) for line in payload.splitlines() if line.strip()]
assert any(row.get('id')==2 and len(row.get('result',{}).get('tools',[]))==4 for row in responses)
pathlib.Path(marker).write_text('real protocol completed',encoding='utf-8')
if drift=='after': pathlib.Path(library).rename(retained)
sys.stdout.buffer.write(payload)
)PY";
        const auto quoted=QJsonDocument(QJsonArray{QString::fromUtf8(values)}).toJson(QJsonDocument::Compact);
        script.replace("%VALUES%",quoted.mid(1,quoted.size()-2)); write(launcher,script);
        qputenv("LMTI_STUDIO_AGENT_ENTRY",launcher.toUtf8()); qunsetenv("LMTI_STUDIO_MCP_CONFIG_OWNER");
        McpProfilePanel p(f.profiles); p.bind(f.selection(),{"default"}); p.show();
        auto check=widget<QPushButton>(p,"checkLocalMcp"); QVERIFY(check->isEnabled());
        if(drift=="before") f.mutate("revision");
        check->click(); const auto status=widget<QLabel>(p,"mcpOperationStatus")->text();
        QCOMPARE(status.contains("responded with 4 tools"),drift=="none");
        QCOMPARE(QFileInfo::exists(marker),drift!="before");
        QVERIFY(!status.contains("libraryIdentity") && !status.contains("storeUuid"));
    }
    void modal_review_rejects_native_drift_data() {
        QTest::addColumn<QString>("change"); for(const auto *v:{"root-aba","delete-readd","library-uuid","project-uuid","revision","same-revision-content","profile"}) QTest::newRow(v)<<QString(v);
    }
    void modal_review_rejects_native_drift() {
        QFETCH(QString,change); Environment env; env.clear(); Fixture f(3,true,change!="same-revision-content");
        McpProfilePanel p(f.profiles); p.bind(f.selection(),{"default"}); p.show(); const auto destination=f.temp.filePath("denied.txt");
        QVERIFY(modal(p,"setupMcpCursor","mcpClientSetupDialog",[&](QDialog &dialog) {
            f.mutate(change); export_to(dialog,destination); need(!QFileInfo::exists(destination));
            need(!widget<QLabel>(dialog,"mcpSetupStatus")->text().contains("Exported"));
        }));
        QVERIFY(!QFileInfo::exists(destination)); QVERIFY(!QFileInfo::exists(at(f.root,".cursor/mcp.json")));
    }
    void cosmetics_and_identical_bind_semantics_data() {
        QTest::addColumn<int>("schema"); QTest::newRow("v1-conservative")<<1; QTest::newRow("v2")<<2; QTest::newRow("v3")<<3;
    }
    void cosmetics_and_identical_bind_semantics() {
        QFETCH(int,schema); Environment env; env.clear(); Fixture f(schema); McpProfilePanel p(f.profiles); p.bind(f.selection(),{"default"}); p.show();
        const auto destination=f.temp.filePath("cosmetic.txt");
        QVERIFY(modal(p,"setupMcpCursor","mcpClientSetupDialog",[&](QDialog &dialog) {
            p.bind(f.selection(),{"default"}); f.mutate("cosmetics"); export_to(dialog,destination);
        }));
        QCOMPARE(QFileInfo::exists(destination),schema>=2);
    }
    void nested_export_rejects_material_bind_epoch_changes_data() {
        QTest::addColumn<QString>("change"); for(const auto *v:{"other-project","root","dirty","aba"}) QTest::newRow(v)<<QString(v);
    }
    void nested_export_rejects_material_bind_epoch_changes() {
        QFETCH(QString,change); Environment env; env.clear(); Fixture f; McpProfilePanel p(f.profiles); p.bind(f.selection(),{"default"}); p.show();
        const auto destination=f.temp.filePath("epoch.txt");
        QVERIFY(modal(p,"setupMcpCursor","mcpClientSetupDialog",[&](QDialog &dialog) {
            export_to(dialog,destination,[&] {
                if(change=="other-project" || change=="aba") p.bind(f.alternate(),{"default"});
                else { auto next=f.selection(); if(change=="root") next.root=f.other_root; else next.clean=false; p.bind(next,{"default"}); }
                if(change=="aba") p.bind(f.selection(),{"default"});
            });
        }));
        QVERIFY(!QFileInfo::exists(destination));
    }
    void profile_editor_cannot_write_through_rebinding_or_profile_cas_data() {
        QTest::addColumn<bool>("rebind"); QTest::newRow("selection")<<true; QTest::newRow("profile-cas")<<false;
    }
    void profile_editor_cannot_write_through_rebinding_or_profile_cas() {
        QFETCH(bool,rebind); Environment env; env.clear(); Fixture f; McpProfilePanel p(f.profiles); p.bind(f.selection(),{"default"}); p.show();
        widget<QTreeWidget>(p,"projectMcpServers")->setCurrentItem(widget<QTreeWidget>(p,"projectMcpServers")->topLevelItem(0));
        QVERIFY(modal(p,"editMcpConnection","mcpConnectionDialog",[&](QDialog &dialog) {
            widget<QLineEdit>(dialog,"mcpConnectionName")->setText("Must not save");
            if(rebind) p.bind(f.alternate(),{"default"}); else f.mutate("profile");
            widget<QDialogButtonBox>(dialog,"")->button(QDialogButtonBox::Save)->click();
            need(!widget<QLabel>(dialog,"mcpConnectionError")->text().isEmpty());
        }));
        QCOMPARE(lmti::load_mcp_profile(f.profiles,"selected-project").revision,rebind?1:2);
        QCOMPARE(lmti::load_mcp_profile(f.profiles,"other-project").revision,1);
    }
    void acknowledged_native_profile_save_survives_binding_change_during_refresh() {
        Environment env; env.clear(); Fixture f; McpProfilePanel p(f.profiles); p.bind(f.selection(),{"default"}); p.show();
        auto tree=widget<QTreeWidget>(p,"projectMcpServers"); tree->setCurrentItem(tree->topLevelItem(0)); bool changed=false,failed=false;
        const auto connection=QObject::connect(tree->model(),&QAbstractItemModel::rowsInserted,&p,[&] {
            try { if(!changed && lmti::load_mcp_profile(f.profiles,"selected-project").revision==2) { changed=true; f.mutate("root-aba"); } }
            catch (...) { failed=true; }
        });
        const auto disconnect=qScopeGuard([&]{QObject::disconnect(connection);});
        QVERIFY(modal(p,"editMcpConnection","mcpConnectionDialog",[&](QDialog &dialog) {
            widget<QLineEdit>(dialog,"mcpConnectionName")->setText("Confirmed profile edit");
            widget<QDialogButtonBox>(dialog,"")->button(QDialogButtonBox::Save)->click();
            need(widget<QLabel>(dialog,"mcpConnectionError")->text().isEmpty());
        }));
        QVERIFY(changed && !failed); QCOMPARE(lmti::load_mcp_profile(f.profiles,"selected-project").revision,2);
        QCOMPARE(lmti::load_mcp_profile(f.profiles,"selected-project").servers.front().label,std::string("Confirmed profile edit"));
        QVERIFY(widget<QLabel>(p,"mcpOperationStatus")->text().contains("profile saved",Qt::CaseInsensitive));
    }
    void stale_apply_is_refused_before_the_real_config_owner_starts() {
        QVERIFY(!python_.isEmpty() && !owner_.isEmpty()); Environment env; Fixture f; OwnerWrapper wrapper(f,owner_,python_);
        McpProfilePanel p(f.profiles); p.bind(f.selection(),{"default"}); p.show();
        QVERIFY(modal(p,"setupMcpCursor","mcpClientSetupDialog",[&](QDialog &dialog) {
            f.mutate("root-aba"); auto apply=widget<QPushButton>(dialog,"applyMcpConfig"); need(apply->isEnabled()); apply->click();
            need(!p.has_pending_write() && wrapper.calls("apply")==0);
        }));
        QVERIFY(!QFileInfo::exists(at(f.root,".cursor/mcp.json")));
    }
    void real_ack_keeps_known_success_and_restore_uses_original_root_after_rebind() {
        QVERIFY2(!python_.isEmpty() && !owner_.isEmpty(),"Trusted Python and config owner required for process evidence.");
        Environment env; Fixture f; const auto path=original_client(f); OwnerWrapper wrapper(f,owner_,python_);
        McpProfilePanel p(f.profiles); p.bind(f.selection(),{"default"}); p.show();
        const auto cleanup=qScopeGuard([&]{wrapper.release();wait_until([&]{return !p.has_pending_write();},20000);});
        QVERIFY(modal(p,"setupMcpCursor","mcpClientSetupDialog",[&](QDialog &dialog) {
            wrapper.mode("hold-ack"); auto apply=widget<QPushButton>(dialog,"applyMcpConfig"); need(apply->isEnabled()); apply->click();
            need(wait_until([&]{return wrapper.marker("committed");})); need(p.has_pending_write());
            f.mutate("root-aba"); p.bind(f.alternate(),{"default"}); wrapper.release();
            need(wait_until([&]{return !p.has_pending_write();}));
            const auto status=widget<QLabel>(dialog,"mcpSetupStatus")->text();
            need(status.contains("Applied",Qt::CaseInsensitive) && !status.contains("not be confirmed",Qt::CaseInsensitive));
            need(!status.contains("synthetic_keep") && !apply->isEnabled());
            const auto target=widget<QLabel>(dialog,"mcpReviewedTarget")->text();
            need(target.contains(f.root) && target.contains("selected-project") && !target.contains("other-project"));
            need(read(path)!=original_config); need(wrapper.calls("apply",f.root)==1);
            wrapper.mode("normal"); auto restore=widget<QPushButton>(dialog,"restoreMcpConfig"); need(restore->isEnabled()); restore->click();
            need(wait_until([&]{return !p.has_pending_write();})); need(read(path)==original_config);
            need(wrapper.calls("restore_commit",f.root)==1 && wrapper.calls("restore_commit",f.other_root)==0);
            need(widget<QLabel>(dialog,"mcpSetupStatus")->text().contains("Restored",Qt::CaseInsensitive));
        }));
        QVERIFY(!QFileInfo::exists(at(f.other_root,".cursor/mcp.json"))); QCOMPARE(wrapper.calls("apply"),1);
    }
    void malformed_write_ack_is_unconfirmed_and_cannot_replay_data() {
        QTest::addColumn<QByteArray>("mode"); for(const auto *v:{"bare","extra","duplicate","wrong-target","wrong-revision","missing","write-overflow"}) QTest::newRow(v)<<QByteArray(v);
    }
    void malformed_write_ack_is_unconfirmed_and_cannot_replay() {
        QFETCH(QByteArray,mode); QVERIFY(!python_.isEmpty() && !owner_.isEmpty()); Environment env; Fixture f;
        const auto path=original_client(f); OwnerWrapper wrapper(f,owner_,python_); McpProfilePanel p(f.profiles); p.bind(f.selection(),{"default"}); p.show();
        const auto cleanup=qScopeGuard([&]{wrapper.release();wait_until([&]{return !p.has_pending_write();},20000);});
        QVERIFY(modal(p,"setupMcpCursor","mcpClientSetupDialog",[&](QDialog &dialog) {
            wrapper.mode(mode); auto apply=widget<QPushButton>(dialog,"applyMcpConfig"); need(apply->isEnabled()); apply->click();
            if(mode=="write-overflow") {
                need(wait_until([&]{return wrapper.marker("overflow-held");})); QTest::qWait(100);
                need(p.has_pending_write()); wrapper.release();
            }
            need(wait_until([&]{return !p.has_pending_write();})); need(wrapper.marker("committed")); need(read(path)!=original_config);
            const auto status=widget<QLabel>(dialog,"mcpSetupStatus")->text();
            need(status.contains("not be confirmed",Qt::CaseInsensitive) && !status.contains("synthetic_keep"));
            need(!apply->isEnabled()); apply->click(); need(wrapper.calls("apply")==1);
            wrapper.mode("normal"); auto restore=widget<QPushButton>(dialog,"restoreMcpConfig"); need(restore->isEnabled()); restore->click();
            need(wait_until([&]{return !p.has_pending_write();})); need(read(path)==original_config);
        }));
        QCOMPARE(wrapper.calls("apply"),1);
    }
    void recovery_preview_drift_cannot_restore_changed_config() {
        QVERIFY(!python_.isEmpty() && !owner_.isEmpty()); Environment env; Fixture f; const auto path=original_client(f);
        OwnerWrapper wrapper(f,owner_,python_); McpProfilePanel p(f.profiles); p.bind(f.selection(),{"default"}); p.show();
        const auto cleanup=qScopeGuard([&]{wrapper.release();wait_until([&]{return !p.has_pending_write();},20000);});
        QVERIFY(modal(p,"setupMcpCursor","mcpClientSetupDialog",[&](QDialog &dialog) {
            widget<QPushButton>(dialog,"applyMcpConfig")->click(); need(wait_until([&]{return !p.has_pending_write();}));
            const auto applied=read(path); need(applied!=original_config); wrapper.mode("restore-drift");
            widget<QPushButton>(dialog,"restoreMcpConfig")->click(); need(wait_until([&]{return !p.has_pending_write();}));
            need(read(path)==applied+"\n"); need(!widget<QLabel>(dialog,"mcpSetupStatus")->text().contains("Restored",Qt::CaseInsensitive));
            need(wrapper.calls("restore_commit")==1);
        }));
        QVERIFY(modal(p,"setupMcpCursor","mcpClientSetupDialog",[&](QDialog &dialog) {
            need(!widget<QPushButton>(dialog,"applyMcpConfig")->isEnabled());
            need(!widget<QPushButton>(dialog,"reviewCurrentMcpConfig")->isVisible());
            need(wrapper.calls("restore_commit")==1); // Unknown restore never becomes a fresh apply permission.
        }));
    }
    void unknown_apply_requires_explicit_current_review_without_retry_data() {
        QTest::addColumn<QString>("change");
        QTest::newRow("unchanged")<<QString("none");
        QTest::newRow("external-config")<<QString("config");
        QTest::newRow("source-revoked")<<QString("source");
    }
    void unknown_apply_requires_explicit_current_review_without_retry() {
        QFETCH(QString,change); QVERIFY(!python_.isEmpty() && !owner_.isEmpty()); Environment env; Fixture f;
        const auto path=original_client(f); OwnerWrapper wrapper(f,owner_,python_);
        McpProfilePanel p(f.profiles); p.bind(f.selection(),{"default"}); p.show();
        const auto cleanup=qScopeGuard([&]{wrapper.release();wait_until([&]{return !p.has_pending_write();},20000);});
        QVERIFY(modal(p,"setupMcpCursor","mcpClientSetupDialog",[&](QDialog &dialog) {
            wrapper.mode(change=="config"?"change-before-write":"refuse-before-write"); widget<QPushButton>(dialog,"applyMcpConfig")->click();
            need(wait_until([&]{return !p.has_pending_write();}));
            need(widget<QLabel>(dialog,"mcpSetupStatus")->text().contains("not be confirmed",Qt::CaseInsensitive));
            need(!widget<QPushButton>(dialog,"applyMcpConfig")->isEnabled());
        }));
        QCOMPARE(read(path),change=="config"?original_config+"\n":original_config); QCOMPARE(wrapper.calls("apply"),1);
        QVERIFY(!QFileInfo::exists(at(f.root,".lmti-client/cursor.backup.dpapi")));
        if(change=="source") f.mutate("root-aba");
        const auto current=read(path); wrapper.mode("normal");
        QVERIFY(modal(p,"setupMcpCursor","mcpClientSetupDialog",[&](QDialog &dialog) {
            need(!widget<QPushButton>(dialog,"applyMcpConfig")->isEnabled());
            need(!widget<QPushButton>(dialog,"restoreMcpConfig")->isEnabled());
            auto review=widget<QPushButton>(dialog,"reviewCurrentMcpConfig"); need(review->isVisible() && review->isEnabled());
            need(wrapper.calls("apply")==1); review->click();
            need(dialog.isVisible()==(change=="source"));
        }));
        QCOMPARE(wrapper.calls("apply"),1); QCOMPARE(read(path),current);
        QVERIFY(modal(p,"setupMcpCursor","mcpClientSetupDialog",[&](QDialog &dialog) {
            need(widget<QPushButton>(dialog,"applyMcpConfig")->isEnabled()==(change!="source"));
            need(wrapper.calls("apply")==1); // A separate fresh review never auto-applies.
        }));
        QCOMPARE(read(path),current); QCOMPARE(wrapper.calls("apply"),1);
    }
    void pending_journal_writer_survives_dialog_close_and_normal_window_close() {
        QVERIFY(!python_.isEmpty() && !owner_.isEmpty()); Environment env; Fixture f; const auto path=original_client(f);
        OwnerWrapper wrapper(f,owner_,python_); ProjectWindow window(nullptr,f.temp.filePath("catalog.sqlite"));
        window.open_project(f.database); window.set_language(true); window.show(); auto p=panel(window);
        const auto cleanup=qScopeGuard([&]{wrapper.release();wait_until([&]{return !p->has_pending_write();},20000);});
        QVERIFY(modal(*p,"setupMcpCursor","mcpClientSetupDialog",[&](QDialog &dialog) {
            wrapper.mode("hold-journal"); widget<QPushButton>(dialog,"applyMcpConfig")->click();
            need(wait_until([&]{return wrapper.marker("write-held");})); need(p->has_pending_write());
        }));
        QVERIFY(p->has_pending_write()); QVERIFY(QFileInfo::exists(at(f.root,".lmti-client/cursor.recovery.dpapi")));
        QVERIFY(!window.close()); QVERIFY(window.isVisible());
        QTest::qWait(8300); QVERIFY(p->has_pending_write()); QCOMPARE(read(path),original_config);
        wrapper.release(); QVERIFY(wait_until([&]{return !p->has_pending_write();}));
        QVERIFY(read(path)!=original_config); QVERIFY(!QFileInfo::exists(at(f.root,".lmti-client/cursor.recovery.dpapi")));
        QCOMPARE(wrapper.calls("apply"),1); QVERIFY(window.close());
    }
    void readonly_deadline_and_output_cap_do_not_create_write_jobs_data() {
        QTest::addColumn<QByteArray>("mode"); QTest::newRow("deadline")<<QByteArray("read-timeout"); QTest::newRow("cap")<<QByteArray("read-overflow");
    }
    void readonly_deadline_and_output_cap_do_not_create_write_jobs() {
        QFETCH(QByteArray,mode); QVERIFY(!python_.isEmpty() && !owner_.isEmpty()); Environment env; Fixture f; OwnerWrapper wrapper(f,owner_,python_);
        McpProfilePanel p(f.profiles); p.bind(f.selection(),{"default"}); p.show(); wrapper.mode(mode); QElapsedTimer elapsed; elapsed.start();
        QVERIFY(modal(p,"setupMcpCursor","mcpClientSetupDialog",[&](QDialog &dialog) {
            need(!widget<QPushButton>(dialog,"applyMcpConfig")->isEnabled());
            need(widget<QLabel>(dialog,"mcpSetupStatus")->text().size()<1024); need(!p.has_pending_write());
        }));
        QVERIFY(elapsed.elapsed()<12000); QCOMPARE(wrapper.calls("apply"),0);
        QVERIFY(!QFileInfo::exists(at(f.root,".cursor/mcp.json")));
    }
};
QTEST_MAIN(McpBindingTest)
#include "mcp_binding_test.moc"
