#import <Cocoa/Cocoa.h>
#include <signal.h>
#include "macos-clipboard-guardian.h"

static bool SnapshotMatches(NSPasteboard *pasteboard, NSArray *expected, NSInteger sequence) {
    return pasteboard.changeCount == sequence && ClipboardSame(expected, ClipboardSnapshot(pasteboard)) &&
        pasteboard.changeCount == sequence;
}

static bool WriteCommand(NSFileHandle *pipe, NSDictionary *command) {
    NSData *json = [NSJSONSerialization dataWithJSONObject:command options:0 error:nil];
    if (!json) return false;
    NSMutableData *line = [NSMutableData dataWithData:json];
    [line appendData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
    auto previous = signal(SIGPIPE, SIG_IGN);
    bool written = false;
    @try { [pipe writeData:line]; written = true; }
    @catch (NSException *exception) { /* 由场景报告记录断管写入失败。 */ }
    signal(SIGPIPE, previous);
    return written;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc == 3 && strcmp(argv[1], "--clipboard-guardian") == 0) {
            // 避免启动 harness 的 shell/runner 继承 SIG_IGN，掩盖 guardian 自己的信号防护回归。
            signal(SIGPIPE, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGTERM, SIG_DFL);
            return RunClipboardGuardian([NSString stringWithUTF8String:argv[2]]);
        }
        if (argc == 2 && strcmp(argv[1], "--owner") == 0) {
            // 仅持有 guardian 的输入/输出管道。外层是两个 NSTask 的父进程，能核验各自退出码。
            NSDictionary *ack = GuardianRead(NSFileHandle.fileHandleWithStandardInput);
            if (!WriteCommand(NSFileHandle.fileHandleWithStandardError, ack ?: @{ @"ready": @NO }) ||
                ![ack[@"ready"] boolValue]) return 1;
            while (true) pause();
        }
        if (argc != 2) return 2;
        NSString *folder = [NSString stringWithUTF8String:argv[1]];
        NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
        NSInteger original = pasteboard.changeCount;
        NSArray *backup = [ClipboardSnapshot(pasteboard) copy];
        // nil 表示无法完整备份，绝不能交给 ClipboardRestore（它会将 nil 当空内容）。
        if (!backup || !SnapshotMatches(pasteboard, backup, original)) { [backup release]; return 1; }
        NSMutableArray *scenarios = [NSMutableArray array];
        bool passed = true;
        for (NSString *scenario in @[@"confirmed-sentinel-kill", @"external-write-kill", @"same-text-rewrite-kill", @"unclaimed-copy-kill",
            @"ready-ack-disconnect", @"claim-ack-disconnect", @"sigint-owner-kill", @"sigterm-owner-kill"]) {
            NSInteger baseline = pasteboard.changeCount;
            if (!SnapshotMatches(pasteboard, backup, baseline)) { passed = false; break; }
            bool readyDisconnect = [scenario isEqualToString:@"ready-ack-disconnect"];
            bool claimDisconnect = [scenario isEqualToString:@"claim-ack-disconnect"];
            bool direct = readyDisconnect || claimDisconnect;
            int guardianSignal = [scenario isEqualToString:@"sigint-owner-kill"] ? SIGINT :
                [scenario isEqualToString:@"sigterm-owner-kill"] ? SIGTERM : 0;
            // 每次保留独立报告，包括失败报告，不删除上一次验收证据。
            NSString *run = [[folder stringByAppendingPathComponent:scenario] stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
            if (![NSFileManager.defaultManager createDirectoryAtPath:run withIntermediateDirectories:YES attributes:nil error:nil]) {
                passed = false; break;
            }
            NSTask *guardian = [[[NSTask alloc] init] autorelease];
            guardian.launchPath = [NSString stringWithUTF8String:argv[0]];
            guardian.arguments = @[@"--clipboard-guardian", run];
            NSPipe *input = [NSPipe pipe], *output = [NSPipe pipe];
            guardian.standardInput = input;
            guardian.standardOutput = output;
            if (readyDisconnect) {
                // launch 前关闭唯一读端和写入端，保证初始 ready ACK 遇到 EPIPE，随后 stdin EOF。
                [output.fileHandleForReading closeFile];
                [input.fileHandleForWriting closeFile];
            }
            [guardian launch];
            pid_t guardianPid = guardian.processIdentifier;
            [input.fileHandleForReading closeFile];
            [output.fileHandleForWriting closeFile];
            NSTask *owner = nil;
            NSDictionary *ack = nil;
            if (!direct) {
                owner = [[[NSTask alloc] init] autorelease];
                owner.launchPath = [NSString stringWithUTF8String:argv[0]];
                owner.arguments = @[@"--owner"];
                owner.standardInput = output;
                owner.standardOutput = input;
                NSPipe *ownerReady = [NSPipe pipe];
                owner.standardError = ownerReady;
                [owner launch];
                [ownerReady.fileHandleForWriting closeFile];
                // owner 成为唯一管道持有者；SIGKILL 后 guardian 才会观察到 EOF。
                [input.fileHandleForWriting closeFile];
                [output.fileHandleForReading closeFile];
                ack = GuardianRead(ownerReady.fileHandleForReading);
                [ownerReady.fileHandleForReading closeFile];
            } else if (claimDisconnect) ack = GuardianRead(output.fileHandleForReading);
            NSInteger sentinelSequence = baseline + 1;
            bool ready = [ack[@"ready"] boolValue] && [ack[@"guardianPid"] intValue] == guardianPid &&
                [ack[@"sequence"] integerValue] == sentinelSequence &&
                SnapshotMatches(pasteboard, ClipboardText(@"copick-verification-sentinel"), sentinelSequence);
            NSString *external = [scenario isEqualToString:@"external-write-kill"] ? [@"guardian-external-" stringByAppendingString:NSUUID.UUID.UUIDString] :
                [scenario isEqualToString:@"same-text-rewrite-kill"] ? @"copick-verification-sentinel" :
                [scenario isEqualToString:@"unclaimed-copy-kill"] || claimDisconnect ? @"CopickPrototype" : nil;
            NSArray *externalSnapshot = external ? ClipboardText(external) : nil;
            // 只有完整核验本次 sentinel 的版本和所有格式后，才允许外层有意写测试内容。
            bool externalWritten = !external || (ready && SnapshotMatches(pasteboard, ClipboardText(@"copick-verification-sentinel"), sentinelSequence) &&
                ClipboardRestore(pasteboard, externalSnapshot));
            NSInteger externalSequence = external ? pasteboard.changeCount : -1;
            externalWritten = externalWritten && (!external || (externalSequence == sentinelSequence + 1 &&
                SnapshotMatches(pasteboard, externalSnapshot, externalSequence)));
            bool claimSent = false;
            if (claimDisconnect) {
                // 先关闭读端再发 claim，保证 accepted ACK 没有读者；不读取/伪造 accepted。
                [output.fileHandleForReading closeFile];
                if (externalWritten) claimSent = WriteCommand(input.fileHandleForWriting,
                    @{ @"operation": @"claim", @"sequence": @(externalSequence), @"expected": external, @"productCopyConfirmed": @YES });
                [input.fileHandleForWriting closeFile];
            }
            bool signalSent = !guardianSignal || (ready && kill(guardianPid, guardianSignal) == 0);
            bool aliveBeforeOwnerExit = !guardianSignal || guardian.running;
            bool ownerKilled = false;
            if (owner) {
                bool killed = kill(owner.processIdentifier, SIGKILL) == 0;
                [owner waitUntilExit];
                ownerKilled = killed && owner.terminationReason == NSTaskTerminationReasonUncaughtSignal && owner.terminationStatus == SIGKILL;
            }
            [guardian waitUntilExit];
            NSString *reportPath = [run stringByAppendingPathComponent:@"clipboard-guardian.json"];
            NSData *data = [NSData dataWithContentsOfFile:reportPath];
            id parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
            NSDictionary *restoration = [parsed isKindOfClass:NSDictionary.class] ? parsed : nil;
            bool matchedReport = [restoration[@"guardianPid"] intValue] == guardianPid;
            bool guardianExited = guardian.terminationReason == NSTaskTerminationReasonExit;
            bool shouldPreserve = external && !claimDisconnect;
            NSString *expectedOutcome = shouldPreserve ? ([scenario isEqualToString:@"unclaimed-copy-kill"] ? @"indeterminate" : @"skippedExternalChange") : @"restoredVerified";
            bool preserved = external && SnapshotMatches(pasteboard, externalSnapshot, externalSequence);
            bool restoredByGuardian = SnapshotMatches(pasteboard, backup, baseline + (claimDisconnect ? 3 : 2));
            bool scenarioPassed = (readyDisconnect || ready) && externalWritten && (!claimDisconnect || claimSent) &&
                (direct || ownerKilled) && signalSent && aliveBeforeOwnerExit && matchedReport && guardianExited &&
                guardian.terminationStatus == (shouldPreserve ? 1 : 0) && [restoration[@"outcome"] isEqual:expectedOutcome] &&
                [restoration[@"testClipboardRestored"] boolValue] == !shouldPreserve && (shouldPreserve ? preserved : restoredByGuardian);
            // 先保留 guardian 的原始失败证据；退出后才清理本轮且版本/全部格式仍匹配的测试写入。
            // ready ACK 故意不读时无法确认初始 sentinel，失败后不推测其归属。
            bool cleanupExternal = external && externalSequence == sentinelSequence + 1 && preserved;
            bool cleanupSentinel = ready && SnapshotMatches(pasteboard, ClipboardText(@"copick-verification-sentinel"), sentinelSequence);
            bool cleanupNeeded = cleanupExternal || cleanupSentinel;
            NSArray *cleanupSnapshot = cleanupExternal ? externalSnapshot : ClipboardText(@"copick-verification-sentinel");
            NSInteger cleanupSequence = cleanupExternal ? externalSequence : sentinelSequence;
            bool cleanupSucceeded = !cleanupNeeded || (SnapshotMatches(pasteboard, cleanupSnapshot, cleanupSequence) &&
                ClipboardRestore(pasteboard, backup));
            NSInteger ending = pasteboard.changeCount;
            bool baselineRestored = SnapshotMatches(pasteboard, backup, ending);
            [scenarios addObject:@{ @"name": scenario, @"passed": @(scenarioPassed && cleanupSucceeded && baselineRestored),
                @"reportPath": reportPath, @"readyAck": ack ?: @{}, @"readyAckIntentionallyUnread": @(readyDisconnect),
                @"claimSent": @(claimSent), @"claimAckIntentionallyUnread": @(claimDisconnect),
                @"guardianPid": @(guardianPid), @"guardianReportMatched": @(matchedReport),
                @"guardianTerminationReason": @(guardian.terminationReason), @"guardianExitStatus": @(guardian.terminationStatus),
                @"ownerKilled": @(ownerKilled), @"signal": @(guardianSignal), @"signalSent": @(signalSent && guardianSignal != 0),
                @"guardianRunningAfterSignal": @(aliveBeforeOwnerExit && guardianSignal != 0),
                @"externalWritten": @(external && externalWritten), @"externalPreserved": @(preserved),
                @"sequenceBeforeExternalWrite": @(sentinelSequence), @"externalSequence": @(externalSequence),
                @"outerCleanupNeeded": @(cleanupNeeded), @"outerCleanupSucceeded": @(cleanupSucceeded),
                @"testClipboardRestored": @(baselineRestored), @"restoration": restoration ?: @{} }];
            passed = passed && scenarioPassed && cleanupSucceeded && baselineRestored;
            if (!passed) break;
        }
        NSInteger ending = pasteboard.changeCount;
        bool restored = SnapshotMatches(pasteboard, backup, ending);
        NSDictionary *report = @{ @"scenario": @"clipboard-guardian", @"sourcePid": @(getpid()),
            @"passed": @(passed && restored), @"testClipboardRestored": @(restored), @"scenarios": scenarios,
            @"evidenceLimits": @[
                @"Only this harness deliberately writes clipboard test text. No GUI copy or product copy callback is exercised; productCopyConfirmed:true in claim-ack-disconnect is a harness assertion after verifying sequence and every format.",
                @"ACK-disconnect scenarios close the read endpoint before the relevant ACK can be written. They prove restoration after EPIPE/EOF without receiving that ACK, not a timed crash of a GUI owner during ACK delivery.",
                @"SIGINT/SIGTERM scenarios send each signal to the ready guardian while its pipe owner is alive, then SIGKILL the owner. Normal guardian exit and its matching report are required; SIGKILL of the guardian itself is not covered.",
                @"Sequence and all-format checks bound cleanup to observed test writes. NSPasteboard has no compare-and-swap; a concurrent clipboard writer can still race the final check and restoration. Run serially with no clipboard/GUI automation."
            ] };
        NSData *data = [NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:nil];
        bool reportWritten = [data writeToFile:[folder stringByAppendingPathComponent:@"verification.json"] atomically:YES];
        [backup release];
        return passed && restored && reportWritten ? 0 : 1;
    }
}
