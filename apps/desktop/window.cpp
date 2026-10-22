#include "window.hpp"
#include "project_language.hpp"
#include "studio_graph.hpp"
#include "studio_style.hpp"
#include "studio_theme.hpp"
#include "studio_widgets.hpp"
#include "toolbar_icons.hpp"
#include <QAction>
#include <QActionGroup>
#include <QApplication>
#include <QCloseEvent>
#include <QDialog>
#include <QDialogButtonBox>
#include <QDockWidget>
#include <QFile>
#include <QFileDialog>
#include <QFileInfo>
#include <QFormLayout>
#include <QGraphicsPathItem>
#include <QGraphicsRectItem>
#include <QGraphicsSceneMouseEvent>
#include <QGraphicsSimpleTextItem>
#include <QHeaderView>
#include <QJsonDocument>
#include <QLabel>
#include <QMenuBar>
#include <QMessageBox>
#include <QPainter>
#include <QPainterPath>
#include <QPushButton>
#include <QScrollArea>
#include <QSignalBlocker>
#include <QStatusBar>
#include <QTimer>
#include <QToolBar>
#include <QToolButton>
#include <QUuid>
#include <QVBoxLayout>
#include <QWheelEvent>
#include <algorithm>
#include <cmath>
#include <set>

namespace {
QString s(const std::string &v) {
    return QString::fromStdString(v);
}
QColor color(lmti::Kind kind) {
    switch (kind) {
    case lmti::Kind::Machine:
        return QColor("#3563e9");
    case lmti::Kind::Gateway:
        return QColor("#168b70");
    case lmti::Kind::Broker:
        return QColor("#8052b8");
    case lmti::Kind::Service:
        return QColor("#a66b18");
    case lmti::Kind::Sensor:
        return QColor("#187e9c");
    }
    return Qt::white;
}
class Canvas : public QGraphicsView {
  protected:
    void wheelEvent(QWheelEvent *e) override {
        const double f = e->angleDelta().y() > 0 ? 1.15 : 1 / 1.15;
        const auto scale_now = transform().m11();
        if (scale_now * f >= 0.15 && scale_now * f <= 3)
            scale(f, f);
        if (changed)
            changed();
        e->accept();
    }
    void drawBackground(QPainter *p, const QRectF &rect) override {
        p->fillRect(rect, QColor("#f7f9fc"));
        if (transform().m11() < 0.3)
            return;
        p->setPen(QPen(QColor("#e5ebf3"), 0));
        const auto left = std::floor(rect.left() / 40) * 40;
        const auto top = std::floor(rect.top() / 40) * 40;
        for (double x = left; x < rect.right(); x += 40)
            p->drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()));
        for (double y = top; y < rect.bottom(); y += 40)
            p->drawLine(QPointF(rect.left(), y), QPointF(rect.right(), y));
    }

  public:
    using QGraphicsView::QGraphicsView;
    std::function<void()> changed;
};
} // namespace
class NodeItem : public QGraphicsRectItem {
  public:
    lmti::Asset asset;
    std::function<void()> moved;
    std::function<void(const std::string &, QPointF)> released;
    explicit NodeItem(const lmti::Asset &a) : QGraphicsRectItem(0, 0, 220, 116), asset(a) {
        setFlags(ItemIsSelectable | ItemIsMovable | ItemSendsGeometryChanges);
        setCursor(Qt::OpenHandCursor);
        setPos(a.x, a.y);
        setZValue(1);
        setData(0, s(a.id));
        setData(1, "device");
        setToolTip((s(a.label) + "\n" + s(a.id) + "\n" + s(a.site)).toHtmlEscaped());
    }
    void paint(QPainter *p, const QStyleOptionGraphicsItem *, QWidget *) override {
        p->setRenderHint(QPainter::Antialiasing);
        p->setBrush(Qt::white);
        p->setPen(QPen(isSelected() ? QColor("#3563e9") : QColor("#c8d4e4"), isSelected() ? 2 : 1));
        p->drawRoundedRect(rect(), 10, 10);
        p->setPen(Qt::NoPen);
        p->setBrush(color(asset.kind));
        p->drawRoundedRect(QRectF(12, 16, 5, 23), 2, 2);
        p->setPen(color(asset.kind));
        // Preserve readable identification in a fitted compact canvas. Detailed
        // metadata remains in the selected-device panel and the full tooltip.
        const auto views = scene() ? scene()->views() : QList<QGraphicsView *>{};
        const auto scale = views.isEmpty() ? 1.0 : std::max(.15, std::abs(views.front()->transform().m11()));
        const bool compact = scale < .7;
        auto f = p->font();
        if (scale < .35) {
            f.setPixelSize(qRound(14 / scale));
            f.setBold(true);
            p->setFont(f);
            p->setPen(QColor("#202a3a"));
            p->drawText(QRectF(8, 2, 204, 112), Qt::AlignLeft | Qt::AlignVCenter,
                        p->fontMetrics().elidedText(s(asset.label), Qt::ElideRight, 204));
            return;
        }
        f.setPixelSize(qRound(compact ? 10 / scale : 12));
        f.setBold(true);
        p->setFont(f);
        p->drawText(QRectF(28, 10, 180, p->fontMetrics().height() + 4), Qt::AlignLeft | Qt::AlignVCenter,
                    p->fontMetrics().elidedText(studio::enum_caption(s(lmti::name(asset.kind))),
                                                Qt::ElideRight, 180));
        p->setPen(QColor("#202a3a"));
        f.setPixelSize(qRound(compact ? 14 / scale : 14));
        p->setFont(f);
        p->drawText(QRectF(14, compact ? 48 : 40, 193, p->fontMetrics().height() + 4),
                    Qt::AlignLeft | Qt::AlignVCenter,
                    p->fontMetrics().elidedText(s(asset.label), Qt::ElideRight, 193));
        if (compact)
            return;
        p->setPen(QColor("#526581"));
        f.setBold(false);
        f.setPixelSize(12);
        p->setFont(f);
        p->drawText(QRectF(14, 67, 195, 18),
                    s(asset.site) + " / " + studio::enum_caption(s(lmti::name(asset.privacy))));
        p->setPen(QColor("#526581"));
        p->drawText(QRectF(14, 91, 195, 16),
                    project_caption("Observed") + ": " + studio::enum_caption(s(lmti::name(asset.observed))));
    }

  protected:
    QVariant itemChange(GraphicsItemChange change, const QVariant &value) override {
        if (change == ItemPositionChange) {
            auto pos = value.toPointF();
            pos.setX(std::clamp(pos.x(), -100000.0, 100000.0));
            pos.setY(std::clamp(pos.y(), -100000.0, 100000.0));
            return pos;
        }
        if (change == ItemPositionHasChanged && moved)
            moved();
        return QGraphicsRectItem::itemChange(change, value);
    }
    void mouseReleaseEvent(QGraphicsSceneMouseEvent *e) override {
        QGraphicsRectItem::mouseReleaseEvent(e);
        if (released)
            released(asset.id, pos());
    }
};

Window::Window(QWidget *parent, lmti::Topology *document)
    : QMainWindow(parent), owned_topology_(document ? lmti::Topology{} : lmti::demo_topology()),
      topology_(document ? *document : owned_topology_) {
    studio::ensure_style();
    setObjectName("topologyWindow");
    resize(1420, 870);
    scene_ = new QGraphicsScene(this);
    scene_->setSceneRect(-1000, -700, 4000, 2800);
    view_ = new Canvas(scene_, this);
    view_->setObjectName("topologyCanvas");
    view_->setRenderHint(QPainter::Antialiasing);
    view_->setDragMode(QGraphicsView::RubberBandDrag);
    view_->setTransformationAnchor(QGraphicsView::AnchorUnderMouse);

    auto bar = addToolBar("Architecture");
    bar->setObjectName("architectureToolbar");
    bar->setMovable(false);
    bar->setFloatable(false);
    bar->setAllowedAreas(Qt::TopToolBarArea);
    bar->setIconSize(QSize(18, 18));
    bar->setToolButtonStyle(Qt::ToolButtonTextBesideIcon);
    auto action = [&](const QString &title, const QString &object_name, studio::ToolbarIcon icon,
                      const std::function<void()> &fn, bool icon_only = false) {
        auto a = bar->addAction(studio::toolbar_icon(icon, icon != studio::ToolbarIcon::AddDevice), title);
        a->setObjectName(object_name);
        auto button = qobject_cast<QToolButton *>(bar->widgetForAction(a));
        button->setObjectName(object_name + "Button");
        button->setToolButtonStyle(icon_only ? Qt::ToolButtonIconOnly : Qt::ToolButtonTextBesideIcon);
        button->setFixedHeight(32);
        button->setCursor(Qt::PointingHandCursor);
        button->setAccessibleName(title);
        connect(a, &QAction::triggered, this, fn);
        return a;
    };
    auto describe = [](QAction *a, const QString &description) {
        const auto shortcut = a->shortcut().toString(QKeySequence::NativeText);
        a->setToolTip(description + (shortcut.isEmpty() ? "" : " (" + shortcut + ")"));
        a->setStatusTip(description);
    };
    auto files = menuBar()->addMenu("&File");
    auto edits = menuBar()->addMenu("&Edit");
    auto views = menuBar()->addMenu("&View");
    auto agents = menuBar()->addMenu("&Agent");
    auto new_action = action(
        "New", "newProject", studio::ToolbarIcon::New,
        [this] {
            if (discard_allowed()) {
                topology_ = {};
                saved_ = {};
                database_path_.clear();
                undo_.clear();
                redo_.clear();
                rebuild();
            }
        },
        true);
    new_action->setShortcut(QKeySequence::New);
    describe(new_action, "New topology");
    files->addAction(new_action);
    auto open_action = action(
        "Open", "openProject", studio::ToolbarIcon::Open,
        [this] {
            if (!discard_allowed())
                return;
            const auto path =
                QFileDialog::getOpenFileName(this, "Open topology", {}, "LMTI topology (*.sqlite)");
            if (path.isEmpty())
                return;
            try {
                open_file(path);
            } catch (const std::exception &e) {
                report(e);
            }
        },
        true);
    open_action->setShortcut(QKeySequence::Open);
    describe(open_action, "Open topology");
    files->addAction(open_action);
    auto save_action =
        action("Save", "saveProject", studio::ToolbarIcon::Save, [this] { save_file(false); }, true);
    save_action->setShortcut(QKeySequence::Save);
    describe(save_action, "Save topology");
    files->addAction(save_action);
    files->addAction("Save &as…", QKeySequence::SaveAs, this, [this] { save_file(true); });
    bar->addSeparator();
    auto add = action("Add device", "addAsset", studio::ToolbarIcon::AddDevice, [this] { add_asset(); });
    bar->widgetForAction(add)->setProperty("emphasis", "primary");
    describe(add, "Add a device to the topology");
    edits->addAction(add);
    auto link = action("Declare connection", "connectAssets", studio::ToolbarIcon::Connect,
                       [this] { connect_assets(); });
    describe(link, "Declare a connection between two devices");
    edits->addAction(link);
    auto remove =
        action("Delete", "deleteAssets", studio::ToolbarIcon::Delete, [this] { delete_selected(); }, true);
    bar->widgetForAction(remove)->setProperty("emphasis", "danger");
    remove->setShortcut(QKeySequence::Delete);
    describe(remove, "Delete selected devices and their connections");
    edits->addAction(remove);
    edits->addSeparator();
    bar->addSeparator();
    auto undo = action(
        "Undo", "undoEdit", studio::ToolbarIcon::Undo,
        [this] {
            if (undo_.empty())
                return;
            redo_.push_back(topology_);
            topology_ = undo_.back();
            undo_.pop_back();
            rebuild();
        },
        true);
    undo->setShortcut(QKeySequence::Undo);
    describe(undo, "Undo last edit");
    edits->addAction(undo);
    auto redo = action(
        "Redo", "redoEdit", studio::ToolbarIcon::Redo,
        [this] {
            if (redo_.empty())
                return;
            undo_.push_back(topology_);
            topology_ = redo_.back();
            redo_.pop_back();
            rebuild();
        },
        true);
    redo->setShortcut(QKeySequence::Redo);
    describe(redo, "Redo last edit");
    edits->addAction(redo);
    bar->addSeparator();
    auto fit = action(
        "Fit view", "fitCanvas", studio::ToolbarIcon::Fit,
        [this] {
            view_->fitInView(scene_->itemsBoundingRect().adjusted(-80, -80, 80, 80), Qt::KeepAspectRatio);
            update_zoom();
        },
        true);
    auto navigation = new QActionGroup(this);
    auto select = action(
        "Select", "selectCanvas", studio::ToolbarIcon::Select,
        [this] { view_->setDragMode(QGraphicsView::RubberBandDrag); }, true);
    select->setCheckable(true);
    select->setChecked(true);
    navigation->addAction(select);
    auto pan = action(
        "Pan", "panCanvas", studio::ToolbarIcon::Pan,
        [this] { view_->setDragMode(QGraphicsView::ScrollHandDrag); }, true);
    pan->setCheckable(true);
    navigation->addAction(pan);
    for (const auto &[caption, factor] : {std::pair{"Zoom out", 1.0 / 1.2}, std::pair{"Zoom in", 1.2}}) {
        auto zoom = action(
            caption, factor < 1 ? "zoomOutCanvas" : "zoomInCanvas",
            factor < 1 ? studio::ToolbarIcon::ZoomOut : studio::ToolbarIcon::ZoomIn,
            [this, factor] {
                const auto next = view_->transform().m11() * factor;
                if (next >= .15 && next <= 3)
                    view_->scale(factor, factor);
                update_zoom();
            },
            true);
        zoom->setToolTip(project_caption(caption));
        if (factor < 1) {
            zoom_label_ = studio::caption("100%");
            zoom_label_->setProperty("verbatim", true);
            zoom_label_->setObjectName("topologyZoom");
            bar->addWidget(zoom_label_);
        }
    }
    static_cast<Canvas *>(view_)->changed = [this] { update_zoom(); };
    describe(fit, "Fit the entire topology in the canvas");
    views->addAction(fit);
    auto spacer = new QWidget(bar);
    spacer->setObjectName("architectureToolbarSpacer");
    spacer->setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Preferred);
    bar->addWidget(spacer);
    auto review =
        action("Review proposal", "reviewProposal", studio::ToolbarIcon::Review, [this] { read_proposal(); });
    bar->widgetForAction(review)->setProperty("emphasis", "secondary");
    agents->addAction(review);
    if (document) {
        files->menuAction()->setVisible(false);
        agents->menuAction()->setVisible(false);
        for (auto a : {new_action, open_action, save_action, undo, redo, review}) {
            a->setVisible(false);
            a->setEnabled(false);
            a->setShortcut({});
        }
    }

    auto inventory = new QDockWidget("DEVICE INVENTORY", this);
    inventory->setAllowedAreas(Qt::LeftDockWidgetArea | Qt::RightDockWidgetArea);
    auto inventory_body = new QWidget;
    auto il = new QVBoxLayout(inventory_body);
    filter_ = new QLineEdit;
    filter_->setPlaceholderText("Filter by device or site");
    il->addWidget(filter_);
    tree_ = new QTreeWidget;
    tree_->setObjectName("assetInventory");
    tree_->setHeaderLabels({"Asset / site", "Kind"});
    tree_->setMinimumWidth(245);
    tree_->header()->setSectionResizeMode(0, QHeaderView::Stretch);
    il->addWidget(tree_);
    inventory->setWidget(inventory_body);
    addDockWidget(Qt::LeftDockWidgetArea, inventory);
    connect(filter_, &QLineEdit::textChanged, this, [this](const QString &query) {
        for (int i = 0; i < tree_->topLevelItemCount(); ++i) {
            auto item = tree_->topLevelItem(i);
            item->setHidden(!(item->text(0) + item->data(0, Qt::UserRole).toString())
                                 .contains(query, Qt::CaseInsensitive));
        }
    });
    connect(tree_, &QTreeWidget::itemSelectionChanged, this, [this] {
        if (rendering_)
            return;
        const auto selected = tree_->selectedItems();
        if (!selected.isEmpty())
            select_asset(selected.front()->data(0, Qt::UserRole).toString().toStdString());
    });

    auto inspector = new QDockWidget("Device details", this);
    inspector->setObjectName("topologyInspector");
    inspector->setFeatures(QDockWidget::NoDockWidgetFeatures);
    auto body = new QWidget;
    auto bl = new QVBoxLayout(body);
    auto form = new QFormLayout;
    id_ = new QLineEdit;
    id_->setReadOnly(true);
    id_->setObjectName("assetId");
    label_ = new QLineEdit;
    label_->setMaxLength(120);
    label_->setObjectName("assetLabel");
    site_ = new QLineEdit;
    site_->setMaxLength(64);
    site_->setObjectName("assetSite");
    kind_ = new studio::Choice;
    kind_->setObjectName("assetKind");
    QStringList kind_labels;
    for (const auto &kind : {"machine", "gateway", "broker", "service", "sensor"}) {
        kind_->addItem(studio::enum_caption(kind), kind);
        kind_labels << studio::enum_label(kind);
    }
    kind_->setProperty("uiChoices", kind_labels);
    privacy_ = new studio::Choice;
    privacy_->addItem(studio::enum_caption("internal"), "internal");
    privacy_->addItem(studio::enum_caption("public"), "public");
    privacy_->setProperty("uiChoices", QStringList{"Internal", "Public"});
    privacy_->setObjectName("assetPrivacy");
    poll_ = new studio::Number;
    poll_->setRange(100, 3600000);
    poll_->setSuffix(" ms");
    poll_->setObjectName("assetPoll");
    enabled_ = new QCheckBox("Desired enabled");
    enabled_->setObjectName("assetEnabled");
    form->addRow("ID", id_);
    form->addRow("Name", label_);
    form->addRow("Site", site_);
    form->addRow("Type", kind_);
    form->addRow("Visibility", privacy_);
    form->addRow("Poll interval", poll_);
    form->addRow(enabled_);
    bl->addLayout(form);
    auto apply = new QPushButton("Apply configuration");
    apply->setObjectName("applyAsset");
    connect(apply, &QPushButton::clicked, this, [this] { apply_fields(); });
    bl->addWidget(apply);
    observation_ = new QLabel;
    observation_->setTextFormat(Qt::PlainText);
    observation_->setWordWrap(true);
    bl->addWidget(observation_);
    auto note = new QLabel("Connections describe architecture. Device telemetry and remote execution are not "
                           "connected in this local MVP.");
    note->setTextFormat(Qt::PlainText);
    note->setWordWrap(true);
    bl->addWidget(note);
    bl->addStretch();
    inspector->setWidget(body);
    inspector->setMinimumWidth(295);
    addDockWidget(Qt::RightDockWidgetArea, inspector);
    auto legend = new QWidget(this);
    auto legend_layout = new QHBoxLayout(legend);
    legend_layout->setContentsMargins(12, 4, 12, 4);
    for (const auto kind : {lmti::Kind::Sensor, lmti::Kind::Machine, lmti::Kind::Gateway, lmti::Kind::Broker,
                            lmti::Kind::Service}) {
        auto marker = new QLabel("●");
        marker->setStyleSheet("color:" + color(kind).name() + ";background:transparent;");
        legend_layout->addWidget(marker);
        legend_layout->addWidget(studio::caption(studio::enum_label(s(lmti::name(kind)))));
    }
    legend_layout->addWidget(studio::caption("→ Declared connection", "muted"));
    legend_layout->addStretch();
    topology_count_ = new QLabel;
    topology_count_->setObjectName("topologyCount");
    topology_count_->setTextFormat(Qt::PlainText);
    topology_count_->setProperty("verbatim", true);
    auto canvas_body = new QWidget;
    auto canvas_layout = new QVBoxLayout(canvas_body);
    canvas_layout->setContentsMargins(0, 0, 0, 0);
    canvas_layout->setSpacing(4);
    canvas_layout->addWidget(view_, 1);
    canvas_layout->addWidget(legend);
    canvas_layout->addWidget(topology_count_);
    setCentralWidget(canvas_body);

    auto agent = new QDockWidget("AGENT CONTEXT · PUBLIC METADATA", this);
    auto agent_body = new QWidget;
    auto al = new QVBoxLayout(agent_body);
    context_site_ = new studio::Choice;
    context_site_->setObjectName("contextSite");
    al->addWidget(context_site_);
    auto show_payload = new QPushButton("Show Agent payload");
    show_payload->setCheckable(true);
    al->addWidget(show_payload);
    context_summary_ = new QPlainTextEdit;
    context_summary_->setReadOnly(true);
    context_summary_->setObjectName("contextSummary");
    al->addWidget(context_summary_);
    context_ = new QPlainTextEdit;
    context_->setObjectName("agentContext");
    context_->setReadOnly(true);
    context_->setMaximumBlockCount(3000);
    al->addWidget(context_);
    context_->hide();
    connect(show_payload, &QPushButton::toggled, this, [this](bool checked) {
        context_->setVisible(checked);
        context_summary_->setVisible(!checked);
    });
    agent->setWidget(agent_body);
    agent->setMinimumHeight(205);
    addDockWidget(Qt::BottomDockWidgetArea, agent);
    if (document) {
        inventory->hide();
        agent->hide();
        menuBar()->hide();
    }
    connect(context_site_, &QComboBox::currentTextChanged, this, [this] { update_context(); });
    connect(scene_, &QGraphicsScene::selectionChanged, this, [this] {
        if (!rendering_)
            inspect();
    });
    setStyleSheet(studio::theme() +
                  QStringLiteral("QToolBar#architectureToolbar{background:white;border:1px solid "
                                 "#dce3eb;padding:8px;spacing:6px;} "
                                 "QDockWidget::title{background:white;color:#202a3a;padding:12px;} "
                                 "QToolButton[emphasis=primary]{background:#3563e9;color:white;} "
                                 "QSpinBox{background:white;border:1px solid #dce3eb;padding:9px;}"));
    capture_project_captions(this);
    apply_project_captions(this);
    rebuild();
    select_asset("machine-a");
    QTimer::singleShot(0, this, [this] {
        view_->fitInView(scene_->itemsBoundingRect().adjusted(-80, -80, 80, 80), Qt::KeepAspectRatio);
        update_zoom();
    });
    statusBar()->showMessage(
        document ? "Project topology · declarations only · no device execution"
                 : "Demo architecture · save a .sqlite file to share with your Agent · observations unknown");
}
Window::~Window() {
    // Scene teardown can emit selectionChanged after toolbar children are gone.
    rendering_ = true;
    disconnect(scene_, nullptr, this, nullptr);
}
void Window::report(const std::exception &e) {
    QMessageBox::warning(this, "LMTI", QString::fromUtf8(e.what()));
}
void Window::edit(const std::function<void(lmti::Topology &)> &operation) {
    auto next = topology_;
    operation(next);
    lmti::validate(next);
    if (next == topology_)
        return;
    if (commit_topology) {
        commit_topology(next);
        rebuild();
        return;
    }
    if (undo_.size() == 20)
        undo_.erase(undo_.begin());
    undo_.push_back(topology_);
    redo_.clear();
    topology_ = std::move(next);
    rebuild();
}
void Window::update_title() {
    setWindowTitle(
        "LMTI Architecture Studio · " +
        (database_path_.isEmpty() ? QString("Unsaved topology") : QFileInfo(database_path_).fileName()) +
        (topology_ == saved_ ? "" : " *"));
    update_toolbar();
}
void Window::update_toolbar() {
    findChild<QAction *>("undoEdit")->setEnabled(!undo_.empty());
    findChild<QAction *>("redoEdit")->setEnabled(!redo_.empty());
    findChild<QAction *>("deleteAssets")->setEnabled(!scene_->selectedItems().isEmpty());
    findChild<QAction *>("connectAssets")->setEnabled(topology_.assets.size() >= 2);
    findChild<QAction *>("fitCanvas")->setEnabled(!topology_.assets.empty());
    auto review = findChild<QAction *>("reviewProposal");
    const bool saved = !database_path_.isEmpty() && topology_ == saved_;
    review->setEnabled(saved);
    const auto description = saved ? "Review an Agent proposal before applying changes"
                                   : "Save the topology before reviewing an Agent proposal";
    review->setToolTip(description);
    review->setStatusTip(description);
    const bool one =
        scene_->selectedItems().size() == 1 && dynamic_cast<NodeItem *>(scene_->selectedItems().front());
    for (auto field : std::vector<QWidget *>{label_, site_, kind_, privacy_, poll_, enabled_})
        field->setEnabled(one);
    findChild<QPushButton *>("applyAsset")->setEnabled(one);
}
void Window::update_zoom() {
    zoom_label_->setText(QString::number(qRound(view_->transform().m11() * 100)) + "%");
    const auto scale = std::max(.01, std::abs(view_->transform().m11()));
    for (auto item : edges_)
        if (auto label = dynamic_cast<QGraphicsSimpleTextItem *>(item)) {
            const auto center = label->data(30).toPointF();
            label->setPos(center - QPointF(label->boundingRect().width() / (2 * scale),
                                           (label->boundingRect().height() + 4) / scale));
        }
}
void Window::draw_edges() {
    for (auto item : edges_) {
        scene_->removeItem(item);
        delete item;
    }
    edges_.clear();
    for (const auto &l : topology_.links) {
        auto start = nodes_.at(l.from)->pos() + QPointF(220, 58);
        auto end = nodes_.at(l.to)->pos() + QPointF(0, 58);
        QPainterPath path(start);
        const auto offset = std::max(60.0, std::abs(end.x() - start.x()) / 2);
        path.cubicTo(start + QPointF(offset, 0), end - QPointF(offset, 0), end);
        auto directed = studio::directed_edge(scene_, path, QColor("#607c95"), Qt::SolidLine, "connection",
                                              s(l.from), s(l.to));
        edges_.insert(edges_.end(), directed.begin(), directed.end());
        auto label = scene_->addSimpleText(s(lmti::name(l.protocol)) + " →");
        auto font = view_->font();
        font.setPixelSize(11);
        label->setFont(font);
        label->setFlag(QGraphicsItem::ItemIgnoresTransformations);
        label->setData(30, path.pointAtPercent(.5));
        label->setBrush(QColor("#526581"));
        label->setPos(path.pointAtPercent(0.5) + QPointF(-25, -20));
        edges_.push_back(label);
    }
    update_zoom();
}
void Window::rebuild() {
    const auto selected = id_->text().toStdString();
    rendering_ = true;
    edges_.clear();
    nodes_.clear();
    scene_->clear();
    tree_->clear();
    for (const auto &a : topology_.assets) {
        auto item = new NodeItem(a);
        scene_->addItem(item);
        nodes_[a.id] = item;
        item->moved = [this] {
            if (!rendering_)
                draw_edges();
        };
        item->released = [this](const std::string &, QPointF) {
            // Commit the whole selection's movement once, after the drag ends.
            auto next = topology_;
            for (auto &asset : next.assets) {
                const auto p = nodes_.at(asset.id)->pos();
                asset.x = p.x();
                asset.y = p.y();
            }
            lmti::validate(next);
            if (next != topology_) {
                if (commit_topology) {
                    commit_topology(next);
                    update_title();
                    update_context();
                    return;
                }
                if (undo_.size() == 20)
                    undo_.erase(undo_.begin());
                undo_.push_back(topology_);
                redo_.clear();
                topology_ = std::move(next);
                update_title();
                update_context();
            }
        };
        auto row = new QTreeWidgetItem(tree_, {s(a.label) + "\n" + s(a.site), s(lmti::name(a.kind))});
        row->setData(0, Qt::UserRole, s(a.id));
        row->setHidden(!(row->text(0) + s(a.id)).contains(filter_->text(), Qt::CaseInsensitive));
    }
    draw_edges();
    topology_count_->setText(project_caption("%1 devices · %2 declared connections · no live telemetry")
                                 .arg(topology_.assets.size())
                                 .arg(topology_.links.size()));
    const auto current = context_site_->currentText();
    {
        QSignalBlocker blocker(context_site_);
        context_site_->clear();
        std::set<std::string> sites;
        for (const auto &a : topology_.assets)
            sites.insert(a.site);
        for (const auto &site : sites)
            context_site_->addItem(s(site));
        if (context_site_->findText(current) >= 0)
            context_site_->setCurrentText(current);
    }
    rendering_ = false;
    if (nodes_.contains(selected))
        select_asset(selected);
    else {
        id_->clear();
        label_->clear();
        site_->clear();
        observation_->setText(project_caption("Select a device to inspect its configuration."));
    }
    update_context();
    update_title();
}
void Window::inspect() {
    update_toolbar();
    const auto selected = scene_->selectedItems();
    if (selected.size() != 1) {
        id_->clear();
        label_->clear();
        site_->clear();
        observation_->setText(project_caption("Select a device to inspect its configuration."));
        return;
    }
    auto node = dynamic_cast<NodeItem *>(selected.front());
    if (!node)
        return;
    const auto &a = lmti::find_asset(topology_, node->asset.id);
    id_->setText(s(a.id));
    label_->setText(s(a.label));
    site_->setText(s(a.site));
    kind_->setCurrentIndex(kind_->findData(s(lmti::name(a.kind))));
    privacy_->setCurrentIndex(privacy_->findData(s(lmti::name(a.privacy))));
    poll_->setValue(a.poll_ms);
    enabled_->setChecked(a.enabled);
    observation_->setText(
        a.observed == lmti::Observation::Unknown
            ? project_caption("Observed: Unknown\nNo device observations have been received.")
            : project_caption("Observed: %1\nTimestamp: %2 UTC epoch seconds (may be stale).")
                  .arg(studio::enum_caption(s(lmti::name(a.observed))), QString::number(a.observed_at)));
}
void Window::select_asset(const std::string &id) {
    if (!nodes_.contains(id))
        return;
    rendering_ = true;
    scene_->clearSelection();
    nodes_.at(id)->setSelected(true);
    rendering_ = false;
    inspect();
}
void Window::refresh_document() {
    undo_.clear();
    redo_.clear();
    rebuild();
}
void Window::retranslate() {
    apply_project_captions(this);
    findChild<QDockWidget *>("topologyInspector")->setWindowTitle(project_caption("Device details"));
    topology_count_->setText(project_caption("%1 devices · %2 declared connections · no live telemetry")
                                 .arg(topology_.assets.size())
                                 .arg(topology_.links.size()));
    inspect();
    scene_->update();
    statusBar()->showMessage(project_caption(
        &topology_ == &owned_topology_
            ? "Demo architecture · save a .sqlite file to share with your Agent · observations unknown"
            : "Project topology · declarations only · no device execution"));
}
void Window::add_asset() {
    const auto id = "device-" + QUuid::createUuid().toString(QUuid::Id128).toStdString();
    try {
        edit([&](auto &t) {
            lmti::Asset a;
            a.id = id;
            a.label = "New machine";
            a.site = context_site_->currentText().isEmpty()
                         ? (commit_topology ? "project-local" : "factory-demo")
                         : context_site_->currentText().toStdString();
            a.x = view_->mapToScene(view_->viewport()->rect().center()).x();
            a.y = view_->mapToScene(view_->viewport()->rect().center()).y();
            t.assets.push_back(a);
        });
        select_asset(id);
    } catch (const std::exception &e) {
        report(e);
    }
}
void Window::apply_fields() {
    if (id_->text().isEmpty())
        return;
    const auto id = id_->text().toStdString();
    try {
        edit([&](auto &t) {
            for (auto &a : t.assets)
                if (a.id == id) {
                    a.label = label_->text().trimmed().toStdString();
                    a.site = site_->text().trimmed().toStdString();
                    a.kind = lmti::parse_kind(kind_->currentData().toString().toStdString());
                    a.privacy = lmti::parse_privacy(privacy_->currentData().toString().toStdString());
                    a.poll_ms = poll_->value();
                    a.enabled = enabled_->isChecked();
                }
        });
    } catch (const std::exception &e) {
        report(e);
    }
}
void Window::connect_assets() {
    if (topology_.assets.size() < 2)
        return;
    QDialog dialog(this);
    dialog.setWindowTitle("Declare a connection");
    auto layout = new QFormLayout(&dialog);
    studio::Choice from, to, protocol;
    for (const auto &a : topology_.assets) {
        from.addItem(s(a.label), s(a.id));
        to.addItem(s(a.label), s(a.id));
    }
    to.setCurrentIndex(1);
    auto selected = scene_->selectedItems();
    if (selected.size() == 2) {
        auto first = dynamic_cast<NodeItem *>(selected[0]);
        auto second = dynamic_cast<NodeItem *>(selected[1]);
        if (first && second) {
            from.setCurrentIndex(from.findData(s(first->asset.id)));
            to.setCurrentIndex(to.findData(s(second->asset.id)));
        }
    }
    protocol.addItems({"dependency", "mqtt", "opcua", "modbus-tcp"});
    layout->addRow("Source", &from);
    layout->addRow("Target", &to);
    layout->addRow("Protocol", &protocol);
    QDialogButtonBox buttons(QDialogButtonBox::Ok | QDialogButtonBox::Cancel);
    layout->addRow(&buttons);
    connect(&buttons, &QDialogButtonBox::accepted, &dialog, &QDialog::accept);
    connect(&buttons, &QDialogButtonBox::rejected, &dialog, &QDialog::reject);
    if (dialog.exec() != QDialog::Accepted)
        return;
    try {
        edit([&](auto &t) {
            t.links.push_back({"link-" + QUuid::createUuid().toString(QUuid::Id128).toStdString(),
                               from.currentData().toString().toStdString(),
                               to.currentData().toString().toStdString(),
                               lmti::parse_protocol(protocol.currentText().toStdString())});
        });
    } catch (const std::exception &e) {
        report(e);
    }
}
void Window::delete_selected() {
    std::set<std::string> ids;
    for (auto item : scene_->selectedItems())
        if (auto node = dynamic_cast<NodeItem *>(item))
            ids.insert(node->asset.id);
    if (ids.empty())
        return;
    try {
        edit([&](auto &t) {
            std::erase_if(t.links, [&](const auto &l) { return ids.contains(l.from) || ids.contains(l.to); });
            std::erase_if(t.assets, [&](const auto &a) { return ids.contains(a.id); });
        });
    } catch (const std::exception &e) {
        report(e);
    }
}
void Window::update_context() {
    lmti::ReadResult result;
    result.topology.revision = topology_.revision;
    const auto site = context_site_->currentText().toStdString();
    std::set<std::string> ids;
    for (const auto &a : topology_.assets)
        if (a.site == site && a.privacy == lmti::Privacy::Public) {
            if (result.topology.assets.size() == 200) {
                result.truncated = true;
                break;
            }
            result.topology.assets.push_back(a);
            ids.insert(a.id);
        }
    for (const auto &l : topology_.links)
        if (ids.contains(l.from) && ids.contains(l.to)) {
            if (result.topology.links.size() == lmti::max_context_links) {
                result.truncated = true;
                break;
            }
            result.topology.links.push_back(l);
        }
    context_->setPlainText(
        QString::fromUtf8(QJsonDocument(lmti::context_json(result)).toJson(QJsonDocument::Indented)));
    QString summary =
        "Site: " + s(site) + " · Revision: " +
        (topology_.revision == 0 ? QString("not saved") : QString::number(topology_.revision)) + "\n" +
        QString::number(result.topology.assets.size()) + " public assets · " +
        QString::number(result.topology.links.size()) + " declared connections" +
        (result.truncated ? " · context truncated" : "") +
        "\n\nAgent receives only public metadata for this site. No device actions are granted.\n";
    for (const auto &a : result.topology.assets)
        summary += "\n" + s(a.label) + " [" + s(a.id) + "] · " + s(lmti::name(a.kind)) + " · desired " +
                   (a.enabled ? "enabled" : "disabled") + " / " + QString::number(a.poll_ms) +
                   " ms · observed " + s(lmti::name(a.observed));
    summary += "\n\nDeclared connections:\n";
    for (const auto &link : result.topology.links)
        summary += s(link.from) + " → " + s(link.to) + " [" + s(lmti::name(link.protocol)) + "]\n";
    if (topology_ != saved_)
        summary += "\nDocument has unsaved changes. The SDK reads the last saved database revision.";
    context_summary_->setPlainText(summary);
}
bool Window::discard_allowed() {
    if (topology_ == saved_)
        return true;
    const auto answer = QMessageBox::question(
        this, "Unsaved architecture", "Save your changes before continuing?",
        QMessageBox::Save | QMessageBox::Discard | QMessageBox::Cancel, QMessageBox::Save);
    if (answer == QMessageBox::Cancel)
        return false;
    if (answer == QMessageBox::Discard)
        return true;
    save_file(false);
    return topology_ == saved_;
}
void Window::open_file(const QString &path) {
    auto next = lmti::load(path);
    topology_ = std::move(next);
    saved_ = topology_;
    database_path_ = QFileInfo(path).absoluteFilePath();
    undo_.clear();
    redo_.clear();
    rebuild();
    view_->fitInView(scene_->itemsBoundingRect().adjusted(-100, -100, 100, 100), Qt::KeepAspectRatio);
    update_zoom();
}
void Window::save_to(const QString &path) {
    auto next = topology_;
    const auto absolute = QFileInfo(path).absoluteFilePath();
    if (absolute != database_path_) {
        if (QFileInfo::exists(absolute))
            throw lmti::Error("Open an existing topology before editing it; Save as requires a new file.");
        next.revision = 0;
    }
    lmti::canonicalize(next);
    next.revision = lmti::save(absolute, next);
    topology_ = std::move(next);
    saved_ = topology_;
    database_path_ = absolute;
    undo_.clear();
    redo_.clear();
    update_title();
    update_context();
    statusBar()->showMessage("Saved revision " + QString::number(topology_.revision) + " · " +
                             database_path_);
}
void Window::save_file(bool save_as) {
    auto path = database_path_;
    if (save_as || path.isEmpty())
        path = QFileDialog::getSaveFileName(this, "Save topology", {}, "LMTI topology (*.sqlite)");
    if (path.isEmpty())
        return;
    if (!path.endsWith(".sqlite", Qt::CaseInsensitive))
        path += ".sqlite";
    try {
        save_to(path);
    } catch (const std::exception &e) {
        report(e);
    }
}
void Window::apply_checked_proposal(const lmti::ConfigProposal &proposal) {
    if (database_path_.isEmpty() || topology_ != saved_)
        throw lmti::Error("Save or reopen the topology before reviewing an Agent proposal.");
    auto next = lmti::apply_proposal(topology_, proposal);
    edit([&](auto &t) { t = next; });
    select_asset(proposal.asset_id);
}
void Window::read_proposal() {
    const auto path = QFileDialog::getOpenFileName(this, "Review Agent configuration proposal", {},
                                                   "LMTI proposal (*.json)");
    if (path.isEmpty())
        return;
    try {
        QFile file(path);
        if (file.size() > 4096 || !file.open(QIODevice::ReadOnly))
            throw lmti::Error("Cannot read bounded proposal file.");
        const auto bytes = file.read(4097);
        if (bytes.size() > 4096)
            throw lmti::Error("Proposal exceeds size limit.");
        QJsonParseError parse_error;
        const auto doc = QJsonDocument::fromJson(bytes, &parse_error);
        if (parse_error.error != QJsonParseError::NoError || !doc.isObject())
            throw lmti::Error("Invalid proposal JSON.");
        const auto p = lmti::parse_proposal(doc.object());
        if (database_path_.isEmpty() || topology_ != saved_)
            throw lmti::Error("Save the topology before reviewing proposals.");
        lmti::apply_proposal(topology_, p);
        const auto text =
            "Device: " + s(p.asset_id) + "\nSite: " + s(p.site) +
            "\nSaved revision: " + QString::number(p.base_revision) +
            "\nPoll interval: " + QString::number(p.expected_poll_ms) + " → " +
            QString::number(p.desired_poll_ms) +
            " ms\nEnabled: " + QString(p.expected_enabled ? "yes" : "no") + " → " +
            QString(p.desired_enabled ? "yes" : "no") +
            "\n\nApply to this architecture? Save afterward to commit. No device command will be sent.";
        QMessageBox box(QMessageBox::Question, "Review Agent proposal", text,
                        QMessageBox::Apply | QMessageBox::Cancel, this);
        box.setTextFormat(Qt::PlainText);
        box.setDefaultButton(QMessageBox::Cancel);
        if (box.exec() == QMessageBox::Apply)
            apply_checked_proposal(p);
    } catch (const std::exception &e) {
        report(e);
    }
}
void Window::closeEvent(QCloseEvent *e) {
    if (discard_allowed())
        e->accept();
    else
        e->ignore();
}
