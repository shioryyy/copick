#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
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
void cp_hide_popup();
}

static NSString *output;
static NSMutableDictionary *report;
static NSWindow *source;
static NSWindow *original;

static bool PanelVisible() {
    NSArray *windows = (NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
    bool found = false;
    for (NSDictionary *window in windows) {
        NSDictionary *bounds = window[(NSString *)kCGWindowBounds];
        if ([window[(NSString *)kCGWindowOwnerPID] intValue] == getpid() &&
            [bounds[@"Width"] doubleValue] == 88 && [bounds[@"Height"] doubleValue] == 40) { found = true; break; }
    }
    [windows release];
    return found;
}
static void Finish(bool passed, NSString *reason) {
    cp_hide_popup();
    report[@"scenario"] = @"native-show-failure";
    report[@"sourcePid"] = @(getpid());
    report[@"passed"] = @(passed);
    report[@"result"] = reason;
    report[@"clipboardTouched"] = @NO;
    NSData *data = [NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:nil];
    [data writeToFile:[output stringByAppendingPathComponent:@"verification.json"] atomically:YES];
    [source orderOut:nil];
    exit(passed ? 0 : 1);
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 2) return 2;
        output = [[NSString stringWithUTF8String:argv[1]] retain];
        report = [[NSMutableDictionary alloc] init];
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        report[@"missingPanelRejected"] = @(!cp_show_popup(nullptr, 200, 200));
        original = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 88, 40)
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        cp_configure_popup(original);
        report[@"missingSourceRejected"] = @(!cp_show_popup(nullptr, 200, 200) && !PanelVisible());
        source = [[NSWindow alloc] initWithContentRect:NSMakeRect(180, 180, 400, 160)
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
        source.title = @"Copick native show failure fixture";
        NSTextView *text = [[[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 400, 160)] autorelease];
        text.string = @"Native source window";
        source.contentView = text;
        [source makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 500 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
            [source makeKeyAndOrderFront:nil];
            InputEvent event = {1, 200, 200, 0, static_cast<uint64_t>(source.windowNumber), getpid(), 0, 0};
            cp_arm(&event);
            bool matched = cp_source_matches(getpid(), source.windowNumber);
            report[@"liveSourceMatched"] = @(matched);
            report[@"frontmostPid"] = @(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier);
            report[@"sourceWindowNumber"] = @(source.windowNumber);
            report[@"sourceWindowVisible"] = @(source.visible);
            report[@"sourceWindowKey"] = @(source.keyWindow);
            if (!matched) {
                NSArray *windows = (NSArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
                NSMutableArray *identities = [NSMutableArray array];
                for (NSDictionary *window in windows) if ([window[(NSString *)kCGWindowOwnerPID] intValue] == getpid()) [identities addObject:window];
                report[@"sourceWindows"] = identities;
                [windows release];
                Finish(false, @"Source window could not become frontmost; desktop not available"); return;
            }
            report[@"nonFinitePositionRejected"] = @(!cp_show_popup(nullptr, NAN, 200) && !PanelVisible());
            bool shown = cp_show_popup(nullptr, 200, 200);
            report[@"showAccepted"] = @(shown);
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 250 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
                report[@"realPanelShown"] = @(shown && PanelVisible());
                cp_hide_popup();
                // Invalidate a real source between arming and presentation.
                NSWindow *other = [[NSWindow alloc] initWithContentRect:NSMakeRect(650, 180, 400, 160)
                    styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
                other.title = @"Copick replacement source window";
                [other makeKeyAndOrderFront:nil];
                [source orderOut:nil];
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 500 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
                    bool invalid = !cp_source_matches(getpid(), event.sourceWindow);
                    bool rejected = !cp_show_popup(nullptr, 200, 200);
                    bool hidden = !PanelVisible();
                    report[@"sourceInvalidated"] = @(invalid);
                    report[@"invalidSourceShowRejected"] = @(rejected);
                    report[@"popupHiddenAfterFailure"] = @(hidden);
                    [other orderOut:nil];
                    Finish([report[@"missingPanelRejected"] boolValue] && [report[@"missingSourceRejected"] boolValue] &&
                        [report[@"nonFinitePositionRejected"] boolValue] && [report[@"realPanelShown"] boolValue] && invalid && rejected && hidden,
                        @"Real native panel rejects invalid arguments and invalidated source without appearing");
                });
            });
        });
        [NSApp run];
    }
}
