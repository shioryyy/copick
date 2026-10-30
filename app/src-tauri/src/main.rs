#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod diagnostics;
mod program_names;
mod startup;

use serde::Serialize;
use tauri::{menu::{Menu, MenuItem, PredefinedMenuItem}, tray::TrayIconBuilder};
use std::{ffi::{c_char, c_void, CStr, CString}, sync::{atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering}, mpsc, Arc, Mutex, OnceLock}, time::{Duration, Instant}};
use tauri::{Emitter, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

macro_rules! trace {
    ($($arg:tt)*) => {{
        let message = format!($($arg)*);
        eprintln!("{}", message);
        diagnostics::write(&message);
        if let Ok(path) = std::env::var("COPICK_PROTOTYPE_LOG") {
            use std::io::Write;
            if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(file, "{}", message);
            }
        }
    }};
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct InputEvent {
    kind: i32,
    x: f64,
    y: f64,
    gesture: i32,
    source_window: u64,
    source_pid: i32,
    clipboard_sequence: u64,
    cursor: u64,
}
#[repr(C)]
struct CaptureRequest {
    request_id: u64,
    x: f64,
    y: f64,
    fallback: i32,
    source_window: u64,
    source_pid: i32,
    clipboard_sequence: u64,
    mouse_down_cursor: u64,
    mouse_up_cursor: u64,
}
#[repr(C)]
struct NativeSelection {
    text: *const c_char,
    length: usize,
    pid: i32,
    window: u64,
    x: f64,
    y: f64,
    method: i32,
    /// 小写程序标识（Windows 可执行文件名或 macOS bundle id），NUL 结尾。
    program: *const c_char,
    /// 失败原因，对应 `Failure`。0 表示成功。
    failure: i32,
}
extern "C" {
    fn cp_permission(prompt: bool) -> bool;
    fn cp_front_pid() -> i32;
    fn cp_source_matches(pid: i32, window: u64) -> bool;
    fn cp_start(callback: extern "C" fn(InputEvent)) -> bool;
    fn cp_stop();
    fn cp_listening() -> bool;
    fn cp_arm(event: *const InputEvent);
    fn cp_capture_begin(request: *const CaptureRequest, callback: extern "C" fn(u64, *const NativeSelection)) -> bool;
    fn cp_copy_begin(request_id: u64, text: *const c_char, length: usize, pid: i32, window: u64,
        callback: extern "C" fn(u64, i32)) -> bool;
    fn cp_cancel(request_id: u64) -> i32;
    fn cp_configure_popup(window: *mut c_void);
    fn cp_hide_popup();
    fn cp_snapshot_popup(path: *const c_char) -> bool;
    fn cp_cursor_position(x: *mut f64, y: *mut f64) -> bool;
    #[cfg(target_os = "macos")]
    fn cp_snapshot_control(window: *mut c_void, path: *const c_char) -> bool;
    #[cfg(target_os = "macos")]
    fn cp_prepare_popup(request_id: u64, callback: extern "C" fn(u64, bool)) -> bool;
    fn cp_show_popup(window: *mut c_void, x: f64, y: f64) -> bool;
    fn cp_inside_popup(window: *mut c_void, x: f64, y: f64) -> bool;
    fn cp_open_settings();
    fn cp_set_excluded(names: *const *const c_char, count: usize);
}

static INPUT_EPOCH: AtomicU64 = AtomicU64::new(0);
static COMPLETION_OVERFLOW: AtomicBool = AtomicBool::new(false);
static INPUT: OnceLock<mpsc::SyncSender<QueuedInput>> = OnceLock::new();
static COMPLETIONS: OnceLock<mpsc::SyncSender<Completion>> = OnceLock::new();
static COMPLETION_QUEUE: OnceLock<Mutex<mpsc::Receiver<Completion>>> = OnceLock::new();
// 回执在 tick 内直接排空，而不是在派发 tick 之前收集：否则在“收集完成”到
// “tick 开始”之间到达的成功回执会错过本轮处理，被随后的超时判断丢弃。
fn drain_completions() -> Vec<Completion> {
    match COMPLETION_QUEUE.get() {
        Some(queue) => queue.lock().map(|queue| queue.try_iter().collect()).unwrap_or_default(),
        None => Vec::new(),
    }
}

struct QueuedInput { value: InputEvent, epoch: u64, received: Instant }
impl QueuedInput {
    fn is_current(&self, epoch: u64, now: Instant) -> bool {
        self.epoch == epoch && now.saturating_duration_since(self.received) < Duration::from_millis(500)
    }
}
extern "C" fn input(event: InputEvent) {
    if let Some(sender) = INPUT.get() {
        let queued = QueuedInput { value: event, epoch: INPUT_EPOCH.load(Ordering::Acquire), received: Instant::now() };
        if sender.try_send(queued).is_err() { INPUT_EPOCH.fetch_add(1, Ordering::AcqRel); }
    }
}

struct Captured { text: String, pid: i32, window: u64, x: f64, y: f64, method: i32, program: String }
/// 原生侧失败原因，与 `bridge_win.cc` 的 `FailureCode` 一一对应。
#[derive(Clone, Copy, PartialEq)]
enum Failure { None, NoText, NonText, Filtered }
impl Failure {
    fn from_code(code: i32) -> Failure {
        match code { 2 => Failure::NonText, 3 => Failure::Filtered, _ => Failure::NoText }
    }
}
/// 一次取词回执的全部内容：成功时带文字，失败时带程序名与原因。
struct CaptureReply { value: Option<Captured>, program: String, failure: Failure }
enum Completion {
    // arrived 是回执到达回调线程的时刻，不是主线程处理它的时刻。主线程
    // 可能因为别的工作晚到几十毫秒，不能把“已经收到的成功”当成超时丢弃。
    Capture { request_id: u64, reply: CaptureReply, arrived: Instant },
    Copy { request_id: u64, result: Result<bool, String>, arrived: Instant },
}

extern "C" fn capture_complete(request_id: u64, value: *const NativeSelection) {
    let reply = if value.is_null() {
        // macOS 失败时不回调结构：没有程序名可报，也就没有提示。
        CaptureReply { value: None, program: String::new(), failure: Failure::None }
    } else {
        unsafe {
            let value = &*value;
            // 程序标识只用于托盘文案与排除项，缺失时按空字符串处理；
            // 原生侧保证指针在本回调返回前有效。
            let program = if value.program.is_null() { String::new() }
                else { CStr::from_ptr(value.program).to_string_lossy().into_owned() };
            let text = if value.text.is_null() || value.length == 0 || value.length > 1024 * 1024 { None }
                else { std::str::from_utf8(std::slice::from_raw_parts(value.text.cast::<u8>(), value.length)).ok() };
            let captured = text.map(|text| Captured {
                text: text.to_owned(), pid: value.pid, window: value.window,
                x: value.x, y: value.y, method: value.method, program: program.clone(),
            });
            // 原生说成功却没有可用文字（编码失败或空选区）时按“没取到文字”处理。
            let failure = if captured.is_some() { Failure::None } else { Failure::from_code(value.failure) };
            CaptureReply { value: captured, program, failure }
        }
    };
    if let Some(sender) = COMPLETIONS.get() {
        if sender.try_send(Completion::Capture { request_id, reply, arrived: Instant::now() }).is_err() { COMPLETION_OVERFLOW.store(true, Ordering::Release); }
    }
}

extern "C" fn copy_complete(request_id: u64, status: i32) {
    let result = match status { 0 => Ok(false), 1 => Ok(true),
        _ => Err("复制提交未能完整确认；剪贴板可能已改变。".into()) };
    if let Some(sender) = COMPLETIONS.get() {
        if sender.try_send(Completion::Copy { request_id, result, arrived: Instant::now() }).is_err() { COMPLETION_OVERFLOW.store(true, Ordering::Release); }
    }
}

struct Selection {
    value: Captured,
    token: String,
    expires: Instant,
    presented: bool,
    copying: bool,
    copied: bool,
}
struct CaptureFlight { request_id: u64, generation: u64, deadline: Instant, source: InputEvent }
struct CopyFlight { request_id: u64, generation: u64, token: String, deadline: Instant, started: Instant, reply: mpsc::SyncSender<Result<bool, String>> }
// 只比较回执的到达时刻与截止时间：处理时刻可能晚于截止时间，但结果本身
// 在截止时间之前就已经产生，丢弃它会变成“写入成功却报告失败”。
fn completion_matches(id: u64, generation: u64, deadline: Instant, request_id: u64, current_generation: u64, arrived: Instant) -> bool {
    id == request_id && generation == current_generation && arrived < deadline
}
impl CaptureFlight {
    fn accepts(&self, request_id: u64, generation: u64, arrived: Instant) -> bool {
        completion_matches(self.request_id, self.generation, self.deadline, request_id, generation, arrived)
    }
}
impl CopyFlight {
    fn accepts(&self, request_id: u64, generation: u64, arrived: Instant) -> bool {
        completion_matches(self.request_id, self.generation, self.deadline, request_id, generation, arrived)
    }
}
#[derive(Default)]
struct State {
    permission: bool, running: bool, paused: bool, fallback: bool,
    selections: u64, presented: u64, copies: u64, serial: u64,
    focus_preserved: Option<bool>, current: Option<Selection>, pending: Option<(Instant, InputEvent)>,
    capture: Option<CaptureFlight>, copy: Option<CopyFlight>, armed: Option<InputEvent>, generation: u64, next_request: u64, input_epoch: u64,
    last_permission_check: Option<Instant>, error: Option<String>,
    tray_status: String,
    /// 最近一次成功取词的程序标识，供托盘「在此应用中停用」使用。
    last_program: String,
    /// 当前生效的用户排除列表，托盘据此判断该程序是否已停用。
    excluded: Vec<String>,
    /// 设置页有未保存草稿或正在保存时为 true，关闭窗口前需要确认。
    draft_dirty: bool,
    /// 最近一次取词失败。默认关闭的回退只有这样才不会被当成“软件坏了”。
    last_failure: Option<CaptureFailure>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureFailure {
    /// 程序显示名，与托盘一致；未知程序就是可执行文件名本身。
    program: String,
    /// `no_text`（无障碍没取到文字）、`non_text`（选中的不是文字）、
    /// `fallback_failed`（回退已开启仍未取到）。
    reason: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    permission: bool, running: bool, paused: bool, fallback: bool,
    selections: u64, presented: u64, copies: u64, focus_preserved: Option<bool>, error: Option<String>,
    last_failure: Option<CaptureFailure>,
}
#[derive(Serialize)]
struct PopupState { token: Option<String>, copying: bool, copied: bool }

fn popup(app: &tauri::AppHandle) -> WebviewWindow { app.get_webview_window("popup").expect("popup") }
fn native_window(window: &WebviewWindow) -> tauri::Result<*mut c_void> {
    #[cfg(target_os = "macos")]
    { window.ns_window() }
    #[cfg(target_os = "windows")]
    { window.hwnd().map(|handle| handle.0.cast()) }
}
fn hide(_app: &tauri::AppHandle, state: &mut State) {
    state.current = None;
    unsafe { cp_hide_popup(); }
}
// 每次失效都记下原因：取消本身只说明“被丢弃”，不说明为什么，
// 真机上排查时日志必须能指出触发条件。
fn cancel_requests(state: &mut State, reason: &str, mut cancel: impl FnMut(u64) -> i32) -> Vec<u64> {
    let mut cancelled = Vec::new();
    if let Some(flight) = state.capture.take() {
        cancel(flight.request_id);
        trace!("COPICK_CAPTURE_CANCEL request={} reason={}", flight.request_id, reason);
        cancelled.push(flight.request_id);
    }
    if let Some(flight) = state.copy.take() {
        let outcome = cancel(flight.request_id);
        trace!("COPICK_COPY_CANCEL request={} outcome={} reason={}", flight.request_id, outcome, reason);
        cancelled.push(flight.request_id);
        let reply = if outcome == 1 { Ok(false) } else {
            Err("复制已进入提交或完成，无法撤销；剪贴板可能已改变。".into())
        };
        let _ = flight.reply.try_send(reply);
    }
    state.generation = state.generation.wrapping_add(1);
    state.pending = None;
    state.armed = None;
    state.current = None;
    cancelled
}
fn invalidate(app: &tauri::AppHandle, state: &mut State, reason: &str) {
    cancel_requests(state, reason, |id| unsafe { cp_cancel(id) });
    hide(app, state);
}
fn snapshot(state: &State) -> Status {
    Status { permission: state.permission, running: state.running, paused: state.paused,
        fallback: state.fallback, selections: state.selections, presented: state.presented,
        copies: state.copies, focus_preserved: state.focus_preserved, error: state.error.clone(),
        last_failure: state.last_failure.clone() }
}
fn refresh(app: &tauri::AppHandle, state: &mut State) {
    state.permission = unsafe { cp_permission(false) };
    let should_run = state.permission && !state.paused;
    if !should_run {
        if state.running { INPUT_EPOCH.fetch_add(1, Ordering::AcqRel); }
        unsafe { cp_stop(); }
        invalidate(app, state, "not_running");
    } else if !unsafe { cp_listening() } {
        state.error = if unsafe { cp_start(input) } { None }
            else { Some("无法创建全局事件监听，请检查辅助功能权限后重新启动原型。".into()) };
    }
    state.running = should_run && unsafe { cp_listening() };
    state.last_permission_check = Some(Instant::now());
    update_tray(app, state);
}
fn source_matches(a: &InputEvent, b: &InputEvent) -> bool {
    a.source_pid > 0 && a.source_pid == b.source_pid && a.source_window == b.source_window
}
fn next_request(state: &mut State) -> u64 {
    state.next_request = state.next_request.wrapping_add(1).max(1);
    state.next_request
}
/// 与 Electron 版一致的丢弃阈值（DIP/物理像素由各平台自行保证）。
const MAX_CURSOR_DISTANCE: f64 = 100.0;
fn cursor_exceeded(origin: (f64, f64), cursor: (f64, f64)) -> bool {
    (origin.0 - cursor.0).hypot(origin.1 - cursor.1) > MAX_CURSOR_DISTANCE
}
/// 指针是否已离开取词起点超过阈值。读不到指针位置时不丢弃结果。
fn cursor_far_from(x: f64, y: f64) -> bool {
    let (mut cursor_x, mut cursor_y) = (0.0, 0.0);
    (unsafe { cp_cursor_position(&mut cursor_x, &mut cursor_y) }) && cursor_exceeded((x, y), (cursor_x, cursor_y))
}
/// 记录最近一次取词失败，供设置页提示。只保留程序名与固定枚举的原因，
/// 不记录窗口标题、路径或选中文字。
fn note_failure(state: &mut State, request_id: u64, reply: &CaptureReply) {
    let program = reply.program.trim().to_lowercase();
    // 取不到程序名，或被程序名过滤（终端、密码管理器、用户排除项）时不提示：
    // 过滤是用户自己的选择，报成故障会误导他去开回退。
    if program.is_empty() {
        trace!("COPICK_CAPTURE_EMPTY request={} reason=unknown program=unknown", request_id);
        return;
    }
    if reply.failure == Failure::Filtered {
        trace!("COPICK_CAPTURE_EMPTY request={} reason=filtered program={}",
            request_id, diagnostics::program_token(&program));
        return;
    }
    let reason = if reply.failure == Failure::NonText { "non_text" }
        else if state.fallback { "fallback_failed" } else { "no_text" };
    // 日志只写压缩后的程序 token；设置页展示的是与托盘一致的易读名称。
    trace!("COPICK_CAPTURE_EMPTY request={} reason={} program={}",
        request_id, reason, diagnostics::program_token(&program));
    state.last_failure = Some(CaptureFailure {
        program: program_names::display_name(&program).to_string(), reason });
}
fn accept_capture(app: &tauri::AppHandle, state: &mut State, request_id: u64, reply: CaptureReply, arrived: Instant) {
    let Some(flight) = state.capture.as_ref() else { return; };
    if !state.running || !flight.accepts(request_id, state.generation, arrived) { return; }
    if !unsafe { cp_source_matches(flight.source.source_pid, flight.source.source_window) } { invalidate(app, state, "capture_source_changed"); return; }
    let release_point = (flight.source.x, flight.source.y);
    state.capture = None;
    let Some(value) = reply.value else {
        note_failure(state, request_id, &reply);
        return;
    };
    // 来源已变或被选中的只是空白时不记为失败：前者不是这个应用的取词结果，
    // 后者提示用户“开启回退”也没有用。
    if !unsafe { cp_source_matches(value.pid, value.window) } || value.text.trim().is_empty() { return; }
    // 慢结果到达时指针可能已经离开选区；此时浮窗会弹在用户正在操作的位置。
    // 与 Electron 版一致以鼠标松开点为基准，而不是选区末行（向上拖选时两者相距很远）。
    if cursor_far_from(release_point.0, release_point.1) { invalidate(app, state, "cursor_moved"); return; }
    hide(app, state);
    state.serial = state.serial.wrapping_add(1);
    state.selections += 1;
    state.last_program = value.program.clone();
    state.last_failure = None;
    update_tray(app, state);
    let token = uuid::Uuid::new_v4().to_string();
    let script = format!("window.copickSelection({});", serde_json::to_string(&token).unwrap());
    state.current = Some(Selection { value, token, expires: Instant::now() + Duration::from_secs(7), presented: false, copying: false, copied: false });
    if popup(app).eval(script).is_err() { invalidate(app, state, "popup_eval_failed"); }
    trace!("COPICK_SELECTION_RECEIVED request={}", request_id);
}
fn finish_copy(app: &tauri::AppHandle, state: &mut State, request_id: u64, result: Result<bool, String>, arrived: Instant) {
    // 迟到或跨 generation 的回执必须被丢弃，但“丢弃”这件事本身要留痕：
    // 否则真机上只会看到一次取消，看不出写入其实已经发生。
    let Some(flight) = state.copy.as_ref() else {
        trace!("COPICK_COPY_LATE request={} reason=no_flight", request_id);
        return;
    };
    if !flight.accepts(request_id, state.generation, arrived) {
        trace!("COPICK_COPY_LATE request={} reason=generation_or_deadline", request_id);
        return;
    }
    let flight = state.copy.take().expect("matched copy");
    let Some(current) = state.current.as_mut() else {
        trace!("COPICK_COPY_LATE request={} reason=no_selection", request_id);
        let _ = flight.reply.try_send(Ok(false));
        return;
    };
    if current.token != flight.token {
        trace!("COPICK_COPY_LATE request={} reason=token_changed", request_id);
        let _ = flight.reply.try_send(Ok(false));
        return;
    }
    current.copying = false;
    let Ok(ok) = result else {
        current.value.text.clear();
        current.expires = Instant::now() + Duration::from_millis(650);
        let _ = flight.reply.try_send(result);
        return;
    };
    let _ = flight.reply.try_send(Ok(ok));
    current.copying = false;
    let elapsed = arrived.saturating_duration_since(flight.started).as_millis();
    if !ok { trace!("COPICK_COPY_FAIL request={} ms={}", request_id, elapsed); return; }
    current.value.text.clear();
    current.copied = true;
    current.expires = Instant::now() + Duration::from_millis(650);
    state.copies += 1;
    state.focus_preserved = Some(unsafe { cp_front_pid() } == current.value.pid);
    trace!("COPICK_COPY_OK request={} focus_preserved={} ms={}", request_id, state.focus_preserved.unwrap_or(false), elapsed);
    let _ = app;
}
fn tick(app: &tauri::AppHandle, queued: Option<QueuedInput>) {
    let managed = app.state::<Mutex<State>>();
    let mut state = managed.lock().unwrap();
    if state.last_permission_check.is_none_or(|time| time.elapsed() >= Duration::from_secs(2)) {
        refresh(app, &mut state);
    }
    let epoch = INPUT_EPOCH.load(Ordering::Acquire);
    let discontinuity = state.input_epoch != epoch || queued.as_ref().is_some_and(|input| !input.is_current(epoch, Instant::now()));
    state.input_epoch = epoch;
    if discontinuity || COMPLETION_OVERFLOW.swap(false, Ordering::AcqRel) {
        invalidate(app, &mut state, if discontinuity { "input_discontinuity" } else { "completion_overflow" });
        return;
    }
    if !state.running {
        // 暂停时也要排空，否则旧回执会占满有界通道并触发一次误报的溢出取消。
        let _ = drain_completions();
        return;
    }
    let event = queued.map(|input| input.value);
    // 已到达的完成回执必须先于超时判断处理。否则一次已经成功的写入会因为
    // 主线程刚好在截止时间之后才轮到它，被当成“超时”丢弃并报告失败。
    for completion in drain_completions() {
        match completion {
            Completion::Capture { request_id, reply, arrived } => accept_capture(app, &mut state, request_id, reply, arrived),
            Completion::Copy { request_id, result, arrived } => finish_copy(app, &mut state, request_id, result, arrived),
        }
    }
    if state.copy.as_ref().is_some_and(|flight| Instant::now() >= flight.deadline) {
        if let Some(flight) = state.copy.as_ref() {
            trace!("COPICK_COPY_TIMEOUT request={} ms={}", flight.request_id, flight.started.elapsed().as_millis());
        }
        invalidate(app, &mut state, "copy_timeout");
        state.error = Some("复制超时，已丢弃请求；若原生服务持续无响应，请重新启动原型。".into());
    }
    if let Some(current) = &state.current {
        if Instant::now() >= current.expires {
            invalidate(app, &mut state, "selection_expired");
        } else if !current.copied && !unsafe { cp_source_matches(current.value.pid, current.value.window) } {
            invalidate(app, &mut state, "selection_source_changed");
        }
    }
    if let Some(flight) = &state.capture {
        if !unsafe { cp_source_matches(flight.source.source_pid, flight.source.source_window) } {
            invalidate(app, &mut state, "capture_source_changed");
        }
    }
    if let Some(flight) = &state.capture {
        if Instant::now() >= flight.deadline {
            let id = flight.request_id;
            trace!("COPICK_CAPTURE_TIMEOUT request={}", id);
            invalidate(app, &mut state, "capture_timeout");
            state.error = Some("取词请求超时，已丢弃迟到结果。".into());
        }
    }
    if let Some(event) = event {
        #[cfg(target_os = "windows")]
        if event.kind == 1 || event.kind == 2 { trace!("COPICK_INPUT kind={} gesture={}", event.kind, event.gesture); }
        let inside = native_window(&popup(app)).ok().is_some_and(|window| unsafe { cp_inside_popup(window, event.x, event.y) });
        match event.kind {
            1 if !inside => {
                invalidate(app, &mut state, "mouse_down");
                state.armed = Some(event);
                unsafe { cp_arm(&event); }
            },
            2 if !inside && event.gesture != 0 => {
                if state.capture.is_none() && state.pending.is_none() &&
                    state.armed.as_ref().is_some_and(|down| source_matches(down, &event)) {
                    state.pending = Some((Instant::now() + Duration::from_millis(80), event));
                }
            },
            3 => invalidate(app, &mut state, "input_cancelled"),
            _ => {},
        }
    }
    if let Some((deadline, event)) = state.pending {
        if Instant::now() >= deadline && state.capture.is_none() {
            state.pending = None;
            let request_id = next_request(&mut state);
            let request = CaptureRequest {
                request_id, x: event.x, y: event.y, fallback: i32::from(state.fallback),
                source_window: event.source_window, source_pid: event.source_pid,
                clipboard_sequence: state.armed.map_or(0, |down| down.clipboard_sequence),
                mouse_down_cursor: state.armed.map_or(0, |down| down.cursor), mouse_up_cursor: event.cursor,
            };
            let accepted = unsafe { cp_capture_begin(&request, capture_complete) };
            if accepted {
                state.error = None;
                state.capture = Some(CaptureFlight { request_id, generation: state.generation,
                    deadline: Instant::now() + Duration::from_secs(2), source: event });
            } else {
                trace!("COPICK_CAPTURE_REJECT request={}", request_id);
                state.error = Some("原生取词请求未被接受：来源已变化或服务仍忙；持续无响应时请重启原型。".into());
            }
        }
    }
}

#[derive(Default)]
struct MainDispatch(AtomicU8);
impl MainDispatch {
    fn start(&self, deadline: Instant) -> bool {
        Instant::now() < deadline && self.0.compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire).is_ok()
    }
    fn cancel(&self) -> bool { self.0.compare_exchange(0, 2, Ordering::AcqRel, Ordering::Acquire).is_ok() }
}
async fn on_main<T: Send + 'static>(app: tauri::AppHandle, action: impl FnOnce(&tauri::AppHandle, &mut State) -> T + Send + 'static) -> Result<T, String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let handle = app.clone();
    let gate = Arc::new(MainDispatch::default());
    let queued = gate.clone();
    let deadline = Instant::now() + Duration::from_secs(5);
    app.run_on_main_thread(move || {
        if !queued.start(deadline) { return; }
        let state = handle.state::<Mutex<State>>();
        let result = action(&handle, &mut state.lock().unwrap());
        let _ = sender.send(result);
    }).map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| if gate.cancel() { "主线程调度超时，未执行操作。".to_owned() }
            else { "操作已开始但未能确认结果；剪贴板可能已改变。".to_owned() }))
        .await.map_err(|error| error.to_string())?
}
fn allowed_source(actual_label: &str, label: &str, url: &tauri::Url) -> bool {
    let expected = if label == "popup" { "/popup.html" } else { "/index.html" };
    let local = url.host_str() == Some("localhost") && url.scheme() == "tauri" ||
        ((url.scheme() == "http" || url.scheme() == "https") && url.host_str() == Some("tauri.localhost"));
    actual_label == label && local && (url.path() == expected ||
        (label == "control" && (url.path().is_empty() || url.path() == "/")))
}
fn require(window: &WebviewWindow, label: &str) -> Result<(), String> {
    let url = window.url().map_err(|_| "无法验证窗口来源".to_owned())?;
    if allowed_source(window.label(), label, &url) { Ok(()) }
    else {
        Err("不允许的窗口调用".into())
    }
}
fn apply_config(state: &mut State, config: &config::Config) {
    let names: Vec<_> = config.excluded_apps.iter().filter_map(|name| CString::new(name.as_str()).ok()).collect();
    let pointers: Vec<_> = names.iter().map(|name| name.as_ptr()).collect();
    unsafe { cp_set_excluded(pointers.as_ptr(), pointers.len()); }
    diagnostics::set_enabled(config.diagnostics_enabled);
    // 托盘菜单需要判断最近应用是否已被排除；配置每次保存都整体替换。
    state.excluded = config.excluded_apps.clone();
}

fn set_paused(app: &tauri::AppHandle, state: &mut State, paused: bool) -> Result<(), String> {
    let store = app.state::<Mutex<config::Store>>();
    let mut store = store.lock().unwrap();
    if store.error.is_some() { return Err("请先在设置中检查并保存配置。".into()); }
    let mut config = store.config.clone();
    config.paused = paused;
    store.save(config)?;
    INPUT_EPOCH.fetch_add(1, Ordering::AcqRel);
    state.paused = paused;
    invalidate(app, state, "configure");
    refresh(app, state);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    config: config::Config,
    /// 仅 Windows 的引擎支持可取消的剪贴板回退；设置页据此禁用开关并说明原因。
    fallback_available: bool,
    startup_enabled: bool,
    startup_available: bool,
    startup_error: Option<String>,
    startup_note: &'static str,
    config_error: Option<String>,
    version: String,
}
fn settings_snapshot(app: &tauri::AppHandle) -> Settings {
    let store = app.state::<Mutex<config::Store>>();
    let (config, config_error) = {
        let store = store.lock().unwrap();
        (store.config.clone(), store.error.clone())
    };
    let startup = startup::enabled();
    Settings {
        config, fallback_available: cfg!(target_os = "windows"),
        startup_enabled: startup.as_ref().copied().unwrap_or(false),
        startup_available: startup::available(), startup_error: startup.err(), startup_note: startup::note(),
        config_error,
        version: app.package_info().version.to_string(),
    }
}
#[tauri::command]
async fn settings(app: tauri::AppHandle, window: WebviewWindow) -> Result<Settings, String> {
    require(&window, "control")?;
    tauri::async_runtime::spawn_blocking(move || settings_snapshot(&app))
        .await.map_err(|error| error.to_string())
}
#[tauri::command]
async fn save_settings(app: tauri::AppHandle, window: WebviewWindow, config: config::Config) -> Result<Settings, String> {
    require(&window, "control")?;
    on_main(app.clone(), move |app, state| {
        let store = app.state::<Mutex<config::Store>>();
        let mut store = store.lock().unwrap();
        let config = config::Config { paused: state.paused, ..config }.validate()?;
        store.save(config.clone())?;
        drop(store);
        state.fallback = config.clipboard_fallback;
        apply_config(state, &config);
        invalidate(app, state, "settings_changed");
        Ok::<_, String>(())
    }).await??;
    tauri::async_runtime::spawn_blocking(move || settings_snapshot(&app))
        .await.map_err(|error| error.to_string())
}
#[tauri::command]
async fn set_startup(app: tauri::AppHandle, window: WebviewWindow, enabled: bool) -> Result<Settings, String> {
    require(&window, "control")?;
    tauri::async_runtime::spawn_blocking(move || {
        startup::set_enabled(enabled)?;
        Ok(settings_snapshot(&app))
    }).await.map_err(|error| error.to_string())?
}
#[tauri::command]
fn open_logs(window: WebviewWindow) -> Result<(), String> {
    require(&window, "control")?;
    let path = diagnostics::path().and_then(|path| path.parent().map(std::path::Path::to_path_buf))
        .ok_or("日志目录尚未初始化。")?;
    std::fs::create_dir_all(&path).map_err(|_| "无法创建日志目录。")?;
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("/usr/bin/open").arg(&path).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer.exe").arg(&path).spawn();
    result.map(|_| ()).map_err(|_| "无法打开日志目录。".into())
}
/// 退出前先让设置页处理未保存草稿；托盘与设置页共用这一入口。
fn request_quit(app: &tauri::AppHandle) {
    let dirty = app.state::<Mutex<State>>().lock().unwrap().draft_dirty;
    if dirty {
        show_settings(app);
        let _ = app.emit_to("control", "close-blocked", ());
    } else {
        app.exit(0);
    }
}
#[tauri::command]
fn quit(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    require(&window, "control")?;
    request_quit(&app);
    Ok(())
}
/// 设置页把“有未保存草稿或正在保存”同步给主进程，关闭窗口与退出时据此确认。
#[tauri::command]
fn set_draft_dirty(app: tauri::AppHandle, window: WebviewWindow, dirty: bool) -> Result<(), String> {
    require(&window, "control")?;
    app.state::<Mutex<State>>().lock().unwrap().draft_dirty = dirty;
    Ok(())
}
/// 用户确认放弃未保存草稿：清除标记并关闭（隐藏）设置窗口。
#[tauri::command]
fn close_settings(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    require(&window, "control")?;
    app.state::<Mutex<State>>().lock().unwrap().draft_dirty = false;
    window.hide().map_err(|error| error.to_string())
}
/// 屏幕可用逻辑尺寸小于窗口时返回收缩后的尺寸，留出十分之一余量。
fn fitted_inner_size(width: f64, height: f64, monitor_width: f64, monitor_height: f64) -> Option<(f64, f64)> {
    let (max_width, max_height) = (monitor_width * 0.9, monitor_height * 0.9);
    if width <= max_width && height <= max_height { return None; }
    Some((width.min(max_width), height.min(max_height)))
}
/// 高 DPI 或小屏幕上收缩设置窗口，避免底部保存/退出按钮落到屏幕外。
fn fit_control_window(window: &WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else { return; };
    let scale = monitor.scale_factor();
    let Ok(inner) = window.inner_size() else { return; };
    let Some((width, height)) = fitted_inner_size(
        inner.width as f64 / scale, inner.height as f64 / scale,
        monitor.size().width as f64 / scale, monitor.size().height as f64 / scale,
    ) else { return; };
    let _ = window.set_size(LogicalSize::new(width, height));
    let _ = window.center();
}
fn show_settings(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window("control") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        #[cfg(target_os = "macos")]
        if let Some(path) = std::env::var_os("COPICK_SETTINGS_SNAPSHOT") {
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(2));
                let handle = window.app_handle().clone();
                let _ = handle.run_on_main_thread(move || {
                    if let (Ok(pointer), Ok(path)) = (native_window(&window), CString::new(path.to_string_lossy().as_bytes())) {
                        unsafe { cp_snapshot_control(pointer, path.as_ptr()); }
                    }
                });
            });
        }
    }
}
struct TrayItems { status: MenuItem<tauri::Wry>, pause: MenuItem<tauri::Wry>, disable: MenuItem<tauri::Wry> }
fn tray_labels(state: &State) -> (&'static str, &'static str) {
    let text = if !state.permission { "需要辅助功能权限" } else if state.paused { "已暂停" }
        else if state.error.is_some() { "监听异常，请打开设置" } else if state.running { "正在监听" } else { "正在启动" };
    (text, if state.paused { "恢复监听" } else { "暂停监听" })
}
/// 托盘「在此应用中停用」的文案与可用状态。
///
/// 受保护的终端/凭据程序由引擎在取词前拦截，因此这里只需判断用户排除列表；
/// 程序名按引擎相同的子串规则匹配，未取过词时保持禁用。
fn exclusion_label(state: &State) -> (String, bool) {
    if state.last_program.is_empty() { return ("在最近取词应用中停用".into(), false); }
    let program = state.last_program.to_lowercase();
    let excluded = state.excluded.iter().any(|entry| program.contains(entry));
    // Windows 菜单把 & 当作助记符，显示名称里的 & 需要转义。
    let display = program_names::display_name(&state.last_program).replace('&', "&&");
    (format!("在此应用中停用：{display}"), !excluded)
}
fn update_tray(app: &tauri::AppHandle, state: &mut State) {
    let (text, pause_text) = tray_labels(state);
    let (exclude_text, exclude_enabled) = exclusion_label(state);
    // 缓存必须同时包含全部标签与可用状态：缺少权限时状态文字与暂停状态无关，
    // 只比较状态文字会让暂停/恢复项停留在旧文案。
    let cache = format!("{text}\n{pause_text}\n{exclude_text}\n{exclude_enabled}");
    if state.tray_status == cache { return; }
    state.tray_status = cache;
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.status.set_text(format!("Copick · {text}"));
        let _ = items.pause.set_text(pause_text);
        let _ = items.disable.set_text(&exclude_text);
        let _ = items.disable.set_enabled(exclude_enabled);
    }
    if let Some(tray) = app.tray_by_id("copick") { let _ = tray.set_tooltip(Some(format!("Copick · {text}"))); }
}
/// 把最近取词的程序追加到用户排除列表。
///
/// 与设置页保存共用 `Store::save` 的校验与持久化路径；保存成功后立即刷新引擎
/// 过滤列表和托盘文案，保存失败则只记录错误，不改变当前配置。
fn exclude_last_program(app: &tauri::AppHandle, state: &mut State) {
    let program = state.last_program.trim().to_lowercase();
    if program.is_empty() { return; }
    let store = app.state::<Mutex<config::Store>>();
    let mut store = store.lock().unwrap();
    let mut next = store.config.clone();
    next.excluded_apps.push(program);
    match store.save(next) {
        Ok(()) => {
            let saved = store.config.clone();
            drop(store);
            apply_config(state, &saved);
            invalidate(app, state, "settings_changed");
            // 设置页可能正打开着：让它重新读取配置，未保存的草稿保持不动。
            let _ = app.emit_to("control", "settings-changed", ());
        }
        Err(error) => state.error = Some(format!("无法保存排除列表：{error}")),
    }
    update_tray(app, state);
}
fn create_tray(app: &tauri::App) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "tray_status", "Copick · 正在启动", false, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "暂停监听", true, None::<&str>)?;
    let disable = MenuItem::with_id(app, "disable_app", "在最近取词应用中停用", false, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Copick", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&status, &pause, &disable, &separator, &settings, &quit])?;
    #[cfg(target_os = "macos")]
    let icon = tauri::image::Image::from_bytes(include_bytes!("../assets/trayTemplate.png"))?;
    #[cfg(target_os = "windows")]
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?;
    TrayIconBuilder::with_id("copick").icon(icon).icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Copick").menu(&menu).on_menu_event(|app, event| {
            match event.id.as_ref() {
                "settings" => show_settings(app),
                "pause" => {
                    let managed = app.state::<Mutex<State>>();
                    let mut state = managed.lock().unwrap();
                    let paused = !state.paused;
                    if let Err(error) = set_paused(app, &mut state, paused) { state.error = Some(error); show_settings(app); }
                },
                "disable_app" => {
                    let managed = app.state::<Mutex<State>>();
                    let mut state = managed.lock().unwrap();
                    exclude_last_program(app, &mut state);
                },
                "quit" => request_quit(app),
                _ => {},
            }
        }).build(app)?;
    app.manage(TrayItems { status, pause, disable });
    Ok(())
}

#[tauri::command]
async fn status(app: tauri::AppHandle, window: WebviewWindow) -> Result<Status, String> {
    require(&window, "control")?;
    on_main(app, |_, state| snapshot(state)).await
}
#[tauri::command]
async fn configure(app: tauri::AppHandle, window: WebviewWindow, paused: bool) -> Result<Status, String> {
    require(&window, "control")?;
    on_main(app, move |app, state| {
        set_paused(app, state, paused)?;
        Ok(snapshot(state))
    }).await?
}
#[tauri::command]
async fn permission(app: tauri::AppHandle, window: WebviewWindow) -> Result<Status, String> {
    require(&window, "control")?;
    on_main(app, |app, state| {
        if !unsafe { cp_permission(true) } { unsafe { cp_open_settings(); } }
        refresh(app, state); snapshot(state)
    }).await
}
#[tauri::command]
async fn popup_state(app: tauri::AppHandle, window: WebviewWindow) -> Result<PopupState, String> {
    require(&window, "popup")?;
    on_main(app, |_, state| PopupState {
        token: state.current.as_ref().map(|current| current.token.clone()),
        copying: state.current.as_ref().is_some_and(|current| current.copying),
        copied: state.current.as_ref().is_some_and(|current| current.copied),
    }).await
}
#[cfg(target_os = "macos")]
static PREPARING_POPUP: Mutex<Option<(u64, mpsc::SyncSender<bool>)>> = Mutex::new(None);
#[cfg(target_os = "macos")]
extern "C" fn popup_prepared(id: u64, ready: bool) {
    let mut pending = PREPARING_POPUP.lock().unwrap();
    if pending.as_ref().is_some_and(|(request, _)| *request == id) {
        if let Some((_, reply)) = pending.take() { let _ = reply.try_send(ready); }
    }
}
#[tauri::command]
async fn present(app: tauri::AppHandle, window: WebviewWindow, token: String) -> Result<bool, String> {
    require(&window, "popup")?;
    #[cfg(target_os = "macos")]
    let preparation = {
        let attempted = token.clone();
        let pending = on_main(app.clone(), move |app, state| {
            let current = state.current.as_ref()?;
            if !state.running || current.token != attempted || current.presented || Instant::now() >= current.expires ||
                !unsafe { cp_permission(false) && cp_source_matches(current.value.pid, current.value.window) } { return None; }
            let mut slot = PREPARING_POPUP.lock().unwrap();
            if slot.is_some() { return None; }
            let id = next_request(state);
            let (reply, receiver) = mpsc::sync_channel(1);
            *slot = Some((id, reply));
            drop(slot);
            if !unsafe { cp_prepare_popup(id, popup_prepared) } { PREPARING_POPUP.lock().unwrap().take(); return None; }
            trace!("COPICK_POPUP_PREPARING request={}", id);
            let _ = app;
            Some((state.generation, Instant::now() + Duration::from_secs(2), receiver))
        }).await?;
        let Some((generation, deadline, receiver)) = pending else { return Ok(false); };
        let ready = tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())).unwrap_or(false))
            .await.map_err(|error| error.to_string())?;
        if !ready || Instant::now() >= deadline {
            let attempted = token.clone();
            return on_main(app, move |app, state| {
                if state.generation == generation && state.current.as_ref().is_some_and(|current| current.token == attempted) {
                    invalidate(app, state, "popup_prepare_failed");
                    state.error = Some("浮窗绘制准备失败或超时；持续无响应时请重新启动原型。".into());
                }
                false
            }).await;
        }
        (generation, deadline)
    };
    on_main(app, move |app, state| {
        #[cfg(target_os = "macos")]
        if state.generation != preparation.0 || Instant::now() >= preparation.1 { return false; }
        if !state.running || !unsafe { cp_permission(false) } { invalidate(app, state, "present_not_running"); return false; }
        let Some(current) = state.current.as_ref() else { return false; };
        if current.token != token || current.presented || Instant::now() >= current.expires { return false; }
        if !unsafe { cp_source_matches(current.value.pid, current.value.window) } { invalidate(app, state, "present_source_changed"); return false; }
        let x = current.value.x;
        let y = current.value.y;
        let Ok(window) = native_window(&popup(app)) else { return false; };
        let shown = unsafe { cp_show_popup(window, x, y) };
        let preserved = unsafe { cp_front_pid() } == current.value.pid;
        state.focus_preserved = Some(preserved);
        if !shown || !preserved { invalidate(app, state, if shown { "present_focus_lost" } else { "present_not_shown" }); return false; }
        let current = state.current.as_mut().expect("selection still present");
        current.presented = true;
        state.presented += 1;
        trace!("COPICK_POPUP_PRESENTED focus_preserved=true method={}", current.value.method);
        if let Ok(path) = std::env::var("COPICK_POPUP_SNAPSHOT") {
            if let Ok(path) = CString::new(path) { unsafe { cp_snapshot_popup(path.as_ptr()); } }
        }
        true
    }).await
}
#[tauri::command]
async fn copy_selection(app: tauri::AppHandle, window: WebviewWindow, token: String) -> Result<bool, String> {
    require(&window, "popup")?;
    let (reply, receiver) = mpsc::sync_channel(1);
    let accepted = match on_main(app, move |app, state| {
        trace!("COPICK_COPY_REQUEST");
        if !state.running { return false; }
        let Some(current) = state.current.as_ref() else { trace!("COPICK_COPY_REJECT no_selection"); return false; };
        if current.token != token || !current.presented || current.copying || current.copied || Instant::now() >= current.expires {
            trace!("COPICK_COPY_REJECT invalid_token"); return false;
        }
        if !unsafe { cp_source_matches(current.value.pid, current.value.window) } { trace!("COPICK_COPY_REJECT focus_changed"); state.focus_preserved = Some(false); invalidate(app, state, "copy_source_changed"); return false; }
        let text = current.value.text.clone();
        let pid = current.value.pid;
        let source_window = current.value.window;
        let request_id = next_request(state);
        let accepted = unsafe { cp_copy_begin(request_id, text.as_ptr().cast(), text.len(), pid, source_window, copy_complete) };
        if !accepted { trace!("COPICK_COPY_REJECT native_busy"); return false; }
        trace!("COPICK_COPY_BEGIN request={}", request_id);
        if let Some(current) = state.current.as_mut() { current.copying = true; }
        state.copy = Some(CopyFlight { request_id, generation: state.generation, token, started: Instant::now(),
            deadline: Instant::now() + Duration::from_secs(2), reply });
        true
    }).await { Ok(value) => value, Err(error) => return Err(error) };
    if !accepted { return Ok(false); }
    tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(3))
        .unwrap_or_else(|_| Err("无法确认复制结果；剪贴板可能已改变。".into())))
        .await.map_err(|error| error.to_string())?
}

fn main() {
    if std::env::args().any(|arg| arg == "--smoke-test") {
        let permission = unsafe { cp_permission(false) };
        println!("{}", serde_json::json!({"ok":true,"permission":permission,"frontPid":unsafe { cp_front_pid() }}));
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if !args.iter().any(|arg| arg == "--background") {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || show_settings(&handle));
            }
        }))
        .manage(Mutex::new(State::default()))
        .invoke_handler(tauri::generate_handler![status, configure, permission, settings, save_settings, set_startup, open_logs, quit, set_draft_dirty, close_settings, popup_state, present, copy_selection])
        .setup(|app| {
            let directory = app.path().app_config_dir()?;
            let store = config::Store::load(directory.join("config.json"));
            diagnostics::init(directory.join("logs/selection.log"));
            {
                let managed = app.state::<Mutex<State>>();
                let mut state = managed.lock().unwrap();
                state.paused = store.config.paused;
                state.fallback = store.config.clipboard_fallback;
                apply_config(&mut state, &store.config);
            }
            let needs_settings = store.error.is_some() || !unsafe { cp_permission(false) };
            app.manage(Mutex::new(store));
            create_tray(app)?;
            let window = WebviewWindowBuilder::new(app, "popup", WebviewUrl::App("popup.html".into()))
                .title("复制").inner_size(88.0, 40.0).decorations(false).resizable(false)
                .visible(false).focused(false).focusable(false).transparent(true)
                .shadow(false).always_on_top(true).skip_taskbar(true).accept_first_mouse(true)
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
                .build()?;
            unsafe { cp_configure_popup(native_window(&window)?); }
            if let Some(control) = app.get_webview_window("control") { fit_control_window(&control); }
            if needs_settings || !std::env::args().any(|arg| arg == "--background") {
                show_settings(app.handle());
            } else {
                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            let (sender, receiver) = mpsc::sync_channel(256);
            let (completion_sender, completion_receiver) = mpsc::sync_channel(256);
            INPUT.set(sender).map_err(|_| "事件通道已初始化")?;
            COMPLETIONS.set(completion_sender).map_err(|_| "完成通道已初始化")?;
            COMPLETION_QUEUE.set(Mutex::new(completion_receiver)).map_err(|_| "完成通道已初始化")?;
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                let event = match receiver.recv_timeout(Duration::from_millis(50)) {
                    Ok(event) => Some(event),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(_) => break,
                };
                let main_handle = handle.clone();
                let (done, completion) = mpsc::sync_channel(1);
                if handle.run_on_main_thread(move || { tick(&main_handle, event); let _ = done.send(()); }).is_err() { break; }
                if completion.recv().is_err() { break; }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "control" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    // 有未保存草稿时不能静默隐藏：设置页会显示确认条，
                    // 用户选择放弃后才调用 close_settings。
                    let dirty = window.app_handle().state::<Mutex<State>>().lock().unwrap().draft_dirty;
                    if dirty {
                        let _ = window.app_handle().emit_to("control", "close-blocked", ());
                    } else {
                        let _ = window.hide();
                        #[cfg(target_os = "macos")]
                        let _ = window.app_handle().set_activation_policy(tauri::ActivationPolicy::Accessory);
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("无法构建 Tauri 原型")
        .run(|_, event| { if matches!(event, tauri::RunEvent::Exit) { unsafe { cp_stop(); } } });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_labels_change_with_pause_even_when_permission_is_missing() {
        let paused = State { paused: true, ..State::default() };
        assert_eq!(tray_labels(&paused), ("需要辅助功能权限", "恢复监听"));
        let running = State { permission: true, running: true, ..State::default() };
        assert_eq!(tray_labels(&running), ("正在监听", "暂停监听"));
        let stopped = State { permission: true, error: Some("x".into()), ..State::default() };
        assert_eq!(tray_labels(&stopped).0, "监听异常，请打开设置");
    }

    #[test]
    fn capture_failure_records_program_and_reason_but_ignores_filtering() {
        let mut state = State::default();
        let reply = |failure, program: &str| CaptureReply { value: None, program: program.into(), failure };
        let recorded = |state: &State| state.last_failure.as_ref().map(|failure| (failure.program.clone(), failure.reason));
        note_failure(&mut state, 1, &reply(Failure::NoText, "Excel.EXE"));
        assert_eq!(recorded(&state), Some(("Excel".into(), "no_text")));
        // 回退已开启仍然取不到时，原因要指向“回退也失败了”，不能继续劝用户去开回退。
        state.fallback = true;
        note_failure(&mut state, 2, &reply(Failure::NoText, "excel.exe"));
        assert_eq!(recorded(&state), Some(("Excel".into(), "fallback_failed")));
        note_failure(&mut state, 3, &reply(Failure::NonText, "winword.exe"));
        assert_eq!(recorded(&state), Some(("Word".into(), "non_text")));
        // 程序名过滤（终端、密码管理器、用户排除项）和取不到程序名都不算故障，
        // 也不覆盖已经记下的提示。
        note_failure(&mut state, 4, &reply(Failure::Filtered, "cmd.exe"));
        note_failure(&mut state, 5, &reply(Failure::NoText, ""));
        assert_eq!(recorded(&state), Some(("Word".into(), "non_text")));
    }

    #[test]
    fn tray_exclusion_item_tracks_last_program_and_existing_entries() {
        assert_eq!(exclusion_label(&State::default()), ("在最近取词应用中停用".into(), false));
        let ready = State { last_program: "chrome.exe".into(), ..State::default() };
        assert_eq!(exclusion_label(&ready), ("在此应用中停用：Chrome".into(), true));
        // 与引擎一致：用户条目按子串匹配，命中后菜单项禁用。
        let listed = State { last_program: "chrome.exe".into(), excluded: vec!["chrome".into()], ..State::default() };
        assert_eq!(exclusion_label(&listed), ("在此应用中停用：Chrome".into(), false));
        // 未收录的名称原样显示，Windows 助记符 & 必须转义。
        let unknown = State { last_program: "a&b.exe".into(), ..State::default() };
        assert_eq!(exclusion_label(&unknown), ("在此应用中停用：a&&b.exe".into(), true));
    }

    #[test]
    fn cursor_distance_threshold_matches_electron() {
        assert!(!cursor_exceeded((0.0, 0.0), (100.0, 0.0)));
        assert!(cursor_exceeded((0.0, 0.0), (100.1, 0.0)));
        assert!(!cursor_exceeded((0.0, 0.0), (60.0, 60.0)));
        assert!(cursor_exceeded((0.0, 0.0), (80.0, 80.0)));
    }

    #[test]
    fn command_source_accepts_tauri_homepage_and_rejects_other_pages() {
        for value in ["tauri://localhost", "tauri://localhost/", "tauri://localhost/index.html",
            "http://tauri.localhost/", "https://tauri.localhost/index.html"] {
            let url = tauri::Url::parse(value).unwrap();
            assert!(allowed_source("control", "control", &url), "{value}");
            assert!(!allowed_source("popup", "control", &url));
            assert!(!allowed_source("control", "popup", &url));
        }
        assert!(allowed_source("popup", "popup", &tauri::Url::parse("tauri://localhost/popup.html").unwrap()));
        for value in ["tauri://localhost/other.html", "https://example.com/index.html", "http://localhost/index.html"] {
            assert!(!allowed_source("control", "control", &tauri::Url::parse(value).unwrap()));
        }
    }

    fn source(pid: i32, window: u64) -> InputEvent {
        InputEvent { source_pid: pid, source_window: window, ..InputEvent::default() }
    }
    #[test]
    fn source_requires_pid_and_exact_window() {
        assert!(source_matches(&source(10, 20), &source(10, 20)));
        assert!(!source_matches(&source(10, 20), &source(10, 21)));
        assert!(!source_matches(&source(10, 20), &source(11, 20)));
        assert!(!source_matches(&source(0, 0), &source(0, 0)));
        assert!(!source_matches(&source(10, 20), &source(10, 0)));
        assert!(source_matches(&source(10, 0), &source(10, 0)));
    }
    #[test]
    fn overflow_or_pause_epoch_rejects_old_events() {
        let now = Instant::now();
        let queued = QueuedInput { value: source(10, 20), epoch: 1, received: now };
        assert!(queued.is_current(1, now));
        assert!(!queued.is_current(2, now));
        assert!(!queued.is_current(1, now + Duration::from_millis(500)));
    }
    #[test]
    fn late_capture_does_not_match_new_generation_or_request() {
        let now = Instant::now();
        let flight = CaptureFlight { request_id: 2, generation: 3, deadline: now + Duration::from_secs(2), source: source(10, 20) };
        assert!(flight.accepts(2, 3, now));
        assert!(!flight.accepts(1, 3, now));
        assert!(!flight.accepts(2, 4, now));
        assert!(!flight.accepts(2, 3, flight.deadline));
    }
    #[test]
    fn cancellation_releases_copy_waiter_and_invalidates_all_state() {
        let now = Instant::now();
        let (reply, receiver) = mpsc::sync_channel(1);
        let mut state = State { generation: 4, armed: Some(source(10, 20)),
            pending: Some((now, source(10, 20))),
            capture: Some(CaptureFlight { request_id: 8, generation: 4, deadline: now + Duration::from_secs(2), source: source(10, 20) }),
            copy: Some(CopyFlight { request_id: 9, generation: 4, token: "old".into(), started: now, deadline: now + Duration::from_secs(2), reply }),
            ..State::default() };
        assert_eq!(cancel_requests(&mut state, "test", |_| 1), vec![8, 9]);
        assert!(!receiver.try_recv().unwrap().unwrap());
        assert_eq!(state.generation, 5);
        assert!(state.capture.is_none() && state.copy.is_none() && state.pending.is_none() && state.armed.is_none());
        assert!(cancel_requests(&mut state, "test", |_| 1).is_empty());
    }
    #[test]
    fn timed_out_main_dispatch_cannot_execute_late() {
        let cancelled = MainDispatch::default();
        assert!(cancelled.cancel());
        assert!(!cancelled.start(Instant::now() + Duration::from_secs(1)));
        let expired = MainDispatch::default();
        assert!(!expired.start(Instant::now()));
        let running = MainDispatch::default();
        assert!(running.start(Instant::now() + Duration::from_secs(1)));
        assert!(!running.cancel());
        assert!(!running.start(Instant::now() + Duration::from_secs(1)));
    }
    #[test]
    fn cancellation_after_commit_reports_uncertain_result() {
        for outcome in [0, 2] {
            let (reply, receiver) = mpsc::sync_channel(1);
            let now = Instant::now();
            let mut state = State { copy: Some(CopyFlight { request_id: 9, generation: 0,
                token: "old".into(), started: now, deadline: now, reply }), ..State::default() };
            cancel_requests(&mut state, "test", |_| outcome);
            assert!(receiver.try_recv().unwrap().unwrap_err().contains("无法撤销"));
        }
    }
    #[test]
    fn expired_copy_completion_is_rejected_even_before_timeout_tick() {
        let now = Instant::now();
        let (reply, _) = mpsc::sync_channel(1);
        let flight = CopyFlight { request_id: 1, generation: 2, token: "token".into(), started: now, deadline: now, reply };
        assert!(!flight.accepts(1, 2, now));
        assert!(!flight.accepts(1, 3, now - Duration::from_millis(1)));
        assert!(!flight.accepts(2, 2, now - Duration::from_millis(1)));
    }
    // 主线程繁忙时，回执可能在下发后很久才被处理。只要它是在截止时间之前
    // 产生的，就必须被接受：否则已提交的写入会被报告成失败。
    #[test]
    fn completion_arriving_before_deadline_is_accepted_even_if_processed_late() {
        let now = Instant::now();
        let deadline = now + Duration::from_secs(2);
        let (reply, _) = mpsc::sync_channel(1);
        let copy = CopyFlight { request_id: 5, generation: 7, token: "t".into(), started: now, deadline, reply };
        let arrived = deadline - Duration::from_millis(1);
        let processed = deadline + Duration::from_secs(5);
        assert!(copy.accepts(5, 7, arrived), "arrival before the deadline must win");
        assert!(arrived < processed);
        let capture = CaptureFlight { request_id: 6, generation: 7, deadline, source: source(10, 20) };
        assert!(capture.accepts(6, 7, arrived));
        // 晚于截止时间才到达的回执仍然必须被丢弃。
        assert!(!copy.accepts(5, 7, deadline));
        assert!(!capture.accepts(6, 7, deadline + Duration::from_millis(1)));
    }
    #[test]
    fn settings_window_shrinks_on_1080p_at_150_percent_but_not_on_1440p() {
        // 1080p、150% 缩放时桌面逻辑高度只有 720，默认的 720 高窗口会超出屏幕。
        assert_eq!(fitted_inner_size(620.0, 720.0, 1280.0, 720.0), Some((620.0, 648.0)));
        // 1440p、150% 缩放的逻辑高度为 960，保留原尺寸。
        assert_eq!(fitted_inner_size(620.0, 720.0, 1706.0, 960.0), None);
        assert_eq!(fitted_inner_size(480.0, 480.0, 1280.0, 720.0), None);
    }
}
