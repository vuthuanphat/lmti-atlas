#pragma once
#include "lmti/project_store.hpp"

namespace lmti::detail {
// Storage-private serializer. The caller owns the one validated native read and
// must derive any additional ancestry restrictions before passing its records.
// Never reload a path here or expose this helper as a caller-selectable bypass.
QJsonObject project_snapshot_records(const ProjectDocument &, const ProjectScope &, bool include_references);
} // namespace lmti::detail
