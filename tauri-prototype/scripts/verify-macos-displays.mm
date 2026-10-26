// 多显示器浮窗定位的原生夹具：直接编译 bridge.mm，不经过 Rust。
// 期望值在“主屏左上角为原点”的 CG 坐标里独立算出，不复用 bridge 里的翻转实现，
// 这样参考屏选错（例如拿副屏高度做 Y 翻转）会以整块屏高度级别的偏差暴露出来。
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#include <algorithm>
#include <cmath>
#include <cstdint>

extern "C" {
struct InputEvent {
    int kind; double x; double y; int gesture;
    uint64_t sourceWindow; int sourcePid; uint64_t clipboardSequence; uint64_t cursor;
};
void cp_configure_popup(void *window);
void cp_arm(const InputEvent *event);
bool cp_source_matches(int pid, uint64_t window);
bool cp_show_popup(void *window, double x, double y);
bool cp_inside_popup(void *window, double x, double y);
void cp_hide_popup();
}

struct Placement {
    NSString *name;
    double x;
    double y;
    NSRect area;
};

static NSString *output;
static NSMutableDictionary *report;

// Cocoa 矩形（左下角原点）转 CG 矩形（主屏左上角原点）。
static NSRect CgRect(NSRect cocoa, CGFloat top) {
    return NSMakeRect(cocoa.origin.x, top - NSMaxY(cocoa), cocoa.size.width, cocoa.size.height);
}

// 与 Windows 实现同构的期望布局：锚点右下方 10/12，放不下就翻到上方，再钳进工作区。
static NSPoint Expected(double x, double y, NSRect area) {
    double left = std::max(NSMinX(area), std::min(x + 10, NSMaxX(area) - 88));
    double top = y + 12;
    if (top + 40 > NSMaxY(area)) top = y - 12 - 40;
    top = std::max(NSMinY(area), std::min(top, NSMaxY(area) - 40));
    return NSMakePoint(left, top);
}

// 独立实现“最近的屏幕”，用于虚拟桌面之外的锚点。
static NSScreen *NearestScreen(NSPoint point) {
    NSScreen *nearest = nil;
    CGFloat best = CGFLOAT_MAX;
    for (NSScreen *screen in [NSScreen screens]) {
        NSRect frame = screen.frame;
        CGFloat dx = point.x < NSMinX(frame) ? NSMinX(frame) - point.x : (point.x > NSMaxX(frame) ? point.x - NSMaxX(frame) : 0);
        CGFloat dy = point.y < NSMinY(frame) ? NSMinY(frame) - point.y : (point.y > NSMaxY(frame) ? point.y - NSMaxY(frame) : 0);
        CGFloat distance = dx * dx + dy * dy;
        if (distance < best) { best = distance; nearest = screen; }
    }
    return nearest;
}

// 取某个进程最前面的普通层窗口编号，用作来源窗口。
static uint64_t FrontWindowOf(int pid) {
    NSArray *windows = (NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
    uint64_t number = 0;
    for (NSDictionary *window in windows) {
        if ([window[(NSString *)kCGWindowOwnerPID] intValue] != pid) continue;
        if ([window[(NSString *)kCGWindowLayer] intValue] != 0) continue;
        number = [window[(NSString *)kCGWindowNumber] unsignedLongLongValue];
        break;
    }
    [windows release];
    return number;
}

static bool PanelBounds(NSRect *bounds) {
    NSArray *windows = (NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
    bool found = false;
    for (NSDictionary *window in windows) {
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
    [windows release];
    return found;
}

static void Finish(bool passed, NSString *reason) {
    cp_hide_popup();
    report[@"scenario"] = @"native-displays";
    report[@"sourcePid"] = @(getpid());
    report[@"passed"] = @(passed);
    report[@"result"] = reason;
    report[@"clipboardTouched"] = @NO;
    NSData *data = [NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:nil];
    [data writeToFile:[output stringByAppendingPathComponent:@"verification.json"] atomically:YES];
    exit(passed ? 0 : 1);
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 2) return 2;
        output = [[NSString stringWithUTF8String:argv[1]] retain];
        report = [[NSMutableDictionary alloc] init];
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        [NSApp finishLaunching];

        NSArray<NSScreen *> *screens = [NSScreen screens];
        if (screens.count < 2) {
            // 单屏机器无法验证多显示器路径；明确报告未执行，而不是假装通过。
            Finish(false, @"需要至少两块屏幕；本次只检测到一块");
            return 1;
        }
        // 参考高度取 frame.origin 为 (0,0) 的主屏，而不是数组里的第一块。
        NSScreen *primary = nil;
        for (NSScreen *screen in screens) if (screen.frame.origin.x == 0 && screen.frame.origin.y == 0) primary = screen;
        if (!primary) Finish(false, @"找不到位于坐标原点的主屏");
        CGFloat top = primary.frame.size.height;
        report[@"primaryScreenHeight"] = @(top);

        NSMutableArray *screenList = [NSMutableArray array];
        for (NSScreen *screen in screens) {
            [screenList addObject:@{ @"frame": NSStringFromRect(screen.frame),
                                     @"visibleFrame": NSStringFromRect(screen.visibleFrame),
                                     @"scale": @(screen.backingScaleFactor) }];
        }
        report[@"screens"] = screenList;

        // cp_configure_popup 把一个 88x40 的窗口接管成常驻浮窗面板。
        NSWindow *shell = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 88, 40)
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        cp_configure_popup(shell);

        // cp_show_popup 要求来源窗口仍是前台。命令行进程很难在 macOS 14+ 抢到前台激活，
        // 所以这里不自己造来源窗口，直接把“当前真正的前台应用与它的最前窗口”当作来源——
        // 校验逻辑照常执行，被测的仍是浮窗定位。
        int frontPid = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
        uint64_t frontWindow = FrontWindowOf(frontPid);
        InputEvent event = {1, 200, 200, 0, frontWindow, frontPid, 0, 0};
        bool armed = false;
        for (int attempt = 0; attempt < 20 && !armed; ++attempt) {
            [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
            frontPid = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
            frontWindow = FrontWindowOf(frontPid);
            event.sourcePid = frontPid;
            event.sourceWindow = frontWindow;
            cp_arm(&event);
            armed = frontWindow != 0 && cp_source_matches(frontPid, frontWindow);
        }
        report[@"frontmostPid"] = @(frontPid);
        report[@"frontmostWindow"] = @(frontWindow);
        if (!armed) Finish(false, @"拿不到前台应用窗口，来源校验无法放行");

        NSMutableArray<NSValue *> *placements = [NSMutableArray array];
        double leftmost = 0;
        bool first = true;
        for (NSScreen *screen in screens) {
            NSRect frame = screen.frame;
            leftmost = first ? NSMinX(frame) : std::min(leftmost, NSMinX(frame));
            first = false;
            NSRect area = CgRect(screen.visibleFrame, top);
            Placement center = {[NSString stringWithFormat:@"%.0fx%.0f@center", frame.size.width, frame.size.height],
                NSMidX(frame), top - NSMidY(frame), area};
            Placement topLeft = {[NSString stringWithFormat:@"%.0fx%.0f@top-left", frame.size.width, frame.size.height],
                NSMinX(frame) + 30, top - (NSMaxY(frame) - 30), area};
            Placement bottomRight = {[NSString stringWithFormat:@"%.0fx%.0f@bottom-right", frame.size.width, frame.size.height],
                NSMaxX(frame) - 30, top - (NSMinY(frame) + 30), area};
            for (auto &placement : {center, topLeft, bottomRight}) {
                [placements addObject:[NSValue value:&placement withObjCType:@encode(Placement)]];
            }
        }
        // 虚拟桌面之外的锚点应当落到最近的屏幕上，而不是一律回落到主屏。
        NSPoint outside = NSMakePoint(leftmost - 200, NSMidY(primary.frame));
        NSScreen *nearest = NearestScreen(outside);
        Placement offscreen = {@"outside-desktop", outside.x, top - outside.y, CgRect(nearest.visibleFrame, top)};
        [placements addObject:[NSValue value:&offscreen withObjCType:@encode(Placement)]];

        bool passed = true;
        NSMutableArray *results = [NSMutableArray array];
        for (NSValue *value in placements) {
            Placement item;
            [value getValue:&item objCType:@encode(Placement)];
            cp_hide_popup();
            bool shown = cp_show_popup(nullptr, item.x, item.y);
            [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.2]];
            NSPoint expected = Expected(item.x, item.y, item.area);
            NSRect actual = NSZeroRect;
            bool visible = shown && PanelBounds(&actual);
            double dx = visible ? actual.origin.x - expected.x : NAN;
            double dy = visible ? actual.origin.y - expected.y : NAN;
            bool inside = visible && NSPointInRect(NSMakePoint(NSMidX(actual), NSMidY(actual)), item.area);
            bool hit = visible && cp_inside_popup(nullptr, NSMidX(actual) + 1, NSMidY(actual) + 1);
            bool miss = visible && !cp_inside_popup(nullptr, NSMidX(actual) + 3000, NSMidY(actual));
            bool ok = visible && std::fabs(dx) <= 1.5 && std::fabs(dy) <= 1.5 && inside && hit && miss;
            if (!ok) passed = false;
            [results addObject:@{
                @"name": item.name,
                @"anchor": [NSString stringWithFormat:@"(%.0f,%.0f)", item.x, item.y],
                @"expected": [NSString stringWithFormat:@"(%.0f,%.0f)", expected.x, expected.y],
                @"actual": visible ? [NSString stringWithFormat:@"(%.0f,%.0f)", actual.origin.x, actual.origin.y] : @"hidden",
                @"delta": visible ? [NSString stringWithFormat:@"(%.1f,%.1f)", dx, dy] : @"-",
                @"insideWorkArea": @(inside),
                @"insideHitTest": @(hit),
                @"outsideHitTest": @(!miss),
                @"passed": @(ok),
            }];
        }
        report[@"cases"] = results;
        Finish(passed, passed ? @"多显示器工作区内的浮窗位置与独立算出的期望一致"
                               : @"至少一个锚点的浮窗位置偏离期望或落到错误的屏幕");
    }
}
