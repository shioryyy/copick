#include <node_api.h>
#include <windows.h>
#include <string>
#include <vector>

// 无法确认前台窗口、进程或映像名时返回 null，不回退到读取选区或发送按键。
static napi_value ReadForeground(napi_env env, napi_callback_info info) {
  napi_value empty;
  napi_get_null(env, &empty);
  HWND window = GetForegroundWindow();
  DWORD pid = 0;
  if (!window || !GetWindowThreadProcessId(window, &pid) || !pid) return empty;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return empty;
  std::vector<wchar_t> image(32768);
  DWORD length = static_cast<DWORD>(image.size());
  BOOL found = QueryFullProcessImageNameW(process, 0, image.data(), &length);
  CloseHandle(process);
  DWORD currentPid = 0;
  // 查询期间切换窗口或更换进程时拒绝不一致的快照。
  if (!found || !length || GetForegroundWindow() != window ||
      !GetWindowThreadProcessId(window, &currentPid) || currentPid != pid) return empty;
  std::wstring fullPath(image.data(), length);
  size_t separator = fullPath.find_last_of(L"\\/");
  std::wstring name = fullPath.substr(separator == std::wstring::npos ? 0 : separator + 1);
  if (name.empty()) return empty;
  napi_value result, program, processId;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_string_utf16(env, reinterpret_cast<const char16_t *>(name.data()), name.size(), &program) != napi_ok ||
      napi_create_uint32(env, pid, &processId) != napi_ok ||
      napi_set_named_property(env, result, "program", program) != napi_ok ||
      napi_set_named_property(env, result, "pid", processId) != napi_ok) return empty;
  return result;
}
static napi_value Init(napi_env env, napi_value exports) {
  napi_value read;
  if (napi_create_function(env, "read", NAPI_AUTO_LENGTH, ReadForeground, nullptr, &read) != napi_ok ||
      napi_set_named_property(env, exports, "read", read) != napi_ok) return nullptr;
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
