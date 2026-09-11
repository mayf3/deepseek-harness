// Real worker fractions drive the long stages; short stages retain bounded estimates.
#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>

struct InstallProgress {
    int stage = 0;
    double value = 0;
    double target = 0;
    double from = 0;
    std::uint64_t stageStarted;
    std::uint64_t animationStarted;
    bool succeeded = false;

    explicit InstallProgress(std::uint64_t now) : stageStarted(now), animationStarted(now) {}

    void Tick(std::uint64_t now) {
        const double duration = succeeded ? 600.0 : 250.0;
        const double fraction = std::min(1.0, (now - animationStarted) / duration);
        value = from + (target - from) * fraction;
    }

    void Advance(int nextStage, double fraction, std::uint64_t now) {
        Tick(now);
        if (succeeded || nextStage < stage || nextStage > 4) return;
        if (nextStage > stage) {
            stage = nextStage;
            stageStarted = now;
        }
        const double boundaries[] = {0, 2, 25, 92, 94, 99};
        if (stage == 0 || stage >= 3) {
            const double seconds = stage == 0 ? 3.0 : stage == 3 ? 1.0 : 11.0;
            fraction = 1 - std::exp(-static_cast<double>(now - stageStarted) / (seconds * 1000));
        }
        const double next = boundaries[stage] + (boundaries[stage + 1] - boundaries[stage]) *
            std::max(0.0, std::min(1.0, fraction));
        if (next > target) {
            from = value;
            target = next;
            animationStarted = now;
        }
    }

    // Only the successful NSIS finish callback may authorize 100%.
    void Complete(std::uint64_t now) {
        if (succeeded) return;
        Tick(now);
        succeeded = true;
        from = value;
        target = 100;
        animationStarted = now;
    }

    int CaptionStage() const {
        const double boundaries[] = {0, 2, 25, 92, 94};
        int caption = 0;
        while (caption < stage && value >= boundaries[caption + 1]) ++caption;
        return caption;
    }
};
