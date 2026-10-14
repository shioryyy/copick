import Cocoa
import ApplicationServices

struct Selection {
    let text: String
    let bundleID: String
    let rect: NSRect?   // Cocoa 坐标；取不到则为 nil
}

private func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

private func param(_ el: AXUIElement, _ name: String, _ arg: CFTypeRef) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyParameterizedAttributeValue(el, name as CFString, arg, &v) == .success ? v : nil
}

// 焦点元素：系统级失败时（如 Safari）回退到前台应用级。
private func focusedElement() -> AXUIElement? {
    if let f = attr(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute) { return (f as! AXUIElement) }
    guard let app = NSWorkspace.shared.frontmostApplication,
          let f = attr(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedUIElementAttribute) else { return nil }
    return (f as! AXUIElement)
}

// 选中文本及其选区矩形（Cocoa 坐标）。依次尝试：SelectedText → StringForRange → WebKit TextMarker。
private func read(_ el: AXUIElement) -> (String, NSRect?)? {
    if let s = attr(el, kAXSelectedTextAttribute) as? String, !blank(s) {
        return (s, selectionRect(el))
    }
    if let r = attr(el, kAXSelectedTextRangeAttribute),
       let s = param(el, kAXStringForRangeParameterizedAttribute, r) as? String, !blank(s) {
        return (s, selectionRect(el))
    }
    if let m = attr(el, "AXSelectedTextMarkerRange"),
       let s = param(el, "AXStringForTextMarkerRange", m) as? String, !blank(s) {
        let b = param(el, "AXBoundsForTextMarkerRange", m)
        return (s, b.flatMap(toCocoa))
    }
    return nil
}

// 先查焦点元素，再沿父链上溯；仍无则从鼠标下的元素起同样处理。
// 部分 Chromium 应用的选区挂在上层 AXWebArea，而焦点元素是无选区的 AXGroup。
private func findSelection() -> (AXUIElement, String, NSRect?)? {
    var starts: [AXUIElement] = []
    if let f = focusedElement() { starts.append(f) }
    if let app = NSWorkspace.shared.frontmostApplication {
        let p = NSEvent.mouseLocation, h = NSScreen.screens[0].frame.height
        var hit: AXUIElement?
        if AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(app.processIdentifier), Float(p.x), Float(h - p.y), &hit) == .success, let hit { starts.append(hit) }
    }
    for start in starts {
        var cur: AXUIElement? = start
        for _ in 0..<14 {
            guard let el = cur else { break }
            if let (t, r) = read(el) { return (el, t, r) }
            cur = attr(el, kAXParentAttribute).map { $0 as! AXUIElement }
        }
    }
    return nil
}

private func blank(_ s: String) -> Bool { s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

// Chromium / Electron 应用要收到此开关才会构建 AX 树；对其他应用无副作用。
private var enabledPids = Set<pid_t>()
func enableAccessibility(_ app: NSRunningApplication) {
    let pid = app.processIdentifier
    guard pid != getpid(), enabledPids.insert(pid).inserted else { return }
    AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), "AXManualAccessibility" as CFString, kCFBooleanTrue)
}

// 取词源：只用 Accessibility API，不碰剪贴板。
func currentSelection() -> Selection? {
    if let app = NSWorkspace.shared.frontmostApplication { enableAccessibility(app) }
    guard let (el, text, rect) = findSelection() else { return nil }
    var pid: pid_t = 0
    AXUIElementGetPid(el, &pid)
    let bid = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? ""
    return Selection(text: text, bundleID: bid, rect: rect)
}

private func selectionRect(_ el: AXUIElement) -> NSRect? {
    guard let range = attr(el, kAXSelectedTextRangeAttribute),
          let b = param(el, kAXBoundsForRangeParameterizedAttribute, range) else { return nil }
    return toCocoa(b)
}

private func toCocoa(_ bv: CFTypeRef) -> NSRect? {
    guard CFGetTypeID(bv) == AXValueGetTypeID() else { return nil }
    var rect = CGRect.zero
    guard AXValueGetValue(bv as! AXValue, .cgRect, &rect), rect.width > 0 || rect.height > 0 else { return nil }
    // AX 坐标原点在主屏左上，Cocoa 在左下
    let h = NSScreen.screens[0].frame.height
    return NSRect(x: rect.origin.x, y: h - rect.origin.y - rect.height, width: rect.width, height: rect.height)
}
