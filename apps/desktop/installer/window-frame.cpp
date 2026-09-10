// Keeps the DWM frame and shadow while the NSIS page owns the entire client area.
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#include <windows.h>
#include <objidl.h>
#include <commctrl.h>
#include <dwmapi.h>
#include <gdiplus.h>
#include <new>

using namespace Gdiplus;

struct ProgressPage {
    HWND source;
    bool dark;
    UINT dpi;
    ULONG_PTR gdiplus;
    Image* brand;
    WCHAR caption[128];
};

// NSIS shows its page after MUI's SHOW callback; keep its controls off screen.
static LRESULT CALLBACK HiddenPageProc(HWND window, UINT message, WPARAM wparam,
                                      LPARAM lparam, UINT_PTR id, DWORD_PTR) {
    if (message == WM_WINDOWPOSCHANGING) {
        auto* position = reinterpret_cast<WINDOWPOS*>(lparam);
        position->flags = (position->flags & ~SWP_SHOWWINDOW) | SWP_HIDEWINDOW;
    }
    if (message == WM_NCDESTROY) RemoveWindowSubclass(window, HiddenPageProc, id);
    return DefSubclassProc(window, message, wparam, lparam);
}

static void FillProgress(Graphics& graphics, Brush& brush, REAL width) {
    GraphicsPath path;
    path.AddArc(64.0f, 482.0f, 4.0f, 4.0f, 180.0f, 90.0f);
    path.AddArc(64.0f + width - 4, 482.0f, 4.0f, 4.0f, 270.0f, 90.0f);
    path.AddArc(64.0f + width - 4, 484.0f, 4.0f, 4.0f, 0.0f, 90.0f);
    path.AddArc(64.0f, 484.0f, 4.0f, 4.0f, 90.0f, 90.0f);
    path.CloseFigure();
    graphics.FillPath(&brush, &path);
}

static LRESULT CALLBACK ProgressProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    auto* page = reinterpret_cast<ProgressPage*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_CREATE) {
        page = static_cast<ProgressPage*>(reinterpret_cast<CREATESTRUCTW*>(lparam)->lpCreateParams);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(page));
        SetTimer(window, 1, 100, nullptr);
    }
    if (message == WM_ERASEBKGND) return 1;
    if (message == WM_TIMER) { InvalidateRect(window, nullptr, FALSE); return 0; }
    if (message == WM_LBUTTONDOWN && page) {
        const int x = LOWORD(lparam) * 96 / page->dpi;
        const int y = HIWORD(lparam) * 96 / page->dpi;
        if (y < 48) {
            HWND parent = GetParent(window);
            if (x >= 548) PostMessageW(parent, WM_CLOSE, 0, 0);
            else if (x >= 504) ShowWindow(parent, SW_MINIMIZE);
            else { ReleaseCapture(); SendMessageW(parent, WM_NCLBUTTONDOWN, HTCAPTION, 0); }
        }
        return 0;
    }
    if (message == WM_PAINT && page) {
        PAINTSTRUCT paint;
        HDC dc = BeginPaint(window, &paint);
        {
            Bitmap buffer(MulDiv(600, page->dpi, 96), MulDiv(600, page->dpi, 96), PixelFormat32bppPARGB);
            Graphics graphics(&buffer);
            graphics.ScaleTransform(page->dpi / 96.0f, page->dpi / 96.0f);
            graphics.Clear(page->dark ? Color(255, 21, 21, 23) : Color(255, 255, 255, 255));
            graphics.SetSmoothingMode(SmoothingModeAntiAlias);
            graphics.DrawImage(page->brand, Rect(0, 174, 600, 196));
            const LRESULT maximum = SendMessageW(page->source, PBM_GETRANGE, FALSE, 0);
            const LRESULT position = SendMessageW(page->source, PBM_GETPOS, 0, 0);
            const int percent = maximum > 0 ? 20 + static_cast<int>(75 * position / maximum) : 20;
            SolidBrush track(page->dark ? Color(255, 97, 102, 107) : Color(255, 233, 236, 242));
            SolidBrush ink(page->dark ? Color(255, 255, 255, 255) : Color(255, 15, 17, 21));
            FillProgress(graphics, track, 472.0f);
            FillProgress(graphics, ink, 472.0f * percent / 100);
            FontFamily family(L"Microsoft YaHei UI");
            Font font(&family, 14, FontStyleRegular, UnitPixel);
            StringFormat centered;
            centered.SetAlignment(StringAlignmentCenter);
            centered.SetLineAlignment(StringAlignmentCenter);
            WCHAR caption[160];
            wsprintfW(caption, page->caption, percent);
            graphics.DrawString(caption, -1, &font, RectF(48, 512, 504, 22), &centered, &ink);
            Font controls(&family, 16, FontStyleRegular, UnitPixel);
            graphics.DrawString(L"\x2212", -1, &controls, RectF(504, 8, 40, 32), &centered, &ink);
            graphics.DrawString(L"\x00d7", -1, &controls, RectF(548, 8, 40, 32), &centered, &ink);
            Graphics screen(dc);
            screen.DrawImage(&buffer, 0, 0);
        }
        EndPaint(window, &paint);
        return 0;
    }
    if (message == WM_NCDESTROY && page) {
        KillTimer(window, 1);
        delete page->brand;
        GdiplusShutdown(page->gdiplus);
        delete page;
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

// Runs on the NSIS UI thread; the stock installation section runs on its worker.
extern "C" __declspec(dllexport) HWND __cdecl InstallerShowProgress(HWND parent, HWND source,
        BOOL dark, UINT dpi, const WCHAR* brand, const WCHAR* caption) {
    HINSTANCE module = GetModuleHandleW(nullptr);
    WNDCLASSW type = {};
    type.lpfnWndProc = ProgressProc;
    type.hInstance = module;
    type.lpszClassName = L"HarnessInstallerProgress";
    type.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    RegisterClassW(&type);
    auto* page = new (std::nothrow) ProgressPage{};
    if (!page) return nullptr;
    GdiplusStartupInput startup;
    if (GdiplusStartup(&page->gdiplus, &startup, nullptr) != Ok) { delete page; return nullptr; }
    page->source = source;
    HWND stockPage = GetParent(source);
    if (!SetWindowSubclass(stockPage, HiddenPageProc, 1, 0)) {
        GdiplusShutdown(page->gdiplus); delete page; return nullptr;
    }
    ShowWindow(stockPage, SW_HIDE);
    page->dark = dark != FALSE;
    page->dpi = dpi;
    lstrcpynW(page->caption, caption, 128);
    page->brand = new Image(brand);
    if (page->brand->GetLastStatus() != Ok) {
        delete page->brand; GdiplusShutdown(page->gdiplus); delete page; return nullptr;
    }
    HWND window = CreateWindowExW(0, type.lpszClassName, L"", WS_CHILD | WS_VISIBLE,
        0, 0, MulDiv(600, dpi, 96), MulDiv(600, dpi, 96), parent, nullptr, module, page);
    if (!window) { delete page->brand; GdiplusShutdown(page->gdiplus); delete page; }
    return window;
}

static LRESULT CALLBACK FrameProc(HWND window, UINT message, WPARAM wparam,
                                 LPARAM lparam, UINT_PTR id, DWORD_PTR) {
    if (message == WM_NCCALCSIZE && wparam) return 0;
    if (message == WM_NCHITTEST) {
        const LRESULT hit = DefSubclassProc(window, message, wparam, lparam);
        // The installer has a fixed size; its page provides the drag area.
        return hit >= HTLEFT && hit <= HTBOTTOMRIGHT ? HTCLIENT : hit;
    }
    if (message == WM_NCDESTROY) RemoveWindowSubclass(window, FrameProc, id);
    return DefSubclassProc(window, message, wparam, lparam);
}

extern "C" __declspec(dllexport) HRESULT __cdecl InstallerApplyFrame(HWND window) {
    // NSIS may release its DLL reference before the window receives WM_NCDESTROY.
    HMODULE module = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_PIN | GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
                           reinterpret_cast<LPCWSTR>(&FrameProc), &module)) return E_FAIL;
    if (!SetWindowSubclass(window, FrameProc, 1, 0)) return E_FAIL;
    const int stockControls[] = {1, 2, 3, 1028, 1256, 1034, 1035, 1036, 1037, 1038, 1039};
    for (int id : stockControls) {
        HWND child = GetDlgItem(window, id);
        if (child) {
            if (!SetWindowSubclass(child, HiddenPageProc, 1, 0)) return E_FAIL;
            ShowWindow(child, SW_HIDE);
        }
    }
    SetWindowLongW(window, GWL_STYLE, GetWindowLongW(window, GWL_STYLE) | WS_THICKFRAME);
    const DWMNCRENDERINGPOLICY policy = DWMNCRP_ENABLED;
    HRESULT result = DwmSetWindowAttribute(window, DWMWA_NCRENDERING_POLICY, &policy, sizeof(policy));
    if (FAILED(result)) return result;
    const DWORD rounded = 2;
    // Windows 10 does not support the Windows 11 corner preference.
    DwmSetWindowAttribute(window, 33, &rounded, sizeof(rounded));
    const MARGINS margins = {1, 1, 1, 1};
    result = DwmExtendFrameIntoClientArea(window, &margins);
    SetWindowPos(window, nullptr, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    return result;
}
