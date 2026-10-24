#pragma once
#include <string>

namespace lmti::audit {
// Only an existing audit.jsonl -> empty .audit-tmp-UUID in its parent/archive.
// Throws a redacted failure; holds handles while checking/copying access control.
void copy_windows_access(const std::wstring& source, const std::wstring& target);
}
