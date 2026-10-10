import Cocoa
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let config = ConfigStore()
    private let trigger = Trigger()
    private let popup = Popup()
    private var item: NSStatusItem!
    private var text = ""
    private var lastApp = ""

    func applicationDidFinishLaunching(_ n: Notification) {
        if NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "").count > 1 {
            NSApp.terminate(nil); return
        }
        if !AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) {
            NSLog("Copick: 需要辅助功能权限")
        }
        popup.onCopy = { [self] in
            guard !text.isEmpty else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }
        trigger.isEnabled = { [self] in !config.value.paused }
        trigger.onCancel = { [self] in popup.hide(); text = "" }
        trigger.onSelect = { [self] start, end in
            guard let sel = currentSelection() else { return }
            lastApp = sel.bundleID
            buildMenu()
            guard isAllowed(sel.bundleID, config.value) else { return }
            text = sel.text
            let area = (NSScreen.screens.first { $0.frame.contains(end) } ?? NSScreen.main!).visibleFrame
            popup.show(at: placePopup(rect: sel.rect, start: start, end: end, size: Popup.size, area: area))
        }
        trigger.start()

        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let url = Bundle.main.url(forResource: "trayTemplate", withExtension: "png"), let img = NSImage(contentsOf: url) {
            img.isTemplate = true
            item.button?.image = img
        } else {
            item.button?.title = "Copick"
        }
        buildMenu()
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [self] _ in
            let t = AXIsProcessTrusted()
            if t != trusted { buildMenu() }
        }
    }

    private var trusted = AXIsProcessTrusted()

    @objc private func openAccessibility() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }

    private func buildMenu() {
        trusted = AXIsProcessTrusted()
        let c = config.value
        item.button?.title = !trusted ? " ⚠" : c.paused ? " ⏸" : ""
        let m = NSMenu()
        if !trusted {
            m.addItem(withTitle: "辅助功能：未授权，划词不会生效", action: nil, keyEquivalent: "").isEnabled = false
            m.addItem(menuItem("打开辅助功能设置…", #selector(openAccessibility)))
            m.addItem(.separator())
        }
        m.addItem(withTitle: c.paused ? "已暂停" : "运行中", action: nil, keyEquivalent: "").isEnabled = false
        m.addItem(menuItem(c.paused ? "恢复划词" : "暂停划词", #selector(togglePause)))
        m.addItem(.separator())
        let ban = menuItem(lastApp.isEmpty ? "在最近划词的应用中禁用" : "在 \(lastApp) 中禁用", #selector(banLast))
        ban.isEnabled = !lastApp.isEmpty && !c.list.contains(lastApp)
        m.addItem(ban)
        let clear = menuItem("清空自定义黑名单", #selector(clearList))
        clear.isEnabled = !c.list.isEmpty
        m.addItem(clear)
        m.addItem(.separator())
        let login = menuItem("开机自启", #selector(toggleLogin))
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        m.addItem(login)
        m.addItem(.separator())
        m.addItem(menuItem("退出 Copick", #selector(quit)))
        item.menu = m
    }

    private func menuItem(_ title: String, _ sel: Selector) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: sel, keyEquivalent: ""); i.target = self; return i
    }

    @objc private func togglePause() { config.update { $0.paused.toggle() }; popup.hide(); buildMenu() }
    @objc private func banLast() { config.update { $0.list.append(lastApp) }; buildMenu() }
    @objc private func clearList() { config.update { $0.list = [] }; buildMenu() }
    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
        } catch { NSLog("Copick: 开机自启设置失败 \(error)") }
        buildMenu()
    }
    @objc private func quit() { trigger.stop(); NSApp.terminate(nil) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
