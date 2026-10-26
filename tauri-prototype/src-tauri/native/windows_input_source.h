#pragma once

#include <cstdint>

namespace copick {
struct WindowIdentity {
    uint64_t window = 0;
    uint32_t pid = 0;
};

// Window queries stay in the Windows bridge; these comparisons are also used by
// the portable regression test without requiring an interactive Windows desktop.
inline bool ValidSource(WindowIdentity source, uint64_t liveRoot, uint32_t livePid, uint32_t ownPid) {
    return source.window && source.pid && source.pid != ownPid &&
        source.window == liveRoot && source.pid == livePid;
}
class GestureSource {
    WindowIdentity source_;
public:
    WindowIdentity Begin(uint64_t hitRoot, uint32_t hitPid) {
        source_ = {hitRoot, hitPid};
        return source_;
    }
    WindowIdentity End() {
        const WindowIdentity source = source_;
        Reset();
        return source;
    }
    void Reset() { source_ = {}; }
};
} // namespace copick
