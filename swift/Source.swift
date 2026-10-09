import Cocoa
import ApplicationServices

struct Selection {
    let text: String
    let bundleID: String
    let rect: NSRect?   // Cocoa 坐标；取不到则为 nil
}

// 取词源：只用 Accessibility API，不碰剪贴板。
func currentSelection() -> Selection? {
    let sys = AXUIElementCreateSystemWide()
    var f: CFTypeRef?
    guard AXUIElementCopyAttributeValue(sys, kAXFocusedUIElementAttribute as CFString, &f) == .success,
          let focused = f else { return nil }
    let el = focused as! AXUIElement

    var t: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXSelectedTextAttribute as CFString, &t) == .success,
          let text = t as? String,
          !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }

    var pid: pid_t = 0
    AXUIElementGetPid(el, &pid)
    let bid = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? ""
    return Selection(text: text, bundleID: bid, rect: selectionRect(el))
}

private func selectionRect(_ el: AXUIElement) -> NSRect? {
    var r: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, &r) == .success,
          let range = r else { return nil }
    var b: CFTypeRef?
    guard AXUIElementCopyParameterizedAttributeValue(
        el, kAXBoundsForRangeParameterizedAttribute as CFString, range, &b) == .success,
          let bv = b else { return nil }
    var rect = CGRect.zero
    guard AXValueGetValue(bv as! AXValue, .cgRect, &rect), rect.width > 0 || rect.height > 0 else { return nil }
    // AX 坐标原点在主屏左上，Cocoa 在左下
    let h = NSScreen.screens[0].frame.height
    return NSRect(x: rect.origin.x, y: h - rect.origin.y - rect.height, width: rect.width, height: rect.height)
}
