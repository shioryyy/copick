// 浮窗定位的纯计算部分：不依赖 AppKit，便于在任何机器上回归多显示器几何。
// 坐标一律用“主屏左上角为原点、y 向下”的屏幕空间（CG 与 Windows 都是这个方向），
// Cocoa 的左下角原点只在调用点换算一次。
#pragma once

namespace copick {

struct Rect {
    double x;
    double y;
    double width;
    double height;
};

constexpr double kPopupWidth = 88.0;
constexpr double kPopupHeight = 40.0;

// anchor 是选区终点；优先放在右下 10/12，下方放不下就翻到上方，最后钳进工作区。
inline Rect PlacePopup(double x, double y, Rect area) {
    double left = x + 10;
    if (left + kPopupWidth > area.x + area.width) left = area.x + area.width - kPopupWidth;
    if (left < area.x) left = area.x;
    double top = y + 12;
    if (top + kPopupHeight > area.y + area.height) top = y - 12 - kPopupHeight;
    if (top < area.y) top = area.y;
    if (top > area.y + area.height - kPopupHeight) top = area.y + area.height - kPopupHeight;
    return {left, top, kPopupWidth, kPopupHeight};
}

// Cocoa（左下角原点，主屏左下角为 0,0）与屏幕坐标（主屏左上角为 0,0）互转。
// primaryHeight 必须是主屏高度：用错屏幕会让副屏上的浮窗整体偏移。
inline double CocoaToScreenY(double cocoaY, double primaryHeight) { return primaryHeight - cocoaY; }
inline double ScreenToCocoaY(double screenY, double primaryHeight) { return primaryHeight - screenY; }

}  // namespace copick
