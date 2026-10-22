#pragma once
#include <QBrush>
#include <QGraphicsPathItem>
#include <QGraphicsPolygonItem>
#include <QGraphicsRectItem>
#include <QGraphicsScene>
#include <QPainter>
#include <QPainterPath>
#include <QPen>
#include <QPolygonF>
#include <cmath>
#include <vector>

namespace studio {
class GraphCard final : public QGraphicsRectItem {
  public:
    using QGraphicsRectItem::QGraphicsRectItem;
    void paint(QPainter *painter, const QStyleOptionGraphicsItem *, QWidget *) override {
        painter->setRenderHint(QPainter::Antialiasing);
        auto outline = pen();
        outline.setWidthF(isSelected() ? 2.5 : 1.5);
        painter->setPen(outline);
        painter->setBrush(brush());
        painter->drawRoundedRect(rect(), 8, 8);
    }
};
inline constexpr int edge_kind_role = 20;
inline constexpr int edge_from_role = 21;
inline constexpr int edge_to_role = 22;
inline std::vector<QGraphicsItem *> directed_edge(QGraphicsScene *scene, const QPainterPath &path,
                                                  const QColor &color, Qt::PenStyle style,
                                                  const QString &kind, const QString &from,
                                                  const QString &to) {
    auto edge = scene->addPath(path, QPen(color, 1.7, style));
    const auto end = path.pointAtPercent(1);
    const auto previous = path.pointAtPercent(.98);
    const auto delta = end - previous;
    const auto length = std::hypot(delta.x(), delta.y());
    std::vector<QGraphicsItem *> items{edge};
    if (length > .001) {
        const auto direction = delta / length;
        const auto normal = QPointF(-direction.y(), direction.x());
        auto arrow = scene->addPolygon(
            QPolygonF{end, end - direction * 10 + normal * 4.5, end - direction * 10 - normal * 4.5},
            Qt::NoPen, QBrush(color));
        arrow->setData(edge_kind_role, kind + "-arrow");
        arrow->setData(edge_from_role, from);
        arrow->setData(edge_to_role, to);
        items.push_back(arrow);
    }
    edge->setData(edge_kind_role, kind);
    edge->setData(edge_from_role, from);
    edge->setData(edge_to_role, to);
    return items;
}
} // namespace studio
