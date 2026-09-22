// 7-Zip's error output is the primary evidence for an extraction failure; the report preserves it verbatim
// on disk and in the clipboard while the dialog shows only a headline and a bounded excerpt.
#pragma once
#include <windows.h>
#include <commctrl.h>
#include <shlobj.h>
#include <algorithm>
#include <string>
#include <vector>

namespace extract_report {

constexpr size_t kOutputLimit = 256 * 1024;
constexpr size_t kHeadlineLimit = 160;
constexpr size_t kExcerptLineLimit = 120;
constexpr size_t kExcerptLines = 10;
constexpr size_t kExcerptChars = 1000;

// Exit codes documented by 7-Zip; the installer treats every non-zero value as fatal.
inline const wchar_t* SevenZipMeaning(int code) {
    switch (code) {
        case 1: return L"warning: some files were not extracted";
        case 2: return L"fatal error";
        case 7: return L"command line error";
        case 8: return L"not enough memory";
        case 255: return L"stopped before completion";
        default: return L"unexpected exit code";
    }
}

inline std::wstring Trim(const std::wstring& text) {
    const auto begin = text.find_first_not_of(L" \t\r\n");
    if (begin == std::wstring::npos) return L"";
    const auto end = text.find_last_not_of(L" \t\r\n");
    return text.substr(begin, end - begin + 1);
}

inline std::vector<std::wstring> Lines(const std::wstring& text) {
    std::vector<std::wstring> lines;
    size_t start = 0;
    while (start <= text.size()) {
        const auto end = text.find(L'\n', start);
        std::wstring line = text.substr(start, end == std::wstring::npos ? std::wstring::npos : end - start);
        if (!line.empty() && line.back() == L'\r') line.pop_back();
        lines.push_back(line);
        if (end == std::wstring::npos) break;
        start = end + 1;
    }
    return lines;
}

constexpr wchar_t kEllipsis = 0x2026;

inline std::wstring Truncate(const std::wstring& text, size_t limit) {
    if (text.size() <= limit) return text;
    return text.substr(0, limit - 1) + kEllipsis;
}

inline std::wstring Win32Message(DWORD error) {
    LPWSTR buffer = nullptr;
    const DWORD length = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr, error, 0, reinterpret_cast<LPWSTR>(&buffer), 0, nullptr);
    std::wstring message = length && buffer ? Trim(std::wstring(buffer, length)) : L"";
    if (buffer) LocalFree(buffer);
    return message;
}

// Positive results are 7-Zip exit codes; negative results are negated Win32 errors from launching or supervising it.
inline std::wstring DescribeResult(int code) {
    if (code >= 0) return L"7-Zip exit code " + std::to_wstring(code) + L" (" + SevenZipMeaning(code) + L")";
    const DWORD error = static_cast<DWORD>(-static_cast<long long>(code));
    std::wstring message = Win32Message(error);
    return L"Windows error " + std::to_wstring(error) + L" while running 7-Zip" + (message.empty() ? L"" : L" (" + message + L")");
}

// 7-Zip prefixes the failing operation and path with "ERROR:"; the bare archive name it prints first says nothing.
inline std::wstring Headline(int code, const std::wstring& output) {
    std::wstring fallback;
    for (const std::wstring& raw : Lines(output)) {
        const std::wstring line = Trim(raw);
        const auto marker = line.find(L"ERROR");
        if (marker == std::wstring::npos) continue;
        const std::wstring detail = Trim(line.substr(line.find(L':', marker) == std::wstring::npos ? line.size() : line.find(L':', marker) + 1));
        if (detail.empty()) continue;
        if (detail.find(L" : ") != std::wstring::npos || detail.find(L' ') != std::wstring::npos) return Truncate(line, kHeadlineLimit);
        if (fallback.empty()) fallback = line;
    }
    if (!fallback.empty()) return Truncate(fallback, kHeadlineLimit);
    return DescribeResult(code);
}

inline std::wstring Compose(int code, const std::wstring& archive, const std::wstring& destination, const std::wstring& output,
                            const std::wstring& timestamp, const std::wstring& windowsVersion) {
    std::wstring report = L"DeepSeek Harness installer: extraction failed\r\n";
    report += L"Time: " + timestamp + L"\r\n";
    report += L"Result: " + DescribeResult(code) + L"\r\n";
    report += L"Archive: " + archive + L"\r\n";
    report += L"Destination: " + destination + L"\r\n";
    report += L"Windows: " + windowsVersion + L"\r\n";
    report += L"\r\n7-Zip output:\r\n";
    const std::wstring trimmed = Trim(output);
    if (trimmed.empty()) {
        report += L"(none)\r\n";
    } else {
        for (const std::wstring& line : Lines(trimmed)) report += line + L"\r\n";
    }
    return report;
}

// The dialog stays compact: long lines are cut and a trailing note counts what the report still holds.
inline std::wstring Excerpt(const std::wstring& report, size_t maxLines = kExcerptLines, size_t maxChars = kExcerptChars) {
    const std::vector<std::wstring> lines = Lines(Trim(report));
    std::wstring excerpt;
    size_t shown = 0;
    for (const std::wstring& line : lines) {
        const std::wstring cut = Truncate(line, kExcerptLineLimit);
        if (shown == maxLines || excerpt.size() + cut.size() + 2 > maxChars) break;
        excerpt += (shown ? L"\r\n" : L"") + cut;
        ++shown;
    }
    if (shown < lines.size()) {
        excerpt += L"\r\n" + std::wstring(1, kEllipsis) + L" (" + std::to_wstring(lines.size() - shown) + L" more lines in the saved report)";
    }
    return excerpt;
}

inline std::wstring Decode(const std::string& bytes) {
    if (bytes.empty()) return L"";
    for (UINT codePage : {static_cast<UINT>(CP_UTF8), static_cast<UINT>(CP_ACP)}) {
        const DWORD flags = codePage == CP_UTF8 ? MB_ERR_INVALID_CHARS : 0;
        const int length = MultiByteToWideChar(codePage, flags, bytes.data(), static_cast<int>(bytes.size()), nullptr, 0);
        if (length <= 0) continue;
        std::wstring text(static_cast<size_t>(length), L'\0');
        MultiByteToWideChar(codePage, flags, bytes.data(), static_cast<int>(bytes.size()), &text[0], length);
        return text;
    }
    return L"(undecodable 7-Zip output)";
}

inline std::wstring ReadOutput(LPCWSTR path) {
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return L"";
    std::string bytes;
    char buffer[8192];
    DWORD count = 0;
    while (bytes.size() < kOutputLimit && ReadFile(file, buffer, sizeof(buffer), &count, nullptr) && count) {
        bytes.append(buffer, std::min<size_t>(count, kOutputLimit - bytes.size()));
    }
    CloseHandle(file);
    return Decode(bytes);
}

inline std::wstring Timestamp() {
    SYSTEMTIME now;
    GetLocalTime(&now);
    WCHAR text[32];
    wsprintfW(text, L"%04u-%02u-%02u %02u:%02u:%02u", now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond);
    return text;
}

inline std::wstring WindowsVersion() {
    typedef LONG(WINAPI * RtlGetVersionFn)(PRTL_OSVERSIONINFOW);
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    auto getVersion = ntdll ? reinterpret_cast<RtlGetVersionFn>(GetProcAddress(ntdll, "RtlGetVersion")) : nullptr;
    RTL_OSVERSIONINFOW info = {};
    info.dwOSVersionInfoSize = sizeof(info);
    if (!getVersion || getVersion(&info) != 0) return L"unknown";
    WCHAR text[64];
    wsprintfW(text, L"%u.%u.%u", info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber);
    return text;
}

inline bool WriteUtf8(LPCWSTR path, const std::wstring& text) {
    std::wstring directory(path);
    const auto separator = directory.find_last_of(L"\\/");
    if (separator != std::wstring::npos) {
        directory.resize(separator);
        const int created = SHCreateDirectoryExW(nullptr, directory.c_str(), nullptr);
        if (created != ERROR_SUCCESS && created != ERROR_ALREADY_EXISTS && created != ERROR_FILE_EXISTS) return false;
    }
    const int length = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    if (length <= 0) return false;
    std::string bytes("\xEF\xBB\xBF", 3);
    bytes.resize(3 + static_cast<size_t>(length));
    WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), &bytes[3], length, nullptr, nullptr);
    HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    DWORD written = 0;
    const bool complete = WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) && written == bytes.size();
    CloseHandle(file);
    return complete;
}

inline bool CopyToClipboard(HWND owner, const std::wstring& text) {
    const size_t bytes = (text.size() + 1) * sizeof(wchar_t);
    HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, bytes);
    if (!memory) return false;
    void* target = GlobalLock(memory);
    if (!target) { GlobalFree(memory); return false; }
    memcpy(target, text.c_str(), bytes);
    GlobalUnlock(memory);
    bool copied = false;
    for (int attempt = 0; attempt < 5 && !copied; ++attempt) {
        if (attempt) Sleep(50);
        if (!OpenClipboard(owner)) continue;
        copied = EmptyClipboard() && SetClipboardData(CF_UNICODETEXT, memory) != nullptr;
        CloseClipboard();
    }
    if (!copied) GlobalFree(memory);
    return copied;
}

struct DialogStrings {
    LPCWSTR title;
    LPCWSTR heading;
    LPCWSTR copy;
    LPCWSTR expand;
    LPCWSTR collapse;
    LPCWSTR footer;
    LPCWSTR copied;
};

struct DialogState {
    const std::wstring* report;
    const DialogStrings* strings;
};

constexpr int kCopyButton = 1001;

inline HRESULT CALLBACK DialogCallback(HWND dialog, UINT notification, WPARAM wparam, LPARAM, LONG_PTR data) {
    auto* state = reinterpret_cast<DialogState*>(data);
    if (notification == TDN_BUTTON_CLICKED && static_cast<int>(wparam) == kCopyButton && state) {
        if (CopyToClipboard(dialog, *state->report)) {
            SendMessageW(dialog, TDM_SET_ELEMENT_TEXT, TDE_FOOTER, reinterpret_cast<LPARAM>(state->strings->copied));
        }
        return S_FALSE;
    }
    return S_OK;
}

// The task dialog comes from the comctl32 v6 the installer already loads; without it a message box carries the headline.
inline void Show(HWND parent, const std::wstring& headline, const std::wstring& excerpt, const std::wstring& report, const DialogStrings& strings) {
    typedef HRESULT(WINAPI * TaskDialogIndirectFn)(const TASKDIALOGCONFIG*, int*, int*, BOOL*);
    HMODULE comctl = GetModuleHandleW(L"comctl32.dll");
    if (!comctl) comctl = LoadLibraryW(L"comctl32.dll");
    auto taskDialog = comctl ? reinterpret_cast<TaskDialogIndirectFn>(GetProcAddress(comctl, "TaskDialogIndirect")) : nullptr;
    if (taskDialog) {
        DialogState state{&report, &strings};
        TASKDIALOG_BUTTON buttons[] = {{kCopyButton, strings.copy}};
        TASKDIALOGCONFIG config = {};
        config.cbSize = sizeof(config);
        config.hwndParent = parent;
        config.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW;
        config.dwCommonButtons = TDCBF_OK_BUTTON;
        config.pszWindowTitle = strings.title;
        config.pszMainIcon = TD_WARNING_ICON;
        config.pszMainInstruction = strings.heading;
        config.pszContent = headline.c_str();
        config.cButtons = 1;
        config.pButtons = buttons;
        config.nDefaultButton = IDOK;
        config.pszExpandedInformation = excerpt.c_str();
        config.pszExpandedControlText = strings.collapse;
        config.pszCollapsedControlText = strings.expand;
        config.pszFooterIcon = TD_INFORMATION_ICON;
        config.pszFooter = strings.footer;
        config.pfCallback = DialogCallback;
        config.lpCallbackData = reinterpret_cast<LONG_PTR>(&state);
        config.cxWidth = 320;
        int pressed = 0;
        if (SUCCEEDED(taskDialog(&config, &pressed, nullptr, nullptr))) return;
    }
    const std::wstring text = std::wstring(strings.heading) + L"\r\n\r\n" + headline + L"\r\n\r\n" + strings.footer;
    MessageBoxW(parent, text.c_str(), strings.title, MB_OK | MB_ICONEXCLAMATION | MB_SETFOREGROUND);
}

}  // namespace extract_report
