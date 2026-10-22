#include "project_library_view.hpp"
#include "project_captions.hpp"
#include "studio_widgets.hpp"
#include "toolbar_icons.hpp"
#include <QApplication>
#include <QDateTime>
#include <QDesktopServices>
#include <QDir>
#include <QEvent>
#include <QFileInfo>
#include <QFrame>
#include <QLocale>
#include <QMenu>
#include <QTimer>
#include <QToolButton>
#include <QUrl>
#include <QVBoxLayout>
#include <algorithm>

namespace {
constexpr int project_path_role = Qt::UserRole + 1;
// Keep the native item model (including selection and accessibility), while
// separating the project name from its real local file path visually.
class ProjectNameDelegate final : public QStyledItemDelegate {
    const QIcon icon_ = studio::toolbar_icon(studio::ToolbarIcon::Open, true);

  public:
    explicit ProjectNameDelegate(QObject *parent) : QStyledItemDelegate(parent) {}
    QSize sizeHint(const QStyleOptionViewItem &, const QModelIndex &) const override {
        return {220, 64};
    }
    void paint(QPainter *painter, const QStyleOptionViewItem &option,
               const QModelIndex &index) const override {
        auto base = option;
        initStyleOption(&base, index);
        base.text.clear();
        base.icon = {};
        const auto style = base.widget ? base.widget->style() : QApplication::style();
        style->drawControl(QStyle::CE_ItemViewItem, &base, painter, base.widget);
        painter->save();
        painter->setClipRect(option.rect);
        const auto icon_rect = QRect(option.rect.left() + 10, option.rect.center().y() - 12, 24, 24);
        icon_.paint(painter, icon_rect);
        const auto bounds = option.rect.adjusted(44, 10, -12, -10);
        auto font = option.font;
        font.setWeight(QFont::DemiBold);
        painter->setFont(font);
        painter->setPen(QColor("#202a3a"));
        painter->drawText(QRect(bounds.left(), bounds.top(), bounds.width(), 22),
                          Qt::AlignLeft | Qt::AlignVCenter,
                          QFontMetrics(font).elidedText(index.data().toString(), Qt::ElideRight,
                                                        std::max(0, bounds.width())));
        font.setWeight(QFont::Normal);
        font.setPixelSize(12);
        painter->setFont(font);
        painter->setPen(QColor("#64748b"));
        painter->drawText(QRect(bounds.left(), bounds.top() + 23, bounds.width(), 18),
                          Qt::AlignLeft | Qt::AlignVCenter,
                          QFontMetrics(font).elidedText(index.data(project_path_role).toString(),
                                                        Qt::ElideMiddle, std::max(0, bounds.width())));
        painter->restore();
    }
};
class ProjectPinButton final : public QToolButton {
    const bool pinned_;

  public:
    explicit ProjectPinButton(bool pinned) : pinned_(pinned) {
        setProperty("libraryPin", true);
        setProperty("pinned", pinned);
    }

  protected:
    void paintEvent(QPaintEvent *event) override {
        QToolButton::paintEvent(event);
        QPainter painter(this);
        painter.setRenderHint(QPainter::Antialiasing);
        painter.translate(rect().center());
        const auto color = QColor(pinned_ ? "#2452d5" : "#64748b");
        painter.setPen(QPen(color, 1.5, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
        painter.setBrush(pinned_ ? QBrush(color) : QBrush(Qt::NoBrush));
        QPainterPath star;
        star.moveTo(0, -8);
        for (const auto point :
             {QPointF(2.3, -2.5), QPointF(8, -2.5), QPointF(3.4, 1.2), QPointF(5, 7), QPointF(0, 3.7),
              QPointF(-5, 7), QPointF(-3.4, 1.2), QPointF(-8, -2.5), QPointF(-2.3, -2.5)})
            star.lineTo(point);
        star.closeSubpath();
        painter.drawPath(star);
    }
};
class ProjectPathLabel final : public QLabel {
  public:
    explicit ProjectPathLabel(const QString &path) : QLabel(path) {
        setObjectName("folderPath");
        setProperty("verbatim", true);
        setTextFormat(Qt::PlainText);
        setToolTip(path);
        setMinimumWidth(0);
        setSizePolicy(QSizePolicy::Ignored, QSizePolicy::Fixed);
    }

  protected:
    void paintEvent(QPaintEvent *) override {
        QPainter painter(this);
        painter.setPen(palette().color(QPalette::WindowText));
        painter.setFont(font());
        painter.drawText(contentsRect(), Qt::AlignLeft | Qt::AlignVCenter,
                         fontMetrics().elidedText(text(), Qt::ElideMiddle, contentsRect().width()));
    }
};
struct Availability {
    bool file, folder;
    QString caption;
};
Availability availability(const lmti::LibraryEntry &entry) {
    const QFileInfo file(entry.path), folder(entry.folder);
    const bool file_available = !file.isSymLink() && file.isFile() && file.isReadable();
    const bool folder_available = entry.folder.isEmpty() || (!folder.isSymLink() && folder.isDir());
    const auto caption =
        !file_available ? (!file.exists() && !file.isSymLink() ? "File missing" : "File unavailable")
        : !folder_available
            ? (!folder.exists() && !folder.isSymLink() ? "Folder missing" : "Folder unavailable")
            : "Available locally";
    return {file_available, folder_available, project_caption(caption)};
}
void clear_widget_names(QWidget *widget) {
    if (!widget)
        return;
    widget->setObjectName({});
    for (auto child : widget->findChildren<QObject *>())
        child->setObjectName({});
}
QLabel *text(const QString &value, const QString &name = {}) {
    const bool verbatim = name == "cardTitle" || name == "folderPath";
    auto label = new QLabel(verbatim ? value : project_text(value));
    label->setProperty("verbatim", verbatim);
    label->setTextFormat(Qt::PlainText);
    label->setWordWrap(true);
    label->setSizePolicy(QSizePolicy::Preferred, QSizePolicy::Minimum);
    label->setObjectName(name);
    return label;
}
void fit_empty_state(QFrame *empty, QScrollArea *scroll, QStackedWidget *views) {
    empty->setFixedWidth(std::min(780, std::max(260, scroll->viewport()->width() - 8)));
    empty->setMinimumHeight(0);
    const auto height = std::max(200, empty->heightForWidth(empty->width()));
    empty->setMinimumHeight(height);
    // Keep the next action beside the explanation instead of reserving an
    // entire empty viewport. Longer translated copy can still scroll.
    views->setMaximumHeight(std::min(420, height + 8));
}
} // namespace
ProjectLibraryView::ProjectLibraryView(QWidget *parent) : QWidget(parent) {
    setObjectName("projectLibrary");
    auto layout = new QVBoxLayout(this);
    layout->setContentsMargins(28, 26, 28, 20);
    layout->setSpacing(16);
    auto title_row = new QHBoxLayout;
    title_row->setSpacing(10);
    auto title = new QVBoxLayout;
    title->setSpacing(6);
    title->addWidget(text("Thư viện dự án", "pageTitle"));
    title->addWidget(text("Một nơi để tìm và mở các dự án trên máy của bạn.", "muted"));
    title_row->addLayout(title, 1);
    auto create = new QPushButton("+ Tạo dự án");
    create->setObjectName("createProjectButton");
    create->setProperty("primary", true);
    connect(create, &QPushButton::clicked, this, [this] {
        if (create_project)
            create_project();
    });
    auto attach = new QPushButton("Liên kết thư mục");
    attach->setObjectName("attachProjectFolder");
    attach->setIcon(studio::toolbar_icon(studio::ToolbarIcon::Open, true));
    connect(attach, &QPushButton::clicked, this, [this] {
        if (attach_folder)
            attach_folder();
    });
    title_row->addWidget(create);
    attach->setParent(this);
    attach->hide();
    layout->addLayout(title_row);
    search_ = new QLineEdit;
    search_->setObjectName("librarySearch");
    search_->setPlaceholderText("Tìm theo tên dự án hoặc thư mục…");
    search_->setClearButtonEnabled(true);
    search_->setAccessibleName("Tìm dự án trong thư viện");
    connect(search_, &QLineEdit::textChanged, this, [this] {
        page_ = 0;
        rebuild();
    });
    controls_ = studio::panel({}, nullptr, true);
    controls_->setObjectName("libraryControls");
    controls_->installEventFilter(this);
    controls_row_ = new QBoxLayout(QBoxLayout::LeftToRight);
    controls_row_->setSpacing(12);
    qobject_cast<QVBoxLayout *>(controls_->layout())->addLayout(controls_row_);
    auto filters = new QWidget;
    filters->setProperty("libraryActions", true);
    auto filter_row = new QHBoxLayout(filters);
    filter_row->setContentsMargins(0, 0, 0, 0);
    filter_row->setSpacing(8);
    filters_ = new QButtonGroup(this);
    const QStringList names{"Tất cả", "Đã ghim", "Gần đây"};
    for (int i = 0; i < names.size(); ++i) {
        auto b = new QPushButton(names[i]);
        b->setObjectName("libraryFilter" + QString::number(i));
        b->setCheckable(true);
        b->setProperty("filter", true);
        filters_->addButton(b, i);
        filter_row->addWidget(b);
    }
    filters_->button(0)->setChecked(true);
    connect(filters_, &QButtonGroup::idClicked, this, [this] {
        page_ = 0;
        rebuild();
    });
    count_ = text({}, "muted");
    count_->setWordWrap(false);
    filter_row->addWidget(count_);
    filter_row->addStretch();
    controls_row_->addWidget(filters);
    auto tools = new QWidget;
    tools->setProperty("libraryActions", true);
    auto tools_row = new QHBoxLayout(tools);
    tools_row->setContentsMargins(0, 0, 0, 0);
    tools_row->setSpacing(8);
    tools_row->addWidget(search_, 1);
    search_->setMinimumWidth(150);
    search_->setMaximumWidth(300);
    mode_ = new studio::Choice;
    mode_->setObjectName("libraryViewMode");
    mode_->addItems({"Cards", "List"});
    mode_->setCurrentIndex(1);
    mode_->setProperty("uiChoices", QStringList{"Cards", "List"});
    sort_ = new studio::Choice;
    sort_->setObjectName("librarySort");
    sort_->addItems({"Last opened", "Name A–Z"});
    sort_->setProperty("uiChoices", QStringList{"Last opened", "Name A–Z"});
    mode_->setParent(this);
    mode_segments_ = studio::segments(mode_, "libraryViewSegments", {1, 0});
    tools_row->addWidget(mode_segments_);
    tools_row->addWidget(sort_);
    controls_row_->addWidget(tools, 1);
    connect(mode_, &QComboBox::currentIndexChanged, this, [this] { rebuild(); });
    connect(sort_, &QComboBox::currentIndexChanged, this, [this] {
        page_ = 0;
        rebuild();
    });
    layout->addWidget(controls_);
    notice_ = text({}, "libraryNotice");
    notice_->hide();
    layout->addWidget(notice_);
    scroll_ = new QScrollArea;
    scroll_->setObjectName("libraryScroll");
    scroll_->setWidgetResizable(true);
    scroll_->setFrameShape(QFrame::NoFrame);
    auto cards = new QWidget;
    cards->setObjectName("libraryCards");
    grid_ = new QGridLayout(cards);
    grid_->setContentsMargins(0, 0, 0, 0);
    grid_->setSpacing(16);
    grid_->setAlignment(Qt::AlignTop);
    scroll_->setWidget(cards);
    scroll_->viewport()->installEventFilter(this);
    views_ = new QStackedWidget;
    views_->setObjectName("libraryViews");
    views_->addWidget(scroll_);
    list_ = new QTreeWidget;
    list_->setObjectName("libraryList");
    list_->setHeaderLabels({"", "Project", "Folder", "Last opened", "Availability", ""});
    studio::inventory(list_);
    list_->setItemDelegateForColumn(1, new ProjectNameDelegate(list_));
    list_->header()->setSectionResizeMode(QHeaderView::ResizeToContents);
    list_->header()->setSectionResizeMode(1, QHeaderView::Stretch);
    list_->header()->setSectionResizeMode(5, QHeaderView::Fixed);
    list_->header()->setStretchLastSection(false);
    list_->header()->setSectionResizeMode(0, QHeaderView::Fixed);
    list_->header()->setSectionResizeMode(4, QHeaderView::Fixed);
    list_->header()->setMinimumSectionSize(38);
    list_->setColumnWidth(0, 42);
    list_->setColumnWidth(4, 155);
    list_->setColumnWidth(5, 170);
    list_->viewport()->installEventFilter(this);
    views_->addWidget(list_);
    layout->addWidget(views_, 1);
    auto pagination = new QHBoxLayout;
    previous_ = new QPushButton("← Trước");
    next_ = new QPushButton("Sau →");
    previous_->setObjectName("libraryPrevious");
    next_->setObjectName("libraryNext");
    page_label_ = text({}, "muted");
    connect(previous_, &QPushButton::clicked, this, [this] {
        --page_;
        rebuild();
    });
    connect(next_, &QPushButton::clicked, this, [this] {
        ++page_;
        rebuild();
    });
    pagination->addStretch();
    pagination->addWidget(previous_);
    pagination->addWidget(page_label_);
    pagination->addWidget(next_);
    pagination->addStretch();
    layout->addLayout(pagination);
    auto import = new QPushButton("Mở file dự án…");
    import->setObjectName("openProjectFileButton");
    import->setIcon(studio::toolbar_icon(studio::ToolbarIcon::New, true));
    connect(import, &QPushButton::clicked, this, [this] {
        if (import_file)
            import_file();
    });
    auto demo = new QPushButton("Khám phá dự án mẫu");
    demo->setObjectName("openProjectDemo");
    connect(demo, &QPushButton::clicked, this, [this] {
        if (open_demo)
            open_demo();
    });
    import->setParent(this);
    import->hide();
    auto options = new QToolButton;
    options->setObjectName("libraryProjectOptions");
    options->setText(QString::fromUtf8("⋯"));
    options->setProperty("more", true);
    options->setAccessibleName(project_caption("Project options"));
    options->setProperty("uiAccessibleName", "Project options");
    options->setPopupMode(QToolButton::InstantPopup);
    auto options_menu = new QMenu(options);
    auto attach_action = options_menu->addAction(project_caption("Link folder"), attach, &QPushButton::click);
    attach_action->setProperty("uiCaption", "Link folder");
    auto import_action =
        options_menu->addAction(project_caption("Open project file…"), import, &QPushButton::click);
    import_action->setProperty("uiCaption", "Open project file…");
    options->setMenu(options_menu);
    title_row->addWidget(options);
    starter_ = studio::panel({});
    starter_->setObjectName("libraryStarter");
    auto starter_layout = qobject_cast<QVBoxLayout *>(starter_->layout());
    auto starter_row = new QHBoxLayout;
    starter_row->setSpacing(16);
    auto starter_icon = new QLabel;
    starter_icon->setPixmap(studio::toolbar_icon(studio::ToolbarIcon::Knowledge, true).pixmap(28, 28));
    starter_icon->setFixedSize(32, 32);
    starter_row->addWidget(starter_icon);
    auto starter_copy = new QVBoxLayout;
    starter_copy->setSpacing(4);
    starter_copy->addWidget(text("New to LMTI?", "sectionTitle"));
    starter_copy->addWidget(
        text("Explore a sample project to see software, hardware and work together.", "muted"));
    starter_row->addLayout(starter_copy, 1);
    starter_row->addWidget(demo);
    starter_layout->addLayout(starter_row);
    layout->addWidget(starter_);
    layout->addStretch();
    rebuild();
}
void ProjectLibraryView::set_entries(std::vector<lmti::LibraryEntry> entries) {
    entries_ = std::move(entries);
    notice_->hide();
    rebuild();
}
void ProjectLibraryView::set_error(const QString &message) {
    notice_->setText(message);
    notice_->show();
}
void ProjectLibraryView::open_folder(const QString &path) {
    try {
        if (QFileInfo(path).isSymLink())
            throw lmti::Error("Choose a local folder, not a symbolic link.");
        const auto checked = lmti::checked_project_folder(path);
        QDesktopServices::openUrl(QUrl::fromLocalFile(checked));
    } catch (const std::exception &exception) {
        set_error(project_caption("Folder unavailable: %1").arg(QString::fromUtf8(exception.what())));
        rebuild();
    }
}
bool ProjectLibraryView::eventFilter(QObject *object, QEvent *event) {
    if (event->type() == QEvent::Resize && object == controls_) {
        const auto direction = controls_->width() < 980 ? QBoxLayout::TopToBottom : QBoxLayout::LeftToRight;
        if (controls_row_->direction() != direction)
            controls_row_->setDirection(direction);
    }
    if (event->type() == QEvent::Resize && list_ && object == list_->viewport())
        list_->setColumnHidden(2, width() < 1000);
    if (event->type() == QEvent::Resize && scroll_ && object == scroll_->viewport()) {
        if (auto empty = findChild<QFrame *>("libraryEmpty"))
            fit_empty_state(empty, scroll_, views_);
        auto columns = std::clamp((scroll_->viewport()->width() + 16) / 316, 1, 3);
        if (columns != columns_) {
            columns_ = columns;
            QTimer::singleShot(0, this, [this] { rebuild(); });
        }
    }
    return QWidget::eventFilter(object, event);
}
void ProjectLibraryView::rebuild() {
    for (int index = 0; index < list_->topLevelItemCount(); ++index)
        for (const auto column : {0, 5})
            clear_widget_names(list_->itemWidget(list_->topLevelItem(index), column));
    list_->clear();
    const bool has_projects = !entries_.empty();
    controls_->setVisible(has_projects);
    starter_->setMaximumWidth(has_projects ? QWIDGETSIZE_MAX : 780);
    search_->setVisible(has_projects);
    for (auto button : filters_->buttons())
        button->setVisible(has_projects);
    mode_segments_->setVisible(has_projects);
    sort_->setVisible(has_projects);
    count_->setVisible(has_projects);
    while (auto item = grid_->takeAt(0)) {
        if (auto widget = item->widget()) {
            widget->hide();
            clear_widget_names(widget);
            widget->deleteLater();
        }
        delete item;
    }
    // Reset obsolete column stretch when the viewport becomes narrower.
    const int columns = mode_->currentIndex() == 1 ? 1 : columns_;
    for (int i = 0; i < 3; ++i)
        grid_->setColumnStretch(i, i < columns ? 1 : 0);
    auto entries = entries_;
    std::stable_sort(entries.begin(), entries.end(), [this](const auto &a, const auto &b) {
        if (filters_->checkedId() != 2 && sort_->currentIndex() == 1)
            return QString::compare(a.label, b.label, Qt::CaseInsensitive) < 0;
        return a.opened == b.opened ? a.id < b.id : a.opened > b.opened;
    });
    entries.erase(std::remove_if(entries.begin(), entries.end(),
                                 [this](const auto &e) {
                                     auto search = search_->text().trimmed();
                                     return (filters_->checkedId() == 1 && !e.pinned) ||
                                            (!e.label.contains(search, Qt::CaseInsensitive) &&
                                             !e.folder.contains(search, Qt::CaseInsensitive) &&
                                             !e.path.contains(search, Qt::CaseInsensitive));
                                 }),
                  entries.end());
    if (filters_->checkedId() == 2 && entries.size() > 12)
        entries.resize(12);
    count_->setText(project_text("%1 dự án").arg(entries.size()));
    constexpr int per_page = 24;
    const int pages = std::max(1, (static_cast<int>(entries.size()) + per_page - 1) / per_page);
    page_ = std::clamp(page_, 0, pages - 1);
    previous_->setEnabled(page_ > 0);
    next_->setEnabled(page_ + 1 < pages);
    previous_->setVisible(pages > 1);
    next_->setVisible(pages > 1);
    page_label_->setVisible(pages > 1);
    page_label_->setText(QString::number(page_ + 1) + " / " + QString::number(pages));
    if (entries.empty()) {
        views_->setMaximumHeight(QWIDGETSIZE_MAX);
        scroll_->setMaximumHeight(QWIDGETSIZE_MAX);
        views_->setCurrentIndex(0);
        auto empty = new QFrame;
        empty->setObjectName("libraryEmpty");
        empty->setMaximumWidth(780);
        auto l = new QVBoxLayout(empty);
        l->setContentsMargins(28, 28, 28, 28);
        l->setSpacing(12);
        l->addWidget(
            text(entries_.empty() ? "Dự án của bạn bắt đầu ở đây" : "Không tìm thấy dự án", "sectionTitle"));
        l->addWidget(text(entries_.empty() ? "Tạo một dự án mới hoặc liên kết thư mục đang có.\nPhần mềm, "
                                             "thiết bị và công việc sẽ được quản lý trong từng dự án."
                                           : "Thử tên khác hoặc chuyển về Tất cả.",
                          "muted"));
        if (entries_.empty()) {
            auto actions = new QHBoxLayout;
            actions->setSpacing(10);
            auto create = new QPushButton(project_text("+ Tạo dự án"));
            create->setObjectName("libraryEmptyCreate");
            create->setProperty("primary", true);
            connect(create, &QPushButton::clicked, this, [this] {
                if (create_project)
                    create_project();
            });
            auto attach = new QPushButton(project_text("Liên kết thư mục"));
            attach->setObjectName("libraryEmptyAttach");
            connect(attach, &QPushButton::clicked, this, [this] {
                if (attach_folder)
                    attach_folder();
            });
            actions->addWidget(create);
            actions->addWidget(attach);
            actions->addStretch();
            l->addSpacing(6);
            l->addLayout(actions);
        }
        grid_->addWidget(empty, 0, 0, 1, columns, Qt::AlignLeft | Qt::AlignTop);
        fit_empty_state(empty, scroll_, views_);
        return;
    }
    views_->setCurrentIndex(mode_->currentIndex() == 1 ? 1 : 0);
    if (mode_->currentIndex() == 1) {
        // Reserve the complete translated Locate action, including button padding.
        list_->setColumnWidth(
            5, std::max(170, fontMetrics().horizontalAdvance(project_caption("Locate file")) + 86));
        for (int i = page_ * per_page; i < std::min(static_cast<int>(entries.size()), (page_ + 1) * per_page);
             ++i) {
            const auto entry = entries[i];
            const auto state = availability(entry);
            const bool available = state.file, folder_missing = !state.folder;
            const auto date = entry.opened == 0
                                  ? project_caption("Not recorded")
                                  : QLocale(project_english ? QLocale::English : QLocale::Vietnamese)
                                        .toString(QDateTime::fromMSecsSinceEpoch(entry.opened).toLocalTime(),
                                                  QLocale::ShortFormat);
            auto item =
                new QTreeWidgetItem(list_, {"", entry.label,
                                            entry.folder.isEmpty() ? project_caption("No folder linked")
                                                                   : QFileInfo(entry.folder).fileName(),
                                            date, state.caption, ""});
            item->setData(0, Qt::UserRole, entry.id);
            item->setSizeHint(0, QSize(0, 64));
            item->setData(1, project_path_role, QDir::toNativeSeparators(entry.path));
            item->setToolTip(1, entry.label + "\n" + QDir::toNativeSeparators(entry.path));
            item->setData(1, Qt::AccessibleDescriptionRole, entry.path);
            item->setToolTip(2, entry.folder);
            item->setData(4, studio::badge_role, !available || folder_missing ? "missing" : "available");
            auto pin = new ProjectPinButton(entry.pinned);
            pin->setFixedSize(30, 36);
            pin->setObjectName("pin-" + entry.id);
            pin->setAccessibleName(project_caption(entry.pinned ? "Unpin project" : "Pin project"));
            pin->setToolTip(pin->accessibleName());
            connect(pin, &QToolButton::clicked, this, [this, entry] {
                if (toggle_pin)
                    toggle_pin(entry);
            });
            auto pin_cell = new QWidget;
            pin_cell->setProperty("libraryActions", true);
            auto pin_layout = new QHBoxLayout(pin_cell);
            pin_layout->setContentsMargins(6, 0, 6, 0);
            pin_layout->addWidget(pin, 0, Qt::AlignCenter);
            list_->setItemWidget(item, 0, pin_cell);
            auto actions = new QWidget;
            actions->setProperty("libraryActions", true);
            auto buttons = new QHBoxLayout(actions);
            buttons->setContentsMargins(4, 12, 8, 12);
            buttons->setSpacing(6);
            auto open = new QPushButton(project_caption(available ? "Open" : "Locate file"));
            open->setProperty("libraryOpen", true);
            open->setMinimumWidth(open->fontMetrics().horizontalAdvance(open->text()) + 32);
            open->setObjectName("open-" + entry.id);
            connect(open, &QPushButton::clicked, this, [this, entry, available] {
                if (available) {
                    if (open_project)
                        open_project(entry);
                } else if (locate_project)
                    locate_project(entry);
            });
            buttons->addWidget(open);
            auto more = new QToolButton;
            more->setObjectName("libraryMore-" + entry.id);
            more->setText("⋯");
            more->setProperty("more", true);
            more->setFixedWidth(36);
            more->setAccessibleName(project_caption("Project options"));
            auto menu = new QMenu(more);
            menu->addAction(project_caption("Choose project folder…"), this, [this, entry] {
                if (change_folder)
                    change_folder(entry);
            });
            menu->addAction(project_caption("Locate project file…"), this, [this, entry] {
                if (locate_project)
                    locate_project(entry);
            });
            if (!entry.folder.isEmpty() && !folder_missing)
                menu->addAction(project_caption("Open folder on this computer"), this,
                                [this, entry] { open_folder(entry.folder); });
            menu->addSeparator();
            menu->addAction(project_caption("Remove from library…"), this, [this, entry] {
                if (remove_reference)
                    remove_reference(entry);
            });
            more->setMenu(menu);
            more->setPopupMode(QToolButton::InstantPopup);
            buttons->addWidget(more);
            list_->setItemWidget(item, 5, actions);
        }
        list_->setMaximumHeight(
            std::min(640, list_->topLevelItemCount() * 64 + list_->header()->sizeHint().height() + 4));
        views_->setMaximumHeight(list_->maximumHeight());
        return;
    }
    views_->setMaximumHeight(QWIDGETSIZE_MAX);
    int index = 0;
    for (int i = page_ * per_page; i < std::min(static_cast<int>(entries.size()), (page_ + 1) * per_page);
         ++i) {
        const auto e = entries[i];
        auto card = new QFrame;
        card->setProperty("projectCard", true);
        card->setObjectName("libraryCard-" + e.id);
        card->setMinimumWidth(250);
        auto l = new QVBoxLayout(card);
        l->setContentsMargins(18, 18, 18, 18);
        l->setSpacing(10);
        auto header = new QHBoxLayout;
        header->setSpacing(10);
        auto icon = new QLabel;
        icon->setPixmap(studio::toolbar_icon(studio::ToolbarIcon::Open, true).pixmap(24, 24));
        icon->setFixedSize(28, 28);
        header->addWidget(icon);
        auto name = text(e.label, "cardTitle");
        name->setToolTip(e.label);
        name->setMaximumHeight(52);
        header->addWidget(name, 1);
        auto pin = new ProjectPinButton(e.pinned);
        pin->setFixedSize(30, 34);
        pin->setObjectName("pin-" + e.id);
        pin->setToolTip(project_text(e.pinned ? "Bỏ ghim dự án" : "Ghim dự án"));
        pin->setAccessibleName(pin->toolTip());
        connect(pin, &QToolButton::clicked, this, [this, e] {
            if (toggle_pin)
                toggle_pin(e);
        });
        header->addWidget(pin);
        l->addLayout(header);
        auto folder = new ProjectPathLabel(QDir::toNativeSeparators(e.path));
        l->addWidget(folder);
        const auto availability_state = availability(e);
        const bool available = availability_state.file, folder_missing = !availability_state.folder;
        auto state = text("● " + availability_state.caption, "cardStatus");
        state->setProperty("verbatim", true);
        state->setProperty("warning", !available || folder_missing);
        l->addWidget(state);
        auto opened = text(
            e.opened == 0 ? project_text("Được nhập từ danh sách dự án cũ")
                          : project_text("Mở gần nhất: %1")
                                .arg(QLocale(project_english ? QLocale::English : QLocale::Vietnamese)
                                         .toString(QDateTime::fromMSecsSinceEpoch(e.opened).toLocalTime(),
                                                   QLocale::ShortFormat)),
            "muted");
        l->addWidget(opened);
        l->addStretch();
        auto bottom = new QHBoxLayout;
        auto open = new QPushButton(project_text(available ? "Mở dự án →" : "Chọn lại file…"));
        open->setObjectName("open-" + e.id);
        open->setProperty("libraryOpen", true);
        connect(open, &QPushButton::clicked, this, [this, e, available] {
            if (available) {
                if (open_project)
                    open_project(e);
            } else if (locate_project)
                locate_project(e);
        });
        bottom->addWidget(open, 1);
        auto more = new QToolButton;
        more->setObjectName("libraryMore-" + e.id);
        more->setProperty("more", true);
        more->setFixedSize(32, 32);
        more->setText("⋯");
        more->setAccessibleName(project_text("Tùy chọn dự án"));
        auto menu = new QMenu(more);
        menu->addAction(project_text("Chọn thư mục dự án…"), this, [this, e] {
            if (change_folder)
                change_folder(e);
        });
        menu->addAction(project_text("Chọn lại file dự án…"), this, [this, e] {
            if (locate_project)
                locate_project(e);
        });
        if (!e.folder.isEmpty() && !folder_missing)
            menu->addAction(project_text("Mở thư mục trên máy"), this, [this, e] { open_folder(e.folder); });
        menu->addSeparator();
        menu->addAction(project_text("Gỡ khỏi thư viện…"), this, [this, e] {
            if (remove_reference)
                remove_reference(e);
        });
        more->setMenu(menu);
        more->setPopupMode(QToolButton::InstantPopup);
        bottom->addWidget(more);
        l->addLayout(bottom);
        grid_->addWidget(card, index / columns, index % columns);
        ++index;
    }
}
