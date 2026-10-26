#pragma once
#include <atomic>

namespace copick {
// 取消与不可撤销写入竞争同一状态；提交开始后不能承诺撤销。
class OperationGate {
    enum Phase { Pending, Cancelled, Committing, Finished };
    std::atomic<Phase> phase_{Pending};
public:
    bool Committed() const { const Phase phase = phase_.load(); return phase == Committing || phase == Finished; }
    bool CancelledBeforeCommit() const { return phase_.load() == Cancelled; }
    int Cancel() {
        Phase expected = Pending;
        if (phase_.compare_exchange_strong(expected, Cancelled)) return 1;
        return expected == Cancelled ? 1 : 2;
    }
    bool TryCommit() {
        Phase expected = Pending;
        return phase_.compare_exchange_strong(expected, Committing);
    }
    void FinishCommit() { phase_.store(Finished); }
};
}
