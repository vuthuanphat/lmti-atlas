#include "impact_panel.hpp"
#include "lmti/project_store.hpp"
#include "project_captions.hpp"
#include <QApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QMessageBox>
#include <QScopeGuard>
#include <QStandardPaths>
#include <QTemporaryDir>
#include <QtTest>

namespace {
class RuntimeEnvironment {
    QByteArray node_, cli_, capability_;
    bool english_;

  public:
    RuntimeEnvironment(const QString &node, const QString &cli, bool review = true)
        : node_(qgetenv("LMTI_STUDIO_NODE_BINARY")), cli_(qgetenv("LMTI_STUDIO_CLI")),
          capability_(qgetenv("LMTI_STUDIO_ALLOW_IMPACT_REVIEW")), english_(project_english) {
        qputenv("LMTI_STUDIO_NODE_BINARY", node.toUtf8());
        qputenv("LMTI_STUDIO_CLI", cli.toUtf8());
        qputenv("LMTI_STUDIO_ALLOW_IMPACT_REVIEW", review ? "1" : "0");
        project_english = true;
    }
    ~RuntimeEnvironment() {
        qputenv("LMTI_STUDIO_NODE_BINARY", node_);
        qputenv("LMTI_STUDIO_CLI", cli_);
        qputenv("LMTI_STUDIO_ALLOW_IMPACT_REVIEW", capability_);
        project_english = english_;
    }
};
bool write_file(const QString &path, const QByteArray &value) {
    QFile file(path);
    return file.open(QIODevice::WriteOnly | QIODevice::Truncate) && file.write(value) == value.size();
}
QByteArray read_file(const QString &path) {
    QFile file(path);
    return file.open(QIODevice::ReadOnly) ? file.readAll() : QByteArray{};
}
QPushButton *action(ImpactPanel &panel, const char *name) {
    return panel.findChild<QPushButton *>(name);
}
QTreeWidget *table(ImpactPanel &panel, const char *name) {
    return panel.findChild<QTreeWidget *>(name);
}
QJsonObject overview_response() {
    const QJsonObject source{{"id", "native-demo"},
                             {"projectId", "factory-monitor"},
                             {"siteId", "factory-demo"},
                             {"environmentId", "local"},
                             {"privacy", "public"},
                             {"kind", "native"},
                             {"revision", "1"},
                             {"digest", QString(64, 'a')},
                             {"capturedAt", "2026-10-13T00:00:00.000Z"},
                             {"parserVersion", "native-test-1"},
                             {"complete", true}};
    const QJsonObject entity{{"id", "native-component-demo"},
                             {"sourceKey", "component:sensor-firmware"},
                             {"kind", "service"},
                             {"label", "Synthetic sensor firmware"},
                             {"ownerRole", "Project component owner"},
                             {"privacy", "public"}};
    const QJsonObject snapshot{
        {"schema", "lmti.impact.snapshot.v1"},
        {"graphRevision", 2},
        {"grantFingerprint", QString(64, 'b')},
        {"sources", QJsonArray{QJsonObject{{"source", source},
                                           {"batchId", "batch-demo"},
                                           {"reviewState", "accepted"},
                                           {"headRevision", "1"},
                                           {"headDigest", QString(64, 'a')},
                                           {"headStatus", "available"}}}},
        {"entities",
         QJsonArray{QJsonObject{{"sourceId", "native-demo"}, {"batchId", "batch-demo"}, {"record", entity}}}},
        {"evidence", QJsonArray{}},
        {"assertions", QJsonArray{}}};
    const QJsonObject result{
        {"native", QJsonObject{{"projectId", "factory-monitor"},
                               {"revision", 1},
                               {"site", "factory-demo"},
                               {"target", "external"}}},
        {"snapshot", snapshot},
        {"reviewEnabled", true},
        {"inbox", QJsonObject{{"imports", QJsonArray{}}, {"history", QJsonArray{}}}},
        {"sourceChecks", QJsonArray{QJsonObject{{"sourceId", "native-demo"},
                                                {"status", "available"},
                                                {"revision", "1"},
                                                {"digest", QString(64, 'a')},
                                                {"checkedAt", "2026-10-13T00:00:00.000Z"}}}}};
    return {{"schema", "lmti.impact.response.v1"}, {"ok", true},           {"op", "overview"},
            {"projectId", "factory-monitor"},      {"projectRevision", 1}, {"result", result}};
}
QByteArray fake_script(const QByteArray &mutation = {}) {
    return QByteArray("let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{"
                      "const request=JSON.parse(input);const response=") +
           QJsonDocument(overview_response()).toJson(QJsonDocument::Compact) + ";" + mutation +
           "process.stdout.write(JSON.stringify(response));});";
}
bool inside(const QWidget &container, const QWidget *widget) {
    return widget && widget->isVisible() && widget->width() > 8 && widget->height() > 8 &&
           container.rect().contains(QRect(widget->mapTo(&container, QPoint(0, 0)), widget->size()));
}
bool capture_panel(ImpactPanel &panel, const QString &name, const QString &project_path, qint64 revision) {
    const auto configured = qEnvironmentVariable("LMTI_IMPACT_RENDER_DIR");
    if (configured.isEmpty())
        return true;
    const QFileInfo directory(configured);
    if (!directory.isAbsolute() || !directory.isDir() || directory.isSymLink())
        return false;
    const bool original_language = project_english;
    const auto restore = qScopeGuard([&] {
        project_english = original_language;
        panel.bind_project("factory-monitor", project_path, revision, true, {"factory-demo"});
    });
    panel.resize(1100, 760);
    for (const bool english : {true, false}) {
        project_english = english;
        panel.bind_project("factory-monitor", project_path, revision, true, {"factory-demo"});
        QApplication::processEvents();
        const auto filename = name + (english ? "-en.png" : "-vi.png");
        if (!panel.grab().save(QDir(directory.canonicalFilePath()).filePath(filename), "PNG"))
            return false;
    }
    return true;
}
} // namespace

class ImpactPanelTest : public QObject {
    Q_OBJECT
  private slots:
    void rejects_wrong_scope_malformed_oversized_and_failed_processes() {
        const auto node = QStandardPaths::findExecutable("node");
        if (node.isEmpty())
            QSKIP("Impact process checks require a trusted Node runtime.");
        QTemporaryDir temp;
        QVERIFY(temp.isValid());
        const auto script = temp.filePath("index.js"), config = temp.filePath("launcher.json");
        QVERIFY(write_file(config, "{}"));
        RuntimeEnvironment environment(node, script);
        auto document = lmti::demo_project();
        const auto path = temp.filePath("project.sqlite");
        document.topology.revision = lmti::save_project(path, document);
        const auto before = read_file(path);
        ImpactPanel panel;
        panel.bind_project("factory-monitor", path, 1, true, {"factory-demo"});
        panel.show();
        auto reload = action(panel, "impactReload");
        const QList<QByteArray> rejected_scripts{
            fake_script("response.projectId='another-project';"),
            fake_script("response.projectRevision=2;"),
            fake_script("response.op='save-report';"),
            fake_script("response.result.native.projectId='another-project';"),
            fake_script("response.result.native.revision=2;"),
            fake_script("response.result.snapshot.entities={};"),
            "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('malformed-json'));",
            "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('PRIVATE_RUNTIME_PATH');"
            "process.exit(7);});",
            "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('x'.repeat(2200000)));"};
        for (const auto &body : rejected_scripts) {
            QVERIFY(write_file(script, fake_script()));
            panel.connect_workspace(config);
            QTRY_VERIFY_WITH_TIMEOUT(reload->isEnabled(), 5000);
            QCOMPARE(panel.findChild<QComboBox *>("impactEntity")->count(), 1);
            QVERIFY(action(panel, "impactImport")->isEnabled());
            QVERIFY(write_file(script, body));
            reload->click();
            QTRY_VERIFY_WITH_TIMEOUT(reload->isEnabled(), 5000);
            QCOMPARE(panel.findChild<QComboBox *>("impactEntity")->count(), 0);
            QCOMPARE(table(panel, "impactSources")->topLevelItemCount(), 0);
            for (const auto *name : {"impactImport", "impactAccept", "impactReject", "impactReport",
                                     "impactSaveReport", "impactVerify"})
                QVERIFY2(!action(panel, name)->isEnabled(), name);
            QVERIFY(!panel.findChild<QLabel *>("impactStatus")->text().contains("PRIVATE_RUNTIME_PATH"));
            QCOMPARE(read_file(path), before);
        }
        // Owner reviewEnabled alone never grants the launcher's write capability.
        qputenv("LMTI_STUDIO_ALLOW_IMPACT_REVIEW", "0");
        QVERIFY(write_file(script, fake_script()));
        reload->click();
        QTRY_VERIFY_WITH_TIMEOUT(reload->isEnabled(), 5000);
        panel.findChild<QLineEdit *>("impactDescription")->setText("Review a synthetic contract change");
        QVERIFY(action(panel, "impactReport")->isEnabled());
        for (const auto *name :
             {"impactCreate", "impactUpgrade", "impactImport", "impactSaveReport", "impactVerify"})
            QVERIFY2(!action(panel, name)->isEnabled(), name);
    }

    void dirty_revision_identity_and_cancel_clear_checked_results() {
        const auto node = QStandardPaths::findExecutable("node");
        if (node.isEmpty())
            QSKIP("Impact process checks require a trusted Node runtime.");
        QTemporaryDir temp;
        QVERIFY(temp.isValid());
        const auto script = temp.filePath("index.js"), config = temp.filePath("launcher.json");
        QVERIFY(write_file(script, fake_script()));
        QVERIFY(write_file(config, "{}"));
        RuntimeEnvironment environment(node, script);
        const auto path = temp.filePath("project.sqlite");
        auto document = lmti::demo_project();
        document.topology.revision = lmti::save_project(path, document);
        ImpactPanel panel;
        panel.bind_project("factory-monitor", path, 1, true, {"factory-demo"});
        panel.connect_workspace(config);
        auto reload = action(panel, "impactReload");
        QTRY_VERIFY_WITH_TIMEOUT(action(panel, "impactImport")->isEnabled(), 5000);
        panel.findChild<QLineEdit *>("impactDescription")->setText("Retained operator draft");
        panel.bind_project("factory-monitor", path, 1, false, {"factory-demo"});
        QVERIFY(!reload->isEnabled());
        QVERIFY(!action(panel, "impactReport")->isEnabled());
        QCOMPARE(panel.findChild<QComboBox *>("impactEntity")->count(), 0);
        QCOMPARE(panel.findChild<QLineEdit *>("impactDescription")->text(), "Retained operator draft");
        panel.bind_project("factory-monitor", path, 1, true, {"factory-demo"});
        QVERIFY(reload->isEnabled());
        QVERIFY(!action(panel, "impactReport")->isEnabled());
        reload->click();
        QTRY_VERIFY_WITH_TIMEOUT(action(panel, "impactImport")->isEnabled(), 5000);
        panel.bind_project("factory-monitor", path, 2, true, {"factory-demo"});
        QCOMPARE(panel.findChild<QComboBox *>("impactEntity")->count(), 0);
        QVERIFY(!action(panel, "impactImport")->isEnabled());
        panel.bind_project("factory-monitor", path, 1, true, {"factory-demo"});
        QVERIFY(write_file(script, "process.stdin.resume();setInterval(()=>{},1000);"));
        reload->click();
        QVERIFY(action(panel, "impactCancel")->isEnabled());
        panel.bind_project("factory-monitor", path, 1, false, {"factory-demo"});
        QVERIFY(!action(panel, "impactCancel")->isEnabled());
        QVERIFY(!reload->isEnabled());
        panel.bind_project("factory-monitor", path, 1, true, {"factory-demo"});
        reload->click();
        QVERIFY(action(panel, "impactCancel")->isEnabled());
        action(panel, "impactCancel")->click();
        QVERIFY(reload->isEnabled());
        QVERIFY(!action(panel, "impactImport")->isEnabled());
        QVERIFY(!action(panel, "impactCancel")->isEnabled());
        panel.bind_project("different-project", temp.filePath("different.sqlite"), 1, true, {"another-site"});
        QVERIFY(!reload->isEnabled());
        QVERIFY(panel.findChild<QLineEdit *>("impactDescription")->text().isEmpty());
        QVERIFY(lmti::load_project(path) == document);
    }

    void changed_request_and_wrong_inner_report_cannot_restore_a_checked_preview() {
        const auto node = QStandardPaths::findExecutable("node");
        if (node.isEmpty())
            QSKIP("Impact process checks require a trusted Node runtime.");
        QTemporaryDir temp;
        QVERIFY(temp.isValid());
        const auto script = temp.filePath("index.js"), config = temp.filePath("launcher.json");
        QVERIFY(write_file(config, "{}"));
        RuntimeEnvironment environment(node, script);
        const QByteArray response_logic =
            "if(request.op==='report'){response.op='report';response.result={report:{"
            "schema:'lmti.impact.report.v1',id:'report-demo',graphRevision:2,grantFingerprint:'" +
            QByteArray(64, 'b') +
            "',input:request.change,findings:[],checklist:[],sourceVersions:[],unknowns:[],"
            "conclusion:'Synthetic checked preview'},review:null};}";
        auto delayed = fake_script(response_logic);
        delayed.replace(
            "process.stdout.write(JSON.stringify(response));",
            "setTimeout(()=>process.stdout.write(JSON.stringify(response)),request.op==='report'?350:0);");
        QVERIFY(write_file(script, delayed));
        auto document = lmti::demo_project();
        const auto path = temp.filePath("project.sqlite");
        lmti::save_project(path, document);
        ImpactPanel panel;
        panel.bind_project("factory-monitor", path, 1, true, {"factory-demo"});
        panel.connect_workspace(config);
        auto reload = action(panel, "impactReload"), report = action(panel, "impactReport");
        auto save = action(panel, "impactSaveReport");
        QTRY_VERIFY_WITH_TIMEOUT(action(panel, "impactImport")->isEnabled(), 5000);
        auto description = panel.findChild<QLineEdit *>("impactDescription");
        description->setText("Original synthetic change");
        report->click();
        QVERIFY(action(panel, "impactCancel")->isEnabled());
        description->setText("A different synthetic change while the report is loading");
        QTRY_VERIFY_WITH_TIMEOUT(reload->isEnabled(), 5000);
        QVERIFY(!save->isEnabled());
        QVERIFY(panel.findChild<QPlainTextEdit *>("impactDetails")->toPlainText().isEmpty());

        // A correct outer project envelope cannot authorize a report for another
        // grant, graph revision or change input.
        for (const auto &mutation : QList<QByteArray>{
                 "response.result.report.grantFingerprint='" + QByteArray(64, 'c') + "';",
                 "response.result.report.graphRevision=3;",
                 "response.result.report.input={...request.change,description:'Different change'};"}) {
            QVERIFY(write_file(script,
                               fake_script(response_logic + "if(request.op==='report'){" + mutation + "}")));
            reload->click();
            QTRY_VERIFY_WITH_TIMEOUT(action(panel, "impactImport")->isEnabled(), 5000);
            QVERIFY(report->isEnabled());
            report->click();
            QTRY_VERIFY_WITH_TIMEOUT(reload->isEnabled(), 5000);
            QVERIFY(!save->isEnabled());
            QVERIFY(panel.findChild<QPlainTextEdit *>("impactDetails")->toPlainText().isEmpty());
        }
    }

    void compact_actions_and_language_changes_preserve_input() {
        const auto node = QStandardPaths::findExecutable("node");
        if (node.isEmpty())
            QSKIP("Impact process checks require a trusted Node runtime.");
        QTemporaryDir temp;
        QVERIFY(temp.isValid());
        const auto script = temp.filePath("index.js"), config = temp.filePath("launcher.json");
        QVERIFY(write_file(script, fake_script()));
        QVERIFY(write_file(config, "{}"));
        RuntimeEnvironment environment(node, script);
        ImpactPanel panel;
        const auto path = temp.filePath("project.sqlite");
        auto document = lmti::demo_project();
        lmti::save_project(path, document);
        panel.bind_project("factory-monitor", path, 1, true, {"factory-demo"});
        panel.resize(860, 620);
        panel.show();
        panel.connect_workspace(config);
        QTRY_VERIFY_WITH_TIMEOUT(action(panel, "impactImport")->isEnabled(), 5000);
        auto description = panel.findChild<QLineEdit *>("impactDescription");
        description->setText("Synthetic draft retained across language changes");
        auto tabs = panel.findChild<QTabWidget *>("impactTabs");
        for (const bool english : {true, false}) {
            project_english = english;
            panel.bind_project("factory-monitor", path, 1, true, {"factory-demo"});
            for (const auto size : {QSize(860, 620), QSize(1100, 760)}) {
                panel.resize(size);
                QTRY_COMPARE(panel.size(), size);
                for (const auto *name : {"impactConnect", "impactCreate", "impactReload", "impactCancel"})
                    QTRY_VERIFY2(inside(panel, action(panel, name)), name);
                tabs->setCurrentIndex(0);
                for (const auto *name :
                     {"impactUpgrade", "impactImport", "impactPreview", "impactAccept", "impactReject"})
                    QTRY_VERIFY2(inside(panel, action(panel, name)), name);
                tabs->setCurrentIndex(1);
                for (const auto *name : {"impactReport", "impactSaveReport", "impactOpenReport"})
                    QTRY_VERIFY2(inside(panel, action(panel, name)), name);
                QVERIFY(inside(panel, description));
                tabs->setCurrentIndex(2);
                QTRY_VERIFY(inside(panel, action(panel, "impactVerify")));
                QVERIFY(inside(panel, panel.findChild<QCheckBox *>("impactVerificationConfirmation")));
                QCOMPARE(description->text(), "Synthetic draft retained across language changes");
                QVERIFY(action(panel, "impactImport")->isEnabled());
            }
        }
    }

    void real_owner_stage_accept_report_upgrade_verify_and_stale_source() {
        const auto node = QStandardPaths::findExecutable("node");
        const auto cli = qEnvironmentVariable("LMTI_STUDIO_TEST_CLI");
        if (cli.isEmpty())
            QSKIP("Set LMTI_STUDIO_TEST_CLI to opt in to the native/TS impact integration test.");
        QVERIFY2(!node.isEmpty() && QFileInfo(cli).isFile(), "Opt-in requires Node and the built TS CLI.");
        const auto native = QDir(QCoreApplication::applicationDirPath()).filePath("lmti-project.exe");
        QVERIFY2(QFileInfo(native).isExecutable(),
                 "The panel requires lmti-project beside its test executable.");
        RuntimeEnvironment environment(node, cli);
        QTemporaryDir temp;
        QVERIFY(temp.isValid());
        auto document = lmti::demo_project();
        const auto path = temp.filePath("project.sqlite");
        document.topology.revision = lmti::save_project(path, document);
        const auto native_before = read_file(path);
        const auto config = temp.filePath("review/launcher.json");
        ImpactPanel panel;
        panel.bind_project("factory-monitor", path, document.topology.revision, true, {"factory-demo"});
        panel.resize(1100, 760);
        panel.show();
        panel.create_workspace(config, "factory-demo", "local", false);
        auto stage = action(panel, "impactImport"), reload = action(panel, "impactReload");
        QTRY_VERIFY_WITH_TIMEOUT(stage->isEnabled(), 15000);
        QVERIFY(QFileInfo(config).isFile());
        QCOMPARE(table(panel, "impactSources")->topLevelItemCount(), 0);
        stage->click();
        QTRY_VERIFY_WITH_TIMEOUT(stage->isEnabled(), 15000);
        auto imports = table(panel, "impactImports");
        QCOMPARE(imports->topLevelItemCount(), 1);
        QCOMPARE(imports->topLevelItem(0)->data(1, Qt::UserRole).toString(), "pending");
        QCOMPARE(imports->topLevelItem(0)->text(1), impact_caption("pending"));
        imports->setCurrentItem(imports->topLevelItem(0));
        QVERIFY(!action(panel, "impactAccept")->isEnabled());
        action(panel, "impactPreview")->click();
        auto confirmation = panel.findChild<QCheckBox *>("impactImportConfirmation");
        auto preview = panel.findChild<QPlainTextEdit *>("impactImportDetails");
        QTRY_VERIFY_WITH_TIMEOUT(!preview->toPlainText().isEmpty(), 15000);
        QVERIFY(preview->toPlainText().contains("Sensor firmware"));
        QVERIFY(!action(panel, "impactAccept")->isEnabled());
        confirmation->setChecked(true);
        QVERIFY(action(panel, "impactAccept")->isEnabled());
        const auto import_id = imports->currentItem()->data(0, Qt::UserRole).toString();
        project_english = false;
        panel.bind_project("factory-monitor", path, document.topology.revision, true, {"factory-demo"});
        QCOMPARE(imports->currentItem()->data(0, Qt::UserRole).toString(), import_id);
        QCOMPARE(imports->currentItem()->data(1, Qt::UserRole).toString(), "pending");
        QCOMPARE(imports->currentItem()->text(1), QString::fromUtf8("Chờ duyệt"));
        QVERIFY(confirmation->isChecked());
        QVERIFY(action(panel, "impactAccept")->isEnabled());
        project_english = true;
        panel.bind_project("factory-monitor", path, document.topology.revision, true, {"factory-demo"});
        action(panel, "impactAccept")->click();
        auto entity = panel.findChild<QComboBox *>("impactEntity");
        QTRY_VERIFY_WITH_TIMEOUT(entity->count() > 0 && stage->isEnabled(), 15000);
        QCOMPARE(imports->topLevelItem(0)->data(1, Qt::UserRole).toString(), "accepted");
        QCOMPARE(imports->topLevelItem(0)->text(1), impact_caption("accepted"));
        const auto component = entity->findText("Sensor firmware");
        QVERIFY(component >= 0);
        entity->setCurrentIndex(component);
        panel.findChild<QLineEdit *>("impactDescription")
            ->setText("Review a synthetic sampling contract change");
        panel.findChild<QLineEdit *>("impactProposed")->setText("candidate-2");
        auto targets = table(panel, "impactTargets");
        QCOMPARE(targets->topLevelItemCount(), 1);
        targets->topLevelItem(0)->setCheckState(0, Qt::Checked);
        panel.findChild<QTabWidget *>("impactTabs")->setCurrentIndex(1);
        auto report = action(panel, "impactReport"), save = action(panel, "impactSaveReport");
        QVERIFY(report->isEnabled());
        report->click();
        QTRY_VERIFY_WITH_TIMEOUT(save->isEnabled(), 15000);
        QVERIFY(table(panel, "impactChecklist")->topLevelItemCount() > 0);
        QVERIFY(!action(panel, "impactVerify")->isEnabled());
        QVERIFY(capture_panel(panel, "native-impact-report", path, document.topology.revision));
        save->click();
        auto saved_id = panel.findChild<QLineEdit *>("impactReportId");
        QTRY_VERIFY_WITH_TIMEOUT(reload->isEnabled() && !saved_id->text().isEmpty(), 15000);
        QVERIFY(!save->isEnabled());
        QVERIFY(stage->isEnabled());
        QVERIFY(lmti::load_project(path) == document);
        QCOMPARE(read_file(path), native_before);

        // Newly created workspaces are already current. The explicit upgrade action
        // remains idempotent and does not manufacture a backup or mutate the native project.
        panel.findChild<QTabWidget *>("impactTabs")->setCurrentIndex(0);
        QTimer::singleShot(0, &panel, [] {
            auto message = qobject_cast<QMessageBox *>(QApplication::activeModalWidget());
            QVERIFY(message);
            message->done(QMessageBox::Yes);
        });
        action(panel, "impactUpgrade")->click();
        QTRY_VERIFY_WITH_TIMEOUT(stage->isEnabled(), 15000);
        QVERIFY(QDir(temp.filePath("review")).entryList({"impact-backup-*.sqlite"}, QDir::Files).isEmpty());
        entity->setCurrentIndex(entity->findText("Sensor firmware"));
        QCOMPARE(targets->topLevelItemCount(), 1);
        targets->topLevelItem(0)->setCheckState(0, Qt::Checked);
        panel.findChild<QTabWidget *>("impactTabs")->setCurrentIndex(1);
        report->click();
        QTRY_VERIFY_WITH_TIMEOUT(save->isEnabled(), 15000);
        save->click();
        QTRY_VERIFY_WITH_TIMEOUT(reload->isEnabled() && !save->isEnabled(), 15000);
        QVERIFY(stage->isEnabled());
        QVERIFY(!saved_id->text().isEmpty());
        auto checklist = table(panel, "impactChecklist");
        QVERIFY(checklist->topLevelItemCount() > 0);
        panel.findChild<QTabWidget *>("impactTabs")->setCurrentIndex(2);
        checklist->setCurrentItem(checklist->topLevelItem(0));
        const auto checklist_id = checklist->currentItem()->data(0, Qt::UserRole).toString();
        panel.findChild<QLineEdit *>("impactEvidenceSummary")
            ->setText("Synthetic operator checked the declared contract fixture");
        panel.findChild<QLineEdit *>("impactEvidenceRef")->setText("synthetic/checks/contract-review");
        auto verified = panel.findChild<QCheckBox *>("impactVerificationConfirmation");
        auto record = action(panel, "impactVerify");
        QVERIFY(!record->isEnabled());
        verified->setChecked(true);
        QVERIFY(record->isEnabled());
        project_english = false;
        panel.bind_project("factory-monitor", path, document.topology.revision, true, {"factory-demo"});
        QCOMPARE(checklist->currentItem()->data(0, Qt::UserRole).toString(), checklist_id);
        QCOMPARE(panel.findChild<QLineEdit *>("impactEvidenceRef")->text(),
                 "synthetic/checks/contract-review");
        QCOMPARE(panel.findChild<QComboBox *>("impactVerificationStatus")->currentData().toString(),
                 "verified");
        QCOMPARE(panel.findChild<QComboBox *>("impactVerificationStatus")->currentText(),
                 QString::fromUtf8("Đã xác minh"));
        QVERIFY(verified->isChecked());
        QVERIFY(record->isEnabled());
        project_english = true;
        panel.bind_project("factory-monitor", path, document.topology.revision, true, {"factory-demo"});
        record->click();
        QTRY_VERIFY_WITH_TIMEOUT(
            reload->isEnabled() && table(panel, "impactHistory")->topLevelItemCount() > 0, 15000);
        bool found = false;
        for (int i = 0; i < checklist->topLevelItemCount(); ++i)
            if (checklist->topLevelItem(i)->data(0, Qt::UserRole) == checklist_id) {
                QCOMPARE(checklist->topLevelItem(i)->data(2, Qt::UserRole).toString(), "verified");
                QCOMPARE(checklist->topLevelItem(i)->text(2), impact_caption("verified"));
                found = true;
            }
        QVERIFY(found);
        QVERIFY(capture_panel(panel, "native-impact-verification", path, document.topology.revision));
        QVERIFY(lmti::load_project(path) == document);
        QCOMPARE(read_file(path), native_before);
        QVERIFY(!record->isEnabled());

        // A separately saved native change invalidates the bound revision and all checked controls.
        document.components[0].label = "Changed synthetic sensor firmware";
        document.topology.revision = lmti::save_project(path, document);
        reload->click();
        QTRY_VERIFY_WITH_TIMEOUT(reload->isEnabled(), 15000);
        QVERIFY(!save->isEnabled());
        QVERIFY(!record->isEnabled());
        QCOMPARE(entity->count(), 0);
        panel.bind_project("factory-monitor", path, document.topology.revision, true, {"factory-demo"});
        reload->click();
        QTRY_VERIFY_WITH_TIMEOUT(stage->isEnabled(), 15000);
        entity->setCurrentIndex(entity->findText("Sensor firmware"));
        report->click();
        QTRY_VERIFY_WITH_TIMEOUT(save->isEnabled(), 15000);
        bool stale = false;
        const auto sources = table(panel, "impactSources");
        for (int i = 0; i < sources->topLevelItemCount(); ++i)
            if (sources->topLevelItem(i)->data(2, Qt::UserRole) == "stale") {
                QCOMPARE(sources->topLevelItem(i)->text(2), impact_caption("stale"));
                stale = true;
            }
        QVERIFY(stale);
        QVERIFY(!record->isEnabled());
        QVERIFY(lmti::load_project(path) == document);
    }
};

QTEST_MAIN(ImpactPanelTest)
#include "impact_panel_test.moc"
