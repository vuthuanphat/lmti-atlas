#include "project_window.hpp"
#include "../../native/common/local_owner_path.hpp"
#include "project_captions.hpp"
#include "project_language.hpp"
#include "studio_graph.hpp"
#include "studio_style.hpp"
#include "studio_theme.hpp"
#include "studio_widgets.hpp"
#include "toolbar_icons.hpp"
#include "workspace_tabs.hpp"
#include <QAction>
#include <QApplication>
#include <QCloseEvent>
#include <QCryptographicHash>
#include <QDateTime>
#include <QDialogButtonBox>
#include <QDir>
#include <QFile>
#include <QFileDialog>
#include <QFileInfo>
#include <QFormLayout>
#include <QFrame>
#include <QGraphicsRectItem>
#include <QGraphicsSimpleTextItem>
#include <QGridLayout>
#include <QHeaderView>
#include <QInputDialog>
#include <QJsonArray>
#include <QJsonDocument>
#include <QMenuBar>
#include <QMessageBox>
#include <QPainter>
#include <QPainterPath>
#include <QPushButton>
#include <QRegularExpression>
#include <QScreen>
#include <QScrollArea>
#include <QScrollBar>
#include <QSettings>
#include <QSignalBlocker>
#include <QSpinBox>
#include <QSplitter>
#include <QStatusBar>
#include <QStyle>
#include <QTabBar>
#include <QTimeZone>
#include <QTimer>
#include <QToolBar>
#include <QUuid>
#include <QVBoxLayout>
#include <algorithm>
#include <set>
#include <tuple>

namespace {
QString s(const std::string &v) {
    return QString::fromStdString(v);
}
std::string uid(const char *prefix) {
    return std::string(prefix) + "-" + QUuid::createUuid().toString(QUuid::Id128).toStdString();
}
template <class T> QString label(const std::vector<T> &rows, const std::string &id) {
    for (const auto &r : rows)
        if (r.id == id)
            return s(r.label);
    return id.empty() ? "—" : s(id);
}
template <class T> T selected(const std::vector<T> &rows, const std::string &id, const char *prefix) {
    for (const auto &r : rows)
        if (r.id == id)
            return r;
    if (!id.empty())
        throw lmti::Error("Selected record no longer exists.");
    T value;
    value.id = uid(prefix);
    return value;
}
template <class T> void upsert(std::vector<T> &rows, const T &value) {
    for (auto &r : rows)
        if (r.id == value.id) {
            r = value;
            return;
        }
    rows.push_back(value);
}
QString selected_id(QTreeWidget *tree) {
    return tree->selectedItems().isEmpty() ? QString{}
                                           : tree->selectedItems().front()->data(0, Qt::UserRole).toString();
}
QTreeWidgetItem *row(QTreeWidget *tree, const std::string &id, const QStringList &values,
                     const QVariantMap &filters = {}) {
    auto item = new QTreeWidgetItem(tree, values);
    item->setData(0, Qt::UserRole, s(id));
    item->setData(0, studio::filter_values_role, filters);
    for (int i = 0; i < values.size(); ++i)
        item->setToolTip(i, "<qt>" + values[i].toHtmlEscaped().replace('\n', "<br>") + "</qt>");
    return item;
}
QLabel *plain(const QString &text) {
    auto l = new QLabel(project_text(text));
    l->setTextFormat(Qt::PlainText);
    l->setWordWrap(true);
    return l;
}
QToolButton *column_picker(QTreeWidget *tree, QWidget *parent) {
    auto button = new QToolButton(parent);
    button->setObjectName(tree->objectName() + "Columns");
    button->setProperty("columnPicker", true);
    button->setText(project_caption("Columns"));
    button->setProperty("uiCaption", "Columns");
    button->setAccessibleName(project_caption("Choose visible columns"));
    button->setProperty("uiAccessibleName", "Choose visible columns");
    button->setToolTip(project_caption("Choose visible columns"));
    button->setProperty("uiTooltip", "Choose visible columns");
    button->setPopupMode(QToolButton::InstantPopup);
    auto menu = new QMenu(button);
    for (int column = 1; column < tree->columnCount(); ++column) {
        auto action = menu->addAction(tree->headerItem()->text(column));
        action->setProperty("uiCaption", project_ui_source(action->text()));
        action->setCheckable(true);
        action->setChecked(!tree->isColumnHidden(column));
        QObject::connect(action, &QAction::toggled, tree,
                         [tree, column](bool shown) { tree->setColumnHidden(column, !shown); });
        QObject::connect(menu, &QMenu::aboutToShow, action, [tree, column, action] {
            QSignalBlocker blocker(action);
            action->setChecked(!tree->isColumnHidden(column));
        });
    }
    button->setMenu(menu);
    return button;
}
class Form : public QDialog {
    QVBoxLayout *outer_, *body_;
    QGridLayout *fields_ = nullptr;
    QString group_;
    int slot_ = 0;
    QScrollArea *scroll_;
    void reveal_field(QWidget *field) {
        auto target = field->parentWidget();
        if (!target || !target->property("formField").toBool())
            target = field;
        const auto bounds = QRect(target->mapTo(scroll_->widget(), QPoint()), target->size());
        // Qt's ensureWidgetVisible uses the input caret for a focused line edit.
        // Reveal the full field container, including its label/errors instead.
        scroll_->ensureVisible(bounds.center().x(), bounds.center().y(),
                               std::min(bounds.width() / 2 + 12, scroll_->viewport()->width() / 2 - 12),
                               std::min(bounds.height() / 2 + 12, scroll_->viewport()->height() / 2 - 12));
    }
    void field(const QString &name, QWidget *widget, bool wide = false) {
        const auto source = project_ui_source(name);
        QString group = group_.isEmpty() ? "Summary" : group_;
        if (source == "Component" || source == "Release" || source == "Device" || source == "Repository")
            group = "Links";
        if (source == "Checklist / completion" || source == "Evidence reference")
            group = "Completion";
        if (source == "Parent folder" || source == "Folder name")
            group = "Local folder";
        if (group != group_) {
            group_ = group;
            slot_ = 0;
            QVBoxLayout *section;
            auto card = studio::panel(group, &section);
            fields_ = new QGridLayout;
            fields_->setHorizontalSpacing(16);
            fields_->setVerticalSpacing(14);
            fields_->setColumnStretch(0, 1);
            fields_->setColumnStretch(1, 1);
            section->addLayout(fields_);
            body_->addWidget(card);
        }
        auto container = new QWidget;
        container->setProperty("formField", true);
        auto layout = new QVBoxLayout(container);
        layout->setContentsMargins(0, 0, 0, 0);
        layout->setSpacing(6);
        if (!qobject_cast<QCheckBox *>(widget))
            layout->addWidget(studio::caption(source));
        layout->addWidget(widget);
        if (wide && slot_ % 2)
            ++slot_;
        fields_->addWidget(container, slot_ / 2, slot_ % 2, 1, wide ? 2 : 1);
        slot_ += wide ? 2 : 1;
    }
    struct Check {
        QWidget *field;
        QLabel *error;
        std::function<QString()> validate;
    };
    std::vector<Check> checks_;

  public:
    explicit Form(QWidget *parent, const QString &title) : QDialog(parent) {
        setObjectName("projectRecordDialog");
        setWindowTitle(project_text(title));
        const auto available =
            parent && parent->screen() ? parent->screen()->availableGeometry().height() : 900;
        resize(740, std::min(740, std::max(480, available - 64)));
        outer_ = new QVBoxLayout(this);
        outer_->setContentsMargins(20, 20, 20, 0);
        outer_->addWidget(studio::caption(project_ui_source(title), "projectHeading"));
        scroll_ = new QScrollArea;
        scroll_->setObjectName("recordFormScroll");
        scroll_->setWidgetResizable(true);
        scroll_->setFrameShape(QFrame::NoFrame);
        auto body = new QWidget;
        body_ = new QVBoxLayout(body);
        body_->setContentsMargins(0, 0, 0, 0);
        body_->setSpacing(16);
        body_->setAlignment(Qt::AlignTop);
        scroll_->setWidget(body);
        // The scrollbar range settles after nested field/error layouts resize.
        // Keep the focused field visible through those asynchronous changes.
        connect(scroll_->verticalScrollBar(), &QScrollBar::rangeChanged, this, [this] {
            auto focused = focusWidget();
            if (focused && scroll_->widget()->isAncestorOf(focused))
                reveal_field(focused);
        });
        outer_->addWidget(scroll_, 1);
    }
    QVBoxLayout *layout() const {
        return body_;
    }
    QLineEdit *text(const QString &name, const std::string &value, int limit = 120) {
        auto edit = new QLineEdit(s(value));
        edit->setMaxLength(limit);
        edit->setObjectName("field" + name);
        field(name, edit,
              QStringList{"Name", "Title", "Goal", "Project name", "Acceptance criteria", "Parent folder",
                          "Folder name", "Local reference", "Interface / contract"}
                  .contains(project_ui_source(name)));
        check(edit, [edit, name = project_ui_source(name), limit] {
            const auto value = edit->text().trimmed().toStdString();
            const bool required = QStringList{"Project name",
                                              "Folder name",
                                              "Parent folder",
                                              "Name",
                                              "Title",
                                              "Version",
                                              "Alias",
                                              "Board / model",
                                              "Label",
                                              "Source",
                                              "Local reference",
                                              "Fingerprint",
                                              "Acceptance criteria",
                                              "Interface / contract",
                                              "Site"}
                                      .contains(name);
            if (required && value.empty())
                return project_caption("This field is required.");
            if (value.size() > static_cast<std::size_t>(limit) || !lmti::valid_metadata_utf8(value) ||
                lmti::secret_like(value) ||
                std::any_of(value.begin(), value.end(), [](unsigned char c) { return c < 32 || c == 127; }))
                return project_caption("Use nonsecret text within the field limit.");
            if (name == "Due date" && !value.empty() &&
                (!QDate::fromString(edit->text().trimmed(), "yyyy-MM-dd").isValid() ||
                 edit->text().trimmed().size() != 10))
                return project_caption("Use a valid YYYY-MM-DD date.");
            if (name == "Site") {
                try {
                    lmti::validate_id(value);
                } catch (...) {
                    return project_caption("Use a site identifier with letters, digits, '.', '_' or '-'.");
                }
            }
            if (name == "Locator" && value.find("://") != std::string::npos &&
                (value.find('@') != std::string::npos || value.find('?') != std::string::npos ||
                 value.find('#') != std::string::npos ||
                 !(value.starts_with("https://") || value.starts_with("ssh://"))))
                return project_caption("Use HTTPS/SSH without credentials, query or fragment.");
            return QString{};
        });
        return edit;
    }
    void check(QWidget *field, std::function<QString()> validate) {
        auto error = plain({});
        error->setObjectName(field->objectName() + "Error");
        error->setProperty("verbatim", true);
        error->setStyleSheet("color:#b91c1c;font-size:12px;");
        error->hide();
        field->parentWidget()->layout()->addWidget(error);
        checks_.push_back({field, error, std::move(validate)});
    }
    QComboBox *choice(const QString &name, const QStringList &values, const std::string &value) {
        auto c = new studio::Choice;
        for (const auto &item : values)
            c->addItem(studio::enum_caption(item), item);
        c->setCurrentIndex(c->findData(s(value)));
        c->setObjectName("field" + name);
        QStringList labels;
        for (const auto &enum_value : values)
            labels << studio::enum_label(enum_value);
        c->setProperty("uiChoices", labels);
        field(name, c);
        return c;
    }
    QCheckBox *checkbox(const QString &name, bool checked) {
        auto c = new QCheckBox(project_text(name));
        c->setObjectName("field" + name);
        c->setChecked(checked);
        field(name, c);
        return c;
    }
    template <class T>
    QComboBox *reference(const QString &name, const std::vector<T> &rows, const std::string &value,
                         bool required = false) {
        auto c = new studio::Choice;
        c->setObjectName("field" + name);
        if (!required)
            c->addItem(project_caption("None"), "");
        for (const auto &r : rows)
            c->addItem(s(r.label), s(r.id));
        auto index = c->findData(s(value));
        if (index >= 0)
            c->setCurrentIndex(index);
        field(name, c);
        if (required)
            check(c, [c] {
                return c->currentData().toString().isEmpty() ? project_caption("Choose a record first.")
                                                             : QString{};
            });
        return c;
    }
    lmti::Privacy privacy(lmti::Privacy initial, QComboBox *&widget) {
        widget = choice("Visibility", {"internal", "public"}, lmti::name(initial));
        return initial;
    }
    bool accept_form(const std::function<void()> &submit, const QString &button_text = "Save") {
        auto notice = plain(
            "Chỉ lưu thông tin không bí mật. Dữ liệu được cho phép chia sẻ có thể gửi tới Agent bên ngoài.");
        body_->addWidget(notice);
        auto failure = plain({});
        failure->setObjectName("formValidationError");
        failure->setProperty("verbatim", true);
        failure->setStyleSheet("color:#b45309;background:#fffbeb;padding:10px;");
        failure->hide();
        outer_->addWidget(failure);
        auto buttons = new QDialogButtonBox(QDialogButtonBox::Save | QDialogButtonBox::Cancel);
        buttons->button(QDialogButtonBox::Save)->setText(project_text(button_text));
        buttons->button(QDialogButtonBox::Save)->setProperty("primary", true);
        buttons->button(QDialogButtonBox::Cancel)->setText(project_caption("Cancel"));
        outer_->addWidget(buttons);
        connect(buttons, &QDialogButtonBox::accepted, this, [this, submit, failure] {
            QWidget *first_error = nullptr;
            QHash<QWidget *, QStringList> field_errors;
            failure->hide();
            for (const auto &check : checks_) {
                const auto message = check.validate();
                check.error->setText(message);
                check.error->setVisible(!message.isEmpty());
                auto &messages = field_errors[check.field];
                if (!message.isEmpty())
                    messages.push_back(message);
                if (!message.isEmpty() && !first_error)
                    first_error = check.field;
            }
            for (auto field = field_errors.begin(); field != field_errors.end(); ++field) {
                field.key()->setAccessibleDescription(field.value().join("\n"));
                field.key()->setProperty("invalid", !field.value().empty());
                field.key()->style()->unpolish(field.key());
                field.key()->style()->polish(field.key());
            }
            if (first_error) {
                first_error->setFocus();
                reveal_field(first_error);
                // Error labels resize the layout after this signal. Scroll again
                // after those heights settle, without changing the draft.
                QTimer::singleShot(0, this, [this, first_error] { reveal_field(first_error); });
                return;
            }
            try {
                submit();
                accept();
            } catch (const std::exception &e) {
                failure->setText(
                    project_caption("Please check the form: %1").arg(QString::fromUtf8(e.what())));
                failure->show();
                if (auto field = findChild<QLineEdit *>())
                    field->setFocus();
            }
        });
        connect(buttons, &QDialogButtonBox::rejected, this, &QDialog::reject);
        capture_project_captions(this);
        apply_project_captions(this);
        return exec() == QDialog::Accepted;
    }
};
std::string value(QLineEdit *e) {
    return e->text().trimmed().toStdString();
}
std::string value(QComboBox *e) {
    return e->currentData().toString().toStdString();
}
std::string reference(QComboBox *e) {
    return e->currentData().toString().toStdString();
}
} // namespace

ProjectWindow::ProjectWindow(QWidget *parent, QString catalog) : QMainWindow(parent) {
    studio::ensure_style();
    setObjectName("projectWindow");
    resize(1440, 900);
    document_.project = {"project-unset", "Untitled", "", lmti::Privacy::Internal};
    catalog_ = catalog;
    if (catalog_.isEmpty()) {
        auto directory = QDir(QApplication::applicationDirPath()).absoluteFilePath("../data");
        if (!QDir().mkpath(directory))
            throw lmti::Error("Cannot create local project catalog directory.");
        catalog_ = QDir(directory).absoluteFilePath("projects-catalog.sqlite");
    }
    root_ = new QStackedWidget;
    root_->setObjectName("projectRoot");
    library_path_ = QDir(QFileInfo(catalog_).absolutePath()).filePath("project-library.sqlite");
    const auto settings_path = QDir(QFileInfo(catalog_).absolutePath()).filePath("ui-settings.ini");
    const QFileInfo settings_info(settings_path);
    project_english = true;
    if (settings_info.isFile() && !settings_info.isSymLink() && settings_info.size() <= 4096)
        project_english =
            QSettings(settings_path, QSettings::IniFormat).value("language", "en").toString() != "vi";
    auto shell = new QWidget;
    auto shell_layout = new QHBoxLayout(shell);
    shell_layout->setContentsMargins(0, 0, 0, 0);
    shell_layout->setSpacing(0);
    auto sidebar = new QFrame;
    sidebar->setObjectName("projectSidebar");
    sidebar->setFixedWidth(224);
    auto sidebar_layout = new QVBoxLayout(sidebar);
    sidebar_layout->setContentsMargins(16, 22, 16, 16);
    sidebar_layout->setSpacing(10);
    auto brand = plain("LMTI");
    brand->setObjectName("brand");
    sidebar_layout->addWidget(brand);
    auto brand_note = plain("Architecture Studio");
    brand_note->setObjectName("brandNote");
    sidebar_layout->addWidget(brand_note);
    brand_note->hide();
    auto sidebar_scroll = new QScrollArea;
    sidebar_scroll->setObjectName("sidebarScroll");
    sidebar_scroll->setWidgetResizable(true);
    sidebar_scroll->setFrameShape(QFrame::NoFrame);
    sidebar_scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    sidebar_scroll->viewport()->setObjectName("sidebarViewport");
    sidebar_scroll->viewport()->installEventFilter(this);
    auto sidebar_body = new QWidget;
    auto body_layout = new QVBoxLayout(sidebar_body);
    body_layout->setContentsMargins(0, 14, 0, 0);
    body_layout->setSpacing(10);
    body_layout->setAlignment(Qt::AlignTop);
    sidebar_layout->addWidget(sidebar_scroll, 1);
    auto library_button = new QPushButton(project_caption("Project library"));
    library_button->setIcon(studio::toolbar_icon(studio::ToolbarIcon::Knowledge, true));
    library_button->setObjectName("showProjectLibrary");
    library_button->setCheckable(true);
    connect(library_button, &QPushButton::clicked, this, [this] { show_library(); });
    body_layout->addWidget(library_button);
    resume_button_ = new QPushButton("Resume project");
    resume_button_->setObjectName("resumeProject");
    connect(resume_button_, &QPushButton::clicked, this, [this] { show_page(resume_page_); });
    body_layout->addWidget(resume_button_);
    recent_projects_ = new QWidget;
    recent_projects_->setSizePolicy(QSizePolicy::Preferred, QSizePolicy::Fixed);
    auto recent_layout = new QVBoxLayout(recent_projects_);
    recent_layout->setContentsMargins(0, 6, 0, 0);
    recent_layout->addWidget(studio::caption("Recent projects", "navSection"));
    recent_list_ = new QListWidget;
    recent_list_->setObjectName("recentProjectNavigation");
    recent_list_->setIconSize(QSize(18, 18));
    recent_list_->setFixedHeight(132);
    recent_layout->addWidget(recent_list_);
    body_layout->addWidget(recent_projects_);
    connect(recent_list_, &QListWidget::itemClicked, this, [this](auto item) {
        const auto intent = capture_library_intent();
        const auto path = item->data(Qt::UserRole).toString();
        const auto id = item->data(Qt::UserRole + 1).toString();
        if (!discard_allowed())
            return;
        try {
            open_project_intent(path, id, intent);
        } catch (const std::exception &exception) {
            error(exception);
        }
    });
    project_switcher_ = new QWidget;
    auto switch_layout = new QVBoxLayout(project_switcher_);
    switch_layout->setContentsMargins(0, 14, 0, 6);
    auto switch_title = plain("Switch project");
    switch_title->hide();
    switch_layout->addWidget(switch_title);
    project_picker_ = new studio::Choice;
    project_picker_->setObjectName("projectPicker");
    project_picker_->setAccessibleName("Chuyển dự án");
    switch_layout->addWidget(project_picker_);
    body_layout->addWidget(project_switcher_);
    connect(project_picker_, &QComboBox::activated, this, [this](int index) {
        auto path = project_picker_->itemData(index).toString();
        if (!path.isEmpty() && path != path_) {
            try {
                const auto intent = capture_library_intent();
                const auto id = project_picker_->itemData(index, Qt::UserRole + 1).toString();
                if (discard_allowed())
                    open_project_intent(path, id, intent);
            } catch (const std::exception &e) {
                error(e);
            }
        } else if (active_) {
            root_->setCurrentIndex(1);
            refresh_navigation();
        }
        refresh_recent();
    });
    project_navigation_ = new QWidget;
    auto nav_layout = new QVBoxLayout(project_navigation_);
    nav_layout->setContentsMargins(0, 6, 0, 0);
    nav_layout->setSpacing(6);
    nav_layout->setAlignment(Qt::AlignTop);
    project_navigation_->setSizePolicy(QSizePolicy::Preferred, QSizePolicy::Maximum);
    auto section = plain("PROJECT");
    section->setObjectName("navSection");
    section->setObjectName("projectNavSection");
    section->hide();
    nav_layout->addWidget(section);
    navigation_ = new QListWidget;
    navigation_->setObjectName("projectNavigation");
    navigation_->setFocusPolicy(Qt::StrongFocus);
    navigation_->setAccessibleName("Điều hướng dự án");
    for (const auto &entry :
         {std::pair{"MCP & Agents", ProjectPage::Mcp}, std::pair{"Overview", ProjectPage::Overview}, std::pair{"Software", ProjectPage::Software},
          std::pair{"Releases", ProjectPage::Releases}, std::pair{"Work", ProjectPage::Work},
          std::pair{"Hardware", ProjectPage::Hardware}, std::pair{"Architecture", ProjectPage::Architecture},
          std::pair{"Change review", ProjectPage::Impact}}) {
        auto item = new QListWidgetItem(entry.first, navigation_);
        item->setData(Qt::UserRole, static_cast<int>(entry.second));
    }
    navigation_->setUniformItemSizes(true);
    const std::array project_icons{studio::ToolbarIcon::Agent, studio::ToolbarIcon::Home,     studio::ToolbarIcon::Software,
                                   studio::ToolbarIcon::Release,  studio::ToolbarIcon::Work,
                                   studio::ToolbarIcon::Hardware, studio::ToolbarIcon::Architecture,
                                   studio::ToolbarIcon::Review};
    navigation_->setIconSize(QSize(20, 20));
    for (int i = 0; i < navigation_->count(); ++i) {
        navigation_->item(i)->setIcon(studio::toolbar_icon(project_icons[i], true));
        navigation_->item(i)->setSizeHint(QSize(180, 38));
    }
    navigation_->setFixedHeight(282);
    nav_layout->addWidget(navigation_);
    auto knowledge_section = plain("KNOWLEDGE & AGENT");
    knowledge_section->setObjectName("navSection");
    knowledge_section->setObjectName("knowledgeNavSection");
    knowledge_section->hide();
    nav_layout->addWidget(knowledge_section);
    knowledge_navigation_ = new QListWidget;
    knowledge_navigation_->setObjectName("knowledgeNavigation");
    knowledge_navigation_->setAccessibleName("Knowledge and Agent navigation");
    for (const auto &entry :
         {std::pair{"Knowledge", ProjectPage::Knowledge}, std::pair{"Context & review", ProjectPage::Agent}}) {
        auto item = new QListWidgetItem(entry.first, knowledge_navigation_);
        item->setData(Qt::UserRole, static_cast<int>(entry.second));
        item->setSizeHint(QSize(180, 38));
    }
    knowledge_navigation_->setFixedHeight(84);
    knowledge_navigation_->setIconSize(QSize(20, 20));
    knowledge_navigation_->item(0)->setIcon(studio::toolbar_icon(studio::ToolbarIcon::Knowledge, true));
    knowledge_navigation_->item(1)->setIcon(studio::toolbar_icon(studio::ToolbarIcon::Agent, true));
    nav_layout->addWidget(knowledge_navigation_);
    more_tools_ = new QPushButton(project_caption("More tools"));
    more_tools_->setObjectName("moreProjectTools");
    more_tools_->setProperty("uiCaption", "More tools");
    more_tools_->setCheckable(true);
    nav_layout->addWidget(more_tools_);
    connect(more_tools_, &QPushButton::toggled, this, [this] { refresh_navigation(); });
    body_layout->addWidget(project_navigation_);
    body_layout->setSizeConstraint(QLayout::SetMinAndMaxSize);
    sidebar_scroll->setWidget(sidebar_body);
    project_settings_ = new QPushButton("Project settings");
    project_settings_->setIcon(studio::toolbar_icon(studio::ToolbarIcon::Settings, true));
    project_settings_->setObjectName("editProjectInfo");
    project_settings_->setCheckable(true);
    connect(project_settings_, &QPushButton::clicked, this, [this] { show_page(ProjectPage::Settings); });
    sidebar_layout->addWidget(project_settings_);
    auto local_note = plain("Stored on your computer");
    local_note->setObjectName("muted");
    local_note->hide();
    local_note->setParent(sidebar);
    language_picker_ = new studio::Choice;
    language_picker_->setObjectName("interfaceLanguage");
    language_picker_->addItem("English", "en");
    language_picker_->addItem("Tiếng Việt", "vi");
    language_picker_->setCurrentIndex(project_english ? 0 : 1);
    language_picker_->setAccessibleName("Interface language");
    sidebar_layout->addWidget(language_picker_);
    shell_layout->addWidget(sidebar);
    auto main_column = new QWidget;
    main_column->setObjectName("mainColumn");
    auto main_layout = new QVBoxLayout(main_column);
    main_layout->setContentsMargins(0, 0, 0, 0);
    main_layout->setSpacing(0);
    shell_layout->addWidget(main_column, 1);
    setCentralWidget(shell);
    auto toolbar = new QToolBar("Project", main_column);
    main_layout->addWidget(toolbar);
    main_layout->addWidget(root_, 1);
    toolbar->setObjectName("projectToolbar");
    toolbar->setFixedHeight(56);
    toolbar->setMovable(false);
    toolbar->setFloatable(false);
    toolbar->setIconSize(QSize(18, 18));
    toolbar->setToolButtonStyle(Qt::ToolButtonTextBesideIcon);
    // QToolBar uses one style margin on all sides. A separate inset preserves
    // horizontal alignment without consuming the compact bar's vertical space.
    auto toolbar_inset = new QWidget;
    toolbar_inset->setObjectName("projectToolbarInset");
    toolbar_inset->setFixedWidth(12);
    toolbar->addWidget(toolbar_inset);
    breadcrumb_ = plain("Thư viện dự án");
    breadcrumb_->setWordWrap(false);
    breadcrumb_->setObjectName("projectBreadcrumb");
    toolbar->addWidget(breadcrumb_);
    auto toolbar_gap = new QWidget;
    toolbar_gap->setObjectName("projectToolbarGap");
    toolbar_gap->setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Preferred);
    toolbar->addWidget(toolbar_gap);
    save_state_ = plain({});
    save_state_->setObjectName("saveState");
    save_state_->setWordWrap(false);
    toolbar->addWidget(save_state_);
    toolbar->addSeparator();
    auto action = [&](const QString &text, const QString &id, studio::ToolbarIcon icon,
                      const std::function<void()> &fn) {
        auto a = toolbar->addAction(studio::toolbar_icon(icon, true), text);
        a->setObjectName(id);
        connect(a, &QAction::triggered, this, fn);
        return a;
    };
    auto new_action =
        action("Tạo dự án…", "createProject", studio::ToolbarIcon::New, [this] { create_project_dialog(); });
    toolbar->removeAction(new_action);
    addAction(new_action);
    new_action->setShortcut(QKeySequence::New);
    auto open_action = action("Mở file dự án…", "openProjectFile", studio::ToolbarIcon::Open, [this] {
        const auto intent = capture_library_intent();
        if (!discard_allowed())
            return;
        auto path = QFileDialog::getOpenFileName(this, "Open project or import topology", {},
                                                 "LMTI SQLite (*.sqlite)");
        if (!path.isEmpty()) {
            try {
                open_project_intent(path, {}, intent);
            } catch (const std::exception &e) {
                error(e);
            }
        }
    });
    toolbar->removeAction(open_action);
    addAction(open_action);
    open_action->setShortcut(QKeySequence::Open);
    save_action_ = action("Lưu", "saveProjectFile", studio::ToolbarIcon::Save, [this] { save_file(false); });
    toolbar->widgetForAction(save_action_)->setProperty("primary", true);
    toolbar->removeAction(save_action_);
    addAction(save_action_);
    save_action_->setShortcut(QKeySequence::Save);
    toolbar->addSeparator();
    undo_action_ = action("Hoàn tác", "undoProjectEdit", studio::ToolbarIcon::Undo, [this] {
        if (undo_.empty())
            return;
        redo_.push_back(document_);
        document_ = undo_.back();
        undo_.pop_back();
        refresh();
    });
    undo_action_->setShortcut(QKeySequence::Undo);
    redo_action_ = action("Làm lại", "redoProjectEdit", studio::ToolbarIcon::Redo, [this] {
        if (redo_.empty())
            return;
        undo_.push_back(document_);
        document_ = redo_.back();
        redo_.pop_back();
        refresh();
    });
    redo_action_->setShortcut(QKeySequence::Redo);
    for (auto a : {undo_action_, redo_action_}) {
        auto button = qobject_cast<QToolButton *>(toolbar->widgetForAction(a));
        button->setToolButtonStyle(Qt::ToolButtonIconOnly);
    }
    toolbar->addSeparator();
    toolbar->addAction(save_action_);
    toolbar->widgetForAction(save_action_)->setProperty("primary", true);
    review_action_ = action("Duyệt đề xuất…", "reviewProjectProposal", studio::ToolbarIcon::Review,
                            [this] { review_file(); });
    toolbar->removeAction(review_action_);
    addAction(review_action_);
    close_action_ = new QAction("Close project", this);
    connect(close_action_, &QAction::triggered, this, [this] {
        if (!discard_allowed())
            return;
        active_ = false;
        path_.clear();
        folder_.clear();
        undo_.clear();
        redo_.clear();
        refresh();
    });
    auto file = menuBar()->addMenu("&Dự án");
    file->addActions({new_action, open_action, save_action_});
    file->addAction("Lưu bản sao…", QKeySequence::SaveAs, this, [this] { save_file(true); });
    file->addSeparator();
    file->addAction(close_action_);
    file->addAction("Open synthetic demo", this, [this] {
        if (discard_allowed())
            load_demo();
    });
    auto edit = menuBar()->addMenu("&Edit");
    edit->addActions({undo_action_, redo_action_});
    auto agent = menuBar()->addMenu("&Agent");
    agent->addAction(review_action_);
    auto options = new QToolButton;
    options->setText("⋯");
    options->setObjectName("projectOptions");
    options->setFixedSize(36, 36);
    options->setToolTip("Các thao tác khác");
    options->setAccessibleName("Các thao tác khác");
    auto options_menu = new QMenu(options);
    options_menu->addMenu(file);
    options_menu->addMenu(edit);
    options_menu->addMenu(agent);
    options->setMenu(options_menu);
    options->setPopupMode(QToolButton::InstantPopup);
    toolbar->addWidget(options);
    menuBar()->hide();
    build_pages();
    build_inspector();
    architecture_->commit_topology = [this](const lmti::Topology &next) {
        update_project([&](auto &d) { d.topology = next; }, false);
    };
    connect(navigation_, &QListWidget::currentRowChanged, this, [this](int row) {
        if (active_ && row >= 0) {
            root_->setCurrentIndex(1);
            show_page(navigation_->item(row)->data(Qt::UserRole).toInt());
            refresh_navigation();
        }
    });
    connect(knowledge_navigation_, &QListWidget::currentRowChanged, this, [this](int row) {
        if (active_ && row >= 0)
            show_page(knowledge_navigation_->item(row)->data(Qt::UserRole).toInt());
    });
    connect(tabs_, &QTabWidget::currentChanged, this, [this] {
        inspector_->hide();
        refresh_navigation();
    });
    connect(root_, &QStackedWidget::currentChanged, this, [this] { refresh_navigation(); });
    capture_project_captions(this);
    apply_project_captions(this);
    connect(language_picker_, &QComboBox::activated, this, [this](int index) { set_language(index == 0); });
    setStyleSheet(studio::theme());
    refresh();
    refresh_recent();
}
ProjectWindow::~ProjectWindow() {
    architecture_->commit_topology = {};
}

void ProjectWindow::build_pages() {
    library_view_ = new ProjectLibraryView;
    library_view_->create_project = [this] { findChild<QAction *>("createProject")->trigger(); };
    library_view_->attach_folder = [this] { attach_folder_dialog(); };
    library_view_->import_file = [this] { findChild<QAction *>("openProjectFile")->trigger(); };
    library_view_->open_demo = [this] {
        if (discard_allowed())
            load_demo();
    };
    library_view_->open_project = [this](const auto &entry) { open_library_entry(entry); };
    library_view_->locate_project = [this](const auto &entry) { locate_library_entry(entry); };
    library_view_->toggle_pin = [this](const auto &entry) {
        try {
            lmti::pin_library_project(library_path_, entry.id, !entry.pinned);
            refresh_recent();
        } catch (const std::exception &e) {
            error(e);
        }
    };
    library_view_->change_folder = [this](const auto &entry) {
        try {
            const auto displayed = entry;
            const auto intent = review_library_entry(displayed);
            const auto folder = QFileDialog::getExistingDirectory(
                this, project_caption("Choose project folder…"), displayed.folder);
            if (!folder.isEmpty())
                change_library_folder(displayed, folder, intent);
        } catch (const std::exception &e) {
            error(e);
        }
    };
    library_view_->remove_reference = [this](const auto &entry) {
        try {
            const auto displayed = entry;
            const auto intent = review_library_entry(displayed);
            if (QMessageBox::question(
                    this, project_caption("Remove from library"),
                    project_caption("Remove this reference? The folder, source and project file will be kept."),
                    QMessageBox::Yes | QMessageBox::Cancel, QMessageBox::Cancel) != QMessageBox::Yes)
                return;
            if (intent.reviewed->token.schema >= 2)
                lmti::forget_library_project_cas(library_path_, displayed.id, intent.reviewed->token);
            else {
                require_library_intent(intent);
                lmti::forget_library_project(library_path_, displayed.id);
            }
            library_error_.clear();
            if (active_ && s(document_.project.id) == displayed.id) {
                folder_.clear();
                refresh(false, true);
            } else
                refresh_recent();
            statusBar()->showMessage(project_caption("Project removed from library. Project file retained."));
        } catch (const std::exception &e) {
            error(e);
        }
    };
    root_->addWidget(library_view_);
    auto workspace = new QWidget;
    auto wl = new QVBoxLayout(workspace);
    wl->setContentsMargins(28, 24, 28, 18);
    wl->setSpacing(10);
    auto header = new QHBoxLayout;
    heading_ = plain({});
    heading_->setObjectName("projectHeading");
    header->addWidget(heading_, 1);
    wl->addLayout(header);
    folder_label_ = plain({});
    folder_label_->setObjectName("activeProjectFolder");
    folder_label_->hide();
    folder_label_->setParent(workspace);
    page_description_ = plain({});
    page_description_->setObjectName("muted");
    wl->addWidget(page_description_);
    page_description_->hide();
    tabs_ = new WorkspaceTabs;
    tabs_->setObjectName("projectTabs");
    tabs_->tabBar()->hide();
    auto pages_scroll = new QScrollArea;
    pages_scroll->setObjectName("workspaceScroll");
    pages_scroll->setWidgetResizable(true);
    pages_scroll->setFrameShape(QFrame::NoFrame);
    pages_scroll->setWidget(tabs_);
    workspace_content_ = new QWidget;
    workspace_body_ = new QHBoxLayout(workspace_content_);
    workspace_body_->setContentsMargins(0, 0, 0, 0);
    workspace_body_->setSpacing(16);
    workspace_body_->addWidget(pages_scroll, 1);
    wl->addWidget(workspace_content_, 1);
    root_->addWidget(workspace);
    auto overview = new QWidget;
    auto ol = new QVBoxLayout(overview);
    ol->setContentsMargins(0, 0, 0, 0);
    ol->setSpacing(18);
    summary_ = plain({});
    summary_->setObjectName("projectSummary");
    ol->addWidget(summary_);
    auto priorities = new QHBoxLayout;
    priorities->setSpacing(18);
    QVBoxLayout *attention_layout, *next_layout;
    auto attention_panel = studio::panel("Needs attention", &attention_layout);
    attention_ = new QTreeWidget;
    attention_->setObjectName("projectAttention");
    attention_->setHeaderLabels({"Record", "Reason"});
    studio::inventory(attention_);
    attention_->header()->hide();
    attention_->setMinimumHeight(170);
    attention_->setMaximumHeight(230);
    attention_->setColumnHidden(1, true);
    attention_->header()->setStretchLastSection(false);
    attention_->header()->setSectionResizeMode(0, QHeaderView::Stretch);
    attention_layout->addWidget(attention_);
    attention_count_ = plain({});
    attention_count_->setObjectName("attentionCount");
    attention_count_->setProperty("verbatim", true);
    attention_count_->setStyleSheet("font-size:12px;color:#64748b;background:transparent;");
    attention_layout->addWidget(attention_count_);
    priorities->addWidget(attention_panel, 1);
    auto next_panel = studio::panel("Next steps", &next_layout);
    auto task = new QPushButton(project_caption("Add a task"));
    task->setObjectName("startProjectTask");
    task->setProperty("uiCaption", "Add a task");
    task->setProperty("primary", true);
    connect(task, &QPushButton::clicked, this, [this] {
        show_page(ProjectPage::Work);
        edit_entity("work", {}, lmti::WorkKind::Task);
    });
    next_layout->addWidget(task);
    auto context = new QPushButton(project_caption("Prepare task context"));
    context->setObjectName("openTaskContext");
    context->setProperty("uiCaption", "Prepare task context");
    connect(context, &QPushButton::clicked, this, [this] {
        show_page(ProjectPage::Knowledge);
        findChild<QTabWidget *>("knowledgeTabs")->setCurrentIndex(4);
    });
    next_layout->addWidget(context);
    auto overview_setup = new QPushButton(project_caption("Project setup actions"));
    overview_setup->setObjectName("showProjectSetupActions");
    overview_setup->setProperty("uiCaption", "Project setup actions");
    overview_setup->setCheckable(true);
    next_layout->addWidget(overview_setup);
    auto setup_actions = new QWidget;
    auto overview_setup_layout = new QVBoxLayout(setup_actions);
    overview_setup_layout->setContentsMargins(0, 0, 0, 0);
    next_layout->addWidget(setup_actions);
    setup_actions->hide();
    connect(overview_setup, &QPushButton::toggled, setup_actions, &QWidget::setVisible);
    for (const auto &entry :
         {std::pair{"Add a component", "component"}, std::pair{"Create a release", "release"},
          std::pair{"Plan verification work", "work"}}) {
        auto button = new QPushButton(project_caption(entry.first));
        button->setMinimumHeight(48);
        button->setObjectName(QString("next-") + entry.second);
        button->setProperty("uiCaption", entry.first);
        connect(button, &QPushButton::clicked, this, [this, kind = QString(entry.second)] {
            show_page(kind == "component" ? ProjectPage::Software
                      : kind == "release" ? ProjectPage::Releases
                                          : ProjectPage::Work);
            edit_entity(kind, {}, kind == "work" ? lmti::WorkKind::Validation : lmti::WorkKind::Task);
        });
        overview_setup_layout->addWidget(button);
    }
    priorities->addWidget(next_panel, 1);
    ol->addLayout(priorities);
    QVBoxLayout *open_layout;
    auto open_panel = studio::panel("Open work", &open_layout);
    overview_blockers_ = new QTreeWidget;
    overview_blockers_->setObjectName("overviewWork");
    overview_blockers_->setHeaderLabels({"Work", "State", "Component", "Release"});
    studio::inventory(overview_blockers_);
    overview_blockers_->header()->setSectionResizeMode(QHeaderView::Stretch);
    open_layout->addWidget(overview_blockers_, 1);
    ol->addWidget(open_panel, 1);
    overview_bindings_ = new QTreeWidget(overview);
    overview_bindings_->hide();
    auto metrics = new QHBoxLayout;
    const QStringList metric_names{"components", "devices", "candidate releases", "work complete"};
    for (int i = 0; i < 4; ++i) {
        auto card = studio::panel({});
        auto l = qobject_cast<QVBoxLayout *>(card->layout());
        metrics_[i] = plain({});
        metrics_[i]->setObjectName("metricValue");
        l->addWidget(metrics_[i]);
        l->addWidget(studio::caption(metric_names[i], "muted"));
        metrics->addWidget(card, 1);
    }
    auto project_details = new QWidget;
    project_details->setObjectName("projectSummaryDetails");
    auto details_layout = new QVBoxLayout(project_details);
    details_layout->setContentsMargins(0, 0, 0, 0);
    details_layout->addLayout(metrics);
    auto details_button = new QPushButton(project_caption("Project details"));
    details_button->setObjectName("showProjectSummaryDetails");
    details_button->setProperty("uiCaption", "Project details");
    details_button->setCheckable(true);
    ol->addWidget(details_button, 0, Qt::AlignLeft);
    ol->addWidget(project_details);
    project_details->hide();
    connect(details_button, &QPushButton::toggled, project_details, &QWidget::setVisible);
    progress_ = plain({});
    progress_->setObjectName("projectProgress");
    progress_->hide();
    progress_->setParent(overview);
    connect(attention_, &QTreeWidget::itemActivated, this, [this](auto item, int) {
        open_entity(item->data(0, Qt::UserRole + 1).toString(), item->data(0, Qt::UserRole).toString());
    });
    connect(overview_blockers_, &QTreeWidget::itemActivated, this,
            [this](auto item, int) { open_entity("work", item->data(0, Qt::UserRole).toString()); });
    tabs_->addTab(overview, "Overview");
    auto table_page = [&](const QString &kind, const QString &name, const QStringList &columns,
                          QTreeWidget *&tree) {
        auto page = new QFrame;
        page->setProperty("inventorySurface", true);
        auto l = new QVBoxLayout(page);
        l->setContentsMargins(14, 14, 14, 10);
        l->setSpacing(10);
        auto tools = new QHBoxLayout;
        tools->setSpacing(8);
        auto add = new QPushButton(project_caption("Add " + name));
        add->setObjectName("add" + kind);
        add->setProperty("primary", true);
        add->setSizePolicy(QSizePolicy::Fixed, QSizePolicy::Fixed);
        auto edit = new QPushButton("Chỉnh sửa", page);
        auto remove = new QPushButton("Gỡ mục", page);
        edit->setObjectName("edit" + kind);
        remove->setObjectName("remove" + kind);
        tools->addWidget(add);
        edit->hide();
        remove->hide();
        l->addLayout(tools);
        tree = new QTreeWidget;
        tree->setObjectName(kind + "Table");
        auto headings = columns;
        for (auto &heading : headings)
            heading = project_caption(heading);
        tree->setHeaderLabels(headings);
        tree->setRootIsDecorated(false);
        tree->setAlternatingRowColors(false);
        tree->header()->setSectionResizeMode(QHeaderView::ResizeToContents);
        tree->header()->setStretchLastSection(true);
        auto search = new QLineEdit;
        search->setObjectName(kind + "Filter");
        search->setPlaceholderText(kind == "component"    ? "Search software…"
                                   : kind == "release"    ? "Search versions…"
                                   : kind == "repository" ? "Search repositories…"
                                                          : "Search records…");
        search->setClearButtonEnabled(true);
        tools->addWidget(search, 1);
        search->setMaximumWidth(330);
        auto count = plain({});
        count->setObjectName("muted");
        l->addWidget(count);
        l->addWidget(tree);
        configure_table(kind, tree, search, count, edit, remove);
        if (kind == "component" || kind == "release" || kind == "verification") {
            auto filter_panel = new QWidget;
            filter_panel->setObjectName(kind + "FilterOptions");
            auto filters = new QHBoxLayout(filter_panel);
            filters->setContentsMargins(0, 0, 0, 0);
            if (kind == "component")
                add_table_filter(tree, filters, "kind", "All kinds");
            else if (kind == "release") {
                add_table_filter(tree, filters, "component", "All components");
                add_table_filter(tree, filters, "state", "All states");
            } else {
                add_table_filter(tree, filters, "release", "All releases");
                add_table_filter(tree, filters, "result", "All results");
            }
            l->insertWidget(1, filter_panel);
            filter_panel->hide();
            auto filter_toggle = new QPushButton(project_caption("Filters"));
            filter_toggle->setObjectName(kind + "ShowFilters");
            filter_toggle->setProperty("uiCaption", "Filters");
            filter_toggle->setCheckable(true);
            tools->removeWidget(search);
            tools->addStretch(1);
            search->setMaximumWidth(QWIDGETSIZE_MAX);
            auto search_row = new QHBoxLayout;
            search_row->addWidget(search, 1);
            search_row->addWidget(filter_toggle);
            l->insertLayout(1, search_row);
            connect(filter_toggle, &QPushButton::toggled, filter_panel, &QWidget::setVisible);
        }
        if (kind == "component" || kind == "release") {
            tree->header()->setStretchLastSection(false);
            tree->header()->setSectionResizeMode(QHeaderView::Interactive);
            tree->header()->setSectionResizeMode(0, QHeaderView::Stretch);
            if (kind == "component") {
                tree->setColumnWidth(1, 95);
                tree->setColumnWidth(2, 150);
                tree->setColumnWidth(4, 105);
                tree->setColumnHidden(3, true);
            } else {
                tree->setColumnWidth(1, 145);
                tree->setColumnWidth(2, 120);
                tree->setColumnWidth(4, 125);
                tree->setColumnHidden(3, true);
            }
            tools->addWidget(column_picker(tree, page));
        }
        auto more = new QToolButton(page);
        more->setText(QString::fromUtf8("⋯"));
        more->setProperty("more", true);
        more->setObjectName(kind + "Actions");
        more->setAccessibleName(project_caption("Selected record actions"));
        more->setProperty("uiAccessibleName", "Selected record actions");
        more->setPopupMode(QToolButton::InstantPopup);
        auto menu = new QMenu(more);
        menu->setObjectName(kind + "ActionsMenu");
        auto edit_action = menu->addAction("Edit record", edit, &QPushButton::click);
        auto remove_action = menu->addAction("Remove selected", remove, &QPushButton::click);
        connect(menu, &QMenu::aboutToShow, this, [edit, remove, edit_action, remove_action] {
            edit_action->setEnabled(edit->isEnabled());
            remove_action->setEnabled(remove->isEnabled());
        });
        more->setMenu(menu);
        tools->addWidget(more);
        l->addWidget(studio::caption("Select a record for details.", "muted"));
        connect(add, &QPushButton::clicked, this, [this, kind] { edit_entity(kind); });
        connect(edit, &QPushButton::clicked, this, [this, kind, tree] {
            auto id = selected_id(tree);
            if (!id.isEmpty())
                edit_entity(kind, id.toStdString());
        });
        connect(remove, &QPushButton::clicked, this, [this, kind, tree] {
            auto id = selected_id(tree);
            if (!id.isEmpty())
                remove_entity(kind, id.toStdString());
        });
        connect(tree, &QTreeWidget::itemDoubleClicked, this, [this, kind](QTreeWidgetItem *item, int) {
            open_entity(kind, item->data(0, Qt::UserRole).toString(), false);
        });
        return page;
    };
    auto software = new WorkspaceTabs;
    software->setObjectName("softwareTabs");
    software->addTab(table_page("component", "component",
                                {"Component", "Kind", "Repository", "Devices", "Visibility"}, components_),
                     "Components");
    software->addTab(table_page("repository", "repository",
                                {"Repository", "Locator", "Visibility", "Linked components"}, repositories_),
                     "Repositories");
    repositories_->header()->setStretchLastSection(false);
    repositories_->header()->setSectionResizeMode(1, QHeaderView::Stretch);
    software->addTab(table_page("dependency", "dependency",
                                {"Source component", "Target component", "Interface / contract"},
                                dependencies_),
                     "Dependencies");
    auto knowledge_page = table_page("knowledge", "knowledge reference",
                                     {"Reference", "Component", "Fingerprint", "Status"}, knowledge_);
    knowledge_panel_ = new KnowledgePanel;
    knowledge_panel_->add_references(knowledge_page);
    drive_panel_ = new DriveKnowledgePanel;
    knowledge_panel_->add_drive(drive_panel_);
    tabs_->addTab(software, "Software");
    auto hardware = new WorkspaceTabs;
    hardware->setObjectName("hardwareTabs");
    auto device_page = new QWidget;
    auto device_layout = new QVBoxLayout(device_page);
    auto device_tools = new QHBoxLayout;
    auto new_device = new QPushButton("Add device");
    new_device->setObjectName("addHardwareDevice");
    auto edit_device = new QPushButton("Edit device");
    edit_device->setObjectName("editdevice");
    device_tools->addWidget(edit_device);
    device_tools->addStretch();
    new_device->setProperty("primary", true);
    device_tools->addWidget(new_device);
    device_layout->addLayout(device_tools);
    hardware_devices_ = new QTreeWidget;
    hardware_devices_->setObjectName("hardwareDevices");
    hardware_devices_->setHeaderLabels({"Device", "Kind", "Site", "Desired software", "Observed version"});
    hardware_devices_->setRootIsDecorated(false);
    hardware_devices_->header()->setSectionResizeMode(QHeaderView::ResizeToContents);
    hardware_devices_->header()->setStretchLastSection(true);
    device_layout->addWidget(hardware_devices_, 1);
    hardware_details_ = plain("Select a device to see its software, release and linked work.");
    device_layout->addWidget(hardware_details_);
    auto device_filter = new QLineEdit;
    device_filter->setObjectName("deviceFilter");
    device_filter->setPlaceholderText("Search records…");
    device_filter->setClearButtonEnabled(true);
    auto device_filters = new QHBoxLayout;
    device_filters->addWidget(device_filter, 1);
    device_layout->insertLayout(1, device_filters);
    auto device_count = plain({});
    device_count->setObjectName("muted");
    device_layout->insertWidget(2, device_count);
    configure_table("device", hardware_devices_, device_filter, device_count, edit_device);
    add_table_filter(hardware_devices_, device_filters, "kind", "All kinds");
    add_table_filter(hardware_devices_, device_filters, "site", "All sites");
    connect(new_device, &QPushButton::clicked, this, [this] { edit_entity("device"); });
    connect(edit_device, &QPushButton::clicked, this, [this] {
        auto id = selected_id(hardware_devices_);
        if (!id.isEmpty())
            edit_entity("device", id.toStdString());
    });
    connect(hardware_devices_, &QTreeWidget::itemActivated, this,
            [this](auto item, int) { open_entity("device", item->data(0, Qt::UserRole).toString(), false); });
    hardware->addTab(device_page, "Devices");
    hardware->addTab(
        table_page("target", "hardware target", {"Target", "Hardware revision", "Architecture"}, targets_),
        "Targets");
    hardware->addTab(table_page("binding", "software binding",
                                {"Device", "Component", "Desired version", "Target", "Observed"}, bindings_),
                     "Software bindings");
    tabs_->addTab(hardware, "Hardware");
    architecture_ = new Window(this, &document_.topology);
    architecture_->setWindowFlags(Qt::Widget);
    auto architecture_pages = architecture_tabs_ = new WorkspaceTabs;
    architecture_pages->setObjectName("architectureTabs");
    architecture_pages->addTab(architecture_, "Device topology");
    auto relationships = new QWidget;
    auto rl = new QVBoxLayout(relationships);
    rl->setContentsMargins(0, 12, 0, 0);
    QVBoxLayout *graph_body;
    auto graph_panel = studio::panel({}, &graph_body);
    rl->addWidget(graph_panel, 1);
    relationship_scene_ = new QGraphicsScene(this);
    relationship_view_ = new QGraphicsView(relationship_scene_);
    relationship_view_->setObjectName("softwareHardwareGraph");
    relationship_view_->viewport()->installEventFilter(this);
    relationship_view_->setAccessibleName("Software and device relationships");
    relationship_view_->setRenderHint(QPainter::Antialiasing);
    relationship_view_->setBackgroundBrush(QColor("#f7f9fc"));
    relationship_view_->setDragMode(QGraphicsView::ScrollHandDrag);
    auto graph_tools = new QHBoxLayout;
    graph_tools->addWidget(studio::caption("Software relationships", "sectionTitle"), 1);
    for (const auto &entry : {std::pair{"Zoom out", 1.0 / 1.2}, std::pair{"Zoom in", 1.2}}) {
        auto button = new QPushButton(project_caption(entry.first));
        button->setProperty("uiCaption", entry.first);
        button->setObjectName(entry.second < 1 ? "zoomOutRelationships" : "zoomInRelationships");
        connect(button, &QPushButton::clicked, this, [this, factor = entry.second] {
            const auto next = relationship_view_->transform().m11() * factor;
            if (next >= 0.05 && next <= 4)
                relationship_view_->scale(factor, factor);
        });
        graph_tools->addWidget(button);
    }
    auto fit = new QPushButton(project_caption("Fit"));
    fit->setProperty("uiCaption", "Fit");
    fit->setObjectName("fitRelationships");
    connect(fit, &QPushButton::clicked, this, [this] {
        relationship_view_->fitInView(relationship_scene_->itemsBoundingRect().adjusted(-30, -30, 30, 30),
                                      Qt::KeepAspectRatio);
    });
    graph_tools->addWidget(fit);
    graph_body->addLayout(graph_tools);
    graph_body->addWidget(
        studio::caption("Declared relationships; observed versions remain unknown.", "muted"));
    graph_body->addWidget(relationship_view_, 1);
    auto legend = new QHBoxLayout;
    legend->setSpacing(6);
    for (const auto &[marker, caption, color] :
         {std::tuple{"■", "Software component", "#3563e9"}, std::tuple{"■", "Device", "#168b8b"},
          std::tuple{"→", "Desired binding", "#3563e9"}, std::tuple{"⇢", "Declared dependency", "#64748b"}}) {
        auto symbol = new QLabel(marker);
        symbol->setStyleSheet(QString("color:%1;background:transparent;font-size:18px;").arg(color));
        legend->addWidget(symbol);
        auto label = studio::caption(caption, "muted");
        label->setStyleSheet("font-size:12px;");
        legend->addWidget(label);
    }
    legend->addStretch();
    graph_count_ = plain({});
    graph_body->addLayout(legend);
    graph_count_->setAlignment(Qt::AlignRight);
    graph_count_->setStyleSheet("font-size:12px;");
    graph_body->addWidget(graph_count_);
    graph_count_->setToolTip(
        project_caption("Up to 50 software nodes and 50 devices. Use the inventories for all records."));
    connect(relationship_scene_, &QGraphicsScene::selectionChanged, this, [this] {
        const auto selected = relationship_scene_->selectedItems();
        if (selected.size() == 1 && !selected.front()->data(0).toString().isEmpty())
            open_entity(selected.front()->data(1).toString(), selected.front()->data(0).toString(), false);
    });
    architecture_pages->addTab(relationships, "Software relationships");
    tabs_->addTab(architecture_pages, "Architecture");
    auto work = new WorkspaceTabs;
    work->setObjectName("workTabs");
    auto board = new QFrame;
    board->setProperty("inventorySurface", true);
    auto bl = new QVBoxLayout(board);
    bl->setContentsMargins(14, 14, 14, 10);
    bl->setSpacing(10);
    auto wt = new QHBoxLayout;
    work_filter_ = new QLineEdit;
    work_filter_->setPlaceholderText("Filter by task, component, device or milestone");
    work_filter_->setObjectName("workFilter");
    wt->addWidget(work_filter_, 1);
    auto add_work = new QPushButton("Add work item");
    add_work->setObjectName("addwork");
    add_work->setProperty("primary", true);
    connect(add_work, &QPushButton::clicked, this, [this] { edit_entity("work"); });
    bl->addLayout(wt);
    work_mode_ = new studio::Choice;
    work_mode_->setObjectName("workViewMode");
    work_mode_->addItems({"List", "Board"});
    work_mode_->setProperty("uiChoices", QStringList{"List", "Board"});
    work_mode_->setParent(board);
    wt->insertWidget(0, studio::segments(work_mode_, "workViewSegments", {0, 1}));
    edit_work_ = new QPushButton("Edit record");
    edit_work_->setObjectName("editwork");
    remove_work_ = new QPushButton("Remove selected");
    remove_work_->setObjectName("removework");
    wt->addWidget(edit_work_);
    wt->addWidget(remove_work_);
    wt->addWidget(add_work);
    // Selected-record actions belong in More; the primary create action and
    // view switch must still fit when the details panel is open.
    wt->removeWidget(edit_work_);
    wt->removeWidget(remove_work_);
    edit_work_->hide();
    remove_work_->hide();
    wt->insertStretch(1, 1);
    auto work_more = new QToolButton;
    work_more->setText(QString::fromUtf8("⋯"));
    work_more->setProperty("more", true);
    work_more->setObjectName("workActions");
    work_more->setAccessibleName(project_caption("Selected work actions"));
    work_more->setProperty("uiAccessibleName", "Selected work actions");
    work_more->setPopupMode(QToolButton::InstantPopup);
    auto work_menu = new QMenu(work_more);
    work_menu->setObjectName("workActionsMenu");
    auto edit_action = work_menu->addAction("Edit record", edit_work_, &QPushButton::click);
    auto remove_action = work_menu->addAction("Remove selected", remove_work_, &QPushButton::click);
    connect(work_menu, &QMenu::aboutToShow, this, [this, edit_action, remove_action] {
        edit_action->setEnabled(edit_work_->isEnabled());
        remove_action->setEnabled(remove_work_->isEnabled());
    });
    work_more->setMenu(work_menu);
    wt->addWidget(work_more);
    auto chosen_work = [this] {
        if (work_views_->currentIndex() == 0)
            return selected_id(work_list_);
        for (auto column : work_columns_) {
            auto id = selected_id(column);
            if (!id.isEmpty())
                return id;
        }
        return QString{};
    };
    connect(edit_work_, &QPushButton::clicked, this, [this, chosen_work] {
        auto id = chosen_work();
        if (!id.isEmpty())
            edit_entity("work", id.toStdString());
    });
    connect(remove_work_, &QPushButton::clicked, this, [this, chosen_work] {
        auto id = chosen_work();
        if (!id.isEmpty())
            remove_entity("work", id.toStdString());
    });
    work_views_ = new QStackedWidget;
    work_views_->setObjectName("workViews");
    work_list_ = new QTreeWidget;
    work_list_->setObjectName("workTable");
    work_list_->setRootIsDecorated(false);
    work_list_->setHeaderLabels(
        {"Work item", "State", "Kind", "Component", "Device", "Release", "Milestone", "Evidence"});
    work_list_->header()->setSectionResizeMode(QHeaderView::Interactive);
    work_list_->header()->setStretchLastSection(false);
    work_list_->header()->setSectionResizeMode(0, QHeaderView::Stretch);
    for (const auto column : {2, 4, 5, 6})
        work_list_->setColumnHidden(column, true);
    work_list_->setColumnWidth(1, 95);
    work_list_->setColumnWidth(3, 125);
    work_list_->setColumnWidth(7, 125);
    auto work_columns = column_picker(work_list_, board);
    wt->insertWidget(wt->count() - 1, work_columns);
    connect(work_mode_, &QComboBox::currentIndexChanged, work_columns,
            [work_columns](int index) { work_columns->setVisible(index == 0); });
    auto work_count = plain({});
    work_count->setObjectName("muted");
    bl->addWidget(work_count);
    configure_table("work", work_list_, work_filter_, work_count, edit_work_, remove_work_);
    wt->removeWidget(work_filter_);
    auto work_filters = new QHBoxLayout;
    work_filters->addWidget(work_filter_, 1);
    bl->insertLayout(1, work_filters);
    add_table_filter(work_list_, work_filters, "state", "All states");
    add_table_filter(work_list_, work_filters, "kind", "All kinds");
    work_views_->addWidget(work_list_);
    connect(work_list_, &QTreeWidget::itemActivated, this,
            [this](auto item, int) { open_entity("work", item->data(0, Qt::UserRole).toString(), false); });
    auto split = new QSplitter;
    for (const auto &state : {"todo", "in-progress", "blocked", "review", "done"}) {
        auto column = new QTreeWidget;
        column->setHeaderLabels({project_caption(state)});
        column->setObjectName(QString("work-") + state);
        column->setRootIsDecorated(false);
        column->setWordWrap(true);
        column->setMinimumWidth(145);
        column->setProperty("workState", state);
        column->setItemDelegate(new studio::WorkCardDelegate(column));
        column->setUniformRowHeights(true);
        column->header()->setSectionResizeMode(QHeaderView::Stretch);
        work_columns_.push_back(column);
        split->addWidget(column);
        connect(column, &QTreeWidget::itemSelectionChanged, this, [this, column] {
            if (refreshing_ || column->selectedItems().empty())
                return;
            edit_work_->setEnabled(true);
            remove_work_->setEnabled(true);
            open_entity("work", selected_id(column), false);
            for (auto other : work_columns_)
                if (other != column) {
                    QSignalBlocker blocker(other);
                    other->clearSelection();
                }
        });
        connect(column, &QTreeWidget::itemDoubleClicked, this, [this](QTreeWidgetItem *item, int) {
            open_entity("work", item->data(0, Qt::UserRole).toString(), false);
        });
        connect(column, &QTreeWidget::itemClicked, this, [this](QTreeWidgetItem *item, int) {
            if (refreshing_ || !item || !item->isSelected())
                return;
            const auto id = item->data(0, Qt::UserRole).toString();
            if (!inspector_->isVisible() || inspected_kind_ != "work" || inspected_id_ != id)
                open_entity("work", id, false);
        });
    }
    auto board_scroll = new QScrollArea;
    board_scroll->setObjectName("workBoardScroll");
    board_scroll->setWidgetResizable(true);
    board_scroll->setFrameShape(QFrame::NoFrame);
    board_scroll->setWidget(split);
    work_views_->addWidget(board_scroll);
    bl->addWidget(work_views_);
    connect(work_mode_, &QComboBox::currentIndexChanged, this, [this](int index) {
        QString selected = selected_id(work_list_);
        if (work_views_->currentIndex() == 1)
            for (auto column : work_columns_)
                if (!selected_id(column).isEmpty())
                    selected = selected_id(column);
        work_views_->setCurrentIndex(index);
        auto choose = [&selected](QTreeWidget *tree) {
            QSignalBlocker blocker(tree);
            tree->clearSelection();
            for (int i = 0; i < tree->topLevelItemCount(); ++i) {
                auto item = tree->topLevelItem(i);
                if (!item->isHidden() && item->data(0, Qt::UserRole).toString() == selected)
                    tree->setCurrentItem(item);
            }
        };
        choose(work_list_);
        for (auto column : work_columns_)
            choose(column);
        edit_work_->setEnabled(!selected.isEmpty());
        remove_work_->setEnabled(!selected.isEmpty());
    });
    bl->addWidget(
        studio::caption("Select a work item to review its links, checklist and evidence.", "muted"));
    connect(work_filter_, &QLineEdit::textChanged, this, [this] { filter_work_views(); });
    work->addTab(board, "Work items");
    work->addTab(table_page("milestone", "milestone",
                            {"Milestone", "Due date", "Linked work", "Acceptance", "Evidence"}, milestones_),
                 "Milestones");
    tabs_->addTab(work, "Work");
    auto release = new WorkspaceTabs;
    release->setObjectName("releaseTabs");
    release->addTab(table_page("release", "release",
                               {"Version", "Component", "Target", "Source revision", "Review state"},
                               releases_),
                    "Releases");
    release->addTab(table_page("verification", "verification record",
                               {"Release", "Device", "Result", "Evidence", "Source", "Recorded"},
                               verification_),
                    "Evidence");
    verification_->header()->setStretchLastSection(false);
    for (const auto &[column, width] :
         {std::pair{0, 100}, std::pair{1, 155}, std::pair{2, 155}, std::pair{4, 115}, std::pair{5, 110}}) {
        verification_->header()->setSectionResizeMode(column, QHeaderView::Interactive);
        verification_->setColumnWidth(column, width);
    }
    verification_->header()->setSectionResizeMode(3, QHeaderView::Stretch);
    tabs_->addTab(release, "Releases");
    auto agent = agent_tabs_ = new WorkspaceTabs;
    agent->setObjectName("agentTabs");
    auto context_page = new QWidget;
    auto al = new QVBoxLayout(context_page);
    al->setContentsMargins(0, 12, 0, 0);
    al->setSpacing(16);
    auto status = new QFrame;
    status->setProperty("notice", true);
    auto status_layout = new QHBoxLayout(status);
    agent_note_ = plain({});
    agent_note_->setObjectName("projectAgentNote");
    status_layout->addWidget(agent_note_, 1);
    agent_site_ = new studio::Choice;
    agent_site_->setObjectName("projectAgentSite");
    agent_site_->setAccessibleName("Site scope");
    agent_site_->setMaximumWidth(250);
    status_layout->addWidget(agent_site_);
    al->addWidget(status);
    QVBoxLayout *scope_body;
    auto scope = studio::panel("Project scope", &scope_body);
    agent_summary_ = new QTreeWidget;
    agent_summary_->setObjectName("agentSummary");
    agent_summary_->setRootIsDecorated(false);
    agent_summary_->setHeaderHidden(true);
    agent_summary_->setColumnCount(2);
    studio::inventory(agent_summary_);
    agent_summary_->header()->setSectionResizeMode(0, QHeaderView::ResizeToContents);
    agent_summary_->header()->setSectionResizeMode(1, QHeaderView::Stretch);
    agent_summary_->setMinimumHeight(150);
    agent_summary_->setMaximumHeight(180);
    // Keep the structured facts model for inspection without spending one row
    // per field in the compact scope card.
    agent_summary_->setParent(scope);
    agent_summary_->hide();
    auto scope_fields = new QHBoxLayout;
    const QStringList scope_labels{"Project", "Site scope", "Visibility", "Observed version"};
    for (int i = 0; i < 4; ++i) {
        auto field = new QVBoxLayout;
        field->addWidget(studio::caption(scope_labels[i], "muted"));
        agent_scope_values_[i] = plain({});
        agent_scope_values_[i]->setObjectName("agentScopeValue" + QString::number(i));
        agent_scope_values_[i]->setMaximumHeight(42);
        field->addWidget(agent_scope_values_[i]);
        scope_fields->addLayout(field, 1);
    }
    scope_body->addLayout(scope_fields);
    auto counts = new QHBoxLayout;
    const QStringList count_labels{"Allowed components", "Allowed devices", "Allowed releases",
                                   "Allowed work items"};
    for (int i = 0; i < 4; ++i) {
        auto column = new QVBoxLayout;
        agent_counts_[i] = plain("0");
        agent_counts_[i]->setObjectName("metricValue");
        agent_counts_[i]->setMinimumHeight(34);
        column->addWidget(agent_counts_[i]);
        column->addWidget(studio::caption(count_labels[i], "muted"));
        counts->addLayout(column, 1);
    }
    scope_body->addLayout(counts);
    al->addWidget(scope);
    QVBoxLayout *records_body;
    auto records = studio::panel({}, &records_body);
    auto record_tools = new QHBoxLayout;
    record_tools->addWidget(studio::caption("Allowed records", "sectionTitle"), 1);
    agent_filter_ = new QLineEdit;
    agent_filter_->setObjectName("agentRecordSearch");
    agent_filter_->setPlaceholderText("Search records…");
    agent_filter_->setMaximumWidth(280);
    record_tools->addWidget(agent_filter_);
    records_body->addLayout(record_tools);
    agent_records_ = new QTreeWidget;
    agent_records_->setObjectName("agentAllowedRecords");
    auto agent_empty = new studio::EmptyTreeState(agent_records_);
    agent_empty->setProperty("verbatim", true);
    agent_records_->setHeaderLabels({"Type", "Name", "Details"});
    studio::inventory(agent_records_);
    agent_records_->header()->setSectionResizeMode(0, QHeaderView::ResizeToContents);
    agent_records_->header()->setSectionResizeMode(1, QHeaderView::Stretch);
    agent_records_->header()->setSectionResizeMode(2, QHeaderView::Stretch);
    records_body->addWidget(agent_records_, 1);
    al->addWidget(records, 1);
    connect(agent_filter_, &QLineEdit::textChanged, this, [this] { filter_agent_records(); });
    auto technical = new QCheckBox("Technical details (JSON)");
    technical->setObjectName("agentTechnicalDetails");
    al->addWidget(technical);
    agent_context_ = new QPlainTextEdit;
    agent_context_->setReadOnly(true);
    agent_context_->setObjectName("projectAgentContext");
    agent_context_->setMaximumHeight(180);
    agent_context_->hide();
    connect(technical, &QCheckBox::toggled, agent_context_, &QWidget::setVisible);
    al->addWidget(agent_context_);
    connect(agent_site_, &QComboBox::currentTextChanged, this, [this] { refresh_agent(); });
    al->addWidget(studio::caption(
        "External/public preview of the current document. SDK/MCP reads the saved file. Project/site "
        "grants come from the trusted launcher. Knowledge references are not raw memory exports.",
        "muted"));
    agent->addTab(context_page, "Context");
    agent_review_ = new AgentReviewView;
    agent_review_->import_file = [this] { review_file(); };
    agent_review_->apply_proposal = [this](const lmti::WorkProposal &proposal) {
        apply_checked_proposal(proposal);
    };
    agent->addTab(agent_review_, "Review");
    auto setup = new QWidget;
    auto setup_layout = new QVBoxLayout(setup);
    setup_layout->setContentsMargins(0, 12, 0, 0);
    setup_layout->setSpacing(12);
    auto setup_tools = new QHBoxLayout;
    setup_tools->addWidget(
        studio::caption("Configure the local Agent boundary and inspect its supported capabilities.",
                        "muted"),
        1);
    auto instructions = new QPushButton(project_caption("View setup instructions"));
    instructions->setProperty("uiCaption", "View setup instructions");
    instructions->setProperty("primary", true);
    instructions->setObjectName("agentSetupInstructions");
    setup_tools->addWidget(instructions);
    setup_layout->addLayout(setup_tools);
    connect(instructions, &QPushButton::clicked, this, [this] {
        QDialog dialog(this);
        dialog.setObjectName("agentSetupInstructionsDialog");
        dialog.setWindowTitle(project_caption("SDK / MCP setup"));
        dialog.resize(680, 470);
        auto layout = new QVBoxLayout(&dialog);
        layout->addWidget(studio::caption(
            "Save the project, then configure the trusted client launcher with the native CLI, "
            "saved database, project identifier, site and model target. Grants belong to the launcher.",
            "muted"));
        auto steps = new QPlainTextEdit;
        steps->setReadOnly(true);
        steps->setObjectName("agentSetupSteps");
        steps->setPlainText(project_caption(
            "1. Make the packaged lmti-project CLI available to the client launcher.\n"
            "2. Make python/src available in the Python environment.\n"
            "3. Configure lmti_project.Client with the CLI, saved database and Grant(project_id, site).\n"
            "4. For MCP, launch python -m lmti_project.mcp with --binary, --database, --project, --site and "
            "--target.\n\n"
            "Supported tools: project_context, project_impact, project_propose_work.\n"
            "External clients receive public metadata within their project/site grant. "
            "Review imported work-state proposals in this app, then Save the reviewed draft."));
        layout->addWidget(steps, 1);
        auto buttons = new QDialogButtonBox(QDialogButtonBox::Close);
        connect(buttons, &QDialogButtonBox::rejected, &dialog, &QDialog::reject);
        layout->addWidget(buttons);
        dialog.exec();
    });
    auto setup_table = [](QVBoxLayout *body, const QStringList &headers, const std::vector<QStringList> &rows,
                          const QString &name) {
        auto table = new QTreeWidget;
        table->setObjectName(name);
        table->setProperty("translatedRows", true);
        table->setHeaderLabels(headers);
        studio::inventory(table);
        table->setSelectionMode(QAbstractItemView::NoSelection);
        table->setWordWrap(false);
        table->setStyleSheet("QTreeWidget::item{padding:5px 10px;}"
                             "QHeaderView::section{padding:7px 10px;}");
        table->header()->setSectionResizeMode(0, QHeaderView::ResizeToContents);
        table->header()->setSectionResizeMode(1, QHeaderView::Stretch);
        for (const auto &row : rows) {
            QStringList captions;
            for (const auto &value : row)
                captions << project_caption(value);
            auto item = new QTreeWidgetItem(table, captions);
            for (int column = 0; column < static_cast<int>(row.size()); ++column) {
                item->setData(column, Qt::UserRole + 110, row[column]);
                item->setToolTip(column, project_caption(row[column]).toHtmlEscaped());
            }
        }
        table->setFixedHeight(126);
        body->addWidget(table);
        // Measure after the shared window theme is inherited. Fixed arbitrary
        // heights can clip the third row on Windows at a different font/DPI.
        QTimer::singleShot(0, table, [table] {
            table->ensurePolished();
            int height = table->header()->sizeHint().height() + 2 * table->frameWidth();
            for (int index = 0; index < table->topLevelItemCount(); ++index)
                height += table->sizeHintForRow(index);
            table->setFixedHeight(height);
        });
    };
    QVBoxLayout *boundary_body;
    auto boundary = studio::panel("Local SDK / MCP boundary", &boundary_body, true);
    boundary_body->addWidget(studio::caption("The Python SDK and MCP stdio invoke the trusted native CLI "
                                             "with launcher-defined project and site scope.",
                                             "muted"));
    setup_table(boundary_body, {"Component", "Role"},
                {{"C++ native CLI", "Validated project metadata boundary"},
                 {"Python SDK", "Scoped native CLI adapter"},
                 {"MCP stdio", "Python transport for scoped tools"}},
                "agentBoundaryTable");
    setup_layout->addWidget(boundary);
    QVBoxLayout *capability_body;
    auto capabilities = studio::panel("Capabilities", &capability_body, true);
    setup_table(
        capability_body, {"Capability", "Description"},
        {{"Read saved public metadata", "Read the saved project within the configured scope."},
         {"Inspect allowed records", "Inspect allowed component relationships and impact."},
         {"Propose work-state changes", "Propose Review or Blocked against a matching saved revision."}},
        "agentCapabilitiesTable");
    setup_layout->addWidget(capabilities);
    QVBoxLayout *connection_body;
    auto connection = studio::panel("Connection status", &connection_body, true);
    auto connection_status = studio::caption("Client connection not verified", "agentConnectionStatus");
    connection_status->setStyleSheet("color:#875400;font-weight:600;");
    connection_body->addWidget(connection_status);
    connection_body->addWidget(studio::caption(
        "Launch the client locally using its trusted configuration. This page documents the boundary; "
        "it does not probe or certify a running client.",
        "muted"));
    setup_layout->addWidget(connection);
    setup_layout->addStretch();
    agent->addTab(setup, "Setup");
    tabs_->addTab(agent, "Agent");
    tabs_->addTab(knowledge_panel_, "Knowledge");
    settings_ = new ProjectSettingsView;
    settings_->submit = [this](const lmti::ProjectInfo &info) {
        update_project([&](auto &next) { next.project = info; }, false);
    };
    settings_->changed = [this] {
        save_action_->setEnabled(active_ && (path_.isEmpty() || document_ != saved_ || settings_->pending()));
        const bool clean = active_ && !path_.isEmpty() && document_ == saved_ && !settings_->pending();
        review_action_->setEnabled(clean);
        agent_review_->bind(document_, clean);
        if (drive_panel_)
            drive_panel_->bind_project(active_ ? s(document_.project.id) : QString{}, path_,
                                       saved_.topology.revision, clean);
        if (impact_panel_) {
            QStringList sites;
            for (const auto &asset : document_.topology.assets)
                if (!sites.contains(s(asset.site)))
                    sites << s(asset.site);
            impact_panel_->bind_project(s(document_.project.id), path_, saved_.topology.revision, clean,
                                        sites);
        }
    };
    settings_->choose_folder = [this] {
        if (path_.isEmpty()) {
            statusBar()->showMessage(project_caption("Save the project before linking a folder."));
            return;
        }
        try {
            // This window may still hold a retained source after activation.
            const lmti::LibraryEntry displayed{s(document_.project.id), s(document_.project.label),
                                                path_, folder_};
            const auto intent = review_library_entry(displayed);
            const auto folder = QFileDialog::getExistingDirectory(
                this, project_caption("Choose project folder…"), folder_);
            if (!folder.isEmpty()) {
                change_library_folder(displayed, folder, intent);
                settings_->bind(document_.project, saved_.topology.revision, folder_);
            }
        } catch (const std::exception &exception) {
            error(exception);
        }
    };
    tabs_->addTab(settings_, "Project settings");
    impact_panel_ = new ImpactPanel;
    tabs_->addTab(impact_panel_, "Change review");
    mcp_panel_ = new McpProfilePanel(QDir(QFileInfo(catalog_).absolutePath()).filePath("mcp-profiles.sqlite"));
    tabs_->addTab(mcp_panel_, "MCP & Agents");
}

void ProjectWindow::refresh_recent() {
    try {
        lmti::import_recent_library(catalog_, library_path_);
        auto entries = lmti::project_library(library_path_);
        recent_list_->clear();
        for (std::size_t i = 0; i < std::min<std::size_t>(3, entries.size()); ++i) {
            const auto &entry = entries[i];
            auto item = new QListWidgetItem(studio::toolbar_icon(studio::ToolbarIcon::Review), entry.label,
                                            recent_list_);
            item->setData(Qt::UserRole, entry.path);
            item->setData(Qt::UserRole + 1, entry.id);
            item->setSizeHint(QSize(180, 38));
        }
        library_view_->set_entries(entries);
        if (!library_error_.isEmpty())
            library_view_->set_error(library_error_);
        QSignalBlocker blocker(project_picker_);
        project_picker_->clear();
        project_picker_->addItem(active_ ? s(document_.project.label) : project_caption("Choose a project…"),
                                 path_);
        for (const auto &e : entries)
            if (!active_ || e.id != s(document_.project.id)) {
                project_picker_->addItem(e.label, e.path);
                project_picker_->setItemData(project_picker_->count() - 1, e.id, Qt::UserRole + 1);
            }
    } catch (const std::exception &e) {
        const auto message = library_error_.isEmpty()
            ? project_caption("Library unavailable: %1").arg(QString::fromUtf8(e.what())) : library_error_;
        statusBar()->showMessage(message);
        library_view_->set_error(message);
    }
}
void ProjectWindow::refresh_navigation() {
    const bool home = root_->currentIndex() == 0;
    project_navigation_->setVisible(active_ && !home);
    resume_button_->setVisible(false);
    recent_projects_->setVisible(home && recent_list_->count() > 0);
    project_switcher_->setVisible(active_ && !home);
    findChild<QPushButton *>("showProjectLibrary")->setChecked(home);
    project_settings_->setVisible(active_ && !home);
    project_settings_->setChecked(!home && tabs_->currentIndex() == static_cast<int>(ProjectPage::Settings));
    if (!home)
        resume_page_ = tabs_->currentIndex();
    findChild<QToolBar *>("projectToolbar")->setVisible(!home);
    QSignalBlocker blocker(navigation_);
    QSignalBlocker knowledge_blocker(knowledge_navigation_);
    QString page = project_caption("Project library");
    if (!home && tabs_->currentIndex() == static_cast<int>(ProjectPage::Settings))
        page = project_caption("Project settings");
    for (auto list : {navigation_, knowledge_navigation_}) {
        int selected = -1;
        for (int i = 0; i < list->count(); ++i)
            if (list->item(i)->data(Qt::UserRole).toInt() == tabs_->currentIndex()) {
                selected = i;
                if (!home)
                    page = list->item(i)->text();
            }
        list->setCurrentRow(home ? -1 : selected);
    }
    int visible_rows = 0;
    for (int i = 0; i < navigation_->count(); ++i) {
        auto item = navigation_->item(i);
        const auto page_id = static_cast<ProjectPage>(item->data(Qt::UserRole).toInt());
        const bool everyday = page_id == ProjectPage::Mcp || page_id == ProjectPage::Overview ||
                              page_id == ProjectPage::Architecture;
        item->setHidden(!everyday && !more_tools_->isChecked() &&
                        item->data(Qt::UserRole).toInt() != tabs_->currentIndex());
        visible_rows += !item->isHidden();
    }
    navigation_->setFixedHeight(visible_rows * 40 + 2);
    breadcrumb_->setText(home ? QString(page) : QString("%1  /  %2").arg(s(document_.project.label), page));
    setWindowTitle(home ? "LMTI Studio · " + project_caption("Project library")
                        : "LMTI Studio · " + s(document_.project.label) + (document_ != saved_ ? " *" : ""));
    if (active_) {
        heading_->setText(page);
        static const QStringList descriptions{
            "Next actions, open work and project progress.",
            "Manage components, repositories and declared dependencies.",
            "Manage devices, hardware targets and desired software bindings.",
            "Explore device topology and software relationships.",
            "Plan work, track progress and review milestone evidence.",
            "Manage versions and their verification evidence.",
            "Prepare scoped context and review proposed work changes.",
            "Connect a local knowledge source or manage reference metadata.",
            "Manage basic project information and local files.",
            "Review project changes, source evidence and human verification.",
            "Set up project MCP connections for Codex and Cursor."};
        page_description_->setText(project_caption(descriptions.value(tabs_->currentIndex())));
        heading_->setToolTip(page_description_->text());
        breadcrumb_->setToolTip(folder_);
        folder_label_->setText(folder_.isEmpty()
                                   ? project_caption("No folder linked · choose a folder from the library")
                                   : project_caption("Folder: %1")
                                         .arg(QFontMetrics(font()).elidedText(
                                             QDir::toNativeSeparators(folder_), Qt::ElideMiddle, 650)));
        folder_label_->setToolTip(folder_);
        save_state_->setText(document_ != saved_
                                 ? project_caption("● Unsaved changes")
                                 : project_caption("Saved · revision %1").arg(document_.topology.revision));
    }
    queue_navigation_visibility();
}
void ProjectWindow::queue_navigation_visibility() {
    if (navigation_visibility_pending_ || !findChild<QScrollArea *>("sidebarScroll"))
        return;
    navigation_visibility_pending_ = true;
    QTimer::singleShot(0, this, [this] {
        navigation_visibility_pending_ = false;
        auto scroll = findChild<QScrollArea *>("sidebarScroll");
        if (!scroll || !scroll->widget())
            return;
        scroll->widget()->layout()->activate();
        if (root_->currentIndex() == 0) {
            scroll->ensureWidgetVisible(findChild<QPushButton *>("showProjectLibrary"), 0, 6);
            return;
        }
        for (auto list : {navigation_, knowledge_navigation_}) {
            const auto item = list->currentItem();
            if (!item || !list->isVisible())
                continue;
            list->scrollToItem(item);
            const auto rect = list->visualItemRect(item);
            const auto center = list->viewport()->mapTo(scroll->widget(), rect.center());
            scroll->ensureVisible(center.x(), center.y(), 0, rect.height() / 2 + 6);
            break;
        }
    });
}
void ProjectWindow::show_library() {
    inspector_->hide();
    root_->setCurrentIndex(0);
    refresh_recent();
    refresh_navigation();
}
void ProjectWindow::set_language(bool english) {
    project_english = english;
    const auto settings_path = QDir(QFileInfo(catalog_).absolutePath()).filePath("ui-settings.ini");
    if (QFileInfo(settings_path).isSymLink() ||
        (QFileInfo::exists(settings_path) &&
         (!QFileInfo(settings_path).isFile() || QFileInfo(settings_path).size() > 4096))) {
        statusBar()->showMessage("Language preference was not saved: settings file is a symbolic link.");
    } else {
        QSettings settings(settings_path, QSettings::IniFormat);
        settings.setValue("language", english ? "en" : "vi");
        settings.sync();
        if (settings.status() != QSettings::NoError)
            statusBar()->showMessage(
                "Language changed for this session; local preference could not be saved.");
    }
    language_picker_->setCurrentIndex(english ? 0 : 1);
    const auto page = root_->currentIndex();
    apply_project_captions(this);
    refresh(false, true);
    architecture_->retranslate();
    root_->setCurrentIndex(page);
    refresh_navigation();
}
void ProjectWindow::refresh(bool architecture, bool keep_knowledge) {
    if (active_ && settings_)
        settings_->bind(document_.project, saved_.topology.revision, folder_);
    knowledge_panel_->bind_project(active_ ? s(document_.project.id) : QString{}, !keep_knowledge);
    struct Selection {
        QTreeWidget *tree;
        QString id;
        int scroll;
    };
    std::vector<Selection> selections;
    for (const auto &ui : table_ui_) {
        selections.push_back({ui.tree, selected_id(ui.tree), ui.tree->verticalScrollBar()->value()});
        ui.tree->setSortingEnabled(false);
    }
    refreshing_ = true;
    root_->setCurrentIndex(active_ ? 1 : 0);
    save_action_->setEnabled(active_ && (path_.isEmpty() || document_ != saved_ || settings_->pending()));
    close_action_->setEnabled(active_);
    undo_action_->setEnabled(active_ && !undo_.empty());
    redo_action_->setEnabled(active_ && !redo_.empty());
    const bool clean = active_ && !path_.isEmpty() && document_ == saved_ && !settings_->pending();
    QStringList mcp_sites;
    for (const auto &asset : document_.topology.assets)
        if (!mcp_sites.contains(s(asset.site))) mcp_sites << s(asset.site);
    mcp_panel_->bind({library_path_, active_ ? s(document_.project.id) : QString{},
                      path_, folder_, saved_, clean}, mcp_sites);
    review_action_->setEnabled(clean);
    agent_review_->bind(document_, clean);
    QStringList impact_sites;
    for (const auto &asset : document_.topology.assets)
        if (!impact_sites.contains(s(asset.site)))
            impact_sites << s(asset.site);
    impact_panel_->bind_project(active_ ? s(document_.project.id) : QString{}, path_,
                                saved_.topology.revision, clean, impact_sites);
    drive_panel_->bind_project(active_ ? s(document_.project.id) : QString{}, path_, saved_.topology.revision,
                               clean);
    review_action_->setToolTip(clean ? "Review a bounded work-status proposal"
                                     : "Save the project before reviewing a proposal");
    setWindowTitle("LMTI · " + (active_ ? s(document_.project.label) : "Projects") +
                   (active_ && document_ != saved_ ? " *" : ""));
    if (!active_) {
        refresh_recent();
        refresh_navigation();
        return;
    }
    auto done = std::count_if(document_.work.begin(), document_.work.end(),
                              [](auto &w) { return w.state == lmti::WorkState::Done; });
    auto blocked = std::count_if(document_.work.begin(), document_.work.end(),
                                 [](auto &w) { return w.state == lmti::WorkState::Blocked; });
    summary_->setText(document_.project.goal.empty()
                          ? project_caption("Add a goal in Project settings to guide the work.")
                          : s(document_.project.goal));
    metrics_[0]->setText(QString::number(document_.components.size()));
    metrics_[1]->setText(QString::number(document_.topology.assets.size()));
    metrics_[2]->setText(QString::number(
        std::count_if(document_.releases.begin(), document_.releases.end(),
                      [](const auto &release) { return release.state == lmti::ReleaseState::Candidate; })));
    metrics_[3]->setText(QString::number(done) + " / " + QString::number(document_.work.size()));
    progress_->setText(
        document_.work.empty()
            ? project_caption("No work planned yet")
            : project_caption("Progress: %1% complete  ·  %2 blocked  ·  milestones need acceptance evidence")
                  .arg(QString::number(100.0 * done / document_.work.size(), 'f', 0))
                  .arg(blocked));
    components_->clear();
    repositories_->clear();
    targets_->clear();
    bindings_->clear();
    dependencies_->clear();
    releases_->clear();
    verification_->clear();
    milestones_->clear();
    knowledge_->clear();
    overview_bindings_->clear();
    overview_blockers_->clear();
    hardware_devices_->clear();
    hardware_details_->setText("Select a device to see its software, release and linked work.");
    for (const auto &a : document_.topology.assets) {
        QStringList software;
        for (const auto &b : document_.bindings)
            if (b.asset_id == a.id)
                software << label(document_.components, b.component_id) + " " +
                                label(document_.releases, b.release_id);
        row(hardware_devices_, a.id,
            {s(a.label), studio::enum_caption(s(lmti::name(a.kind))), s(a.site), software.join(", "),
             studio::enum_caption("unknown")},
            {{"kind", s(lmti::name(a.kind))}, {"site", s(a.site)}});
    }
    for (const auto &r : document_.components) {
        QStringList devices;
        for (const auto &b : document_.bindings)
            if (b.component_id == r.id)
                devices << label(document_.topology.assets, b.asset_id);
        auto item = row(components_, r.id,
                        {s(r.label), studio::enum_caption(s(lmti::name(r.kind))),
                         label(document_.repositories, r.repository_id), QString::number(devices.size()),
                         studio::enum_caption(s(lmti::name(r.privacy)))},
                        {{"kind", s(lmti::name(r.kind))}});
        item->setToolTip(3, devices.join("\n").toHtmlEscaped());
        item->setData(0, Qt::UserRole + 5, devices.join("\n"));
        item->setData(4, studio::badge_role, s(lmti::name(r.privacy)));
    }
    QHash<QString, int> repository_counts;
    for (const auto &component : document_.components)
        ++repository_counts[s(component.repository_id)];
    for (const auto &r : document_.repositories) {
        auto item = row(repositories_, r.id,
                        {s(r.label), r.locator.empty() ? QString::fromUtf8("—") : s(r.locator),
                         studio::enum_caption(s(lmti::name(r.privacy))),
                         QString::number(repository_counts.value(s(r.id)))});
        item->setData(2, studio::badge_role, s(lmti::name(r.privacy)));
    }
    for (const auto &r : document_.targets)
        row(targets_, r.id, {s(r.label), s(r.hardware_revision), s(r.architecture)});
    for (const auto &r : document_.bindings)
        row(bindings_, r.id,
            {label(document_.topology.assets, r.asset_id), label(document_.components, r.component_id),
             label(document_.releases, r.release_id), label(document_.targets, r.target_id),
             project_caption("Unknown")});
    for (const auto &r : document_.bindings)
        row(overview_bindings_, r.id,
            {label(document_.topology.assets, r.asset_id), label(document_.components, r.component_id),
             label(document_.releases, r.release_id), project_caption("unknown")});
    if (document_.bindings.empty())
        new QTreeWidgetItem(overview_bindings_,
                            {"No bindings yet — add a release and link it to a device in Hardware"});
    for (const auto &r : document_.work)
        if (r.state != lmti::WorkState::Done) {
            row(overview_blockers_, r.id,
                {s(r.label), studio::enum_caption(s(lmti::name(r.state))),
                 label(document_.components, r.component_id), label(document_.releases, r.release_id)});
            overview_blockers_->topLevelItem(overview_blockers_->topLevelItemCount() - 1)
                ->setData(1, studio::badge_role, s(lmti::name(r.state)));
        }
    if (document_.work.empty())
        new QTreeWidgetItem(overview_blockers_, {"No work planned — add tasks and a milestone in Work"});
    for (const auto &r : document_.dependencies)
        row(dependencies_, r.id,
            {label(document_.components, r.from), label(document_.components, r.to), s(r.contract)});
    for (const auto &r : document_.releases) {
        row(releases_, r.id,
            {s(r.label), label(document_.components, r.component_id), label(document_.targets, r.target_id),
             s(r.source_revision), studio::enum_caption(s(lmti::name(r.state)))},
            {{"state", s(lmti::name(r.state))},
             {"component", s(r.component_id)},
             {"componentLabel", label(document_.components, r.component_id)}});
        releases_->topLevelItem(releases_->topLevelItemCount() - 1)
            ->setData(4, studio::badge_role, s(lmti::name(r.state)));
    }
    for (const auto &r : document_.verification) {
        row(verification_, r.id,
            {label(document_.releases, r.release_id), label(document_.topology.assets, r.asset_id),
             studio::enum_caption(s(lmti::name(r.result))), s(r.evidence), s(r.source),
             QDateTime::fromSecsSinceEpoch(r.at, QTimeZone::UTC).toString("yyyy-MM-dd")},
            {{"result", s(lmti::name(r.result))},
             {"release", s(r.release_id)},
             {"releaseLabel", label(document_.releases, r.release_id)}});
        verification_->topLevelItem(verification_->topLevelItemCount() - 1)
            ->setData(2, studio::badge_role, s(lmti::name(r.result)));
        verification_->topLevelItem(verification_->topLevelItemCount() - 1)
            ->setToolTip(5, QDateTime::fromSecsSinceEpoch(r.at, QTimeZone::UTC).toString(Qt::ISODate));
    }
    for (const auto &r : document_.milestones) {
        int total = 0, count = 0;
        for (const auto &w : document_.work)
            if (w.milestone_id == r.id) {
                ++total;
                if (w.state == lmti::WorkState::Done)
                    ++count;
            }
        auto item = row(milestones_, r.id,
                        {s(r.label), r.due_date.empty() ? project_caption("Not set") : s(r.due_date),
                         project_caption("%1 of %2 complete").arg(count).arg(total),
                         project_caption(r.accepted ? "Operator accepted" : "Pending"),
                         project_caption(r.evidence.empty() ? "Missing" : "Recorded")});
        item->setData(3, studio::badge_role, r.accepted ? "approved" : "pending");
        item->setData(4, studio::badge_role, r.evidence.empty() ? "failed" : "public");
        item->setToolTip(0, s(r.criteria).toHtmlEscaped());
        item->setToolTip(4, s(r.evidence).toHtmlEscaped());
        item->setData(0, Qt::UserRole + 5,
                      item->data(0, Qt::UserRole + 5).toString() + "\n" + s(r.criteria) + "\n" +
                          s(r.evidence));
    }
    for (const auto &r : document_.knowledge)
        row(knowledge_, r.id,
            {s(r.label), label(document_.components, r.component_id), s(r.fingerprint),
             project_caption("Reference only · source not loaded")});
    refresh_work();
    {
        QSignalBlocker blocker(agent_site_);
        auto current = agent_site_->currentText();
        agent_site_->clear();
        std::set<QString> sites;
        for (const auto &a : document_.topology.assets)
            sites.insert(s(a.site));
        if (sites.empty())
            sites.insert("project-local");
        for (const auto &site : sites)
            agent_site_->addItem(site);
        if (agent_site_->findText(current) >= 0)
            agent_site_->setCurrentText(current);
    }
    refresh_agent();
    refresh_relationships();
    if (architecture)
        architecture_->refresh_document();
    refresh_attention();
    refresh_creation_actions();
    for (const auto &selection : selections) {
        selection.tree->setSortingEnabled(true);
        for (int i = 0; i < selection.tree->topLevelItemCount(); ++i)
            if (selection.tree->topLevelItem(i)->data(0, Qt::UserRole).toString() == selection.id)
                selection.tree->setCurrentItem(selection.tree->topLevelItem(i));
        selection.tree->verticalScrollBar()->setValue(selection.scroll);
    }
    for (const auto &ui : table_ui_) {
        refresh_table_filters(ui);
        filter_table(ui);
    }
    refreshing_ = false;
    refresh_inspector();
    refresh_recent();
    refresh_navigation();
}
void ProjectWindow::refresh_work() {
    auto selected_work = selected_id(work_list_);
    if (work_views_->currentIndex() == 1)
        for (auto column : work_columns_)
            if (!selected_id(column).isEmpty())
                selected_work = selected_id(column);
    QSignalBlocker list_blocker(work_list_);
    work_list_->setSortingEnabled(false);
    work_list_->clear();
    for (auto tree : work_columns_)
        tree->clear();
    const QStringList states{"todo", "in-progress", "blocked", "review", "done"};
    for (const auto &w : document_.work) {
        const QStringList values{s(w.label),
                                 studio::enum_caption(s(lmti::name(w.state))),
                                 studio::enum_caption(s(lmti::name(w.kind))),
                                 label(document_.components, w.component_id),
                                 label(document_.topology.assets, w.asset_id),
                                 label(document_.releases, w.release_id),
                                 label(document_.milestones, w.milestone_id),
                                 w.evidence.empty() ? project_caption("Not recorded") : s(w.evidence)};
        const QVariantMap fields{{"state", s(lmti::name(w.state))}, {"kind", s(lmti::name(w.kind))}};
        row(work_list_, w.id, values, fields);
        const auto searchable =
            values.join("\n") + "\n" + s(lmti::name(w.state)) + "\n" + s(lmti::name(w.kind));
        work_list_->topLevelItem(work_list_->topLevelItemCount() - 1)
            ->setData(0, Qt::UserRole + 5, searchable);
        work_list_->topLevelItem(work_list_->topLevelItemCount() - 1)
            ->setData(1, studio::badge_role, s(lmti::name(w.state)));
        auto description = s(w.label) + "\n" + label(document_.components, w.component_id) + " · " +
                           label(document_.topology.assets, w.asset_id) + "\n" +
                           label(document_.milestones, w.milestone_id);
        auto column = work_columns_[states.indexOf(s(lmti::name(w.state)))];
        row(column, w.id, {description}, fields);
        column->topLevelItem(column->topLevelItemCount() - 1)->setData(0, Qt::UserRole + 5, searchable);
        auto card = column->topLevelItem(column->topLevelItemCount() - 1);
        card->setData(0, studio::work_title_role, s(w.label));
        card->setData(0, studio::work_component_role, label(document_.components, w.component_id));
        card->setData(0, studio::work_release_role, label(document_.releases, w.release_id));
        card->setData(0, studio::work_milestone_role, label(document_.milestones, w.milestone_id));
        card->setData(0, studio::work_evidence_role, !w.evidence.empty());
    }
    work_list_->setSortingEnabled(true);
    for (const auto &ui : table_ui_)
        if (ui.tree == work_list_)
            refresh_table_filters(ui);
    for (int i = 0; i < work_list_->topLevelItemCount(); ++i)
        if (work_list_->topLevelItem(i)->data(0, Qt::UserRole).toString() == selected_work)
            work_list_->setCurrentItem(work_list_->topLevelItem(i));
    filter_work_views();
    if (work_views_->currentIndex() == 1) {
        bool selected = false;
        for (auto column : work_columns_) {
            QSignalBlocker blocker(column);
            for (int i = 0; i < column->topLevelItemCount(); ++i) {
                auto item = column->topLevelItem(i);
                if (!item->isHidden() && !selected_work.isEmpty() &&
                    item->data(0, Qt::UserRole).toString() == selected_work) {
                    column->setCurrentItem(item);
                    selected = true;
                }
            }
        }
        edit_work_->setEnabled(selected);
        remove_work_->setEnabled(selected);
    }
}
void ProjectWindow::filter_work_views() {
    for (const auto &ui : table_ui_)
        if (ui.tree == work_list_)
            filter_table(ui);
    bool board_selection = false;
    for (auto column : work_columns_) {
        QSignalBlocker blocker(column);
        int visible = 0;
        for (int i = 0; i < column->topLevelItemCount(); ++i) {
            auto item = column->topLevelItem(i);
            bool matches = item->data(0, Qt::UserRole + 5)
                               .toString()
                               .contains(work_filter_->text().trimmed(), Qt::CaseInsensitive);
            for (const auto &ui : table_ui_)
                if (ui.tree == work_list_)
                    matches = matches && matches_table_filters(ui, item);
            item->setHidden(!matches);
            if (!matches)
                item->setSelected(false);
            else {
                ++visible;
                board_selection |= item->isSelected();
            }
        }
        const auto total = column->topLevelItemCount();
        const auto count =
            visible == total ? QString::number(visible) : QString("%1 / %2").arg(visible).arg(total);
        column->setHeaderLabel(studio::enum_caption(column->property("workState").toString()) + "  " + count);
    }
    if (work_views_->currentIndex() == 1) {
        edit_work_->setEnabled(board_selection);
        remove_work_->setEnabled(board_selection);
    }
}
void ProjectWindow::refresh_agent() {
    if (!active_)
        return;
    agent_note_->setText(project_caption("Public context preview · revision %1 · %2")
                             .arg(document_.topology.revision)
                             .arg(project_caption(document_ == saved_ && !path_.isEmpty()
                                                      ? "Saved snapshot"
                                                      : "Unsaved document · SDK reads saved data")));
    agent_summary_->clear();
    agent_records_->clear();
    agent_records_->setProperty("contextUnavailable", false);
    for (auto count : agent_counts_)
        count->setText("—");
    auto summary = [this](const QString &key, const QString &value) {
        new QTreeWidgetItem(agent_summary_, {project_caption(key), value});
    };
    summary("Project", s(document_.project.label));
    summary("Site scope", agent_site_->currentText());
    summary("Visibility", project_caption("Public metadata only"));
    summary("Observed version", project_caption("Unknown · no device execution"));
    agent_scope_values_[0]->setText(s(document_.project.label));
    agent_scope_values_[1]->setText(agent_site_->currentText());
    agent_scope_values_[2]->setText(project_caption("Public metadata only"));
    agent_scope_values_[3]->setText(project_caption("Unknown"));
    for (auto value : agent_scope_values_)
        value->setToolTip(value->text().toHtmlEscaped());
    try {
        auto context = lmti::project_context(
            document_, {document_.project.id, agent_site_->currentText().toStdString(), true, 100});
        agent_context_->setPlainText(
            QString::fromUtf8(QJsonDocument(context).toJson(QJsonDocument::Indented)));
        const QStringList count_keys{"components", "assets", "releases", "work"};
        for (int i = 0; i < 4; ++i)
            agent_counts_[i]->setText(QString::number(context.value(count_keys[i]).toArray().size()));
        summary("Truncated", project_caption(context.value("truncated").toBool() ? "Yes" : "No"));
        const std::vector<std::pair<QString, QString>> categories{
            {"components", "Component"},  {"assets", "Device"},           {"releases", "Release"},
            {"work", "Work item"},        {"repositories", "Repository"}, {"targets", "Target"},
            {"bindings", "Binding"},      {"dependencies", "Dependency"}, {"milestones", "Milestone"},
            {"verification", "Evidence"}, {"knowledge", "Reference"}};
        for (const auto &[key, caption] : categories) {
            for (const auto &value : context.value(key).toArray()) {
                const auto record = value.toObject();
                QStringList details;
                for (const auto &field : {"kind", "state", "contract", "hardwareRevision", "architecture",
                                          "observedVersion", "result", "acceptance"})
                    if (record.value(field).isString() && !record.value(field).toString().isEmpty())
                        details << studio::enum_caption(record.value(field).toString());
                new QTreeWidgetItem(agent_records_,
                                    {project_caption(caption),
                                     record.value("label").toString(record.value("id").toString()),
                                     details.join(" · ")});
            }
        }
    } catch (const std::exception &e) {
        agent_records_->setProperty("contextUnavailable", true);
        agent_note_->setText(agent_note_->text() + " · " +
                             project_caption("Context unavailable for this scope."));
        summary("Context unavailable", QString::fromUtf8(e.what()));
        agent_context_->setPlainText(
            QString::fromUtf8(e.what()) +
            "\nNew projects default to internal. Classify only nonsecret metadata public deliberately.");
    }
    filter_agent_records();
}
void ProjectWindow::filter_agent_records() {
    const auto query = agent_filter_->text().trimmed();
    int visible = 0;
    for (int i = 0; i < agent_records_->topLevelItemCount(); ++i) {
        auto item = agent_records_->topLevelItem(i);
        bool match = query.isEmpty();
        for (int column = 0; !match && column < agent_records_->columnCount(); ++column)
            match = item->text(column).contains(query, Qt::CaseInsensitive);
        item->setHidden(!match);
        visible += match;
    }
    auto empty = agent_records_->findChild<QLabel *>("tableEmptyState");
    if (empty) {
        const auto message = agent_records_->property("contextUnavailable").toBool()
                                 ? "Context unavailable for this scope."
                             : agent_records_->topLevelItemCount() == 0
                                 ? "No allowed records to display for this scope."
                                 : "No matching records. Clear the search to see allowed records.";
        empty->setText(project_caption(message));
        empty->setVisible(visible == 0);
        if (visible == 0)
            empty->raise();
    }
}
void ProjectWindow::refresh_relationships() {
    QString selected_id, selected_kind;
    if (relationship_scene_->selectedItems().size() == 1) {
        selected_id = relationship_scene_->selectedItems().front()->data(0).toString();
        selected_kind = relationship_scene_->selectedItems().front()->data(1).toString();
    }
    QSignalBlocker scene_blocker(relationship_scene_);
    relationship_scene_->clear();
    const bool compact = width() < 1440;
    relationship_scene_->setProperty("compactLayout", compact);
    const double card_width = compact ? 185 : 240;
    const double device_column = compact ? 315 : 520;
    std::map<std::string, QPointF> software, devices;
    auto title_font = relationship_view_->font();
    title_font.setPixelSize(compact ? 20 : 18);
    title_font.setBold(true);
    auto detail_font = title_font;
    detail_font.setPixelSize(compact ? 16 : 15);
    detail_font.setBold(false);
    auto card = [&](const std::string &id, const QString &title, const QString &detail,
                    const QPointF &position, const QColor &accent, const QString &kind) {
        auto box = new studio::GraphCard(QRectF(position, QSizeF(card_width, 70)));
        relationship_scene_->addItem(box);
        box->setPen(QPen(accent, 1.5));
        box->setBrush(QColor(kind == "component" ? "#e8efff" : "#e0f4f2"));
        box->setZValue(1);
        box->setData(0, s(id));
        box->setData(1, kind);
        box->setFlag(QGraphicsItem::ItemIsSelectable);
        box->setFlag(QGraphicsItem::ItemIsFocusable);
        box->setSelected(s(id) == selected_id && kind == selected_kind && s(id) == inspected_id_ &&
                         kind == inspected_kind_);
        auto text = new QGraphicsSimpleTextItem(
            QFontMetrics(title_font).elidedText(title, Qt::ElideRight, card_width - 24), box);
        text->setFont(title_font);
        text->setBrush(QColor("#202a3a"));
        text->setPos(position + QPointF(12, 10));
        auto subtitle = new QGraphicsSimpleTextItem(
            QFontMetrics(detail_font).elidedText(detail, Qt::ElideRight, card_width - 24), box);
        subtitle->setFont(detail_font);
        subtitle->setBrush(accent);
        subtitle->setPos(position + QPointF(12, 40));
        box->setToolTip((title + "\n" + detail).toHtmlEscaped());
    };
    for (const auto &[caption, position] : {std::pair{QString("Software components"), QPointF(0, -42)},
                                            std::pair{QString("Devices"), QPointF(device_column, -42)}}) {
        auto title = relationship_scene_->addSimpleText(project_caption(caption));
        title->setFont(detail_font);
        title->setBrush(QColor("#526581"));
        title->setPos(position);
    }
    for (const auto &r : document_.components) {
        if (software.size() == 50)
            break;
        QPointF p(0, software.size() * 100.0);
        software[r.id] = p;
        card(r.id, s(r.label), studio::enum_caption(s(lmti::name(r.kind))), p, QColor("#3563e9"),
             "component");
    }
    for (const auto &r : document_.topology.assets) {
        if (devices.size() == 50)
            break;
        QPointF p(device_column, devices.size() * 100.0);
        devices[r.id] = p;
        card(r.id, s(r.label), s(r.site) + " · " + project_caption("Observed: Unknown"), p, QColor("#168b8b"),
             "device");
    }
    for (const auto &r : document_.bindings)
        if (software.contains(r.component_id) && devices.contains(r.asset_id)) {
            auto from = software.at(r.component_id) + QPointF(card_width, 35),
                 to = devices.at(r.asset_id) + QPointF(0, 35);
            QPainterPath path(from);
            const auto curve = (device_column - card_width) / 2;
            path.cubicTo(from + QPointF(curve, 0), to - QPointF(curve, 0), to);
            studio::directed_edge(relationship_scene_, path, QColor("#3563e9"), Qt::SolidLine, "binding",
                                  s(r.component_id), s(r.asset_id));
            auto label_item = relationship_scene_->addSimpleText(
                project_caption("Desired %1").arg(label(document_.releases, r.release_id)));
            label_item->setFont(detail_font);
            label_item->setBrush(QColor("#526581"));
            label_item->setPos(path.pointAtPercent(0.5) -
                               QPointF(label_item->boundingRect().width() / 2, 24));
        }
    for (const auto &r : document_.dependencies)
        if (software.contains(r.from) && software.contains(r.to)) {
            auto from = software.at(r.from) + QPointF(0, 35), to = software.at(r.to) + QPointF(0, 35);
            QPainterPath path(from);
            const auto lane = compact ? 60.0 : 90.0;
            path.cubicTo(from - QPointF(lane, 0), to - QPointF(lane, 0), to);
            studio::directed_edge(relationship_scene_, path, QColor("#64748b"), Qt::DashLine, "dependency",
                                  s(r.from), s(r.to));
            auto label_item = relationship_scene_->addSimpleText(
                QFontMetrics(detail_font).elidedText(s(r.contract), Qt::ElideRight, compact ? 90 : 120));
            label_item->setFont(detail_font);
            label_item->setToolTip(s(r.contract).toHtmlEscaped());
            label_item->setBrush(QColor("#526581"));
            label_item->setPos(path.pointAtPercent(0.5) - QPointF(label_item->boundingRect().width() + 6, 0));
        }
    graph_count_->setText(project_caption("Shown: %1/%2 software · %3/%4 devices")
                              .arg(software.size())
                              .arg(document_.components.size())
                              .arg(devices.size())
                              .arg(document_.topology.assets.size()));
    relationship_scene_->setSceneRect(relationship_scene_->itemsBoundingRect().adjusted(-30, -30, 30, 30));
    for (const auto &name : {"fitRelationships", "zoomInRelationships", "zoomOutRelationships"})
        findChild<QPushButton *>(name)->setEnabled(!software.empty() || !devices.empty());
}
void ProjectWindow::new_project(const QString &label, const QString &goal) {
    lmti::ProjectDocument next;
    next.project = {uid("project"), label.trimmed().toStdString(), goal.trimmed().toStdString(),
                    lmti::Privacy::Internal};
    lmti::validate(next);
    document_ = next;
    saved_ = {};
    path_.clear();
    folder_.clear();
    library_error_.clear();
    undo_.clear();
    redo_.clear();
    active_ = true;
    inspected_id_.clear();
    inspector_history_.clear();
    inspector_->hide();
    tabs_->setCurrentIndex(static_cast<int>(ProjectPage::Mcp));
    refresh();
}
void ProjectWindow::load_demo() {
    document_ = lmti::demo_project();
    saved_ = {};
    path_.clear();
    folder_.clear();
    library_error_.clear();
    undo_.clear();
    redo_.clear();
    active_ = true;
    inspected_id_.clear();
    inspector_history_.clear();
    inspector_->hide();
    tabs_->setCurrentIndex(static_cast<int>(ProjectPage::Mcp));
    refresh();
    statusBar()->showMessage(
        "Synthetic demo · all declared software versions are unverified · save to a new file");
}
namespace {
QString library_binding_path(const QString &path) {
    if (path.isEmpty())
        return {};
    auto result = lmti::detail::local_owner_path_lexical(path);
#ifdef Q_OS_WIN
    result = result.toCaseFolded();
#endif
    return result;
}
bool same_library_binding(const lmti::LibraryEntry &a, const lmti::LibraryEntry &b) {
    return a.id == b.id && library_binding_path(a.path) == library_binding_path(b.path) &&
           library_binding_path(a.folder) == library_binding_path(b.folder);
}
const lmti::LibraryEntry *library_entry(const lmti::LibraryInspection &view, const QString &id) {
    for (const auto &entry : view.entries)
        if (entry.id == id)
            return &entry;
    return nullptr;
}
bool library_outcome_uncertain(const std::exception &error) {
    const auto library_error = dynamic_cast<const lmti::LibraryError *>(&error);
    return library_error && library_error->code == lmti::LibraryCode::RecoveryRequired;
}
}
ProjectWindow::LibraryIntent ProjectWindow::capture_library_intent() const {
    LibraryIntent intent;
    try {
        // Check local ancestors before even probing whether the optional index exists.
        const auto path = lmti::detail::local_owner_path(library_path_, false);
        if (QFileInfo::exists(path))
            intent.reviewed = lmti::inspect_project_library(path);
    } catch (const std::exception &) {
        // Library failure must not prevent loading or saving a valid project.
        intent.error = "Library changed or is unavailable. Reopen the library and review this action again.";
    }
    return intent;
}
ProjectWindow::LibraryIntent ProjectWindow::review_library_entry(const lmti::LibraryEntry &displayed) const {
    auto intent = capture_library_intent();
    if (!intent.error.isEmpty() || !intent.reviewed)
        throw lmti::LibraryError(lmti::LibraryCode::Conflict);
    const auto current = library_entry(*intent.reviewed, displayed.id);
    if (!current || !same_library_binding(*current, displayed))
        throw lmti::LibraryError(lmti::LibraryCode::Conflict);
    return intent;
}
void ProjectWindow::require_library_intent(const LibraryIntent &intent) const {
    const auto current = capture_library_intent();
    if (!intent.error.isEmpty() || !current.error.isEmpty() ||
        intent.reviewed.has_value() != current.reviewed.has_value())
        throw lmti::LibraryError(lmti::LibraryCode::Conflict);
    if (!intent.reviewed)
        return;
    if (intent.reviewed->token.schema == 1) {
        // V1 has no durable identity/generation. Preserve its legacy behavior:
        // a Save during the discard dialog may refresh label/opened cosmetics.
        // Compare every binding, without pretending this detects v1 ABA.
        if (current.reviewed->token.schema != 1 ||
            current.reviewed->token.canonical_path != intent.reviewed->token.canonical_path ||
            current.reviewed->entries.size() != intent.reviewed->entries.size())
            throw lmti::LibraryError(lmti::LibraryCode::Conflict);
        for (const auto &entry : intent.reviewed->entries) {
            const auto match = library_entry(*current.reviewed, entry.id);
            if (!match || !same_library_binding(entry, *match))
                throw lmti::LibraryError(lmti::LibraryCode::Conflict);
        }
    } else if (intent.reviewed->token != current.reviewed->token)
        throw lmti::LibraryError(lmti::LibraryCode::Conflict);
}
void ProjectWindow::library_failure(const std::exception &e) {
    // The loaded/saved document stays usable, but a failed binding check must
    // not leave an inherited root presented to project tools as current.
    folder_.clear();
    library_error_ = library_outcome_uncertain(e)
        ? project_caption("Project saved/opened; library update could not be confirmed. Reopen the library to inspect it before repeating this action.")
        : project_caption("Project saved/opened, but library update failed: %1")
              .arg(QString::fromUtf8(e.what()));
    statusBar()->showMessage(library_error_);
    library_view_->set_error(library_error_);
}
void ProjectWindow::finish_library_intent(const LibraryIntent &intent, bool explicit_root) {
    try {
        require_library_intent(intent);
        if (intent.reviewed && intent.reviewed->token.schema >= 2) {
            const auto entry = library_entry(*intent.reviewed, s(document_.project.id));
            if (!entry) {
                lmti::register_library_project_cas(
                    library_path_, {s(document_.project.id), s(document_.project.label), path_, folder_},
                    intent.reviewed->token);
            } else {
                if (library_binding_path(entry->path) != library_binding_path(path_))
                    throw lmti::LibraryError(lmti::LibraryCode::Conflict);
                if (explicit_root && library_binding_path(entry->folder) != library_binding_path(folder_))
                    lmti::link_library_folder_cas(library_path_, entry->id, folder_, intent.reviewed->token);
            }
        }
        // Existing bindings only on v2/v3. This never obtains registration authority.
        remember();
    } catch (const std::exception &e) {
        library_failure(e);
    }
}
void ProjectWindow::change_library_folder(const lmti::LibraryEntry &entry, const QString &folder,
                                           const LibraryIntent &intent) {
    const auto canonical = lmti::checked_project_folder(folder);
    if (!intent.reviewed)
        throw lmti::LibraryError(lmti::LibraryCode::Conflict);
    if (intent.reviewed->token.schema >= 2)
        lmti::link_library_folder_cas(library_path_, entry.id, canonical, intent.reviewed->token);
    else {
        require_library_intent(intent);
        lmti::link_library_folder(library_path_, entry.id, canonical);
    }
    library_error_.clear();
    if (active_ && s(document_.project.id) == entry.id &&
        library_binding_path(path_) == library_binding_path(entry.path)) {
        folder_ = canonical;
        refresh(false, true);
    } else {
        refresh_recent();
        refresh_navigation();
    }
    statusBar()->showMessage(project_caption("Project folder updated."));
}
void ProjectWindow::open_project(const QString &path, const QString &expected_id) {
    open_project_intent(path, expected_id, capture_library_intent());
}
void ProjectWindow::open_project_intent(const QString &path, const QString &expected_id,
                                        const LibraryIntent &intent,
                                        const std::optional<QString> &explicit_root) {
    lmti::ProjectDocument next;
    bool imported = false;
    try {
        next = lmti::load_project(path);
    } catch (const lmti::Error &) {
        auto legacy = lmti::load(path);
        next.project = {uid("project"), QFileInfo(path).completeBaseName().toStdString(),
                        "Imported topology; software and work are not yet configured.",
                        lmti::Privacy::Internal};
        next.topology = legacy;
        next.topology.revision = 0;
        QFile file(path);
        if (!file.open(QIODevice::ReadOnly))
            throw lmti::Error("Cannot fingerprint topology import.");
        QCryptographicHash hash(QCryptographicHash::Sha256);
        qint64 read_bytes = 0;
        while (!file.atEnd()) {
            auto block = file.read(65536);
            read_bytes += block.size();
            if (read_bytes > 64 * 1024 * 1024 || (block.isEmpty() && file.error() != QFileDevice::NoError))
                throw lmti::Error("Topology import exceeds fingerprint budget.");
            hash.addData(block);
        }
        next.knowledge.push_back({uid("import"), "Topology v1 import", "",
                                  "topology-v1-revision-" + std::to_string(legacy.revision),
                                  hash.result().toHex().toStdString(), lmti::Privacy::Internal});
        lmti::validate(next);
        imported = true;
    }
    if (!expected_id.isEmpty() && (imported || s(next.project.id) != expected_id))
        throw lmti::Error("The selected file belongs to a different project. Open it separately to add it.");
    QString folder;
    if (intent.reviewed)
        for (const auto &entry : intent.reviewed->entries)
            if (entry.id == s(next.project.id) &&
                (intent.reviewed->token.schema == 1 ||
                 library_binding_path(entry.path) == library_binding_path(QFileInfo(path).absoluteFilePath())))
                folder = entry.folder;
    if (explicit_root)
        folder = *explicit_root;
    document_ = next;
    saved_ = imported ? lmti::ProjectDocument{} : next;
    path_ = imported ? QString{} : QFileInfo(path).absoluteFilePath();
    folder_ = folder;
    undo_.clear();
    redo_.clear();
    active_ = true;
    inspected_id_.clear();
    inspector_history_.clear();
    inspector_->hide();
    tabs_->setCurrentIndex(static_cast<int>(ProjectPage::Mcp));
    library_error_.clear();
    if (!imported)
        finish_library_intent(intent, explicit_root.has_value());
    refresh();
    statusBar()->showMessage(!library_error_.isEmpty() ? library_error_
        : imported ? "Imported topology in memory. Save to a new project file; the source is unchanged."
                   : "Project opened · saved snapshot");
}
void ProjectWindow::update_project(const std::function<void(lmti::ProjectDocument &)> &operation,
                                   bool architecture) {
    if (!active_)
        throw lmti::Error("Open a project first.");
    auto next = document_;
    operation(next);
    lmti::validate_update(document_, next);
    if (next == document_)
        return;
    if (undo_.size() == 20)
        undo_.erase(undo_.begin());
    undo_.push_back(document_);
    redo_.clear();
    document_ = std::move(next);
    refresh(architecture);
}
void ProjectWindow::remember() {
    library_error_.clear();
    try {
        lmti::remember_library_project(library_path_,
                                       {s(document_.project.id), s(document_.project.label), path_, {}});
        if (!folder_.isEmpty() && QFileInfo(folder_).isDir())
            lmti::link_library_folder(library_path_, s(document_.project.id), folder_);
        lmti::remember_project(catalog_, {s(document_.project.id), s(document_.project.label), path_});
        refresh_recent();
    } catch (const std::exception &e) {
        library_failure(e);
    }
}
void ProjectWindow::create_project_dialog() {
    const auto intent = capture_library_intent();
    if (!discard_allowed())
        return;
    Form form(this, "Tạo dự án trong thư mục mới");
    form.setObjectName("createProjectDialog");
    auto name = form.text("Tên dự án", {});
    auto goal = form.text("Mục tiêu", {}, 512);
    auto folder_name = form.text("Tên thư mục", {}, 64);
    auto parent = form.text("Thư mục chứa", {}, 1024);
    form.check(parent, [parent] {
        try {
            lmti::checked_project_folder(parent->text());
        } catch (...) {
            return project_caption("Choose an existing project folder outside .lmti.");
        }
        return QString{};
    });
    form.check(folder_name, [folder_name, parent] {
        const auto folder = folder_name->text();
        const auto reserved = QRegularExpression("^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\..*)?$",
                                                 QRegularExpression::CaseInsensitiveOption);
        if (folder.isEmpty() || folder != folder.trimmed() || folder == "." || folder == ".." ||
            folder.compare(".lmti", Qt::CaseInsensitive) == 0 || folder.endsWith('.') ||
            folder.contains(QRegularExpression("[\\\\/:*?\"<>|\\x00-\\x1f]")) ||
            reserved.match(folder).hasMatch())
            return project_caption("Use a simple new folder name without separators or reserved names.");
        if (QFileInfo::exists(QDir(parent->text()).filePath(folder)))
            return project_caption("Folder exists. Link it from the library instead.");
        return QString{};
    });
    parent->setPlaceholderText("Chọn thư mục trên máy để tạo dự án bên trong");
    auto choose = new QPushButton("Chọn thư mục chứa…");
    form.layout()->addWidget(choose);
    connect(choose, &QPushButton::clicked, &form, [this, parent] {
        auto path =
            QFileDialog::getExistingDirectory(this, project_caption("Choose parent folder"), parent->text());
        if (!path.isEmpty())
            parent->setText(path);
    });
    connect(name, &QLineEdit::textEdited, &form, [folder_name](const QString &value) {
        if (!folder_name->isModified()) {
            auto slug = value.trimmed();
            slug.replace(QRegularExpression("[\\\\/:*?\"<>|\\s]+"), "-");
            folder_name->setText(slug.left(64));
        }
    });
    auto preview = plain({});
    preview->setObjectName("projectDestinationPreview");
    preview->setProperty("verbatim", true);
    form.layout()->addWidget(preview);
    auto update_preview = [parent, folder_name, preview] {
        if (!parent->text().isEmpty() && !folder_name->text().isEmpty())
            preview->setText(project_caption("New folder: %1\nProject file: project.lmti.sqlite")
                                 .arg(QDir(parent->text()).filePath(folder_name->text())));
        else
            preview->setText(project_caption(
                "Creates a project folder and its metadata. Source files are not created or modified."));
    };
    connect(parent, &QLineEdit::textChanged, &form, update_preview);
    connect(folder_name, &QLineEdit::textChanged, &form, update_preview);
    update_preview();
    form.accept_form(
        [&] { create_project_folder_intent(parent->text(), folder_name->text(), name->text(),
                                            goal->text(), intent); },
        "Create project");
}
void ProjectWindow::create_project_folder(const QString &parent, const QString &folder_name,
                                          const QString &label, const QString &goal) {
    create_project_folder_intent(parent, folder_name, label, goal, capture_library_intent());
}
void ProjectWindow::create_project_folder_intent(const QString &parent, const QString &folder_name,
                                                 const QString &label, const QString &goal,
                                                 const LibraryIntent &intent) {
    auto root = lmti::checked_project_folder(parent);
    if (intent.reviewed && intent.reviewed->entries.size() >= lmti::max_library_entries)
        throw lmti::Error("Library is full. Remove an unused reference before creating a project.");
    const auto reserved = QRegularExpression("^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\..*)?$",
                                             QRegularExpression::CaseInsensitiveOption);
    if (folder_name.isEmpty() || folder_name.size() > 64 || folder_name != folder_name.trimmed() ||
        folder_name == "." || folder_name == ".." || folder_name.compare(".lmti", Qt::CaseInsensitive) == 0 ||
        folder_name.endsWith('.') || folder_name.contains(QRegularExpression("[\\\\/:*?\"<>|\\x00-\\x1f]")) ||
        reserved.match(folder_name).hasMatch())
        throw lmti::Error("Use a simple new folder name without separators or reserved names.");
    lmti::ProjectDocument next;
    next.project = {uid("project"), label.trimmed().toStdString(), goal.trimmed().toStdString(),
                    lmti::Privacy::Internal};
    lmti::validate(next);
    auto folder = QDir(root).filePath(folder_name);
    if (QFileInfo::exists(folder) || QFileInfo(folder).isSymLink() || !QDir(root).mkdir(folder_name))
        throw lmti::Error(
            "This folder already exists or cannot be created. Link an existing folder instead.");
    auto file = QDir(folder).filePath("project.lmti.sqlite");
    next.topology.revision = lmti::save_project(file, next);
    document_ = next;
    saved_ = next;
    path_ = file;
    folder_ = lmti::checked_project_folder(folder);
    active_ = true;
    undo_.clear();
    redo_.clear();
    tabs_->setCurrentIndex(0);
    finish_library_intent(intent);
    refresh();
}
void ProjectWindow::attach_folder_dialog() {
    const auto intent = capture_library_intent();
    auto folder = QFileDialog::getExistingDirectory(this, project_caption("Link an existing project folder"));
    if (folder.isEmpty() || !discard_allowed())
        return;
    try {
        attach_project_folder_intent(folder, intent);
    } catch (const std::exception &e) {
        error(e);
    }
}
void ProjectWindow::attach_project_folder(const QString &folder) {
    attach_project_folder_intent(folder, capture_library_intent());
}
void ProjectWindow::attach_project_folder_intent(const QString &folder, const LibraryIntent &intent) {
    auto canonical = lmti::checked_project_folder(folder);
    if (intent.reviewed)
        for (const auto &entry : intent.reviewed->entries)
            if (!entry.folder.isEmpty() && QDir(entry.folder) == QDir(canonical)) {
                open_project_intent(entry.path, entry.id, intent, canonical);
                return;
            }
    auto metadata = QDir(canonical).filePath("project.lmti.sqlite");
    if (QFileInfo::exists(metadata)) {
        // Strict project reader: linking a folder is not a topology import.
        lmti::load_project(metadata);
        open_project_intent(metadata, {}, intent, canonical);
        refresh_navigation();
        return;
    }
    if (intent.reviewed && intent.reviewed->entries.size() >= lmti::max_library_entries)
        throw lmti::Error("Library is full. Remove an unused reference before linking a new project.");
    lmti::ProjectDocument next;
    next.project = {uid("project"), QFileInfo(canonical).fileName().toStdString(), "",
                    lmti::Privacy::Internal};
    lmti::validate(next);
    auto directory = QDir(QFileInfo(library_path_).absolutePath()).filePath("documents");
    if (!QDir().mkpath(directory))
        throw lmti::Error("Cannot create library document directory.");
    auto file = QDir(directory).filePath(s(next.project.id) + ".sqlite");
    next.topology.revision = lmti::save_project(file, next);
    document_ = next;
    saved_ = next;
    path_ = file;
    folder_ = canonical;
    active_ = true;
    undo_.clear();
    redo_.clear();
    tabs_->setCurrentIndex(0);
    finish_library_intent(intent);
    refresh();
}
void ProjectWindow::open_library_entry(const lmti::LibraryEntry &entry) {
    try {
        const auto displayed = entry;
        const auto intent = review_library_entry(displayed);
        if (discard_allowed())
            open_project_intent(displayed.path, displayed.id, intent);
    } catch (const std::exception &e) {
        error(e);
    }
}
void ProjectWindow::locate_library_entry(const lmti::LibraryEntry &entry) {
    try {
        const auto displayed = entry;
        const auto intent = review_library_entry(displayed);
        const auto file = QFileDialog::getOpenFileName(
            this, project_caption("Choose a file for the same project"), {}, "LMTI (*.sqlite)");
        if (!file.isEmpty() && discard_allowed())
            open_project_intent(file, displayed.id, intent);
    } catch (const std::exception &e) {
        error(e);
    }
}
void ProjectWindow::save_to(const QString &path) {
    save_to_intent(path, capture_library_intent());
}
void ProjectWindow::save_to_intent(const QString &path, const LibraryIntent &intent) {
    if (!active_)
        throw lmti::Error("Open a project first.");
    const bool first_save = path_.isEmpty();
    auto absolute = QFileInfo(path).absoluteFilePath();
    auto next = document_;
    if (absolute != path_) {
        if (next.structure && !path_.isEmpty())
            throw lmti::Error("Copying a structured project requires a registry-preserving owner operation.");
        if (QFileInfo::exists(absolute))
            throw lmti::Error("Save as requires a new file; open existing projects before updating them.");
        next.topology.revision = 0;
    }
    next.topology.revision = lmti::save_project(absolute, next);
    document_ = next;
    saved_ = next;
    path_ = absolute;
    undo_.clear();
    redo_.clear();
    if (first_save)
        finish_library_intent(intent);
    else
        remember();
    refresh();
    statusBar()->showMessage(library_error_.isEmpty()
                                 ? project_caption("Saved · revision %1").arg(document_.topology.revision)
                                 : library_error_);
}
void ProjectWindow::save_file(bool save_as) {
    if (settings_ && settings_->pending() && !settings_->apply()) {
        show_page(ProjectPage::Settings);
        return;
    }
    if (!active_)
        return;
    const auto intent = capture_library_intent();
    auto target = path_;
    if (save_as || target.isEmpty())
        target = QFileDialog::getSaveFileName(this, "Save project to a new SQLite file", {},
                                              "LMTI project (*.sqlite)");
    if (target.isEmpty())
        return;
    if (!target.endsWith(".sqlite", Qt::CaseInsensitive))
        target += ".sqlite";
    try {
        save_to_intent(target, intent);
    } catch (const std::exception &e) {
        error(e);
    }
}
bool ProjectWindow::discard_allowed() {
    if (!active_ || (document_ == saved_ && !(settings_ && settings_->pending())))
        return true;
    auto choice = QMessageBox::question(this, "Unsaved project", "Save changes before continuing?",
                                        QMessageBox::Save | QMessageBox::Discard | QMessageBox::Cancel,
                                        QMessageBox::Save);
    if (choice == QMessageBox::Cancel)
        return false;
    if (choice == QMessageBox::Discard) {
        if (settings_)
            settings_->revert();
        return true;
    }
    save_file(false);
    return document_ == saved_ && !(settings_ && settings_->pending());
}
void ProjectWindow::closeEvent(QCloseEvent *e) {
    if (mcp_panel_ && mcp_panel_->has_pending_write()) {
        statusBar()->showMessage(project_caption("MCP configuration is still being written. Wait for its result before closing."));
        e->ignore();
        return;
    }
    if (discard_allowed())
        e->accept();
    else
        e->ignore();
}
void ProjectWindow::error(const std::exception &e) {
    const auto message = library_outcome_uncertain(e)
        ? project_caption("Library update could not be confirmed. Reopen the library to inspect it before repeating this action.")
        : QString::fromUtf8(e.what());
    if (dynamic_cast<const lmti::LibraryError *>(&e) && active_) {
        // A refused/uncertain root or removal action can reveal that this
        // window's binding is stale. Keep its document, withhold its root.
        folder_.clear();
        library_error_ = message;
        refresh(false, true);
        statusBar()->showMessage(message);
    }
    QMessageBox::warning(this, "LMTI project", message);
}
void ProjectWindow::apply_checked_proposal(const lmti::WorkProposal &p) {
    if (!active_ || path_.isEmpty() || document_ != saved_ || (settings_ && settings_->pending()))
        throw lmti::Error("Save or reopen the project before reviewing a proposal.");
    auto next = lmti::apply_proposal(document_, p);
    update_project([&](auto &d) { d = next; });
}
void ProjectWindow::review_proposal(const lmti::WorkProposal &proposal) {
    if (!active_)
        throw lmti::Error("Open a project before reviewing a proposal.");
    agent_review_->bind(document_, !path_.isEmpty() && document_ == saved_ && !settings_->pending());
    agent_review_->set_proposal(proposal);
    show_page(ProjectPage::Agent);
    agent_tabs_->setCurrentIndex(1);
}
void ProjectWindow::review_file() {
    if (!active_ || path_.isEmpty() || document_ != saved_ || settings_->pending()) {
        statusBar()->showMessage(project_caption("Save the project before reviewing a proposal"));
        return;
    }
    auto path = QFileDialog::getOpenFileName(this, "Review work proposal", {}, "LMTI proposal (*.json)");
    if (path.isEmpty())
        return;
    try {
        QFile f(path);
        if (!f.open(QIODevice::ReadOnly))
            throw lmti::Error("Cannot open proposal.");
        auto bytes = f.read(4097);
        if (bytes.size() > 4096)
            throw lmti::Error("Proposal size limit exceeded.");
        QJsonParseError parse;
        auto json = QJsonDocument::fromJson(bytes, &parse);
        if (parse.error != QJsonParseError::NoError || !json.isObject())
            throw lmti::Error("Invalid proposal JSON.");
        auto proposal = lmti::parse_work_proposal(json.object());
        review_proposal(proposal);
    } catch (const std::exception &e) {
        error(e);
    }
}
void ProjectWindow::edit_entity(const QString &kind, const std::string &id, lmti::WorkKind work_kind) {
    if (!active_)
        return;
    try {
        Form f(this, id.empty() ? "Add " + kind : "Edit " + kind);
        QComboBox *privacy = nullptr;
        if (kind == "project") {
            auto r = document_.project;
            auto title = f.text("Name", r.label);
            auto goal = f.text("Goal", r.goal, 512);
            f.privacy(r.privacy, privacy);
            f.accept_form([&] {
                r.label = value(title);
                r.goal = value(goal);
                r.privacy = lmti::parse_privacy(value(privacy));
                update_project([&](auto &d) { d.project = r; });
            });
        } else if (kind == "device") {
            auto r = selected(document_.topology.assets, id, "device");
            if (id.empty()) {
                r.site = "project-local";
                r.x = document_.topology.assets.size() * 30;
                r.y = r.x;
            }
            auto title = f.text("Name", r.label);
            auto site = f.text("Site", r.site, 64);
            auto type =
                f.choice("Kind", {"machine", "gateway", "broker", "service", "sensor"}, lmti::name(r.kind));
            auto enabled = f.checkbox("Desired enabled", r.enabled);
            f.privacy(r.privacy, privacy);
            f.accept_form([&] {
                r.label = value(title);
                r.site = value(site);
                r.kind = lmti::parse_kind(value(type));
                r.enabled = enabled->isChecked();
                r.privacy = lmti::parse_privacy(value(privacy));
                update_project([&](auto &d) { upsert(d.topology.assets, r); });
            });
        } else if (kind == "repository") {
            auto r = selected(document_.repositories, id, "repo");
            auto title = f.text("Alias", r.label);
            auto locator = f.text("Locator", r.locator, 512);
            f.privacy(r.privacy, privacy);
            f.accept_form([&] {
                r.label = value(title);
                r.locator = value(locator);
                r.privacy = lmti::parse_privacy(value(privacy));
                update_project([&](auto &d) { upsert(d.repositories, r); });
            });
        } else if (kind == "component") {
            auto r = selected(document_.components, id, "component");
            auto title = f.text("Name", r.label);
            auto type = f.choice("Kind", {"firmware", "gateway", "backend", "desktop", "driver", "library"},
                                 lmti::name(r.kind));
            auto repo = f.reference("Repository", document_.repositories, r.repository_id);
            f.privacy(r.privacy, privacy);
            f.accept_form([&] {
                r.label = value(title);
                r.kind = lmti::component_kind(value(type));
                r.repository_id = reference(repo);
                r.privacy = lmti::parse_privacy(value(privacy));
                update_project([&](auto &d) { upsert(d.components, r); });
            });
        } else if (kind == "target") {
            auto r = selected(document_.targets, id, "target");
            auto title = f.text("Board / model", r.label);
            auto revision = f.text("Hardware revision", r.hardware_revision, 64);
            auto architecture = f.text("Architecture", r.architecture, 64);
            f.privacy(r.privacy, privacy);
            f.accept_form([&] {
                r.label = value(title);
                r.hardware_revision = value(revision);
                r.architecture = value(architecture);
                r.privacy = lmti::parse_privacy(value(privacy));
                update_project([&](auto &d) { upsert(d.targets, r); });
            });
        } else if (kind == "release") {
            if (document_.components.empty())
                throw lmti::Error("Add a software component before creating a release.");
            auto r = selected(document_.releases, id, "release");
            if (id.empty() && create_kind_ == "component")
                r.component_id = create_id_.toStdString();
            if (id.empty() && create_kind_ == "release") {
                auto base = selected(document_.releases, create_id_.toStdString(), "release");
                r.component_id = base.component_id;
                r.target_id = base.target_id;
            }
            if (r.state == lmti::ReleaseState::Approved)
                throw lmti::Error("Approved releases are immutable. Create a new release for changes.");
            auto title = f.text("Version", r.label, 64);
            auto component = f.reference("Component", document_.components, r.component_id, true);
            auto target = f.reference("Target", document_.targets, r.target_id);
            auto revision = f.text("Source revision", r.source_revision, 128);
            auto state =
                f.choice("Review state", {"draft", "candidate", "approved", "archived"}, lmti::name(r.state));
            f.privacy(r.privacy, privacy);
            const auto accepted = f.accept_form([&] {
                r.label = value(title);
                r.component_id = reference(component);
                r.target_id = reference(target);
                r.source_revision = value(revision);
                r.state = lmti::release_state(value(state));
                r.privacy = lmti::parse_privacy(value(privacy));
                update_project([&](auto &d) { upsert(d.releases, r); });
            });
            if (accepted && id.empty())
                open_entity("release", s(r.id));
        } else if (kind == "binding") {
            if (document_.topology.assets.empty() || document_.releases.empty())
                throw lmti::Error("Add a device in Architecture and a software release before binding them.");
            auto r = selected(document_.bindings, id, "binding");
            if (id.empty() && create_kind_ == "device")
                r.asset_id = create_id_.toStdString();
            if (id.empty() && create_kind_ == "release")
                r.release_id = create_id_.toStdString();
            auto choices = document_.releases;
            if (id.empty() && create_kind_ == "component")
                std::erase_if(choices,
                              [&](const auto &v) { return v.component_id != create_id_.toStdString(); });
            if (choices.empty())
                throw lmti::Error("Create a release for this component first.");
            auto asset = f.reference("Device", document_.topology.assets, r.asset_id, true);
            auto release = f.reference("Desired release", choices, r.release_id, true);
            f.check(asset, [&, asset, release] {
                const auto component =
                    selected(document_.releases, reference(release), "release").component_id;
                for (const auto &binding : document_.bindings)
                    if (binding.id != r.id && binding.asset_id == reference(asset) &&
                        binding.component_id == component)
                        return project_caption("This device already has a binding for this component.");
                return QString{};
            });
            for (int i = 0; i < release->count(); ++i) {
                auto rid = release->itemData(i).toString().toStdString();
                auto selected_release = selected(document_.releases, rid, "release");
                release->setItemText(i, label(document_.components, selected_release.component_id) + " · " +
                                            s(selected_release.label));
            }
            f.privacy(r.privacy, privacy);
            f.accept_form([&] {
                r.asset_id = reference(asset);
                r.release_id = reference(release);
                auto selected_release = selected(document_.releases, r.release_id, "release");
                r.component_id = selected_release.component_id;
                r.target_id = selected_release.target_id;
                r.privacy = lmti::parse_privacy(value(privacy));
                update_project([&](auto &d) { upsert(d.bindings, r); });
            });
        } else if (kind == "dependency") {
            if (document_.components.size() < 2)
                throw lmti::Error("Add two components before declaring a dependency.");
            auto r = selected(document_.dependencies, id, "dependency");
            auto from = f.reference("Source", document_.components, r.from, true);
            auto to = f.reference("Target", document_.components, r.to, true);
            if (id.empty())
                to->setCurrentIndex(1);
            auto contract = f.text("Interface / contract", r.contract);
            f.check(to, [from, to] {
                return reference(from) == reference(to)
                           ? project_caption("A component cannot depend on itself.")
                           : QString{};
            });
            f.privacy(r.privacy, privacy);
            f.accept_form([&] {
                r.from = reference(from);
                r.to = reference(to);
                r.contract = value(contract);
                r.privacy = lmti::parse_privacy(value(privacy));
                update_project([&](auto &d) { upsert(d.dependencies, r); });
            });
        } else if (kind == "milestone") {
            auto r = selected(document_.milestones, id, "milestone");
            auto title = f.text("Name", r.label);
            auto criteria = f.text("Acceptance criteria", r.criteria, 512);
            auto due = f.text("Due date", r.due_date, 10);
            auto accepted = f.checkbox("Operator accepts milestone", r.accepted);
            auto evidence = f.text("Acceptance evidence", r.evidence, 512);
            f.check(evidence, [accepted, evidence] {
                return accepted->isChecked() && value(evidence).empty()
                           ? project_caption("Acceptance requires evidence.")
                           : QString{};
            });
            f.check(accepted, [&, accepted] {
                if (!accepted->isChecked())
                    return QString{};
                bool found = false;
                for (const auto &work : document_.work)
                    if (work.milestone_id == r.id) {
                        found = true;
                        if (work.state != lmti::WorkState::Done)
                            return project_caption("Complete linked work before accepting this milestone.");
                    }
                return found ? QString{}
                             : project_caption("Link completed work before accepting this milestone.");
            });
            due->setPlaceholderText("YYYY-MM-DD (optional)");
            f.privacy(r.privacy, privacy);
            f.accept_form([&] {
                r.label = value(title);
                r.criteria = value(criteria);
                r.due_date = value(due);
                r.accepted = accepted->isChecked();
                r.evidence = value(evidence);
                r.privacy = lmti::parse_privacy(value(privacy));
                update_project([&](auto &d) { upsert(d.milestones, r); });
            });
        } else if (kind == "work") {
            auto r = selected(document_.work, id, "work");
            if (id.empty())
                r.kind = work_kind;
            if (id.empty() && !create_id_.isEmpty()) {
                r.kind = lmti::WorkKind::Validation;
                if (create_kind_ == "component")
                    r.component_id = create_id_.toStdString();
                if (create_kind_ == "device")
                    r.asset_id = create_id_.toStdString();
                if (create_kind_ == "release") {
                    r.release_id = create_id_.toStdString();
                    r.component_id = selected(document_.releases, r.release_id, "release").component_id;
                }
                if (create_kind_ == "binding") {
                    const auto binding = selected(document_.bindings, create_id_.toStdString(), "binding");
                    r.component_id = binding.component_id;
                    r.asset_id = binding.asset_id;
                    r.release_id = binding.release_id;
                }
            }
            auto title = f.text("Title", r.label);
            auto type = f.choice("Kind", {"task", "bug", "integration", "validation"}, lmti::name(r.kind));
            auto state =
                f.choice("State", {"todo", "in-progress", "review", "done", "blocked"}, lmti::name(r.state));
            auto component = f.reference("Component", document_.components, r.component_id);
            auto asset = f.reference("Device", document_.topology.assets, r.asset_id);
            auto release = f.reference("Release", document_.releases, r.release_id);
            auto milestone = f.reference("Milestone", document_.milestones, r.milestone_id);
            auto checklist = f.text("Checklist / completion", r.checklist, 512);
            auto evidence = f.text("Evidence reference", r.evidence, 512);
            f.check(checklist, [state, checklist] {
                return value(state) == "done" && value(checklist).empty()
                           ? project_caption("Done requires a completed checklist.")
                           : QString{};
            });
            f.check(evidence, [state, type, evidence] {
                return value(state) == "done" && value(type) == "validation" && value(evidence).empty()
                           ? project_caption("Validation Done requires evidence.")
                           : QString{};
            });
            f.check(release, [&, release, component] {
                const auto rid = reference(release);
                if (!rid.empty() &&
                    selected(document_.releases, rid, "release").component_id != reference(component))
                    return project_caption("Choose the component belonging to this release.");
                return QString{};
            });
            f.privacy(r.privacy, privacy);
            const auto accepted = f.accept_form([&] {
                r.label = value(title);
                r.kind = lmti::work_kind(value(type));
                r.state = lmti::work_state(value(state));
                r.component_id = reference(component);
                r.asset_id = reference(asset);
                r.release_id = reference(release);
                r.milestone_id = reference(milestone);
                r.checklist = value(checklist);
                r.evidence = value(evidence);
                r.privacy = lmti::parse_privacy(value(privacy));
                update_project([&](auto &d) { upsert(d.work, r); });
            });
            if (accepted && id.empty())
                open_entity("work", s(r.id));
        } else if (kind == "verification") {
            if (document_.releases.empty())
                throw lmti::Error("Add a release before attaching verification evidence.");
            auto r = selected(document_.verification, id, "evidence");
            if (id.empty() && create_kind_ == "release")
                r.release_id = create_id_.toStdString();
            if (id.empty() && create_kind_ == "device")
                r.asset_id = create_id_.toStdString();
            auto release = f.reference("Release", document_.releases, r.release_id, true);
            auto asset = f.reference("Device", document_.topology.assets, r.asset_id);
            auto evidence = f.text("Evidence reference", r.evidence, 512);
            f.check(evidence, [evidence] {
                return value(evidence).empty() ? project_caption("This field is required.") : QString{};
            });
            auto source = f.text("Source", r.source.empty() ? "operator" : r.source);
            auto result = f.choice("Result", {"operator-declared", "passed", "failed"}, lmti::name(r.result));
            f.privacy(r.privacy, privacy);
            f.accept_form([&] {
                r.release_id = reference(release);
                r.asset_id = reference(asset);
                r.evidence = value(evidence);
                r.source = value(source);
                r.result = lmti::evidence_result(value(result));
                if (r.at == 0)
                    r.at = QDateTime::currentSecsSinceEpoch();
                r.privacy = lmti::parse_privacy(value(privacy));
                update_project([&](auto &d) { upsert(d.verification, r); });
            });
        } else if (kind == "knowledge") {
            auto r = selected(document_.knowledge, id, "knowledge");
            auto title = f.text("Label", r.label);
            auto component = f.reference("Component", document_.components, r.component_id);
            auto ref = f.text("Local reference", r.reference, 256);
            auto hash = f.text("Fingerprint", r.fingerprint, 128);
            f.privacy(r.privacy, privacy);
            f.accept_form([&] {
                r.label = value(title);
                r.component_id = reference(component);
                r.reference = value(ref);
                r.fingerprint = value(hash);
                r.privacy = lmti::parse_privacy(value(privacy));
                update_project([&](auto &d) { upsert(d.knowledge, r); });
            });
        }
    } catch (const std::exception &e) {
        error(e);
    }
}
void ProjectWindow::remove_entity(const QString &kind, const std::string &id) {
    if (!active_ || id.empty())
        return;
    if (QMessageBox::question(
            this, "Remove record", "Remove the selected record? Existing references must be removed first.",
            QMessageBox::Yes | QMessageBox::Cancel, QMessageBox::Cancel) != QMessageBox::Yes)
        return;
    try {
        update_project([&](auto &d) {
            auto remove = [&](auto &rows) { std::erase_if(rows, [&](const auto &r) { return r.id == id; }); };
            if (kind == "repository")
                remove(d.repositories);
            else if (kind == "component")
                remove(d.components);
            else if (kind == "target")
                remove(d.targets);
            else if (kind == "release")
                remove(d.releases);
            else if (kind == "binding")
                remove(d.bindings);
            else if (kind == "dependency")
                remove(d.dependencies);
            else if (kind == "verification")
                remove(d.verification);
            else if (kind == "milestone")
                remove(d.milestones);
            else if (kind == "work")
                remove(d.work);
            else if (kind == "knowledge")
                remove(d.knowledge);
        });
    } catch (const std::exception &e) {
        error(e);
    }
}
