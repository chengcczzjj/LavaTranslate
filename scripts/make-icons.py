"""生成桌面与安卓的全部图标：python scripts/make-icons.py （需要 Pillow；用项目里的 Electron 渲染 SVG）

桌面：build/icon-1024.png、build/icon.ico、resources/icon.ico / icon.png / tray*.png、src/renderer/public/icon.png、docs/images/icon.png
安卓：mipmap-*/ic_launcher_bg.png（背景层）、ic_launcher_fg.png（前景层）、drawable/ic_mark.xml（单色）、drawable/ic_tile.xml（通知栏）
图形定义在 scripts/icons/lava.py
"""
import json
import os
import subprocess
import sys
import tempfile

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'icons'))
import lava  # noqa: E402

RES = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')
DENSITIES = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]


def render(tmp, jobs):
    """jobs: [(svg 文本, 输出文件, 尺寸)]"""
    spec = []
    for i, (text, out, size) in enumerate(jobs):
        p = os.path.join(tmp, f'{i}.svg')
        open(p, 'w', encoding='utf-8').write(text)
        spec.append({'svg': p, 'out': out, 'size': size})
    jp = os.path.join(tmp, 'jobs.json')
    json.dump(spec, open(jp, 'w'))
    subprocess.run(['npx', 'electron', os.path.join(ROOT, 'scripts', 'icons', 'render.cjs'), jp], cwd=ROOT, shell=True, check=True)


def vector(path_data, size, dp, translate=0):
    return f"""<?xml version="1.0" encoding="utf-8"?>
<!-- 由 scripts/make-icons.py 生成：熔岩滴剪影，两行文字挖空 -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="{dp}dp"
    android:height="{dp}dp"
    android:viewportWidth="{size}"
    android:viewportHeight="{size}">
    <path
        android:fillColor="#FFFFFFFF"
        android:fillType="evenOdd"
        android:pathData="{path_data}" />
</vector>
"""


def main():
    full = lava.icon()
    small = lava.icon(small=True)
    with tempfile.TemporaryDirectory() as tmp:
        t = lambda name: os.path.join(tmp, name)  # noqa: E731
        jobs = [(full, t('1024.png'), 1024)]
        jobs += [(small if s <= 32 else full, t(f'ico-{s}.png'), s) for s in ICO_SIZES]
        for name, px in DENSITIES.items():
            jobs.append((lava.adaptive_bg(), t(f'bg-{name}.png'), px))
            jobs.append((lava.adaptive_fg(), t(f'fg-{name}.png'), px))
        render(tmp, jobs)

        big = Image.open(t('1024.png')).convert('RGBA')
        big.save(os.path.join(ROOT, 'build', 'icon-1024.png'))
        for p in ['resources/icon.png', 'src/renderer/public/icon.png', 'docs/images/icon.png']:
            big.resize((512, 512), Image.LANCZOS).save(os.path.join(ROOT, p))
        frames = [Image.open(t(f'ico-{s}.png')).convert('RGBA') for s in ICO_SIZES]
        for p in ['build/icon.ico', 'resources/icon.ico']:
            frames[-1].save(os.path.join(ROOT, p), sizes=[(s, s) for s in ICO_SIZES], append_images=frames[:-1])
        for name, s in [('tray.png', 16), ('tray@1.25x.png', 20), ('tray@1.5x.png', 24), ('tray@2x.png', 32)]:
            Image.open(t(f'ico-{s}.png')).save(os.path.join(ROOT, 'resources', name))
        for name in DENSITIES:
            d = os.path.join(RES, f'mipmap-{name}')
            os.makedirs(d, exist_ok=True)
            Image.open(t(f'bg-{name}.png')).convert('RGB').save(os.path.join(d, 'ic_launcher_bg.png'), optimize=True)
            Image.open(t(f'fg-{name}.png')).save(os.path.join(d, 'ic_launcher_fg.png'), optimize=True)

    # 单色主题图标（108dp 整层，内容在安全区内）与通知栏小图标（24dp，熔岩滴撑满）
    open(os.path.join(RES, 'drawable', 'ic_mark.xml'), 'w', encoding='utf-8').write(vector(lava.silhouette_path(0.8, 108), 108, 108))
    open(os.path.join(RES, 'drawable', 'ic_tile.xml'), 'w', encoding='utf-8').write(vector(lava.silhouette_path(1.38, 24), 24, 24))
    print('icons ok')


if __name__ == '__main__':
    main()
