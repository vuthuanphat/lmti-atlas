#pragma once
#include "mcp_profile.hpp"
#include "original_read.hpp"

namespace lmti {
struct OriginalBindingExpected {
    std::string project_id;
    OriginalLibraryExpected library;
    OriginalProjectExpected project;
    OriginalPhysicalTarget profiles;
    QString linked_root;
};
enum class MissingProfilePolicy { PresentOnly, AllowStillAbsent };
struct OriginalBindingRead {
    LibraryToken library;
    LibraryEntry entry;
    ProjectDocument document;
    McpProfile profile;
};
// Trusted native boundary: neither expected paths nor identities confer a grant.
// Pure input validation precedes I/O. Windows-only ordinary local-file support.
void validate_original_binding_request(const QString &fixed_library,
    const QString &fixed_profiles, const OriginalBindingExpected &, MissingProfilePolicy);
// Reuses owner reads while retaining namespace leases. Result owns all values;
// leases end only after SQLite readers close, before pure caller serialization.
OriginalBindingRead read_original_mcp_state(const QString &fixed_library,
    const QString &fixed_profiles, const OriginalBindingExpected &, MissingProfilePolicy);
} // namespace lmti
