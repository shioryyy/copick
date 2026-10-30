//! 配置与日志放在哪里：默认用系统配置目录，便携模式下用程序旁边的 `data/`。

use std::path::{Path, PathBuf};

/// 便携模式判定。
///
/// 可执行文件旁边（macOS 上是 `.app` 旁边）存在 `data` 目录时，配置与日志都写进
/// 这个目录，整个文件夹复制到另一台机器就能接着用。只在目录确实存在时生效，
/// 安装版不建这个目录，行为与以前一致。
pub fn portable_root(executable: &Path) -> Option<PathBuf> {
    let data = portable_base(executable)?.join("data");
    data.is_dir().then_some(data)
}

/// macOS 的可执行文件在 `Copick.app/Contents/MacOS/` 里，`data` 要放在 `.app`
/// 旁边而不是塞进 bundle；开发模式下没有 bundle，退回可执行文件所在目录。
fn portable_base(executable: &Path) -> Option<&Path> {
    if cfg!(target_os = "macos") {
        if let Some(bundle) = executable.ancestors().find(|path| {
            path.extension().is_some_and(|extension| extension == "app")
        }) {
            return bundle.parent();
        }
    }
    executable.parent()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn root() -> PathBuf {
        let path = std::env::temp_dir().join(format!("copick-storage-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn portable_root_requires_a_data_directory_beside_the_executable() {
        let root = root();
        let executable = root.join("copick-tauri-prototype.exe");
        fs::write(&executable, b"").unwrap();
        // 没有 data 目录：不启用便携模式，安装版照常用系统配置目录。
        assert_eq!(portable_root(&executable), None);
        // 同名普通文件不算数，避免用户误建的文件把配置写到意想不到的地方。
        fs::write(root.join("data"), b"").unwrap();
        assert_eq!(portable_root(&executable), None);
        fs::remove_file(root.join("data")).unwrap();
        fs::create_dir(root.join("data")).unwrap();
        assert_eq!(portable_root(&executable), Some(root.join("data")));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn portable_root_sits_beside_the_app_bundle() {
        let root = root();
        let macos = root.join("Copick Tauri.app/Contents/MacOS");
        fs::create_dir_all(&macos).unwrap();
        let executable = macos.join("copick-tauri-prototype");
        fs::write(&executable, b"").unwrap();
        assert_eq!(portable_root(&executable), None);
        // data 放在 .app 里面不算：bundle 内部会被签名校验，写进去会破坏签名。
        fs::create_dir_all(root.join("Copick Tauri.app/data")).unwrap();
        assert_eq!(portable_root(&executable), None);
        fs::create_dir(root.join("data")).unwrap();
        assert_eq!(portable_root(&executable), Some(root.join("data")));
        fs::remove_dir_all(root).unwrap();
    }
}
