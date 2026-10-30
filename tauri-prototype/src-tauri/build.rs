use std::{env, path::PathBuf};

fn main() {
    let platform = env::var("CARGO_CFG_TARGET_OS").unwrap();
    assert!(platform == "macos" || platform == "windows", "原型仅支持 macOS 和 Windows");
    let package = PathBuf::from("../node_modules/selection-hook");
    let metadata: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(package.join("package.json")).expect("请先在 tauri-prototype/ 执行 npm ci"),
    ).expect("无法读取 selection-hook 元数据");
    assert_eq!(metadata["version"], "2.1.1", "原型仅验证过 selection-hook 2.1.1");
    let source = package.join(if platform == "macos" { "src/mac" } else { "src/windows" });
    println!("cargo:rerun-if-changed=native");
    println!("cargo:rerun-if-changed={}", source.display());
    let mut build = cc::Build::new();
    build.cpp(true).std("c++17").include(&source);
    if platform == "macos" {
        build.flag("-fno-objc-arc").flag("-fblocks").flag("-fexceptions").flag("-frtti")
            .flag("-include").flag("algorithm").flag("-include").flag("cctype")
            .file("native/bridge.mm").file(source.join("core/engine.mm"))
            .file(source.join("lib/utils.mm")).file(source.join("lib/clipboard.mm"));
        for framework in ["Cocoa", "ApplicationServices"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    } else {
        build.flag("/utf-8").flag("/EHsc").define("NOMINMAX", None)
            .define("UNICODE", None).define("_UNICODE", None)
            .file("native/bridge_win.cc").file(source.join("core/engine.cc"))
            .file(source.join("lib/clipboard.cc")).file(source.join("lib/utils.cc"))
            .file(source.join("lib/string_pool.cc"));
        for library in ["UIAutomationCore", "Ole32", "OleAut32", "Oleacc", "User32", "Gdi32", "Shell32", "Advapi32", "Uuid"] {
            println!("cargo:rustc-link-lib={library}");
        }
    }
    build.compile("copick_selection");
    tauri_build::build();
}
