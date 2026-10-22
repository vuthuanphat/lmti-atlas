#include "design_fixture.hpp"
#include "project_captions.hpp"
#include "project_window.hpp"
#include "studio_graph.hpp"
#include "studio_widgets.hpp"
#include "window.hpp"
#include <QAction>
#include <QCheckBox>
#include <QDateTime>
#include <QDesktopServices>
#include <QDialog>
#include <QDialogButtonBox>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileDialog>
#include <QHeaderView>
#include <QJsonArray>
#include <QJsonDocument>
#include <QMap>
#include <QMenu>
#include <QMessageBox>
#include <QPushButton>
#include <QScopeGuard>
#include <QScrollBar>
#include <QSet>
#include <QStandardPaths>
#include <QTemporaryDir>
#include <QTimeZone>
#include <QTimer>
#include <QToolBar>
#include <QUrl>
#include <QtTest>

class FolderOpenProbe : public QObject {
    Q_OBJECT
  public:
    int count = 0;
  public slots:
    void record(const QUrl &) {
        ++count;
    }
};

class WindowTest : public QObject {
    Q_OBJECT
  private slots:
    void overview_actions_prioritize_blockers_keep_back_and_plan_validation() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        window.save_to(temp.filePath("project.sqlite"));
        const auto before = window.document();
        window.show();
        auto pages = window.findChild<QTabWidget *>("projectTabs");
        QVERIFY(pages);
        const auto blocked = std::find_if(before.work.begin(), before.work.end(), [](const auto &work) {
            return work.state == lmti::WorkState::Blocked;
        });
        QVERIFY(blocked != before.work.end());
        auto attention = window.findChild<QTreeWidget *>("projectAttention");
        for (const bool english : {true, false}) {
            window.set_language(english);
            for (const auto size : {QSize(1100, 800), QSize(1280, 720), QSize(1440, 900)}) {
                window.resize(size);
                window.show_page(ProjectPage::Overview);
                QCoreApplication::processEvents();
                QCOMPARE(attention->topLevelItem(0)->data(0, Qt::UserRole).toString(),
                         QString::fromStdString(blocked->id));
                auto open = attention->findChild<QPushButton *>("attentionOpen-work-" +
                                                                QString::fromStdString(blocked->id));
                QVERIFY(open && open->isVisible());
                const auto bounds = QRect(open->mapTo(attention->viewport(), QPoint()), open->size());
                QVERIFY(attention->viewport()->rect().contains(bounds));
                open->click();
                QCOMPARE(pages->currentIndex(), static_cast<int>(ProjectPage::Work));
                QCOMPARE(window.findChild<QTreeWidget *>("workTable")
                             ->currentItem()
                             ->data(0, Qt::UserRole)
                             .toString(),
                         QString::fromStdString(blocked->id));
                window.findChild<QPushButton *>("inspectorBack")->click();
                QCOMPARE(pages->currentIndex(), static_cast<int>(ProjectPage::Overview));
                QVERIFY(!window.findChild<QFrame *>("entityInspector")->isVisible());
                QCOMPARE(window.document(), before);
            }
        }
        QTimer::singleShot(0, &window, [&] {
            auto dialog = window.findChild<QDialog *>("projectRecordDialog");
            QVERIFY(dialog);
            const auto close = qScopeGuard([&] { dialog->reject(); });
            QCOMPARE(dialog->findChild<QComboBox *>("fieldKind")->currentData().toString(), "validation");
            QCOMPARE(dialog->findChild<QComboBox *>("fieldVisibility")->currentData().toString(), "internal");
        });
        window.findChild<QPushButton *>("next-work")->click();
        QCOMPARE(window.document(), before);
        window.update_project([](auto &document) {
            for (int index = 0; index < 6; ++index) {
                auto work = document.work.back();
                work.id = "synthetic-blocker-" + std::to_string(index);
                document.work.push_back(work);
            }
        });
        window.show_page(ProjectPage::Overview);
        QCOMPARE(attention->topLevelItemCount(), 3);
        QVERIFY(window.findChild<QLabel *>("attentionCount")->isVisible());
        QVERIFY(window.findChild<QLabel *>("attentionCount")->text().contains("8"));
        window.update_project([](auto &document) {
            for (auto &work : document.work) {
                work.state = lmti::WorkState::Done;
                work.evidence = "Synthetic checklist evidence";
                work.checklist = "Synthetic completed checklist";
            }
        });
        QCOMPARE(attention->topLevelItemCount(), 1);
        QCOMPARE(attention->topLevelItem(0)->data(0, Qt::UserRole + 1).toString(), "milestone");
        window.new_project("Empty synthetic project");
        window.show_page(ProjectPage::Overview);
        QCOMPARE(attention->topLevelItemCount(), 1);
        QVERIFY(!attention->findChild<QPushButton *>("attentionOpen-work-" +
                                                     QString::fromStdString(blocked->id)));
        QVERIFY(!window.findChild<QPushButton *>("next-release")->isEnabled());
        QVERIFY(!window.findChild<QPushButton *>("addrelease")->isEnabled());
        QVERIFY(!window.findChild<QPushButton *>("addbinding")->isEnabled());
        QVERIFY(!window.findChild<QPushButton *>("addverification")->isEnabled());
        QVERIFY(!window.findChild<QPushButton *>("adddependency")->isEnabled());
    }
    void inventories_distinguish_empty_data_from_no_matches_and_keep_add_gates() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.new_project("Empty synthetic project");
        window.show();
        window.show_page(ProjectPage::Releases);
        auto releases = window.findChild<QTreeWidget *>("releaseTable");
        auto empty = releases->findChild<QLabel *>("tableEmptyState");
        QVERIFY(empty && empty->isVisible());
        QCOMPARE(empty->text(), project_caption("Add a component before creating a release."));
        window.load_demo();
        window.show_page(ProjectPage::Software);
        auto components = window.findChild<QTreeWidget *>("componentTable");
        auto filter = window.findChild<QLineEdit *>("componentFilter");
        filter->setText("No synthetic match");
        auto message = components->findChild<QLabel *>("tableEmptyState");
        QVERIFY(message && message->isVisible());
        QCOMPARE(message->text(),
                 project_caption("No matching records. Clear the filters to see all records."));
        const auto before = window.document();
        window.set_language(false);
        QVERIFY(message->text().contains(QString::fromUtf8("Không có bản ghi")));
        filter->clear();
        QVERIFY(!message->isVisible());
        QVERIFY(window.findChild<QPushButton *>("addrelease")->isEnabled());
        QVERIFY(window.findChild<QPushButton *>("addbinding")->isEnabled());
        QVERIFY(window.findChild<QPushButton *>("addverification")->isEnabled());
        QVERIFY(window.findChild<QPushButton *>("adddependency")->isEnabled());
        QCOMPARE(window.document(), before);
    }
    void edit_and_create_forms_keep_footer_validation_and_destination_at_supported_sizes() {
        QTemporaryDir temp;
        QVERIFY(QDir(temp.path()).mkdir("existing"));
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        const auto path = temp.filePath("original.sqlite");
        window.save_to(path);
        const auto original = window.document();
        window.show();
        auto footer_fits = [](QDialog *dialog) {
            auto buttons = dialog->findChild<QDialogButtonBox *>();
            for (const auto role : {QDialogButtonBox::Save, QDialogButtonBox::Cancel}) {
                auto button = buttons->button(role);
                const auto bounds = QRect(button->mapTo(dialog, QPoint()), button->size());
                if (!button->isVisible() || !dialog->rect().contains(bounds))
                    return false;
            }
            auto scroll = dialog->findChild<QScrollArea *>("recordFormScroll");
            return scroll && !scroll->isAncestorOf(buttons);
        };
        int sequence = 0;
        for (const bool english : {true, false}) {
            window.set_language(english);
            for (const auto size : {QSize(1100, 800), QSize(1280, 720), QSize(1440, 900)}) {
                window.resize(size);
                window.show_page(ProjectPage::Work);
                window.findChild<QTabWidget *>("workTabs")->setCurrentIndex(0);
                auto work = window.findChild<QTreeWidget *>("workTable");
                for (int index = 0; index < work->topLevelItemCount(); ++index)
                    if (work->topLevelItem(index)->data(0, Qt::UserRole).toString() == "validate-sampling")
                        work->setCurrentItem(work->topLevelItem(index));
                QTimer::singleShot(0, &window, [&] {
                    auto dialog = window.findChild<QDialog *>("projectRecordDialog");
                    QVERIFY(dialog);
                    const auto close = qScopeGuard([&] {
                        if (dialog->isVisible())
                            dialog->reject();
                    });
                    QCOMPARE(dialog->windowTitle(), project_caption("Edit work"));
                    QStringList section_titles;
                    for (auto label : dialog->findChildren<QLabel *>("sectionTitle"))
                        section_titles << label->text();
                    QVERIFY(section_titles.contains(project_caption("Links")));
                    QVERIFY(section_titles.contains(project_caption("Completion")));
                    dialog->resize(740, std::min(740, size.height() - 100));
                    auto title = dialog->findChild<QLineEdit *>("fieldTitle");
                    title->setText("Retained edit draft");
                    auto state = dialog->findChild<QComboBox *>("fieldState");
                    state->setCurrentIndex(state->findData("done"));
                    auto evidence = dialog->findChild<QLineEdit *>("fieldEvidence reference");
                    evidence->clear();
                    dialog->findChild<QLineEdit *>("fieldChecklist / completion")
                        ->setText("Synthetic checklist");
                    QCoreApplication::processEvents();
                    QVERIFY(footer_fits(dialog));
                    auto buttons = dialog->findChild<QDialogButtonBox *>();
                    QTest::mouseClick(buttons->button(QDialogButtonBox::Save), Qt::LeftButton);
                    QVERIFY(dialog->isVisible());
                    QCOMPARE(dialog->focusWidget(), evidence);
                    QCOMPARE(title->text(), "Retained edit draft");
                    QVERIFY(evidence->property("invalid").toBool());
                    QCoreApplication::processEvents();
                    auto scroll = dialog->findChild<QScrollArea *>("recordFormScroll");
                    QTRY_VERIFY(scroll->viewport()->rect().contains(
                        QRect(evidence->mapTo(scroll->viewport(), QPoint()), evidence->size())));
                    auto error_container = evidence->parentWidget();
                    QTRY_VERIFY(scroll->viewport()->rect().contains(QRect(
                        error_container->mapTo(scroll->viewport(), QPoint()), error_container->size())));
                    QVERIFY(footer_fits(dialog));
                    QCOMPARE(window.document(), original);
                    QTest::keyClick(dialog, Qt::Key_Escape);
                });
                window.findChild<QPushButton *>("editwork")->click();
                QCOMPARE(window.document(), original);
                QCOMPARE(lmti::load_project(path), original);
                window.show_library();
                const auto folder_name = QString("created-%1").arg(++sequence);
                QTimer::singleShot(0, &window, [&] {
                    auto dialog = window.findChild<QDialog *>("createProjectDialog");
                    QVERIFY(dialog);
                    const auto close = qScopeGuard([&] {
                        if (dialog->isVisible())
                            dialog->reject();
                    });
                    dialog->resize(740, std::min(740, size.height() - 100));
                    auto name = dialog->findChild<QLineEdit *>("fieldTên dự án");
                    auto parent = dialog->findChild<QLineEdit *>("fieldThư mục chứa");
                    auto folder = dialog->findChild<QLineEdit *>("fieldTên thư mục");
                    auto preview = dialog->findChild<QLabel *>("projectDestinationPreview");
                    name->setText("Retained project draft");
                    parent->setText(temp.path());
                    folder->setText("../escape");
                    auto save = dialog->findChild<QDialogButtonBox *>()->button(QDialogButtonBox::Save);
                    QCoreApplication::processEvents();
                    QVERIFY(footer_fits(dialog));
                    save->click();
                    QVERIFY(dialog->isVisible());
                    QCOMPARE(dialog->focusWidget(), folder);
                    QCOMPARE(name->text(), "Retained project draft");
                    folder->setText("existing");
                    save->click();
                    QVERIFY(dialog->isVisible());
                    QVERIFY(folder->property("invalid").toBool());
                    QCOMPARE(dialog->focusWidget(), folder);
                    QCOMPARE(window.document(), original);
                    folder->setText(folder_name);
                    QVERIFY(preview->text().contains(QDir(temp.path()).filePath(folder_name)));
                    folder->clear();
                    QVERIFY(!preview->text().contains(folder_name));
                    folder->setText(folder_name);
                    QCoreApplication::processEvents();
                    QVERIFY(footer_fits(dialog));
                    save->click();
                    QVERIFY(!dialog->isVisible());
                });
                window.findChild<QPushButton *>("createProjectButton")->click();
                const auto created_path = temp.filePath(folder_name + "/project.lmti.sqlite");
                QVERIFY(QFileInfo::exists(created_path));
                QCOMPARE(window.document().project.label, "Retained project draft");
                QCOMPARE(window.document().project.privacy, lmti::Privacy::Internal);
                QCOMPARE(lmti::load_project(created_path), window.document());
                QVERIFY(!QFileInfo::exists(temp.filePath("existing/project.lmti.sqlite")));
                window.open_project(path);
                QCOMPARE(window.document(), original);
            }
        }
    }
    void inventory_edit_dialogs_validate_links_and_save_only_the_draft() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        const auto path = temp.filePath("project.sqlite");
        window.save_to(path);
        const auto saved = window.document();
        window.show();
        auto select = [&](const char *table, const char *id) {
            auto rows = window.findChild<QTreeWidget *>(table);
            for (int index = 0; index < rows->topLevelItemCount(); ++index)
                if (rows->topLevelItem(index)->data(0, Qt::UserRole).toString() == id)
                    rows->setCurrentItem(rows->topLevelItem(index));
        };
        window.show_page(ProjectPage::Software);
        auto software = window.findChild<QTabWidget *>("softwareTabs");
        auto component_rows = window.findChild<QTreeWidget *>("componentTable");
        component_rows->setCurrentItem(component_rows->topLevelItem(0));
        const auto component_id = component_rows->currentItem()->data(0, Qt::UserRole).toString();
        for (const auto english : {true, false}) {
            window.set_language(english);
            for (const auto size : {QSize(1100, 800), QSize(1280, 720), QSize(1440, 900)}) {
                window.resize(size);
                QCoreApplication::processEvents();
                auto search = window.findChild<QLineEdit *>("componentFilter");
                auto more = window.findChild<QToolButton *>("componentActions");
                QVERIFY(search->isVisible() && search->width() >= 140);
                QVERIFY(more && more->isVisible());
                QVERIFY(!window.findChild<QPushButton *>("editcomponent")->isVisible());
                more->setFocus();
                QTest::keyClick(more, Qt::Key_Space);
                QTRY_VERIFY(more->menu()->isVisible());
                QVERIFY(more->menu()->actions().front()->isEnabled());
                more->menu()->hide();
                QTimer::singleShot(0, &window, [&] {
                    auto dialog = window.findChild<QDialog *>("projectRecordDialog");
                    QVERIFY(dialog);
                    QCOMPARE(dialog->findChild<QLineEdit *>("fieldName")->text(),
                             QString::fromStdString(saved.components.front().label));
                    dialog->reject();
                });
                more->menu()->actions().front()->trigger();
                QCOMPARE(window.document(), saved);
                QCOMPARE(component_rows->currentItem()->data(0, Qt::UserRole).toString(), component_id);
            }
        }
        window.set_language(true);
        software->setCurrentIndex(1);
        select("repositoryTable", "repo-sensor");
        auto repository_rows = window.findChild<QTreeWidget *>("repositoryTable");
        QCOMPARE(repository_rows->columnCount(), 4);
        QCOMPARE(repository_rows->currentItem()->text(3), "1");
        QCOMPARE(repository_rows->currentItem()->data(2, studio::badge_role).toString(), "public");
        QTimer::singleShot(0, &window, [&] {
            auto dialog = window.findChild<QDialog *>("projectRecordDialog");
            QVERIFY(dialog);
            const auto close = qScopeGuard([&] {
                if (dialog->isVisible())
                    dialog->reject();
            });
            dialog->findChild<QLineEdit *>("fieldLocator")->setText("https://example.invalid/sensor");
            dialog->findChild<QDialogButtonBox *>()->button(QDialogButtonBox::Save)->click();
        });
        window.findChild<QPushButton *>("editrepository")->click();
        QCOMPARE(window.document().repositories.front().locator, "https://example.invalid/sensor");
        software->setCurrentIndex(2);
        select("dependencyTable", "sensor-gateway");
        const auto before_dependency = window.document();
        QTimer::singleShot(0, &window, [&] {
            auto dialog = window.findChild<QDialog *>("projectRecordDialog");
            QVERIFY(dialog);
            const auto close = qScopeGuard([&] {
                if (dialog->isVisible())
                    dialog->reject();
            });
            auto target = dialog->findChild<QComboBox *>("fieldTarget");
            target->setCurrentIndex(target->findData("sensor-firmware"));
            auto contract = dialog->findChild<QLineEdit *>("fieldInterface / contract");
            contract->setText("Synthetic contract v2");
            auto save = dialog->findChild<QDialogButtonBox *>()->button(QDialogButtonBox::Save);
            save->click();
            QVERIFY(dialog->isVisible());
            QCOMPARE(window.document(), before_dependency);
            QCOMPARE(contract->text(), "Synthetic contract v2");
            target->setCurrentIndex(target->findData("gateway-agent"));
            save->click();
        });
        window.findChild<QPushButton *>("editdependency")->click();
        QCOMPARE(window.document().dependencies.front().contract, "Synthetic contract v2");
        window.show_page(ProjectPage::Hardware);
        window.findChild<QTabWidget *>("hardwareTabs")->setCurrentIndex(2);
        select("bindingTable", "sensor-binding");
        QTimer::singleShot(0, &window, [&] {
            auto dialog = window.findChild<QDialog *>("projectRecordDialog");
            QVERIFY(dialog);
            const auto close = qScopeGuard([&] {
                if (dialog->isVisible())
                    dialog->reject();
            });
            auto device = dialog->findChild<QComboBox *>("fieldDevice");
            device->setCurrentIndex(device->findData("gateway-b"));
            dialog->findChild<QDialogButtonBox *>()->button(QDialogButtonBox::Save)->click();
        });
        window.findChild<QPushButton *>("editbinding")->click();
        QCOMPARE(window.document().bindings.front().asset_id, "gateway-b");
        QCOMPARE(window.document().bindings.front().component_id, "sensor-firmware");
        QCOMPARE(window.document().bindings.front().target_id, "board-b");
        QCOMPARE(window.document().topology.assets, saved.topology.assets);
        QCOMPARE(lmti::load_project(path), saved);
        window.save_to(path);
        QCOMPARE(lmti::load_project(path), window.document());
        const auto before_work = window.document();
        QTimer::singleShot(0, &window, [&] {
            auto dialog = window.findChild<QDialog *>("projectRecordDialog");
            QVERIFY(dialog);
            const auto close = qScopeGuard([&] {
                if (dialog->isVisible())
                    dialog->reject();
            });
            QCOMPARE(dialog->findChild<QComboBox *>("fieldKind")->currentData().toString(), "validation");
            QCOMPARE(dialog->findChild<QComboBox *>("fieldComponent")->currentData().toString(),
                     "sensor-firmware");
            QCOMPARE(dialog->findChild<QComboBox *>("fieldDevice")->currentData().toString(), "gateway-b");
            QCOMPARE(dialog->findChild<QComboBox *>("fieldRelease")->currentData().toString(), "sensor-v020");
            dialog->findChild<QLineEdit *>("fieldTitle")->setText("Synthetic binding validation");
            dialog->findChild<QDialogButtonBox *>()->button(QDialogButtonBox::Save)->click();
        });
        auto add_validation = window.findChild<QPushButton *>("inspectorAddWork");
        QVERIFY(add_validation && add_validation->isEnabled());
        QCOMPARE(add_validation->text(), "Add validation work");
        add_validation->click();
        QCOMPARE(window.document().work.size(), before_work.work.size() + 1);
        const auto created = window.document().work.back();
        QCOMPARE(created.label, "Synthetic binding validation");
        QCOMPARE(created.kind, lmti::WorkKind::Validation);
        QCOMPARE(created.asset_id, "gateway-b");
        QCOMPARE(created.component_id, "sensor-firmware");
        QCOMPARE(created.release_id, "sensor-v020");
        QCOMPARE(created.privacy, lmti::Privacy::Internal);
        QCOMPARE(window.document().topology.assets, before_work.topology.assets);
        QCOMPARE(lmti::load_project(path), before_work);
        window.findChild<QPushButton *>("inspectorBack")->click();
        auto relations = window.findChild<QTreeWidget *>("inspectorRelations");
        bool linked_work = false;
        for (int index = 0; index < relations->topLevelItemCount(); ++index)
            linked_work |= relations->topLevelItem(index)->data(0, Qt::UserRole).toString() ==
                           QString::fromStdString(created.id);
        QVERIFY(linked_work);
        window.save_to(path);
        QCOMPARE(lmti::load_project(path), window.document());
        const auto before_reference = window.document();
        window.show_page(ProjectPage::Knowledge);
        window.findChild<QTabWidget *>("knowledgeTabs")->setCurrentIndex(0);
        QTimer::singleShot(0, &window, [&] {
            auto dialog = window.findChild<QDialog *>("projectRecordDialog");
            QVERIFY(dialog);
            const auto close = qScopeGuard([&] {
                if (dialog->isVisible())
                    dialog->reject();
            });
            dialog->findChild<QLineEdit *>("fieldLabel")->setText("Synthetic knowledge reference");
            auto component = dialog->findChild<QComboBox *>("fieldComponent");
            component->setCurrentIndex(component->findData("sensor-firmware"));
            dialog->findChild<QLineEdit *>("fieldLocal reference")->setText("synthetic-interface-note");
            dialog->findChild<QLineEdit *>("fieldFingerprint")->setText("synthetic-reference-v1");
            dialog->findChild<QDialogButtonBox *>()->button(QDialogButtonBox::Save)->click();
        });
        window.findChild<QPushButton *>("addknowledge")->click();
        QCOMPARE(window.document().knowledge.size(), before_reference.knowledge.size() + 1);
        QCOMPARE(window.document().knowledge.back().privacy, lmti::Privacy::Internal);
        QCOMPARE(window.findChild<QLabel *>("knowledgeStatus")->text(), "Not connected");
        QVERIFY(!window.findChild<QPushButton *>("reloadKnowledge")->isEnabled());
        auto panel = window.findChild<QWidget *>("knowledgeConnection");
        QVERIFY(panel->findChildren<QProcess *>().isEmpty());
        auto references = window.findChild<QTreeWidget *>("knowledgeTable");
        QVERIFY(references);
        references->setCurrentItem(references->topLevelItem(0));
        auto reference_facts = window.findChild<QTreeWidget *>("inspectorFacts");
        QCOMPARE(reference_facts->topLevelItemCount(), 4);
        QCOMPARE(reference_facts->topLevelItem(3)->text(1), "Source not loaded");
        QCOMPARE(lmti::load_project(path), before_reference);
        window.save_to(path);
        QCOMPARE(lmti::load_project(path), window.document());
    }
    void component_summary_and_related_work_keep_metadata_history_and_actions() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        const auto before = window.document();
        window.show();
        auto rows = window.findChild<QTreeWidget *>("componentTable");
        auto mode = window.findChild<QComboBox *>("inspectorViewMode");
        auto links = window.findChild<QTreeWidget *>("inspectorRelations");
        auto select = [&](const QString &id) {
            for (int index = 0; index < rows->topLevelItemCount(); ++index)
                if (rows->topLevelItem(index)->data(0, Qt::UserRole).toString() == id)
                    rows->setCurrentItem(rows->topLevelItem(index));
        };
        for (const bool english : {true, false}) {
            window.set_language(english);
            for (const auto size : {QSize(1100, 800), QSize(1280, 720), QSize(1440, 900)}) {
                window.resize(size);
                window.show_page(ProjectPage::Software);
                select("sensor-firmware");
                QTest::mouseClick(window.findChild<QPushButton *>("inspectorViewSegments0"), Qt::LeftButton);
                QCoreApplication::processEvents();
                QVERIFY(window.findChild<QTreeWidget *>("inspectorFacts")->isVisible());
                auto facts = window.findChild<QTreeWidget *>("inspectorFacts");
                bool desired = false, observed = false;
                for (int index = 0; index < facts->topLevelItemCount(); ++index) {
                    auto row = facts->topLevelItem(index);
                    desired |= row->data(0, Qt::UserRole) == "Desired bindings" && row->text(1) == "1";
                    observed |= row->data(0, Qt::UserRole) == "Observed versions" &&
                                row->text(1) == project_caption("Unknown");
                }
                QVERIFY(desired && observed);
                auto content = window.findChild<QWidget *>("inspectorContent");
                auto scroll = qobject_cast<QScrollArea *>(content->parentWidget()->parentWidget());
                QVERIFY(scroll);
                scroll->verticalScrollBar()->setValue(scroll->verticalScrollBar()->maximum());
                QCoreApplication::processEvents();
                auto inspector = window.findChild<QFrame *>("entityInspector");
                auto title = window.findChild<QLabel *>("inspectorTitle");
                QVERIFY(inspector->rect().contains(QRect(title->mapTo(inspector, QPoint()), title->size())));
                auto related = window.findChild<QPushButton *>("inspectorViewSegments1");
                related->setFocus();
                QTest::keyClick(related, Qt::Key_Space);
                QCOMPARE(mode->currentData().toString(), "work");
                QVERIFY(!facts->isVisible());
                QTreeWidgetItem *work = nullptr;
                for (int index = 0; index < links->topLevelItemCount(); ++index)
                    if (!links->topLevelItem(index)->isHidden()) {
                        QCOMPARE(links->topLevelItem(index)->data(0, Qt::UserRole + 1).toString(), "work");
                        work = links->topLevelItem(index);
                    }
                QVERIFY(work);
                links->setCurrentItem(work);
                window.findChild<QPushButton *>("openRelatedRecord")->click();
                QCOMPARE(window.findChild<QTabWidget *>("projectTabs")->currentIndex(),
                         static_cast<int>(ProjectPage::Work));
                window.findChild<QPushButton *>("inspectorBack")->click();
                QCOMPARE(mode->currentData().toString(), "work");
                QCOMPARE(rows->currentItem()->data(0, Qt::UserRole).toString(), "sensor-firmware");
                QCOMPARE(window.document(), before);
                select("monitor-backend");
                QTest::mouseClick(window.findChild<QPushButton *>("inspectorViewSegments1"), Qt::LeftButton);
                QVERIFY(links->findChild<QLabel *>("tableEmptyState")->isVisible());
                QVERIFY(window.findChild<QPushButton *>("inspectorAddWork")->isEnabled());
                QCOMPARE(window.document(), before);
            }
        }
    }
    void inspector_related_pages_keep_all_records_keyboard_history_and_one_scroll_area() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        window.update_project([](auto &document) {
            const auto prototype =
                *std::find_if(document.work.begin(), document.work.end(),
                              [](const auto &work) { return work.component_id == "sensor-firmware"; });
            for (int index = 0; index < 31; ++index) {
                auto work = prototype;
                work.id = "related-page-" + std::to_string(index);
                work.label = "Related task " + std::to_string(index);
                document.work.push_back(work);
            }
        });
        const auto before = window.document();
        QSet<QString> expected;
        for (const auto &work : before.work)
            if (work.component_id == "sensor-firmware")
                expected.insert(QString::fromStdString(work.id));
        window.resize(1100, 800);
        window.show();
        window.show_page(ProjectPage::Software);
        auto components = window.findChild<QTreeWidget *>("componentTable");
        auto filter = window.findChild<QLineEdit *>("componentFilter");
        filter->setText("sensor");
        for (int index = 0; index < components->topLevelItemCount(); ++index)
            if (components->topLevelItem(index)->data(0, Qt::UserRole).toString() == "sensor-firmware")
                components->setCurrentItem(components->topLevelItem(index));
        auto mode = window.findChild<QComboBox *>("inspectorViewMode");
        mode->setCurrentIndex(1);
        auto relations = window.findChild<QTreeWidget *>("inspectorRelations");
        auto scroll = window.findChild<QScrollArea *>("inspectorScroll");
        auto next = window.findChild<QPushButton *>("inspectorNext");
        auto previous = window.findChild<QPushButton *>("inspectorPrevious");
        QVERIFY(scroll && next && previous);
        QVERIFY(!previous->isEnabled());
        QSet<QString> seen;
        for (;;) {
            QCoreApplication::processEvents();
            QVERIFY(relations->topLevelItemCount() <= 12);
            QCOMPARE(relations->verticalScrollBarPolicy(), Qt::ScrollBarAlwaysOff);
            QCOMPARE(relations->horizontalScrollBarPolicy(), Qt::ScrollBarAlwaysOff);
            QCOMPARE(relations->verticalScrollBar()->maximum(), 0);
            for (int index = 0; index < relations->topLevelItemCount(); ++index) {
                auto item = relations->topLevelItem(index);
                QCOMPARE(item->data(0, Qt::UserRole + 1).toString(), "work");
                QVERIFY(!seen.contains(item->data(0, Qt::UserRole).toString()));
                seen.insert(item->data(0, Qt::UserRole).toString());
            }
            if (!next->isEnabled())
                break;
            next->click();
        }
        QCOMPARE(seen, expected);
        const auto page_caption = window.findChild<QLabel *>("inspectorPageLabel")->text();
        auto selected = relations->topLevelItem(relations->topLevelItemCount() - 1);
        const auto selected_id = selected->data(0, Qt::UserRole).toString();
        relations->setCurrentItem(selected);
        relations->setFocus();
        QTest::keyClick(relations, Qt::Key_Return);
        QCOMPARE(window.findChild<QTabWidget *>("projectTabs")->currentIndex(),
                 static_cast<int>(ProjectPage::Work));
        window.findChild<QPushButton *>("inspectorBack")->click();
        QCoreApplication::processEvents();
        QCOMPARE(mode->currentData().toString(), "work");
        QCOMPARE(window.findChild<QLabel *>("inspectorPageLabel")->text(), page_caption);
        QVERIFY(relations->currentItem());
        QCOMPARE(relations->currentItem()->data(0, Qt::UserRole).toString(), selected_id);
        QCOMPARE(filter->text(), "sensor");
        QVERIFY(previous->isEnabled());
        QVERIFY(!next->isEnabled());
        scroll->verticalScrollBar()->setValue(scroll->verticalScrollBar()->maximum());
        QCoreApplication::processEvents();
        auto inspector = window.findChild<QFrame *>("entityInspector");
        for (const auto name : {"inspectorTitle", "inspectorEdit", "inspectorAddWork"}) {
            auto control = window.findChild<QWidget *>(name);
            QVERIFY(control && control->isVisible());
            QVERIFY(inspector->rect().contains(QRect(control->mapTo(inspector, QPoint()), control->size())));
        }
        window.set_language(false);
        QCoreApplication::processEvents();
        QVERIFY(relations->topLevelItemCount() <= 12);
        QCOMPARE(mode->currentData().toString(), "work");
        QCOMPARE(window.document(), before);
    }
    void management_column_choices_keep_metadata_and_localized_actions() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        window.set_language(true);
        const auto before = window.document();
        window.show();
        struct Inventory {
            ProjectPage page;
            const char *tree;
            int hidden_column;
        };
        for (const auto &inventory : {Inventory{ProjectPage::Work, "workTable", 2},
                                      Inventory{ProjectPage::Releases, "releaseTable", 3},
                                      Inventory{ProjectPage::Software, "componentTable", 3}}) {
            auto tree = window.findChild<QTreeWidget *>(inventory.tree);
            auto picker = window.findChild<QToolButton *>(QString(inventory.tree) + "Columns");
            QVERIFY(tree && picker && picker->menu());
            QVERIFY(tree->isColumnHidden(inventory.hidden_column));
            const auto values = [&] {
                QStringList result;
                for (int index = 0; index < tree->topLevelItemCount(); ++index)
                    result << tree->topLevelItem(index)->text(inventory.hidden_column);
                return result;
            }();
            QVERIFY(!values.empty());
            auto action = picker->menu()->actions().at(inventory.hidden_column - 1);
            QVERIFY(action->isCheckable());
            for (const bool english : {true, false}) {
                window.set_language(english);
                window.show_page(inventory.page);
                tree->setCurrentItem(tree->topLevelItem(0));
                for (const auto size : {QSize(1100, 800), QSize(1440, 900)}) {
                    window.resize(size);
                    QCoreApplication::processEvents();
                    QVERIFY(window.findChild<QFrame *>("entityInspector")->isVisible());
                    QCOMPARE(picker->text(), project_caption("Columns"));
                    QCOMPARE(action->text(), tree->headerItem()->text(inventory.hidden_column));
                    QVERIFY(tree->isColumnHidden(inventory.hidden_column));
                    action->trigger();
                    QVERIFY(!tree->isColumnHidden(inventory.hidden_column));
                    action->trigger();
                    QVERIFY(tree->isColumnHidden(inventory.hidden_column));
                    QCOMPARE(window.document(), before);
                }
            }
            window.set_language(true);
            for (int index = 0; index < tree->topLevelItemCount(); ++index)
                QCOMPARE(tree->topLevelItem(index)->text(inventory.hidden_column), values.at(index));
        }
        window.show_page(ProjectPage::Work);
        auto work_mode = window.findChild<QComboBox *>("workViewMode");
        auto work_columns = window.findChild<QToolButton *>("workTableColumns");
        work_mode->setCurrentIndex(1);
        QCoreApplication::processEvents();
        QVERIFY(!work_columns->isVisible());
        work_mode->setCurrentIndex(0);
        QCoreApplication::processEvents();
        QVERIFY(work_columns->isVisible());
        QCOMPARE(window.document(), before);
    }
    void inventory_facts_and_related_navigation_match_the_typed_records() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        const auto before = window.document();
        window.show();
        struct Case {
            ProjectPage page;
            const char *tabs;
            int tab;
            const char *table, *id, *fact, *value, *related_kind, *related_id;
        };
        const std::vector<Case> cases{
            {ProjectPage::Software, "softwareTabs", 0, "componentTable", "sensor-firmware", "Related devices",
             "1", "repository", "repo-sensor"},
            {ProjectPage::Software, "softwareTabs", 1, "repositoryTable", "repo-sensor", "Linked components",
             "1", "component", "sensor-firmware"},
            {ProjectPage::Software, "softwareTabs", 2, "dependencyTable", "sensor-gateway",
             "Target component", "Gateway agent", "component", "gateway-agent"},
            {ProjectPage::Hardware, "hardwareTabs", 0, "hardwareDevices", "machine-a", "Observed version",
             "Unknown", "binding", "sensor-binding"},
            {ProjectPage::Hardware, "hardwareTabs", 1, "targetTable", "board-b", "Hardware revision", "rev B",
             "release", "sensor-v020"},
            {ProjectPage::Hardware, "hardwareTabs", 2, "bindingTable", "sensor-binding", "Desired version",
             "0.2.0", "target", "board-b"}};
        auto fact = [&window](const QString &key) {
            auto rows = window.findChild<QTreeWidget *>("inspectorFacts");
            for (int index = 0; index < rows->topLevelItemCount(); ++index)
                if (rows->topLevelItem(index)->data(0, Qt::UserRole).toString() == key)
                    return rows->topLevelItem(index)->text(1);
            return QString{};
        };
        for (const auto &entry : cases) {
            window.show_page(entry.page);
            auto tabs = window.findChild<QTabWidget *>(entry.tabs);
            tabs->setCurrentIndex(entry.tab);
            auto table = window.findChild<QTreeWidget *>(entry.table);
            for (int index = 0; index < table->topLevelItemCount(); ++index)
                if (table->topLevelItem(index)->data(0, Qt::UserRole).toString() == entry.id)
                    table->setCurrentItem(table->topLevelItem(index));
            QCOMPARE(fact(entry.fact), QString(entry.value));
            auto relations = window.findChild<QTreeWidget *>("inspectorRelations");
            QTreeWidgetItem *linked = nullptr;
            for (int index = 0; index < relations->topLevelItemCount(); ++index) {
                auto row = relations->topLevelItem(index);
                if (row->data(0, Qt::UserRole + 1).toString() == entry.related_kind &&
                    row->data(0, Qt::UserRole).toString() == entry.related_id)
                    linked = row;
            }
            QVERIFY(linked);
            relations->setCurrentItem(linked);
            QVERIFY(relations->isHeaderHidden());
            QVERIFY(relations->isColumnHidden(1));
            if (entry.page == ProjectPage::Hardware) {
                relations->setFocus();
                QTest::keyClick(relations, Qt::Key_Return);
            } else
                window.findChild<QPushButton *>("openRelatedRecord")->click();
            window.findChild<QPushButton *>("inspectorBack")->click();
            QCOMPARE(tabs->currentIndex(), entry.tab);
            QCOMPARE(table->currentItem()->data(0, Qt::UserRole).toString(), QString(entry.id));
            QCOMPARE(fact(entry.fact), QString(entry.value));
            QCOMPARE(window.document(), before);
        }
        window.set_language(false);
        QCOMPARE(fact("Observed version"), QString::fromUtf8("Chưa xác định"));
        QCOMPARE(fact("Desired version"), "0.2.0");
        QCOMPARE(window.document(), before);
    }
    void details_reserve_their_viewport_and_close_by_keyboard_at_supported_sizes() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        const auto before = window.document();
        window.show();
        window.activateWindow();
        auto pages = window.findChild<QScrollArea *>("workspaceScroll");
        auto details = window.findChild<QFrame *>("entityInspector");
        auto components = window.findChild<QTreeWidget *>("componentTable");
        for (const auto english : {true, false}) {
            window.set_language(english);
            for (const auto size : {QSize(1100, 800), QSize(1280, 720), QSize(1440, 900)}) {
                window.resize(size);
                window.show_page(ProjectPage::Software);
                window.findChild<QTabWidget *>("softwareTabs")->setCurrentIndex(0);
                components->clearSelection();
                components->setCurrentItem(components->topLevelItem(0));
                QCoreApplication::processEvents();
                QVERIFY(details->isVisible());
                const auto main_bounds = QRect(pages->mapTo(&window, QPoint()), pages->size());
                const auto detail_bounds = QRect(details->mapTo(&window, QPoint()), details->size());
                QVERIFY(!main_bounds.intersects(detail_bounds));
                QVERIFY(detail_bounds.right() < window.width());
                QVERIFY(main_bounds.width() >= 350);
                auto close = window.findChild<QPushButton *>("closeInspector");
                QVERIFY(close->isVisible());
                close->setFocus();
                QTest::keyClick(close, Qt::Key_Escape);
                QTRY_VERIFY(!details->isVisible());
                QCOMPARE(window.document(), before);
            }
        }
    }
    void library_locate_rejects_another_project_and_repairs_the_same_identity() {
        const auto native_dialogs = QApplication::testAttribute(Qt::AA_DontUseNativeDialogs);
        QApplication::setAttribute(Qt::AA_DontUseNativeDialogs, true);
        const auto restore =
            qScopeGuard([&] { QApplication::setAttribute(Qt::AA_DontUseNativeDialogs, native_dialogs); });
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.create_project_folder(temp.path(), "original", "Original project");
        const auto original = window.document();
        const auto old_path = temp.filePath("original/project.lmti.sqlite");
        const auto moved_path = temp.filePath("moved.sqlite");
        lmti::pin_library_project(window.library_path(), QString::fromStdString(original.project.id), true);
        window.create_project_folder(temp.path(), "other", "Other project");
        const auto other = window.document();
        const auto other_path = temp.filePath("other/project.lmti.sqlite");
        QVERIFY(QFile::rename(old_path, moved_path));
        window.show_library();
        window.show();
        auto choose = [&](const QString &path) {
            QTimer::singleShot(0, &window, [&, path] {
                auto dialog = window.findChild<QFileDialog *>();
                QVERIFY(dialog);
                const auto close = qScopeGuard([&] {
                    if (dialog->isVisible())
                        dialog->reject();
                });
                dialog->selectFile(path);
                QVERIFY(QMetaObject::invokeMethod(dialog, "accept", Qt::DirectConnection));
            });
        };
        QString rejection;
        QTimer errors;
        errors.setInterval(10);
        connect(&errors, &QTimer::timeout, &window, [&] {
            if (auto dialog = window.findChild<QMessageBox *>(); dialog && dialog->isVisible()) {
                rejection = dialog->text();
                dialog->accept();
                errors.stop();
            }
        });
        choose(other_path);
        errors.start();
        window.findChild<QPushButton *>("open-" + QString::fromStdString(original.project.id))->click();
        errors.stop();
        QVERIFY(rejection.contains("different project"));
        QCOMPARE(window.document(), other);
        auto entries = lmti::project_library(window.library_path());
        auto entry = std::find_if(entries.begin(), entries.end(), [&](const auto &record) {
            return record.id == QString::fromStdString(original.project.id);
        });
        QVERIFY(entry != entries.end());
        QCOMPARE(entry->path, old_path);
        QVERIFY(entry->pinned);
        choose(moved_path);
        window.findChild<QPushButton *>("open-" + QString::fromStdString(original.project.id))->click();
        QCOMPARE(window.document(), original);
        entries = lmti::project_library(window.library_path());
        entry = std::find_if(entries.begin(), entries.end(), [&](const auto &record) {
            return record.id == QString::fromStdString(original.project.id);
        });
        QVERIFY(entry != entries.end());
        QCOMPARE(entry->path, moved_path);
        QVERIFY(entry->pinned);
        QCOMPARE(lmti::load_project(moved_path), original);
        QCOMPARE(lmti::load_project(other_path), other);
        QVERIFY(!QFileInfo::exists(old_path));
    }
    void approved_release_is_readonly_and_creates_a_separate_editable_draft() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        window.update_project(
            [](auto &document) { document.releases.front().state = lmti::ReleaseState::Approved; });
        const auto path = temp.filePath("project.sqlite");
        window.save_to(path);
        const auto before = window.document();
        window.show_page(ProjectPage::Releases);
        window.show();
        auto releases = window.findChild<QTreeWidget *>("releaseTable");
        releases->setCurrentItem(releases->topLevelItem(0));
        auto edit = window.findChild<QPushButton *>("inspectorEdit");
        auto create = window.findChild<QPushButton *>("inspectorCreateVersion");
        QVERIFY(edit && !edit->isEnabled());
        QVERIFY(create && create->isEnabled() && create->property("primary").toBool());
        QCoreApplication::processEvents();
        const auto capture = create->grab().toImage();
        const auto primary = capture.pixelColor(capture.width() / 2, qRound(7 * capture.devicePixelRatio()));
        QVERIFY2(primary.blue() > primary.red() + 60, qPrintable(primary.name()));
        QCOMPARE(window.findChild<QLabel *>("inspectorState")->text(), "Metadata locked");
        QCOMPARE(window.findChild<QTreeWidget *>("inspectorFacts")->topLevelItemCount(), 5);
        QVERIFY_THROWS_EXCEPTION(lmti::Error, window.update_project([](auto &document) {
            document.releases.front().source_revision = "Different revision";
        }));
        QCOMPARE(window.document(), before);
        QTimer::singleShot(0, &window, [&] {
            auto dialog = window.findChild<QDialog *>("projectRecordDialog");
            QVERIFY(dialog);
            const auto cancel = qScopeGuard([&] { dialog->reject(); });
            QCOMPARE(dialog->findChild<QComboBox *>("fieldComponent")->currentData().toString(),
                     "sensor-firmware");
            QCOMPARE(dialog->findChild<QComboBox *>("fieldTarget")->currentData().toString(), "board-b");
            QCOMPARE(dialog->findChild<QComboBox *>("fieldReview state")->currentData().toString(), "draft");
            QCOMPARE(dialog->findChild<QComboBox *>("fieldVisibility")->currentData().toString(), "internal");
            QVERIFY(dialog->findChild<QLineEdit *>("fieldVersion")->text().isEmpty());
        });
        create->click();
        QCOMPARE(window.document(), before);
        window.set_language(false);
        QCOMPARE(window.findChild<QLabel *>("inspectorState")->text(),
                 QString::fromUtf8("Thông tin đã khóa"));
        QCOMPARE(window.findChild<QPushButton *>("inspectorCreateVersion")->text(),
                 QString::fromUtf8("Tạo phiên bản mới"));
        window.set_language(true);
        QTimer::singleShot(0, &window, [&] {
            auto dialog = window.findChild<QDialog *>("projectRecordDialog");
            QVERIFY(dialog);
            const auto cancel = qScopeGuard([&] {
                if (dialog->isVisible())
                    dialog->reject();
            });
            dialog->findChild<QLineEdit *>("fieldVersion")->setText("0.3.0");
            dialog->findChild<QLineEdit *>("fieldSource revision")->setText("Synthetic next revision");
            dialog->findChild<QDialogButtonBox *>()->button(QDialogButtonBox::Save)->click();
        });
        window.findChild<QPushButton *>("inspectorCreateVersion")->click();
        QCOMPARE(window.document().releases.size(), std::size_t(2));
        QCOMPARE(window.document().releases.front(), before.releases.front());
        const auto next = window.document().releases.back();
        QVERIFY(next.id != before.releases.front().id);
        QCOMPARE(next.state, lmti::ReleaseState::Draft);
        QCOMPARE(next.component_id, before.releases.front().component_id);
        QCOMPARE(next.target_id, before.releases.front().target_id);
        QCOMPARE(releases->currentItem()->data(0, Qt::UserRole).toString(), QString::fromStdString(next.id));
        QVERIFY(window.findChild<QPushButton *>("inspectorEdit")->isEnabled());
        QCOMPARE(lmti::load_project(path), before);
        window.save_to(path);
        QCOMPARE(lmti::load_project(path).releases.back(), next);
        QCOMPARE(lmti::load_project(path).releases.front(), before.releases.front());
    }
    void library_availability_actions_and_view_switches_keep_current_references() {
        const auto previous_language = project_english;
        const auto restore_language = qScopeGuard([&] { project_english = previous_language; });
        project_english = true;
        QTemporaryDir temp;
        QVERIFY(QDir(temp.path()).mkdir("linked-folder"));
        FolderOpenProbe probe;
        QDesktopServices::setUrlHandler("file", &probe, "record");
        const auto restore_handler = qScopeGuard([] { QDesktopServices::unsetUrlHandler("file"); });
        const auto existing = temp.filePath("exists.sqlite");
        QFile file(existing);
        QVERIFY(file.open(QIODevice::WriteOnly));
        file.write("Synthetic presence fixture, not a verified project");
        file.close();
        const std::vector<lmti::LibraryEntry> entries{
            {"present", "Present", existing, temp.filePath("linked-folder")},
            {"missing", "Missing", temp.filePath("missing.sqlite"), temp.path()},
            {"folder-gone", "Folder gone", existing, temp.filePath("missing-folder")},
            {"unsupported", "Unsupported", temp.path(), temp.path()}};
        ProjectLibraryView view;
        QString opened, located;
        view.open_project = [&](const auto &entry) { opened = entry.id; };
        view.locate_project = [&](const auto &entry) { located = entry.id; };
        view.set_entries(entries);
        view.resize(1100, 800);
        view.show();
        auto mode = view.findChild<QComboBox *>("libraryViewMode");
        mode->setCurrentIndex(1);
        auto rows = view.findChild<QTreeWidget *>("libraryList");
        QMap<QString, QString> expected{{"present", "Available locally"},
                                        {"missing", "File missing"},
                                        {"folder-gone", "Folder missing"},
                                        {"unsupported", "File unavailable"}};
        for (int index = 0; index < rows->topLevelItemCount(); ++index) {
            const auto row = rows->topLevelItem(index);
            QCOMPARE(row->text(4), expected.value(row->data(0, Qt::UserRole).toString()));
        }
        view.findChild<QPushButton *>("open-present")->click();
        QCOMPARE(opened, "present");
        view.findChild<QPushButton *>("open-missing")->click();
        QCOMPARE(located, "missing");
        QCOMPARE(opened, "present");
        mode->setCurrentIndex(0);
        QTRY_VERIFY(view.findChild<QPushButton *>("open-missing")->isVisible());
        view.findChild<QPushButton *>("open-missing")->click();
        QCOMPARE(located, "missing");
        auto more = view.findChild<QToolButton *>("libraryMore-folder-gone");
        QVERIFY(more && more->menu());
        for (auto action : more->menu()->actions())
            QVERIFY(action->text() != "Open folder on this computer");
        mode->setCurrentIndex(1);
        QTRY_VERIFY(view.findChild<QPushButton *>("open-present")->isVisible());
        auto present = view.findChild<QToolButton *>("libraryMore-present");
        QAction *open_folder = nullptr;
        for (auto action : present->menu()->actions())
            if (action->text() == "Open folder on this computer")
                open_folder = action;
        QVERIFY(open_folder);
        open_folder->trigger();
        QCOMPARE(probe.count, 1);
        QVERIFY(QDir(temp.path()).rmdir("linked-folder"));
        // The menu is already built; invocation must recheck the current path.
        open_folder->trigger();
        QCOMPARE(probe.count, 1);
        bool missing_folder = false;
        for (int index = 0; index < rows->topLevelItemCount(); ++index)
            if (rows->topLevelItem(index)->data(0, Qt::UserRole).toString() == "present")
                missing_folder = rows->topLevelItem(index)->text(4) == "Folder missing";
        QVERIFY(missing_folder);
        QVERIFY(QFileInfo::exists(existing));
    }
    void release_evidence_shows_source_time_and_related_work_without_self_links() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        window.update_project([](auto &document) {
            lmti::VerificationRecord record;
            record.id = "synthetic-evidence";
            record.release_id = "sensor-v020";
            record.asset_id = "machine-a";
            record.evidence = "A long synthetic report reference; no device execution";
            record.source = "Synthetic operator note";
            record.at = QDateTime(QDate(2026, 10, 12), QTime(10, 0), QTimeZone::UTC).toSecsSinceEpoch();
            document.verification.push_back(record);
        });
        const auto before = window.document();
        window.resize(1440, 900);
        window.show_page(ProjectPage::Releases);
        window.findChild<QTabWidget *>("releaseTabs")->setCurrentIndex(1);
        window.show();
        auto rows = window.findChild<QTreeWidget *>("verificationTable");
        QCOMPARE(rows->columnCount(), 6);
        rows->setCurrentItem(rows->topLevelItem(0));
        QCoreApplication::processEvents();
        QCOMPARE(rows->currentItem()->text(3), QString::fromStdString(before.verification.front().evidence));
        QCOMPARE(rows->currentItem()->text(4), "Synthetic operator note");
        QCOMPARE(rows->currentItem()->text(5), "2026-10-12");
        QVERIFY(rows->currentItem()->toolTip(5).contains("T10:00:00Z"));
        QVERIFY(rows->header()->sectionViewportPosition(5) + rows->header()->sectionSize(5) <=
                rows->viewport()->width());
        auto facts = window.findChild<QTreeWidget *>("inspectorFacts");
        QCOMPARE(facts->topLevelItemCount(), 5);
        QCOMPARE(facts->topLevelItem(1)->text(1), "Synthetic operator note");
        QCOMPARE(facts->topLevelItem(2)->text(1), "2026-10-12T10:00:00Z");
        auto links = window.findChild<QTreeWidget *>("inspectorRelations");
        bool linked_work = false;
        for (int index = 0; index < links->topLevelItemCount(); ++index) {
            const auto item = links->topLevelItem(index);
            QVERIFY(item->data(0, Qt::UserRole).toString() != "synthetic-evidence");
            linked_work |= item->data(0, Qt::UserRole).toString() == "validate-sampling" &&
                           item->data(0, Qt::UserRole + 1).toString() == "work";
        }
        QVERIFY(linked_work);
        window.set_language(false);
        QCOMPARE(rows->currentItem()->text(4), "Synthetic operator note");
        QCOMPARE(rows->currentItem()->text(2), QString::fromUtf8("Người dùng ghi nhận"));
        QCOMPARE(window.document(), before);
    }
    void milestone_acceptance_requires_completed_work_evidence_and_explicit_save() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        const auto path = temp.filePath("project.sqlite");
        window.save_to(path);
        const auto saved = window.document();
        window.show_page(ProjectPage::Work);
        window.findChild<QTabWidget *>("workTabs")->setCurrentIndex(1);
        auto milestones = window.findChild<QTreeWidget *>("milestoneTable");
        milestones->setCurrentItem(milestones->topLevelItem(0));
        auto accept = [&] { return window.findChild<QPushButton *>("inspectorAcceptMilestone"); };
        QVERIFY(accept());
        QVERIFY(!accept()->isEnabled());
        QCOMPARE(milestones->currentItem()->text(2), "0 of 2 complete");
        QCOMPARE(milestones->currentItem()->text(4), "Missing");
        window.update_project(
            [](auto &document) { document.milestones.front().evidence = "Synthetic acceptance report"; });
        QVERIFY(!accept()->isEnabled());
        window.update_project([](auto &document) {
            for (auto &work : document.work) {
                work.state = lmti::WorkState::Done;
                work.evidence = "Synthetic work evidence";
            }
        });
        QVERIFY(accept()->isEnabled());
        QVERIFY(!window.document().milestones.front().accepted);
        QCOMPARE(milestones->currentItem()->text(2), "2 of 2 complete");
        auto links = window.findChild<QTreeWidget *>("inspectorRelations");
        QCOMPARE(links->topLevelItemCount(), 2);
        QCOMPARE(links->topLevelItem(0)->text(1), "Done");
        // A click is an undoable draft edit; it does not write storage.
        accept()->click();
        QVERIFY(window.document().milestones.front().accepted);
        QVERIFY(!accept()->isEnabled());
        QCOMPARE(lmti::load_project(path), saved);
        QVERIFY_THROWS_EXCEPTION(lmti::Error, window.update_project([](auto &document) {
            document.work.front().state = lmti::WorkState::Todo;
        }));
        window.findChild<QAction *>("undoProjectEdit")->trigger();
        QVERIFY(!window.document().milestones.front().accepted);
        QVERIFY(accept()->isEnabled());
        window.set_language(false);
        QCOMPARE(accept()->text(), QString::fromUtf8("Xác nhận nghiệm thu"));
        QCOMPARE(milestones->currentItem()->text(2), QString::fromUtf8("2 trên 2 hoàn tất"));
        QCOMPARE(window.document().milestones.front().evidence, "Synthetic acceptance report");
        window.set_language(true);
        accept()->click();
        window.save_to(path);
        QVERIFY(lmti::load_project(path).milestones.front().accepted);
        // Zero linked work is never enough, even when evidence is present.
        window.update_project([](auto &document) {
            document.milestones.front().accepted = false;
            document.work.clear();
        });
        QVERIFY(!accept()->isEnabled());
        QCOMPARE(milestones->currentItem()->text(2), "0 of 0 complete");
    }
    void work_release_and_graph_controls_are_reachable_in_both_languages() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        window.update_project(
            [](auto &document) { document.releases.front().state = lmti::ReleaseState::Approved; });
        const auto before = window.document();
        window.show();
        auto workspace = window.findChild<QScrollArea *>("workspaceScroll");
        auto check_workspace = [&](QWidget *control) {
            if (!control || !control->isVisible())
                return false;
            workspace->ensureWidgetVisible(control);
            QCoreApplication::processEvents();
            return workspace->viewport()->rect().contains(
                QRect(control->mapTo(workspace->viewport(), QPoint()), control->size()));
        };
        auto check_inspector = [&](const char *name) {
            auto inspector = window.findChild<QFrame *>("entityInspector");
            auto control = window.findChild<QWidget *>(name);
            const auto bounds =
                control ? QRect(control->mapTo(inspector, QPoint()), control->size()) : QRect{};
            const auto visible = control && control->isVisible() && inspector->rect().contains(bounds);
            if (!visible)
                qWarning() << name << "inspector visible" << inspector->isVisible() << "control visible"
                           << (control && control->isVisible()) << bounds << inspector->rect();
            return visible;
        };
        auto click_row = [](QTreeWidget *tree, QTreeWidgetItem *item) {
            tree->scrollToItem(item);
            QCoreApplication::processEvents();
            const auto bounds = tree->visualItemRect(item).intersected(tree->viewport()->rect());
            if (bounds.isEmpty())
                return false;
            QTest::mouseClick(tree->viewport(), Qt::LeftButton, Qt::NoModifier, bounds.center());
            return true;
        };
        for (const bool english : {true, false}) {
            window.set_language(english);
            for (const auto size : {QSize(1100, 800), QSize(1280, 720), QSize(1440, 900)}) {
                window.resize(size);
                window.show_page(ProjectPage::Work);
                window.findChild<QTabWidget *>("workTabs")->setCurrentIndex(0);
                auto mode = window.findChild<QComboBox *>("workViewMode");
                for (const int view : {0, 1}) {
                    mode->setCurrentIndex(view);
                    QVERIFY(check_workspace(window.findChild<QPushButton *>("addwork")));
                    QVERIFY(check_workspace(window.findChild<QFrame *>("workViewSegments")));
                    QVERIFY(check_workspace(window.findChild<QToolButton *>("workActions")));
                    QCOMPARE(mode->currentIndex(), view);
                    auto work_rows = window.findChild<QTreeWidget *>(view == 0 ? "workTable" : "work-todo");
                    auto work = work_rows->topLevelItem(0);
                    QVERIFY(work);
                    work_rows->setCurrentItem(work);
                    work_rows->scrollToItem(work);
                    QCoreApplication::processEvents();
                    QVERIFY(click_row(work_rows, work));
                    QVERIFY(check_inspector("inspectorEdit"));
                    window.findChild<QPushButton *>("closeInspector")->click();
                    QVERIFY(!window.findChild<QFrame *>("entityInspector")->isVisible());
                    QVERIFY(click_row(work_rows, work));
                    QVERIFY(check_inspector("inspectorEdit"));
                    QCOMPARE(window.document(), before);
                }
                window.findChild<QTabWidget *>("workTabs")->setCurrentIndex(1);
                auto milestones = window.findChild<QTreeWidget *>("milestoneTable");
                milestones->setCurrentItem(milestones->topLevelItem(0));
                QCoreApplication::processEvents();
                QVERIFY(click_row(milestones, milestones->currentItem()));
                QVERIFY(check_workspace(window.findChild<QPushButton *>("addmilestone")));
                QVERIFY(check_inspector("inspectorAcceptMilestone"));
                QVERIFY(!window.findChild<QPushButton *>("inspectorAcceptMilestone")->isEnabled());
                window.show_page(ProjectPage::Releases);
                window.findChild<QTabWidget *>("releaseTabs")->setCurrentIndex(0);
                auto releases = window.findChild<QTreeWidget *>("releaseTable");
                releases->setCurrentItem(releases->topLevelItem(0));
                QCoreApplication::processEvents();
                QVERIFY(click_row(releases, releases->currentItem()));
                QVERIFY(check_workspace(window.findChild<QPushButton *>("addrelease")));
                QVERIFY(check_inspector("inspectorCreateVersion"));
                QVERIFY(!window.findChild<QPushButton *>("inspectorEdit")->isEnabled());
                window.findChild<QTabWidget *>("releaseTabs")->setCurrentIndex(1);
                QVERIFY(check_workspace(window.findChild<QPushButton *>("addverification")));
                window.show_page(ProjectPage::Architecture);
                auto architecture = window.findChild<QTabWidget *>("architectureTabs");
                architecture->setCurrentIndex(0);
                auto topology = static_cast<Window *>(window.findChild<QMainWindow *>("topologyWindow"));
                auto toolbar = topology->findChild<QToolBar *>("architectureToolbar");
                for (const auto name : {"addAsset", "connectAssets", "fitCanvas", "panCanvas", "selectCanvas",
                                        "zoomInCanvas", "zoomOutCanvas"}) {
                    auto action = topology->findChild<QAction *>(name);
                    QVERIFY(action);
                    QVERIFY2(check_workspace(toolbar->widgetForAction(action)), name);
                }
                architecture->setCurrentIndex(1);
                for (const auto name : {"zoomInRelationships", "zoomOutRelationships", "fitRelationships"})
                    QVERIFY2(check_workspace(window.findChild<QPushButton *>(name)), name);
                QCOMPARE(window.document(), before);
            }
        }
    }
    void graph_directions_selection_controls_and_translated_edits_preserve_domain() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        window.show_page(ProjectPage::Architecture);
        window.show();
        QCoreApplication::processEvents();
        auto topology = static_cast<Window *>(window.findChild<QMainWindow *>("topologyWindow"));
        auto canvas = topology->findChild<QGraphicsView *>("topologyCanvas");
        auto check_edges = [](QGraphicsScene *scene, const QString &kind, const QString &from,
                              const QString &to) {
            int paths = 0, arrows = 0;
            for (auto item : scene->items()) {
                if (item->data(studio::edge_from_role).toString() != from ||
                    item->data(studio::edge_to_role).toString() != to)
                    continue;
                if (item->data(studio::edge_kind_role).toString() == kind)
                    paths += dynamic_cast<QGraphicsPathItem *>(item) != nullptr;
                if (item->data(studio::edge_kind_role).toString() == kind + "-arrow") {
                    ++arrows;
                    if (item->flags() & QGraphicsItem::ItemIsSelectable)
                        return false;
                }
            }
            return paths == 1 && arrows == 1;
        };
        for (const auto &edge : window.document().topology.links)
            QVERIFY(check_edges(canvas->scene(), "connection", QString::fromStdString(edge.from),
                                QString::fromStdString(edge.to)));
        const auto before = window.document();
        topology->findChild<QAction *>("panCanvas")->trigger();
        QCOMPARE(canvas->dragMode(), QGraphicsView::ScrollHandDrag);
        topology->findChild<QAction *>("selectCanvas")->trigger();
        QCOMPARE(canvas->dragMode(), QGraphicsView::RubberBandDrag);
        const auto scale = canvas->transform().m11();
        topology->findChild<QAction *>("zoomInCanvas")->trigger();
        QVERIFY(canvas->transform().m11() > scale);
        QCOMPARE(topology->findChild<QLabel *>("topologyZoom")->text(),
                 QString::number(qRound(canvas->transform().m11() * 100)) + "%");
        topology->findChild<QAction *>("fitCanvas")->trigger();
        QCOMPARE(window.document(), before);
        topology->select_asset("machine-a");
        window.set_language(false);
        auto kind = topology->findChild<QComboBox *>("assetKind");
        QCOMPARE(kind->currentData().toString(), "machine");
        QCOMPARE(kind->currentText(), QString::fromUtf8("Máy"));
        topology->findChild<QSpinBox *>("assetPoll")->setValue(2300);
        topology->findChild<QPushButton *>("applyAsset")->click();
        QCOMPARE(lmti::find_asset(window.document().topology, "machine-a").poll_ms, 2300);
        QCOMPARE(lmti::find_asset(window.document().topology, "machine-a").kind, lmti::Kind::Machine);
        window.findChild<QAction *>("undoProjectEdit")->trigger();
        QCOMPARE(window.document(), before);
        canvas->scene()->clearSelection();
        QVERIFY(!topology->findChild<QPushButton *>("applyAsset")->isEnabled());
        QVERIFY(topology->findChild<QLineEdit *>("assetLabel")->text().isEmpty());
        window.set_language(true);
        window.findChild<QTabWidget *>("architectureTabs")->setCurrentIndex(1);
        auto graph = window.findChild<QGraphicsView *>("softwareHardwareGraph");
        for (const auto &edge : window.document().dependencies)
            QVERIFY(check_edges(graph->scene(), "dependency", QString::fromStdString(edge.from),
                                QString::fromStdString(edge.to)));
        for (const auto &edge : window.document().bindings)
            QVERIFY(check_edges(graph->scene(), "binding", QString::fromStdString(edge.component_id),
                                QString::fromStdString(edge.asset_id)));
        for (auto item : graph->scene()->items())
            if (item->data(0).toString() == "sensor-firmware" && item->data(1).toString() == "component") {
                item->setSelected(true);
                break;
            }
        QCOMPARE(window.findChild<QLabel *>("inspectorTitle")->text(), "Sensor firmware");
        const auto graph_scale = graph->transform().m11();
        window.findChild<QPushButton *>("zoomInRelationships")->click();
        QVERIFY(graph->transform().m11() > graph_scale);
        window.findChild<QPushButton *>("fitRelationships")->click();
        QCOMPARE(window.document(), before);
        const auto wide_bounds = graph->scene()->itemsBoundingRect().width();
        window.resize(1100, 800);
        QCoreApplication::processEvents();
        QVERIFY(graph->scene()->itemsBoundingRect().width() < wide_bounds);
        QCOMPARE(graph->scene()->selectedItems().size(), 1);
        QCOMPARE(graph->scene()->selectedItems().front()->data(0).toString(), "sensor-firmware");
        for (const auto &edge : window.document().bindings)
            QVERIFY(check_edges(graph->scene(), "binding", QString::fromStdString(edge.component_id),
                                QString::fromStdString(edge.asset_id)));
        QCOMPARE(window.document(), before);
    }
    void knowledge_search_keeps_scope_selection_and_review_gates() {
        const auto node = QStandardPaths::findExecutable("node");
        const auto cli = qEnvironmentVariable("LMTI_STUDIO_TEST_CLI");
        if (node.isEmpty() || !QFileInfo::exists(cli))
            QSKIP("Knowledge search checks require the trusted local owner runtime.");
        const auto old_node = qgetenv("LMTI_STUDIO_NODE_BINARY");
        const auto old_cli = qgetenv("LMTI_STUDIO_CLI");
        const auto old_review = qgetenv("LMTI_STUDIO_ALLOW_LESSON_REVIEW");
        const auto restore = qScopeGuard([&] {
            qputenv("LMTI_STUDIO_NODE_BINARY", old_node);
            qputenv("LMTI_STUDIO_CLI", old_cli);
            qputenv("LMTI_STUDIO_ALLOW_LESSON_REVIEW", old_review);
        });
        qputenv("LMTI_STUDIO_NODE_BINARY", node.toUtf8());
        qputenv("LMTI_STUDIO_CLI", cli.toUtf8());
        qputenv("LMTI_STUDIO_ALLOW_LESSON_REVIEW", "1");
        QTemporaryDir source, native;
        ProjectWindow window(nullptr, native.filePath("catalog.sqlite"));
        window.load_demo();
        const auto before = window.document();
        QVERIFY(create_design_knowledge_fixture(source.path(), QString::fromStdString(before.project.id)));
        window.show_page(ProjectPage::Knowledge);
        window.show();
        auto tabs = window.findChild<QTabWidget *>("knowledgeTabs");
        auto panel = static_cast<KnowledgePanel *>(window.findChild<QWidget *>("knowledgeConnection"));
        auto reload = window.findChild<QPushButton *>("reloadKnowledge");
        panel->connect_source(source.path());
        QTRY_VERIFY_WITH_TIMEOUT(reload->isEnabled(), 10000);
        auto visible_count = [](QTreeWidget *tree) {
            int count = 0;
            for (int index = 0; index < tree->topLevelItemCount(); ++index)
                count += !tree->topLevelItem(index)->isHidden();
            return count;
        };
        for (const bool english : {true, false}) {
            window.set_language(english);
            for (const auto size : {QSize(1100, 800), QSize(1280, 720), QSize(1440, 900)}) {
                window.resize(size);
                for (const auto &name :
                     {QString("knowledgeMap"), QString("knowledgeMemory"), QString("knowledgeLessons")}) {
                    tabs->setCurrentIndex(name == "knowledgeMap" ? 1 : name == "knowledgeMemory" ? 2 : 3);
                    auto tree = window.findChild<QTreeWidget *>(name);
                    auto search = window.findChild<QLineEdit *>(name + "Search");
                    auto count = window.findChild<QLabel *>(name + "Count");
                    auto empty = tree->findChild<QLabel *>("tableEmptyState");
                    QVERIFY(search && count && empty);
                    QCoreApplication::processEvents();
                    QVERIFY(search->isVisible() && search->width() >= 260);
                    QVERIFY(tree->viewport()->width() >= 260);
                    const auto row = tree->topLevelItem(0);
                    QVERIFY(row);
                    const auto record = row->data(0, Qt::UserRole).toJsonObject();
                    search->setText(record.value("title").toString().toUpper());
                    QVERIFY(!row->isHidden());
                    tree->setCurrentItem(row);
                    QCOMPARE(tree->currentItem()->data(0, Qt::UserRole).toJsonObject(), record);
                    const auto confirm = window.findChild<QCheckBox *>("lessonEvidenceReviewed");
                    if (name == "knowledgeLessons") {
                        QVERIFY(confirm->height() >= confirm->heightForWidth(confirm->width()));
                        confirm->setFocus();
                        QTest::keyClick(confirm, Qt::Key_Space);
                        QVERIFY(window.findChild<QPushButton *>("approveLesson")->isEnabled());
                    }
                    search->setText("No synthetic record matches this query");
                    QCOMPARE(visible_count(tree), 0);
                    QVERIFY(!tree->currentItem());
                    QVERIFY(empty->isVisible());
                    QVERIFY(count->text().contains('0'));
                    if (name == "knowledgeLessons") {
                        QVERIFY(!confirm->isChecked());
                        QVERIFY(!window.findChild<QPushButton *>("approveLesson")->isEnabled());
                        window.findChild<QPushButton *>("approveLesson")->click();
                        QCOMPARE(row->data(0, Qt::UserRole).toJsonObject(), record);
                    }
                    search->clear();
                    QCOMPARE(visible_count(tree), tree->topLevelItemCount());
                    QVERIFY(!empty->isVisible());
                    for (auto process : panel->findChildren<QProcess *>())
                        QCOMPARE(process->state(), QProcess::NotRunning);
                    QCOMPARE(window.document(), before);
                }
            }
        }
        // Filters survive a reload of the same source and cannot alter the
        // checked context's task/project/source scope.
        auto search = window.findChild<QLineEdit *>("knowledgeMapSearch");
        search->setText("Sampling");
        reload->click();
        QTRY_VERIFY_WITH_TIMEOUT(reload->isEnabled(), 10000);
        QCOMPARE(search->text(), "Sampling");
        QCOMPARE(visible_count(window.findChild<QTreeWidget *>("knowledgeMap")), 1);
        tabs->setCurrentIndex(4);
        window.findChild<QLineEdit *>("knowledgeTask")->setText("Review sampling validation");
        window.findChild<QPushButton *>("prepareKnowledgeContext")->click();
        QTRY_VERIFY_WITH_TIMEOUT(window.findChild<QPushButton *>("copyKnowledgeContext")->isEnabled(), 10000);
        const auto context = window.findChild<QPlainTextEdit *>("knowledgeContextPreview")->toPlainText();
        search->setText("No matching module");
        QCOMPARE(window.findChild<QPlainTextEdit *>("knowledgeContextPreview")->toPlainText(), context);
        QVERIFY(window.findChild<QPushButton *>("copyKnowledgeContext")->isEnabled());
        window.new_project("Another synthetic project");
        QVERIFY(search->text().isEmpty());
        QVERIFY(!window.findChild<QPushButton *>("copyKnowledgeContext")->isEnabled());
    }
    void inline_lesson_review_requires_grant_confirmation_and_owner_validation() {
        const auto node = QStandardPaths::findExecutable("node");
        const auto cli = qEnvironmentVariable("LMTI_STUDIO_TEST_CLI");
        if (node.isEmpty() || !QFileInfo::exists(cli))
            QSKIP("Build TS CLI and configure the local owner runtime for this integration test.");
        const auto old_node = qgetenv("LMTI_STUDIO_NODE_BINARY");
        const auto old_cli = qgetenv("LMTI_STUDIO_CLI");
        const auto old_review = qgetenv("LMTI_STUDIO_ALLOW_LESSON_REVIEW");
        const auto restore = qScopeGuard([&] {
            qputenv("LMTI_STUDIO_NODE_BINARY", old_node);
            qputenv("LMTI_STUDIO_CLI", old_cli);
            qputenv("LMTI_STUDIO_ALLOW_LESSON_REVIEW", old_review);
        });
        qputenv("LMTI_STUDIO_NODE_BINARY", node.toUtf8());
        qputenv("LMTI_STUDIO_CLI", cli.toUtf8());
        qputenv("LMTI_STUDIO_ALLOW_LESSON_REVIEW", "0");
        QTemporaryDir source, native;
        ProjectWindow window(nullptr, native.filePath("catalog.sqlite"));
        window.new_project("Synthetic lesson review");
        const auto before = window.document();
        QVERIFY(create_design_knowledge_fixture(source.path(), QString::fromStdString(before.project.id)));
        QVERIFY(!create_design_knowledge_fixture(source.path(), QString::fromStdString(before.project.id)));
        window.show_page(ProjectPage::Knowledge);
        window.findChild<QTabWidget *>("knowledgeTabs")->setCurrentIndex(3);
        window.show();
        auto panel = static_cast<KnowledgePanel *>(window.findChild<QWidget *>("knowledgeConnection"));
        auto rows = window.findChild<QTreeWidget *>("knowledgeLessons");
        auto reload = window.findChild<QPushButton *>("reloadKnowledge");
        auto confirm = window.findChild<QCheckBox *>("lessonEvidenceReviewed");
        auto approve = window.findChild<QPushButton *>("approveLesson");
        auto reject = window.findChild<QPushButton *>("rejectLesson");
        panel->connect_source(source.path());
        QTRY_VERIFY_WITH_TIMEOUT(reload->isEnabled(), 10000);
        QCOMPARE(rows->topLevelItemCount(), 1);
        rows->setCurrentItem(rows->topLevelItem(0));
        const auto pending = rows->currentItem()->data(0, Qt::UserRole).toJsonObject();
        QCOMPARE(pending.value("status").toString(), "pending");
        window.set_language(false);
        QCOMPARE(window.findChild<QPushButton *>("connectKnowledge")->text(),
                 QString::fromUtf8("Kết nối nguồn…"));
        QCOMPARE(reload->text(), QString::fromUtf8("Đọc lại nguồn"));
        QCOMPARE(window.findChild<QPushButton *>("cancelKnowledge")->text(), QString::fromUtf8("Hủy"));
        QCOMPARE(window.findChild<QTabWidget *>("knowledgeTabs")->tabText(4),
                 QString::fromUtf8("Ngữ cảnh công việc"));
        window.set_language(true);
        QVERIFY(!confirm->isEnabled());
        QVERIFY(!approve->isEnabled());
        approve->click();
        QCOMPARE(rows->currentItem()->data(0, Qt::UserRole).toJsonObject(), pending);

        // A new explicitly granted session must still pass confirmation and the
        // real owning writer's privacy/evidence/fingerprint checks.
        qputenv("LMTI_STUDIO_ALLOW_LESSON_REVIEW", "1");
        reload->click();
        QTRY_VERIFY_WITH_TIMEOUT(reload->isEnabled(), 10000);
        rows->setCurrentItem(rows->topLevelItem(0));
        QVERIFY(confirm->isEnabled());
        QVERIFY(!approve->isEnabled());
        QVERIFY(!reject->isEnabled());
        QVERIFY(rows->currentItem()->data(0, Qt::UserRole).toJsonObject().value("canApprove").toBool());
        confirm->setChecked(true);
        QVERIFY(approve->isEnabled());
        QVERIFY(reject->isEnabled());
        QTest::mouseClick(approve, Qt::LeftButton);
        QTRY_VERIFY_WITH_TIMEOUT(reload->isEnabled(), 10000);
        QCOMPARE(rows->topLevelItemCount(), 1);
        QCOMPARE(rows->topLevelItem(0)->data(0, Qt::UserRole).toJsonObject().value("status").toString(),
                 "approved");
        rows->setCurrentItem(rows->topLevelItem(0));
        QVERIFY(!approve->isEnabled());
        QVERIFY(!reject->isEnabled());
        bool reusable = false;
        auto memories = window.findChild<QTreeWidget *>("knowledgeMemory");
        for (int i = 0; i < memories->topLevelItemCount(); ++i)
            reusable |=
                memories->topLevelItem(i)->data(0, Qt::UserRole).toJsonObject().value("zone") == "lesson";
        QVERIFY(reusable);
        QCOMPARE(window.document(), before);
    }
    void inventory_filters_keep_ids_language_history_and_board_in_sync() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        window.update_project([](auto &document) {
            document.components[1].label = "Software"; // A user name must never become a UI translation.
            auto device = document.topology.assets[1];
            device.id = "other-gateway";
            device.label = "Other site gateway";
            device.site = "other-site";
            document.topology.assets.push_back(device);
            auto version = document.releases.front();
            version.id = "backend-v010";
            version.label = "0.1.0";
            version.component_id = "monitor-backend";
            version.target_id.clear();
            version.state = lmti::ReleaseState::Draft;
            document.releases.push_back(version);
            document.verification = {
                {"sensor-check", "sensor-v020", "machine-a", "Synthetic pass", "Synthetic review", 1791763200,
                 lmti::EvidenceResult::Passed, lmti::Privacy::Public},
                {"backend-check", "backend-v010", "", "Synthetic failure", "Synthetic review", 1791763200,
                 lmti::EvidenceResult::Failed, lmti::Privacy::Public}};
            auto task = document.work.front();
            task.id = "review-task";
            task.label = "Review synthetic architecture";
            task.kind = lmti::WorkKind::Task;
            task.state = lmti::WorkState::Review;
            document.work.push_back(task);
        });
        const auto path = temp.filePath("project.sqlite");
        window.save_to(path);
        const auto before = window.document();
        window.show();
        auto visible = [](QTreeWidget *tree) {
            QStringList ids;
            for (int i = 0; i < tree->topLevelItemCount(); ++i)
                if (!tree->topLevelItem(i)->isHidden())
                    ids << tree->topLevelItem(i)->data(0, Qt::UserRole).toString();
            ids.sort();
            return ids;
        };
        auto select = [&window](const char *name, const QString &value) {
            auto choice = window.findChild<QComboBox *>(name);
            if (!choice || choice->findData(value) < 0)
                return false;
            choice->setCurrentIndex(choice->findData(value));
            return true;
        };
        window.show_page(ProjectPage::Software);
        auto components = window.findChild<QTreeWidget *>("componentTable");
        QVERIFY(select("component_kindChoice", "gateway"));
        QCOMPARE(visible(components), QStringList{"gateway-agent"});
        for (int i = 0; i < components->topLevelItemCount(); ++i)
            if (!components->topLevelItem(i)->isHidden())
                components->setCurrentItem(components->topLevelItem(i));
        auto relations = window.findChild<QTreeWidget *>("inspectorRelations");
        QTreeWidgetItem *sensor = nullptr;
        for (int i = 0; i < relations->topLevelItemCount(); ++i)
            if (relations->topLevelItem(i)->data(0, Qt::UserRole).toString() == "sensor-firmware")
                sensor = relations->topLevelItem(i);
        QVERIFY(sensor);
        relations->setCurrentItem(sensor);
        QTest::mouseClick(window.findChild<QPushButton *>("openRelatedRecord"), Qt::LeftButton);
        QCOMPARE(window.findChild<QComboBox *>("component_kindChoice")->currentData().toString(), "");
        QTest::mouseClick(window.findChild<QPushButton *>("inspectorBack"), Qt::LeftButton);
        QCOMPARE(visible(components), QStringList{"gateway-agent"});
        QCOMPARE(components->currentItem()->data(0, Qt::UserRole).toString(), "gateway-agent");
        window.set_language(false);
        QCOMPARE(window.findChild<QComboBox *>("component_kindChoice")->currentData().toString(), "gateway");
        QCOMPARE(window.findChild<QComboBox *>("component_kindChoice")->itemText(0),
                 QString::fromUtf8("Tất cả loại"));
        QCOMPARE(components->currentItem()->text(0), "Software");
        QVERIFY(select("component_kindChoice", "firmware"));
        QCOMPARE(visible(components), QStringList{"sensor-firmware"});

        window.show_page(ProjectPage::Hardware);
        window.findChild<QTabWidget *>("hardwareTabs")->setCurrentIndex(0);
        auto devices = window.findChild<QTreeWidget *>("hardwareDevices");
        QVERIFY(select("device_kindChoice", "gateway"));
        QVERIFY(select("device_siteChoice", "other-site"));
        QCOMPARE(visible(devices), QStringList{"other-gateway"});
        window.set_language(true);
        QCOMPARE(window.findChild<QComboBox *>("device_siteChoice")->currentData().toString(), "other-site");
        QCOMPARE(visible(devices), QStringList{"other-gateway"});

        window.findChild<QPushButton *>("closeInspector")->click();
        window.show_page(ProjectPage::Work);
        auto list = window.findChild<QTreeWidget *>("workTable");
        QVERIFY(select("work_stateChoice", "review"));
        QVERIFY(select("work_kindChoice", "task"));
        QCOMPARE(visible(list), QStringList{"review-task"});
        QTest::mouseClick(window.findChild<QPushButton *>("workViewSegments1"), Qt::LeftButton);
        QCOMPARE(visible(window.findChild<QTreeWidget *>("work-review")), QStringList{"review-task"});
        QCOMPARE(visible(window.findChild<QTreeWidget *>("work-todo")), QStringList{});
        QVERIFY(select("work_stateChoice", "todo"));
        QCOMPARE(visible(list), QStringList{});
        QCOMPARE(visible(window.findChild<QTreeWidget *>("work-review")), QStringList{});
        QVERIFY(!window.findChild<QPushButton *>("editwork")->isEnabled());
        QVERIFY(select("work_stateChoice", "review"));
        QVERIFY(select("work_kindChoice", ""));
        window.findChild<QLineEdit *>("workFilter")->setText("architecture");
        QCOMPARE(visible(list), QStringList{"review-task"});

        window.show_page(ProjectPage::Releases);
        QVERIFY(select("release_componentChoice", "monitor-backend"));
        QVERIFY(select("release_stateChoice", "draft"));
        QCOMPARE(visible(window.findChild<QTreeWidget *>("releaseTable")), QStringList{"backend-v010"});
        QVERIFY(select("release_componentChoice", "sensor-firmware"));
        QCOMPARE(visible(window.findChild<QTreeWidget *>("releaseTable")), QStringList{});
        window.findChild<QTabWidget *>("releaseTabs")->setCurrentIndex(1);
        QVERIFY(select("verification_releaseChoice", "backend-v010"));
        QVERIFY(select("verification_resultChoice", "failed"));
        QCOMPARE(visible(window.findChild<QTreeWidget *>("verificationTable")), QStringList{"backend-check"});
        QVERIFY(select("verification_resultChoice", "passed"));
        QCOMPARE(visible(window.findChild<QTreeWidget *>("verificationTable")), QStringList{});
        QCOMPARE(window.document(), before);
        QCOMPARE(lmti::load_project(path), before);
    }
    void selected_sidebar_navigation_stays_visible_after_resize_and_keyboard_changes() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        const auto before = window.document();
        window.show();
        auto scroll = window.findChild<QScrollArea *>("sidebarScroll");
        auto project = window.findChild<QListWidget *>("projectNavigation");
        auto knowledge = window.findChild<QListWidget *>("knowledgeNavigation");
        auto visible = [&](QListWidget *list) {
            const auto item = list->currentItem();
            if (!item || !list->isVisible())
                return false;
            const auto rect = list->visualItemRect(item);
            const auto bounds =
                QRect(list->viewport()->mapTo(scroll->viewport(), rect.topLeft()), rect.size());
            return scroll->viewport()->rect().contains(bounds);
        };
        for (const bool english : {true, false}) {
            window.set_language(english);
            for (const auto size : {QSize(1100, 800), QSize(1280, 720), QSize(1440, 900)}) {
                window.resize(size);
                for (const auto page : {ProjectPage::Overview, ProjectPage::Software, ProjectPage::Hardware,
                                        ProjectPage::Architecture, ProjectPage::Work, ProjectPage::Releases,
                                        ProjectPage::Knowledge, ProjectPage::Agent}) {
                    window.show_page(page);
                    auto list =
                        page == ProjectPage::Knowledge || page == ProjectPage::Agent ? knowledge : project;
                    QTRY_VERIFY(visible(list));
                    QCOMPARE(list->currentItem()->data(Qt::UserRole).toInt(), static_cast<int>(page));
                    QCOMPARE(window.document(), before);
                }
                knowledge->setFocus();
                QTest::keyClick(knowledge, Qt::Key_Up);
                QTRY_VERIFY(visible(knowledge));
                QCOMPARE(window.findChild<QTabWidget *>("projectTabs")->currentIndex(),
                         static_cast<int>(ProjectPage::Knowledge));
                window.show_library();
                auto library = window.findChild<QPushButton *>("showProjectLibrary");
                QTRY_VERIFY(scroll->viewport()->rect().contains(
                    QRect(library->mapTo(scroll->viewport(), QPoint()), library->size())));
                window.show_page(ProjectPage::Overview);
                QTRY_VERIFY(visible(project));
                QCOMPARE(window.document(), before);
            }
        }
    }
    void simple_navigation_and_disclosures_preserve_project_state() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        window.resize(1280, 800);
        window.show();
        const auto before = window.document();
        auto navigation = window.findChild<QListWidget *>("projectNavigation");
        auto visible_rows = [&] {
            int count = 0;
            for (int i = 0; i < navigation->count(); ++i)
                count += !navigation->item(i)->isHidden();
            return count;
        };
        QCOMPARE(visible_rows(), 3);
        auto more = window.findChild<QPushButton *>("moreProjectTools");
        more->click();
        QCOMPARE(visible_rows(), 8);
        more->click();
        QCOMPARE(visible_rows(), 3);
        window.show_page(ProjectPage::Software);
        QCOMPARE(visible_rows(), 4);
        QVERIFY(!navigation->currentItem()->isHidden());
        auto filters = window.findChild<QWidget *>("componentFilterOptions");
        QVERIFY(filters->isHidden());
        window.findChild<QPushButton *>("componentShowFilters")->click();
        QVERIFY(filters->isVisible());
        window.set_language(false);
        QCOMPARE(more->text(), QString::fromUtf8("Công cụ khác"));
        QVERIFY(filters->isVisible());
        window.show_page(ProjectPage::Overview);
        QVERIFY(window.findChild<QWidget *>("projectSummaryDetails")->isHidden());
        window.findChild<QPushButton *>("showProjectSummaryDetails")->click();
        QVERIFY(window.findChild<QWidget *>("projectSummaryDetails")->isVisible());
        window.findChild<QPushButton *>("openTaskContext")->click();
        auto knowledge = window.findChild<QTabWidget *>("knowledgeTabs");
        QCOMPARE(knowledge->currentIndex(), 4);
        QVERIFY(window.findChild<QPushButton *>("connectKnowledge")->isVisible());
        knowledge->setCurrentIndex(5);
        QVERIFY(!window.findChild<QPushButton *>("connectKnowledge")->isVisible());
        knowledge->setCurrentIndex(1);
        QVERIFY(window.findChild<QPushButton *>("connectKnowledge")->isVisible());
        QCOMPARE(window.document(), before);
    }
    void compact_toolbar_and_recent_navigation_keep_controls_visible() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        window.save_to(temp.filePath("project.sqlite"));
        window.show();
        QCoreApplication::processEvents();
        auto toolbar = window.findChild<QToolBar *>("projectToolbar");
        auto save = toolbar->widgetForAction(window.findChild<QAction *>("saveProjectFile"));
        QVERIFY(save && save->isVisible());
        QVERIFY2(
            save->height() >= save->sizeHint().height(),
            qPrintable(
                QString("Save height %1 < size hint %2").arg(save->height()).arg(save->sizeHint().height())));
        auto breadcrumb = window.findChild<QLabel *>("projectBreadcrumb");
        QVERIFY(breadcrumb->height() >= breadcrumb->fontMetrics().height());
        window.show_page(ProjectPage::Work);
        auto mode = window.findChild<QComboBox *>("workViewMode");
        QVERIFY(!mode->isVisible());
        QTest::mouseClick(window.findChild<QPushButton *>("workViewSegments1"), Qt::LeftButton);
        QCOMPARE(mode->currentIndex(), 1);
        window.resize(1100, 800);
        QCoreApplication::processEvents();
        QCOMPARE(mode->currentIndex(), 1);
        window.resize(1440, 900);
        QTest::mouseClick(window.findChild<QPushButton *>("workViewSegments0"), Qt::LeftButton);
        QCOMPARE(mode->currentIndex(), 0);
        auto work_rows = window.findChild<QTreeWidget *>("workTable");
        work_rows->setCurrentItem(work_rows->topLevelItem(0));
        auto workspace = window.findChild<QScrollArea *>("workspaceScroll");
        auto more = window.findChild<QToolButton *>("workActions");
        for (const auto english : {true, false}) {
            window.set_language(english);
            for (const auto size : {QSize(1100, 800), QSize(1280, 720), QSize(1440, 900)}) {
                window.resize(size);
                QCoreApplication::processEvents();
                for (QWidget *control :
                     {static_cast<QWidget *>(more),
                      static_cast<QWidget *>(window.findChild<QPushButton *>("addwork")),
                      static_cast<QWidget *>(window.findChild<QFrame *>("workViewSegments"))}) {
                    const auto bounds =
                        QRect(control->mapTo(workspace->viewport(), QPoint()), control->size());
                    QVERIFY2(workspace->viewport()->rect().contains(bounds),
                             qPrintable(control->objectName()));
                }
                QTimer::singleShot(0, &window, [&] {
                    auto menu = window.findChild<QMenu *>("workActionsMenu");
                    QVERIFY(menu);
                    const auto close = qScopeGuard([&] { menu->close(); });
                    QVERIFY(menu->isVisible());
                    QVERIFY(menu->actions().front()->isEnabled());
                    QVERIFY(menu->actions().back()->isEnabled());
                });
                more->setFocus();
                QTest::keyClick(more, Qt::Key_Space);
            }
        }
        window.set_language(true);
        window.show_library();
        auto recent = window.findChild<QListWidget *>("recentProjectNavigation");
        QVERIFY(recent->isVisible());
        QVERIFY(recent->mapTo(&window, QPoint(0, 0)).y() < 350);
        auto library_cards = window.findChild<QPushButton *>("libraryViewSegments0");
        // The newly shown responsive toolbar receives its layout on the next
        // event turn. A zero-height segment has no clickable center yet.
        QTRY_VERIFY(library_cards->isVisible() &&
                    library_cards->height() >= library_cards->sizeHint().height() &&
                    library_cards->parentWidget()->rect().contains(library_cards->geometry()));
        QVERIFY(
            window.rect().contains(QRect(library_cards->mapTo(&window, QPoint()), library_cards->size())));
        QSignalSpy library_card_clicks(library_cards, &QPushButton::clicked);
        QTest::mouseClick(library_cards, Qt::LeftButton);
        QCOMPARE(library_card_clicks.count(), 1);
        QCOMPARE(window.findChild<QComboBox *>("libraryViewMode")->currentIndex(), 0);
        QTest::mouseClick(window.findChild<QPushButton *>("libraryViewSegments1"), Qt::LeftButton);
        QCOMPARE(window.findChild<QComboBox *>("libraryViewMode")->currentIndex(), 1);
    }
    void agent_public_preview_and_setup_are_scoped() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        window.update_project([](auto &document) {
            auto internal = document.components.front();
            internal.id = "internal-component";
            internal.label = "Internal synthetic component";
            internal.privacy = lmti::Privacy::Internal;
            document.components.push_back(internal);
            auto other_site = document.topology.assets.front();
            other_site.id = "other-site-device";
            other_site.label = "Other site synthetic device";
            other_site.site = "other-site";
            document.topology.assets.push_back(other_site);
        });
        window.show_page(ProjectPage::Agent);
        window.show();
        const auto before = window.document();
        auto site = window.findChild<QComboBox *>("projectAgentSite");
        site->setCurrentIndex(site->findText("factory-demo"));
        auto records = window.findChild<QTreeWidget *>("agentAllowedRecords");
        QVERIFY(records->topLevelItemCount() > 0);
        for (int i = 0; i < records->topLevelItemCount(); ++i) {
            const auto label = records->topLevelItem(i)->text(1);
            QVERIFY(label != "Internal synthetic component");
            QVERIFY(label != "Other site synthetic device");
        }
        auto search = window.findChild<QLineEdit *>("agentRecordSearch");
        search->setText("sensor");
        int visible = 0;
        for (int i = 0; i < records->topLevelItemCount(); ++i)
            if (!records->topLevelItem(i)->isHidden())
                ++visible;
        QVERIFY(visible > 0);
        QVERIFY(visible < records->topLevelItemCount());
        const auto json = window.findChild<QPlainTextEdit *>("projectAgentContext")->toPlainText();
        QVERIFY(!json.contains("Internal synthetic component"));
        QVERIFY(!json.contains("Other site synthetic device"));
        search->setText("No allowed record matches this query");
        auto empty = records->findChild<QLabel *>("tableEmptyState");
        QVERIFY(empty && empty->isVisible());
        for (int index = 0; index < records->topLevelItemCount(); ++index)
            QVERIFY(records->topLevelItem(index)->isHidden());
        QCOMPARE(window.document(), before);
        search->clear();
        QVERIFY(!empty->isVisible());
        window.update_project([](auto &document) { document.project.privacy = lmti::Privacy::Internal; });
        QVERIFY(records->property("contextUnavailable").toBool());
        QVERIFY(empty->isVisible());
        QVERIFY(empty->text().contains("unavailable"));
        window.update_project([&](auto &document) { document = before; });
        QVERIFY(!empty->isVisible());
        window.findChild<QTabWidget *>("agentTabs")->setCurrentIndex(2);
        for (const auto english : {true, false}) {
            window.set_language(english);
            for (const auto size : {QSize(1100, 800), QSize(1280, 720), QSize(1440, 900)}) {
                window.resize(size);
                auto workspace = window.findChild<QScrollArea *>("workspaceScroll");
                workspace->verticalScrollBar()->setValue(0);
                QCoreApplication::processEvents();
                for (const auto name : {"agentBoundaryTable", "agentCapabilitiesTable"}) {
                    auto table = window.findChild<QTreeWidget *>(name);
                    QCOMPARE(table->verticalScrollBar()->maximum(), 0);
                    const auto last = table->visualItemRect(table->topLevelItem(2));
                    QVERIFY(last.bottom() < table->viewport()->height());
                    QCOMPARE(table->topLevelItem(0)->toolTip(1),
                             table->topLevelItem(0)->text(1).toHtmlEscaped());
                }
                auto status = window.findChild<QLabel *>("agentConnectionStatus");
                QVERIFY(status);
                if (size != QSize(1440, 900))
                    workspace->ensureWidgetVisible(status);
                QCoreApplication::processEvents();
                const auto bounds = QRect(status->mapTo(workspace->viewport(), QPoint()), status->size());
                QVERIFY(workspace->viewport()->rect().contains(bounds));
                QCOMPARE(window.document(), before);
            }
        }
        window.set_language(false);
        QCOMPARE(window.findChild<QTreeWidget *>("agentCapabilitiesTable")->topLevelItem(0)->text(0),
                 QString::fromUtf8("Đọc thông tin công khai đã lưu"));
        QTimer::singleShot(0, &window, [&] {
            auto dialog = window.findChild<QDialog *>("agentSetupInstructionsDialog");
            QVERIFY(dialog);
            QVERIFY(dialog->findChild<QPlainTextEdit *>("agentSetupSteps")->isReadOnly());
            dialog->reject();
        });
        QTest::mouseClick(window.findChild<QPushButton *>("agentSetupInstructions"), Qt::LeftButton);
        QCOMPARE(window.document(), before);
        window.set_language(true);
    }
    void context_review_and_settings_controls_fit_and_preserve_drafts() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        window.save_to(temp.filePath("project.sqlite"));
        window.show();
        const auto before = window.document();
        auto workspace = window.findChild<QScrollArea *>("workspaceScroll");
        auto reachable = [&](const char *name) {
            auto widget = window.findChild<QWidget *>(name);
            if (QString::fromLatin1(name) == "reviewProposalButton")
                widget = window.findChild<QWidget *>("agentReviewPage")->findChild<QWidget *>(name);
            QVERIFY2(widget && widget->isVisible(), name);
            workspace->ensureWidgetVisible(widget);
            QCoreApplication::processEvents();
            QVERIFY(workspace->viewport()->rect().contains(
                QRect(widget->mapTo(workspace->viewport(), QPoint()), widget->size())));
            QVERIFY(!widget->accessibleName().isEmpty() ||
                    (qobject_cast<QAbstractButton *>(widget) &&
                     !qobject_cast<QAbstractButton *>(widget)->text().isEmpty()) ||
                    qobject_cast<QLineEdit *>(widget));
        };
        for (const bool english : {true, false}) {
            window.set_language(english);
            QCOMPARE(project_caption("Project information"),
                     english ? QString("Project information") : QString::fromUtf8("Thông tin dự án"));
            for (const auto size : {QSize(1100, 800), QSize(1280, 720), QSize(1440, 900)}) {
                window.resize(size);
                window.show_page(ProjectPage::Knowledge);
                window.findChild<QTabWidget *>("knowledgeTabs")->setCurrentIndex(4);
                QCoreApplication::processEvents();
                for (const auto name : {"knowledgeTask", "prepareKnowledgeContext", "copyKnowledgeContext",
                                        "exportKnowledgeContext"})
                    reachable(name);
                QVERIFY(!window.findChild<QPushButton *>("prepareKnowledgeContext")->isEnabled());
                QVERIFY(!window.findChild<QPushButton *>("exportKnowledgeContext")->isEnabled());
                window.show_page(ProjectPage::Agent);
                auto tabs = window.findChild<QTabWidget *>("agentTabs");
                tabs->setCurrentIndex(0);
                QCoreApplication::processEvents();
                reachable("agentRecordSearch");
                reachable("agentTechnicalDetails");
                window.review_proposal({"factory-monitor", "validate-sampling", 1, lmti::WorkState::Todo,
                                        lmti::WorkState::Review});
                QCoreApplication::processEvents();
                for (const auto name : {"reviewProposalButton", "applyWorkProposal", "cancelWorkProposal"})
                    reachable(name);
                QVERIFY(window.findChild<QPushButton *>("applyWorkProposal")->isEnabled());
                window.findChild<QPushButton *>("cancelWorkProposal")->click();
                window.show_page(ProjectPage::Settings);
                auto settings_tabs = window.findChild<QTabWidget *>("projectSettingsTabs");
                settings_tabs->setCurrentIndex(0);
                QCoreApplication::processEvents();
                reachable("settingsName");
                auto name = window.findChild<QLineEdit *>("settingsName");
                name->setText("Retained synthetic settings draft");
                for (const auto control : {"applyProjectSettings", "cancelProjectSettings"})
                    reachable(control);
                settings_tabs->setCurrentIndex(1);
                QCoreApplication::processEvents();
                reachable("settingsChooseFolder");
                QCOMPARE(name->text(), "Retained synthetic settings draft");
                window.findChild<QPushButton *>("cancelProjectSettings")->click();
                QCOMPARE(name->text(), QString::fromStdString(before.project.label));
                QCOMPARE(window.document(), before);
                QCOMPARE(lmti::load_project(temp.filePath("project.sqlite")), before);
            }
        }
        window.set_language(true);
    }
    void settings_drafts_and_proposal_preview_gates() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        const auto path = temp.filePath("project.sqlite");
        window.save_to(path);
        window.show();
        const auto before = window.document();
        const lmti::WorkProposal proposal{"factory-monitor", "validate-sampling", 1, lmti::WorkState::Todo,
                                          lmti::WorkState::Review};
        window.review_proposal(proposal);
        auto apply = window.findChild<QPushButton *>("applyWorkProposal");
        auto comparison = window.findChild<QTreeWidget *>("proposalComparison");
        QVERIFY(apply->isEnabled());
        QCOMPARE(comparison->topLevelItemCount(), 1);
        QCOMPARE(window.document(), before);
        QTest::mouseClick(window.findChild<QPushButton *>("cancelWorkProposal"), Qt::LeftButton);
        QVERIFY(!apply->isEnabled());
        QCOMPARE(window.document(), before);

        window.review_proposal(proposal);
        window.show_page(ProjectPage::Settings);
        auto name = window.findChild<QLineEdit *>("settingsName");
        QVERIFY(name);
        name->setText("Unapplied project name");
        QVERIFY(window.findChild<QAction *>("saveProjectFile")->isEnabled());
        QVERIFY(!window.findChild<QAction *>("reviewProjectProposal")->isEnabled());
        QVERIFY(!apply->isEnabled());
        QVERIFY_THROWS_EXCEPTION(lmti::Error, window.apply_checked_proposal(proposal));
        QCOMPARE(window.document(), before);
        QTest::mouseClick(window.findChild<QPushButton *>("cancelProjectSettings"), Qt::LeftButton);
        QCOMPARE(name->text(), QString::fromStdString(before.project.label));
        QVERIFY(apply->isEnabled());

        name->setText("");
        QTest::mouseClick(window.findChild<QPushButton *>("applyProjectSettings"), Qt::LeftButton);
        QVERIFY(window.findChild<QLabel *>("settingsError")->isVisible());
        QCOMPARE(name->text(), "");
        QCOMPARE(window.document(), before);
        name->setText(QString(60, QChar(0x1ec7)));
        window.findChild<QPushButton *>("applyProjectSettings")->click();
        QCOMPARE(window.focusWidget(), name);
        QCOMPARE(name->text(), QString(60, QChar(0x1ec7)));
        QCOMPARE(window.document(), before);
        name->setText("Reviewed synthetic name");
        QTest::mouseClick(window.findChild<QPushButton *>("applyProjectSettings"), Qt::LeftButton);
        QCOMPARE(window.document().project.label, std::string("Reviewed synthetic name"));
        QCOMPARE(lmti::load_project(path).project.label, before.project.label);
        QVERIFY(!apply->isEnabled());
        window.findChild<QAction *>("saveProjectFile")->trigger();
        QCOMPARE(lmti::load_project(path), window.document());
        QVERIFY(!apply->isEnabled()); // Loaded proposal still references the earlier saved revision.

        window.review_proposal(
            {"factory-monitor", "validate-sampling", 2, lmti::WorkState::Todo, lmti::WorkState::Review});
        QVERIFY(apply->isEnabled());
        const auto reviewed = window.document();
        QTest::mouseClick(apply, Qt::LeftButton);
        auto expected = reviewed;
        expected.work[0].state = lmti::WorkState::Review;
        QCOMPARE(window.document(), expected); // Nothing besides the permitted state changed.
        QCOMPARE(lmti::load_project(path), reviewed);
        QVERIFY(!apply->isEnabled());
        window.findChild<QAction *>("undoProjectEdit")->trigger();
        QCOMPARE(window.document(), reviewed);
        window.review_proposal(
            {"another-project", "validate-sampling", 2, lmti::WorkState::Todo, lmti::WorkState::Review});
        QVERIFY(!apply->isEnabled());
        window.review_proposal(
            {"factory-monitor", "validate-sampling", 2, lmti::WorkState::Todo, lmti::WorkState::Done});
        QVERIFY(!apply->isEnabled());
        QCOMPARE(window.document(), reviewed);
    }
    void form_errors_keep_draft_focus_and_cancel_history() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        window.show_page(ProjectPage::Work);
        window.show();
        const auto before = window.document();
        QTimer::singleShot(0, &window, [&] {
            auto dialog = window.findChild<QDialog *>("projectRecordDialog");
            QVERIFY(dialog);
            auto title = dialog->findChild<QLineEdit *>("fieldTitle");
            title->setText("Draft validation");
            auto kind = dialog->findChild<QComboBox *>("fieldKind");
            kind->setCurrentIndex(kind->findData("validation"));
            auto state = dialog->findChild<QComboBox *>("fieldState");
            state->setCurrentIndex(state->findData("done"));
            dialog->findChild<QLineEdit *>("fieldChecklist / completion")->setText("Checked synthetic model");
            auto evidence = dialog->findChild<QLineEdit *>("fieldEvidence reference");
            QTest::mouseClick(dialog->findChild<QDialogButtonBox *>()->button(QDialogButtonBox::Save),
                              Qt::LeftButton);
            QVERIFY(dialog->isVisible());
            QCOMPARE(title->text(), "Draft validation");
            QCOMPARE(dialog->focusWidget(), evidence);
            QCOMPARE(window.document(), before);
            evidence->setText(QString(200, QChar(0x1ec7)));
            dialog->findChild<QDialogButtonBox *>()->button(QDialogButtonBox::Save)->click();
            QVERIFY(dialog->isVisible());
            QVERIFY(evidence->property("invalid").toBool());
            QVERIFY(!evidence->accessibleDescription().isEmpty());
            QCOMPARE(dialog->focusWidget(), evidence);
            QCOMPARE(window.document(), before);
            QTest::mouseClick(dialog->findChild<QDialogButtonBox *>()->button(QDialogButtonBox::Cancel),
                              Qt::LeftButton);
        });
        QTest::mouseClick(window.findChild<QPushButton *>("addwork"), Qt::LeftButton);
        QCOMPARE(window.document(), before);
        window.show_page(ProjectPage::Work);
        // Invalid calendar dates remain editable and focus the actual date field.
        QTimer::singleShot(0, &window, [&] {
            auto dialog = window.findChild<QDialog *>("projectRecordDialog");
            QVERIFY(dialog);
            dialog->findChild<QLineEdit *>("fieldName")->setText("Draft milestone");
            dialog->findChild<QLineEdit *>("fieldAcceptance criteria")->setText("Synthetic criteria");
            auto date = dialog->findChild<QLineEdit *>("fieldDue date");
            date->setText("2026-02-30");
            auto buttons = dialog->findChild<QDialogButtonBox *>();
            QTest::mouseClick(buttons->button(QDialogButtonBox::Save), Qt::LeftButton);
            QVERIFY(dialog->isVisible());
            QCOMPARE(dialog->focusWidget(), date);
            QCOMPARE(date->text(), "2026-02-30");
            date->setText("2026-02-28");
            QTest::mouseClick(buttons->button(QDialogButtonBox::Save), Qt::LeftButton);
        });
        QTest::mouseClick(window.findChild<QPushButton *>("addmilestone"), Qt::LeftButton);
        QCOMPARE(window.document().milestones.size(), before.milestones.size() + 1);
        window.findChild<QAction *>("undoProjectEdit")->trigger();
        QCOMPARE(window.document(), before);
    }
    void inspector_back_modes_language_and_agent_summary() {
        QTemporaryDir temp;
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        window.show();
        window.show_page(ProjectPage::Software);
        for (const auto size : {QSize(1100, 800), QSize(1280, 720), QSize(1440, 900)}) {
            window.resize(size);
            QCoreApplication::processEvents();
            QCOMPARE(window.size(), size);
        }
        auto components = window.findChild<QTreeWidget *>("componentTable");
        auto filter = window.findChild<QLineEdit *>("componentFilter");
        auto edit = window.findChild<QPushButton *>("editcomponent");
        QVERIFY(!edit->isEnabled());
        filter->setText("sensor");
        QTreeWidgetItem *sensor = nullptr;
        for (int i = 0; i < components->topLevelItemCount(); ++i)
            if (components->topLevelItem(i)->data(0, Qt::UserRole).toString() == "sensor-firmware")
                sensor = components->topLevelItem(i);
        QVERIFY(sensor);
        components->setCurrentItem(sensor);
        QVERIFY(edit->isEnabled());
        auto relations = window.findChild<QTreeWidget *>("inspectorRelations");
        QTreeWidgetItem *release = nullptr;
        for (int i = 0; i < relations->topLevelItemCount(); ++i)
            if (relations->topLevelItem(i)->data(0, Qt::UserRole + 1).toString() == "release")
                release = relations->topLevelItem(i);
        QVERIFY(release);
        relations->setCurrentItem(release);
        QTest::mouseClick(window.findChild<QPushButton *>("openRelatedRecord"), Qt::LeftButton);
        QCOMPARE(window.findChild<QTabWidget *>("projectTabs")->currentIndex(),
                 static_cast<int>(ProjectPage::Releases));
        QTest::mouseClick(window.findChild<QPushButton *>("inspectorBack"), Qt::LeftButton);
        QCOMPARE(window.findChild<QTabWidget *>("projectTabs")->currentIndex(),
                 static_cast<int>(ProjectPage::Software));
        QCOMPARE(filter->text(), "sensor");
        QCOMPARE(components->currentItem()->data(0, Qt::UserRole).toString(), "sensor-firmware");
        const auto before = window.document();
        auto inspector = window.findChild<QFrame *>("entityInspector");
        QVERIFY(inspector->isVisible());
        auto pages = window.findChild<QScrollArea *>("workspaceScroll");
        QCoreApplication::processEvents();
        QVERIFY(pages->mapTo(&window, QPoint(pages->width(), 0)).x() <=
                inspector->mapTo(&window, QPoint(0, 0)).x());
        window.resize(1100, 800);
        QCoreApplication::processEvents();
        QCOMPARE(window.size(), QSize(1100, 800));
        QVERIFY(inspector->isVisible());
        window.resize(1440, 900);
        QCoreApplication::processEvents();
        QCOMPARE(window.size(), QSize(1440, 900));
        QVERIFY(inspector->isVisible());
        QCOMPARE(window.document(), before);
        window.set_language(false);
        QCOMPARE(filter->text(), "sensor");
        QCOMPARE(window.document(), before);
        QCOMPARE(project_caption("Observed"), QString::fromUtf8("Quan sát được"));
        window.set_language(true);
        window.show_page(ProjectPage::Work);
        auto list = window.findChild<QTreeWidget *>("workTable");
        list->setCurrentItem(list->topLevelItem(0));
        const auto id = list->currentItem()->data(0, Qt::UserRole).toString();
        auto mode = window.findChild<QComboBox *>("workViewMode");
        mode->setCurrentIndex(1);
        QVERIFY(window.findChild<QPushButton *>("editwork")->isEnabled());
        mode->setCurrentIndex(0);
        QCOMPARE(list->currentItem()->data(0, Qt::UserRole).toString(), id);
        window.show_page(ProjectPage::Agent);
        auto knowledge_navigation = window.findChild<QListWidget *>("knowledgeNavigation");
        QCOMPARE(knowledge_navigation->currentRow(), 1);
        QCOMPARE(window.findChild<QListWidget *>("projectNavigation")->currentRow(), -1);
        knowledge_navigation->setCurrentRow(0);
        QCOMPARE(window.findChild<QTabWidget *>("projectTabs")->currentIndex(),
                 static_cast<int>(ProjectPage::Knowledge));
        window.show_page(ProjectPage::Agent);
        QCOMPARE(window.findChild<QTabWidget *>("agentTabs")->count(), 3);
        QVERIFY(window.findChild<QTreeWidget *>("agentSummary")->topLevelItemCount() > 3);
        QVERIFY(!window.findChild<QPlainTextEdit *>("projectAgentContext")->isVisible());
        window.findChild<QCheckBox *>("agentTechnicalDetails")->setChecked(true);
        QVERIFY(window.findChild<QPlainTextEdit *>("projectAgentContext")->isVisible());
        window.show_page(ProjectPage::Knowledge);
        QVERIFY(static_cast<KnowledgePanel *>(window.findChild<QWidget *>("knowledgeConnection")));
        window.show_library();
        auto library_mode = window.findChild<QComboBox *>("libraryViewMode");
        QVERIFY(library_mode);
        library_mode->setCurrentIndex(1);
        QCOMPARE(library_mode->currentIndex(), 1);
    }
    void knowledge_process_scope_cancel_and_document_change() {
        const auto node = QStandardPaths::findExecutable("node");
        if (node.isEmpty())
            QSKIP("Knowledge process checks require a trusted Node runtime.");
        const auto old_node = qgetenv("LMTI_STUDIO_NODE_BINARY"), old_cli = qgetenv("LMTI_STUDIO_CLI");
        const auto restore = qScopeGuard([&] {
            qputenv("LMTI_STUDIO_NODE_BINARY", old_node);
            qputenv("LMTI_STUDIO_CLI", old_cli);
        });
        QTemporaryDir temp;
        const auto script = temp.filePath("index.js");
        qputenv("LMTI_STUDIO_NODE_BINARY", node.toUtf8());
        qputenv("LMTI_STUDIO_CLI", script.toUtf8());
        auto write_script = [&](const QByteArray &body) {
            QFile file(script);
            QVERIFY(file.open(QIODevice::WriteOnly));
            file.write(body);
        };
        QJsonObject response{{"schema", "lmti.desktop.knowledge.v1"},
                             {"sourceId", QString(64, 'a')},
                             {"target", "external"},
                             {"sourceName", "Synthetic source"},
                             {"compiledAt", "2026-10-12"},
                             {"fetchedAt", "2026-10-12"},
                             {"memoryConnected", true},
                             {"projectMap", QJsonArray{}},
                             {"memories", QJsonArray{}},
                             {"lessons", QJsonArray{}},
                             {"canReview", false},
                             {"truncated", false},
                             {"context", ""}};
        auto valid_script =
            QByteArray("let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const "
                       "r=JSON.parse(s);console.log(JSON.stringify({...") +
            QJsonDocument(response).toJson(QJsonDocument::Compact) +
            ",projectId:r.projectId,context:r.operation==='context'?JSON.stringify({schema:'lmti.desktop."
            "knowledge.v1',projectId:r.projectId,sourceId:'" +
            QByteArray(64, 'a') + "',target:'external',task:r.task,projectMap:[],memories:[]}):''}));});";
        write_script(valid_script);
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.load_demo();
        window.show();
        window.show_page(ProjectPage::Knowledge);
        window.findChild<QTabWidget *>("knowledgeTabs")->setCurrentIndex(1);
        auto panel = static_cast<KnowledgePanel *>(window.findChild<QWidget *>("knowledgeConnection"));
        panel->connect_source(temp.path());
        auto reload = window.findChild<QPushButton *>("reloadKnowledge");
        auto prepare = window.findChild<QPushButton *>("prepareKnowledgeContext");
        auto source = window.findChild<QLabel *>("knowledgeSource");
        QVERIFY(!prepare->isEnabled());
        QVERIFY(source->text().contains("not loaded"));
        QTRY_VERIFY_WITH_TIMEOUT(reload->isEnabled(), 5000);
        QVERIFY(prepare->isEnabled());
        QVERIFY(source->text().contains("Loaded:"));
        auto copy = window.findChild<QPushButton *>("copyKnowledgeContext");
        window.findChild<QTabWidget *>("knowledgeTabs")->setCurrentIndex(4);
        // An invalid task clears only the outgoing preview; the checked source
        // remains usable after correcting the input without another source read.
        prepare->click();
        QVERIFY(prepare->isEnabled());
        QVERIFY(source->text().contains("Loaded:"));
        window.findChild<QLineEdit *>("knowledgeTask")->setText("Synthetic task");
        QTest::mouseClick(window.findChild<QPushButton *>("prepareKnowledgeContext"), Qt::LeftButton);
        QTRY_VERIFY_WITH_TIMEOUT(copy->isEnabled(), 5000);
        QVERIFY(copy->isEnabled());
        const auto before = window.document();
        window.set_language(false);
        QVERIFY(copy->isEnabled());
        QCOMPARE(window.document(), before);
        window.set_language(true);
        window.update_project([](auto &d) { d.project.goal = "Synthetic edit"; });
        QVERIFY(!copy->isEnabled());
        QVERIFY(!prepare->isEnabled());
        QVERIFY(source->text().contains("not loaded"));
        // A correct outer envelope must not authorize a context for another project.
        QTest::mouseClick(reload, Qt::LeftButton);
        QTRY_VERIFY_WITH_TIMEOUT(reload->isEnabled(), 5000);
        auto wrong_inner = valid_script;
        wrong_inner.replace("projectId:r.projectId,sourceId:", "projectId:'other-project',sourceId:");
        write_script(wrong_inner);
        QTest::mouseClick(window.findChild<QPushButton *>("prepareKnowledgeContext"), Qt::LeftButton);
        QTRY_VERIFY_WITH_TIMEOUT(reload->isEnabled(), 5000);
        QVERIFY(!copy->isEnabled());
        QVERIFY(!window.findChild<QPushButton *>("exportKnowledgeContext")->isEnabled());
        QVERIFY(window.findChild<QPlainTextEdit *>("knowledgeContextPreview")->toPlainText().isEmpty());
        QVERIFY(!prepare->isEnabled());
        QVERIFY(source->text().contains("not loaded"));
        window.set_language(false);
        QVERIFY(source->text().contains(QString::fromUtf8("chưa đọc")));
        window.set_language(true);
        // Scope mismatch clears prior results and never enables export.
        write_script("process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({schema:'"
                     "lmti.desktop.knowledge.v1',projectId:'other'})));");
        QTest::mouseClick(reload, Qt::LeftButton);
        QTRY_VERIFY_WITH_TIMEOUT(reload->isEnabled(), 5000);
        QVERIFY(!copy->isEnabled());
        write_script("process.stdin.resume();process.stdin.on('end',()=>console.log('malformed'));");
        QTest::mouseClick(reload, Qt::LeftButton);
        QTRY_VERIFY_WITH_TIMEOUT(reload->isEnabled(), 5000);
        QVERIFY(!copy->isEnabled());
        write_script("process.stdin.resume();setInterval(()=>{},1000);");
        QTest::mouseClick(reload, Qt::LeftButton);
        QVERIFY(window.findChild<QPushButton *>("cancelKnowledge")->isEnabled());
        window.new_project("Another project");
        QVERIFY(!copy->isEnabled());
        QVERIFY(!reload->isEnabled());
        window.show_page(ProjectPage::Knowledge);
        window.findChild<QTabWidget *>("knowledgeTabs")->setCurrentIndex(1);
        panel->connect_source(temp.path());
        QTest::mouseClick(window.findChild<QPushButton *>("cancelKnowledge"), Qt::LeftButton);
        QVERIFY(!copy->isEnabled());
        QVERIFY(reload->isEnabled());
        QTest::mouseClick(reload, Qt::LeftButton);
        QTRY_VERIFY_WITH_TIMEOUT(reload->isEnabled(), 12000);
        QVERIFY(!copy->isEnabled());
        QVERIFY(window.findChild<QLabel *>("knowledgeStatus")->text().contains("timed out"));
        QVERIFY(!prepare->isEnabled());
        QVERIFY(source->text().contains("not loaded"));
        write_script("process.stdin.resume();process.stdin.on('end',()=>console.log('x'.repeat(2200000)));");
        QTest::mouseClick(reload, Qt::LeftButton);
        QTRY_VERIFY_WITH_TIMEOUT(reload->isEnabled(), 5000);
        QVERIFY(!copy->isEnabled());
    }
    void knowledge_real_adapter_context_round_trip() {
        const auto node = QStandardPaths::findExecutable("node");
        const auto cli = qEnvironmentVariable("LMTI_STUDIO_TEST_CLI");
        if (node.isEmpty() || !QFileInfo::exists(cli))
            QSKIP("Build TS CLI and set LMTI_STUDIO_TEST_CLI for the cross-runtime test.");
        const auto old_node = qgetenv("LMTI_STUDIO_NODE_BINARY"), old_cli = qgetenv("LMTI_STUDIO_CLI");
        const auto restore = qScopeGuard([&] {
            qputenv("LMTI_STUDIO_NODE_BINARY", old_node);
            qputenv("LMTI_STUDIO_CLI", old_cli);
        });
        qputenv("LMTI_STUDIO_NODE_BINARY", node.toUtf8());
        qputenv("LMTI_STUDIO_CLI", cli.toUtf8());
        QTemporaryDir temp;
        QVERIFY(QDir(temp.path()).mkdir(".lmti"));
        QJsonObject amf{{"version", "0.1.0"},
                        {"project", QJsonObject{{"name", "Synthetic knowledge"},
                                                {"root", QFileInfo(temp.path()).canonicalFilePath()},
                                                {"compiledAt", "2026-10-12"}}},
                        {"modules", QJsonArray{QJsonObject{{"name", "Synthetic core"},
                                                           {"summary", "Typed architecture boundary"},
                                                           {"privacy", "public"}}}},
                        {"files", QJsonArray{}},
                        {"architecture", QJsonArray{}},
                        {"rules", QJsonArray{}},
                        {"summaries", QJsonArray{}}};
        QFile file(temp.filePath(".lmti/project.amf.json"));
        QVERIFY(file.open(QIODevice::WriteOnly));
        file.write(QJsonDocument(amf).toJson());
        file.close();
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.new_project("Synthetic native project");
        window.show();
        window.show_page(ProjectPage::Knowledge);
        window.findChild<QTabWidget *>("knowledgeTabs")->setCurrentIndex(1);
        auto panel = static_cast<KnowledgePanel *>(window.findChild<QWidget *>("knowledgeConnection"));
        panel->connect_source(temp.path());
        auto reload = window.findChild<QPushButton *>("reloadKnowledge");
        QTRY_VERIFY_WITH_TIMEOUT(reload->isEnabled(), 10000);
        QCOMPARE(window.findChild<QTreeWidget *>("knowledgeMap")->topLevelItemCount(), 1);
        QCOMPARE(window.findChild<QTreeWidget *>("knowledgeMemory")->topLevelItemCount(), 0);
        QCOMPARE(window.findChild<QLabel *>("knowledgeMemoryCount")->text(),
                 "Memory storage is not connected.");
        QVERIFY(!QFileInfo::exists(temp.filePath(".lmti/memory/project-memory.sqlite")));
        // Only the explicit owner command creates the previously missing store.
        QProcess add;
        add.setWorkingDirectory(temp.path());
        add.start(node, {cli, "memory", "add", "--title", "Synthetic architecture memory", "--content",
                         "Preserve the typed architecture boundary", "--zone", "architecture", "--privacy-level",
                         "public"});
        QVERIFY(add.waitForFinished(10000));
        QCOMPARE(add.exitCode(), 0);
        reload->click();
        QTRY_VERIFY_WITH_TIMEOUT(reload->isEnabled(), 10000);
        QCOMPARE(window.findChild<QTreeWidget *>("knowledgeMemory")->topLevelItemCount(), 1);
        window.findChild<QLineEdit *>("knowledgeTask")->setText("architecture boundary");
        window.findChild<QTabWidget *>("knowledgeTabs")->setCurrentIndex(4);
        QTest::mouseClick(window.findChild<QPushButton *>("prepareKnowledgeContext"), Qt::LeftButton);
        auto copy = window.findChild<QPushButton *>("copyKnowledgeContext");
        QTRY_VERIFY_WITH_TIMEOUT(copy->isEnabled(), 10000);
        const auto text = window.findChild<QPlainTextEdit *>("knowledgeContextPreview")->toPlainText();
        QVERIFY(text.contains("Synthetic architecture memory"));
        QVERIFY(!text.contains("sourceRoot"));
        QVERIFY(!window.findChild<QPushButton *>("reviewKnowledgeLesson")->isEnabled());
        const bool native_dialogs_disabled = QApplication::testAttribute(Qt::AA_DontUseNativeDialogs);
        QApplication::setAttribute(Qt::AA_DontUseNativeDialogs, true);
        const auto restore_dialogs = qScopeGuard(
            [&] { QApplication::setAttribute(Qt::AA_DontUseNativeDialogs, native_dialogs_disabled); });
        const auto export_path = temp.filePath("checked-context.txt");
        QTimer::singleShot(0, &window, [&] {
            auto dialog = qobject_cast<QFileDialog *>(QApplication::activeModalWidget());
            QVERIFY(dialog);
            dialog->selectFile(export_path);
            QMetaObject::invokeMethod(dialog, "accept", Qt::DirectConnection);
        });
        window.findChild<QPushButton *>("exportKnowledgeContext")->click();
        QFile exported(export_path);
        QVERIFY(exported.open(QIODevice::ReadOnly));
        QCOMPARE(QString::fromUtf8(exported.readAll()), text);
        window.findChild<QLineEdit *>("knowledgeTask")->setText("Changed task invalidates checked export");
        QVERIFY(!copy->isEnabled());
        QVERIFY(!window.findChild<QPushButton *>("exportKnowledgeContext")->isEnabled());
        QVERIFY(window.findChild<QPlainTextEdit *>("knowledgeContextPreview")->toPlainText().isEmpty());
    }
    void bounded_library_and_workspace_scale() {
        QTemporaryDir temp;
        ProjectLibraryView library;
        std::vector<lmti::LibraryEntry> entries;
        for (int i = 0; i < 500; ++i)
            entries.push_back({QString("project-%1").arg(i),
                               QString("Synthetic project %1").arg(i),
                               temp.filePath(QString("project-%1.sqlite").arg(i)),
                               {},
                               false,
                               0});
        library.resize(1100, 800);
        library.findChild<QComboBox *>("libraryViewMode")->setCurrentIndex(0);
        library.set_entries(entries);
        library.show();
        QCoreApplication::processEvents();
        int cards = 0;
        for (auto frame : library.findChildren<QFrame *>())
            if (frame->isVisible() && frame->objectName().startsWith("libraryCard-"))
                ++cards;
        QCOMPARE(cards, 24);
        library.findChild<QComboBox *>("libraryViewMode")->setCurrentIndex(1);
        library.findChild<QLineEdit *>("librarySearch")->setText("Synthetic project 499");
        QCoreApplication::processEvents();
        QCOMPARE(library.findChild<QTreeWidget *>("libraryList")->topLevelItemCount(), 1);
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.new_project("Synthetic scale");
        window.resize(1280, 720);
        window.show();
        for (const int count : {500, 2000}) {
            QElapsedTimer timer;
            timer.start();
            window.update_project([count](auto &d) {
                d.components.clear();
                d.releases.clear();
                d.work.clear();
                d.bindings.clear();
                d.topology.assets.clear();
                d.project.privacy = lmti::Privacy::Public;
                const int component_count = count == 500 ? 100 : 2000;
                for (int i = 0; i < component_count; ++i) {
                    auto id = "component-" + std::to_string(i);
                    d.components.push_back(
                        {id, "Synthetic component", "", lmti::ComponentKind::Library, lmti::Privacy::Public});
                    d.releases.push_back({"release-" + std::to_string(i), "0.1.0", id, "", "synthetic",
                                          lmti::ReleaseState::Candidate, lmti::Privacy::Public});
                }
                for (int i = 0; i < 200; ++i) {
                    lmti::Asset a;
                    a.id = "asset-" + std::to_string(i);
                    a.label = "Synthetic device";
                    a.site = "demo-site";
                    a.privacy = lmti::Privacy::Public;
                    d.topology.assets.push_back(a);
                }
                for (int i = 0; i < count; ++i) {
                    auto component = "component-" + std::to_string(i / 200),
                         asset = "asset-" + std::to_string(i % 200),
                         release = "release-" + std::to_string(i / 200);
                    d.bindings.push_back({"binding-" + std::to_string(i), asset, component, release, "",
                                          lmti::Privacy::Public});
                    d.work.push_back({"work-" + std::to_string(i),
                                      "Synthetic validation " + std::to_string(i), component, asset, release,
                                      "", "Check metadata", "", lmti::WorkKind::Validation,
                                      lmti::WorkState::Todo, lmti::Privacy::Public});
                }
            });
            const auto load_ms = timer.nsecsElapsed() / 1000000.0;
            window.show_page(ProjectPage::Work);
            auto filter = window.findChild<QLineEdit *>("workFilter");
            auto tree = window.findChild<QTreeWidget *>("workTable");
            QCOMPARE(tree->topLevelItemCount(), count);
            std::vector<double> filters, pages;
            for (int i = 0; i < 20; ++i) {
                timer.restart();
                filter->setText(i % 2 ? "validation 499" : "");
                QCoreApplication::processEvents();
                filters.push_back(timer.nsecsElapsed() / 1000000.0);
                timer.restart();
                window.show_page(i % 2 ? ProjectPage::Work : ProjectPage::Software);
                QCoreApplication::processEvents();
                pages.push_back(timer.nsecsElapsed() / 1000000.0);
            }
            std::sort(filters.begin(), filters.end());
            std::sort(pages.begin(), pages.end());
            qInfo("UI synthetic scale: work=%d loadMs=%.2f filterP95Ms=%.2f pageP95Ms=%.2f samples=20", count,
                  load_ms, filters[18], pages[18]);
            filter->clear();
            window.show_page(ProjectPage::Work);
            window.findChild<QComboBox *>("workViewMode")->setCurrentIndex(1);
            window.resize(1100, 800);
            QCoreApplication::processEvents();
            QCOMPARE(window.findChild<QComboBox *>("workViewMode")->currentIndex(), 1);
            for (const auto &state : {"todo", "in-progress", "blocked", "review", "done"})
                QVERIFY(window.findChild<QTreeWidget *>(QString("work-") + state)->isVisible());
        }
    }
    void library_folders_pins_search_and_safe_switch() {
        QTemporaryDir temp;
        QVERIFY(temp.isValid());
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.show();
        window.create_project_folder(temp.path(), "firmware-project", "Firmware project", "Synthetic goal");
        const auto first = window.document();
        const auto first_file = temp.filePath("firmware-project/project.lmti.sqlite");
        QVERIFY(QFileInfo::exists(first_file));
        QVERIFY_THROWS_EXCEPTION(lmti::Error,
                                 window.create_project_folder(temp.path(), "../escape", "Rejected"));
        QVERIFY_THROWS_EXCEPTION(lmti::Error, window.create_project_folder(temp.path(), "CON", "Rejected"));
        QVERIFY_THROWS_EXCEPTION(lmti::Error, window.create_project_folder(temp.path(), ".LMTI", "Rejected"));
        QVERIFY(!QFileInfo::exists(temp.filePath(".LMTI")));
        QVERIFY_THROWS_EXCEPTION(lmti::Error,
                                 window.create_project_folder(temp.path(), "firmware-project", "Rejected"));
        QCOMPARE(window.document(), first);
        QVERIFY(QDir(temp.path()).mkdir("existing-source"));
        QFile source(temp.filePath("existing-source/main.cpp"));
        QVERIFY(source.open(QIODevice::WriteOnly));
        source.write("// synthetic source\n");
        source.close();
        auto before = QDir(temp.filePath("existing-source")).entryList(QDir::Files | QDir::Hidden);
        window.attach_project_folder(temp.filePath("existing-source"));
        const auto second = window.document();
        QCOMPARE(QDir(temp.filePath("existing-source")).entryList(QDir::Files | QDir::Hidden), before);
        QVERIFY(source.open(QIODevice::ReadOnly));
        QCOMPARE(source.readAll(), QByteArray("// synthetic source\n"));
        source.close();
        window.attach_project_folder(temp.filePath("existing-source"));
        QCOMPARE(window.document().project.id, second.project.id);
        QCOMPARE(lmti::project_library(window.library_path()).size(), std::size_t(2));
        window.show_library();
        window.resize(1100, 800);
        QTest::qWait(20);
        QCOMPARE(window.findChild<QScrollArea *>("libraryScroll")->horizontalScrollBar()->maximum(), 0);
        auto navigation = window.findChild<QListWidget *>("projectNavigation");
        const auto last_bottom = navigation->visualItemRect(navigation->item(5)).bottom();
        QVERIFY2(
            last_bottom < navigation->viewport()->height(),
            qPrintable(QString("Last navigation item bottom %1, viewport height %2, first item height %3")
                           .arg(last_bottom)
                           .arg(navigation->viewport()->height())
                           .arg(navigation->visualItemRect(navigation->item(0)).height())));
        QCOMPARE(window.findChild<QStackedWidget *>("projectRoot")->currentIndex(), 0);
        QCOMPARE(window.findChild<QPushButton *>("createProjectButton")->text(), QString("+ Create project"));
        auto search = window.findChild<QLineEdit *>("librarySearch");
        search->setText("firmware");
        QTest::qWait(10);
        auto other = window.findChild<QPushButton *>("open-" + QString::fromStdString(first.project.id));
        QVERIFY(other && other->isVisible());
        search->clear();
        QTest::qWait(10);
        auto pin = window.findChild<QToolButton *>("pin-" + QString::fromStdString(second.project.id));
        QVERIFY(pin);
        QTest::mouseClick(pin, Qt::LeftButton);
        QTest::qWait(10);
        QVERIFY(lmti::project_library(window.library_path()).front().pinned);
        window.update_project([](auto &d) { d.project.goal = "Unsaved change"; });
        auto dirty = window.document();
        window.show_library();
        window.set_language(false);
        QCOMPARE(window.document(), dirty);
        QCOMPARE(window.findChild<QStackedWidget *>("projectRoot")->currentIndex(), 0);
        QCOMPARE(window.findChild<QPushButton *>("createProjectButton")->text(), QString("+ Tạo dự án"));
        window.set_language(true);
        QCOMPARE(window.document(), dirty);
        QCOMPARE(window.findChild<QPushButton *>("createProjectButton")->text(), QString("+ Create project"));
        QTimer::singleShot(0, &window, [&] {
            auto dialog = window.findChild<QMessageBox *>();
            QVERIFY(dialog);
            QTest::mouseClick(dialog->button(QMessageBox::Cancel), Qt::LeftButton);
        });
        other = window.findChild<QPushButton *>("open-" + QString::fromStdString(first.project.id));
        QVERIFY(other);
        QTest::mouseClick(other, Qt::LeftButton);
        QCOMPARE(window.document(), dirty);
        QVERIFY_THROWS_EXCEPTION(lmti::Error,
                                 window.open_project(first_file, QString::fromStdString(second.project.id)));
        QCOMPARE(window.document(), dirty);
        auto copy = temp.filePath("copy.sqlite");
        window.save_to(copy);
        auto entries = lmti::project_library(window.library_path());
        QCOMPARE(entries.size(), std::size_t(2));
        QCOMPARE(entries.front().path, copy);
        QVERIFY(entries.front().pinned);
        QCOMPARE(entries.front().folder, lmti::checked_project_folder(temp.filePath("existing-source")));
        window.show_page(1);
        QCOMPARE(window.findChild<QListWidget *>("projectNavigation")->currentItem()->data(Qt::UserRole).toInt(),
                 static_cast<int>(ProjectPage::Software));
        QVERIFY(QDir(temp.path()).mkdir(".lmti"));
        QVERIFY_THROWS_EXCEPTION(lmti::Error, window.attach_project_folder(temp.filePath(".lmti")));
    }
    void project_lifecycle_and_shared_history() {
        QTemporaryDir temp;
        QVERIFY(temp.isValid());
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.show();
        QCOMPARE(window.findChild<QStackedWidget *>()->currentIndex(), 0);
        QCoreApplication::processEvents();
        auto library_button = window.findChild<QPushButton *>("showProjectLibrary");
        QVERIFY(library_button->isVisible());
        QVERIFY(library_button->mapTo(&window, QPoint(0, 0)).y() < 200);
        auto empty = window.findChild<QFrame *>("libraryEmpty");
        QVERIFY(empty && empty->width() >= 600);
        for (auto label : empty->findChildren<QLabel *>()) {
            const auto required = label->fontMetrics()
                                      .boundingRect(QRect(0, 0, label->contentsRect().width(), 10000),
                                                    Qt::TextWordWrap, label->text())
                                      .height();
            QVERIFY2(label->contentsRect().height() >= required, qPrintable(label->text()));
        }
        QVERIFY(!window.findChild<QAction *>("saveProjectFile")->isEnabled());
        window.load_demo();
        QCOMPARE(window.document().components.size(), std::size_t(3));
        auto tabs = window.findChild<QTabWidget *>("projectTabs");
        QCOMPARE(tabs->count(), 11);
        QCOMPARE(tabs->widget(static_cast<int>(ProjectPage::Impact))->objectName(), "impactPanel");
        tabs->setCurrentIndex(1);
        QTimer::singleShot(0, &window, [&] {
            auto dialog = window.findChild<QDialog *>("projectRecordDialog");
            QVERIFY(dialog);
            dialog->findChild<QLineEdit *>("fieldName")->setText("Test driver");
            QTest::mouseClick(dialog->findChild<QDialogButtonBox *>()->button(QDialogButtonBox::Save),
                              Qt::LeftButton);
        });
        QTest::mouseClick(window.findChild<QPushButton *>("addcomponent"), Qt::LeftButton);
        QCOMPARE(window.document().components.size(), std::size_t(4));
        QCOMPARE(window.document().components.back().privacy, lmti::Privacy::Internal);
        window.findChild<QAction *>("undoProjectEdit")->trigger();
        QCOMPARE(window.document().components.size(), std::size_t(3));
        window.findChild<QAction *>("redoProjectEdit")->trigger();
        QCOMPARE(window.document().components.size(), std::size_t(4));
        tabs->setCurrentIndex(3);
        auto architecture_tabs = window.findChild<QTabWidget *>("architectureTabs");
        architecture_tabs->setCurrentIndex(1);
        tabs->setCurrentIndex(2);
        QTimer::singleShot(0, &window, [&] {
            auto dialog = window.findChild<QDialog *>("projectRecordDialog");
            QVERIFY(dialog);
            const auto close = qScopeGuard([dialog] {
                if (dialog->isVisible())
                    dialog->reject();
            });
            dialog->findChild<QLineEdit *>("fieldName")->setText("Synthetic sensor");
            dialog->findChild<QLineEdit *>("fieldSite")->setText("factory-demo");
            QTest::mouseClick(dialog->findChild<QDialogButtonBox *>()->button(QDialogButtonBox::Save),
                              Qt::LeftButton);
        });
        QTest::mouseClick(window.findChild<QPushButton *>("addHardwareDevice"), Qt::LeftButton);
        QCOMPARE(tabs->currentIndex(), static_cast<int>(ProjectPage::Hardware));
        QCOMPARE(architecture_tabs->currentIndex(), 1);
        QCOMPARE(window.document().topology.assets.size(), std::size_t(4));
        window.findChild<QAction *>("undoProjectEdit")->trigger();
        QCOMPARE(window.document().topology.assets.size(), std::size_t(3));
        QCOMPARE(window.document().components.size(), std::size_t(4));
        const auto path = temp.filePath("project.sqlite");
        window.save_to(path);
        QCOMPARE(window.document().topology.revision, std::int64_t(1));
        QVERIFY(window.findChild<QAction *>("reviewProjectProposal")->isEnabled());
        window.apply_checked_proposal(
            {"factory-monitor", "validate-sampling", 1, lmti::WorkState::Todo, lmti::WorkState::Review});
        QCOMPARE(window.document().work[0].state, lmti::WorkState::Review);
        QVERIFY(!window.findChild<QAction *>("reviewProjectProposal")->isEnabled());
        window.save_to(path);
        ProjectWindow reopened(nullptr, temp.filePath("catalog.sqlite"));
        reopened.open_project(path);
        QCOMPARE(reopened.document(), window.document());
        QVERIFY_THROWS_EXCEPTION(
            lmti::Error, reopened.apply_checked_proposal({"factory-monitor", "validate-sampling", 1,
                                                          lmti::WorkState::Todo, lmti::WorkState::Blocked}));
        QVERIFY_THROWS_EXCEPTION(
            lmti::Error, reopened.update_project([](auto &d) { d.work[0].state = lmti::WorkState::Done; }));
        reopened.new_project("Empty software project");
        QCOMPARE(reopened.document().components.size(), std::size_t(0));
        QCOMPARE(reopened.document().topology.assets.size(), std::size_t(0));
        QCOMPARE(reopened.document().project.privacy, lmti::Privacy::Internal);
    }
    void topology_import_keeps_source() {
        QTemporaryDir temp;
        auto source = temp.filePath("legacy.sqlite");
        lmti::save(source, lmti::demo_topology());
        QFile file(source);
        QVERIFY(file.open(QIODevice::ReadOnly));
        auto before = file.readAll();
        file.close();
        ProjectWindow window(nullptr, temp.filePath("catalog.sqlite"));
        window.open_project(source);
        QCOMPARE(window.document().topology.revision, std::int64_t(0));
        QCOMPARE(window.document().topology.assets.size(), std::size_t(3));
        QVERIFY_THROWS_EXCEPTION(lmti::Error, window.save_to(source));
        window.save_to(temp.filePath("imported.sqlite"));
        QVERIFY(file.open(QIODevice::ReadOnly));
        QCOMPARE(file.readAll(), before);
    }
    void editing_and_proposals() {
        Window window;
        window.show();
        QTest::qWait(30);
        QCOMPARE(window.topology().assets.size(), std::size_t(3));
        window.select_asset("machine-a");
        auto poll = window.findChild<QSpinBox *>("assetPoll");
        QVERIFY(poll);
        poll->setValue(2300);
        QTest::mouseClick(window.findChild<QPushButton *>("applyAsset"), Qt::LeftButton);
        QCOMPARE(lmti::find_asset(window.topology(), "machine-a").poll_ms, 2300);
        window.findChild<QAction *>("undoEdit")->trigger();
        QCOMPARE(lmti::find_asset(window.topology(), "machine-a").poll_ms, 1000);
        window.findChild<QAction *>("redoEdit")->trigger();
        QCOMPARE(lmti::find_asset(window.topology(), "machine-a").poll_ms, 2300);
        QTemporaryDir temp;
        QVERIFY(temp.isValid());
        const auto path = temp.filePath("ui.sqlite");
        window.save_to(path);
        QCOMPARE(window.topology().revision, std::int64_t(1));
        lmti::ConfigProposal p{1, "machine-a", "factory-demo", true, false, 2300, 5000};
        window.apply_checked_proposal(p);
        QCOMPARE(lmti::find_asset(window.topology(), "machine-a").poll_ms, 5000);
        window.save_to(path);
        QVERIFY_THROWS_EXCEPTION(lmti::Error, window.apply_checked_proposal(p));
        Window reopened;
        reopened.open_file(path);
        QCOMPARE(reopened.topology(), window.topology());
        // Delete removes associated edges, then undo restores both.
        reopened.select_asset("gateway-b");
        reopened.findChild<QAction *>("deleteAssets")->trigger();
        QCOMPARE(reopened.topology().links.size(), std::size_t(0));
        reopened.findChild<QAction *>("undoEdit")->trigger();
        QCOMPARE(reopened.topology().links.size(), std::size_t(2));
        auto context = window.findChild<QPlainTextEdit *>("agentContext");
        QVERIFY(context->toPlainText().contains("lmti.topology.context.v1"));
        window.findChild<QAction *>("addAsset")->trigger();
        QCOMPARE(window.topology().assets.size(), std::size_t(4));
        const auto created = window.topology().assets.back();
        QCOMPARE(created.privacy, lmti::Privacy::Internal);
        QVERIFY(!context->toPlainText().contains(QString::fromStdString(created.id)));
        QTimer::singleShot(0, &window, [&] {
            auto dialog = window.findChild<QDialog *>();
            QVERIFY(dialog);
            const auto combos = dialog->findChildren<QComboBox *>();
            QCOMPARE(combos.size(), qsizetype(3));
            combos[0]->setCurrentIndex(combos[0]->findData("machine-a"));
            combos[1]->setCurrentIndex(combos[1]->findData(QString::fromStdString(created.id)));
            auto buttons = dialog->findChild<QDialogButtonBox *>();
            QTest::mouseClick(buttons->button(QDialogButtonBox::Ok), Qt::LeftButton);
        });
        window.findChild<QAction *>("connectAssets")->trigger();
        QCOMPARE(window.topology().links.size(), std::size_t(3));
        window.findChild<QAction *>("undoEdit")->trigger();
        QCOMPARE(window.topology().links.size(), std::size_t(2));
    }
    void canvas_drag_is_undoable() {
        Window window;
        window.show();
        QTest::qWait(30);
        window.select_asset("machine-a");
        auto view = window.findChild<QGraphicsView *>("topologyCanvas");
        QVERIFY(view);
        const auto before = lmti::find_asset(window.topology(), "machine-a");
        const QPoint center = view->mapFromScene(QPointF(before.x + 110, before.y + 58));
        const QPoint moved = center + QPoint(35, 25);
        QTest::mousePress(view->viewport(), Qt::LeftButton, Qt::NoModifier, center);
        QTest::mouseMove(view->viewport(), moved, 20);
        QTest::mouseRelease(view->viewport(), Qt::LeftButton, Qt::NoModifier, moved);
        const auto after = lmti::find_asset(window.topology(), "machine-a");
        QVERIFY(after.x != before.x || after.y != before.y);
        window.findChild<QAction *>("undoEdit")->trigger();
        QCOMPARE(lmti::find_asset(window.topology(), "machine-a").x, before.x);
        QCOMPARE(lmti::find_asset(window.topology(), "machine-a").y, before.y);
    }
};
QTEST_MAIN(WindowTest)
#include "window_test.moc"
