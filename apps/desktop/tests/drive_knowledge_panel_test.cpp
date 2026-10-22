#include "drive_captions.hpp"
#include "drive_knowledge_panel.hpp"
#include <QApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QLineEdit>
#include <QScopeGuard>
#include <QStandardPaths>
#include <QTemporaryDir>
#include <QtTest>

namespace {
class Environment {
    QMap<QByteArray, QByteArray> values_;
    QSet<QByteArray> present_;
    bool english_ = project_english;

  public:
    Environment(const QString &node, const QString &cli, bool enabled = true) {
        for (const auto name :
             {"LMTI_STUDIO_NODE_BINARY", "LMTI_STUDIO_CLI", "LMTI_STUDIO_ALLOW_GOOGLE_DRIVE",
              "LMTI_GOOGLE_CLIENT_ID", "LMTI_GOOGLE_CLIENT_SECRET", "NODE_OPTIONS", "NODE_PATH",
              "LMTI_TEST_UNRELATED"}) {
            values_.insert(name, qgetenv(name));
            if (qEnvironmentVariableIsSet(name))
                present_.insert(name);
        }
        qputenv("LMTI_STUDIO_NODE_BINARY", node.toUtf8());
        qputenv("LMTI_STUDIO_CLI", cli.toUtf8());
        qputenv("LMTI_STUDIO_ALLOW_GOOGLE_DRIVE", enabled ? "1" : "0");
        qputenv("LMTI_GOOGLE_CLIENT_ID", "synthetic-public-client.apps.googleusercontent.com");
        qputenv("LMTI_GOOGLE_CLIENT_SECRET", "synthetic-test-only-value");
        // These must never reach the owner child, even when the host has them.
        qputenv("NODE_OPTIONS", "--definitely-invalid-test-option");
        qputenv("NODE_PATH", "synthetic-untrusted-module-path");
        qputenv("LMTI_TEST_UNRELATED", "synthetic-host-only");
        project_english = true;
    }
    ~Environment() {
        for (auto it = values_.begin(); it != values_.end(); ++it)
            if (present_.contains(it.key()))
                qputenv(it.key().constData(), it.value());
            else
                qunsetenv(it.key().constData());
        project_english = english_;
    }
};
bool write_file(const QString &path, const QByteArray &data) {
    QFile file(path);
    return file.open(QIODevice::WriteOnly | QIODevice::Truncate) && file.write(data) == data.size();
}
QByteArray bytes(const QString &path) {
    QFile file(path);
    return file.open(QIODevice::ReadOnly) ? file.readAll() : QByteArray{};
}
QPushButton *action(DriveKnowledgePanel &panel, const char *name) {
    return panel.findChild<QPushButton *>(name);
}
QLabel *status(DriveKnowledgePanel &panel) {
    return panel.findChild<QLabel *>("driveStatus");
}
QTreeWidget *files(DriveKnowledgePanel &panel) {
    return panel.findChild<QTreeWidget *>("driveFiles");
}
QPlainTextEdit *preview(DriveKnowledgePanel &panel) {
    return panel.findChild<QPlainTextEdit *>("drivePreview");
}
QCheckBox *ack(DriveKnowledgePanel &panel) {
    return panel.findChild<QCheckBox *>("driveScopeAcknowledgment");
}
bool capture(DriveKnowledgePanel &panel, const QString &name) {
    const auto path = qEnvironmentVariable("LMTI_DRIVE_RENDER_DIR");
    if (path.isEmpty())
        return true;
    const QFileInfo directory(path);
    if (!directory.isAbsolute() || !directory.isDir() || directory.isSymLink())
        return false;
    QCoreApplication::processEvents();
    return panel.grab().save(QDir(directory.canonicalFilePath()).filePath(name + ".png"));
}
QByteArray script(const QByteArray &mutation = {}) {
    return QByteArray(R"JS(
const readline = require('node:readline');
const crypto = require('node:crypto');
if(process.argv[2] !== 'drive-desktop' || process.env.NODE_OPTIONS || process.env.NODE_PATH ||
   process.env.LMTI_TEST_UNRELATED || process.env.LMTI_STUDIO_CLI ||
   process.env.LMTI_STUDIO_ALLOW_GOOGLE_DRIVE !== '1' ||
   process.env.LMTI_GOOGLE_CLIENT_ID !== 'synthetic-public-client.apps.googleusercontent.com' ||
   process.env.LMTI_GOOGLE_CLIENT_SECRET !== 'synthetic-test-only-value') process.exit(19);
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
const stamp='2026-10-13T00:00:00.000Z', connection='c'.repeat(64), scope='a'.repeat(64);
const item=(id,name,kind='folder')=>({id,name,kind,version:'7',modifiedTime:stamp,
 mimeType:kind==='folder'?'application/vnd.google-apps.folder':kind==='document'?'text/plain':'application/pdf',
 canDownload:true,readable:kind==='document'});
const folder=id=>item(id,id==='drive_root'?'My Drive':id==='folder_A'?'Selected project folder':'Child folder');
const document=item('document_A','Synthetic <b>plain</b> document','document');
const page=(id,picker=false)=>({folder:folder(id),files:picker?[folder('folder_A')]:[
 document,folder('folder_child'),item('pdf_A','Synthetic PDF','unsupported')],partial:false,checkedAt:stamp});
const content='<b>This is plain text</b>\nSynthetic local document.';
let connected=false, selected=false, lastRequest=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.schema!=='lmti.desktop.drive.request.v1' || !Number.isSafeInteger(r.requestId) ||
    r.requestId<=lastRequest || r.projectId!=='factory-monitor' || r.projectRevision<1 ||
    r.connectionId!==(connected?connection:'')) process.exit(20);
 lastRequest=r.requestId;
 const base={requestId:r.requestId,projectId:r.projectId,documentPath:r.documentPath,
   projectRevision:r.projectRevision,connectionId:r.connectionId};
 const response={...base,schema:'lmti.desktop.drive.response.v1',operation:r.operation,
   ok:true,purpose:'local_view',externalEgress:'denied',result:{}};
 let event;
 if(r.operation==='status') response.result={configured:true,connected};
 else if(r.operation==='connect') {
   if(r.acknowledgedScope!==true) process.exit(21);
   event={...base,schema:'lmti.desktop.drive.event.v1',event:'authorize',
     url:'https://accounts.google.com/o/oauth2/v2/auth?'+new URLSearchParams({
       client_id:process.env.LMTI_GOOGLE_CLIENT_ID,redirect_uri:'http://127.0.0.1:43210/oauth2/callback',
       response_type:'code',scope:'https://www.googleapis.com/auth/drive.readonly',
       code_challenge:'a'.repeat(43),code_challenge_method:'S256',state:'b'.repeat(43),
       access_type:'offline',prompt:'select_account'}).toString()};
   connected=true; response.result={connectionId:connection,account:{id:'account_A',displayName:'Synthetic account'},page:page('drive_root',true)};
 } else if(r.operation==='select-folder') {
   selected=true; response.result={root:folder(r.folderReference),scopeId:scope,page:page(r.folderReference)};
 } else if(r.operation==='choose-folder') {
   selected=false; response.result={page:page('drive_root',true)};
 } else if(r.operation==='browse-folders') response.result={page:page(r.folderId||'drive_root',true)};
 else if(r.operation==='list') {
   if(!selected)process.exit(22); response.result={page:page(r.folderId||'folder_A')};
 } else if(r.operation==='read') {
   if(!selected || r.fileId!=='document_A' || r.expectedVersion!=='7')process.exit(23);
   response.result={document:{file:document,text:content,
    contentHash:crypto.createHash('sha256').update(content).digest('hex'),checkedAt:stamp,scopeId:scope}};
 } else process.exit(24);
)JS") + mutation +
           QByteArray(R"JS(
 if(event)send(event);
 send(response);
});
)JS");
}
struct Fixture {
    QTemporaryDir directory;
    QString cli = directory.filePath("index.js");
    QString project = directory.filePath("project.lmti.sqlite");
    bool initialize(const QByteArray &mutation = {}) {
        return directory.isValid() && write_file(cli, script(mutation)) &&
               write_file(project, "synthetic native owner file: never write from Drive\n");
    }
};
} // namespace

class DriveKnowledgePanelTest : public QObject {
    Q_OBJECT
    QString node_;
    void verify_notice_geometry(DriveKnowledgePanel &panel) {
        QCoreApplication::processEvents();
        auto previous = action(panel, "driveConnect")->isVisible() ? action(panel, "driveConnect")
                                                                   : action(panel, "driveDisconnect");
        QRect previous_bounds(previous->mapTo(&panel, QPoint{}), previous->size());
        for (const auto name : {"driveScopeAcknowledgment", "driveBoundary", "driveStatus", "driveSource"}) {
            const auto notice = panel.findChild<QWidget *>(name);
            QVERIFY2(notice, name);
            if (notice->isHidden())
                continue; // Stage-specific visibility is asserted separately below.
            QVERIFY2(notice->isVisible(), name);
            const QRect bounds(notice->mapTo(&panel, QPoint{}), notice->size());
            QVERIFY2(bounds.height() >= notice->fontMetrics().height(), name);
            QVERIFY2(bounds.height() >= notice->heightForWidth(bounds.width()), name);
            QVERIFY2(panel.rect().contains(bounds), name);
            QVERIFY2(bounds.top() > previous_bounds.bottom(), name);
            QVERIFY2(!bounds.intersects(previous_bounds), name);
            previous_bounds = bounds;
        }
    }
    void start(DriveKnowledgePanel &panel, const QString &path) {
        panel.bind_project("factory-monitor", path, 7, true);
        if (action(panel, "driveRefresh")->isEnabled())
            action(panel, "driveRefresh")->click();
        QTRY_COMPARE(status(panel)->text(),
                     drive_caption("Review the permission notice, then connect Google Drive."));
        QVERIFY(!action(panel, "driveConnect")->isEnabled());
        ack(panel)->setChecked(true);
        QVERIFY(action(panel, "driveConnect")->isEnabled());
        action(panel, "driveConnect")->click();
        QTRY_VERIFY(action(panel, "driveUseFolder")->isEnabled());
        QCOMPARE(files(panel)->topLevelItemCount(), 1);
        files(panel)->setCurrentItem(files(panel)->topLevelItem(0));
        action(panel, "driveUseFolder")->click();
        QTRY_COMPARE(files(panel)->topLevelItemCount(), 3);
        files(panel)->setCurrentItem(files(panel)->topLevelItem(0));
        QTRY_VERIFY(action(panel, "driveRead")->isEnabled());
    }

  private slots:
    void initTestCase() {
        node_ = qEnvironmentVariable("LMTI_STUDIO_NODE_BINARY");
        if (node_.isEmpty())
            node_ = QStandardPaths::findExecutable("node");
        QVERIFY2(!node_.isEmpty(), "Drive desktop tests require the configured local Node runtime.");
    }
    void configuration_and_acknowledgment_are_required() {
        Fixture fixture;
        QVERIFY(fixture.initialize("if(r.operation==='status') response.result.configured=false;"));
        {
            Environment environment(node_, fixture.cli, false);
            DriveKnowledgePanel panel;
            panel.bind_project("factory-monitor", fixture.project, 7, true);
            QCOMPARE(status(panel)->text(), "Google Drive is unavailable in this build.");
            QVERIFY(!action(panel, "driveConnect")->isEnabled());
            QVERIFY(panel.findChildren<QLineEdit *>().isEmpty());
            QVERIFY(panel.findChildren<QProcess *>().isEmpty());
        }
        Environment environment(node_, fixture.cli);
        DriveKnowledgePanel panel;
        panel.bind_project("factory-monitor", fixture.project, 7, true);
        QTRY_VERIFY(status(panel)->text().contains("LMTI publisher"));
        ack(panel)->setChecked(true);
        QVERIFY(!action(panel, "driveConnect")->isEnabled());
        QVERIFY(!action(panel, "driveRead")->isEnabled());
        panel.resize(860, 620);
        panel.show();
        QVERIFY(capture(panel, "drive-setup-missing-en"));
        project_english = false;
        panel.bind_project("factory-monitor", fixture.project, 7, true);
        QVERIFY(capture(panel, "drive-setup-missing-vi"));
        project_english = true;
        panel.bind_project("factory-monitor", fixture.project, 7, false);
        QVERIFY(status(panel)->text().contains("Save the project"));
    }
    void real_broker_status_uses_the_launcher_capability_without_network() {
        const auto cli = qEnvironmentVariable("LMTI_STUDIO_TEST_CLI");
        if (cli.isEmpty())
            QSKIP("Set LMTI_STUDIO_TEST_CLI to exercise the built Drive broker status protocol.");
        QVERIFY(QFileInfo(cli).isAbsolute() && QFileInfo(cli).isFile());
        Fixture fixture;
        QVERIFY(fixture.initialize());
        const auto original = bytes(fixture.project);
        Environment environment(node_, cli);
        int browsers = 0;
        {
            DriveKnowledgePanel panel;
            panel.set_browser_handler([&](const QUrl &) {
                ++browsers;
                return false;
            });
            panel.bind_project("factory-monitor", fixture.project, 7, true);
            QTRY_COMPARE(status(panel)->text(),
                         drive_caption("Review the permission notice, then connect Google Drive."));
            QVERIFY(!action(panel, "driveConnect")->isEnabled());
            ack(panel)->setChecked(true);
            QVERIFY(action(panel, "driveConnect")->isEnabled());
            action(panel, "driveRefresh")->click();
            QTRY_VERIFY(action(panel, "driveConnect")->isEnabled());
            QCOMPARE(browsers, 0);
        }
        qunsetenv("LMTI_GOOGLE_CLIENT_ID");
        {
            DriveKnowledgePanel panel;
            panel.set_browser_handler([&](const QUrl &) {
                ++browsers;
                return false;
            });
            panel.bind_project("factory-monitor", fixture.project, 7, true);
            QTRY_VERIFY(status(panel)->text().contains("LMTI publisher"));
            ack(panel)->setChecked(true);
            QVERIFY(!action(panel, "driveConnect")->isEnabled());
            QCOMPARE(browsers, 0);
        }
        QCOMPARE(bytes(fixture.project), original);
    }
    void quick_connect_folder_read_and_disconnect_are_session_only() {
        Fixture fixture;
        QVERIFY(fixture.initialize());
        const auto original = bytes(fixture.project);
        Environment environment(node_, fixture.cli);
        DriveKnowledgePanel panel;
        QList<QUrl> opened;
        panel.set_browser_handler([&](const QUrl &url) {
            opened.append(url);
            return true;
        });
        start(panel, fixture.project);
        QCOMPARE(opened.size(), 1);
        QCOMPARE(opened.front().host(), "accounts.google.com");
        action(panel, "driveRead")->click();
        QTRY_VERIFY(!preview(panel)->toPlainText().isEmpty());
        QCOMPARE(preview(panel)->toPlainText(), "<b>This is plain text</b>\nSynthetic local document.");
        QVERIFY(preview(panel)->isReadOnly());
        QCOMPARE(files(panel)->currentItem()->data(0, Qt::UserRole).toString(), "document_A");
        QCOMPARE(bytes(fixture.project), original);
        // Unsupported formats remain explicit browser actions, never preview reads.
        files(panel)->setCurrentItem(files(panel)->topLevelItem(2));
        QVERIFY(preview(panel)->toPlainText().isEmpty());
        QVERIFY(!action(panel, "driveRead")->isEnabled());
        QVERIFY(action(panel, "driveOpen")->isEnabled());
        action(panel, "driveOpen")->click();
        QCOMPARE(opened.last(), QUrl("https://drive.google.com/file/d/pdf_A/view"));
        action(panel, "driveChooseFolder")->click();
        QTRY_VERIFY(action(panel, "driveUseFolder")->isEnabled());
        QVERIFY(!action(panel, "driveRead")->isEnabled());
        action(panel, "driveDisconnect")->click();
        QCOMPARE(files(panel)->topLevelItemCount(), 0);
        QVERIFY(!ack(panel)->isChecked());
        QVERIFY(preview(panel)->toPlainText().isEmpty());
        QVERIFY(!action(panel, "driveConnect")->isEnabled());
        QCOMPARE(bytes(fixture.project), original);
    }
    void wrong_document_envelopes_clear_the_session_data() {
        QTest::addColumn<QByteArray>("mutation");
        QTest::newRow("project") << QByteArray(
            "if(r.operation==='read')response.projectId='another-project';");
        QTest::newRow("path") << QByteArray("if(r.operation==='read')response.documentPath+='other';");
        QTest::newRow("revision") << QByteArray("if(r.operation==='read')response.projectRevision++;");
        QTest::newRow("request") << QByteArray("if(r.operation==='read')response.requestId++;");
        QTest::newRow("connection") << QByteArray("if(r.operation==='read')response.connectionId='other';");
        QTest::newRow("egress") << QByteArray("if(r.operation==='read')response.externalEgress='allowed';");
        QTest::newRow("scope") << QByteArray(
            "if(r.operation==='read')response.result.document.scopeId='b'.repeat(64);");
        QTest::newRow("file") << QByteArray(
            "if(r.operation==='read')response.result.document.file.id='outside-folder';");
        QTest::newRow("version") << QByteArray(
            "if(r.operation==='read')response.result.document.file.version='8';");
        QTest::newRow("hash") << QByteArray(
            "if(r.operation==='read')response.result.document.contentHash='f'.repeat(64);");
        QTest::newRow("malformed") << QByteArray(
            "if(r.operation==='read'){process.stdout.write('{bad\\n');return;}");
        QTest::newRow("oversized-line")
            << QByteArray("if(r.operation==='read'){process.stdout.write('x'.repeat(2097153));return;}");
        QTest::newRow("oversized-text")
            << QByteArray("if(r.operation==='read'){const "
                          "d=response.result.document;d.text='x'.repeat(524289);d.contentHash=crypto."
                          "createHash('sha256').update(d.text).digest('hex');}");
        QTest::newRow("revoked") << QByteArray(
            "if(r.operation==='read'){response.ok=false;delete "
            "response.result;response.error={code:'ACCESS_REVOKED',detail:'NEVER_DISPLAY_DIAGNOSTIC'};}");
        QTest::newRow("failed-process") << QByteArray(
            "if(r.operation==='read'){process.stderr.write('NEVER_DISPLAY_DIAGNOSTIC');process.exit(31);}");
    }
    void wrong_document_envelopes_clear_the_session() {
        QFETCH(QByteArray, mutation);
        Fixture fixture;
        QVERIFY(fixture.initialize(mutation));
        Environment environment(node_, fixture.cli);
        DriveKnowledgePanel panel;
        panel.set_browser_handler([](const QUrl &) { return true; });
        start(panel, fixture.project);
        action(panel, "driveRead")->click();
        QTRY_VERIFY(!action(panel, "driveCancel")->isEnabled());
        QCOMPARE(files(panel)->topLevelItemCount(), 0);
        QVERIFY(preview(panel)->toPlainText().isEmpty());
        QVERIFY(!action(panel, "driveRead")->isEnabled());
        QVERIFY(!action(panel, "driveOpen")->isEnabled());
        QVERIFY(!status(panel)->text().contains("NEVER_DISPLAY_DIAGNOSTIC"));
    }
    void browser_events_are_pinned_to_google_and_current_request_data() {
        QTest::addColumn<QByteArray>("mutation");
        QTest::newRow("host") << QByteArray(
            "if(event)event.url='https://accounts.google.com.attacker.invalid/o/oauth2/v2/auth';");
        QTest::newRow("userinfo") << QByteArray(
            "if(event)event.url='https://attacker@accounts.google.com/o/oauth2/v2/auth';");
        QTest::newRow("path") << QByteArray("if(event)event.url='https://accounts.google.com/other';");
        QTest::newRow("scheme") << QByteArray("if(event)event.url='file:///synthetic';");
        QTest::newRow("sensitive-query")
            << QByteArray("if(event)event.url+='&client_secret=synthetic-test-only';");
        QTest::newRow("wrong-request") << QByteArray("if(event)event.requestId++;");
        QTest::newRow("duplicate-query") << QByteArray("if(event)event.url+='&state='+('c'.repeat(43));");
        QTest::newRow("redirect") << QByteArray("if(event){let u=new "
                                                "URL(event.url);u.searchParams.set('redirect_uri','https://"
                                                "attacker.invalid/oauth2/callback');event.url=u.href;}");
        QTest::newRow("broader-scope") << QByteArray("if(event){let u=new "
                                                     "URL(event.url);u.searchParams.set('scope','https://"
                                                     "www.googleapis.com/auth/drive');event.url=u.href;}");
        QTest::newRow("other-client") << QByteArray("if(event){let u=new "
                                                    "URL(event.url);u.searchParams.set('client_id','other."
                                                    "apps.googleusercontent.com');event.url=u.href;}");
    }
    void browser_events_are_pinned_to_google_and_current_request() {
        QFETCH(QByteArray, mutation);
        Fixture fixture;
        QVERIFY(fixture.initialize(mutation));
        Environment environment(node_, fixture.cli);
        DriveKnowledgePanel panel;
        int opened = 0;
        panel.set_browser_handler([&](const QUrl &) {
            ++opened;
            return true;
        });
        panel.bind_project("factory-monitor", fixture.project, 7, true);
        QTRY_VERIFY(ack(panel)->isEnabled());
        ack(panel)->setChecked(true);
        QTRY_VERIFY(action(panel, "driveConnect")->isEnabled());
        action(panel, "driveConnect")->click();
        QTRY_VERIFY(!action(panel, "driveCancel")->isEnabled());
        QCOMPARE(opened, 0);
        QCOMPARE(files(panel)->topLevelItemCount(), 0);
    }
    void cancellation_and_document_changes_invalidate_pending_reads() {
        Fixture fixture;
        QVERIFY(fixture.initialize("if(r.operation==='read'){setTimeout(()=>send(response),300);return;}"));
        Environment environment(node_, fixture.cli);
        DriveKnowledgePanel panel;
        panel.set_browser_handler([](const QUrl &) { return true; });
        start(panel, fixture.project);
        action(panel, "driveRead")->click();
        QVERIFY(action(panel, "driveCancel")->isEnabled());
        QVERIFY(!action(panel, "driveChooseFolder")->isEnabled());
        QVERIFY(!files(panel)->isEnabled());
        panel.bind_project("factory-monitor", fixture.project, 7, false);
        QTest::qWait(400);
        QVERIFY(preview(panel)->toPlainText().isEmpty());
        QCOMPARE(files(panel)->topLevelItemCount(), 0);
        QVERIFY(!action(panel, "driveConnect")->isEnabled());
        start(panel, fixture.project);
        action(panel, "driveRead")->click();
        action(panel, "driveCancel")->click();
        QTest::qWait(400);
        QVERIFY(preview(panel)->toPlainText().isEmpty());
        QCOMPARE(files(panel)->topLevelItemCount(), 0);
        QVERIFY(status(panel)->text().contains("Cancelled"));
        start(panel, fixture.project);
        panel.bind_project("factory-monitor", fixture.project, 8, true);
        QTRY_VERIFY(ack(panel)->isEnabled());
        QCOMPARE(files(panel)->topLevelItemCount(), 0);
        QVERIFY(preview(panel)->toPlainText().isEmpty());
        QVERIFY(!ack(panel)->isChecked());
    }
    void english_vietnamese_compact_layout_preserves_local_selection() {
        Fixture fixture;
        QVERIFY(fixture.initialize());
        Environment environment(node_, fixture.cli);
        DriveKnowledgePanel panel;
        panel.resize(860, 620);
        panel.show();
        panel.set_browser_handler([](const QUrl &) { return true; });
        start(panel, fixture.project);
        action(panel, "drivePrivacyDetails")->click();
        action(panel, "driveRead")->click();
        QTRY_VERIFY(!preview(panel)->toPlainText().isEmpty());
        const auto original = preview(panel)->toPlainText();
        verify_notice_geometry(panel);
        QVERIFY(capture(panel, "drive-local-view-en"));
        project_english = false;
        panel.bind_project("factory-monitor", fixture.project, 7, true);
        QCoreApplication::processEvents();
        QCOMPARE(action(panel, "driveRead")->text(), QString::fromUtf8("Đọc tài liệu"));
        QCOMPARE(files(panel)->headerItem()->text(0), QString::fromUtf8("Tên"));
        QCOMPARE(files(panel)->currentItem()->data(0, Qt::UserRole).toString(), "document_A");
        QCOMPARE(preview(panel)->toPlainText(), original);
        verify_notice_geometry(panel);
        QVERIFY(capture(panel, "drive-local-view-vi"));
        for (const auto name :
             {"driveConnect", "driveDisconnect", "driveCancel", "driveUp", "driveRefresh",
              "driveChooseFolder", "driveUseFolder", "driveNext", "driveRead", "driveOpen"}) {
            const auto button = action(panel, name);
            if (button->isHidden())
                continue;
            const QRect bounds(button->mapTo(&panel, QPoint{}), button->size());
            QVERIFY2(panel.rect().contains(bounds), name);
            QVERIFY2(button->height() >= button->heightForWidth(button->width()), name);
        }
        project_english = true;
        panel.bind_project("factory-monitor", fixture.project, 7, true);
        QCOMPARE(action(panel, "driveRead")->text(), "Read document");
        QCOMPARE(preview(panel)->toPlainText(), original);
        QCOMPARE(files(panel)->topLevelItemCount(), 3);
        verify_notice_geometry(panel);
    }
    void stages_keep_consent_explicit_and_hide_unavailable_document_controls() {
        Fixture fixture;
        QVERIFY(fixture.initialize());
        Environment environment(node_, fixture.cli);
        DriveKnowledgePanel panel;
        panel.resize(860, 620);
        panel.show();
        panel.set_browser_handler([](const QUrl &) { return true; });
        panel.bind_project("factory-monitor", fixture.project, 7, true);
        QTRY_VERIFY(action(panel, "driveConnect")->isVisible());
        QTRY_VERIFY(ack(panel)->isVisible());
        QVERIFY(!action(panel, "driveConnect")->isEnabled());
        QVERIFY(!files(panel)->isVisible());
        QVERIFY(preview(panel)->parentWidget()->isHidden());
        QVERIFY(action(panel, "driveDisconnect")->isHidden());
        QVERIFY(panel.findChild<QLabel *>("driveBoundary")->isHidden());
        action(panel, "drivePrivacyDetails")->click();
        QVERIFY(panel.findChild<QLabel *>("driveBoundary")->isVisible());
        ack(panel)->setChecked(true);
        QVERIFY(action(panel, "driveConnect")->isEnabled());
        action(panel, "driveConnect")->click();
        QTRY_VERIFY(action(panel, "driveUseFolder")->isVisible());
        QVERIFY(ack(panel)->isHidden());
        QVERIFY(files(panel)->isVisible());
        QVERIFY(preview(panel)->parentWidget()->isHidden());
        files(panel)->setCurrentItem(files(panel)->topLevelItem(0));
        action(panel, "driveUseFolder")->click();
        QTRY_VERIFY(action(panel, "driveChooseFolder")->isVisible());
        QVERIFY(action(panel, "driveUseFolder")->isHidden());
        auto doc = files(panel)->topLevelItem(0);
        files(panel)->setCurrentItem(doc);
        doc->setSelected(true);
        QVERIFY(action(panel, "driveRead")->isVisible());
        action(panel, "driveRead")->click();
        QTRY_VERIFY(!preview(panel)->toPlainText().isEmpty());
        QVERIFY(preview(panel)->isVisible());
        action(panel, "driveDisconnect")->click();
        QVERIFY(files(panel)->parentWidget()->isHidden());
        QVERIFY(preview(panel)->toPlainText().isEmpty());
    }
};

QTEST_MAIN(DriveKnowledgePanelTest)
#include "drive_knowledge_panel_test.moc"
