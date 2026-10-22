#include "mcp_profile_panel.hpp"
#include "../../native/common/local_owner_path.hpp"
#include "../../native/common/strict_json.hpp"
#include "project_captions.hpp"
#include "studio_widgets.hpp"
#include <QApplication>
#include <QCheckBox>
#include <QComboBox>
#include <QDateTime>
#include <QDialog>
#include <QDialogButtonBox>
#include <QDir>
#include <QFileDialog>
#include <QFileInfo>
#include <QFormLayout>
#include <QJsonArray>
#include <QJsonDocument>
#include <QLineEdit>
#include <QPlainTextEdit>
#include <QProcess>
#include <QProcessEnvironment>
#include <QPointer>
#include <QRegularExpression>
#include <QSet>
#include <QTimer>
#include <QEvent>
#include <limits>
#include <cmath>
#include <QVBoxLayout>
#include <algorithm>

namespace {
QString caption(const char *value) { return project_caption(QString::fromUtf8(value)); }
QLabel *note(const QString &text) {
    auto result = new QLabel(text);
    result->setWordWrap(true);
    result->setTextFormat(Qt::PlainText);
    result->setProperty("verbatim", true);
    return result;
}
QString client_name(lmti::McpClient client) { return client == lmti::McpClient::Codex ? "Codex" : "Cursor"; }
QProcessEnvironment owner_environment() {
    QProcessEnvironment env;
    for (const auto *key : {"SystemRoot", "WINDIR"}) {
        const auto value = qEnvironmentVariable(key);
        if (!value.isEmpty()) env.insert(key, value);
    }
    env.insert("PYTHONIOENCODING", "utf-8");
    return env;
}
QByteArray fixed_process(const QString &python, const QStringList &args, const QByteArray &input) {
    lmti::detail::local_owner_path(python);
    QProcess process;
    process.setProcessEnvironment(owner_environment());
    process.setProcessChannelMode(QProcess::SeparateChannels);
    process.setStandardErrorFile(QProcess::nullDevice());
    QByteArray output;
    bool overflow = false;
    QObject::connect(&process, &QProcess::readyReadStandardOutput, &process, [&] {
        while (process.bytesAvailable()) {
            const auto chunk = process.read(4096);
            if (chunk.isEmpty()) break;
            if (overflow || output.size() + chunk.size() > 32768) { overflow = true; process.kill(); }
            else output += chunk;
        }
    });
    process.start(python, args, QIODevice::ReadWrite);
    if (!process.waitForStarted(1500)) throw lmti::Error("Cannot start the trusted client adapter.");
    process.write(input);
    process.closeWriteChannel();
    if (!process.waitForFinished(8000)) {
        process.kill(); process.waitForFinished(1000);
        throw lmti::Error("MCP operation timed out. No connection was verified.");
    }
    while (process.bytesAvailable()) {
        const auto chunk = process.read(4096);
        if (chunk.isEmpty()) break;
        if (output.size() + chunk.size() > 32768) overflow = true;
        if (!overflow) output += chunk;
    }
    if (overflow) throw lmti::Error("MCP operation exceeded response limits.");
    if (process.exitStatus() != QProcess::NormalExit || process.exitCode() != 0)
        throw lmti::Error("MCP operation is unavailable. Client settings were not verified.");
    return output;
}
QString binding_path(const QString &path) {
    if (path.isEmpty()) return {};
    auto value = lmti::detail::local_owner_path_lexical(path);
#ifdef Q_OS_WIN
    value = value.toCaseFolded();
#endif
    return value;
}
bool same_runtime(const lmti::McpRuntime &a, const lmti::McpRuntime &b) {
    return a.python == b.python && a.entry == b.entry && a.binary == b.binary && a.database == b.database;
}
void need(bool value, const char *message = "Project binding changed. Reopen setup to review it.") {
    if (!value) throw lmti::Error(message);
}
void fields(const QJsonObject &o, const QSet<QString> &expected) {
    need(o.size() == expected.size(), "Client adapter returned an invalid response.");
    for (auto i = o.begin(); i != o.end(); ++i)
        need(expected.contains(i.key()), "Client adapter returned an invalid response.");
}
QJsonObject owner_response(const QByteArray &bytes) {
    try { return lmti::detail::strict_json_object(bytes, 32768); }
    catch (...) { throw lmti::Error("Client adapter returned an invalid response."); }
}
QString fixed_target(const QString &root, lmti::McpClient client) {
    // Derive a comparison value only. Export never requires the linked root
    // to be online; config effects validate it before filesystem access.
    return QDir(lmti::detail::local_owner_path_lexical(root)).filePath(
        client == lmti::McpClient::Codex ? ".codex/config.toml" : ".cursor/mcp.json");
}
bool hash_value(const QJsonValue &value) {
    return value.isString() && QRegularExpression("^[a-f0-9]{64}$").match(value.toString()).hasMatch();
}
void checked_changes(const QJsonValue &value) {
    need(value.isObject()); const auto changes = value.toObject(); fields(changes, {"added", "updated", "removed"});
    QSet<QString> names;
    for (const auto &key : {"added", "updated", "removed"}) {
        need(changes.value(key).isArray() && changes.value(key).toArray().size() <= 32);
        for (const auto &name : changes.value(key).toArray()) {
            need(name.isString() && QRegularExpression("^[a-z][a-z0-9_-]{0,47}$").match(name.toString()).hasMatch());
            need(!names.contains(name.toString())); names.insert(name.toString());
        }
    }
}
void checked_preview(const QJsonObject &result, const QString &target, qint64 revision) {
    fields(result, {"ok", "state", "expected", "changes", "target", "revision", "verified"});
    const auto state = result.value("state");
    need(result.value("ok").isBool() && result.value("ok").toBool() && state.isString() &&
         (state == "not_applied" || state == "update_pending" || state == "applied") &&
         hash_value(result.value("expected")) && result.value("target").isString() &&
         binding_path(result.value("target").toString()) == binding_path(target) &&
         result.value("revision").isDouble() && result.value("revision").toDouble() == revision &&
         result.value("verified").isBool() && !result.value("verified").toBool());
    checked_changes(result.value("changes"));
}
void checked_inspection(const QJsonObject &state) {
    fields(state, {"ok", "state", "appliedRevision", "canRestore", "verified"});
    const auto status = state.value("state"), revision = state.value("appliedRevision");
    need(state.value("ok").isBool() && state.value("ok").toBool() && status.isString() &&
         (status == "not_applied" || status == "configured" || status == "recovery_required") &&
         state.value("canRestore").isBool() && state.value("verified").isBool() && !state.value("verified").toBool());
    need(revision.isNull() || (revision.isDouble() && revision.toDouble() >= 1 &&
         revision.toDouble() <= 9007199254740991.0 && std::floor(revision.toDouble()) == revision.toDouble()));
    if (status == "not_applied") need(revision.isNull());
    if (status == "configured") need(!revision.isNull());
}
bool unapplied_without_recovery(const QJsonObject &state) {
    checked_inspection(state);
    return state.value("state") == "not_applied" && state.value("appliedRevision").isNull() &&
           !state.value("canRestore").toBool();
}

} // namespace

struct McpProfilePanel::ReviewedBinding {
    quint64 epoch;
    McpSelection selection;
    lmti::LibraryToken library;
    lmti::LibraryEntry entry;
    lmti::McpProfile profile;
    lmti::McpRuntime runtime;
    QString helper;
};
struct McpProfilePanel::SetupReview {
    ReviewedBinding binding;
    lmti::McpClient client;
    lmti::McpGeneration generation;
    QString expected, target;
};
struct McpProfilePanel::WriteJob {
    std::shared_ptr<const SetupReview> review;
    QString action, expected;
    QByteArray output;
    bool overflow = false;
    QProcess *process = nullptr;
    QTimer *deadline = nullptr;
    QPointer<QLabel> message;
    QPointer<QPushButton> apply, restore, export_button;
};

McpProfilePanel::~McpProfilePanel() { if (qApp) qApp->removeEventFilter(this); }
bool McpProfilePanel::has_pending_write() const { return bool(write_); }
bool McpProfilePanel::eventFilter(QObject *watched, QEvent *event) {
    if (watched == qApp && event->type() == QEvent::Quit && has_pending_write()) {
        status_->setText(caption("A client update is pending. Wait for its result before closing Studio."));
        return true;
    }
    return QWidget::eventFilter(watched, event);
}
McpProfilePanel::ReviewedBinding McpProfilePanel::capture_review() const {
    need(!epoch_exhausted_ && selection_.clean && !selection_.project.isEmpty() && !selection_.database.isEmpty(),
         "Save and review the registered project before setting up MCP.");
    lmti::detail::local_owner_path(selection_.library);
    lmti::detail::local_owner_path(store_, false);
    const auto before = lmti::inspect_project_library(selection_.library);
    const auto selected = std::find_if(before.entries.begin(), before.entries.end(), [&](const auto &entry) {
        return entry.id == selection_.project;
    });
    need(selected != before.entries.end());
    need(binding_path(selected->path) == binding_path(selection_.database) &&
         binding_path(selected->folder) == binding_path(selection_.root));
    lmti::detail::local_owner_path(selection_.database);
    const auto document = lmti::load_project(selection_.database);
    need(document.project.id == selection_.project.toStdString() && document == selection_.saved);
    const auto profile = lmti::load_mcp_profile(store_, document.project.id);
    const auto after = lmti::inspect_project_library(selection_.library);
    need(before.token == after.token);
    const auto checked = std::find_if(after.entries.begin(), after.entries.end(), [&](const auto &entry) {
        return entry.id == selected->id;
    });
    need(checked != after.entries.end() && binding_path(checked->path) == binding_path(selected->path) &&
         binding_path(checked->folder) == binding_path(selected->folder));
    return {selection_epoch_, selection_, before.token, *selected, profile, runtime_, config_owner_};
}
void McpProfilePanel::require_review(const ReviewedBinding &review) const {
    need(review.epoch == selection_epoch_ && !epoch_exhausted_);
    const auto current = capture_review();
    need(current.library == review.library && current.selection == review.selection &&
         current.profile == review.profile && same_runtime(current.runtime, review.runtime) &&
         current.helper == review.helper && current.entry.id == review.entry.id &&
         binding_path(current.entry.path) == binding_path(review.entry.path) &&
         binding_path(current.entry.folder) == binding_path(review.entry.folder));
}
lmti::McpGeneration McpProfilePanel::generate(const ReviewedBinding &review, lmti::McpClient client) const {
    if (std::any_of(review.profile.servers.begin(), review.profile.servers.end(), [](const auto &server) {
        return server.enabled && server.transport == lmti::McpTransport::LmtiLocal;
    })) {
        for (const auto &path : {review.runtime.python, review.runtime.entry, review.runtime.binary, review.runtime.database})
            lmti::detail::local_owner_path(path);
    }
    return lmti::generate_mcp_config(review.profile, client, review.runtime);
}

McpProfilePanel::McpProfilePanel(QString store, QWidget *parent) : QWidget(parent), store_(std::move(store)) {
    setObjectName("projectMcpPanel");
    qApp->installEventFilter(this);
    auto body = new QVBoxLayout(this);
    body->setContentsMargins(0, 12, 0, 0);
    body->setSpacing(18);
    summary_ = note({}); summary_->setObjectName("mcpProfileSummary"); body->addWidget(summary_);
    QVBoxLayout *list_body;
    auto list_card = studio::panel("Project MCP servers", &list_body);
    auto toolbar = new QHBoxLayout;
    add_ = new QPushButton(caption("Add connection")); add_->setObjectName("addMcpConnection");
    add_->setProperty("primary", true);
    edit_ = new QPushButton(caption("Edit")); edit_->setObjectName("editMcpConnection");
    toggle_ = new QPushButton(caption("Enable / disable")); toggle_->setObjectName("toggleMcpConnection");
    toolbar->addWidget(add_); toolbar->addWidget(edit_); toolbar->addWidget(toggle_); toolbar->addStretch();
    list_body->addLayout(toolbar);
    empty_ = note({}); empty_->setObjectName("mcpEmptyState"); list_body->addWidget(empty_);
    servers_ = new QTreeWidget;
    servers_->setObjectName("projectMcpServers");
    servers_->setHeaderLabels({"Connection", "Type", "Setup"});
    studio::inventory(servers_); servers_->setMinimumHeight(120); servers_->setMaximumHeight(270);
    servers_->header()->setSectionResizeMode(QHeaderView::Stretch);
    list_body->addWidget(servers_);
    body->addWidget(list_card);
    auto client_row = new QHBoxLayout;
    for (int i = 0; i < 2; ++i) {
        QVBoxLayout *card_body;
        auto card = studio::panel(i == 0 ? "Codex" : "Cursor", &card_body);
        clients_[i] = note({}); clients_[i]->setObjectName(i == 0 ? "mcpCodexState" : "mcpCursorState");
        card_body->addWidget(clients_[i]);
        setup_[i] = new QPushButton(caption("Set up client"));
        setup_[i]->setObjectName(i == 0 ? "setupMcpCodex" : "setupMcpCursor");
        connect(setup_[i], &QPushButton::clicked, this, [this, i] {
            setup_client(i == 0 ? lmti::McpClient::Codex : lmti::McpClient::Cursor);
        });
        card_body->addWidget(setup_[i]); client_row->addWidget(card, 1);
    }
    body->addLayout(client_row);
    check_ = new QPushButton(caption("Check local LMTI MCP")); check_->setObjectName("checkLocalMcp");
    connect(check_, &QPushButton::clicked, this, [this] { check_local(); });
    body->addWidget(check_, 0, Qt::AlignLeft);
    status_ = note({}); status_->setObjectName("mcpOperationStatus"); body->addWidget(status_);
    body->addWidget(studio::caption("Configuration does not verify client access. Each client owns its sign-in.", "muted"));
    body->addStretch();
    connect(add_, &QPushButton::clicked, this, [this] { edit_server(true); });
    connect(edit_, &QPushButton::clicked, this, [this] { edit_server(false); });
    connect(servers_, &QTreeWidget::itemSelectionChanged, this, [this] {
        edit_->setEnabled(available_ && !has_pending_write() && !uncertain_ && servers_->currentItem());
        toggle_->setEnabled(available_ && !has_pending_write() && !uncertain_ && servers_->currentItem());
    });
    connect(toggle_, &QPushButton::clicked, this, [this] {
        if (!clean_ || has_pending_write() || uncertain_ || !servers_->currentItem()) return;
        const auto key = servers_->currentItem()->data(0, Qt::UserRole).toString().toStdString();
        try {
            const auto reviewed = capture_review();
            need(reviewed.profile == profile_, "Profile changed. Review the current profile before editing.");
            auto next = reviewed.profile;
            for (auto &server : next.servers) if (server.id == key) server.enabled = !server.enabled;
            need(next.revision < 9007199254740991LL, "Profile revision is exhausted.");
            auto acknowledged = reviewed; acknowledged.profile = next; ++acknowledged.profile.revision;
            QString message = caption("MCP profile saved. Update each client to use this revision.");
            require_review(reviewed);
            next.revision = lmti::save_mcp_profile(store_, next);
            // Native return confirms this write. Later refresh failures are advisory.
            if (selection_epoch_ == reviewed.epoch) profile_ = std::move(next);
            try { refresh(); require_review(acknowledged); }
            catch (...) { message += " " + caption("The current binding changed or review is unavailable."); }
            status_->setText(message);
        } catch (const std::exception &error) { status_->setText(QString::fromUtf8(error.what())); }
    });
    refresh();
}

void McpProfilePanel::bind(McpSelection selection, QStringList sites) {
    lmti::McpRuntime runtime{qEnvironmentVariable("LMTI_STUDIO_PYTHON_BINARY"),
        qEnvironmentVariable("LMTI_STUDIO_AGENT_ENTRY"),
        QDir(QApplication::applicationDirPath()).filePath("lmti-project.exe"), selection.database};
#ifndef Q_OS_WIN
    runtime.binary = QDir(QApplication::applicationDirPath()).filePath("lmti-project");
#endif
    const auto helper = qEnvironmentVariable("LMTI_STUDIO_MCP_CONFIG_OWNER");
    const bool changed = selection != selection_ || !same_runtime(runtime, runtime_) || helper != config_owner_;
    if (changed) {
        if (selection_epoch_ == std::numeric_limits<quint64>::max()) epoch_exhausted_ = true;
        else ++selection_epoch_;
    }
    selection_ = std::move(selection); sites_ = std::move(sites);
    project_ = selection_.project; database_ = selection_.database; root_ = selection_.root;
    clean_ = selection_.clean && !epoch_exhausted_;
    runtime_ = std::move(runtime); config_owner_ = helper;
    try {
        lmti::detail::local_owner_path(store_, false);
        profile_ = project_.isEmpty() ? lmti::McpProfile{} : lmti::load_mcp_profile(store_, project_.toStdString());
        if (changed && !has_pending_write() && !uncertain_) status_->clear();
        refresh();
    } catch (const std::exception &error) {
        profile_ = {}; clean_ = false; refresh();
        if (!has_pending_write() && !uncertain_) status_->setText(QString::fromUtf8(error.what()));
    }
}

void McpProfilePanel::refresh() {
    bool available = false;
    if (clean_ && !has_pending_write() && !uncertain_) {
        try { (void)capture_review(); available = true; } catch (...) {}
    }
    available_ = available;
    summary_->setText(available ? caption("One MCP profile for this project. Set up Codex and Cursor from the same revision.") :
                                caption("Save and review the registered project before setting up its MCP connections."));
    add_->setEnabled(available && profile_.servers.size() < 32);
    servers_->clear();
    empty_->setText(caption("Add your first MCP connection. Cloudflare and private endpoints are optional."));
    empty_->setVisible(profile_.servers.empty()); servers_->setVisible(!profile_.servers.empty());
    bool local = false;
    for (const auto &server : profile_.servers) {
        const bool builtin = server.transport == lmti::McpTransport::LmtiLocal;
        auto item = new QTreeWidgetItem(servers_, {QString::fromStdString(server.label),
            builtin ? caption("LMTI local") : server.private_endpoint ? caption("Private HTTPS") : caption("Remote HTTPS"),
            server.enabled ? caption("Client check needed") : caption("Disabled in profile")});
        item->setData(0, Qt::UserRole, QString::fromStdString(server.id));
        const auto detail = QString::fromStdString(builtin ? server.site : server.endpoint);
        item->setToolTip(0, "<qt>" + detail.toHtmlEscaped() + "</qt>");
        local |= builtin && server.enabled;
    }
    edit_->setEnabled(false); toggle_->setEnabled(false); check_->setEnabled(available && local);
    for (int i = 0; i < 2; ++i) {
        setup_[i]->setEnabled(!has_pending_write() && ((available && profile_.revision > 0) ||
            (uncertain_ && uncertain_->client == (i == 0 ? lmti::McpClient::Codex : lmti::McpClient::Cursor))));
        clients_[i]->setText(profile_.revision > 0 ? caption("Profile revision %1 · client access not verified").arg(profile_.revision) :
                                                   caption("Add a connection to begin."));
        if (available && profile_.revision > 0 && !root_.isEmpty()) {
            try {
                const auto client = i == 0 ? lmti::McpClient::Codex : lmti::McpClient::Cursor;
                const auto binding = capture_review();
                const auto generation = generate(binding, client);
                const SetupReview review{binding, client, generation, {}, fixed_target(binding.selection.root, client)};
                const auto state = config_operation(binding, request("status", review));
                checked_preview(state, review.target, generation.revision);
                require_review(binding);
                if (!state.value("ok").toBool())
                    clients_[i]->setText(caption("Configuration needs review. Open setup for details."));
                else if (state.value("state").toString() == "applied")
                    clients_[i]->setText(caption("Applied revision %1 · client access not verified").arg(binding.profile.revision));
                else if (state.value("state").toString() == "update_pending")
                    clients_[i]->setText(caption("Update pending · profile revision %1").arg(binding.profile.revision));
                else
                    clients_[i]->setText(caption("Not applied · profile revision %1").arg(binding.profile.revision));
            } catch (const std::exception &) {
                clients_[i]->setText(caption("Configuration status unavailable. Open setup or export."));
            }
        }
    }
}

void McpProfilePanel::edit_server(bool create) {
    if (!clean_ || has_pending_write() || uncertain_) return;
    std::optional<ReviewedBinding> captured;
    try {
        captured = capture_review();
        need(captured->profile == profile_, "Profile changed. Review the current profile before editing.");
    } catch (const std::exception &error) { status_->setText(QString::fromUtf8(error.what())); return; }
    const auto reviewed = *captured;
    lmti::McpServer server;
    if (!create) {
        if (!servers_->currentItem()) return;
        const auto key = servers_->currentItem()->data(0, Qt::UserRole).toString().toStdString();
        auto found = std::find_if(profile_.servers.begin(), profile_.servers.end(), [&](const auto &s) { return s.id == key; });
        if (found == profile_.servers.end()) return;
        server = *found;
    }
    QDialog dialog(this); dialog.setObjectName("mcpConnectionDialog");
    dialog.setWindowTitle(caption("MCP connection")); dialog.resize(580, 430);
    auto outer = new QVBoxLayout(&dialog);
    auto form = new QFormLayout;
    auto type = new QComboBox; type->setObjectName("mcpConnectionType");
    type->addItems({caption("Remote HTTPS"), caption("Cloudflare"), caption("Private via Tailscale"), caption("LMTI local")});
    type->setCurrentIndex(server.transport == lmti::McpTransport::LmtiLocal ? 3 : server.private_endpoint ? 2 : 0);
    auto name = new QLineEdit(QString::fromStdString(server.label)); name->setObjectName("mcpConnectionName"); name->setMaxLength(120);
    auto key = new QLineEdit(QString::fromStdString(server.id)); key->setObjectName("mcpConnectionKey"); key->setMaxLength(48); key->setEnabled(create);
    auto url = new QLineEdit(QString::fromStdString(server.endpoint)); url->setObjectName("mcpConnectionUrl"); url->setMaxLength(512);
    url->setPlaceholderText("https://your-server.example.com/mcp");
    auto site = new QComboBox; site->setObjectName("mcpConnectionSite"); site->addItems(sites_);
    site->setEditable(true); site->lineEdit()->setMaxLength(64);
    site->setCurrentText(QString::fromStdString(server.site));
    auto enabled = new QCheckBox(caption("Enabled")); enabled->setChecked(server.enabled);
    form->addRow(caption("Connection type"), type); form->addRow(caption("Name"), name);
    form->addRow(caption("Server key"), key); form->addRow(caption("Endpoint"), url);
    form->addRow(caption("Site"), site); form->addRow(enabled); outer->addLayout(form);
    auto help = note(caption("Use your approved MCP endpoint. Sign in separately in Codex/Cursor; never paste a token here."));
    outer->addWidget(help);
    auto failure = note({}); failure->setObjectName("mcpConnectionError"); outer->addWidget(failure);
    auto buttons = new QDialogButtonBox(QDialogButtonBox::Save | QDialogButtonBox::Cancel); outer->addWidget(buttons);
    auto update_type = [=] {
        url->setEnabled(type->currentIndex() != 3); site->setEnabled(type->currentIndex() == 3);
        if (create && name->text().isEmpty() && type->currentIndex() > 0) {
            name->setText(type->currentIndex() == 1 ? "Cloudflare" : type->currentIndex() == 2 ? "Private MCP" : "LMTI context");
            key->setText(type->currentIndex() == 1 ? "cloudflare" : type->currentIndex() == 2 ? "private_mcp" : "lmti_context");
        }
    };
    connect(type, &QComboBox::currentIndexChanged, &dialog, update_type); update_type();
    connect(buttons, &QDialogButtonBox::rejected, &dialog, &QDialog::reject);
    connect(buttons, &QDialogButtonBox::accepted, &dialog, [&] {
        try {
            const bool local = type->currentIndex() == 3;
            server = {key->text().trimmed().toStdString(), name->text().trimmed().toStdString(),
                      local ? std::string{} : url->text().trimmed().toStdString(),
                      local ? site->currentText().toStdString() : std::string{},
                      local ? lmti::McpTransport::LmtiLocal : lmti::McpTransport::RemoteHttps,
                      local ? lmti::McpAuth::None : lmti::McpAuth::ClientOAuth,
                      enabled->isChecked(), type->currentIndex() == 2};
            auto next = reviewed.profile;
            if (create) next.servers.push_back(server);
            else for (auto &entry : next.servers) if (entry.id == server.id) entry = server;
            need(next.revision < 9007199254740991LL, "Profile revision is exhausted.");
            auto acknowledged = reviewed; acknowledged.profile = next; ++acknowledged.profile.revision;
            QString message = caption("MCP profile saved. Update each client to use this revision.");
            need(!has_pending_write() && !uncertain_, "A client update needs review first.");
            require_review(reviewed);
            next.revision = lmti::save_mcp_profile(store_, next);
            if (selection_epoch_ == reviewed.epoch) profile_ = std::move(next);
            dialog.accept();
            try { refresh(); require_review(acknowledged); }
            catch (...) { message += " " + caption("The current binding changed or review is unavailable."); }
            status_->setText(message);
        } catch (const std::exception &error) { failure->setText(QString::fromUtf8(error.what())); }
    });
    dialog.exec();
}

QJsonObject McpProfilePanel::request(const QString &action, const SetupReview &review) const {
    const auto &selection = review.binding.selection;
    QJsonObject result{{"action", action}, {"root", selection.root},
        {"client", client_name(review.client).toLower()}, {"project", selection.project}};
    if (action != "inspect" && action != "restore_preview" && action != "restore_commit") {
        result["revision"] = static_cast<double>(review.generation.revision);
        result["content"] = QString::fromUtf8(review.generation.content);
        result["servers"] = QJsonDocument::fromJson(review.generation.servers_json).object();
    }
    return result;
}
QJsonObject McpProfilePanel::config_operation(const ReviewedBinding &review, const QJsonObject &request) const {
    lmti::checked_project_folder(review.selection.root);
    lmti::detail::local_owner_path(review.helper);
    const auto bytes = fixed_process(review.runtime.python, {"-I", review.helper},
                                    QJsonDocument(request).toJson(QJsonDocument::Compact));
    const auto result = owner_response(bytes);
    need(result.value("ok").isBool() && result.value("ok").toBool(), "Client configuration needs review.");
    return result;
}
void McpProfilePanel::start_config_write(std::shared_ptr<const SetupReview> review, const QString &action,
                                        const QString &expected, QLabel *message, QPushButton *apply,
                                        QPushButton *restore, QPushButton *export_button) {
    need(!has_pending_write(), "A client update is already pending.");
    need(action == "apply" || action == "restore_commit");
    need(hash_value(expected));
    if (action == "apply") {
        need(!uncertain_, "Inspect or restore the unconfirmed update before another apply.");
        need(expected == review->expected);
        require_review(review->binding);
    }
    lmti::detail::local_owner_path(review->binding.helper);
    lmti::checked_project_folder(review->binding.selection.root);
    const auto python = lmti::detail::local_owner_path(review->binding.runtime.python);
    need(binding_path(fixed_target(review->binding.selection.root, review->client)) == binding_path(review->target));
    auto payload = request(action, *review); payload["expected"] = expected;
    const auto bytes = QJsonDocument(payload).toJson(QJsonDocument::Compact);
    need(bytes.size() <= 128 * 1024, "Client request exceeds limits.");
    auto job = std::make_unique<WriteJob>();
    job->review = std::move(review); job->action = action; job->expected = expected;
    job->message = message; job->apply = apply; job->restore = restore; job->export_button = export_button;
    job->process = new QProcess(this); job->deadline = new QTimer(this); job->deadline->setSingleShot(true);
    auto process = job->process; auto deadline = job->deadline;
    process->setProcessEnvironment(owner_environment());
    process->setProcessChannelMode(QProcess::SeparateChannels);
    process->setStandardErrorFile(QProcess::nullDevice());
    write_ = std::move(job);
    connect(process, &QProcess::readyReadStandardOutput, this, [this, process] {
        while (process->bytesAvailable()) {
            const auto bytes = process->read(4096);
            if (bytes.isEmpty()) break;
            if (!write_ || write_->process != process) continue;
            if (write_->overflow || write_->output.size() + bytes.size() > 32768) {
                write_->overflow = true; write_->output.clear(); // Continue draining; never kill a writer.
            } else write_->output += bytes;
        }
    });
    process->start(python, {"-I", write_->review->binding.helper}, QIODevice::ReadWrite);
    if (!process->waitForStarted(1500)) {
        // No request was dispatched; this is not a writing process.
        process->deleteLater(); deadline->deleteLater(); write_.reset();
        throw lmti::Error("Cannot start the trusted client adapter.");
    }
    connect(process, qOverload<int, QProcess::ExitStatus>(&QProcess::finished), this,
            [this](int, QProcess::ExitStatus) { finish_config_write(); });
    connect(deadline, &QTimer::timeout, this, [this] {
        if (!write_) return;
        const auto text = caption("Client update is still pending. Do not repeat it; its outcome is not confirmed.");
        status_->setText(text); if (write_->message) write_->message->setText(text);
    });
    if (process->write(bytes) != bytes.size()) write_->overflow = true;
    process->closeWriteChannel();
    deadline->start(8000);
    for (auto button : {apply, restore, export_button}) if (button) button->setEnabled(false);
    status_->setText(caption("Updating the reviewed client configuration…"));
    if (message) message->setText(status_->text());
    try { refresh(); } catch (...) { /* Dispatched writer remains owned and pending. */ }
    if (process->state() == QProcess::NotRunning)
        QTimer::singleShot(0, this, [this] { finish_config_write(); });
}
void McpProfilePanel::finish_config_write() {
    if (!write_ || write_->process->state() != QProcess::NotRunning) return;
    auto job = std::move(write_); job->deadline->stop();
    while (job->process->bytesAvailable()) {
        const auto tail = job->process->read(4096);
        if (tail.isEmpty()) break;
        if (job->output.size() + tail.size() > 32768) job->overflow = true;
        if (!job->overflow) job->output += tail;
    }
    bool confirmed = false;
    try {
        need(!job->overflow && job->process->exitStatus() == QProcess::NormalExit && job->process->exitCode() == 0);
        const auto result = owner_response(job->output);
        if (job->action == "apply") {
            fields(result, {"ok", "state", "expected", "changes", "target", "revision", "verified"});
            need(result.value("state") == "applied" && result.value("expected") == job->expected &&
                 result.value("revision").isDouble() && result.value("revision").toDouble() == job->review->generation.revision &&
                 result.value("verified").isBool() && !result.value("verified").toBool());
            checked_changes(result.value("changes"));
        } else {
            fields(result, {"ok", "state", "target"}); need(result.value("state") == "restored");
        }
        need(result.value("ok").isBool() && result.value("ok").toBool() && result.value("target").isString() &&
             binding_path(result.value("target").toString()) == binding_path(job->review->target));
        confirmed = true;
    } catch (...) { /* Dispatched write without a valid acknowledgment has an unknown outcome. */ }
    job->process->deleteLater(); job->deadline->deleteLater();
    QString text;
    if (confirmed) {
        uncertain_.reset(); uncertain_action_.clear();
        text = job->action == "apply"
            ? caption("Applied to the reviewed project. Reload the client; client access is not verified.")
            : caption("Restored the reviewed project's previous client configuration.");
        // Advisory only: a later source failure cannot demote the acknowledged write.
        try { require_review(job->review->binding); }
        catch (...) { text += " " + caption("The current binding changed or is unavailable. Review it again."); }
    } else {
        uncertain_ = job->review; uncertain_action_ = job->action;
        text = caption("Client update could not be confirmed. Inspect or restore the original reviewed project before another apply.");
    }
    try { refresh(); } catch (...) { /* Keep the already classified write outcome. */ }
    status_->setText(text);
    if (job->message) job->message->setText(text);
    if (job->apply) job->apply->setEnabled(false); // This preview was consumed; never replay it.
    if (job->export_button) job->export_button->setEnabled(false);
    if (job->restore) job->restore->setEnabled(!(confirmed && job->action == "restore_commit"));
}
void McpProfilePanel::setup_client(lmti::McpClient client) {
    try {
        need(!has_pending_write(), "A client update is pending.");
        const bool recovery_only = bool(uncertain_);
        std::shared_ptr<const SetupReview> review;
        if (recovery_only) {
            need(uncertain_->client == client, "Inspect the original client's unconfirmed update first.");
            review = uncertain_;
        } else {
            auto binding = capture_review();
            const auto generation = generate(binding, client); require_review(binding);
            profile_ = binding.profile;
            auto value = std::make_shared<SetupReview>(SetupReview{binding, client, generation, {}, {}});
            if (!binding.selection.root.isEmpty()) value->target = fixed_target(binding.selection.root, client);
            review = value;
        }
        QDialog dialog(this); dialog.setObjectName("mcpClientSetupDialog"); dialog.resize(760, 610);
        dialog.setWindowTitle(caption("Set up client") + " · " + client_name(client));
        auto body = new QVBoxLayout(&dialog);
        body->addWidget(note(caption("Preview the project configuration. Applying does not sign in or verify client access.")));
        const auto target_label = caption("Reviewed project: ") + review->binding.selection.project +
            "\n" + caption("Recovery folder: ") + review->binding.selection.root;
        auto target = note(target_label); target->setObjectName("mcpReviewedTarget"); body->addWidget(target);
        auto preview = new QPlainTextEdit(QString::fromUtf8(review->generation.content)); preview->setReadOnly(true);
        preview->setObjectName("mcpConfigPreview"); body->addWidget(preview, 1);
        auto message = note({}); message->setObjectName("mcpSetupStatus"); body->addWidget(message);
        auto actions = new QHBoxLayout;
        auto export_button = new QPushButton(caption("Export new file")); export_button->setObjectName("exportMcpConfig");
        auto apply = new QPushButton(caption("Apply to project")); apply->setObjectName("applyMcpConfig"); apply->setProperty("primary", true);
        auto restore = new QPushButton(caption("Restore last update")); restore->setObjectName("restoreMcpConfig");
        auto review_current = new QPushButton(caption("Review current configuration")); review_current->setObjectName("reviewCurrentMcpConfig");
        review_current->setVisible(recovery_only && uncertain_action_ == "apply");
        auto close = new QPushButton(caption("Close"));
        for (auto button : {export_button, apply, restore, review_current, close}) actions->addWidget(button);
        body->addLayout(actions);
        QString expected; bool apply_consumed = recovery_only, can_restore = false;
        if (!review->binding.selection.root.isEmpty()) {
            try {
                const auto state = config_operation(review->binding, request("inspect", *review));
                checked_inspection(state);
                can_restore = state.value("canRestore").toBool();
            } catch (...) { /* A missing adapter must not block remote-only export. */ }
        }
        if (!recovery_only) {
            try {
                need(!review->binding.selection.root.isEmpty(), "Link a registered project folder to apply configuration. Export remains available.");
                require_review(review->binding);
                const auto validation = config_operation(review->binding, request("preview", *review));
                checked_preview(validation, review->target, review->generation.revision); require_review(review->binding);
                expected = validation.value("expected").toString();
                auto frozen = std::make_shared<SetupReview>(*review); frozen->expected = expected; review = frozen;
                message->setText(caption("Configuration preview is ready. Other servers are preserved."));
            } catch (const std::exception &error) { message->setText(QString::fromUtf8(error.what())); }
        } else message->setText(caption("The previous update was not confirmed. This review concerns its original folder only."));
        apply->setEnabled(!expected.isEmpty() && !recovery_only);
        export_button->setEnabled(!recovery_only);
        restore->setEnabled(can_restore);
        connect(close, &QPushButton::clicked, &dialog, &QDialog::accept);
        connect(review_current, &QPushButton::clicked, &dialog, [&] {
            try {
                need(!has_pending_write() && uncertain_ == review && uncertain_action_ == "apply",
                     "Only a finished, unconfirmed apply can be reviewed here.");
                require_review(review->binding);
                const auto first = config_operation(review->binding, request("inspect", *review));
                need(unapplied_without_recovery(first), "Protected recovery remains available or requires attention.");
                require_review(review->binding);
                const auto current = config_operation(review->binding, request("preview", *review));
                checked_preview(current, review->target, review->generation.revision);
                need(current.value("state") == "not_applied");
                require_review(review->binding);
                const auto last = config_operation(review->binding, request("inspect", *review));
                need(unapplied_without_recovery(last), "Protected recovery changed; inspect the original folder again.");
                require_review(review->binding);
                // This explicit acknowledgment establishes only the current
                // reviewable state. It never classifies or retries the old write.
                const auto result = caption("The previous update remains unconfirmed. Current configuration can be reviewed again; no write was retried. Reopen setup for a fresh review.");
                apply_consumed = true; apply->setEnabled(false); export_button->setEnabled(false);
                uncertain_.reset(); uncertain_action_.clear();
                try { refresh(); } catch (...) { /* Keep the completed read-only reconciliation. */ }
                status_->setText(result); message->setText(result); dialog.accept();
            } catch (const std::exception &error) { message->setText(QString::fromUtf8(error.what())); }
        });
        connect(export_button, &QPushButton::clicked, &dialog, [&] {
            if (has_pending_write() || uncertain_ || apply_consumed) return;
            const auto path = QFileDialog::getSaveFileName(&dialog, caption("Export new file"),
                client == lmti::McpClient::Codex ? "lmti-codex.toml" : "lmti-cursor.json");
            if (path.isEmpty()) return;
            try {
                require_review(review->binding);
                const auto destination = lmti::detail::local_owner_path(path, false);
                need(!QFileInfo::exists(destination), "Export requires a new file in a normal local directory.");
                need(review->generation.content.size() <= 128 * 1024, "Configuration exceeds export limits.");
                require_review(review->binding);
                lmti::detail::local_owner_path(destination, false);
                QFile file(destination);
                need(file.open(QIODevice::WriteOnly | QIODevice::NewOnly), "Cannot export to an existing or unavailable file.");
                // Exclusive creation protects another legitimate exporter. A
                // short write retains its new partial file for inspection.
                need(file.write(review->generation.content) == review->generation.content.size() && file.flush(),
                     "Export is incomplete. Inspect the new output file before using it.");
                file.close();
                message->setText(caption("Exported. Client configuration and access are not yet verified."));
            } catch (const std::exception &error) { message->setText(QString::fromUtf8(error.what())); }
        });
        connect(apply, &QPushButton::clicked, &dialog, [&] {
            try {
                need(!apply_consumed && !uncertain_ && !has_pending_write(), "This preview cannot be applied again.");
                require_review(review->binding);
                apply_consumed = true; apply->setEnabled(false);
                start_config_write(review, "apply", expected, message, apply, restore, export_button);
            } catch (const std::exception &error) { message->setText(QString::fromUtf8(error.what())); }
        });
        connect(restore, &QPushButton::clicked, &dialog, [&] {
            try {
                need(!has_pending_write(), "A client update is pending.");
                const auto recovery = config_operation(review->binding, request("restore_preview", *review));
                fields(recovery, {"ok", "expected", "protectedRecovery", "verified"});
                need(hash_value(recovery.value("expected")) && recovery.value("protectedRecovery").isBool() &&
                     recovery.value("protectedRecovery").toBool() && recovery.value("verified").isBool() && !recovery.value("verified").toBool());
                apply_consumed = true; apply->setEnabled(false);
                start_config_write(review, "restore_commit", recovery.value("expected").toString(), message, apply, restore, export_button);
            } catch (const std::exception &error) { message->setText(QString::fromUtf8(error.what())); }
        });
        dialog.exec();
    } catch (const std::exception &error) { status_->setText(QString::fromUtf8(error.what())); }
}

void McpProfilePanel::check_local() {
    try {
        need(!has_pending_write() && !uncertain_, "Inspect the pending or unconfirmed client update first.");
        const auto review = capture_review();
        const auto found = std::find_if(review.profile.servers.begin(), review.profile.servers.end(), [](const auto &server) {
            return server.enabled && server.transport == lmti::McpTransport::LmtiLocal;
        });
        need(found != review.profile.servers.end(), "Add an enabled LMTI local connection first.");
        const auto generation = generate(review, lmti::McpClient::Cursor);
        const auto config = QJsonDocument::fromJson(generation.servers_json).object().value(QString::fromStdString(found->id)).toObject();
        QStringList args; for (const auto &value : config.value("args").toArray()) args << value.toString();
        const QJsonObject initialize{{"jsonrpc", "2.0"}, {"id", 1}, {"method", "initialize"},
            {"params", QJsonObject{{"protocolVersion", "2025-06-18"}, {"capabilities", QJsonObject{}},
                {"clientInfo", QJsonObject{{"name", "lmti-studio-probe"}, {"version", "1"}}}}}};
        const QJsonObject initialized{{"jsonrpc", "2.0"}, {"method", "notifications/initialized"}};
        const QJsonObject list{{"jsonrpc", "2.0"}, {"id", 2}, {"method", "tools/list"}};
        require_review(review);
        const auto bytes = fixed_process(review.runtime.python, args, QJsonDocument(initialize).toJson(QJsonDocument::Compact) + "\n" +
            QJsonDocument(initialized).toJson(QJsonDocument::Compact) + "\n" + QJsonDocument(list).toJson(QJsonDocument::Compact) + "\n");
        bool ready = false, listed = false;
        const QSet<QString> expected{"lmti_context", "lmti_entity", "lmti_observations", "lmti_related"};
        for (const auto &line : bytes.split('\n')) {
            if (line.trimmed().isEmpty()) continue;
            const auto response = owner_response(line); fields(response, {"jsonrpc", "id", "result"});
            need(response.value("jsonrpc") == "2.0" && response.value("id").isDouble() && response.value("result").isObject());
            if (response.value("id").toDouble() == 1) {
                need(!ready && response.value("result").toObject().value("protocolVersion") == "2025-06-18"); ready = true;
            } else {
                need(response.value("id").toDouble() == 2 && !listed);
                const auto tools = response.value("result").toObject().value("tools"); need(tools.isArray() && tools.toArray().size() == 4);
                QSet<QString> names;
                for (const auto &tool : tools.toArray()) {
                    need(tool.isObject() && tool.toObject().value("name").isString());
                    const auto name = tool.toObject().value("name").toString(); need(!names.contains(name)); names.insert(name);
                }
                need(names == expected); listed = true;
            }
        }
        need(ready && listed, "LMTI MCP handshake or tool list was not verified."); require_review(review);
        status_->setText(caption("Local LMTI MCP responded with 4 tools at %1. Codex/Cursor access and remote endpoints are not verified.")
            .arg(QDateTime::currentDateTimeUtc().toString(Qt::ISODate)));
    } catch (const std::exception &error) { status_->setText(QString::fromUtf8(error.what())); }
}
