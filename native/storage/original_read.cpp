#include "original_read_p.hpp"

namespace lmti {
#ifdef LMTI_ORIGINAL_READ_TEST_HOOKS
namespace detail {
thread_local OriginalReadTestHook original_read_hook = nullptr;
void set_original_read_test_hook(OriginalReadTestHook hook) { original_read_hook = hook; }
void original_read_test_point(OriginalReadPhase phase,const QString &path) {
    if (original_read_hook) original_read_hook(phase,path);
}
}
#endif
} // namespace lmti
