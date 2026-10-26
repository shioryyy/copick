#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <cstdint>
#include <cstring>
#include "operation_gate.h"

extern "C" {
struct InputEvent { int kind; double x; double y; int gesture; uint64_t sourceWindow; int sourcePid; uint64_t clipboardSequence; uint64_t cursor; };
void cp_configure_popup(void *window);
void cp_arm(const InputEvent *event);
bool cp_show_popup(void *window, double x, double y);
void cp_hide_popup();
}

static NSString *output;
static NSMutableDictionary *report;
static NSWindow *hostWindow;
static NSWindow *sourceWindow;
static WKWebView *webview;
static NSData *readyPixels;
static NSData *copiedPixels;
static NSData *firstPixels;
static NSData *settledPixels;
static bool finished = false;

static NSData *Pixels(NSImage *image) {
    if (!image) return nil;
    NSRect rect = NSMakeRect(0, 0, image.size.width, image.size.height);
    CGImageRef imageRef = [image CGImageForProposedRect:&rect context:nil hints:nil];
    if (!imageRef) return nil;
    size_t width = CGImageGetWidth(imageRef), height = CGImageGetHeight(imageRef);
    if (!width || !height || width > 4096 || height > 4096) return nil;
    NSMutableData *data = [NSMutableData dataWithLength:width * height * 4];
    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
    CGContextRef context = CGBitmapContextCreate(data.mutableBytes, width, height, 8, width * 4,
        colorSpace, kCGBitmapByteOrder32Big | kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(colorSpace);
    if (!context) return nil;
    CGContextDrawImage(context, CGRectMake(0, 0, width, height), imageRef);
    CGContextRelease(context);
    return data;
}

static void SaveSnapshot(NSImage *image, NSString *name) {
    NSData *tiff = image.TIFFRepresentation;
    NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:tiff];
    NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    [png writeToFile:[output stringByAppendingPathComponent:name] atomically:YES];
}
static void Snapshot(NSString *name, void (^completion)(NSData *, NSError *)) {
    [webview takeSnapshotWithConfiguration:nil completionHandler:^(NSImage *image, NSError *error) {
        if (!error && image) SaveSnapshot(image, name);
        completion(image ? Pixels(image) : nil, error);
    }];
}
static void Evaluate(NSString *script, void (^completion)(id, NSError *)) {
    [webview evaluateJavaScript:script completionHandler:completion];
}
static void Finish(bool passed, NSString *reason) {
    if (finished) return;
    finished = true;
    cp_hide_popup();
    report[@"scenario"] = @"popup-first-frame";
    report[@"sourcePid"] = @(getpid());
    report[@"passed"] = @(passed);
    report[@"result"] = reason;
    report[@"visualSource"] = @"WKWebView takeSnapshot requested immediately after native show; not compositor scanout capture";
    NSData *json = [NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:nil];
    [json writeToFile:[output stringByAppendingPathComponent:@"verification.json"] atomically:YES];
    [sourceWindow orderOut:nil];
    exit(passed ? 0 : 1);
}
static void FailIfError(NSError *error, NSString *stage) {
    if (error) Finish(false, [NSString stringWithFormat:@"%@ failed: %@", stage, error.localizedDescription]);
}
static void ArmAndShow(void (^completion)(bool)) {
    InputEvent source = {1, 200, 200, 0, static_cast<uint64_t>(sourceWindow.windowNumber), getpid(), 0, 0};
    cp_arm(&source);
    completion(cp_show_popup(nullptr, 200, 200));
}
static void WaitForCopied(int attempt, void (^completion)(bool)) {
    Evaluate(@"document.getElementById('copy-label').textContent", ^(id value, NSError *error) {
        if (error) { FailIfError(error, @"Polling copied state"); completion(false); return; }
        if ([value isEqual:@"已复制"]) { completion(true); return; }
        if (attempt >= 50) { completion(false); return; }
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ WaitForCopied(attempt + 1, completion); });
    });
}
static void PrepareCopied(int attempt, void (^completion)(bool)) {
    Evaluate(@"document.getElementById('copy').disabled", ^(id disabled, NSError *error) {
        if (error) { FailIfError(error, @"Waiting for presentation"); completion(false); return; }
        if (![disabled boolValue]) {
            Snapshot(@"first-frame-ready.png", ^(NSData *pixels, NSError *snapshotError) {
                FailIfError(snapshotError, @"Ready-state snapshot"); if (finished || !pixels) { completion(false); return; }
                readyPixels = [pixels retain];
                Evaluate(@"(document.getElementById('copy').click(), true)", ^(id _, NSError *clickError) {
                    if (clickError) { FailIfError(clickError, @"Clicking baseline copy state"); completion(false); return; }
                    WaitForCopied(0, completion);
                });
            });
        } else if (attempt >= 50) completion(false);
        else dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{ PrepareCopied(attempt + 1, completion); });
    });
}

@interface PopupNavigation : NSObject <WKNavigationDelegate>
@property(nonatomic, copy) void (^loaded)(void);
@end
@implementation PopupNavigation
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    if (self.loaded) self.loaded();
}
@end

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 3) return 2;
        output = [[NSString stringWithUTF8String:argv[1]] retain];
        NSString *ui = [[NSString stringWithUTF8String:argv[2]] stringByStandardizingPath];
        report = [[NSMutableDictionary alloc] init];
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        WKUserContentController *controller = [[[WKUserContentController alloc] init] autorelease];
        NSString *mock = @"window.__TAURI__={core:{invoke:function(command){if(command==='popup_state')return Promise.resolve({token:null,copying:false,copied:false});if(command==='present'||command==='copy_selection')return Promise.resolve(true);return Promise.reject('unexpected command')}}};";
        WKUserScript *userScript = [[[WKUserScript alloc] initWithSource:mock injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES] autorelease];
        [controller addUserScript:userScript];
        WKWebViewConfiguration *configuration = [[[WKWebViewConfiguration alloc] init] autorelease];
        configuration.userContentController = controller;
        webview = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 88, 40) configuration:configuration];
        hostWindow = [[NSWindow alloc] initWithContentRect:NSMakeRect(30, 30, 88, 40)
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        hostWindow.contentView = webview;
        cp_configure_popup(hostWindow);
        sourceWindow = [[NSWindow alloc] initWithContentRect:NSMakeRect(160, 160, 420, 180)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        sourceWindow.title = @"Copick first-frame fixture source";
        [sourceWindow makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 500 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
            NSString *html = [ui stringByAppendingPathComponent:@"popup.html"];
            NSURL *url = [NSURL fileURLWithPath:html];
            [webview loadFileURL:url allowingReadAccessToURL:[NSURL fileURLWithPath:ui isDirectory:YES]];
            static PopupNavigation *navigation;
            navigation = [[PopupNavigation alloc] init];
            navigation.loaded = ^{
                if (finished) return;
                Evaluate(@"(window.copickSelection('old-token'), true)", ^(id _, NSError *error) {
                    FailIfError(error, @"Preparing prior copied state"); if (finished) return;
                    PrepareCopied(0, ^(bool copied) {
                        if (!copied) { Finish(false, @"Could not prepare the prior copied state"); return; }
                        report[@"previousCopiedLabel"] = @"已复制";
                        ArmAndShow(^(bool shown) {
                            if (!shown) { Finish(false, @"Could not show baseline popup for the source window"); return; }
                            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 200 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
                                Snapshot(@"first-frame-before.png", ^(NSData *pixels, NSError *snapshotError) {
                                    FailIfError(snapshotError, @"Baseline snapshot"); if (finished || !pixels) return;
                                    copiedPixels = [pixels retain];
                                    cp_hide_popup();
                                    Evaluate(@"(window.copickSelection('new-token'), true)", ^(id _, NSError *selectError) {
                                        FailIfError(selectError, @"Resetting popup for next selection"); if (finished) return;
                                        ArmAndShow(^(bool firstShown) {
                                            report[@"nativeShowAccepted"] = @(firstShown);
                                            if (!firstShown) { Finish(false, @"Could not show popup for the new source selection"); return; }
                                            Snapshot(@"first-frame-after.png", ^(NSData *pixelsNow, NSError *firstError) {
                                                FailIfError(firstError, @"First post-show snapshot"); if (finished || !pixelsNow) return;
                                                firstPixels = [pixelsNow retain];
                                                report[@"firstSnapshotDiffersFromCopied"] = @(![firstPixels isEqual:copiedPixels]);
                                                report[@"firstSnapshotMatchesReady"] = @([firstPixels isEqual:readyPixels]);
                                                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 250 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
                                                    Snapshot(@"first-frame-settled.png", ^(NSData *stable, NSError *settledError) {
                                                        FailIfError(settledError, @"Settled snapshot"); if (finished || !stable) return;
                                                        settledPixels = [stable retain];
                                                        report[@"settledSnapshotMatchesFirst"] = @([settledPixels isEqual:firstPixels]);
                                                        report[@"newSelectionLabel"] = @"复制";
                                                        Finish([report[@"previousCopiedLabel"] isEqual:@"已复制"] &&
                                                            [report[@"firstSnapshotDiffersFromCopied"] boolValue] &&
                                                            [report[@"firstSnapshotMatchesReady"] boolValue] &&
                                                            [report[@"settledSnapshotMatchesFirst"] boolValue],
                                                            @"Immediate WKWebView snapshot shows the new popup state rather than the prior copied state");
                                                    });
                                                });
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            };
            webview.navigationDelegate = navigation;
        });
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            Finish(false, @"Timed out waiting for the first-frame fixture");
        });
        [NSApp run];
    }
}
