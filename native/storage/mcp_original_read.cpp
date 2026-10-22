#include "lmti/mcp_original_read.hpp"
#include "lmti/mcp_profile_store.hpp"
#include "original_read_p.hpp"

namespace lmti {
using namespace detail::original_read;

void validate_original_binding_request(const QString &fixed_library,const QString &fixed_profiles,
    const OriginalBindingExpected &expected,MissingProfilePolicy policy) {
    try {
        need(policy == MissingProfilePolicy::PresentOnly || policy == MissingProfilePolicy::AllowStillAbsent);
        (void)path_text(fixed_library); (void)path_text(fixed_profiles);
        (void)path_text(expected.library.canonical_path);
        (void)path_text(expected.linked_root,true);
        need(expected.project_id.size() <= 64);
        validate_id(expected.project_id);
        need(expected.library.schema >= 1 && expected.library.schema <= 3 &&
             (expected.library.schema == 1 ? expected.library.uuid.isEmpty() : uuid(expected.library.uuid)));
        need((expected.project.schema == 1 || expected.project.schema == 2) &&
             (expected.project.schema == 1 ? expected.project.store_uuid.isEmpty() : uuid(expected.project.store_uuid)));
        physical_shape(expected.library.physical,false);
        physical_shape(expected.project.physical,false);
        physical_shape(expected.profiles,policy == MissingProfilePolicy::AllowStillAbsent);
        // The fixed path is the path opened below, so do not treat Unicode
        // case-fold equivalence as proof it is the exact path we leased.
        need(path_text(fixed_library) == path_text(expected.library.physical.path) &&
             path_text(fixed_profiles) == path_text(expected.profiles.path),OriginalReadCode::ScopeDenied);
        qsizetype bytes = fixed_library.toUtf8().size()+fixed_profiles.toUtf8().size()+
            expected.library.canonical_path.toUtf8().size()+expected.linked_root.toUtf8().size()+
            static_cast<qsizetype>(expected.project_id.size())+72;
        for (const auto *target : {&expected.library.physical,&expected.project.physical,&expected.profiles}) {
            bytes += target->path.toUtf8().size();
            for (const auto &id : target->chain) bytes += id.dev.size()+id.ino.size()+id.birthtime_ns.size();
        }
        need(bytes <= 48*1024,OriginalReadCode::LimitExceeded);
    } catch (const OriginalReadError &) { throw; }
    catch (const std::exception &) { refused(OriginalReadCode::InvalidInput); }
}

OriginalBindingRead read_original_mcp_state(const QString &fixed_library,const QString &fixed_profiles,
    const OriginalBindingExpected &expected,MissingProfilePolicy policy) {
    validate_original_binding_request(fixed_library,fixed_profiles,expected,policy);
#ifndef Q_OS_WIN
    refused(OriginalReadCode::NotSupported);
#else
    try {
        NamespaceLease lease;
        lease.retain_target(expected.library.physical,64ULL*1024*1024);
        lease.retain_target(expected.project.physical,64ULL*1024*1024);
        lease.retain_target(expected.profiles,8ULL*1024*1024);
        const bool profile_missing = expected.profiles.state == OriginalPhysicalState::Missing;
        if (profile_missing) need(!present_leaf(fixed_profiles),OriginalReadCode::ConfigChanged);
        const auto library_sidecars = retain_sidecars(lease,fixed_library);
        const auto project_sidecars = retain_sidecars(lease,expected.project.physical.path);
        const auto profile_sidecars = retain_sidecars(lease,fixed_profiles);
        if (profile_missing)
            for (const auto &sidecar : profile_sidecars.identities)
                need(!sidecar.has_value(),OriginalReadCode::OwnerUnavailable);
#ifdef LMTI_ORIGINAL_READ_TEST_HOOKS
        detail::original_read_test_point(detail::OriginalReadPhase::AfterLeasesAcquired,fixed_library);
#endif
        const auto before = inspect_project_library(fixed_library);
        matches_original_library(before,expected);
        // Copy now; later catalog observations may never choose an I/O path.
        const auto entry = selected(before,expected.project_id);
#ifdef LMTI_ORIGINAL_READ_TEST_HOOKS
        detail::original_read_test_point(detail::OriginalReadPhase::AfterInitialLocatorCompared,fixed_library);
        detail::original_read_test_point(detail::OriginalReadPhase::BeforeProjectOpen,expected.project.physical.path);
#endif
        auto document = detail::read_original_project(expected.project.physical.path,expected.project.schema,
            expected.project_id,expected.project.store_uuid.toStdString());
        McpProfile profile{expected.project_id,0,{}};
        if (!profile_missing) {
#ifdef LMTI_ORIGINAL_READ_TEST_HOOKS
            detail::original_read_test_point(detail::OriginalReadPhase::BeforeProfileOpen,fixed_profiles);
#endif
            profile = load_mcp_profile(fixed_profiles,expected.project_id);
        }
#ifdef LMTI_ORIGINAL_READ_TEST_HOOKS
        detail::original_read_test_point(detail::OriginalReadPhase::BeforeFinalVerification,fixed_library);
#endif
        const auto after = inspect_project_library(fixed_library);
        need(before.token == after.token,OriginalReadCode::ConfigChanged);
        matches_original_library(after,expected);
        const auto &final_entry = selected(after,expected.project_id);
        need(before.token == after.token && final_entry.id == entry.id &&
             final_entry.path == entry.path && final_entry.folder == entry.folder,
             OriginalReadCode::ConfigChanged);
        check_sidecars(lease,library_sidecars);
        check_sidecars(lease,project_sidecars);
        check_sidecars(lease,profile_sidecars);
        if (profile_missing) need(!present_leaf(fixed_profiles),OriginalReadCode::ConfigChanged);
        // All owner functions destroyed their SQLite readers before this owned
        // result is built and the lease scope ends. Serialization is caller-only.
        return {before.token,entry,std::move(document),std::move(profile)};
    } catch (const OriginalReadError &) { throw; }
    catch (const detail::OriginalProjectChanged &) { refused(OriginalReadCode::ConfigChanged); }
    catch (const LibraryError &error) {
        if (error.code == LibraryCode::Conflict) refused(OriginalReadCode::ConfigChanged);
        if (error.code == LibraryCode::BudgetExceeded) refused(OriginalReadCode::LimitExceeded);
        refused(OriginalReadCode::OwnerUnavailable);
    }
    catch (const std::exception &) { refused(OriginalReadCode::OwnerUnavailable); }
#endif
}
} // namespace lmti
