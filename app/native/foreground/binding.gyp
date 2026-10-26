{
  "targets": [{
    "target_name": "foreground",
    "defines": ["NAPI_VERSION=8"],
    "conditions": [
      ["OS=='mac'", {
        "sources": ["foreground_mac.mm"],
        "link_settings": { "libraries": ["-framework AppKit"] },
        "xcode_settings": { "MACOSX_DEPLOYMENT_TARGET": "12.0", "CLANG_ENABLE_OBJC_ARC": "YES" }
      }],
      ["OS=='win'", {
        "sources": ["foreground_win.cc"],
        "libraries": ["user32.lib"],
        "defines": ["UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "NOMINMAX"]
      }]
    ]
  }]
}
