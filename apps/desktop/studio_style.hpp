#pragma once
#include <QApplication>
#include <QPainter>
#include <QPainterPath>
#include <QProxyStyle>
#include <QStyleFactory>
#include <QStyleOption>

namespace studio {
// Explicit indicators keep controls legible independently of the Windows theme.
class Style final : public QProxyStyle {
  public:
    Style() : QProxyStyle(QStyleFactory::create("Fusion")) {
        setObjectName("lmtiStudioStyle");
    }
    void drawPrimitive(PrimitiveElement element, const QStyleOption *option, QPainter *painter,
                       const QWidget *widget = nullptr) const override {
        if (element != PE_IndicatorCheckBox && element != PE_IndicatorArrowDown) {
            QProxyStyle::drawPrimitive(element, option, painter, widget);
            return;
        }
        painter->save();
        painter->setRenderHint(QPainter::Antialiasing);
        const bool enabled = option->state & State_Enabled;
        const auto center = option->rect.center();
        if (element == PE_IndicatorArrowDown) {
            painter->setPen(Qt::NoPen);
            painter->setBrush(QColor(enabled ? "#526581" : "#a5b0bf"));
            painter->drawPolygon(QPolygonF{QPointF(center.x() - 4, center.y() - 2),
                                           QPointF(center.x() + 4, center.y() - 2),
                                           QPointF(center.x(), center.y() + 3)});
        } else {
            const bool checked = option->state & (State_On | State_NoChange);
            const QRectF box = QRectF(option->rect).adjusted(1, 1, -1, -1);
            painter->setPen(QPen(QColor(checked ? (enabled ? "#3563e9" : "#b6c7e6") : "#9cacbf"), 1.2));
            painter->setBrush(QColor(checked ? (enabled ? "#3563e9" : "#b6c7e6") : "#ffffff"));
            painter->drawRoundedRect(box, 3, 3);
            if (checked) {
                painter->setPen(QPen(Qt::white, 1.8, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
                if (option->state & State_NoChange)
                    painter->drawLine(box.topLeft() + QPointF(3, box.height() / 2),
                                      box.topRight() + QPointF(-3, box.height() / 2));
                else {
                    QPainterPath tick;
                    tick.moveTo(box.left() + box.width() * .2, box.top() + box.height() * .52);
                    tick.lineTo(box.left() + box.width() * .43, box.top() + box.height() * .73);
                    tick.lineTo(box.left() + box.width() * .8, box.top() + box.height() * .28);
                    painter->drawPath(tick);
                }
            }
        }
        painter->restore();
    }
};
inline void ensure_style() {
    if (qApp && qApp->style()->objectName() != "lmtiStudioStyle")
        QApplication::setStyle(new Style);
}
} // namespace studio
