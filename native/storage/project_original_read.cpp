#include "lmti/project_original_read.hpp"
#include "original_read_p.hpp"

namespace lmti {
using namespace detail::original_read;

void validate_original_hierarchy_request(const QString &fixed_library,
    const LogicalHierarchyScope &scope,const OriginalHierarchyExpected &expected) {
    try {
        (void)path_text(fixed_library);
        (void)path_text(expected.library.canonical_path);
        (void)path_text(expected.linked_root,true);
        need(expected.project_id.size() <= 64 && scope.project_id.size() <= 64);
        validate_id(expected.project_id); validate_id(scope.project_id);
        need(scope.allow_logical_write && scope.project_id == expected.project_id,OriginalReadCode::ScopeDenied);
        need(expected.library.schema >= 1 && expected.library.schema <= 3 &&
             (expected.library.schema == 1 ? expected.library.uuid.isEmpty() : uuid(expected.library.uuid)));
        need(expected.project.schema == 2 && uuid(expected.project.store_uuid));
        physical_shape(expected.library.physical,false);
        physical_shape(expected.project.physical,false);
        need(path_text(fixed_library) == path_text(expected.library.physical.path),OriginalReadCode::ScopeDenied);
        qsizetype bytes = fixed_library.toUtf8().size()+expected.library.canonical_path.toUtf8().size()+
            expected.linked_root.toUtf8().size()+static_cast<qsizetype>(expected.project_id.size())+72;
        for (const auto *target : {&expected.library.physical,&expected.project.physical}) {
            bytes += target->path.toUtf8().size();
            for (const auto &id : target->chain) bytes += id.dev.size()+id.ino.size()+id.birthtime_ns.size();
        }
        need(bytes <= 48*1024,OriginalReadCode::LimitExceeded);
    } catch (const OriginalReadError &) { throw; }
    catch (const std::exception &) { refused(OriginalReadCode::InvalidInput); }
}

OriginalHierarchyRead read_original_hierarchy_state(const QString &fixed_library,
    const LogicalHierarchyScope &scope,const OriginalHierarchyExpected &expected) {
    validate_original_hierarchy_request(fixed_library,scope,expected);
#ifndef Q_OS_WIN
    refused(OriginalReadCode::NotSupported);
#else
    try {
        NamespaceLease lease;
        lease.retain_target(expected.library.physical,64ULL*1024*1024);
        lease.retain_target(expected.project.physical,64ULL*1024*1024);
        const auto library_sidecars = retain_sidecars(lease,fixed_library);
        const auto project_sidecars = retain_sidecars(lease,expected.project.physical.path);
#ifdef LMTI_ORIGINAL_READ_TEST_HOOKS
        detail::original_read_test_point(detail::OriginalReadPhase::AfterLeasesAcquired,fixed_library);
#endif
        const auto before = inspect_project_library(fixed_library);
        matches_original_library(before,expected);
        const auto entry = selected(before,expected.project_id);
#ifdef LMTI_ORIGINAL_READ_TEST_HOOKS
        detail::original_read_test_point(detail::OriginalReadPhase::AfterInitialLocatorCompared,fixed_library);
        detail::original_read_test_point(detail::OriginalReadPhase::BeforeProjectOpen,expected.project.physical.path);
#endif
        // The single copied original locator is the only project path opened.
        auto state = detail::read_original_hierarchy(expected.project.physical.path,scope,
            expected.project.store_uuid.toStdString());
#ifdef LMTI_ORIGINAL_READ_TEST_HOOKS
        detail::original_read_test_point(detail::OriginalReadPhase::BeforeFinalVerification,fixed_library);
#endif
        const auto after = inspect_project_library(fixed_library);
        need(before.token == after.token,OriginalReadCode::ConfigChanged);
        matches_original_library(after,expected);
        const auto &final_entry = selected(after,expected.project_id);
        need(final_entry.id == entry.id && final_entry.path == entry.path && final_entry.folder == entry.folder,
             OriginalReadCode::ConfigChanged);
        check_sidecars(lease,library_sidecars);
        check_sidecars(lease,project_sidecars);
        return {before.token,std::move(state)};
    } catch (const OriginalReadError &) { throw; }
    catch (const detail::OriginalProjectChanged &) { refused(OriginalReadCode::ConfigChanged); }
    catch (const HierarchyError &) { throw; }
    catch (const LibraryError &error) {
        if (error.code == LibraryCode::Conflict) refused(OriginalReadCode::ConfigChanged);
        if (error.code == LibraryCode::BudgetExceeded) refused(OriginalReadCode::LimitExceeded);
        refused(OriginalReadCode::OwnerUnavailable);
    }
    catch (const std::exception &) { refused(OriginalReadCode::OwnerUnavailable); }
#endif
}
void validate_original_physical_hierarchy_request(const QString &fixed_library,
    const PhysicalHierarchyScope &scope,const OriginalPhysicalHierarchyExpected &expected) {
    try {
        (void)path_text(fixed_library);
        (void)path_text(expected.library.canonical_path);
        (void)path_text(expected.linked_root,true);
        need(expected.project_id.size() <= 64 && scope.project_id.size() <= 64);
        validate_id(expected.project_id); validate_id(scope.project_id);
        need(scope.allow_physical_write && scope.project_id == expected.project_id,OriginalReadCode::ScopeDenied);
        need(expected.library.schema >= 1 && expected.library.schema <= 3 &&
             (expected.library.schema == 1 ? expected.library.uuid.isEmpty() : uuid(expected.library.uuid)));
        need(expected.project.schema == 2 && uuid(expected.project.store_uuid));
        physical_shape(expected.library.physical,false);
        physical_shape(expected.project.physical,false);
        need(path_text(fixed_library) == path_text(expected.library.physical.path),OriginalReadCode::ScopeDenied);
        qsizetype bytes = fixed_library.toUtf8().size()+expected.library.canonical_path.toUtf8().size()+
            expected.linked_root.toUtf8().size()+static_cast<qsizetype>(expected.project_id.size())+72;
        for (const auto *target : {&expected.library.physical,&expected.project.physical}) {
            bytes += target->path.toUtf8().size();
            for (const auto &id : target->chain) bytes += id.dev.size()+id.ino.size()+id.birthtime_ns.size();
        }
        need(bytes <= 48*1024,OriginalReadCode::LimitExceeded);
    } catch (const OriginalReadError &) { throw; }
    catch (const std::exception &) { refused(OriginalReadCode::InvalidInput); }
}

OriginalPhysicalHierarchyRead read_original_physical_hierarchy_state(const QString &fixed_library,
    const PhysicalHierarchyScope &scope,const OriginalPhysicalHierarchyExpected &expected) {
    validate_original_physical_hierarchy_request(fixed_library,scope,expected);
#ifndef Q_OS_WIN
    refused(OriginalReadCode::NotSupported);
#else
    try {
        NamespaceLease lease;
        lease.retain_target(expected.library.physical,64ULL*1024*1024);
        lease.retain_target(expected.project.physical,64ULL*1024*1024);
        const auto library_sidecars = retain_sidecars(lease,fixed_library);
        const auto project_sidecars = retain_sidecars(lease,expected.project.physical.path);
#ifdef LMTI_ORIGINAL_READ_TEST_HOOKS
        detail::original_read_test_point(detail::OriginalReadPhase::AfterLeasesAcquired,fixed_library);
#endif
        const auto before = inspect_project_library(fixed_library);
        matches_original_library(before,expected);
        const auto entry = selected(before,expected.project_id);
#ifdef LMTI_ORIGINAL_READ_TEST_HOOKS
        detail::original_read_test_point(detail::OriginalReadPhase::AfterInitialLocatorCompared,fixed_library);
        detail::original_read_test_point(detail::OriginalReadPhase::BeforeProjectOpen,expected.project.physical.path);
#endif
        // The single copied original locator is the only project path opened.
        auto state = detail::read_original_physical_hierarchy(expected.project.physical.path,scope,
            expected.project.store_uuid.toStdString());
#ifdef LMTI_ORIGINAL_READ_TEST_HOOKS
        detail::original_read_test_point(detail::OriginalReadPhase::BeforeFinalVerification,fixed_library);
#endif
        const auto after = inspect_project_library(fixed_library);
        need(before.token == after.token,OriginalReadCode::ConfigChanged);
        matches_original_library(after,expected);
        const auto &final_entry = selected(after,expected.project_id);
        need(final_entry.id == entry.id && final_entry.path == entry.path && final_entry.folder == entry.folder,
             OriginalReadCode::ConfigChanged);
        check_sidecars(lease,library_sidecars);
        check_sidecars(lease,project_sidecars);
        return {before.token,std::move(state)};
    } catch (const OriginalReadError &) { throw; }
    catch (const detail::OriginalProjectChanged &) { refused(OriginalReadCode::ConfigChanged); }
    catch (const PhysicalHierarchyError &) { throw; }
    catch (const LibraryError &error) {
        if (error.code == LibraryCode::Conflict) refused(OriginalReadCode::ConfigChanged);
        if (error.code == LibraryCode::BudgetExceeded) refused(OriginalReadCode::LimitExceeded);
        refused(OriginalReadCode::OwnerUnavailable);
    }
    catch (const std::exception &) { refused(OriginalReadCode::OwnerUnavailable); }
#endif
}
} // namespace lmti
