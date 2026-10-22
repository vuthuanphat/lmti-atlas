#include "project_settings_view.hpp"
#include "project_captions.hpp"
#include "studio_widgets.hpp"
#include "workspace_tabs.hpp"
#include <QDesktopServices>
#include <QFileInfo>
#include <QFormLayout>
#include <QHBoxLayout>
#include <QSignalBlocker>
#include <QTabWidget>
#include <QUrl>

ProjectSettingsView::ProjectSettingsView(QWidget *parent) : QWidget(parent) {
    setObjectName("projectSettingsPage");
    auto outer = new QVBoxLayout(this);
    outer->setContentsMargins(0, 0, 0, 0);
    auto tabs = new WorkspaceTabs;
    tabs->setObjectName("projectSettingsTabs");
    auto general = new QWidget;
    auto row = new QHBoxLayout(general);
    row->setContentsMargins(0, 14, 0, 0);
    row->setSpacing(18);
    QVBoxLayout *body;
    auto panel = studio::panel("Project information", &body);
    body->addWidget(studio::caption("Basic details used across this workspace.", "muted"));
    auto fields = new QFormLayout;
    fields->setVerticalSpacing(22);
    fields->setFieldGrowthPolicy(QFormLayout::AllNonFixedFieldsGrow);
    auto field = [fields](const QString &label, const QString &name, int limit, bool read_only = false) {
        auto widget = new QLineEdit;
        widget->setObjectName(name);
        widget->setMaxLength(limit);
        widget->setReadOnly(read_only);
        fields->addRow(studio::caption(label), widget);
        return widget;
    };
    name_ = field("Name", "settingsName", 120);
    goal_ = field("Goal", "settingsGoal", 512);
    visibility_ = new studio::Choice;
    visibility_->setObjectName("settingsVisibility");
    visibility_->addItem(studio::enum_caption("internal"), "internal");
    visibility_->addItem(studio::enum_caption("public"), "public");
    visibility_->setProperty("uiChoices", QStringList{"Internal", "Public"});
    fields->addRow(studio::caption("Visibility"), visibility_);
    auto policy = studio::caption("Internal metadata is excluded from public Agent context. Visibility is a "
                                  "data policy, not OS access control.",
                                  "muted");
    fields->addRow(policy);
    id_ = field("Project identifier", "settingsProjectId", 64, true);
    revision_ = field("Saved revision", "settingsRevision", 32, true);
    body->addLayout(fields);
    body->addStretch();
    error_ = new QLabel;
    error_->setTextFormat(Qt::PlainText);
    error_->setWordWrap(true);
    error_->setObjectName("settingsError");
    error_->setProperty("verbatim", true);
    error_->setStyleSheet("color:#b91c1c;background:transparent;");
    error_->hide();
    body->addWidget(error_);
    row->addWidget(panel, 2);
    QVBoxLayout *local_body;
    auto local = studio::panel("Local files", &local_body);
    local_body->addWidget(studio::caption("Manage the folder reference from Local files. Linking a folder "
                                          "does not scan source or grant Agent access.",
                                          "muted"));
    auto local_button = new QPushButton(project_caption("Open Local files"));
    local_button->setProperty("uiCaption", "Open Local files");
    connect(local_button, &QPushButton::clicked, this, [tabs] { tabs->setCurrentIndex(1); });
    local_body->addWidget(local_button);
    local_body->addStretch();
    row->addWidget(local, 1);
    tabs->addTab(general, "General");
    auto files = new QWidget;
    auto file_layout = new QVBoxLayout(files);
    file_layout->setContentsMargins(0, 14, 0, 0);
    QVBoxLayout *file_body;
    auto files_panel = studio::panel("Local project folder", &file_body);
    folder_ = new QLineEdit;
    folder_->setObjectName("settingsFolder");
    folder_->setReadOnly(true);
    file_body->addWidget(folder_);
    file_body->addWidget(studio::caption(
        "This is a local folder reference. Removing a library entry does not delete the folder or source.",
        "muted"));
    auto buttons = new QHBoxLayout;
    auto choose = new QPushButton(project_caption("Choose project folder…"));
    choose->setProperty("uiCaption", "Choose project folder…");
    choose->setObjectName("settingsChooseFolder");
    connect(choose, &QPushButton::clicked, this, [this] {
        if (choose_folder)
            choose_folder();
    });
    open_folder_ = new QPushButton(project_caption("Open folder on this computer"));
    open_folder_->setProperty("uiCaption", "Open folder on this computer");
    connect(open_folder_, &QPushButton::clicked, this, [this] {
        if (!folder_path_.isEmpty() && QFileInfo(folder_path_).isDir() &&
            !QFileInfo(folder_path_).isSymLink())
            QDesktopServices::openUrl(QUrl::fromLocalFile(folder_path_));
    });
    buttons->addWidget(choose);
    buttons->addWidget(open_folder_);
    buttons->addStretch();
    file_body->addLayout(buttons);
    file_layout->addWidget(files_panel);
    file_layout->addStretch();
    tabs->addTab(files, "Local files");
    outer->addWidget(tabs, 1);
    auto footer = new QHBoxLayout;
    apply_ = new QPushButton(project_caption("Apply to draft"));
    apply_->setProperty("uiCaption", "Apply to draft");
    apply_->setProperty("primary", true);
    apply_->setObjectName("applyProjectSettings");
    auto cancel = new QPushButton(project_caption("Cancel"));
    cancel->setProperty("uiCaption", "Cancel");
    cancel->setObjectName("cancelProjectSettings");
    connect(apply_, &QPushButton::clicked, this, [this] { apply(); });
    connect(cancel, &QPushButton::clicked, this, [this] { revert(); });
    footer->addWidget(apply_);
    footer->addWidget(cancel);
    footer->addStretch();
    outer->addLayout(footer);
    outer->addWidget(studio::caption("Apply edits the draft; Save persists the project.", "muted"));
    connect(name_, &QLineEdit::textChanged, this, [this] { update_pending(); });
    connect(goal_, &QLineEdit::textChanged, this, [this] { update_pending(); });
    connect(visibility_, &QComboBox::currentIndexChanged, this, [this] { update_pending(); });
}
bool ProjectSettingsView::pending() const {
    return name_->text().trimmed().toStdString() != baseline_.label ||
           goal_->text().trimmed().toStdString() != baseline_.goal ||
           visibility_->currentData().toString().toStdString() != lmti::name(baseline_.privacy);
}
void ProjectSettingsView::update_pending() {
    apply_->setEnabled(pending());
    if (changed)
        changed();
}
void ProjectSettingsView::revert() {
    QSignalBlocker name_block(name_), goal_block(goal_), privacy_block(visibility_);
    name_->setText(QString::fromStdString(baseline_.label));
    goal_->setText(QString::fromStdString(baseline_.goal));
    visibility_->setCurrentIndex(
        visibility_->findData(QString::fromStdString(lmti::name(baseline_.privacy))));
    error_->hide();
    update_pending();
}
void ProjectSettingsView::bind(const lmti::ProjectInfo &info, std::int64_t revision, const QString &folder) {
    const bool different = info != baseline_;
    baseline_ = info;
    if (different)
        revert();
    id_->setText(QString::fromStdString(info.id));
    revision_->setText(QString::number(revision));
    folder_path_ = folder;
    folder_->setText(folder.isEmpty() ? project_caption("No folder linked") : QFileInfo(folder).fileName());
    folder_->setToolTip(folder);
    open_folder_->setEnabled(!folder.isEmpty() && QFileInfo(folder).isDir() &&
                             !QFileInfo(folder).isSymLink());
}
bool ProjectSettingsView::apply() {
    auto next = baseline_;
    next.label = name_->text().trimmed().toStdString();
    next.goal = goal_->text().trimmed().toStdString();
    try {
        next.privacy = lmti::parse_privacy(visibility_->currentData().toString().toStdString());
        if (!submit)
            return false;
        submit(next);
        baseline_ = next;
        error_->hide();
        update_pending();
        return true;
    } catch (const std::exception &exception) {
        error_->setText(QString::fromUtf8(exception.what()));
        error_->show();
        auto focus = name_;
        try {
            // Use the same typed validator to distinguish a bad name from a bad
            // goal, including UTF-8 byte limits that differ from Qt character limits.
            lmti::ProjectDocument probe;
            probe.project = baseline_;
            probe.project.label = next.label;
            lmti::validate(probe);
            focus = goal_;
        } catch (const std::exception &) {
        }
        focus->setFocus();
        return false;
    }
}
