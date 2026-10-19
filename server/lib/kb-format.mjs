/**
 * 知识库的**可编辑文件格式**：一行一个 `字段: 值`，`---` 之后是自由正文。
 *
 * 为什么不用 JSON 当人工编辑格式：知识和「话术」是两种东西 ——
 * 海拔、树种、价格是要机器读的结构化字段；山场故事、直播间话术是给人看的散文。
 * 塞进同一个 JSON 里，人就没法舒服地写散文了。所以：抬头写字段，下面随便写。
 *
 * 为什么不用 YAML front-matter：缩进、引号、转义、特殊字符都是坑，
 * 对不写代码的人太容易写坏。`字段: 值` 没有这些坑。
 *
 * 导出与导入共用这里的字段映射，所以能保证**往返一致**（导出→导入→数据不变）。
 */

/** 山头字段：中文标签 ↔ 数据键 */
const MOUNTAIN_FIELDS = [
  ['别名', 'alias', 'list'],
  ['产区', 'region', 'scalar'],
  ['片区', 'area', 'scalar'],
  ['村寨', 'village', 'scalar'],
  ['经纬度', 'coordinates', 'scalar'],
  ['海拔', 'altitude', 'scalar'],
  ['树种', 'treeType', 'scalar'],
  ['树龄', 'treeAge', 'scalar'],
  // 「古树/大树/乔木/小树各占多少」——和笼统的树龄不是一回事，溯源页要用
  ['树龄结构', 'treeAgeStructure', 'scalar'],
  ['采摘标准', 'pickStandard', 'scalar'],
  ['土壤', 'soil', 'scalar'],
  // 以下 5 项是「山头档案与工艺」页要的气候/生态信息
  ['气候', 'climate', 'scalar'],
  ['生态', 'ecology', 'scalar'],
  ['伴生植物', 'companionPlants', 'list'],
  ['日照', 'sunlight', 'scalar'],
  ['降水', 'rainfall', 'scalar'],
  // 工艺对滋味的影响是**按山头各不相同**的（杀青轻重、揉捻轻重、晒青程度…），
  // 所以不要通用的「生茶工艺流程图」，而是每个山头自己写。
  // 写法用逐条：`- 杀青偏轻: 苦涩保留更多，前段冲击强`
  ['工艺影响', 'craftEffect', 'list'],
  // 信任与溯源：谁做的、哪一批、有没有检测
  ['初制所', 'factory', 'scalar'],
  ['毛茶编号', 'batchNo', 'scalar'],
  ['检测报告', 'labReport', 'list'],
  ['合作年限', 'partnerYears', 'scalar'],
  ['香气', 'aroma', 'list'],
  ['口感', 'taste', 'list'],
  ['汤色', 'soup', 'scalar'],
  ['叶底', 'leaf', 'scalar'],
  ['价格区间', 'priceRange', 'scalar'],
  ['等级', 'grade', 'scalar'],
  ['常见坑', 'pitfalls', 'list'],
  ['卖点', 'sellingPoints', 'list'],
  ['适合人群', 'audience', 'list'],
  ['冲泡', 'brewTips', 'scalar'],
  ['可信度', 'confidence', 'scalar'],
  ['备注', 'note', 'scalar'],
  // 图片：一行一张，写成 `文件名 | 拍摄时间 · 地点 · 海拔`
  ['图片', 'images', 'list'],
];

/**
 * 正文段落：`---` 之后用 `## 段落名` 分段，各自映射到数据键。
 * 支持多段是因为「山场」和「选料逻辑」是两种内容 ——
 * 前者讲这片地，后者讲你为什么选它、第一次喝到什么、和茶农合作了几年。
 * 塞进一个字段里，页面上就没法分开用。
 */
const MOUNTAIN_BODY = [
  ['山场', 'terroir'],
  ['选料逻辑', 'whyThisPlot'],
  // 历史沿革：茶王树谁命名的、哪年进的村、老照片对应什么年代 ——
  // 既不属于「这片地长什么样」，也不属于「为什么选它」，必须单独有位置。
  ['历史沿革', 'history'],
  ['直播间怎么讲', 'talkTracks'],
];

/** 茶品字段 */
const PRODUCT_FIELDS = [
  ['分类', 'category', 'scalar'],
  ['别名', 'aka', 'list'],
  ['一句话', 'summary', 'scalar'],
  ['要点', 'points', 'list'],
  ['卖点', 'sellingPoints', 'list'],
  ['常见坑', 'pitfalls', 'list'],
  ['冲泡', 'brewTips', 'scalar'],
  ['可信度', 'confidence', 'scalar'],
];

/** 专题字段（品鉴 / 冲泡 / 转化 / 价格体系这四类通用知识，不属于某个山头或某个品类） */
const TOPIC_FIELDS = [
  ['分类', 'category', 'scalar'],
  ['一句话', 'summary', 'scalar'],
  ['要点', 'points', 'list'],
  ['注意', 'cautions', 'list'],
];

const TOPIC_BODY = [
  ['详情', 'details'],
  ['直播间怎么讲', 'talkTracks'],
];

export const FIELD_MAP = {
  mountain: MOUNTAIN_FIELDS,
  product: PRODUCT_FIELDS,
  topic: TOPIC_FIELDS,
};
/** 正文段落表：`## 段落名` → 数据键 */
export const BODY_MAP = {
  mountain: MOUNTAIN_BODY,
  product: [],
  topic: TOPIC_BODY,
};

/**
 * 分隔多个值的写法。
 *
 * ⚠️ 绝对不能用中文逗号「，」或顿号「、」：那是中文散文的句读，
 * 一条卖点里几乎必然出现。实测把「这一口下去苦是很清楚的，但你别急着皱眉」
 * 当成分隔符切成两条 —— 内容直接碎掉。
 * 所以只认两种明确的分隔：` / `（斜杠两侧要有空格）和全角竖线「｜」。
 * 斜杠必须带空格，否则 `5-6g/100ml` 这种也会被切开。
 */
const INLINE_SEP = /\s+\/\s+|\s*｜\s*/;

/** 中文冒号/全角冒号统一成英文冒号 */
const normColon = (s) => s.replace(/[：:﹕]/g, ':');

const labelOf = (type, key) => {
  const f = (FIELD_MAP[type] || []).find((x) => x[1] === key);
  return f ? f[0] : key;
};

/**
 * 由字段名找数据键与类型。中文标签与原始键（如 `audience`）都要能认 ——
 * 否则用原始键写的那行会被当普通文本丢掉，或者列表被当字符串存进去（实测踩过）。
 */
const resolveField = (type, label) => {
  const fields = FIELD_MAP[type] || [];
  const byLabel = fields.find((f) => f[0] === label);
  if (byLabel) return { key: byLabel[1], kind: byLabel[2] };
  const byKey = fields.find((f) => f[1] === label);
  if (byKey) return { key: byKey[1], kind: byKey[2] };
  return null;
};

/** 行内列表为空时，允许用 `- xxx` 逐行写（一条里含 ` / ` 时用这种） */
const BULLET = /^[-*・•]\s+/;

const asList = (v) => {
  if (Array.isArray(v)) return v.filter((x) => x != null && String(x).trim() !== '').map(String);
  if (v == null || String(v).trim() === '') return [];
  return String(v)
    .split(INLINE_SEP)
    .map((s) => s.trim())
    .filter(Boolean);
};

/**
 * 把一条知识对象渲染成可编辑的 .md 文本。
 * @param {'mountain'|'product'} type
 * @param {object} obj
 */
export function renderKbFile(type, obj) {
  const fields = FIELD_MAP[type] || [];
  const lines = [`# ${obj.name || ''}`, ''];

  for (const [label, key, kind] of fields) {
    const v = obj[key];
    if (kind === 'list') {
      const arr = asList(v);
      if (arr.length) lines.push(`${label}: ${arr.join(' / ')}`);
    } else if (v != null && String(v).trim() !== '') {
      lines.push(`${label}: ${String(v).trim()}`);
    }
  }

  // 没被字段表覆盖的键原样保留（不丢数据）
  const bodyKeys = new Set((BODY_MAP[type] || []).map((b) => b[1]));
  const known = new Set(
    fields.map((f) => f[1]).concat([...bodyKeys], ['id', 'name'])
  );
  for (const [k, v] of Object.entries(obj)) {
    if (known.has(k) || v == null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length) lines.push(`${k}: ${v.join(' / ')}`);
    } else if (typeof v !== 'object') {
      lines.push(`${k}: ${String(v)}`);
    }
  }

  lines.push('', '---', '');
  const bodyParts = [];
  for (const [label, key] of BODY_MAP[type] || []) {
    const v = obj[key];
    if (v && String(v).trim()) bodyParts.push(`## ${label}\n\n${String(v).trim()}`);
  }
  if (bodyParts.length) {
    lines.push(bodyParts.join('\n\n'));
  } else if (type === 'topic') {
    lines.push('## 详情');
    lines.push('');
    lines.push('（这一章要讲透的东西。分点写也行，写你真正讲得出来的。）');
  } else {
    lines.push('## 山场');
    lines.push('');
    lines.push('（这片地长什么样、为什么选它、你第一次喝到什么感觉。写你真正知道的。）');
    lines.push('');
    lines.push('## 选料逻辑');
    lines.push('');
    lines.push('（为什么选这块地、和这家茶农合作几年、当初是什么让你决定做它。）');
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 解析一个 .md 知识文件。宽容优先：认不出的行忽略，不报错、不中断整批导入。
 * @param {'mountain'|'product'} type
 * @param {string} text
 * @param {string} [fallbackName] 文件名（抬头没有 # 名字时用它）
 * @returns {{name: string, data: object, warnings: string[]}}
 */
export function parseKbFile(type, text, fallbackName = '') {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const warnings = [];
  const data = {};
  let name = '';
  let bodyLines = [];
  let inBody = false;
  let pendingList = null; // 正在收集 `- xxx` 列表的字段

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // 分界线之后就是正文
    if (!inBody && /^-{3,}$/.test(line)) {
      inBody = true;
      continue;
    }
    if (inBody) {
      // 正文里的二级标题保留
      bodyLines.push(raw);
      continue;
    }
    if (line.startsWith('#')) {
      if (!name) name = line.replace(/^#+\s*/, '').trim();
      continue;
    }
    if (line.startsWith('//') || line.startsWith('>')) continue; // 注释/引用行

    // 「每条一行」写法：`- 一条内容`，跟在 `字段:`（值为空）后面
    if (BULLET.test(line) && pendingList) {
      const item = line.replace(BULLET, '').trim();
      if (item) pendingList.items.push(item);
      continue;
    }

    // 只认行首那个分隔冒号，**不碰值里的冒号**。
    // 之前把整行的中文冒号都规范化，结果正文里的「虚报树龄：」被改成「虚报树龄:」—— 内容被改了。
    const sep = line.match(/^([^：:﹕]{1,24})[：:﹕]/);
    let label;
    let value;
    if (sep) {
      label = sep[1].trim();
      value = line.slice(sep[0].length).trim();
    } else {
      // 容错：`海拔 1700-1900m` 这种漏了冒号也能认（按已知字段名开头匹配）
      const hit = (FIELD_MAP[type] || []).find((f) => line.startsWith(f[0]));
      if (!hit) continue;
      label = hit[0];
      value = line.slice(hit[0].length).trim();
    }
    if (!label) continue;

    const resolved = resolveField(type, label);
    const key = resolved ? resolved.key : label;
    const kind = resolved ? resolved.kind : 'scalar';
    if (kind === 'body') {
      warnings.push(`字段「${label}」应该写在 \`---\` 之后的正文里，已忽略`);
      continue;
    }

    // 值为空且是列表字段 → 期待后面的 `- xxx` 逐行写法
    if (kind === 'list' && !value) {
      data[key] = data[key] || [];
      pendingList = { key, items: data[key] };
      continue;
    }
    if (!value) continue;

    if (kind === 'list') {
      data[key] = (data[key] || []).concat(asList(value));
    } else if (data[key] !== undefined) {
      data[key] = `${data[key]} ${value}`; // 同字段写两次 → 合并，不丢内容
    } else {
      data[key] = value;
    }
  }

  // 正文段落：`## 段落名` 分段，各自进自己的字段。
  // 没有 `##` 时的整段正文归到第一个段落（山场），兼容旧写法。
  const bodies = BODY_MAP[type] || [];
  if (bodies.length) {
    const raw = bodyLines.join('\n').trim();
    if (raw) {
      const byLabel = new Map(bodies.map(([label, key]) => [label, key]));
      const sections = [];
      let cur = null;
      for (const line of bodyLines) {
        const m = line.trim().match(/^##\s+(.+?)\s*$/);
        if (m) {
          cur = { label: m[1].trim(), lines: [] };
          sections.push(cur);
          continue;
        }
        if (!cur) {
          // `---` 之后、第一个 `##` 之前的散文：归到第一段
          if (!sections.length) {
            cur = { label: bodies[0][0], lines: [] };
            sections.push(cur);
          } else continue;
        }
        cur.lines.push(line);
      }
      for (const sec of sections) {
        const text = sec.lines
          .join('\n')
          .split('\n')
          .filter((l) => !/^#\s/.test(l.trim()))
          .join('\n')
          .trim();
        if (!text) continue;
        const key = byLabel.get(sec.label);
        if (key) {
          data[key] = data[key] ? `${data[key]}\n\n${text}` : text;
        } else {
          warnings.push(`正文里有认不出的段落「${sec.label}」，已并进「${bodies[0][0]}」`);
          data[bodies[0][1]] = data[bodies[0][1]] ? `${data[bodies[0][1]]}\n\n${text}` : text;
        }
      }
    }
  }

  const finalName = (name || fallbackName).trim();
  if (!finalName) warnings.push('没有名字（抬头缺 `# 名字`）');
  data.name = finalName;
  return { name: finalName, data, warnings };
}

/** 文件名 → 稳定 id（中文用拼音不现实，用文件名 hash 保证稳定且唯一） */
export function idFromName(name) {
  const ascii = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return (ascii ? `${ascii}-` : '') + h.toString(36);
}

export { labelOf };
