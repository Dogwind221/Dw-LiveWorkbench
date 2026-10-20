/* ==========================================================================
   普洱茶直播工作台 —— 前端逻辑
   零依赖，纯原生 DOM。六个模块 + 全屏提词器。
   ========================================================================== */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) =>
    String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const toast = (msg, isErr) => {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => (t.className = 'toast'), isErr ? 5200 : 2600);
  };

  async function api(pathname, opts = {}) {
    const res = await fetch(pathname, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
    return data;
  }

  const fmtMin = (m) => (m >= 1 ? `${Math.round(m * 10) / 10} 分钟` : `${Math.round(m * 60)} 秒`);

  const state = {
    module: 'intel',
    options: null,
    kb: null,
    kbTab: 'mountains',
    kbKind: 'mountains',
    kbSelected: null,
    kbQuery: '',
    deck: null,
    deckTab: 'slides',
    decks: [],
    intel: { items: [], stats: {}, sources: [], topics: [] },
    qa: { question: '', result: null, items: [], intents: [], faq: [] },
    review: { sessions: [], current: null, reviewData: null },
  };

  /* ---------------------------------------------------------------- 导航 */
  /**
   * 侧栏模块清单。
   *
   * `num` 就是「从上到下第几个」——**必须和数组顺序一致**。
   * 早期编号沿用了历史模块号，侧栏显示成 1、2、7、8、4…，很难指代"第几个模块"。
   * 想调整顺序：改数组顺序，然后按位置重排 num。
   */
  const MODULES = [
    { id: 'deck', num: '1', name: 'PPT + 口播稿生成', sub: '选题 → 大纲 → 幻灯片 → 逐字稿 → 导出' },
    { id: 'kb', num: '2', name: '山头 / 茶品知识库', sub: '直播内容的底座，可自行完善' },
    { id: 'rag', num: '3', name: 'AI 知识库问答（RAG）', sub: '检索知识库后回答，每句都带出处' },
    { id: 'agent', num: '4', name: 'AI 助手（Agent 编排）', sub: '你说要什么，它自己决定调哪些工具' },
    { id: 'qa', num: '5', name: '提词器 + 弹幕问答', sub: '开着提词器播，边播边答' },
    { id: 'compliance', num: '6', name: '合规违禁词检查', sub: '广告法与平台规则兜底' },
    { id: 'review', num: '7', name: '复盘 + 切片建议', sub: '看完数据，知道下一场改什么' },
    { id: 'intel', num: '8', name: '今日情报采集', sub: '抓取与整理素材，转成可直播的选题' },
    { id: 'batch', num: '9', name: '批量生成方案', sub: '勾多个山头，一次出多份方案与口播稿' },
    { id: 'variants', num: '10', name: 'A/B 方案对比', sub: '同一款茶几种讲法，看着指标选' },
  ];

  function renderNav() {
    $('#nav').innerHTML = MODULES.map(
      (m) => `<button class="nav-item${state.module === m.id ? ' active' : ''}" data-nav="${m.id}">
        <span class="num">${m.num}</span><span>${esc(m.name)}</span>${
          m.id === 'deck' && state.deck ? '<span class="badge">已生成</span>' : ''
        }</button>`
    ).join('');
    const mod = MODULES.find((m) => m.id === state.module);
    $('#pageTitle').textContent = mod.name;
    $('#pageSub').textContent = mod.sub;
  }

  async function goto(id) {
    state.module = id;
    renderNav();
    $('#topActions').innerHTML = '';
    const view = $('#view');
    view.innerHTML = '<div class="empty">加载中…</div>';
    try {
      if (id === 'intel') await renderIntel();
      else if (id === 'kb') await renderKB();
      else if (id === 'rag') await renderRagAsk();
      else if (id === 'deck') await renderDeckModule();
      else if (id === 'qa') await renderQA();
      else if (id === 'compliance') await renderCompliance();
      else if (id === 'review') await renderReview();
      else if (id === 'agent') await renderAgent();
      else if (id === 'batch') await renderBatch();
      else if (id === 'variants') await renderVariants();
    } catch (err) {
      view.innerHTML = `<div class="card"><h3>加载失败</h3><p class="hint">${esc(err.message)}</p></div>`;
    }
  }

  /* ================================================================ 模块1 */
  async function renderIntel() {
    const data = await api('api/intel');
    state.intel.items = data.items;
    state.intel.stats = data.stats;
    state.intel.sources = await api('api/intel/sources');
    const view = $('#view');
    $('#topActions').innerHTML = `<button class="btn" id="intelFetch">抓取情报源</button>
      <button class="btn primary" id="intelTopics">生成选题</button>`;

    const st = state.intel.stats;
    view.innerHTML = `
      <div class="grid c4" style="margin-bottom:16px">
        <div class="stat"><div class="k">情报总数</div><div class="v">${st.total || 0} <small>条</small></div></div>
        <div class="stat"><div class="k">今日新增</div><div class="v">${st.today || 0} <small>条</small></div></div>
        <div class="stat"><div class="k">未使用</div><div class="v">${st.unread || 0} <small>条</small></div></div>
        <div class="stat"><div class="k">情报源</div><div class="v">${state.intel.sources.filter((s) => s.enabled && s.url).length} <small>个启用</small></div></div>
      </div>

      <div class="two-col">
        <div>
          <div class="card">
            <h3>手动录入情报</h3>
            <p class="hint">网络抓取不稳定时，直接把看到的链接、标题、摘要贴进来，系统会自动打标签。</p>
            <div class="field" style="margin-bottom:10px"><label>标题</label><input type="text" id="intelTitle" placeholder="例：云南春茶减产，古树茶原料价上涨约两成"></div>
            <div class="field" style="margin-bottom:10px"><label>链接（可选）</label><input type="text" id="intelUrl" placeholder="https://..."></div>
            <div class="field" style="margin-bottom:10px"><label>摘要 / 备注（可选）</label><textarea id="intelSummary" rows="3" placeholder="补充你看到的细节，方便后面写脚本"></textarea></div>
            <div class="flex"><button class="btn primary" id="intelAdd">录入</button><span class="muted small">已自动去重（同标题 / 同链接）</span></div>
          </div>

          <div class="card">
            <h3>情报源（RSS / Atom）</h3>
            <p class="hint">填 RSS 地址即可定时抓取。没有网络也能用整个工作台，抓取失败不影响其它模块。</p>
            <div id="intelSources"></div>
            <div class="row mt12">
              <div class="field"><label>名称</label><input type="text" id="srcName" placeholder="例：茶行业资讯"></div>
              <div class="field" style="flex:2 1 260px"><label>RSS 地址</label><input type="text" id="srcUrl" placeholder="https://example.com/feed.xml"></div>
              <button class="btn" id="srcAdd">添加</button>
            </div>
          </div>

          <div class="card">
            <h3>直播选题建议</h3>
            <p class="hint">把情报转成能直接开播的选题，点「用这个选题」会跳到模块 3 并自动填入。</p>
            <div id="topicList"><div class="empty">还没生成选题。<br>先录入几条情报，再点右上角「生成选题」。</div></div>
          </div>
        </div>

        <div class="card">
          <h3>情报列表 <span class="muted small" id="intelCount"></span></h3>
          <p class="hint">打上「已用」标记的情报不会再出现在选题建议里。</p>
          <div class="scroll-y" id="intelList"></div>
        </div>
      </div>`;

    renderIntelSources();
    renderIntelList();
    renderTopicList();

    $('#intelAdd').onclick = async () => {
      const title = $('#intelTitle').value.trim();
      if (!title) return toast('请先填标题', true);
      const r = await api('api/intel', { body: { title, url: $('#intelUrl').value.trim(), summary: $('#intelSummary').value.trim() } });
      toast(r.added ? `已录入 ${r.added} 条` : '这条已经存在了');
      await renderIntel();
    };
    $('#intelFetch').onclick = async (e) => {
      e.target.disabled = true;
      e.target.innerHTML = '<span class="spinner"></span>抓取中';
      try {
        const r = await api('api/intel/fetch', { body: {} });
        if (!r.ok) toast(r.message || '抓取失败，可用手动录入', true);
        else toast(r.results.map((x) => `${x.source}: ${x.ok ? '+' + x.added : '失败'}`).join('；'));
        await renderIntel();
      } finally {
        e.target.disabled = false;
        e.target.textContent = '抓取情报源';
      }
    };
    $('#intelTopics').onclick = async () => {
      state.intel.topics = await api('api/intel/topics?limit=10');
      renderTopicList();
      toast(state.intel.topics.length ? `生成 ${state.intel.topics.length} 个选题` : '没有可用情报，先录入几条');
    };
    $('#srcAdd').onclick = async () => {
      const name = $('#srcName').value.trim();
      const url = $('#srcUrl').value.trim();
      if (!name || !url) return toast('名称和地址都要填', true);
      await api('api/intel/sources', { body: { name, url, enabled: true, type: 'rss' } });
      toast('已添加情报源');
      await renderIntel();
    };
  }

  function renderIntelSources() {
    const el = $('#intelSources');
    if (!el) return;
    el.innerHTML =
      state.intel.sources
        .map(
          (s) => `<div class="intel-item" style="margin-bottom:7px">
        <div class="t">${esc(s.name)} ${s.enabled ? '<span class="chip green">启用</span>' : '<span class="chip grey">停用</span>'}</div>
        <div class="s mono small">${esc(s.url || '（未配置地址）')}</div>
        <div class="m">
          <button class="btn sm" data-src-toggle="${s.id}">${s.enabled ? '停用' : '启用'}</button>
          <button class="btn sm danger" data-src-del="${s.id}">删除</button>
        </div></div>`
        )
        .join('') || '<div class="muted small">还没有情报源。没有也没关系，手动录入同样可用。</div>';

    $$('[data-src-toggle]', el).forEach((b) => {
      b.onclick = async () => {
        const s = state.intel.sources.find((x) => x.id === b.dataset.srcToggle);
        await api('api/intel/sources', { body: { ...s, enabled: !s.enabled } });
        await renderIntel();
      };
    });
    $$('[data-src-del]', el).forEach((b) => {
      b.onclick = async () => {
        await api(`api/intel/sources/${b.dataset.srcDel}`, { method: 'DELETE' });
        await renderIntel();
      };
    });
  }

  function renderIntelList() {
    const el = $('#intelList');
    if (!el) return;
    $('#intelCount').textContent = `(${state.intel.items.length})`;
    if (!state.intel.items.length) {
      el.innerHTML = '<div class="empty">还没有情报。<br>左边手动录一条试试。</div>';
      return;
    }
    el.innerHTML = state.intel.items
      .map(
        (i) => `<div class="intel-item${i.used ? ' used' : ''}">
        <div class="t">${esc(i.title)}</div>
        ${i.summary ? `<div class="s">${esc(i.summary.slice(0, 160))}${i.summary.length > 160 ? '…' : ''}</div>` : ''}
        <div class="m">
          ${(i.tags || []).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}
          <span class="muted small">${esc(i.source || '')} ${i.createdAt ? '· ' + i.createdAt.slice(5, 16).replace('T', ' ') : ''}</span>
          <span class="right flex">
            ${i.url ? `<a class="btn sm ghost" href="${esc(i.url)}" target="_blank" rel="noreferrer">看原文</a>` : ''}
            <button class="btn sm ghost" data-intel-used="${i.id}">${i.used ? '标记未用' : '标记已用'}</button>
            <button class="btn sm ghost danger" data-intel-del="${i.id}">删除</button>
          </span>
        </div></div>`
      )
      .join('');

    $$('[data-intel-used]', el).forEach((b) => {
      b.onclick = async () => {
        const i = state.intel.items.find((x) => x.id === b.dataset.intelUsed);
        await api(`api/intel/${i.id}`, { method: 'PUT', body: { used: !i.used } });
        await renderIntel();
      };
    });
    $$('[data-intel-del]', el).forEach((b) => {
      b.onclick = async () => {
        await api(`api/intel/${b.dataset.intelDel}`, { method: 'DELETE' });
        await renderIntel();
      };
    });
  }

  function renderTopicList() {
    const el = $('#topicList');
    if (!el) return;
    const list = state.intel.topics || [];
    if (!list.length) {
      el.innerHTML = '<div class="empty">还没生成选题。<br>先录入几条情报，再点右上角「生成选题」。</div>';
      return;
    }
    el.innerHTML = list
      .map(
        (t, i) => `<div class="intel-item">
        <div class="t">${i + 1}. ${esc(t.title)}</div>
        <div class="s">为什么值得做：${esc(t.why)}</div>
        <div class="m"><span class="chip amber">${esc(t.tag)}</span><span class="muted small">来源：${esc(t.source || '')}</span>
          <span class="right"><button class="btn sm primary" data-use-topic="${i}">用这个选题生成方案</button></span></div></div>`
      )
      .join('');

    $$('[data-use-topic]', el).forEach((b) => {
      b.onclick = () => {
        const t = list[Number(b.dataset.useTopic)];
        const form = loadDeckForm();
        form.topic = t.title;
        saveDeckForm(form);
        state.pendingTopic = t.title;
        goto('deck');
        toast('已把选题填入模块 3');
      };
    });
  }

  /* ================================================================ 模块2 */
  async function renderKB() {
    state.kb = await api('api/kb');
    const kb = state.kb;
    const view = $('#view');
    $('#topActions').innerHTML = `<button class="btn" id="kbExport">导出 JSON</button>
      <button class="btn primary" id="kbNew">新增${state.kbKind === 'mountains' ? '山头' : '茶品'}</button>`;

    view.innerHTML = `
      <div class="grid c4" style="margin-bottom:16px">
        <div class="stat"><div class="k">山头</div><div class="v">${kb.mountains.length} <small>条</small></div></div>
        <div class="stat"><div class="k">茶品知识</div><div class="v">${kb.products.length} <small>条</small></div></div>
        <div class="stat"><div class="k">产区</div><div class="v">${kb.regions.length} <small>个</small></div></div>
        <div class="stat"><div class="k">最近更新</div><div class="v" style="font-size:15px">${esc(kb.updatedAt || '—')}</div></div>
      </div>

      <div class="tabs">
        <button class="tab${state.kbKind === 'mountains' ? ' active' : ''}" data-kbkind="mountains">山头 (${kb.mountains.length})</button>
        <button class="tab${state.kbKind === 'products' ? ' active' : ''}" data-kbkind="products">茶品知识 (${kb.products.length})</button>
      </div>

      <div class="card" id="kbFileCard">
        <div class="flex">
          <div style="min-width:0">
            <h3 style="margin:0">从素材库导入</h3>
            <p class="hint" style="margin:4px 0 0" id="kbFileHint">正在读取素材库状态…</p>
          </div>
          <span class="right flex" style="flex:0 0 auto">
            <button class="btn sm" id="kbFilePreview">检查差异</button>
            <button class="btn sm primary" id="kbFileApply" disabled>确认导入</button>
          </span>
        </div>
        <div id="kbFileDiff" class="mt12"></div>
      </div>

      <div class="kb-layout">
        <div>
          <div class="field" style="margin-bottom:10px"><input type="text" id="kbSearch" placeholder="搜索山头 / 茶品 / 口感关键词…" value="${esc(state.kbQuery)}"></div>
          <div class="kb-list" id="kbList"></div>
        </div>
        <div id="kbDetail"><div class="card"><div class="empty">从左边选一条查看与编辑</div></div></div>
      </div>`;

    $$('[data-kbkind]', view).forEach((b) => {
      b.onclick = () => {
        state.kbKind = b.dataset.kbkind;
        state.kbSelected = null;
        renderKB();
      };
    });
    $('#kbSearch').oninput = (e) => {
      state.kbQuery = e.target.value;
      renderKBList();
    };
    $('#kbExport').onclick = () => {
      const blob = new Blob([JSON.stringify(kb, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'knowledge.json';
      a.click();
      toast('已导出 knowledge.json，改完可在下面导回');
    };
    $('#kbNew').onclick = () => {
      state.kbSelected = { __new: true, id: '', name: '', region: '', area: '', taste: [], aroma: [], pitfalls: [], sellingPoints: [], audience: [] };
      renderKBDetail();
    };

    /* ---- 从素材库目录（一堆 .md 文件）导入 ---- */
    const kbHint = $('#kbFileHint');
    const kbDiff = $('#kbFileDiff');
    const kbApply = $('#kbFileApply');
    let diffData = null;

    const lineOf = (label, arr) =>
      arr.length
        ? `<div class="muted small">${label} <b>${arr.length}</b>：${esc(arr.slice(0, 8).join('、'))}${
            arr.length > 8 ? ` …等 ${arr.length} 个` : ''
          }</div>`
        : '';
    const blockOf = (title, g) =>
      `<div style="margin-bottom:10px"><b style="font-size:13px">${title}</b>
        <div class="muted small">素材库 ${g.files} 个文件 → 解析出 ${g.total} 条</div>
        ${lineOf('新增', g.added)}${lineOf('更新', g.updated)}${lineOf('删除', g.removed)}</div>`;
    const countDiff = (d) =>
      ['mountains', 'products', 'topics'].reduce(
        (a, k) => a + (d.groups[k]?.added.length || 0) + (d.groups[k]?.updated.length || 0) + (d.groups[k]?.removed.length || 0),
        0
      );
    const GROUP_LABEL = { mountains: '山头', products: '茶品知识', topics: '专题（品鉴 / 冲泡 / 转化 / 价格）' };

    (async () => {
      try {
        const st = await api('api/kb/file-status');
        kbHint.innerHTML = st.ok
          ? `素材库：<code>${esc(st.dir)}</code> —— 山头 ${st.mountains.items} 条 / 茶品 ${st.products.items} 条。
             <b>文件夹是内容源头</b>：导入会覆盖当前知识库（覆盖前自动备份）。`
          : esc(st.message || '素材库不可用');
      } catch (e) {
        kbHint.textContent = '读取素材库失败：' + e.message;
      }
    })();

    $('#kbFilePreview').onclick = async () => {
      kbDiff.innerHTML = '<span class="muted small">正在比对…</span>';
      kbApply.disabled = true;
      try {
        diffData = await api('api/kb/import-preview', { body: {} });
        if (!diffData.ok) {
          kbDiff.innerHTML = `<p class="hint">${esc(diffData.message || '比对失败')}</p>`;
          return;
        }
        const n = countDiff(diffData);
        kbDiff.innerHTML =
          `<p class="hint" style="margin-top:0">素材库：<code>${esc(diffData.dir)}</code></p>` +
          ['mountains', 'products', 'topics']
            .filter((k) => diffData.groups[k])
            .map((k) => blockOf(GROUP_LABEL[k], diffData.groups[k]))
            .join('') +
          (n === 0
            ? '<div class="chip green">素材库与当前知识库完全一致，无需导入</div>'
            : `<div class="chip amber">共 ${n} 处变动 —— 确认后覆盖当前知识库（先自动备份）</div>`) +
          ((diffData.warnings || []).length
            ? `<div class="muted small" style="margin-top:8px">解析提醒：${esc(diffData.warnings.slice(0, 4).join('；'))}${
                diffData.warnings.length > 4 ? ` …共 ${diffData.warnings.length} 条` : ''
              }</div>`
            : '');
        kbApply.disabled = n === 0;
      } catch (e) {
        kbDiff.innerHTML = `<p class="hint">比对失败：${esc(e.message)}</p>`;
      }
    };

    $('#kbFileApply').onclick = async () => {
      if (!diffData) return;
      const n = countDiff(diffData);
      if (!confirm(`导入会用素材库覆盖当前知识库（${n} 处变动）。\n\n当前知识库会先自动备份到 data/backups/，可以回滚。\n\n继续？`)) return;
      kbApply.disabled = true;
      try {
        const r = await api('api/kb/import', { body: {} });
        if (!r.ok) throw new Error(r.message || '导入失败');
        toast(`导入完成：新增 ${r.added} / 更新 ${r.updated} / 删除 ${r.removed}（备份 ${r.backup}）`);
        diffData = null;
        await renderKB();
      } catch (e) {
        toast('导入失败：' + e.message, true);
        kbApply.disabled = false;
      }
    };

    renderKBList();
    renderKBDetail();
  }

  function renderKBList() {
    const el = $('#kbList');
    if (!el) return;
    const isM = state.kbKind === 'mountains';
    const q = state.kbQuery.trim().toLowerCase();
    let list = isM ? state.kb.mountains : state.kb.products;
    if (q) {
      list = list.filter((x) =>
        [x.name, x.id, x.region, x.area, x.category, ...(x.alias || []), ...(x.aka || []), ...(x.taste || [])]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(q)
      );
    }
    el.innerHTML =
      list
        .map(
          (x) => `<div class="kb-row${state.kbSelected && state.kbSelected.id === x.id ? ' active' : ''}" data-kbrow="${esc(x.id)}">
        <span>${esc(x.name)}</span>
        <span class="meta">${esc(isM ? x.region || '' : x.category || '')}</span></div>`
        )
        .join('') || '<div class="empty">没有匹配条目</div>';

    $$('[data-kbrow]', el).forEach((r) => {
      r.onclick = () => {
        const src = state.kbKind === 'mountains' ? state.kb.mountains : state.kb.products;
        state.kbSelected = JSON.parse(JSON.stringify(src.find((x) => x.id === r.dataset.kbrow)));
        renderKBList();
        renderKBDetail();
      };
    });
  }

  const arr2str = (a) => (Array.isArray(a) ? a.join('\n') : '');
  const str2arr = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);

  function renderKBDetail() {
    const el = $('#kbDetail');
    if (!el) return;
    const x = state.kbSelected;
    if (!x) {
      el.innerHTML = '<div class="card"><div class="empty">从左边选一条查看与编辑</div></div>';
      return;
    }
    const isM = state.kbKind === 'mountains';
    const f = (label, key, opts = {}) => `
      <div class="field" style="${opts.full ? 'flex:1 1 100%' : ''}">
        <label>${label}</label>
        ${opts.area
          ? `<textarea data-kbf="${key}" rows="${opts.rows || 3}">${esc(arr2str(x[key]))}</textarea>`
          : `<input type="text" data-kbf="${key}" value="${esc(x[key] || '')}">`}
      </div>`;

    el.innerHTML = `<div class="card">
      <h3>${x.__new ? '新增' : '编辑'}${isM ? '山头' : '茶品'} —— ${esc(x.name || '未命名')}</h3>
      <p class="hint">这里的内容会直接进入模块 3 的 PPT 与口播稿。多行字段一行一条。</p>
      <div class="grid c3">
        ${f('名称', 'name')}
        ${f('ID（英文短横线，可留空自动生成）', 'id')}
        ${isM ? f('产区', 'region') : f('分类', 'category')}
        ${isM ? f('具体位置', 'area') : ''}
        ${isM ? f('海拔', 'altitude') : ''}
        ${isM ? f('树种', 'treeType') : ''}
        ${isM ? f('树龄', 'treeAge') : ''}
        ${isM ? f('土壤', 'soil') : ''}
        ${isM ? f('市场定位', 'grade') : ''}
        ${isM ? f('价格区间', 'priceRange') : ''}
        ${f(isM ? '别名（一行一个）' : '也叫（一行一个）', isM ? 'alias' : 'aka', { area: true, rows: 2 })}
        ${f('香气（一行一个）', 'aroma', { area: true, rows: 3 })}
        ${f('滋味（一行一个）', 'taste', { area: true, rows: 3 })}
        ${f('汤色', 'soup')}
        ${f('叶底', 'leaf')}
        ${f('适饮人群（一行一个）', 'audience', { area: true, rows: 2 })}
      </div>
      <div class="grid c2 mt12">
        ${f(isM ? '山场特征（讲因果，PPT 知识页核心素材）' : '一句话定义 summary', isM ? 'terroir' : 'summary', { full: true, area: true, rows: 4 })}
        ${f(isM ? '直播间防坑点（一行一个）' : '要点 points（一行一个）', isM ? 'pitfalls' : 'points', { full: true, area: true, rows: 4 })}
        ${f('可直接念的卖点话术（一行一个）', 'sellingPoints', { full: true, area: true, rows: 4 })}
        ${f('冲泡建议', 'brewTips', { full: true, area: true, rows: 2 })}
        ${f('备注', 'note', { full: true, area: true, rows: 2 })}
      </div>
      <hr class="sep">
      <div class="flex">
        <button class="btn primary" id="kbSave">保存</button>
        <button class="btn" id="kbCancel">取消</button>
        <span class="right">
          ${x.__new ? '' : '<button class="btn danger" id="kbDelete">删除这条</button>'}
        </span>
      </div></div>`;

    $('#kbSave').onclick = async () => {
      const out = { ...x };
      delete out.__new;
      delete out.mountain;
      $$('[data-kbf]', el).forEach((inp) => {
        const k = inp.dataset.kbf;
        const v = inp.value;
        out[k] = ['alias', 'aka', 'aroma', 'taste', 'audience', 'pitfalls', 'points', 'sellingPoints'].includes(k)
          ? str2arr(v)
          : v.trim();
      });
      if (!out.name) return toast('名称不能为空', true);
      const kind = state.kbKind === 'mountains' ? 'mountain' : 'product';
      const r = await api(kind === 'mountain' ? 'api/kb/mountain' : 'api/kb/product', { body: out });
      toast('已保存');
      state.kbSelected = r.item;
      await renderKB();
    };
    $('#kbCancel').onclick = () => {
      state.kbSelected = null;
      renderKBDetail();
    };
    const del = $('#kbDelete');
    if (del)
      del.onclick = async () => {
        if (!confirm(`确定删除「${x.name}」？`)) return;
        await api('api/kb/delete', { body: { type: state.kbKind === 'mountains' ? 'mountain' : 'product', id: x.id } });
        state.kbSelected = null;
        toast('已删除');
        await renderKB();
      };
  }

  /* ================================================================ 模块3 */
  /**
   * 表单默认值。
   *
   * `host` / `brand` 会被 `data/settings.json` 覆盖（见 renderDeckModule）——
   * 这样改主播名/店名不用改代码。
   * （之前是写死在代码里的，结果 settings.json 里的 host 界面上根本不生效。）
   */
  const DEFAULT_FORM = {
    topic: '老班章春茶专场',
    host: '主播',
    brand: '本店',
    purpose: 'newlaunch',
    audience: 'veteran',
    style: 'practical',
    // 视觉风格：渲染期选择，不进 DeckSpec —— 同一份方案可以换风格重新输出
    deckStyle: '',
    durationMin: 60,
    nextTopic: '',
    products: [
      { name: '老班章古树春茶', mountainName: '老班章', type: '生普', year: String(new Date().getFullYear()), spec: '357g/饼', price: '2680', comparePrice: '3280', gift: '茶样2泡', stock: '限量80饼', role: '主推款' },
    ],
  };
  const loadDeckForm = () => {
    try {
      const raw = localStorage.getItem('puer_deck_form');
      if (raw) {
        const v = JSON.parse(raw);
        if (v && Array.isArray(v.products) && v.products.length) return v;
      }
    } catch { /* 忽略 */ }
    return JSON.parse(JSON.stringify(DEFAULT_FORM));
  };
  const saveDeckForm = (f) => localStorage.setItem('puer_deck_form', JSON.stringify(f));

  let deckForm = null;

  async function renderDeckModule() {
    if (!state.options) state.options = await api('api/options');
    deckForm = loadDeckForm();
    // 主播名 / 品牌从 settings 读（改数据文件即可，不用改代码）。
    // 只在用户没手动改过表单时覆盖，避免把用户自己填的值冲掉。
    try {
      const st = await api('api/settings');
      const storedRaw = localStorage.getItem('puer_deck_form');
      if (!storedRaw) {
        if (st?.host) deckForm.host = st.host;
        if (st?.brand) deckForm.brand = st.brand;
      }
    } catch { /* settings 读不到就用默认值 */ }
    if (state.pendingTopic) {
      deckForm.topic = state.pendingTopic;
      state.pendingTopic = null;
      saveDeckForm(deckForm);
    }
    state.decks = await api('api/decks');
    const view = $('#view');
    view.innerHTML = `
      <div class="two-col">
        <div class="card">
          <h3>场次设置</h3>
          <p class="hint">一次可以过一款或多款茶 —— 真实直播是「过款」节奏，多款茶也能让长场次内容更充实。</p>
          <div class="grid c2">
            <div class="field" style="grid-column:1/-1"><label>场次主题</label><input type="text" id="fTopic" value="${esc(deckForm.topic)}"></div>
            <div class="field"><label>主播</label><input type="text" id="fHost" value="${esc(deckForm.host)}"></div>
            <div class="field"><label>品牌 / 店铺</label><input type="text" id="fBrand" value="${esc(deckForm.brand)}"></div>
            <div class="field"><label>场次类型</label><select id="fPurpose">
              ${state.options.purposes.map((p) => `<option value="${p.id}"${deckForm.purpose === p.id ? ' selected' : ''}>${p.label} —— ${p.desc}</option>`).join('')}
            </select></div>
            <div class="field"><label>受众</label><select id="fAudience">
              ${state.options.audiences.map((p) => `<option value="${p.id}"${deckForm.audience === p.id ? ' selected' : ''}>${p.label}</option>`).join('')}
            </select></div>
            <div class="field"><label>讲法风格</label><select id="fStyle">
              ${state.options.styles.map((p) => `<option value="${p.id}"${deckForm.style === p.id ? ' selected' : ''}>${p.label} —— ${p.desc}</option>`).join('')}
            </select></div>
            <div class="field"><label>计划时长</label><select id="fDuration">
              ${state.options.durations.map((d) => `<option value="${d}"${Number(deckForm.durationMin) === d ? ' selected' : ''}>${d} 分钟</option>`).join('')}
            </select></div>
          </div>

          <hr class="sep">
          <div class="flex" style="margin-bottom:10px"><b style="font-size:14px">本场茶品</b>
            <span class="muted small">最多 5 款</span>
            <button class="btn sm right" id="addProduct">+ 添加一款</button></div>
          <div id="productList"></div>

          <hr class="sep">
          <div class="flex" style="margin-bottom:9px"><b style="font-size:14px">视觉风格</b>
            <span class="muted small">决定输出成什么样。同一份方案随时可以换一种风格重新导出，不用重新生成。</span></div>
          <div class="style-picker" id="stylePicker"></div>

          <div class="flex mt12">
            <button class="btn primary" id="buildDeck" style="padding:10px 22px">生成方案（PPT + 口播稿）</button>
            <span class="muted small" id="buildNote"></span>
          </div>
        </div>

        <div>
          <div class="card" id="deckResultCard" style="display:none">
            <h3>生成结果</h3>
            <div id="deckSummary"></div>
          </div>
        </div>
      </div>

      <div id="deckWorkspace"></div>

      <div class="card" id="deckHistoryCard">
        <div class="flex" style="margin-bottom:10px">
          <div style="min-width:0">
            <h3 style="margin:0">历史方案</h3>
            <p class="hint" style="margin:4px 0 0">每次生成都会存档。勾选可以批量打开或删除 —— 删除只删存档，已导出的文件不动。</p>
          </div>
          <div class="right flex" style="flex:0 0 auto">
            <label class="pickall"><input type="checkbox" id="histAll"> 全选</label>
            <button class="btn sm" id="histOpen">打开选中</button>
            <button class="btn sm ghost danger" id="histDel">删除选中</button>
          </div>
        </div>
        <div id="deckHistory"></div>
      </div>`;

    renderProductRows();
    renderStylePicker();
    renderDeckHistory();

    // 历史方案：全选 / 批量打开 / 批量删除
    const histAll = $('#histAll');
    if (histAll) {
      histAll.onchange = () => {
        const list = state.decks.slice(0, 12);
        if (histAll.checked) list.forEach((d) => state.deckPicks.add(d.id));
        else state.deckPicks.clear();
        renderDeckHistory();
      };
    }
    const histOpen = $('#histOpen');
    if (histOpen) {
      histOpen.onclick = () => {
        const ids = [...state.deckPicks];
        if (ids.length !== 1) return toast('一次只能打开一份，请只勾一份', true);
        loadDeckById(ids[0]);
      };
    }
    const histDel = $('#histDel');
    if (histDel) histDel.onclick = () => deleteDecks([...state.deckPicks]);

    $('#addProduct').onclick = () => {
      if (deckForm.products.length >= 5) return toast('最多 5 款', true);
      deckForm.products.push({ name: '', mountainName: '', type: '生普', year: String(new Date().getFullYear()), spec: '357g/饼', price: '', comparePrice: '', gift: '', stock: '', role: state.options.productRoles[deckForm.products.length] || '对比款' });
      collectForm();
      renderProductRows();
    };
    $('#buildDeck').onclick = doBuild;

    if (state.deck) renderDeckWorkspace();
  }

  /**
   * 视觉风格选择器。
   *
   * 风格是**渲染期选择**，不进 DeckSpec —— 所以换风格不用重新生成方案，
   * 直接拿去重新导出即可。未实现的风格会禁用（不假装能选）。
   */
  /**
   * 切换视觉风格。
   *
   * 关键：**切完要立刻把下方的预览重渲染**，否则用户切了风格往下一看还是老样子，
   * 会以为功能没生效（这正是之前的体验问题）。所以这里统一走一个入口。
   */
  function setDeckStyle(id) {
    if (!id) return;
    deckForm.deckStyle = id;
    saveDeckForm(deckForm);
    state._stylePreview = null; // 换风格 → 缓存失效
    renderStylePicker();
    if (state.module === 'deck' && state.deckTab === 'slides' && state.slidePreviewMode !== 'builtin' && state.deck) {
      renderDeckTab();
    }
  }

  /**
   * 「视觉风格真稿」预览：直接用导出管线渲染最终那份 HTML 塞进 iframe —— 所见即所得，
   * 不是另写一套近似预览。同一 (方案, 风格) 组合有缓存，来回切不会反复渲染。
   */
  async function mountStylePreview() {
    const box = $('#stylePreviewBox');
    const note = $('#previewNote');
    const d = state.deck;
    if (!box || !d) return;
    const styles = (state.options && state.options.deckStyles) || [];
    const style = deckForm.deckStyle || (state.options && state.options.defaultDeckStyle) || '';
    const label = (styles.find((s) => s.id === style) || {}).label || style;
    const key = `${d.id}:${style}`;

    const paint = (r) => {
      box.innerHTML = `<iframe src="files/html/${encodeURIComponent(r.fileName)}"
          style="width:100%;aspect-ratio:16/9;border:1px solid var(--line);border-radius:var(--radius-s);background:#111"
          title="按风格渲染的幻灯片"></iframe>
        <p class="hint" style="margin-top:6px">${esc(r.styleLabel)} · ${r.slides} 页 ·
          框内可直接用 <b>← →</b> 翻页、<b>B</b> 静态、<b>ESC</b> 总览 ·
          <a href="files/html/${encodeURIComponent(r.fileName)}" target="_blank" rel="noopener">在新标签页打开</a></p>`;
      if (note) note.textContent = `当前预览 = 最终成品：${r.styleLabel}`;
    };

    if (state._stylePreview && state._stylePreview.key === key) {
      paint(state._stylePreview.result);
      return;
    }
    box.innerHTML = `<p class="hint">正在按「${esc(label)}」渲染真稿…</p>`;
    if (note) note.textContent = '';
    try {
      const r = await api(`api/decks/${d.id}/export-html`, { body: { deck: d, style, mode: 'present' } });
      if (!r.ok) throw new Error(r.message || '渲染失败');
      state._stylePreview = { key, result: r };
      // 渲染期间用户可能又切了风格/方案/标签页，确认目标没变再落地
      const stillSame =
        state.deck && state.deck.id === d.id &&
        (deckForm.deckStyle || (state.options && state.options.defaultDeckStyle) || '') === style &&
        state.deckTab === 'slides' && state.slidePreviewMode !== 'builtin';
      if (stillSame) paint(r);
    } catch (e) {
      box.innerHTML = `<p class="hint">渲染失败：${esc(e.message)}</p>`;
    }
  }

  function renderStylePicker() {
    const el = $('#stylePicker');
    if (!el) return;
    const styles = (state.options && state.options.deckStyles) || [];
    const cur = deckForm.deckStyle || (state.options && state.options.defaultDeckStyle) || '';
    deckForm.deckStyle = cur;

    el.innerHTML = styles
      .map((s) => {
        const dis = s.ready ? '' : ' disabled title="该风格尚未实现"';
        const dots = (s.swatches || [])
          .map((c) => `<i style="background:${esc(c)}"></i>`)
          .join('');
        return `<button type="button" class="style-card${s.id === cur ? ' active' : ''}" data-style="${esc(
          s.id
        )}"${dis}>
          <span class="sc-head"><span class="sc-dots">${dots}</span><span class="sc-name">${esc(s.label)}</span></span>
          <span class="sc-desc">${esc(s.desc)}</span>
          <span class="sc-src">${esc(s.source)}${s.ready ? '' : ' · 尚未实现'}</span>
        </button>`;
      })
      .join('');

    $$('[data-style]', el).forEach((b) => {
      b.onclick = () => setDeckStyle(b.dataset.style);
    });
  }

  function collectForm() {
    if (!$('#fTopic')) return;
    deckForm.topic = $('#fTopic').value;
    deckForm.host = $('#fHost').value;
    deckForm.brand = $('#fBrand').value;
    deckForm.purpose = $('#fPurpose').value;
    deckForm.audience = $('#fAudience').value;
    deckForm.style = $('#fStyle').value;
    deckForm.durationMin = Number($('#fDuration').value);
    $$('#productList [data-pf]').forEach((inp) => {
      const [idx, key] = inp.dataset.pf.split('.');
      deckForm.products[Number(idx)][key] = inp.value;
    });
    saveDeckForm(deckForm);
  }

  function renderProductRows() {
    const el = $('#productList');
    if (!el) return;
    el.innerHTML = deckForm.products
      .map((p, i) => {
        const pf = (key, label, ph, opts = {}) =>
          `<div class="field" style="${opts.w ? 'flex:' + opts.w : ''}"><label>${label}</label>
            <input type="${opts.num ? 'number' : 'text'}" data-pf="${i}.${key}" value="${esc(p[key] ?? '')}" placeholder="${ph || ''}"></div>`;
        return `<div class="product-row">
          <div class="hd"><span class="role">${esc(p.role || '茶品 ' + (i + 1))}</span>
            <span class="muted small">${esc(p.name || '未命名')}</span>
            ${deckForm.products.length > 1 ? `<button class="btn sm ghost danger del" data-del-product="${i}">移除</button>` : ''}</div>
          <div class="grid c3">
            ${pf('role', '角色', '主推款 / 对比款')}
            ${pf('name', '茶品名称', '老班章古树春茶')}
            <div class="field"><label>山头（自动匹配知识库）</label>
              <input type="text" list="mountainOptions" data-pf="${i}.mountainName" value="${esc(p.mountainName || '')}" placeholder="老班章">
            </div>
            <div class="field"><label>类型</label><select data-pf="${i}.type">
              ${state.options.types.map((t) => `<option value="${esc(t)}"${p.type === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}
            </select></div>
            ${pf('year', '年份', '2026')}
            ${pf('spec', '规格', '357g/饼')}
            ${pf('price', '直播价（元）', '2680', { num: true })}
            ${pf('comparePrice', '日常价（元）', '3280', { num: true })}
            ${pf('gift', '赠品', '茶样2泡')}
            ${pf('stock', '库存说明', '限量80饼')}
          </div></div>`;
      })
      .join('') + `<datalist id="mountainOptions">${(state.options.mountains || []).map((m) => `<option value="${esc(m.name)}">${esc(m.region || '')}${m.area ? ' · ' + esc(m.area) : ''}</option>`).join('')}</datalist>`;

    $$('[data-del-product]', el).forEach((b) => {
      b.onclick = () => {
        collectForm();
        deckForm.products.splice(Number(b.dataset.delProduct), 1);
        renderProductRows();
      };
    });
    $$('#productList [data-pf]', el).forEach((inp) => {
      inp.onchange = collectForm;
      inp.oninput = () => {
        const [idx] = inp.dataset.pf.split('.');
        clearTimeout(inp._t);
        inp._t = setTimeout(() => {
          collectForm();
          const row = $$('.product-row')[Number(idx)];
          if (row) row.querySelector('.muted').textContent = deckForm.products[Number(idx)].name || '未命名';
        }, 260);
      };
    });
  }

  /** 历史方案的勾选状态（跨重渲染保留） */
  if (!(state.deckPicks instanceof Set)) state.deckPicks = new Set();

  function renderDeckHistory() {
    const el = $('#deckHistory');
    if (!el) return;
    const list = state.decks.slice(0, 12);
    // 丢掉已经不存在的选中项
    const alive = new Set(list.map((d) => d.id));
    [...state.deckPicks].forEach((id) => { if (!alive.has(id)) state.deckPicks.delete(id); });

    if (!list.length) {
      el.innerHTML = '<div class="empty">还没有历史方案</div>';
      syncHistBar([]);
      return;
    }

    el.innerHTML = list
      .map(
        (d) => `<div class="intel-item hist-row${state.deckPicks.has(d.id) ? ' picked' : ''}">
        <label class="hist-pick"><input type="checkbox" data-pick-deck="${d.id}"${
          state.deckPicks.has(d.id) ? ' checked' : ''
        }><span></span></label>
        <div class="hist-main">
          <div class="t">${esc(d.title || '未命名')}</div>
          <div class="s">${esc(d.createdAt ? new Date(d.createdAt).toLocaleString('zh-CN') : '')} · ${d.slideCount || 0} 页 · 逐字稿 ${d.scriptMinutes || 0} 分钟</div>
          <div class="m">
            <span class="chip">${esc(d.purposeLabel || '')}</span>
            <span class="chip grey">${d.durationMin || 0} 分钟</span>
            <span class="chip grey">${d.productCount || 1} 款茶</span>
            <span class="chip ${d.complianceLevel === 'clean' ? 'green' : d.complianceLevel === 'high' ? 'red' : 'amber'}">合规 ${d.complianceTotal || 0}</span>
            <span class="right flex">
              <button class="btn sm" data-load-deck="${d.id}">打开</button>
              <button class="btn sm ghost danger" data-del-deck="${d.id}">删除</button>
            </span>
          </div>
        </div></div>`
      )
      .join('');

    $$('[data-pick-deck]', el).forEach((c) => {
      c.onchange = () => {
        if (c.checked) state.deckPicks.add(c.dataset.pickDeck);
        else state.deckPicks.delete(c.dataset.pickDeck);
        c.closest('.hist-row').classList.toggle('picked', c.checked);
        syncHistBar(list);
      };
    });
    $$('[data-load-deck]', el).forEach((b) => {
      b.onclick = () => loadDeckById(b.dataset.loadDeck);
    });
    $$('[data-del-deck]', el).forEach((b) => {
      b.onclick = () => deleteDecks([b.dataset.delDeck]);
    });

    syncHistBar(list);
  }

  /** 顶部「全选 / 打开选中 / 删除选中」的可用状态与文案 */
  function syncHistBar(list) {
    const picked = state.deckPicks.size;
    const all = $('#histAll');
    const openBtn = $('#histOpen');
    const delBtn = $('#histDel');
    if (all) {
      all.checked = list.length > 0 && picked === list.length;
      all.indeterminate = picked > 0 && picked < list.length;
      all.parentElement.classList.toggle('on', picked > 0);
    }
    if (openBtn) {
      openBtn.textContent = picked > 1 ? '打开选中（限 1 份）' : '打开选中';
      openBtn.disabled = picked !== 1;
    }
    if (delBtn) {
      delBtn.textContent = picked ? `删除选中（${picked}）` : '删除选中';
      delBtn.disabled = picked === 0;
    }
  }

  async function loadDeckById(id) {
    state.deck = await api(`api/decks/${id}`);
    state.deckTab = 'slides';
    state._stylePreview = null; // 换了方案，风格预览要重渲染
    renderDeckSummary();
    renderDeckWorkspace();
    toast('已载入方案');
  }

  async function deleteDecks(ids) {
    if (!ids.length) return;
    if (!confirm(`删除 ${ids.length} 份方案存档？已导出的 pptx / html 文件不会被删除。`)) return;
    for (const id of ids) {
      await api(`api/decks/${id}`, { method: 'DELETE' });
      state.deckPicks.delete(id);
      if (state.deck && state.deck.id === id) state.deck = null;
    }
    state.decks = await api('api/decks');
    renderDeckHistory();
    if (!state.deck) renderDeckWorkspace();
    toast(`已删除 ${ids.length} 份`);
  }

  async function doBuild() {
    collectForm();
    const btn = $('#buildDeck');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>生成中…';
    $('#buildNote').textContent = '正在根据时长推算段落与稿子长度…';
    try {
      state.deck = await api('api/decks/build', { body: deckForm });
      state.deckTab = 'slides';
      state._stylePreview = null; // 新方案要重渲染风格预览
      state.decks = await api('api/decks');
      renderDeckHistory();
      renderDeckSummary();
      renderDeckWorkspace();
      toast(`生成完成：${state.deck.meta.stats.slideCount} 页 / 逐字稿 ${state.deck.meta.stats.scriptMinutes} 分钟`);
      $('#deckWorkspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      toast('生成失败：' + err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '生成方案（PPT + 口播稿）';
      $('#buildNote').textContent = '';
    }
  }

  function renderDeckSummary() {
    const d = state.deck;
    if (!d) return;
    const card = $('#deckResultCard');
    if (card) card.style.display = '';
    const el = $('#deckSummary');
    if (!el) return;
    const s = d.meta.stats;
    const cmp = d.compliance || {};
    el.innerHTML = `
      <div class="grid c2" style="gap:10px">
        <div class="stat"><div class="k">幻灯片</div><div class="v">${s.slideCount} <small>页</small></div></div>
        <div class="stat"><div class="k">段落</div><div class="v">${s.sectionCount} <small>段</small></div></div>
        <div class="stat"><div class="k">逐字稿</div><div class="v">${s.scriptMinutes} <small>分钟</small></div>
          <div class="bar" style="margin-top:6px"><i style="width:${Math.min(100, s.verbatimCoverage)}%"></i></div>
          <div class="muted small" style="margin-top:4px">占全场 ${s.verbatimCoverage}%</div></div>
        <div class="stat"><div class="k">互动提词</div><div class="v">${s.interactionMinutes} <small>分钟</small></div>
          <div class="muted small" style="margin-top:6px">${s.interactionCount} 个环节，合计排满 ${s.fillRate}%</div></div>
      </div>
      <div class="mt12 flex">
        <span class="chip ${cmp.level === 'clean' ? 'green' : cmp.level === 'high' ? 'red' : 'amber'}">
          合规：${cmp.total ? `命中 ${cmp.total} 处` : '未发现违规词'}</span>
        ${cmp.warnTotal ? `<span class="chip amber">${cmp.warnTotal} 项提示（需备依据）</span>` : ''}
        <span class="chip grey">${esc(d.meta.purposeLabel)}</span>
        <span class="chip grey">${d.meta.durationMin} 分钟</span>
      </div>`;
  }

  function renderDeckWorkspace() {
    const el = $('#deckWorkspace');
    const d = state.deck;
    if (!el) return;
    if (!d) {
      el.innerHTML = '';
      return;
    }
    const tabs = [
      ['slides', '幻灯片预览'],
      ['script', '口播稿'],
      ['interaction', '互动环节'],
      ['prompter', '提词器'],
      ['export', '导出'],
      ['compliance', '合规检查'],
    ];
    el.innerHTML = `
      <div class="card">
        <div class="flex" style="margin-bottom:14px">
          <h3 style="margin:0">${esc(d.meta.title)}</h3>
          <span class="muted small">${esc(d.meta.host)} · ${esc(d.meta.brand)}</span>
          <span class="right flex">
            <button class="btn sm" id="openPrompter">▶ 全屏提词器</button>
            <button class="btn sm primary" id="quickPptx">导出 PPTX（当前风格）</button>
          </span>
        </div>
        <div class="tabs" style="margin-bottom:14px">
          ${tabs.map(([id, label]) => `<button class="tab${state.deckTab === id ? ' active' : ''}" data-decktab="${id}">${label}</button>`).join('')}
        </div>
        <div id="deckTabBody"></div>
      </div>`;

    $$('[data-decktab]', el).forEach((b) => {
      b.onclick = () => {
        state.deckTab = b.dataset.decktab;
        renderDeckWorkspace();
      };
    });
    $('#openPrompter').onclick = () => openPrompter(d);
    $('#quickPptx').onclick = () => doExport('style-pptx');
    renderDeckTab();
  }

  function renderDeckTab() {
    const el = $('#deckTabBody');
    const d = state.deck;
    if (!el || !d) return;

    if (state.deckTab === 'slides') {
      const styles0 = (state.options && state.options.deckStyles) || [];
      const cur0 = deckForm.deckStyle || (state.options && state.options.defaultDeckStyle) || '';
      const curLabel0 = (styles0.find((s) => s.id === cur0) || {}).label || cur0;
      if (state.slidePreviewMode !== 'builtin') state.slidePreviewMode = 'style';
      const mode = state.slidePreviewMode;

      el.innerHTML = `
        <div class="flex" style="margin-bottom:12px;gap:10px">
          <div class="tabs" style="margin:0">
            <button class="tab${mode === 'style' ? ' active' : ''}" data-previewmode="style">视觉风格真稿</button>
            <button class="tab${mode === 'builtin' ? ' active' : ''}" data-previewmode="builtin">内置 PPTX 版式</button>
          </div>
          <span class="muted small right" id="previewNote"></span>
        </div>
        <div id="stylePreviewBox" style="${mode === 'style' ? '' : 'display:none'}"></div>
        <div id="builtinPreviewBox" style="${mode === 'builtin' ? '' : 'display:none'}">
          <p class="hint">这是<b>导出 PPTX</b> 的实际版式（16:9），不跟随视觉风格。点「看备注」可以看这一页的口播稿。</p>
          <div class="deck-sections">${window.SlidePreview.renderDeck(d)}</div>
        </div>`;

      $$('[data-previewmode]', el).forEach((b) => {
        b.onclick = () => {
          state.slidePreviewMode = b.dataset.previewmode;
          renderDeckTab();
        };
      });
      $$('[data-toggle-notes]', el).forEach((b) => {
        b.onclick = () => {
          const wrap = b.closest('.slide-wrap');
          wrap.querySelector('.slide').classList.toggle('show-notes');
          b.textContent = wrap.querySelector('.slide').classList.contains('show-notes') ? '收起备注' : '看备注';
        };
      });

      // 默认就是「风格真稿」，进来即渲染；换风格时由 setDeckStyle 重新触发
      if (mode === 'style') mountStylePreview();
      return;
    }

    if (state.deckTab === 'script') {
      el.innerHTML = `<div class="flex" style="margin-bottom:12px">
          <button class="btn sm" id="dlMd">下载 Markdown</button>
          <button class="btn sm" id="dlTxt">下载提词文本</button>
          <span class="muted small">稿子净讲 ${d.script.minutes} 分钟 · 共 ${d.script.fullText.length} 字</span>
        </div>
        ${d.script.sections
          .map(
            (sec, i) => `<div class="script-section">
          <div class="script-head"><span class="n chip">${String(i + 1).padStart(2, '0')}</span>
            <span class="t">${esc(sec.title)}</span>
            <span class="time">第 ${Math.round(sec.startSec / 60)} 分钟起 · 计划 ${sec.plannedMinutes} 分钟 · 讲稿 ${sec.talkMinutes} 分钟</span></div>
          ${sec.lines
            .map(
              (l) => `<div class="line"><span class="sid">${String(l.slideIndex).padStart(2, '0')}</span>
              <span class="cue">${esc(l.cue || '')}</span><span class="txt">${esc(l.text)}</span></div>`
            )
            .join('')}
        </div>`
          )
          .join('')}`;
      $('#dlMd').onclick = () => doExport('script');
      $('#dlTxt').onclick = () => doExport('script');
      return;
    }

    if (state.deckTab === 'interaction') {
      const it = d.interaction || [];
      if (!it.length) {
        el.innerHTML = '<div class="empty">这个场次逐字稿已经排满，不需要额外互动环节。<br>如果想让节奏更松，可以把时长调长一点再生成。</div>';
        return;
      }
      const gap = d.meta.stats.gapMinutes;
      el.innerHTML = `<p class="hint">逐字稿之外还有约 <b>${gap} 分钟</b>，用这些环节填满。每个环节都给了可直接念的提示句，提词器里也会一起滚动。</p>
        ${it
          .map(
            (x, i) => `<div class="intel-item">
          <div class="t">${i + 1}. ${esc(x.title)} <span class="chip amber">${x.minutes} 分钟</span> <span class="chip grey">${esc(x.cue)}</span></div>
          <div class="s">${esc(x.desc)}</div>
          ${(x.lines || []).map((l) => `<div class="line"><span class="cue"></span><span class="txt">${esc(l)}</span></div>`).join('')}
        </div>`
          )
          .join('')}`;
      return;
    }

    if (state.deckTab === 'prompter') {
      el.innerHTML = `<p class="hint">提词器会全屏打开，支持自动滚动、镜像、字号与速度调节。手机 / 平板可以直接架在镜头旁使用。</p>
        <button class="btn primary" id="openPrompter2" style="padding:10px 22px">▶ 打开全屏提词器</button>
        <div class="mt12 muted small">快捷键：空格播放/暂停 · ↑↓ 调速 · ←→ 切段 · M 镜像 · Esc 退出</div>`;
      $('#openPrompter2').onclick = () => openPrompter(d);
      return;
    }

    if (state.deckTab === 'export') {
      const styles = (state.options && state.options.deckStyles) || [];
      const cur = deckForm.deckStyle || (state.options && state.options.defaultDeckStyle) || '';
      const curLabel = (styles.find((s) => s.id === cur) || {}).label || cur || '未选择';
      el.innerHTML = `<div id="exportOut">
        <div class="grid c3">
          <div class="card" style="margin:0;grid-column:1/-1"><h3>HTML 幻灯片（按视觉风格输出）</h3>
            <p class="hint">按你选的视觉风格渲染成单文件 HTML，双击就能开、断网也能放。
              页码/翻页键由外壳承载：<b>← →</b> 翻页、<b>B</b> 静态、<b>ESC</b> 总览。</p>
            <div class="style-inline" id="exportStyleSwitch">
              ${styles
                .map(
                  (s) =>
                    `<button type="button" data-exstyle="${esc(s.id)}"${s.id === cur ? ' class="active"' : ''}${
                      s.ready ? '' : ' disabled title="该风格尚未实现"'
                    }>${esc(s.label)}${s.ready ? '' : '（未实现）'}</button>`
                )
                .join('')}
            </div>
            <div class="flex mt12">
              <button class="btn primary" data-export="html">按「${esc(curLabel)}」生成</button>
              <span class="muted small">换风格不用重新生成方案，直接再点一次即可</span>
            </div>
          </div>
          <div class="card" style="margin:0"><h3>可编辑 PPTX（跟随所选风格）</h3>
            <p class="hint">把「<b>${esc(curLabel)}</b>」这套视觉转成 PowerPoint 文件，文字是真文本框、可以直接改。
              转换要跑一遍浏览器渲染，比内置版式慢几秒。</p>
            <button class="btn primary" data-export="style-pptx">按「${esc(curLabel)}」导出 .pptx</button></div>
          <div class="card" style="margin:0"><h3>PPTX 演示文稿（内置版式）</h3>
            <p class="hint">工作台自带的茶主题版式，<b>不跟随上面的风格选择</b>，${d.slides.length} 页，口播稿写在演讲者备注里。</p>
            <button class="btn" data-export="pptx">导出内置版式 .pptx</button></div>
          <div class="card" style="margin:0"><h3>口播稿 Markdown</h3>
            <p class="hint">分段带时间轴，可直接打印或导入笔记软件。</p>
            <button class="btn" data-export="script">导出 .md</button></div>
          <div class="card" style="margin:0"><h3>提词器纯文本</h3>
            <p class="hint">一行一句，方便导入手机提词器 App。</p>
            <button class="btn" data-export="script">导出 .txt</button></div>
        </div>
        <div id="exportResult" class="mt12"></div></div>`;
      $$('[data-export]', el).forEach((b) => (b.onclick = () => doExport(b.dataset.export)));
      $$('[data-exstyle]', el).forEach((b) => {
        b.onclick = () => {
          setDeckStyle(b.dataset.exstyle);
          renderDeckTab();
        };
      });
      return;
    }

    if (state.deckTab === 'compliance') {
      const c = d.compliance || {};
      el.innerHTML = `
        <div class="flex" style="margin-bottom:12px">
          <span class="chip ${c.level === 'clean' ? 'green' : c.level === 'high' ? 'red' : 'amber'}">当前：${c.level === 'clean' ? '未发现违规词' : `命中 ${c.total} 处`}</span>
          <button class="btn sm" id="recheck">重新检查</button>
          <button class="btn sm" id="fullCheck">把整份稿子放进模块 5 细查</button>
        </div>
        ${renderComplianceHits(c)}
        <p class="hint mt12">「提示项」不是违禁词，而是直播中需要准备依据的表述（例如树龄、产地、年份宣称）。</p>
        ${(c.warnings || []).length
          ? `<div>${(c.warnings || [])
              .map(
                (w) => `<div class="hit-row m"><div class="w">${esc(w.word)}</div>
              <div class="body"><span class="note">出现 ${w.count} 次 · ${esc(w.category)}</span><br>${esc(w.note || '')}</div></div>`
              )
              .join('')}</div>`
          : ''}`;
      $('#recheck').onclick = async () => {
        const r = await api(`api/decks/${d.id}/recheck`, { body: {} });
        d.compliance = { level: r.level, score: r.score, counts: r.counts, total: r.total, warnTotal: (r.warnings || []).length,
          top: r.hits.slice(0, 12).map((h) => ({ word: h.word, level: h.level, category: h.category, suggest: h.suggest })),
          warnings: (r.warnings || []).slice(0, 8).map((w) => ({ word: w.word, category: w.category, count: w.count, note: w.note })) };
        renderDeckTab();
        toast('已重新检查');
      };
      $('#fullCheck').onclick = () => {
        state.pendingCheckText = d.script.fullText;
        goto('compliance');
      };
      return;
    }
  }

  function renderComplianceHits(c) {
    const top = c.top || [];
    if (!top.length) return '<div class="empty">没有发现违禁词。可以放心导出。</div>';
    return top
      .map(
        (h) => `<div class="hit-row${h.level !== 'high' ? ' m' : ''}">
        <div class="w">${esc(h.word)}</div>
        <div class="body"><span class="note">${esc(h.category)} · ${h.level === 'high' ? '高风险' : '中低风险'}</span><br>
        建议改成：<span class="sugg">${esc(h.suggest || '直接删除该表述')}</span></div></div>`
      )
      .join('');
  }

  async function doExport(format) {
    const d = state.deck;
    if (!d) return;
    const out = $('#exportResult');
    if (out) out.innerHTML = '<span class="spinner" style="border-color:#ccc;border-top-color:#2f5d50"></span> 正在导出…';

    /* 按视觉风格转成**可编辑** PPTX：走 huashu-design 路线 B（渲染后坐标 → 真文本框），
       要跑一遍浏览器渲染，比内置版式慢。 */
    if (format === 'style-pptx') {
      const style = deckForm.deckStyle || (state.options && state.options.defaultDeckStyle) || '';
      toast('正在按所选风格转可编辑 PPTX（要跑一遍浏览器渲染，约 5-20 秒）…');
      try {
        const st = await api('api/pptx-by-style/status');
        if (!st.ok) {
          if (out)
            out.innerHTML = `<div class="card" style="margin:0"><h3>暂时不可用</h3>
              <p class="hint">${esc(st.message || '环境未就绪')}</p>
              <p class="hint">在此之前可以先用上面的「HTML 幻灯片」按风格输出，或改用内置版式 PPTX。</p></div>`;
          toast('按风格转 PPTX 的环境未就绪', true);
          return;
        }
        const r = await api(`api/decks/${d.id}/export-pptx-by-style`, { body: { deck: d, style } });
        if (!r.ok) throw new Error(r.message || '转换失败');
        if (out)
          out.innerHTML = `<div class="card" style="margin:0"><h3>可编辑 PPTX 已生成</h3>
            <p class="hint">风格：<b>${esc(r.styleLabel)}</b> · ${r.slides} 页 · ${(r.bytes / 1024).toFixed(1)} KB · 文字是真文本框，可在 PowerPoint 里直接改</p>
            <a class="btn primary" href="files/pptx/${encodeURIComponent(r.fileName)}" download>下载 ${esc(r.fileName)}</a>
            <span class="muted small" style="margin-left:10px">也已保存在 output/pptx 目录</span></div>`;
        toast(`已按「${r.styleLabel}」导出可编辑 PPTX`);
      } catch (e) {
        if (out) out.innerHTML = `<div class="card" style="margin:0"><h3>转换失败</h3><p class="hint">${esc(e.message)}</p></div>`;
        toast(e.message, true);
      }
      return;
    }

    if (format === 'html') {
      const style = deckForm.deckStyle || (state.options && state.options.defaultDeckStyle) || '';
      toast('正在按所选风格渲染 HTML…');
      try {
        const r = await api(`api/decks/${d.id}/export-html`, { body: { deck: d, style, mode: 'present' } });
        if (!r.ok) throw new Error(r.message || '渲染失败');
        const url = `files/html/${encodeURIComponent(r.fileName)}`;
        if (out)
          out.innerHTML = `<div class="card" style="margin:0"><h3>HTML 幻灯片已生成</h3>
            <p class="hint">风格：<b>${esc(r.styleLabel)}</b> · ${r.slides} 页 · ${(r.bytes / 1024).toFixed(1)} KB · ${esc(r.relativePath)}</p>
            <a class="btn primary" href="${url}" target="_blank" rel="noopener">在新标签页打开</a>
            <a class="btn" href="${url}" download="${esc(r.fileName)}" style="margin-left:8px">下载 HTML</a>
            <span class="muted small" style="margin-left:10px">单文件、离线可放，可直接投屏</span></div>`;
        toast('HTML 幻灯片已生成');
      } catch (e) {
        if (out) out.innerHTML = `<div class="card" style="margin:0"><h3>渲染失败</h3><p class="hint">${esc(e.message)}</p></div>`;
        toast(e.message, true);
      }
      return;
    }
    toast('正在导出，PPT 渲染需要几秒…');
    try {
      const r = await api(`api/decks/${d.id}/export`, { body: { format, deck: d } });
      if (format === 'pptx' && r.pptx) {
        if (!r.pptx.ok) throw new Error(r.pptx.message || 'PPTX 导出失败');
        const name = r.pptx.pptxPath.split(/[\\/]/).pop();
        if (out)
          out.innerHTML = `<div class="card" style="margin:0"><h3>导出成功</h3>
            <p class="hint">${r.pptx.slides} 页 · ${(r.pptx.bytes / 1024).toFixed(1)} KB · ${esc(r.pptx.relativePath)}</p>
            <a class="btn primary" href="files/pptx/${encodeURIComponent(name)}" download>下载 ${esc(name)}</a>
            <span class="muted small" style="margin-left:10px">文件也已保存在 output/pptx 目录</span></div>`;
        toast('PPTX 导出成功');
      } else if (r.script) {
        const mdName = r.script.mdPath.split(/[\\/]/).pop();
        const txtName = r.script.txtPath.split(/[\\/]/).pop();
        if (out)
          out.innerHTML = `<div class="card" style="margin:0"><h3>导出成功</h3>
            <a class="btn primary" href="files/scripts/${encodeURIComponent(mdName)}" download>下载 Markdown 口播稿</a>
            <a class="btn" href="files/scripts/${encodeURIComponent(txtName)}" download style="margin-left:8px">下载提词文本</a></div>`;
        toast('口播稿导出成功');
      }
    } catch (err) {
      if (out) out.innerHTML = `<div class="card" style="margin:0"><h3>导出失败</h3><p class="hint">${esc(err.message)}</p></div>`;
      toast('导出失败：' + err.message, true);
    }
  }

  /* ================================================================ 模块4 */
  async function renderQA() {
    state.qa.intents = await api('api/qa/intents');
    state.qa.faq = await api('api/qa/faq');
    const view = $('#view');
    $('#topActions').innerHTML = state.deck ? '<button class="btn primary" id="qaPrompter">▶ 打开提词器（含弹幕）</button>' : '';

    view.innerHTML = `
      <div class="two-col">
        <div>
          <div class="card">
            <h3>弹幕 / 问题 → 可直接念的回答</h3>
            <p class="hint">输入观众的问题，自动识别意图、从知识库取依据，并做合规自检。高风险问题会被拦下并给出改写。</p>
            <div class="flex" style="align-items:flex-start">
              <textarea id="qaInput" rows="3" placeholder="例：这个茶会不会很苦？新手能喝吗？ / 怎么泡？ / 能存几年？"></textarea>
            </div>
            <div class="flex mt12">
              <button class="btn primary" id="qaAsk">生成回答</button>
              <button class="btn" id="qaBatch">批量处理（一行一条）</button>
            </div>
          </div>
          <div id="qaResult"></div>

          <div class="card">
            <h3>问答库</h3>
            <p class="hint">把常见问题的标准答法存下来，命中时优先使用。直播间反复被问的问题放这里最省事。</p>
            <div id="faqList"></div>
            <div class="row mt12">
              <div class="field"><label>问题</label><input type="text" id="faqQ" placeholder="会不会很苦"></div>
              <div class="field" style="flex:2 1 300px"><label>回答</label><input type="text" id="faqA" placeholder="苦能化开，化开之后回甜…"></div>
              <button class="btn" id="faqAdd">保存</button>
            </div>
          </div>
        </div>

        <div>
          <div class="card">
            <h3>意图识别规则</h3>
            <p class="hint">系统按这些类别分流。功效类会强制走合规改写，不接话头。</p>
            <table class="tbl">
              <thead><tr><th>类别</th><th>风险</th><th>处理方式</th></tr></thead>
              <tbody>${state.qa.intents
                .map(
                  (i) => `<tr><td>${esc(i.name)}</td><td>${i.level === 'high' ? '<span class="chip red">高</span>' : '<span class="chip grey">常规</span>'}</td>
                  <td class="small muted">${esc(i.advice || '按知识库内容正常回答')}</td></tr>`
                )
                .join('')}</tbody>
            </table>
          </div>
        </div>
      </div>`;

    $('#qaAsk').onclick = () => askOne($('#qaInput').value);
    $('#qaInput').onkeydown = (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) askOne($('#qaInput').value);
    };
    $('#qaBatch').onclick = async () => {
      const lines = $('#qaInput').value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!lines.length) return toast('先输入几行问题', true);
      const r = await api('api/qa/batch', { body: { questions: lines } });
      $('#qaResult').innerHTML = `<div class="card"><h3>批量结果（${r.items.length} 条）</h3>
        ${Object.entries(r.grouped).map(([k, v]) => `<span class="chip" style="margin-right:6px">${esc(k)} ${v}</span>`).join('')}
        <div class="mt12">${r.items
          .map(
            (x) => `<div class="intel-item${x.blocked ? ' used' : ''}">
          <div class="t">Q：${esc(x.question)}</div>
          <div class="s">A：${esc(x.answer)}</div>
          <div class="m">${x.intent ? `<span class="chip">${esc(x.intent.name)}</span>` : ''}
            ${x.blocked ? '<span class="chip red">已按合规改写</span>' : ''}</div></div>`
          )
          .join('')}</div></div>`;
    };
    $('#faqAdd').onclick = async () => {
      const q = $('#faqQ').value.trim();
      const a = $('#faqA').value.trim();
      if (!q || !a) return toast('问题和回答都要填', true);
      await api('api/qa/faq', { body: { q, a } });
      toast('已保存');
      await renderQA();
    };
    if ($('#qaPrompter')) $('#qaPrompter').onclick = () => openPrompter(state.deck, true);
    renderFaqList();
  }

  /* ================================================================ 模块7：RAG 问答 */

  /**
   * 和模块 4「弹幕问答」的区别（别混）：
   *   模块 4 是**规则引擎**：意图识别 + 模板答案 + 合规改写，离线、零成本、可预测。
   *   模块 7 是**检索增强生成**：先从知识库取片段，再让模型组织语言，**每句带 [n] 出处**。
   * 所以直播现场要快、要稳、不能编，用模块 4；要写稿、要问开放性问题，用模块 7。
   */
  async function renderRagAsk() {
    const view = $('#view');
    const presets = [
      '倚邦和布朗山的口感有什么差别',
      '中期茶怎么辨别年份',
      '老班章古树大概什么价位',
      '为什么倚邦的汤水比较细',
      '直播间能不能说降三高',
    ];
    view.innerHTML = `
      <div class="two-col">
        <div>
          <div class="card">
            <h3>问知识库（检索 + 大模型，带引用溯源）</h3>
            <p class="hint">先从知识库检索出最相关的片段，再让模型**只依据片段**回答，每条事实后面带 [n] 编号。
              资料不够时它会直接拒答，不会编 —— 直播里一句编造的"树龄五百年"就是合规事故。</p>
            <textarea id="ragInput" rows="3" placeholder="例：老班章和布朗山其他寨子到底差在哪？"></textarea>
            <div class="flex mt12">
              <button class="btn primary" id="ragAsk">提问</button>
              <button class="btn" id="ragTopk">只看检索结果（不调模型）</button>
              <span class="spacer"></span>
              <label class="small muted">引用条数
                <select id="ragK">
                  <option value="4">4</option>
                  <option value="6" selected>6</option>
                  <option value="8">8</option>
                </select>
              </label>
            </div>
            <div class="mt12 small muted">试试：${presets
              .map((p) => `<a href="#" class="chip rag-preset" data-q="${esc(p)}">${esc(p)}</a>`)
              .join(' ')}</div>
          </div>
          <div id="ragResult"></div>
        </div>
        <div>
          <div class="card">
            <h3>它为什么这么答</h3>
            <p class="hint">下面把每次用到的知识库片段和检索打分都摊开。模型答错了，先看这里 —— 多半是检索没取对，
              而不是模型不行。</p>
            <div id="ragTrace"><div class="empty">还没有提问</div></div>
          </div>
        </div>
      </div>`;

    const ask = async () => {
      const q = $('#ragInput').value.trim();
      if (!q) return toast('先输入问题', true);
      const k = Number($('#ragK').value) || 6;
      const out = $('#ragResult');
      out.innerHTML = '<div class="card"><p class="hint">检索并生成中…</p></div>';
      try {
        const r = await api('api/kb/ask', { body: { question: q, k } });
        renderRagAnswer(out, r);
        renderRagTrace($('#ragTrace'), r);
      } catch (err) {
        out.innerHTML = `<div class="card"><h3>没能回答</h3><p class="hint">${esc(err.message)}</p></div>`;
      }
    };

    $('#ragAsk').onclick = ask;
    $('#ragInput').onkeydown = (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ask();
    };
    $('#ragTopk').onclick = async () => {
      const q = $('#ragInput').value.trim();
      if (!q) return toast('先输入问题', true);
      const k = Number($('#ragK').value) || 6;
      const out = $('#ragResult');
      out.innerHTML = '<div class="card"><p class="hint">检索中…</p></div>';
      try {
        const r = await api('api/kb/search', { body: { question: q, k } });
        renderRagAnswer(out, { ...r, answer: '', citations: [] }, { searchOnly: true });
        renderRagTrace($('#ragTrace'), r);
      } catch (err) {
        out.innerHTML = `<div class="card"><h3>检索失败</h3><p class="hint">${esc(err.message)}</p></div>`;
      }
    };
    view.querySelectorAll('.rag-preset').forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        $('#ragInput').value = a.dataset.q;
        ask();
      };
    });
  }

  function renderRagAnswer(out, r, opts = {}) {
    if (r.refused) {
      out.innerHTML = `<div class="card"><h3>知识库里没有这条</h3>
        <p class="hint">${esc(r.reason || '资料不足，已拒答。')}</p>
        <p class="small muted mt12">补一条知识库条目再问，或者换个说法。</p></div>`;
      return;
    }
    if (opts.searchOnly || !r.answer) {
      out.innerHTML = `<div class="card"><h3>检索结果（未调用模型）</h3>
        ${(r.hits || [])
          .map(
            (h, i) => `<div class="intel-item"><div class="t">[${i + 1}] ${esc(h.title || h.chunk?.title || '')}</div>
          <div class="s">${esc((h.text || h.chunk?.text || '').slice(0, 200))}…</div>
          <div class="m"><span class="chip">${esc(h.type || h.chunk?.type || '')}</span>
          <span class="chip grey">score ${Number(h.score ?? 0).toFixed(3)}</span></div></div>`
          )
          .join('') || '<div class="empty">没有命中任何片段</div>'}</div>`;
      return;
    }
    const cits = r.citations || [];
    const withMarks = esc(r.answer).replace(/\[(\d{1,2})\]/g, (_m, n) => {
      const c = cits.find((x) => x.n === Number(n));
      return c
        ? `<sup class="rag-cite" title="${esc(c.title)}">[${n}]</sup>`
        : `<sup class="rag-cite bad" title="没有对应出处">[${n}]</sup>`;
    });
    out.innerHTML = `<div class="card">
      <h3>回答${r.partial ? ' <span class="chip amber">资料不完整</span>' : ''}</h3>
      ${r.partial ? '<p class="hint">知识库里只有部分相关内容，以下是能确定的部分 —— 别照着念满，缺的那部分资料里确实没有。</p>' : ''}
      <div class="rag-answer">${withMarks.replace(/\n/g, '<br>')}</div>
      <div class="mt12 small muted">出处（${cits.length} 条）：${cits
        .map((c) => `<span class="chip">[${c.n}] ${esc(c.title)}</span>`)
        .join(' ') || '（无引用，请注意核对）'}</div>
      ${r.degraded ? `<p class="small muted mt12">模型通道不可用，以上只返回了检索片段：${esc(r.reason || '')}</p>` : ''}
      <div class="small muted mt12">${r.meta?.provider ? `模型 ${esc(r.meta.provider)}/${esc(r.meta.model || '')}` : ''}
        ${r.meta?.top1 !== undefined ? ` · 检索最高分 ${Number(r.meta.top1).toFixed(3)}` : ''}</div>
    </div>`;
  }

  function renderRagTrace(el, r) {
    const hits = r.hits || [];
    el.innerHTML = hits.length
      ? `<div class="small muted mb8">共命中 ${hits.length} 条${r.meta?.index?.chunks ? ` （索引 ${r.meta.index.chunks} 块）` : ''}</div>` +
        hits
          .map((h, i) => {
            const s = h.scores || {};
            return `<div class="intel-item">
          <div class="t">[${i + 1}] ${esc(h.chunk?.title || '')}</div>
          <div class="s">${esc((h.chunk?.text || '').slice(0, 160))}…</div>
          <div class="m">
            <span class="chip">${esc(h.chunk?.type || '')}</span>
            <span class="chip grey">BM25 ${s.bm25 !== undefined ? Number(s.bm25).toFixed(3) : '-'}</span>
            <span class="chip grey">向量 ${s.vector !== undefined ? Number(s.vector).toFixed(3) : '-'}</span>
            <span class="chip grey">融合 ${s.rrf !== undefined ? Number(s.rrf).toFixed(4) : '-'}</span>
          </div>
          ${h.reasons?.length ? `<div class="small muted">${esc(h.reasons.join(' · '))}</div>` : ''}
        </div>`;
          })
          .join('')
      : `<div class="empty">${esc(r.reason || '没有命中片段')}</div>`;
  }

  /* ================================================================ 模块8：Agent 编排 */

  /**
   * 和模块 7 最本质的区别，也是这个面板要让人一眼看懂的：
   *   模块 7 —— **流程由代码固定**：检索 → 拼 prompt → 生成。模型只负责"写"。
   *   模块 8 —— **流程由模型决定**：调哪个工具、调几次、什么顺序。代码只负责"执行 + 兜底"。
   * 所以这个面板的重点不是答案，而是**把模型的决策过程摊开**：
   * 它自己选了什么工具、花了多久、有没有失败、有没有绕远路。
   */
  async function renderAgent() {
    const view = $('#view');
    let tools = [];
    try {
      tools = (await api('api/agent/tools')).tools || [];
    } catch (err) {
      view.innerHTML = `<div class="card"><h3>Agent 还没就绪</h3>
        <p class="hint">${esc(err.message)}</p>
        <p class="small muted mt12">Agent 模块需要 <code>server/lib/agent/tools.mjs</code> 就绪，并配置可用的模型通道。</p></div>`;
      return;
    }

    const presets = [
      '帮我查一下老班章的山场特征，然后检查这句话能不能在直播间说：「老班章是全国最好的茶，能降三高」',
      '给我出一场 60 分钟的老班章新品首发直播方案，主题就叫老班章新品首发',
      '倚邦和布朗山哪个更适合推给我直播间里的老茶客？给我个说法',
      '你好，你都能干什么？',
    ];

    view.innerHTML = `
      <div class="two-col">
        <div>
          <div class="card">
            <h3>你要什么，它自己决定怎么干</h3>
            <p class="hint">这里和模块 7 不一样：模块 7 的流程是写死的（先检索再生成），
              这里**由模型自己决定调哪个工具、调几次、按什么顺序**。代码只负责执行它要的工具，
              并在它失控（死循环 / 幻觉工具名 / 工具报错）时兜底。</p>
            <textarea id="agTask" rows="3" placeholder="例：帮我出一场 60 分钟的老班章新品首发方案"></textarea>
            <div class="flex mt12">
              <button class="btn primary" id="agRun">执行</button>
              <span class="spacer"></span>
              <label class="small muted">最多轮数
                <select id="agSteps">
                  <option value="4">4</option>
                  <option value="6" selected>6</option>
                  <option value="8">8</option>
                </select>
              </label>
            </div>
            <div class="mt12 small muted">试试：${presets
              .map((p, i) => `<a href="#" class="chip ag-preset" data-q="${esc(p)}">例 ${i + 1}</a>`)
              .join(' ')}</div>
            <div class="mt12 small muted" id="agPresetHint"></div>
          </div>
          <div id="agResult"></div>
        </div>
        <div>
          <div class="card">
            <h3>它手里有什么工具（${tools.length} 个）</h3>
            <p class="hint">工具的选择**完全由 description 决定** —— 模型看不到工具的实现代码，
              只能看这段说明。所以工具描述写得准不准，直接决定它会不会挑对工具。<br>
              标 <b>写</b> 的工具会改数据，必须你点确认才会执行。</p>
            ${tools
              .map(
                (t) => `<div class="intel-item"><div class="t">${
                  t.permission === 'write' ? '<span class="chip red">写</span> ' : '<span class="chip grey">读</span> '
                }${esc(t.name)}</div>
              <div class="s">${esc(t.description)}</div></div>`
              )
              .join('')}
          </div>
          <div class="card">
            <h3>它每一步在干什么</h3>
            <p class="hint">答案不对时先看这里 —— 是它挑错了工具，还是工具返回的东西不对，
              还是它该停下来却停不下来。**Agent 出问题基本都出在这三处。**</p>
            <div id="agTrace"><div class="empty">还没执行</div></div>
          </div>
        </div>
      </div>`;

    const run = async (approvals) => {
      const task = $('#agTask').value.trim();
      if (!task) return toast('先说要干什么', true);
      const maxSteps = Number($('#agSteps').value) || 6;
      const out = $('#agResult');
      const trace = $('#agTrace');
      out.innerHTML = '<div class="card"><p class="hint">它在自己决定调什么工具…（最多 ' + maxSteps + ' 轮）</p></div>';
      trace.innerHTML = '<div class="empty">执行中…</div>';
      try {
        const body = { task, maxSteps };
        if (approvals?.length) body.approvals = approvals;
        const r = await api('api/agent/run', { body });
        renderAgentResult(out, r, { task, maxSteps, onRun: run });
        renderAgentTrace(trace, r);
      } catch (err) {
        out.innerHTML = `<div class="card"><h3>没能完成</h3><p class="hint">${esc(err.message)}</p></div>`;
      }
    };

    $('#agRun').onclick = () => run();
    $('#agTask').onkeydown = (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run();
    };    view.querySelectorAll('.ag-preset').forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        $('#agTask').value = a.dataset.q;
        $('#agPresetHint').textContent = a.dataset.q;
      };
    });
  }

  /**
   * 结果卡片。
   *
   * 核心是**写操作确认卡片**：当 Agent 想做有副作用的操作时，它会停在这里等用户点头。
   * 这不是"多一步麻烦"，而是信任边界 —— 模型提议的写入是基于它自己读到的内容，
   * 而它可能读错了、也可能被用户的话诱导了。用户必须在**看到确切影响**之后才能批准。
   */
  function renderAgentResult(out, r, ctx = {}) {
    const used = (r.steps || []).flatMap((s) => s.toolCalls || []).map((c) => c.name);
    const uniq = [...new Set(used)];
    const pending = r.pending || [];

    out.innerHTML = `<div class="card">
      <h3>结果${r.stopped ? ' <span class="chip amber">被上限中止</span>' : ''}${
        pending.length ? ' <span class="chip red">需要你确认</span>' : ''
      }</h3>
      ${r.stopped ? `<p class="hint">没有做完就停了：${esc(r.stopReason || '')}。这通常意味着任务太复杂，或者它绕远路了 —— 看右边的轨迹。</p>` : ''}
      ${r.falseWriteClaim ? `<p class="hint" style="color:var(--red)"><b>注意：它说已经完成了，但实际没有写入成功。</b>不要相信这段结论，请看下面的确认卡片或轨迹。</p>` : ''}
      <div class="rag-answer">${esc(r.answer || '（没有给出答案）').replace(/\n/g, '<br>')}</div>
      <div class="mt12 small muted">
        它自己选了 ${uniq.length} 个工具：${uniq.map((n) => `<span class="chip">${esc(n)}</span>`).join(' ') || '（一个都没用）'}
      </div>
      <div class="mt12 small muted">
        ${r.meta?.steps ?? 0} 轮 · ${r.meta?.toolCalls ?? 0} 次工具调用 · ${r.meta?.totalMs ?? 0}ms
        ${r.meta?.usage?.total_tokens ? ` · ${r.meta.usage.total_tokens} tokens` : ''}
        ${r.meta?.provider ? ` · ${esc(r.meta.provider)}/${esc(r.meta.model || '')}` : ''}
      </div>
      ${(r.artifacts || []).length
        ? `<div class="small muted mt12">产出文件：${r.artifacts.map((a) => `<span class="chip">${esc(a.path)}</span>`).join(' ')}</div>`
        : ''}
    </div>
    ${pending.map((p) => renderConfirmCard(p, ctx)).join('')}`;

    // 确认按钮：直接调 confirm 接口执行**已存下的那份参数**。
    // 为什么不再重跑 agent：实测模型对同一句话两次生成不完全一样（问号/标点），
    // 重跑算出的 actionId 会对不上，用户就会"点了确认什么都没发生"。
    out.querySelectorAll('.ag-approve').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.actionId;
        btn.disabled = true;
        btn.textContent = '执行中…';
        try {
          const r = await api('api/agent/confirm', { method: 'POST', body: { actionId: id } });
          btn.closest('.card')?.remove();
          toast(`已执行：${r.tool || ''}，数据已更新`);
          if (typeof ctx.onDone === 'function') ctx.onDone();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = '确认执行';
          toast(`执行失败：${err.message}`, true);
        }
      };
    });
    out.querySelectorAll('.ag-cancel').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.actionId;
        try { await api('api/agent/cancel', { method: 'POST', body: { actionId: id } }); } catch { /* 失败也无妨 */ }
        btn.closest('.card')?.remove();
        toast('已取消，没有做任何修改');
      };
    });
  }

  /** 单个待确认动作的卡片：把 impact 全部摊开给用户看。 */
  function renderConfirmCard(p, ctx) {
    const imp = p.impact || {};
    const rows = [];
    if (imp.action) rows.push(['操作', imp.action]);
    if (imp.target) rows.push(['目标', imp.target]);
    if (imp.before) rows.push(['改前', imp.before]);
    if (imp.after) rows.push(['改后', imp.after]);
    for (const c of imp.changes || []) rows.push([c.field, `${c.before} → ${c.after}`]);
    const preview = imp.preview
      ? Object.entries(imp.preview)
          .map(([k, v]) => `<div class="small"><span class="muted">${esc(k)}：</span>${esc(String(v))}</div>`)
          .join('')
      : '';
    const warnings = (imp.warnings || [])
      .map((w) => `<div class="small" style="color:var(--red)">⚠️ ${esc(w)}</div>`)
      .join('');

    return `<div class="card" style="border-color:var(--red)">
      <h3>⚖️ 这一步会改数据，需要你确认</h3>
      <p class="hint">Agent 提议执行 <b>${esc(p.tool)}</b>。请核对下面的内容 ——
        确认后才会真正写入，取消则什么都不发生。</p>
      ${rows.map(([k, v]) => `<div class="small"><span class="muted">${esc(k)}：</span><b>${esc(String(v))}</b></div>`).join('')}
      ${preview ? `<div class="mt12">${preview}</div>` : ''}
      ${warnings ? `<div class="mt12">${warnings}</div>` : ''}
      <div class="flex mt12">
        <button class="btn primary ag-approve" data-action-id="${esc(p.actionId)}">确认执行</button>
        <button class="btn ag-cancel" data-action-id="${esc(p.actionId)}">取消</button>
        <span class="small muted">动作 id ${esc(p.actionId)}</span>
      </div>
    </div>`;
  }

  function renderAgentTrace(el, r) {
    const steps = r.steps || [];
    if (!steps.length) { el.innerHTML = '<div class="empty">没有产生任何步骤</div>'; return; }
    el.innerHTML = steps
      .map((s) => {
        const calls = (s.toolCalls || [])
          .map(
            (c) => `<div class="intel-item" style="margin-bottom:6px">
          <div class="t">${c.ok ? '' : '<span class="chip red">失败</span> '}${esc(c.name)}</div>
          <div class="s mono">${esc(JSON.stringify(c.args || {}))}</div>
          <div class="m">
            <span class="chip grey">${c.ms}ms</span>
            ${c.ok ? `<span class="chip green">ok</span>` : `<span class="chip red">${esc((c.error || '').slice(0, 80))}</span>`}
          </div>
          ${c.summary ? `<div class="small muted">${esc(c.summary)}</div>` : ''}
        </div>`
          )
          .join('');
        return `<div style="margin-bottom:14px">
        <div class="small muted mb8">第 ${s.n} 轮${s.thought ? `：${esc(s.thought.slice(0, 100))}` : ''}</div>
        ${calls || '<div class="small muted">（这一轮没有调工具）</div>'}
      </div>`;
      })
      .join('');
  }

  function renderFaqList() {
    const el = $('#faqList');
    if (!el) return;
    el.innerHTML =
      state.qa.faq
        .map(
          (f) => `<div class="intel-item"><div class="t">${esc(f.q)}</div><div class="s">${esc(f.a)}</div>
        <div class="m"><button class="btn sm ghost danger right" data-faq-del="${f.id}">删除</button></div></div>`
        )
        .join('') || '<div class="empty">问答库还是空的</div>';
    $$('[data-faq-del]', el).forEach((b) => {
      b.onclick = async () => {
        await api(`api/qa/faq/${b.dataset.faqDel}`, { method: 'DELETE' });
        await renderQA();
      };
    });
  }

  async function askOne(question) {
    if (!question.trim()) return toast('先输入问题', true);
    const r = await api('api/qa/answer', { body: { question } });
    const el = $('#qaResult');
    el.innerHTML = `<div class="card">
      <h3>回答草稿 ${r.intent ? `<span class="chip">${esc(r.intent.name)}</span>` : ''}
        ${r.blocked ? '<span class="chip red">高风险，已合规改写</span>' : ''}</h3>
      ${r.warning ? `<p class="hint" style="color:#b3552e">${esc(r.warning)}</p>` : ''}
      <div style="font-size:16px;line-height:2;background:var(--tint);padding:14px 16px;border-radius:8px">${esc(r.answer)}</div>
      <div class="mt12">
        ${(r.basis || []).map((b) => `<span class="chip green">依据 · ${esc(b.text)}</span>`).join(' ')}
      </div>
      ${(r.followUps || []).length ? `<div class="mt12 muted small">可以接着补一句：${(r.followUps || []).map(esc).join(' / ')}</div>` : ''}
      ${r.risk && r.risk.hits.length
        ? `<div class="mt12"><b class="small">合规注意：</b>${r.risk.hits
            .map((h) => `<span class="chip amber">${esc(h.word)} → ${esc(h.suggest || '建议删除')}</span>`)
            .join(' ')}</div>`
        : ''}
      <div class="flex mt12"><button class="btn sm" id="qaCopy">复制回答</button>
        ${r.blocked ? '<span class="muted small">功效类问题不要顺着延伸，转回口感与工艺</span>' : ''}</div>
    </div>`;
    $('#qaCopy').onclick = () => {
      navigator.clipboard?.writeText(r.answer);
      toast('已复制');
    };
  }

  /* ================================================================ 模块5 */
  async function renderCompliance() {
    const stats = await api('api/compliance/stats');
    const kb = await api('api/compliance');
    const preset = state.pendingCheckText || '';
    state.pendingCheckText = null;
    const view = $('#view');
    $('#topActions').innerHTML = '';

    const cats = kb.categories || [];
    view.innerHTML = `
      <div class="grid c4" style="margin-bottom:16px">
        <div class="stat"><div class="k">违禁词条</div><div class="v">${stats.words} <small>条</small></div></div>
        <div class="stat"><div class="k">风险分类</div><div class="v">${stats.categories} <small>类</small></div></div>
        <div class="stat"><div class="k">正则规则</div><div class="v">${stats.patterns} <small>条</small></div></div>
        <div class="stat"><div class="k">语境规则</div><div class="v">${stats.contextRules} <small>条</small></div></div>
      </div>

      <div class="two-col">
        <div>
          <div class="card">
            <h3>检查文案</h3>
            <p class="hint">把口播稿、商品标题、短视频文案贴进来。系统做三层检查：词表、正则、以及「触发词 × 目标词」的语境规则。</p>
            <textarea id="cmpInput" rows="9" placeholder="把要检查的文案贴在这里…">${esc(preset)}</textarea>
            <div class="flex mt12">
              <button class="btn primary" id="cmpRun">开始检查</button>
              <button class="btn" id="cmpPasteDeck">用当前方案的稿子</button>
              <button class="btn ghost" id="cmpClear">清空</button>
            </div>
          </div>
          <div id="cmpResult"></div>
        </div>
        <div>
          <div class="card">
            <h3>风险分类</h3>
            <div class="scroll-y" style="max-height:44vh">
              ${cats
                .map(
                  (c) => `<div class="intel-item" style="margin-bottom:7px">
                <div class="t">${esc(c.name)} <span class="chip ${c.level === 'high' ? 'red' : 'amber'}">${c.level === 'high' ? '高' : '中'}</span>
                  <span class="chip grey">${(c.words || []).length} 词</span></div>
                <div class="s">${esc(c.risk || '')}</div>
                ${c.advice ? `<div class="small muted">处理建议：${esc(c.advice)}</div>` : ''}
              </div>`
                )
                .join('')}
            </div>
          </div>
          <div class="card">
            <h3>白名单</h3>
            <p class="hint">把你行业里的正常表达加进来，检查时会跳过。例如自家产品名、已经核准的宣传语。</p>
            <div id="wlList">
              ${(stats.whitelist || []).map((w) => `<span class="chip" style="margin:0 6px 6px 0">${esc(w)} <a href="#" data-wl-del="${esc(w)}" style="color:#b3552e;text-decoration:none">×</a></span>`).join('') || '<span class="muted small">暂无白名单</span>'}
            </div>
            <div class="row mt12"><div class="field"><input type="text" id="wlInput" placeholder="要加入白名单的词"></div>
              <button class="btn" id="wlAdd">加入</button></div>
          </div>
        </div>
      </div>`;

    $('#cmpRun').onclick = runCheck;
    $('#cmpClear').onclick = () => {
      $('#cmpInput').value = '';
      $('#cmpResult').innerHTML = '';
    };
    $('#cmpPasteDeck').onclick = () => {
      if (!state.deck) return toast('还没有生成方案', true);
      $('#cmpInput').value = state.deck.script.fullText;
      runCheck();
    };
    $('#wlAdd').onclick = async () => {
      const w = $('#wlInput').value.trim();
      if (!w) return;
      await api('api/compliance/whitelist', { body: { word: w } });
      toast('已加入白名单');
      await renderCompliance();
    };
    $$('[data-wl-del]').forEach((a) => {
      a.onclick = async (e) => {
        e.preventDefault();
        await api('api/compliance/whitelist', { method: 'DELETE', body: { word: a.dataset.wlDel } });
        await renderCompliance();
      };
    });
    if (preset) runCheck();
  }

  async function runCheck() {
    const text = $('#cmpInput').value;
    if (!text.trim()) return toast('先贴点内容', true);
    const r = await api('api/compliance/check', { body: { text } });
    const el = $('#cmpResult');

    // 高亮命中
    const sorted = [...r.hits].sort((a, b) => a.index - b.index);
    let html = '';
    let cursor = 0;
    for (const h of sorted) {
      if (h.index < cursor) continue;
      html += esc(text.slice(cursor, h.index));
      const cls = h.level === 'high' ? '' : h.level === 'medium' ? ' m' : ' l';
      html += `<mark class="hit${cls}" title="${esc(h.category)}${h.suggest ? ' → 建议：' + esc(h.suggest) : ''}">${esc(h.word)}</mark>`;
      cursor = h.index + h.length;
    }
    html += esc(text.slice(cursor));

    const lvlText = r.level === 'clean' ? '未发现违规词' : r.level === 'high' ? '存在高风险表述' : '存在需注意表述';
    const lvlCls = r.level === 'clean' ? 'green' : r.level === 'high' ? 'red' : 'amber';

    el.innerHTML = `<div class="card">
      <h3>检查结果 <span class="chip ${lvlCls}">${lvlText}</span>
        <span class="chip">高 ${r.counts.high || 0}</span><span class="chip">中 ${r.counts.medium || 0}</span><span class="chip">低 ${r.counts.low || 0}</span></h3>
      <div class="check-out" style="margin:10px 0 16px">${html}</div>
      ${r.hits.length
        ? `<h3 style="font-size:13.5px">逐条处理建议</h3>
        <div>${r.hits
          .slice(0, 40)
          .map(
            (h) => `<div class="hit-row${h.level !== 'high' ? ' m' : ''}">
          <div class="w">${esc(h.word)}</div>
          <div class="body"><span class="note">${esc(h.category)} · 位置 ${h.index}</span><br>
            ${esc(h.snippet || '')}<br>
            建议改成：<span class="sugg">${esc(h.suggest || '直接删除该表述')}</span>
            ${h.note ? `<br><span class="note">${esc(h.note)}</span>` : ''}
            <br><button class="btn sm ghost" data-wl-add="${esc(h.word)}" style="margin-top:4px">误报？加入白名单</button></div></div>`
          )
          .join('')}</div>`
        : '<div class="empty">没有发现问题。</div>'}
      ${(r.warnings || []).length
        ? `<h3 style="font-size:13.5px;margin-top:16px">提示项（需准备依据，不算违禁）</h3>
        ${r.warnings
          .map(
            (w) => `<div class="hit-row m"><div class="w">${esc(w.word)}</div>
          <div class="body"><span class="note">${esc(w.category)} · 出现 ${w.count} 次</span><br>${esc(w.note || '')}</div></div>`
          )
          .join('')}`
        : ''}
      <div class="flex mt12">
        <button class="btn" id="cmpCopyClean">复制一键替换建议稿</button>
        <span class="muted small">命中处已用【建议】标出</span>
      </div></div>`;

    $$('[data-wl-add]', el).forEach((b) => {
      b.onclick = async () => {
        await api('api/compliance/whitelist', { body: { word: b.dataset.wlAdd } });
        toast('已加入白名单');
        runCheck();
      };
    });
    $('#cmpCopyClean').onclick = () => {
      navigator.clipboard?.writeText(r.cleaned);
      toast('已复制建议稿');
    };
  }

  /* ================================================================ 模块6 */
  const emptySession = () => ({
    title: '今日直播复盘',
    date: new Date().toISOString().slice(0, 10),
    durationMin: 60,
    metrics: { peakViewers: 320, avgViewers: 140, productClicks: 460, orders: 26, gmv: 12400, newFollowers: 38, comments: 210, likes: 900 },
    segments: [
      { t: '00:05:00', label: '开场铺垫', viewers: 180, orders: 0, note: '讲今晚流程' },
      { t: '00:18:00', label: '老班章讲解', viewers: 320, orders: 9, note: '山场与树龄讲得最细' },
      { t: '00:35:00', label: '冲泡演示', viewers: 260, orders: 4, note: '现场泡给观众看' },
      { t: '00:48:00', label: '价格与下单', viewers: 300, orders: 13, note: '每泡成本算了一笔账' },
    ],
    products: [],
  });

  async function renderReview() {
    state.review.sessions = await api('api/sessions');
    if (!state.review.current) state.review.current = state.review.sessions[0] || emptySession();
    const view = $('#view');
    const s = state.review.current;
    $('#topActions').innerHTML = '<button class="btn primary" id="rvAnalyze">开始复盘</button>';

    view.innerHTML = `
      <div class="two-col">
        <div class="card">
          <h3>本场数据</h3>
          <p class="hint">填得越全，诊断越准。不知道的可以先留空。</p>
          <div class="grid c3">
            <div class="field"><label>场次名称</label><input type="text" data-sf="title" value="${esc(s.title || '')}"></div>
            <div class="field"><label>日期</label><input type="date" data-sf="date" value="${esc(s.date || '')}"></div>
            <div class="field"><label>时长（分钟）</label><input type="number" data-sf="durationMin" value="${esc(s.durationMin || '')}"></div>
            <div class="field"><label>峰值在线</label><input type="number" data-sm="peakViewers" value="${esc(s.metrics?.peakViewers ?? '')}"></div>
            <div class="field"><label>平均在线</label><input type="number" data-sm="avgViewers" value="${esc(s.metrics?.avgViewers ?? '')}"></div>
            <div class="field"><label>商品点击</label><input type="number" data-sm="productClicks" value="${esc(s.metrics?.productClicks ?? '')}"></div>
            <div class="field"><label>订单数</label><input type="number" data-sm="orders" value="${esc(s.metrics?.orders ?? '')}"></div>
            <div class="field"><label>成交金额 GMV</label><input type="number" data-sm="gmv" value="${esc(s.metrics?.gmv ?? '')}"></div>
            <div class="field"><label>新增关注</label><input type="number" data-sm="newFollowers" value="${esc(s.metrics?.newFollowers ?? '')}"></div>
            <div class="field"><label>弹幕条数</label><input type="number" data-sm="comments" value="${esc(s.metrics?.comments ?? '')}"></div>
            <div class="field"><label>点赞数</label><input type="number" data-sm="likes" value="${esc(s.metrics?.likes ?? '')}"></div>
          </div>
          <hr class="sep">
          <div class="flex" style="margin-bottom:8px"><b style="font-size:13.5px">分段记录</b>
            <span class="muted small">关键节点打点，切片建议就从这里来</span>
            <button class="btn sm right" id="addSeg">+ 加一段</button></div>
          <div id="segList"></div>
          <div class="flex mt12">
            <button class="btn primary" id="rvAnalyze2">开始复盘</button>
            <button class="btn" id="rvSave">保存这场</button>
          </div>
        </div>
        <div>
          <div class="card">
            <h3>历史记录</h3>
            <div id="sessList"></div>
          </div>
        </div>
      </div>
      <div id="reviewOut"></div>`;

    renderSegList();
    renderSessionList();
    const run = async () => {
      collectSession();
      const r = await api('api/sessions', { body: { ...s, id: s.id } });
      state.review.current = r;
      const rv = await api(`api/sessions/${r.id}/analyze`, { body: { session: r } });
      state.review.reviewData = rv;
      renderReviewOut();
      state.review.sessions = await api('api/sessions');
      renderSessionList();
      toast(`复盘完成，评级 ${rv.grade}`);
    };
    $('#rvAnalyze').onclick = run;
    $('#rvAnalyze2').onclick = run;
    $('#rvSave').onclick = async () => {
      collectSession();
      const r = await api('api/sessions', { body: { ...s, id: s.id } });
      state.review.current = r;
      toast('已保存');
      state.review.sessions = await api('api/sessions');
      renderSessionList();
    };
    $('#addSeg').onclick = () => {
      collectSession();
      s.segments = s.segments || [];
      s.segments.push({ t: '00:00:00', label: '', viewers: 0, orders: 0, note: '' });
      renderSegList();
    };
    if (state.review.reviewData && s.review) renderReviewOut();
  }

  function renderSegList() {
    const el = $('#segList');
    const s = state.review.current;
    if (!el) return;
    el.innerHTML = (s.segments || [])
      .map(
        (g, i) => `<div class="product-row" style="padding:10px 12px">
        <div class="grid c4">
          <div class="field"><label>时间点</label><input type="text" data-sg="${i}.t" value="${esc(g.t || '')}" placeholder="00:18:00"></div>
          <div class="field"><label>段落名称</label><input type="text" data-sg="${i}.label" value="${esc(g.label || '')}"></div>
          <div class="field"><label>该段在线</label><input type="number" data-sg="${i}.viewers" value="${esc(g.viewers ?? '')}"></div>
          <div class="field"><label>该段成交</label><input type="number" data-sg="${i}.orders" value="${esc(g.orders ?? '')}"></div>
        </div>
        <div class="field mt12"><label>备注（这段讲了什么，会成为切片标题）</label>
          <input type="text" data-sg="${i}.note" value="${esc(g.note || '')}"></div>
        <div class="flex" style="margin-top:6px"><button class="btn sm ghost danger right" data-del-seg="${i}">删除这段</button></div>
      </div>`
      )
      .join('');
    $$('[data-del-seg]', el).forEach((b) => {
      b.onclick = () => {
        collectSession();
        s.segments.splice(Number(b.dataset.delSeg), 1);
        renderSegList();
      };
    });
  }

  function collectSession() {
    const s = state.review.current;
    if (!$('[data-sf]')) return;
    $$('[data-sf]').forEach((i) => (s[i.dataset.sf] = i.type === 'number' ? Number(i.value) : i.value));
    s.metrics = s.metrics || {};
    $$('[data-sm]').forEach((i) => (s.metrics[i.dataset.sm] = Number(i.value) || 0));
    $$('[data-sg]').forEach((i) => {
      const [idx, key] = i.dataset.sg.split('.');
      s.segments[Number(idx)][key] = key === 'viewers' || key === 'orders' ? Number(i.value) || 0 : i.value;
    });
  }

  function renderSessionList() {
    const el = $('#sessList');
    if (!el) return;
    el.innerHTML =
      state.review.sessions
        .map(
          (x) => `<div class="intel-item"><div class="t">${esc(x.title || '未命名')}</div>
        <div class="s">${esc(x.date || '')} · ${x.durationMin || 0} 分钟
          ${x.review ? `· 评级 ${x.review.grade}（${x.review.score} 分）` : ''}</div>
        <div class="m"><button class="btn sm ghost" data-load-sess="${x.id}">打开</button>
          <button class="btn sm ghost danger right" data-del-sess="${x.id}">删除</button></div></div>`
        )
        .join('') || '<div class="empty">还没有复盘记录</div>';
    $$('[data-load-sess]', el).forEach((b) => {
      b.onclick = () => {
        state.review.current = state.review.sessions.find((x) => x.id === b.dataset.loadSess);
        state.review.reviewData = state.review.current.review || null;
        renderReview();
      };
    });
    $$('[data-del-sess]', el).forEach((b) => {
      b.onclick = async () => {
        await api(`api/sessions/${b.dataset.delSess}`, { method: 'DELETE' });
        state.review.sessions = await api('api/sessions');
        renderSessionList();
      };
    });
  }

  function renderReviewOut() {
    const el = $('#reviewOut');
    const rv = state.review.reviewData;
    if (!el || !rv) return;
    const m = rv.metrics;
    const sevCls = { high: 'red', medium: 'amber', low: 'grey' };
    el.innerHTML = `
      <div class="card">
        <h3>复盘结论 <span class="chip ${rv.grade === 'A' ? 'green' : rv.grade === 'D' ? 'red' : 'amber'}">评级 ${rv.grade} · ${rv.score} 分</span></h3>
        <div class="grid c4" style="margin:12px 0 18px">
          <div class="stat"><div class="k">客单价</div><div class="v">${m.aov} <small>元</small></div></div>
          <div class="stat"><div class="k">点击转化率</div><div class="v">${m.conversionRate ?? '—'} <small>%</small></div></div>
          <div class="stat"><div class="k">人均产出</div><div class="v">${m.gmvPerViewer} <small>元/人</small></div>
            <div class="muted small" style="margin-top:4px">GMV ÷ 平均在线（并发口径）</div></div>
          <div class="stat"><div class="k">每小时成交</div><div class="v">${m.gmvPerHour} <small>元</small></div>
            <div class="muted small" style="margin-top:4px">峰值/均值 ${m.peakToAvgRatio} 倍</div></div>
        </div>

        <h3 style="font-size:13.5px">问题诊断</h3>
        ${rv.issues.length
          ? rv.issues
              .map(
                (i) => `<div class="hit-row${i.severity === 'high' ? '' : ' m'}">
          <div class="w"><span class="chip ${sevCls[i.severity]}">${i.severity === 'high' ? '重点' : i.severity === 'medium' ? '注意' : '观察'}</span></div>
          <div class="body"><b>${esc(i.title)}</b><br><span class="note">${esc(i.detail)}</span><br>
            改进：<span class="sugg">${esc(i.action)}</span></div></div>`
              )
              .join('')
          : '<div class="empty">没有明显问题，这场数据健康。</div>'}

        <h3 style="font-size:13.5px;margin-top:18px">切片建议</h3>
        ${rv.clipHint ? `<p class="hint">${esc(rv.clipHint)}</p>` : ''}
        ${rv.clips
          .map(
            (c) => `<div class="intel-item">
          <div class="t">${esc(c.title)} <span class="chip amber">推荐度 ${c.score}</span></div>
          <div class="s">时间点 ${esc(c.startAt)} · 该段在线 ${c.viewers} · 成交 ${c.orders}<br>
            开头钩子：「${esc(c.hook)}」<br>发布建议：${esc(c.platform)} · ${esc(c.advise)}</div></div>`
          )
          .join('') || '<div class="empty">没有分段记录，无法推荐切片</div>'}

        <h3 style="font-size:13.5px;margin-top:18px">下一场行动清单</h3>
        <div>${rv.actions.map((a, i) => `<div class="line"><span class="sid">${i + 1}</span><span class="txt">${esc(a)}</span></div>`).join('')}</div>
      </div>`;
  }

  /* ============================================================== 提词器 */
  const pm = { playing: false, speed: 12, timer: null, last: 0, pos: 0, lastHighlight: 0, activeIdx: null };

  /** 行位置一次性预计算。
   *  之前每帧对 430 行做 classList + offsetTop 交错读写，会反复触发布局，
   *  把 rAF 拖到 ~5fps，表现为「点了播放几乎不动」。 */
  function prepareLines() {
    const body = $('#prompterBody');
    if (!body) return;
    pm.lines = $$('.pline', body).map((el) => ({ el, top: el.offsetTop }));
    pm.secs = $$('.psec', body).map((el) => ({ el, top: el.offsetTop, text: el.textContent }));
    pm.activeIdx = null;
    pm.footKey = '';
  }

  function updateFooter(idx) {
    const total = (pm.lines || []).length;
    const mid = $('#prompterBody').scrollTop + $('#prompterBody').clientHeight * 0.35;
    let secText = '';
    for (const s of pm.secs || []) if (s.top <= mid) secText = s.text;
    const speed = pm.speed;
    const remainPx = Math.max(0, $('#prompterBody').scrollHeight - $('#prompterBody').scrollTop - $('#prompterBody').clientHeight);
    const remainMin = speed > 0 ? Math.round(remainPx / speed / 60) : 0;
    const key = `${secText}|${idx}|${total}|${remainMin}`;
    if (key === pm.footKey) return;
    pm.footKey = key;
    $('#prompterFoot').innerHTML = `<span>${esc(secText)}</span>
      <span>进度 ${Math.max(0, idx + 1)}/${total}</span>
      <span>速度 ${speed} px/s · 剩余约 ${remainMin} 分钟</span>
      <span>空格：播放 / 暂停</span><span>↑ ↓：调速</span><span>← →：切段</span><span>M：镜像</span><span>Esc：退出</span>`;
  }

  function setActive(idx) {
    const lines = pm.lines || [];
    if (pm.activeIdx === idx) return;
    const prev = pm.activeIdx;
    if (prev !== null && lines[prev]) lines[prev].el.classList.remove('active');
    if (prev !== null && idx > prev) {
      for (let i = prev + 1; i < idx; i++) if (lines[i]) lines[i].el.classList.add('past');
    }
    if (idx >= 0 && lines[idx]) lines[idx].el.classList.add('active');
    pm.activeIdx = idx;
    updateFooter(idx);
  }

  /** 跳转后需要整体重刷一次样式（发生频率低，用一次完整 pass 即可）。 */
  function resetLineStyles() {
    for (const l of pm.lines || []) l.el.classList.remove('active', 'past');
    pm.activeIdx = null;
    pm.footKey = '';
  }

  function highlightCenter() {
    const body = $('#prompterBody');
    if (!pm.lines) prepareLines();
    const mid = body.scrollTop + body.clientHeight * 0.35;
    const lines = pm.lines || [];
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].top <= mid) idx = i;
      else break;
    }
    setActive(idx);
    return idx >= 0 ? lines[idx].el : null;
  }

  function setScroll(top) {
    const body = $('#prompterBody');
    body.scrollTop = top;
    pm.pos = top;
    resetLineStyles();
    highlightCenter();
  }

  /* 滚动驱动用「墙钟 + setInterval」而不是 requestAnimationFrame：
     rAF 在某些环境（后台标签、无合成器、远程桌面）会被节流到 1-2fps，
     那样提词器会几乎不动。墙钟计时保证任何帧率下 px/s 都是准的，
     最坏情况只是画面更新变粗，不会有累积误差。 */
  function stopLoop() {
    if (pm.timer) {
      clearInterval(pm.timer);
      pm.timer = null;
    }
  }

  function startLoop() {
    stopLoop();
    pm.last = 0;
    pm.lastHighlight = 0;
    pm.timer = setInterval(step, 33);
  }

  function step() {
    if (!pm.playing) return stopLoop();
    const now = performance.now();
    const dt = pm.last ? Math.min((now - pm.last) / 1000, 0.5) : 0;
    pm.last = now;
    const body = $('#prompterBody');
    pm.pos += pm.speed * dt;
    body.scrollTop = pm.pos;
    if (!pm.lastHighlight || now - pm.lastHighlight > 150) {
      pm.lastHighlight = now;
      highlightCenter();
    }
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 2) {
      pm.playing = false;
      stopLoop();
      $('#pmPlay').textContent = '▶ 继续滚动';
    }
  }

  function openPrompter(deck, withQA) {
    if (!deck) return toast('还没有方案可以提词', true);
    const body = $('#prompterBody');
    $('#prompterTitle').textContent = `${deck.meta.title} · ${deck.meta.durationMin} 分钟`;
    let html = '';
    for (const sec of deck.script.sections) {
      html += `<div class="psec">${esc(sec.title)} · 第 ${Math.round(sec.startSec / 60)} 分钟起</div>`;
      for (const l of sec.lines) {
        html += `<div class="pline">${l.cue ? `<span class="pcue">〔${esc(l.cue)}〕</span>` : ''}${esc(l.text)}</div>`;
      }
    }
    if ((deck.interaction || []).length) {
      html += `<div class="psec">互动环节提词 ${deck.meta.stats.gapMinutes} 分钟</div>`;
      for (const it of deck.interaction) {
        html += `<div class="pline"><span class="pcue">〔${esc(it.cue)} · ${it.minutes} 分钟〕${esc(it.title)}——${esc(it.desc)}</span></div>`;
        for (const l of it.lines || []) html += `<div class="pline">${esc(l)}</div>`;
      }
    }
    body.innerHTML = html || '<div class="pline">这份方案没有口播稿。</div>';
    $('#prompter').classList.add('show');
    prepareLines(); // 必须在显示之后量取行位置，隐藏时 offsetTop 全是 0
    setScroll(0);
    pm.playing = false;
    $('#pmPlay').textContent = '▶ 开始滚动';
    if (!withQA) pm.cueVisible = true;
    requestAnimationFrame(() => highlightCenter());
  }

  function closePrompter() {
    pm.playing = false;
    stopLoop();
    $('#prompter').classList.remove('show');
  }

  function bindPrompter() {
    $('#pmClose').onclick = closePrompter;
    $('#pmTop').onclick = () => setScroll(0);
    $('#pmPlay').onclick = () => {
      pm.playing = !pm.playing;
      $('#pmPlay').textContent = pm.playing ? '⏸ 暂停' : '▶ 继续滚动';
      if (pm.playing) {
        pm.pos = $('#prompterBody').scrollTop; // 以当前实际位置为基准，避免跳回
        startLoop();
      } else stopLoop();
    };
    $('#pmFont').oninput = (e) => {
      $$('.pline').forEach((l) => (l.style.fontSize = e.target.value + 'px'));
      prepareLines(); // 字号变了行高就变，必须重新量位置
      resetLineStyles();
      highlightCenter();
    };
    $('#pmSpeed').oninput = (e) => {
      pm.speed = Number(e.target.value);
      pm.footKey = '';
      updateFooter(pm.activeIdx ?? 0);
    };
    $('#pmMirror').onchange = (e) => $('#prompterBody').classList.toggle('mirror', e.target.checked);
    $('#pmCue').onchange = (e) => {
      $$('.pcue').forEach((c) => (c.style.display = e.target.checked ? '' : 'none'));
      prepareLines();
      resetLineStyles();
      highlightCenter();
    };
    $('#prompterBody').onscroll = () => highlightCenter();

    document.addEventListener('keydown', (e) => {
      if (!$('#prompter').classList.contains('show')) return;
      if (e.key === 'Escape') return closePrompter();
      if (e.code === 'Space') {
        e.preventDefault();
        $('#pmPlay').click();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        $('#pmSpeed').value = Math.max(2, Number($('#pmSpeed').value) - 2);
        pm.speed = Number($('#pmSpeed').value);
        pm.footKey = '';
        updateFooter(pm.activeIdx ?? 0);
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        $('#pmSpeed').value = Math.min(60, Number($('#pmSpeed').value) + 2);
        pm.speed = Number($('#pmSpeed').value);
        pm.footKey = '';
        updateFooter(pm.activeIdx ?? 0);
      }
      if (e.key === 'm' || e.key === 'M') {
        $('#pmMirror').checked = !$('#pmMirror').checked;
        $('#prompterBody').classList.toggle('mirror', $('#pmMirror').checked);
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const body = $('#prompterBody');
        const secs = $$('.psec', body);
        if (!secs.length) return;
        const mid = body.scrollTop + body.clientHeight * 0.35;
        const cur = secs.filter((s) => s.offsetTop <= mid).pop();
        let i = secs.indexOf(cur);
        i = e.key === 'ArrowRight' ? Math.min(secs.length - 1, i + 1) : Math.max(0, i - 1);
        setScroll(secs[i].offsetTop - 20);
      }
    });
    window.addEventListener('resize', () => {
      if (!$('#prompter').classList.contains('show')) return;
      prepareLines();
      resetLineStyles();
      highlightCenter();
    });
  }

  /* ================================================================ 模块9：批量生成 */
  /**
   * 批量生成：勾几个山头 → 一次出多份方案。
   *
   * 设计上刻意做成"两步"：**先预检，再生成**。
   * 因为批量操作最怕的是"跑了 40 分钟发现参数选错"，预检能先告诉你
   * "会生成几份、跳过几份"，成本几乎为零（不写盘）。
   */
  async function renderBatch() {
    const [choices, decksRaw, opts] = await Promise.all([
      api('api/batch/choices'),
      api('api/decks'),
      api('api/options'),
    ]);
    const mountains = choices.mountains || [];
    const decks = Array.isArray(decksRaw) ? decksRaw : [];
    const sel = new Set();
    const form = { purpose: 'knowledge', audience: 'veteran', style: 'storyteller', durationMin: 45 };

    const optHtml = (list, cur) =>
      list.map((o) => `<option value="${esc(o.id)}"${o.id === cur ? ' selected' : ''}>${esc(o.label)}</option>`).join('');

    const view = $('#view');
    $('#topActions').innerHTML = `
      <button class="btn" id="batchDry">预检（不生成）</button>
      <button class="btn primary" id="batchRun">开始生成</button>`;

    view.innerHTML = `
      <div class="grid c4" style="margin-bottom:16px">
        <div class="stat"><div class="k">可选山头</div><div class="v">${mountains.length} <small>个</small></div></div>
        <div class="stat"><div class="k">已勾选</div><div class="v"><span id="batchSelCount">0</span> <small>个</small></div></div>
        <div class="stat"><div class="k">已有方案</div><div class="v">${decks.length} <small>份</small></div></div>
        <div class="stat"><div class="k">单批上限</div><div class="v">50 <small>项</small></div></div>
      </div>

      <div class="two-col">
        <div>
          <div class="card">
            <h3>1. 勾选山头</h3>
            <p class="hint">同样的参数重跑会自动跳过已存在的方案，不会生成一堆重复的。</p>
            <div class="row" style="margin-bottom:10px">
              <input type="text" id="batchSearch" placeholder="搜索山头 / 产区…" style="flex:1">
              <button class="btn sm ghost" id="batchAll">全选</button>
              <button class="btn sm ghost" id="batchNone">清空</button>
            </div>
            <div class="scroll-y" id="batchList" style="max-height:42vh;border:1px solid var(--line);border-radius:8px;background:#fff"></div>
          </div>

          <div class="card mt12">
            <h3>2. 统一参数</h3>
            <p class="hint">这一批共用同一套参数。想让每一份讲法不同，去「A/B 方案对比」。</p>
            <div class="row">
              <div class="field"><label>场次目的</label><select id="bPurpose">${optHtml(opts.purposes, form.purpose)}</select></div>
              <div class="field"><label>受众</label><select id="bAudience">${optHtml(opts.audiences, form.audience)}</select></div>
            </div>
            <div class="row">
              <div class="field"><label>讲法风格</label><select id="bStyle">${optHtml(opts.styles, form.style)}</select></div>
              <div class="field"><label>计划时长</label><select id="bDuration">${(opts.durations || [])
                .map((d) => `<option value="${d}"${d === form.durationMin ? ' selected' : ''}>${d} 分钟</option>`)
                .join('')}</select></div>
            </div>
          </div>
        </div>

        <div class="card">
          <h3>结果</h3>
          <div id="batchOut"><p class="hint">还没有生成。先勾选山头，再点右上角「开始生成」。</p></div>
        </div>
      </div>`;

    /* ---- 山头列表 ---- */
    const listEl = $('#batchList');
    const renderList = (kw = '') => {
      const q = kw.trim().toLowerCase();
      const shown = mountains.filter(
        (m) => !q || m.name.toLowerCase().includes(q) || (m.region || '').toLowerCase().includes(q)
      );
      if (!shown.length) {
        listEl.innerHTML = '<p class="hint" style="padding:12px">没有匹配的山头</p>';
        return;
      }
      listEl.innerHTML = shown
        .map(
          (m) => `<label class="batch-row${sel.has(m.name) ? ' on' : ''}">
            <input type="checkbox" data-m="${esc(m.name)}"${sel.has(m.name) ? ' checked' : ''}>
            <span>${esc(m.name)}</span>
            <span class="rg">${esc(m.region || '')}${m.price ? ' · ' + esc(m.price) : ''}</span>
          </label>`
        )
        .join('');
      listEl.querySelectorAll('input[type=checkbox]').forEach((cb) => {
        cb.onchange = () => {
          const name = cb.dataset.m;
          if (cb.checked) sel.add(name);
          else sel.delete(name);
          cb.closest('.batch-row').classList.toggle('on', cb.checked);
          $('#batchSelCount').textContent = sel.size;
        };
      });
    };
    renderList();

    $('#batchSearch').oninput = (e) => renderList(e.target.value);
    $('#batchAll').onclick = () => {
      mountains.forEach((m) => sel.add(m.name));
      renderList($('#batchSearch').value);
      $('#batchSelCount').textContent = sel.size;
    };
    $('#batchNone').onclick = () => {
      sel.clear();
      renderList($('#batchSearch').value);
      $('#batchSelCount').textContent = sel.size;
    };

    const collect = () => ({
      mountains: [...sel],
      template: {
        purpose: $('#bPurpose').value,
        audience: $('#bAudience').value,
        style: $('#bStyle').value,
        durationMin: Number($('#bDuration').value),
      },
    });

    /* ---- 预检 ---- */
    $('#batchDry').onclick = async () => {
      if (!sel.size) return toast('先勾选至少一个山头', true);
      const body = collect();
      $('#batchOut').innerHTML = '<p class="hint">预检中…</p>';
      try {
        const r = await api('api/batch', { method: 'POST', body: { ...body, dryRun: true } });
        const skip = r.results.filter((x) => x.wouldSkip).length;
        $('#batchOut').innerHTML = `
          <div class="card" style="background:var(--tint);border-color:var(--primary-l)">
            <h3 style="margin-top:0">预检结果（没有生成任何东西）</h3>
            <p style="margin:6px 0;font-size:13px">
              共 <b>${r.total}</b> 项：将生成 <b>${r.total - skip}</b> 份，跳过 <b>${skip}</b> 份（参数完全相同、已有同款方案）。
            </p>
            ${skip ? '<p class="hint">想让它们重新生成，勾上「强制重跑」再点开始生成。</p>' : ''}
            <label class="flex mt12" style="font-size:12.5px">
              <input type="checkbox" id="bForce"> 强制重跑（不跳过已存在的）
            </label>
          </div>`;
      } catch (err) {
        $('#batchOut').innerHTML = `<p class="hint" style="color:var(--red)">预检失败：${esc(err.message)}</p>`;
      }
    };

    /* ---- 生成 ---- */
    $('#batchRun').onclick = async () => {
      if (!sel.size) return toast('先勾选至少一个山头', true);
      const body = { ...collect(), force: !!$('#bForce')?.checked };
      $('#batchRun').disabled = true;
      $('#batchRun').textContent = '生成中…';
      $('#batchOut').innerHTML = `<p class="hint">正在生成 ${sel.size} 份方案…（这是纯本地计算，通常几秒内完成）</p>`;
      try {
        const r = await api('api/batch', { method: 'POST', body });
        renderBatchResult(r);
      } catch (err) {
        $('#batchOut').innerHTML = `<p class="hint" style="color:var(--red)">生成失败：${esc(err.message)}</p>`;
      } finally {
        $('#batchRun').disabled = false;
        $('#batchRun').textContent = '开始生成';
      }
    };

    function renderBatchResult(r) {
      const rows = r.results || [];
      const okCount = rows.filter((x) => x.ok && !x.skipped).length;
      const skipCount = rows.filter((x) => x.skipped).length;
      const degraded = rows.filter((x) => x.degraded);

      const trs = rows
        .map((x) => {
          const badge = !x.ok
            ? '<span class="chip red">失败</span>'
            : x.skipped
              ? '<span class="chip grey">跳过</span>'
              : x.degraded
                ? '<span class="chip amber">注意</span>'
                : '<span class="chip green">成功</span>';
          const warn = (x.warnings || []).map((w) => esc(w.message)).join('；');
          const s = x.stats || {};
          // 跳过的行也要能点开：它是有 deckId 的（复用已有方案），
          // 只显示"跳过"而不给入口，用户就没法看那份方案了。
          const cell = [];
          if (x.deckId) {
            cell.push(`<button class="btn sm" data-open="${esc(x.deckId)}">${x.skipped ? '查看已有' : '查看'}</button>`);
          }
          if (warn) cell.push(`<span class="hint">${warn}</span>`);
          return `<tr>
            <td>${x.index + 1}</td>
            <td>${esc(x.label)}</td>
            <td>${badge}</td>
            <td>${s.slides ?? '-'}</td>
            <td>${s.scriptChars ?? '-'}</td>
            <td>${s.complianceHigh != null ? s.complianceHigh + ' 高' : '-'}</td>
            <td>${cell.join(' ') || '-'}</td>
          </tr>`;
        })
        .join('');

      $('#batchOut').innerHTML = `
        <div class="grid c3" style="margin-bottom:12px">
          <div class="stat"><div class="k">新生成</div><div class="v">${okCount} <small>份</small></div></div>
          <div class="stat"><div class="k">跳过</div><div class="v">${skipCount} <small>份</small></div></div>
          <div class="stat"><div class="k">需留意</div><div class="v">${degraded.length} <small>份</small></div></div>
        </div>
        ${degraded.length
          ? `<div class="card" style="background:var(--amber-bg);border-color:var(--amber-l)">
               <b>⚠ 有 ${degraded.length} 份是"降级"生成的</b>
               <p class="hint" style="margin:6px 0 0">这些山头的名字在知识库里没匹配上，生成的是<b>通用内容</b>而不是该山头的内容。
               点开表格里对应行的提示看具体原因。</p>
             </div>`
          : ''}
        <div class="tbl-wrap" style="margin-top:12px"><table class="tbl">
          <thead><tr><th>#</th><th>山头</th><th>状态</th><th>页数</th><th>字数</th><th>合规</th><th></th></tr></thead>
          <tbody>${trs}</tbody>
        </table></div>
        <p class="hint" style="margin-top:10px">耗时 ${r.ms} ms。方案已存入「PPT + 口播稿生成」的历史里，可以继续编辑或导出。</p>`;

      $('#batchOut').querySelectorAll('[data-open]').forEach((b) => {
        b.onclick = async () => {
          await goto('deck');
          await loadDeckById(b.dataset.open);
        };
      });
    }
  }

  /* ================================================================ 模块10：A/B 对比 */
  /**
   * A/B 对比：同一款茶，几种讲法，看着指标选。
   *
   * 页面上必须**先显示"事实是否锁定"**：如果变体之间价格/规格不一致，
   * 那就不是"两种讲法"而是两个商品，此时不要让用户看指标表 —— 会误导。
   */
  async function renderVariants() {
    const [choices, opts] = await Promise.all([api('api/batch/choices'), api('api/options')]);
    const mountains = choices.mountains || [];
    const variants = [
      { label: '知识科普', purpose: 'knowledge', audience: 'veteran', style: 'storyteller', durationMin: 45 },
      { label: '大促逼单', purpose: 'promo', audience: 'regular', style: 'practical', durationMin: 45 },
      { label: '新手入门', purpose: 'knowledge', audience: 'newbie', style: 'warm', durationMin: 30 },
    ];

    const view = $('#view');
    $('#topActions').innerHTML = `<button class="btn primary" id="abRun">生成对比</button>`;

    view.innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <h3>1. 选茶</h3>
        <p class="hint">同一款茶、同一场时长下比"讲法"。价格和规格<b>不允许</b>在变体里改 —— 那会变成两个商品。</p>
        <div class="row">
          <div class="field"><label>山头 / 茶品</label>
            <select id="abMountain">${mountains
              .map((m) => `<option value="${esc(m.name)}">${esc(m.name)}${m.region ? ' · ' + esc(m.region) : ''}</option>`)
              .join('')}</select>
          </div>
          <div class="field"><label>基准时长</label>
            <select id="abDuration">${(opts.durations || [])
              .map((d) => `<option value="${d}"${d === 45 ? ' selected' : ''}>${d} 分钟</option>`)
              .join('')}</select>
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <h3>2. 变体设置 <span class="chip grey" id="abCount">${variants.length} 个</span></h3>
        <p class="hint">每个变体改的是"怎么讲"（目的 / 受众 / 风格 / 时长），待会并排看指标。</p>
        <div id="abList"></div>
        <button class="btn sm ghost" id="abAdd" style="margin-top:8px">+ 添加变体</button>
      </div>

      <div id="abOut"><p class="hint">点右上角「生成对比」，会并排给出每个变体的指标。</p></div>`;

    const optHtml = (list, cur) =>
      list.map((o) => `<option value="${esc(o.id)}"${o.id === cur ? ' selected' : ''}>${esc(o.label)}</option>`).join('');

    const renderVariantRows = () => {
      $('#abList').innerHTML = variants
        .map(
          (v, i) => `<div class="ab-row" data-i="${i}">
            <div class="hd">
              <input type="text" class="vLabel" value="${esc(v.label)}" style="flex:1;font-weight:700">
              <button class="btn sm danger vDel" ${variants.length <= 2 ? 'disabled title="至少两个变体"' : ''}>删除</button>
            </div>
            <div class="row">
              <div class="field"><label>目的</label><select class="vPurpose">${optHtml(opts.purposes, v.purpose)}</select></div>
              <div class="field"><label>受众</label><select class="vAudience">${optHtml(opts.audiences, v.audience)}</select></div>
              <div class="field"><label>风格</label><select class="vStyle">${optHtml(opts.styles, v.style)}</select></div>
              <div class="field"><label>时长</label><select class="vDuration">${(opts.durations || [])
                .map((d) => `<option value="${d}"${d === v.durationMin ? ' selected' : ''}>${d} 分钟</option>`)
                .join('')}</select></div>
            </div>
          </div>`
        )
        .join('');
      $('#abCount').textContent = `${variants.length} 个`;
      $('#abList').querySelectorAll('.ab-row').forEach((row) => {
        const i = Number(row.dataset.i);
        row.querySelector('.vLabel').oninput = (e) => { variants[i].label = e.target.value; };
        row.querySelector('.vPurpose').onchange = (e) => { variants[i].purpose = e.target.value; };
        row.querySelector('.vAudience').onchange = (e) => { variants[i].audience = e.target.value; };
        row.querySelector('.vStyle').onchange = (e) => { variants[i].style = e.target.value; };
        row.querySelector('.vDuration').onchange = (e) => { variants[i].durationMin = Number(e.target.value); };
        row.querySelector('.vDel').onclick = () => {
          if (variants.length <= 2) return toast('至少要两个变体才能对比', true);
          variants.splice(i, 1);
          renderVariantRows();
        };
      });
    };
    renderVariantRows();

    $('#abAdd').onclick = () => {
      if (variants.length >= 6) return toast('最多 6 个变体，再多就分不清了', true);
      variants.push({ label: `变体 ${variants.length + 1}`, purpose: 'knowledge', audience: 'regular', style: 'practical', durationMin: 45 });
      renderVariantRows();
    };

    $('#abRun').onclick = async () => {
      const base = { mountainName: $('#abMountain').value, durationMin: Number($('#abDuration').value) };
      $('#abRun').disabled = true;
      $('#abRun').textContent = '生成中…';
      $('#abOut').innerHTML = '<p class="hint">正在生成变体…</p>';
      try {
        const r = await api('api/variants', {
          method: 'POST',
          body: {
            base,
            variants: variants.map((v) => ({
              label: v.label,
              overrides: { purpose: v.purpose, audience: v.audience, style: v.style, durationMin: v.durationMin },
            })),
          },
        });
        renderVariantResult(r);
      } catch (err) {
        $('#abOut').innerHTML = `<p class="hint" style="color:var(--red)">生成失败：${esc(err.message)}</p>`;
      } finally {
        $('#abRun').disabled = false;
        $('#abRun').textContent = '生成对比';
      }
    };

    function renderVariantResult(r) {
      /* 事实锁定失败时**不要**给指标表 —— 那两个根本不是同一个商品，比了会误导 */
      if (!r.factLocked) {
        $('#abOut').innerHTML = `
          <div class="card" style="background:var(--red-bg);border-color:#e8c4b8">
            <h3 style="margin-top:0;color:var(--red)">✗ 变体之间的事实不一致，这次对比不成立</h3>
            ${(r.warnings || []).map((w) => `<p style="margin:6px 0;font-size:13px">${esc(w.message)}</p>`).join('')}
            <p class="hint">事实字段（山头 / 茶品 / 价格 / 规格 / 年份）必须完全一致，否则比的是两个商品。</p>
          </div>`;
        return;
      }

      const rows = r.variants || [];
      const best = {
        safest: r.guidance?.safest?.label,
        densest: r.guidance?.densest?.label,
        interactive: r.guidance?.mostInteractive?.label,
      };
      const mark = (label, which) =>
        label === best[which] ? ' <span class="chip green">' + { safest: '最安全', densest: '最密', interactive: '最互动' }[which] + '</span>' : '';

      const trs = rows
        .map((v) => {
          const m = v.metrics || {};
          const comp = m.compliance || {};
          const compChip = comp.high > 0
            ? '<span class="chip red">' + comp.high + ' 高危</span>'
            : comp.medium > 0
              ? '<span class="chip amber">' + comp.medium + ' 中危</span>'
              : '<span class="chip green">无高危</span>';
          return `<tr>
            <td><b>${esc(v.label)}</b>${mark(v.label, 'safest')}${mark(v.label, 'densest')}${mark(v.label, 'interactive')}
              <div class="hint" style="font-size:11.5px">${esc(v.meta?.purposeLabel || '')} · ${esc(v.meta?.audienceLabel || '')} · ${esc(v.meta?.styleLabel || '')}</div></td>
            <td>${m.plannedMin} 分</td>
            <td>${m.slides}</td>
            <td>${m.scriptChars}</td>
            <td>${m.scriptMinutes} 分</td>
            <td>${m.densityPerMin ?? '-'}</td>
            <td>${m.contentRatio ?? '-'}%</td>
            <td>${compChip}</td>
            <td><button class="btn sm" data-open="${esc(v.deckId)}">选这个</button></td>
          </tr>`;
        })
        .join('');

      const warnHtml = (r.warnings || [])
        .map(
          (w) =>
            `<p class="hint" style="margin:4px 0;color:${w.level === 'warn' ? 'var(--amber)' : 'var(--muted)'}">${esc(w.message)}</p>`
        )
        .join('');

      $('#abOut').innerHTML = `
        <div class="card" style="background:var(--tint);border-color:var(--primary-l);margin-bottom:14px">
          <b>✓ 事实锁定通过</b>
          <span class="hint">（指纹 ${esc(r.factSignature || '')}）—— 这些变体是同一件商品的不同讲法。</span>
          ${warnHtml}
        </div>

        <div class="card">
          <h3 style="margin-top:0">指标对比</h3>
          <p class="hint">不同时长不能比绝对字数，请看「字/分」和「内容占比」。</p>
          <div class="tbl-wrap" style="margin-top:10px"><table class="tbl">
            <thead><tr>
              <th>变体</th><th>计划</th><th>页数</th><th>字数</th><th>口播</th>
              <th>字/分</th><th>内容占比</th><th>合规</th><th></th>
            </tr></thead>
            <tbody>${trs}</tbody>
          </table></div>
        </div>

        <div class="grid c3 mt12">
          <div class="stat"><div class="k">最安全</div><div class="v" style="font-size:15px">${esc(r.guidance?.safest?.label || '-')}</div>
            <div class="hint" style="font-size:11.5px;margin-top:4px">${esc(r.guidance?.safest?.why || '')}</div></div>
          <div class="stat"><div class="k">信息最密</div><div class="v" style="font-size:15px">${esc(r.guidance?.densest?.label || '-')}</div>
            <div class="hint" style="font-size:11.5px;margin-top:4px">${esc(r.guidance?.densest?.why || '')}</div></div>
          <div class="stat"><div class="k">互动最多</div><div class="v" style="font-size:15px">${esc(r.guidance?.mostInteractive?.label || '-')}</div>
            <div class="hint" style="font-size:11.5px;margin-top:4px">${esc(r.guidance?.mostInteractive?.why || '')}</div></div>
        </div>
        <p class="hint" style="margin-top:10px">${esc(r.guidance?.note || '')}</p>`;

      $('#abOut').querySelectorAll('[data-open]').forEach((b) => {
        b.onclick = async () => {
          await goto('deck');
          await loadDeckById(b.dataset.open);
        };
      });
    }
  }

  /* ================================================================ 启动 */

  /**
   * 显示当前登录身份 + 退出按钮。
   *
   * 为什么要有：多租户之后"我现在是谁、在哪个租户"是最基本的信息 ——
   * 不给用户看，他就不知道自己改的是哪家店的数据。
   */
  async function bindIdentity() {
    const foot = $('#sidebarFoot');
    if (!foot) return;
    let me;
    try {
      me = await api('api/auth/me');
    } catch {
      return; // 认证未开启或接口异常时不显示，不影响主功能
    }
    const box = document.createElement('div');
    box.id = 'identityBox';
    box.style.cssText = 'margin-top:10px;padding-top:10px;border-top:1px solid var(--line);font-size:12px;line-height:1.7';

    if (!me.authenticated) {
      box.innerHTML = `<a href="./login" style="color:var(--primary)">去登录</a>`;
      foot.appendChild(box);
      return;
    }
    if (me.mode === 'local') {
      box.innerHTML = `<div class="muted">本地模式（未开启认证）</div>`;
      foot.appendChild(box);
      return;
    }
    const roleName = { viewer: '只读', editor: '可编辑', approver: '可审批' }[me.role] || me.role;
    box.innerHTML = `
      <div><b>${esc(me.username || '-')}</b>
        <span class="chip" style="margin-left:4px">${esc(roleName)}</span>
        ${me.isAdmin ? '<span class="chip amber">管理员</span>' : ''}</div>
      <div class="muted">租户：${esc(me.tenantId || '-')}</div>
      <a href="#" id="logoutLink" style="color:var(--red);text-decoration:none">退出登录</a>`;
    foot.appendChild(box);

    $('#logoutLink').onclick = async (e) => {
      e.preventDefault();
      try {
        await api('api/auth/logout', { method: 'POST', body: {} });
      } catch { /* 忽略：即使接口失败也跳登录页 */ }
      location.replace('./login');
    };
  }

  async function boot() {
    bindPrompter();
    document.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-nav]');
      if (nav) goto(nav.dataset.nav);
    });

    try {
      const h = await api('api/health');
      $('#healthText').textContent = '正常';
      $('#healthDetail').innerHTML = h.python.ok
        ? `PPT 引擎：python-pptx ${esc(h.python.pptx)}`
        : `<span style="color:#e3c88e">PPT 引擎不可用，PPTX 导出会失败</span>`;
    } catch (err) {
      $('#healthText').textContent = '连接失败';
      $('#healthDetail').textContent = err.message;
    }

    renderNav();
    await bindIdentity();
    await goto('intel');
  }

  boot();
})();
