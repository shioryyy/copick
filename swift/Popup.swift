import Cocoa

// 浮窗：非激活 panel，不抢焦点，全屏 / 所有桌面可见。
final class Panel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class Popup {
    static let size = NSSize(width: 96, height: 40)
    var onCopy: (() -> Void)?
    private let panel: Panel
    private let button: NSButton

    init() {
        panel = Panel(contentRect: NSRect(origin: .zero, size: Popup.size),
                      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .screenSaver
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]

        button = NSButton(frame: NSRect(x: 2, y: 2, width: 92, height: 36))
        button.isBordered = false
        button.wantsLayer = true
        button.layer?.cornerRadius = 9
        button.layer?.borderWidth = 1
        button.layer?.borderColor = NSColor(white: 0.33, alpha: 1).cgColor
        button.layer?.backgroundColor = NSColor(white: 0.16, alpha: 1).cgColor
        panel.contentView?.addSubview(button)
        button.target = self
        button.action = #selector(clicked)
        setTitle("复制")
    }

    private func setTitle(_ s: String) {
        button.attributedTitle = NSAttributedString(string: s, attributes: [
            .foregroundColor: NSColor.white, .font: NSFont.systemFont(ofSize: 14)])
    }

    @objc private func clicked() {
        onCopy?()
        setTitle("已复制 ✓")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { [self] in hide() }
    }

    func show(at origin: NSPoint) {
        setTitle("复制")
        panel.setFrameOrigin(origin)
        panel.orderFrontRegardless()
    }

    func hide() { if panel.isVisible { panel.orderOut(nil) } }
}
