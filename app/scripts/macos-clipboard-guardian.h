#pragma once
#import <Cocoa/Cocoa.h>
#include <unistd.h>
#include <signal.h>
#include <errno.h>

// 备份仅驻留守护进程内存；管道 EOF 与正常完成走同一恢复检查。
static NSArray *ClipboardSnapshot(NSPasteboard *pasteboard) {
    NSInteger sequence = pasteboard.changeCount;
    NSMutableArray *items = [NSMutableArray array];
    NSUInteger total = 0;
    NSArray *sourceItems = pasteboard.pasteboardItems;
    if (!sourceItems) return nil;
    for (NSPasteboardItem *item in sourceItems) {
        if (!item.types.count) return nil;
        NSMutableDictionary *formats = [NSMutableDictionary dictionary];
        for (NSString *type in item.types) {
            NSData *data = [item dataForType:type];
            if (!data || data.length > 32 * 1024 * 1024 || total > 64 * 1024 * 1024 - data.length) return nil;
            total += data.length;
            formats[type] = data;
        }
        [items addObject:formats];
    }
    return pasteboard.changeCount == sequence ? items : nil;
}
static bool ClipboardSame(NSArray *a, NSArray *b) {
    return a && b && [a isEqual:b];
}
static NSArray *ClipboardText(NSString *text) {
    return @[@{ NSPasteboardTypeString: [text dataUsingEncoding:NSUTF8StringEncoding] }];
}
static bool ClipboardRestore(NSPasteboard *pasteboard, NSArray *items) {
    NSMutableArray *prepared = [NSMutableArray array];
    for (NSDictionary *formats in items) {
        NSPasteboardItem *item = [[[NSPasteboardItem alloc] init] autorelease];
        for (NSString *type in formats) if (![item setData:formats[type] forType:type]) return false;
        [prepared addObject:item];
    }
    [pasteboard prepareForNewContentsWithOptions:NSPasteboardContentsCurrentHostOnly];
    return (!prepared.count || [pasteboard writeObjects:prepared]) && ClipboardSame(items, ClipboardSnapshot(pasteboard));
}
static bool GuardianReply(NSDictionary *value) {
    NSData *json = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    NSMutableData *line = [NSMutableData dataWithData:json];
    [line appendData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
    const char *bytes = (const char *)line.bytes;
    NSUInteger remaining = line.length;
    while (remaining) {
        ssize_t written = write(STDOUT_FILENO, bytes, remaining);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) return false;
        bytes += written; remaining -= written;
    }
    return true;
}
static NSDictionary *GuardianRead(NSFileHandle *pipe) {
    NSMutableData *line = [NSMutableData data];
    while (line.length < 4096) {
        NSData *byte = [pipe readDataOfLength:1];
        if (!byte.length) return nil;
        if (((const char *)byte.bytes)[0] == '\n') {
            id value = [NSJSONSerialization JSONObjectWithData:line options:0 error:nil];
            return [value isKindOfClass:NSDictionary.class] ? value : nil;
        }
        [line appendData:byte];
    }
    return nil;
}
static int RunClipboardGuardian(NSString *folder) {
    signal(SIGPIPE, SIG_IGN);
    signal(SIGINT, SIG_IGN);
    signal(SIGTERM, SIG_IGN);
    NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
    NSInteger original = pasteboard.changeCount;
    NSArray *backup = [ClipboardSnapshot(pasteboard) copy];
    NSMutableDictionary *report = [NSMutableDictionary dictionaryWithDictionary:@{
        @"guardianPid": @(getpid()), @"testClipboardRestored": @NO, @"outcome": @"untouched"
    }];
    NSInteger confirmed = -1;
    NSArray *owned = nil;
    bool initialized = false;
    if (backup && pasteboard.changeCount == original) {
        NSArray *sentinel = ClipboardText(@"copick-verification-sentinel");
        NSPasteboardItem *item = [[[NSPasteboardItem alloc] init] autorelease];
        [item setString:@"copick-verification-sentinel" forType:NSPasteboardTypeString];
        report[@"outcome"] = @"indeterminate";
        [pasteboard prepareForNewContentsWithOptions:NSPasteboardContentsCurrentHostOnly];
        NSInteger cleared = pasteboard.changeCount;
        initialized = cleared == original + 1 && [pasteboard writeObjects:@[item]] &&
            pasteboard.changeCount == cleared && ClipboardSame(sentinel, ClipboardSnapshot(pasteboard)) && pasteboard.changeCount == cleared;
        confirmed = cleared;
        owned = [sentinel retain];
        report[@"outcome"] = @"indeterminate";
    }
    GuardianReply(@{ @"ready": @(initialized), @"sequence": @(confirmed), @"guardianPid": @(getpid()) });
    bool unconfirmed = false;
    if (initialized) {
        NSFileHandle *input = NSFileHandle.fileHandleWithStandardInput;
        while (NSDictionary *command = GuardianRead(input)) {
            NSString *operation = command[@"operation"];
            if ([operation isEqualToString:@"finish"]) break;
            if (![operation isEqualToString:@"claim"]) { unconfirmed = true; break; }
            NSInteger sequence = [command[@"sequence"] integerValue];
            NSString *expected = command[@"expected"];
            bool allowed = [expected isEqualToString:@"CopickPrototype"] || [expected isEqualToString:@"SecondPrototype"];
            NSArray *snapshot = ClipboardSnapshot(pasteboard);
            bool accepted = [command[@"productCopyConfirmed"] boolValue] && allowed && sequence == confirmed + 1 && pasteboard.changeCount == sequence &&
                ClipboardSame(ClipboardText(expected), snapshot);
            if (accepted) {
                confirmed = sequence;
                [owned release]; owned = [snapshot copy];
            } else unconfirmed = true;
            GuardianReply(@{ @"accepted": @(accepted) });
        }
        NSInteger ending = pasteboard.changeCount;
        NSArray *current = ClipboardSnapshot(pasteboard);
        if (unconfirmed) report[@"outcome"] = @"indeterminate";
        else if (ending != confirmed || !ClipboardSame(owned, current) || pasteboard.changeCount != confirmed) {
            bool possibleCopy = ending == confirmed + 1 &&
                (ClipboardSame(ClipboardText(@"CopickPrototype"), current) || ClipboardSame(ClipboardText(@"SecondPrototype"), current));
            report[@"outcome"] = possibleCopy ? @"indeterminate" : @"skippedExternalChange";
        }
        else {
            // NSPasteboard 没有 CAS；最后核验与恢复之间仍存在系统级竞态。
            bool restored = ClipboardRestore(pasteboard, backup);
            report[@"outcome"] = restored ? @"restoredVerified" : @"restoreFailed";
            report[@"testClipboardRestored"] = @(restored);
        }
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:nil];
    bool reportWritten = [json writeToFile:[folder stringByAppendingPathComponent:@"clipboard-guardian.json"] atomically:YES];
    // EOF 后原 fixture 已退出，不能再向断开的 stdout 写入。
    [owned release]; [backup release];
    return reportWritten && [report[@"testClipboardRestored"] boolValue] ? 0 : 1;
}

static NSTask *clipboardGuardian;
static NSFileHandle *guardianInput;
static NSFileHandle *guardianOutput;
static NSInteger guardianSequence;
static bool StartClipboardGuardian(NSString *executable, NSString *folder) {
    NSString *reportPath = [folder stringByAppendingPathComponent:@"clipboard-guardian.json"];
    if ([NSFileManager.defaultManager fileExistsAtPath:reportPath] &&
        ![NSFileManager.defaultManager removeItemAtPath:reportPath error:nil]) return false;
    clipboardGuardian = [[NSTask alloc] init];
    clipboardGuardian.launchPath = executable;
    clipboardGuardian.arguments = @[@"--clipboard-guardian", folder];
    NSPipe *input = [NSPipe pipe], *output = [NSPipe pipe];
    clipboardGuardian.standardInput = input;
    clipboardGuardian.standardOutput = output;
    guardianInput = [input.fileHandleForWriting retain];
    guardianOutput = [output.fileHandleForReading retain];
    [clipboardGuardian launch];
    [input.fileHandleForReading closeFile];
    [output.fileHandleForWriting closeFile];
    NSDictionary *ack = GuardianRead(guardianOutput);
    guardianSequence = [ack[@"sequence"] integerValue];
    return [ack[@"ready"] boolValue];
}
static bool GuardianClaim(NSString *expected, bool productCopyConfirmed) {
    NSInteger sequence = NSPasteboard.generalPasteboard.changeCount;
    if (sequence == guardianSequence) return true;
    NSDictionary *claim = @{ @"operation": @"claim", @"sequence": @(sequence), @"expected": expected, @"productCopyConfirmed": @(productCopyConfirmed) };
    NSData *json = [NSJSONSerialization dataWithJSONObject:claim options:0 error:nil];
    [guardianInput writeData:json]; [guardianInput writeData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
    bool accepted = [GuardianRead(guardianOutput)[@"accepted"] boolValue];
    if (accepted) guardianSequence = sequence;
    return accepted;
}
static NSDictionary *FinishClipboardGuardian(NSString *folder) {
    if (!clipboardGuardian) return nil;
    if (clipboardGuardian.running) {
        [guardianInput writeData:[@"{\"operation\":\"finish\"}\n" dataUsingEncoding:NSUTF8StringEncoding]];
        [guardianInput closeFile];
    }
    [clipboardGuardian waitUntilExit];
    NSData *json = [NSData dataWithContentsOfFile:[folder stringByAppendingPathComponent:@"clipboard-guardian.json"]];
    NSDictionary *report = json ? [NSJSONSerialization JSONObjectWithData:json options:0 error:nil] : nil;
    if (![report isKindOfClass:NSDictionary.class] || [report[@"guardianPid"] intValue] != clipboardGuardian.processIdentifier ||
        clipboardGuardian.terminationReason != NSTaskTerminationReasonExit ||
        ([report[@"testClipboardRestored"] boolValue] && clipboardGuardian.terminationStatus != 0)) return nil;
    return report;
}
