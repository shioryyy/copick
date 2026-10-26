use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub version: u32,
    #[serde(default)]
    pub paused: bool,
    pub excluded_apps: Vec<String>,
    pub diagnostics_enabled: bool,
}
impl Default for Config {
    fn default() -> Self {
        Self { version: 1, paused: false, excluded_apps: Vec::new(), diagnostics_enabled: false }
    }
}
impl Config {
    pub fn validate(mut self) -> Result<Self, String> {
        if self.version != 1 { return Err("此设置版本暂不支持，请更新 Copick。".into()); }
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
    pub migrated: bool,
}
impl Store {
    pub fn load(path: PathBuf, legacy: Option<&Path>) -> Self {
        let mut store = Self { path, config: Config::default(), error: None, migrated: false };
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
        } else if let Some(legacy) = legacy.filter(|path| path.exists()) {
            match migrate(legacy).and_then(|config| store.save(config)) {
                Ok(()) => store.migrated = true,
                Err(_) => {
                    store.config.paused = true;
                    store.error = Some("旧版设置导入失败，监听已暂停，旧文件未改动。请检查排除列表后保存。".into());
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

fn migrate(path: &Path) -> Result<Config, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if !value.is_object() { return Err("旧设置必须是对象。".into()); }
    let paused = match value.get("paused") {
        Some(value) => value.as_bool().ok_or("旧设置的暂停状态无效。")?, None => false,
    };
    let excluded_apps = match value.get("blacklist") {
        Some(value) => value.as_array().ok_or("旧设置的排除列表无效。")?.iter()
            .map(|entry| entry.as_str().map(str::to_owned).ok_or_else(|| "旧设置的应用标识无效。".to_owned()))
            .collect::<Result<_, _>>()?,
        None => Vec::new(),
    };
    // 启动项属于不同应用身份，兼容复制尚未启用；不导入这些系统副作用。
    Config { paused, excluded_apps, ..Config::default() }.validate()
}

pub fn legacy_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    { std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Application Support/Copick/config.json")) }
    #[cfg(target_os = "windows")]
    { std::env::var_os("APPDATA").map(|home| PathBuf::from(home).join("Copick/config.json")) }
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
    fn imports_once_and_never_changes_electron_file() {
        let root = directory(); let old = root.join("electron.json"); let path = root.join("config.json");
        let bytes = br#"{"paused":true,"clipboardFallback":true,"launchAtLogin":true,"blacklist":["Code.EXE"]}"#;
        fs::write(&old, bytes).unwrap();
        let store = Store::load(path.clone(), Some(&old));
        assert!(store.migrated && store.config.paused);
        assert_eq!(store.config.excluded_apps, ["code.exe"]);
        assert_eq!(fs::read(&old).unwrap(), bytes);
        fs::write(&old, b"broken").unwrap();
        assert!(!Store::load(path, Some(&old)).migrated);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn corrupt_file_is_preserved_and_failed_save_keeps_current_config() {
        let root = directory(); let path = root.join("config.json");
        fs::write(&path, b"broken").unwrap();
        let mut store = Store::load(path.clone(), None);
        assert!(store.config.paused && store.error.is_some());
        assert_eq!(fs::read(&path).unwrap(), b"broken");
        let before = store.config.clone();
        store.path = root.join("missing-parent-file/config.json");
        fs::write(root.join("missing-parent-file"), b"file").unwrap();
        assert!(store.save(Config::default()).is_err()); assert_eq!(store.config, before);
        fs::remove_dir_all(root).unwrap();
    }
}
