#include "knowledge_panel.hpp"
#include "lmti/topology.hpp"
#include "project_captions.hpp"
#include "project_language.hpp"
#include "studio_widgets.hpp"
#include "workspace_tabs.hpp"
#include <QApplication>
#include <QCheckBox>
#include <QClipboard>
#include <QDateTime>
#include <QDialog>
#include <QDialogButtonBox>
#include <QFileDialog>
#include <QFileInfo>
#include <QHeaderView>
#include <QJsonArray>
#include <QJsonDocument>
#include <QProcessEnvironment>
#include <QRegularExpression>
#include <QSaveFile>
#include <QScrollArea>
#include <QTabWidget>
#include <QVBoxLayout>
#include <cmath>
#include <stdexcept>
#include <utility>
#include <vector>

namespace {
constexpr qsizetype output_limit = 2 * 1024 * 1024;
QString display_time(const QString &source) {
    auto value = QDateTime::fromString(source, Qt::ISODateWithMs);
    if (!value.isValid())
        value = QDateTime::fromString(source, Qt::ISODate);
    return value.isValid() ? value.toLocalTime().toString("yyyy-MM-dd HH:mm") : source;
}
bool secret_output(const QString &text) {
    const auto bytes = text.toStdString();
    if (bytes.size() > static_cast<std::size_t>(output_limit))
        return true;
    // The core scanner intentionally rejects metadata over 512 bytes. Scan
    // bounded overlapping windows for larger, already policy-checked context.
    for (std::size_t i = 0; i < bytes.size(); i += 384)
        if (lmti::secret_like(bytes.substr(i, 512)))
            return true;
    return false;
}
QLabel *label(const QString &text) {
    auto result = new QLabel(text);
    result->setTextFormat(Qt::PlainText);
    result->setWordWrap(true);
    return result;
}
QString checked_text(const QJsonValue &value, qsizetype max = 2000) {
    if (!value.isString() || value.toString().size() > max || secret_output(value.toString()))
        throw std::runtime_error("Invalid adapter output");
    return value.toString();
}
} // namespace
KnowledgePanel::KnowledgePanel(QWidget *parent) : QWidget(parent) {
    setObjectName("knowledgeConnection");
    auto layout = new QVBoxLayout(this);
    layout->setContentsMargins(0, 0, 0, 0);
    tabs_ = new WorkspaceTabs;
    tabs_->setObjectName("knowledgeTabs");
    layout->addWidget(tabs_, 1);
    QVBoxLayout *banner_layout;
    banner_ = studio::panel({}, &banner_layout);
    banner_->setParent(this);
    banner_->hide();
    banner_->setProperty("notice", true);
    auto source_row = new QHBoxLayout;
    auto source_labels = new QVBoxLayout;
    source_ = label({});
    source_->setObjectName("knowledgeSource");
    source_->setProperty("verbatim", true);
    status_ = label({});
    status_->setObjectName("knowledgeStatus");
    status_->setProperty("verbatim", true);
    source_labels->addWidget(source_);
    source_labels->addWidget(status_);
    source_row->addLayout(source_labels, 1);
    connect_ = new QPushButton(project_caption("Connect source…"));
    connect_->setObjectName("connectKnowledge");
    connect_->setProperty("uiCaption", "Connect source…");
    reload_ = new QPushButton(project_caption("Reload source"));
    reload_->setObjectName("reloadKnowledge");
    reload_->setProperty("uiCaption", "Reload source");
    cancel_ = new QPushButton(project_caption("Cancel"));
    cancel_->setObjectName("cancelKnowledge");
    cancel_->setProperty("uiCaption", "Cancel");
    source_row->addWidget(connect_);
    source_row->addWidget(reload_);
    source_row->addWidget(cancel_);
    banner_layout->addLayout(source_row);
    connect(connect_, &QPushButton::clicked, this, [this] {
        const auto folder =
            QFileDialog::getExistingDirectory(this, project_caption("Choose a knowledge source"));
        if (!folder.isEmpty())
            connect_source(folder);
    });
    connect(reload_, &QPushButton::clicked, this, [this] { request("snapshot"); });
    connect(cancel_, &QPushButton::clicked, this, [this] {
        cancel();
        fail("Request cancelled. Reload to continue.");
    });
    auto table_page = [this](const QString &name, const QStringList &columns, const QString &title,
                             QLabel **detail_title, QLabel **detail_text) {
        auto page = new QWidget;
        auto page_layout = new QVBoxLayout(page);
        page_layout->setContentsMargins(0, 12, 0, 0);
        auto search = new QLineEdit;
        search->setObjectName(name + "Search");
        search->setMaxLength(240);
        search->setClearButtonEnabled(true);
        const auto search_caption = name == "knowledgeMap"      ? "Search project map…"
                                    : name == "knowledgeMemory" ? "Search memory…"
                                                                : "Search lessons…";
        search->setPlaceholderText(project_caption(search_caption));
        search->setProperty("uiPlaceholder", search_caption);
        search->setAccessibleName(project_caption(search_caption));
        search->setProperty("uiAccessibleName", search_caption);
        auto count = label({});
        count->setObjectName(name + "Count");
        count->setProperty("verbatim", true);
        count->setStyleSheet("color:#64748b;font-size:12px;");
        auto split = new QHBoxLayout;
        split->setSpacing(18);
        auto tree = new QTreeWidget;
        tree->setObjectName(name);
        tree->setHeaderLabels(columns);
        studio::inventory(tree);
        tree->header()->setSectionResizeMode(QHeaderView::ResizeToContents);
        tree->header()->setStretchLastSection(false);
        if (name == "knowledgeMap") {
            tree->header()->setSectionResizeMode(1, QHeaderView::Interactive);
            tree->setColumnWidth(1, 220);
            tree->header()->setSectionResizeMode(2, QHeaderView::Stretch);
        } else {
            tree->header()->setSectionResizeMode(0, QHeaderView::Interactive);
            tree->setColumnWidth(0, 220);
            tree->header()->setSectionResizeMode(1, QHeaderView::Stretch);
            if (name == "knowledgeMemory") {
                tree->header()->setSectionResizeMode(3, QHeaderView::Fixed);
                tree->setColumnWidth(3, 160);
            }
        }
        auto inventory = new QWidget;
        auto inventory_layout = new QVBoxLayout(inventory);
        inventory_layout->setContentsMargins(0, 0, 0, 0);
        inventory_layout->setSpacing(8);
        inventory_layout->addWidget(search);
        inventory_layout->addWidget(count);
        inventory_layout->addWidget(tree, 1);
        split->addWidget(inventory, 2);
        auto empty = new studio::EmptyTreeState(tree);
        empty->setProperty("verbatim", true);
        table_ui_.push_back({tree, search, count, empty});
        connect(search, &QLineEdit::textChanged, this, [this, tree] { filter_table(tree); });
        QVBoxLayout *details;
        auto card = studio::panel({}, &details);
        card->setMinimumWidth(260);
        card->setMaximumWidth(340);
        *detail_title = label(project_caption("Select a record for details."));
        (*detail_title)->setObjectName("sectionTitle");
        (*detail_title)->setProperty("verbatim", true);
        *detail_text = label({});
        (*detail_text)->setProperty("verbatim", true);
        details->addWidget(*detail_title);
        details->addWidget(studio::caption(title == "Lessons" ? "Lesson review" : "Read-only", "muted"));
        auto scroll = new QScrollArea;
        scroll->setObjectName(name + "DetailScroll");
        scroll->setWidgetResizable(true);
        scroll->setFrameShape(QFrame::NoFrame);
        auto content = new QWidget;
        content->setObjectName("knowledgeDetailContent");
        auto content_layout = new QVBoxLayout(content);
        content_layout->setContentsMargins(0, 0, 0, 0);
        content_layout->addWidget(*detail_text);
        content_layout->addStretch();
        scroll->setWidget(content);
        details->addWidget(scroll, 1);
        split->addWidget(card, 1);
        page_layout->addLayout(split, 1);
        tabs_->addTab(page, title);
        connect(
            tree, &QTreeWidget::itemSelectionChanged, this,
            [this, tree, title = *detail_title, text = *detail_text] { show_details(tree, title, text); });
        return tree;
    };
    map_ =
        table_page("knowledgeMap", {"Kind", "Record", "Summary"}, "Project map", &map_title_, &map_detail_);
    memories_ = table_page("knowledgeMemory", {"Record", "Summary", "Visibility", "Updated"}, "Memory",
                           &memory_title_, &memory_detail_);
    lessons_ = table_page("knowledgeLessons", {"Record", "Summary", "Review state"}, "Lessons",
                          &lesson_title_, &lesson_detail_);
    auto lesson_body = qobject_cast<QVBoxLayout *>(lesson_title_->parentWidget()->layout());
    lesson_confirm_ = new studio::WrapCheckBox(project_caption("Evidence and privacy reviewed"));
    lesson_confirm_->setProperty("uiCaption", "Evidence and privacy reviewed");
    lesson_confirm_->setToolTip(project_caption("I reviewed the evidence and privacy of this lesson."));
    lesson_confirm_->setObjectName("lessonEvidenceReviewed");
    lesson_body->addWidget(lesson_confirm_);
    auto decisions = new QHBoxLayout;
    lesson_approve_ = new QPushButton(project_caption("Approve lesson"));
    lesson_approve_->setProperty("uiCaption", "Approve lesson");
    lesson_approve_->setObjectName("approveLesson");
    lesson_approve_->setProperty("primary", true);
    lesson_reject_ = new QPushButton(project_caption("Reject lesson"));
    lesson_reject_->setProperty("uiCaption", "Reject lesson");
    lesson_reject_->setObjectName("rejectLesson");
    decisions->addWidget(lesson_approve_);
    decisions->addWidget(lesson_reject_);
    lesson_body->addLayout(decisions);
    review_ = new QPushButton(project_caption("Review selected lesson…"));
    review_->setProperty("uiCaption", "Review selected lesson…");
    review_->setObjectName("reviewKnowledgeLesson");
    review_->setParent(this);
    review_->hide();
    connect(review_, &QPushButton::clicked, this, [this] { review_lesson(); });
    connect(lesson_confirm_, &QCheckBox::toggled, this, [this] { update_lesson_actions(); });
    connect(lessons_, &QTreeWidget::itemSelectionChanged, this, [this] {
        lesson_confirm_->setChecked(false);
        update_lesson_actions();
    });
    auto decision = [this](const QString &operation) {
        auto selected = lessons_->currentItem();
        if (!selected || selected->isHidden() || process_ || !review_allowed_ ||
            !lesson_confirm_->isChecked())
            return;
        const auto record = selected->data(0, Qt::UserRole).toJsonObject();
        if (record.value("status") != "pending" ||
            (operation == "approve" && !record.value("canApprove").toBool()))
            return;
        lesson_confirm_->setChecked(false);
        request(operation, {{"lessonId", record.value("id")},
                            {"fingerprint", record.value("fingerprint")},
                            {"reviewed", true}});
    };
    connect(lesson_approve_, &QPushButton::clicked, this, [decision] { decision("approve"); });
    connect(lesson_reject_, &QPushButton::clicked, this, [decision] { decision("reject"); });
    auto context_page = new QWidget;
    auto context_layout = new QVBoxLayout(context_page);
    context_layout->setContentsMargins(0, 12, 0, 0);
    auto context_split = new QHBoxLayout;
    context_split->setSpacing(18);
    QVBoxLayout *input_body, *preview_body;
    auto input_panel = studio::panel("Task input", &input_body);
    input_panel->setMaximumWidth(380);
    input_body->addWidget(studio::caption("Task"));
    task_ = new QLineEdit;
    task_->setObjectName("knowledgeTask");
    task_->setMaxLength(1000);
    task_->setPlaceholderText(project_caption("Describe the task to prepare external context"));
    task_->setProperty("uiPlaceholder", "Describe the task to prepare external context");
    task_->setAccessibleName("Task for knowledge context");
    input_body->addWidget(task_);
    input_body->addWidget(studio::caption("External model · policy-checked summaries", "muted"));
    skill_ = label({});
    skill_->setObjectName("knowledgeSkill");
    skill_->setProperty("verbatim", true);
    input_body->addWidget(skill_);
    input_body->addStretch();
    prepare_ = new QPushButton(project_caption("Prepare context"));
    prepare_->setProperty("uiCaption", "Prepare context");
    prepare_->setProperty("primary", true);
    prepare_->setObjectName("prepareKnowledgeContext");
    input_body->addWidget(prepare_);
    context_split->addWidget(input_panel, 1);
    auto preview_panel = studio::panel("Context preview", &preview_body);
    context_summary_ = new QTreeWidget;
    context_summary_->setObjectName("knowledgeContextSummary");
    context_summary_->setHeaderLabels({"Section", "Allowed summary"});
    context_summary_->setRootIsDecorated(true);
    context_summary_->header()->setSectionResizeMode(0, QHeaderView::ResizeToContents);
    context_summary_->header()->setStretchLastSection(true);
    preview_body->addWidget(context_summary_, 1);
    preview_ = new QPlainTextEdit;
    preview_->setReadOnly(true);
    preview_->setObjectName("knowledgeContextPreview");
    preview_->setMaximumHeight(170);
    preview_->hide();
    auto technical = new QCheckBox(project_caption("Technical details (JSON)"));
    technical->setProperty("uiCaption", "Technical details (JSON)");
    technical->setObjectName("knowledgeTechnicalDetails");
    preview_body->addWidget(technical);
    connect(technical, &QCheckBox::toggled, preview_, &QWidget::setVisible);
    preview_body->addWidget(preview_);
    auto exports = new QHBoxLayout;
    copy_ = new QPushButton(project_caption("Copy checked context"));
    copy_->setProperty("uiCaption", "Copy checked context");
    copy_->setObjectName("copyKnowledgeContext");
    export_ = new QPushButton(project_caption("Export checked context…"));
    export_->setProperty("uiCaption", "Export checked context…");
    export_->setObjectName("exportKnowledgeContext");
    exports->addWidget(copy_);
    exports->addWidget(export_);
    preview_body->addLayout(exports);
    context_split->addWidget(preview_panel, 2);
    context_layout->addLayout(context_split, 1);
    tabs_->addTab(context_page, "Task context");
    connect(prepare_, &QPushButton::clicked, this,
            [this] { request("context", {{"task", task_->text().trimmed()}}); });
    connect(task_, &QLineEdit::textChanged, this, [this] {
        context_.clear();
        copy_->setEnabled(false);
        export_->setEnabled(false);
        preview_->clear();
        context_summary_->clear();
    });
    connect(copy_, &QPushButton::clicked, this, [this] {
        if (!context_.isEmpty() && !secret_output(context_))
            QApplication::clipboard()->setText(context_);
    });
    connect(export_, &QPushButton::clicked, this, [this] {
        if (context_.isEmpty() || secret_output(context_))
            return;
        const auto filename = QFileDialog::getSaveFileName(this, project_caption("Export checked context…"),
                                                           {}, "Text (*.txt)");
        if (filename.isEmpty())
            return;
        QSaveFile file(filename);
        if (!file.open(QIODevice::WriteOnly) || file.write(context_.toUtf8()) != context_.toUtf8().size() ||
            !file.commit())
            set_status("Context export failed.");
    });
    connect(tabs_, &QTabWidget::currentChanged, this, [this] {
        auto page = tabs_->currentWidget();
        const bool separate_source = page && (page->property("referencePage").toBool() ||
                                              page->property("independentKnowledgeSource").toBool());
        if (separate_source) {
            banner_->hide();
            return;
        }
        if (page) {
            if (banner_->parentWidget() && banner_->parentWidget()->layout())
                banner_->parentWidget()->layout()->removeWidget(banner_);
            banner_->setParent(page);
            qobject_cast<QVBoxLayout *>(page->layout())->insertWidget(0, banner_);
            banner_->show();
        }
    });
    deadline_.setSingleShot(true);
    connect(&deadline_, &QTimer::timeout, this, [this] {
        cancel();
        fail("Knowledge request timed out. Reload to retry.");
    });
    clear_results();
    busy(false);
    set_status("Not connected");
}
KnowledgePanel::~KnowledgePanel() {
    cancel();
}
void KnowledgePanel::add_references(QWidget *page) {
    page->setProperty("referencePage", true);
    tabs_->insertTab(0, page, "References");
    tabs_->setCurrentIndex(0);
    banner_->hide();
}
void KnowledgePanel::add_drive(QWidget *page) {
    page->setProperty("independentKnowledgeSource", true);
    tabs_->addTab(page, "Google Drive");
}
void KnowledgePanel::show_details(QTreeWidget *tree, QLabel *title, QLabel *detail) {
    const auto item = tree->currentItem();
    if (!item || item->isHidden()) {
        title->setText(project_caption("Select a record for details."));
        detail->clear();
        return;
    }
    const auto record = item->data(0, Qt::UserRole).toJsonObject();
    title->setText(record.value("title").toString());
    title->setToolTip(title->text().toHtmlEscaped());
    QStringList lines{record.value("summary").toString()};
    if (!source_details_.isEmpty())
        lines << project_caption("Source") + ": " + source_details_[0];
    if (tree == map_)
        lines << project_caption("Visibility") + ": " + studio::enum_caption("public");
    if (tree == memories_)
        lines << project_caption("Visibility") + ": " +
                     studio::enum_caption(record.value("privacy").toString())
              << project_caption("Updated") + ": " + display_time(record.value("updatedAt").toString())
              << project_caption("Eligible only after task-context policy checks.");
    if (tree == memories_ && record.contains("zone"))
        lines << project_caption("Kind") + ": " + studio::enum_caption(record.value("zone").toString());
    if (tree == lessons_) {
        lines << project_caption("Review state") + ": " +
                     studio::enum_caption(record.value("status").toString());
        for (const auto &evidence : record.value("evidence").toArray()) {
            auto text = evidence.toString();
            for (const auto &[key, caption] :
                 std::vector<std::pair<QString, QString>>{{"command_exit_code", "Command result"},
                                                          {"test_passed", "Recorded check"},
                                                          {"privacy_check", "Privacy check"},
                                                          {"agent_summary", "Lesson summary"}})
                if (text.startsWith(key + ":")) {
                    text = project_caption(caption) + text.mid(key.size());
                    break;
                }
            lines << text;
        }
        lines << project_caption("Confidence: %1 · Last verified: %2")
                     .arg(record.value("confidence").toDouble())
                     .arg(record.value("lastVerifiedAt").isString()
                              ? display_time(record.value("lastVerifiedAt").toString())
                              : project_caption("Not recorded"));
        lines << project_caption(review_allowed_ ? "Review enabled for this session"
                                                 : "Lesson review is disabled for this session.");
    }
    detail->setText(lines.join("\n\n"));
}
void KnowledgePanel::filter_table(QTreeWidget *tree) {
    for (const auto &ui : table_ui_) {
        if (ui.tree != tree)
            continue;
        const auto query = ui.search->text().trimmed();
        int visible = 0;
        for (int index = 0; index < tree->topLevelItemCount(); ++index) {
            auto item = tree->topLevelItem(index);
            bool matches = query.isEmpty();
            for (int column = 0; column < tree->columnCount() && !matches; ++column)
                matches = item->text(column).contains(query, Qt::CaseInsensitive);
            item->setHidden(!matches);
            visible += matches;
        }
        if (tree->currentItem() && tree->currentItem()->isHidden()) {
            tree->clearSelection();
            tree->setCurrentItem(nullptr);
        }
        const bool table_connected = tree == map_ || memory_connected_;
        ui.count->setText(!snapshot_ready_   ? project_caption("Source not loaded")
                          : !table_connected ? project_caption("Memory storage is not connected.")
                                             : project_caption("Showing %1 of %2 allowed records")
                                                   .arg(visible)
                                                   .arg(tree->topLevelItemCount()));
        const auto empty_caption =
            !snapshot_ready_                 ? "No loaded knowledge snapshot. Connect or reload a source."
            : !table_connected               ? "Memory storage is not connected."
            : tree->topLevelItemCount() == 0 ? "No allowed records in this snapshot."
                                             : "No matching records. Clear the search to see this snapshot.";
        ui.empty->setText(project_caption(empty_caption));
        ui.empty->setVisible(visible == 0);
        if (visible == 0)
            ui.empty->raise();
        break;
    }
    if (tree == map_)
        show_details(tree, map_title_, map_detail_);
    else if (tree == memories_)
        show_details(tree, memory_title_, memory_detail_);
    else if (tree == lessons_) {
        show_details(tree, lesson_title_, lesson_detail_);
        update_lesson_actions();
    }
}
void KnowledgePanel::update_lesson_actions() {
    const auto item = lessons_->currentItem();
    const auto record = item ? item->data(0, Qt::UserRole).toJsonObject() : QJsonObject{};
    const bool allowed =
        item && !item->isHidden() && !process_ && review_allowed_ && record.value("status") == "pending";
    review_->setEnabled(allowed);
    lesson_confirm_->setEnabled(allowed);
    lesson_approve_->setEnabled(allowed && lesson_confirm_->isChecked() &&
                                record.value("canApprove").toBool());
    lesson_reject_->setEnabled(allowed && lesson_confirm_->isChecked());
}
void KnowledgePanel::set_status(const QString &key) {
    status_key_ = key;
    status_->setText(project_caption(key));
}
void KnowledgePanel::refresh_source() {
    if (source_root_.isEmpty()) {
        source_->clear();
        source_->setToolTip({});
    } else if (snapshot_ready_ && source_details_.size() == 3) {
        source_->setText(
            project_caption("Source: %1 · Compiled: %2 · Loaded: %3")
                .arg(source_details_[0], display_time(source_details_[1]), display_time(source_details_[2])));
    } else {
        const auto name = source_details_.isEmpty() ? QFileInfo(source_root_).fileName() : source_details_[0];
        source_->setText(project_caption("Selected source: %1 · not loaded").arg(name));
    }
    if (!source_root_.isEmpty())
        source_->setToolTip(source_root_.toHtmlEscaped());
}
void KnowledgePanel::translate_state() {
    // The shared banner moves between tabs; translate it even before it has
    // been inserted into the currently visible page.
    apply_project_captions(banner_);
    set_status(status_key_);
    const auto skill_caption = project_caption(skill_key_);
    skill_->setText(skill_caption.contains("%1") ? skill_caption.arg(skill_value_) : skill_caption);
    refresh_source();
    for (int i = 0; i < lessons_->topLevelItemCount(); ++i) {
        auto item = lessons_->topLevelItem(i);
        item->setText(
            2, studio::enum_caption(item->data(0, Qt::UserRole).toJsonObject().value("status").toString()));
    }
    for (int i = 0; i < memories_->topLevelItemCount(); ++i) {
        auto item = memories_->topLevelItem(i);
        const auto record = item->data(0, Qt::UserRole).toJsonObject();
        item->setText(2, studio::enum_caption(record.value("privacy").toString()));
    }
    for (int i = 0; i < map_->topLevelItemCount(); ++i) {
        auto item = map_->topLevelItem(i);
        item->setText(
            0, studio::enum_caption(item->data(0, Qt::UserRole).toJsonObject().value("kind").toString()));
    }
    for (const auto &ui : table_ui_)
        filter_table(ui.tree);
    show_details(map_, map_title_, map_detail_);
    show_details(memories_, memory_title_, memory_detail_);
    show_details(lessons_, lesson_title_, lesson_detail_);
}
void KnowledgePanel::busy(bool value) {
    connect_->setEnabled(!value && !project_id_.isEmpty());
    cancel_->setEnabled(value);
    cancel_->setVisible(value);
    reload_->setEnabled(!value && !source_root_.isEmpty());
    reload_->setVisible(!source_root_.isEmpty());
    prepare_->setEnabled(!value && snapshot_ready_);
    review_->setEnabled(false);
    task_->setEnabled(!value);
    copy_->setEnabled(!value && !context_.isEmpty());
    export_->setEnabled(copy_->isEnabled());
    update_lesson_actions();
}
void KnowledgePanel::clear_results() {
    snapshot_ready_ = false;
    memory_connected_ = false;
    refresh_source();
    map_->clear();
    memories_->clear();
    lessons_->clear();
    preview_->clear();
    context_summary_->clear();
    lesson_confirm_->setChecked(false);
    for (const auto &entry : {std::pair{map_title_, map_detail_}, std::pair{memory_title_, memory_detail_},
                              std::pair{lesson_title_, lesson_detail_}}) {
        entry.first->setText(project_caption("Select a record for details."));
        entry.second->clear();
    }
    context_.clear();
    review_allowed_ = false;
    skill_key_ = "Skill routing not requested";
    skill_value_.clear();
    skill_->setText(project_caption(skill_key_));
    copy_->setEnabled(false);
    export_->setEnabled(false);
    review_->setEnabled(false);
    for (const auto &ui : table_ui_)
        filter_table(ui.tree);
}
void KnowledgePanel::cancel() {
    deadline_.stop();
    if (process_) {
        auto old = process_;
        process_ = nullptr;
        old->disconnect(this);
        old->kill();
        old->waitForFinished(1000);
        old->deleteLater();
    }
    output_.clear();
    busy(false);
}
void KnowledgePanel::bind_project(const QString &id, bool changed) {
    if (id == project_id_ && !changed) {
        translate_state();
        return;
    }
    cancel();
    clear_results();
    if (id != project_id_) {
        source_root_.clear();
        source_id_.clear();
        source_details_.clear();
        source_->clear();
        task_->clear();
        for (const auto &ui : table_ui_)
            ui.search->clear();
    }
    project_id_ = id;
    refresh_source();
    busy(false);
    set_status(source_root_.isEmpty() ? "Not connected"
                                      : "Document changed. Reload knowledge before exporting context.");
}
void KnowledgePanel::connect_source(const QString &root) {
    cancel();
    clear_results();
    source_id_.clear();
    const auto next_root = QFileInfo(root).canonicalFilePath();
    if (next_root != source_root_)
        for (const auto &ui : table_ui_)
            ui.search->clear();
    source_root_ = next_root;
    source_details_.clear();
    refresh_source();
    request("snapshot");
}
void KnowledgePanel::fail(const QString &message) {
    clear_results();
    busy(false);
    set_status(message);
}
void KnowledgePanel::request(const QString &operation, const QJsonObject &extra) {
    if (process_ || project_id_.isEmpty() || source_root_.isEmpty())
        return;
    const auto node = QFileInfo(qEnvironmentVariable("LMTI_STUDIO_NODE_BINARY"));
    const auto cli = QFileInfo(qEnvironmentVariable("LMTI_STUDIO_CLI"));
    if (!node.isAbsolute() || !node.isFile() || !node.isExecutable() || !cli.isAbsolute() || !cli.isFile() ||
        cli.fileName() != "index.js") {
        fail("Knowledge runtime not configured. Configure the trusted launcher.");
        return;
    }
    QJsonObject input = extra;
    input.insert("schema", "lmti.desktop.knowledge.v1");
    input.insert("operation", operation);
    input.insert("projectId", project_id_);
    input.insert("sourceRoot", source_root_);
    input.insert("sourceId", source_id_);
    input.insert("target", "external");
    if (operation == "context" && (task_->text().trimmed().isEmpty() || secret_output(task_->text()))) {
        context_.clear();
        preview_->clear();
        context_summary_->clear();
        copy_->setEnabled(false);
        export_->setEnabled(false);
        task_->setFocus();
        set_status("Use a nonsecret task description.");
        return;
    }
    clear_results();
    busy(true);
    set_status("Loading knowledge…");
    auto process = process_ = new QProcess(this);
    output_.clear();
    const auto launcher = QProcessEnvironment::systemEnvironment();
    QProcessEnvironment env;
    for (const auto &name : {"SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"})
        if (launcher.contains(name))
            env.insert(name, launcher.value(name));
    env.insert("LMTI_STUDIO_ALLOW_LESSON_REVIEW", launcher.value("LMTI_STUDIO_ALLOW_LESSON_REVIEW", "0"));
    process->setProcessEnvironment(env);
    process->setWorkingDirectory(cli.absolutePath());
    connect(process, &QProcess::readyReadStandardOutput, this, [this, process] {
        output_ += process->readAllStandardOutput();
        if (output_.size() > output_limit) {
            cancel();
            fail("Knowledge output exceeded the limit.");
        }
    });
    connect(process, &QProcess::readyReadStandardError, this, [process] { process->readAllStandardError(); });
    connect(process, &QProcess::errorOccurred, this, [this, process](QProcess::ProcessError error) {
        if (process_ == process && error == QProcess::FailedToStart) {
            cancel();
            fail("Knowledge runtime could not start.");
        }
    });
    connect(process, &QProcess::finished, this, [this, process](int code, QProcess::ExitStatus state) {
        if (process_ != process)
            return;
        deadline_.stop();
        output_ += process->readAllStandardOutput();
        process_ = nullptr;
        process->deleteLater();
        const auto bytes = std::move(output_);
        output_.clear();
        try {
            QJsonParseError error;
            const auto doc = QJsonDocument::fromJson(bytes, &error);
            if (bytes.size() > output_limit || code || state != QProcess::NormalExit ||
                error.error != QJsonParseError::NoError || !doc.isObject())
                throw std::runtime_error("Adapter denied");
            receive(doc.object());
        } catch (...) {
            fail("Knowledge unavailable or denied by source policy. Check source identity and runtime.");
        }
        busy(false);
    });
    process->start(node.canonicalFilePath(), {cli.canonicalFilePath(), "desktop-bridge"});
    process->write(QJsonDocument(input).toJson(QJsonDocument::Compact));
    process->closeWriteChannel();
    deadline_.start(10000);
}
void KnowledgePanel::receive(const QJsonObject &response) {
    if (response.value("schema") != "lmti.desktop.knowledge.v1" ||
        response.value("projectId") != project_id_ || response.value("target") != "external")
        throw std::runtime_error("Wrong scope");
    for (const auto &flag : {"canReview", "truncated", "memoryConnected"})
        if (!response.value(flag).isBool())
            throw std::runtime_error("Invalid adapter flags");
    if (!response.value("memoryConnected").toBool() &&
        (!response.value("memories").toArray().isEmpty() || !response.value("lessons").toArray().isEmpty()))
        throw std::runtime_error("Invalid memory connection state");
    const auto identity = checked_text(response.value("sourceId"), 64);
    if (!QRegularExpression("^[a-f0-9]{64}$").match(identity).hasMatch() ||
        (!source_id_.isEmpty() && identity != source_id_))
        throw std::runtime_error("Wrong identity");
    const auto context = checked_text(response.value("context"), output_limit);
    // Validate all fields before showing any part of the response.
    for (const auto &category : {"projectMap", "memories", "lessons"}) {
        const auto value = response.value(category);
        if (!value.isArray() || value.toArray().size() > 200)
            throw std::runtime_error("Invalid records");
        for (const auto &entry : value.toArray()) {
            if (!entry.isObject())
                throw std::runtime_error("Invalid record");
            const auto row = entry.toObject();
            checked_text(row.value("title"), 240);
            checked_text(row.value("summary"));
            if (QString(category) == "projectMap")
                checked_text(row.value("kind"), 80);
            if (QString(category) == "memories") {
                if (row.contains("zone"))
                    checked_text(row.value("zone"), 80);
                const auto privacy = checked_text(row.value("privacy"), 32);
                if (!QStringList{"public", "internal", "private"}.contains(privacy))
                    throw std::runtime_error("Denied memory");
                checked_text(row.value("updatedAt"), 80);
            }
            if (QString(category) == "lessons") {
                const auto status = checked_text(row.value("status"), 16);
                if (!QStringList{"pending", "approved", "rejected"}.contains(status) ||
                    !row.value("evidence").isArray() || row.value("evidence").toArray().size() > 12)
                    throw std::runtime_error("Invalid lesson");
                checked_text(row.value("id"), 120);
                checked_text(row.value("fingerprint"), 64);
                if (!row.value("canApprove").isBool() || !row.value("confidence").isDouble() ||
                    !std::isfinite(row.value("confidence").toDouble()) ||
                    row.value("confidence").toDouble() < 0 || row.value("confidence").toDouble() > 1)
                    throw std::runtime_error("Invalid lesson evidence state");
                if (!row.value("lastVerifiedAt").isNull())
                    checked_text(row.value("lastVerifiedAt"), 80);
                for (const auto &evidence : row.value("evidence").toArray())
                    checked_text(evidence, 2000);
            }
        }
    }
    checked_text(response.value("sourceName"), 240);
    checked_text(response.value("compiledAt"), 80);
    checked_text(response.value("fetchedAt"), 80);
    QJsonObject prepared;
    if (!context.isEmpty()) {
        QJsonParseError error;
        auto doc = QJsonDocument::fromJson(context.toUtf8(), &error);
        if (error.error != QJsonParseError::NoError || !doc.isObject())
            throw std::runtime_error("Invalid context");
        prepared = doc.object();
        if (prepared.value("schema") != response.value("schema") ||
            prepared.value("projectId") != project_id_ || prepared.value("sourceId") != identity ||
            prepared.value("target") != "external" || prepared.value("task") != task_->text().trimmed() ||
            prepared.value("projectMap") != response.value("projectMap") ||
            prepared.value("memories") != response.value("memories"))
            throw std::runtime_error("Wrong context scope");
    }
    if (response.value("skill").isObject()) {
        auto skill = response.value("skill").toObject();
        const auto decision = checked_text(skill.value("decision"), 80);
        if (skill.contains("selected")) {
            if (!skill.value("executed").isBool() || skill.value("executed").toBool())
                throw std::runtime_error("Invalid skill state");
            skill_value_ = checked_text(skill.value("selected"), 120);
        }
        skill_key_ = !skill_value_.isEmpty()       ? "Skill recommendation: %1 · not executed"
                     : decision == "not_requested" ? "Skill routing not requested"
                                                   : "Skill routing unavailable or no matching skill";
    }
    source_id_ = identity;
    snapshot_ready_ = true;
    memory_connected_ = response.value("memoryConnected").toBool();
    source_details_ = {response.value("sourceName").toString(), response.value("compiledAt").toString(),
                       response.value("fetchedAt").toString()};
    for (const auto &entry : response.value("projectMap").toArray()) {
        auto r = entry.toObject();
        auto item = new QTreeWidgetItem(map_, {studio::enum_caption(r.value("kind").toString()),
                                               r.value("title").toString(), r.value("summary").toString()});
        item->setData(0, Qt::UserRole, r);
        item->setToolTip(2, r.value("summary").toString().toHtmlEscaped());
    }
    for (const auto &entry : response.value("memories").toArray()) {
        auto r = entry.toObject();
        auto item =
            new QTreeWidgetItem(memories_, {r.value("title").toString(), r.value("summary").toString(),
                                            studio::enum_caption(r.value("privacy").toString()),
                                            display_time(r.value("updatedAt").toString())});
        item->setData(0, Qt::UserRole, r);
        item->setToolTip(1, r.value("summary").toString().toHtmlEscaped());
        item->setToolTip(3, r.value("updatedAt").toString().toHtmlEscaped());
        item->setData(2, studio::badge_role, r.value("privacy"));
    }
    for (const auto &entry : response.value("lessons").toArray()) {
        auto r = entry.toObject();
        auto item = new QTreeWidgetItem(lessons_, {r.value("title").toString(), r.value("summary").toString(),
                                                   studio::enum_caption(r.value("status").toString())});
        item->setData(0, Qt::UserRole, r);
        item->setData(2, studio::badge_role, r.value("status"));
    }
    review_allowed_ = qEnvironmentVariable("LMTI_STUDIO_ALLOW_LESSON_REVIEW") == "1" &&
                      response.value("canReview").toBool();
    context_ = context;
    preview_->setPlainText(context_);
    context_summary_->clear();
    if (!prepared.isEmpty()) {
        auto project =
            new QTreeWidgetItem(context_summary_, {project_caption("Project summary"), source_details_[0]});
        new QTreeWidgetItem(project, {project_caption("Task"), task_->text().trimmed()});
        new QTreeWidgetItem(project,
                            {project_caption("Sharing"), project_caption("Policy-checked summaries only")});
        auto modules = new QTreeWidgetItem(context_summary_, {project_caption("Relevant modules"), ""});
        for (const auto &entry : prepared.value("projectMap").toArray()) {
            const auto record = entry.toObject();
            new QTreeWidgetItem(modules,
                                {record.value("title").toString(), record.value("summary").toString()});
        }
        auto memories = new QTreeWidgetItem(context_summary_, {project_caption("Relevant memory"), ""});
        auto lessons = new QTreeWidgetItem(context_summary_, {project_caption("Approved lessons"), ""});
        for (const auto &entry : prepared.value("memories").toArray()) {
            const auto record = entry.toObject();
            new QTreeWidgetItem(record.value("zone") == "lesson" ? lessons : memories,
                                {record.value("title").toString(), record.value("summary").toString()});
        }
        context_summary_->expandAll();
    }
    set_status(response.value("truncated").toBool() ? "Loaded a bounded snapshot. Some records were omitted."
               : response.value("memoryConnected").toBool()
                   ? "Loaded policy-checked summaries. Pending lessons are excluded from context."
                   : "Project map loaded. Memory storage is not connected.");
    translate_state();
}
void KnowledgePanel::review_lesson() {
    auto selected = lessons_->currentItem();
    if (!selected || selected->isHidden() || process_ || !review_allowed_)
        return;
    const auto lesson = selected->data(0, Qt::UserRole).toJsonObject();
    if (lesson.value("status") != "pending")
        return;
    QDialog dialog(this);
    dialog.setObjectName("lessonReviewDialog");
    dialog.setWindowTitle(project_caption("Review lesson"));
    auto layout = new QVBoxLayout(&dialog);
    layout->addWidget(label(lesson.value("title").toString()));
    layout->addWidget(label(lesson.value("summary").toString()));
    QStringList evidence;
    for (const auto &entry : lesson.value("evidence").toArray())
        evidence << entry.toString();
    layout->addWidget(label(project_caption("Evidence") + "\n" + evidence.join("\n")));
    layout->addWidget(
        label(project_caption("Confidence: %1 · Last verified: %2")
                  .arg(lesson.value("confidence").toDouble())
                  .arg(lesson.value("lastVerifiedAt").isString() ? lesson.value("lastVerifiedAt").toString()
                                                                 : project_caption("Not recorded"))));
    layout->addWidget(label(project_caption(
        "Approval stores a reviewed lesson. It does not claim that suggested verification was executed.")));
    auto confirm =
        new studio::WrapCheckBox(project_caption("I reviewed the evidence and privacy of this lesson."));
    confirm->setObjectName("lessonEvidenceReviewed");
    layout->addWidget(confirm);
    auto buttons = new QDialogButtonBox(QDialogButtonBox::Cancel);
    auto approve = buttons->addButton(project_caption("Approve lesson"), QDialogButtonBox::AcceptRole);
    approve->setObjectName("approveLesson");
    approve->setEnabled(false);
    auto reject = buttons->addButton(project_caption("Reject lesson"), QDialogButtonBox::DestructiveRole);
    reject->setObjectName("rejectLesson");
    reject->setEnabled(false);
    layout->addWidget(buttons);
    QString decision;
    connect(confirm, &QCheckBox::toggled, &dialog, [approve, reject, lesson](bool checked) {
        approve->setEnabled(checked && lesson.value("canApprove").toBool());
        reject->setEnabled(checked);
    });
    connect(approve, &QPushButton::clicked, &dialog, [&] {
        decision = "approve";
        dialog.accept();
    });
    connect(reject, &QPushButton::clicked, &dialog, [&] {
        decision = "reject";
        dialog.accept();
    });
    connect(buttons, &QDialogButtonBox::rejected, &dialog, &QDialog::reject);
    if (dialog.exec() == QDialog::Accepted && !decision.isEmpty())
        request(decision, {{"lessonId", lesson.value("id")},
                           {"fingerprint", lesson.value("fingerprint")},
                           {"reviewed", true}});
}
