import Cocoa

// 触发器：判断"选择完成"（拖选 / 双击三击 / Shift+点击）；滚轮、按键、点击别处则取消。
final class Trigger {
    var onSelect: ((NSPoint, NSPoint) -> Void)?
    var onCancel: (() -> Void)?
    var isEnabled: () -> Bool = { true }

    private var down: (p: NSPoint, t: Date)?
    private var lastClick: (p: NSPoint, t: Date)?
    private var clicks = 0
    private var ticket = 0
    private var monitors: [Any] = []

    func start() {
        let add = { (mask: NSEvent.EventTypeMask, h: @escaping (NSEvent) -> Void) in
            if let m = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: h) { self.monitors.append(m) }
        }
        add([.leftMouseDown]) { [self] _ in cancel(); down = (NSEvent.mouseLocation, Date()) }
        add([.leftMouseUp]) { [self] e in mouseUp(e) }
        add([.scrollWheel, .keyDown]) { [self] _ in cancel() }
    }

    func stop() { monitors.forEach { NSEvent.removeMonitor($0) }; monitors = [] }

    func cancel() { ticket += 1; onCancel?() }

    private func mouseUp(_ e: NSEvent) {
        guard let d = down else { return }
        down = nil
        guard isEnabled() else { return }
        let p = NSEvent.mouseLocation, now = Date()
        let dist = hypot(p.x - d.p.x, p.y - d.p.y)
        let near = lastClick.map { now.timeIntervalSince($0.t) < NSEvent.doubleClickInterval && hypot(p.x - $0.p.x, p.y - $0.p.y) < 6 } ?? false
        clicks = (dist < 8 && near) ? clicks + 1 : 1
        lastClick = (p, now)

        let dragged = dist >= 8 && now.timeIntervalSince(d.t) <= 15
        guard dragged || clicks >= 2 || e.modifierFlags.contains(.shift) else { return }

        ticket += 1
        let mine = ticket, start = d.p
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [self] in
            if mine == ticket { onSelect?(start, p) }
        }
    }
}
