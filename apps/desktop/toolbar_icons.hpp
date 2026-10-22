#pragma once
#include <QIcon>
#include <QPainter>
#include <QPainterPath>
#include <QPixmap>
#include <QPolygonF>

namespace studio {
enum class ToolbarIcon {
    New,
    Open,
    Save,
    AddDevice,
    Connect,
    Delete,
    Undo,
    Redo,
    Fit,
    Review,
    Home,
    Software,
    Hardware,
    Architecture,
    Work,
    Release,
    Knowledge,
    Agent,
    Settings,
    Globe,
    Select,
    Pan,
    ZoomIn,
    ZoomOut
};

// Local vector artwork keeps the toolbar consistent without external assets or fonts.
inline QIcon toolbar_icon(ToolbarIcon icon, bool light = false) {
    QIcon result;
    for (auto mode : {QIcon::Normal, QIcon::Disabled}) {
        for (int scale : {1, 2, 3}) {
            QPixmap pixmap(24 * scale, 24 * scale);
            pixmap.setDevicePixelRatio(scale);
            pixmap.fill(Qt::transparent);
            QPainter p(&pixmap);
            p.setRenderHint(QPainter::Antialiasing);
            p.setPen(QPen(QColor(mode == QIcon::Disabled ? "#94a3b8"
                                 : light                 ? "#475569"
                                                         : "#dce8f3"),
                          1.65, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
            p.setBrush(Qt::NoBrush);
            auto line = [&](std::initializer_list<QPointF> points) {
                QPolygonF polygon;
                for (auto point : points)
                    polygon.append(point);
                p.drawPolyline(polygon);
            };
            auto document = [&] {
                line({{14, 3}, {6, 3}, {6, 21}, {19, 21}, {19, 8}, {14, 3}, {14, 8}, {19, 8}});
            };
            switch (icon) {
            case ToolbarIcon::Home:
                line({{3, 11}, {12, 3}, {21, 11}});
                line({{5, 10}, {5, 21}, {10, 21}, {10, 14}, {14, 14}, {14, 21}, {19, 21}, {19, 10}});
                break;
            case ToolbarIcon::Software:
                line({{8, 6}, {2, 12}, {8, 18}});
                line({{16, 6}, {22, 12}, {16, 18}});
                break;
            case ToolbarIcon::Hardware:
                p.drawRoundedRect(QRectF(6, 6, 12, 12), 1, 1);
                for (int n : {8, 12, 16}) {
                    p.drawLine(QPointF(n, 3), QPointF(n, 6));
                    p.drawLine(QPointF(n, 18), QPointF(n, 21));
                    p.drawLine(QPointF(3, n), QPointF(6, n));
                    p.drawLine(QPointF(18, n), QPointF(21, n));
                }
                break;
            case ToolbarIcon::Architecture:
                p.drawRoundedRect(QRectF(9, 2, 6, 6), 1, 1);
                p.drawRoundedRect(QRectF(2, 16, 6, 6), 1, 1);
                p.drawRoundedRect(QRectF(16, 16, 6, 6), 1, 1);
                line({{12, 8}, {12, 12}, {5, 12}, {5, 16}});
                line({{12, 12}, {19, 12}, {19, 16}});
                break;
            case ToolbarIcon::Work:
                p.drawRoundedRect(QRectF(3, 3, 18, 18), 2, 2);
                line({{7, 12}, {11, 16}, {17, 8}});
                break;
            case ToolbarIcon::Release:
                line({{12, 2}, {21, 7}, {21, 17}, {12, 22}, {3, 17}, {3, 7}, {12, 2}});
                line({{3, 7}, {12, 12}, {21, 7}});
                p.drawLine(QPointF(12, 12), QPointF(12, 22));
                break;
            case ToolbarIcon::Knowledge:
                line({{12, 5},
                      {7, 3},
                      {2, 4},
                      {2, 20},
                      {7, 19},
                      {12, 21},
                      {17, 19},
                      {22, 20},
                      {22, 4},
                      {17, 3},
                      {12, 5},
                      {12, 21}});
                break;
            case ToolbarIcon::Agent:
                p.drawRoundedRect(QRectF(4, 6, 16, 14), 2, 2);
                p.drawLine(QPointF(12, 2), QPointF(12, 6));
                p.drawEllipse(QPointF(8, 11), 1, 1);
                p.drawEllipse(QPointF(16, 11), 1, 1);
                p.drawLine(QPointF(8, 16), QPointF(16, 16));
                break;
            case ToolbarIcon::Settings:
                p.drawEllipse(QRectF(5, 5, 14, 14));
                p.drawEllipse(QRectF(9, 9, 6, 6));
                for (int n = 0; n < 8; ++n) {
                    p.save();
                    p.translate(12, 12);
                    p.rotate(n * 45);
                    p.drawLine(QPointF(0, 7), QPointF(0, 10));
                    p.restore();
                }
                break;
            case ToolbarIcon::Globe:
                p.drawEllipse(QRectF(2, 2, 20, 20));
                p.drawEllipse(QRectF(7, 2, 10, 20));
                p.drawLine(QPointF(2, 12), QPointF(22, 12));
                break;
            case ToolbarIcon::New:
                document();
                p.drawLine(QPointF(9, 14), QPointF(16, 14));
                p.drawLine(QPointF(12.5, 10.5), QPointF(12.5, 17.5));
                break;
            case ToolbarIcon::Open:
                line({{3, 17}, {3, 6}, {9, 6}, {11, 8}, {20, 8}, {20, 11}});
                line({{3, 19}, {6, 11}, {22, 11}, {19, 19}, {3, 19}});
                break;
            case ToolbarIcon::Save:
                line({{4, 4}, {17, 4}, {20, 7}, {20, 20}, {4, 20}, {4, 4}});
                p.drawRect(QRectF(8, 4, 7, 6));
                p.drawRect(QRectF(8, 14, 8, 6));
                break;
            case ToolbarIcon::AddDevice:
                p.drawRoundedRect(QRectF(3, 4, 14, 11), 2, 2);
                p.drawLine(QPointF(10, 15), QPointF(10, 20));
                p.drawLine(QPointF(6, 20), QPointF(14, 20));
                p.drawLine(QPointF(17, 17), QPointF(23, 17));
                p.drawLine(QPointF(20, 14), QPointF(20, 20));
                break;
            case ToolbarIcon::Connect:
                p.drawRoundedRect(QRectF(2, 3, 7, 7), 2, 2);
                p.drawRoundedRect(QRectF(15, 14, 7, 7), 2, 2);
                line({{9, 6.5}, {13, 6.5}, {13, 17.5}, {15, 17.5}});
                break;
            case ToolbarIcon::Delete:
                p.drawLine(QPointF(4, 6), QPointF(20, 6));
                p.drawLine(QPointF(9, 3), QPointF(15, 3));
                line({{6, 6}, {7, 21}, {17, 21}, {18, 6}});
                p.drawLine(QPointF(10, 10), QPointF(10, 17));
                p.drawLine(QPointF(14, 10), QPointF(14, 17));
                break;
            case ToolbarIcon::Undo:
            case ToolbarIcon::Redo: {
                if (icon == ToolbarIcon::Redo) {
                    p.translate(24, 0);
                    p.scale(-1, 1);
                }
                line({{8, 4}, {3, 9}, {8, 14}});
                QPainterPath path;
                path.moveTo(3, 9);
                path.lineTo(14, 9);
                path.cubicTo(22, 9, 23, 19, 14, 20);
                p.drawPath(path);
                break;
            }
            case ToolbarIcon::Fit:
                line({{9, 3}, {3, 3}, {3, 9}});
                line({{15, 3}, {21, 3}, {21, 9}});
                line({{3, 15}, {3, 21}, {9, 21}});
                line({{21, 15}, {21, 21}, {15, 21}});
                p.drawRoundedRect(QRectF(8, 8, 8, 8), 1, 1);
                break;
            case ToolbarIcon::Review:
                document();
                line({{9, 14}, {11, 16}, {16, 11}});
                break;
            case ToolbarIcon::Select:
                line({{5, 3}, {5, 20}, {10, 15}, {14, 22}, {17, 20}, {13, 13}, {21, 13}, {5, 3}});
                break;
            case ToolbarIcon::Pan:
                line({{12, 2}, {12, 22}});
                line({{2, 12}, {22, 12}});
                line({{8, 6}, {12, 2}, {16, 6}});
                line({{8, 18}, {12, 22}, {16, 18}});
                line({{6, 8}, {2, 12}, {6, 16}});
                line({{18, 8}, {22, 12}, {18, 16}});
                break;
            case ToolbarIcon::ZoomIn:
            case ToolbarIcon::ZoomOut:
                p.drawEllipse(QRectF(3, 3, 13, 13));
                p.drawLine(QPointF(15, 15), QPointF(21, 21));
                p.drawLine(QPointF(6, 9.5), QPointF(13, 9.5));
                if (icon == ToolbarIcon::ZoomIn)
                    p.drawLine(QPointF(9.5, 6), QPointF(9.5, 13));
                break;
            }
            p.end();
            result.addPixmap(pixmap, mode);
        }
    }
    return result;
}
} // namespace studio
