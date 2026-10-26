#pragma once

#include <string>
#include <vector>

namespace copick {

/**
 * Programs that never take part in selection capture.
 *
 * The engine lowercases the foreground program name and checks whether it contains
 * any entry, so entries are lowercase fragments rather than exact matches: "copick"
 * also covers "copick-tauri-prototype.exe". Terminals, credential prompts and
 * password managers are excluded so a popup never appears next to a password field
 * or a command line. Keep this aligned with the Electron build's PROTECTED list.
 *
 * @return Stable list shared by the global and clipboard exclude filters.
 */
inline const std::vector<std::string> &ProtectedPrograms()
{
    static const std::vector<std::string> programs = {
        "copick", "windowsterminal", "windowsterminalpreview", "openconsole", "conhost",
        "cmd.exe", "powershell", "pwsh", "wsl", "wslhost", "bash.exe", "mintty", "putty",
        "kitty.exe", "wezterm", "alacritty", "hyper.exe", "tabby", "ssh.exe",
        "mobaxterm", "xshell", "securecrt", "credentialuibroker.exe", "logonui.exe",
        "1password", "onepassword", "bitwarden", "lastpass", "keepass", "dashlane",
        "nordpass", "keeper", "roboform", "enpass",
    };
    return programs;
}

/**
 * Programs allowed to use accessibility retrieval but not the clipboard fallback.
 *
 * Synthesized copy shortcuts can truncate a terminal session or trigger editor
 * shortcuts, so IDEs stay on UIA/MSAA only. They must not be added to
 * ProtectedPrograms(): that would disable accessibility capture as well.
 *
 * @return Stable clipboard-only exclusion list.
 */
inline const std::vector<std::string> &NoClipboardPrograms()
{
    static const std::vector<std::string> programs = {
        "code.exe", "code - insiders", "vscodium", "cursor", "windsurf", "trae", "devenv",
        "idea", "pycharm", "webstorm", "phpstorm", "clion", "rider", "goland", "datagrip",
        "rubymine", "rustrover", "fleet",
    };
    return programs;
}

/**
 * Append the user's exclusion list to a built-in list.
 *
 * @param[in] base Built-in fragments.
 * @param[in] excluded Normalized lowercase user entries.
 * @return New list; the inputs are left untouched.
 */
inline std::vector<std::string> WithExcluded(const std::vector<std::string> &base,
                                             const std::vector<std::string> &excluded)
{
    std::vector<std::string> list = base;
    list.insert(list.end(), excluded.begin(), excluded.end());
    return list;
}

/**
 * Build the clipboard exclude list: protected programs, then clipboard-only
 * programs, then the user's entries. Order is irrelevant to the engine.
 *
 * @param[in] excluded Normalized lowercase user entries.
 * @return Combined clipboard exclusion list.
 */
inline std::vector<std::string> ClipboardExclusions(const std::vector<std::string> &excluded)
{
    return WithExcluded(WithExcluded(ProtectedPrograms(), NoClipboardPrograms()), excluded);
}

} // namespace copick
