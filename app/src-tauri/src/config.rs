use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

/// 剪贴板回退默认关闭。
///
/// 它要先合成 Ctrl+C 读剪贴板再恢复原内容，会短暂改写系统剪贴板（剪贴板管理器、
/// 云同步和历史记录都可能看到），恢复对 GDI 句柄、私有格式和延迟渲染格式也只能
/// 尽力而为；合成快捷键在终端里还是 SIGINT。无障碍路径（UIA/MSAA）能覆盖主流
/// 应用后，这条路径只在长尾里才有收益，因此改为显式开启。
fn default_clipboard_fallback() -> bool { false }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub version: u32,
    #[serde(default)]
    pub paused: bool,
    #[serde(default = "default_clipboard_fallback")]
    pub clipboard_fallback: bool,
    pub excluded_apps: Vec<String>,
    pub diagnostics_enabled: bool,
}
impl Default for Config {
    fn default() -> Self {
        Self { version: 1, paused: false, clipboard_fallback: default_clipboard_fallback(),
            excluded_apps: Vec::new(), diagnostics_enabled: false }
    }
}
impl Config {
    pub fn validate(mut self) -> Result<Self, String> {
        if self.version != 1 { return Err("此设置版本暂不支持，请更新 Copick。".into()); }
        // macOS 没有可取消的回退路径，忽略来自旧配置或旧版导入的开启意图。
        if !cfg!(target_os = "windows") { self.clipboard_fallback = false; }
        if self.excluded_apps.len() > 200 { return Err("最多添加 200 个排除应用。".into()); }
        let mut names = Vec::new();
        for entry in self.excluded_apps {
            let name = entry.trim().to_lowercase();
            if name.is_empty() { continue; }
            if name.chars().count() > 128 || name.chars().any(char::is_control) || name.contains(['/', '\\', '*', '?']) {
                return Err("应用标识不能超过 128 个字符，也不能含路径、通配符或控制字符。".into());
            }
            if !names.contains(&name) { names.push(name); }
        }
        self.excluded_apps = names;
        Ok(self)
    }
}

pub struct Store {
    pub path: PathBuf,
    pub config: Config,
    pub error: Option<String>,
}
impl Store {
    pub fn load(path: PathBuf) -> Self {
        let mut store = Self { path, config: Config::default(), error: None };
        if store.path.exists() {
            match fs::read(&store.path).map_err(|e| e.to_string())
                .and_then(|bytes| serde_json::from_slice::<Config>(&bytes).map_err(|e| e.to_string()))
                .and_then(Config::validate) {
                Ok(config) => store.config = config,
                Err(_) => {
                    store.config.paused = true;
                    store.error = Some("无法读取设置，监听已暂停。原设置文件已保留；保存可重新建立设置。".into());
                }
            }
        }
        store
    }
    pub fn save(&mut self, config: Config) -> Result<(), String> {
        let config = config.validate()?;
        let directory = self.path.parent().ok_or("无法确定设置目录。")?;
        fs::create_dir_all(directory).map_err(|_| "无法创建设置目录。")?;
        let bytes = serde_json::to_vec_pretty(&config).map_err(|_| "无法编码设置。")?;
        let temporary = self.path.with_extension("json.tmp");
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        let mut file = options.open(&temporary).map_err(|_| "无法写入设置文件。")?;
        file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| "设置未能完整保存，请重试。")?;
        drop(file);
        fs::rename(&temporary, &self.path).map_err(|_| "无法替换设置文件，请检查目录权限。")?;
        self.config = config;
        self.error = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!("copick-config-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap(); path
    }
    #[test]
    fn normalizes_and_rejects_invalid_identifiers() {
        let config = Config { excluded_apps: vec![" Code.EXE ".into(), "code.exe".into()], ..Config::default() }.validate().unwrap();
        assert_eq!(config.excluded_apps, ["code.exe"]);
        for name in ["/Applications/Code.app", "foo\nbar", "*.exe"] {
            assert!(Config { excluded_apps: vec![name.into()], ..Config::default() }.validate().is_err());
        }
    }
    #[test]
    fn clipboard_fallback_is_opt_in_and_forced_off_on_macos() {
        // 默认关闭：无障碍路径能覆盖的应用不必让选区经过系统剪贴板。
        assert!(!Config::default().clipboard_fallback);
        // 缺字段的旧配置同样按关闭读取，不会因为升级而突然开始合成快捷键。
        let parsed: Config = serde_json::from_str(
            r#"{"version":1,"excludedApps":[],"diagnosticsEnabled":false}"#).unwrap();
        assert!(!parsed.clipboard_fallback);
        // 显式开启在 Windows 上保留，macOS 没有可取消的回退路径，仍强制关闭。
        let requested = Config { clipboard_fallback: true, ..Config::default() }.validate().unwrap();
        assert_eq!(requested.clipboard_fallback, cfg!(target_os = "windows"));
    }
    #[test]
    fn corrupt_file_is_preserved_and_failed_save_keeps_current_config() {
        let root = directory(); let path = root.join("config.json");
        fs::write(&path, b"broken").unwrap();
        let mut store = Store::load(path.clone());
        assert!(store.config.paused && store.error.is_some());
        assert_eq!(fs::read(&path).unwrap(), b"broken");
        let before = store.config.clone();
        store.path = root.join("missing-parent-file/config.json");
        fs::write(root.join("missing-parent-file"), b"file").unwrap();
        assert!(store.save(Config::default()).is_err()); assert_eq!(store.config, before);
        fs::remove_dir_all(root).unwrap();
    }
}
