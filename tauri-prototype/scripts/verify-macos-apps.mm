// 真实第三方应用的取词矩阵：把 bridge.mm 编进一个独立进程，向 Safari / TextEdit
// 发真实鼠标拖选，再用产品自己的 cp_capture_begin 读取选区。
//
// 与 verify-macos.mm 的分工：那个夹具用自己的 NSTextView 覆盖“点击浮窗 → 复制”
// 的全链路；这里补的是“别人的应用里能不能取到词”，所以只走到浮窗出现为止，
// 复制用 cp_copy_begin 直接发起（与点击浮窗后产品做的事相同）。
//
// 不打包成 .app：以 Terminal 的子进程运行才能继承 Terminal 已经获得的辅助功能授权；
// 新 bundle id 的 .app 需要人工去系统设置里勾选，无法自动化。
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <unistd.h>
#include "macos-clipboard-guardian.h"

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
    const char *program;
};
void cp_arm(const InputEvent *event);
bool cp_capture_begin(const CaptureRequest *input, void (*callback)(uint64_t, const Selection *));
bool cp_copy_begin(uint64_t id, const char *text, size_t length, int pid, uint64_t window, void (*callback)(uint64_t, int));
bool cp_show_popup(void *window, double x, double y);
void cp_hide_popup();
void cp_configure_popup(void *window);
}

static NSString *output;
static NSMutableDictionary *report;
static NSString *mode;
// 剪贴板守护只接受这些文案，避免把外部复制误判成产品的复制。
static NSString *expected = @"CopickPrototype";
static NSString *testFile;
static int targetPid = 0;
static uint64_t targetWindow = 0;

static void Finish(bool passed, NSString *reason) {
    cp_hide_popup();
    NSDictionary *guardian = FinishClipboardGuardian(output);
    report[@"clipboardRestoration"] = guardian ?: @{};
    report[@"scenario"] = [@"app-" stringByAppendingString:mode];
    report[@"sourcePid"] = @(getpid());
    report[@"passed"] = @(passed);
    report[@"result"] = reason;
    // 不删测试文件：目标应用还开着它，删掉会让文档变成“已被删除”状态，
    // 下一次按路径匹配窗口就容易失败。文件留在 artifacts 目录里即可。
    report[@"testFile"] = testFile ?: @"";
    NSData *data = [NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:nil];
    [data writeToFile:[output stringByAppendingPathComponent:@"verification.json"] atomically:YES];
    exit(passed ? 0 : 1);
}

// ---- 窗口与 AX ----------------------------------------------------------

static uint64_t VisibleWindow(int pid, const CGPoint *point = nullptr) {
    CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    uint64_t found = 0;
    for (NSDictionary *window in (NSArray *)list) {
        if ([window[(NSString *)kCGWindowOwnerPID] intValue] != pid || [window[(NSString *)kCGWindowLayer] intValue] != 0) continue;
        CGRect bounds;
        if (point && !CGRectMakeWithDictionaryRepresentation((CFDictionaryRef)window[(NSString *)kCGWindowBounds], &bounds)) continue;
        if (point && !CGRectContainsPoint(bounds, *point)) continue;
        found = [window[(NSString *)kCGWindowNumber] unsignedLongLongValue];
        break;
    }
    if (list) CFRelease(list);
    return found;
}

static bool PanelBounds(NSRect *bounds) {
    CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
    bool found = false;
    for (NSDictionary *window in (NSArray *)list) {
        NSDictionary *rect = window[(NSString *)kCGWindowBounds];
        if ([window[(NSString *)kCGWindowOwnerPID] intValue] == getpid() &&
            std::fabs([rect[@"Width"] doubleValue] - 88) < 0.5 &&
            std::fabs([rect[@"Height"] doubleValue] - 40) < 0.5) {
            *bounds = NSMakeRect([rect[@"X"] doubleValue], [rect[@"Y"] doubleValue],
                                 [rect[@"Width"] doubleValue], [rect[@"Height"] doubleValue]);
            found = true;
            break;
        }
    }
    if (list) CFRelease(list);
    return found;
}

static AXUIElementRef FindRole(AXUIElementRef element, NSString *role, int depth) {
    if (depth > 14 || !element) return nullptr;
    CFTypeRef value = nullptr;
    if (AXUIElementCopyAttributeValue(element, kAXRoleAttribute, &value) == kAXErrorSuccess && value) {
        bool match = [role isEqualToString:(NSString *)value];
        CFRelease(value);
        if (match) return (AXUIElementRef)CFRetain(element);
    }
    if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &value) == kAXErrorSuccess && value) {
        for (id child in (NSArray *)value) {
            AXUIElementRef found = FindRole((AXUIElementRef)child, role, depth + 1);
            if (found) { CFRelease(value); return found; }
        }
        CFRelease(value);
    }
    return nullptr;
}

// TextEdit 会保留上次打开的窗口；按文档 URL 精确定位本次的窗口，
// 否则可能在旧文档上拖选，取到的是上一次的残留状态。
static AXUIElementRef WindowWithDocument(AXUIElementRef application, NSString *path) {
    CFTypeRef windows = nullptr;
    if (AXUIElementCopyAttributeValue(application, kAXWindowsAttribute, &windows) != kAXErrorSuccess || !windows) return nullptr;
    NSString *wanted = [path stringByResolvingSymlinksInPath];
    AXUIElementRef found = nullptr;
    for (id window in (NSArray *)windows) {
        CFTypeRef document = nullptr;
        if (AXUIElementCopyAttributeValue((AXUIElementRef)window, kAXDocumentAttribute, &document) == kAXErrorSuccess && document) {
            NSURL *url = CFGetTypeID(document) == CFStringGetTypeID() ? [NSURL URLWithString:(NSString *)document] : nil;
            if (url.path && [[url.path stringByResolvingSymlinksInPath] isEqualToString:wanted]) found = (AXUIElementRef)CFRetain(window);
            CFRelease(document);
        }
        if (found) break;
    }
    CFRelease(windows);
    return found;
}

// Safari 把 `open -a` 打开的文件放进前台窗口的新标签页；如果它落到了后台标签，
// 前台窗口里根本没有这块 WebArea。按 AXURL 找到真正加载了测试文件的窗口。
static bool WebAreaMatches(AXUIElementRef area, NSString *path) {
    CFTypeRef url = nullptr;
    if (AXUIElementCopyAttributeValue(area, CFSTR("AXURL"), &url) != kAXErrorSuccess || !url) return false;
    bool same = false;
    if (CFGetTypeID(url) == CFURLGetTypeID()) {
        NSString *candidate = [(NSURL *)url path];
        same = candidate && [[candidate stringByResolvingSymlinksInPath] isEqualToString:[path stringByResolvingSymlinksInPath]];
    }
    CFRelease(url);
    return same;
}

static AXUIElementRef WindowWithWebArea(AXUIElementRef application, NSString *path) {
    CFTypeRef windows = nullptr;
    if (AXUIElementCopyAttributeValue(application, kAXWindowsAttribute, &windows) != kAXErrorSuccess || !windows) return nullptr;
    AXUIElementRef found = nullptr;
    for (id window in (NSArray *)windows) {
        AXUIElementRef area = FindRole((AXUIElementRef)window, @"AXWebArea", 0);
        if (area) {
            if (WebAreaMatches(area, path)) found = (AXUIElementRef)CFRetain(window);
            CFRelease(area);
        }
        if (found) break;
    }
    CFRelease(windows);
    return found;
}

static AXUIElementRef FocusedWindow(AXUIElementRef application) {
    CFTypeRef focused = nullptr;
    if (AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute, &focused) != kAXErrorSuccess || !focused) return nullptr;
    return (AXUIElementRef)focused;
}

// Safari 的 AXWebArea 在页面内容加载完成之前就已经存在；此时拖选什么也选不到。
// 这里等到页面里真的出现了测试文字再动手。
static bool ContainsText(AXUIElementRef element, NSString *needle, int depth) {
    if (!element || depth > 10) return false;
    CFTypeRef value = nullptr;
    bool found = false;
    if (AXUIElementCopyAttributeValue(element, kAXValueAttribute, &value) == kAXErrorSuccess && value) {
        if (CFGetTypeID(value) == CFStringGetTypeID() && [(NSString *)value containsString:needle]) found = true;
        CFRelease(value);
    }
    if (!found && AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &value) == kAXErrorSuccess && value) {
        for (id child in (NSArray *)value) {
            if ((found = ContainsText((AXUIElementRef)child, needle, depth + 1))) break;
        }
        CFRelease(value);
    }
    return found;
}

// 窗口标题。Safari 场景的 HTML 会在 mouseup 时把选区写进标题，
// 于是即使产品的 AX 取词失败，也能独立证明这次拖选真的发生了。
static NSString *WindowTitle(AXUIElementRef window) {
    if (!window) return nil;
    CFTypeRef value = nullptr;
    NSString *text = nil;
    if (AXUIElementCopyAttributeValue(window, kAXTitleAttribute, &value) == kAXErrorSuccess && value) {
        if (CFGetTypeID(value) == CFStringGetTypeID()) text = [(NSString *)value copy];
        CFRelease(value);
    }
    return text;
}

// WebKit 的选区出口：AXSelectedTextMarkerRange + AXStringForTextMarkerRange。
// Safari 27 起不再提供 AXSelectedText，选区只挂在这条路径上。
static NSString *MarkerSelection(AXUIElementRef element) {
    if (!element) return nil;
    CFTypeRef markers = nullptr;
    NSString *text = nil;
    if (AXUIElementCopyAttributeValue(element, CFSTR("AXSelectedTextMarkerRange"), &markers) == kAXErrorSuccess && markers) {
        CFTypeRef value = nullptr;
        if (AXUIElementCopyParameterizedAttributeValue(element, CFSTR("AXStringForTextMarkerRange"), markers, &value) == kAXErrorSuccess && value) {
            if (CFGetTypeID(value) == CFStringGetTypeID()) text = [(NSString *)value copy];
            CFRelease(value);
        }
        CFRelease(markers);
    }
    return text;
}

static bool FrameOf(AXUIElementRef element, CGRect *out) {
    CFTypeRef position = nullptr;
    CFTypeRef size = nullptr;
    if (AXUIElementCopyAttributeValue(element, kAXPositionAttribute, &position) != kAXErrorSuccess || !position) return false;
    if (AXUIElementCopyAttributeValue(element, kAXSizeAttribute, &size) != kAXErrorSuccess || !size) { CFRelease(position); return false; }
    CGPoint point = CGPointZero;
    CGSize extent = CGSizeZero;
    bool ok = AXValueGetValue((AXValueRef)position, (AXValueType)kAXValueCGPointType, &point) &&
              AXValueGetValue((AXValueRef)size, (AXValueType)kAXValueCGSizeType, &extent);
    CFRelease(position);
    CFRelease(size);
    if (!ok) return false;
    *out = CGRectMake(point.x, point.y, extent.width, extent.height);
    return true;
}

// 独立于产品的读取：直接问 AX 当前选中的是什么，用来交叉验证产品取到的文本。
static NSString *AxSelectedText(AXUIElementRef element) {
    CFTypeRef value = nullptr;
    NSString *text = nil;
    if (AXUIElementCopyAttributeValue(element, kAXSelectedTextAttribute, &value) == kAXErrorSuccess && value) {
        if (CFGetTypeID(value) == CFStringGetTypeID()) text = [(NSString *)value copy];
        CFRelease(value);
    }
    return text;
}

// ---- 输入注入 ------------------------------------------------------------

static void Post(CGEventType type, CGPoint point, int clickState) {
    CGEventRef event = CGEventCreateMouseEvent(nullptr, type, point, kCGMouseButtonLeft);
    if (type == kCGEventLeftMouseDown || type == kCGEventLeftMouseUp) CGEventSetIntegerValueField(event, kCGMouseEventClickState, clickState);
    CGEventPost(kCGHIDEventTap, event);
    CFRelease(event);
}

static void Spin(double seconds) {
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:seconds]];
}

// 从 from 拖到 to。中间插入若干 drag 事件，让应用看到连续的拖动而不是一次跳变。
static void Drag(CGPoint from, CGPoint to) {
    Post(kCGEventMouseMoved, from, 0);
    usleep(60000);
    Post(kCGEventLeftMouseDown, from, 1);
    usleep(150000);
    const int steps = 12;
    for (int index = 1; index <= steps; ++index) {
        double t = (double)index / steps;
        CGPoint point = CGPointMake(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
        Post(kCGEventLeftMouseDragged, point, 1);
        usleep(18000);
    }
    usleep(120000);
    Post(kCGEventLeftMouseUp, to, 1);
}

// ---- 目标应用 ------------------------------------------------------------

static NSRunningApplication *WaitForApplication(NSString *bundle, int timeoutMs) {
    NSRunningApplication *app = nil;
    for (int waited = 0; waited < timeoutMs; waited += 100) {
        NSArray *apps = [NSRunningApplication runningApplicationsWithBundleIdentifier:bundle];
        app = apps.firstObject;
        if (app && VisibleWindow(app.processIdentifier) != 0) return app;
        Spin(0.1);
    }
    return app;
}

static bool OpenInApplication(NSString *path, NSString *name) {
    NSTask *task = [[[NSTask alloc] init] autorelease];
    task.launchPath = @"/usr/bin/open";
    task.arguments = @[@"-a", name, path];
    @try { [task launch]; } @catch (NSException *exception) { return false; }
    [task waitUntilExit];
    return task.terminationStatus == 0;
}

static NSRunningApplication *ActivateAndWait(NSString *bundle, int timeoutMs) {
    NSRunningApplication *app = WaitForApplication(bundle, timeoutMs);
    if (!app) return nil;
    [app activateWithOptions:NSApplicationActivateAllWindows];
    for (int waited = 0; waited < timeoutMs; waited += 100) {
        if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == app.processIdentifier) return app;
        [app activateWithOptions:NSApplicationActivateAllWindows];
        Spin(0.1);
    }
    return nil;
}

// 把 content 写进临时文件，用 open -a 交给目标应用；返回文件路径。
static NSString *StageFile(NSString *name, NSString *content) {
    NSString *path = [output stringByAppendingPathComponent:name];
    [content writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
    return path;
}

// ---- 取词流程 ------------------------------------------------------------

static void OnCopy(uint64_t id, int result);

static void OnCapture(uint64_t id, const Selection *selection) {
    NSString *text = nil;
    int pid = 0;
    uint64_t window = 0;
    int method = 0;
    NSString *program = nil;
    double anchorX = 0, anchorY = 0;
    if (selection) {
        text = [[NSString alloc] initWithBytes:selection->text length:selection->length encoding:NSUTF8StringEncoding];
        pid = selection->pid;
        window = selection->window;
        method = selection->method;
        program = selection->program ? @(selection->program) : nil;
        anchorX = selection->x;
        anchorY = selection->y;
    }
    dispatch_async(dispatch_get_main_queue(), ^{
        // Safari 27 的选区只走文本标记范围，产品的 AXSelectedText 取词必定为空。
        // 这里把这条已知限制固化下来：现象变了就报错，提醒更新兼容矩阵。
        bool expectCapture = ![mode isEqualToString:@"safari"];
        if (!selection) {
            if (expectCapture) { Finish(false, @"产品没有取到选区（AX 路径返回空）"); return; }
            bool observed = [report[@"selectionObserved"] boolValue];
            NSString *marker = report[@"textMarkerSelection"];
            if (observed && [marker isEqualToString:expected]) {
                report[@"knownLimitation"] = @"Safari 27 只提供 AXSelectedTextMarkerRange，不提供 AXSelectedText";
                Finish(true, @"拖选成功，网页报告的选区正确；但 Safari 不提供 AXSelectedText，产品取词为空（已知限制，Electron 版走同一个引擎，同样受影响）");
            } else {
                Finish(false, @"拖选没有产生选区，或文本标记范围与预期不符");
            }
            return;
        }
        if (!expectCapture) {
            Finish(false, @"Safari 现在能通过 AXSelectedText 取到词了，请复测并更新兼容矩阵");
            return;
        }
        report[@"capturedText"] = text ?: @"";
        report[@"method"] = @(method);
        report[@"capturedPid"] = @(pid);
        report[@"capturedWindow"] = @(window);
        report[@"capturedProgram"] = program ?: @"";
        bool textOk = [text isEqualToString:expected];
        report[@"textMatchesExpected"] = @(textOk);
        if (!textOk) {
            Finish(false, [NSString stringWithFormat:@"取到的文本与预期不符：%@", text ?: @"<nil>"]);
            return;
        }
        bool shown = cp_show_popup(nullptr, anchorX, anchorY);
        NSRect bounds = NSZeroRect;
        for (int wait = 0; wait < 10 && !PanelBounds(&bounds); ++wait) Spin(0.05);
        bool visible = shown && PanelBounds(&bounds);
        report[@"popupShown"] = @(visible);
        report[@"popupBounds"] = visible ? NSStringFromRect(bounds) : @"hidden";
        if (!visible) { Finish(false, @"取词成功但浮窗没有出现"); return; }
        // 浮窗是 NonactivatingPanel，不应抢走前台；复制前再确认一次来源仍然成立。
        report[@"sourceStillFrontmost"] = @(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == targetPid);
        const char *bytes = text.UTF8String;
        if (!cp_copy_begin(1, bytes, strlen(bytes), pid, window, OnCopy)) Finish(false, @"cp_copy_begin 拒绝了这次复制");
    });
}

static void OnCopy(uint64_t id, int result) {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSString *value = [NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString];
        // 接管剪贴板必须在产品已经写入之后：守护进程按“复制后的序号 = 上一个序号 + 1”
        // 判断这次变更确实是产品的复制。提前申领会被当成外部改动，导致无法恢复。
        report[@"clipboardClaimAccepted"] = @(GuardianClaim(expected, true));
        report[@"copyResult"] = @(result);
        report[@"clipboardText"] = value ?: @"";
        bool ok = result == 1 && [value isEqualToString:expected];
        Finish(ok, ok ? @"真实应用取词、浮窗与复制均与预期一致" : @"复制结果与预期不一致");
    });
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc == 3 && strcmp(argv[1], "--clipboard-guardian") == 0)
            return RunClipboardGuardian([NSString stringWithUTF8String:argv[2]]);
        if (argc != 3) {
            fprintf(stderr, "usage: %s <output-dir> <textedit|safari>\n", argv[0]);
            return 2;
        }
        output = [[NSString stringWithUTF8String:argv[1]] retain];
        mode = [[NSString stringWithUTF8String:argv[2]] retain];
        report = [[NSMutableDictionary alloc] init];
        report[@"scenario"] = [@"app-" stringByAppendingString:mode];

        [NSApplication sharedApplication];
        // Accessory：不占 Dock、不抢前台，但可以拥有浮窗。
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

        if (!AXIsProcessTrusted()) Finish(false, @"验证驱动缺少辅助功能权限（应由已获授权的终端启动）");
        if (!StartClipboardGuardian([NSString stringWithUTF8String:argv[0]], output)) Finish(false, @"无法完整备份并确认测试 sentinel");

        NSScreen *primary = nil;
        for (NSScreen *screen in NSScreen.screens) if (screen.frame.origin.x == 0 && screen.frame.origin.y == 0) primary = screen;
        if (!primary) Finish(false, @"找不到位于坐标原点的主屏");
        // 浮窗定位用 88x40 的面板，和产品一致。
        NSWindow *shell = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 88, 40)
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        cp_configure_popup(shell);

        NSString *bundle = nil;
        NSString *applicationName = nil;
        NSString *axRole = nil;
        if ([mode isEqualToString:@"textedit"]) {
            bundle = @"com.apple.TextEdit"; applicationName = @"TextEdit";
            axRole = (NSString *)kAXTextAreaRole;
            testFile = StageFile([NSString stringWithFormat:@"copick-app-matrix-%d.txt", getpid()], expected);
        } else if ([mode isEqualToString:@"safari"]) {
            bundle = @"com.apple.Safari"; applicationName = @"Safari";
            axRole = @"AXWebArea";
            NSString *html = [NSString stringWithFormat:
                @"<!doctype html><meta charset=\"utf-8\"><style>html,body{margin:0;padding:0}"
                 // 测试文字放在距页面顶部 120px 处，拖选点沿着它走，不贴着窗口边缘。
                 "body{font:48px -apple-system,'Helvetica Neue',sans-serif;white-space:nowrap;padding-top:120px}</style>"
                 "<body onmouseup=\"document.title='SEL:'+String(window.getSelection())\">"
                 "<div onmousedown=\"document.title='COPICKMOUSEDOWN'\">%@</div>", expected];
            testFile = StageFile([NSString stringWithFormat:@"copick-app-matrix-%d.html", getpid()], html);
        } else {
            Finish(false, [NSString stringWithFormat:@"未知场景 %@", mode]);
        }
        testFile = [testFile retain];
        if (!OpenInApplication(testFile, applicationName)) Finish(false, @"无法用目标应用打开测试文件");
        NSRunningApplication *app = ActivateAndWait(bundle, 15000);
        if (!app) Finish(false, @"目标应用没有成为前台窗口");
        targetPid = app.processIdentifier;
        report[@"targetPid"] = @(targetPid);
        report[@"targetBundle"] = bundle;
        NSBundle *appBundle = app.bundleURL ? [NSBundle bundleWithURL:app.bundleURL] : nil;
        report[@"applicationVersion"] = [appBundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"";

        // 只在本次打开的窗口里找文本元素：同一个应用可能同时开着别的文档。
        AXUIElementRef application = AXUIElementCreateApplication(targetPid);
        AXUIElementRef window = nullptr;
        for (int waited = 0; waited < 150 && !window; ++waited) {
            window = [mode isEqualToString:@"textedit"]
                ? WindowWithDocument(application, testFile)
                : WindowWithWebArea(application, testFile);
            if (!window) Spin(0.1);
        }
        if (!window) window = FocusedWindow(application);
        // 页面可能落在后台标签页/被别的窗口盖住：先把承载它的窗口提到最前。
        if (window) {
            AXUIElementPerformAction(window, kAXRaiseAction);
            [app activateWithOptions:NSApplicationActivateAllWindows];
            Spin(0.3);
        }
        AXUIElementRef element = FindRole(window ? window : application, axRole, 0);
        if (!element) Finish(false, [NSString stringWithFormat:@"找不到 %@ 元素", axRole]);
        for (int waited = 0; waited < 100 && !ContainsText(element, expected, 0); ++waited) Spin(0.1);
        if (!ContainsText(element, expected, 0)) Finish(false, @"目标文档没有在 10 秒内出现测试文字");
        CGRect frame = CGRectZero;
        if (!FrameOf(element, &frame) || frame.size.width < 40 || frame.size.height < 12) Finish(false, @"文本区域的 AX 位置无效");
        report[@"textFrame"] = NSStringFromRect(NSRectFromCGRect(frame));

        // 一行文字：从左边距拖到文本区右侧之外，整行都会被选中。
        // Safari 的文字在页面顶部下方 120px，TextEdit 的第一行就在文本区顶部。
        double lineY = frame.origin.y + ([mode isEqualToString:@"safari"] ? 140 : 12);
        CGPoint from = CGPointMake(frame.origin.x + 6, lineY);
        CGPoint to = CGPointMake(frame.origin.x + frame.size.width - 12, lineY);

        InputEvent event = {1, from.x, from.y, 0, 0, targetPid, 0, 0};
        // 起点可能被工具栏盖住；决定来源窗口时必须以真实落点为准。
        event.sourceWindow = VisibleWindow(targetPid, &from);
        if (!event.sourceWindow) event.sourceWindow = VisibleWindow(targetPid);
        targetWindow = event.sourceWindow;
        if (!targetWindow) Finish(false, @"拿不到目标窗口的 WindowServer 编号");
        event.clipboardSequence = NSPasteboard.generalPasteboard.changeCount;
        report[@"targetWindow"] = @(targetWindow);
        report[@"dragFrom"] = [NSString stringWithFormat:@"(%.0f,%.0f)", from.x, from.y];
        report[@"dragTo"] = [NSString stringWithFormat:@"(%.0f,%.0f)", to.x, to.y];
        cp_arm(&event);

        // Safari 的第一次点击常常只用来激活网页内容，不产生拖选；先点一下再拖。
        if ([mode isEqualToString:@"safari"]) {
            Post(kCGEventLeftMouseDown, from, 1);
            usleep(60000);
            Post(kCGEventLeftMouseUp, from, 1);
            Spin(0.2);
        }
        Drag(from, to);
        // 让应用把 mouseUp 处理完、更新 AX 选区，再发起取词。
        Spin(0.25);
        // 三条互相独立的证据：网页自己报告的选区（证明拖选发生）、
        // 标准的 AXSelectedText（产品依赖的属性）、WebKit 的文本标记范围（Safari 27 的唯一出口）。
        NSString *pageReported = WindowTitle(window) ?: @"";
        report[@"pageReportedSelection"] = pageReported;
        report[@"selectionObserved"] = @([pageReported isEqualToString:[@"SEL:" stringByAppendingString:expected]]);
        report[@"axSelectedText"] = AxSelectedText(element) ?: @"";
        report[@"textMarkerSelection"] = MarkerSelection(element) ?: @"";
        report[@"frontmostBeforeCapture"] = @(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
        CFRelease(element);
        if (window) CFRelease(window);
        CFRelease(application);

        CaptureRequest request = {1, to.x, to.y, 0, targetWindow, targetPid, event.clipboardSequence, 0, 0};
        if (!cp_capture_begin(&request, OnCapture)) Finish(false, @"cp_capture_begin 拒绝了这次取词（来源或权限校验未通过）");

        // 产品的取词在后台队列上完成，主队列必须持续运转才能收到回调。
        [NSApp run];
    }
    return 1;
}
