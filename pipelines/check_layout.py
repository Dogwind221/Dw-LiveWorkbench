#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
版式越界检查：打开 .pptx，逐页报告超出画布或异常大小的形状。

用法：
    python check_layout.py <out.pptx> [--json]

python-pptx 只能拿到形状框，不能判断文字是否溢出框内，
但「形状跑出画布」这一类问题（最常见、最影响观感）能可靠发现。
"""
import json
import sys
import os
from pptx import Presentation
from pptx.util import Emu

TOL = 0.02  # 英寸容差


def inches(v):
    return None if v is None else v / 914400.0


def check(path):
    prs = Presentation(path)
    sw = inches(prs.slide_width)
    sh = inches(prs.slide_height)
    report = {"file": os.path.abspath(path), "slideWidth": round(sw, 3), "slideHeight": round(sh, 3), "slides": []}

    for i, slide in enumerate(prs.slides, 1):
        problems = []
        counts = {}
        for shape in slide.shapes:
            counts[shape.shape_type] = counts.get(shape.shape_type, 0) + 1
            try:
                l = inches(shape.left)
                t = inches(shape.top)
                w = inches(shape.width)
                h = inches(shape.height)
            except Exception:
                continue
            if l is None or t is None or w is None or h is None:
                continue
            name = shape.name
            # 以 `deco ` 命名的形状是刻意的装饰出血（封面纹样、引导线等），
            # 不参与越界判定；这样检查器不用靠猜页码或猜有没有文字。
            if (name or "").lower().startswith("deco"):
                continue
            text = (shape.text_frame.text[:26].replace("\n", " ") if shape.has_text_frame else "")
            if l < -TOL:
                problems.append({"shape": name, "issue": "超出左边界", "left": round(l, 3), "text": text})
            if t < -TOL:
                problems.append({"shape": name, "issue": "超出上边界", "top": round(t, 3), "text": text})
            if l + w > sw + TOL:
                problems.append({"shape": name, "issue": "超出右边界", "right": round(l + w, 3), "limit": round(sw, 3), "text": text})
            if t + h > sh + TOL:
                problems.append({"shape": name, "issue": "超出下边界", "bottom": round(t + h, 3), "limit": round(sh, 3), "text": text})

        report["slides"].append({"page": i, "shapes": len(slide.shapes), "problems": problems})

    total = sum(len(s["problems"]) for s in report["slides"])
    report["totalProblems"] = total
    report["badPages"] = [s["page"] for s in report["slides"] if s["problems"]]
    return report


def main():
    if len(sys.argv) < 2:
        print("usage: check_layout.py <out.pptx> [--json]", file=sys.stderr)
        return 2
    rep = check(sys.argv[1])
    if "--json" in sys.argv:
        print(json.dumps(rep, ensure_ascii=False, indent=1))
        return 0
    print(f"文件：{rep['file']}")
    print(f"画布：{rep['slideWidth']} x {rep['slideHeight']} 英寸，共 {len(rep['slides'])} 页")
    if rep["totalProblems"] == 0:
        print("版式检查：所有形状都在画布内 ✅")
    else:
        print(f"版式检查：发现 {rep['totalProblems']} 处越界，涉及页面 {rep['badPages']}")
        for s in rep["slides"]:
            for p in s["problems"]:
                print(f"  第{s['page']}页 {p['issue']}: {p['shape']} {p} 文本「{p.get('text','')}」")
    return 0


if __name__ == "__main__":
    sys.exit(main())
