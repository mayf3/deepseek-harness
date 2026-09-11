// Stage estimates never announce the next operation before the worker reaches it.
#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>

struct InstallProgress {
    int stage = 0;
    double value = 0;
    std::uint64_t stageStarted;
    std::uint64_t updated;

    explicit InstallProgress(std::uint64_t now) : stageStarted(now), updated(now) {}

    void Advance(int nextStage, std::uint64_t now) {
        if (nextStage > stage && nextStage <= 4) {
            stage = nextStage;
            stageStarted = now;
        }
        const double boundaries[] = {0, 2, 22, 92, 94, 100};
        const double seconds[] = {3, 33, 120, 1, 11};
        const double elapsed = (now - stageStarted) / 1000.0;
        // File copy and cleanup expose no byte callbacks. Approach the stage limit
        // gradually, leaving completion to the worker rather than a timer.
        const double ratio = elapsed / seconds[stage];
        const double fraction = ratio <= 0.95 ? ratio : 1 - 0.05 * std::exp(-(ratio - 0.95));
        const double target = boundaries[stage] + (boundaries[stage + 1] - boundaries[stage]) * fraction;
        const double bounded = std::min(boundaries[stage + 1] - 0.1, target);
        value = std::min(std::max(value, bounded), value + (now - updated) / 1000.0 * 10);
        updated = now;
    }
};
