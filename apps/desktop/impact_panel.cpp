#include "impact_panel.hpp"
#include "project_captions.hpp"
#include "project_language.hpp"
#include "studio_widgets.hpp"
#include <QCoreApplication>
#include <QDialog>
#include <QDialogButtonBox>
#include <QDir>
#include <QFileDialog>
#include <QFileInfo>
#include <QFormLayout>
#include <QHeaderView>
#include <QJsonArray>
#include <QJsonDocument>
#include <QMap>
#include <QMessageBox>
#include <QProcessEnvironment>
#include <QRegularExpression>
#include <QScrollBar>
#include <QSignalBlocker>
#include <QSplitter>
#include <QVBoxLayout>
#include <algorithm>
#include <stdexcept>

namespace {
constexpr qsizetype output_limit = 2 * 1024 * 1024;
constexpr int caption_role = Qt::UserRole + 120, finding_role = Qt::UserRole + 121;
static_assert(caption_role != studio::badge_role && finding_role != studio::badge_role);
void display(QTreeWidgetItem *item, int column, const QString &raw) {
    item->setData(column, caption_role, raw);
    item->setText(column, impact_caption(raw));
    item->setToolTip(column, impact_caption(raw).toHtmlEscaped());
}
QLabel *label(const QString &text) {
    auto item = new QLabel(project_caption(text));
    item->setTextFormat(Qt::PlainText);
    item->setWordWrap(true);
    item->setProperty("uiCaption", text);
    return item;
}
QPushButton *button(const char *name, const QString &text, QBoxLayout *layout) {
    auto item = new QPushButton(project_caption(text));
    item->setObjectName(name);
    item->setProperty("uiCaption", text);
    layout->addWidget(item);
    return item;
}
QTreeWidget *table(const char *name, const QStringList &headers, QBoxLayout *layout) {
    auto tree = new QTreeWidget;
    tree->setObjectName(name);
    tree->setHeaderLabels(headers);
    studio::inventory(tree);
    tree->setSelectionMode(QAbstractItemView::SingleSelection);
    tree->header()->setSectionResizeMode(QHeaderView::Stretch);
    tree->setMinimumHeight(90);
    layout->addWidget(tree, 1);
    return tree;
}
QString value(const QJsonObject &object, const char *key) {
    const auto v = object.value(key);
    if (!v.isString() || v.toString().size() > 8000)
        throw std::runtime_error("Invalid impact text");
    return v.toString();
}
QJsonArray rows(const QJsonObject &object, const char *key, int max = 10000) {
    const auto v = object.value(key);
    if (!v.isArray() || v.toArray().size() > max)
        throw std::runtime_error("Invalid impact rows");
    return v.toArray();
}
QString selected(QTreeWidget *tree) {
    return tree->currentItem() ? tree->currentItem()->data(0, Qt::UserRole).toString() : QString{};
}
QString strings(const QJsonArray &array) {
    QStringList result;
    for (const auto &item : array)
        if (item.isString())
            result << item.toString();
    return result.join("; ");
}
QString finding_details(const QJsonObject &finding, const QJsonObject &snapshot) {
    QStringList path;
    for (const auto &step : finding.value("path").toArray()) {
        const auto edge = step.toObject();
        path << edge.value("fromId").toString() + " → " + edge.value("toId").toString() + " · " +
                    impact_caption(edge.value("predicate").toString()) + " · " +
                    impact_caption(edge.value("freshness").toString()) + " · " +
                    strings(edge.value("evidenceIds").toArray());
        for (const auto &evidence : snapshot.value("evidence").toArray()) {
            const auto record = evidence.toObject().value("record").toObject();
            if (edge.value("evidenceIds").toArray().contains(record.value("id")))
                path << record.value("summary").toString() + " · " + record.value("locator").toString();
        }
    }
    return path.join('\n');
}
} // namespace

ImpactPanel::ImpactPanel(QWidget *parent) : QWidget(parent) {
    setObjectName("impactPanel");
    auto body = new QVBoxLayout(this);
    body->setContentsMargins(12, 8, 12, 8);
    auto toolbar = new QHBoxLayout;
    connect_ = button("impactConnect", "Connect review workspace…", toolbar);
    create_ = button("impactCreate", "Create review workspace…", toolbar);
    reload_ = button("impactReload", "Recheck sources", toolbar);
    cancel_ = button("impactCancel", "Cancel", toolbar);
    toolbar->addStretch();
    body->addLayout(toolbar);
    status_ = label("Save the project to review changes.");
    status_->setObjectName("impactStatus");
    status_->setProperty("verbatim", true);
    source_ = label("");
    source_->setProperty("verbatim", true);
    body->addWidget(status_);
    body->addWidget(source_);
    tabs_ = new QTabWidget;
    tabs_->setObjectName("impactTabs");
    body->addWidget(tabs_, 1);

    auto source_page = new QWidget;
    auto source_body = new QVBoxLayout(source_page);
    auto source_actions = new QHBoxLayout;
    upgrade_ = button("impactUpgrade", "Enable verification history…", source_actions);
    import_ = button("impactImport", "Stage project changes", source_actions);
    source_actions->addStretch();
    source_body->addLayout(source_actions);
    sources_ = table("impactSources", {"Source", "Revision", "Freshness"}, source_body);
    imports_ = table("impactImports", {"Source", "State", "Added", "Changed", "Removed"}, source_body);
    auto review_actions = new QHBoxLayout;
    preview_button_ = button("impactPreview", "Inspect changes", review_actions);
    accept_ = button("impactAccept", "Accept", review_actions);
    reject_ = button("impactReject", "Reject", review_actions);
    review_actions->addStretch();
    source_body->addLayout(review_actions);
    import_confirm_ = new QCheckBox("I reviewed the declared metadata and its evidence.");
    import_confirm_->setObjectName("impactImportConfirmation");
    source_body->addWidget(import_confirm_);
    import_details_ = new QPlainTextEdit;
    import_details_->setObjectName("impactImportDetails");
    import_details_->setReadOnly(true);
    import_details_->setMaximumHeight(125);
    source_body->addWidget(import_details_);
    tabs_->addTab(source_page, "Sources");

    auto report_page = new QWidget;
    auto report_body = new QVBoxLayout(report_page);
    auto form = new QFormLayout;
    entity_ = new QComboBox;
    entity_->setObjectName("impactEntity");
    category_ = new QComboBox;
    category_->setObjectName("impactCategory");
    for (const auto &key : {"contract", "code", "config", "version", "availability", "unknown"})
        category_->addItem(key, key);
    description_ = new QLineEdit;
    description_->setObjectName("impactDescription");
    description_->setMaxLength(2000);
    baseline_ = new QLineEdit;
    baseline_->setObjectName("impactBaseline");
    baseline_->setMaxLength(160);
    proposed_ = new QLineEdit;
    proposed_->setObjectName("impactProposed");
    proposed_->setMaxLength(160);
    form->addRow(label("Changed component"), entity_);
    form->addRow(label("Change category"), category_);
    form->addRow(label("Change description"), description_);
    auto revisions = new QHBoxLayout;
    revisions->addWidget(baseline_);
    revisions->addWidget(label("Proposed revision"));
    revisions->addWidget(proposed_);
    form->addRow(label("Baseline revision"), revisions);
    report_body->addLayout(form);
    auto saved_actions = new QHBoxLayout;
    saved_reports_ = new QComboBox;
    saved_reports_->setObjectName("impactSavedReports");
    saved_reports_->setMinimumContentsLength(16);
    saved_reports_->setMaximumWidth(270);
    saved_actions->addWidget(saved_reports_);
    report_id_ = new QLineEdit;
    report_id_->setObjectName("impactReportId");
    report_id_->setMaxLength(100);
    report_id_->setPlaceholderText("Saved report ID");
    saved_actions->addWidget(report_id_, 1);
    open_report_ = button("impactOpenReport", "Open saved report", saved_actions);
    report_body->addLayout(saved_actions);
    targets_ = table("impactTargets", {"Planned rollout targets"}, report_body);
    targets_->setMaximumHeight(95);
    auto report_actions = new QHBoxLayout;
    report_button_ = button("impactReport", "Review impact", report_actions);
    save_report_ = button("impactSaveReport", "Save review report", report_actions);
    report_actions->addStretch();
    report_body->addLayout(report_actions);
    findings_ = table("impactFindings", {"Name", "Disposition", "Reason"}, report_body);
    details_ = new QPlainTextEdit;
    details_->setObjectName("impactDetails");
    details_->setReadOnly(true);
    details_->setMaximumHeight(140);
    report_body->addWidget(details_);
    tabs_->addTab(report_page, "Impact");

    auto verify_page = new QWidget;
    auto verify_body = new QVBoxLayout(verify_page);
    verify_body->addWidget(
        label("Record human verification against a saved report. This does not authorize deployment."));
    checklist_ = table("impactChecklist", {"Verification", "Owner", "Result"}, verify_body);
    auto evidence_form = new QFormLayout;
    evidence_summary_ = new QLineEdit;
    evidence_summary_->setObjectName("impactEvidenceSummary");
    evidence_summary_->setMaxLength(1000);
    evidence_ref_ = new QLineEdit;
    evidence_ref_->setObjectName("impactEvidenceRef");
    evidence_ref_->setMaxLength(512);
    verification_status_ = new QComboBox;
    verification_status_->setObjectName("impactVerificationStatus");
    for (const auto &key : {"verified", "failed", "pending"})
        verification_status_->addItem(impact_caption(key), key);
    evidence_form->addRow(label("Evidence summary"), evidence_summary_);
    evidence_form->addRow(label("Evidence reference"), evidence_ref_);
    evidence_form->addRow(label("Result"), verification_status_);
    verify_body->addLayout(evidence_form);
    verify_confirm_ = new QCheckBox("I performed or reviewed this verification.");
    verify_confirm_->setObjectName("impactVerificationConfirmation");
    verify_body->addWidget(verify_confirm_);
    auto verify_actions = new QHBoxLayout;
    verify_ = button("impactVerify", "Record verification", verify_actions);
    verify_actions->addStretch();
    verify_body->addLayout(verify_actions);
    tabs_->addTab(verify_page, "Verification");
    auto history_page = new QWidget;
    auto history_body = new QVBoxLayout(history_page);
    history_ = table("impactHistory", {"Event", "Reviewer", "Time", "Evidence"}, history_body);
    tabs_->addTab(history_page, "History");

    connect(connect_, &QPushButton::clicked, this, [this] {
        const auto path = QFileDialog::getOpenFileName(this, project_caption("Connect review workspace…"), {},
                                                       "Review workspace (launcher.json)");
        if (!path.isEmpty())
            connect_workspace(path);
    });
    connect(create_, &QPushButton::clicked, this, [this] { setup_dialog(); });
    connect(reload_, &QPushButton::clicked, this, [this] { request("overview"); });
    connect(cancel_, &QPushButton::clicked, this, [this] {
        cancel();
        clear_results();
        set_status("Cancelled. Reload to check whether a write completed.");
    });
    connect(upgrade_, &QPushButton::clicked, this, [this] {
        if (QMessageBox::question(this, project_caption("Enable verification history…"),
                                  project_caption("Create a consistent backup and upgrade this impact "
                                                  "workspace for verification history?")) == QMessageBox::Yes)
            request("upgrade");
    });
    connect(import_, &QPushButton::clicked, this,
            [this] { request("import-native", {{"graphRevision", graph_revision_}}); });
    connect(preview_button_, &QPushButton::clicked, this,
            [this] { request("import-preview", {{"batchId", selected(imports_)}}); });
    connect(accept_, &QPushButton::clicked, this, [this] { review_import("accept"); });
    connect(reject_, &QPushButton::clicked, this, [this] { review_import("reject"); });
    connect(imports_, &QTreeWidget::itemSelectionChanged, this, [this] {
        preview_ = {};
        import_details_->clear();
        import_confirm_->setChecked(false);
        update_actions();
    });
    connect(import_confirm_, &QCheckBox::toggled, this, [this] { update_actions(); });
    connect(report_button_, &QPushButton::clicked, this,
            [this] { request("report", {{"change", change()}}); });
    connect(save_report_, &QPushButton::clicked, this,
            [this] { request("save-report", {{"report", report_}}); });
    connect(open_report_, &QPushButton::clicked, this,
            [this] { request("open-report", {{"id", report_id_->text().trimmed()}}); });
    connect(report_id_, &QLineEdit::textChanged, this, [this] { update_actions(); });
    connect(saved_reports_, &QComboBox::activated, this, [this] {
        report_id_->setText(saved_reports_->currentData().toString());
        update_actions();
    });
    const auto changed = [this] {
        if (process_ && operation_ != "overview" && operation_ != "setup") {
            cancel();
            set_status("Inputs changed. Review impact again.");
        }
        clear_report();
        update_actions();
    };
    for (auto edit : {description_, baseline_, proposed_})
        connect(edit, &QLineEdit::textChanged, this, changed);
    connect(category_, &QComboBox::currentIndexChanged, this, changed);
    connect(targets_, &QTreeWidget::itemChanged, this, changed);
    connect(entity_, &QComboBox::currentIndexChanged, this, [this, changed] {
        baseline_->setText(entity_->currentData(Qt::UserRole + 1).toString());
        changed();
    });
    connect(findings_, &QTreeWidget::itemSelectionChanged, this, [this] {
        const auto item = findings_->currentItem();
        if (item)
            details_->setPlainText(item->data(0, Qt::UserRole).toString());
    });
    connect(checklist_, &QTreeWidget::itemSelectionChanged, this, [this] {
        verify_confirm_->setChecked(false);
        evidence_summary_->clear();
        evidence_ref_->clear();
        update_actions();
    });
    connect(verify_confirm_, &QCheckBox::toggled, this, [this] { update_actions(); });
    for (auto edit : {evidence_summary_, evidence_ref_})
        connect(edit, &QLineEdit::textChanged, this, [this] {
            verify_confirm_->setChecked(false);
            update_actions();
        });
    connect(verification_status_, &QComboBox::currentIndexChanged, this, [this] {
        verify_confirm_->setChecked(false);
        update_actions();
    });
    connect(verify_, &QPushButton::clicked, this, [this] {
        QJsonObject verification{{"reportId", report_.value("id")},
                                 {"checklistId", selected(checklist_)},
                                 {"status", verification_status_->currentData().toString()},
                                 {"expectedGraphRevision", graph_revision_},
                                 {"expectedReviewRevision", review_revision_}};
        if (!evidence_summary_->text().trimmed().isEmpty())
            verification["evidenceSummary"] = evidence_summary_->text().trimmed();
        if (!evidence_ref_->text().trimmed().isEmpty())
            verification["evidenceRef"] = evidence_ref_->text().trimmed();
        request("verify", {{"verification", verification}});
    });
    deadline_.setSingleShot(true);
    connect(&deadline_, &QTimer::timeout, this, [this] {
        cancel();
        fail("Request timed out. Reload to check whether a write completed.");
    });
    capture_project_captions(this);
    set_status("Save the project to review changes.");
    update_actions();
}
ImpactPanel::~ImpactPanel() {
    cancel();
}
void ImpactPanel::set_status(const QString &key) {
    status_key_ = key;
    status_->setText(project_caption(key));
}
void ImpactPanel::clear_report() {
    report_ = {};
    review_ = {};
    report_saved_ = false;
    review_revision_ = 0;
    findings_->clear();
    checklist_->clear();
    details_->clear();
    verify_confirm_->setChecked(false);
}
void ImpactPanel::clear_results() {
    loaded_ = false;
    review_allowed_ = false;
    graph_revision_ = -1;
    snapshot_ = {};
    preview_ = {};
    sources_->clear();
    imports_->clear();
    targets_->clear();
    entity_->clear();
    history_->clear();
    saved_reports_->clear();
    import_confirm_->setChecked(false);
    import_details_->clear();
    clear_report();
    update_actions();
}
void ImpactPanel::update_actions() {
    const bool idle = !process_ && clean_ && !project_id_.isEmpty();
    const bool connected = idle && !config_path_.isEmpty();
    const bool writes = connected && review_allowed_ && loaded_;
    for (auto field : {description_, baseline_, proposed_, report_id_, evidence_summary_, evidence_ref_})
        field->setEnabled(idle);
    for (auto field : {entity_, category_, verification_status_, saved_reports_})
        field->setEnabled(idle);
    targets_->setEnabled(idle);
    connect_->setEnabled(idle);
    create_->setEnabled(idle && qEnvironmentVariable("LMTI_STUDIO_ALLOW_IMPACT_REVIEW") == "1");
    reload_->setEnabled(connected);
    cancel_->setEnabled(process_ != nullptr);
    upgrade_->setEnabled(writes);
    import_->setEnabled(writes);
    preview_button_->setEnabled(connected && loaded_ && !selected(imports_).isEmpty());
    const bool reviewed = writes && !preview_.isEmpty() && import_confirm_->isChecked() &&
                          imports_->currentItem() &&
                          imports_->currentItem()->data(1, Qt::UserRole) == "pending";
    accept_->setEnabled(reviewed);
    reject_->setEnabled(reviewed);
    report_button_->setEnabled(connected && loaded_ && entity_->currentIndex() >= 0 &&
                               !description_->text().trimmed().isEmpty() &&
                               !baseline_->text().trimmed().isEmpty());
    save_report_->setEnabled(writes && !report_.isEmpty() && !report_saved_);
    open_report_->setEnabled(connected && loaded_ && !report_id_->text().trimmed().isEmpty());
    const bool evidence =
        verification_status_->currentData() == "pending" ||
        (!evidence_summary_->text().trimmed().isEmpty() && !evidence_ref_->text().trimmed().isEmpty());
    verify_->setEnabled(writes && report_saved_ && review_.value("current").toBool() &&
                        !selected(checklist_).isEmpty() && verify_confirm_->isChecked() && evidence);
}
void ImpactPanel::bind_project(const QString &id, const QString &path, qint64 revision, bool clean,
                               const QStringList &sites) {
    const bool identity_changed = id != project_id_ || path != document_path_;
    const bool changed = identity_changed || revision != revision_ || clean != clean_;
    if (changed) {
        cancel();
        clear_results();
        if (identity_changed) {
            config_path_.clear();
            description_->clear();
            baseline_->clear();
            proposed_->clear();
            report_id_->clear();
        }
    }
    project_id_ = id;
    document_path_ = path;
    revision_ = revision;
    clean_ = clean;
    sites_ = sites;
    apply_project_captions(this);
    // Translate existing cells in place: selection, evidence drafts, checked
    // confirmations and protocol IDs must survive a language change.
    for (auto tree : {sources_, imports_, findings_, checklist_, history_}) {
        const QSignalBlocker blocked(tree);
        for (int row = 0; row < tree->topLevelItemCount(); ++row) {
            auto item = tree->topLevelItem(row);
            for (int column = 0; column < tree->columnCount(); ++column)
                if (item->data(column, caption_role).isValid())
                    display(item, column, item->data(column, caption_role).toString());
            if (tree == findings_)
                item->setData(0, Qt::UserRole,
                              finding_details(item->data(0, finding_role).toJsonObject(), snapshot_));
        }
    }
    {
        const QSignalBlocker blocked(verification_status_);
        for (int i = 0; i < verification_status_->count(); ++i)
            verification_status_->setItemText(i,
                                              impact_caption(verification_status_->itemData(i).toString()));
    }
    if (saved_reports_->count() && saved_reports_->itemData(0).toString().isEmpty())
        saved_reports_->setItemText(0, project_caption("Choose a saved report"));
    if (!report_.isEmpty()) {
        const auto scroll = details_->verticalScrollBar()->value();
        details_->setPlainText(findings_->currentItem()
                                   ? findings_->currentItem()->data(0, Qt::UserRole).toString()
                                   : impact_caption(report_.value("conclusion").toString()) + "\n" +
                                         impact_caption(strings(report_.value("unknowns").toArray())));
        details_->verticalScrollBar()->setValue(scroll);
    }
    if (changed)
        set_status(clean ? "Connect a review workspace or create one for this project."
                         : "Save the project to review changes.");
    else
        set_status(status_key_);
    source_->setText(config_path_.isEmpty() ? QString{} : QFileInfo(config_path_).absoluteDir().dirName());
    source_->setToolTip(config_path_);
    update_actions();
}
void ImpactPanel::connect_workspace(const QString &config) {
    cancel();
    clear_results();
    if (QFileInfo(config).canonicalFilePath() != config_path_)
        report_id_->clear();
    config_path_ = QFileInfo(config).canonicalFilePath();
    source_->setText(QFileInfo(config_path_).absoluteDir().dirName());
    source_->setToolTip(config_path_);
    if (!config_path_.isEmpty())
        request("overview");
}
void ImpactPanel::setup_dialog() {
    QDialog dialog(this);
    dialog.setWindowTitle(project_caption("Create review workspace…"));
    auto body = new QVBoxLayout(&dialog);
    body->addWidget(label("Select the declared site and environment. Use nonsecret metadata only."));
    auto form = new QFormLayout;
    QComboBox site;
    site.addItems(sites_);
    site.setEditable(true);
    QLineEdit environment("local");
    environment.setMaxLength(100);
    QCheckBox internal(project_caption("Include internal metadata in this local review"));
    form->addRow(label("Site"), &site);
    form->addRow(label("Environment"), &environment);
    body->addLayout(form);
    body->addWidget(&internal);
    QDialogButtonBox actions(QDialogButtonBox::Ok | QDialogButtonBox::Cancel);
    body->addWidget(&actions);
    connect(&actions, &QDialogButtonBox::accepted, &dialog, &QDialog::accept);
    connect(&actions, &QDialogButtonBox::rejected, &dialog, &QDialog::reject);
    if (dialog.exec() != QDialog::Accepted)
        return;
    const auto directory = QFileDialog::getSaveFileName(this, project_caption("Choose a new review folder"),
                                                        {}, {}, nullptr, QFileDialog::DontConfirmOverwrite);
    if (!directory.isEmpty())
        create_workspace(QDir(directory).filePath("launcher.json"), site.currentText().trimmed(),
                         environment.text().trimmed(), internal.isChecked());
}
void ImpactPanel::create_workspace(const QString &config, const QString &site, const QString &environment,
                                   bool allow_internal) {
    cancel();
    clear_results();
    config_path_ = QFileInfo(config).absoluteFilePath();
    request("setup", {{"documentPath", document_path_},
                      {"site", site},
                      {"environmentId", environment},
                      {"allowInternal", allow_internal}});
}
void ImpactPanel::cancel() {
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
    update_actions();
}
void ImpactPanel::fail(const QString &key) {
    clear_results();
    set_status(key);
}
QJsonObject ImpactPanel::change() const {
    QJsonArray targets;
    for (int i = 0; i < targets_->topLevelItemCount(); ++i) {
        const auto item = targets_->topLevelItem(i);
        if (item->checkState(0) == Qt::Checked)
            targets.append(item->data(0, Qt::UserRole).toString());
    }
    QJsonObject result{{"entityId", entity_->currentData().toString()},
                       {"description", description_->text().trimmed()},
                       {"category", category_->currentData().toString()},
                       {"baselineRevision", baseline_->text().trimmed()},
                       {"mode", "prospective"},
                       {"targetDeploymentIds", targets}};
    if (!proposed_->text().trimmed().isEmpty())
        result["proposedRevision"] = proposed_->text().trimmed();
    return result;
}
void ImpactPanel::review_import(const QString &decision) {
    request("review", {{"batchId", selected(imports_)},
                       {"graphRevision", graph_revision_},
                       {"decision", decision},
                       {"evidenceReviewed", true}});
}
void ImpactPanel::request(const QString &op, QJsonObject extra) {
    if (process_ || !clean_ || project_id_.isEmpty() || config_path_.isEmpty())
        return;
    const QFileInfo node(qEnvironmentVariable("LMTI_STUDIO_NODE_BINARY")),
        cli(qEnvironmentVariable("LMTI_STUDIO_CLI"));
    if (!node.isAbsolute() || !node.isFile() || !node.isExecutable() || !cli.isAbsolute() || !cli.isFile() ||
        cli.fileName() != "index.js") {
        fail("Impact runtime is not configured. Use the Studio launcher.");
        return;
    }
    operation_ = op;
    requested_change_ = op == "save-report" ? extra.value("report").toObject().value("input").toObject()
                                            : extra.value("change").toObject();
    requested_report_id_ = extra.value("id").toString();
    extra.insert("schema", "lmti.impact.desktop.request.v1");
    extra.insert("op", op);
    extra.insert("projectId", project_id_);
    extra.insert("expectedProjectRevision", revision_);
    extra.insert("documentPath", document_path_);
    if (op == "overview" || op == "setup")
        clear_results();
    auto process = process_ = new QProcess(this);
    output_.clear();
    const auto system = QProcessEnvironment::systemEnvironment();
    QProcessEnvironment environment;
    for (const auto &name :
         {"SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "LMTI_STUDIO_ALLOW_IMPACT_REVIEW"})
        if (system.contains(name))
            environment.insert(name, system.value(name));
    const auto native = QDir(QCoreApplication::applicationDirPath()).filePath("lmti-project.exe");
    environment.insert("LMTI_STUDIO_PROJECT_BINARY", native);
    process->setProcessEnvironment(environment);
    process->setWorkingDirectory(cli.absolutePath());
    connect(process, &QProcess::readyReadStandardOutput, this, [this, process] {
        output_ += process->readAllStandardOutput();
        if (output_.size() > output_limit) {
            cancel();
            fail("Impact response exceeded the limit.");
        }
    });
    connect(process, &QProcess::readyReadStandardError, this, [process] { process->readAllStandardError(); });
    connect(process, &QProcess::errorOccurred, this, [this, process](QProcess::ProcessError error) {
        if (process_ == process && error == QProcess::FailedToStart) {
            cancel();
            fail("Impact runtime could not start.");
        }
    });
    connect(process, &QProcess::finished, this, [this, process](int code, QProcess::ExitStatus state) {
        if (process_ != process)
            return;
        deadline_.stop();
        output_ += process->readAllStandardOutput();
        process_ = nullptr;
        process->deleteLater();
        auto bytes = std::move(output_);
        output_.clear();
        try {
            QJsonParseError error;
            const auto document = QJsonDocument::fromJson(bytes, &error);
            if (code || state != QProcess::NormalExit || bytes.size() > output_limit ||
                error.error != QJsonParseError::NoError || !document.isObject())
                throw std::runtime_error("Invalid response");
            receive(document.object());
        } catch (...) {
            fail("Review unavailable. Recheck the source, scope and saved revision.");
        }
        update_actions();
    });
    process->start(node.canonicalFilePath(),
                   {cli.canonicalFilePath(), "impact", "desktop-request", "--config", config_path_});
    process->write(QJsonDocument(extra).toJson(QJsonDocument::Compact));
    process->closeWriteChannel();
    deadline_.start(30000);
    set_status("Checking sources…");
    update_actions();
}
void ImpactPanel::receive(const QJsonObject &response) {
    if (response.value("schema") != "lmti.impact.response.v1" || response.value("ok") != true ||
        response.value("projectId") != project_id_ ||
        response.value("projectRevision").toInteger(-1) != revision_ || response.value("op") != operation_ ||
        !response.value("result").isObject())
        throw std::runtime_error("Wrong response scope");
    const auto result = response.value("result").toObject();
    if (operation_ == "overview") {
        const auto native = result.value("native").toObject();
        if (native.value("projectId") != project_id_ || native.value("revision").toInteger(-1) != revision_)
            throw std::runtime_error("Wrong native scope");
        snapshot_ = result.value("snapshot").toObject();
        graph_revision_ = snapshot_.value("graphRevision").toInteger(-1);
        if (graph_revision_ < 0 || !result.value("reviewEnabled").isBool())
            throw std::runtime_error("Invalid revision");
        review_allowed_ = result.value("reviewEnabled").toBool() &&
                          qEnvironmentVariable("LMTI_STUDIO_ALLOW_IMPACT_REVIEW") == "1";
        QMap<QString, QString> revisions;
        for (const auto &entry : rows(snapshot_, "sources", 200)) {
            const auto record = entry.toObject().value("source").toObject();
            const auto id = value(record, "id"), rev = value(record, "revision");
            revisions[id] = rev;
            QString freshness = "unknown";
            for (const auto &checked : result.value("sourceChecks").toArray()) {
                const auto check = checked.toObject();
                if (check.value("sourceId") == id) {
                    if (check.value("status") == "deleted")
                        freshness = "stale";
                    else if (check.value("status") == "available")
                        freshness =
                            check.value("revision") == record.value("revision") &&
                                    check.value("digest") == record.value("digest") &&
                                    entry.toObject().value("headRevision") == record.value("revision") &&
                                    entry.toObject().value("headDigest") == record.value("digest")
                                ? "fresh"
                                : "stale";
                }
            }
            auto item = new QTreeWidgetItem(sources_, {id, rev, QString{}});
            item->setData(2, Qt::UserRole, freshness);
            display(item, 2, freshness);
        }
        for (const auto &entry : rows(snapshot_, "entities")) {
            const auto owned = entry.toObject(), record = owned.value("record").toObject();
            const auto id = value(record, "id"), title = value(record, "label"), kind = value(record, "kind");
            entity_->addItem(title, id);
            entity_->setItemData(
                entity_->count() - 1,
                record.value("version").toString(revisions.value(owned.value("sourceId").toString())),
                Qt::UserRole + 1);
            if (kind == "deployment") {
                auto item = new QTreeWidgetItem(targets_, {title});
                item->setData(0, Qt::UserRole, id);
                item->setCheckState(0, Qt::Unchecked);
            }
        }
        if (entity_->count())
            baseline_->setText(entity_->currentData(Qt::UserRole + 1).toString());
        const auto inbox = result.value("inbox").toObject();
        saved_reports_->addItem(project_caption("Choose a saved report"), QString{});
        for (const auto &entry : result.value("savedReports").toObject().value("reports").toArray()) {
            const auto record = entry.toObject();
            saved_reports_->addItem(record.value("savedAt").toString() + " · " +
                                        record.value("id").toString().left(20),
                                    record.value("id").toString());
        }
        for (const auto &entry : rows(inbox, "imports", 500)) {
            const auto record = entry.toObject(), delta = record.value("delta").toObject();
            auto item =
                new QTreeWidgetItem(imports_, {record.value("source").toObject().value("id").toString(),
                                               record.value("state").toString(),
                                               QString::number(delta.value("added").toArray().size()),
                                               QString::number(delta.value("changed").toArray().size()),
                                               QString::number(delta.value("removed").toArray().size())});
            item->setData(0, Qt::UserRole, record.value("batchId").toString(record.value("id").toString()));
            item->setData(1, Qt::UserRole, record.value("state").toString());
            display(item, 1, record.value("state").toString());
        }
        for (const auto &entry : rows(inbox, "history", 2000)) {
            const auto record = entry.toObject();
            new QTreeWidgetItem(history_,
                                {record.value("event").toString(), record.value("actor").toString(),
                                 record.value("at").toString(), record.value("sourceId").toString()});
        }
        loaded_ = true;
        set_status("Sources checked. Imported metadata describes the declared system.");
    } else if (operation_ == "import-preview") {
        preview_ = result.value("batch").toObject();
        if (preview_.isEmpty())
            throw std::runtime_error("Missing preview");
        QStringList text;
        const auto snapshot = preview_.value("snapshot").toObject().isEmpty()
                                  ? preview_
                                  : preview_.value("snapshot").toObject();
        const auto source = snapshot.value("source").toObject();
        text << project_caption("Source") + ": " + source.value("id").toString() + " · " +
                    source.value("revision").toString();
        for (const auto &entry : snapshot.value("entities").toArray()) {
            const auto record = entry.toObject();
            text << record.value("label").toString() + " [" + record.value("id").toString() + "] · " +
                        record.value("kind").toString();
        }
        for (const auto &entry : snapshot.value("assertions").toArray()) {
            const auto record = entry.toObject();
            text << record.value("subjectId").toString() + " → " + record.value("predicate").toString() +
                        " → " + record.value("objectId").toString() + " · " +
                        record.value("basis").toString() + " · " + record.value("contract").toString();
        }
        for (const auto &entry : snapshot.value("evidence").toArray()) {
            const auto record = entry.toObject();
            text << record.value("summary").toString() + " · " + record.value("locator").toString();
        }
        for (const auto &category : {"entities", "assertions"}) {
            const auto candidate = snapshot.value(category).toArray();
            for (const auto &entry : snapshot_.value(category).toArray()) {
                const auto owned = entry.toObject(), old = owned.value("record").toObject();
                if (owned.value("sourceId") != source.value("id"))
                    continue;
                const auto next =
                    std::find_if(candidate.begin(), candidate.end(), [&](const QJsonValue &row) {
                        return row.toObject().value("id") == old.value("id");
                    });
                if (next == candidate.end())
                    text << project_caption("Removed") + ": " + old.value("id").toString();
                else if (next->toObject() != old)
                    text << project_caption("Previous") + ": " + old.value("id").toString() + " · " +
                                old.value("label").toString() + " · " + old.value("subjectId").toString() +
                                " → " + old.value("objectId").toString() + " · " +
                                old.value("contract").toString();
            }
        }
        import_details_->setPlainText(text.join('\n'));
        import_confirm_->setChecked(false);
        set_status("Review the candidate metadata before accepting or rejecting it.");
    } else if (operation_ == "report" || operation_ == "save-report" || operation_ == "open-report") {
        render_report(result);
        report_saved_ = operation_ != "report";
        if (report_saved_) {
            report_id_->setText(report_.value("id").toString());
            if (saved_reports_->findData(report_.value("id").toString()) < 0)
                saved_reports_->addItem(report_.value("createdAt").toString(),
                                        report_.value("id").toString());
        }
        set_status(report_saved_ ? "Report saved. Verification requires reviewed evidence."
                                 : "Impact preview ready. Save the report to record verification.");
    } else if (operation_ == "verify") {
        request("open-report", {{"id", report_.value("id")}});
    } else {
        request("overview");
    }
}
void ImpactPanel::render_report(const QJsonObject &result) {
    report_ = result.value("report").toObject();
    review_ = result.value("review").toObject();
    if (report_.value("schema") != "lmti.impact.report.v1")
        throw std::runtime_error("Invalid report");
    if (report_.value("graphRevision") != snapshot_.value("graphRevision") ||
        report_.value("grantFingerprint") != snapshot_.value("grantFingerprint") ||
        (!requested_change_.isEmpty() && report_.value("input").toObject() != requested_change_) ||
        (!requested_report_id_.isEmpty() && report_.value("id") != requested_report_id_))
        throw std::runtime_error("Report binding mismatch");
    graph_revision_ = report_.value("graphRevision").toInteger(-1);
    review_revision_ = review_.value("reviewRevision").toInteger(0);
    findings_->clear();
    checklist_->clear();
    verify_confirm_->setChecked(false);
    for (const auto &entry : rows(report_, "findings")) {
        const auto finding = entry.toObject();
        auto item =
            new QTreeWidgetItem(findings_, {finding.value("entity").toObject().value("label").toString(),
                                            finding.value("disposition").toString(),
                                            strings(finding.value("reasons").toArray())});
        item->setData(0, Qt::UserRole, finding_details(finding, snapshot_));
        item->setData(0, finding_role, QVariant::fromValue(finding));
        item->setData(1, Qt::UserRole, finding.value("disposition").toString());
        display(item, 1, finding.value("disposition").toString());
        display(item, 2, strings(finding.value("reasons").toArray()));
    }
    QMap<QString, QString> statuses;
    if (review_.value("current").toBool())
        for (const auto &entry : review_.value("entries").toArray()) {
            const auto record = entry.toObject();
            statuses[record.value("checklistId").toString()] = record.value("status").toString();
        }
    for (const auto &entry : rows(report_, "checklist")) {
        const auto record = entry.toObject();
        const auto id = value(record, "id");
        auto item = new QTreeWidgetItem(
            checklist_, {value(record, "reason"), value(record, "ownerRole"), statuses.value(id, "pending")});
        item->setData(0, Qt::UserRole, id);
        item->setData(2, Qt::UserRole, statuses.value(id, "pending"));
        display(item, 0, value(record, "reason"));
        display(item, 1, value(record, "ownerRole"));
        display(item, 2, statuses.value(id, "pending"));
        item->setToolTip(0, record.value("requiredEvidence").toString().toHtmlEscaped());
    }
    history_->clear();
    for (const auto &entry : review_.value("history").toArray()) {
        const auto record = entry.toObject();
        auto item = new QTreeWidgetItem(history_, {QString{}, record.value("reviewer").toString(),
                                                   record.value("recordedAt").toString(),
                                                   record.value("evidenceSummary").toString()});
        item->setData(0, Qt::UserRole, record.value("status").toString());
        display(item, 0, record.value("status").toString());
    }
    sources_->clear();
    for (const auto &entry : rows(report_, "sourceVersions", 200)) {
        const auto source = entry.toObject();
        auto item =
            new QTreeWidgetItem(sources_, {value(source, "sourceId"), value(source, "revision"), QString{}});
        item->setData(2, Qt::UserRole, value(source, "freshness"));
        display(item, 2, value(source, "freshness"));
    }
    details_->setPlainText(impact_caption(report_.value("conclusion").toString()) + "\n" +
                           impact_caption(strings(report_.value("unknowns").toArray())));
    update_actions();
}
