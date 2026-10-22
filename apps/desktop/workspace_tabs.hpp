#pragma once
#include <QTabBar>
#include <QTabWidget>
#include <algorithm>

// The outer scroll area follows the visible page, rather than the largest hidden
// topology/board page. Each page keeps its own layout and input accessibility.
class WorkspaceTabs final : public QTabWidget {
  public:
    explicit WorkspaceTabs(QWidget *parent = nullptr) : QTabWidget(parent) {
        connect(this, &QTabWidget::currentChanged, this, [this] { updateGeometry(); });
    }
    QSize minimumSizeHint() const override {
        auto result = currentWidget()
                          ? currentWidget()->minimumSizeHint().expandedTo(currentWidget()->minimumSize())
                          : QSize(0, 0);
        if (!tabBar()->isHidden()) {
            result.setHeight(result.height() + tabBar()->sizeHint().height());
            result.setWidth(std::max(result.width(), tabBar()->minimumSizeHint().width()));
        }
        return result;
    }
    QSize sizeHint() const override {
        auto result = currentWidget() ? currentWidget()->sizeHint() : QSize(640, 480);
        if (!tabBar()->isHidden())
            result.setHeight(result.height() + tabBar()->sizeHint().height());
        return result;
    }
};
