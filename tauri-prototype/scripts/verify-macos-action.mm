#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#include <signal.h>

// 验证进程提前解析真实控制页按钮，避免把脚本启动/AX 树初始化计入提交竞态。
int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc != 6) return 2;
        int pid = atoi(argv[1]);
        NSString *folder = [NSString stringWithUTF8String:argv[2]];
        NSString *logPath = [NSString stringWithUTF8String:argv[3]];
        NSUInteger offset = strtoull(argv[4], nullptr, 10);
        bool exiting = strcmp(argv[5], "exit") == 0;
        AXUIElementRef app = AXUIElementCreateApplication(pid);
        AXUIElementSetMessagingTimeout(app, 0.2);
        NSMutableArray *queue = [NSMutableArray arrayWithObject:(id)app];
        CFRelease(app);
        AXUIElementRef target = nullptr;
        for (NSUInteger index = 0; index < queue.count && index < 250 && !target; ++index) {
            AXUIElementRef element = (AXUIElementRef)queue[index];
            CFTypeRef title = nullptr, role = nullptr;
            AXUIElementCopyAttributeValue(element, kAXTitleAttribute, &title);
            AXUIElementCopyAttributeValue(element, kAXRoleAttribute, &role);
            // 关闭窗口只会隐藏到托盘，退出场景必须点击真正的退出按钮。
            if (role && CFEqual(role, kAXButtonRole) && title &&
                CFEqual(title, exiting ? CFSTR("退出 Copick") : CFSTR("暂停监听")))
                target = (AXUIElementRef)CFRetain(element);
            if (title) CFRelease(title);
            if (role) CFRelease(role);
            CFTypeRef children = nullptr;
            AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &children);
            if (children && CFGetTypeID(children) == CFArrayGetTypeID()) [queue addObjectsFromArray:(NSArray *)children];
            if (children) CFRelease(children);
        }
        if (!target) return 3;
        [@"ready" writeToFile:[folder stringByAppendingPathComponent:@"actor-ready"] atomically:YES encoding:NSUTF8StringEncoding error:nil];
        for (int attempt = 0; attempt < 2000; ++attempt) {
            if ([NSFileManager.defaultManager fileExistsAtPath:[folder stringByAppendingPathComponent:@"provider-entered"]]) {
                NSData *data = [NSData dataWithContentsOfFile:logPath];
                if (data.length >= offset) {
                    NSString *recent = [[[NSString alloc] initWithData:[data subdataWithRange:NSMakeRange(offset, data.length - offset)] encoding:NSUTF8StringEncoding] autorelease];
                    if ([recent containsString:@"COPICK_COPY_BEGIN request="]) {
                        NSTimeInterval start = NSDate.timeIntervalSinceReferenceDate;
                        AXError result = AXUIElementPerformAction(target, kAXPressAction);
                        double elapsed = (NSDate.timeIntervalSinceReferenceDate - start) * 1000;
                        CFRelease(target);
                        printf("%.3f\n", elapsed);
                        return result == kAXErrorSuccess ? 0 : 4;
                    }
                }
            }
            usleep(10000);
        }
        CFRelease(target);
        return 5;
    }
}
