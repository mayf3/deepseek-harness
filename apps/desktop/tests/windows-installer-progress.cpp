// Deterministic user-visible progress scenarios; no wall-clock sleeps or file operations.
#include "../installer/progress.h"
#include <cassert>

int main() {
    // Identical work fractions give the same result on fast and slow disks.
    for (std::uint64_t interval : {1000ULL, 10000ULL}) {
        InstallProgress progress(0);
        std::uint64_t now = 0;
        double previous = 0;
        for (int stage : {1, 2}) {
            for (int step = 0; step <= 10; ++step) {
                now += interval;
                progress.Advance(stage, step / 10.0, now);
                progress.Tick(now + 250);
                assert(progress.value >= previous && progress.value < 100);
                previous = progress.value;
                if (stage == 2 && step == 5) assert(progress.value == 58.5);
            }
        }
        assert(progress.value == 92);
        progress.Advance(2, 0.2, now + 300); // Retry or a revised Shell work total.
        progress.Advance(1, 1, now + 400);
        assert(progress.stage == 2 && progress.value == 92);
        progress.Advance(3, 0, now + 500);
        progress.Advance(4, 0, now + 600);
        progress.Advance(4, 0, now + 1000000);
        progress.Tick(now + 1000250);
        assert(progress.value < 100);
        assert(progress.CaptionStage() == 4);
    }

    // A stalled copy does not creep toward completion merely because time passes.
    InstallProgress stalled(0);
    stalled.Advance(2, 0.5, 0);
    stalled.Advance(2, 0.5, 1000000);
    assert(stalled.value == 58.5);
    assert(!stalled.succeeded);

    // Replay the recording's short cleanup and also a worker finishing between UI ticks.
    for (std::uint64_t cleanup : {0ULL, 2200ULL}) {
        InstallProgress progress(0);
        progress.Advance(1, 1, 25000);
        progress.Advance(2, 0, 25300);
        progress.Advance(2, 0.99, 53000);
        progress.Advance(3, 0, 53250);
        progress.Advance(4, 0, 53500);
        const auto done = 53500 + cleanup;
        progress.Complete(done);
        double previous = progress.value;
        for (std::uint64_t elapsed = 0; elapsed < 600; elapsed += 16) {
            progress.Advance(4, 1, done + elapsed);
            assert(progress.value >= previous && progress.value < 100);
            previous = progress.value;
        }
        progress.Tick(done + 600);
        assert(progress.value == 100);
        progress.Complete(done + 1000);
        assert(progress.value == 100);
    }
}
