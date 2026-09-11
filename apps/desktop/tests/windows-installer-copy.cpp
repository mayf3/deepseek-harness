// Exercise Shell copying against private files, including a held destination handle.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define UNICODE
#include <windows.h>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include "../installer/file-copy.h"

static void Check(bool condition) {
    if (!condition) throw std::runtime_error("Installer copy regression failed");
}

int wmain(int argc, wchar_t** argv) {
    if (argc != 2) return 2;
    const std::filesystem::path root(argv[1]);
    // The runner allocates this root exclusively and retains it on test failure.
    const auto source = root / L"source";
    const auto target = root / L"target";
    std::filesystem::create_directories(source / L"nested" / L"empty");
    std::filesystem::create_directories(target / L"nested");
    const auto filename = std::filesystem::path(L"\x6d4b\x8bd5 file.bin");
    const std::string data(8 * 1024 * 1024, 'x');
    std::ofstream(source / L"nested" / filename, std::ios::binary) << data;
    std::ofstream(source / L"hidden.txt") << "hidden";
    Check(SetFileAttributesW((source / L"hidden.txt").c_str(), FILE_ATTRIBUTE_HIDDEN) != FALSE);
    std::ofstream(target / L"nested" / filename) << "old";
    HWND window = CreateWindowExW(0, L"STATIC", L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, nullptr, nullptr);
    Check(window != nullptr);
    HANDLE locked = CreateFileW((target / L"nested" / filename).c_str(), GENERIC_READ, 0, nullptr, OPEN_EXISTING, 0, nullptr);
    Check(locked != INVALID_HANDLE_VALUE);
    const HRESULT blocked = InstallerCopyFiles(window, source.c_str(), target.c_str());
    CloseHandle(locked);
    Check(FAILED(blocked));
    Check(SUCCEEDED(InstallerCopyFiles(window, source.c_str(), target.c_str())));
    std::ifstream copied(target / L"nested" / filename, std::ios::binary);
    Check(std::string(std::istreambuf_iterator<char>(copied), {}) == data);
    copied.close();
    Check(std::filesystem::is_directory(target / L"nested" / L"empty"));
    Check(std::filesystem::file_size(target / L"hidden.txt") == 6);
    Check(reinterpret_cast<UINT_PTR>(GetPropW(window, L"HarnessInstaller.CopyProgress")) > 0);
    Check(FAILED(InstallerCopyFiles(window, (root / L"missing").c_str(), target.c_str())));
    DestroyWindow(window);
    return 0;
}
