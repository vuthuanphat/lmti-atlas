#include "project_language.hpp"
#include "project_captions.hpp"
#include <QAbstractButton>
#include <QAction>
#include <QComboBox>
#include <QLabel>
#include <QLineEdit>
#include <QListWidget>
#include <QTabWidget>
#include <QTreeWidget>

namespace {
constexpr int caption_role = Qt::UserRole + 100;
void capture(QObject *object, const char *property, const QString &text) {
    if (known_project_caption(text))
        object->setProperty(property, project_ui_source(text));
}
} // namespace
void capture_project_captions(QWidget *root) {
    for (auto widget : root->findChildren<QWidget *>()) {
        // User-authored labels, paths and data never become translation keys.
        if (widget->property("verbatim").toBool())
            continue;
        if (auto label = qobject_cast<QLabel *>(widget))
            capture(label, "uiCaption", label->text());
        if (auto button = qobject_cast<QAbstractButton *>(widget))
            capture(button, "uiCaption", button->text());
        if (auto edit = qobject_cast<QLineEdit *>(widget))
            capture(edit, "uiPlaceholder", edit->placeholderText());
        capture(widget, "uiTooltip", widget->toolTip());
        capture(widget, "uiAccessibleName", widget->accessibleName());
        if (auto tabs = qobject_cast<QTabWidget *>(widget)) {
            QStringList labels;
            for (int i = 0; i < tabs->count(); ++i)
                labels << project_ui_source(tabs->tabText(i));
            tabs->setProperty("uiTabs", labels);
        }
        if (auto list = qobject_cast<QListWidget *>(widget);
            list &&
            (list->objectName() == "projectNavigation" || list->objectName() == "knowledgeNavigation"))
            for (int i = 0; i < list->count(); ++i)
                list->item(i)->setData(caption_role, project_ui_source(list->item(i)->text()));
        if (auto tree = qobject_cast<QTreeWidget *>(widget))
            for (int i = 0; i < tree->columnCount(); ++i)
                tree->headerItem()->setData(i, caption_role, project_ui_source(tree->headerItem()->text(i)));
    }
    for (auto action : root->findChildren<QAction *>())
        capture(action, "uiCaption", action->text());
}
void apply_project_captions(QWidget *root) {
    for (auto widget : root->findChildren<QWidget *>()) {
        if (widget->property("verbatim").toBool())
            continue;
        const auto caption = widget->property("uiCaption");
        if (caption.isValid()) {
            if (auto label = qobject_cast<QLabel *>(widget))
                label->setText(project_caption(caption.toString()));
            if (auto button = qobject_cast<QAbstractButton *>(widget))
                button->setText(project_caption(caption.toString()));
        }
        if (widget->property("uiTooltip").isValid())
            widget->setToolTip(project_caption(widget->property("uiTooltip").toString()));
        if (widget->property("uiAccessibleName").isValid())
            widget->setAccessibleName(project_caption(widget->property("uiAccessibleName").toString()));
        if (auto edit = qobject_cast<QLineEdit *>(widget); edit && edit->property("uiPlaceholder").isValid())
            edit->setPlaceholderText(project_caption(edit->property("uiPlaceholder").toString()));
        if (auto combo = qobject_cast<QComboBox *>(widget); combo && combo->property("uiChoices").isValid()) {
            const auto choices = combo->property("uiChoices").toStringList();
            for (int i = 0; i < combo->count() && i < choices.size(); ++i)
                combo->setItemText(i, project_caption(choices[i]));
        }
        if (auto tabs = qobject_cast<QTabWidget *>(widget); tabs && tabs->property("uiTabs").isValid()) {
            auto labels = tabs->property("uiTabs").toStringList();
            for (int i = 0; i < tabs->count() && i < labels.size(); ++i)
                tabs->setTabText(i, project_caption(labels[i]));
        }
        if (auto list = qobject_cast<QListWidget *>(widget);
            list &&
            (list->objectName() == "projectNavigation" || list->objectName() == "knowledgeNavigation"))
            for (int i = 0; i < list->count(); ++i)
                list->item(i)->setText(project_caption(list->item(i)->data(caption_role).toString()));
        if (auto tree = qobject_cast<QTreeWidget *>(widget))
            for (int i = 0; i < tree->columnCount(); ++i) {
                auto source = tree->headerItem()->data(i, caption_role);
                if (source.isValid())
                    tree->headerItem()->setText(i, project_caption(source.toString()));
            }
        if (auto tree = qobject_cast<QTreeWidget *>(widget);
            tree && tree->property("translatedRows").toBool())
            for (int i = 0; i < tree->topLevelItemCount(); ++i)
                for (int column = 0; column < tree->columnCount(); ++column) {
                    auto item = tree->topLevelItem(i);
                    const auto source = item->data(column, Qt::UserRole + 110);
                    if (source.isValid()) {
                        item->setText(column, project_caption(source.toString()));
                        item->setToolTip(column, project_caption(source.toString()).toHtmlEscaped());
                    }
                }
    }
    for (auto action : root->findChildren<QAction *>())
        if (action->property("uiCaption").isValid())
            action->setText(project_caption(action->property("uiCaption").toString()));
}
