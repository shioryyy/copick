import Foundation

let builtinBlacklist: Set<String> = [
    "com.apple.finder", "com.apple.keychainaccess",
    "com.1password.1password", "com.agilebits.onepassword7",
]

func isAllowed(_ bundleID: String, _ cfg: Config) -> Bool {
    if bundleID.isEmpty { return true }
    let id = bundleID.lowercased()
    let user = Set(cfg.list.map { $0.lowercased() })
    if cfg.mode == "whitelist" { return user.contains(id) }
    return !builtinBlacklist.contains(id) && !user.contains(id)
}
