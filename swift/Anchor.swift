import Cocoa

// 纯函数：根据选区矩形与拖动方向计算浮窗左下角位置（Cocoa 坐标，原点在左下）。
func placePopup(rect: NSRect?, start: NSPoint, end: NSPoint, size: NSSize, area: NSRect) -> NSPoint {
    var x = end.x - size.width / 2
    var y: CGFloat
    if let r = rect {
        let below = end.y <= start.y + 4          // 向下或水平拖选：放在选区下方；向上拖选：放在上方
        y = below ? r.minY - 4 - size.height : r.maxY + 4
        if !below && y + size.height > area.maxY { y = r.minY - 4 - size.height }
    } else {
        y = end.y - 16 - size.height
    }
    x = max(area.minX, min(x, area.maxX - size.width))
    y = max(area.minY, min(y, area.maxY - size.height))
    return NSPoint(x: x.rounded(), y: y.rounded())
}
