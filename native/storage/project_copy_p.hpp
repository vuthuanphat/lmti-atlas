#pragma once
#include "lmti/project_copy.hpp"
#include <map>
#include <memory>

namespace lmti::detail {
using CopyRegistry = std::map<std::pair<std::string, std::string>, bool>;
struct CopySnapshot {
    ProjectDocument document;
    CopyRegistry registry;
    ProjectCopyToken token;
};
// Storage-private typed snapshot/initializer, not a caller-controlled registry
// serialization API. The public owner never accepts a document or registry.
CopySnapshot capture_project_copy(const QString &path);
// Private, same-thread reservation of TWO existing stores. Canonical/physical
// aliases are refused; locks are taken in canonical order, independently of
// caller order. Snapshots are captured on the held BEGIN IMMEDIATE connections.
// No commit, SQL, registry override, automatic retry, or new-file operation.
class HeldProjectCopies final {
  public:
    HeldProjectCopies(const QString &first_path, const QString &second_path);
    ~HeldProjectCopies();
    HeldProjectCopies(const HeldProjectCopies &) = delete;
    HeldProjectCopies &operator=(const HeldProjectCopies &) = delete;
    HeldProjectCopies(HeldProjectCopies &&) = delete;
    HeldProjectCopies &operator=(HeldProjectCopies &&) = delete;
    const CopySnapshot &first() const noexcept;
    const CopySnapshot &second() const noexcept;
    // Cooperative elapsed-work/path/sidecar check before the library COMMIT.
    // This is not an OS deadline or an adversarial filesystem-race guarantee.
    void check_held() const;
  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
CopySnapshot transform_project_copy(CopySnapshot snapshot, ProjectCopyMode mode);
void initialize_project_copy(const QString &new_path, const CopySnapshot &snapshot, const QString &new_uuid);
#ifdef LMTI_COPY_OWNER_TEST_HOOKS
// Only compiled into the isolated copy test executable, never the owner library.
enum class CopyTestFault { None, BeforeIndependentVerification, BeforeVerifiedReceipt };
void set_copy_test_fault(CopyTestFault fault);
#endif
#ifdef LMTI_PROJECT_RESERVATION_TEST_HOOKS
// Isolated executable only; absent from shipped storage. The fixed test hook
// demonstrates disappearing-file refusal and lock order/failure cleanup.
enum class ReservationTestPoint { BeforeExistingOpen, AfterBegin };
using ReservationTestHook = void (*)(ReservationTestPoint, const QString &);
void set_project_reservation_test_hook(ReservationTestHook hook);
// Test the exact existing-only open against disappearance after its QFileInfo
// check, without the production keeper which pins the file on Windows.
void test_project_reservation_existing_open(const QString &path);
#endif
} // namespace lmti::detail
