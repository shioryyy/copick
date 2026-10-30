#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#include "lib/clipboard.h"

static NSString *output;
static NSWindow *sourceWindow;
static NSWindow *secondWindow;
static NSTextView *textView;
#include "macos-clipboard-guardian.h"
static NSString *expected = @"CopickPrototype";
static int attempts = 0;
static NSMutableDictionary *report;
static NSString *mode;
static int copyShortcutCount = 0;
static bool hungPopupSeen = false;
static bool firstRoundCopied = false;
static unsigned long long productLogOffset = 0;
static bool ProductCopyConfirmed() {
    const char *path = getenv("COPICK_PROTOTYPE_LOG");
    if (!path) return false;
    NSData *data = [NSData dataWithContentsOfFile:[NSString stringWithUTF8String:path]];
    if (!data || data.length < productLogOffset) return false;
    NSString *log = [[[NSString alloc] initWithData:[data subdataWithRange:NSMakeRange(productLogOffset, data.length - productLogOffset)] encoding:NSUTF8StringEncoding] autorelease];
    return [log containsString:@"COPICK_COPY_OK request="];
}
static void WaitForPopup();
static void WaitForCopy();
static void WaitForNextRound();
static NSString *documentIdentity = @"file:///copick-fixture/document-a.txt";
static NSString *ProviderMarker(NSString *name);
static bool Exists(NSString *name);

@interface DocumentWindow : NSWindow
@end
@implementation DocumentWindow
- (NSString *)accessibilityDocument {
    if ([mode isEqualToString:@"copy-provider"] && Exists(@"provider-armed") && !Exists(@"provider-entered")) {
        [@"copy source check waiting" writeToFile:ProviderMarker(@"provider-entered") atomically:YES encoding:NSUTF8StringEncoding error:nil];
        while (!Exists(@"provider-release")) usleep(10000);
        [@"copy source check released" writeToFile:ProviderMarker(@"provider-returned") atomically:YES encoding:NSUTF8StringEncoding error:nil];
    }
    return documentIdentity;
}
@end

static void Click(CGPoint point, int count);
static NSString *ProviderMarker(NSString *name) { return [output stringByAppendingPathComponent:name]; }
static bool Exists(NSString *name) { return [[NSFileManager defaultManager] fileExistsAtPath:ProviderMarker(name)]; }

@interface SlowTextView : NSTextView
@end
@implementation SlowTextView
- (NSString *)accessibilitySelectedText {
    if (self.selectedRange.length > 0 && ![[NSFileManager defaultManager] fileExistsAtPath:[output stringByAppendingPathComponent:@"provider-entered"]]) {
        [@"AX request received" writeToFile:[output stringByAppendingPathComponent:@"provider-entered"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
        usleep(6000000);
        [@"AX response released" writeToFile:[output stringByAppendingPathComponent:@"provider-returned"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
    }
    return [super accessibilitySelectedText];
}
@end

@interface HungTextView : NSTextView
@end
@implementation HungTextView
- (NSString *)accessibilitySelectedText {
    if (self.selectedRange.length > 0 && !Exists(@"provider-entered")) {
        [@"AX request received; waiting for external release" writeToFile:ProviderMarker(@"provider-entered") atomically:YES encoding:NSUTF8StringEncoding error:nil];
        // The provider has no timer-based escape. The owning runner releases it
        // in finally, including when a UI assertion or a signal interrupts it.
        while (!Exists(@"provider-release")) usleep(20000);
        [@"AX response externally released" writeToFile:ProviderMarker(@"provider-returned") atomically:YES encoding:NSUTF8StringEncoding error:nil];
    }
    return [super accessibilitySelectedText];
}
@end

@interface ClipboardOnlyTextView : NSTextView
@end
@implementation ClipboardOnlyTextView
- (NSString *)accessibilitySelectedText { return nil; }
- (NSRange)accessibilitySelectedTextRange { return NSMakeRange(0, 0); }
- (NSString *)accessibilityValue { return nil; }
- (void)copy:(id)sender { ++copyShortcutCount; [super copy:sender]; }
@end

static void Save() {
    NSData *data = [NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:nil];
    [data writeToFile:[output stringByAppendingPathComponent:@"verification.json"] atomically:YES];
}
static void Finish(bool success, NSString *reason) {
    report[@"passed"] = @(success);
    report[@"result"] = reason;
    report[@"sourcePid"] = @(getpid());
    if (clipboardGuardian) {
        NSDictionary *restoration = FinishClipboardGuardian(output);
        bool restored = [restoration[@"testClipboardRestored"] boolValue];
        report[@"testClipboardRestored"] = @(restored);
        report[@"clipboardRestoration"] = restoration ?: @{};
        if (!restored) { success = false; report[@"passed"] = @NO; report[@"result"] = @"剪贴板恢复未确认；保留外部变化或未归属版本"; }
    }
    Save();
    exit(success ? 0 : 1);
}
static void OtherClick(CGPoint point) {
    for (CGEventType type : {kCGEventOtherMouseDown, kCGEventOtherMouseUp}) {
        CGEventRef event = CGEventCreateMouseEvent(nullptr, type, point, kCGMouseButtonCenter);
        CGEventPost(kCGHIDEventTap, event);
        CFRelease(event);
        usleep(30000);
    }
}
static void Click(CGPoint point, int count) {
    for (int index = 1; index <= count; ++index) {
        for (CGEventType type : {kCGEventLeftMouseDown, kCGEventLeftMouseUp}) {
            CGEventRef event = CGEventCreateMouseEvent(nullptr, type, point, kCGMouseButtonLeft);
            CGEventSetIntegerValueField(event, kCGMouseEventClickState, index);
            CGEventPost(kCGHIDEventTap, event);
            CFRelease(event);
            usleep(30000);
        }
    }
}
static NSDictionary *Popup() {
    NSArray *windows = (NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
    NSDictionary *found = nil;
    for (NSDictionary *window in windows) {
        NSString *owner = window[(NSString *)kCGWindowOwnerName];
        NSDictionary *bounds = window[(NSString *)kCGWindowBounds];
        if (([owner containsString:@"copick-tauri"] || [owner containsString:@"Copick Tauri"]) &&
            [bounds[@"Width"] doubleValue] == 88 && [bounds[@"Height"] doubleValue] == 40) {
            found = [[window retain] autorelease]; break;
        }
    }
    [windows release];
    return found;
}
static void Screenshot(NSNumber *number, NSString *name) {
    NSTask *task = [[[NSTask alloc] init] autorelease];
    task.launchPath = @"/usr/sbin/screencapture";
    task.arguments = @[@"-x", @"-l", number.stringValue, [output stringByAppendingPathComponent:name]];
    @try { [task launch]; [task waitUntilExit]; } @catch (NSException *) {}
}
static bool PopupCopiedLabel() {
    NSDictionary *popup = Popup();
    if (!popup) return false;
    AXUIElementRef app = AXUIElementCreateApplication([popup[(NSString *)kCGWindowOwnerPID] intValue]);
    AXUIElementSetMessagingTimeout(app, 0.1);
    NSDictionary *bounds = popup[(NSString *)kCGWindowBounds];
    AXUIElementRef hit = nullptr;
    AXUIElementCopyElementAtPosition(app, [bounds[@"X"] doubleValue] + 44, [bounds[@"Y"] doubleValue] + 20, &hit);
    NSMutableArray *queue = [NSMutableArray array];
    if (hit) { [queue addObject:(id)hit]; CFRelease(hit); }
    CFRelease(app);
    for (NSUInteger index = 0; index < queue.count && index < 12; ++index) {
        AXUIElementRef element = (AXUIElementRef)queue[index];
        for (CFStringRef attribute : {kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute}) {
            CFTypeRef value = nullptr;
            AXUIElementCopyAttributeValue(element, attribute, &value);
            bool copied = value && CFGetTypeID(value) == CFStringGetTypeID() && CFEqual(value, CFSTR("已复制"));
            if (value) CFRelease(value);
            if (copied) return true;
        }
        CFTypeRef children = nullptr;
        AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &children);
        if (children && CFGetTypeID(children) == CFArrayGetTypeID()) [queue addObjectsFromArray:(NSArray *)children];
        if (children) CFRelease(children);
        CFTypeRef parent = nullptr;
        AXUIElementCopyAttributeValue(element, kAXParentAttribute, &parent);
        if (parent) {
            if (![queue containsObject:(id)parent]) [queue addObject:(id)parent];
            CFRelease(parent);
        }
    }
    return false;
}
static void WaitForNextRound() {
    if (Popup()) {
        if (++attempts > 30) { Finish(false, @"第一轮复制后浮窗未隐藏"); return; }
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ WaitForNextRound(); });
        return;
    }
    report[@"hiddenBetweenRounds"] = @YES;
    expected = @"SecondPrototype";
    textView.string = @"SecondPrototype  第二轮真实选词。";
    NSRect glyph = [textView firstRectForCharacterRange:NSMakeRange(2, 1) actualRange:nullptr];
    Click(CGPointMake(NSMidX(glyph), NSScreen.screens.firstObject.frame.size.height - NSMidY(glyph)), 2);
    attempts = 0;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 200 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ WaitForPopup(); });
}
static void WaitForCopy() {
    NSString *actual = [[NSPasteboard generalPasteboard] stringForType:NSPasteboardTypeString];
    if ([mode isEqualToString:@"expiry"] || [mode isEqualToString:@"switch"] || [mode isEqualToString:@"samepid-switch"] || [mode isEqualToString:@"document-switch"] || [mode isEqualToString:@"document-copy"] || [mode isEqualToString:@"other-click"]) {
        bool hidden = Popup() == nil;
        bool unchanged = [actual isEqualToString:@"copick-verification-sentinel"];
        report[@"popupHidden"] = @(hidden);
        report[@"clipboardUnchanged"] = @(unchanged);
        bool changed = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != getpid();
        if ([mode isEqualToString:@"switch"]) report[@"foregroundChanged"] = @(changed);
        bool samePidSwitched = !changed && secondWindow.keyWindow && !sourceWindow.keyWindow;
        if ([mode isEqualToString:@"samepid-switch"]) {
            report[@"foregroundPidPreserved"] = @(!changed);
            report[@"sourceWindowNumber"] = @(sourceWindow.windowNumber);
            report[@"targetWindowNumber"] = @(secondWindow.windowNumber);
            report[@"sourceWindowIsKey"] = @(sourceWindow.keyWindow);
            report[@"targetWindowIsKey"] = @(secondWindow.keyWindow);
            report[@"windowSwitched"] = @(samePidSwitched);
        }
        bool documentSwitched = !changed && sourceWindow.keyWindow && [documentIdentity hasSuffix:@"document-b.txt"];
        if ([mode isEqualToString:@"document-switch"] || [mode isEqualToString:@"document-copy"]) {
            report[@"foregroundPidPreserved"] = @(!changed);
            report[@"sourceWindowPreserved"] = @(sourceWindow.keyWindow);
            report[@"documentChanged"] = @(documentSwitched);
        }
        Finish(hidden && unchanged && (![mode isEqualToString:@"switch"] || changed) &&
            (![mode isEqualToString:@"samepid-switch"] || samePidSwitched) &&
            ((!([mode isEqualToString:@"document-switch"] || [mode isEqualToString:@"document-copy"])) || documentSwitched) &&
            (![mode isEqualToString:@"document-copy"] || [report[@"copyAttemptedAfterDocumentChange"] boolValue]), @"失效选区不再显示且未修改剪贴板");
        return;
    }
    if ([actual isEqualToString:expected]) {
        if (!ProductCopyConfirmed()) {
            if (++attempts <= 10) {
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ WaitForCopy(); });
                return;
            }
            Finish(false, @"未观察到本轮产品成功复制回执，拒绝接管剪贴板"); return;
        }
        if (!GuardianClaim(expected, true)) { Finish(false, @"复制版本未获守护进程确认"); return; }
        if ([mode isEqualToString:@"two-round"] && !firstRoundCopied) {
            if (!PopupCopiedLabel()) {
                if (++attempts > 5) { Finish(false, @"未确认第一轮已复制按钮"); return; }
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ WaitForCopy(); });
                return;
            }
            report[@"firstRoundCopiedLabel"] = @YES;
            report[@"firstRoundClipboardMatches"] = @YES;
            firstRoundCopied = true;
            attempts = 0;
            WaitForNextRound();
            return;
        }
        NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
        BOOL focused = front.processIdentifier == getpid();
        NSRange selected = textView.selectedRange;
        report[@"clipboardMatches"] = @YES;
        report[@"focusAfterClick"] = @(focused);
        report[@"selectionPreserved"] = @(selected.length == expected.length);
        report[@"selectionLength"] = @(selected.length);
        bool restored = [report[@"clipboardRestoredBeforeClick"] boolValue];
        Finish([report[@"focusBeforeClick"] boolValue] && focused &&
            selected.length == expected.length &&
            [[textView.string substringWithRange:selected] isEqualToString:expected] && restored,
            @"真实鼠标点击复制完成");
        return;
    }
    if (++attempts > 30) { Finish(false, @"点击后剪贴板未匹配预期文本"); return; }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ WaitForCopy(); });
}
static void WaitForHungProvider() {
    bool entered = Exists(@"provider-entered");
    bool returned = Exists(@"provider-returned");
    bool released = Exists(@"provider-release");
    bool hidden = Popup() == nil;
    if (!hidden) hungPopupSeen = true;
    if (Exists(@"provider-finish") && (!entered || returned)) {
        report[@"providerEntered"] = @(entered);
        report[@"providerReturned"] = @(returned);
        report[@"providerExternallyReleased"] = @(released);
        report[@"popupHidden"] = @(hidden);
        report[@"popupSeenDuringWait"] = @(hungPopupSeen);
        bool unchanged = [[[NSPasteboard generalPasteboard] stringForType:NSPasteboardTypeString] isEqualToString:@"copick-verification-sentinel"];
        report[@"clipboardUnchanged"] = @(unchanged);
        bool copyWait = [mode isEqualToString:@"copy-provider"];
        Finish(entered && returned && released && hidden && (copyWait || !hungPopupSeen) && unchanged &&
            (!copyWait || [report[@"explicitCopyClicked"] boolValue]), @"外部释放真实 AX 挂起后，过期选区未展示或复制");
        return;
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ WaitForHungProvider(); });
}

static void WaitForPopup() {
    if ([mode isEqualToString:@"hung-provider"] || ([mode isEqualToString:@"copy-provider"] && Exists(@"provider-armed"))) { WaitForHungProvider(); return; }
    NSDictionary *popup = Popup();
    if ([mode isEqualToString:@"slow-provider"]) {
        if (popup) { Finish(false, @"慢 provider 的过期结果出现浮窗"); return; }
        if (++attempts > 30) {
            bool unchanged = [[[NSPasteboard generalPasteboard] stringForType:NSPasteboardTypeString] isEqualToString:@"copick-verification-sentinel"];
            bool entered = [[NSFileManager defaultManager] fileExistsAtPath:[output stringByAppendingPathComponent:@"provider-entered"]];
            bool returned = [[NSFileManager defaultManager] fileExistsAtPath:[output stringByAppendingPathComponent:@"provider-returned"]];
            report[@"providerEntered"] = @(entered);
            report[@"providerReturned"] = @(returned);
            report[@"popupHidden"] = @YES;
            report[@"clipboardUnchanged"] = @(unchanged);
            Finish(entered && returned && unchanged, @"慢 provider 返回后旧选区未展示或复制");
        } else dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ WaitForPopup(); });
        return;
    }
    if ([mode isEqualToString:@"fallback-disabled"] || [mode isEqualToString:@"busy-provider"]) {
        if (popup) { Finish(false, @"回退关闭却出现浮窗"); return; }
        if (++attempts > 40) {
            bool unchanged = [[[NSPasteboard generalPasteboard] stringForType:NSPasteboardTypeString] isEqualToString:@"copick-verification-sentinel"];
            bool focused = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == getpid();
            bool selected = textView.selectedRange.length == expected.length;
            report[@"popupHidden"] = @YES;
            report[@"clipboardUnchanged"] = @(unchanged);
            report[@"sourceFocused"] = @(focused);
            report[@"selectionPreserved"] = @(selected);
            report[@"copyShortcutCount"] = @(copyShortcutCount);
            Finish(unchanged && focused && selected && copyShortcutCount == 0,
                [mode isEqualToString:@"busy-provider"] ? @"挂起服务拒绝新选区，未显示浮窗或修改剪贴板" : @"回退关闭，无复制快捷键副作用");
        } else dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ WaitForPopup(); });
        return;
    }
    if (popup) {
        NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
        report[@"popupShown"] = @YES;
        NSString *before = [[NSPasteboard generalPasteboard] stringForType:NSPasteboardTypeString];
        report[@"clipboardRestoredBeforeClick"] = @([before isEqualToString:([mode isEqualToString:@"two-round"] && firstRoundCopied ? @"CopickPrototype" : @"copick-verification-sentinel")]);
        if ([mode isEqualToString:@"two-round"] && firstRoundCopied) {
            bool reset = !PopupCopiedLabel();
            report[@"secondRoundCopiedLabelCleared"] = @(reset);
            if (!reset) { Finish(false, @"第二轮仍显示旧已复制状态"); return; }
        }
        report[@"focusBeforeClick"] = @(front.processIdentifier == getpid());
        report[@"sourcePid"] = @(getpid());
        // 截图可能被 macOS 屏幕录制权限阻止，不让它耗尽选区的七秒有效期。
        if (getenv("COPICK_CAPTURE_SCREENSHOTS")) {
            Screenshot(popup[(NSString *)kCGWindowNumber], @"popup.png");
            Screenshot(@(sourceWindow.windowNumber), @"source.png");
        }
        NSDictionary *bounds = popup[(NSString *)kCGWindowBounds];
        CGPoint center = CGPointMake([bounds[@"X"] doubleValue] + 44, [bounds[@"Y"] doubleValue] + 20);
        report[@"popupBounds"] = bounds;
        attempts = 0;
        if (const char *path = getenv("COPICK_PROTOTYPE_LOG"))
            productLogOffset = [[[NSFileManager defaultManager] attributesOfItemAtPath:[NSString stringWithUTF8String:path] error:nil] fileSize];
        if ([mode isEqualToString:@"expiry"]) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 8 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ WaitForCopy(); });
        } else if ([mode isEqualToString:@"switch"]) {
            NSNumber *pid = popup[(NSString *)kCGWindowOwnerPID];
            [[NSRunningApplication runningApplicationWithProcessIdentifier:pid.intValue] activateWithOptions:0];
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 400 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ WaitForCopy(); });
        } else if ([mode isEqualToString:@"document-switch"] || [mode isEqualToString:@"document-copy"]) {
            documentIdentity = @"file:///copick-fixture/document-b.txt";
            textView.string = @"ReplacementDocument  同窗口第二文档。";
            NSAccessibilityPostNotification(sourceWindow, NSAccessibilityValueChangedNotification);
            if ([mode isEqualToString:@"document-copy"]) { Click(center, 1); report[@"copyAttemptedAfterDocumentChange"] = @YES; }
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 800 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ WaitForCopy(); });
        } else if ([mode isEqualToString:@"samepid-switch"]) {
            // AppKit switches the actual key window without a global input event
            // that would independently invalidate the selection.
            [secondWindow makeKeyAndOrderFront:nil];
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 400 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ WaitForCopy(); });
        } else if ([mode isEqualToString:@"other-click"]) {
            NSRect frame = [sourceWindow convertRectToScreen:NSMakeRect(400, 100, 1, 1)];
            OtherClick(CGPointMake(NSMinX(frame), NSScreen.screens.firstObject.frame.size.height - NSMinY(frame)));
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 400 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ WaitForCopy(); });
        } else if ([mode isEqualToString:@"copy-provider"]) {
            [@"ready for explicit copy" writeToFile:ProviderMarker(@"provider-armed") atomically:YES encoding:NSUTF8StringEncoding error:nil];
            Click(center, 1);
            report[@"explicitCopyClicked"] = @YES;
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ WaitForHungProvider(); });
        } else {
            if ([mode isEqualToString:@"two-round"]) PopupCopiedLabel();
            Click(center, 1);
            int delayMs = [mode isEqualToString:@"two-round"] ? 20 : 200;
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, delayMs * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ WaitForCopy(); });
        }
        return;
    }
    if (++attempts > 40) { Finish(false, @"未发现复制浮窗"); return; }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ WaitForPopup(); });
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc == 3 && strcmp(argv[1], "--clipboard-guardian") == 0)
            return RunClipboardGuardian([NSString stringWithUTF8String:argv[2]]);
        output = argc > 1 ? [[NSString stringWithUTF8String:argv[1]] retain] : @"/tmp";
        report = [[NSMutableDictionary alloc] init];
        mode = getenv("COPICK_VERIFY_MODE") ? [NSString stringWithUTF8String:getenv("COPICK_VERIFY_MODE")] : @"double";
        report[@"scenario"] = mode;
        report[@"description"] = @"macOS 原生 NSTextView → Tauri 浮窗 → 真实鼠标交互";
        if (([mode isEqualToString:@"hung-provider"] || [mode isEqualToString:@"copy-provider"]) && !getenv("COPICK_VERIFY_PROVIDER_RUNNER")) {
            Finish(false, @"挂起 provider 必须由 verify-macos-provider.cjs 运行以保证 finally 释放与剪贴板恢复"); return 1;
        }
        if (!AXIsProcessTrusted()) { Finish(false, @"验证驱动缺少辅助功能权限"); return 1; }
        bool expectsCopy = [mode isEqualToString:@"double"] || [mode isEqualToString:@"drag"] || [mode isEqualToString:@"two-round"] || [mode isEqualToString:@"fallback"];
        if (expectsCopy && !getenv("COPICK_PROTOTYPE_LOG")) { Finish(false, @"复制验证需要与产品一致的 COPICK_PROTOTYPE_LOG 路径"); return 1; }
        if ([mode isEqualToString:@"busy-provider"]) {
            report[@"clipboardRestoration"] = @{ @"outcome": @"untouched" };
            report[@"clipboardTouched"] = @NO;
        } else if (!StartClipboardGuardian([NSString stringWithUTF8String:argv[0]], output)) {
            Finish(false, @"无法完整备份并确认测试 sentinel"); return 1;
        }
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        NSMenu *menu = [[[NSMenu alloc] initWithTitle:@"验证"] autorelease];
        NSMenuItem *editItem = [[[NSMenuItem alloc] initWithTitle:@"编辑" action:nil keyEquivalent:@""] autorelease];
        NSMenu *edit = [[[NSMenu alloc] initWithTitle:@"编辑"] autorelease];
        [edit addItemWithTitle:@"复制" action:@selector(copy:) keyEquivalent:@"c"];
        editItem.submenu = edit;
        [menu addItem:editItem];
        NSApp.mainMenu = menu;
        sourceWindow = [[(([mode isEqualToString:@"document-switch"] || [mode isEqualToString:@"document-copy"] || [mode isEqualToString:@"copy-provider"]) ? DocumentWindow.class : NSWindow.class) alloc] initWithContentRect:NSMakeRect(180, 180, 520, 200)
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
        sourceWindow.title = @"Copick 验证用选区";
        textView = ([mode isEqualToString:@"fallback"] || [mode isEqualToString:@"fallback-disabled"] || [mode isEqualToString:@"busy-provider"])
            ? [[ClipboardOnlyTextView alloc] initWithFrame:NSMakeRect(0, 0, 520, 200)]
            : [mode isEqualToString:@"slow-provider"]
                ? [[SlowTextView alloc] initWithFrame:NSMakeRect(0, 0, 520, 200)]
                : [mode isEqualToString:@"hung-provider"]
                    ? [[HungTextView alloc] initWithFrame:NSMakeRect(0, 0, 520, 200)]
                    : [[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 520, 200)];
        textView.font = [NSFont systemFontOfSize:24];
        textView.string = @"CopickPrototype  验证文字，仅用于本次测试。";
        textView.textContainerInset = NSMakeSize(25, 35);
        sourceWindow.contentView = textView;
        if ([mode isEqualToString:@"samepid-switch"]) {
            secondWindow = [[NSWindow alloc] initWithContentRect:NSMakeRect(740, 180, 420, 200)
                styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
            secondWindow.title = @"Copick 验证同进程第二窗口";
            NSTextView *otherText = [[[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 420, 200)] autorelease];
            otherText.string = @"第二窗口：切换到此窗口应使原选区失效。";
            secondWindow.contentView = otherText;
            [secondWindow orderFront:nil];
        }
        [sourceWindow makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
        if (!([mode isEqualToString:@"hung-provider"] || [mode isEqualToString:@"copy-provider"])) {
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 18 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
                Finish(false, @"验证超时");
            });
        }
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            bool focused = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == getpid() && sourceWindow.keyWindow;
            report[@"sourceFocusedBeforeInput"] = @(focused);
            if (!focused) { Finish(false, @"测试窗口未获得前台，未发送鼠标输入"); return; }
            NSRect glyph = [textView firstRectForCharacterRange:NSMakeRange(2, 1) actualRange:nullptr];
            CGFloat top = NSScreen.screens.firstObject.frame.size.height;
            CGPoint point = CGPointMake(NSMidX(glyph), top - NSMidY(glyph));
            if ([mode isEqualToString:@"drag"]) {
                NSRect start = [textView firstRectForCharacterRange:NSMakeRange(0, 1) actualRange:nullptr];
                NSRect end = [textView firstRectForCharacterRange:NSMakeRange(expected.length, 1) actualRange:nullptr];
                CGPoint from = CGPointMake(NSMinX(start) + 1, top - NSMidY(start));
                CGPoint to = CGPointMake(NSMinX(end), top - NSMidY(end));
                CGEventRef down = CGEventCreateMouseEvent(nullptr, kCGEventLeftMouseDown, from, kCGMouseButtonLeft);
                CGEventPost(kCGHIDEventTap, down); CFRelease(down);
                usleep(30000);
                for (int index = 1; index <= 12; ++index) {
                    CGPoint position = CGPointMake(from.x + (to.x - from.x) * index / 12, from.y);
                    CGEventRef drag = CGEventCreateMouseEvent(nullptr, kCGEventLeftMouseDragged, position, kCGMouseButtonLeft);
                    CGEventPost(kCGHIDEventTap, drag); CFRelease(drag); usleep(15000);
                }
                CGEventRef up = CGEventCreateMouseEvent(nullptr, kCGEventLeftMouseUp, to, kCGMouseButtonLeft);
                CGEventPost(kCGHIDEventTap, up); CFRelease(up);
            } else Click(point, 2);
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 200 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ WaitForPopup(); });
        });
        [NSApp run];
    }
}
