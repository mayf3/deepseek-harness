// Deterministic user-visible progress scenarios; no wall-clock sleeps or file operations.
#include "../installer/progress.h"
#include <cassert>

int main() {
    InstallProgress progress(0);
    progress.Advance(0, 100);
    assert(progress.value < 2);
    progress.Advance(1, 200);
    assert(progress.value < 2);
    for (std::uint64_t now = 300; now <= 30200; now += 100) progress.Advance(1, now);
    assert(progress.value > 20 && progress.value < 22);
    progress.Advance(2, 30300);
    double previous = progress.value;
    for (std::uint64_t now = 30400; now <= 150300; now += 100) {
        progress.Advance(2, now);
        assert(progress.value >= previous && progress.value - previous <= 1.01);
        assert(progress.value < 92);
        previous = progress.value;
    }
    progress.Advance(1, 150400);
    assert(progress.stage == 2 && progress.value >= previous);
    progress.Advance(3, 150500);
    progress.Advance(4, 150600);
    for (std::uint64_t now = 150700; now <= 300600; now += 100) progress.Advance(4, now);
    assert(progress.value > 98 && progress.value < 100);
}
