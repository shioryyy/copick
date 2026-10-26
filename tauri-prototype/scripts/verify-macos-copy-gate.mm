#import <Cocoa/Cocoa.h>
#include <condition_variable>
#include <mutex>
#include <thread>
#include "operation_gate.h"

// This executable controls scheduling around the product's gate, not AX or the
// product copy entry point. Clipboard writes use the real system pasteboard.
class Barrier {
    std::mutex mutex;
    std::condition_variable changed;
    bool arrived = false, released = false;
public:
    void Pause() {
        std::unique_lock<std::mutex> lock(mutex);
        arrived = true;
        changed.notify_all();
        changed.wait(lock, [&] { return released; });
    }
    void Wait() {
        std::unique_lock<std::mutex> lock(mutex);
        changed.wait(lock, [&] { return arrived; });
    }
    void Complete() {
        std::lock_guard<std::mutex> lock(mutex);
        arrived = true;
        changed.notify_all();
    }
    void Release() {
        std::lock_guard<std::mutex> lock(mutex);
        released = true;
        changed.notify_all();
    }
};

static NSArray *Snapshot(NSPasteboard *pasteboard) {
    NSInteger sequence = pasteboard.changeCount;
    NSMutableArray *snapshot = [NSMutableArray array];
    NSUInteger total = 0;
    for (NSPasteboardItem *item in pasteboard.pasteboardItems) {
        if (item.types.count == 0) return nil;
        NSMutableDictionary *formats = [NSMutableDictionary dictionary];
        for (NSPasteboardType type in item.types) {
            NSData *data = [item dataForType:type];
            if (!data || data.length > 32 * 1024 * 1024 || total > 64 * 1024 * 1024 - data.length) return nil;
            total += data.length;
            formats[type] = [[data copy] autorelease];
        }
        [snapshot addObject:formats];
    }
    return pasteboard.changeCount == sequence ? snapshot : nil;
}

static bool SameFormats(NSArray *expected, NSArray *actual) {
    if (!expected || !actual || expected.count != actual.count) return false;
    for (NSUInteger index = 0; index < expected.count; ++index) {
        NSDictionary *a = expected[index], *b = actual[index];
        if (a.count != b.count) return false;
        for (NSString *type in a) if (![a[type] isEqual:b[type]]) return false;
    }
    return true;
}
static bool Restore(NSPasteboard *pasteboard, NSArray *snapshot) {
    NSMutableArray *items = [NSMutableArray array];
    for (NSDictionary *formats in snapshot) {
        NSPasteboardItem *item = [[[NSPasteboardItem alloc] init] autorelease];
        for (NSString *type in formats) if (![item setData:formats[type] forType:type]) return false;
        [items addObject:item];
    }
    [pasteboard prepareForNewContentsWithOptions:NSPasteboardContentsCurrentHostOnly];
    if (items.count && ![pasteboard writeObjects:items]) return false;
    NSArray *actual = Snapshot(pasteboard);
    return SameFormats(snapshot, actual);
}

enum class PauseAt { BeforeCommit, AfterCommit, AfterClear, AfterFinish };
static NSDictionary *Scenario(NSString *name, PauseAt phase, bool failAfterClear, NSInteger *sequence, bool *externalChange) {
    NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
    if (pasteboard.changeCount != *sequence) return @{ @"name": name, @"passed": @NO, @"error": @"External clipboard change; stopped before writing" };
    NSInteger base = pasteboard.changeCount;
    NSString *sentinel = [@"copick-gate-sentinel-" stringByAppendingString:NSUUID.UUID.UUIDString];
    NSString *expected = [@"copick-gate-result-" stringByAppendingString:NSUUID.UUID.UUIDString];
    [pasteboard prepareForNewContentsWithOptions:NSPasteboardContentsCurrentHostOnly];
    NSInteger afterPrepare = pasteboard.changeCount;
    if (![pasteboard setString:sentinel forType:NSPasteboardTypeString]) {
        *sequence = pasteboard.changeCount;
        return @{ @"name": name, @"passed": @NO, @"error": @"Unable to write test sentinel" };
    }
    NSInteger before = pasteboard.changeCount;
    if (pasteboard.changeCount != afterPrepare || ![[pasteboard stringForType:NSPasteboardTypeString] isEqualToString:sentinel]) {
        *externalChange = true;
        *sequence = pasteboard.changeCount;
        return @{ @"name": name, @"passed": @NO, @"error": @"Clipboard changed while writing test sentinel" };
    }
    NSInteger setupClearDelta = afterPrepare - base;
    NSInteger setupSentinelDelta = before - afterPrepare;
    copick::OperationGate gate;
    Barrier barrier;
    bool wrote = false, cleared = false, exception = false;
    int status = -1;
    std::thread worker([&] {
        @autoreleasepool {
            @try {
                NSPasteboardItem *item = [[[NSPasteboardItem alloc] init] autorelease];
                bool prepared = [item setString:expected forType:NSPasteboardTypeString];
                if (phase == PauseAt::BeforeCommit) barrier.Pause();
                if (prepared && gate.TryCommit()) {
                    if (phase == PauseAt::AfterCommit) barrier.Pause();
                    if (pasteboard.changeCount != before ||
                        ![[pasteboard stringForType:NSPasteboardTypeString] isEqualToString:sentinel]) {
                        *externalChange = true;
                    } else {
                        [pasteboard clearContents];
                        cleared = true;
                        NSInteger afterClear = pasteboard.changeCount;
                        if (afterClear != before + 1) *externalChange = true;
                        if (phase == PauseAt::AfterClear) barrier.Pause();
                        // Do not overwrite a clipboard update observed while the
                        // operation was paused after clearing the previous data.
                        if (pasteboard.changeCount != afterClear) *externalChange = true;
                        else if (!failAfterClear && !*externalChange) wrote = [pasteboard writeObjects:@[item]];
                    }
                    gate.FinishCommit();
                }
                if (phase == PauseAt::AfterFinish) barrier.Pause();
                if (!prepared) barrier.Complete();
            } @catch (NSException *) { exception = true; barrier.Complete(); }
            status = wrote ? 1 : gate.Committed() ? 2 : 0;
        }
    });
    barrier.Wait();
    int cancellation = gate.Cancel();
    barrier.Release();
    worker.join();
    if (phase == PauseAt::BeforeCommit) barrier.Wait();
    NSString *actual = [pasteboard stringForType:NSPasteboardTypeString];
    NSInteger ending = pasteboard.changeCount;
    NSInteger changeCountDelta = ending - before;
    if ((phase == PauseAt::BeforeCommit && ending != before) ||
        (phase != PauseAt::BeforeCommit && cleared && ending != before + 1)) *externalChange = true;
    bool empty = pasteboard.pasteboardItems.count == 0;
    if (![actual isEqualToString:sentinel] && ![actual isEqualToString:expected] && !(failAfterClear && empty)) *externalChange = true;
    *sequence = ending;
    bool cancelledFirst = phase == PauseAt::BeforeCommit;
    bool unchanged = !cleared && ending == before && [actual isEqualToString:sentinel];
    bool exact = [actual isEqualToString:expected];
    bool passed = !exception && (cancelledFirst
        ? cancellation == 1 && status == 0 && unchanged
        : cancellation == 2 && cleared && (failAfterClear ? status == 2 && !wrote && empty : status == 1 && wrote && exact));
    passed = passed && !*externalChange;
    return @{ @"name": name, @"passed": @(passed), @"cancelResult": @(cancellation),
        @"copyStatus": @(status), @"cleared": @(cleared), @"wrote": @(wrote),
        @"unchanged": @(unchanged), @"clipboardMatches": @(exact), @"clipboardEmpty": @(empty),
        @"changeCountDelta": @(changeCountDelta), @"setupClearDelta": @(setupClearDelta),
        @"setupSentinelDelta": @(setupSentinelDelta), @"injectedPostClearFailure": @(failAfterClear), @"exception": @(exception) };
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 2) return 2;
        NSString *output = [NSString stringWithUTF8String:argv[1]];
        NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
        NSInteger originalSequence = pasteboard.changeCount;
        NSArray *backup = nil;
        NSMutableArray *cases = [NSMutableArray array];
        bool passed = false, touched = false, restored = false;
        bool externalChange = false;
        NSString *reason = @"Clipboard backup failed; nothing written";
        NSInteger sequence = originalSequence;
        @try {
            backup = [Snapshot(pasteboard) retain];
            if (backup && pasteboard.changeCount == originalSequence) {
                passed = true;
                for (auto phase : {PauseAt::BeforeCommit, PauseAt::AfterCommit, PauseAt::AfterClear, PauseAt::AfterFinish}) {
                    NSString *name = phase == PauseAt::BeforeCommit ? @"cancel-before-commit"
                        : phase == PauseAt::AfterCommit ? @"cancel-after-commit"
                        : phase == PauseAt::AfterClear ? @"cancel-after-clear" : @"cancel-after-finish";
                    if (pasteboard.changeCount != sequence) { externalChange = true; passed = false; break; }
                    touched = true;
                    NSDictionary *result = Scenario(name, phase, false, &sequence, &externalChange);
                    [cases addObject:result];
                    if (![result[@"passed"] boolValue]) { passed = false; break; }
                }
                if (passed) {
                    if (pasteboard.changeCount != sequence) { externalChange = true; passed = false; }
                    else {
                        NSDictionary *result = Scenario(@"failure-after-clear", PauseAt::AfterClear, true, &sequence, &externalChange);
                        [cases addObject:result];
                        passed = [result[@"passed"] boolValue];
                    }
                }
                reason = passed ? @"Five forced schedules passed on the system pasteboard" : @"Forced schedule failed";
            }
        } @catch (NSException *) { passed = false; reason = @"Pasteboard exception"; }
        @try {
            if (!touched) restored = true;
            else if (backup && !externalChange && pasteboard.changeCount == sequence) restored = Restore(pasteboard, backup);
            else { externalChange = true; reason = @"Clipboard changed externally; refused to overwrite it with backup"; }
        } @catch (NSException *) { restored = false; }
        passed = passed && restored && !externalChange && cases.count == 5;
        if (externalChange) reason = @"External clipboard change; backup restoration was refused";
        NSDictionary *report = @{ @"scenario": @"native-copy-gate", @"sourcePid": @(getpid()),
            @"passed": @(passed), @"result": reason, @"cases": cases,
            @"clipboardTouched": @(touched), @"externalChangeObserved": @(externalChange),
            @"backupItemCount": @(backup.count), @"testClipboardRestored": @(restored),
            @"scope": @"Shared product gate plus real NSPasteboard; not the product AX/copy entry point" };
        NSData *json = [NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:nil];
        bool saved = [json writeToFile:[output stringByAppendingPathComponent:@"verification.json"] atomically:YES];
        [backup release];
        return passed && saved ? 0 : 1;
    }
}
