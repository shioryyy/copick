# 纯标准库绘制图标：圆角矩形 SDF 抗锯齿，输出 PNG。
import zlib, struct, math

def rrect(px, py, x, y, w, h, r):
    cx, cy = x + w / 2, y + h / 2
    qx, qy = abs(px - cx) - (w / 2 - r), abs(py - cy) - (h / 2 - r)
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r

def png(path, size, shapes, bg=None):
    s = size / 1024
    rows = []
    for j in range(size):
        row = bytearray([0])
        for i in range(size):
            px, py = (i + .5) / s, (j + .5) / s
            r = g = b = a = 0.0
            for (x, y, w, h, rad, col, grad) in shapes:
                cov = min(1, max(0, .5 - rrect(px, py, x, y, w, h, rad) * s))
                if cov <= 0: continue
                c = col
                if grad:
                    t = min(1, max(0, (py - y) / h))
                    c = tuple(grad[0][k] * (1 - t) + grad[1][k] * t for k in range(3))
                ca = cov
                oa = ca + a * (1 - ca)
                if oa > 0:
                    r = (c[0] * ca + r * a * (1 - ca)) / oa
                    g = (c[1] * ca + g * a * (1 - ca)) / oa
                    b = (c[2] * ca + b * a * (1 - ca)) / oa
                a = oa
            row += bytes((int(r), int(g), int(b), int(a * 255)))
        rows.append(bytes(row))
    raw = b''.join(rows)
    def ch(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + ch(b'IDAT', zlib.compress(raw, 9)) + ch(b'IEND', b''))

GREY, BLUE, WHITE = (138, 143, 156), (59, 130, 246), (255, 255, 255)
icon = [
    (100, 100, 824, 824, 185, None, ((58, 63, 75), (28, 31, 38))),
    (230, 300, 400, 56, 28, GREY, None),
    (210, 430, 470, 110, 26, BLUE, None),
    (250, 462, 390, 46, 23, WHITE, None),
    (230, 620, 300, 56, 28, GREY, None),
    (660, 520, 150, 150, 40, WHITE, None),
    (690, 550, 90, 90, 22, BLUE, None),
]
tray = [  # 模板图标：纯黑 + 透明
    (96, 224, 544, 80, 40, (0, 0, 0), None),
    (64, 400, 672, 224, 64, (0, 0, 0), None),
    (96, 736, 384, 80, 40, (0, 0, 0), None),
    (640, 608, 320, 320, 80, (0, 0, 0), None),
]
png('icon_1024.png', 1024, icon)
png('trayTemplate.png', 18, tray)
png('trayTemplate@2x.png', 36, tray)
