//! 程序显示名称。
//!
//! 仅用于界面文案（当前是托盘菜单），不参与过滤、配置写入或事件匹配。
//! 只收录完整标识；未知值（包括空值）原样返回，不根据片段猜测名称。
//! 表与 Electron 版 `program-names.js` 保持一致。

/// 把已知的 bundle identifier 或 Windows 可执行文件名换成易读名称。
///
/// 查表时忽略大小写，返回的未知值保持调用方传入的原样。
pub fn display_name(identifier: &str) -> &str {
    let lower = identifier.to_lowercase();
    match lower.as_str() {
        // macOS bundle identifier；表不依赖当前运行平台。
        "com.apple.safari" => "Safari",
        "com.google.chrome" => "Chrome",
        "org.mozilla.firefox" => "Firefox",
        "com.microsoft.edgemac" => "Edge",
        "com.microsoft.vscode" => "VS Code",
        "com.todesktop.2305228j7" => "Cursor",
        "com.exafunction.windsurf" => "Windsurf",
        "com.apple.terminal" => "Terminal",
        "com.googlecode.iterm2" => "iTerm2",
        "com.apple.finder" => "Finder",
        "com.apple.textedit" => "TextEdit",
        "com.microsoft.word" => "Word",
        "com.microsoft.excel" => "Excel",
        "com.microsoft.powerpoint" => "PowerPoint",
        "com.electron.lark" => "Feishu",
        "com.larksuite.larkapp" => "Lark",
        "com.tencent.xinwechat" => "WeChat",
        "com.1password.1password" => "1Password",
        "com.agilebits.onepassword7" => "1Password",
        "com.agilebits.onepassword4" => "1Password",

        // Windows 可执行文件名，只匹配文件名本身。
        "chrome.exe" => "Chrome",
        "firefox.exe" => "Firefox",
        "msedge.exe" => "Edge",
        "code.exe" => "VS Code",
        "cursor.exe" => "Cursor",
        "windsurf.exe" => "Windsurf",
        "windowsterminal.exe" => "Windows Terminal",
        "explorer.exe" => "File Explorer",
        "notepad.exe" => "Notepad",
        "winword.exe" => "Word",
        "excel.exe" => "Excel",
        "powerpnt.exe" => "PowerPoint",
        "feishu.exe" => "Feishu",
        "lark.exe" => "Lark",
        "wechat.exe" => "WeChat",
        "weixin.exe" => "WeChat",
        "1password.exe" => "1Password",

        _ => identifier,
    }
}

#[cfg(test)]
mod tests {
    use super::display_name;

    #[test]
    fn known_identifiers_map_on_both_platforms() {
        assert_eq!(display_name("com.google.chrome"), "Chrome");
        assert_eq!(display_name("com.tencent.xinwechat"), "WeChat");
        assert_eq!(display_name("chrome.exe"), "Chrome");
        assert_eq!(display_name("WeiXin.EXE"), "WeChat");
        assert_eq!(display_name("com.1password.1password"), "1Password");
    }

    #[test]
    fn unknown_and_empty_values_are_returned_unchanged() {
        assert_eq!(display_name("com.example.Unknown"), "com.example.Unknown");
        assert_eq!(display_name("my-tool.exe"), "my-tool.exe");
        assert_eq!(display_name(""), "");
        // 只匹配完整标识，不能按片段猜测。
        assert_eq!(display_name("chrome.exe.bak"), "chrome.exe.bak");
        assert_eq!(display_name("not-chrome.exe"), "not-chrome.exe");
    }
}
