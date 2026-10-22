#include "lmti/topology.hpp"
#include <cstdlib>
#include <functional>
#include <iostream>
#include <limits>

namespace {
int failures = 0;
void check(bool result, const char *message) {
    if (!result) {
        std::cerr << message << '\n';
        ++failures;
    }
}
void rejects(const std::function<void()> &fn, const char *message) {
    try {
        fn();
        check(false, message);
    } catch (const lmti::Error &) {
    }
}
} // namespace
int main() {
    auto t = lmti::demo_topology();
    lmti::validate(t);
    check(t.assets.size() == 3 && t.links.size() == 2, "demo shape");
    check(t.assets[0].observed == lmti::Observation::Unknown, "demo cannot claim online");
    auto bad = t;
    bad.assets.push_back(bad.assets[0]);
    rejects([&] { lmti::validate(bad); }, "duplicate asset accepted");
    bad = t;
    bad.links[0].to = "missing";
    rejects([&] { lmti::validate(bad); }, "dangling link accepted");
    bad = t;
    bad.links[0].to = bad.links[0].from;
    rejects([&] { lmti::validate(bad); }, "self link accepted");
    bad = t;
    bad.assets[0].x = std::numeric_limits<double>::quiet_NaN();
    rejects([&] { lmti::validate(bad); }, "NaN position accepted");
    bad = t;
    bad.assets[0].label = "invalid\nlabel";
    rejects([&] { lmti::validate(bad); }, "control character accepted");
    bad = t;
    bad.assets[0].label = std::string("\xc0\xaf", 2);
    rejects([&] { lmti::validate(bad); }, "invalid UTF8 accepted");
    bad = t;
    bad.assets[0].label = "api_key=" + std::string("fake-value-test-only");
    rejects([&] { lmti::validate(bad); }, "secret metadata accepted");
    bad = t;
    bad.assets[0].observed = lmti::Observation::Online;
    rejects([&] { lmti::validate(bad); }, "online without evidence timestamp accepted");
    t.revision = 7;
    lmti::ConfigProposal p{7, "machine-a", "factory-demo", true, false, 1000, 2000};
    const auto next = lmti::apply_proposal(t, p);
    check(next.assets[0].poll_ms == 2000 && !next.assets[0].enabled && t.assets[0].poll_ms == 1000,
          "proposal atomicity");
    p.base_revision = 6;
    rejects([&] { lmti::apply_proposal(t, p); }, "stale proposal accepted");
    p.base_revision = 7;
    p.site = "another-site";
    rejects([&] { lmti::apply_proposal(t, p); }, "wrong site proposal accepted");
    p.site = "factory-demo";
    p.desired_poll_ms = 1;
    rejects([&] { lmti::apply_proposal(t, p); }, "invalid desired interval accepted");
    check(t.assets[0].poll_ms == 1000, "rejected proposal modified source");
    // The domain validator must handle the intended inventory size.
    lmti::Topology large;
    for (int i = 0; i < 1000; ++i) {
        auto a = t.assets[0];
        a.id = "machine-" + std::to_string(i);
        large.assets.push_back(a);
    }
    lmti::validate(large);
    std::cout << "Core validation, proposal conflicts and 1,000-asset model checked\n";
    return failures ? EXIT_FAILURE : EXIT_SUCCESS;
}
