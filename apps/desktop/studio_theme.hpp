#pragma once
#include <QString>

namespace studio {
// Shared presentation tokens derived from the accepted AI interface designs.
inline QString theme() {
    return QStringLiteral(R"QSS(
QWidget{font-family:'Segoe UI';font-size:14px;color:#202a3a;background:#ffffff;}
QMainWindow,QWidget#mainColumn{background:#ffffff;}
QWidget#projectSidebar,QWidget#projectSidebar QWidget{background:#f7f7f8;color:#353740;}
QFrame#projectSidebar{border:0;}
QLabel#brand{font-size:23px;font-weight:600;color:#202123;}
QLabel#brandNote{font-size:13px;color:#bdcbe0;}
QLabel#navSection{color:#b8c8de;font-size:11px;font-weight:600;padding:6px 8px;}
QWidget#projectSidebar QPushButton{background:transparent;border:0;color:#353740;text-align:left;padding:10px 12px;border-radius:8px;}
QWidget#projectSidebar QPushButton:hover{background:#ececee;}
QWidget#projectSidebar QPushButton:checked{background:#e7e7e9;color:#202123;border:0;}
QListWidget#recentProjectNavigation{background:#f7f7f8;border:0;outline:0;}
QListWidget#recentProjectNavigation::item{padding:8px;color:#353740;}
QListWidget#recentProjectNavigation::item:hover,QListWidget#recentProjectNavigation::item:selected{background:#e7e7e9;color:#202123;}
QWidget#projectSidebar QComboBox{background:#f7f7f8;color:#353740;border:1px solid #dedee2;padding:10px;}
QWidget#projectSidebar QScrollBar:vertical{background:#f7f7f8;}
QWidget#projectSidebar QScrollBar::handle:vertical{background:#4b607a;}
QListWidget#projectNavigation,QListWidget#knowledgeNavigation{border:0;outline:0;background:#f7f7f8;padding:0;}
QListWidget#projectNavigation::item,QListWidget#knowledgeNavigation::item{padding:8px 10px;margin:1px 0;border-radius:8px;color:#353740;}
QListWidget#projectNavigation::item:selected,QListWidget#knowledgeNavigation::item:selected{background:#e7e7e9;color:#202123;border:0;}
QListWidget#projectNavigation::item:hover,QListWidget#knowledgeNavigation::item:hover{background:#ececee;}
QToolBar#projectToolbar{background:white;border:0;border-bottom:1px solid #dce3eb;padding:8px;spacing:8px;}
QLabel#projectBreadcrumb,QLabel#saveState{background:transparent;color:#64748b;font-size:13px;}
QLabel#saveState{padding:0 12px;}
QLabel#projectHeading,QLabel#pageTitle{font-size:27px;font-weight:700;color:#202a3a;background:transparent;}
QLabel#muted,QLabel#folderPath{color:#64748b;font-size:13px;background:transparent;}
QLabel#sectionTitle,QLabel#cardTitle,QLabel#inspectorTitle{font-size:19px;font-weight:600;background:transparent;}
QLabel#projectSummary,QLabel#projectProgress{color:#526581;background:transparent;}
QLabel#metricValue{font-size:25px;font-weight:600;background:transparent;}
QPushButton{background:white;border:1px solid #dce3eb;border-radius:6px;padding:9px 14px;}
QPushButton:hover{background:#eef3ff;border-color:#a7bce5;}
QPushButton:disabled{color:#8999b0;background:#f1f4f8;border-color:#e3e8f0;}
QPushButton[primary=true],QToolButton[primary=true]{background:#3563e9;border:1px solid #3563e9;color:white;}
QPushButton[primary=true]:hover,QToolButton[primary=true]:hover{background:#2452d5;}
QPushButton[primary=true]:disabled,QToolButton[primary=true]:disabled{background:#dce6fa;color:#637ea7;border-color:#dce6fa;}
QPushButton[filter=true]{border:0;background:transparent;color:#64748b;}
QPushButton[filter=true]:checked{background:#eaf0ff;color:#2452d5;}
QFrame[segmented=true]{background:#edf2f8;border:1px solid #dce3eb;border-radius:6px;}
QPushButton[segment=true]{background:transparent;border:0;padding:8px 14px;color:#526581;}
QPushButton[segment=true]:checked{background:#3563e9;color:white;}
QPushButton[compactAction=true]{font-size:13px;padding:9px 6px;}
QPushButton:focus,QToolButton:focus{border:2px solid #3563e9;}
QToolButton{background:transparent;border:0;padding:7px;border-radius:6px;}
QToolButton:hover{background:#edf2fa;}
QToolButton:checked{background:#e0eaff;border:1px solid #b6c7ed;}
QToolButton:disabled{color:#8999b0;}
QToolButton::menu-indicator{image:none;}
QToolButton#projectOptions,QToolButton[more=true]{font-size:22px;}
QToolButton[columnPicker=true]{background:white;border:1px solid #dce3eb;padding:8px 10px;font-size:13px;}
QToolButton[columnPicker=true]:hover{background:#eef3ff;border-color:#a7bce5;}
QToolButton[columnPicker=true]:focus{border:2px solid #3563e9;}
QLineEdit,QComboBox,QPlainTextEdit{background:white;border:1px solid #dce3eb;border-radius:6px;padding:9px;selection-background-color:#dce8ff;selection-color:#202a3a;}
QLineEdit:focus,QComboBox:focus,QPlainTextEdit:focus{border:1px solid #3563e9;}
QLineEdit[invalid=true]{border:1px solid #dc2626;}
QComboBox::drop-down{border:0;width:24px;}
QComboBox QAbstractItemView{background:white;color:#202a3a;selection-background-color:#eaf0ff;selection-color:#2452d5;border:1px solid #dce3eb;padding:4px;}
QTreeWidget{background:white;border:1px solid #dce3eb;border-radius:6px;padding:0;outline:0;}
QTreeWidget::item{padding:8px 12px;border-bottom:1px solid #eef1f6;}
QTreeWidget::item:selected{background:#e7efff;color:#202a3a;}
QTreeWidget::item:hover{background:#f1f5fc;}
QTreeWidget#libraryList::item{padding:0;}
QTreeWidget[facts=true]{background:transparent;border:0;}
QTreeWidget[facts=true]::item{border:0;padding:4px 0;}
QTreeWidget[workState="todo"]{background:#edf1f6;}
QTreeWidget[workState="in-progress"]{background:#e9f0ff;}
QTreeWidget[workState="blocked"]{background:#fff0f2;}
QTreeWidget[workState="review"]{background:#fff8e7;}
QTreeWidget[workState="done"]{background:#eaf8f1;}
QTreeWidget[workState]::item{border:0;padding:0;}
QHeaderView::section{background:#fafafa;color:#62636b;border:0;border-bottom:1px solid #e5e5e8;padding:11px 12px;font-weight:600;}
QTabWidget::pane{border:0;background:transparent;}
QTabBar::tab{background:transparent;color:#526581;padding:12px 16px;border-bottom:2px solid transparent;font-weight:600;}
QTabBar::tab:selected{color:#2452d5;border-bottom:2px solid #3563e9;}
QFrame[projectCard=true],QFrame#libraryEmpty,QFrame#entityInspector,QFrame[panel=true]{background:white;border:1px solid #dce3eb;border-radius:7px;}
QFrame[inventorySurface=true]{background:white;border:1px solid #dce3eb;border-radius:8px;}
QFrame[inventorySurface=true] QLabel{background:transparent;}
QFrame[inventorySurface=true] QTreeWidget{border:0;border-radius:0;}
QStackedWidget#workViews{background:white;}
QFrame[inspectorTabs=true]{background:transparent;border:0;border-bottom:1px solid #dce3eb;border-radius:0;}
QFrame[inspectorTabs=true] QPushButton[segment=true]{background:transparent;border:0;border-bottom:2px solid transparent;border-radius:0;padding:8px 5px;color:#526581;}
QFrame[inspectorTabs=true] QPushButton[segment=true]:checked{background:transparent;border-bottom:2px solid #3563e9;color:#2452d5;}
QPushButton[inspectorChrome=true]{background:transparent;border:0;padding:2px;font-size:19px;}
QPushButton[inspectorChrome=true]:hover{background:#eef3ff;}
QWidget[libraryActions=true]{background:transparent;}
QPushButton[libraryOpen=true]{background:#edf3ff;color:#2452d5;border:1px solid #d5e1fb;padding:7px 14px;}
QToolButton[libraryPin=true]{background:transparent;border:0;font-size:20px;padding:2px;}
QToolButton[libraryPin=true][pinned=true]{color:#2452d5;background:#edf3ff;}
QFrame[projectCard=true] QLabel,QFrame#libraryEmpty QLabel,QFrame#entityInspector QLabel,QFrame[panel=true] QLabel{background:transparent;}
QWidget#projectToolbarGap,QWidget#projectToolbarInset{background:transparent;}
QWidget#inspectorContent,QWidget#knowledgeDetailContent,QWidget[formField=true]{background:white;}
QCheckBox{background:transparent;}
QFrame#entityInspector QTreeWidget,QFrame#entityInspector QScrollArea{background:white;}
QTreeWidget[compactRelations=true]{border:0;}
QLabel#cardStatus{background:transparent;color:#526581;font-size:12px;}
QLabel#cardStatus[warning=true],QLabel#libraryNotice{color:#9a6200;background:#fff7e4;padding:8px;}
QFrame[notice=true]{background:#fafafa;border:1px solid #e5e5e8;border-radius:10px;}
QFrame[notice=true] QLabel{background:transparent;color:#526581;}
QDialog{background:#f5f7fa;}
QDialogButtonBox{background:white;padding:12px;}
QMenu{background:white;border:1px solid #dce3eb;}
QMenu::item{padding:9px 24px;}
QMenu::item:selected{background:#eaf0ff;}
QMenu::item:disabled{color:#8999b0;}
QStatusBar{background:#f5f7fa;color:#64748b;font-size:12px;border-top:1px solid #dce3eb;}
QToolTip{background:#162238;color:white;border:0;padding:7px;}
QScrollArea{border:0;background:transparent;}
QScrollBar:vertical{background:transparent;width:9px;}
QScrollBar::handle:vertical{background:#c4cfdf;border-radius:4px;min-height:28px;}
QScrollBar::add-line:vertical,QScrollBar::sub-line:vertical{height:0;}
QScrollBar:horizontal{background:transparent;height:9px;}
QScrollBar::handle:horizontal{background:#c4cfdf;border-radius:4px;min-width:28px;}
QScrollBar::add-line:horizontal,QScrollBar::sub-line:horizontal{width:0;}
)QSS");
}
} // namespace studio
