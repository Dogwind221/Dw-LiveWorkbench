/**
 * 批量生成（第 12 周：内容生产效率）。
 *
 * ## 为什么需要它
 *
 * 一场直播备货，主播要同时准备**好几个山头**的方案和口播稿。
 * 一个个点、一遍遍填同样的"目的/受众/风格/时长"，是纯浪费。
 * 批量生成让"选 10 个山头 → 一次出 10 份方案"变成一步。
 *
 * ## 一个刻意的设计：**顺序执行，不并发**
 *
 * `buildDeck` 是确定性的模板引擎，**不走网络、不调模型**，是纯 CPU 计算。
 * 对它并发只会让 CPU 更忙、上下文切换更多，并不会更快 ——
 * 所以这里刻意顺序执行，并在每一步之间让出事件循环，好让进度回调能刷新。
 *
 * 将来如果接入 LLM 来生成（而不是模板填充），才需要引入真正的并发控制
 * （限流 / 令牌桶）。现在加一个"看起来并发其实没用"的参数只会误导。
 *
 * ## 幂等
 *
 * 每份方案保存时带一个 `inputSignature`（输入内容的确定性哈希）。
 * 重跑同一批时，**签名相同的直接跳过**（返回 `skipped: true`），
 * 除非显式 `force: true`。这样"跑一半失败了再跑一次"不会产生一堆重复方案。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { buildDeck } from './deck/build.mjs';
import { decksDir } from './paths.mjs';
import { readJson, writeJson } from './store.mjs';
import { loadKB } from './kb.mjs';

/** 参与签名的输入字段。**只放"会影响产出"的字段**，加一个无关字段就会破坏幂等。 */
const SIGNATURE_FIELDS = [
  'topic', 'productName', 'mountainName', 'type', 'year', 'spec', 'price', 'comparePrice',
  'gift', 'stock', 'purpose', 'audience', 'style', 'durationMin', 'host', 'brand', 'nextTopic', 'seed',
];

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

/** 输入 → 确定性签名（16 位 hex）。同样的输入必须得到同样的签名。 */
export function signatureOf(input = {}) {
  const picked = {};
  for (const k of SIGNATURE_FIELDS) if (input[k] !== undefined) picked[k] = input[k];
  return crypto.createHash('sha256').update(stableStringify(picked), 'utf8').digest('hex').slice(0, 16);
}

/** 知识库里的山头清单（批量生成的默认候选）。 */
export function listMountainChoices() {
  const kb = loadKB();
  return (kb.mountains || []).map((m) => ({
    id: m.id,
    name: m.name,
    region: m.region || '',
    price: m.price ? `${m.price.min}–${m.price.max}` : '',
  }));
}

/** 已有的全部方案（用于幂等跳过）。 */
function listSavedDecks() {
  const dir = decksDir();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    } catch {
      /* 坏文件跳过，不该因为一份坏文件让整批失败 */
    }
  }
  return out;
}

/** 建 签名 → deckId 的索引（同类取最新一份）。 */
function buildSignatureIndex() {
  const idx = new Map();
  for (const d of listSavedDecks()) {
    if (!d.inputSignature || !d.id) continue;
    const prev = idx.get(d.inputSignature);
    if (!prev || String(d.createdAt).localeCompare(String(prev.createdAt)) > 0) {
      idx.set(d.inputSignature, d);
    }
  }
  return idx;
}

/**
 * 跑一批。
 *
 * @param {object} opts
 * @param {Array} opts.items          每项至少给 mountainName / productName 之一，或直接给 input
 * @param {object} [opts.template]    所有项共享的输入（purpose/audience/style/durationMin…）
 * @param {boolean} [opts.force]      强制重跑，不跳过已存在的
 * @param {boolean} [opts.dryRun]     只算签名、不生成（给界面预览"会生成几份、跳过几份"）
 * @param {string}  [opts.tag]        可选标记，会写进每个方案（便于按批次归类或测试清扫）
 * @param {Function} [opts.onProgress] 每完成一项回调一次
 */
export async function runBatch({ items = [], template = {}, force = false, dryRun = false, tag = '', onProgress } = {}) {
  const batchId = `batch_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error('items 不能为空：至少给一个要生成的山头或茶品');
    err.code = 'EMPTY_BATCH';
    throw err;
  }
  if (items.length > 50) {
    const err = new Error('单批最多 50 项（防止一次跑太久、失败时损失太大）');
    err.code = 'BATCH_TOO_LARGE';
    throw err;
  }

  // 注意：dryRun **不能**清空索引 —— 它存在的意义恰恰是"预览会生成几份、跳过几份"。
  // 第一版写成 `force || dryRun ? new Map() : ...`，导致 dryRun 永远报告"全都要生成"，
  // 预检完全失去作用。只有 force 才该绕过已有索引。
  const index = force ? new Map() : buildSignatureIndex();
  const results = [];
  let ok = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < items.length; i++) {
    const raw = items[i] || {};
    // 支持三种写法：{mountainName} / {productName} / {label, input}
    const input = { ...template, ...(raw.input || {}), ...withoutMeta(raw) };
    const label = raw.label || input.mountainName || input.productName || input.topic || `第 ${i + 1} 项`;
    const signature = signatureOf(input);

    try {
      if (!dryRun && index.has(signature)) {
        const hit = index.get(signature);
        skipped++;
        results.push({
          index: i, label, signature, ok: true, skipped: true,
          deckId: hit.id, reason: '输入完全相同，已存在同款方案（加 force:true 可强制重跑）',
        });
        onProgress?.({ index: i, total: items.length, label, status: 'skipped', deckId: hit.id });
        continue;
      }

      if (dryRun) {
        results.push({ index: i, label, signature, ok: true, dryRun: true, wouldSkip: index.has(signature) });
        ok++;
        onProgress?.({ index: i, total: items.length, label, status: 'dry-run' });
        continue;
      }

      const deck = buildDeck(input);
      const saved = {
        ...deck,
        batchId,
        inputSignature: signature,
        ...(tag ? { tag } : {}),
      };
      writeJson(path.join('decks', `${deck.id}.json`), saved);

      /**
       * **静默降级检测。**
       *
       * `buildDeck` 对认不出的字段是忽略的：传 `mountainId` 而不是 `mountainName`，
       * 它不会报错，只会生成一份"没有山场信息"的通用方案 —— 看起来完全正常。
       *
       * 单份生成时这是小问题，**批量 50 份时就是灾难**：50 份都是通用内容，
       * 而每一份都"成功"了。所以这里必须把降级显式记下来。
       */
      const warnings = [];
      const wantedMountain = String(input.mountainName || '').trim();
      if (wantedMountain && !deck.meta?.hasMountain) {
        warnings.push({
          code: 'MOUNTAIN_NOT_FOUND',
          message: `山场「${wantedMountain}」在知识库里没匹配到，这份方案是按通用内容生成的（不是该山头的内容）`,
        });
      }
      if (input.mountainId && !wantedMountain) {
        warnings.push({
          code: 'WRONG_FIELD',
          message: 'buildDeck 认的是 mountainName（山头名称），不是 mountainId；这份方案没有山场信息',
        });
      }

      ok++;
      results.push({
        index: i,
        label,
        signature,
        ok: true,
        deckId: deck.id,
        warnings,
        degraded: warnings.length > 0,
        stats: {
          slides: (deck.slides || []).length,
          scriptChars: deck.meta?.stats?.scriptChars ?? (deck.script?.fullText || '').length,
          scriptMinutes: deck.meta?.stats?.scriptMinutes ?? null,
          complianceLevel: deck.compliance?.level || 'unknown',
          complianceHigh: deck.compliance?.counts?.high ?? 0,
          hasMountain: !!deck.meta?.hasMountain,
        },
      });
      onProgress?.({ index: i, total: items.length, label, status: 'ok', deckId: deck.id, degraded: warnings.length > 0 });
    } catch (err) {
      // **单项失败不能拖垮整批。** 记下来继续跑，最后一起报告。
      failed++;
      results.push({ index: i, label, signature, ok: false, error: err.message, code: err.code || 'BUILD_FAILED' });
      onProgress?.({ index: i, total: items.length, label, status: 'failed', error: err.message });
    }

    // 让出事件循环：否则 50 项会把 HTTP 线程卡住，进度和健康检查都无响应
    await new Promise((r) => setImmediate(r));
  }

  const summary = {
    batchId,
    dryRun: !!dryRun,
    startedAt,
    finishedAt: new Date().toISOString(),
    ms: Date.now() - t0,
    total: items.length,
    ok,
    failed,
    skipped,
    // 有多少份是"静默降级"出来的（山场没匹配上）—— 批量场景下这个数字最该被看见
    degraded: results.filter((r) => r.degraded).length,
    results,
  };

  // 清单落盘：出了问题能追"这一批到底生成了什么"
  if (!dryRun) {
    try {
      writeJson(path.join('decks', `_batch-${batchId}.json`), {
        ...summary,
        template,
        ...(tag ? { tag } : {}),
      });
    } catch {
      /* 清单写失败不该让已生成的方案变成"失败" */
    }
  }
  return summary;
}

/** 从 item 里剥掉元字段，剩下的当作 deck 输入。 */
function withoutMeta(raw) {
  const out = { ...raw };
  delete out.label;
  delete out.input;
  return out;
}
