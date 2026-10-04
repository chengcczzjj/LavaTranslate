# LavaTranslate 图标：熔岩灯配色（紫 → 洋红 → 橙）的圆角方块，白色截图框四角 + 中间一滴熔岩
# 用法：python scripts/make-icon.py   （需要 Pillow）
import math
from PIL import Image, ImageChops, ImageDraw, ImageFilter

STOPS = [(0.0, (92, 70, 255)), (0.48, (226, 62, 154)), (1.0, (255, 140, 52))]


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def grad_color(t):
    for (t0, c0), (t1, c1) in zip(STOPS, STOPS[1:]):
        if t <= t1:
            return lerp(c0, c1, (t - t0) / (t1 - t0))
    return STOPS[-1][1]


def gradient(N):
    # 对角渐变：先画一条 1 维色带再拉伸旋转，比逐像素快
    band = Image.new('RGB', (512, 1))
    for i in range(512):
        band.putpixel((i, 0), grad_color(i / 511))
    D = int(N * 1.5)
    g = band.resize((D, D), Image.BILINEAR).rotate(-45, resample=Image.BICUBIC)
    o = (D - N) // 2
    return g.crop((o, o, o + N, o + N)).convert('RGBA')


def drop(cx, cy, r, h):
    """水滴：底部是半径 r 的圆（圆心 cx,cy），尖端在圆心上方 h 处"""
    # 尖端到圆的两条切线：切点与竖直轴的夹角 beta（数学坐标，逆时针为正）
    beta = math.acos(r / h)
    pts = [(cx, cy - h)]
    a0, a1 = math.pi / 2 + beta, 2.5 * math.pi - beta  # 从左切点经底部绕到右切点
    steps = 120
    for i in range(steps + 1):
        a = a0 + (a1 - a0) * i / steps
        pts.append((cx + r * math.cos(a), cy - r * math.sin(a)))
    return pts


def soft(N, shape, color, alpha, blur):
    """柔光层：颜色铺满、只模糊透明度，避免半透明边缘混进黑色"""
    m = Image.new('L', (N, N), 0)
    shape(ImageDraw.Draw(m))
    if blur:
        m = m.filter(ImageFilter.GaussianBlur(blur))
    layer = Image.new('RGBA', (N, N), color + (0,))
    layer.putalpha(m.point(lambda v: v * alpha // 255))
    return layer


def mark(size):
    k = 4
    N = size * k
    small = size <= 32
    mask = Image.new('L', (N, N), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, N - 1, N - 1], radius=int(N * 0.235), fill=255)

    im = gradient(N)
    # 底部熔岩热光、左上角冷光，让渐变更有体积
    im = Image.alpha_composite(im, soft(N, lambda d: d.ellipse([N * 0.1, N * 0.66, N * 1.15, N * 1.4], fill=255), (255, 190, 90), 150, N * 0.13))
    im = Image.alpha_composite(im, soft(N, lambda d: d.ellipse([-N * 0.45, -N * 0.5, N * 0.55, N * 0.4], fill=255), (150, 120, 255), 90, N * 0.14))

    white = (255, 255, 255)
    # 熔岩滴
    r = N * (0.15 if small else 0.128)
    h = r * 2.05
    cy = N * 0.5 + r * 0.6
    pts = drop(N / 2, cy, r, h)
    if not small:
        im = Image.alpha_composite(im, soft(N, lambda d: d.polygon(pts, fill=255), (255, 226, 170), 200, N * 0.05))

    # 截图框四角
    m = N * (0.2 if small else 0.215)
    L = N * (0.19 if small else 0.165)
    w = N * (0.105 if small else 0.066)

    def corners(d):
        for cx, cy2, sx, sy in [(m, m, 1, 1), (N - m, m, -1, 1), (m, N - m, 1, -1), (N - m, N - m, -1, -1)]:
            d.line([(cx, cy2 + sy * L), (cx, cy2), (cx + sx * L, cy2)], fill=255, width=int(w), joint='curve')
            for px, py in [(cx, cy2 + sy * L), (cx + sx * L, cy2), (cx, cy2)]:
                d.ellipse([px - w / 2, py - w / 2, px + w / 2, py + w / 2], fill=255)

    if not small:
        # 前景的细微投影
        im = Image.alpha_composite(im, soft(N, lambda d: (corners(d), d.polygon([(x, y + N * 0.012) for x, y in pts], fill=255)), (90, 20, 60), 70, N * 0.018))
    im = Image.alpha_composite(im, soft(N, corners, white, 255, 0))
    im = Image.alpha_composite(im, soft(N, lambda d: d.polygon(pts, fill=255), white, 255, 0))
    if not small:
        # 滴底部一抹暖色，像正在发光的熔岩
        dm = Image.new('L', (N, N), 0)
        ImageDraw.Draw(dm).polygon(pts, fill=255)
        warm = soft(N, lambda d: d.ellipse([N / 2 - r * 1.1, cy + r * 0.1, N / 2 + r * 1.1, cy + r * 1.6], fill=255), (255, 168, 72), 120, r * 0.45)
        warm.putalpha(ImageChops.multiply(warm.getchannel('A'), dm))
        im = Image.alpha_composite(im, warm)

    im.putalpha(ImageChops.multiply(im.getchannel('A'), mask))
    return im.resize((size, size), Image.LANCZOS)


if __name__ == '__main__':
    big = mark(1024)
    big.save('build/icon-1024.png')
    big.resize((512, 512), Image.LANCZOS).save('resources/icon.png')
    big.resize((512, 512), Image.LANCZOS).save('src/renderer/public/icon.png')
    # ico 里每个尺寸单独渲染：小尺寸用加粗的线条
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames = [mark(s) for s in sizes]
    for p in ['build/icon.ico', 'resources/icon.ico']:
        frames[-1].save(p, sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    for name, sz in [('tray.png', 16), ('tray@1.25x.png', 20), ('tray@1.5x.png', 24), ('tray@2x.png', 32)]:
        mark(sz).save('resources/' + name)
    print('icons ok')
