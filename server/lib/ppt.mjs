/**
 * PPT 导出桥：Node 侧把 DeckSpec 落盘 → 调用 python-pptx 渲染 → 回收结果。
 * Python 解释器自动探测，优先用 DSH 运行时自带的那个。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PIPELINE_DIR, decksDir, pptxOut, scriptOut, ensureDir, ROOT } from './paths.mjs';
import { readJson } from './store.mjs';

let cachedPython = null;
let cachedProbe = null;

/**
 * 异步跑一个子进程并把输出收集回来（形状对齐 spawnSync 的返回值）。
 * 不阻塞事件循环 —— 这一点在 DSH 宿主里很关键。
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<{status:number, stdout:string, stderr:string, error?:Error}>}
 */
function run(cmd, args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (error) {
      resolve({ status: -1, stdout: '', stderr: '', error });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 进程已退出 */
      }
      finish({ status: -1, stdout, stderr: stderr + `\n超时（${timeoutMs}ms）` });
    }, timeoutMs);

    child.stdout?.on('data', (c) => (stdout += c.toString('utf8')));
    child.stderr?.on('data', (c) => (stderr += c.toString('utf8')));
    child.on('error', (error) => finish({ status: -1, stdout, stderr, error }));
    child.on('close', (code) => finish({ status: code ?? -1, stdout, stderr }));
  });
}

function candidateInterpreters() {
  const list = [];
  if (process.env.PUER_PYTHON) list.push(process.env.PUER_PYTHON);

  const settings = readJson('settings.json', {}) || {};
  if (settings.pythonPath) list.push(settings.pythonPath);

  // DSH 运行时自带的 python（路径含版本号，动态扫描）
  const home = os.homedir();
  const runtimeRoot = path.join(home, '.dsh', 'dsh-runtimes');
  for (const root of [runtimeRoot, path.join(home, 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'runtime')]) {
    try {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        for (const rel of [
          ['dependencies', 'python', 'python.exe'],
          ['primary-runtime', 'dependencies', 'python', 'python.exe'],
          ['dependencies', 'python', 'bin', 'python3'],
        ]) {
          const p = path.join(root, entry.name, ...rel);
          if (fs.existsSync(p)) list.push(p);
        }
      }
    } catch {
      /* 忽略扫描失败 */
    }
  }

  list.push('python', 'python3', 'py');
  return [...new Set(list.filter(Boolean))];
}

export function findPython() {
  if (cachedPython) return cachedPython;
  for (const exe of candidateInterpreters()) {
    const probe = spawnSync(exe, ['-c', 'import pptx,sys;print(pptx.__version__)'], {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
    if (probe.status === 0 && !probe.error) {
      cachedPython = { exe, pptxVersion: (probe.stdout || '').trim() };
      return cachedPython;
    }
  }
  cachedPython = null;
  return null;
}

export function pptStatus() {
  if (cachedProbe) return cachedProbe;
  const py = findPython();
  cachedProbe = py
    ? { ok: true, python: py.exe, pptx: py.pptxVersion }
    : { ok: false, error: '未找到可用的 Python 解释器或 python-pptx' };
  return cachedProbe;
}

export function deckJsonPath(deckId) {
  return path.join(ensureDir(decksDir()), `${deckId}.json`);
}

export function saveDeckSpec(deck) {
  const p = deckJsonPath(deck.id);
  fs.writeFileSync(p, JSON.stringify(deck, null, 2), 'utf8');
  return p;
}

export function loadDeckSpec(deckId) {
  const p = deckJsonPath(deckId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function safeName(s) {
  return String(s || 'deck').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
}

/**
 * 导出 PPTX。返回 { ok, pptxPath, slides, stderr }
 *
 * 用异步 spawn 而不是 spawnSync：工作台现在也跑在 DSH 宿主进程里，
 * spawnSync 会把整个事件循环卡住 —— 渲染一份 PPT 要几秒，
 * 那几秒里 GUI 的全部会话都会僵住。异步化后只影响这一次导出请求。
 */
export async function exportPptx(deck, opts = {}) {
  const py = findPython();
  if (!py) {
    return { ok: false, error: 'PYTHON_UNAVAILABLE', message: '未找到可用的 Python（需要 python-pptx）。可在「设置」里指定 python 路径。' };
  }
  const specPath = saveDeckSpec(deck);
  ensureDir(pptxOut());
  const stamp = new Date().toISOString().slice(0, 10);
  const fileName = `${stamp}_${safeName(deck.meta?.title || deck.id)}_${deck.id.slice(-4)}.pptx`;
  const outPath = path.join(pptxOut(), fileName);

  const script = path.join(PIPELINE_DIR, 'build_pptx.py');
  const res = await run(py.exe, [script, specPath, outPath], opts.timeoutMs ?? 180000);

  if (res.status !== 0 || !fs.existsSync(outPath)) {
    return {
      ok: false,
      error: 'RENDER_FAILED',
      message: (res.stderr || res.stdout || '未知错误').slice(-2000),
    };
  }
  let info = {};
  try {
    info = JSON.parse((res.stdout || '').trim().split('\n').pop());
  } catch {
    /* 忽略 */
  }
  const size = fs.statSync(outPath).size;
  return {
    ok: true,
    pptxPath: outPath,
    relativePath: path.relative(ROOT, outPath).replace(/\\/g, '/'),
    slides: info.slides || deck.slides.length,
    bytes: size,
    stderr: (res.stderr || '').trim(),
  };
}

/** 导出 Markdown 口播稿 + 纯文本提词稿 */
export function exportScript(deck) {
  ensureDir(scriptOut());
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `${stamp}_${safeName(deck.meta?.title || deck.id)}_${deck.id.slice(-4)}`;

  const lines = [];
  lines.push(`# ${deck.meta.title}`);
  lines.push('');
  lines.push(`- 场次类型：${deck.meta.purposeLabel}`);
  lines.push(`- 受众：${deck.meta.audienceLabel}`);
  lines.push(`- 计划时长：${deck.meta.durationMin} 分钟`);
  lines.push(`- 稿子净讲时长：约 ${deck.meta.stats.scriptMinutes} 分钟`);
  lines.push(`- 幻灯片：${deck.meta.stats.slideCount} 页 / 段落：${deck.meta.stats.sectionCount} 段`);
  lines.push(`- 生成时间：${new Date(deck.createdAt).toLocaleString('zh-CN')}`);
  lines.push('');
  if (deck.compliance && deck.compliance.total > 0) {
    lines.push(`> ⚠️ 合规自检：命中 ${deck.compliance.total} 处（高 ${deck.compliance.counts.high} / 中 ${deck.compliance.counts.medium} / 低 ${deck.compliance.counts.low}），导出前请在模块 5 处理。`);
    lines.push('');
  }
  for (const sec of deck.script.sections) {
    lines.push(`## ${sec.title}`);
    lines.push('');
    lines.push(`> 目标：${sec.goal}　|　计划 ${sec.plannedMinutes} 分钟　|　约第 ${Math.round(sec.startSec / 60)} 分钟开始`);
    lines.push('');
    for (const line of sec.lines) {
      lines.push(line.cue ? `**〔${line.cue}〕**${line.text}` : line.text);
      lines.push('');
    }
  }
  const mdPath = path.join(scriptOut(), `${base}.md`);
  fs.writeFileSync(mdPath, lines.join('\n'), 'utf8');

  // 提词器纯文本：一段一行，方便导入外部提词器
  const prompter = deck.script.sections
    .map((sec) => `【${sec.title}】\n` + sec.lines.map((l) => l.text).join('\n'))
    .join('\n\n');
  const txtPath = path.join(scriptOut(), `${base}.txt`);
  fs.writeFileSync(txtPath, prompter, 'utf8');

  return {
    ok: true,
    mdPath,
    txtPath,
    relative: {
      md: path.relative(ROOT, mdPath).replace(/\\/g, '/'),
      txt: path.relative(ROOT, txtPath).replace(/\\/g, '/'),
    },
  };
}
