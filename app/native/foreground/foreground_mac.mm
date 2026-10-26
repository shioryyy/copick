#include <node_api.h>
#import <AppKit/AppKit.h>

// 只查询前台应用身份；不读取 AX 选区、剪贴板或窗口标题。
static napi_value ReadForeground(napi_env env, napi_callback_info info) {
  napi_value empty;
  napi_get_null(env, &empty);
  @autoreleasepool {
    NSRunningApplication *application = NSWorkspace.sharedWorkspace.frontmostApplication;
    NSString *identifier = application.bundleIdentifier;
    pid_t pid = application.processIdentifier;
    if (!application || application.terminated || identifier.length == 0 || pid <= 0) return empty;
    const char *utf8 = identifier.UTF8String;
    if (!utf8) return empty;
    napi_value result, program, processId;
    if (napi_create_object(env, &result) != napi_ok ||
        napi_create_string_utf8(env, utf8, NAPI_AUTO_LENGTH, &program) != napi_ok ||
        napi_create_int64(env, pid, &processId) != napi_ok ||
        napi_set_named_property(env, result, "program", program) != napi_ok ||
        napi_set_named_property(env, result, "pid", processId) != napi_ok) return empty;
    return result;
  }
}
static napi_value Init(napi_env env, napi_value exports) {
  napi_value read;
  if (napi_create_function(env, "read", NAPI_AUTO_LENGTH, ReadForeground, nullptr, &read) != napi_ok ||
      napi_set_named_property(env, exports, "read", read) != napi_ok) return nullptr;
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
