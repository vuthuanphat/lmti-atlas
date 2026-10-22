#pragma once
#include "project_captions.hpp"
#include "toolbar_icons.hpp"
#include <QApplication>
#include <QButtonGroup>
#include <QCheckBox>
#include <QComboBox>
#include <QEvent>
#include <QFrame>
#include <QHBoxLayout>
#include <QHeaderView>
#include <QLabel>
#include <QPainter>
#include <QPainterPath>
#include <QPushButton>
#include <QSpinBox>
#include <QStyleOptionButton>
#include <QStyleOptionSpinBox>
#include <QStyledItemDelegate>
#include <QTreeWidget>
#include <QVBoxLayout>
#include <algorithm>

namespace studio {
class EmptyTreeState final : public QLabel {
    void fit_viewport() {
        auto area = parentWidget()->rect().adjusted(16, 16, -16, -16);
        area.setWidth(std::max(0, area.width()));
        area.setHeight(std::max(0, area.height()));
        setGeometry(area);
    }

  public:
    explicit EmptyTreeState(QTreeWidget *tree) : QLabel(tree->viewport()) {
        setObjectName("tableEmptyState");
        setTextFormat(Qt::PlainText);
        setWordWrap(true);
        setAlignment(Qt::AlignCenter);
        setAttribute(Qt::WA_TransparentForMouseEvents);
        setStyleSheet("background:transparent;color:#64748b;font-size:13px;");
        parentWidget()->installEventFilter(this);
        fit_viewport();
        hide();
    }

  protected:
    bool eventFilter(QObject *object, QEvent *event) override {
        if (object == parentWidget() && event->type() == QEvent::Resize)
            fit_viewport();
        return QLabel::eventFilter(object, event);
    }
};
class WrapCheckBox final : public QCheckBox {
    int text_offset() const {
        return style()->pixelMetric(QStyle::PM_IndicatorWidth, nullptr, this) +
               style()->pixelMetric(QStyle::PM_CheckBoxLabelSpacing, nullptr, this);
    }

  public:
    explicit WrapCheckBox(const QString &text, QWidget *parent = nullptr) : QCheckBox(text, parent) {
        QSizePolicy policy(QSizePolicy::Preferred, QSizePolicy::Minimum);
        policy.setHeightForWidth(true);
        setSizePolicy(policy);
    }
    bool hasHeightForWidth() const override {
        return true;
    }
    int heightForWidth(int width) const override {
        const auto text_height = fontMetrics()
                                     .boundingRect(QRect(0, 0, std::max(40, width - text_offset() - 2), 1000),
                                                   Qt::TextWordWrap, text())
                                     .height();
        return std::max(text_height, style()->pixelMetric(QStyle::PM_IndicatorHeight, nullptr, this)) + 4;
    }
    QSize sizeHint() const override {
        const auto width = std::min(280, QCheckBox::sizeHint().width());
        return QSize(width, heightForWidth(width));
    }
    QSize minimumSizeHint() const override {
        return QSize(40, fontMetrics().height() + 4);
    }

  protected:
    bool hitButton(const QPoint &point) const override {
        return rect().contains(point);
    }
    void paintEvent(QPaintEvent *) override {
        QStyleOptionButton option;
        initStyleOption(&option);
        option.text.clear();
        QPainter painter(this);
        style()->drawControl(QStyle::CE_CheckBox, &option, &painter, this);
        painter.setPen(
            palette().color(isEnabled() ? QPalette::Active : QPalette::Disabled, QPalette::WindowText));
        painter.drawText(rect().adjusted(text_offset(), 2, -2, -2),
                         Qt::AlignLeft | Qt::AlignVCenter | Qt::TextWordWrap, text());
    }
};
class ActionButton final : public QPushButton {
  public:
    using QPushButton::QPushButton;
    bool hasHeightForWidth() const override {
        return true;
    }
    int heightForWidth(int width) const override {
        return std::max(
            38, fontMetrics()
                        .boundingRect(QRect(0, 0, std::max(40, width - 16), 1000), Qt::TextWordWrap, text())
                        .height() +
                    18);
    }
    QSize sizeHint() const override {
        return QSize(std::min(180, QPushButton::sizeHint().width()), heightForWidth(180));
    }
    QSize minimumSizeHint() const override {
        return QSize(40, 38);
    }

  protected:
    void paintEvent(QPaintEvent *) override {
        QStyleOptionButton option;
        initStyleOption(&option);
        option.text.clear();
        QPainter painter(this);
        style()->drawControl(QStyle::CE_PushButton, &option, &painter, this);
        painter.setPen(
            palette().color(isEnabled() ? QPalette::Active : QPalette::Disabled, QPalette::ButtonText));
        painter.drawText(rect().adjusted(8, 7, -8, -7), Qt::AlignCenter | Qt::TextWordWrap, text());
    }
};
class Number final : public QSpinBox {
  public:
    using QSpinBox::QSpinBox;

  protected:
    void paintEvent(QPaintEvent *event) override {
        QSpinBox::paintEvent(event);
        QStyleOptionSpinBox option;
        initStyleOption(&option);
        QPainter painter(this);
        painter.setRenderHint(QPainter::Antialiasing);
        for (const auto control : {QStyle::SC_SpinBoxUp, QStyle::SC_SpinBoxDown}) {
            const auto rectangle = style()->subControlRect(QStyle::CC_SpinBox, &option, control, this);
            if (rectangle.isEmpty())
                continue;
            const auto center = QPointF(rectangle.center());
            const auto direction = control == QStyle::SC_SpinBoxUp ? -1.0 : 1.0;
            const bool active =
                isEnabled() &&
                (stepEnabled() & (control == QStyle::SC_SpinBoxUp ? StepUpEnabled : StepDownEnabled));
            painter.setPen(
                QPen(palette().color(active ? QPalette::Active : QPalette::Disabled, QPalette::Text), 1.4,
                     Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
            QPainterPath arrow;
            arrow.moveTo(center + QPointF(-3, -direction));
            arrow.lineTo(center + QPointF(0, direction * 2));
            arrow.lineTo(center + QPointF(3, -direction));
            painter.drawPath(arrow);
        }
    }
};
class Choice final : public QComboBox {
  public:
    using QComboBox::QComboBox;

  protected:
    void paintEvent(QPaintEvent *event) override {
        QComboBox::paintEvent(event);
        // QSS may suppress the base style's arrow on Windows. Keep the affordance
        // explicit while retaining native popup, keyboard and accessibility behavior.
        QPainter painter(this);
        painter.setRenderHint(QPainter::Antialiasing);
        painter.setPen(
            QPen(palette().color(isEnabled() ? QPalette::Active : QPalette::Disabled, QPalette::Text), 1.6,
                 Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
        const auto center = QPointF(width() - 14, height() / 2.0);
        QPainterPath arrow;
        arrow.moveTo(center + QPointF(-4, -2));
        arrow.lineTo(center + QPointF(0, 2));
        arrow.lineTo(center + QPointF(4, -2));
        painter.drawPath(arrow);
    }
};
inline QFrame *segments(QComboBox *controller, const QString &prefix, std::initializer_list<int> order) {
    auto result = new QFrame;
    result->setProperty("segmented", true);
    result->setObjectName(prefix);
    auto layout = new QHBoxLayout(result);
    layout->setContentsMargins(2, 2, 2, 2);
    layout->setSpacing(0);
    auto group = new QButtonGroup(result);
    for (const int index : order) {
        auto button = new QPushButton(controller->itemText(index));
        button->setProperty("uiCaption", project_ui_source(controller->itemText(index)));
        button->setProperty("segment", true);
        button->setObjectName(prefix + QString::number(index));
        button->setCheckable(true);
        group->addButton(button, index);
        button->setChecked(controller->currentIndex() == index);
        layout->addWidget(button);
    }
    QObject::connect(group, &QButtonGroup::idClicked, controller,
                     [controller](int index) { controller->setCurrentIndex(index); });
    QObject::connect(controller, &QComboBox::currentIndexChanged, result, [group](int index) {
        if (auto button = group->button(index))
            button->setChecked(true);
    });
    controller->hide();
    return result;
}
inline QLabel *caption(const QString &text, const QString &name = {}) {
    auto result = new QLabel(project_caption(text));
    result->setTextFormat(Qt::PlainText);
    result->setWordWrap(true);
    result->setObjectName(name);
    result->setProperty("uiCaption", text);
    return result;
}
inline QFrame *panel(const QString &title, QVBoxLayout **layout = nullptr, bool compact = false) {
    auto result = new QFrame;
    result->setProperty("panel", true);
    auto body = new QVBoxLayout(result);
    const auto margin = compact ? 12 : 18;
    body->setContentsMargins(margin, margin, margin, margin);
    body->setSpacing(compact ? 6 : 12);
    if (!title.isEmpty())
        body->addWidget(caption(title, "sectionTitle"));
    if (layout)
        *layout = body;
    return result;
}
// Plain metadata is painted as text, never interpreted as HTML. Badge roles are
// supplied explicitly by presentation code, not inferred from user-authored text.
inline constexpr int badge_role = Qt::UserRole + 20;
inline constexpr int filter_values_role = Qt::UserRole + 50;
inline QString enum_label(const QString &key) {
    static const QHash<QString, QString> labels{{"todo", "To do"},
                                                {"in-progress", "In progress"},
                                                {"review", "Review"},
                                                {"done", "Done"},
                                                {"blocked", "Blocked"},
                                                {"draft", "Draft"},
                                                {"candidate", "Candidate"},
                                                {"approved", "Approved"},
                                                {"archived", "Archived"},
                                                {"pending", "Pending"},
                                                {"rejected", "Rejected"},
                                                {"passed", "Passed"},
                                                {"failed", "Failed"},
                                                {"operator-declared", "Operator declared"},
                                                {"public", "Public"},
                                                {"internal", "Internal"},
                                                {"firmware", "Firmware"},
                                                {"gateway", "Gateway"},
                                                {"backend", "Backend"},
                                                {"desktop", "Desktop"},
                                                {"driver", "Driver"},
                                                {"library", "Library"},
                                                {"task", "Task"},
                                                {"bug", "Bug"},
                                                {"integration", "Integration"},
                                                {"validation", "Validation"},
                                                {"machine", "Machine"},
                                                {"broker", "Broker"},
                                                {"service", "Service"},
                                                {"sensor", "Sensor"},
                                                {"unknown", "Unknown"},
                                                {"modules", "Module"},
                                                {"files", "File"},
                                                {"architecture", "Architecture"},
                                                {"rules", "Rule"},
                                                {"summaries", "Summary"},
                                                {"component", "Component"},
                                                {"device", "Device"},
                                                {"repository", "Repository"},
                                                {"target", "Target"},
                                                {"binding", "Binding"},
                                                {"dependency", "Dependency"},
                                                {"release", "Release"},
                                                {"work", "Work item"},
                                                {"milestone", "Milestone"},
                                                {"verification", "Evidence"},
                                                {"knowledge", "Reference"}};
    return labels.value(key, key);
}
inline QString enum_caption(const QString &key) {
    return project_caption(enum_label(key));
}
inline constexpr int work_title_role = Qt::UserRole + 30;
inline constexpr int work_component_role = Qt::UserRole + 31;
inline constexpr int work_release_role = Qt::UserRole + 32;
inline constexpr int work_milestone_role = Qt::UserRole + 33;
inline constexpr int work_evidence_role = Qt::UserRole + 34;
// Keep the native item model and keyboard activation, while displaying linked
// records as compact two-line rows. Metadata is plain text.
class RelatedRecordDelegate final : public QStyledItemDelegate {
  public:
    explicit RelatedRecordDelegate(QObject *parent) : QStyledItemDelegate(parent) {}
    QSize sizeHint(const QStyleOptionViewItem &, const QModelIndex &) const override {
        return {180, 60};
    }
    void paint(QPainter *painter, const QStyleOptionViewItem &option,
               const QModelIndex &index) const override {
        painter->save();
        painter->setRenderHint(QPainter::Antialiasing);
        const auto card = option.rect.adjusted(1, 1, -1, -1);
        const bool selected = option.state & QStyle::State_Selected;
        const bool hovered = option.state & QStyle::State_MouseOver;
        painter->setPen(Qt::NoPen);
        painter->setBrush(selected || hovered ? QColor("#eef3ff") : Qt::white);
        painter->drawRoundedRect(card, 5, 5);
        painter->setPen(QColor("#eef1f6"));
        painter->drawLine(card.bottomLeft(), card.bottomRight());
        const auto kind = index.data(Qt::UserRole + 1).toString();
        const auto icon = kind == "device" || kind == "target"          ? ToolbarIcon::Hardware
                          : kind == "release"                           ? ToolbarIcon::Release
                          : kind == "work" || kind == "milestone"       ? ToolbarIcon::Work
                          : kind == "knowledge" || kind == "repository" ? ToolbarIcon::Knowledge
                          : kind == "verification"                      ? ToolbarIcon::Review
                                                                        : ToolbarIcon::Software;
        toolbar_icon(icon, true).paint(painter, QRect(card.left() + 8, card.top() + 17, 20, 20));
        auto font = option.font;
        font.setBold(true);
        painter->setFont(font);
        painter->setPen(QColor("#202a3a"));
        const auto text_bounds = card.adjusted(38, 7, -24, -27);
        painter->drawText(
            text_bounds, Qt::AlignVCenter,
            QFontMetrics(font).elidedText(index.data().toString(), Qt::ElideRight, text_bounds.width()));
        font.setBold(false);
        font.setPixelSize(12);
        painter->setFont(font);
        painter->setPen(QColor("#526581"));
        const auto detail = index.siblingAtColumn(1).data().toString();
        painter->drawText(card.adjusted(38, 31, -24, -7), Qt::AlignVCenter,
                          QFontMetrics(font).elidedText(detail, Qt::ElideRight, text_bounds.width()));
        painter->setPen(QPen(QColor("#526581"), 1.6, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
        const auto center = QPointF(card.right() - 12, card.center().y());
        QPainterPath arrow;
        arrow.moveTo(center + QPointF(-2, -4));
        arrow.lineTo(center + QPointF(2, 0));
        arrow.lineTo(center + QPointF(-2, 4));
        painter->drawPath(arrow);
        if (option.state & QStyle::State_HasFocus) {
            painter->setPen(QPen(QColor("#3563e9"), 1, Qt::DotLine));
            painter->setBrush(Qt::NoBrush);
            painter->drawRoundedRect(card.adjusted(3, 3, -3, -3), 3, 3);
        }
        painter->restore();
    }
};
class WorkCardDelegate final : public QStyledItemDelegate {
  public:
    explicit WorkCardDelegate(QObject *parent) : QStyledItemDelegate(parent) {}
    QSize sizeHint(const QStyleOptionViewItem &, const QModelIndex &) const override {
        return {180, 156};
    }
    void paint(QPainter *painter, const QStyleOptionViewItem &option,
               const QModelIndex &index) const override {
        painter->save();
        painter->setRenderHint(QPainter::Antialiasing);
        const auto card = option.rect.adjusted(6, 6, -6, -6);
        const bool selected = option.state & QStyle::State_Selected;
        painter->setPen(QPen(selected ? QColor("#3563e9") : QColor("#dce3eb"), selected ? 2 : 1));
        painter->setBrush(Qt::white);
        painter->drawRoundedRect(card, 6, 6);
        auto font = option.font;
        font.setBold(true);
        painter->setFont(font);
        painter->setPen(QColor("#202a3a"));
        const auto title = index.data(work_title_role).toString();
        painter->drawText(card.adjusted(12, 10, -12, -94), Qt::AlignTop | Qt::TextWordWrap, title);
        font.setBold(false);
        font.setPixelSize(12);
        painter->setFont(font);
        painter->setPen(QColor("#526581"));
        const auto component = index.data(work_component_role).toString();
        const auto version = index.data(work_release_role).toString();
        const auto milestone = index.data(work_milestone_role).toString();
        const auto metrics = QFontMetrics(font);
        painter->drawText(QRect(card.x() + 12, card.y() + 62, card.width() - 24, 20), Qt::AlignVCenter,
                          metrics.elidedText(component + (version.isEmpty() ? "" : " · " + version),
                                             Qt::ElideRight, card.width() - 24));
        painter->drawText(QRect(card.x() + 12, card.y() + 84, card.width() - 24, 20), Qt::AlignVCenter,
                          metrics.elidedText(milestone, Qt::ElideRight, card.width() - 24));
        const bool evidence = index.data(work_evidence_role).toBool();
        painter->setPen(evidence ? QColor("#2452d5") : QColor("#aa1c31"));
        painter->drawText(QRect(card.x() + 12, card.bottom() - 30, card.width() - 24, 20), Qt::AlignVCenter,
                          project_caption(evidence ? "Evidence recorded" : "Evidence missing"));
        painter->restore();
    }
};
class BadgeDelegate final : public QStyledItemDelegate {
  public:
    explicit BadgeDelegate(QObject *parent) : QStyledItemDelegate(parent) {}
    void paint(QPainter *painter, const QStyleOptionViewItem &option,
               const QModelIndex &index) const override {
        const auto key = index.data(badge_role).toString();
        if (key.isEmpty()) {
            QStyledItemDelegate::paint(painter, option, index);
            return;
        }
        auto base = option;
        initStyleOption(&base, index);
        const auto text = base.text;
        base.text.clear();
        // Calling the delegate again reinitializes DisplayRole and draws the
        // original text underneath the badge. Paint only the native background.
        const auto style = base.widget ? base.widget->style() : QApplication::style();
        style->drawControl(QStyle::CE_ItemViewItem, &base, painter, base.widget);
        QColor background("#edf1f6"), foreground("#526581");
        if (key == "in-progress" || key == "internal") {
            background = QColor("#e0eaff");
            foreground = QColor("#2452d5");
        } else if (key == "blocked" || key == "failed" || key == "rejected") {
            background = QColor("#ffe7e9");
            foreground = QColor("#aa1c31");
        } else if (key == "review" || key == "candidate" || key == "pending" || key == "missing") {
            background = QColor("#fff2d6");
            foreground = QColor("#8b5700");
        } else if (key == "done" || key == "passed" || key == "approved" || key == "public") {
            background = QColor("#dff3ea");
            foreground = QColor("#176647");
        }
        painter->save();
        painter->setRenderHint(QPainter::Antialiasing);
        const auto width =
            std::min(option.rect.width() - 16, option.fontMetrics.horizontalAdvance(text) + 20);
        QRect badge(option.rect.x() + 8, option.rect.center().y() - 12, std::max(12, width), 24);
        painter->setPen(Qt::NoPen);
        painter->setBrush(background);
        painter->drawRoundedRect(badge, 4, 4);
        painter->setPen(foreground);
        painter->setFont(option.font);
        painter->drawText(badge.adjusted(10, 0, -5, 0), Qt::AlignVCenter | Qt::AlignLeft,
                          option.fontMetrics.elidedText(text, Qt::ElideRight, badge.width() - 15));
        painter->restore();
    }
};
inline void inventory(QTreeWidget *tree) {
    tree->setRootIsDecorated(false);
    tree->setUniformRowHeights(true);
    tree->setSelectionMode(QAbstractItemView::SingleSelection);
    tree->setItemDelegate(new BadgeDelegate(tree));
    tree->header()->setMinimumSectionSize(90);
    tree->header()->setResizeContentsPrecision(50);
}
} // namespace studio
