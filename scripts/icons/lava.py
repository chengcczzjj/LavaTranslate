"""LavaTranslate 图标：黑底上一滴从朱红到琥珀的发光熔岩，里面两行文字（1024 视口的 SVG）。
小尺寸（≤32px）用去掉文字、放大熔岩滴的版本；安卓自适应图标分背景层、前景层；单色图标用剪影。"""
import math

DROP = (512, 616, 236, 470)  # 圆心 x、y，底部圆半径，尖端到圆心的距离
LINES = [(392, 600, 240, 50), (392, 684, 160, 50)]  # x, y, 宽, 高（胶囊）
CENTER_Y = 499  # 熔岩滴整体的竖向中心（尖端 146 到底部 852）


def squircle(cx=512, cy=512, r=512, n=5.0, steps=360):
    """超椭圆圆角方块（连续曲率的圆角）"""
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        pts.append(f'{cx + r * math.copysign(abs(c) ** (2 / n), c):.1f},{cy + r * math.copysign(abs(s) ** (2 / n), s):.1f}')
    return 'M' + ' L'.join(pts) + ' Z'


def drop_path(cx=DROP[0], cy=DROP[1], r=DROP[2], tip=DROP[3]):
    beta = math.acos(r / tip)
    a0 = math.pi / 2 + beta
    x0 = cx + r * math.cos(a0)
    y0 = cy - r * math.sin(a0)
    x1 = cx - r * math.cos(a0)
    return f'M{cx:.2f},{cy - tip:.2f} L{x0:.2f},{y0:.2f} A{r:.2f},{r:.2f} 0 1 0 {x1:.2f},{y0:.2f} Z'


def pill_path(x, y, w, h):
    r = h / 2
    return f'M{x + r:.2f},{y:.2f} L{x + w - r:.2f},{y:.2f} A{r:.2f},{r:.2f} 0 0 1 {x + w - r:.2f},{y + h:.2f} L{x + r:.2f},{y + h:.2f} A{r:.2f},{r:.2f} 0 0 1 {x + r:.2f},{y:.2f} Z'


DEFS = """
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1A1614"/><stop offset="1" stop-color="#0B0A0A"/></linearGradient>
<radialGradient id="glow" cx="0.5" cy="0.72" r="0.45"><stop offset="0" stop-color="#FF8A00" stop-opacity="0.38"/><stop offset="1" stop-color="#FF8A00" stop-opacity="0"/></radialGradient>
<linearGradient id="lava" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF2D2D"/><stop offset="0.55" stop-color="#FF5A1F"/><stop offset="1" stop-color="#FFB627"/></linearGradient>
<radialGradient id="hl" cx="0.36" cy="0.42" r="0.32"><stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<radialGradient id="shade" cx="0.7" cy="0.85" r="0.6"><stop offset="0.4" stop-color="#7A1400" stop-opacity="0"/><stop offset="1" stop-color="#7A1400" stop-opacity="0.35"/></radialGradient>
<filter id="ds" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="20" stdDeviation="30" flood-color="#FF5A1F" flood-opacity="0.45"/></filter>"""


def background():
    return '<rect width="1024" height="1024" fill="url(#bg)"/><rect width="1024" height="1024" fill="url(#glow)"/>'


def drop(lines=True):
    p = drop_path()
    body = f'<g filter="url(#ds)"><path d="{p}" fill="url(#lava)"/></g><path d="{p}" fill="url(#shade)"/><path d="{p}" fill="url(#hl)"/>'
    if lines:
        body += ''.join(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{h / 2}" fill="#fff" fill-opacity="0.95"/>' for x, y, w, h in LINES)
    return body


def place(content, scale):
    """把熔岩滴缩放后放在画面正中"""
    return f'<g transform="translate(512 512) scale({scale}) translate(-512 -{CENTER_Y})">{content}</g>'


def svg(body, defs=DEFS, clip=True):
    sq = f'<clipPath id="sq"><path d="{squircle()}"/></clipPath>' if clip else ''
    inner = f'<g clip-path="url(#sq)">{body}</g>' if clip else body
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024"><defs>{sq}{defs}</defs>{inner}</svg>'


def icon(small=False):
    """桌面 / 文档用：圆角方块。small：≤32px 用，去掉文字、熔岩滴放大"""
    return svg(background() + (place(drop(lines=False), 1.12) if small else place(drop(), 1.0)))


def adaptive_bg():
    return svg(background(), clip=False)


def adaptive_fg():
    # 安全区是直径 66dp 的圆（整层 108dp）：熔岩滴缩到 0.8，最远点离中心约 283/512
    return svg(place(drop(), 0.8), clip=False)


def silhouette_path(scale, size):
    """单色剪影（熔岩滴，两行文字挖空），坐标换算到 size 视口；用 evenOdd 填充"""
    k = scale * size / 1024

    def tx(x, y):
        return (size / 2 + (x - 512) * k, size / 2 + (y - CENTER_Y) * k)

    cx, cy = tx(DROP[0], DROP[1])
    d = drop_path(cx, cy, DROP[2] * k, DROP[3] * k)
    for x, y, w, h in LINES:
        px, py = tx(x, y)
        d += ' ' + pill_path(px, py, w * k, h * k)
    return d
