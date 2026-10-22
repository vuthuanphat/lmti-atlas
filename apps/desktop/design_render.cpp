#include "design_render.hpp"
#include "design_fixture.hpp"
#include <QApplication>
#include <QDateTime>
#include <QDialog>
#include <QDialogButtonBox>
#include <QDir>
#include <QElapsedTimer>
#include <QFontInfo>
#include <QGraphicsItem>
#include <QHash>
#include <QJsonDocument>
#include <QRawFont>
#include <QSaveFile>
#include <QTimeZone>
#include <QTimer>
#include <memory>

namespace {
bool save_capture(QWidget *widget, const QString &output) {
    const auto font = QRawFont::fromFont(widget->font());
    if (!font.supportsCharacter(QChar('A')) || !font.supportsCharacter(QChar(0x1ec7)))
        return false;
    const auto capture = widget->grab();
    if (!capture.save(output))
        return false;
    const QJsonObject metrics{{"logicalWidth", widget->width()},
                              {"logicalHeight", widget->height()},
                              {"pixelWidth", capture.width()},
                              {"pixelHeight", capture.height()},
                              {"devicePixelRatio", capture.devicePixelRatio()},
                              {"platform", QGuiApplication::platformName()},
                              {"fontFamily", QFontInfo(widget->font()).family()},
                              {"widget", widget->objectName()}};
    QSaveFile file(output + ".json");
    if (!file.open(QIODevice::WriteOnly))
        return false;
    const auto json = QJsonDocument(metrics).toJson();
    return file.write(json) == json.size() && file.commit();
}
struct Route {
    ProjectPage page;
    const char *tabs = nullptr;
    int tab = 0;
    const char *table = nullptr;
};
const QHash<QString, Route> routes{
    {"01-overview", {ProjectPage::Overview}},
    {"03-software-components", {ProjectPage::Software, "softwareTabs", 0, "componentTable"}},
    {"04-software-repositories", {ProjectPage::Software, "softwareTabs", 1, "repositoryTable"}},
    {"05-software-dependencies", {ProjectPage::Software, "softwareTabs", 2, "dependencyTable"}},
    {"06-hardware-devices", {ProjectPage::Hardware, "hardwareTabs", 0, "hardwareDevices"}},
    {"07-hardware-targets", {ProjectPage::Hardware, "hardwareTabs", 1, "targetTable"}},
    {"08-software-bindings", {ProjectPage::Hardware, "hardwareTabs", 2, "bindingTable"}},
    {"09-architecture-topology", {ProjectPage::Architecture, "architectureTabs", 0}},
    {"10-architecture-relationships", {ProjectPage::Architecture, "architectureTabs", 1}},
    {"11-work-list", {ProjectPage::Work, "workTabs", 0, "workTable"}},
    {"12-work-board", {ProjectPage::Work, "workTabs", 0}},
    {"13-milestones", {ProjectPage::Work, "workTabs", 1, "milestoneTable"}},
    {"14-releases", {ProjectPage::Releases, "releaseTabs", 0, "releaseTable"}},
    {"15-release-evidence", {ProjectPage::Releases, "releaseTabs", 1, "verificationTable"}},
    {"16-knowledge-references", {ProjectPage::Knowledge, "knowledgeTabs", 0, "knowledgeTable"}},
    {"17-knowledge-project-map", {ProjectPage::Knowledge, "knowledgeTabs", 1}},
    {"18-knowledge-memory", {ProjectPage::Knowledge, "knowledgeTabs", 2}},
    {"19-knowledge-lessons", {ProjectPage::Knowledge, "knowledgeTabs", 3}},
    {"20-knowledge-task-context", {ProjectPage::Knowledge, "knowledgeTabs", 4}},
    {"21-agent-context", {ProjectPage::Agent, "agentTabs", 0}},
    {"22-agent-review", {ProjectPage::Agent, "agentTabs", 1}},
    {"23-agent-setup", {ProjectPage::Agent, "agentTabs", 2}},
    {"24-project-settings", {ProjectPage::Settings, "projectSettingsTabs", 0}},
    {"27-mcp-agents", {ProjectPage::Mcp}},
};
} // namespace

bool render_design_screen(ProjectWindow &window, const QString &screen, const QString &output,
                          const QString &fixture_directory) {
    const bool library = screen == "02-project-library";
    const bool create = screen == "25-create-project";
    const bool validation = screen == "26-edit-work-validation";
    if (!routes.contains(screen) && !library && !create && !validation)
        return false;
    if (library) {
        for (const auto &[folder, name] :
             {std::pair{"FactoryMonitor", "Factory Monitor"}, std::pair{"EdgeGateway", "Edge Gateway"},
              std::pair{"SensorFirmware", "Sensor Firmware"}, std::pair{"ControlBoard", "Control Board"},
              std::pair{"DataTools", "Data Tools"}, std::pair{"TestBench", "Test Bench"}}) {
            window.create_project_folder(fixture_directory, folder, name, "Synthetic design fixture");
            if (QString(folder) == "FactoryMonitor" || QString(folder) == "SensorFirmware")
                lmti::pin_library_project(window.library_path(),
                                          QString::fromStdString(window.document().project.id), true);
        }
        const auto moved = QDir(fixture_directory).filePath("DataTools");
        if (!QDir(moved).rename("project.lmti.sqlite", "project-moved.sqlite"))
            return false;
        window.show_library();
    } else if (!create) {
        window.load_demo();
        if (screen == "04-software-repositories")
            window.update_project([](auto &document) {
                document.repositories[0].locator = "sensor-source";
                document.repositories[1].locator = "gateway-source";
            });
        if (screen == "16-knowledge-references")
            window.update_project([](auto &document) {
                document.knowledge.push_back({"design-sampling-reference", "Sampling interface note",
                                              "sensor-firmware", "sampling-interface-note",
                                              "synthetic-reference-v1", lmti::Privacy::Internal});
            });
        if (screen == "14-releases") {
            window.update_project([](auto &document) {
                document.targets.push_back({"design-edge-board", "Edge board", "rev A",
                                            "Embedded Linux (declared)", lmti::Privacy::Public});
                document.releases.push_back({"design-gateway-approved", "1.1.0", "gateway-agent",
                                             "design-edge-board", "design-rev-9",
                                             lmti::ReleaseState::Approved, lmti::Privacy::Public});
                document.releases.push_back({"design-gateway-archived", "1.0.0", "gateway-agent",
                                             "design-edge-board", "design-rev-7",
                                             lmti::ReleaseState::Archived, lmti::Privacy::Public});
                document.work.back().release_id = "design-gateway-approved";
            });
        }
        if (screen == "15-release-evidence") {
            window.update_project([](auto &document) {
                lmti::VerificationRecord record;
                record.id = "design-evidence";
                record.release_id = "sensor-v020";
                record.asset_id = "machine-a";
                record.evidence = "Illustrative operator report; no device execution";
                record.source = "Design fixture";
                record.at = QDateTime(QDate(2026, 10, 12), QTime(10, 0), QTimeZone::UTC).toSecsSinceEpoch();
                record.privacy = lmti::Privacy::Public;
                document.verification.push_back(record);
            });
        }
        if (screen == "12-work-board") {
            window.update_project([](auto &document) {
                for (const auto state :
                     {lmti::WorkState::InProgress, lmti::WorkState::Review, lmti::WorkState::Done}) {
                    auto item = document.work.front();
                    item.id = "design-" + lmti::name(state);
                    item.label = state == lmti::WorkState::Done     ? "Record verification plan"
                                 : state == lmti::WorkState::Review ? "Review interface contract"
                                                                    : "Implement gateway contract";
                    item.state = state;
                    item.checklist = "Review synthetic metadata";
                    item.evidence = "Synthetic review record";
                    document.work.push_back(item);
                }
            });
        }
        window.save_to(QDir(fixture_directory).filePath("design-project.sqlite"));
        if (!validation) {
            const auto route = routes.value(screen);
            window.show_page(route.page);
            if (route.tabs) {
                auto tabs = window.findChild<QTabWidget *>(route.tabs);
                if (!tabs || route.tab >= tabs->count())
                    return false;
                tabs->setCurrentIndex(route.tab);
            }
            if (route.table) {
                auto table = window.findChild<QTreeWidget *>(route.table);
                if (!table)
                    return false;
                if (table->topLevelItemCount())
                    table->setCurrentItem(table->topLevelItem(0));
                if (screen == "14-releases")
                    for (int index = 0; index < table->topLevelItemCount(); ++index)
                        if (table->topLevelItem(index)->data(0, Qt::UserRole).toString() ==
                            "design-gateway-approved")
                            table->setCurrentItem(table->topLevelItem(index));
            }
        }
        if (screen == "12-work-board")
            window.findChild<QComboBox *>("workViewMode")->setCurrentIndex(1);
        if (screen == "09-architecture-topology" && window.document().topology.assets.size() > 1)
            static_cast<Window *>(window.findChild<QMainWindow *>("topologyWindow"))
                ->select_asset(window.document().topology.assets[1].id);
        if (screen == "10-architecture-relationships") {
            auto view = window.findChild<QGraphicsView *>("softwareHardwareGraph");
            for (auto item : view->scene()->items())
                if (item->data(0).toString() == "sensor-firmware" &&
                    item->data(1).toString() == "component") {
                    item->setSelected(true);
                    break;
                }
            window.findChild<QPushButton *>("fitRelationships")->click();
        }
        if (screen == "22-agent-review")
            window.review_proposal({window.document().project.id, "validate-sampling",
                                    window.document().topology.revision, lmti::WorkState::Todo,
                                    lmti::WorkState::Review});
    }
    const auto requested_size = window.size();
    window.show();
    // Windows may clamp the initial show to the monitor work area. Restore the
    // requested logical viewport for a complete, measured synthetic capture.
    window.resize(requested_size);
    if (screen == "10-architecture-relationships")
        QTimer::singleShot(100, &window,
                           [&window] { window.findChild<QPushButton *>("fitRelationships")->click(); });
    const bool knowledge = screen == "17-knowledge-project-map" || screen == "18-knowledge-memory" ||
                           screen == "19-knowledge-lessons" || screen == "20-knowledge-task-context";
    if (knowledge) {
        if (!create_design_knowledge_fixture(fixture_directory,
                                             QString::fromStdString(window.document().project.id)))
            return false;
        auto panel = static_cast<KnowledgePanel *>(window.findChild<QWidget *>("knowledgeConnection"));
        panel->connect_source(fixture_directory);
        auto poll = new QTimer(&window);
        auto elapsed = std::make_shared<QElapsedTimer>();
        elapsed->start();
        poll->setInterval(50);
        QObject::connect(
            poll, &QTimer::timeout, &window,
            [&window, screen, output, poll, elapsed, prepared = false]() mutable {
                if (elapsed->elapsed() > 15000) {
                    poll->stop();
                    QApplication::exit(1);
                    return;
                }
                const auto map = window.findChild<QTreeWidget *>("knowledgeMap");
                const auto memory = window.findChild<QTreeWidget *>("knowledgeMemory");
                const auto lessons = window.findChild<QTreeWidget *>("knowledgeLessons");
                const auto idle = window.findChild<QPushButton *>("reloadKnowledge")->isEnabled();
                if (!idle)
                    return;
                if (!prepared && (map->topLevelItemCount() < 2 || memory->topLevelItemCount() < 3 ||
                                  lessons->topLevelItemCount() < 1))
                    return;
                if (screen == "20-knowledge-task-context") {
                    if (!prepared) {
                        prepared = true;
                        window.findChild<QLineEdit *>("knowledgeTask")
                            ->setText("Review the sampling contract and desired versions");
                        window.findChild<QPushButton *>("prepareKnowledgeContext")->click();
                        return;
                    }
                    if (!window.findChild<QPushButton *>("copyKnowledgeContext")->isEnabled())
                        return;
                } else {
                    auto table = screen == "17-knowledge-project-map" ? map
                                 : screen == "18-knowledge-memory"    ? memory
                                                                      : lessons;
                    table->setCurrentItem(table->topLevelItem(0));
                }
                poll->stop();
                QTimer::singleShot(100, &window, [&window, output] {
                    QApplication::exit(save_capture(&window, output) ? 0 : 1);
                });
            });
        poll->start();
        return true;
    }
    if (create || validation) {
        if (validation) {
            window.show_page(ProjectPage::Work);
            auto work = window.findChild<QTreeWidget *>("workTable");
            for (int index = 0; index < work->topLevelItemCount(); ++index)
                if (work->topLevelItem(index)->data(0, Qt::UserRole).toString() == "validate-sampling")
                    work->setCurrentItem(work->topLevelItem(index));
        }
        QTimer::singleShot(250, &window, [&window, output, create, fixture_directory] {
            auto button = window.findChild<QPushButton *>(create ? "createProjectButton" : "editwork");
            if (!button) {
                QApplication::exit(1);
                return;
            }
            QTimer::singleShot(100, &window, [&window, output, create, fixture_directory] {
                auto dialog =
                    window.findChild<QDialog *>(create ? "createProjectDialog" : "projectRecordDialog");
                if (!dialog) {
                    QApplication::exit(1);
                    return;
                }
                // Capture the supported parent viewport, rather than the
                // offscreen plugin's arbitrary simulated monitor work area.
                dialog->resize(std::min(740, window.width() - 80), std::min(740, window.height() - 100));
                if (create) {
                    dialog->findChild<QLineEdit *>("fieldTên dự án")->setText("Factory Monitor");
                    dialog->findChild<QLineEdit *>("fieldMục tiêu")
                        ->setText("Coordinate sampling firmware and gateway verification.");
                    dialog->findChild<QLineEdit *>("fieldTên thư mục")->setText("FactoryMonitor");
                    dialog->findChild<QLineEdit *>("fieldThư mục chứa")->setText(fixture_directory);
                } else {
                    dialog->findChild<QLineEdit *>("fieldTitle")->setText("Validate sensor sampling");
                    auto kind = dialog->findChild<QComboBox *>("fieldKind");
                    kind->setCurrentIndex(kind->findData("validation"));
                    auto state = dialog->findChild<QComboBox *>("fieldState");
                    state->setCurrentIndex(state->findData("done"));
                    dialog->findChild<QLineEdit *>("fieldChecklist / completion")
                        ->setText("Checked synthetic model");
                    dialog->findChild<QDialogButtonBox *>()->button(QDialogButtonBox::Save)->click();
                }
                QTimer::singleShot(100, dialog, [dialog, output] {
                    const auto success = save_capture(dialog, output);
                    dialog->reject();
                    QTimer::singleShot(0, qApp, [success] { QApplication::exit(success ? 0 : 1); });
                });
            });
            button->click();
        });
    } else {
        QTimer::singleShot(250, &window, [&window, output, screen] {
            if (screen == "12-work-board" &&
                window.findChild<QComboBox *>("workViewMode")->currentIndex() != 1) {
                QApplication::exit(1);
                return;
            }
            QApplication::exit(save_capture(&window, output) ? 0 : 1);
        });
    }
    return true;
}
