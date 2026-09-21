// Native cleanup regressions operate only in the caller's private test directory.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define UNICODE
#include <windows.h>
#include <cassert>
#include "../installer/uninstall-data.h"

static void File(const std::wstring& path) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    assert(file != INVALID_HANDLE_VALUE);
    DWORD count;
    assert(WriteFile(file, "retained", 8, &count, nullptr));
    CloseHandle(file);
}

int wmain(int argc, wchar_t** argv) {
    assert(argc == 2);
    const std::wstring root = argv[1];
    const std::wstring installation = root + L"\\application";
    const std::wstring home = root + L"\\home";
    assert(CreateDirectoryW(root.c_str(), nullptr));
    assert(CreateDirectoryW(installation.c_str(), nullptr));
    assert(CreateDirectoryW(home.c_str(), nullptr));
    assert(CreateDirectoryW((home + L"\\profiles").c_str(), nullptr));
    const std::wstring desktop = home + L"\\profiles\\desktop";
    assert(CreateDirectoryW(desktop.c_str(), nullptr));
    File(home + L"\\session.jsonl");
    File(desktop + L"\\plugin.json");
    assert(uninstall_data::Remove(root.c_str(), installation.c_str()) == ERROR_ACCESS_DENIED);
    assert(uninstall_data::Remove(L"C:\\", installation.c_str()) == ERROR_INVALID_NAME);
    assert(uninstall_data::Remove(L"relative", installation.c_str()) == ERROR_INVALID_NAME);
    assert(uninstall_data::Remove(L"C:\\bad*", installation.c_str()) == ERROR_INVALID_NAME);
    PWSTR profile = nullptr;
    assert(SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Profile, 0, nullptr, &profile)));
    assert(uninstall_data::Remove(profile, installation.c_str()) == ERROR_ACCESS_DENIED);
    CoTaskMemFree(profile);
    HANDLE held = CreateFileW((desktop + L"\\plugin.json").c_str(), GENERIC_READ, FILE_SHARE_READ,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    assert(held != INVALID_HANDLE_VALUE);
    assert(uninstall_data::Remove(desktop.c_str(), installation.c_str()) == ERROR_SHARING_VIOLATION);
    CloseHandle(held);
    assert(uninstall_data::Remove(desktop.c_str(), installation.c_str()) == ERROR_SUCCESS);
    assert(GetFileAttributesW((home + L"\\session.jsonl").c_str()) != INVALID_FILE_ATTRIBUTES);
    assert(uninstall_data::Remove(desktop.c_str(), installation.c_str()) == ERROR_SUCCESS);
    assert(uninstall_data::Remove(home.c_str(), installation.c_str()) == ERROR_SUCCESS);
    assert(GetFileAttributesW(home.c_str()) == INVALID_FILE_ATTRIBUTES);
    assert(RemoveDirectoryW(installation.c_str()));
    assert(RemoveDirectoryW(root.c_str()));
}
