# 视觉风格模块契约

工作台的「视觉风格」是一个**渲染期选择**，不写进 DeckSpec。DeckSpec 只描述内容，
风格模块负责把同一份内容渲染成不同视觉语言。

```
DeckSpec(JSON)  ──►  server/lib/deck/html/<style>.mjs  ──►  单文件 HTML（可离线双击打开）
```

## 一、模块必须导出什么

```js
// server/lib/deck/html/magazine.mjs
export const meta = {
  id: 'magazine',                        // 稳定 id，UI 与 API 用它
  label: '电子杂志 × 电子墨水',            // UI 上显示的名字
  desc: '衬线大字 + 暖白纸感，山林人文调',   // 一句话说明，UI 显示
  source: 'guizang-ppt-skill 风格 A · 森林墨',  // 出处（显示在 UI 上，诚实标注）
  swatches: ['#1a2e1f', '#f5f1e8', '#b98a3c'],  // 3 个代表色，UI 画色块
  darkHint: false,                        // 深色底时把右下角提示条改成深色态
};

export const css = `/* 该风格的样式，会被内联进单文件 HTML */`;

export function slide(s, ctx) {
  // 返回**一页**的 <section>，不含 <html>/<body> 外壳
  return `<section class="slide" data-slide-id="${s.id}" data-type="${s.type}">…</section>`;
}
```

- `css` 与 `slide()` 之外的舞台/翻页/缩放/打印**一律由 `shell.mjs` 提供**，风格不要重写。
- 风格可以给 `.slide` 加自己的 class（如 `slide light` / `slide void`），用于明暗节奏。

## 二、`slide(s, ctx)` 拿到的数据

`s` = 一页的 DeckSpec。**所有页字段集合一致**（不存在的字段是 `[]` / `''` / `null`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 稳定 id，用于 `data-slide-id` 和备注锚点 |
| `index` | number | 第几页（从 1 起） |
| `type` | string | 版式类型，见下表 |
| `kicker` | string | 页眉小标签。**空串 = 这页不要小标签**（不要回退成别的文字） |
| `title` | string | 主标题 |
| `subtitle` | string | 副标题 |
| `bullets` | string[] | 要点 |
| `cards` | `{title, desc}[]` | 卡片 |
| `steps` | `{title, desc}[]` | 步骤 |
| `faq` | `{q, a}[]` | 问答 |
| `table` | `{rows: [string, string][]}` | 清单（标签 / 值 两列） |
| `left` / `right` | `{title, items: string[]}` | 对比两侧 |
| `quote` | string | 金句 / 结论条 |
| `price` / `comparePrice` | string | 价格 / 划线价 |
| `anchors` | `{label, value}[]` | 价格锚点 |
| `meta` | string[] | 封面底部元信息 |
| `footnote` | string | 页脚注 |
| `sectionTitle` | string | 所属段落名（页脚左侧常用） |
| `productName` | string | 本页对应茶品名（多款场次时用来区分） |
| `script` | `{text, cue?}[]` | 该页口播稿 —— 产出到 HTML 的 `data-notes`，不显示在页面上 |

`ctx` = `{ deck, style, mode, total }`。`deck.meta` 里有 `title / host / brand / date / durationMin` 等。

### 必须支持的 `type`

`cover` `hook` `points` `cards` `table` `compare` `steps` `faq` `price` `product` `tasting` `cta` `end`

- `hook` / `tasting` 用卡片结构；`points` 用要点结构；`product` 是「左要点 + 右清单」。
- **未知 type 要有兜底**（按「有 cards 用卡片 / 有 table 用清单 / 否则用要点」挑），
  绝不能渲染成空白页 —— 历史存档里会有旧类型。

## 三、硬约束

1. **单文件、离线可开**：不引用任何外链（字体、图片、JS、CSS 全不联网）。
   中文字体栈必须有 `"Microsoft YaHei UI"` / `"Noto Sans SC"` 这类 Windows 兜底，
   没有苹方也不能掉进默认衬线错乱。
2. **固定 1920×1080 画布**：所有尺寸用 `cqw` / `cqh` / `em`（相对 `.page` 的基准字号），
   不要用 `px` 写死尺寸、不要用 `vw`/`vh`（舞台是 letterbox 的，vw 会算错）。
   > 基准字号由外壳设在 `.slide > *` 上（`1.05cqw ≈ 20px @1920`）。
   > **不要把 `cqw` 写在 `.slide` 自己身上** —— 那样解析到的是外层/视口，不是舞台。
3. **可读性下限（直播投屏，不可突破）**：正文 ≥20px、卡片描述/列表 ≥18px、标签注释 ≥14px
   （按 1920 设计尺寸算，即 ≥1.05em / ≥0.94em / ≥0.71em）。对比度 ≥4.5:1。
4. **页面本身不带页码 / 进度标记**：页码由外壳的圆点承载。
5. **装饰性出血的元素必须加 `class="deco"`**（同时加 `aria-hidden="true"`）。
   例如封面的幽灵大年份、超出画布的纹样。原因：转 PPTX 时这类元素会变成真的文本框并
   **越出画布**（实测一个 22em 的幽灵年份到 2322pt > 1920），转换管线用
   `--skip-class deco` 跳过它们；验收脚本也会跳过它们不判越界。
   注意：**真正承载信息的文字不要标 deco**（例如封面元信息之间的分隔点要保留，
   否则转出来会粘成一串）。
6. **不要图片**：用排版、字体、网格、色块建立视觉。结构确实需要图片位就留**诚实占位**
   （明确色块 + 文字说明），**不要用 SVG 手画茶叶/山水/人物冒充照片**。
7. **反 AI slop**：不要紫蓝渐变、不要均匀深蓝底+霓虹 glow、不要 emoji 当图标、
   不要「圆角卡片 + 左侧彩色 border accent」、不要每个标题配装饰 icon、
   不要编造数据/评价/销量。
8. **中文引号用「」不用 ""**。
9. **转 PPTX 友好的两条经验**（不做会被验收拦下）：
   - 绝对定位的横条（页脚、封面元信息）不要用 `left:0;right:0` 横跨整页，
     要与 `.page` 的左右内边距对齐（`left:6.4cqw;right:6.4cqw`），否则转出的文本框
     宽度会超出画布（实测 1932pt > 1920）。
   - 同一行里靠 flex `gap` 拉开的多段文字，转 PPTX 后会合并成一个文本框、间隙丢失。
     要么用可见分隔符（`·`），要么拆成结构上独立的两块。

## 四、自检

```powershell
node scripts/style-smoke.mjs           # 三风格各渲染一份真方案 + 结构/字号/对比度/像素检查
```

该脚本会：用真实 DeckSpec 渲染三份 HTML → 单页截图 → 检查**每页都有墨迹**（不是空白页）、
字号下限、对比度、越界、emoji、JS 报错。提交前必须全绿。
