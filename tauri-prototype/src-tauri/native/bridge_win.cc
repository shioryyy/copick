#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN 1
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <ole2.h>
#include <UIAutomation.h>
#include <windows.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "programs.h"
#include "windows_input_source.h"
#include "operation_gate.h"
#include "core/engine.h"
#include "lib/utils.h"

extern "C" {
struct InputEvent {
    int kind;
    double x;
    double y;
    int gesture;
    uint64_t sourceWindow;
    int sourcePid;
    uint64_t clipboardSequence;
    uint64_t cursor;
};
struct CaptureRequest {
    uint64_t requestId;
    double x;
    double y;
    int fallback;
    uint64_t sourceWindow;
    int sourcePid;
    uint64_t clipboardSequence;
    uint64_t mouseDownCursor;
    uint64_t mouseUpCursor;
};
struct Selection {
    const char *text;
    size_t length;
    int pid;
    uint64_t window;
    double x;
    double y;
    int method;
    // 小写程序标识（UTF-8）。只用于托盘文案与排除项，指针在回调返回前有效。
    const char *program;
};
using InputCallback = void (*)(InputEvent);
using CaptureCallback = void (*)(uint64_t, const Selection *);
using CopyCallback = void (*)(uint64_t, int);
}

namespace {
using Clock = std::chrono::steady_clock;
constexpr auto requestTimeout = std::chrono::milliseconds(1800);
constexpr size_t maxTextBytes = 1024 * 1024;

struct Source { HWND hwnd = nullptr; DWORD pid = 0; DWORD clipboardSequence = 0; POINT down = {}; HCURSOR downCursor = nullptr; };

// Worker messages contain only owned native values. Rust pointers never enter this queue.
struct Request {
    enum class Kind { Capture, Copy };
    Kind kind = Kind::Capture;
    Source source;
    uint64_t id = 0;
    double x = 0, y = 0;
    CaptureCallback captureCallback = nullptr;
    CopyCallback copyCallback = nullptr;
    SelectionConfigSnapshot config;
    std::wstring copyText;
    TextSelectionInfo selection;
    std::string utf8;
    std::string program;
    DWORD endingSequence = 0;
    std::atomic<bool> cancel{false};
    copick::OperationGate gate;
    std::atomic<RetrievalStage> stage{RetrievalStage::Idle};
};

struct Worker {
    std::mutex mutex;
    std::condition_variable cv;
    std::shared_ptr<Request> pending;
    std::shared_ptr<Request> active;
    std::atomic<bool> stop{false};
    bool ready = false;
    bool initialized = false;
    bool exited = false;
};

struct Hooks {
    std::atomic<InputCallback> callback{nullptr};
    std::atomic<bool> stop{false};
    std::atomic<bool> listening{false};
    std::atomic<DWORD> threadId{0};
    std::mutex mutex;
    std::condition_variable cv;
    bool ready = false;
    bool exited = false;
    bool leftDown = false, dragging = false, doubleClick = false, previousClick = false, shiftDown = false;
    POINT down = {}, previousDown = {};
    copick::GestureSource gestureSource;
    DWORD previousTime = 0;
};
struct Bridge {
    DWORD mainThread = 0;
    bool disabled = false;
    Source armed, delivered;
    std::shared_ptr<Worker> worker;
    std::shared_ptr<Hooks> hooks;
    HWND popup = nullptr;
    WNDPROC popupProc = nullptr;
};
Bridge &State() { static Bridge *state = new Bridge; return *state; }
thread_local Hooks *currentHooks = nullptr;

bool OnMainThread() {
    Bridge &state = State();
    if (!state.mainThread) state.mainThread = GetCurrentThreadId();
    return state.mainThread == GetCurrentThreadId();
}
DWORD WindowPid(HWND hwnd) {
    DWORD pid = 0;
    if (hwnd && IsWindow(hwnd)) GetWindowThreadProcessId(hwnd, &pid);
    return pid;
}
bool SourceValid(const Source &source) {
    return copick::ValidSource({reinterpret_cast<uint64_t>(source.hwnd), source.pid},
        reinterpret_cast<uint64_t>(GetAncestor(source.hwnd, GA_ROOT)), WindowPid(source.hwnd), GetCurrentProcessId());
}
bool ForegroundMatches(const Source &source) {
    return SourceValid(source) && GetForegroundWindow() == source.hwnd;
}
bool ValidPopup(HWND hwnd) { return hwnd && WindowPid(hwnd) == GetCurrentProcessId(); }
HCURSOR CurrentCursor() {
    CURSORINFO info = {}; info.cbSize = sizeof(info);
    return GetCursorInfo(&info) ? info.hCursor : nullptr;
}
class PhysicalCoordinates {
    using Setter = HANDLE (WINAPI *)(HANDLE);
    Setter setter_ = nullptr; HANDLE previous_ = nullptr;
public:
    PhysicalCoordinates() {
        setter_ = reinterpret_cast<Setter>(GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetThreadDpiAwarenessContext"));
        if (setter_) previous_ = setter_(reinterpret_cast<HANDLE>(static_cast<INT_PTR>(-4)));
    }
    ~PhysicalCoordinates() { if (setter_ && previous_) setter_(previous_); }
};
bool ToUtf8(const std::wstring &text, std::string &out) {
    if (text.empty() || text.size() > maxTextBytes || text.find(L'\0') != std::wstring::npos || IsTrimmedEmpty(text)) return false;
    int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    if (count <= 0 || static_cast<size_t>(count) > maxTextBytes) return false;
    out.resize(static_cast<size_t>(count));
    return WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), &out[0], count, nullptr, nullptr) == count;
}
bool FromUtf8(const char *text, size_t length, std::wstring &out) {
    if (!text || !length || length > maxTextBytes || std::memchr(text, 0, length)) return false;
    int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, static_cast<int>(length), nullptr, 0);
    if (count <= 0) return false;
    out.resize(static_cast<size_t>(count));
    return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, static_cast<int>(length), &out[0], count) == count;
}

LRESULT CALLBACK ClipboardOwnerProc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
    if (message == WM_MOUSEACTIVATE) return MA_NOACTIVATE;
    if (message == WM_DESTROYCLIPBOARD || message == WM_RENDERFORMAT || message == WM_RENDERALLFORMATS) return 0;
    return DefWindowProcW(hwnd, message, wparam, lparam);
}
HWND CreateClipboardOwner() {
    WNDCLASSW windowClass = {};
    windowClass.lpfnWndProc = ClipboardOwnerProc;
    windowClass.hInstance = GetModuleHandleW(nullptr);
    windowClass.lpszClassName = L"CopickStandaloneClipboardOwner";
    if (!RegisterClassW(&windowClass) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return nullptr;
    return CreateWindowExW(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW, windowClass.lpszClassName, L"", WS_POPUP,
        0, 0, 0, 0, nullptr, nullptr, windowClass.hInstance, nullptr);
}
bool WriteClipboardOwned(Request &request, HWND owner) {
    if (request.cancel.load() || !ValidPopup(owner) || !ForegroundMatches(request.source)) return false;
    HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, (request.copyText.size() + 1) * sizeof(wchar_t));
    if (!memory) return false;
    void *destination = GlobalLock(memory);
    if (!destination) { GlobalFree(memory); return false; }
    std::memcpy(destination, request.copyText.c_str(), (request.copyText.size() + 1) * sizeof(wchar_t));
    GlobalUnlock(memory);
    bool opened = false;
    const auto deadline = Clock::now() + std::chrono::milliseconds(250);
    while (!request.cancel.load() && ForegroundMatches(request.source) && ValidPopup(owner)) {
        if (OpenClipboard(owner)) { opened = true; break; }
        if (Clock::now() >= deadline) break;
        Sleep(5);
    }
    bool ok = false;
    if (opened) {
        if (!request.cancel.load() && ForegroundMatches(request.source) && ValidPopup(owner) && request.gate.TryCommit()) {
            if (EmptyClipboard() && SetClipboardData(CF_UNICODETEXT, memory)) { memory = nullptr; ok = true; }
            request.gate.FinishCommit();
        }
        CloseClipboard();
    }
    if (memory) GlobalFree(memory);
    request.endingSequence = GetClipboardSequenceNumber();
    return ok;
}

void WorkerMain(const std::shared_ptr<Worker> &worker) {
    PhysicalCoordinates coordinates;
    HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    IUIAutomation *automation = nullptr;
    HRESULT created = FAILED(initialized) ? initialized : CoCreateInstance(CLSID_CUIAutomation,
        nullptr, CLSCTX_INPROC_SERVER, IID_IUIAutomation, reinterpret_cast<void **>(&automation));
    HWND owner = SUCCEEDED(created) && automation ? CreateClipboardOwner() : nullptr;
    {
        std::lock_guard<std::mutex> lock(worker->mutex);
        worker->initialized = SUCCEEDED(created) && automation && owner; worker->ready = true;
    }
    worker->cv.notify_all();
    if (SUCCEEDED(created) && automation && owner) {
        SelectionEngine engine(automation);
        while (!worker->stop.load()) {
            MSG message = {};
            while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
            std::shared_ptr<Request> request;
            {
                std::unique_lock<std::mutex> lock(worker->mutex);
                worker->cv.wait_for(lock, std::chrono::milliseconds(10), [&] { return worker->stop.load() || worker->pending; });
                if (worker->stop.load()) break;
                if (!worker->pending) continue;
                request = std::move(worker->pending); worker->active = request;
            }
            bool ok = false;
            try {
                if (!request->cancel.load() && ForegroundMatches(request->source)) {
                    if (request->kind == Request::Kind::Copy) ok = WriteClipboardOwned(*request, owner);
                    else {
                        std::wstring program;
                        if (GetProgramNameFromHwnd(request->source.hwnd, program)) {
                            ok = engine.GetSelectedText(request->source.hwnd, request->selection, request->config,
                                ClipboardLockMode::InterruptibleWait, &request->cancel, &request->stage, &request->endingSequence);
                            ok = ok && !request->cancel.load() && ForegroundMatches(request->source) && ToUtf8(request->selection.text, request->utf8);
                        }
                    }
                }
            } catch (...) { ok = false; }
            if (request->kind == Request::Kind::Copy) {
                // Once committed, report the actual write result even if focus/cancellation changes.
                request->copyCallback(request->id, ok ? 1 : request->gate.Committed() ? 2 : 0);
            } else {
                ok = ok && !request->cancel.load() && ForegroundMatches(request->source);
                double x = request->x, y = request->y;
                if (request->selection.posLevel >= SelectionPositionLevel::Full) {
                    x = request->selection.endBottom.x; y = request->selection.endBottom.y;
                }
                if (ok) ToUtf8(request->selection.programName, request->program);
                Selection selection = {request->utf8.data(), request->utf8.size(),
                    static_cast<int>(request->source.pid), reinterpret_cast<uint64_t>(request->source.hwnd),
                    x, y, static_cast<int>(request->selection.method), request->program.c_str()};
                request->captureCallback(request->id, ok ? &selection : nullptr);
            }
            { std::lock_guard<std::mutex> lock(worker->mutex); worker->active.reset(); }
        }
    }
    if (owner) DestroyWindow(owner);
    if (automation) automation->Release();
    if (SUCCEEDED(initialized)) CoUninitialize();
    { std::lock_guard<std::mutex> lock(worker->mutex); worker->exited = true; }
    worker->cv.notify_all();
}
int CancelRequest(const std::shared_ptr<Request> &request) {
    if (!request) return 0;
    const int result = request->gate.Cancel();
    if (result == 1) request->cancel.store(true);
    return result;
}
void CancelWorker(const std::shared_ptr<Worker> &worker) {
    if (!worker) return;
    worker->stop.store(true);
    { std::lock_guard<std::mutex> lock(worker->mutex); CancelRequest(worker->pending); CancelRequest(worker->active); }
    worker->cv.notify_all();
}
bool EnsureWorker() {
    Bridge &state = State(); if (state.disabled) return false; if (state.worker) return true;
    auto worker = std::make_shared<Worker>();
    try { std::thread(WorkerMain, worker).detach(); } catch (...) { return false; }
    state.worker = worker;
    std::unique_lock<std::mutex> lock(worker->mutex);
    bool ready = worker->cv.wait_for(lock, requestTimeout, [&] { return worker->ready; });
    bool ok = ready && worker->initialized; lock.unlock();
    if (!ok) { state.disabled = true; CancelWorker(worker); }
    return ok;
}
bool RunRequest(const std::shared_ptr<Request> &request) {
    Bridge &state = State();
    if (!state.worker || state.disabled || !ForegroundMatches(request->source)) return false;
    auto worker = state.worker;
    {
        std::lock_guard<std::mutex> lock(worker->mutex);
        if (worker->stop.load() || worker->pending || worker->active) return false;
        worker->pending = request;
    }
    worker->cv.notify_one();
    return true;
}
void Emit(Hooks &hooks, InputEvent event) { if (auto callback = hooks.callback.load(std::memory_order_acquire)) callback(event); }
LRESULT CALLBACK MouseHook(int code, WPARAM message, LPARAM data) {
    Hooks *hooks = currentHooks;
    if (code == HC_ACTION && hooks && !hooks->stop.load()) {
        const auto &mouse = *reinterpret_cast<const MSLLHOOKSTRUCT *>(data);
        // SendInput 鼠标也必须被视为真实鼠标，否则集成验证和辅助设备失效。
        InputEvent event = {0, static_cast<double>(mouse.pt.x), static_cast<double>(mouse.pt.y), 0, 0, 0, 0, 0};
        copick::WindowIdentity source;
        if (message == WM_LBUTTONDOWN) {
            // The low-level hook runs before a background target is activated.
            // Bind the whole gesture to the hit root, not the old foreground.
            HWND root = GetAncestor(WindowFromPoint(mouse.pt), GA_ROOT);
            source = hooks->gestureSource.Begin(reinterpret_cast<uint64_t>(root), WindowPid(root));
            hooks->doubleClick = hooks->previousClick && mouse.time - hooks->previousTime <= GetDoubleClickTime() &&
                std::abs(static_cast<double>(mouse.pt.x) - hooks->previousDown.x) <= GetSystemMetrics(SM_CXDOUBLECLK) / 2.0 &&
                std::abs(static_cast<double>(mouse.pt.y) - hooks->previousDown.y) <= GetSystemMetrics(SM_CYDOUBLECLK) / 2.0;
            hooks->down = mouse.pt; hooks->leftDown = true; hooks->dragging = false; event.kind = 1;
        } else if (message == WM_MOUSEMOVE && hooks->leftDown) {
            if (std::hypot(static_cast<double>(mouse.pt.x) - hooks->down.x, static_cast<double>(mouse.pt.y) - hooks->down.y) > 3) hooks->dragging = true;
        } else if (message == WM_LBUTTONUP) {
            source = hooks->gestureSource.End();
            event.kind = 2; event.gesture = hooks->leftDown && (hooks->dragging || hooks->doubleClick || hooks->shiftDown);
            hooks->previousClick = hooks->leftDown && !hooks->dragging && !hooks->doubleClick;
            hooks->previousDown = hooks->down; hooks->previousTime = mouse.time; hooks->leftDown = false; hooks->dragging = false;
        } else if (message == WM_RBUTTONDOWN || message == WM_MBUTTONDOWN || message == WM_XBUTTONDOWN) {
            hooks->leftDown = false; hooks->previousClick = false; hooks->gestureSource.Reset(); event.kind = 1;
        } else if (message == WM_RBUTTONUP || message == WM_MBUTTONUP || message == WM_XBUTTONUP || message == WM_MOUSEWHEEL || message == WM_MOUSEHWHEEL) {
            hooks->leftDown = false; hooks->previousClick = false; hooks->gestureSource.Reset(); event.kind = 3;
        }
        if (event.kind) {
            event.sourceWindow = source.window;
            event.sourcePid = static_cast<int>(source.pid);
            event.clipboardSequence = GetClipboardSequenceNumber();
            event.cursor = reinterpret_cast<uint64_t>(CurrentCursor());
            Emit(*hooks, event);
        }
    }
    return CallNextHookEx(nullptr, code, message, data);
}
LRESULT CALLBACK KeyboardHook(int code, WPARAM message, LPARAM data) {
    Hooks *hooks = currentHooks;
    if (code == HC_ACTION && hooks && !hooks->stop.load()) {
        const auto &key = *reinterpret_cast<const KBDLLHOOKSTRUCT *>(data);
        if (!(key.flags & LLKHF_INJECTED)) {
            const bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
            if (key.vkCode == VK_SHIFT || key.vkCode == VK_LSHIFT || key.vkCode == VK_RSHIFT) hooks->shiftDown = down;
            if (down) { POINT point = {}; GetPhysicalCursorPos(&point); Emit(*hooks, {3, static_cast<double>(point.x), static_cast<double>(point.y), 0, 0, 0, 0, 0}); }
        }
    }
    return CallNextHookEx(nullptr, code, message, data);
}
void HookMain(const std::shared_ptr<Hooks> &hooks) {
    PhysicalCoordinates coordinates; currentHooks = hooks.get(); MSG message = {}; PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
    hooks->threadId.store(GetCurrentThreadId()); hooks->shiftDown = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
    HHOOK mouse = SetWindowsHookExW(WH_MOUSE_LL, MouseHook, GetModuleHandleW(nullptr), 0);
    HHOOK keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, KeyboardHook, GetModuleHandleW(nullptr), 0);
    hooks->listening.store(mouse && keyboard);
    { std::lock_guard<std::mutex> lock(hooks->mutex); hooks->ready = true; } hooks->cv.notify_all();
    if (mouse && keyboard) while (!hooks->stop.load() && GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
    if (mouse) UnhookWindowsHookEx(mouse); if (keyboard) UnhookWindowsHookEx(keyboard);
    hooks->listening.store(false); hooks->callback.store(nullptr); currentHooks = nullptr;
    { std::lock_guard<std::mutex> lock(hooks->mutex); hooks->exited = true; } hooks->cv.notify_all();
}
void StopHooks() {
    Bridge &state = State(); auto hooks = state.hooks; if (!hooks) return;
    hooks->callback.store(nullptr); hooks->stop.store(true); DWORD thread = hooks->threadId.load(); if (thread) PostThreadMessageW(thread, WM_QUIT, 0, 0);
    std::unique_lock<std::mutex> lock(hooks->mutex); bool exited = hooks->cv.wait_for(lock, std::chrono::milliseconds(200), [&] { return hooks->exited; });
    if (!exited) state.disabled = true; state.hooks.reset();
}
LRESULT CALLBACK PopupProc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
    Bridge &state = State(); WNDPROC previous = state.popupProc;
    if (message == WM_MOUSEACTIVATE) return MA_NOACTIVATE;
    if (message == WM_NCDESTROY && hwnd == state.popup) { state.popup = nullptr; state.popupProc = nullptr; }
    return previous ? CallWindowProcW(previous, hwnd, message, wparam, lparam) : DefWindowProcW(hwnd, message, wparam, lparam);
}
UINT MonitorDpi(HMONITOR monitor, HWND hwnd) {
    UINT dpi = 96;
    using WindowDpi = UINT (WINAPI *)(HWND);
    auto windowDpi = reinterpret_cast<WindowDpi>(GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForWindow"));
    if (windowDpi) { UINT value = windowDpi(hwnd); if (value) dpi = value; }
    HMODULE shcore = LoadLibraryExW(L"shcore.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (shcore) {
        using MonitorDpiFn = HRESULT (WINAPI *)(HMONITOR, int, UINT *, UINT *);
        auto fn = reinterpret_cast<MonitorDpiFn>(GetProcAddress(shcore, "GetDpiForMonitor"));
        UINT x = 0, y = 0; if (fn && SUCCEEDED(fn(monitor, 0, &x, &y)) && x) dpi = x; FreeLibrary(shcore);
    }
    return dpi;
}
} // namespace

extern "C" bool cp_permission(bool) { return true; }
extern "C" void cp_open_settings() {}
extern "C" bool cp_snapshot_popup(const char *) { return false; }
extern "C" int cp_front_pid() { return static_cast<int>(WindowPid(GetForegroundWindow())); }
// 物理像素坐标，与 UIA 的 endBottom 及输入事件使用同一空间。
extern "C" bool cp_cursor_position(double *x, double *y) {
    POINT point;
    if (!x || !y || !GetCursorPos(&point)) return false;
    *x = point.x; *y = point.y;
    return true;
}
extern "C" bool cp_start(InputCallback callback) {
    if (!OnMainThread() || !callback || State().disabled) return false;
    Bridge &state = State(); if (state.hooks && state.hooks->listening.load()) return true;
    try {
        StopHooks(); if (state.disabled || !EnsureWorker()) return false;
        auto hooks = std::make_shared<Hooks>(); hooks->callback.store(callback); std::thread(HookMain, hooks).detach(); state.hooks = hooks;
        std::unique_lock<std::mutex> lock(hooks->mutex); bool ready = hooks->cv.wait_for(lock, requestTimeout, [&] { return hooks->ready; });
        bool ok = ready && hooks->listening.load(); lock.unlock(); if (!ok) StopHooks(); return ok;
    } catch (...) { return false; }
}
extern "C" void cp_stop() {
    if (!OnMainThread()) return;
    Bridge &state = State(); StopHooks(); state.armed = {}; state.delivered = {};
    if (state.worker) {
        std::lock_guard<std::mutex> lock(state.worker->mutex);
        CancelRequest(state.worker->pending);
        CancelRequest(state.worker->active);
    }
}
extern "C" bool cp_listening() { return OnMainThread() && !State().disabled && State().hooks && State().hooks->listening.load(); }
extern "C" bool cp_source_matches(int pid, uint64_t window) {
    Source source; source.pid = static_cast<DWORD>(pid); source.hwnd = reinterpret_cast<HWND>(window);
    return ForegroundMatches(source);
}
extern "C" void cp_arm(const InputEvent *event) {
    if (!OnMainThread() || !event) return;
    Bridge &state = State(); state.armed = {}; state.delivered = {};
    Source source;
    source.hwnd = reinterpret_cast<HWND>(event->sourceWindow);
    source.pid = static_cast<DWORD>(std::max(event->sourcePid, 0));
    source.clipboardSequence = static_cast<DWORD>(event->clipboardSequence);
    source.downCursor = reinterpret_cast<HCURSOR>(event->cursor);
    // Main-thread delivery can precede activation; capture still requires foreground.
    if (SourceValid(source)) state.armed = source;
}
static std::vector<std::string> excludedApps;
extern "C" void cp_set_excluded(const char *const *names, size_t count) {
    excludedApps.clear();
    for (size_t index = 0; index < count; ++index) excludedApps.emplace_back(names[index]);
}
extern "C" bool cp_capture_begin(const CaptureRequest *input, CaptureCallback callback) {
    if (!OnMainThread() || State().disabled || !input || !callback || !std::isfinite(input->x) || !std::isfinite(input->y)) return false;
    const Source source = State().armed;
    if (!ForegroundMatches(source) || source.pid != static_cast<DWORD>(input->sourcePid) ||
        reinterpret_cast<uint64_t>(source.hwnd) != input->sourceWindow) return false;
    try {
        auto request = std::make_shared<Request>();
        request->id = input->requestId; request->x = input->x; request->y = input->y;
        request->captureCallback = callback; request->source = source;
        request->endingSequence = source.clipboardSequence;
        // 回退仅在无障碍取词失败后由引擎触发。request->cancel 作为 stop token 传入
        // GetSelectedText，引擎在备份后、发送快捷键前和轮询中都会检查它，取消时恢复
        // 备份；与已发布 Electron 版的暴露面一致，并多了事务内取消。
        request->config.clipboardEnabled = input->fallback != 0;
        request->config.triggeredByUser = false; request->config.clipboardSequence = source.clipboardSequence;
        request->config.mouseDownCursor = source.downCursor;
        request->config.mouseUpCursor = reinterpret_cast<HCURSOR>(input->mouseUpCursor);
        request->config.globalFilterMode = FilterMode::ExcludeList;
        request->config.globalFilterList = copick::WithExcluded(copick::ProtectedPrograms(), excludedApps);
        request->config.clipboardFilterMode = FilterMode::ExcludeList;
        // 终端与凭据界面已由全局列表拦截；复制备份列表再追加 IDE 与用户排除项，
        // 与 Electron 版 [...blockedPrograms, ...NO_CLIPBOARD] 的组合方式一致。
        request->config.clipboardFilterList = copick::ClipboardExclusions(excludedApps);
        if (!RunRequest(request)) return false;
        State().delivered = source;
        return true;
    } catch (...) { return false; }
}
extern "C" bool cp_copy_begin(uint64_t id, const char *text, size_t length, int pid, uint64_t window, CopyCallback callback) {
    if (!OnMainThread() || State().disabled || !callback || pid <= 0 || State().delivered.pid != static_cast<DWORD>(pid) ||
        reinterpret_cast<uint64_t>(State().delivered.hwnd) != window || !ForegroundMatches(State().delivered) || !ValidPopup(State().popup)) return false;
    try {
        auto request = std::make_shared<Request>(); request->kind = Request::Kind::Copy;
        request->id = id; request->copyCallback = callback; request->source = State().delivered;
        if (!FromUtf8(text, length, request->copyText)) return false;
        return RunRequest(request);
    } catch (...) { return false; }
}
extern "C" int cp_cancel(uint64_t id) {
    if (!OnMainThread() || !State().worker) return 0;
    auto worker = State().worker;
    std::lock_guard<std::mutex> lock(worker->mutex);
    for (auto request : {worker->pending, worker->active}) {
        if (request && request->id == id) return CancelRequest(request);
    }
    return 0;
}
extern "C" void cp_configure_popup(void *pointer) {
    if (!OnMainThread()) return;
    Bridge &state = State(); HWND hwnd = static_cast<HWND>(pointer);
    if (!ValidPopup(hwnd) || (state.popup && state.popup != hwnd)) return;
    LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE); style = (style | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW) & ~static_cast<LONG_PTR>(WS_EX_APPWINDOW);
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);
    if (state.popup != hwnd) {
        auto previous = reinterpret_cast<WNDPROC>(SetWindowLongPtrW(hwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(PopupProc)));
        if (!previous) return; state.popupProc = previous; state.popup = hwnd;
    }
    SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED);
}
extern "C" void cp_hide_popup() { if (OnMainThread() && ValidPopup(State().popup)) ShowWindow(State().popup, SW_HIDE); }
extern "C" bool cp_show_popup(void *pointer, double x, double y) {
    if (!OnMainThread() || State().disabled || !std::isfinite(x) || !std::isfinite(y)) return false;
    HWND hwnd = static_cast<HWND>(pointer); if (hwnd != State().popup || !ValidPopup(hwnd) || !ForegroundMatches(State().delivered)) return false;
    PhysicalCoordinates coordinates; x = std::clamp(x, -2147480000.0, 2147480000.0); y = std::clamp(y, -2147480000.0, 2147480000.0);
    POINT anchor = {static_cast<LONG>(std::lround(x)), static_cast<LONG>(std::lround(y))}; HMONITOR monitor = MonitorFromPoint(anchor, MONITOR_DEFAULTTONEAREST);
    MONITORINFO info = {}; info.cbSize = sizeof(info); if (!GetMonitorInfoW(monitor, &info)) return false;
    RECT area = info.rcWork; double scale = MonitorDpi(monitor, hwnd) / 96.0;
    int width = std::min(static_cast<int>(std::lround(88 * scale)), static_cast<int>(area.right - area.left));
    int height = std::min(static_cast<int>(std::lround(40 * scale)), static_cast<int>(area.bottom - area.top)); if (width <= 0 || height <= 0) return false;
    int left = static_cast<int>(std::lround(x + 10 * scale)); int top = static_cast<int>(std::lround(y + 12 * scale));
    if (static_cast<double>(top) + height > area.bottom) top = static_cast<int>(std::lround(y - 12 * scale - height));
    left = std::clamp(left, static_cast<int>(area.left), static_cast<int>(area.right) - width);
    top = std::clamp(top, static_cast<int>(area.top), static_cast<int>(area.bottom) - height);
    if (!SetWindowPos(hwnd, HWND_TOPMOST, left, top, width, height, SWP_NOACTIVATE | SWP_SHOWWINDOW)) return false;
    const bool shown = IsWindowVisible(hwnd) && ForegroundMatches(State().delivered);
    if (!shown) ShowWindow(hwnd, SW_HIDE);
    return shown;
}
extern "C" bool cp_inside_popup(void *pointer, double x, double y) {
    if (!OnMainThread() || !std::isfinite(x) || !std::isfinite(y)) return false;
    HWND hwnd = static_cast<HWND>(pointer); if (hwnd != State().popup || !ValidPopup(hwnd) || !IsWindowVisible(hwnd)) return false;
    PhysicalCoordinates coordinates; RECT rect = {}; return GetWindowRect(hwnd, &rect) && x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}
