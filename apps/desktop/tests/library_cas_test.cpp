#include "project_window.hpp"
#include "lmti/project_library.hpp"
#include <QAction>
#include <QApplication>
#include <QDialogButtonBox>
#include <QElapsedTimer>
#include <QFile>
#include <QFileDialog>
#include <QMessageBox>
#include <QStandardPaths>
#include <QStatusBar>
#include <QTemporaryDir>
#include <QTimer>
#include <QtTest>
#include <algorithm>

namespace {
void need(bool ok) { if (!ok) throw lmti::Error("Disposable Qt fixture failed."); }
QByteArray bytes(const QString &path) {
    QFile file(path); need(file.open(QIODevice::ReadOnly)); return file.readAll();
}
void write(const QString &path,const QByteArray &value) {
    QFile file(path); need(file.open(QIODevice::WriteOnly|QIODevice::NewOnly)); need(file.write(value)==value.size());
}
QString at(const QString &root,const QString &name) { return QDir(root).filePath(name); }
lmti::ProjectDocument save_document(const QString &path,const std::string &id) {
    lmti::ProjectDocument document;
    document.project={id,"Synthetic project","Synthetic local fixture",lmti::Privacy::Internal};
    document.topology.revision=lmti::save_project(path,document); return document;
}
void upgrade(const QString &library,const QString &root,int schema) {
    const auto backups=at(root,"backups"); need(QDir().mkpath(backups));
    if (schema>=2) need(lmti::upgrade_project_library(library,backups,lmti::inspect_project_library(library).token).state==lmti::LibraryUpgradeState::Upgraded);
    if (schema==3) need(lmti::upgrade_library_activation_format(library,backups,lmti::inspect_library_activation_upgrade(library)).state==lmti::LibraryUpgradeState::Upgraded);
}
void seed(const QString &library,const QString &root,int schema) {
    const auto path=at(root,"seed.sqlite");
    if (!QFileInfo::exists(path)) save_document(path,"seed-project");
    lmti::remember_library_project(library,{"seed-project","Seed",path,{}}); upgrade(library,root,schema);
}
lmti::LibraryEntry entry(const QString &library,const QString &id) {
    const auto rows=lmti::project_library(library);
    const auto found=std::find_if(rows.begin(),rows.end(),[&](const auto &v){return v.id==id;});
    need(found!=rows.end()); return *found;
}
bool contains(const QString &library,const QString &id) {
    const auto rows=lmti::project_library(library);
    return std::any_of(rows.begin(),rows.end(),[&](const auto &v){return v.id==id;});
}
ProjectLibraryView *view(ProjectWindow &window) {
    // These existing QWidget subclasses intentionally have no Q_OBJECT.
    auto widget=window.findChild<QWidget *>("projectLibrary"); need(widget);
    return static_cast<ProjectLibraryView *>(widget);
}
ProjectSettingsView *settings(ProjectWindow &window) {
    auto widget=window.findChild<QWidget *>("projectSettingsPage"); need(widget);
    return static_cast<ProjectSettingsView *>(widget);
}
void schema_rows() {
    QTest::addColumn<int>("schema"); QTest::newRow("v2")<<2; QTest::newRow("v3")<<3;
}
struct DialogResult { int files=0,forms=0,questions=0,saves=0,warnings=0; bool timed_out=false,fixture_failed=false; };
DialogResult dialog_action(ProjectWindow &window,const QString &selection,const std::function<void()> &mutate,
                           const std::function<void()> &action,bool create_form=false,const QString &parent={},
                           bool save_dirty=false) {
    DialogResult result; bool handled=false; QElapsedTimer elapsed; elapsed.start(); QTimer timer;
    QObject::connect(&timer,&QTimer::timeout,&window,[&] {
        auto dialog=qobject_cast<QDialog *>(QApplication::activeModalWidget());
        if (!dialog) return;
        if (elapsed.elapsed()>5000) { result.timed_out=true; dialog->reject(); return; }
        try {
            if (auto message=qobject_cast<QMessageBox *>(dialog)) {
                if (message->standardButtons().testFlag(QMessageBox::Yes)) {
                    ++result.questions;
                    if (!handled) { handled=true; mutate(); }
                    need(message->button(QMessageBox::Yes)); message->button(QMessageBox::Yes)->click();
                } else if (save_dirty && message->standardButtons().testFlag(QMessageBox::Save) &&
                           message->standardButtons().testFlag(QMessageBox::Discard)) {
                    ++result.saves; need(message->button(QMessageBox::Save)); message->button(QMessageBox::Save)->click();
                } else { ++result.warnings; message->accept(); }
            } else if (auto file=qobject_cast<QFileDialog *>(dialog); file && !handled) {
                handled=true; ++result.files; mutate(); file->selectFile(selection);
                need(QMetaObject::invokeMethod(file,"accept",Qt::DirectConnection));
            } else if (create_form && dialog->objectName()=="createProjectDialog" && !handled) {
                handled=true; ++result.forms; mutate();
                const std::pair<QString,QString> fields[]={{"fieldTên dự án","Created while reviewing"},
                    {"fieldMục tiêu","Synthetic goal"},{"fieldTên thư mục",selection},{"fieldThư mục chứa",parent}};
                for (const auto &[name,value]:fields) { auto field=dialog->findChild<QLineEdit *>(name); need(field); field->setText(value); }
                auto buttons=dialog->findChild<QDialogButtonBox *>(); need(buttons && buttons->button(QDialogButtonBox::Save));
                buttons->button(QDialogButtonBox::Save)->click();
            }
        } catch (...) { result.fixture_failed=true; dialog->reject(); }
    });
    timer.start(5); action(); timer.stop(); return result;
}
bool warning(ProjectWindow &window) {
    return window.statusBar()->currentMessage().contains("library update failed",Qt::CaseInsensitive);
}
void root_aba(const QString &library,const QString &id,const QString &other,const QString &original) {
    const auto token=lmti::inspect_project_library(library).token;
    const auto changed=lmti::link_library_folder_cas(library,id,other,token);
    lmti::link_library_folder_cas(library,id,original,changed);
}
}

class LibraryCasTest : public QObject {
    Q_OBJECT
  private slots:
    void initTestCase() {
        QStandardPaths::setTestModeEnabled(true);
        QApplication::setAttribute(Qt::AA_DontUseNativeDialogs,true);
    }
    void explicit_registration_and_ordinary_save_no_resurrection_data() { schema_rows(); }
    void explicit_registration_and_ordinary_save_no_resurrection() {
        QFETCH(int,schema); QTemporaryDir temp; QVERIFY(temp.isValid());
        const auto library=temp.filePath("project-library.sqlite"), path=temp.filePath("open.sqlite");
        const auto original=save_document(path,"opened-project"); seed(library,temp.path(),schema);
        ProjectWindow window(nullptr,temp.filePath("catalog.sqlite")); window.set_language(true);
        const auto before=lmti::inspect_project_library(library).token;
        window.open_project(path);
        QCOMPARE(window.document(),original); QCOMPARE(entry(library,"opened-project").path,path);
        QCOMPARE(lmti::inspect_project_library(library).token.generation,before.generation+1);
        const auto registered=lmti::inspect_project_library(library).token;
        window.update_project([](auto &d){d.project.goal="Saved ordinary edit";}); window.save_to(path);
        QCOMPARE(lmti::inspect_project_library(library).token,registered);
        const auto removed=lmti::forget_library_project_cas(library,"opened-project",registered);
        window.update_project([](auto &d){d.project.goal="Still usable after removal";}); window.save_to(path);
        QVERIFY(!contains(library,"opened-project")); QCOMPARE(lmti::inspect_project_library(library).token,removed);
        QCOMPARE(lmti::load_project(path),window.document()); QCOMPARE(window.document().topology.revision,3);
        QVERIFY(warning(window));
    }
    void create_attach_and_first_save_register_explicitly_data() { schema_rows(); }
    void create_attach_and_first_save_register_explicitly() {
        QFETCH(int,schema); QTemporaryDir temp; QVERIFY(temp.isValid());
        const auto library=temp.filePath("project-library.sqlite"); seed(library,temp.path(),schema);
        ProjectWindow window(nullptr,temp.filePath("catalog.sqlite")); window.set_language(true);
        auto generation=lmti::inspect_project_library(library).token.generation;
        window.create_project_folder(temp.path(),"created","Created project");
        const auto created=QString::fromStdString(window.document().project.id);
        QCOMPARE(entry(library,created).path,temp.filePath("created/project.lmti.sqlite"));
        QCOMPARE(entry(library,created).folder,lmti::checked_project_folder(temp.filePath("created")));
        QCOMPARE(lmti::inspect_project_library(library).token.generation,++generation);
        QVERIFY(QDir(temp.path()).mkdir("source")); write(temp.filePath("source/main.cpp"),"// synthetic source\n");
        window.attach_project_folder(temp.filePath("source"));
        const auto attached=entry(library,QString::fromStdString(window.document().project.id));
        QCOMPARE(attached.folder,lmti::checked_project_folder(temp.filePath("source")));
        QCOMPARE(bytes(temp.filePath("source/main.cpp")),QByteArray("// synthetic source\n"));
        QCOMPARE(QDir(temp.filePath("source")).entryList(QDir::Files|QDir::Hidden),QStringList{"main.cpp"});
        QCOMPARE(lmti::load_project(attached.path),window.document());
        QCOMPARE(lmti::inspect_project_library(library).token.generation,++generation);
        window.new_project("Unsaved draft"); const auto first=temp.filePath("first-save.sqlite"); window.save_to(first);
        QCOMPARE(entry(library,QString::fromStdString(window.document().project.id)).path,first);
        QCOMPARE(lmti::inspect_project_library(library).token.generation,++generation); QVERIFY(!warning(window));
    }
    void same_path_attach_can_deliberately_link_root_data() { schema_rows(); }
    void same_path_attach_can_deliberately_link_root() {
        QFETCH(int,schema); QTemporaryDir temp; QVERIFY(temp.isValid());
        QVERIFY(QDir(temp.path()).mkdir("existing"));
        const auto library=temp.filePath("project-library.sqlite"), path=temp.filePath("existing/project.lmti.sqlite");
        save_document(path,"attached-project"); seed(library,temp.path(),schema);
        lmti::register_library_project_cas(library,{"attached-project","Existing",path,{}},lmti::inspect_project_library(library).token);
        ProjectWindow window(nullptr,temp.filePath("catalog.sqlite")); window.set_language(true);
        const auto before=lmti::inspect_project_library(library).token; const auto project_before=bytes(path);
        window.attach_project_folder(temp.filePath("existing"));
        QCOMPARE(entry(library,"attached-project").folder,lmti::checked_project_folder(temp.filePath("existing")));
        QCOMPARE(lmti::inspect_project_library(library).token.generation,before.generation+1);
        QCOMPARE(bytes(path),project_before); QVERIFY(!warning(window));
    }
    void retained_source_cannot_inherit_or_change_current_target_root_data() { schema_rows(); }
    void retained_source_cannot_inherit_or_change_current_target_root() {
        QFETCH(int,schema); QTemporaryDir temp; QVERIFY(temp.isValid());
        QVERIFY(QDir(temp.path()).mkdir("target-root")); QVERIFY(QDir(temp.path()).mkdir("other-root"));
        const auto library=temp.filePath("project-library.sqlite"), source=temp.filePath("source.sqlite"), target=temp.filePath("target.sqlite");
        save_document(source,"shared-project"); save_document(target,"shared-project"); seed(library,temp.path(),schema);
        lmti::register_library_project_cas(library,{"shared-project","Current",target,temp.filePath("target-root")},lmti::inspect_project_library(library).token);
        ProjectWindow window(nullptr,temp.filePath("catalog.sqlite")); window.set_language(true);
        const auto token=lmti::inspect_project_library(library).token; const auto target_before=bytes(target);
        window.open_project(source); QVERIFY(warning(window));
        auto field=window.findChild<QLineEdit *>("settingsFolder"); QVERIFY(field); QVERIFY(field->toolTip().isEmpty());
        QCOMPARE(lmti::inspect_project_library(library).token,token);
        window.show();
        const auto dialog=dialog_action(window,temp.filePath("other-root"),[]{},[&]{settings(window)->choose_folder();});
        QCOMPARE(dialog.files,0); QCOMPARE(dialog.warnings,1); QVERIFY(!dialog.timed_out && !dialog.fixture_failed);
        QCOMPARE(lmti::inspect_project_library(library).token,token);
        window.update_project([](auto &d){d.project.goal="Retained source edit";}); window.save_to(source);
        QCOMPARE(lmti::load_project(source),window.document()); QCOMPARE(bytes(target),target_before);
        QCOMPARE(lmti::inspect_project_library(library).token,token); QVERIFY(warning(window));
    }
    void reviewed_root_and_remove_actions_data() {
        QTest::addColumn<int>("schema"); QTest::addColumn<QString>("operation"); QTest::addColumn<bool>("stale");
        for (int schema:{2,3}) for (const auto &operation:{QString("library-root"),QString("settings-root"),QString("remove")})
            for (bool stale:{false,true}) QTest::newRow(qPrintable(QString("v%1-%2-%3").arg(schema).arg(operation).arg(stale)))<<schema<<operation<<stale;
    }
    void reviewed_root_and_remove_actions() {
        QFETCH(int,schema); QFETCH(QString,operation); QFETCH(bool,stale); QTemporaryDir temp; QVERIFY(temp.isValid());
        for (const auto &name:{"original-root","chosen-root","intervening-root"}) QVERIFY(QDir(temp.path()).mkdir(name));
        const auto library=temp.filePath("project-library.sqlite"), path=temp.filePath("selected.sqlite");
        save_document(path,"selected-project"); seed(library,temp.path(),schema);
        lmti::register_library_project_cas(library,{"selected-project","Selected",path,temp.filePath("original-root")},lmti::inspect_project_library(library).token);
        ProjectWindow window(nullptr,temp.filePath("catalog.sqlite")); window.set_language(true); window.open_project(path); window.show();
        const auto selected=entry(library,"selected-project"); const auto before=lmti::inspect_project_library(library).token;
        const auto project_before=bytes(path); lmti::LibraryToken concurrent;
        const auto result=dialog_action(window,temp.filePath("chosen-root"),[&] {
            if (stale) { root_aba(library,selected.id,temp.filePath("intervening-root"),temp.filePath("original-root")); concurrent=lmti::inspect_project_library(library).token; }
        },[&] {
            if (operation=="remove") view(window)->remove_reference(selected);
            else if (operation=="settings-root") settings(window)->choose_folder();
            else view(window)->change_folder(selected);
        });
        QVERIFY(!result.timed_out && !result.fixture_failed);
        QCOMPARE(result.files,operation=="remove"?0:1); QCOMPARE(result.questions,operation=="remove"?1:0);
        QCOMPARE(bytes(path),project_before);
        if (stale) {
            QCOMPARE(result.warnings,1); QCOMPARE(lmti::inspect_project_library(library).token,concurrent);
            QCOMPARE(entry(library,selected.id).folder,selected.folder);
        } else {
            QCOMPARE(result.warnings,0); QCOMPARE(lmti::inspect_project_library(library).token.generation,before.generation+1);
            if (operation=="remove") QVERIFY(!contains(library,selected.id));
            else QCOMPARE(entry(library,selected.id).folder,lmti::checked_project_folder(temp.filePath("chosen-root")));
        }
        auto active_folder=window.findChild<QLabel *>("activeProjectFolder"); QVERIFY(active_folder);
        auto settings_folder=window.findChild<QLineEdit *>("settingsFolder"); QVERIFY(settings_folder);
        if (stale || operation=="remove") {
            QVERIFY(active_folder->toolTip().isEmpty()); QVERIFY(settings_folder->toolTip().isEmpty());
        } else {
            const auto chosen=lmti::checked_project_folder(temp.filePath("chosen-root"));
            QCOMPARE(active_folder->toolTip(),chosen); QCOMPARE(settings_folder->toolTip(),chosen);
        }
        QVERIFY(QFileInfo::exists(temp.filePath("original-root")));
    }
    void same_path_open_loses_inherited_root_if_binding_changes_during_dialog_data() { schema_rows(); }
    void same_path_open_loses_inherited_root_if_binding_changes_during_dialog() {
        QFETCH(int,schema); QTemporaryDir temp; QVERIFY(temp.isValid());
        QVERIFY(QDir(temp.path()).mkdir("old-root")); QVERIFY(QDir(temp.path()).mkdir("new-root"));
        const auto library=temp.filePath("project-library.sqlite"), path=temp.filePath("selected.sqlite");
        const auto document=save_document(path,"selected-project"); seed(library,temp.path(),schema);
        lmti::register_library_project_cas(library,{"selected-project","Selected",path,temp.filePath("old-root")},lmti::inspect_project_library(library).token);
        ProjectWindow window(nullptr,temp.filePath("catalog.sqlite")); window.set_language(true); window.show();
        const auto project_before=bytes(path); lmti::LibraryToken concurrent;
        const auto result=dialog_action(window,path,[&] {
            concurrent=lmti::link_library_folder_cas(library,"selected-project",temp.filePath("new-root"),lmti::inspect_project_library(library).token);
        },[&] { auto action=window.findChild<QAction *>("openProjectFile"); need(action); action->trigger(); });
        QVERIFY(!result.timed_out && !result.fixture_failed); QCOMPARE(result.files,1); QCOMPARE(result.warnings,0);
        QCOMPARE(window.document(),document); QCOMPARE(bytes(path),project_before); QVERIFY(warning(window));
        QCOMPARE(lmti::inspect_project_library(library).token,concurrent);
        QCOMPARE(entry(library,"selected-project").folder,lmti::checked_project_folder(temp.filePath("new-root")));
        auto folder=window.findChild<QLabel *>("activeProjectFolder"); QVERIFY(folder); QVERIFY(folder->toolTip().isEmpty());
        auto field=window.findChild<QLineEdit *>("settingsFolder"); QVERIFY(field); QVERIFY(field->toolTip().isEmpty());
    }
    void library_changed_during_dialog_keeps_saved_document_without_registering_data() {
        QTest::addColumn<QString>("operation"); QTest::addColumn<bool>("initial_v1");
        for (const auto &operation:{QString("open"),QString("create"),QString("save")})
            for (bool initial:{false,true}) QTest::newRow(qPrintable(operation+(initial?"-v1-upgrade":"-missing-appears")))<<operation<<initial;
    }
    void library_changed_during_dialog_keeps_saved_document_without_registering() {
        QFETCH(QString,operation); QFETCH(bool,initial_v1); QTemporaryDir temp; QVERIFY(temp.isValid());
        const auto library=temp.filePath("project-library.sqlite"), open_path=temp.filePath("opened.sqlite"), save_path=temp.filePath("saved.sqlite");
        save_document(open_path,"opened-during-review");
        if (initial_v1) seed(library,temp.path(),1);
        ProjectWindow window(nullptr,temp.filePath("catalog.sqlite")); window.set_language(true); window.show();
        QCOMPARE(QFileInfo::exists(library),initial_v1);
        if (operation=="save") window.new_project("Draft during review");
        lmti::LibraryToken concurrent;
        const auto selection=operation=="open"?open_path:operation=="save"?save_path:QString("created-during-review");
        const auto result=dialog_action(window,selection,[&] {
            if (initial_v1) upgrade(library,temp.path(),2); else seed(library,temp.path(),2);
            concurrent=lmti::inspect_project_library(library).token;
        },[&] {
            auto action=window.findChild<QAction *>(operation=="open"?"openProjectFile":operation=="save"?"saveProjectFile":"createProject");
            need(action); action->trigger();
        },operation=="create",temp.path());
        QVERIFY(!result.timed_out && !result.fixture_failed); QCOMPARE(result.warnings,0);
        QCOMPARE(result.forms,operation=="create"?1:0); QCOMPARE(result.files,operation=="create"?0:1);
        const auto path=operation=="open"?open_path:operation=="save"?save_path:temp.filePath("created-during-review/project.lmti.sqlite");
        QVERIFY(QFileInfo::exists(path)); QCOMPARE(lmti::load_project(path),window.document());
        QVERIFY(warning(window)); QVERIFY(!contains(library,QString::fromStdString(window.document().project.id)));
        QCOMPARE(lmti::inspect_project_library(library).token,concurrent);
        window.update_project([](auto &d){d.project.goal="Usable saved project after conflict";}); window.save_to(path);
        QCOMPARE(lmti::load_project(path),window.document()); QCOMPARE(lmti::inspect_project_library(library).token,concurrent);
        QVERIFY(warning(window));
    }
    void legacy_discard_save_then_open_ignores_own_cosmetic_refresh() {
        QTemporaryDir temp; QVERIFY(temp.isValid()); ProjectWindow window(nullptr,temp.filePath("catalog.sqlite"));
        window.set_language(true); window.create_project_folder(temp.path(),"first","First project");
        const auto first_id=QString::fromStdString(window.document().project.id), first=temp.filePath("first/project.lmti.sqlite");
        window.create_project_folder(temp.path(),"second","Second project");
        const auto second=temp.filePath("second/project.lmti.sqlite"); const auto second_document=window.document();
        window.open_project(first); window.update_project([](auto &d){d.project.label="Edited before opening";});
        const auto reviewed=lmti::inspect_project_library(window.library_path());
        const auto draft=window.document(); window.show();
        const auto result=dialog_action(window,second,[]{},[&] {
            auto action=window.findChild<QAction *>("openProjectFile"); need(action); action->trigger();
        },false,{},true);
        QVERIFY(!result.timed_out && !result.fixture_failed); QCOMPARE(result.saves,1); QCOMPARE(result.files,1); QCOMPARE(result.warnings,0);
        const auto persisted=lmti::load_project(first);
        QCOMPARE(persisted.project,draft.project); QCOMPARE(persisted.topology.revision,2);
        QCOMPARE(window.document(),second_document); QVERIFY(!warning(window));
        const auto after=lmti::inspect_project_library(window.library_path());
        QCOMPARE(after.token.schema,1); QVERIFY(after.token.digest!=reviewed.token.digest);
        QCOMPARE(entry(window.library_path(),first_id).label,QString("Edited before opening"));
        QCOMPARE(after.entries.size(),reviewed.entries.size());
        for (const auto &before:reviewed.entries) {
            const auto current=entry(window.library_path(),before.id);
            QCOMPARE(current.path,before.path); QCOMPARE(current.folder,before.folder);
        }
    }
    void legacy_locate_and_save_as_remain_available() {
        QTemporaryDir temp; QVERIFY(temp.isValid()); ProjectWindow window(nullptr,temp.filePath("catalog.sqlite"));
        window.set_language(true); window.create_project_folder(temp.path(),"legacy","Legacy project");
        const auto id=QString::fromStdString(window.document().project.id), old=temp.filePath("legacy/project.lmti.sqlite"), moved=temp.filePath("moved.sqlite");
        const auto selected=entry(window.library_path(),id); QVERIFY(QFile::rename(old,moved)); window.show();
        const auto result=dialog_action(window,moved,[]{},[&]{view(window)->locate_project(selected);});
        QVERIFY(!result.timed_out && !result.fixture_failed); QCOMPARE(result.files,1); QCOMPARE(result.warnings,0);
        QCOMPARE(entry(window.library_path(),id).path,moved);
        const auto copy=temp.filePath("copy.sqlite"); window.save_to(copy);
        QCOMPARE(entry(window.library_path(),id).path,copy); QVERIFY(QFileInfo::exists(moved));
        QCOMPARE(lmti::inspect_project_library(window.library_path()).token.schema,1);
    }
};
QTEST_MAIN(LibraryCasTest)
#include "library_cas_test.moc"
