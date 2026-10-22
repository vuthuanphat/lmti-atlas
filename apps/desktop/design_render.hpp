#pragma once
#include "project_window.hpp"

// Native UI fixtures use a disposable catalog and synthetic project metadata.
// Knowledge fixtures are loaded through the owning policy adapter.
bool render_design_screen(ProjectWindow &, const QString &screen, const QString &output,
                          const QString &fixture_directory);
