#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <WebKit/WebKit.h>
#include <cmath>
#include <chrono>
#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <unistd.h>
#include "core/engine.h"
#include "lib/clipboard.h"
#include "lib/utils.h"
#include "operation_gate.h"
#include "placement.h"

extern "C" {
struct InputEvent {
    int kind; double x; double y; int gesture;
    uint64_t sourceWindow; int sourcePid; uint64_t clipboardSequence; uint64_t cursor;
};
struct CaptureRequest {
    uint64_t requestId; double x; double y; int fallback;
    uint64_t sourceWindow; int sourcePid; uint64_t clipboardSequence;
    uint64_t mouseDownCursor; uint64_t mouseUpCursor;
};
struct Selection {
    const char *text; size_t length; int pid; uint64_t window; double x; double y; int method;
    // bundle identifier，只用于托盘文案与排除项；指针在回调返回前有效。
    const char *program;
};
using InputCallback = void (*)(InputEvent);
using CaptureCallback = void (*)(uint64_t, const Selection *);
using CopyCallback = void (*)(uint64_t, int);
}

static SelectionEngine engine;
static CFMachPortRef tap = nullptr;
static CFRunLoopSourceRef tapSource = nullptr;
static InputCallback inputCallback = nullptr;
static bool dragging = false;
static CGPoint mouseDown = CGPointZero;
static int sourcePid = 0;
static uint64_t sourceWindow = 0;
static uint64_t gestureWindow = 0;
static int gesturePid = 0;
static int64_t clipboardSequence = 0;

// 只读取 WindowServer 元数据，不在事件回调或 UI 线程查询 AX provider。
static uint64_t VisibleWindow(int pid, const CGPoint *point = nullptr) {
    CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    uint64_t found = 0;
    for (NSDictionary *window in (NSArray *)list) {
        if ([window[(NSString *)kCGWindowOwnerPID] intValue] != pid || [window[(NSString *)kCGWindowLayer] intValue] != 0) continue;
        CGRect bounds;
        if (!CGRectMakeWithDictionaryRepresentation((CFDictionaryRef)window[(NSString *)kCGWindowBounds], &bounds)) continue;
        if (!point || CGRectContainsPoint(bounds, *point)) { found = [window[(NSString *)kCGWindowNumber] unsignedLongLongValue]; break; }
    }
    if (list) CFRelease(list);
    return found;
}
static AXUIElementRef deliveredElement = nullptr;
static CFTypeRef deliveredDocument = nullptr;
static int deliveredPid = 0;
static uint64_t deliveredWindow = 0;
static uint64_t deliveredRevision = 0;
static bool deliveredInvalid = false;
static bool documentCheckPending = false;
static std::chrono::steady_clock::time_point lastDocumentCheck;
static void CheckDeliveredDocument();
static dispatch_queue_t executor = dispatch_queue_create("local.copick.capture", DISPATCH_QUEUE_SERIAL);
struct Operation { uint64_t id; copick::OperationGate gate; };
static std::mutex operationMutex;
static std::shared_ptr<Operation> operation;

static std::shared_ptr<Operation> Begin(uint64_t id) {
    std::lock_guard<std::mutex> lock(operationMutex);
    if (operation) return nullptr;
    operation = std::make_shared<Operation>(); operation->id = id;
    return operation;
}
static void Finish(const std::shared_ptr<Operation> &request) {
    std::lock_guard<std::mutex> lock(operationMutex);
    if (operation == request) operation.reset();
}
extern "C" int cp_front_pid();
static void ClearDelivered();
extern "C" int cp_cancel(uint64_t id) {
    std::lock_guard<std::mutex> lock(operationMutex);
    if (!operation || operation->id != id) return 0;
    return operation->gate.Cancel();
}

static CGEventRef ReceiveInput(CGEventTapProxy, CGEventType type, CGEventRef event, void *) {
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        if (tap) CGEventTapEnable(tap, true);
        return event;
    }
    CGPoint point = CGEventGetLocation(event);
    InputEvent input = {0, point.x, point.y, 0, 0, 0, 0, 0};
    if (type == kCGEventLeftMouseDown || type == kCGEventRightMouseDown) {
        mouseDown = point;
        dragging = false;
        input.kind = 1;
    } else if (type == kCGEventLeftMouseDragged) {
        if (std::hypot(point.x - mouseDown.x, point.y - mouseDown.y) > 3) dragging = true;
    } else if (type == kCGEventLeftMouseUp) {
        input.kind = 2;
        input.gesture = dragging || CGEventGetIntegerValueField(event, kCGMouseEventClickState) >= 2 ||
            (CGEventGetFlags(event) & kCGEventFlagMaskShift);
        dragging = false;
    } else if (type == kCGEventScrollWheel || type == kCGEventKeyDown || type == kCGEventRightMouseUp ||
        type == kCGEventOtherMouseDown || type == kCGEventOtherMouseUp) {
        dragging = false;
        input.kind = 3;
    }
    // Only snapshot lightweight identity/change count here; never read AX or clipboard contents.
    if (input.kind && inputCallback) {
        input.sourcePid = cp_front_pid();
        if (type == kCGEventLeftMouseDown) {
            gesturePid = input.sourcePid;
            gestureWindow = VisibleWindow(gesturePid, &point);
        }
        if (type == kCGEventLeftMouseDown || type == kCGEventLeftMouseUp) {
            input.sourcePid = gesturePid;
            input.sourceWindow = gestureWindow;
        }
        input.clipboardSequence = static_cast<uint64_t>(GetClipboardSequence());
        inputCallback(input);
    }
    return event;
}

extern "C" bool cp_permission(bool prompt) {
    @autoreleasepool {
        NSDictionary *options = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @(prompt)};
        return AXIsProcessTrustedWithOptions((CFDictionaryRef)options);
    }
}

extern "C" int cp_front_pid() {
    @autoreleasepool {
        NSRunningApplication *app = NSWorkspace.sharedWorkspace.frontmostApplication;
        return app && !app.terminated ? app.processIdentifier : 0;
    }
}

// CGEvent 坐标与输入事件、AX endBottom 同为“主屏左上角为原点”的屏幕点，
// 不能用 NSEvent.mouseLocation（左下角原点），否则多显示器下符号相反。
extern "C" bool cp_cursor_position(double *x, double *y) {
    if (!x || !y) return false;
    CGEventRef event = CGEventCreate(nullptr);
    if (!event) return false;
    const CGPoint point = CGEventGetLocation(event);
    CFRelease(event);
    *x = point.x; *y = point.y;
    return true;
}

extern "C" bool cp_start(InputCallback callback) {
    if (tap) return true;
    inputCallback = callback;
    CGEventMask mask = CGEventMaskBit(kCGEventLeftMouseDown) | CGEventMaskBit(kCGEventLeftMouseUp) |
        CGEventMaskBit(kCGEventLeftMouseDragged) | CGEventMaskBit(kCGEventRightMouseDown) |
        CGEventMaskBit(kCGEventRightMouseUp) | CGEventMaskBit(kCGEventOtherMouseDown) |
        CGEventMaskBit(kCGEventOtherMouseUp) | CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventScrollWheel);
    tap = CGEventTapCreate(kCGSessionEventTap, kCGTailAppendEventTap, kCGEventTapOptionListenOnly,
        mask, ReceiveInput, nullptr);
    if (!tap) return false;
    tapSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
    if (!tapSource) { CFRelease(tap); tap = nullptr; return false; }
    CFRunLoopAddSource(CFRunLoopGetMain(), tapSource, kCFRunLoopCommonModes);
    CGEventTapEnable(tap, true);
    return true;
}

extern "C" void cp_stop() {
    {
        std::lock_guard<std::mutex> lock(operationMutex);
        if (operation) operation->gate.Cancel();
    }
    sourcePid = 0; sourceWindow = 0;
    gesturePid = 0; gestureWindow = 0;
    ClearDelivered();
    if (tap) { CGEventTapEnable(tap, false); CFMachPortInvalidate(tap); }
    if (tapSource) {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), tapSource, kCFRunLoopCommonModes);
        CFRelease(tapSource); tapSource = nullptr;
    }
    if (tap) { CFRelease(tap); tap = nullptr; }
    inputCallback = nullptr;
    dragging = false;
}

extern "C" bool cp_listening() { return tap && CGEventTapIsEnabled(tap); }

extern "C" bool cp_source_matches(int pid, uint64_t window) {
    bool matches = pid > 0 && window != 0 && cp_front_pid() == pid && VisibleWindow(pid) == window;
    if (matches && deliveredPid == pid && deliveredWindow == window) {
        CheckDeliveredDocument();
        matches = !deliveredInvalid;
    }
    return matches;
}
static void ClearDelivered() {
    ++deliveredRevision;
    deliveredInvalid = false;
    lastDocumentCheck = {};
    if (deliveredElement) CFRelease(deliveredElement);
    if (deliveredDocument) CFRelease(deliveredDocument);
    deliveredElement = nullptr; deliveredDocument = nullptr;
    deliveredPid = 0; deliveredWindow = 0;
}
static AXUIElementRef FocusedWindow(int pid) {
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    if (!app) return nullptr;
    AXUIElementSetMessagingTimeout(app, 0.3);
    CFTypeRef value = nullptr;
    AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute, &value);
    CFRelease(app);
    if (!value || CFGetTypeID(value) != AXUIElementGetTypeID()) { if (value) CFRelease(value); return nullptr; }
    AXUIElementSetMessagingTimeout((AXUIElementRef)value, 0.3);
    return (AXUIElementRef)value;
}
static bool Document(AXUIElementRef window, CFTypeRef *value) {
    *value = nullptr;
    if (!window) return false;
    AXError error = AXUIElementCopyAttributeValue(window, kAXDocumentAttribute, value);
    return error == kAXErrorSuccess || error == kAXErrorAttributeUnsupported || error == kAXErrorNoValue;
}
static bool SameDocument(AXUIElementRef expected, CFTypeRef document, int pid) {
    AXUIElementRef current = FocusedWindow(pid);
    CFTypeRef currentDocument = nullptr;
    bool readable = Document(current, &currentDocument);
    bool same = readable && current && expected && CFEqual(current, expected) &&
        ((!document && !currentDocument) || (document && currentDocument && CFEqual(document, currentDocument)));
    if (current) CFRelease(current);
    if (currentDocument) CFRelease(currentDocument);
    return same;
}
static void CheckDeliveredDocument() {
    if (!deliveredElement || deliveredInvalid || documentCheckPending) return;
    auto now = std::chrono::steady_clock::now();
    if (now - lastDocumentCheck < std::chrono::milliseconds(200)) return;
    {
        std::lock_guard<std::mutex> lock(operationMutex);
        if (operation) return;
    }
    documentCheckPending = true;
    lastDocumentCheck = now;
    uint64_t revision = deliveredRevision;
    int pid = deliveredPid;
    AXUIElementRef element = (AXUIElementRef)CFRetain(deliveredElement);
    CFTypeRef document = deliveredDocument ? CFRetain(deliveredDocument) : nullptr;
    dispatch_async(executor, ^{
        @autoreleasepool {
            bool same = SameDocument(element, document, pid);
            CFRelease(element);
            if (document) CFRelease(document);
            dispatch_async(dispatch_get_main_queue(), ^{
                documentCheckPending = false;
                if (revision == deliveredRevision && !same) deliveredInvalid = true;
            });
        }
    });
}
extern "C" void cp_arm(const InputEvent *event) {
    ClearDelivered();
    sourcePid = event ? event->sourcePid : 0;
    sourceWindow = event ? event->sourceWindow : 0;
    clipboardSequence = event ? static_cast<int64_t>(event->clipboardSequence) : 0;
}

static std::vector<std::string> excludedApps;
extern "C" void cp_set_excluded(const char *const *names, size_t count) {
    excludedApps.clear();
    for (size_t index = 0; index < count; ++index) excludedApps.emplace_back(names[index]);
}
extern "C" bool cp_capture_begin(const CaptureRequest *input, CaptureCallback callback) {
    if (!input || !callback || sourcePid <= 0 || input->sourcePid != sourcePid || input->sourceWindow != sourceWindow || sourcePid == getpid() ||
        !cp_source_matches(sourcePid, sourceWindow) || !cp_permission(false) || !std::isfinite(input->x) || !std::isfinite(input->y)) return false;
    auto request = Begin(input->requestId);
    if (!request) return false;
    CaptureRequest capture = *input;
    SelectionConfigSnapshot config;
    config.runningPid = getpid();
    // macOS 引擎的 GetSelectedText 不接受 stop token，回退无法在事务内取消；
    // 在补齐该能力前保持关闭，配置层也会忽略 macOS 上的开启意图。
    config.clipboardEnabled = false;
    config.clipboardSequence = clipboardSequence;
    config.globalFilterMode = FilterMode::ExcludeList;
    config.globalFilterList = {"local.copick", "com.apple.finder", "com.apple.keychainaccess",
        "1password", "onepassword", "bitwarden", "lastpass"};
    config.globalFilterList.insert(config.globalFilterList.end(), excludedApps.begin(), excludedApps.end());
    config.clipboardFilterMode = FilterMode::ExcludeList;
    config.clipboardFilterList = {"com.apple.terminal", "com.googlecode.iterm2", "com.microsoft.vscode",
        "com.microsoft.visual-studio-code", "com.todesktop.2305228j7", "com.exafunction.windsurf"};
    // Resolve and retain the source on AppKit's thread; never pump a worker run loop.
    NSRunningApplication *front = [[NSRunningApplication runningApplicationWithProcessIdentifier:sourcePid] retain];
    if (!front) { Finish(request); return false; }
    dispatch_async(executor, ^{
        @autoreleasepool {
            AXUIElementRef window = FocusedWindow(capture.sourcePid);
            CFTypeRef document = nullptr;
            bool documentReadable = Document(window, &document);
            TextSelectionInfo info;
            int64_t endingSequence = config.clipboardSequence;
            bool result = false;
            __block bool valid = false;
            dispatch_sync(dispatch_get_main_queue(), ^{
                valid = !request->gate.CancelledBeforeCommit() && cp_source_matches(capture.sourcePid, capture.sourceWindow) && cp_permission(false);
            });
            try {
                if (valid && !request->gate.CancelledBeforeCommit()) result = engine.GetSelectedText(front, info, config, &endingSequence);
            } catch (...) { result = false; }
            dispatch_sync(dispatch_get_main_queue(), ^{
                valid = !request->gate.CancelledBeforeCommit() && cp_source_matches(capture.sourcePid, capture.sourceWindow) && cp_permission(false);
            });
            result = result && valid && !request->gate.CancelledBeforeCommit() && documentReadable && SameDocument(window, document, capture.sourcePid) && !IsTrimmedEmpty(info.text) &&
                info.text.size() <= 1024 * 1024 && info.text.find('\0') == std::string::npos;
            if (result) dispatch_sync(dispatch_get_main_queue(), ^{
                if (!request->gate.CancelledBeforeCommit() && cp_source_matches(capture.sourcePid, capture.sourceWindow)) {
                    ClearDelivered();
                    deliveredElement = (AXUIElementRef)CFRetain(window);
                    deliveredDocument = document ? CFRetain(document) : nullptr;
                    deliveredPid = capture.sourcePid; deliveredWindow = capture.sourceWindow;
                }
            });
            if (window) CFRelease(window);
            if (document) CFRelease(document);
            CGPoint point = CGPointMake(capture.x, capture.y);
            if (info.posLevel >= SelectionPositionLevel::Full && std::isfinite(info.endBottom.x) && std::isfinite(info.endBottom.y)) point = info.endBottom;
            std::string program;
            if (NSString *bundle = [front bundleIdentifier]) {
                const char *identifier = [bundle UTF8String];
                if (identifier) program = identifier;
            }
            Selection selection = {info.text.data(), info.text.size(), capture.sourcePid, capture.sourceWindow, point.x, point.y, static_cast<int>(info.method), program.c_str()};
            [front release];
            Finish(request);
            callback(capture.requestId, result ? &selection : nullptr);
        }
    });
    return true;
}

extern "C" bool cp_copy_begin(uint64_t id, const char *text, size_t length, int pid, uint64_t window, CopyCallback callback) {
    if (!text || !length || length > 1024 * 1024 || !callback || !cp_source_matches(pid, window) || !cp_permission(false) ||
        deliveredPid != pid || deliveredWindow != window || !deliveredElement) return false;
    auto request = Begin(id);
    if (!request) return false;
    const std::string owned(text, length);
    AXUIElementRef element = (AXUIElementRef)CFRetain(deliveredElement);
    CFTypeRef document = deliveredDocument ? CFRetain(deliveredDocument) : nullptr;
    dispatch_async(executor, ^{
        @autoreleasepool {
            bool ok = false;
            // AX 与 pasteboard 调用都留在 worker；主线程只完成最终授权。
            bool same = !request->gate.CancelledBeforeCommit() && SameDocument(element, document, pid);
            NSString *value = [[[NSString alloc] initWithBytes:owned.data() length:owned.size() encoding:NSUTF8StringEncoding] autorelease];
            NSPasteboardItem *item = [[[NSPasteboardItem alloc] init] autorelease];
            __block bool committed = false;
            if (same && value && [item setString:value forType:NSPasteboardTypeString] && SameDocument(element, document, pid)) dispatch_sync(dispatch_get_main_queue(), ^{
                committed = cp_source_matches(pid, window) && cp_permission(false) && request->gate.TryCommit();
            });
            if (committed) {
                @try {
                    NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
                    [pasteboard clearContents];
                    ok = [pasteboard writeObjects:@[item]];
                } @catch (NSException *) { ok = false; }
                request->gate.FinishCommit();
            }
            CFRelease(element);
            if (document) CFRelease(document);
            callback(id, ok ? 1 : request->gate.Committed() ? 2 : 0);
            Finish(request);
        }
    });
    return true;
}

@interface CopickPanel : NSPanel
@end
@implementation CopickPanel
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

static CopickPanel *panel = nil;
extern "C" void cp_configure_popup(void *pointer) {
    NSWindow *original = (NSWindow *)pointer;
    // 普通 NSWindow 加 NonactivatingPanel 位仍会在点击时激活；使用真正的 NSPanel。
    panel = [[CopickPanel alloc] initWithContentRect:NSMakeRect(0, 0, 88, 40)
        styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
        backing:NSBackingStoreBuffered defer:NO];
    NSView *content = [original.contentView retain];
    original.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 88, 40)] autorelease];
    panel.contentView = content;
    [content release];
    panel.opaque = NO;
    panel.backgroundColor = NSColor.clearColor;
    panel.level = NSPopUpMenuWindowLevel;
    panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
        NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorStationary;
    panel.hidesOnDeactivate = NO;
    panel.hasShadow = NO;
    panel.becomesKeyOnlyIfNeeded = YES;
    panel.floatingPanel = YES;
}

static WKWebView *FindWebview(NSView *view) {
    if ([view isKindOfClass:WKWebView.class]) return (WKWebView *)view;
    for (NSView *child in view.subviews) { WKWebView *found = FindWebview(child); if (found) return found; }
    return nil;
}

static bool preparingPopup = false;
extern "C" bool cp_prepare_popup(uint64_t id, void (*callback)(uint64_t, bool)) {
    WKWebView *webview = FindWebview(panel.contentView);
    if (!webview || !callback || preparingPopup) return false;
    preparingPopup = true;
    WKSnapshotConfiguration *config = [[[WKSnapshotConfiguration alloc] init] autorelease];
    config.afterScreenUpdates = YES;
    [webview takeSnapshotWithConfiguration:config completionHandler:^(NSImage *image, NSError *error) {
        preparingPopup = false;
        callback(id, image != nil && error == nil);
    }];
    return true;
}

static bool SnapshotWebview(WKWebView *webview, const char *path) {
    NSString *destination = [[NSString alloc] initWithUTF8String:path];
    if (!webview) { [destination release]; return false; }
    [webview takeSnapshotWithConfiguration:nil completionHandler:^(NSImage *image, NSError *error) {
        if (!error && image) {
            NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:image.TIFFRepresentation];
            NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
            [png writeToFile:destination atomically:YES];
        }
        [destination release];
    }];
    return true;
}

extern "C" bool cp_snapshot_popup(const char *path) {
    return SnapshotWebview(FindWebview(panel.contentView), path);
}
extern "C" bool cp_snapshot_control(void *pointer, const char *path) {
    NSWindow *window = (NSWindow *)pointer;
    return SnapshotWebview(FindWebview(window.contentView), path);
}
extern "C" void cp_hide_popup() { [panel orderOut:nil]; }

// Cocoa 的全局屏幕坐标以主屏左下角为原点，AX 与 CGEvent 的屏幕坐标以主屏左上角为原点。
// 主屏就是 frame.origin 为 (0,0) 的那块屏——不能假定 [NSScreen screens] 的顺序，
// 多显示器下高度不同时，用错参考高度会让副屏上的浮窗整体纵向偏移。
static NSScreen *CpPrimaryScreen(void) {
    for (NSScreen *screen in NSScreen.screens) {
        if (screen.frame.origin.x == 0 && screen.frame.origin.y == 0) return screen;
    }
    return NSScreen.screens.firstObject;
}

static CGFloat CpScreenTop(void) {
    NSScreen *primary = CpPrimaryScreen();
    return primary ? primary.frame.size.height : 0;
}

// 锚点可能落在所有屏幕之外（选区贴着屏幕边缘，或坐标来自已被拔掉的显示器）：
// 取最近的一块屏，而不是一律回落到主屏。
static NSScreen *CpScreenForAnchor(NSPoint anchor) {
    NSScreen *nearest = CpPrimaryScreen();
    CGFloat best = CGFLOAT_MAX;
    for (NSScreen *screen in NSScreen.screens) {
        NSRect frame = screen.frame;
        if (NSPointInRect(anchor, frame)) return screen;
        CGFloat dx = anchor.x < NSMinX(frame) ? NSMinX(frame) - anchor.x : (anchor.x > NSMaxX(frame) ? anchor.x - NSMaxX(frame) : 0);
        CGFloat dy = anchor.y < NSMinY(frame) ? NSMinY(frame) - anchor.y : (anchor.y > NSMaxY(frame) ? anchor.y - NSMaxY(frame) : 0);
        CGFloat distance = dx * dx + dy * dy;
        if (distance < best) { best = distance; nearest = screen; }
    }
    return nearest;
}

extern "C" bool cp_show_popup(void *, double x, double y) {
    NSWindow *window = panel;
    if (!window || !std::isfinite(x) || !std::isfinite(y) || !cp_source_matches(sourcePid, sourceWindow) || NSScreen.screens.count == 0) {
        [window orderOut:nil];
        return false;
    }
    CGFloat top = CpScreenTop();
    NSScreen *target = CpScreenForAnchor(NSMakePoint(x, copick::ScreenToCocoaY(y, top)));
    if (!target) { [window orderOut:nil]; return false; }
    NSRect visible = target.visibleFrame;
    copick::Rect placed = copick::PlacePopup(x, y, {NSMinX(visible), copick::CocoaToScreenY(NSMaxY(visible), top),
                                                    NSWidth(visible), NSHeight(visible)});
    [window setFrameOrigin:NSMakePoint(placed.x, copick::ScreenToCocoaY(placed.y + placed.height, top))];
    [window orderFrontRegardless];
    bool shown = window.visible && cp_source_matches(sourcePid, sourceWindow);
    if (!shown) [window orderOut:nil];
    return shown;
}

extern "C" bool cp_inside_popup(void *, double x, double y) {
    NSWindow *window = panel;
    return window.visible && NSPointInRect(NSMakePoint(x, copick::ScreenToCocoaY(y, CpScreenTop())), window.frame);
}

extern "C" void cp_open_settings() {
    @autoreleasepool {
        [NSWorkspace.sharedWorkspace openURL:[NSURL URLWithString:
            @"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]];
    }
}
