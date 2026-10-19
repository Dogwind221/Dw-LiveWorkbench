# -*- coding: utf-8 -*-
"""
页面墨迹检查：截图的像素级验收。

为什么需要：DOM 层面的验收查不出「元素在 DOM 里齐全、位置也对，但就是没被画出来」
这类 bug。实测踩过一次 —— 某方向第 2 页整页空白，而 DOM 里有 75 个文本节点、
getBoundingClientRect 也在视口内，audit-demo.mjs 全绿放行。
只有看像素才能发现：那一页根本没有墨迹。

用法：python ppt-lab/ink-check.py <png> [<png> ...]
"""
import sys
import os
import json
from collections import Counter

from PIL import Image

# 判空只看**中央区域**的墨迹。
#
# 为什么不用整页墨迹比例：深色页 + 居中几行字（例如结语页）整页墨迹可能只有 0.8%，
# 用「整页 < 1.2%」判定会把正常页误报成空白（实测踩过）。
# 而真正的空白页，中央区域是干净的 —— 角落的页码/提示条不该算内容。
CENTER_X = (0.20, 0.80)
CENTER_Y = (0.15, 0.85)
CENTER_INK_FLOOR = 0.0035   # 中央区域墨迹低于 0.35% 视为空白


def measure(path):
    im = Image.open(path).convert("RGB")
    full = im.copy()
    im.thumbnail((640, 640))  # 缩样即可，判定空不空不需要全分辨率
    W, H = im.size
    px = im.load()
    n = W * H

    counts = Counter(im.getdata())
    bg, _ = counts.most_common(1)[0]

    def ink_in(x0, x1, y0, y1):
        hit = tot = 0
        for y in range(int(y0 * H), int(y1 * H)):
            for x in range(int(x0 * W), int(x1 * W)):
                r, g, b = px[x, y]
                tot += 1
                if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > 30:
                    hit += 1
        return hit / max(1, tot)

    ink_all = ink_in(0, 1, 0, 1)
    ink_center = ink_in(*CENTER_X, *CENTER_Y)
    distinct = len(counts)

    return {
        "file": os.path.basename(path),
        "size": os.path.getsize(path),
        "w": full.width,
        "h": full.height,
        "bg": "#%02X%02X%02X" % bg,
        "inkRatio": round(ink_all, 4),
        "inkCenter": round(ink_center, 4),
        "distinctColors": distinct,
        "blank": ink_center < CENTER_INK_FLOOR,
    }


def main():
    paths = sys.argv[1:]
    if not paths:
        print("用法: python ink-check.py <png> [<png> ...]", file=sys.stderr)
        return 2

    rows = []
    for p in paths:
        if not os.path.exists(p):
            rows.append({"file": p, "error": "不存在"})
            continue
        try:
            rows.append(measure(p))
        except Exception as e:
            rows.append({"file": os.path.basename(p), "error": "%s: %s" % (type(e).__name__, e)})

    blanks = [r for r in rows if r.get("blank")]
    for r in rows:
        if r.get("error"):
            print("  [ERR ] %s  %s" % (r["file"], r["error"]))
        else:
            flag = "[空白]" if r["blank"] else "[有内容]"
            print("  %s %-30s 中央墨迹 %6.3f%%  整页 %5.2f%%  色数 %4d  %6.1f KB  %dx%d  底色 %s"
                  % (flag, r["file"], r["inkCenter"] * 100, r["inkRatio"] * 100, r["distinctColors"],
                     r["size"] / 1024, r["w"], r["h"], r["bg"]))

    print(json.dumps({"checked": len(rows), "blank": [r["file"] for r in blanks]}, ensure_ascii=False))
    return 1 if blanks else 0


if __name__ == "__main__":
    sys.exit(main())
