/**
 * 生成「专题」四个模板文件（§3 品鉴体系 / §4 前中后段 / §5 转化方向 / §6 价格体系）。
 *
 * 为什么用脚本而不是直接塞进 knowledge.json：
 * 这些文件里**没有任何茶叶事实**，只有结构和提示 —— 括号里的字全部来自用户自己给的框架。
 * 知识库是内容源头，不该被占位文本污染；模板放在素材库文件夹里，用户填完再导入。
 *
 * 已存在且用户填过内容的文件不会被覆盖（除非加 --force）。
 *
 * 用法：node scripts/kb-seed-topics.mjs [--force]
 */
import fs from 'node:fs';
import path from 'node:path';
import { kbDir } from '../server/lib/kb-file.mjs';

const force = process.argv.includes('--force');
const dir = path.join(kbDir(), '专题');
fs.mkdirSync(dir, { recursive: true });

/** 结构来自用户给的框架；括号内是「该填什么」的提示，不是内容 */
const TOPICS = [
  {
    name: '风味轮',
    category: '品鉴',
    summary: '把「香、甜、回甘」拆成一套能对着讲的体系。',
    points: [
      '香气: （干茶香 / 杯底香 / 汤香 / 叶底香 —— 四个位置分别是什么）',
      '汤色: （新茶什么颜色，随陈化怎么变）',
      '滋味: （苦、涩、甜、鲜、醇、厚、滑 —— 各自的强弱与先后）',
      '口感: （回甘、生津、喉韵、体感、耐泡度）',
      '叶底: （匀整度、活性、柔韧度）',
    ],
    cautions: [],
  },
  {
    name: '前中后段',
    category: '冲泡',
    summary: '先定义冲泡参数，否则前中后段没有可比性。',
    points: [
      '冲泡参数: （器皿 / 水温 / 投茶比 / 出汤时间 —— 先定死这个）',
      '前段（1—3泡）: （香气、鲜爽、苦底、冲击力）',
      '中段（4—8泡）: （滋味饱满度、层次、回甘生津、喉韵）',
      '后段（9泡以后）: （甜水、木香、尾水厚度、耐泡度）',
      '不同冲泡方式对比: （同一款茶，教观众怎么泡）',
    ],
    cautions: [],
  },
  {
    name: '转化方向',
    category: '转化',
    summary: '按时间轴讲可能的走向 —— 只能讲趋势，不能承诺。',
    points: [
      '1—3年: （青味退，香气高扬，汤感偏鲜爽）',
      '3—5年: （苦涩下降，汤感转醇，陈香初显）',
      '5—10年: （胶质感增强，木香、药香、陈香出现）',
      '10年以上: （看仓储和原料底子）',
      '昆明仓 / 广东仓 / 北方仓: （三地转化差异）',
    ],
    cautions: ['转化方向只能讲「可能趋势」，不能说成必然', '必须补上：发霉、异味、湿仓风险'],
  },
  {
    name: '价格体系',
    category: '价格',
    summary: '「标准纯料春茶价格」很难标准，改成「参考行情区间」。',
    points: [
      '价格构成: （鲜叶价 → 毛茶价 → 压饼包装 → 仓储 → 品牌运营 → 渠道利润，每一环大概占多少）',
      '出成率: （约 4—4.5 斤鲜叶做 1 斤毛茶；357g 饼约需 0.75 斤毛茶，加损耗）',
      '影响价格的因素: （山头、村寨、地块、树龄、春茶/秋茶、头采/二采、纯料/拼配、工艺、品牌、渠道）',
      '小树 / 大树 / 古树 / 混采参考区间: （各写一个区间，不要写「绝对标准价」）',
      '为什么同山头价格差几倍: （外围茶、拼配茶、小树充古树）',
    ],
    cautions: ['只写「参考区间」，不要写「绝对标准价」'],
  },
];

let created = 0;
let skipped = 0;
for (const t of TOPICS) {
  const file = path.join(dir, `${t.name}.md`);
  if (fs.existsSync(file) && !force) {
    skipped++;
    continue;
  }
  const lines = [`# ${t.name}`, '', `分类: ${t.category}`, `一句话: ${t.summary}`, ''];
  if (t.points.length) {
    lines.push('要点:');
    for (const p of t.points) lines.push(`- ${p}`);
  }
  if (t.cautions.length) {
    lines.push('注意:');
    for (const c of t.cautions) lines.push(`- ${c}`);
  }
  lines.push('', '---', '', '## 详情', '', '（这一章要讲透的东西。写你真正讲得出来的，不用凑字数。）', '');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  created++;
}

console.log(`专题模板：新建 ${created} 个，跳过已存在 ${skipped} 个 → ${dir}`);
if (skipped) console.log('（加 --force 可覆盖重写；注意会清掉你已填的内容）');
