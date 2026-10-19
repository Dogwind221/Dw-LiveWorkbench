/**
 * 模块 6：直播后复盘 + 切片建议。
 *
 * 输入一场直播的数据与分段记录，输出：
 *   - 派生指标（转化率、千次观看成交、均单、人效）
 *   - 问题诊断（规则引擎，带严重度与改进动作）
 *   - 切片建议（按分段的人数/成交峰值推荐，并给出标题与钩子）
 *   - 下一场行动清单
 */
import { makeCollection, newId } from './store.mjs';

const sessions = makeCollection('sessions.json');

export function listSessions() {
  return sessions.all();
}

export function getSession(id) {
  return sessions.get(id);
}

export function saveSession(input) {
  const id = input.id || newId('sess');
  return sessions.upsert({ ...input, id });
}

export function removeSession(id) {
  return sessions.remove(id);
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

export function deriveMetrics(s) {
  const m = s.metrics || {};
  const avgViewers = n(m.avgViewers);
  const orders = n(m.orders);
  const gmv = n(m.gmv);
  const clicks = n(m.productClicks);
  const durationMin = n(s.durationMin);
  return {
    durationMin,
    peakViewers: n(m.peakViewers),
    avgViewers,
    gmv,
    orders,
    aov: orders ? Math.round((gmv / orders) * 100) / 100 : 0,
    conversionRate: clicks ? Math.round((orders / clicks) * 1000) / 10 : null, // %
    // 口径说明：我们手上是「平均在线人数」（并发），不是累计观看，所以不套用 GPM，
    // 改用人均产出与每小时产出，这两个指标用现有数据算才有意义。
    gmvPerViewer: avgViewers ? Math.round((gmv / avgViewers) * 100) / 100 : 0,
    gmvPerHour: durationMin ? Math.round((gmv / (durationMin / 60)) * 100) / 100 : 0,
    newFollowers: n(m.newFollowers),
    comments: n(m.comments),
    likes: n(m.likes),
    clickRate: avgViewers ? Math.round((clicks / avgViewers) * 1000) / 10 : null,
    ordersPerMinute: durationMin ? Math.round((orders / durationMin) * 100) / 100 : 0,
    peakToAvgRatio: avgViewers ? Math.round((n(m.peakViewers) / avgViewers) * 100) / 100 : 0,
  };
}

const RULES = [
  {
    id: 'low-retention',
    when: (d, s) => d.peakViewers > 0 && d.peakToAvgRatio > 1.8,
    severity: 'medium',
    title: '人数峰值与均值差距偏大',
    detail: (d) => `峰值 ${d.peakViewers} 是均值 ${d.avgViewers} 的 ${d.peakToAvgRatio} 倍，说明流量进来了但没留住。`,
    action: '把峰值时段的讲法固化成脚本，同时检查前 90 秒的钩子是否足够具体。',
  },
  {
    id: 'no-peak',
    when: (d) => d.peakViewers > 0 && d.peakToAvgRatio < 1.3 && d.durationMin >= 30,
    severity: 'low',
    title: '全程人数平稳，缺少爆发点',
    detail: () => '没有明显峰值，说明缺少强钩子或福利节点。',
    action: '在开场、上链接前、福袋节点各设计一个明确的「留人理由」。',
  },
  {
    id: 'low-conversion',
    when: (d) => d.conversionRate !== null && d.conversionRate < 3,
    severity: 'high',
    title: '点击到下单转化偏低',
    detail: (d) => `转化率 ${d.conversionRate}%，低于常见区间（3%-8%）。`,
    action: '检查价格锚点是否讲清、库存与售后是否交代、下单步骤是否复述过。',
  },
  {
    id: 'few-clicks',
    when: (d) => d.clickRate !== null && d.clickRate < 10 && d.avgViewers > 0,
    severity: 'medium',
    title: '商品点击率偏低',
    detail: (d) => `点击率 ${d.clickRate}%，说明引导不够或链接露出不足。`,
    action: '每小时至少 3 次明确指向购物车，并用「每泡成本」把价格落地。',
  },
  {
    id: 'low-aov',
    when: (d, s) => d.aov > 0 && d.aov < 150 && (s.products || []).some((p) => n(p.price) > 500),
    severity: 'medium',
    title: '客单价低于产品结构应有的水平',
    detail: (d) => `均单 ${d.aov} 元，但场内有高单价产品，说明高价款没讲透。`,
    action: '给高价款单独留出讲解段落，用原料、树龄、批次凭证支撑价格。',
  },
  {
    id: 'no-followers',
    when: (d) => d.newFollowers >= 0 && d.newFollowers < 5 && d.durationMin >= 60,
    severity: 'low',
    title: '新关注增长偏少',
    detail: (d) => `新增关注 ${d.newFollowers}，长场次下偏低。`,
    action: '在每段结尾加一次关注引导，并说明「下一场讲什么」给出关注理由。',
  },
  {
    id: 'short-duration',
    when: (s) => n(s.durationMin) > 0 && n(s.durationMin) < 30,
    severity: 'low',
    title: '场次时长偏短',
    detail: (s) => `本场 ${s.durationMin} 分钟，短场次不利于自然流量累积。`,
    action: '把节奏拉到 45-90 分钟，用互动环节填充而不是硬讲产品。',
  },
  {
    id: 'low-comment',
    when: (d) => d.avgViewers > 50 && d.comments / Math.max(d.durationMin, 1) < 1,
    severity: 'medium',
    title: '互动密度不足',
    detail: (d, s) => `每分钟弹幕不足 1 条（本场 ${d.comments} 条 / ${s.durationMin} 分钟）。`,
    action: '每 10 分钟抛一个具体问题（不要问「在不在」），并把回答念出来。',
  },
];

export function diagnose(session) {
  const d = deriveMetrics(session);
  const issues = [];
  for (const r of RULES) {
    try {
      if (r.when(d, session)) {
        issues.push({
          id: r.id,
          severity: r.severity,
          title: r.title,
          detail: r.detail(d, session),
          action: r.action,
        });
      }
    } catch {
      /* 规则异常不影响整体 */
    }
  }
  const order = { high: 3, medium: 2, low: 1 };
  issues.sort((a, b) => order[b.severity] - order[a.severity]);
  return { metrics: d, issues };
}

/** 切片建议：优先取「人数峰值 + 成交」双高的分段。 */
export function suggestClips(session, limit = 6) {
  const segments = session.segments || [];
  if (!segments.length) {
    return {
      clips: [],
      hint: '没有分段记录。下次直播时在关键节点打点（上链接、福利、高光讲解），复盘时就能直接生成切片。',
    };
  }
  const maxViewers = Math.max(...segments.map((x) => n(x.viewers)), 1);
  const maxOrders = Math.max(...segments.map((x) => n(x.orders)), 1);
  const clips = segments
    .map((seg) => {
      const vScore = n(seg.viewers) / maxViewers;
      const oScore = n(seg.orders) / maxOrders;
      const score = Math.round((vScore * 0.6 + oScore * 0.4) * 100);
      const label = seg.label || '未命名段落';
      return {
        startAt: seg.t || '',
        label,
        viewers: n(seg.viewers),
        orders: n(seg.orders),
        score,
        // 切片标题：直播切片靠标题抢流量，所以给具体、有信息的标题
        title: `${label}：${seg.note || '这段讲得最实'}`,
        hook: seg.note || `很多人问${label}，我一次讲清楚`,
        platform: vScore > 0.8 ? '抖音 / 视频号（高流量段）' : '小红书（知识向）',
        advise: oScore > 0.6 ? '这段有成交，切片结尾保留下单引导' : '这段偏内容，切片结尾改成关注引导',
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { clips, hint: '' };
}

/** 下一场行动清单：把诊断结论转成可执行条目。 */
export function nextActions(session, diag) {
  const base = [
    '开场 90 秒内说清「今晚讲什么、为什么值得留下、什么时候上链接」',
    '每个产品段落结尾复述一次下单步骤与售后政策',
    '每 10 分钟抛一个具体互动问题，并念出 2-3 条弹幕回答',
    '上链接前先讲价格锚点（日常价 / 今晚价 / 每泡成本）',
    '准备 2 个互动环节用于填补空档（答疑、冲泡演示）',
  ];
  const extra = diag.issues.map((i) => i.action);
  const seen = new Set();
  const merged = [];
  for (const a of [...extra, ...base]) {
    if (seen.has(a)) continue;
    seen.add(a);
    merged.push(a);
  }
  return merged.slice(0, 8);
}

export function reviewSession(session) {
  const diag = diagnose(session);
  const clips = suggestClips(session);
  const actions = nextActions(session, diag);
  const penalty = diag.issues.reduce((s, i) => s + ({ high: 18, medium: 9, low: 4 }[i.severity] || 0), 0);
  const score = Math.max(30, Math.min(100, 100 - penalty));
  return {
    metrics: diag.metrics,
    issues: diag.issues,
    clips: clips.clips,
    clipHint: clips.hint,
    actions,
    score,
    grade: score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : 'D',
  };
}
