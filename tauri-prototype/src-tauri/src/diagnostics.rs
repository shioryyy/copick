//! 正式诊断日志只记录固定元数据；验证用环境变量由 main 外层独立处理。

use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

const MAX_BYTES: u64 = 512 * 1024;

struct State {
    path: Option<PathBuf>,
    enabled: bool,
}

static STATE: Mutex<State> = Mutex::new(State { path: None, enabled: false });

/// 只保存路径并恢复默认关闭状态，不创建目录或文件。
pub fn init(path: PathBuf) {
    if let Ok(mut state) = STATE.lock() {
        state.path = Some(path);
        state.enabled = false;
    }
}

pub fn set_enabled(enabled: bool) {
    if let Ok(mut state) = STATE.lock() {
        state.enabled = enabled;
    }
}

pub fn path() -> Option<PathBuf> {
    STATE.lock().ok()?.path.clone()
}

/// 写入失败直接丢弃日志，避免日志故障影响取词或再次触发日志。
pub fn write(message: &str) {
    let Ok(state) = STATE.lock() else { return };
    if !state.enabled { return; }
    let Some(path) = state.path.as_deref() else { return };
    if let Some(line) = metadata_line(message) {
        let _ = append(path, line.as_bytes());
    }
}

fn number(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<u64>().is_ok()
}

fn boolean(value: &str) -> bool { matches!(value, "true" | "false") }

fn cancel_reason(value: &str) -> bool {
    matches!(value, "not_running" | "capture_source_changed" | "popup_eval_failed"
        | "input_discontinuity" | "completion_overflow" | "copy_timeout"
        | "selection_expired" | "selection_source_changed" | "capture_timeout"
        | "mouse_down" | "input_cancelled" | "configure" | "settings_changed" | "popup_prepare_failed"
        | "present_not_running" | "present_source_changed" | "present_focus_lost"
        | "present_not_shown" | "copy_source_changed" | "cursor_moved")
}

fn failure_reason(value: &str) -> bool {
    matches!(value, "no_text" | "non_text" | "fallback_failed" | "filtered" | "unknown")
}

/// 程序名来自操作系统，可能带空格、路径或任意字符。日志解析不了就整行丢弃，
/// 所以先压成固定字符集与长度上限；不接纳任何原样文本。
pub fn program_token(program: &str) -> String {
    let token: String = program.trim().to_ascii_lowercase().chars()
        .map(|value| if value.is_ascii_alphanumeric() || matches!(value, '.' | '-' | '_' | '+') { value } else { '_' })
        .take(64).collect();
    if token.bytes().all(|value| value == b'_') { "unknown".into() } else { token }
}

fn late_reason(value: &str) -> bool {
    matches!(value, "no_flight" | "generation_or_deadline" | "no_selection" | "token_changed")
}

fn outcome(value: &str) -> bool { matches!(value, "0" | "1" | "2") }
fn input_kind(value: &str) -> bool { matches!(value, "1" | "2") }
fn gesture(value: &str) -> bool { matches!(value, "0" | "1" | "2" | "3") }
fn method(value: &str) -> bool { matches!(value, "0" | "1" | "2" | "3" | "11" | "99") }
/// 只接纳 `program_token` 的输出：小写、固定字符集、长度有界。
fn program(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64
        && value.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit()
            || matches!(byte, b'.' | b'-' | b'_' | b'+'))
}

type Field = (&'static str, fn(&str) -> bool);

fn metadata_line(message: &str) -> Option<String> {
    // 同时限制事件、字段和取值；不能仅凭 COPICK_ 前缀接纳任意文本。
    // 禁止控制字符，避免换行注入；数字最多为 u64，不接纳路径、标题或选中文字。
    if message.len() > 512 || message.chars().any(char::is_control) { return None; }
    let mut words = message.split_ascii_whitespace();
    let event = words.next()?;
    let schema: &[Field] = match event {
        "COPICK_CAPTURE_EMPTY" => &[("request", number), ("reason", failure_reason), ("program", program)],
        "COPICK_CAPTURE_TIMEOUT" | "COPICK_CAPTURE_REJECT"
        | "COPICK_SELECTION_RECEIVED" | "COPICK_POPUP_PREPARING" | "COPICK_COPY_BEGIN" =>
            &[("request", number)],
        "COPICK_CAPTURE_CANCEL" => &[("request", number), ("reason", cancel_reason)],
        "COPICK_COPY_CANCEL" => &[("request", number), ("outcome", outcome), ("reason", cancel_reason)],
        "COPICK_COPY_LATE" => &[("request", number), ("reason", late_reason)],
        "COPICK_COPY_FAIL" | "COPICK_COPY_TIMEOUT" => &[("request", number), ("ms", number)],
        "COPICK_COPY_OK" => &[("request", number), ("focus_preserved", boolean), ("ms", number)],
        "COPICK_INPUT" => &[("kind", input_kind), ("gesture", gesture)],
        "COPICK_POPUP_PRESENTED" => &[("focus_preserved", boolean), ("method", method)],
        "COPICK_COPY_REQUEST" => &[],
        "COPICK_COPY_REJECT" => {
            let reason = words.next()?;
            if !matches!(reason, "no_selection" | "invalid_token" | "focus_changed" | "native_busy")
                || words.next().is_some() { return None; }
            return Some(format!("{event} {reason}\n"));
        }
        _ => return None,
    };
    let mut line = event.to_owned();
    for (key, valid) in schema {
        let (actual, value) = words.next()?.split_once('=')?;
        if actual != *key || !valid(value) { return None; }
        line.push(' ');
        line.push_str(key);
        line.push('=');
        line.push_str(value);
    }
    if words.next().is_some() { return None; }
    line.push('\n');
    Some(line)
}

fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".1");
    PathBuf::from(name)
}

fn file_size(path: &Path) -> io::Result<u64> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(metadata.len()),
        Ok(_) => Err(io::Error::new(io::ErrorKind::InvalidInput, "日志目标必须是普通文件")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error),
    }
}

fn needs_rotation(size: u64, incoming: usize) -> bool {
    size.saturating_add(incoming as u64) > MAX_BYTES
}

fn append(path: &Path, line: &[u8]) -> io::Result<()> {
    let backup = backup_path(path);
    let size = file_size(path)?;
    if file_size(&backup)? > MAX_BYTES {
        fs::remove_file(&backup)?;
    }
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    if needs_rotation(size, line.len()) {
        // 超限旧文件可能来自旧版本或外部改写，直接丢弃，保证备份也不超过上限。
        if size > MAX_BYTES {
            fs::remove_file(path)?;
        } else {
            match fs::remove_file(&backup) {
                Ok(()) => {},
                Err(error) if error.kind() == io::ErrorKind::NotFound => {},
                Err(error) => return Err(error),
            }
            fs::rename(path, &backup)?;
        }
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_known_metadata_with_exact_fields() {
        assert_eq!(metadata_line("COPICK_COPY_OK request=42 focus_preserved=true ms=17"),
            Some("COPICK_COPY_OK request=42 focus_preserved=true ms=17\n".into()));
        assert!(metadata_line("COPICK_CAPTURE_CANCEL request=2 reason=mouse_down").is_some());
        assert!(metadata_line("COPICK_CAPTURE_CANCEL request=2 reason=settings_changed").is_some());
        assert!(metadata_line("COPICK_CAPTURE_CANCEL request=2 reason=cursor_moved").is_some());
        assert_eq!(metadata_line("COPICK_CAPTURE_EMPTY request=7 reason=no_text program=excel.exe"),
            Some("COPICK_CAPTURE_EMPTY request=7 reason=no_text program=excel.exe\n".into()));
        assert!(metadata_line("COPICK_CAPTURE_EMPTY request=7 reason=fallback_failed program=unknown").is_some());
        assert!(metadata_line("COPICK_CAPTURE_EMPTY request=7 reason=filtered program=cmd.exe").is_some());
        assert_eq!(program_token("Excel.EXE"), "excel.exe");
        assert_eq!(program_token("Code - Insiders.exe"), "code_-_insiders.exe");
        assert_eq!(program_token("../../secret"), ".._.._secret");
        assert_eq!(program_token(""), "unknown");
        assert_eq!(program_token(&"a".repeat(100)).len(), 64);
        assert!(metadata_line("COPICK_COPY_REJECT invalid_token").is_some());
        assert!(metadata_line("COPICK_COPY_REQUEST").is_some());
        assert!(metadata_line("COPICK_POPUP_PRESENTED focus_preserved=true method=11").is_some());
        assert!(metadata_line("COPICK_POPUP_PRESENTED focus_preserved=true method=99").is_some());
        for message in ["selected private text", "COPICK_UNKNOWN request=1",
            "COPICK_COPY_REQUEST text=secret", "COPICK_COPY_REJECT secret",
            "COPICK_CAPTURE_CANCEL request=2 reason=private_text",
            "COPICK_COPY_OK request=42 focus_preserved=secret ms=17",
            "COPICK_COPY_BEGIN request=hello", "COPICK_COPY_BEGIN request=1 request=2",
            "COPICK_COPY_BEGIN request=18446744073709551616",
            "COPICK_COPY_BEGIN request=1\nCOPICK_COPY_REQUEST",
            "COPICK_CAPTURE_EMPTY request=7",
            "COPICK_CAPTURE_EMPTY request=7 reason=private_text program=excel.exe",
            "COPICK_CAPTURE_EMPTY request=7 reason=no_text program=Excel.exe",
            "COPICK_CAPTURE_EMPTY request=7 reason=no_text program=C:\\secret\\a.exe"] {
            assert!(metadata_line(message).is_none(), "{message}");
        }
    }

    #[test]
    fn rotation_preserves_the_exact_size_limit() {
        assert!(!needs_rotation(MAX_BYTES - 10, 10));
        assert!(needs_rotation(MAX_BYTES - 10, 11));
        assert!(needs_rotation(u64::MAX, 1));
        assert_eq!(backup_path(Path::new("/tmp/copick.log")), PathBuf::from("/tmp/copick.log.1"));
    }
}
