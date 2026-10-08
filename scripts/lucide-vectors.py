"""把 lucide 图标（ISC 许可，与网页界面同一套）转成安卓 VectorDrawable，给原生的悬浮面板、小胶囊用。
用法：python scripts/lucide-vectors.py   （读 node_modules/lucide-react，写 android/app/src/main/res/drawable/ic_lc_*.xml）
"""
import os
import re

ROOT = os.path.join(os.path.dirname(__file__), '..')
SRC = os.path.join(ROOT, 'node_modules', 'lucide-react', 'dist', 'esm', 'icons')
OUT = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res', 'drawable')
ICONS = {
    'languages': 'translate',
    'message-square-reply': 'reply',
    'settings-2': 'settings',
    'x': 'close',
    'eye': 'compare',
}


def attrs(block):
    return dict(re.findall(r'(\w+): "([^"]*)"', block))


def to_path(kind, a):
    if kind == 'path':
        return a['d']
    if kind == 'circle':
        cx, cy, r = float(a['cx']), float(a['cy']), float(a['r'])
        return f'M{cx - r},{cy} a{r},{r} 0 1,0 {2 * r},0 a{r},{r} 0 1,0 {-2 * r},0'
    if kind == 'line':
        return f"M{a['x1']},{a['y1']} L{a['x2']},{a['y2']}"
    raise ValueError(kind)


for name, short in ICONS.items():
    src = open(os.path.join(SRC, name + '.mjs'), encoding='utf-8').read()
    node = src[src.index('node: [') : src.index('};')]
    paths = [to_path(kind, attrs(body)) for kind, body in re.findall(r'\[\s*"(\w+)",\s*\{([^}]*)\}', node)]
    body = '\n'.join(
        f'    <path\n        android:pathData="{d}"\n        android:strokeWidth="2"\n        android:strokeColor="#FFFFFFFF"\n'
        f'        android:strokeLineCap="round"\n        android:strokeLineJoin="round" />'
        for d in paths
    )
    xml = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        f'<!-- 由 scripts/lucide-vectors.py 从 lucide「{name}」生成（ISC 许可） -->\n'
        '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
        '    android:width="24dp"\n    android:height="24dp"\n    android:viewportWidth="24"\n    android:viewportHeight="24">\n'
        f'{body}\n</vector>\n'
    )
    open(os.path.join(OUT, f'ic_lc_{short}.xml'), 'w', encoding='utf-8', newline='\n').write(xml)
    print('ic_lc_' + short, len(paths), 'paths')
