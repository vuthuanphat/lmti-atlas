#include "drive_knowledge_panel.hpp"
#include "drive_captions.hpp"
#include "studio_widgets.hpp"
#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDesktopServices>
#include <QElapsedTimer>
#include <QFileInfo>
#include <QHeaderView>
#include <QJsonArray>
#include <QJsonDocument>
#include <QProcessEnvironment>
#include <QRegularExpression>
#include <QResizeEvent>
#include <QScopedValueRollback>
#include <QSet>
#include <QSignalBlocker>
#include <QSplitter>
#include <QUrlQuery>
#include <QVBoxLayout>
#include <algorithm>
#include <stdexcept>

namespace {
constexpr qsizetype line_limit = 2 * 1024 * 1024, text_limit = 512 * 1024;
constexpr qint64 safe_integer = 9007199254740991LL;
constexpr int item_role = Qt::UserRole + 130;
static_assert(item_role != studio::badge_role);
QString text(const QJsonObject &object, const char *key, qsizetype limit, bool empty = false) {
    const auto v = object.value(key);
    if (!v.isString() || v.toString().size() > limit || (!empty && v.toString().isEmpty()))
        throw std::runtime_error("Invalid Drive text");
    const auto result = v.toString();
    for (const auto ch : result)
        if (ch.unicode() < 32 || ch.unicode() == 127)
            throw std::runtime_error("Invalid Drive metadata");
    return result;
}
QString token(const QJsonObject &object, const char *key, const QString &pattern, qsizetype limit = 200) {
    const auto result = text(object, key, limit);
    if (!QRegularExpression(pattern).match(result).hasMatch())
        throw std::runtime_error("Invalid Drive identifier");
    return result;
}
QString id(const QJsonObject &object, const char *key = "id") {
    return token(object, key, "\\A[A-Za-z0-9_-]{1,200}\\z");
}
QString digest(const QJsonObject &object, const char *key) {
    return token(object, key, "\\A[a-f0-9]{64}\\z", 64);
}
QJsonObject object(const QJsonObject &parent, const char *key) {
    if (!parent.value(key).isObject())
        throw std::runtime_error("Invalid Drive object");
    return parent.value(key).toObject();
}
QJsonObject item(const QJsonObject &value) {
    id(value);
    text(value, "name", 1024);
    text(value, "mimeType", 160);
    token(value, "version", "\\A[0-9]{1,20}\\z", 20);
    if (value.contains("modifiedTime"))
        text(value, "modifiedTime", 80);
    const auto kind = text(value, "kind", 20);
    if ((kind != "folder" && kind != "document" && kind != "unsupported") ||
        !value.value("canDownload").isBool() || !value.value("readable").isBool() ||
        (value.value("readable").toBool() && kind != "document"))
        throw std::runtime_error("Invalid Drive item");
    return value;
}
QString kind_caption(const QJsonObject &value) {
    return drive_caption(value.value("kind") == "folder"   ? "Folder"
                         : value.value("readable") == true ? "Document"
                                                           : "Metadata only");
}
QLabel *label(const char *name, const QString &caption, QBoxLayout *layout) {
    auto result = new QLabel(drive_caption(caption));
    result->setObjectName(name);
    result->setTextFormat(Qt::PlainText);
    result->setWordWrap(true);
    result->setProperty("verbatim", true);
    result->setProperty("driveCaption", caption);
    layout->addWidget(result);
    return result;
}
QPushButton *button(const char *name, const QString &caption, QBoxLayout *layout) {
    auto result = new studio::ActionButton(drive_caption(caption));
    result->setObjectName(name);
    result->setProperty("verbatim", true);
    result->setProperty("driveCaption", caption);
    auto policy = result->sizePolicy();
    policy.setHeightForWidth(true);
    policy.setVerticalPolicy(QSizePolicy::Preferred);
    result->setSizePolicy(policy);
    layout->addWidget(result);
    return result;
}
bool authorized_url(const QUrl &url) {
    if (!url.isValid() || url.toEncoded().size() > 8192 || url.scheme() != "https" ||
        url.host() != "accounts.google.com" || !url.userInfo().isEmpty() || url.port() != -1 ||
        url.path() != "/o/oauth2/v2/auth" || url.hasFragment())
        return false;
    const QUrlQuery query(url);
    const QSet<QString> fields{"client_id", "redirect_uri",   "response_type",
                               "scope",     "code_challenge", "code_challenge_method",
                               "state",     "access_type",    "prompt"};
    QSet<QString> seen;
    for (const auto &pair : query.queryItems(QUrl::FullyDecoded)) {
        if (!fields.contains(pair.first) || seen.contains(pair.first))
            return false;
        seen.insert(pair.first);
    }
    const auto value = [&](const QString &key) { return query.queryItemValue(key, QUrl::FullyDecoded); };
    const QRegularExpression nonce("\\A[A-Za-z0-9_-]{43}\\z");
    const QRegularExpression client("\\A[A-Za-z0-9][A-Za-z0-9_-]{0,199}\\.apps\\.googleusercontent\\.com\\z");
    const QUrl redirect(value("redirect_uri"), QUrl::StrictMode);
    return seen == fields && client.match(value("client_id")).hasMatch() &&
           value("client_id") == qEnvironmentVariable("LMTI_GOOGLE_CLIENT_ID") &&
           value("response_type") == "code" &&
           value("scope") == "https://www.googleapis.com/auth/drive.readonly" &&
           value("code_challenge_method") == "S256" && nonce.match(value("state")).hasMatch() &&
           nonce.match(value("code_challenge")).hasMatch() && value("access_type") == "offline" &&
           value("prompt") == "select_account" && redirect.isValid() && redirect.scheme() == "http" &&
           redirect.host() == "127.0.0.1" && redirect.port() > 0 && redirect.port() <= 65535 &&
           redirect.path() == "/oauth2/callback" && redirect.userInfo().isEmpty() && !redirect.hasQuery() &&
           !redirect.hasFragment();
}
} // namespace

DriveKnowledgePanel::DriveKnowledgePanel(QWidget *parent) : QWidget(parent) {
    setObjectName("driveKnowledgePanel");
    browser_handler_ = [](const QUrl &url) { return QDesktopServices::openUrl(url); };
    auto body = new QVBoxLayout(this);
    body->setContentsMargins(12, 8, 12, 8);
    body->setAlignment(Qt::AlignTop);
    auto title = label("driveTitle", "Google Drive", body);
    title->setStyleSheet("font-size:24px;font-weight:600;background:transparent;");
    label("driveIntroduction", "Read documents from a folder you choose.", body);
    auto connection_actions = new QHBoxLayout;
    connect_ = button("driveConnect", "Connect Google Drive", connection_actions);
    connect_->setProperty("primary", true);
    disconnect_ = button("driveDisconnect", "Disconnect", connection_actions);
    cancel_ = button("driveCancel", "Cancel", connection_actions);
    connection_actions->addStretch();
    body->addLayout(connection_actions);
    acknowledgment_ = new studio::WrapCheckBox({}, this);
    acknowledgment_->setObjectName("driveScopeAcknowledgment");
    acknowledgment_->setProperty("verbatim", true);
    acknowledgment_->setProperty("driveCaption", "I understand Google's read-only permission covers my whole "
                                                 "Drive. LMTI limits document reads to the folder I select.");
    body->addWidget(acknowledgment_);
    label("driveBoundary",
          "Local view only. Google Docs, Slides, text, Markdown and CSV can be read here. Nothing is sent to "
          "an AI agent or stored in project memory. Sign-in lasts for this session.",
          body);
    privacy_details_ = new QPushButton(drive_caption("Privacy and supported formats"));
    privacy_details_->setObjectName("drivePrivacyDetails");
    privacy_details_->setProperty("driveCaption", "Privacy and supported formats");
    privacy_details_->setProperty("verbatim", true);
    privacy_details_->setCheckable(true);
    body->addWidget(privacy_details_, 0, Qt::AlignLeft);
    connect(privacy_details_, &QPushButton::toggled, this, [this] { update_actions(); });
    status_ = label("driveStatus", {}, body);
    source_ = label("driveSource", {}, body);
    auto folder_actions = new QHBoxLayout;
    up_ = button("driveUp", "Up", folder_actions);
    refresh_ = button("driveRefresh", "Refresh", folder_actions);
    choose_ = button("driveChooseFolder", "Choose another folder", folder_actions);
    use_ = button("driveUseFolder", "Use this folder", folder_actions);
    next_ = button("driveNext", "Next page", folder_actions);
    body->addLayout(folder_actions);
    count_ = label("driveCount", {}, body);
    auto split = new QSplitter(Qt::Vertical);
    documents_ = split;
    files_ = new QTreeWidget;
    files_->setObjectName("driveFiles");
    files_->setProperty("verbatim", true);
    files_->setColumnCount(3);
    studio::inventory(files_);
    files_->setSelectionMode(QAbstractItemView::SingleSelection);
    files_->header()->setSectionResizeMode(0, QHeaderView::Stretch);
    files_->header()->setSectionResizeMode(1, QHeaderView::ResizeToContents);
    files_->header()->setSectionResizeMode(2, QHeaderView::ResizeToContents);
    files_->setMinimumHeight(100);
    new studio::EmptyTreeState(files_);
    split->addWidget(files_);
    auto preview_page = new QWidget;
    preview_page_ = preview_page;
    auto preview_body = new QVBoxLayout(preview_page);
    preview_body->setContentsMargins(0, 0, 0, 0);
    auto document_actions = new QHBoxLayout;
    read_ = button("driveRead", "Read document", document_actions);
    open_ = button("driveOpen", "Open in Google Drive", document_actions);
    document_actions->addStretch();
    preview_body->addLayout(document_actions);
    preview_title_ = label("drivePreviewTitle", {}, preview_body);
    preview_ = new QPlainTextEdit;
    preview_->setObjectName("drivePreview");
    preview_->setReadOnly(true);
    preview_->setContextMenuPolicy(Qt::NoContextMenu);
    preview_->setMinimumHeight(90);
    preview_body->addWidget(preview_, 1);
    split->addWidget(preview_page);
    split->setStretchFactor(0, 1);
    split->setStretchFactor(1, 1);
    body->addWidget(split, 1);

    connect(acknowledgment_, &QCheckBox::toggled, this, [this] { update_actions(); });
    connect(connect_, &QPushButton::clicked, this, [this] {
        if (acknowledgment_->isChecked() && configured_)
            request("connect", {{"acknowledgedScope", true}});
    });
    connect(cancel_, &QPushButton::clicked, this, &DriveKnowledgePanel::cancel);
    connect(disconnect_, &QPushButton::clicked, this, [this] {
        // Closing the session process drops its tokens, including during a request.
        stop_process();
        clear_session();
        set_status("Disconnected. Session credentials and document previews were cleared.");
        update_actions();
    });
    connect(refresh_, &QPushButton::clicked, this, [this] {
        if (connection_id_.isEmpty())
            request("status");
        else
            navigate(current_folder_.value("id").toString());
    });
    connect(choose_, &QPushButton::clicked, this, [this] {
        clear_preview();
        scope_id_.clear();
        root_folder_ = {};
        request("choose-folder");
    });
    connect(use_, &QPushButton::clicked, this, [this] {
        const auto chosen = selected().value("kind") == "folder" ? selected() : current_folder_;
        request("select-folder", {{"folderReference", chosen.value("id")}});
    });
    connect(up_, &QPushButton::clicked, this, [this] {
        if (!ancestors_.isEmpty())
            navigate(ancestors_.back(), true);
    });
    connect(next_, &QPushButton::clicked, this, [this] {
        request(picker_ ? "browse-folders" : "list",
                {{"folderId", current_folder_.value("id")}, {"cursor", next_cursor_}});
    });
    connect(files_, &QTreeWidget::itemSelectionChanged, this, [this] {
        clear_preview();
        update_actions();
    });
    connect(files_, &QTreeWidget::itemDoubleClicked, this, [this](QTreeWidgetItem *, int) {
        const auto row = selected();
        if (operation_.isEmpty() && row.value("kind") == "folder")
            navigate(row.value("id").toString());
    });
    connect(read_, &QPushButton::clicked, this, [this] {
        const auto row = selected();
        if (row.value("readable") == true)
            request("read", {{"fileId", row.value("id")}, {"expectedVersion", row.value("version")}});
    });
    connect(open_, &QPushButton::clicked, this, [this] {
        const auto row = selected();
        if (!operation_.isEmpty() || scope_id_.isEmpty() || row.isEmpty())
            return;
        const QUrl url("https://drive.google.com/file/d/" + id(row) + "/view");
        if (!browser_handler_(url))
            fail("Google Drive is unavailable or access was denied. Reconnect to retry.");
    });
    deadline_.setSingleShot(true);
    connect(&deadline_, &QTimer::timeout, this,
            [this] { fail("Google Drive request timed out. Reconnect to retry."); });
    set_status("Save the project before connecting Google Drive.");
    translate();
    update_actions();
}

DriveKnowledgePanel::~DriveKnowledgePanel() {
    stop_process();
    // Normal cancellation is asynchronous. Teardown also accounts for processes
    // cancelled just before the panel closes, with one short total wait budget.
    QElapsedTimer elapsed;
    elapsed.start();
    for (auto process : findChildren<QProcess *>(QString{}, Qt::FindDirectChildrenOnly)) {
        if (process->state() == QProcess::NotRunning)
            continue;
        const auto remaining = std::max(0, 250 - static_cast<int>(elapsed.elapsed()));
        if (remaining)
            process->waitForFinished(remaining);
        if (process->state() != QProcess::NotRunning)
            process->setParent(QCoreApplication::instance());
    }
}
void DriveKnowledgePanel::set_browser_handler(std::function<bool(const QUrl &)> handler) {
    if (handler)
        browser_handler_ = std::move(handler);
}
QJsonObject DriveKnowledgePanel::selected() const {
    return files_->currentItem() && files_->currentItem()->isSelected()
               ? files_->currentItem()->data(0, item_role).toJsonObject()
               : QJsonObject{};
}
void DriveKnowledgePanel::clear_preview() {
    preview_->clear();
    preview_title_->setProperty("driveFileName", QVariant{});
    preview_title_->setProperty("driveVersion", QVariant{});
    preview_title_->setText(drive_caption("Choose a document to view its text."));
}
void DriveKnowledgePanel::stop_process() {
    deadline_.stop();
    if (process_) {
        auto old = process_;
        process_ = nullptr;
        old->disconnect(this);
        // Deletion waits for process exit without blocking the UI event loop.
        connect(old, qOverload<int, QProcess::ExitStatus>(&QProcess::finished), old, &QObject::deleteLater);
        connect(old, &QProcess::stateChanged, old, [old](QProcess::ProcessState state) {
            if (state == QProcess::NotRunning)
                old->deleteLater();
        });
        // A cancellation may arrive while QProcess is still starting.
        connect(old, &QProcess::started, old, &QProcess::kill);
        old->kill();
        if (old->state() == QProcess::NotRunning)
            old->deleteLater();
    }
    output_.clear();
    operation_.clear();
    request_extra_ = {};
    request_connection_id_.clear();
    authorization_opened_ = false;
    pending_up_ = false;
}
void DriveKnowledgePanel::clear_session() {
    connection_id_.clear();
    account_name_.clear();
    scope_id_.clear();
    current_folder_ = {};
    root_folder_ = {};
    next_cursor_.clear();
    checked_at_.clear();
    ancestors_.clear();
    picker_ = false;
    partial_ = false;
    files_->clear();
    acknowledgment_->setChecked(false);
    clear_preview();
    translate();
}
void DriveKnowledgePanel::cancel() {
    stop_process();
    clear_session();
    set_status("Cancelled. Reconnect Google Drive to continue.");
    update_actions();
}
void DriveKnowledgePanel::fail(const QString &message) {
    stop_process();
    clear_session();
    set_status(message);
    update_actions();
}
void DriveKnowledgePanel::set_status(const QString &message) {
    status_key_ = message;
    status_->setText(drive_caption(message));
    update_text_geometry();
}
void DriveKnowledgePanel::resizeEvent(QResizeEvent *event) {
    QWidget::resizeEvent(event);
    update_text_geometry();
}
void DriveKnowledgePanel::update_text_geometry() {
    if (updating_layout_ || !layout())
        return;
    QScopedValueRollback<bool> guard(updating_layout_, true);
    const auto margins = layout()->contentsMargins();
    const auto available = std::max(120, width() - margins.left() - margins.right());
    acknowledgment_->setMinimumHeight(acknowledgment_->heightForWidth(available));
    for (auto notice : {findChild<QLabel *>("driveBoundary"), status_, source_, count_, preview_title_})
        if (notice)
            notice->setMinimumHeight(notice->text().isEmpty() ? 0
                                                              : std::max(notice->fontMetrics().height(),
                                                                         notice->heightForWidth(available)));
    // Replacing translated strings invalidates wrapped heights. Resolve them
    // before returning so the privacy notice remains visible during a switch.
    layout()->invalidate();
    layout()->activate();
}
void DriveKnowledgePanel::bind_project(const QString &project, const QString &path, qint64 revision,
                                       bool clean) {
    const QFileInfo file(path);
    const auto canonical = file.canonicalFilePath();
    const bool usable = clean && revision >= 1 && revision <= safe_integer && !project.isEmpty() &&
                        file.isFile() && !canonical.isEmpty();
    const bool changed =
        project_id_ != project || document_path_ != canonical || revision_ != revision || clean_ != usable;
    if (changed) {
        stop_process();
        clear_session();
        status_checked_ = false;
        configured_ = false;
    }
    project_id_ = project;
    document_path_ = canonical;
    revision_ = revision;
    clean_ = usable;
    translate();
    if (!usable)
        set_status("Save the project before connecting Google Drive.");
    else if (qEnvironmentVariable("LMTI_STUDIO_ALLOW_GOOGLE_DRIVE") != "1") {
        stop_process();
        clear_session();
        set_status("Google Drive is unavailable in this build.");
    } else if (changed || !status_checked_)
        request("status");
    update_actions();
}
void DriveKnowledgePanel::navigate(const QString &folder, bool up) {
    if (folder.isEmpty() || !operation_.isEmpty())
        return;
    pending_up_ = up;
    request(picker_ ? "browse-folders" : "list", {{"folderId", folder}});
}
void DriveKnowledgePanel::update_actions() {
    const bool enabled = clean_ && qEnvironmentVariable("LMTI_STUDIO_ALLOW_GOOGLE_DRIVE") == "1";
    const bool idle = operation_.isEmpty();
    const bool connected = !connection_id_.isEmpty();
    const auto row = selected();
    acknowledgment_->setEnabled(enabled && idle && !connected);
    connect_->setEnabled(enabled && idle && !connected && configured_ && acknowledgment_->isChecked());
    disconnect_->setEnabled(connected && idle);
    cancel_->setEnabled(!idle);
    up_->setEnabled(enabled && idle && connected && !ancestors_.isEmpty());
    refresh_->setEnabled(enabled && idle);
    choose_->setEnabled(enabled && idle && connected && !picker_);
    use_->setEnabled(enabled && idle && connected && picker_ && !current_folder_.isEmpty() &&
                     (row.isEmpty() || row.value("kind") == "folder"));
    next_->setEnabled(enabled && idle && connected && !next_cursor_.isEmpty());
    read_->setEnabled(enabled && idle && !picker_ && !scope_id_.isEmpty() && row.value("readable") == true);
    open_->setEnabled(enabled && idle && !picker_ && !scope_id_.isEmpty() && !row.isEmpty() &&
                      row.value("kind") != "folder");
    files_->setEnabled(enabled && idle && connected);
    // Each stage exposes only the actions it can actually use. Consent remains
    // explicit and readable before Connect can become enabled.
    connect_->setVisible(!connected && idle);
    disconnect_->setVisible(connected && idle);
    cancel_->setVisible(!idle);
    acknowledgment_->setVisible(!connected && configured_ && status_checked_);
    findChild<QLabel *>("driveBoundary")->setVisible(privacy_details_->isChecked());
    source_->setVisible(connected);
    up_->setVisible(connected && !ancestors_.isEmpty());
    refresh_->setVisible(connected || (idle && clean_ && !configured_));
    choose_->setVisible(connected && !picker_);
    use_->setVisible(connected && picker_);
    use_->setProperty("primary", true);
    next_->setVisible(connected && !next_cursor_.isEmpty());
    count_->setVisible(connected && !checked_at_.isEmpty());
    documents_->setVisible(connected);
    preview_page_->setVisible(connected && !picker_ && !row.isEmpty() && row.value("kind") != "folder");
    read_->setVisible(row.value("readable") == true);
    open_->setVisible(!row.isEmpty() && row.value("kind") != "folder");
    update_text_geometry();
}
void DriveKnowledgePanel::translate() {
    for (auto widget : findChildren<QWidget *>()) {
        const auto caption = widget->property("driveCaption");
        if (!caption.isValid() || caption.toString().isEmpty())
            continue;
        if (auto label = qobject_cast<QLabel *>(widget))
            label->setText(drive_caption(caption.toString()));
        if (auto button = qobject_cast<QAbstractButton *>(widget))
            button->setText(drive_caption(caption.toString()));
        if (auto button = qobject_cast<QPushButton *>(widget); button && button->hasHeightForWidth())
            button->setMinimumHeight(button->heightForWidth(button->sizeHint().width()));
    }
    files_->setHeaderLabels({drive_caption("Name"), drive_caption("Type"), drive_caption("Modified")});
    for (int i = 0; i < files_->topLevelItemCount(); ++i) {
        auto row = files_->topLevelItem(i);
        row->setText(1, kind_caption(row->data(0, item_role).toJsonObject()));
    }
    status_->setText(drive_caption(status_key_));
    if (connection_id_.isEmpty())
        source_->setText(drive_caption("No Google Drive folder is connected."));
    else if (picker_)
        source_->setText(drive_caption("Account: %1 · Choosing a folder: %2")
                             .arg(account_name_, current_folder_.value("name").toString()));
    else
        source_->setText(drive_caption("Account: %1 · Allowed folder: %2 · Viewing: %3")
                             .arg(account_name_, root_folder_.value("name").toString(),
                                  current_folder_.value("name").toString()));
    count_->setText(checked_at_.isEmpty()
                        ? QString{}
                        : drive_caption(partial_
                                            ? "%1 items on this page · More items are available · Checked: %2"
                                            : "%1 items on this page · Checked: %2")
                              .arg(files_->topLevelItemCount())
                              .arg(checked_at_));
    auto empty = files_->findChild<QLabel *>("tableEmptyState");
    empty->setProperty("verbatim", true);
    empty->setText(drive_caption("No folders or documents on this page."));
    empty->setVisible(files_->topLevelItemCount() == 0);
    const auto name = preview_title_->property("driveFileName").toString();
    preview_title_->setText(name.isEmpty()
                                ? drive_caption("Choose a document to view its text.")
                                : drive_caption("%1 · Version %2")
                                      .arg(name, preview_title_->property("driveVersion").toString()));
    update_text_geometry();
}
bool DriveKnowledgePanel::start_process() {
    if (process_)
        return true;
    const QFileInfo node(qEnvironmentVariable("LMTI_STUDIO_NODE_BINARY"));
    const QFileInfo cli(qEnvironmentVariable("LMTI_STUDIO_CLI"));
    if (!node.isAbsolute() || !node.isFile() || !cli.isAbsolute() || !cli.isFile() ||
        node.canonicalFilePath().isEmpty() || cli.canonicalFilePath().isEmpty()) {
        fail("Google Drive could not start. Reopen LMTI and try again.");
        return false;
    }
    auto process = new QProcess(this);
    process_ = process;
    QProcessEnvironment environment;
    for (const auto name : {"SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "LMTI_STUDIO_ALLOW_GOOGLE_DRIVE",
                            "LMTI_GOOGLE_CLIENT_ID", "LMTI_GOOGLE_CLIENT_SECRET"})
        if (qEnvironmentVariableIsSet(name))
            environment.insert(name, qEnvironmentVariable(name));
    process->setProcessEnvironment(environment);
    process->setProcessChannelMode(QProcess::SeparateChannels);
    connect(process, &QProcess::readyReadStandardOutput, this, [this, process] {
        if (process_ == process)
            consume_output();
    });
    connect(process, &QProcess::readyReadStandardError, this, [this, process] {
        if (process_ != process)
            return;
        // Provider diagnostics are never shown or logged by the desktop.
        process->setReadChannel(QProcess::StandardError);
        while (process->bytesAvailable())
            process->read(8192);
        process->setReadChannel(QProcess::StandardOutput);
    });
    connect(process, &QProcess::errorOccurred, this, [this, process](QProcess::ProcessError) {
        if (process_ == process)
            fail("Google Drive is unavailable or access was denied. Reconnect to retry.");
    });
    connect(process, qOverload<int, QProcess::ExitStatus>(&QProcess::finished), this,
            [this, process](int, QProcess::ExitStatus) {
                if (process_ == process)
                    fail("Google Drive is unavailable or access was denied. Reconnect to retry.");
            });
    process->start(node.canonicalFilePath(), {cli.canonicalFilePath(), "drive-desktop"});
    return true;
}
void DriveKnowledgePanel::request(const QString &operation, const QJsonObject &extra) {
    if (!clean_ || !operation_.isEmpty() || qEnvironmentVariable("LMTI_STUDIO_ALLOW_GOOGLE_DRIVE") != "1")
        return;
    if ((operation == "connect" && (!configured_ || !status_checked_ || !acknowledgment_->isChecked())) ||
        (operation != "status" && operation != "connect" && connection_id_.isEmpty()))
        return;
    if (!start_process())
        return;
    if (next_request_id_ >= safe_integer) {
        fail("Google Drive is unavailable or access was denied. Reconnect to retry.");
        return;
    }
    request_id_ = ++next_request_id_;
    request_connection_id_ = connection_id_;
    request_extra_ = extra;
    operation_ = operation;
    authorization_opened_ = false;
    clear_preview();
    QJsonObject payload = extra;
    payload.insert("schema", "lmti.desktop.drive.request.v1");
    payload.insert("requestId", request_id_);
    payload.insert("projectId", project_id_);
    payload.insert("documentPath", document_path_);
    payload.insert("projectRevision", revision_);
    payload.insert("connectionId", request_connection_id_);
    payload.insert("operation", operation);
    const auto bytes = QJsonDocument(payload).toJson(QJsonDocument::Compact) + '\n';
    if (bytes.size() > 16 * 1024 || process_->write(bytes) != bytes.size()) {
        fail("Google Drive is unavailable or access was denied. Reconnect to retry.");
        return;
    }
    deadline_.start(operation == "connect" ? 300000 : 45000);
    set_status(operation == "status"    ? "Checking Google sign-in configuration…"
               : operation == "connect" ? "Complete Google sign-in in your browser. You can cancel here."
                                        : "Loading Google Drive…");
    update_actions();
}
void DriveKnowledgePanel::consume_output() {
    while (process_ && process_->bytesAvailable()) {
        output_ += process_->read(line_limit + 1 - output_.size());
        for (;;) {
            const auto newline = output_.indexOf('\n');
            if (newline < 0)
                break;
            const auto bytes = output_.left(newline);
            output_.remove(0, newline + 1);
            QJsonParseError parse;
            const auto document = QJsonDocument::fromJson(bytes, &parse);
            try {
                if (bytes.size() > line_limit || parse.error != QJsonParseError::NoError ||
                    !document.isObject())
                    throw std::runtime_error("Invalid Drive response");
                receive(document.object());
            } catch (...) {
                fail("Google Drive is unavailable or access was denied. Reconnect to retry.");
            }
            if (!process_)
                return;
        }
        if (output_.size() > line_limit) {
            fail("Google Drive response exceeded the limit. Reconnect to retry.");
            return;
        }
    }
}
void DriveKnowledgePanel::render_page(const QJsonObject &page, const QString &expected_folder) {
    const auto folder = item(object(page, "folder"));
    if (folder.value("kind") != "folder" ||
        (!expected_folder.isEmpty() && folder.value("id") != expected_folder) ||
        !page.value("files").isArray() || page.value("files").toArray().size() > 200 ||
        !page.value("partial").isBool())
        throw std::runtime_error("Invalid Drive page");
    const auto checked = text(page, "checkedAt", 80);
    const auto cursor = page.contains("nextCursor") ? digest(page, "nextCursor") : QString{};
    if (!cursor.isEmpty() && !page.value("partial").toBool())
        throw std::runtime_error("Invalid Drive paging");
    QSet<QString> ids;
    QVector<QJsonObject> records;
    for (const auto &value : page.value("files").toArray()) {
        if (!value.isObject())
            throw std::runtime_error("Invalid Drive row");
        const auto row = item(value.toObject());
        const auto key = id(row);
        if (ids.contains(key) || (picker_ && row.value("kind") != "folder"))
            throw std::runtime_error("Invalid Drive row scope");
        ids.insert(key);
        records.push_back(row);
    }
    const auto previous = current_folder_.value("id").toString();
    if (!previous.isEmpty() && folder.value("id") != previous) {
        if (pending_up_) {
            if (ancestors_.isEmpty() || ancestors_.back() != folder.value("id").toString())
                throw std::runtime_error("Invalid Drive parent");
            ancestors_.removeLast();
        } else
            ancestors_.append(previous);
    }
    QSignalBlocker blocker(files_);
    files_->clear();
    for (const auto &row : records) {
        auto record = new QTreeWidgetItem(
            files_, {row.value("name").toString(), kind_caption(row), row.value("modifiedTime").toString()});
        record->setData(0, Qt::UserRole, row.value("id").toString());
        record->setData(0, item_role, row);
        record->setToolTip(0, row.value("name").toString().toHtmlEscaped());
    }
    current_folder_ = folder;
    next_cursor_ = cursor;
    checked_at_ = checked;
    partial_ = page.value("partial").toBool();
    clear_preview();
}
void DriveKnowledgePanel::receive(const QJsonObject &response) {
    if (operation_.isEmpty() || response.value("requestId").toInteger(-1) != request_id_ ||
        response.value("projectId") != project_id_ || response.value("documentPath") != document_path_ ||
        response.value("projectRevision").toInteger(-1) != revision_ ||
        response.value("connectionId") != request_connection_id_)
        throw std::runtime_error("Wrong Drive response scope");
    if (response.value("schema") == "lmti.desktop.drive.event.v1") {
        if (operation_ != "connect" || response.value("event") != "authorize" || authorization_opened_)
            throw std::runtime_error("Invalid Drive event");
        const QUrl url(text(response, "url", 8192), QUrl::StrictMode);
        if (!authorized_url(url))
            throw std::runtime_error("Invalid Drive authorization URL");
        authorization_opened_ = true;
        if (!browser_handler_(url))
            fail("The Google sign-in page could not be opened. Reconnect to retry.");
        return;
    }
    if (response.value("schema") != "lmti.desktop.drive.response.v1" ||
        response.value("operation") != operation_ || response.value("purpose") != "local_view" ||
        response.value("externalEgress") != "denied" || !response.value("ok").isBool())
        throw std::runtime_error("Invalid Drive response boundary");
    if (!response.value("ok").toBool()) {
        const auto error = object(response, "error");
        const auto code = text(error, "code", 80);
        if (code == "DRIVE_NOT_CONFIGURED")
            fail("Google sign-in has not been configured by the LMTI publisher.");
        else
            fail("Google Drive is unavailable or access was denied. Reconnect to retry.");
        return;
    }
    const auto result = object(response, "result");
    if (operation_ == "status") {
        if (!result.value("configured").isBool() || !result.value("connected").isBool() ||
            result.value("connected").toBool() != !connection_id_.isEmpty())
            throw std::runtime_error("Invalid Drive status");
        configured_ = result.value("configured").toBool();
        status_checked_ = true;
        set_status(configured_ ? "Review the permission notice, then connect Google Drive."
                               : "Google sign-in has not been configured by the LMTI publisher.");
    } else if (operation_ == "connect") {
        if (!connection_id_.isEmpty() || !authorization_opened_)
            throw std::runtime_error("Invalid Drive connection");
        connection_id_ = digest(result, "connectionId");
        const auto account = object(result, "account");
        text(account, "id", 200);
        account_name_ = text(account, "displayName", 1024);
        picker_ = true;
        current_folder_ = {};
        ancestors_.clear();
        render_page(object(result, "page"));
        set_status("Choose a folder, then use it for this project session.");
    } else if (operation_ == "choose-folder") {
        picker_ = true;
        scope_id_.clear();
        root_folder_ = {};
        current_folder_ = {};
        ancestors_.clear();
        render_page(object(result, "page"));
        set_status("Choose a folder, then use it for this project session.");
    } else if (operation_ == "select-folder") {
        if (!picker_)
            throw std::runtime_error("Invalid Drive folder selection");
        const auto root = item(object(result, "root"));
        if (root.value("kind") != "folder" || root.value("id") != request_extra_.value("folderReference"))
            throw std::runtime_error("Wrong selected Drive folder");
        root_folder_ = root;
        scope_id_ = digest(result, "scopeId");
        picker_ = false;
        current_folder_ = {};
        ancestors_.clear();
        render_page(object(result, "page"), id(root));
        set_status("Folder selected. Choose a document to read locally.");
    } else if (operation_ == "browse-folders" || operation_ == "list") {
        if ((operation_ == "browse-folders") != picker_ || (!picker_ && scope_id_.isEmpty()))
            throw std::runtime_error("Wrong Drive page mode");
        render_page(object(result, "page"), request_extra_.value("folderId").toString());
        set_status(picker_ ? "Choose a folder, then use it for this project session."
                           : "Folder selected. Choose a document to read locally.");
    } else if (operation_ == "read") {
        const auto document = object(result, "document");
        const auto file = item(object(document, "file"));
        if (picker_ || scope_id_.isEmpty() || document.value("scopeId") != scope_id_ ||
            file.value("id") != request_extra_.value("fileId") ||
            file.value("version") != request_extra_.value("expectedVersion") ||
            file.value("readable") != true || !document.value("text").isString())
            throw std::runtime_error("Wrong Drive document scope");
        const auto content = document.value("text").toString();
        const auto bytes = content.toUtf8();
        if (bytes.size() > text_limit || content.contains(QChar::Null) ||
            QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex() !=
                digest(document, "contentHash").toLatin1())
            throw std::runtime_error("Invalid Drive document text");
        text(document, "checkedAt", 80);
        preview_->setPlainText(content);
        preview_title_->setProperty("driveFileName", file.value("name").toString());
        preview_title_->setProperty("driveVersion", file.value("version").toString());
        set_status("Document loaded for local viewing.");
    } else
        throw std::runtime_error("Unknown Drive operation");
    deadline_.stop();
    operation_.clear();
    request_extra_ = {};
    pending_up_ = false;
    translate();
    update_actions();
}
