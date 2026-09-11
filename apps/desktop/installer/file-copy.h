// Windows Shell owns recursive copying, overwrite semantics, and progress accounting.
#pragma once
#include <shobjidl.h>
#include <shellapi.h>
#include <wrl.h>
#include <string>
#include <memory>

using Microsoft::WRL::ComPtr;

class CopyProgress final : public Microsoft::WRL::RuntimeClass<
        Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, IFileOperationProgressSink> {
    HWND parent;
public:
    explicit CopyProgress(HWND window) : parent(window) {}
    IFACEMETHODIMP StartOperations() override { return S_OK; }
    IFACEMETHODIMP FinishOperations(HRESULT) override { return S_OK; }
    IFACEMETHODIMP UpdateProgress(UINT total, UINT done) override {
        if (total && parent) SetPropW(parent, L"HarnessInstaller.CopyProgress",
            reinterpret_cast<HANDLE>(static_cast<UINT_PTR>(10000ULL * done / total)));
        return S_OK;
    }
    IFACEMETHODIMP PreRenameItem(DWORD, IShellItem*, LPCWSTR) override { return S_OK; }
    IFACEMETHODIMP PostRenameItem(DWORD, IShellItem*, LPCWSTR, HRESULT, IShellItem*) override { return S_OK; }
    IFACEMETHODIMP PreMoveItem(DWORD, IShellItem*, IShellItem*, LPCWSTR) override { return S_OK; }
    IFACEMETHODIMP PostMoveItem(DWORD, IShellItem*, IShellItem*, LPCWSTR, HRESULT, IShellItem*) override { return S_OK; }
    IFACEMETHODIMP PreCopyItem(DWORD, IShellItem*, IShellItem*, LPCWSTR) override { return S_OK; }
    IFACEMETHODIMP PostCopyItem(DWORD, IShellItem*, IShellItem*, LPCWSTR, HRESULT, IShellItem*) override { return S_OK; }
    IFACEMETHODIMP PreDeleteItem(DWORD, IShellItem*) override { return S_OK; }
    IFACEMETHODIMP PostDeleteItem(DWORD, IShellItem*, HRESULT, IShellItem*) override { return S_OK; }
    IFACEMETHODIMP PreNewItem(DWORD, IShellItem*, LPCWSTR) override { return S_OK; }
    IFACEMETHODIMP PostNewItem(DWORD, IShellItem*, LPCWSTR, LPCWSTR, DWORD, HRESULT, IShellItem*) override { return S_OK; }
    IFACEMETHODIMP ResetTimer() override { return S_OK; }
    IFACEMETHODIMP PauseTimer() override { return S_OK; }
    IFACEMETHODIMP ResumeTimer() override { return S_OK; }
};

static HRESULT CopyApplication(HWND parent, LPCWSTR source, LPCWSTR destination) {
    ComPtr<IFileOperation> operation;
    HRESULT result = CoCreateInstance(CLSID_FileOperation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&operation));
    if (FAILED(result)) return result;
    result = operation->SetOperationFlags(FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOCONFIRMMKDIR |
                                         FOF_NOERRORUI | FOFX_EARLYFAILURE);
    if (FAILED(result)) return result;
    result = operation->SetOwnerWindow(parent);
    if (FAILED(result)) return result;
    auto progress = Microsoft::WRL::Make<CopyProgress>(parent);
    if (!progress) return E_OUTOFMEMORY;
    DWORD cookie;
    result = operation->Advise(progress.Get(), &cookie);
    if (FAILED(result)) return result;
    ComPtr<IShellItem> target;
    result = SHCreateItemFromParsingName(destination, nullptr, IID_PPV_ARGS(&target));
    if (FAILED(result)) return result;
    const std::wstring prefix = std::wstring(source) + L"\\";
    WIN32_FIND_DATAW entry;
    HANDLE search = FindFirstFileW((prefix + L"*").c_str(), &entry);
    if (search == INVALID_HANDLE_VALUE) return HRESULT_FROM_WIN32(GetLastError());
    std::unique_ptr<void, decltype(&FindClose)> searchOwner(search, FindClose);
    bool found = false;
    do {
        if (wcscmp(entry.cFileName, L".") == 0 || wcscmp(entry.cFileName, L"..") == 0) continue;
        found = true;
        ComPtr<IShellItem> item;
        result = SHCreateItemFromParsingName((prefix + entry.cFileName).c_str(), nullptr, IID_PPV_ARGS(&item));
        if (SUCCEEDED(result)) result = operation->CopyItem(item.Get(), target.Get(), nullptr, nullptr);
        if (FAILED(result)) break;
    } while (FindNextFileW(search, &entry));
    const DWORD enumerationError = GetLastError();
    if (FAILED(result)) return result;
    if (enumerationError != ERROR_NO_MORE_FILES) return HRESULT_FROM_WIN32(enumerationError);
    if (!found) return HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
    result = operation->PerformOperations();
    if (FAILED(result)) return result;
    BOOL aborted = FALSE;
    result = operation->GetAnyOperationsAborted(&aborted);
    if (FAILED(result)) return result;
    return aborted ? HRESULT_FROM_WIN32(ERROR_CANCELLED) : S_OK;
}

// Called synchronously by the NSIS installation worker; failures return to its retry loop.
extern "C" __declspec(dllexport) HRESULT __cdecl InstallerCopyFiles(HWND parent, LPCWSTR source, LPCWSTR destination) {
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(initialized)) return initialized;
    HRESULT result;
    try { result = CopyApplication(parent, source, destination); }
    catch (const std::bad_alloc&) { result = E_OUTOFMEMORY; }
    CoUninitialize();
    return result;
}
