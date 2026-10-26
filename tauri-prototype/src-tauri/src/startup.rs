//! 当前用户的登录启动项；查询和关闭不要求当前程序来自安装包。

use std::sync::Mutex;

static ACCESS: Mutex<()> = Mutex::new(());

/// 只检查安装路径，不查询或写入系统启动项；目录权限仍以实际保存结果为准。
pub fn available() -> bool {
    if cfg!(debug_assertions) { return false; }
    #[cfg(target_os = "macos")]
    {
        std::env::current_exe().and_then(std::fs::canonicalize).ok()
            .is_some_and(|path| path.is_file() && mac_bundle_path(&path))
    }
    #[cfg(target_os = "windows")]
    {
        std::env::current_exe().ok().is_some_and(|path| path.is_file()
            && path.to_str().is_some_and(|path| windows_command(path).is_ok()))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { false }
}

/// 设置页应显示此说明；登记状态不能保证系统会执行登录启动。
pub fn note() -> &'static str {
    #[cfg(target_os = "macos")]
    { "仅已安装的正式应用可启用；更改在下次登录时生效，系统可能另行禁用此登录启动项。" }
    #[cfg(target_os = "windows")]
    { "仅安装目录中的正式应用可启用；此处显示启动项登记状态，Windows 启动应用设置或系统策略可能另行禁用。" }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { "当前平台不支持登录启动项。" }
}

pub fn enabled() -> Result<bool, String> {
    let _guard = ACCESS.lock().map_err(|_| "启动项状态锁不可用".to_owned())?;
    platform::enabled()
}

pub fn set_enabled(enabled: bool) -> Result<(), String> {
    let _guard = ACCESS.lock().map_err(|_| "启动项状态锁不可用".to_owned())?;
    platform::set_enabled(enabled)
}

#[cfg(any(target_os = "macos", test))]
fn mac_bundle_path(path: &std::path::Path) -> bool {
    let Some(macos) = path.parent() else { return false };
    let Some(contents) = macos.parent() else { return false };
    let Some(bundle) = contents.parent() else { return false };
    path.is_absolute()
        && macos.file_name().is_some_and(|name| name == "MacOS")
        && contents.file_name().is_some_and(|name| name == "Contents")
        && bundle.extension().is_some_and(|ext| ext == "app")
        && !path.components().any(|part| {
            let name = part.as_os_str().to_string_lossy();
            name.eq_ignore_ascii_case("target") || name.eq_ignore_ascii_case("debug")
                || name == ".."
        })
}

#[cfg(any(target_os = "macos", test))]
fn xml_escape(value: &str) -> Result<String, String> {
    // XML 1.0 不接受大部分控制字符，也不能无损表示非 UTF-8 路径。
    if value.chars().any(|c| !(matches!(c, '\t' | '\n' | '\r') || c >= ' ')
        || matches!(c, '\u{fffe}' | '\u{ffff}')) {
        return Err("启动路径包含 XML 不支持的字符".into());
    }
    Ok(value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
        .replace('"', "&quot;").replace('\'', "&apos;").replace('\r', "&#13;"))
}

#[cfg(any(target_os = "windows", test))]
fn windows_command(executable: &str) -> Result<String, String> {
    // 独立参数交给 reg.exe；此处的引号属于注册表中保存的启动命令。
    let normalized = executable.replace('/', "\\");
    let absolute = normalized.as_bytes().get(1) == Some(&b':')
        && normalized.as_bytes().get(2) == Some(&b'\\')
        && normalized.as_bytes()[0].is_ascii_alphabetic();
    if !absolute || executable.contains('"') || executable.chars().any(char::is_control)
        || !normalized.to_ascii_lowercase().ends_with(".exe")
        || normalized.split('\\').any(|part| {
            part.eq_ignore_ascii_case("target") || part.eq_ignore_ascii_case("debug")
                || part == ".." || part == "."
        }) {
        return Err("仅支持从本地安装目录启用开机启动，请先安装应用".into());
    }
    let command = format!("\"{executable}\" --background");
    // Windows Run 值的命令行长度上限为 260 个字符。
    if command.encode_utf16().count() > 260 {
        return Err("启动命令超过 Windows Run 的长度限制".into());
    }
    Ok(command)
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{mac_bundle_path, xml_escape};
    use std::{fs, io::{ErrorKind, Write}, os::unix::fs::OpenOptionsExt,
        path::{Path, PathBuf}, process::Command};

    const LABEL: &str = "local.copick.tauri";

    fn item_path() -> Result<PathBuf, String> {
        let home = std::env::var_os("HOME").map(PathBuf::from)
            .filter(|path| path.is_absolute()).ok_or("无法确定当前用户主目录")?;
        Ok(home.join("Library/LaunchAgents").join(format!("{LABEL}.plist")))
    }

    fn regular_file(path: &Path) -> Result<bool, String> {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_file() => Ok(true),
            Ok(_) => Err("启动项目标必须是普通文件，不能是符号链接或目录".into()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
            Err(error) => Err(format!("无法检查启动项：{error}")),
        }
    }

    pub fn enabled() -> Result<bool, String> {
        let path = item_path()?;
        if !regular_file(&path)? { return Ok(false); }
        // 使用系统 plist 解析器，避免手写 XML 解析或以文件存在代替配置有效。
        let output = Command::new("/usr/bin/plutil")
            .args(["-convert", "json", "-o", "-", "--"]).arg(path)
            .output().map_err(|error| format!("无法读取启动项：{error}"))?;
        if !output.status.success() { return Err("启动项 plist 无法解析".into()); }
        let value: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|_| "启动项 plist 内容无效".to_owned())?;
        let args = value["ProgramArguments"].as_array();
        Ok(value["Label"].as_str() == Some(LABEL)
            && value["RunAtLoad"].as_bool() == Some(true)
            && args.is_some_and(|args| args.len() == 2
                && args[0].as_str().is_some_and(|path| mac_bundle_path(Path::new(path)))
                && args[1].as_str() == Some("--background")))
    }

    pub fn set_enabled(enable: bool) -> Result<(), String> {
        let path = item_path()?;
        let exists = regular_file(&path)?;
        if !enable {
            if exists { fs::remove_file(path).map_err(|error| format!("无法删除启动项：{error}"))?; }
            return Ok(());
        }
        // 开发版本即使被手工放进 .app，也不能注册登录启动。
        let executable = std::env::current_exe().and_then(fs::canonicalize)
            .map_err(|error| format!("无法确定应用安装路径：{error}"))?;
        if cfg!(debug_assertions) || !mac_bundle_path(&executable) || !executable.is_file() {
            return Err("请先安装正式的 .app 应用，再启用开机启动".into());
        }
        let executable = xml_escape(executable.to_str().ok_or("启动路径必须是 UTF-8")?)?;
        let plist = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
            <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
            <plist version=\"1.0\"><dict>\n\
            <key>Label</key><string>{LABEL}</string>\n\
            <key>ProgramArguments</key><array><string>{executable}</string><string>--background</string></array>\n\
            <key>RunAtLoad</key><true/>\n</dict></plist>\n");
        let directory = path.parent().ok_or("启动项目录无效")?;
        fs::create_dir_all(directory).map_err(|error| format!("无法创建启动项目录：{error}"))?;
        if !fs::symlink_metadata(directory).map_err(|error| error.to_string())?.is_dir() {
            return Err("启动项目录不能是符号链接".into());
        }
        // 同目录原子替换；临时文件使用独占创建，拒绝覆盖链接或其他文件。
        let temporary = path.with_extension(format!("plist.{}.tmp", std::process::id()));
        let mut file = fs::OpenOptions::new().write(true).create_new(true).mode(0o600)
            .open(&temporary).map_err(|error| format!("无法创建启动项临时文件：{error}"))?;
        let result = (|| -> Result<(), String> {
            file.write_all(plist.as_bytes()).and_then(|_| file.sync_all())
                .map_err(|error| format!("无法写入启动项：{error}"))?;
            regular_file(&path)?;
            fs::rename(&temporary, &path).map_err(|error| format!("无法保存启动项：{error}"))
        })();
        if result.is_err() { let _ = fs::remove_file(&temporary); }
        result
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::windows_command;
    use std::{os::windows::process::CommandExt, process::{Command, Output}};

    const PARENT: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion";
    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    const FULL_KEY: &str = r"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run";
    const NAME: &str = "CopickTauri";

    fn reg(args: &[&str]) -> Result<Output, String> {
        let root = std::env::var_os("SystemRoot").ok_or("无法确定 Windows 系统目录")?;
        Command::new(std::path::PathBuf::from(root).join("System32/reg.exe"))
            .args(args).creation_flags(0x08000000).output()
            .map_err(|error| format!("无法运行 reg.exe：{error}"))
    }

    fn has_value() -> Result<bool, String> {
        let output = reg(&["query", KEY])?;
        if !output.status.success() {
            // Run 键可能尚未创建；不能把访问失败误报成“已关闭”。
            let parent = reg(&["query", PARENT])?;
            if parent.status.success() && !String::from_utf8_lossy(&parent.stdout).lines()
                .any(|line| line.trim().eq_ignore_ascii_case(FULL_KEY)) {
                return Ok(false);
            }
            return Err("无法查询当前用户的启动项注册表".into());
        }
        // reg.exe 输出采用系统代码页；只解析固定 ASCII 名称，不解码用户路径。
        for line in output.stdout.split(|byte| *byte == b'\n') {
            let name = line.split(|byte| byte.is_ascii_whitespace()).find(|part| !part.is_empty());
            if name.is_some_and(|part| part.eq_ignore_ascii_case(NAME.as_bytes())) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn enabled() -> Result<bool, String> {
        // 查询的是独立名称是否存在；系统对该项的启动禁用策略不在此接口范围内。
        has_value()
    }

    pub fn set_enabled(enable: bool) -> Result<(), String> {
        if !enable {
            if !has_value()? { return Ok(()); }
            if !reg(&["delete", KEY, "/v", NAME, "/f"])?.status.success() {
                return Err("无法删除当前用户启动项".into());
            }
            return Ok(());
        }
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        if cfg!(debug_assertions) || !executable.is_file() {
            return Err("请先安装正式应用，再启用开机启动".into());
        }
        let command = windows_command(executable.to_str().ok_or("启动路径必须是 Unicode")?)?;
        if !reg(&["add", KEY, "/v", NAME, "/t", "REG_SZ", "/d", &command, "/f"])?.status.success() {
            return Err("无法保存当前用户启动项".into());
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    pub fn enabled() -> Result<bool, String> { Err("当前平台不支持登录启动项".into()) }
    pub fn set_enabled(_: bool) -> Result<(), String> { Err("当前平台不支持登录启动项".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn only_bundle_executables_are_accepted() {
        // 该函数在 test 下也会为 Windows 编译，但 Windows 的 Path 语义要求盘符，
        // 没有盘符的 "/Applications/..." 不是绝对路径，正例只在 macOS 成立。
        #[cfg(target_os = "macos")]
        assert!(mac_bundle_path(Path::new("/Applications/Copick.app/Contents/MacOS/copick")));
        for path in ["/tmp/copick", "/tmp/Copick.app/copick", "Copick.app/Contents/MacOS/copick",
            "/tmp/target/release/Copick.app/Contents/MacOS/copick",
            "/Applications/Copick.app/Contents/MacOS/../copick"] {
            assert!(!mac_bundle_path(Path::new(path)), "{path}");
        }
    }

    #[test]
    fn plist_paths_are_escaped_and_invalid_xml_is_rejected() {
        assert_eq!(xml_escape("/A&B/<\"应用\">/'").unwrap(), "/A&amp;B/&lt;&quot;应用&quot;&gt;/&apos;");
        assert!(xml_escape("/bad\u{1}path").is_err());
    }

    #[test]
    fn windows_command_quotes_the_executable_and_rejects_development_paths() {
        assert_eq!(windows_command(r"C:\Program Files\Copick\copick.exe").unwrap(),
            r#""C:\Program Files\Copick\copick.exe" --background"#);
        for path in [r"C:\src\target\release\copick.exe", r"C:\src\DEBUG\copick.exe",
            r"C:\Apps\..\copick.exe", r"copick.exe", "C:\\Apps\\bad\".exe"] {
            assert!(windows_command(path).is_err(), "{path}");
        }
    }
}
