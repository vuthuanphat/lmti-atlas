#include "project_captions.hpp"
#include "project_window.hpp"
#include "studio_widgets.hpp"
#include <QDateTime>
#include <QGraphicsItem>
#include <QGridLayout>
#include <QHeaderView>
#include <QMap>
#include <QMouseEvent>
#include <QResizeEvent>
#include <QScrollArea>
#include <QScrollBar>
#include <QShortcut>
#include <QSignalBlocker>
#include <QTimeZone>
#include <QTimer>
#include <QVBoxLayout>
#include <algorithm>

namespace {
constexpr int inspector_page_size = 12;
QString text(const std::string &value) {
    return QString::fromStdString(value);
}
template <class T> QString title(const std::vector<T> &rows, const std::string &id) {
    for (const auto &r : rows)
        if (r.id == id)
            return text(r.label);
    return QString{};
}
QLabel *plain_label(const QString &value = {}) {
    auto label = new QLabel(value);
    label->setTextFormat(Qt::PlainText);
    label->setWordWrap(true);
    label->setProperty("verbatim", true);
    return label;
}
} // namespace

void ProjectWindow::configure_table(const QString &kind, QTreeWidget *tree, QLineEdit *filter, QLabel *count,
                                    QPushButton *edit, QPushButton *remove) {
    table_ui_.push_back({kind, tree, filter, count, edit, remove, {}});
    tree->setSelectionMode(QAbstractItemView::SingleSelection);
    tree->setSortingEnabled(true);
    tree->setUniformRowHeights(true);
    studio::inventory(tree);
    new studio::EmptyTreeState(tree);
    tree->header()->setResizeContentsPrecision(50);
    tree->setAccessibleName(project_caption("Project records"));
    tree->setProperty("uiAccessibleName", "Project records");
    if (edit)
        edit->setEnabled(false);
    if (remove)
        remove->setEnabled(false);
    connect(filter, &QLineEdit::textChanged, this, [this, tree] {
        for (const auto &ui : table_ui_)
            if (ui.tree == tree)
                filter_table(ui);
    });
    connect(tree, &QTreeWidget::itemSelectionChanged, this, [this, kind, tree] {
        if (refreshing_)
            return;
        for (const auto &ui : table_ui_)
            if (ui.tree == tree)
                filter_table(ui);
        if (!tree->selectedItems().empty())
            open_entity(kind, tree->selectedItems().front()->data(0, Qt::UserRole).toString(), false);
    });
    connect(tree, &QTreeWidget::itemClicked, this, [this, kind](QTreeWidgetItem *item, int) {
        if (refreshing_ || !item || !item->isSelected())
            return;
        const auto id = item->data(0, Qt::UserRole).toString();
        if (!inspector_->isVisible() || inspected_kind_ != kind || inspected_id_ != id)
            open_entity(kind, id, false);
    });
    auto enter = new QShortcut(QKeySequence(Qt::Key_Return), tree);
    enter->setContext(Qt::WidgetShortcut);
    connect(enter, &QShortcut::activated, this, [this, kind, tree] {
        if (!tree->selectedItems().empty())
            open_entity(kind, tree->selectedItems().front()->data(0, Qt::UserRole).toString(), false);
    });
}

QComboBox *ProjectWindow::add_table_filter(QTreeWidget *tree, QBoxLayout *layout, const QString &key,
                                           const QString &label) {
    auto choice = new studio::Choice;
    choice->setMinimumWidth(110);
    choice->setMaximumWidth(170);
    choice->addItem(project_caption(label), QString{});
    choice->setAccessibleName(project_caption(label));
    choice->setProperty("uiAccessibleName", label);
    for (auto &ui : table_ui_)
        if (ui.tree == tree) {
            choice->setObjectName(ui.kind + "_" + key + "Choice");
            ui.choices.push_back({key, label, choice});
            break;
        }
    layout->addWidget(choice);
    connect(choice, &QComboBox::currentIndexChanged, this, [this, tree] {
        for (const auto &ui : table_ui_)
            if (ui.tree == tree) {
                filter_table(ui);
                if (ui.kind == "work")
                    filter_work_views();
            }
    });
    return choice;
}

void ProjectWindow::refresh_table_filters(const TableUi &ui) {
    for (const auto &choice : ui.choices) {
        const auto selected = choice.widget->currentData().toString();
        QMap<QString, QString> values;
        for (int i = 0; i < ui.tree->topLevelItemCount(); ++i) {
            const auto fields = ui.tree->topLevelItem(i)->data(0, studio::filter_values_role).toMap();
            const auto value = fields.value(choice.key).toString();
            if (!value.isEmpty()) {
                const auto caption = choice.key == "kind" || choice.key == "state" || choice.key == "result"
                                         ? studio::enum_caption(value)
                                         : fields.value(choice.key + "Label", value).toString();
                values.insert(value, caption);
            }
        }
        QSignalBlocker blocker(choice.widget);
        choice.widget->clear();
        choice.widget->addItem(project_caption(choice.label), QString{});
        for (auto i = values.begin(); i != values.end(); ++i) {
            choice.widget->addItem(i.value(), i.key());
            choice.widget->setItemData(choice.widget->count() - 1, i.key(), Qt::ToolTipRole);
        }
        choice.widget->setCurrentIndex(std::max(0, choice.widget->findData(selected)));
        choice.widget->setEnabled(!values.empty());
    }
}

bool ProjectWindow::matches_table_filters(const TableUi &ui, const QTreeWidgetItem *item) const {
    const auto values = item->data(0, studio::filter_values_role).toMap();
    for (const auto &choice : ui.choices) {
        const auto selected = choice.widget->currentData().toString();
        if (!selected.isEmpty() && values.value(choice.key).toString() != selected)
            return false;
    }
    return true;
}

void ProjectWindow::filter_table(const TableUi &ui) {
    QSignalBlocker blocker(ui.tree);
    const bool updates = ui.tree->updatesEnabled();
    ui.tree->setUpdatesEnabled(false);
    const auto query = ui.filter->text().trimmed();
    int visible = 0;
    for (int i = 0; i < ui.tree->topLevelItemCount(); ++i) {
        auto item = ui.tree->topLevelItem(i);
        bool matches = query.isEmpty();
        for (int col = 0; !matches && col < ui.tree->columnCount(); ++col)
            matches = item->text(col).contains(query, Qt::CaseInsensitive);
        if (!matches)
            matches = item->data(0, Qt::UserRole + 5).toString().contains(query, Qt::CaseInsensitive);
        matches = matches && matches_table_filters(ui, item);
        item->setHidden(!matches);
        if (matches)
            ++visible;
        else if (item->isSelected())
            item->setSelected(false);
    }
    ui.count->setText(project_caption("%1 of %2 records").arg(visible).arg(ui.tree->topLevelItemCount()));
    auto empty = ui.tree->findChild<QLabel *>("tableEmptyState");
    const bool records_empty = ui.tree->topLevelItemCount() == 0;
    QString empty_message = records_empty ? "No records yet. Use Add to create one."
                                          : "No matching records. Clear the filters to see all records.";
    if (records_empty) {
        if (ui.kind == "release" && document_.components.empty())
            empty_message = "Add a component before creating a release.";
        else if (ui.kind == "dependency" && document_.components.size() < 2)
            empty_message = "Add two components before declaring a dependency.";
        else if (ui.kind == "binding" && (document_.releases.empty() || document_.topology.assets.empty()))
            empty_message = "Add a device and release before creating a binding.";
        else if (ui.kind == "verification" && document_.releases.empty())
            empty_message = "Add a release before recording evidence.";
    }
    empty->setText(project_caption(empty_message));
    empty->setVisible(visible == 0);
    bool enabled = !ui.tree->selectedItems().empty();
    bool immutable = false;
    if (enabled && ui.kind == "release") {
        auto id = ui.tree->selectedItems().front()->data(0, Qt::UserRole).toString();
        for (const auto &release : document_.releases)
            if (text(release.id) == id)
                immutable = release.state == lmti::ReleaseState::Approved;
    }
    for (auto button : {ui.edit, ui.remove})
        if (button) {
            button->setEnabled(enabled && !immutable);
            button->setToolTip(project_caption(immutable
                                                   ? "Approved metadata is locked. Create a new release."
                                               : enabled ? ""
                                                         : "Select a record first"));
        }
    ui.tree->setUpdatesEnabled(updates);
}

bool ProjectWindow::eventFilter(QObject *object, QEvent *event) {
    if (object->objectName() == "sidebarViewport" && event->type() == QEvent::Resize)
        queue_navigation_visibility();
    if (relationship_view_ && object == relationship_view_->viewport() &&
        event->type() == QEvent::MouseButtonRelease) {
        auto mouse = static_cast<QMouseEvent *>(event);
        if (mouse->button() != Qt::LeftButton)
            return QMainWindow::eventFilter(object, event);
        auto item = relationship_view_->itemAt(mouse->position().toPoint());
        while (item && item->data(0).toString().isEmpty())
            item = item->parentItem();
        if (item && !item->data(0).toString().isEmpty()) {
            open_entity(item->data(1).toString(), item->data(0).toString(), false);
            return true;
        }
    }
    return QMainWindow::eventFilter(object, event);
}

void ProjectWindow::build_inspector() {
    inspector_ = new QFrame(centralWidget());
    inspector_->setObjectName("entityInspector");
    auto layout = new QVBoxLayout(inspector_);
    layout->setContentsMargins(18, 16, 18, 16);
    auto toolbar = new QHBoxLayout;
    auto back = new QPushButton(QString::fromUtf8("←"));
    back->setProperty("uiAccessibleName", "Back");
    back->setProperty("uiTooltip", "Back");
    back->setAccessibleName(project_caption("Back"));
    back->setToolTip(project_caption("Back"));
    back->setProperty("inspectorChrome", true);
    back->setFixedSize(30, 30);
    back->setObjectName("inspectorBack");
    back->setEnabled(false);
    connect(back, &QPushButton::clicked, this, [this] {
        if (inspector_history_.empty())
            return;
        const auto previous = inspector_history_.back();
        inspector_history_.pop_back();
        restore_view(previous);
    });
    auto close = new QPushButton(QString::fromUtf8("×"));
    close->setProperty("uiAccessibleName", "Close details");
    close->setProperty("uiTooltip", "Close details");
    close->setAccessibleName(project_caption("Close details"));
    close->setToolTip(project_caption("Close details"));
    close->setProperty("inspectorChrome", true);
    close->setFixedSize(30, 30);
    close->setObjectName("closeInspector");
    connect(close, &QPushButton::clicked, inspector_, &QWidget::hide);
    toolbar->addWidget(back);
    toolbar->addStretch();
    toolbar->addWidget(close);
    layout->addLayout(toolbar);
    auto scroll = new QScrollArea;
    scroll->setObjectName("inspectorScroll");
    scroll->setWidgetResizable(true);
    scroll->setFrameShape(QFrame::NoFrame);
    scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    auto content = new QWidget;
    content->setObjectName("inspectorContent");
    auto body = new QVBoxLayout(content);
    body->setContentsMargins(0, 6, 0, 0);
    body->setSpacing(12);
    inspector_title_ = plain_label();
    inspector_title_->setObjectName("inspectorTitle");
    inspector_title_->setStyleSheet("font-size:20px;font-weight:600;");
    layout->addWidget(inspector_title_);
    inspector_mode_ = new studio::Choice(content);
    inspector_mode_->setObjectName("inspectorViewMode");
    inspector_mode_->addItem("Summary", "summary");
    inspector_mode_->addItem("Related work", "work");
    inspector_mode_->setProperty("uiChoices", QStringList{"Summary", "Related work"});
    inspector_modes_ = studio::segments(inspector_mode_, "inspectorViewSegments", {0, 1});
    inspector_modes_->setProperty("inspectorTabs", true);
    layout->addWidget(inspector_modes_);
    inspector_modes_->hide();
    connect(inspector_mode_, &QComboBox::currentIndexChanged, this, [this] {
        inspector_page_ = 0;
        filter_inspector_links();
    });
    inspector_state_ = plain_label();
    inspector_state_->setObjectName("inspectorState");
    inspector_state_->setSizePolicy(QSizePolicy::Maximum, QSizePolicy::Preferred);
    layout->addWidget(inspector_state_);
    inspector_primary_ = new QWidget;
    auto primary_layout = new QVBoxLayout(inspector_primary_);
    primary_layout->setContentsMargins(0, 0, 0, 0);
    layout->addWidget(inspector_primary_);
    inspector_facts_ = new QTreeWidget;
    inspector_facts_->setObjectName("inspectorFacts");
    inspector_facts_->setColumnCount(2);
    inspector_facts_->setHeaderHidden(true);
    inspector_facts_->setProperty("facts", true);
    inspector_facts_->setFocusPolicy(Qt::NoFocus);
    inspector_facts_->setVerticalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    inspector_facts_->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    studio::inventory(inspector_facts_);
    inspector_facts_->header()->setMinimumSectionSize(40);
    inspector_facts_->header()->setSectionResizeMode(0, QHeaderView::Fixed);
    inspector_facts_->header()->setSectionResizeMode(1, QHeaderView::Stretch);
    inspector_facts_->setMinimumHeight(152);
    inspector_facts_->setMaximumHeight(152);
    body->addWidget(inspector_facts_);
    inspector_summary_ = plain_label();
    inspector_summary_->setObjectName("inspectorSummary");
    body->addWidget(inspector_summary_);
    inspector_actions_ = new QWidget;
    inspector_actions_->setLayout(new QGridLayout);
    inspector_actions_->layout()->setContentsMargins(0, 8, 0, 8);
    inspector_links_ = new QTreeWidget;
    inspector_links_->setObjectName("inspectorRelations");
    inspector_links_->setHeaderLabels({project_caption("Related records"), project_caption("Kind")});
    inspector_links_->setRootIsDecorated(false);
    inspector_links_->setProperty("compactRelations", true);
    inspector_links_->setVerticalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    inspector_links_->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    studio::inventory(inspector_links_);
    auto related_empty = new studio::EmptyTreeState(inspector_links_);
    related_empty->setProperty("verbatim", true);
    inspector_links_->setItemDelegate(new studio::RelatedRecordDelegate(inspector_links_));
    inspector_links_->setHeaderHidden(true);
    inspector_links_->setColumnHidden(1, true);
    inspector_links_->setMouseTracking(true);
    inspector_links_->header()->setSectionResizeMode(0, QHeaderView::Stretch);
    inspector_pagination_ = new QWidget;
    inspector_pagination_->setObjectName("inspectorPagination");
    auto pagination = new QHBoxLayout(inspector_pagination_);
    pagination->setContentsMargins(0, 0, 0, 0);
    pagination->setSpacing(6);
    inspector_page_label_ = plain_label();
    inspector_page_label_->setObjectName("inspectorPageLabel");
    pagination->addWidget(inspector_page_label_, 1);
    inspector_previous_ = new QPushButton(QString::fromUtf8("‹"));
    inspector_next_ = new QPushButton(QString::fromUtf8("›"));
    inspector_previous_->setObjectName("inspectorPrevious");
    inspector_next_->setObjectName("inspectorNext");
    for (auto button : {inspector_previous_, inspector_next_}) {
        const auto caption =
            button == inspector_previous_ ? "Previous related records" : "Next related records";
        button->setProperty("uiAccessibleName", caption);
        button->setProperty("uiTooltip", caption);
        button->setAccessibleName(project_caption(caption));
        button->setToolTip(project_caption(caption));
        button->setProperty("inspectorChrome", true);
        button->setFixedSize(28, 28);
        pagination->addWidget(button);
    }
    auto change_page = [this, scroll](int step) {
        inspector_page_ += step;
        filter_inspector_links();
        scroll->ensureWidgetVisible(inspector_pagination_);
    };
    connect(inspector_previous_, &QPushButton::clicked, this, [change_page] { change_page(-1); });
    connect(inspector_next_, &QPushButton::clicked, this, [change_page] { change_page(1); });
    body->addWidget(inspector_pagination_);
    body->addWidget(inspector_links_);
    connect(inspector_links_, &QTreeWidget::itemActivated, this, [this](QTreeWidgetItem *item, int) {
        open_entity(item->data(0, Qt::UserRole + 1).toString(), item->data(0, Qt::UserRole).toString());
    });
    auto open = new QPushButton(project_caption("Open related record"));
    open->setObjectName("openRelatedRecord");
    open->setProperty("uiCaption", "Open related record");
    open->setEnabled(false);
    connect(inspector_links_, &QTreeWidget::currentItemChanged, open,
            [open](QTreeWidgetItem *item) { open->setEnabled(item != nullptr); });
    connect(inspector_links_, &QTreeWidget::currentItemChanged, scroll,
            [this, scroll, content](QTreeWidgetItem *item) {
                if (!item)
                    return;
                const auto bounds = inspector_links_->visualItemRect(item);
                const auto center = inspector_links_->viewport()->mapTo(content, bounds.center());
                scroll->ensureVisible(center.x(), center.y(), 0, bounds.height() / 2 + 6);
            });
    connect(open, &QPushButton::clicked, this, [this] {
        if (auto item = inspector_links_->currentItem())
            open_entity(item->data(0, Qt::UserRole + 1).toString(), item->data(0, Qt::UserRole).toString());
    });
    open->setProperty("compactAction", true);
    body->addWidget(open, 0, Qt::AlignRight);
    body->addStretch();
    scroll->setWidget(content);
    layout->addWidget(scroll, 1);
    layout->addWidget(inspector_actions_);
    auto escape = new QShortcut(QKeySequence(Qt::Key_Escape), inspector_);
    escape->setContext(Qt::WidgetWithChildrenShortcut);
    connect(escape, &QShortcut::activated, inspector_, &QWidget::hide);
    inspector_->hide();
    position_inspector();
}

void ProjectWindow::position_inspector() {
    if (!inspector_)
        return;
    const bool was_visible = inspector_->isVisible();
    if (inspector_->parentWidget() != workspace_content_) {
        inspector_->setParent(workspace_content_);
        workspace_body_->addWidget(inspector_);
        if (was_visible)
            inspector_->show();
    }
    inspector_->setFixedWidth(width() < 1280 ? 280 : 352);
    // Leave enough room for the value in narrow translated inspectors. Full
    // captions and metadata remain available in the native cell tooltips.
    inspector_facts_->setColumnWidth(0, (inspector_->width() - 38) * 45 / 100);
}
void ProjectWindow::resizeEvent(QResizeEvent *event) {
    QMainWindow::resizeEvent(event);
    position_inspector();
    queue_navigation_visibility();
    if (active_ && relationship_view_ &&
        relationship_scene_->property("compactLayout").toBool() != (width() < 1440))
        refresh_relationships();
}

void ProjectWindow::open_entity(const QString &kind, const QString &id, bool navigate) {
    if (!active_ || id.isEmpty() || !inspector_)
        return;
    if (kind != inspected_kind_ || id != inspected_id_) {
        if (!inspected_id_.isEmpty() || navigate) {
            if (inspector_history_.size() == 20)
                inspector_history_.erase(inspector_history_.begin());
            inspector_history_.push_back(capture_view());
        }
        QSignalBlocker mode_blocker(inspector_mode_);
        inspector_mode_->setCurrentIndex(0);
        inspector_page_ = 0;
        findChild<QScrollArea *>("inspectorScroll")->verticalScrollBar()->setValue(0);
        inspected_kind_ = kind;
        inspected_id_ = id;
    }
    if (navigate) {
        QTreeWidget *table = nullptr;
        ProjectPage page = ProjectPage::Software;
        if (kind == "device") {
            page = ProjectPage::Hardware;
            table = hardware_devices_;
        } else if (kind == "target") {
            page = ProjectPage::Hardware;
            table = targets_;
        } else if (kind == "binding") {
            page = ProjectPage::Hardware;
            table = bindings_;
        } else if (kind == "component")
            table = components_;
        else if (kind == "repository")
            table = repositories_;
        else if (kind == "dependency")
            table = dependencies_;
        else if (kind == "release") {
            page = ProjectPage::Releases;
            table = releases_;
        } else if (kind == "verification") {
            page = ProjectPage::Releases;
            table = verification_;
        } else if (kind == "work") {
            page = ProjectPage::Work;
            table = work_list_;
            work_mode_->setCurrentIndex(0);
        } else if (kind == "milestone") {
            page = ProjectPage::Work;
            table = milestones_;
        } else if (kind == "knowledge") {
            page = ProjectPage::Knowledge;
            table = knowledge_;
        }
        show_page(page);
        if (table) {
            QWidget *child = table;
            for (QWidget *parent = child->parentWidget(); parent && parent != tabs_;
                 parent = parent->parentWidget()) {
                if (auto tabs = qobject_cast<QTabWidget *>(parent))
                    for (int i = 0; i < tabs->count(); ++i)
                        if (tabs->widget(i) == child || tabs->widget(i)->isAncestorOf(table))
                            tabs->setCurrentIndex(i);
                child = parent;
            }
            for (const auto &ui : table_ui_)
                if (ui.tree == table) {
                    for (int i = 0; i < table->topLevelItemCount(); ++i)
                        if (table->topLevelItem(i)->data(0, Qt::UserRole).toString() == id &&
                            table->topLevelItem(i)->isHidden()) {
                            ui.filter->clear();
                            for (const auto &choice : ui.choices)
                                choice.widget->setCurrentIndex(0);
                        }
                }
            QSignalBlocker blocker(table);
            for (int i = 0; i < table->topLevelItemCount(); ++i) {
                auto item = table->topLevelItem(i);
                if (item->data(0, Qt::UserRole).toString() == id) {
                    table->setCurrentItem(item);
                    table->scrollToItem(item);
                }
            }
        }
    }
    refresh_inspector();
    position_inspector();
    inspector_->show();
    inspector_->raise();
}

ProjectWindow::ViewState ProjectWindow::capture_view() const {
    ViewState state{inspected_kind_,
                    inspected_id_,
                    tabs_->currentIndex(),
                    work_mode_->currentIndex(),
                    {},
                    {},
                    {},
                    {},
                    {}};
    for (auto tree : findChildren<QTreeWidget *>()) {
        auto selected = tree->selectedItems();
        state.tables.push_back(
            {tree, selected.empty() ? QString{} : selected.front()->data(0, Qt::UserRole).toString(),
             tree->verticalScrollBar()->value()});
    }
    for (const auto &ui : table_ui_) {
        state.filters.emplace_back(ui.filter, ui.filter->text());
        for (const auto &choice : ui.choices)
            state.choices.emplace_back(choice.widget, choice.widget->currentData().toString());
    }
    state.choices.emplace_back(inspector_mode_, inspector_mode_->currentData().toString());
    for (auto tabs : findChildren<QTabWidget *>())
        state.tabs.emplace_back(tabs, tabs->currentIndex());
    for (auto view : findChildren<QGraphicsView *>())
        state.canvases.push_back({view, view->transform(), view->horizontalScrollBar()->value(),
                                  view->verticalScrollBar()->value()});
    if (auto scroll = findChild<QScrollArea *>("workspaceScroll")) {
        state.page_horizontal = scroll->horizontalScrollBar()->value();
        state.page_vertical = scroll->verticalScrollBar()->value();
    }
    state.inspector_page = inspector_page_;
    state.inspector_vertical = findChild<QScrollArea *>("inspectorScroll")->verticalScrollBar()->value();
    if (auto item = inspector_links_->currentItem()) {
        state.related_kind = item->data(0, Qt::UserRole + 1).toString();
        state.related_id = item->data(0, Qt::UserRole).toString();
    }
    return state;
}

void ProjectWindow::restore_view(const ViewState &state) {
    inspected_kind_ = state.kind;
    inspected_id_ = state.id;
    inspector_page_ = state.inspector_page;
    const bool before = refreshing_;
    refreshing_ = true;
    for (const auto &[filter, value] : state.filters) {
        QSignalBlocker blocker(filter);
        filter->setText(value);
    }
    for (const auto &[choice, value] : state.choices) {
        QSignalBlocker blocker(choice);
        choice->setCurrentIndex(std::max(0, choice->findData(value)));
    }
    work_mode_->setCurrentIndex(state.work_mode);
    refresh_work();
    for (const auto &ui : table_ui_)
        filter_table(ui);
    for (const auto &[tabs, page] : state.tabs)
        tabs->setCurrentIndex(page);
    show_page(state.page);
    for (const auto &table : state.tables) {
        if (table.tree == inspector_links_)
            continue; // The bounded related-record model is rebuilt below.
        QSignalBlocker blocker(table.tree);
        table.tree->clearSelection();
        for (int i = 0; i < table.tree->topLevelItemCount(); ++i) {
            auto item = table.tree->topLevelItem(i);
            if (!item->isHidden() && !table.selection.isEmpty() &&
                item->data(0, Qt::UserRole).toString() == table.selection)
                table.tree->setCurrentItem(item);
        }
        table.tree->verticalScrollBar()->setValue(table.scroll);
    }
    refreshing_ = before;
    for (const auto &ui : table_ui_)
        filter_table(ui);
    refresh_inspector();
    for (int index = 0; index < inspector_links_->topLevelItemCount(); ++index) {
        auto item = inspector_links_->topLevelItem(index);
        if (item->data(0, Qt::UserRole).toString() == state.related_id &&
            item->data(0, Qt::UserRole + 1).toString() == state.related_kind)
            inspector_links_->setCurrentItem(item);
    }
    // Let the body layout publish its new range before restoring its position.
    QTimer::singleShot(
        0, this,
        [this, kind = state.kind, id = state.id, page = state.inspector_page,
         offset = state.inspector_vertical] {
            if (inspected_kind_ == kind && inspected_id_ == id && inspector_page_ == page)
                findChild<QScrollArea *>("inspectorScroll")->verticalScrollBar()->setValue(offset);
        });
    if (auto scroll = findChild<QScrollArea *>("workspaceScroll")) {
        scroll->horizontalScrollBar()->setValue(state.page_horizontal);
        scroll->verticalScrollBar()->setValue(state.page_vertical);
    }
    for (const auto &canvas : state.canvases) {
        canvas.view->setTransform(canvas.transform);
        canvas.view->horizontalScrollBar()->setValue(canvas.horizontal);
        canvas.view->verticalScrollBar()->setValue(canvas.vertical);
    }
    inspector_->setVisible(!state.id.isEmpty());
}

void ProjectWindow::create_related(const QString &kind) {
    create_kind_ = inspected_kind_;
    create_id_ = inspected_id_;
    edit_entity(kind);
    create_kind_.clear();
    create_id_.clear();
}

void ProjectWindow::refresh_inspector() {
    if (!inspector_ || inspected_id_.isEmpty())
        return;
    inspector_links_->clear();
    inspector_relations_.clear();
    inspector_state_->hide();
    inspector_primary_->hide();
    inspector_facts_->clear();
    inspector_facts_->hide();
    inspector_summary_->setStyleSheet({});
    inspector_links_->setHeaderLabels({project_caption("Related records"), project_caption("Kind")});
    for (const auto container : {inspector_actions_, inspector_primary_})
        while (auto item = container->layout()->takeAt(0)) {
            if (auto widget = item->widget()) {
                widget->hide();
                widget->setObjectName({});
                widget->deleteLater();
            }
            delete item;
        }
    QString name, summary;
    std::string component, asset, release;
    bool editable = true;
    bool milestone_accepted = false, milestone_ready = false;
    const auto id = inspected_id_.toStdString();
    const auto kind = inspected_kind_;
    findChild<QPushButton *>("inspectorBack")->setEnabled(!inspector_history_.empty());
    QMap<std::pair<QString, QString>, int> related_indices;
    auto related = [this, &related_indices](const QString &type, const std::string &key,
                                            const QString &caption) -> InspectorRelation * {
        if (key.empty() || caption.isEmpty())
            return nullptr;
        if (type == inspected_kind_ && text(key) == inspected_id_)
            return nullptr;
        const auto identity = std::make_pair(type, text(key));
        if (auto existing = related_indices.constFind(identity); existing != related_indices.cend())
            return &inspector_relations_[existing.value()];
        related_indices.insert(identity, static_cast<int>(inspector_relations_.size()));
        inspector_relations_.push_back({type, text(key), caption, studio::enum_caption(type), {}});
        return &inspector_relations_.back();
    };
    auto facts = [this](std::initializer_list<std::pair<QString, QString>> values) {
        for (const auto &[caption, value] : values) {
            auto row =
                new QTreeWidgetItem(inspector_facts_, {project_caption(caption),
                                                       value.isEmpty() ? project_caption("None") : value});
            row->setData(0, Qt::UserRole, caption);
            row->setToolTip(0, project_caption(caption).toHtmlEscaped());
            row->setSizeHint(
                0,
                QSize(inspector_facts_->fontMetrics().horizontalAdvance(project_caption(caption)) + 16, 28));
            row->setToolTip(1, value.toHtmlEscaped());
        }
        const auto height = static_cast<int>(values.size()) * 28 + 12;
        inspector_facts_->setMinimumHeight(height);
        inspector_facts_->setMaximumHeight(height);
        inspector_facts_->show();
    };
    if (kind == "component")
        for (const auto &r : document_.components)
            if (r.id == id) {
                name = text(r.label);
                component = id;
                const auto devices =
                    std::count_if(document_.bindings.begin(), document_.bindings.end(),
                                  [&](const auto &binding) { return binding.component_id == id; });
                facts(
                    {{"Kind", studio::enum_caption(lmti::name(r.kind).c_str())},
                     {"Repository", r.repository_id.empty() ? project_caption("None")
                                                            : title(document_.repositories, r.repository_id)},
                     {"Related devices", QString::number(devices)},
                     {"Desired bindings", QString::number(devices)},
                     {"Observed versions", project_caption("Unknown")},
                     {"Visibility", studio::enum_caption(lmti::name(r.privacy).c_str())}});
                summary = project_caption("Software metadata and declared relationships.");
                related("repository", r.repository_id, title(document_.repositories, r.repository_id));
                for (const auto &d : document_.dependencies) {
                    if (d.from == id)
                        related("component", d.to, title(document_.components, d.to));
                    if (d.to == id)
                        related("component", d.from, title(document_.components, d.from));
                }
            }
    if (kind == "device")
        for (const auto &r : document_.topology.assets)
            if (r.id == id) {
                name = text(r.label);
                asset = id;
                facts({{"Kind", studio::enum_caption(lmti::name(r.kind).c_str())},
                       {"Site", text(r.site)},
                       {"Observed version", project_caption("Unknown")},
                       {"Desired enabled", project_caption(r.enabled ? "Yes" : "No")},
                       {"Visibility", studio::enum_caption(lmti::name(r.privacy).c_str())}});
                summary = project_caption("Desired configuration only; no device execution.");
            }
    if (kind == "release")
        for (const auto &r : document_.releases)
            if (r.id == id) {
                name = text(r.label);
                component = r.component_id;
                release = id;
                editable = r.state != lmti::ReleaseState::Approved;
                inspector_state_->setText(editable ? studio::enum_caption(lmti::name(r.state).c_str())
                                                   : project_caption("Metadata locked"));
                inspector_state_->setStyleSheet(
                    QString("color:%1;background:%2;border-radius:4px;padding:6px 10px;font-weight:600;")
                        .arg(editable ? "#526581" : "#176647", editable ? "#edf1f6" : "#dff3ea"));
                inspector_state_->show();
                facts({{"Component", title(document_.components, r.component_id)},
                       {"Target", r.target_id.empty() ? project_caption("None")
                                                      : title(document_.targets, r.target_id)},
                       {"Source revision", r.source_revision.empty() ? project_caption("Not recorded")
                                                                     : text(r.source_revision)},
                       {"Review state", studio::enum_caption(lmti::name(r.state).c_str())},
                       {"Visibility", studio::enum_caption(lmti::name(r.privacy).c_str())}});
                summary = project_caption("Approval reviews metadata; it does not prove installation.");
                inspector_summary_->setStyleSheet(
                    "background:#edf4ff;color:#526581;padding:10px;border-radius:6px;");
                related("component", component, title(document_.components, component));
                related("target", r.target_id, title(document_.targets, r.target_id));
            }
    if (kind == "work")
        for (const auto &r : document_.work)
            if (r.id == id) {
                name = text(r.label);
                component = r.component_id;
                asset = r.asset_id;
                release = r.release_id;
                facts({{"Kind", studio::enum_caption(lmti::name(r.kind).c_str())},
                       {"State", studio::enum_caption(lmti::name(r.state).c_str())},
                       {"Component", title(document_.components, component)},
                       {"Device", title(document_.topology.assets, asset)},
                       {"Release", title(document_.releases, release)},
                       {"Milestone", title(document_.milestones, r.milestone_id)},
                       {"Visibility", studio::enum_caption(lmti::name(r.privacy).c_str())}});
                summary = project_caption("Checklist: %1\n\nWork evidence: %2")
                              .arg(text(r.checklist),
                                   r.evidence.empty() ? project_caption("Not recorded") : text(r.evidence));
                related("milestone", r.milestone_id, title(document_.milestones, r.milestone_id));
            }
    if (kind == "verification")
        for (const auto &r : document_.verification)
            if (r.id == id) {
                name = project_caption("Release evidence");
                release = r.release_id;
                asset = r.asset_id;
                facts(
                    {{"Result", studio::enum_caption(lmti::name(r.result).c_str())},
                     {"Source", text(r.source)},
                     {"Recorded", QDateTime::fromSecsSinceEpoch(r.at, QTimeZone::UTC).toString(Qt::ISODate)},
                     {"Release", title(document_.releases, release)},
                     {"Device", title(document_.topology.assets, asset)}});
                summary = project_caption("Evidence: %1").arg(text(r.evidence));
            }
    if (kind == "binding")
        for (const auto &r : document_.bindings)
            if (r.id == id) {
                name = project_caption("Desired software binding");
                component = r.component_id;
                asset = r.asset_id;
                release = r.release_id;
                facts({{"Device", title(document_.topology.assets, asset)},
                       {"Component", title(document_.components, component)},
                       {"Target", r.target_id.empty() ? project_caption("None")
                                                      : title(document_.targets, r.target_id)},
                       {"Desired version", title(document_.releases, release)},
                       {"Observed version", project_caption("Unknown")},
                       {"Visibility", studio::enum_caption(lmti::name(r.privacy).c_str())}});
                summary = project_caption("Declared desired binding only; no device execution.");
                related("target", r.target_id, title(document_.targets, r.target_id));
            }
    if (kind == "target")
        for (const auto &r : document_.targets)
            if (r.id == id) {
                name = text(r.label);
                facts({{"Hardware revision", r.hardware_revision.empty() ? project_caption("Not recorded")
                                                                         : text(r.hardware_revision)},
                       {"Architecture",
                        r.architecture.empty() ? project_caption("Not recorded") : text(r.architecture)},
                       {"Visibility", studio::enum_caption(lmti::name(r.privacy).c_str())}});
                summary = project_caption("Compatibility declarations; no hardware probing.");
                for (const auto &v : document_.releases)
                    if (v.target_id == id)
                        related("release", v.id, text(v.label));
            }
    if (kind == "repository")
        for (const auto &r : document_.repositories)
            if (r.id == id) {
                name = text(r.label);
                const auto components =
                    std::count_if(document_.components.begin(), document_.components.end(),
                                  [&](const auto &component) { return component.repository_id == id; });
                facts({{"Locator", r.locator.empty() ? project_caption("Not recorded") : text(r.locator)},
                       {"Linked components", QString::number(components)},
                       {"Visibility", studio::enum_caption(lmti::name(r.privacy).c_str())}});
                summary = project_caption("Repository reference only; source is not scanned.");
                for (const auto &c : document_.components)
                    if (c.repository_id == id)
                        related("component", c.id, text(c.label));
            }
    if (kind == "milestone")
        for (const auto &r : document_.milestones)
            if (r.id == id) {
                name = text(r.label);
                inspector_links_->setHeaderLabels({project_caption("Linked work"), project_caption("State")});
                int total = 0, done = 0;
                for (const auto &w : document_.work)
                    if (w.milestone_id == id) {
                        ++total;
                        done += w.state == lmti::WorkState::Done;
                        auto row = related("work", w.id, text(w.label));
                        row->detail = studio::enum_caption(lmti::name(w.state).c_str());
                        row->state = text(lmti::name(w.state));
                    }
                milestone_accepted = r.accepted;
                milestone_ready = total > 0 && done == total && !r.evidence.empty();
                facts(
                    {{"Due date", r.due_date.empty() ? project_caption("Not set") : text(r.due_date)},
                     {"Acceptance", project_caption(r.accepted ? "Operator accepted" : "Acceptance pending")},
                     {"Linked work", project_caption("%1 of %2 complete").arg(done).arg(total)},
                     {"Visibility", studio::enum_caption(lmti::name(r.privacy).c_str())}});
                summary = project_caption("Acceptance criteria\n%1\n\nAcceptance evidence\n%2")
                              .arg(text(r.criteria),
                                   r.evidence.empty() ? project_caption("Not recorded") : text(r.evidence));
                if (!r.accepted && !milestone_ready)
                    summary += "\n\n" +
                               project_caption("Complete linked work and record acceptance evidence first.");
            }
    if (kind == "knowledge")
        for (const auto &r : document_.knowledge)
            if (r.id == id) {
                name = text(r.label);
                component = r.component_id;
                facts({{"Component", title(document_.components, component)},
                       {"Fingerprint",
                        r.fingerprint.empty() ? project_caption("Not recorded") : text(r.fingerprint)},
                       {"Visibility", studio::enum_caption(lmti::name(r.privacy).c_str())},
                       {"Source status", project_caption("Source not loaded")}});
                summary = project_caption("Reference only · source not loaded") + "\n" + text(r.reference);
            }
    if (kind == "dependency")
        for (const auto &r : document_.dependencies)
            if (r.id == id) {
                name = project_caption("Declared dependency");
                facts({{"Source component", title(document_.components, r.from)},
                       {"Target component", title(document_.components, r.to)},
                       {"Interface / contract", text(r.contract)},
                       {"Visibility", studio::enum_caption(lmti::name(r.privacy).c_str())}});
                summary =
                    project_caption("Declared software dependency; no runtime connectivity is verified.");
                related("component", r.from, title(document_.components, r.from));
                related("component", r.to, title(document_.components, r.to));
            }
    if (name.isEmpty()) {
        inspector_->hide();
        inspected_id_.clear();
        return;
    }
    inspector_title_->setText(name);
    inspector_summary_->setText(summary);
    if (!component.empty() && kind != "component")
        related("component", component, title(document_.components, component));
    if (!asset.empty() && kind != "device")
        related("device", asset, title(document_.topology.assets, asset));
    if (!release.empty() && kind != "release")
        related("release", release, title(document_.releases, release));
    if (kind == "component" || kind == "device") {
        for (const auto &b : document_.bindings)
            if ((kind == "component" && b.component_id == id) || (kind == "device" && b.asset_id == id)) {
                related("device", b.asset_id, title(document_.topology.assets, b.asset_id));
                related("component", b.component_id, title(document_.components, b.component_id));
                related("release", b.release_id, title(document_.releases, b.release_id));
                related("binding", b.id, project_caption("Desired software binding"));
            }
    }
    if (kind == "component")
        for (const auto &v : document_.releases)
            if (v.component_id == id)
                related("release", v.id, text(v.label));
    for (const auto &w : document_.work)
        if ((kind == "component" && w.component_id == id) || (kind == "device" && w.asset_id == id) ||
            (kind == "release" && w.release_id == id) ||
            (kind == "binding" && w.component_id == component && w.asset_id == asset &&
             w.release_id == release) ||
            (kind == "verification" && w.release_id == release && (asset.empty() || w.asset_id == asset)))
            related("work", w.id, text(w.label));
    for (const auto &e : document_.verification)
        if (kind != "verification" || e.id != id)
            if ((!release.empty() && e.release_id == release) || (!asset.empty() && e.asset_id == asset) ||
                (kind == "component" &&
                 std::any_of(document_.releases.begin(), document_.releases.end(),
                             [&](const auto &v) { return v.id == e.release_id && v.component_id == id; })))
                related("verification", e.id,
                        project_caption("Release evidence") + " · " +
                            studio::enum_caption(lmti::name(e.result).c_str()));
    auto action = [this](const QString &caption, const QString &key, auto callback, bool prominent = false) {
        auto button = new studio::ActionButton(project_caption(caption));
        button->setObjectName(key);
        connect(button, &QPushButton::clicked, this, callback);
        auto grid = qobject_cast<QGridLayout *>(inspector_actions_->layout());
        const auto index = grid->count();
        button->setProperty("primary", prominent);
        button->setProperty("compactAction", index != 0);
        if (prominent) {
            inspector_primary_->layout()->addWidget(button);
            inspector_primary_->show();
        } else if (index == 0)
            grid->addWidget(button, 0, 0, 1, 2);
        else
            grid->addWidget(button, 1 + (index - 1) / 2, (index - 1) % 2);
        auto policy = QSizePolicy(QSizePolicy::Ignored, QSizePolicy::Preferred);
        policy.setHeightForWidth(true);
        button->setSizePolicy(policy);
        button->setToolTip(project_caption(caption));
        return button;
    };
    if (kind == "release" && !editable) {
        auto create = action(
            "Create new version", "inspectorCreateVersion", [this] { create_related("release"); }, true);
        create->setProperty("primary", true);
    }
    auto edit = action("Edit record", "inspectorEdit",
                       [this] { edit_entity(inspected_kind_, inspected_id_.toStdString()); });
    edit->setEnabled(editable);
    edit->setProperty("primary", editable);
    edit->style()->unpolish(edit);
    edit->style()->polish(edit);
    if (!editable)
        edit->setToolTip(project_caption("Approved metadata is locked. Create a new release."));
    if (kind == "milestone") {
        auto accept = action("Mark as accepted", "inspectorAcceptMilestone", [this, id] {
            try {
                update_project([&](auto &document) {
                    auto milestone = std::find_if(document.milestones.begin(), document.milestones.end(),
                                                  [&](const auto &record) { return record.id == id; });
                    if (milestone == document.milestones.end())
                        throw lmti::Error("Milestone no longer exists.");
                    milestone->accepted = true;
                });
            } catch (const std::exception &exception) {
                error(exception);
            }
        });
        accept->setEnabled(!milestone_accepted && milestone_ready);
        if (!accept->isEnabled())
            accept->setToolTip(project_caption(
                milestone_accepted ? "Operator accepted"
                                   : "Complete linked work and record acceptance evidence first."));
    }
    if (kind == "component" || (kind == "release" && editable))
        action("Create version", "inspectorCreateVersion", [this] { create_related("release"); });
    if (kind == "binding")
        action("Add validation work", "inspectorAddWork", [this] { create_related("work"); });
    if (kind == "component" || kind == "release" || kind == "device") {
        auto bind =
            action("Link desired version", "inspectorLinkDevice", [this] { create_related("binding"); });
        bind->setEnabled(!document_.releases.empty() && !document_.topology.assets.empty());
        if (!bind->isEnabled())
            bind->setToolTip(project_caption("Add a release and device first"));
        action("Add work item", "inspectorAddWork", [this] { create_related("work"); });
    }
    if (kind == "release" || kind == "device") {
        auto evidence = action("Add release evidence", "inspectorAddEvidence",
                               [this] { create_related("verification"); });
        evidence->setEnabled(!document_.releases.empty());
    }
    if (kind == "device")
        action("Edit topology", "inspectorTopology", [this] {
            show_page(ProjectPage::Architecture);
            architecture_tabs_->setCurrentIndex(0);
            architecture_->select_asset(inspected_id_.toStdString());
            inspector_->hide();
        });
    filter_inspector_links();
}

void ProjectWindow::filter_inspector_links() {
    if (!inspector_mode_ || !inspector_links_)
        return;
    const bool component = inspected_kind_ == "component";
    const bool work_only = component && inspector_mode_->currentIndex() == 1;
    inspector_modes_->setVisible(component);
    inspector_facts_->setVisible(!work_only && inspector_facts_->topLevelItemCount() > 0);
    inspector_summary_->setVisible(!work_only && !inspector_summary_->text().isEmpty());
    QString selected_kind, selected_id;
    if (auto item = inspector_links_->currentItem()) {
        selected_kind = item->data(0, Qt::UserRole + 1).toString();
        selected_id = item->data(0, Qt::UserRole).toString();
    }
    const auto visible = static_cast<int>(
        std::count_if(inspector_relations_.begin(), inspector_relations_.end(),
                      [work_only](const auto &record) { return !work_only || record.kind == "work"; }));
    const auto last_page = visible == 0 ? 0 : (visible - 1) / inspector_page_size;
    inspector_page_ = std::clamp(inspector_page_, 0, last_page);
    const int begin = inspector_page_ * inspector_page_size;
    const int end = std::min(visible, begin + inspector_page_size);
    {
        QSignalBlocker blocker(inspector_links_);
        inspector_links_->clear();
        int index = 0;
        for (const auto &record : inspector_relations_) {
            if (work_only && record.kind != "work")
                continue;
            if (index++ < begin)
                continue;
            if (index > end)
                break;
            auto item = new QTreeWidgetItem(inspector_links_, {record.caption, record.detail});
            item->setData(0, Qt::UserRole, record.id);
            item->setData(0, Qt::UserRole + 1, record.kind);
            item->setData(1, studio::badge_role, record.state);
            item->setData(0, Qt::AccessibleTextRole, record.caption + " · " + record.detail);
            item->setToolTip(0, (record.caption + " · " + record.detail).toHtmlEscaped());
            if (record.kind == selected_kind && record.id == selected_id)
                inspector_links_->setCurrentItem(item);
        }
    }
    findChild<QPushButton *>("openRelatedRecord")->setEnabled(inspector_links_->currentItem() != nullptr);
    // Only this page has native items. Its full height belongs to the outer
    // details scroll area; the tree itself never owns a second scroll range.
    int height = inspector_links_->frameWidth() * 2;
    for (int index = 0; index < inspector_links_->topLevelItemCount(); ++index)
        height += inspector_links_->sizeHintForRow(index);
    inspector_links_->setFixedHeight(std::max(visible == 0 ? 92 : 0, height));
    inspector_page_label_->setText(project_caption("%1–%2 of %3 related records")
                                       .arg(visible == 0 ? 0 : begin + 1)
                                       .arg(end)
                                       .arg(visible));
    inspector_previous_->setEnabled(inspector_page_ > 0);
    inspector_next_->setEnabled(inspector_page_ < last_page);
    inspector_pagination_->setVisible(visible > inspector_page_size);
    auto empty = inspector_links_->findChild<QLabel *>("tableEmptyState");
    empty->setText(project_caption(work_only ? "No related work yet. Use Add work to plan a task."
                                             : "No related records."));
    empty->setVisible(visible == 0);
    if (visible == 0)
        empty->raise();
}

void ProjectWindow::refresh_attention() {
    for (auto button : attention_->findChildren<QPushButton *>())
        button->setObjectName({});
    attention_->clear();
    int total = 0;
    auto add = [this, &total](const QString &reason, const QString &kind, const std::string &id,
                              const QString &caption) {
        ++total;
        if (attention_->topLevelItemCount() == 3)
            return;
        auto item = new QTreeWidgetItem(attention_, {"", reason});
        item->setData(0, Qt::UserRole, text(id));
        item->setData(0, Qt::UserRole + 1, kind);
        item->setData(0, Qt::AccessibleTextRole, caption + " · " + reason);
        item->setSizeHint(0, QSize(180, 76));
        auto row = new QWidget;
        row->setStyleSheet("background:transparent;");
        auto layout = new QHBoxLayout(row);
        layout->setContentsMargins(10, 8, 10, 8);
        auto labels = new QVBoxLayout;
        labels->setSpacing(4);
        auto title = plain_label(caption);
        title->setStyleSheet("font-weight:600;background:transparent;");
        labels->addWidget(title);
        auto detail = plain_label(reason);
        detail->setStyleSheet("font-size:12px;color:#64748b;background:transparent;");
        labels->addWidget(detail);
        layout->addLayout(labels, 1);
        auto open = new QPushButton(project_caption("Open"));
        open->setObjectName("attentionOpen-" + kind + "-" + text(id));
        open->setToolTip(caption.toHtmlEscaped());
        connect(open, &QPushButton::clicked, this, [this, kind, id] { open_entity(kind, text(id)); });
        layout->addWidget(open);
        attention_->setItemWidget(item, 0, row);
    };
    for (const auto &w : document_.work)
        if (w.state == lmti::WorkState::Blocked)
            add(project_caption("Blocked work"), "work", w.id, text(w.label));
    QHash<QString, std::pair<int, int>> milestone_work;
    for (const auto &w : document_.work) {
        if (!w.milestone_id.empty()) {
            auto &counts = milestone_work[text(w.milestone_id)];
            ++counts.first;
            counts.second += w.state == lmti::WorkState::Done;
        }
        if (w.state != lmti::WorkState::Blocked && w.kind == lmti::WorkKind::Validation &&
            w.evidence.empty() && w.state != lmti::WorkState::Done)
            add(project_caption("Validation needs evidence"), "work", w.id, text(w.label));
    }
    for (const auto &m : document_.milestones)
        if (!m.accepted) {
            const auto counts = milestone_work.value(text(m.id));
            if (counts.first > 0 && counts.first == counts.second)
                add(project_caption("Milestone needs acceptance"), "milestone", m.id, text(m.label));
        }
    if (!attention_->topLevelItemCount())
        new QTreeWidgetItem(attention_, {project_caption("No blockers requiring attention"), ""});
    attention_count_->setText(project_caption("Showing %1 of %2 attention items. Open Work for all items.")
                                  .arg(std::min(3, total))
                                  .arg(total));
    attention_count_->setVisible(total > 3);
}

void ProjectWindow::refresh_creation_actions() {
    auto gate = [this](const QString &name, bool ready, const QString &reason) {
        if (auto button = findChild<QPushButton *>(name)) {
            button->setEnabled(active_ && ready);
            button->setToolTip(ready ? QString{} : project_caption(reason));
        }
    };
    for (const auto name : {"addrelease", "next-release"})
        gate(name, !document_.components.empty(), "Add a component before creating a release.");
    gate("adddependency", document_.components.size() >= 2,
         "Add two components before declaring a dependency.");
    gate("addbinding", !document_.releases.empty() && !document_.topology.assets.empty(),
         "Add a device and release before creating a binding.");
    gate("addverification", !document_.releases.empty(), "Add a release before recording evidence.");
}
