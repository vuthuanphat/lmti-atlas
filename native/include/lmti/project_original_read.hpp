#pragma once
#include "original_read.hpp"
#include "project_store.hpp"

namespace lmti {
// Identity-only original target. Revisions/digests are read afresh; no field is
// a grant and canonical_path is only a comparison key, never an I/O locator.
struct OriginalHierarchyExpected {
    std::string project_id;
    OriginalLibraryExpected library;
    OriginalProjectExpected project; // Schema 2 only.
    QString linked_root;
};
struct OriginalHierarchyRead {
    LibraryToken library;
    HierarchyState state;
};
// Pure request checks run before namespace acquisition or any SQLite access.
void validate_original_hierarchy_request(const QString &fixed_library,
    const LogicalHierarchyScope &, const OriginalHierarchyExpected &);
// Windows ordinary local namespace support. Holds original library/project
// ancestors and sidecars until all SQLite readers close. It never opens profiles.
OriginalHierarchyRead read_original_hierarchy_state(const QString &fixed_library,
    const LogicalHierarchyScope &, const OriginalHierarchyExpected &);
// Physical scope is independent of logical write authority. This identity-only
// sibling has no profiles, revisions, proposal or caller-supplied grant fields.
struct OriginalPhysicalHierarchyExpected {
    std::string project_id;
    OriginalLibraryExpected library;
    OriginalProjectExpected project; // Schema 2 only.
    QString linked_root;
};
struct OriginalPhysicalHierarchyRead {
    LibraryToken library;
    PhysicalHierarchyState state;
};
void validate_original_physical_hierarchy_request(const QString &fixed_library,
    const PhysicalHierarchyScope &, const OriginalPhysicalHierarchyExpected &);
// Same original namespace policy and reader lifetime as the logical sibling.
// Identity changes remain OriginalReadError; physical projection failures retain
// independent PhysicalHierarchyError codes for the fixed boundary to map.
OriginalPhysicalHierarchyRead read_original_physical_hierarchy_state(const QString &fixed_library,
    const PhysicalHierarchyScope &, const OriginalPhysicalHierarchyExpected &);
} // namespace lmti
