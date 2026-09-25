/* 唯讀靜態版的「假 API」。
 *
 * 發布版沿用本機同一份 app.js，只是沒有後端可打。這支把 fetch('/api/...')
 * 攔下來，改由內嵌的 window.__MEDKB__ 回答，因此兩邊畫面與按鍵完全一致，
 * 差別只在 /access 回 is_admin:false —— app.js 既有的訪客模式會自己接手，
 * 把編輯類的 UI 收起來。
 *
 * 寫入類請求（POST/PUT/DELETE）一律回 401。app.js 的 api() 看到 401 就把
 * isAdmin 設為 false；訪客本來就不是管理員，所以不會彈出登入框。
 */
(function () {
  'use strict';
  const DB = window.__MEDKB__ || {};
  const CATS = DB.categories || [];
  const nameOf = s => (CATS.find(c => c.slug === s) || {}).name || s;
  const lc = s => String(s == null ? '' : s).toLowerCase();

  /* 條目的搜尋欄位：對應後端 entries_fts 實際索引到的內容 */
  const blobOf = e => (e.__blob || (e.__blob = lc(
    [e.summary_md, e.table_md, e.section, e.topic_name, e.source_label,
     (e.keywords || []).join(' ')].join('\n'))));

  /* 後端 /knowledge 的 q 走 FTS；靜態版以「全部詞都要命中」的子字串比對近似，
     中文沒有空白分詞，這樣的行為跟使用者的直覺一致。 */
  function matches(e, q) {
    if (!q) return true;
    const blob = blobOf(e);
    return q.split(/[\s,，、]+/).filter(Boolean).every(t => blob.includes(t));
  }

  // ---------------------------------------------------------------- 端點

  const R = {};

  R['/access'] = () => Object.assign(
    { public_read: true, hide_raw_excerpts: true, session_hours: 720 },
    DB.access || {}, { is_admin: false });

  R['/categories'] = () => ({ categories: CATS });

  R['/highlight-colors'] = () => ({ colors: DB.colors || [] });

  R['/topics'] = qs => {
    const pageId = qs.get('page_id') ? +qs.get('page_id') : null;
    const q = lc(qs.get('q') || '');
    let rows = (DB.topics || []).filter(t => !pageId || t.page_id === pageId);
    if (q) rows = rows.filter(t => lc(t.name).includes(q) || lc(t.name_en).includes(q));
    return { topics: rows };
  };

  R['/pages'] = () => ({ pages: DB.pages || [] });

  R['/notes'] = qs => {
    const topicId = qs.get('topic_id') ? +qs.get('topic_id') : null;
    const entryId = qs.get('entry_id') ? +qs.get('entry_id') : null;
    const docId = qs.get('document_id') ? +qs.get('document_id') : null;
    const cat = qs.get('category') || '';
    const q = lc(qs.get('q') || '');
    let rows = DB.notes || [];
    if (topicId) rows = rows.filter(n => n.target_topic_id === topicId);
    if (entryId) rows = rows.filter(n => n.effective_entry_id === entryId);
    if (docId) rows = rows.filter(n => n.document_id === docId);
    if (cat) rows = rows.filter(n => n.category === cat);
    if (q) rows = rows.filter(n => lc(n.title).includes(q) || lc(n.body_md).includes(q));
    return { notes: rows };
  };

  /* 畫記不匯出（那是個人標註），一律回空集合，畫面自然就沒有畫記 */
  R['/highlights'] = () => ({ highlights: {} });
  R['/highlights/orphans'] = () => ({ highlights: [] });

  // ---------------------------------------------------------------- 知識庫

  function knowledge(qs) {
    const topicId = +qs.get('topic_id');
    const category = qs.get('category') || '';
    const docId = qs.get('document_id') ? +qs.get('document_id') : null;
    const keyword = qs.get('keyword') || '';
    const q = lc(qs.get('q') || '').trim();
    const slugs = category ? [category] : CATS.map(c => c.slug);

    let list = (DB.entries || []).filter(e => e.topic_id === topicId);
    if (category) list = list.filter(e => e.category === category);
    if (docId) list = list.filter(e => e.document_id === docId);
    if (keyword) list = list.filter(e => (e.keywords || []).some(k => k.includes(keyword)));
    if (q) list = list.filter(e => matches(e, q));

    const byCat = {};
    list.forEach(e => (byCat[e.category] = byCat[e.category] || []).push(e));

    const sections = slugs.map(slug => {
      const entries = byCat[slug] || [];
      const groups = new Map();
      entries.forEach(e => {
        let g = groups.get(e.document_id);
        if (!g) {
          g = { document_id: e.document_id, source_label: e.source_label || e.filename,
                filename: e.filename, entries: [] };
          groups.set(e.document_id, g);
        }
        g.entries.push(e);
      });
      groups.forEach(g => g.entries.sort(
        (a, b) => (a.page_start || 0) - (b.page_start || 0) || a.id - b.id));
      const conflicts = (DB.conflicts || [])
        .filter(c => c.topic_id === topicId && c.category === slug)
        .map(c => Object.assign({ highlights: [] }, c));
      const examQs = questionsForTopic(topicId, slug);
      return {
        slug, name: nameOf(slug),
        sources: [...groups.values()].sort(
          (a, b) => String(a.source_label || '').localeCompare(String(b.source_label || ''))),
        count: entries.length, conflicts, exam_questions: examQs,
        empty: !entries.length && !examQs.length,
      };
    });
    return { topic_id: topicId, sections };
  }

  R['/knowledge'] = knowledge;

  R['/topics/:id/overview'] = (qs, m) => {
    const id = +m[1];
    const topic = (DB.topics || []).find(t => t.id === id);
    if (!topic) return { __status: 404, detail: '找不到疾病主題' };
    const counts = {}, conf = {};
    (DB.entries || []).forEach(e => {
      if (e.topic_id === id) counts[e.category] = (counts[e.category] || 0) + 1;
    });
    (DB.conflicts || []).forEach(c => {
      if (c.topic_id === id) conf[c.category] = (conf[c.category] || 0) + 1;
    });
    return {
      topic,
      categories: CATS.map(c => ({
        slug: c.slug, name: c.name, count: counts[c.slug] || 0,
        conflicts: conf[c.slug] || 0, empty: !(counts[c.slug] || 0),
      })),
    };
  };

  /* 點摘要跳出的原文出處。訪客看不到原文段落（著作權），與本機訪客模式一致。 */
  R['/entries/:id/context'] = (qs, m) => {
    const id = +m[1];
    const e = (DB.entries || []).find(x => x.id === id);
    if (!e) return { __status: 404, detail: '找不到此段落' };
    return Object.assign({}, e, {
      source: (DB.documents || {})[e.document_id] || {},
      excerpt: null, excerpt_hidden: true,
      notes: [], figures: e.figures || [],
    });
  };

  // ---------------------------------------------------------------- 考古題

  function questionsForTopic(topicId, category) {
    const ids = (DB.question_topics || [])
      .filter(m => m.topic_id === topicId && (!category || m.category === category))
      .map(m => m.question_id);
    const seen = new Set();
    const out = [];
    ids.forEach(qid => {
      if (seen.has(qid)) return;
      seen.add(qid);
      const q = (DB.questions || []).find(x => x.id === qid);
      if (q) out.push(q);
    });
    return out.sort(examOrder);
  }

  const examOrder = (a, b) =>
    (b.year || 0) - (a.year || 0) ||
    (b.session_no || 0) - (a.session_no || 0) ||
    (a.number || 0) - (b.number || 0);

  R['/exams'] = () => ({ exams: DB.exams || [] });

  R['/exam-filters'] = () => DB.exam_filters || {};

  R['/exam-questions'] = qs => {
    const topicId = qs.get('topic_id') ? +qs.get('topic_id') : null;
    const follow = qs.get('follow_topic_id') ? +qs.get('follow_topic_id') : null;
    const category = qs.get('category') || '';
    const year = qs.get('year') ? +qs.get('year') : null;
    const subject = qs.get('subject') || '';
    const examId = qs.get('exam_id') ? +qs.get('exam_id') : null;
    const onlyUnmapped = qs.get('only_unmapped') === 'true';
    const q = lc(qs.get('q') || '').trim();
    const limit = +(qs.get('limit') || 100);
    const offset = +(qs.get('offset') || 0);

    let rows = DB.questions || [];
    let auto = {};

    if (topicId || category) {
      const ok = new Set((DB.question_topics || [])
        .filter(m => (!topicId || m.topic_id === topicId) &&
                     (!category || m.category === category))
        .map(m => m.question_id));
      rows = rows.filter(x => ok.has(x.id));
    }
    if (follow) {
      const ok = new Set((DB.question_topics || [])
        .filter(m => m.topic_id === follow).map(m => m.question_id));
      const skip = new Set(DB.skips || []);
      rows = rows.filter(x => ok.has(x.id) && !skip.has(x.id));
      auto = { mode: 'mapped', matched_by: '人工確認的考點對應', confirmed: ok.size };
    }
    if (onlyUnmapped) {
      const mapped = new Set((DB.question_topics || []).map(m => m.question_id));
      rows = rows.filter(x => !mapped.has(x.id));
    }
    if (year) rows = rows.filter(x => x.year === year);
    if (subject) rows = rows.filter(x => String(x.subject || '').includes(subject));
    if (examId) rows = rows.filter(x => x.exam_id === examId);
    if (q) {
      const terms = q.split(/[\s,，、]+/).filter(Boolean);
      rows = rows.filter(x => {
        const blob = (x.__blob || (x.__blob = lc(
          [x.stem, (x.options || []).join(' '), x.explanation].join('\n'))));
        return terms.some(t => blob.includes(t));   // 後端是聯集，這裡照抄
      });
    }
    rows = rows.slice().sort(examOrder);
    const total = rows.length;
    const page = rows.slice(offset, offset + limit);
    return { questions: page, count: page.length, total, auto,
             offset, limit, has_more: offset + page.length < total };
  };

  // ---------------------------------------------------------------- 圖表

  R['/figures-index'] = qs => {
    const topicId = qs.get('topic_id') ? +qs.get('topic_id') : null;
    const pageId = qs.get('page_id') ? +qs.get('page_id') : null;
    const kind = qs.get('kind') || '';
    const kw = lc(qs.get('q') || '').trim();
    const groups = new Map();
    const bucket = r => {
      let g = groups.get(r.topic_id);
      if (!g) {
        g = { topic_id: r.topic_id, topic_name: r.topic_name,
              page_id: r.page_id, sort: r.sort, items: [] };
        groups.set(r.topic_id, g);
      }
      return g;
    };
    const keep = r => (!topicId || r.topic_id === topicId) &&
                      (!pageId || r.page_id === pageId);

    if (kind !== 'table') {
      (DB.figure_index || []).forEach(r => {
        if (!keep(r)) return;
        if (kw && !(lc(r.label).includes(kw) || lc(r.caption).includes(kw) ||
                    lc(r.section).includes(kw))) return;
        if (kind === 'flow' && !r.flow) return;
        const g = bucket(r);
        if (g.items.some(i => i.kind === 'figure' && i.id === r.id)) return;
        g.items.push({ kind: 'figure', id: r.id, label: r.label || '',
                       caption: r.caption || '', updated_at: r.updated_at,
                       entry_id: r.entry_id, section: r.section || '',
                       category: r.category, flow: r.flow });
      });
    }
    if (kind === '' || kind === 'table') {
      (DB.table_index || []).forEach(r => {
        if (!keep(r)) return;
        if (kw && !(lc(r.table_md).includes(kw) || lc(r.section).includes(kw))) return;
        bucket(r).items.push({ kind: 'table', id: r.entry_id, label: '',
                               caption: r.caption, entry_id: r.entry_id,
                               section: r.section || '', category: r.category, flow: false });
      });
    }
    const out = [...groups.values()].sort(
      (a, b) => (a.page_id || 0) - (b.page_id || 0) || (a.sort || 0) - (b.sort || 0));
    return { groups: out, total: out.reduce((n, g) => n + g.items.length, 0),
             pages: (DB.pages || []).map(p => ({ id: p.id, name: p.name,
                                                 color: p.color, icon: p.icon })),
             counts: DB.figure_counts || { figures: 0, tables: 0 } };
  };

  /* 影像庫。篩選、計數、排序三件事都照 routes.images_index 重做一次：
     計數只跟著科別走（不跟分類與關鍵字），否則按鈕上的數字會跟畫面對不起來；
     排序是「檢查→序列→切片」三層，不能只照 created_at。 */
  R['/images-index'] = qs => {
    const kind = qs.get('kind') || '';
    const pid = qs.get('page_id') || '';
    const kw = (qs.get('q') || '').trim().toLowerCase();
    const all = DB.images || [];
    let items = all.filter(it => {
      if (kind === '__none') { if (it.kind) return false; }
      else if (kind && it.kind !== kind) return false;
      if (pid && String(it.page_id) !== String(pid)) return false;
      if (kw && !((it.title || '') + (it.caption || '')).toLowerCase().includes(kw)) return false;
      return true;
    });

    const newest = new Map(), firstSeen = new Map();
    items.forEach(it => {
      const st = it.study || ('\x00' + it.id);          // 單張照片各自成組
      newest.set(st, Math.max(newest.get(st) || 0, it.created_at || 0));
      const k = st + '\x01' + (it.series || '');
      const c = it.created_at || 0;
      firstSeen.set(k, Math.min(firstSeen.has(k) ? firstSeen.get(k) : c, c));
    });
    items = items.slice().sort((a, b) => {
      const sa = a.study || ('\x00' + a.id), sb = b.study || ('\x00' + b.id);
      return (newest.get(sb) - newest.get(sa))
          || (sa < sb ? -1 : sa > sb ? 1 : 0)
          || (firstSeen.get(sa + '\x01' + (a.series || ''))
              - firstSeen.get(sb + '\x01' + (b.series || '')))
          || ((a.instance_no || 0) - (b.instance_no || 0))
          || (a.id - b.id);
    });

    const counts = {};
    all.forEach(it => {
      if (pid && String(it.page_id) !== String(pid)) return;
      counts[it.kind || ''] = (counts[it.kind || ''] || 0) + 1;
    });
    const kinds = (DB.image_kinds || []).map(k => ({ ...k, count: counts[k.slug] || 0 }));
    return { kinds, items,
             pages: (DB.pages || []).map(p => ({ id: p.id, name: p.name,
                                                 color: p.color, icon: p.icon })),
             total: Object.values(counts).reduce((n, v) => n + v, 0),
             unclassified: counts[''] || 0 };
  };

  // ---------------------------------------------------------------- 路由

  const DYNAMIC = Object.keys(R).filter(k => k.includes(':')).map(k => ({
    key: k,
    re: new RegExp('^' + k.replace(/:[a-z_]+/g, '([^/]+)') + '$'),
  }));

  function handle(method, path, search) {
    if (method !== 'GET') {
      // 唯讀版沒有寫入端點；交給 app.js 既有的 401 處理
      return { status: 401, body: { detail: '這是唯讀的公開版本，無法修改內容' } };
    }
    const qs = new URLSearchParams(search || '');
    if (R[path]) return ok(R[path](qs, null));
    for (const d of DYNAMIC) {
      const m = path.match(d.re);
      if (m) return ok(R[d.key](qs, m));
    }
    return { status: 404, body: { detail: '唯讀版本沒有這個端點：' + path } };
  }

  function ok(body) {
    if (body && body.__status) {
      const { __status, ...rest } = body;
      return { status: __status, body: rest };
    }
    return { status: 200, body };
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!/^\/api\//.test(url)) return realFetch(input, init);
    const method = ((init && init.method) || 'GET').toUpperCase();
    const [path, search] = url.replace(/^\/api/, '').split('?');
    let res;
    try {
      res = handle(method, path, search);
    } catch (err) {
      res = { status: 500, body: { detail: String((err && err.message) || err) } };
    }
    return Promise.resolve(new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    }));
  };
})();

/* 醫學文獻知識庫 — 前端 */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const state = {
  topics: [], topicId: null, categories: [], overview: [], settings: null,
  activeCat: null, sources: [], colors: [], sections: [],
  filters: { q: '', category: '', document_id: '' },
  noteEditing: null, hlSel: null, organizeRun: null,
  examFilterId: null, examOffset: 0,
  pages: [], pageId: null, pageEditing: null,
  // 'page'＝在某個子頁裡（考古題／影像綁該科）；'global'＝從總覽進來（不綁科別）
  scope: 'page',
  isAdmin: true, access: {}, accessLoaded: false,
  // 沒有資料的分類預設收起來不顯示；想看「哪些還沒讀」時可用工具列的開關叫回來
  showEmptyCats: (() => { try { return localStorage.getItem('showEmptyCats') === '1'; }
                          catch (e) { return false; } })(),
};

/* 分類是不是真的空的——條目、考題、文獻矛盾三者都沒有才算 */
function catIsEmpty(s) {
  return !s.count && !(s.exam_questions || []).length && !(s.conflicts || []).length;
}

/* ================= utils ================= */
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' }, ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { detail: text }; }
  if (res.status === 401) {
    // 只有「原本是管理員、session 過期」才主動跳登入；
    // 訪客第一次載入時的 401 屬正常情形，不打擾他。
    const wasAdmin = state.isAdmin;
    state.isAdmin = false;
    applyAccessUI();
    if (wasAdmin && state.accessLoaded) openLogin();
    throw new Error(data.detail || '需要登入');
  }
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}
function toast(msg, isErr) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4600);
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = t => t ? new Date(t * 1000).toLocaleString('zh-TW', { hour12: false }) : '—';
const fmtSize = b => !b ? '—' : b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : (b / 1e3).toFixed(0) + ' KB';
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function catName(slug) { return (state.categories.find(c => c.slug === slug) || {}).name || slug; }

const BQ_COLOR = { '藍': 'blue', '紅': 'red', '黃': 'yellow',
                   blue: 'blue', red: 'red', yellow: 'yellow' };
/* 極簡 Markdown：條列、表格、引言、粗體、行內程式碼 */
function md(src) {
  if (!src) return '';
  const lines = String(src).replace(/\r/g, '').split('\n');
  const out = []; let list = 0, tbl = null, quote = null;
  const inline = t => esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // [詳見：某條目](#entry-條目id-主題id)：站內跳轉，點了捲到那一則（可跨主題）
    .replace(/\[([^\]]+)\]\(#entry-(\d+)-(\d+)\)/g,
             '<a href="#" class="entry-link" data-jump="$2" data-jumptopic="$3">$1</a>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  const closeList = () => { while (list > 0) { out.push('</ul>'); list--; } };
  const closeTbl = () => { if (tbl) { out.push('</tbody></table>'); tbl = null; } };
  // 引言整段收集起來再遞迴丟回 md()，框內的表格與清單才不會被當成純文字
  const closeQuote = () => {
    if (!quote) return;
    // 第一行寫 [!摺疊 標題] 就收成可展開的區塊。用途是「內容要保留、但預設別擋路」，
    // 例如教科書裡有時效性的段落（疫苗清單、變異株名稱、EUA 狀態）——
    // 刪掉會讓索引失真，攤開又容易被誤當成現況；收起來並在標題註明年份最剛好。
    const fold = (quote[0] || '').match(/^\[!\s*(?:摺疊|折疊|fold)\s*(.*?)\s*\]\s*(.*)$/i);
    if (fold) {
      const title = fold[1] || '已收合的內容';
      const rest = [fold[2], ...quote.slice(1)];
      out.push('<details class="md-fold"><summary>' + inline(title) + '</summary>'
               + '<div class="md-fold-body">' + md(rest.join('\n')) + '</div></details>');
      quote = null;
      return;
    }
    // 第一行寫 [!紅] / [!黃] 就換色；沒寫就是預設的藍色
    let cls = '', body = quote;
    const tag = (quote[0] || '').match(/^\[!\s*(藍|紅|黃|blue|red|yellow)\s*\]\s*(.*)$/i);
    if (tag) {
      cls = ' class="bq-' + BQ_COLOR[tag[1].toLowerCase()] + '"';
      body = [tag[2], ...quote.slice(1)];
    }
    out.push('<blockquote' + cls + '>' + md(body.join('\n')) + '</blockquote>');
    quote = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const bq = line.match(/^\s*>\s?(.*)$/);
    if (bq) {
      if (!quote) { closeList(); closeTbl(); quote = []; }
      quote.push(bq[1]);          // 只吃掉一個空格，框內縮排要留著
      continue;
    }
    closeQuote();
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^[\s|:-]+$/.test(line)) continue;
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      if (!tbl) { closeList(); out.push('<table><thead><tr>' + cells.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'); tbl = 1; }
      else out.push('<tr>' + cells.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>');
      continue;
    }
    closeTbl();
    const li = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (li) {
      const depth = Math.floor(li[1].length / 2) + 1;
      while (list < depth) { out.push('<ul>'); list++; }
      while (list > depth) { out.push('</ul>'); list--; }
      out.push(`<li>${inline(li[2])}</li>`); continue;
    }
    closeList();
    if (!line.trim()) continue;
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    out.push(h ? `<p><strong>${inline(h[2])}</strong></p>` : `<p>${inline(line)}</p>`);
  }
  closeList(); closeTbl(); closeQuote();
  return out.join('');
}

/* ================= 檢視切換 =================
   上方分頁：知識庫／考古題　　右上齒輪：設定與管理
   問答區（12）與筆記區（13）由左側分類架構清單觸發 */
function showView(v) {
  $$('.view').forEach(el => el.classList.toggle('active', el.id === 'view-' + v));
  $$('nav.tabs button').forEach(x => x.classList.toggle('active', x.dataset.view === v));
  $('#gearBtn').classList.toggle('active', v === 'settings');
  // 「總覽情境」：從總覽進來的考古題與影像不綁科別，一律顯示全部；
  // 知識庫與圖表需要子頁脈絡，所以這時候不給進。
  const globalView = (state.scope === 'global' || v === 'settings');
  document.body.classList.toggle('no-aside', globalView);
  document.body.classList.toggle('on-overview', globalView);
  if (v === 'overview') loadPages();
  if (v === 'settings') loadSettings();
  if (v === 'notes') loadNotes();
  if (v === 'exams') initExams();
  if (v === 'figs') loadFigures();
  if (v === 'imgs') loadImages();
  if (v === 'pubmed') setTimeout(() => $('#pmQ').focus(), 30);
  if (v === 'notes') state.activeCat = '__notes';
  else if (state.activeCat === '__notes') state.activeCat = null;
  renderCatNav(state.overview.length ? state.overview : null);
}
$$('nav.tabs button, #gearBtn').forEach(b => b.onclick = () => {
  if (b.dataset.view === 'overview') state.scope = 'global';
  showView(b.dataset.view);
});

/* 設定內的子分頁（文件、待確認已併入此處） */
$$('#setTabs button').forEach(b => b.onclick = () => showSetPanel(b.dataset.set));
function showSetPanel(name) {
  $$('#setTabs button').forEach(x => x.classList.toggle('active', x.dataset.set === name));
  $$('.set-panel').forEach(p => p.classList.toggle('active', p.id === 'set-' + name));
  if (name === 'docs') loadDocs();
  if (name === 'review') { loadFailures(); loadEvents(); loadOrphans(); loadOrganizeRuns(); }
  if (name === 'watch') { renderFolders(); loadStats(); }
  if (name === 'ai') loadUsage();
  if (name === 'marks') { renderColorEditor(); renderFocus(); renderHighlightManager(); }
  if (name === 'access') renderAccessPanel();
}

/* ================= 側欄 ================= */
async function loadTopics() {
  const { topics } = await api('/topics' + (state.pageId ? '?page_id=' + state.pageId : ''));
  state.topics = topics;
  renderTopics();
  const stillThere = topics.some(t => t.id === state.topicId);
  // 不自動挑第一個主題——進到子頁時停在「請自行選擇」的狀態，由使用者自己點。
  // 只有原本選著的主題還在時才留著它（換子頁、改名、重新整理後不會被踢掉）。
  if (topics.length && !stillThere) {
    state.topicId = null;
    state.topic = null;
    state.overview = [];
    state.sections = null;
    renderTopics();
    renderCatNav(null);
    $('#kbBody').innerHTML =
      '<div class="empty-note">從左側選一個疾病主題開始閱讀。</div>';
    $('#kbTitle').textContent = '尚未選擇疾病主題';
    $('#kbSub').innerHTML = '';
    $('#topicEdit').hidden = true;
    const hint = $('#emptyCatHint'); if (hint) hint.textContent = '';
  }
  else if (!topics.length) {
    state.topicId = null;
    state.overview = [];
    renderCatNav(null);
    $('#kbTitle').textContent = '此子頁尚無疾病主題';
    state.topic = null; $('#topicEdit').hidden = true;
    $('#kbSub').innerHTML = '';
    $('#kbBody').innerHTML = '';
    $('#sourceList').innerHTML = '<span class="muted small">尚無來源</span>';
    $('#kwCloud').innerHTML = '<span class="muted small">尚無關鍵字</span>';
  }
}
/* 側欄疾病主題拖曳排序（管理員）。順序存在 topics.sort，同一子頁內獨立。 */
function bindTopicReorder() {
  const tree = $('#topicTree');
  let dragId = null;

  const clearMarks = () => $$('#topicTree .topic-row').forEach(r => {
    r.classList.remove('drag-over-up', 'drag-over-down', 'dragging');
  });

  $$('#topicTree .topic-row').forEach(row => {
    row.ondragstart = ev => {
      dragId = +row.dataset.id;
      ev.dataTransfer.effectAllowed = 'move';
      // Firefox 需要真的設一份資料，拖曳才會啟動
      ev.dataTransfer.setData('text/plain', String(dragId));
      row.classList.add('dragging');
    };
    row.ondragend = () => { dragId = null; clearMarks(); };
    row.ondragover = ev => {
      if (dragId == null || +row.dataset.id === dragId) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      const from = state.topics.findIndex(t => t.id === dragId);
      const to = state.topics.findIndex(t => +t.id === +row.dataset.id);
      row.classList.toggle('drag-over-up', to < from);
      row.classList.toggle('drag-over-down', to > from);
    };
    row.ondragleave = () => row.classList.remove('drag-over-up', 'drag-over-down');
    row.ondrop = async ev => {
      ev.preventDefault();
      const targetId = +row.dataset.id;
      clearMarks();
      if (dragId == null || targetId === dragId) return;
      const ids = state.topics.map(t => t.id);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(targetId);
      if (from < 0 || to < 0) return;
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      // 先動畫面再送出，拖完立刻看得到結果；失敗才回捲
      const before = state.topics;
      state.topics = ids.map(id => before.find(t => t.id === id));
      renderTopics();
      try {
        await api('/topics/order', { method: 'PUT',
          body: { ids, page_id: state.pageId || null } });
      } catch (e) {
        state.topics = before;
        renderTopics();
        toast(e.message, true);
      }
    };
  });
}

function renderTopics() {
  const kw = ($('#topicSearch').value || '').toLowerCase();
  const list = state.topics.filter(t => !kw
    || (t.name || '').toLowerCase().includes(kw)
    || (t.name_en || '').toLowerCase().includes(kw));
  const tree = $('#topicTree');
  if (!list.length) {
    tree.innerHTML = '<div class="topic-empty muted small">尚無疾病主題，按上方 ＋ 新增</div>';
    return;
  }
  // 搜尋過濾時看到的只是子集，這時拖曳會把沒顯示的主題排錯，因此只在未過濾時開放
  const sortable = state.isAdmin && !kw;
  tree.innerHTML = list.map(t => {
    const open = t.id === state.topicId;
    return `<div class="topic-node ${open ? 'open' : ''}">
      <div class="topic-row ${open ? 'active' : ''}" data-id="${t.id}"${sortable ? ' draggable="true"' : ''}>
        <span class="caret">${open ? '▾' : '▸'}</span>
        <span class="tname">${esc(t.name)}</span>
        ${sortable ? '<span class="topic-grip" title="拖曳調整順序">⠿</span>' : ''}
      </div>
      ${open ? `<div class="cat-nav" id="catNav"></div>` : ''}
    </div>`;
  }).join('');
  if (sortable) bindTopicReorder();
  $$('#topicTree .topic-row').forEach(el => el.onclick = () => {
    const onExams = $('#view-exams').classList.contains('active');
    if (+el.dataset.id === state.topicId) {   // 再點一次收合
      state.topicId = null; state.overview = [];
      renderTopics(); $('#kbBody').innerHTML = ''; $('#kbTitle').textContent = '尚未選擇疾病主題';
      state.topic = null; $('#topicEdit').hidden = true;
      if (onExams) loadExamQuestions(false);
      return;
    }
    // 在考古題頁切換主題時留在原頁，只更新題目；其他頁面才跳回知識庫
    if (!onExams && !$('#view-kb').classList.contains('active')) showView('kb');
    selectTopic(+el.dataset.id);
  });
  if (state.overview.length) renderCatNav(state.overview);
}

$('#topicSearch').oninput = renderTopics;

$('#showEmptyCats').checked = state.showEmptyCats;
$('#showEmptyCats').onchange = ev => {
  state.showEmptyCats = ev.target.checked;
  try { localStorage.setItem('showEmptyCats', state.showEmptyCats ? '1' : '0'); } catch (e) { }
  if (state.sections) renderKnowledge(state.sections);
  if (state.overview.length) renderCatNav(state.overview);
};

$('#topicAdd').onclick = async () => {
  const name = prompt('新增疾病主題\n\n輸入中文名稱（例如：心肌梗塞）');
  if (!name || !name.trim()) return;
  const en = prompt(`「${name.trim()}」的英文名稱（可留空）\n\n填了之後，考古題的自動篩選會更準。`, '') || '';
  try {
    const r = await api('/topics', { method: 'POST',
      body: { name: name.trim(), name_en: en.trim(), page_id: state.pageId, is_focus: false } });
    await loadTopics();
    await selectTopic(r.topic_id);
    toast(`已新增「${name.trim()}」`);
  } catch (e) { toast(e.message, true); }
};

/* ---------- 修改疾病主題（改名／英文名／同義詞／換子頁） ---------- */
function openTopicModal() {
  const t = state.topic;
  if (!t) return;
  $('#tpName').value = t.name || '';
  $('#tpNameEn').value = t.name_en || '';
  let aliases = [];
  try { aliases = JSON.parse(t.aliases_json || '[]'); } catch (e) { }
  $('#tpAliases').value = aliases.join('、');
  $('#tpPage').innerHTML = state.pages.map(p =>
    `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('#tpPage').value = String(t.page_id || state.pageId || '');
  const n = (state.topics.find(x => x.id === t.id) || {}).entry_count || 0;
  $('#tpStats').textContent = n
    ? `這個主題底下有 ${n} 則條目；改名不會動到內容。`
    : '這個主題目前還沒有條目。';
  $('#topicModal').classList.add('open');
  setTimeout(() => { $('#tpName').focus(); $('#tpName').select(); }, 30);
}
$('#topicEdit').onclick = openTopicModal;
$('#tpCancel').onclick = () => $('#topicModal').classList.remove('open');
$('#tpSave').onclick = async () => {
  const t = state.topic;
  if (!t) return;
  const name = $('#tpName').value.trim();
  if (!name) return toast('請輸入主題名稱', true);
  // 全形頓號、逗號都當成分隔符——手打時很難只用半形逗號
  const aliases = $('#tpAliases').value.split(/[,、，]/).map(a => a.trim()).filter(Boolean);
  const pageId = +$('#tpPage').value || null;
  try {
    await api(`/topics/${t.id}`, { method: 'PUT', body: {
      name, name_en: $('#tpNameEn').value.trim(), aliases, page_id: pageId } });
    $('#topicModal').classList.remove('open');
    const movedAway = pageId && pageId !== state.pageId;
    if (movedAway) {                       // 換到別的子頁就跟著跳過去，否則側欄會找不到它
      state.pageId = pageId;
      localStorage.setItem('pageId', String(pageId));
      renderPageSelect();
    }
    await loadPages(false);
    await loadTopics();
    await selectTopic(t.id);
    toast(movedAway ? `已改名並移到「${(currentPage() || {}).name || ''}」` : `已改名為「${name}」`);
  } catch (e) { toast(e.message, true); }
};

function renderCatNav(overview) {
  const nav = $('#catNav');
  if (!nav) return;                      // 主題未展開時側欄沒有分類節點
  const cats = overview || state.categories.map(c => ({ ...c, count: 0, conflicts: 0, empty: true }));
  const inKb = $('#view-kb').classList.contains('active');
  // 總覽只知道條目數，只有考題的分類會被誤判成空的——已載入 sections 時以它為準
  const secBySlug = {};
  (state.sections || []).forEach(s => { secBySlug[s.slug] = s; });
  const isEmpty = c => {
    const s = secBySlug[c.slug];
    return s ? catIsEmpty(s) : !!c.empty;
  };
  const shownCats = cats.filter(c => state.showEmptyCats || !isEmpty(c));
  const rows = shownCats.map((c, idx) => `
    <a href="#cat-${c.slug}" data-slug="${c.slug}" class="${isEmpty(c) ? 'empty' : ''} ${inKb && state.activeCat === c.slug ? 'active' : ''}">
      <span>${idx + 1}. ${esc(c.name)}${c.conflicts ? ' <span class="cflag">⚠</span>' : ''}</span>
      ${isEmpty(c) ? '<span class="badge">尚無資料</span>' : ''}
    </a>`).join('');
  // 筆記區永遠緊接在分類清單後面：全部顯示時是 12，藏了空分類就跟著往前
  const noteNo = shownCats.length + 1;
  const extra = `
    <div class="cat-extra">
      <a href="#" data-view="notes" class="special note ${state.activeCat === '__notes' ? 'active' : ''}">
        <span class="lbl"><span class="sq"></span>${noteNo}. 筆記區</span>
      </a>
    </div>`;
  nav.innerHTML = rows + extra;

  $$('#catNav a[data-slug]').forEach(a => a.onclick = ev => {
    ev.preventDefault();
    if (!$('#view-kb').classList.contains('active')) showView('kb');
    state.activeCat = a.dataset.slug;
    renderCatNav(state.overview.length ? state.overview : null);
    const t = document.getElementById('cat-' + a.dataset.slug);
    if (t) {
      if (t.classList.contains('folded')) {        // 收合中就先展開，否則點了像沒反應
        t.classList.remove('folded');
        const set = foldSet(); set.delete(a.dataset.slug);
        try { localStorage.setItem('kbFolded', JSON.stringify([...set])); } catch (e) { }
      }
      t.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  $$('#catNav a[data-view]').forEach(a => a.onclick = ev => {
    ev.preventDefault();
    showView(a.dataset.view);
  });
}

async function selectTopic(id) {
  state.topicId = id;
  state.activeCat = null;
  state.sections = null;      // 先清掉上一個主題的，否則側欄會拿舊資料判斷哪些分類是空的
  state.filters = { q: '', category: '', document_id: '' };
  $('#kbSearch').value = '';
  renderTopics();
  const ov = await api(`/topics/${id}/overview`);
  state.overview = ov.categories;
  renderCatNav(ov.categories);
  state.topic = ov.topic;
  $('#kbTitle').textContent = ov.topic.name + (ov.topic.name_en ? `（${ov.topic.name_en}）` : '');
  $('#topicEdit').hidden = !state.isAdmin;
  $('#kbSub').innerHTML = '';
  await loadKnowledge();
  renderCatNav(state.overview);   // 有了 sections 才知道「只有考題」的分類其實不算空
  if ($('#view-exams').classList.contains('active')) loadExamQuestions(false);
  if ($('#view-notes').classList.contains('active')) loadNotes();
}



/* ================= 知識庫（§5） ================= */
$('#kbSearch').oninput = debounce(() => { state.filters.q = $('#kbSearch').value.trim(); loadKnowledge(); }, 320);

async function loadKnowledge() {
  if (!state.topicId) return;
  const f = state.filters;
  const qs = new URLSearchParams({ topic_id: state.topicId });
  if (f.q) qs.set('q', f.q);
  if (f.category) qs.set('category', f.category);
  if (f.document_id) qs.set('document_id', f.document_id);
  const { sections } = await api('/knowledge?' + qs.toString());
  state.sections = sections;
  renderKnowledge(sections);
}

function renderKnowledge(sections) {
  // 隱藏空分類後重新連續編號（1、2、3…），不留下 1、2、6、8 這種跳號
  const items = sections.filter(s => state.showEmptyCats || !catIsEmpty(s));
  const hidden = sections.length - items.length;
  if (!items.length) {
    $('#kbBody').innerHTML = '<div class="empty-note">這個主題的 11 個分類都還沒有資料。'
      + '勾選上方「顯示空白分類」可以看到完整架構。</div>';
    renderEmptyHint(hidden);
    return;
  }
  $('#kbBody').innerHTML = items.map((s, idx) => `
    <section class="cat ${s.count ? '' : 'is-empty'} ${catFolded(s.slug) ? 'folded' : ''}" id="cat-${s.slug}">
      <div class="cat-head" data-fold="${s.slug}" title="點擊收合／展開這個分類">
        <span class="fold-caret">▾</span>
        <h2><span class="cat-no">${idx + 1}</span>${esc(s.name)}</h2>
        ${s.count ? '' : '<span class="n">尚無資料</span>'}</div>
      ${s.conflicts.map(c => renderConflict(c)).join('')}
      ${!s.sources.length ? ((s.exam_questions && s.exam_questions.length) ? '' : '<div class="empty-note">尚無資料</div>') : s.sources.map(g => `
        <div class="src-group">
          ${g.entries.map(e => renderEntry(e, s.sources.length > 1 ? (g.source_label || g.filename) : '')).join('')}
        </div>`).join('')}
      ${renderExamBlock(s)}
    </section>`).join('');
  renderEmptyHint(hidden);
  applyAllHighlights();
  bindEntryActions();
  bindCatFolding();
}

/* 工具列上的提示：現在藏了幾個分類 */
function renderEmptyHint(hidden) {
  const el = $('#emptyCatHint');
  if (el) el.textContent = hidden > 0 ? `已隱藏 ${hidden} 個空白分類` : '';
}

/* ---------- 分類區塊收放（記在瀏覽器裡，換主題也保持一致） ---------- */
function foldSet() {
  try { return new Set(JSON.parse(localStorage.getItem('kbFolded') || '[]')); }
  catch (e) { return new Set(); }
}
function catFolded(slug) { return foldSet().has(slug); }
function bindCatFolding() {
  $$('#kbBody [data-fold]').forEach(h => h.onclick = ev => {
    if (ev.target.closest('button, a, input')) return;   // 別跟標題列上的其他控制項打架
    const sec = h.closest('.cat');
    const folded = sec.classList.toggle('folded');
    const set = foldSet();
    folded ? set.add(h.dataset.fold) : set.delete(h.dataset.fold);
    try { localStorage.setItem('kbFolded', JSON.stringify([...set])); } catch (e) { /* 無痕模式 */ }
  });
}

function stripOrdinal(t) {
  // 章節名常帶「一、」「(二)」「1.」等序號，顯示時只留文字
  return String(t || '')
    .replace(/^\s*[（(]?\s*[一二三四五六七八九十百]+\s*[）)、．.·]\s*/, '')
    .replace(/^\s*[（(]?\s*\d+\s*[）)、．.·]\s*/, '')
    .trim();
}

/* 條目底下的「這一則出過的考題」。預設收起，點右上角的考點標記展開。 */
function examYears(list) {
  // 同一場考試出過兩題就只算一場；年份新的排前面（115-2 > 115-1 > 114-2）。
  // 同一場裡只要有一題是人工確認過的，這個年份就算確認過的。
  const n = new Map();
  for (const q of list || []) {
    const t = examTag(q);
    if (!t) continue;
    const cur = n.get(t) || { tag: t, count: 0, confirmed: false };
    cur.count++;
    if (!q.auto) cur.confirmed = true;
    n.set(t, cur);
  }
  return [...n.values()].sort((a, b) => b.tag.localeCompare(a.tag, 'en', { numeric: true }));
}

function examPinHtml(entryId, list) {
  const ys = examYears(list);
  const SHOW = 3;                       // 一則出過太多場時只列最近三場，其餘收成「＋N」
  // 全部都還沒人工確認過的，標記畫成虛線並在提示裡講明是推測
  const guess = ys.every(y => !y.confirmed);
  const head = ys.slice(0, SHOW).map(y => y.tag).join(' · ');
  const rest = ys.length > SHOW ? ` ＋${ys.length - SHOW}` : '';
  const full = ys.map(y => (y.count > 1 ? `${y.tag}（${y.count} 題）` : y.tag)
                          + (y.confirmed ? '' : '？')).join('、');
  const tip = guess
    ? `推測這一則考過：${full}——由關鍵詞比對推算，還沒人工確認，點開自己核對`
    : `這一則出過的考古題：${full}`;
  return `<button class="exam-pin ${guess ? 'guess' : ''}" data-exampin="${entryId}"
    title="${esc(tip)}">${guess ? '📝' : '✅'} ${esc(head + rest)}</button>`;
}

function renderExamPoints(entryId, list) {
  const anyGuess = list.some(q => q.auto);
  return `<div class="exam-points" id="ep-${entryId}" hidden>
    <div class="ep-head">這一則出過的考題${anyGuess
      ? '<span class="ep-note">標「？」的是關鍵詞比對推測出來的，點進去核對</span>' : ''}</div>
    ${list.map(q => `<div class="ep-row ${q.auto ? 'guess' : ''}" data-epq="${q.id}">
      <span class="ep-no">${esc(examTag(q))} 第 ${q.number} 題${q.auto ? '？' : ''}</span>
      <span class="ep-stem">${esc((q.stem || '').slice(0, 46))}</span>
      ${q.answer ? `<span class="ep-ans">${esc(q.answer)}</span>` : ''}
    </div>`).join('')}
  </div>`;
}

function renderEntry(e, srcLabel) {
  const loc = [srcLabel ? '📄 ' + srcLabel : '', stripOrdinal(e.section),
               e.page_start ? `p.${e.page_start}${e.page_end && e.page_end !== e.page_start ? '–' + e.page_end : ''}` : '']
    .filter(Boolean).map(esc).join(' · ');
  const eps = e.exam_points || [];
  return `<div class="card ${e.stale ? 'entry-stale' : ''}" data-entry="${e.id}">
    <div class="src">${loc ? `<span>${loc}</span>` : '<span class="muted">未標示章節</span>'}
      ${e.edited_at ? '<span class="edited-tag" title="這一條的文字經過手動編輯，重新整理主題時不會被覆寫">已編輯</span>' : ''}
      ${noteMarks(e.notes_on)}
      ${eps.length ? `<span class="spacer"></span>${examPinHtml(e.id, eps)}` : ''}</div>
    ${eps.length ? renderExamPoints(e.id, eps) : ''}
    <div class="md" data-hl data-target-type="entry" data-target-id="${e.id}" data-field="summary">${md(e.summary_md)}</div>
    ${e.table_md ? `<div class="tbl-wrap" style="--tbl:${e.table_scale || 1}">
        ${state.isAdmin ? `<div class="tbl-zoom"><button data-tbl="${e.id}" data-dir="-1" title="縮小表格">−</button><span class="tz">${Math.round((e.table_scale || 1) * 100)}%</span><button data-tbl="${e.id}" data-dir="1" title="放大表格">＋</button></div>` : ''}
        <div class="md" data-hl data-target-type="entry" data-target-id="${e.id}" data-field="table">${md(e.table_md)}</div>
      </div>` : ''}
    ${renderFigures(e.figures, e.id)}
    <div class="act">
      <button data-src-btn="${e.id}">查看原文出處</button>
      <button data-note-btn="${e.id}">為此段落加筆記</button>
      ${state.isAdmin ? `<button data-askai-entry="${e.id}">問 AI</button>` : ''}
      ${state.isAdmin ? `<button data-edit-btn="${e.id}">編輯文字</button>` : ''}
      ${state.isAdmin ? `<button data-addfig="${e.id}">加入圖片</button>` : ''}
      ${state.isAdmin && e.edited_at ? `<button data-revert-btn="${e.id}" class="link-btn">還原成匯入時的內容</button>` : ''}
    </div></div>`;
}

/* ---------- 條目文字編輯 ---------- */
function entryById(id) {
  for (const sec of state.sections || [])
    for (const g of sec.sources || [])
      for (const e of g.entries || []) if (+e.id === +id) return e;
  return null;
}

function entryKeywords(e) {
  // /api/knowledge 給的是 keywords 陣列，PUT 回傳的是原始列的 keywords_json 字串
  if (Array.isArray(e.keywords)) return e.keywords;
  try { return JSON.parse(e.keywords_json || '[]'); } catch (_) { return []; }
}

/* ---------- 編輯器的「重點框」按鈕 ----------
   直接改 textarea 裡的 Markdown 原文：整行前面加 >，第一行視顏色加上 [!紅]／[!黃]。
   已經是重點框的話，按同色或「取消」就拆掉，按別的顏色就換色。 */
const BQ_LABELS = [['blue', '藍', '藍'], ['red', '紅', '淡紅'], ['yellow', '黃', '淡黃']];
const BQ_BTNS = BQ_LABELS.map(([k, , lab]) =>
  `<button type="button" class="ee-bq ee-bq-${k}" data-bq="${k}" title="套用${lab}色重點框"><i></i>${lab}</button>`
).join('');

function bqLineRange(v, start, end) {
  // 把選取範圍撐成完整的整行（沒選取就取游標所在那一行）
  const a = v.lastIndexOf('\n', start - 1) + 1;
  let b = v.indexOf('\n', end);
  if (b === -1) b = v.length;
  return [a, b];
}

function bqBlockRange(v, a, b) {
  // 把範圍往上下撐開到整個重點框為止。空行或沒有 > 的行就是框的邊界。
  const isQ = t => /^\s*>/.test(t);
  while (a > 0) {
    const pa = v.lastIndexOf('\n', a - 2) + 1;
    if (!isQ(v.slice(pa, a - 1))) break;
    a = pa;
  }
  while (b < v.length) {
    let nb = v.indexOf('\n', b + 1);
    if (nb === -1) nb = v.length;
    if (!isQ(v.slice(b + 1, nb))) break;
    b = nb;
  }
  return [a, b];
}

function applyBlockquote(ta, color) {
  const v = ta.value;
  let [a, b] = bqLineRange(v, ta.selectionStart, ta.selectionEnd);
  // 選取範圍只要碰到既有的重點框，就整個框一起處理——
  // 不必精準選到頭尾，游標點在框裡任何地方都能換色或整個拆掉
  if (/^\s*>/m.test(v.slice(a, b))) [a, b] = bqBlockRange(v, a, b);
  const lines = v.slice(a, b).split('\n');
  const marked = lines.filter(l => l.trim()).every(l => /^\s*>/.test(l));

  // 一律先還原成純內容：沒有 > 的行不受影響，選取範圍跨到框外時也能正確拆掉
  const body = lines.map(l => l.replace(/^\s*>\s?/, ''));
  const t = (body[0] || '').match(/^\[!\s*(?:藍|紅|黃|blue|red|yellow)\s*\]\s*(.*)$/i);
  if (t) { body[0] = t[1]; if (!body[0] && body.length > 1) body.shift(); }

  let next;
  if (color === 'off' || (marked && color === bqColorOf(lines))) {
    next = body;                                            // 拆掉
  } else {
    const tag = color === 'blue' ? '' : `[!${(BQ_LABELS.find(x => x[0] === color) || [, '藍'])[1]}] `;
    next = body.map((l, i) => {
      const head = i === 0 ? tag : '';
      return (head + l) ? '> ' + head + l : '>';   // 空行就只留 >，不要拖一個尾隨空格
    });
  }

  ta.value = v.slice(0, a) + next.join('\n') + v.slice(b);
  ta.focus();
  ta.setSelectionRange(a, a + next.join('\n').length);
}

function bqColorOf(lines) {
  const t = (lines[0] || '').match(/^\s*>\s?\[!\s*(藍|紅|黃|blue|red|yellow)\s*\]/i);
  return t ? BQ_COLOR[t[1].toLowerCase()] : 'blue';
}

function openEntryEditor(id) {
  const card = $(`.card[data-entry="${id}"]`);
  const e = entryById(id);
  if (!card || !e || card.classList.contains('editing')) return;
  card.classList.add('editing');
  card.dataset.snapshot = card.innerHTML;
  const kws = entryKeywords(e);
  card.innerHTML = `<div class="entry-edit">
    <label>章節<input class="ee-section" value="${esc(e.section || '')}"></label>
    <label>摘要（Markdown：- 條列、**粗體**）
      <div class="ee-tools">
        <span class="ee-tools-lab">重點框</span>
        ${BQ_BTNS}
        <button type="button" class="ee-bq-off" data-bq="off" title="游標點在框裡任何地方，按這個就整個拆掉">✕ 取消</button>
      </div>
      <textarea class="ee-summary" rows="10">${esc(e.summary_md || '')}</textarea></label>
    <label>表格（Markdown 表格，不需要就留空）<textarea class="ee-table" rows="6">${esc(e.table_md || '')}</textarea></label>
    <label>關鍵字（以逗號分隔，最多 8 個）<input class="ee-kws" value="${esc(kws.join('、'))}"></label>
    <div class="ee-act">
      <button class="primary" data-ee-save="${id}">儲存</button>
      <button data-ee-cancel="${id}">取消</button>
      <span class="ee-hint">⌘/Ctrl + Enter 儲存 · Esc 取消。存過的條目重新整理主題時不會被覆寫。</span>
    </div></div>`;
  const ta = card.querySelector('.ee-summary');
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  card.querySelectorAll('.ee-tools [data-bq]').forEach(b => {
    b.onclick = ev => { ev.preventDefault(); applyBlockquote(ta, b.dataset.bq); };
  });
  card.querySelector('[data-ee-save]').onclick = () => saveEntryEdit(id);
  card.querySelector('[data-ee-cancel]').onclick = () => closeEntryEditor(id);
  card.querySelectorAll('.entry-edit input, .entry-edit textarea').forEach(el => {
    el.onkeydown = ev => {
      if (ev.key === 'Escape') { ev.preventDefault(); closeEntryEditor(id); }
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); saveEntryEdit(id); }
    };
  });
}

function closeEntryEditor(id) {
  const card = $(`.card[data-entry="${id}"]`);
  if (!card || !card.dataset.snapshot) return;
  card.innerHTML = card.dataset.snapshot;
  delete card.dataset.snapshot;
  card.classList.remove('editing');
  bindEntryActions(); applyAllHighlights();
}

function mergeEntry(id, row) {
  const e = entryById(id);
  if (!e || !row) return;
  const kws = entryKeywords(row);
  Object.assign(e, row, { keywords: kws });
  delete e.keywords_json;
}

async function saveEntryEdit(id) {
  const card = $(`.card[data-entry="${id}"]`);
  const body = {
    section: card.querySelector('.ee-section').value,
    summary_md: card.querySelector('.ee-summary').value,
    table_md: card.querySelector('.ee-table').value,
    keywords: card.querySelector('.ee-kws').value,
  };
  if (!body.summary_md.trim()) { toast('摘要不可以是空的', true); return; }
  try {
    const r = await api(`/entries/${id}`, { method: 'PUT', body });
    mergeEntry(id, r.entry);
    delete card.dataset.snapshot;
    card.classList.remove('editing');
    renderKnowledge(state.sections);
    toast('已儲存');
  } catch (err) { toast(err.message, true); }
}

async function revertEntryEdit(id) {
  if (!confirm('把這一條還原成匯入時的原始內容？你手動改的文字會消失。')) return;
  try {
    const r = await api(`/entries/${id}/revert`, { method: 'POST' });
    mergeEntry(id, r.entry);
    renderKnowledge(state.sections);
    toast('已還原');
  } catch (err) { toast(err.message, true); }
}

function editFigCaption(cap, figId) {
  if (!cap || cap.isContentEditable) return;
  const before = cap.textContent.trim();
  cap.contentEditable = 'true';
  cap.classList.add('editing');
  cap.focus();
  document.getSelection().selectAllChildren(cap);
  const finish = async (save) => {
    cap.contentEditable = 'false';
    cap.classList.remove('editing');
    const next = cap.textContent.trim();
    if (!save || next === before) { cap.textContent = before; return; }
    try {
      await api(`/figures/${figId}`, { method: 'PUT', body: { caption: next } });
      if (state.figIndex && state.figIndex[figId]) state.figIndex[figId].caption = next;
      const f = (state.sections || []).flatMap(s => s.sources || []).flatMap(g => g.entries || [])
        .flatMap(e => e.figures || []).find(x => +x.id === +figId);
      if (f) f.caption = next;
      toast('圖說已更新');
    } catch (e) { cap.textContent = before; toast(e.message, true); }
  };
  cap.onkeydown = ev => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); cap.blur(); }
    if (ev.key === 'Escape') { ev.preventDefault(); cap.onblur = null; finish(false); }
  };
  cap.onblur = () => finish(true);
  cap.onclick = ev => ev.stopPropagation();   // 編輯中不要觸發燈箱
}

// 標題已經自稱「修正…」時就不要再重複標一次
function saysFix(title) { return /^\s*(修正|更正|訂正)/.test(title || ''); }

function noteMarks(list) {
  if (!list || !list.length) return '';
  return `<span class="note-marks">${list.map(n => `
    <button class="note-mark ${n.is_correction ? 'fix' : ''}" data-open-peek="${n.id}"
            title="${n.is_correction ? '修正' : '筆記'}：${esc(n.title || '（無標題）')}　點擊叫出">
      ${n.is_correction ? (saysFix(n.title) ? '⚠' : '⚠ 修正') : '📝 筆記'}${n.title ? (saysFix(n.title) ? ' ' : '：') + esc(n.title) : ''}</button>`).join('')}</span>`;
}

// 編輯圖片後檔名不變（網址才穩定），所以用 updated_at 當版本號避開瀏覽器快取
function figSrc(f) {
  const v = (f && f.updated_at) ? `?v=${Math.round(f.updated_at)}` : '';
  return (window.__SRC__.fig[f.id] || '');
}

function renderFigures(figs, entryId) {
  if (!figs || !figs.length) return '';
  return `<div class="fig-row">${figs.map(f => `
    <figure class="fig" data-fig="${f.id}" style="width:${f.display_width || 100}%">
      <img src="${figSrc(f)}" alt="${esc(f.caption || f.label)}">
      <figcaption>${esc(f.caption || f.label || '')}</figcaption>
      ${noteMarks(f.notes_on)}
      ${state.isAdmin ? `<span class="fig-grip" data-grip="${f.id}" title="拖曳調整大小"></span>` : ''}
      ${state.isAdmin ? `<button class="fig-note" data-fignote="${f.id}" title="為這張圖加筆記／修正">＋筆記</button>` : ''}
      ${state.isAdmin ? `<button class="fig-edit" data-figcap="${f.id}" title="編輯圖說">✎</button>` : ''}
      ${state.isAdmin ? `<button class="fig-edit-btn" data-figedit="${f.id}" title="裁切／旋轉／換圖">✂</button>` : ''}
      ${entryId && state.isAdmin ? `<button class="fig-x" data-unfig="${f.id}" data-entry="${entryId}" title="從此條目移除這張圖">✕</button>` : ''}
    </figure>`).join('')}</div>`;
}

function bindFigureResize() {
  $$('[data-grip]').forEach(grip => {
    grip.onmousedown = ev => {
      ev.preventDefault(); ev.stopPropagation();
      const fig = grip.closest('.fig');
      const row = fig.parentElement;
      const startX = ev.clientX;
      const startW = fig.getBoundingClientRect().width;
      const rowW = row.getBoundingClientRect().width || 1;
      fig.classList.add('resizing');
      const onMove = e => {
        const pct = Math.max(25, Math.min(100,
          Math.round((startW + (e.clientX - startX)) / rowW * 100)));
        fig.style.width = pct + '%';
      };
      const onUp = async () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        fig.classList.remove('resizing');
        const pct = Math.round(parseFloat(fig.style.width) || 100);
        try { await api(`/figures/${grip.dataset.grip}`, { method: 'PUT', body: { display_width: pct } }); }
        catch (e) { toast(e.message, true); }
        if (state.figIndex && state.figIndex[grip.dataset.grip]) state.figIndex[grip.dataset.grip].display_width = pct;
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };
  });
}

/* ================= 燈箱：看圖 + 圖片編輯（裁切／旋轉／翻轉／換圖） =================
   裁切送出的是「畫布比例」，後端改裁切框後從來源重新渲染，不是把 PNG 切掉——
   所以裁切無損、框可以往外拉救回先前裁掉的內容，也能隨時還原。            */

const LB = { figId: null, info: null, crop: null, drag: null };

function openLightbox(figId) {
  const f = (state.figIndex || {})[figId] || {};
  LB.figId = figId;
  LB.info = null;
  lbExitCrop();
  $('#lightboxImg').src = figSrc({ id: figId, updated_at: f.updated_at });
  $('#lightboxImg').hidden = false;
  $('#lightboxCap').textContent = f.caption || f.label || '';
  $('#lbTools').hidden = !state.isAdmin;
  $('#lightbox').classList.add('open');
}

function lbClose() {
  lbExitCrop();
  if (typeof svClose === 'function') svClose();
  $('#lightbox').classList.remove('open');
}

/* ---------- 編輯結果套回畫面 ---------- */
function lbApplyResult(res) {
  const stamp = res && res.updated_at;
  if (!stamp) return;
  if (state.figIndex && state.figIndex[LB.figId]) state.figIndex[LB.figId].updated_at = stamp;
  (state.sections || []).flatMap(x => x.sources || []).flatMap(g => g.entries || [])
    .flatMap(e => e.figures || []).filter(x => +x.id === +LB.figId)
    .forEach(x => { x.updated_at = stamp; x.width = res.width; x.height = res.height; });
  const src = figSrc({ id: LB.figId, updated_at: stamp });
  $('#lightboxImg').src = src;
  $$(`.fig[data-fig="${LB.figId}"] img`).forEach(im => { im.src = src; });
  LB.info = null;                       // 尺寸變了，編輯資訊要重抓
}

async function lbInfo(force) {
  if (!LB.info || force) LB.info = await api(`/figures/${LB.figId}/edit`);
  return LB.info;
}

/* ---------- 旋轉／翻轉／還原 ---------- */
async function lbTransform(kind) {
  try {
    const info = await lbInfo();
    const t = { ...info.transform };
    if (kind === 'rot') t.rotate = ((t.rotate || 0) + 90) % 360;
    if (kind === 'flipH') t.flipH = !t.flipH;
    if (kind === 'flipV') t.flipV = !t.flipV;
    const res = await api(`/figures/${LB.figId}/edit`, { method: 'POST', body: { transform: t } });
    lbApplyResult(res);
    toast(kind === 'rot' ? '已旋轉' : '已翻轉');
  } catch (e) { toast(e.message, true); }
}

async function lbReset() {
  if (!confirm('把這張圖還原成最初擷取時的樣子？裁切、旋轉與翻轉都會清掉。')) return;
  try {
    lbApplyResult(await api(`/figures/${LB.figId}/reset`, { method: 'POST' }));
    toast('已還原原圖');
  } catch (e) { toast(e.message, true); }
}

/* ---------- 換圖 / 新增圖（上傳） ---------- */
function pickImage(onPick) {
  const inp = $('#figFileInput');
  inp.value = '';
  inp.onchange = () => { if (inp.files && inp.files[0]) onPick(inp.files[0]); };
  inp.click();
}

async function upload(path, file, extra) {
  const fd = new FormData();
  fd.append('file', file);
  Object.entries(extra || {}).forEach(([k, v]) => fd.append(k, v));
  const res = await fetch('/api' + path, { method: 'POST', body: fd });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { detail: text }; }
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

function lbReplace() {
  pickImage(async file => {
    try {
      lbApplyResult(await upload(`/figures/${LB.figId}/replace`, file));
      toast('已換圖');
    } catch (e) { toast(e.message, true); }
  });
}

function addFigureToEntry(entryId) {
  pickImage(async file => {
    try {
      await upload(`/entries/${entryId}/figures/upload`, file, { caption: file.name });
      toast('已加入圖片');
      loadKnowledge();
    } catch (e) { toast(e.message, true); }
  });
}

/* ---------- 裁切 ---------- */
async function lbEnterCrop() {
  try {
    const info = await lbInfo(true);
    LB.crop = { ...info.crop };
    $('#lightboxImg').hidden = true;
    $('#lbTools').hidden = true;
    $('#lbCropTools').hidden = false;
    $('#lbCrop').hidden = false;
    $('#lbCropTools .lb-hint').textContent = info.can_expand
      ? '底圖是原文整頁，框可以往外拉、把先前裁掉的部分找回來'
      : '這張圖沒有可用的原文頁面，只能往內裁';
    const url = `/api/figures/${LB.figId}/canvas?t=${Date.now()}`;
    const canvas = $('#lbCanvas');
    const inner = $('#lbBoxImg');
    canvas.onload = () => { inner.src = url; lbPlaceBox(); };
    canvas.src = url;
  } catch (e) { toast(e.message, true); lbExitCrop(); }
}

function lbExitCrop() {
  $('#lbCrop').hidden = true;
  $('#lbCropTools').hidden = true;
  $('#lightboxImg').hidden = false;
  $('#lbTools').hidden = !state.isAdmin;
  LB.drag = null;
}

function lbPlaceBox() {
  const c = LB.crop;
  if (!c) return;
  const canvas = $('#lbCanvas');
  const box = $('#lbBox');
  const w = canvas.clientWidth, h = canvas.clientHeight;
  box.style.left = (c.x * 100) + '%';
  box.style.top = (c.y * 100) + '%';
  box.style.width = (c.w * 100) + '%';
  box.style.height = (c.h * 100) + '%';
  // 框內那張沒壓暗的圖用負位移對齊畫布，框裡看到的就是實際會存下來的範圍
  const inner = $('#lbBoxImg');
  inner.style.width = w + 'px';
  inner.style.height = h + 'px';
  inner.style.left = (-c.x * w) + 'px';
  inner.style.top = (-c.y * h) + 'px';
}

function lbBindCrop() {
  const MIN = 0.02;
  const box = $('#lbBox');
  const start = (ev, handle) => {
    ev.preventDefault();
    ev.stopPropagation();
    const rect = $('#lbCanvas').getBoundingClientRect();
    LB.drag = { handle, rect, x0: ev.clientX, y0: ev.clientY, crop: { ...LB.crop } };
    box.setPointerCapture && box.setPointerCapture(ev.pointerId);
  };
  box.onpointerdown = ev => start(ev, ev.target.dataset.h || 'move');
  box.onpointermove = ev => {
    const d = LB.drag;
    if (!d) return;
    const dx = (ev.clientX - d.x0) / d.rect.width;
    const dy = (ev.clientY - d.y0) / d.rect.height;
    const c = { ...d.crop };
    if (d.handle === 'move') {
      c.x = Math.min(Math.max(0, d.crop.x + dx), 1 - c.w);
      c.y = Math.min(Math.max(0, d.crop.y + dy), 1 - c.h);
    } else {
      let x0 = c.x, y0 = c.y, x1 = c.x + c.w, y1 = c.y + c.h;
      if (d.handle.includes('w')) x0 = Math.min(Math.max(0, x0 + dx), x1 - MIN);
      if (d.handle.includes('e')) x1 = Math.max(Math.min(1, x1 + dx), x0 + MIN);
      if (d.handle.includes('n')) y0 = Math.min(Math.max(0, y0 + dy), y1 - MIN);
      if (d.handle.includes('s')) y1 = Math.max(Math.min(1, y1 + dy), y0 + MIN);
      c.x = x0; c.y = y0; c.w = x1 - x0; c.h = y1 - y0;
    }
    LB.crop = c;
    lbPlaceBox();
  };
  const end = () => { LB.drag = null; };
  box.onpointerup = end;
  box.onpointercancel = end;
  window.addEventListener('resize', () => { if (!$('#lbCrop').hidden) lbPlaceBox(); });
}

async function lbSaveCrop() {
  try {
    const res = await api(`/figures/${LB.figId}/edit`,
                          { method: 'POST', body: { crop: LB.crop } });
    lbExitCrop();
    lbApplyResult(res);
    toast('已套用裁切');
  } catch (e) { toast(e.message, true); }
}

function bindLightboxTools() {
  const act = {
    crop: lbEnterCrop, rot: () => lbTransform('rot'),
    flipH: () => lbTransform('flipH'), flipV: () => lbTransform('flipV'),
    replace: lbReplace, reset: lbReset,
    cropCancel: lbExitCrop, cropSave: lbSaveCrop,
    cropFull: () => { LB.crop = { x: 0, y: 0, w: 1, h: 1 }; lbPlaceBox(); },
  };
  $$('#lightbox [data-lb]').forEach(b => b.onclick = ev => {
    ev.stopPropagation();
    (act[b.dataset.lb] || (() => {}))();
  });
  lbBindCrop();
}

function renderConflict(c) {
  return `<div class="conflict" data-conflict="${c.id}">
    <div class="title">⚠ 文獻矛盾：${esc(c.issue_zh)}</div>
    ${c.note_zh ? `<div class="note">${esc(c.note_zh)}</div>` : ''}
    ${c.sources.map(x => `
      <div class="qsrc">
        <div class="cite">${esc(x.source_label || '未知來源')}${x.section ? ' · ' + esc(stripOrdinal(x.section)) : ''}${x.page ? ' · p.' + x.page : ''}</div>
        ${x.stance_zh ? `<div class="stance">${esc(x.stance_zh)}</div>` : ''}
        ${x.quote ? `<blockquote data-hl data-target-type="conflict" data-target-id="${c.id}" data-field="quote" data-field-key="${x.id}">${esc(x.quote)}</blockquote>` : ''}
      </div>`).join('')}
  </div>`;
}

/* 從條目點考題編號時，拉出完整題目（沿用考古題頁的 renderQuestion） */
async function openExamPeek(qid) {
  try {
    const { questions } = await api(`/exam-questions?limit=400`);
    const q = (questions || []).find(x => x.id === qid);
    if (!q) { toast('找不到這一題', true); return; }
    const box = document.createElement('div');
    // 顯示用的 class 是 .lightbox.open（style.css），不是 .show——寫錯就會是一個看不見的 div
    box.className = 'lightbox open';
    box.innerHTML = `<div class="peek-card">${renderQuestion(q)}</div>`;
    box.onclick = ev => { if (ev.target === box) box.remove(); };
    const esc2 = ev => { if (ev.key === 'Escape') { box.remove(); document.removeEventListener('keydown', esc2); } };
    document.addEventListener('keydown', esc2);
    document.body.appendChild(box);
  } catch (e) { toast(e.message, true); }
}

function bindEntryActions() {
  $$('[data-exampin]').forEach(b => b.onclick = () => {
    const box = $(`#ep-${b.dataset.exampin}`);
    if (box) box.hidden = !box.hidden;
  });
  $$('[data-epq]').forEach(el => el.onclick = () => openExamPeek(+el.dataset.epq));
  $$('[data-src-btn]').forEach(b => b.onclick = () => openDrawer(+b.dataset.srcBtn));
  $$('[data-note-btn]').forEach(b => b.onclick = () => openNoteModal(null, { entry_id: +b.dataset.noteBtn }));
  $$('[data-fig]').forEach(el => el.onclick = ev => {
    if (ev.target.dataset && ev.target.dataset.unfig) return;
    openLightbox(+el.dataset.fig);
  });
  $$('[data-tbl]').forEach(b => b.onclick = async ev => {
    ev.stopPropagation();
    const wrap = b.closest('.tbl-wrap');
    const cur = parseFloat(getComputedStyle(wrap).getPropertyValue('--tbl')) || 1;
    const next = Math.max(0.7, Math.min(2.0, +(cur + 0.1 * (+b.dataset.dir)).toFixed(2)));
    wrap.style.setProperty('--tbl', next);
    wrap.querySelector('.tz').textContent = Math.round(next * 100) + '%';
    try { await api(`/entries/${b.dataset.tbl}/display`, { method: 'PUT', body: { table_scale: next } }); }
    catch (e) { toast(e.message, true); }
  });
  bindFigureResize();
  $$('[data-unfig]').forEach(b => b.onclick = async ev => {
    ev.stopPropagation();
    if (!confirm('把這張圖從此條目移除？（圖本身與其他條目不受影響）')) return;
    await api(`/entries/${b.dataset.entry}/figures/${b.dataset.unfig}`, { method: 'DELETE' });
    toast('已移除'); loadKnowledge();
  });
  $$('[data-edit-btn]').forEach(b => b.onclick = () => openEntryEditor(+b.dataset.editBtn));
  $$('[data-revert-btn]').forEach(b => b.onclick = () => revertEntryEdit(+b.dataset.revertBtn));
  $$('[data-open-peek]').forEach(b => b.onclick = ev => {
    ev.stopPropagation(); openNotePeekById(+b.dataset.openPeek);
  });
  $$('[data-fignote]').forEach(b => b.onclick = ev => {
    ev.stopPropagation();
    const fig = b.closest('.fig');
    const cap = fig.querySelector('figcaption').textContent.trim();
    openNoteModal(null, { figure_id: +b.dataset.fignote, is_correction: true,
                          body_md: `> ${cap}\n\n` });
  });
  $$('[data-figcap]').forEach(b => b.onclick = ev => {
    ev.stopPropagation();
    editFigCaption(b.closest('.fig').querySelector('figcaption'), b.dataset.figcap);
  });
  $$('[data-figedit]').forEach(b => b.onclick = ev => {
    ev.stopPropagation();
    openLightbox(+b.dataset.figedit);
    lbEnterCrop();
  });
  $$('[data-addfig]').forEach(b => b.onclick = () => addFigureToEntry(+b.dataset.addfig));
  bindQuestionActions();
  $$('#kbBody [data-goto-topic]').forEach(el => el.onclick = () => {
    if (+el.dataset.gotoTopic !== state.topicId) selectTopic(+el.dataset.gotoTopic);
  });
}

function renderExamBlock(s) {
  const qs = s.exam_questions || [];
  if (!qs.length) return '';
  return `<details class="exam-block">
    <summary>相關考古題（${qs.length}）— 交叉參考與練習</summary>
    <div class="inner">${qs.map(q => renderQuestion(q)).join('')}</div>
  </details>`;
}

function examTag(q) {
  // 115 年第二次 → 115-2
  if (!q.roc_year) return q.year ? String(q.year) : '';
  return q.session_no ? `${q.roc_year}-${q.session_no}` : String(q.roc_year);
}

/* 這題已經人工對應到的內文。跟條目右上角的「✅ 年份」是同一份資料的另一個方向，
   所以不論演算法找不找得到候選，只要標過就一定看得見。 */
function renderQuestionEntries(q) {
  const list = q.entries || [];
  if (!list.length) return '';
  return `<div class="q-entries">
    <div class="qe-head">📖 對應的內文 · ${list.length} 則${state.isAdmin
      ? ` <a href="#" class="qe-add" data-qrelbtn="${q.id}">＋ 再找其他條目</a>` : ''}</div>
    ${list.map(e => `<div class="qe-row" data-qego="${e.entry_id}" data-qetopic="${e.topic_id}">
      <span class="qe-main">
        <span class="qe-sec">${esc(stripOrdinal(e.section) || '（未命名章節）')}</span>
        <span class="qe-topic">${esc(e.topic_name || '')}${e.category ? ' · ' + esc(catName(e.category)) : ''}</span>
        ${e.excerpt ? `<span class="qe-text">${esc(e.excerpt)}</span>` : ''}
      </span>
      ${state.isAdmin ? `<button class="qe-x" data-qedel="${e.entry_id}" data-qeq="${q.id}"
          title="移除這則對應">✕</button>` : ''}
    </div>`).join('')}
  </div>`;
}

/* 考題附圖。考選部 PDF 的圖抽不出來，靠事後補上；管理員可直接拖檔案進來。 */
function renderQuestionImages(q) {
  const list = q.images || [];
  // 附圖改由 bin/import_exam_images.py 從考卷 PDF 自動抽取，不再從網頁上傳；
  // 這裡只負責顯示，以及讓管理員把抽錯的那張移掉（移掉後重跑那支程式會重抽）。
  if (!list.length) return '';
  return `<div class="q-imgs" data-qimg="${q.id}">
    ${list.map(im => `<figure class="q-img">
      <img src="${window.__SRC__.exam[im.id] || ''}" alt="${esc(im.caption || '題目附圖')}" loading="lazy"
           data-qimgview="${im.id}">
      ${state.isAdmin ? `<button class="q-img-x" data-qimgdel="${im.id}" title="移除這張圖">✕</button>` : ''}
      ${im.caption ? `<figcaption>${esc(im.caption)}</figcaption>` : ''}
    </figure>`).join('')}
  </div>`;
}

function bindQuestionImages() {
  $$('[data-qimgdel]').forEach(b => b.onclick = async ev => {
    ev.stopPropagation();
    if (!confirm('移除這張附圖？')) return;
    try {
      await api(`/exam-images/${b.dataset.qimgdel}`, { method: 'DELETE' });
      b.closest('figure').remove();
    } catch (e) { toast(e.message, true); }
  });
  $$('[data-qimgview]').forEach(im => im.onclick = () => {
    const box = document.createElement('div');
    box.className = 'lightbox open';
    box.innerHTML = `<img src="${im.src}" alt="">`;
    box.onclick = () => box.remove();
    document.body.appendChild(box);
  });
}

function renderQuestion(q) {
  const ans = (q.answer || '').trim();
  const head = [
    (q.roc_year || q.year) ? `<span class="yr">${esc(examTag(q))}</span>` : '',
    q.category_name ? esc(q.category_name) : '',
    q.subject ? esc(String(q.subject).slice(0, 30)) : '',
    q.number ? `第 ${q.number} 題` : '',
  ].filter(Boolean).join(' · ');
  return `<div class="q-card" data-qid="${q.id}">
    ${state.isAdmin ? `<div class="q-tools">
      <button data-qex="${q.id}" title="從目前主題的清單中排除這題（可還原）">排除</button>
      <button class="danger" data-qdel="${q.id}" title="永久刪除這題">刪除</button></div>` : ''}
    <div class="qh">${head}</div>
    <div class="q-stem">${esc(q.stem)}</div>
    ${renderQuestionImages(q)}
    <ul class="q-opts">${(q.options || []).map((o, i) =>
      `<li><b>${String.fromCharCode(65 + i)}</b><span>${esc(o)}</span></li>`).join('')}</ul>
    <div class="q-ans">${ans
      ? `<span>正確答案：<span class="val">${esc(ans)}</span></span>`
      : '<span class="muted">考選部未公布答案（可另外匯入標準答案檔）</span>'}
      ${q.note ? `<span class="muted">· ${esc(q.note)}</span>` : ''}</div>
    ${renderExplanation(q)}
    ${(q.topics || []).length ? `<div class="q-topics">${q.topics.map(t =>
      `<span class="tag" data-goto-topic="${t.topic_id}" data-goto-cat="${t.category}">${esc(t.topic_name)}／${esc(catName(t.category))}</span>`).join('')}</div>` : ''}
    ${renderQuestionEntries(q)}
    <div class="q-related" data-qrel="${q.id}">
      ${(q.entries || []).length ? ''
        : `<button class="qrel-btn" data-qrelbtn="${q.id}">📖 找對應的內文</button>`}
      <div class="qrel-body" hidden></div>
    </div>
  </div>`;
}

/* ---------- 看完題目就找對應的內文 ----------
   演算法排出最接近的條目讓你直接讀；覺得對就按「＋」記下來，
   不自動寫入——實測最高信心那一層仍有四成是字面上的巧合。 */
async function loadQuestionRelated(qid, btn) {
  // 用按鈕自己的容器，不能用 document.querySelector 找 data-qrel——
  // 同一題可能同時出現在考古題清單與內文彈窗裡，用全域查找會把結果塞進另一個。
  // 觸發者可能是 .q-related 裡的按鈕，也可能是「對應的內文」標題旁的小連結，
  // 所以從整張題目卡往下找容器；找不到才退回全域查詢。
  const card = btn && btn.closest('.q-card');
  const wrap = (btn && btn.closest('.q-related')) || (card && card.querySelector('.q-related'))
               || document.querySelector(`[data-qrel="${qid}"]`);
  if (!wrap) return;
  const body = wrap.querySelector('.qrel-body');
  if (!body.hidden) { body.hidden = true; return; }
  body.hidden = false;
  body.innerHTML = '<div class="small muted">比對中…</div>';
  try {
    const r = await api(`/exam-candidates?question_id=${qid}&limit=5`);
    const linked = new Set((r.question.entries || []).map(e => e.entry_id));
    const list = (r.candidates || []);
    body.innerHTML = list.length ? list.map(c => `
      <div class="qrel-row">
        <span class="qrel-main" data-qrelgo="${c.entry_id}" data-qreltopic="${c.topic_id}">
          <span class="qrel-sec">${esc(stripOrdinal(c.section) || '（未命名章節）')}</span>
          <span class="qrel-topic">${esc(c.topic_name)}${c.category ? ' · ' + esc(catName(c.category)) : ''}</span>
          ${c.excerpt ? `<span class="qrel-text">${esc(c.excerpt)}</span>` : ''}
        </span>
        ${state.isAdmin ? `<button class="qrel-add ${linked.has(c.entry_id) ? 'on' : ''}"
            data-qreladd="${c.entry_id}" data-qrelq="${qid}"
            title="${linked.has(c.entry_id) ? '已記為考點' : '記為這一題的考點'}">${linked.has(c.entry_id) ? '✓' : '＋'}</button>` : ''}
      </div>`).join('')
      : '<div class="small muted">找不到夠接近的條目——這題可能不在知識庫涵蓋的範圍。</div>';
    bindQuestionRelated();
  } catch (e) { body.innerHTML = `<div class="small danger">${esc(e.message)}</div>`; }
}

function bindQuestionRelated() {
  $$('[data-qrelgo]').forEach(el => el.onclick =
    () => jumpToEntry(+el.dataset.qrelgo, +el.dataset.qreltopic));
  $$('[data-qreladd]').forEach(b => b.onclick = async ev => {
    ev.stopPropagation();
    const eid = +b.dataset.qreladd, qid = +b.dataset.qrelq;
    try {
      if (b.classList.contains('on')) {
        await api(`/exam-question-entries?question_id=${qid}&entry_id=${eid}`, { method: 'DELETE' });
        b.classList.remove('on'); b.textContent = '＋';
      } else {
        await api('/exam-question-entries', { method: 'POST',
          body: { question_id: qid, entry_id: eid, relevance: 1 } });
        b.classList.add('on'); b.textContent = '✓'; toast('已記為考點');
      }
    } catch (e) { toast(e.message, true); }
  });
}

/* ---------- 每題的「解析」欄位 ---------- */
function renderExplanation(q) {
  const txt = (q.explanation || '').trim();
  state.explCache = state.explCache || {};
  state.explCache[q.id] = txt;
  if (!txt && !state.isAdmin) return '';
  return `<div class="q-expl-wrap ${txt ? '' : 'is-empty'}" data-qexpl="${q.id}">
    ${explInner(q.id, txt)}</div>`;
}

function explInner(qid, txt) {
  return `<div class="q-expl-label">解析${state.isAdmin
      ? `<button class="expl-edit" data-expl-edit="${qid}">${txt ? '編輯' : '寫解析'}</button>` : ''}</div>
    <div class="q-expl">${txt ? md(txt) : '<span class="muted">尚未填寫</span>'}</div>`;
}

function editExplanation(qid) {
  const wrap = $(`[data-qexpl="${qid}"]`);
  if (!wrap || wrap.classList.contains('editing')) return;
  const cur = (state.explCache || {})[qid] || '';
  wrap.dataset.snapshot = wrap.innerHTML;
  wrap.classList.add('editing');
  wrap.innerHTML = `<div class="q-expl-label">解析</div>
    <textarea class="expl-ta" rows="4" placeholder="寫下這題的解析、易錯點、相關觀念…（支援 Markdown）">${esc(cur)}</textarea>
    <div class="expl-act">
      <button class="primary" data-expl-save="${qid}">儲存</button>
      <button data-expl-cancel="${qid}">取消</button>
      <span class="muted small">⌘/Ctrl + Enter 儲存 · Esc 取消</span>
    </div>`;
  const ta = wrap.querySelector('.expl-ta');
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  wrap.querySelector('[data-expl-save]').onclick = () => saveExplanation(qid);
  wrap.querySelector('[data-expl-cancel]').onclick = () => closeExplanation(qid);
  ta.onkeydown = ev => {
    ev.stopPropagation();
    if (ev.key === 'Escape') { ev.preventDefault(); closeExplanation(qid); }
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); saveExplanation(qid); }
  };
}

function closeExplanation(qid) {
  const wrap = $(`[data-qexpl="${qid}"]`);
  if (!wrap || !wrap.dataset.snapshot) return;
  wrap.innerHTML = wrap.dataset.snapshot;
  delete wrap.dataset.snapshot;
  wrap.classList.remove('editing');
  bindQuestionActions();
}

async function saveExplanation(qid) {
  const wrap = $(`[data-qexpl="${qid}"]`);
  const txt = wrap.querySelector('.expl-ta').value.trim();
  try {
    await api(`/exam-questions/${qid}`, { method: 'PUT', body: { explanation: txt } });
    state.explCache = state.explCache || {};
    state.explCache[qid] = txt;
    delete wrap.dataset.snapshot;
    wrap.classList.remove('editing');
    wrap.classList.toggle('is-empty', !txt);
    wrap.innerHTML = explInner(qid, txt);
    bindQuestionActions();
    toast(txt ? '解析已儲存' : '解析已清空');
  } catch (e) { toast(e.message, true); }
}

/* 考題卡片上的動作。知識庫內嵌的考題與考古題分頁共用同一份卡片，
   因此這裡不限定容器——原本只綁 #exList，知識庫裡的按鈕點了沒反應。 */
function bindQuestionActions() {
  bindQuestionImages();
  $$('[data-qrelbtn]').forEach(b => b.onclick = ev => {
    ev.preventDefault(); ev.stopPropagation();   // 也可能是 <a>，要擋掉跳回頁首
    loadQuestionRelated(+b.dataset.qrelbtn, b);
  });
  $$('[data-qego]').forEach(el => el.onclick = ev => {
    if (ev.target.dataset && ev.target.dataset.qedel) return;
    jumpToEntry(+el.dataset.qego, +el.dataset.qetopic);
  });
  $$('[data-qedel]').forEach(b => b.onclick = async ev => {
    ev.stopPropagation();
    if (!confirm('移除這則內文對應？')) return;
    try {
      await api(`/exam-question-entries?question_id=${b.dataset.qeq}&entry_id=${b.dataset.qedel}`,
                { method: 'DELETE' });
      b.closest('.qe-row').remove();
      toast('已移除');
    } catch (e) { toast(e.message, true); }
  });
  $$('[data-expl-edit]').forEach(b => b.onclick = ev => {
    ev.stopPropagation(); editExplanation(+b.dataset.explEdit);
  });
  $$('[data-qex]').forEach(b => b.onclick = async () => {
    if (!state.topicId) return toast('請先選擇疾病主題', true);
    const name = (state.topics.find(t => t.id === state.topicId)
                  || state.topic || {}).name || '';
    if (!confirm(`把這題從「${name}」的清單中排除？\n（題目不會被刪除，可在提示列還原）`)) return;
    await api('/exam-questions/exclude', { method: 'POST',
      body: { question_id: +b.dataset.qex, topic_id: state.topicId } });
    toast('已排除');
    if ($('#view-exams').classList.contains('active')) loadExamQuestions(false);
    else loadKnowledge();
  });
  $$('[data-qdel]').forEach(b => b.onclick = async () => {
    if (!confirm('永久刪除這道題目？\n（重新匯入該份考卷會再出現）')) return;
    await api(`/exam-questions/${b.dataset.qdel}`, { method: 'DELETE' });
    toast('已刪除');
    if ($('#view-exams').classList.contains('active')) { loadExamTable(); loadExamQuestions(false); }
    else loadKnowledge();
  });
}

/* ================= 考古題頁（§10） ================= */
let examInited = false;
function renderAutoBar(auto, total) {
  const bar = $('#exPinned');
  if (!bar) return;
  if (!$('#exFollow').checked || !state.topicId) { bar.hidden = true; return; }
  // state.topics 只裝「目前子頁」的主題；跨子頁時找不到，要退回已載入的 state.topic，
  // 否則橫幅會變成「只顯示與　相關的題目」，主題名整個消失
  const name = (state.topics.find(t => t.id === state.topicId)
                || state.topic || {}).name || '';
  bar.hidden = false;
  // 清單只來自人工確認的考點對應，所以不再需要顯示比對詞與比對範圍
  bar.innerHTML = `🎯 只顯示與 <b>${esc(name)}</b> 相關的題目 · 共 ${total} 題`;
}

$('#exFollow').onchange = async () => {
  try {
    await api(`/pages/${state.pageId}`, { method: 'PUT',
      body: { exam_filter: { follow: $('#exFollow').checked } } });
    await loadPages();
  } catch (e) { /* 未登入時不影響瀏覽 */ }
  loadExamQuestions(false);
};


async function initExams() {
  if (!examInited) {
    const f = await api('/exam-filters');
    $('#exYear').innerHTML = '<option value="">全部年份</option>' +
      f.years.map(y => `<option value="${y}">${y - 1911} 年（${y}）</option>`).join('');
    $('#exSubject').innerHTML = '<option value="">全部科別</option>' +
      f.subjects.map(x => `<option value="${esc(x)}">${esc(String(x).slice(0, 34))}</option>`).join('');
    $('#exCat').innerHTML = '<option value="">全部分類</option>' +
      state.categories.map(c => `<option value="${c.slug}">${esc(c.name)}</option>`).join('');
    examInited = true;
  }
  const saved = (currentPage() || {}).exam_filter;
  if (saved && typeof saved.follow === 'boolean') $('#exFollow').checked = saved.follow;
  loadExamTable();
  loadExamQuestions(false);
}
async function loadExamTable() {
  const { exams } = await api('/exams');
  $('#examTable').innerHTML = !exams.length
    ? '<div class="empty-note">尚無考卷。把考題 PDF 放進監控資料夾即可自動匯入。</div>'
    : `<table class="grid"><thead><tr><th>年份</th><th>類科／科目</th><th></th></tr></thead><tbody>
      ${exams.map(e => `<tr>
        <td class="small"><b>${e.roc_year ? (e.session_no ? e.roc_year + '-' + e.session_no : e.roc_year) : (e.year || '—')}</b></td>
        <td><div class="small">${esc(e.category_name || '')}</div><div class="small muted">${esc(String(e.subject || '').slice(0, 46))}</div></td>
        <td><button data-exfilter="${e.id}">只看此卷</button></td>
      </tr>`).join('')}</tbody></table>`;
  $$('[data-exfilter]').forEach(b => b.onclick = () => { state.examFilterId = b.dataset.exfilter; loadExamQuestions(false); });
}
const EXAM_PAGE = 60;
function examQuery(offset) {
  const qs = new URLSearchParams({ limit: String(EXAM_PAGE), offset: String(offset) });
  if ($('#exQ').value.trim()) qs.set('q', $('#exQ').value.trim());
  if ($('#exYear').value) qs.set('year', $('#exYear').value);
  if ($('#exSubject').value) qs.set('subject', $('#exSubject').value);
  if ($('#exCat').value) qs.set('category', $('#exCat').value);
  if ($('#exFollow').checked && state.topicId) {
    qs.set('follow_topic_id', state.topicId);
  }
  if (state.examFilterId) qs.set('exam_id', state.examFilterId);
  return qs.toString();
}
async function loadExamQuestions(append) {
  const offset = append ? (state.examOffset || 0) : 0;
  const r = await api('/exam-questions?' + examQuery(offset));
  state.examOffset = offset + r.count;
  renderAutoBar(r.auto, r.total);
  const cards = r.questions.map(q => renderQuestion(q)).join('');
  if (!append) {
    $('#exList').innerHTML = !r.total
      ? '<div class="empty-note">沒有符合條件的題目</div>'
      : `<div class="sub" id="exCount"></div><div id="exCards">${cards}</div>
         <div class="row" id="exMoreRow" style="justify-content:center;margin:12px 0"></div>`;
  } else {
    const box = $('#exCards');
    if (box) box.insertAdjacentHTML('beforeend', cards);
  }
  if (r.total) {
    $('#exCount').innerHTML = `共 <b>${r.total}</b> 題`
      + (state.examOffset < r.total ? `，已顯示 ${state.examOffset} 題` : '')
      + (state.examFilterId ? '（已篩選單一考卷）' : '');
    $('#exMoreRow').innerHTML = r.has_more
      ? `<button class="primary" id="exMore">載入更多（剩 ${r.total - state.examOffset} 題）</button>`
      : (r.total > EXAM_PAGE ? '<span class="muted small">已顯示全部題目</span>' : '');
    const more = $('#exMore');
    if (more) more.onclick = () => loadExamQuestions(true);
  }
  bindQuestionActions();
  $$('#exList [data-goto-topic]').forEach(el => el.onclick = () => {
    showView('kb');
    selectTopic(+el.dataset.gotoTopic).then(() => {
      const t = document.getElementById('cat-' + el.dataset.gotoCat);
      if (t) t.scrollIntoView({ behavior: 'smooth' });
    });
  });
}
$('#exQ').oninput = debounce(() => loadExamQuestions(false), 320);
['#exYear', '#exSubject', '#exCat'].forEach(id => $(id).onchange = () => loadExamQuestions(false));
$('#exClear').onclick = () => {
  ['#exQ', '#exYear', '#exSubject', '#exCat'].forEach(id => $(id).value = '');
  state.examFilterId = null; loadExamQuestions(false);
};
/* ================= 圖表總覽 =================
   341 張圖與上千張表本來只能靠捲動撞見；診斷流程圖是要成套看的，集中起來才有用。 */
// 科別不再由圖表自己選，一律跟著頁首的子頁（state.pageId）
const figState = { kind: '', topic: '', q: '', loaded: false };

function renderFigKinds() {
  const kinds = [['', '全部'], ['flow', '流程圖'], ['figure', '圖片'], ['table', '表格']];
  $('#figKinds').innerHTML = kinds.map(([k, label]) =>
    `<button class="fig-kind ${figState.kind === k ? 'on' : ''}" data-figkind="${k}">${esc(label)}</button>`).join('');
  $$('[data-figkind]').forEach(b => b.onclick = () => {
    figState.kind = b.dataset.figkind; loadFigures();
  });
}

async function loadFigures() {
  const body = $('#figBody');
  if (!figState.loaded) {
    body.innerHTML = '<div class="small muted">載入中…</div>';
  }
  const qs = new URLSearchParams();
  // 「流程圖」與「圖片」在後端是同一種來源，差別只在有沒有再篩選一次
  if (figState.kind === 'flow') qs.set('kind', 'flow');
  if (figState.kind === 'table') qs.set('kind', 'table');
  if (figState.kind === 'figure') qs.set('kind', 'figure');
  if (state.pageId) qs.set('page_id', state.pageId);
  if (figState.topic) qs.set('topic_id', figState.topic);
  if (figState.q) qs.set('q', figState.q);
  try {
    const r = await api('/figures-index?' + qs.toString());
    figState.loaded = true;
    renderFigKinds();
    // 主題下拉只列「目前這一科」實際有圖表的主題
    const sel = $('#figTopic');
    sel.innerHTML = '<option value="">全部主題</option>'
      + (r.groups || []).map(g =>
          `<option value="${g.topic_id}" ${String(figState.topic) === String(g.topic_id) ? 'selected' : ''}>
             ${esc(g.topic_name)}</option>`).join('');
    state.figIndex = state.figIndex || {};
    (r.groups || []).forEach(g => g.items.forEach(it => {
      if (it.kind === 'figure') state.figIndex[it.id] = { updated_at: it.updated_at, caption: it.caption };
    }));
    body.innerHTML = (r.groups || []).length
      ? (r.groups || []).map(g => `<section class="fig-group">
          <h2>${esc(g.topic_name)}</h2>
          <div class="fig-grid">${g.items.map(it => figCard(it, g.topic_id)).join('')}</div>
        </section>`).join('')
      : '<div class="empty-note">沒有符合的圖表。</div>';
    bindFigCards();
  } catch (e) { body.innerHTML = `<div class="small danger">${esc(e.message)}</div>`; }
}

function figCard(it, topicId) {
  const title = it.kind === 'table' ? '表格' : (it.label || '圖');
  const thumb = it.kind === 'figure'
    ? `<img loading="lazy" src="${figSrc({ id: it.id, updated_at: it.updated_at })}" alt="${esc(it.label || '')}">`
    : '<div class="fig-tbl-icon">▦</div>';
  return `<div class="fig-card" data-figkind2="${it.kind}" data-figid="${it.id}"
      data-figentry="${it.entry_id}" data-figtopic="${topicId}">
    <div class="fig-thumb">${thumb}</div>
    <div class="fig-meta">
      <div class="fig-title">${esc(title)}${it.flow ? '<span class="fig-flow">流程</span>' : ''}</div>
      <div class="fig-cap">${esc((it.caption || it.section || '').slice(0, 44))}</div>
      <div class="fig-sec">${esc(stripOrdinal(it.section).slice(0, 30))}</div>
    </div></div>`;
}

function bindFigCards() {
  $$('.fig-card').forEach(el => el.onclick = () => {
    if (el.dataset.figkind2 === 'figure') openLightbox(+el.dataset.figid);
    else jumpToEntry(+el.dataset.figentry, +el.dataset.figtopic);
  });
}

/* 從圖表分頁跳回原條目：切到知識庫、選好主題、捲到那張卡片並閃一下。
   topicId 由圖表索引直接帶過來，不必再打一次 API。 */
async function jumpToEntry(entryId, topicId) {
  if (!topicId) { toast('找不到來源條目', true); return; }
  try {
    showView('kb');
    // 同一個主題且卡片已在畫面上就不重載，免得捲動位置和收合狀態被洗掉
    const here = state.topicId === topicId && $(`.card[data-entry="${entryId}"]`);
    if (!here) await selectTopic(topicId);
    setTimeout(() => {
      const card = $(`.card[data-entry="${entryId}"]`);
      if (!card) { toast('這一則目前不在畫面上', true); return; }
      const sec = card.closest('.cat');
      if (sec && sec.classList.contains('folded')) sec.classList.remove('folded');   // 只在畫面上展開，不改記憶的收合設定
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 1600);
    }, here ? 30 : 500);
  } catch (err) { toast(err.message, true); }
}

// 條目內文的「詳見」連結（md() 產生的 a.entry-link）
document.addEventListener('click', ev => {
  const a = ev.target.closest('a.entry-link');
  if (!a) return;
  ev.preventDefault();
  jumpToEntry(+a.dataset.jump, +a.dataset.jumptopic);
});

$('#figQ').oninput = debounce(() => { figState.q = $('#figQ').value.trim(); loadFigures(); }, 300);
$('#figTopic').onchange = () => { figState.topic = $('#figTopic').value; loadFigures(); };


/* ================= 影像庫 =================
   跟圖表分頁刻意分開：圖表是課本裡的插圖（依章節圖號組織），影像是自己上傳、
   拿來練判讀的臨床影像（依檢查種類組織）。兩者混在一起會兩邊都難找。 */
// 同上：科別跟著頁首的子頁，只留分類（全部／X光／EKG／MRI／CT／超音波）
const imgState = { kind: '', q: '', page: '', loaded: false };

function imgSrc(it) {
  return (window.__SRC__.img[it.id] || '');
}

function renderImgKinds(kinds, total, unclassified) {
  const all = `<button class="fig-kind ${imgState.kind === '' ? 'on' : ''}" data-imgkind="">全部${total ? ` <span class="ik-n">${total}</span>` : ''}</button>`;
  const rest = (kinds || []).map(k =>
    `<button class="fig-kind ${imgState.kind === k.slug ? 'on' : ''}" data-imgkind="${esc(k.slug)}"
       data-kindid="${k.id}" data-builtin="${k.builtin}">${esc(k.name)}${k.count ? ` <span class="ik-n">${k.count}</span>` : ''}</button>`).join('');
  const un = unclassified
    ? `<button class="fig-kind ${imgState.kind === '__none' ? 'on' : ''}" data-imgkind="__none">未分類 <span class="ik-n">${unclassified}</span></button>`
    : '';
  $('#imgKinds').innerHTML = all + rest + un;
  $$('[data-imgkind]').forEach(b => {
    b.onclick = () => { imgState.kind = b.dataset.imgkind; loadImages(); };
    // 自訂分類按右鍵可刪；內建的六類不給刪，免得既有影像變成孤兒
    if (b.dataset.builtin === '0') {
      b.title = '右鍵可刪除這個分類';
      b.oncontextmenu = async (ev) => {
        ev.preventDefault();
        if (!confirm(`刪除分類「${b.textContent.trim()}」？\n影像會保留，只是變成未分類。`)) return;
        try {
          await api(`/image-kinds/${b.dataset.kindid}`, { method: 'DELETE' });
          if (imgState.kind === b.dataset.imgkind) imgState.kind = '';
          toast('已刪除分類'); loadImages();
        } catch (e) { toast(e.message, true); }
      };
    }
  });
}

async function loadImages() {
  const body = $('#imgBody');
  if (!imgState.loaded) body.innerHTML = '<div class="small muted">載入中…</div>';
  const qs = new URLSearchParams();
  if (imgState.kind === '__none') qs.set('kind', '__none');
  else if (imgState.kind) qs.set('kind', imgState.kind);
  // 子頁情境固定綁該科；總覽情境預設全部，由下拉自行篩選
  const pid = state.scope === 'global' ? imgState.page : state.pageId;
  if (pid) qs.set('page_id', pid);
  if (imgState.q) qs.set('q', imgState.q);
  try {
    const r = await api('/images-index?' + qs.toString());
    imgState.loaded = true;
    renderImgKinds(r.kinds || [], r.total || 0, r.unclassified || 0);
    const psel = $('#imgPageSel');
    psel.innerHTML = '<option value="">全部科別</option>'
      + (r.pages || []).map(pg =>
          `<option value="${pg.id}" ${String(imgState.page) === String(pg.id) ? 'selected' : ''}>${esc(pg.name)}</option>`).join('');
    state.imgKinds = r.kinds || [];
    state.imgList = r.items || [];
    const cards = groupByStudy(r.items || []);
    body.innerHTML = cards.length
      ? `<div class="fig-grid">${cards.map(imgCard).join('')}</div>`
      : `<div class="empty-note">${state.isAdmin ? '還沒有影像。按右上角「⬆ 上傳影像」加入第一張。' : '這裡還沒有影像。'}</div>`;
    bindImgCards();
  } catch (e) { body.innerHTML = `<div class="small danger">${esc(e.message)}</div>`; }
}

/* 一次 CT／MRI 檢查會有好幾個序列、每個序列好幾張切片。
   卡片牆上一次檢查只該佔一張卡，點開才進序列檢視器；study 空字串的就是單張照片。 */
function groupByStudy(items) {
  const out = [], byStudy = new Map();
  items.forEach(it => {
    if (!it.study) { out.push({ single: it }); return; }
    let g = byStudy.get(it.study);
    if (!g) {
      g = { study: it.study, cover: it, items: [], series: [] };
      byStudy.set(it.study, g); out.push(g);
    }
    g.items.push(it);
    if (it.series && !g.series.includes(it.series)) g.series.push(it.series);
  });
  return out;
}

function imgCard(g) {
  if (g.single) {
    const it = g.single;
    return `<div class="fig-card img-card" data-imgid="${it.id}">
      <div class="fig-thumb"><img loading="lazy" src="${imgSrc(it)}" alt="${esc(it.title || '')}"></div>
      <div class="fig-meta">
        <div class="fig-title">${esc(it.title || '未命名')}</div>
        <div class="fig-cap">${esc((it.caption || '').slice(0, 44))}</div>
      </div>
      <button class="img-edit" data-imgedit="${it.id}" title="編輯歸屬與標題">✎</button>
      <button class="img-del" data-imgdel="${it.id}" title="刪除">✕</button>
    </div>`;
  }
  const nSeries = g.series.length;
  const sub = `${nSeries ? `${nSeries} 序列 · ` : ''}${g.items.length} 張`;
  return `<div class="fig-card img-card" data-study="${esc(g.study)}">
    <div class="fig-thumb"><img loading="lazy" src="${imgSrc(g.cover)}" alt="${esc(g.study)}">
      <span class="img-stack">${sub}</span></div>
    <div class="fig-meta">
      <div class="fig-title">${esc(g.study)}</div>
      <div class="fig-cap">${esc(g.series.join(' · ').slice(0, 44))}</div>
    </div>
    <button class="img-edit" data-imgedit="${g.cover.id}" title="編輯（開啟第一張切片）">✎</button>
    <button class="img-del" data-studydel="${esc(g.study)}" title="刪除整次檢查">✕</button>
  </div>`;
}

function bindImgCards() {
  $$('.img-card').forEach(el => {
    el.onclick = (ev) => {
      if (ev.target.closest('[data-imgdel],[data-studydel],[data-imgedit]')) return;
      if (el.dataset.study) openStudyViewer(el.dataset.study);
      else openImgLightbox(+el.dataset.imgid);
    };
  });
  $$('[data-imgdel]').forEach(b => b.onclick = async (ev) => {
    ev.stopPropagation();
    if (!confirm('刪除這張影像？')) return;
    try { await api(`/images/${b.dataset.imgdel}`, { method: 'DELETE' }); toast('已刪除'); loadImages(); }
    catch (e) { toast(e.message, true); }
  });
  $$('[data-imgedit]').forEach(b => b.onclick = ev => {
    ev.stopPropagation(); openImgEdit(+b.dataset.imgedit);
  });
  $$('[data-studydel]').forEach(b => b.onclick = async (ev) => {
    ev.stopPropagation();
    const st = b.dataset.studydel;
    if (!confirm(`刪除整次檢查「${st}」的所有切片？`)) return;
    try {
      const r = await api(`/image-studies?study=${encodeURIComponent(st)}`, { method: 'DELETE' });
      toast(`已刪除 ${r.deleted} 張`); loadImages();
    } catch (e) { toast(e.message, true); }
  });
}

/* 影像的燈箱借用圖表那一個，但把裁切／換圖等 figures 專屬工具藏起來 */
function openImgLightbox(id) {
  svClose();
  const it = (state.imgList || []).find(x => x.id === id);
  LB.figId = null;                 // 影像不是 figures，關掉裁切/換圖那一套工具
  LB.info = null;
  lbExitCrop();
  $('#lightboxImg').src = (window.__SRC__.img[id] || '');
  $('#lightboxImg').hidden = false;
  $('#lbTools').hidden = true;
  $('#lightboxCap').textContent = it ? [it.title, it.caption].filter(Boolean).join(' — ') : '';
  $('#lightbox').classList.add('open');
}


/* ---- 多序列檢視器 ----
   只放關鍵切片（3–10 張）所以不做預載與 cine；序列用按鈕切、切片用 ←→／滾輪／按鈕。 */
const SV = { on: false, study: '', series: '', bySeries: new Map(), idx: 0 };

function openStudyViewer(study, startId) {
  const items = (state.imgList || []).filter(x => x.study === study);
  if (!items.length) return;
  SV.on = true; SV.study = study; SV.bySeries = new Map();
  items.forEach(it => {
    const k = it.series || '（未命名序列）';
    if (!SV.bySeries.has(k)) SV.bySeries.set(k, []);
    SV.bySeries.get(k).push(it);
  });
  SV.bySeries.forEach(arr => arr.sort((a, b) => (a.instance_no - b.instance_no) || (a.id - b.id)));
  const keys = [...SV.bySeries.keys()];
  SV.series = keys[0];
  SV.idx = 0;
  if (startId) {
    for (const k of keys) {
      const i = SV.bySeries.get(k).findIndex(x => x.id === startId);
      if (i >= 0) { SV.series = k; SV.idx = i; break; }
    }
  }
  LB.figId = null; LB.info = null;
  lbExitCrop();
  $('#lbTools').hidden = true;
  $('#lightbox').classList.add('open');
  svRender();
}

function svRender() {
  const keys = [...SV.bySeries.keys()];
  const arr = SV.bySeries.get(SV.series) || [];
  const it = arr[SV.idx];
  if (!it) return;
  $('#lightboxImg').hidden = false;
  $('#lightboxImg').src = (window.__SRC__.img[it.id] || '');
  // 單一序列時不必顯示序列列，省得畫面多一排沒用的東西
  const sb = $('#lbSeries');
  sb.hidden = keys.length < 2;
  sb.innerHTML = keys.map(k =>
    `<button class="${k === SV.series ? 'on' : ''}" data-sv="${esc(k)}">${esc(k)}
       <span class="ik-n">${SV.bySeries.get(k).length}</span></button>`).join('');
  $$('#lbSeries [data-sv]').forEach(b => b.onclick = ev => {
    ev.stopPropagation(); SV.series = b.dataset.sv; SV.idx = 0; svRender();
  });
  $('#lbSlice').hidden = arr.length < 2;
  $('#lbSliceN').textContent = `${SV.idx + 1} / ${arr.length}`;
  $('#lightboxCap').textContent =
    [SV.study, it.title, it.caption].filter(Boolean).join(' — ');
}

function svStep(d) {
  const arr = SV.bySeries.get(SV.series) || [];
  if (arr.length < 2) return;
  SV.idx = (SV.idx + d + arr.length) % arr.length;   // 頭尾相接，捲到底不會卡住
  svRender();
}

$$('#lbSlice [data-slice]').forEach(b => b.onclick = ev => {
  ev.stopPropagation(); svStep(+b.dataset.slice);
});
$('#lightbox').addEventListener('wheel', ev => {
  if (!SV.on) return;
  ev.preventDefault();
  svStep(ev.deltaY > 0 ? 1 : -1);
}, { passive: false });

function svClose() {
  SV.on = false;
  $('#lbSeries').hidden = true;
  $('#lbSlice').hidden = true;
}


/* ---- 影像編輯：歸屬與命名 ----
   上傳的當下常常還不知道要歸到哪一類、哪一科，所以事後一定要改得動；
   檔名也很少能直接當標題（Chest-X-ray-left-pneumothorax.png）。 */
let imEditId = null;

function openImgEdit(id) {
  const it = (state.imgList || []).find(x => x.id === id);
  if (!it) return;
  imEditId = id;
  $('#imEditThumb').src = imgSrc(it);
  $('#imTitle').value = it.title || '';
  $('#imCaption').value = it.caption || '';
  $('#imStudy').value = it.study || '';
  $('#imSeries').value = it.series || '';
  $('#imNo').value = it.instance_no || 0;
  $('#imKind').innerHTML = '<option value="">未分類</option>'
    + (state.imgKinds || []).map(k =>
        `<option value="${esc(k.slug)}" ${k.slug === it.kind ? 'selected' : ''}>${esc(k.name)}</option>`).join('');
  $('#imPage').innerHTML = '<option value="">未指定</option>'
    + (state.pages || []).map(pg =>
        `<option value="${pg.id}" ${String(pg.id) === String(it.page_id || '') ? 'selected' : ''}>${esc(pg.name)}</option>`).join('');
  // 既有的檢查名稱做成候選，打一半就能選，避免同一組因為打錯字而分家
  const studies = [...new Set((state.imgList || []).map(x => x.study).filter(Boolean))];
  $('#imStudyList').innerHTML = studies.map(x => `<option value="${esc(x)}">`).join('');
  $('#imgModal').classList.add('open');
  setTimeout(() => $('#imTitle').focus(), 30);
}

$('#imCancel').onclick = () => $('#imgModal').classList.remove('open');
$('#imSave').onclick = async () => {
  if (!imEditId) return;
  try {
    await api(`/images/${imEditId}`, { method: 'PUT', body: {
      title: $('#imTitle').value.trim(),
      caption: $('#imCaption').value.trim(),
      kind: $('#imKind').value,
      page_id: $('#imPage').value,
      study: $('#imStudy').value.trim(),
      series: $('#imSeries').value.trim(),
      instance_no: $('#imNo').value || 0,
    }});
    $('#imgModal').classList.remove('open');
    toast('已儲存'); loadImages();
  } catch (e) { toast(e.message, true); }
};
$('#imDelete').onclick = async () => {
  if (!imEditId || !confirm('刪除這張影像？')) return;
  try {
    await api(`/images/${imEditId}`, { method: 'DELETE' });
    $('#imgModal').classList.remove('open');
    toast('已刪除'); loadImages();
  } catch (e) { toast(e.message, true); }
};

async function doImageUpload(files) {
  const kind = (imgState.kind && imgState.kind !== '__none') ? imgState.kind : '';
  let study = '', series = '';
  // 一次選多張通常就是同一次檢查的一組切片；單張才當獨立照片，不打擾使用者
  if (files.length > 1) {
    study = (prompt(
      `這 ${files.length} 張屬於哪一次檢查？\n`
      + '例：65 歲男性 胸部CT\n\n'
      + '留白＝各自當成獨立單張照片。\n'
      + '輸入跟既有檢查相同的名稱，就會併進同一組。') || '').trim();
    if (study) {
      series = (prompt(
        '序列名稱？\n例：肺窗、縱膈窗、T1、T2、FLAIR、DWI\n\n'
        + '留白也可以，之後再補。同一次檢查可以分多次上傳不同序列。') || '').trim();
    }
  }
  // 檔名常自帶切片序號（IM_0012.jpg），照檔名排序就能拿到正確的前後關係
  const list = [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  let ok = 0, fail = 0;
  for (let i = 0; i < list.length; i++) {
    try {
      await upload('/images', list[i], {
        kind, page_id: (state.scope === 'global' ? imgState.page : state.pageId) || '',
        study, series, instance_no: i + 1,
      });
      ok++;
    } catch (e) { fail++; toast(e.message, true); }
  }
  if (ok) toast(`已上傳 ${ok} 張${study ? `到「${study}」` : ''}${fail ? `，${fail} 張失敗` : ''}`);
  loadImages();
}

$('#imgQ').oninput = debounce(() => { imgState.q = $('#imgQ').value.trim(); loadImages(); }, 300);
$('#imgPageSel').onchange = () => { imgState.page = $('#imgPageSel').value; loadImages(); };
$('#imgUpload').onclick = () => {
  const inp = $('#imgFileInput');
  inp.value = '';
  inp.onchange = () => { if (inp.files && inp.files.length) doImageUpload([...inp.files]); };
  inp.click();
};
$('#imgKindAdd').onclick = async () => {
  const name = (prompt('新分類名稱（12 字以內），例如：內視鏡、血管攝影') || '').trim();
  if (!name) return;
  try { await api('/image-kinds', { method: 'POST', body: { name } }); toast('已新增分類'); loadImages(); }
  catch (e) { toast(e.message, true); }
};

/* ================= 標記考點 =================
   演算法用條目的 keywords 排出候選，你按一下確認；主題由條目自動往上收斂。
   候選不準時用下方的搜尋自己找——那才是真正把這件事做完的路徑。 */
const tagState = { q: null, cands: [], found: [] };

$('#exTagStart').onclick = () => { $('#tagBox').hidden = false; loadTagQuestion(); };
$('#tagClose').onclick = () => { $('#tagBox').hidden = true; };

async function loadTagQuestion(questionId) {
  const box = $('#tagBody');
  box.innerHTML = '<div class="small muted">載入中…</div>';
  try {
    const qs = questionId ? `?question_id=${questionId}` : '';
    const r = await api('/exam-candidates' + qs);
    tagState.q = r.question; tagState.cands = r.candidates || []; tagState.found = [];
    const st = r.stats || {};
    $('#tagProgress').textContent =
      `已標記 ${st.tagged || 0} / ${st.total || 0}　跳過 ${st.skipped || 0}　剩 ${st.remaining || 0}`;
    renderTagBody();
  } catch (e) { box.innerHTML = `<div class="small danger">${esc(e.message)}</div>`; }
}

function tagOption(c, kind) {
  return `<div class="tag-opt" data-tagpick="${c.entry_id}">
    <span class="tag-dot"></span>
    <span class="tag-main">
      <span class="tag-sec">${esc(stripOrdinal(c.section) || '（未命名章節）')}</span>
      <span class="tag-topic">${esc(c.topic_name || '')}${c.category ? ' · ' + esc(catName(c.category)) : ''}</span>
      ${c.excerpt ? `<span class="tag-text">${esc(c.excerpt)}</span>` : ''}
      ${kind === 'cand' && c.terms && c.terms.length
        ? `<span class="tag-terms">命中：${c.terms.slice(0, 4).map(esc).join('、')}</span>` : ''}
    </span>
  </div>`;
}

function renderTagBody() {
  const q = tagState.q;
  if (!q) {
    $('#tagBody').innerHTML = '<div class="small">全部題目都標記或跳過了 🎉</div>';
    return;
  }
  const done = (q.entries || []);
  $('#tagBody').innerHTML = `
    <div class="tag-q">
      <div class="tag-qhead">${q.roc_year}-${q.session_no || 1} · 第 ${q.number} 題
        ${q.answer ? `<span class="ep-ans">答案 ${esc(q.answer)}</span>` : ''}</div>
      <div class="tag-stem">${esc(q.stem || '')}</div>
      ${(q.options || []).length ? `<ol class="tag-opts">${q.options.map(o => `<li>${esc(o)}</li>`).join('')}</ol>` : ''}
    </div>
    ${done.length ? `<div class="tag-done">已對應：${done.map(x =>
        `<span class="tag-chip" data-tagdel="${x.entry_id}">${esc(stripOrdinal(x.section))} ✕</span>`).join('')}</div>` : ''}
    <div class="tag-label">這一題在考哪一則條目？</div>
    ${tagState.cands.length
      ? tagState.cands.map(c => tagOption(c, 'cand')).join('')
      : '<div class="small muted" style="padding:4px 0 8px">演算法找不到夠接近的條目——這題可能不在知識庫涵蓋的範圍，或請用下方搜尋。</div>'}
    <div class="tag-search">
      <input id="tagFind" placeholder="找不到？輸入疾病、章節或關鍵字搜尋條目…">
      <div id="tagFound"></div>
    </div>
    <div class="tag-act">
      <button id="tagSkip">這題不在範圍內，跳過</button>
      <div class="spacer"></div>
      <button id="tagNext" class="primary">下一題 ›</button>
    </div>`;
  bindTag();
}

function bindTag() {
  $$('[data-tagpick]').forEach(el => el.onclick = () => confirmTag(+el.dataset.tagpick));
  $$('[data-tagdel]').forEach(el => el.onclick = async () => {
    await api(`/exam-question-entries?question_id=${tagState.q.id}&entry_id=${el.dataset.tagdel}`,
              { method: 'DELETE' });
    loadTagQuestion(tagState.q.id);
  });
  const find = $('#tagFind');
  if (find) find.oninput = debounce(async () => {
    const kw = find.value.trim();
    if (kw.length < 2) { $('#tagFound').innerHTML = ''; return; }
    try {
      const r = await api(`/entry-search?q=${encodeURIComponent(kw)}&limit=12`);
      $('#tagFound').innerHTML = (r.entries || []).map(e =>
        tagOption({ entry_id: e.id, section: e.section, topic_name: e.topic_name,
                    category: e.category, excerpt: e.excerpt }, 'find')).join('')
        || '<div class="small muted">沒有符合的條目</div>';
      $$('#tagFound [data-tagpick]').forEach(el => el.onclick = () => confirmTag(+el.dataset.tagpick));
    } catch (e) { toast(e.message, true); }
  }, 280);
  const skip = $('#tagSkip');
  if (skip) skip.onclick = async () => {
    await api('/exam-questions/skip', { method: 'POST', body: { question_id: tagState.q.id } });
    loadTagQuestion();
  };
  const next = $('#tagNext');
  if (next) next.onclick = () => loadTagQuestion();
}

async function confirmTag(entryId) {
  const c = tagState.cands.find(x => x.entry_id === entryId);
  try {
    await api('/exam-question-entries', { method: 'POST',
      body: { question_id: tagState.q.id, entry_id: entryId, relevance: c ? c.relevance : 1 } });
    toast('已標記');
    loadTagQuestion();          // 直接跳下一題，維持標記節奏
  } catch (e) { toast(e.message, true); }
}
$('#exApplyKeys').onclick = async () => {
  const r = await api('/exam-answer-keys/apply', { method: 'POST' });
  toast(`已套用 ${r.applied} 題答案`); loadExamTable(); loadExamQuestions(false);
};

/* ================= 畫記引擎（§8） ================= */
function textNodes(root) {
  const out = []; let pos = 0;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) { const n = w.currentNode; out.push({ n, s: pos, e: pos + n.length }); pos += n.length; }
  return out;
}
function locate(full, hl) {
  const exact = hl.exact_text || '';
  if (!exact) return null;
  const s = hl.start_offset | 0, e = hl.end_offset | 0;
  if (full.slice(s, e) === exact) return { start: s, end: e, moved: false };
  const hits = [];
  let i = full.indexOf(exact);
  while (i >= 0) { hits.push(i); i = full.indexOf(exact, i + 1); }
  if (!hits.length) return null;
  let best = hits[0], bestScore = -1e9;
  for (const p of hits) {
    let sc = -Math.abs(p - s) / Math.max(1, full.length);
    const pre = hl.prefix || '', suf = hl.suffix || '';
    if (pre && full.slice(Math.max(0, p - pre.length), p).endsWith(pre.slice(-10))) sc += 2;
    if (suf && full.slice(p + exact.length).startsWith(suf.slice(0, 10))) sc += 2;
    if (sc > bestScore) { bestScore = sc; best = p; }
  }
  return { start: best, end: best + exact.length, moved: best !== s };
}
function wrapRange(root, start, end, hl) {
  const jobs = [];
  for (const t of textNodes(root)) {
    if (t.e <= start || t.s >= end) continue;
    jobs.push({ n: t.n, from: Math.max(0, start - t.s), to: Math.min(t.n.length, end - t.s) });
  }
  jobs.reverse().forEach(j => {
    const n = j.n;
    if (j.to < n.length) n.splitText(j.to);
    const mid = j.from > 0 ? n.splitText(j.from) : n;
    const style = hl.style || 'mark';
    const el = document.createElement(style === 'mark' ? 'mark' : 'span');
    el.className = (style === 'mark' ? 'hl' : style === 'text' ? 'hlt' : 'hlp')
      + (hl.bold ? ' hlb' : '') + (hl.note_id ? ' has-note' : '');
    const css = (state.colors.find(c => c.key === hl.color) || {}).css || '#ffe14d';
    if (style === 'mark') el.style.setProperty('--hl', css);
    else if (style === 'text') el.style.color = css;
    el.dataset.hlId = hl.id;
    el.title = hl.note_title ? `筆記：${hl.note_title}（點擊叫出）` : '點擊可修改畫記';
    el.textContent = mid.textContent;
    mid.parentNode.replaceChild(el, mid);
  });
}
function applyAllHighlights() {
  const byTarget = {};
  state.hlIndex = {};
  for (const s of state.sections || []) {
    for (const g of s.sources || []) for (const e of g.entries) byTarget['entry:' + e.id] = e.highlights || [];
    for (const c of s.conflicts || []) byTarget['conflict:' + c.id] = c.highlights || [];
  }
  $$('#kbBody [data-hl]').forEach(root => {
    const key = root.dataset.targetType + ':' + root.dataset.targetId;
    const all = (byTarget[key] || []).filter(h =>
      (h.field || 'summary') === root.dataset.field &&
      String(h.field_key || '') === String(root.dataset.fieldKey || ''));
    if (!all.length) return;
    all.forEach(h => { state.hlIndex[h.id] = h; });
    for (const hl of all.slice().sort((a, b) => b.start_offset - a.start_offset)) {
      const pos = locate(root.textContent, hl);
      if (!pos) {
        api(`/highlights/${hl.id}/anchor`, { method: 'POST', body: { orphan: true } }).catch(() => { });
        continue;
      }
      if (pos.moved) api(`/highlights/${hl.id}/anchor`, { method: 'POST', body: { start: pos.start, end: pos.end, orphan: false } }).catch(() => { });
      wrapRange(root, pos.start, pos.end, hl);
    }
  });
  $$('[data-hl-id]').forEach(el => el.onclick = ev => {
    ev.stopPropagation();
    openHlToolbar(el);
    // 這段文字上掛了筆記 → 直接叫出筆記檢視窗
    const hl = (state.hlIndex || {})[el.dataset.hlId];
    if (state.isAdmin && hl && hl.note_id) openNotePeekById(hl.note_id);
  });
}

async function openNotePeekById(noteId) {
  const cached = (state.noteIndex || {})[noteId];
  if (cached) { openNotePeek(cached); return; }
  try {
    const { note } = await api(`/notes/${noteId}`);
    state.noteIndex = state.noteIndex || {};
    state.noteIndex[note.id] = note;
    openNotePeek(note);
  } catch (e) { toast(e.message, true); }
}

function selectionInfo() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  let root = r.commonAncestorContainer;
  if (root.nodeType === 3) root = root.parentElement;
  root = root && root.closest ? root.closest('[data-hl]') : null;
  if (!root) return null;
  const pre = r.cloneRange();
  pre.selectNodeContents(root);
  pre.setEnd(r.startContainer, r.startOffset);
  const start = pre.toString().length;
  const text = r.toString();
  if (!text.trim()) return null;
  const full = root.textContent;
  // 選取範圍內既有的畫記（可能不只一筆），供工具列直接提供清除
  const hit = new Set();
  root.querySelectorAll('[data-hl-id]').forEach(el => {
    if (r.intersectsNode ? r.intersectsNode(el) : false) hit.add(el.dataset.hlId);
  });
  // 選取範圍落在哪一個重點框裡？記下它在這個欄位中的序號，
  // 之後就能在 Markdown 原文找到對應的那一段，不必做字元位移換算
  let bqIndex = -1;
  let node = r.commonAncestorContainer;
  if (node.nodeType === 3) node = node.parentElement;
  let bq = node && node.closest ? node.closest('blockquote') : null;
  if (bq && root.contains(bq)) {
    // md() 支援巢狀引言（>>），只數最外層才會跟 Markdown 原文的段落序號對得起來
    let outer = bq, up = bq.parentElement;
    while (up && root.contains(up)) {
      const o = up.closest('blockquote');
      if (!o || !root.contains(o)) break;
      outer = o; up = o.parentElement;
    }
    const tops = Array.from(root.querySelectorAll('blockquote'))
      .filter(b => !(b.parentElement && b.parentElement.closest('blockquote')));
    bqIndex = tops.indexOf(outer);
  }
  // 選取涵蓋了 root 的第幾到第幾個頂層區塊（段落／表格／清單／重點框）。
  // md() 輸出的頂層元素與原文的區塊一一對應，靠序號就能換算回 Markdown 行號。
  const topOf = n => {
    let el = n.nodeType === 3 ? n.parentElement : n;
    while (el && el.parentElement !== root) el = el.parentElement;
    return el;
  };
  const kids = Array.from(root.children);
  const bFrom = kids.indexOf(topOf(r.startContainer));
  const bTo = kids.indexOf(topOf(r.endContainer));
  return {
    root, start, end: start + text.length, text, existing: Array.from(hit), bqIndex,
    blockFrom: bFrom, blockTo: bTo, blockCount: kids.length,
    prefix: full.slice(Math.max(0, start - 40), start),
    suffix: full.slice(start + text.length, start + text.length + 40),
    target_type: root.dataset.targetType, target_id: +root.dataset.targetId,
    field: root.dataset.field, field_key: root.dataset.fieldKey || '',
  };
}

document.addEventListener('mouseup', ev => {
  const tgt = ev.target instanceof Element ? ev.target : null;
  if (tgt && tgt.closest('#hlToolbar')) return;
  setTimeout(() => {
    const info = selectionInfo();
    if (!info) { if (!tgt || !tgt.closest('[data-hl-id]')) hideToolbar(); return; }
    state.hlSel = info;
    const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
    showToolbar(rect, null);
  }, 10);
});

function showToolbar(rect, existing) {
  const tb = $('#hlToolbar');
  // existing 可以是被點到的元素，或選取範圍內重疊到的畫記 id 陣列
  let ids = [];
  if (existing instanceof Element) ids = [existing.dataset.hlId];
  else if (Array.isArray(existing)) ids = existing.slice();
  else if (state.hlSel && state.hlSel.existing) ids = state.hlSel.existing.slice();
  const swatches = state.colors.map(c =>
    `<button class="hl-swatch" data-color="${c.key}" title="${esc(c.label)}" style="background:${c.css}"></button>`).join('');
  const textSw = state.colors.map(c =>
    `<button class="hl-swatch text" data-textcolor="${c.key}" title="字體變色：${esc(c.label)}" style="color:${c.css}">A</button>`).join('');
  const anyBold = ids.some(id => (state.hlIndex || {})[id] && state.hlIndex[id].bold);
  tb.innerHTML = swatches + '<span class="sep"></span>' + textSw + '<span class="sep"></span>'
    + `<button class="hl-bold ${anyBold ? 'on' : ''}" data-hlbold title="粗體">B</button>`
    + '<span class="sep"></span>'
    + `<button class="txt" data-hlnote>加筆記</button>`
    + (state.isAdmin ? `<button class="txt" data-askai>問 AI</button>` : '')
    + (ids.length ? `<button class="txt hl-del" data-hldel title="清除這段畫記">✕ 清除畫記${ids.length > 1 ? `（${ids.length}）` : ''}</button>` : '')
    + (canBoxSel() || canDropBq()
        ? '<span class="sep"></span><span class="hl-lab">重點框</span>'
          + BQ_LABELS.map(([k, , lab]) =>
              `<button class="hl-bq hl-bq-${k}" data-bqbox="${k}" title="${canDropBq() ? '換成' : '加上'}${lab}色重點框"></button>`).join('')
        : '')
    + (canDropBq() ? `<button class="txt hl-del" data-bqdel title="把這個重點框拆掉，文字留著">✕ 刪除</button>` : '');
  tb.classList.add('show');
  const top = rect.top + window.scrollY - tb.offsetHeight - 8;
  tb.style.top = Math.max(window.scrollY + 4, top) + 'px';
  tb.style.left = Math.max(6, Math.min(rect.left + window.scrollX, window.innerWidth - tb.offsetWidth - 12)) + 'px';
  tb.dataset.hlIds = ids.join(',');
  tb.dataset.hlId = ids.length === 1 ? ids[0] : '';
  $$('#hlToolbar [data-color]').forEach(b => b.onclick = () => applyMark(b.dataset.color, 'mark'));
  $$('#hlToolbar [data-textcolor]').forEach(b => b.onclick = () => applyMark(b.dataset.textcolor, 'text'));
  const bb = $('#hlToolbar [data-hlbold]'); if (bb) bb.onclick = () => toggleBold(!anyBold);
  const nb = $('#hlToolbar [data-hlnote]'); if (nb) nb.onclick = attachNote;
  const ab = $('#hlToolbar [data-askai]');
  if (ab) ab.onclick = () => {
    const sel = state.hlSel || {};
    aiAttach(sel.target_type === 'entry' ? sel.target_id : null, sel.text || '');
    hideToolbar(); window.getSelection().removeAllRanges();
  };
  const db = $('#hlToolbar [data-hldel]'); if (db) db.onclick = removeMark;
  const qb = $('#hlToolbar [data-bqdel]'); if (qb) qb.onclick = dropBlockquote;
  $$('#hlToolbar [data-bqbox]').forEach(b => b.onclick = () => boxBlockquote(b.dataset.bqbox));
}

/* ---------- 在閱讀模式直接拆掉重點框 ----------
   選取的文字落在第幾個重點框，就把 Markdown 原文裡第幾段引言的 > 去掉。
   靠序號對應而不是字元位移，框內有表格或清單也不會對錯位置。 */
function canDropBq() {
  const s = state.hlSel;
  return !!(state.isAdmin && s && s.bqIndex >= 0 && s.target_type === 'entry');
}

function bqRuns(lines) {
  // 傳回每一段連續引言的 [起始行, 結束行]（含），順序與畫面上的框一致
  const runs = []; let i = 0;
  while (i < lines.length) {
    if (/^\s*>/.test(lines[i])) {
      const a = i;
      while (i < lines.length && /^\s*>/.test(lines[i])) i++;
      runs.push([a, i - 1]);
    } else i++;
  }
  return runs;
}

function stripBqRun(src, n) {
  const lines = src.replace(/\r/g, '').split('\n');
  const run = bqRuns(lines)[n];
  if (!run) return null;
  const [a, b] = run;
  const body = lines.slice(a, b + 1).map(l => l.replace(/^\s*>\s?/, ''));
  const t = (body[0] || '').match(/^\[!\s*(?:藍|紅|黃|blue|red|yellow)\s*\]\s*(.*)$/i);
  if (t) { body[0] = t[1]; if (!body[0] && body.length > 1) body.shift(); }
  return [...lines.slice(0, a), ...body, ...lines.slice(b + 1)].join('\n');
}

/* 把 Markdown 原文切成「頂層區塊」，規則必須跟 md() 的迴圈一致，
   否則序號會對不上。回傳每個區塊的 [起始行, 結束行]（含）。 */
function mdBlockRanges(src) {
  const lines = String(src).replace(/\r/g, '').split('\n');
  const out = []; let open = null, kind = null;
  const close = i => { if (open !== null) { out.push([open, i - 1]); open = null; kind = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');
    if (/^\s*>\s?/.test(line)) { if (kind !== 'q') { close(i); open = i; kind = 'q'; } continue; }
    if (kind === 'q') close(i);
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^[\s|:-]+$/.test(line)) continue;          // 表格分隔線仍屬於同一張表
      if (kind !== 't') { close(i); open = i; kind = 't'; }
      continue;
    }
    if (kind === 't') close(i);
    if (/^(\s*)[-*+]\s+/.test(line)) { if (kind !== 'l') { close(i); open = i; kind = 'l'; } continue; }
    if (kind === 'l') close(i);
    if (!line.trim()) continue;                        // 空行不產生元素
    out.push([i, i]);                                  // 單獨一行＝一個 <p>
  }
  close(lines.length);
  return out;
}

function bqWrap(lines, color) {
  const tag = color === 'blue' ? '' : `[!${(BQ_LABELS.find(x => x[0] === color) || [, '藍'])[1]}] `;
  return lines.map((l, i) => {
    let t = l.replace(/^\s*>\s?/, '');
    // 換色時要先把舊的顏色標記拿掉，否則會變成 [!黃] [!紅] 疊在一起
    if (i === 0) t = t.replace(/^\[!\s*(?:藍|紅|黃|blue|red|yellow)\s*\]\s*/i, '');
    const head = (i === 0 ? tag : '') + t;
    return head ? '> ' + head : '>';
  });
}

/* 在閱讀模式把選取範圍變成重點框，或替既有的框換色。 */
async function boxBlockquote(color) {
  const sel = state.hlSel;
  if (!canDropBq() && !canBoxSel()) return;
  const e = entryById(sel.target_id);
  if (!e) { toast('找不到這一條條目', true); return; }
  const key = sel.field === 'table' ? 'table_md' : 'summary_md';
  const src = e[key] || '';
  const lines = src.replace(/\r/g, '').split('\n');

  let a, b;
  if (sel.bqIndex >= 0) {                              // 已經是框 → 換色
    const run = bqRuns(lines)[sel.bqIndex];
    if (!run) { toast('找不到對應的重點框，請重新整理後再試', true); return; }
    [a, b] = run;
  } else {                                             // 還不是框 → 建立
    const ranges = mdBlockRanges(src);
    // 原文區塊數必須跟畫面上的頂層元素數一致，不一致就寧可不動
    if (ranges.length !== sel.blockCount || sel.blockFrom < 0 || sel.blockTo < 0) {
      toast('這段位置沒辦法自動加框，請改用「編輯文字」', true); return;
    }
    a = ranges[Math.min(sel.blockFrom, sel.blockTo)][0];
    b = ranges[Math.max(sel.blockFrom, sel.blockTo)][1];
  }

  const next = [...lines.slice(0, a), ...bqWrap(lines.slice(a, b + 1), color), ...lines.slice(b + 1)].join('\n');
  try {
    const r = await api(`/entries/${sel.target_id}`, { method: 'PUT', body: { [key]: next } });
    mergeEntry(sel.target_id, r.entry);
    hideToolbar();
    renderKnowledge(state.sections);
    toast(sel.bqIndex >= 0 ? '已換色' : '已加上重點框');
  } catch (err) { toast(err.message, true); }
}

function canBoxSel() {
  const s = state.hlSel;
  return !!(state.isAdmin && s && s.target_type === 'entry' && s.blockFrom >= 0);
}

async function dropBlockquote() {
  const sel = state.hlSel;
  if (!canDropBq()) return;
  const e = entryById(sel.target_id);
  if (!e) { toast('找不到這一條條目', true); return; }
  const key = sel.field === 'table' ? 'table_md' : 'summary_md';
  const next = stripBqRun(e[key] || '', sel.bqIndex);
  if (next === null) { toast('找不到對應的重點框，請重新整理後再試', true); return; }
  try {
    const r = await api(`/entries/${sel.target_id}`, { method: 'PUT', body: { [key]: next } });
    mergeEntry(sel.target_id, r.entry);
    hideToolbar();
    renderKnowledge(state.sections);
    toast('已拆掉重點框');
  } catch (err) { toast(err.message, true); }
}
function hideToolbar() { $('#hlToolbar').classList.remove('show'); }
function openHlToolbar(el) {
  state.hlSel = null;
  showToolbar(el.getBoundingClientRect(), el);
}

async function applyMark(color, style) {
  const id = $('#hlToolbar').dataset.hlId;
  try {
    if (id) await api(`/highlights/${id}`, { method: 'PUT', body: { color, style } });
    else {
      const s = state.hlSel;
      if (!s) return;
      await api('/highlights', {
        method: 'POST', body: {
          target_type: s.target_type, target_id: s.target_id, field: s.field, field_key: s.field_key,
          start: s.start, end: s.end, exact_text: s.text, prefix: s.prefix, suffix: s.suffix,
          color, style,
        }
      });
    }
    hideToolbar(); window.getSelection().removeAllRanges();
    await loadKnowledge();
  } catch (e) { toast(e.message, true); }
}
async function toggleBold(on) {
  const ids = ($('#hlToolbar').dataset.hlIds || '').split(',').filter(Boolean);
  try {
    if (ids.length) {
      for (const id of ids) await api(`/highlights/${id}`, { method: 'PUT', body: { bold: on } });
    } else {
      const s = state.hlSel;
      if (!s) return;
      await api('/highlights', { method: 'POST', body: {
        target_type: s.target_type, target_id: s.target_id, field: s.field, field_key: s.field_key,
        start: s.start, end: s.end, exact_text: s.text, prefix: s.prefix, suffix: s.suffix,
        color: (state.colors[0] || {}).key || 'yellow', style: 'plain', bold: true } });
    }
    hideToolbar(); window.getSelection().removeAllRanges();
    await loadKnowledge();
  } catch (e) { toast(e.message, true); }
}

async function removeMark() {
  const ids = ($('#hlToolbar').dataset.hlIds || '').split(',').filter(Boolean).map(Number);
  if (!ids.length) return;
  try {
    if (ids.length === 1) await api(`/highlights/${ids[0]}`, { method: 'DELETE' });
    else await api('/highlights/delete-many', { method: 'POST', body: { ids } });
    toast(ids.length > 1 ? `已清除 ${ids.length} 筆畫記` : '已清除畫記');
  } catch (e) { toast(e.message, true); }
  hideToolbar();
  window.getSelection().removeAllRanges();
  await loadKnowledge();
}
async function attachNote() {
  const id = $('#hlToolbar').dataset.hlId;
  const s = state.hlSel;
  let hlId = id;
  if (!hlId && s) {
    const r = await api('/highlights', {
      method: 'POST', body: {
        target_type: s.target_type, target_id: s.target_id, field: s.field, field_key: s.field_key,
        start: s.start, end: s.end, exact_text: s.text, prefix: s.prefix, suffix: s.suffix,
        color: (state.colors[0] || {}).key || 'yellow', style: 'mark',
      }
    });
    hlId = r.highlight.id;
  }
  hideToolbar();
  const quote = s ? s.text : (($(`[data-hl-id="${hlId}"]`) || {}).textContent || '');
  openNoteModal(null, {
    entry_id: s && s.target_type === 'entry' ? s.target_id : null,
    highlight_id: hlId, body_md: `> ${quote}\n\n`,
  });
}

/* ================= 原文出處抽屜（§5） ================= */
async function openDrawer(entryId) {
  const c = await api(`/entries/${entryId}/context`);
  const src = c.source || {};
  $('#drawerBody').innerHTML = `
    <h3>原文出處</h3>
    <div class="kv">疾病主題：${esc(c.topic_name)}　分類：${esc(catName(c.category))}</div>
    <div class="kv">來源文件：<b>${esc(src.source_label || src.filename || '')}</b></div>
    <div class="kv">檔名：${esc(src.filename || '')}</div>
    <div class="kv">章節：${esc(stripOrdinal(c.section) || '（未標示）')}</div>
    <div class="kv">頁碼：${c.page_start ? 'p.' + c.page_start + (c.page_end && c.page_end !== c.page_start ? '–' + c.page_end : '') : '（未標示）'}${src.page_count ? ` / 全書 ${src.page_count} 頁` : ''}</div>
    <div class="kv">路徑：<code style="font-size:11px">${esc(src.path || '')}</code></div>
    ${(src.meta && src.meta.ocr) ? '<div class="kv" style="color:var(--warn)">此文件文字由 OCR 產生，原文可能有誤差</div>' : ''}
    <div class="side-label" style="margin-left:0">整理後的中文摘要</div>
    <div class="md">${md(c.summary_md)}</div>
    <div class="side-label" style="margin-left:0">對應的原文段落（AI 判讀所依據的內容）</div>
    <pre class="raw">${esc(c.excerpt ? c.excerpt.text : '（原文段落已不在資料庫中，可重新分析該文件）')}</pre>
    <div class="side-label" style="margin-left:0">此段落的筆記（${(c.notes || []).length}）</div>
    ${(c.notes || []).map(n => `<div class="note-card" data-open-note="${n.id}"><div class="nt">${esc(n.title || '（無標題）')}</div><div class="nm">${fmtTime(n.updated_at)}</div></div>`).join('') || '<div class="muted small">尚無筆記</div>'}
    <div class="row" style="margin-top:11px"><button class="primary" data-add-note="${entryId}">為此段落加筆記</button></div>`;
  state.figIndex = state.figIndex || {};
  (c.figures || []).forEach(f => { state.figIndex[f.id] = f; });
  $('#drawer').classList.add('open');
  $$('#drawerBody [data-fig]').forEach(el => el.onclick = () => openLightbox(+el.dataset.fig));
  $$('[data-open-note]').forEach(el => el.onclick = () => openNoteModal(+el.dataset.openNote));
  $$('[data-add-note]').forEach(el => el.onclick = () => openNoteModal(null, { entry_id: +el.dataset.addNote }));
}
$('#drawerClose').onclick = () => $('#drawer').classList.remove('open');
$('#lightbox').onclick = ev => { if (ev.target.id === 'lightbox') lbClose(); };
bindLightboxTools();

/* ================= 疾病主題整理（§9） ================= */
$('#organizeGo').onclick = async () => {
  const name = $('#organizeInput').value.trim();
  if (!name) return toast('請輸入疾病主題名稱', true);
  try {
    const r = await api('/organize', { method: 'POST', body: { topic_name: name, page_id: state.pageId } });
    state.organizeRun = r.run_id;
    toast(`已開始整理「${name}」`);
    pollOrganize();
  } catch (e) { toast(e.message, true); }
};
async function pollOrganize() {
  if (!state.organizeRun) return;
  try {
    const r = await api(`/organize/runs/${state.organizeRun}`);
    const pct = Math.round((r.progress || 0) * 100);
    $('#organizeStatus').innerHTML = `<b>${esc(r.topic_name)}</b>：${esc(r.stage || '')} ${pct}%`
      + `<div class="bar"><i style="width:${pct}%"></i></div>`;
    if (r.status === 'running' || r.status === 'queued') { setTimeout(pollOrganize, 2500); return; }
    if (r.status === 'done') {
      $('#organizeStatus').innerHTML = `<b>${esc(r.topic_name)}</b>：完成 — 新增 ${r.created_entries}、更新 ${r.updated_entries}、未變動 ${r.unchanged_entries}、過時 ${r.stale_entries}`;
      toast(`「${r.topic_name}」整理完成`);
      $('#organizeInput').value = '';
      await loadTopics();
      if (r.topic_id) selectTopic(r.topic_id);
    } else {
      $('#organizeStatus').innerHTML = `<span style="color:var(--danger)">整理失敗：${esc(r.error || r.stage || '')}</span>`;
    }
    state.organizeRun = null;
  } catch (e) { state.organizeRun = null; }
}
async function loadOrganizeRuns() {
  const { runs } = await api('/organize/runs');
  $('#organizeRuns').innerHTML = !runs.length ? '<div class="empty-note">尚無整理紀錄</div>' : `
    <table class="grid"><thead><tr><th>主題</th><th>狀態</th><th>掃描/相關</th><th>新增/更新/未變/過時</th><th>時間</th></tr></thead><tbody>
    ${runs.map(r => `<tr><td>${esc(r.topic_name)}</td>
      <td><span class="status ${r.status === 'done' ? 'done' : r.status === 'failed' ? 'failed' : 'processing'}">${esc(r.stage || r.status)}</span></td>
      <td class="small">${r.scanned_chunks} / ${r.matched_chunks}</td>
      <td class="small">${r.created_entries} / ${r.updated_entries} / ${r.unchanged_entries} / ${r.stale_entries}</td>
      <td class="small muted">${fmtTime(r.updated_at)}</td></tr>`).join('')}</tbody></table>`;
}

/* ================= 筆記區（§7） ================= */
$('#noteSearch').oninput = debounce(loadNotes, 300);
$('#noteNew').onclick = () => openNoteModal(null, {});
$('#noteFollow').onchange = () => {
  localStorage.setItem('noteFollow', $('#noteFollow').checked ? '1' : '0');
  loadNotes();
};
if (localStorage.getItem('noteFollow') === '0') $('#noteFollow').checked = false;

function noteScopeTopicId() {
  return ($('#noteFollow').checked && state.topicId) ? state.topicId : null;
}

async function loadNotes() {
  const q = $('#noteSearch').value.trim();
  const scopeId = noteScopeTopicId();
  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (scopeId) qs.set('topic_id', scopeId);
  const { notes } = await api('/notes' + (qs.toString() ? '?' + qs.toString() : ''));
  // 依標題自然排序：補充1 在 補充2 之前，補充2 在 補充10 之前
  notes.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'zh-Hant',
    { numeric: true, sensitivity: 'base' }) || (a.id - b.id));
  state.noteIndex = {};
  notes.forEach(n => { state.noteIndex[n.id] = n; });
  const scopeBar = $('#noteScope');
  if (scopeBar) {
    const name = (state.topics.find(t => t.id === state.topicId) || {}).name || '';
    if (scopeId) {
      scopeBar.innerHTML = `📒 只顯示 <b>${esc(name)}</b> 的筆記 · 共 ${notes.length} 則`
        + `（取消勾選可看全部主題）`;
    } else {
      const byTopic = {};
      notes.forEach(n => {
        const k = n.target_topic_name || n.topic_name || '未指定主題';
        byTopic[k] = (byTopic[k] || 0) + 1;
      });
      const parts = Object.entries(byTopic)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${esc(k)} ${v}`).join(' · ');
      scopeBar.innerHTML = `📚 所有主題的筆記 · 共 ${notes.length} 則`
        + (parts ? `<div class="small" style="margin-top:3px">${parts}</div>` : '');
    }
    scopeBar.hidden = false;
  }
  $('#noteList').innerHTML = notes.length ? notes.map(n => `
    <div class="note-card ${noteTarget(n) ? 'linked' : ''}" data-note-goto="${n.id}"
         ${noteTarget(n) ? 'title="點一下回到對應的內文位置"' : ''}>
      <div class="nt">${n.is_correction && !saysFix(n.title) ? '<span class="fix-tag">修正</span>' : ''}${esc(n.title || '（無標題）')}
        <button class="nt-edit" data-note="${n.id}">編輯</button></div>
      <div class="md" style="font-size:13px">${md((n.body_md || '').slice(0, 260))}</div>
      ${!scopeId && (n.target_topic_name || n.topic_name)
        ? `<div class="note-topic">${esc(n.target_topic_name || n.topic_name)}</div>` : ''}
      <div class="nm">${fmtTime(n.updated_at)}
        ${noteCat(n) ? ' · ' + esc(catName(noteCat(n))) : ''}
        ${n.source_label ? ' · 來源：' + esc(n.source_label) : ''}
        ${n.highlight_count ? ' · 關聯畫記 ' + n.highlight_count : ''}</div>
      ${noteTarget(n) ? `<div class="nm goto-hint">↩ ${esc(noteTarget(n))}</div>`
        : '<div class="nm muted">未關聯到內文位置</div>'}
    </div>`).join('') : '<div class="empty-note">尚無筆記</div>';
  $$('[data-note-goto]').forEach(el => el.onclick = () => gotoNoteTarget(+el.dataset.noteGoto));
  $$('.nt-edit[data-note]').forEach(el => el.onclick = ev => {
    ev.stopPropagation(); openNoteModal(+el.dataset.note);
  });
}

/* ---------- 從筆記回到內文位置（§7） ---------- */
/* 在筆記區按「新增筆記」時，state.activeCat 會是 '__notes' 這種介面用的假分類，
   不是 11 大分類之一，拿來當跳轉目標會找不到區塊。 */
function realCat(slug) {
  return slug && state.categories.some(c => c.slug === slug) ? slug : '';
}

function noteCat(n) {
  return realCat(n.entry_category) || realCat(n.category);
}

function noteEntryId(n) {
  // 從畫記建立的筆記沒有自己的 entry_id，後端會回填它畫記所在的段落
  return n.effective_entry_id || n.entry_id || null;
}

function noteTarget(n) {
  if (noteEntryId(n)) {
    const sec = stripOrdinal(n.entry_section) || catName(n.entry_category) || '關聯段落';
    const pg = n.entry_page_start
      ? ` p.${n.entry_page_start}${n.entry_page_end && n.entry_page_end !== n.entry_page_start ? '–' + n.entry_page_end : ''}` : '';
    const fig = n.figure_label ? `・${n.figure_label}` : '';
    return `回到內文：${sec}${pg}${fig}${n.entry_stale ? '（已標為過時）' : ''}`;
  }
  const cat = noteCat(n);
  if (n.target_topic_id && cat) return `回到內文：${catName(cat)}`;
  if (n.target_topic_id) return `回到主題：${n.target_topic_name || ''}`;
  return '';
}

async function gotoNoteTarget(noteId) {
  const n = (state.noteIndex || {})[noteId];
  if (!n) return;
  if (!noteEntryId(n) && !n.target_topic_id) {
    toast('這則筆記沒有關聯到內文位置，用「編輯」可以改內容', true);
    return;
  }
  showView('kb');
  if (n.target_page_id && n.target_page_id !== state.pageId) await openPage(n.target_page_id);
  if (n.target_topic_id && state.topicId !== n.target_topic_id) {
    await selectTopic(n.target_topic_id);
  } else {
    const f = state.filters;
    if (f.q || f.category || f.document_id) {          // 搜尋中的話目標可能被濾掉
      state.filters = { q: '', category: '', document_id: '' };
      $('#kbSearch').value = '';
      await loadKnowledge();
    }
  }
  const cat = noteCat(n);
  if (cat) {
    state.activeCat = cat;
    renderCatNav(state.overview.length ? state.overview : null);
  }
  const eid = noteEntryId(n);
  const card = eid ? $(`.card[data-entry="${eid}"]`) : null;
  const section = cat ? document.getElementById('cat-' + cat) : null;
  const target = card || section || $('#kbTitle');
  if (!target) {
    toast(eid ? '找不到對應的段落，可能已被刪除或不在目前的主題下' : '找不到對應的分類', true);
    return;
  }
  // 條目卡片常比視窗還高，用 block:'center' 會把開頭推到畫面外；
  // 自己算位置並扣掉置頂列的高度，確保看到的是這一條的開頭。
  const head = document.querySelector('header');
  const offset = (head ? head.getBoundingClientRect().height : 0) + 16;
  window.scrollTo({ top: Math.max(0, window.scrollY + target.getBoundingClientRect().top - offset),
                    behavior: 'smooth' });
  openNotePeek(n);
  if (card) {
    card.classList.remove('flash');
    void card.offsetWidth;                 // 強制重繪，連點同一則才會再閃一次
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 2400);
  }
}
/* ---------- 筆記檢視窗 ---------- */
function openNotePeek(n) {
  const box = $('#notePeek');
  if (!box || !n) return;
  box.classList.toggle('is-fix', !!n.is_correction);
  box.querySelector('.np-title').textContent =
    (n.is_correction ? (saysFix(n.title) ? '⚠ ' : '⚠ 修正：') : '') + (n.title || '（無標題）');
  const bits = [
    n.target_topic_name || n.topic_name || '',
    noteCat(n) ? catName(noteCat(n)) : '',
    noteEntryId(n) ? (stripOrdinal(n.entry_section) || '關聯段落') : '',
    n.figure_label || '',
    n.entry_page_start ? `p.${n.entry_page_start}${n.entry_page_end && n.entry_page_end !== n.entry_page_start ? '–' + n.entry_page_end : ''}` : '',
  ].filter(Boolean);
  box.querySelector('.np-meta').textContent = bits.join(' · ');
  box.querySelector('.np-body').innerHTML = md(n.body_md || '') || '<span class="muted">（這則筆記沒有內容）</span>';
  box.querySelector('.np-body').scrollTop = 0;
  box.dataset.noteId = n.id;
  if (!box.dataset.moved) {          // 使用者拖曳過就尊重他放的位置
    box.style.left = ''; box.style.top = ''; box.style.right = ''; box.style.bottom = '';
  }
  box.hidden = false;
}

function closeNotePeek() {
  const box = $('#notePeek');
  if (box) { box.hidden = true; delete box.dataset.noteId; }
}

(function initNotePeek() {
  const box = $('#notePeek');
  if (!box) return;
  $('#npClose').onclick = closeNotePeek;
  $('#npEdit').onclick = () => {
    const id = +box.dataset.noteId;
    if (id) openNoteModal(id);
  };
  // 擋住內文時可以自己拖開
  const head = box.querySelector('.np-head');
  head.onmousedown = ev => {
    if (ev.target.tagName === 'BUTTON') return;
    ev.preventDefault();
    const r = box.getBoundingClientRect();
    const dx = ev.clientX - r.left, dy = ev.clientY - r.top;
    head.classList.add('dragging');
    const onMove = e => {
      const x = Math.min(Math.max(8, e.clientX - dx), window.innerWidth - r.width - 8);
      const y = Math.min(Math.max(8, e.clientY - dy), window.innerHeight - 60);
      box.style.left = x + 'px'; box.style.top = y + 'px';
      box.style.right = 'auto'; box.style.bottom = 'auto';
      box.dataset.moved = '1';
    };
    const onUp = () => {
      head.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
})();

async function openNoteModal(noteId, ctx) {
  ctx = ctx || {};
  let note = { title: '', body_md: ctx.body_md || '', entry_id: ctx.entry_id || null };
  if (noteId) {
    const { notes } = await api('/notes');
    note = notes.find(n => n.id === noteId) || note;
  }
  state.noteEditing = { id: noteId, ctx, highlight_id: ctx.highlight_id || null };
  $('#modalTitle').textContent = noteId ? '編輯筆記' : '新增筆記';
  $('#noteTitle').value = note.title || '';
  $('#noteBody').value = note.body_md || '';
  $('#noteDelete').style.display = noteId ? '' : 'none';
  $('#noteCorrection').checked = noteId ? !!note.is_correction
    : !!(ctx.is_correction || /^\s*修正/.test($('#noteTitle').value));
  const parts = [];
  if (note.entry_id || ctx.entry_id) parts.push(`關聯段落 #${note.entry_id || ctx.entry_id}`);
  if (note.figure_id || ctx.figure_id) parts.push(`關聯圖表 ${note.figure_label || '#' + (note.figure_id || ctx.figure_id)}`);
  if (state.topicId) parts.push(`主題：${(state.topics.find(t => t.id === state.topicId) || {}).name || ''}`);
  if (ctx.highlight_id) parts.push('已關聯畫記');
  $('#noteContext').textContent = parts.join('　');
  $('#modal').classList.add('open');
}
$('#noteCancel').onclick = () => $('#modal').classList.remove('open');
$('#noteSave').onclick = async () => {
  const e = state.noteEditing || {};
  const body = { title: $('#noteTitle').value.trim(), body_md: $('#noteBody').value,
                 is_correction: $('#noteCorrection').checked };
  // 只有「新增」才寫入關聯；編輯既有筆記時不送這三個欄位，
  // 否則會用目前畫面的狀態覆蓋掉它原本指向的段落與分類（entry_id 會被清成 null）。
  if (!e.id) {
    body.entry_id = (e.ctx && e.ctx.entry_id) || null;
    body.figure_id = (e.ctx && e.ctx.figure_id) || null;
    body.topic_id = state.topicId;
    body.category = realCat(state.activeCat) || null;
  }
  try {
    let noteId = e.id;
    if (e.id) await api(`/notes/${e.id}`, { method: 'PUT', body });
    else { const r = await api('/notes', { method: 'POST', body }); noteId = r.note_id; }
    if (e.highlight_id) await api(`/highlights/${e.highlight_id}`, { method: 'PUT', body: { note_id: noteId } });
    $('#modal').classList.remove('open');
    toast('筆記已儲存');
    await loadNotes();
    const peek = $('#notePeek');
    if (peek && !peek.hidden && +peek.dataset.noteId === +noteId) {
      openNotePeek((state.noteIndex || {})[noteId]);      // 檢視窗跟著更新
    }
    if ($('#view-kb').classList.contains('active')) loadKnowledge();
  } catch (err) { toast(err.message, true); }
};
$('#noteDelete').onclick = async () => {
  const e = state.noteEditing || {};
  if (!e.id || !confirm('刪除這則筆記？')) return;
  await api(`/notes/${e.id}`, { method: 'DELETE' });
  $('#modal').classList.remove('open'); toast('已刪除');
  const peek = $('#notePeek');
  if (peek && +peek.dataset.noteId === +e.id) closeNotePeek();
  loadNotes();
};

/* ================= 文件 ================= */
const STATUS_ZH = { pending: '等待中', processing: '處理中', done: '完成', failed: '失敗', needs_review: '需確認', parked: '考題（待處理）', awaiting_approval: '待確認處理', cancelled: '已取消' };
async function loadDocs() {
  const { documents } = await api('/documents');
  $('#docTable').innerHTML = !documents.length ? '<div class="empty-note">尚無文件</div>' : `
  <table class="grid"><thead><tr><th>檔案</th><th>類型</th><th>狀態</th><th>頁數</th><th>條目</th><th>更新時間</th><th></th></tr></thead><tbody>
  ${documents.map(d => `<tr>
    <td><div>${esc(d.filename)}</div><div class="small muted">${esc((d.meta && d.meta.folder) || '')} · ${fmtSize(d.size)}${(d.meta && d.meta.ocr) ? ' · OCR' : ''}</div>
      ${d.status === 'processing' ? `<div class="small muted">${esc(d.stage || '')}</div><div class="bar"><i style="width:${Math.round((d.progress || 0) * 100)}%"></i></div>` : (d.error ? `<div class="small" style="color:var(--danger)">${esc(d.error)}</div>` : (d.stage ? `<div class="small muted">${esc(d.stage)}</div>` : ''))}</td>
    <td class="small">${(d.meta && d.meta.kind === 'answer_key') ? '答案' : (d.doc_type === 'exam' ? '考題' : '文獻')}</td>
    <td><span class="status ${d.status}">${STATUS_ZH[d.status] || d.status}</span></td>
    <td class="small">${d.page_count || '—'}</td><td class="small">${d.entry_count}</td>
    <td class="small muted">${fmtTime(d.updated_at)}</td>
    <td class="small">
      ${d.status === 'awaiting_approval' ? `<button class="primary" data-approve="${d.id}">確認處理</button>` : ''}
      ${d.status === 'processing' ? `<button data-stop="${d.id}">停止</button>` : `<button data-re="${d.id}">重新分析</button>`}
      <button class="danger" data-del="${d.id}">刪除</button></td></tr>`).join('')}</tbody></table>`;
  $$('[data-approve]').forEach(b => b.onclick = async () => { await api(`/documents/${b.dataset.approve}/approve`, { method: 'POST' }); toast('已排入處理'); loadDocs(); });
  $$('[data-re]').forEach(b => b.onclick = async () => { await api(`/documents/${b.dataset.re}/reingest`, { method: 'POST', body: {} }); toast('已排入重新分析'); loadDocs(); });
  $$('[data-stop]').forEach(b => b.onclick = async () => { await api(`/documents/${b.dataset.stop}/stop`, { method: 'POST' }); toast('已要求停止'); });
  $$('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('確定刪除這份文件與其所有已整理內容？')) return;
    await api(`/documents/${b.dataset.del}`, { method: 'DELETE' }); toast('已刪除'); loadDocs(); loadTopics();
  });
}
$('#manualGo').onclick = async () => {
  const path = $('#manualPath').value.trim();
  if (!path) return;
  try { const r = await api('/ingest', { method: 'POST', body: { path } }); toast(`已排入 ${r.queued} 個檔案`); loadDocs(); }
  catch (e) { toast(e.message, true); }
};

/* ================= 待確認 ================= */
async function loadFailures() {
  const { failures } = await api('/failures');
  $('#failTable').innerHTML = !failures.length ? '<div class="empty-note">目前沒有待確認項目</div>' : `
  <table class="grid"><thead><tr><th>時間</th><th>階段</th><th>問題</th><th>檔案</th><th></th></tr></thead><tbody>
  ${failures.map(f => `<tr><td class="small muted">${fmtTime(f.created_at)}</td>
    <td class="small">${esc(f.stage)}</td>
    <td><div>${esc(f.reason)}</div><div class="small muted">${esc((f.detail || '').slice(0, 300))}</div></td>
    <td class="small">${esc(f.filename || f.path || '')}</td>
    <td>${f.document_id ? `<button data-refail="${f.document_id}">重試</button>` : ''}<button data-res="${f.id}">標為已處理</button></td>
  </tr>`).join('')}</tbody></table>`;
  $$('[data-res]').forEach(b => b.onclick = async () => { await api(`/failures/${b.dataset.res}/resolve`, { method: 'POST' }); loadFailures(); });
  $$('[data-refail]').forEach(b => b.onclick = async () => { await api(`/documents/${b.dataset.refail}/reingest`, { method: 'POST', body: {} }); toast('已排入重新分析'); });
}
async function loadOrphans() {
  const { orphans } = await api('/highlights/orphans');
  $('#orphanList').innerHTML = !orphans.length ? '<div class="empty-note">沒有失去對應的畫記</div>' : `
    <table class="grid"><thead><tr><th>原文字</th><th>主題／分類</th><th>筆記</th><th></th></tr></thead><tbody>
    ${orphans.map(o => `<tr><td class="small">「${esc((o.exact_text || '').slice(0, 90))}」</td>
      <td class="small">${esc(o.topic_name || '')} ${esc(o.category ? catName(o.category) : '')}</td>
      <td class="small">${esc(o.note_title || '—')}</td>
      <td><button class="danger" data-hldel2="${o.id}">刪除畫記</button></td></tr>`).join('')}</tbody></table>`;
  $$('[data-hldel2]').forEach(b => b.onclick = async () => { await api(`/highlights/${b.dataset.hldel2}`, { method: 'DELETE' }); loadOrphans(); });
}
async function loadEvents() {
  const { events } = await api('/events?limit=120');
  $('#eventLog').innerHTML = events.map(e =>
    `<div class="${e.level}">${fmtTime(e.ts)}  ${esc(e.message)}</div>`).join('') || '<div class="muted">尚無事件</div>';
}

/* ================= 設定 ================= */
async function loadSettings() {
  const data = await api('/settings');
  state.settings = data.settings;
  const s = data.settings;
  // 說明文字已移除，API key 的目前狀態改以輸入框的提示文字呈現
  $('#keyState').textContent = data.api_key_set ? data.api_key_masked : '未設定';
  $('#apiKey').placeholder = data.api_key_set ? `目前：${data.api_key_masked}` : '尚未設定（sk-ant-…）';
  $('#sModel').value = s.llm.screen_model; $('#eModel').value = s.llm.extract_model;
  $('#oModel').value = s.ocr.model; $('#effort').value = s.llm.effort;
  $('#conc').value = s.llm.max_concurrency; $('#maxTok').value = s.llm.max_tokens;
  $('#targetChars').value = s.chunking.target_chars; $('#gate').value = s.limits.auto_approve_max_chunks;
  $('#orgMax').value = s.limits.organize_max_chunks;
  $('#ocrMax').value = s.ocr.max_pages;
  $('#llmEnabled').checked = !!s.llm.enabled; $('#ocrEnabled').checked = !!s.ocr.enabled;
  $('#topicMode').value = s.topics.mode;
  const active = $('#setTabs button.active');
  showSetPanel(active ? active.dataset.set : 'watch');
}

async function loadStats() {
  const st = await api('/status');
  const s = st.stats;
  $('#statBoxes').innerHTML = [
    ['文件', s.documents], ['已完成', s.documents_done], ['考題文件', s.documents_parked],
    ['疾病主題', s.topics], ['知識條目', s.entries], ['文獻矛盾', s.conflicts], ['待確認', s.failures_open],
  ].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join('');
}
function renderColorEditor() {
  $('#colorEditor').innerHTML = state.colors.map((c, i) => `
    <div class="row" style="margin-bottom:6px">
      <input type="color" value="${c.css}" data-ci="${i}" data-ck="css" style="width:46px;padding:2px">
      <input value="${esc(c.label)}" data-ci="${i}" data-ck="label" placeholder="代表意義" style="flex:1">
      <input value="${esc(c.key)}" data-ci="${i}" data-ck="key" placeholder="代號" style="width:110px">
      <button class="danger" data-cdel="${i}">移除</button>
    </div>`).join('');
  $$('[data-ci]').forEach(el => el.onchange = () => { state.colors[+el.dataset.ci][el.dataset.ck] = el.value; });
  $$('[data-cdel]').forEach(b => b.onclick = () => { state.colors.splice(+b.dataset.cdel, 1); renderColorEditor(); });
}
$('#colorAdd').onclick = () => { state.colors.push({ key: 'c' + Date.now().toString(36).slice(-4), label: '新顏色', css: '#ffd166' }); renderColorEditor(); };
$('#colorSave').onclick = async () => {
  await api('/highlight-colors', { method: 'PUT', body: state.colors.map((c, i) => ({ ...c, sort: i })) });
  toast('畫記顏色已儲存'); await loadColors(); renderHighlightManager(); loadKnowledge();
};
async function loadColors() {
  const { colors } = await api('/highlight-colors');
  state.colors = colors.map(c => ({ key: c.key, label: c.label, css: c.css }));
}
async function renderFolders() {
  const { folders } = await api('/settings/folders');
  $('#folderTable').innerHTML = `<table class="grid"><thead><tr><th>路徑</th><th>名稱</th><th>類型</th><th>子資料夾</th><th>啟用</th><th></th></tr></thead><tbody>
  ${folders.map(f => `<tr>
    <td><div>${esc(f.path)}</div>${f.exists ? '' : '<div class="small" style="color:var(--danger)">⚠ 資料夾不存在</div>'}</td>
    <td class="small">${esc(f.label)}</td>
    <td><select data-fid="${f.id}" data-k="doc_type" style="width:auto">
      ${['auto', 'literature', 'exam', 'answer'].map(v => `<option value="${v}" ${f.doc_type === v ? 'selected' : ''}>${{ auto: '自動', literature: '文獻', exam: '考題', answer: '答案' }[v]}</option>`).join('')}</select></td>
    <td><input type="checkbox" data-fid="${f.id}" data-k="recursive" ${f.recursive ? 'checked' : ''} style="width:auto"></td>
    <td><input type="checkbox" data-fid="${f.id}" data-k="enabled" ${f.enabled ? 'checked' : ''} style="width:auto"></td>
    <td><button data-scan="${f.id}">掃描</button><button class="danger" data-fdel="${f.id}">移除</button></td></tr>`).join('')}</tbody></table>`;
  $$('[data-fid]').forEach(el => el.onchange = async () => {
    const v = el.type === 'checkbox' ? el.checked : el.value;
    await api(`/settings/folders/${el.dataset.fid}`, { method: 'PUT', body: { [el.dataset.k]: v } });
    toast('已更新資料夾設定');
  });
  $$('[data-fdel]').forEach(b => b.onclick = async () => {
    if (!confirm('從清單移除這個資料夾？（已匯入的內容不會刪除）')) return;
    await api(`/settings/folders/${b.dataset.fdel}`, { method: 'DELETE' }); renderFolders();
  });
  $$('[data-scan]').forEach(b => b.onclick = async () => {
    const r = await api('/scan', { method: 'POST', body: { folder_id: b.dataset.scan } });
    toast(`找到 ${r.found} 個檔案，排入 ${r.queued} 個`);
  });
}
$('#fAdd').onclick = async () => {
  try {
    await api('/settings/folders', { method: 'POST', body: { path: $('#fPath').value.trim(), label: $('#fLabel').value.trim(), doc_type: $('#fType').value } });
    $('#fPath').value = ''; $('#fLabel').value = ''; renderFolders(); toast('已新增資料夾');
  } catch (e) { toast(e.message, true); }
};
$('#saveSettings').onclick = async () => {
  const patch = {
    llm: { screen_model: $('#sModel').value.trim(), extract_model: $('#eModel').value.trim(), effort: $('#effort').value, max_concurrency: +$('#conc').value, max_tokens: +$('#maxTok').value, enabled: $('#llmEnabled').checked },
    ocr: { model: $('#oModel').value.trim(), max_pages: +$('#ocrMax').value, enabled: $('#ocrEnabled').checked },
    chunking: { target_chars: +$('#targetChars').value },
    limits: { auto_approve_max_chunks: +$('#gate').value, organize_max_chunks: +$('#orgMax').value },
    topics: { mode: $('#topicMode').value },
  };
  await api('/settings', { method: 'PUT', body: patch });
  toast('設定已儲存');
};
$('#keySave').onclick = async () => {
  try { const r = await api('/settings/api-key', { method: 'POST', body: { api_key: $('#apiKey').value } }); $('#apiKey').value = ''; $('#keyState').textContent = r.masked || '未設定';
    $('#apiKey').placeholder = r.masked ? `目前：${r.masked}` : '尚未設定（sk-ant-…）';
    toast('API key 已儲存'); refreshStatus(); }
  catch (e) { toast(e.message, true); }
};
$('#keyTest').onclick = async () => {
  const r = await api('/settings/test-llm', { method: 'POST' });
  toast(r.ok ? `連線成功（${r.model}）` : `連線失敗：${r.error}`, !r.ok);
};
$('#reindexBtn').onclick = async () => {
  const r = await api('/maintenance/reindex', { method: 'POST' });
  toast(`已重建索引：條目 ${r.entries}、筆記 ${r.notes}、區塊 ${r.chunks}、考題 ${r.questions}`);
};
$('#addTopic').onclick = async () => {
  const name = $('#newTopic').value.trim();
  if (!name) return;
  await api('/topics', { method: 'POST', body: { name, is_focus: true, page_id: state.pageId } });
  $('#newTopic').value = ''; renderFocus(); loadTopics();
};
async function renderFocus() {
  const { topics } = await api('/topics');
  const focus = topics.filter(t => t.is_focus);
  $('#focusList').innerHTML = focus.length ? focus.map(t =>
    `<span class="tag" style="font-size:12px">${esc(t.name)} <a href="#" data-unfocus="${t.id}" title="取消指定">✕</a></span>`).join('')
    : '<span class="muted small">尚未指定主題（＝自動判定模式）</span>';
  $$('[data-unfocus]').forEach(a => a.onclick = async ev => {
    ev.preventDefault(); await api(`/topics/${a.dataset.unfocus}`, { method: 'PUT', body: { is_focus: false } }); renderFocus();
  });
}
async function loadUsage() {
  const st = await api('/status');
  const u = st.usage || {};
  const keys = Object.keys(u);
  $('#usageTable').innerHTML = !keys.length ? '<div class="muted small">尚無 API 用量</div>' :
    `<table class="grid"><thead><tr><th>模型</th><th>呼叫</th><th>輸入</th><th>輸出</th><th>快取讀取</th></tr></thead><tbody>
    ${keys.map(k => `<tr><td class="small">${esc(k)}</td><td class="small">${u[k].calls}</td><td class="small">${u[k].input.toLocaleString()}</td><td class="small">${u[k].output.toLocaleString()}</td><td class="small">${u[k].cache_read.toLocaleString()}</td></tr>`).join('')}</tbody></table>`;
}

/* ================= 存取權限 ================= */
async function loadAccess() {
  try {
    const a = await api('/access');
    state.access = a;
    state.isAdmin = !!a.is_admin;
  } catch (e) {
    state.access = {}; state.isAdmin = false;
  }
  state.accessLoaded = true;
  applyAccessUI();
}
function applyAccessUI() {
  const guest = !state.isAdmin;
  document.body.classList.toggle('guest', guest);
  $('#loginBtn').hidden = !guest;
  $('#aiBtn').hidden = guest;
  $('#pmTabBtn').hidden = guest;
  if (guest && typeof aiClose === 'function') aiClose();
  const tagBtn = $('#exTagStart'); if (tagBtn) tagBtn.hidden = guest;
  if (guest) { const tb = $('#tagBox'); if (tb) tb.hidden = true; }
  if (guest && !$('#view-kb').classList.contains('active')
      && !$('#view-exams').classList.contains('active')
      && !$('#view-overview').classList.contains('active')) {
    showView('kb');
  }
}
function openLogin() {
  $('#loginErr').textContent = '';
  $('#loginPw').value = '';
  $('#loginModal').classList.add('open');
  setTimeout(() => $('#loginPw').focus(), 30);
}
$('#loginBtn').onclick = openLogin;
$('#loginCancel').onclick = () => $('#loginModal').classList.remove('open');
$('#loginGo').onclick = doLogin;
$('#loginPw').onkeydown = ev => { if (ev.key === 'Enter') doLogin(); };
async function doLogin() {
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('#loginPw').value }),
    });
    if (!res.ok) { $('#loginErr').textContent = '密碼錯誤'; return; }
    $('#loginModal').classList.remove('open');
    $('#imgModal').classList.remove('open'); lbClose();
    toast('已登入');
    await loadAccess();
    await loadPages(); await loadTopics(); refreshStatus();
  } catch (e) { $('#loginErr').textContent = String(e.message || e); }
}
async function doLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  toast('已登出');
  location.reload();
}

/* ================= 子頁左側欄：摺疊 ================= */
function setAside(open) {
  document.body.classList.toggle('aside-collapsed', !open);
  localStorage.setItem('asideOpen', open ? '1' : '0');
}
$('#asideCollapse').onclick = () => setAside(false);
$('#asideOpen').onclick = () => setAside(true);

async function renderAccessPanel() {
  const a = await api('/access');
  state.access = a;
  $('#acPublic').checked = !!a.public_read;
  $('#acHideRaw').checked = !!a.hide_raw_excerpts;
  $('#acPwState').innerHTML = a.password_set
    ? '目前<b>已設定</b>管理密碼；未登入者只能依下方設定瀏覽。'
    : '目前<b>未設定</b>密碼＝單機自用模式，任何連得到這個網址的人都是管理員。';
  $('#acScope').innerHTML = !a.password_set
    ? '<span style="color:var(--danger)">尚未設定管理密碼，公開唯讀不會生效。</span>'
    : (a.public_read
      ? `<div>✅ 可看：知識庫（中文摘要、來源、章節頁碼）、考古題、疾病主題與分類</div>
         <div>${a.hide_raw_excerpts ? '🚫' : '⚠️'} 原文段落與本機檔案路徑：${a.hide_raw_excerpts ? '已隱藏' : '<b style="color:var(--warn)">會公開</b>'}</div>
         <div>🚫 看不到：設定、文件清單、待確認、筆記、問答紀錄、監控狀態</div>
         <div>🚫 不能做：匯入、刪除、整理主題、改設定、提問（不會花到你的 API 額度）</div>`
      : '<div>目前未開放公開唯讀，未登入者一律看不到任何內容。</div>');
}
$('#acSave').onclick = async () => {
  await api('/access', { method: 'PUT', body: {
    public_read: $('#acPublic').checked, hide_raw_excerpts: $('#acHideRaw').checked } });
  toast('存取設定已儲存'); renderAccessPanel();
};
$('#acSavePw').onclick = async () => {
  const pw = $('#acPassword').value;
  if (pw.length < 8) return toast('密碼至少 8 個字元', true);
  try {
    await api('/access', { method: 'PUT', body: { password: pw } });
    $('#acPassword').value = '';
    toast('管理密碼已設定'); renderAccessPanel(); loadAccess();
  } catch (e) { toast(e.message, true); }
};
$('#acClearPw').onclick = async () => {
  if (!confirm('清除管理密碼？之後任何連得到這個網址的人都會是管理員。')) return;
  await api('/access', { method: 'PUT', body: { password: '' } });
  toast('已清除密碼'); renderAccessPanel(); loadAccess();
};

/* ================= 母頁「總覽」與子頁 ================= */
async function loadPages(keepSelection = true) {
  const { pages } = await api('/pages');
  state.pages = pages;
  if (!state.pageId || !pages.some(p => p.id === state.pageId)) {
    const saved = +localStorage.getItem('pageId');
    state.pageId = (keepSelection && pages.some(p => p.id === saved)) ? saved
      : (pages[0] ? pages[0].id : null);
  }
  renderPageSelect();
  renderPageGrid();
}
function currentPage() { return state.pages.find(p => p.id === state.pageId) || null; }
function renderPageSelect() {
  $('#pageSelect').innerHTML = state.pages.map(p =>
    `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  if (state.pageId) $('#pageSelect').value = String(state.pageId);
  const p = currentPage();
  $('#pcIcon').innerHTML = p ? pageIconHtml(p, 17) : '📚';
  $('#pageChip').style.borderColor = p ? p.color : 'var(--border)';
}
/* ================= 子頁圖示 =================
   常用的醫學相關 emoji，點一下就選好；也可以在自訂欄位打任何符號。 */
const ICON_CHOICES = [
  ['🫀', '心臟'], ['🫁', '肺'], ['🫘', '腎臟'], ['🧠', '腦'],
  ['🩸', '血液'], ['🦴', '骨骼'], ['🦷', '牙科'], ['👁️', '眼'],
  ['👂', '耳'], ['👃', '鼻'], ['🍽️', '消化'], ['🦠', '感染'],
  ['🧬', '遺傳'], ['💊', '藥物'], ['💉', '注射'], ['🩺', '診察'],
  ['🔬', '顯微鏡'], ['🧪', '檢驗'], ['🩻', '影像'], ['📚', '一般'],
];

/* 子頁圖示：img: 開頭是上傳的圖檔，其餘（emoji、文字）直接顯示 */
function pageIconHtml(p, size) {
  const v = String((p && p.icon) || '');
  if (v.startsWith('img:')) {
    const ver = p.updated_at ? `?v=${Math.round(p.updated_at)}` : '';
    return `<img class="pg-img" src="${window.__SRC__.page[p.id] || ''}" alt=""
              style="width:${size}px;height:${size}px">`;
  }
  return esc(v || '📚');
}

function renderPageGrid() {
  $('#pageGrid').innerHTML = state.pages.map(p => `
    <div class="page-card" data-page="${p.id}" style="--pc:${esc(p.color)}">
      <div class="pc-top">
        <span class="pc-emoji">${pageIconHtml(p, 34)}</span>
        <span class="pc-name">${esc(p.name)}</span>
        <button class="pc-edit" data-edit="${p.id}">編輯</button>
      </div>
      <div class="pc-note">${esc(p.note || '')}</div>
      <div class="pc-stats">
        <div class="pc-stat"><b>${p.topic_count}</b><span>疾病主題</span></div>
        ${p.conflict_count ? `<div class="pc-stat"><b style="color:var(--warn)">${p.conflict_count}</b><span>文獻矛盾</span></div>` : ''}
      </div>
    </div>`).join('')
    + `<div class="page-card add" id="pageAdd"><span class="plus">＋</span><span>新增子頁</span></div>`;

  $$('#pageGrid [data-page]').forEach(el => el.onclick = ev => {
    if (ev.target.dataset.edit) return;
    openPage(+el.dataset.page);
  });
  $$('#pageGrid [data-edit]').forEach(b => b.onclick = ev => {
    ev.stopPropagation(); openPageModal(+b.dataset.edit);
  });
  $('#pageAdd').onclick = () => openPageModal(null);
}
async function openPage(pageId) {
  state.scope = 'page';
  state.pageId = pageId;
  state.topicId = null;
  localStorage.setItem('pageId', String(pageId));
  renderPageSelect();
  // 圖表與影像本來就只顯示目前子頁的內容，換科別時留在原地重載就好，
  // 硬跳回知識庫等於每換一科就要重按一次分頁
  const v = ($$('nav.tabs button.active')[0] || {}).dataset?.view;
  if (v === 'figs') { figState.topic = ''; await loadFigures(); }
  else if (v === 'imgs') { await loadImages(); }
  else showView('kb');
  await loadTopics();
}
$('#pageSelect').onchange = () => openPage(+$('#pageSelect').value);

function setPageIcon(val) {
  const isImg = String(val).startsWith('img:');
  state.pgIcon = val;
  $('#pgIcon').value = isImg ? '' : val;
  $('#pgPreview').innerHTML = isImg
    ? pageIconHtml({ id: state.pageEditing, icon: val, updated_at: Date.now() / 1000 }, 34)
    : esc(val);
  $('#pgIconClear').hidden = !isImg;
  $$('#pgOrgans [data-ic]').forEach(b => b.classList.toggle('on', !isImg && b.dataset.ic === val));
}

function renderIconPicker() {
  $('#pgOrgans').innerHTML = ICON_CHOICES.map(([ic, label]) =>
    `<button type="button" class="organ-btn" data-ic="${ic}" title="${esc(label)}">
       <span class="oi">${ic}</span><span>${esc(label)}</span></button>`).join('');
  $$('#pgOrgans [data-ic]').forEach(b => b.onclick = () => setPageIcon(b.dataset.ic));
}

function openPageModal(pageId) {
  const p = pageId ? state.pages.find(x => x.id === pageId) : null;
  state.pageEditing = pageId;
  $('#pageModalTitle').textContent = p ? '編輯子頁' : '新增子頁';
  $('#pgName').value = p ? p.name : '';
  $('#pgNote').value = p ? (p.note || '') : '';
  $('#pgColor').value = p ? p.color : '#1f6feb';
  renderIconPicker();
  setPageIcon(p ? (p.icon || '📚') : '🫀');
  $('#pgStats').textContent = p ? `${p.topic_count} 個主題 · ${p.entry_count} 條目` : '';
  $('#pgDelete').style.display = (p && state.pages.length > 1) ? '' : 'none';
  $('#pageModal').classList.add('open');
  setTimeout(() => $('#pgName').focus(), 30);
}
$('#pgIcon').oninput = () => setPageIcon($('#pgIcon').value.trim());

/* 上傳圖片：Unicode 沒有腎臟、胃這類器官的符號，自己放圖最準確。
   先存起來才能上傳，所以新子頁要按過一次儲存。 */
$('#pgIconPick').onclick = () => {
  if (!state.pageEditing) { toast('請先儲存這個子頁，再上傳圖片', true); return; }
  $('#pgIconFile').click();
};
$('#pgIconFile').onchange = async () => {
  const f = $('#pgIconFile').files[0];
  if (!f) return;
  const fd = new FormData(); fd.append('file', f);
  try {
    const res = await fetch(`/api/pages/${state.pageEditing}/icon`, { method: 'POST', body: fd });
    const r = await res.json();
    if (!res.ok) throw new Error(r.detail || '上傳失敗');
    setPageIcon(r.icon);
    toast('圖片已上傳');
    await loadPages();
  } catch (e) { toast(e.message, true); }
  $('#pgIconFile').value = '';
};
$('#pgIconClear').onclick = () => setPageIcon('📚');
$('#pgCancel').onclick = () => $('#pageModal').classList.remove('open');
$('#pgSave').onclick = async () => {
  const body = {
    name: $('#pgName').value.trim(), note: $('#pgNote').value.trim(),
    // 上傳圖片時 icon 已由上傳端點寫好，這裡不要用符號欄覆蓋掉
    icon: $('#pgIcon').value.trim() || state.pgIcon || '📚', color: $('#pgColor').value,
  };
  if (!body.name) return toast('請輸入子頁名稱', true);
  try {
    if (state.pageEditing) await api(`/pages/${state.pageEditing}`, { method: 'PUT', body });
    else {
      const r = await api('/pages', { method: 'POST', body });
      state.pageId = r.page_id;
      localStorage.setItem('pageId', String(r.page_id));
    }
    $('#pageModal').classList.remove('open');
    toast(state.pageEditing ? '子頁已更新' : `已新增子頁「${body.name}」`);
    await loadPages();
    if (!state.pageEditing) await loadTopics();
  } catch (e) { toast(e.message, true); }
};
$('#pgDelete').onclick = async () => {
  const p = state.pages.find(x => x.id === state.pageEditing);
  if (!p) return;
  const other = state.pages.find(x => x.id !== p.id);
  if (!confirm(`刪除子頁「${p.name}」？\n其中的 ${p.topic_count} 個疾病主題會移到「${other ? other.name : ''}」，內容不會被刪除。`)) return;
  try {
    const r = await api(`/pages/${p.id}`, { method: 'DELETE' });
    $('#pageModal').classList.remove('open');
    toast(`已刪除；${r.moved_topics} 個主題已移轉`);
    if (state.pageId === p.id) { state.pageId = null; localStorage.removeItem('pageId'); }
    await loadPages();
    await loadTopics();
  } catch (e) { toast(e.message, true); }
};

/* ================= 佇列狀態 ================= */
let lastPending = null;
async function refreshStatus() {
  if (!state.isAdmin) return;
  try {
    const st = await api('/status');
    const busy = st.queue.current;
    $('#queuePill').textContent = `佇列 ${st.queue.pending}`
      + (busy ? ` · ${busy.path.split('/').pop().slice(0, 20)}` : '');
    $('#queuePill').style.display = (st.queue.pending || busy) ? '' : 'none';
    $('#reviewCount').textContent = st.stats.failures_open ? `(${st.stats.failures_open})` : '';
    $('#gearDot').hidden = !st.stats.failures_open;
    const hint = $('#scanHint');
    if (hint) hint.textContent = busy ? `處理中：${busy.path.split('/').pop()}`
      : (st.queue.pending ? `佇列中 ${st.queue.pending} 個檔案` : '');
    if ($('#set-docs').classList.contains('active') && busy) loadDocs();
    if (lastPending && !st.queue.pending && !busy) { loadTopics(); lastPending = 0; }
    lastPending = st.queue.pending;
  } catch (e) { /* 伺服器暫時無回應 */ }
}
$('#btnScan').onclick = async ev => {
  ev.target.disabled = true;
  try {
    const r = await api('/scan', { method: 'POST', body: {} });
    toast(`找到 ${r.found} 個檔案，排入 ${r.queued} 個`);
  } catch (e) { toast(e.message, true); }
  ev.target.disabled = false;
};

/* ================= 畫記清除 ================= */
async function renderHighlightManager() {
  const r = await api('/highlights?limit=200');
  $('#hlSummary').innerHTML = r.total
    ? `目前共 <b>${r.total}</b> 筆畫記`
    : '目前沒有任何畫記';
  const colors = Object.entries(r.by_color || {});
  $('#hlByColor').innerHTML = colors.length ? colors.map(([key, n]) => {
    const c = state.colors.find(x => x.key === key) || { css: '#ffe14d', label: key };
    return `<div class="row" style="margin-bottom:6px">
      <span style="display:inline-block;width:14px;height:14px;border-radius:4px;background:${c.css};border:1px solid var(--border)"></span>
      <span class="small">${esc(c.label)}（${esc(key)}）· ${n} 筆</span>
      <div class="spacer"></div>
      <button class="danger small" data-hlcolor="${esc(key)}">清除這個顏色</button>
    </div>`;
  }).join('') : '';
  $('#hlList').innerHTML = !r.highlights.length ? '' :
    `<table class="grid"><thead><tr><th>畫記文字</th><th>所在</th><th>筆記</th><th></th></tr></thead><tbody>
     ${r.highlights.slice(0, 60).map(h => `<tr>
       <td class="small"><span style="border-bottom:3px solid ${(state.colors.find(c=>c.key===h.color)||{css:'#ffe14d'}).css}">「${esc((h.exact_text || '').slice(0, 46))}」</span>
         ${h.orphan ? '<div class="small" style="color:var(--warn)">已失去對應</div>' : ''}</td>
       <td class="small">${esc(h.topic_name || '')}${h.category ? ' · ' + esc(catName(h.category)) : ''}
         <div class="muted">${esc((h.source_label || '').slice(0, 28))}</div></td>
       <td class="small">${esc(h.note_title || '—')}</td>
       <td><button class="danger small" data-hlone="${h.id}">刪除</button></td></tr>`).join('')}
     </tbody></table>
     ${r.highlights.length > 60 ? `<div class="small muted" style="margin-top:6px">僅列出前 60 筆，共 ${r.total} 筆</div>` : ''}`;
  $$('[data-hlcolor]').forEach(b => b.onclick = () => clearHighlights({ color: b.dataset.hlcolor },
    `清除顏色「${b.dataset.hlcolor}」的所有畫記？`));
  $$('[data-hlone]').forEach(b => b.onclick = async () => {
    await api(`/highlights/${b.dataset.hlone}`, { method: 'DELETE' });
    toast('已刪除'); renderHighlightManager(); loadKnowledge();
  });
}
async function clearHighlights(params, confirmMsg) {
  if (!confirm(confirmMsg + '\n此動作無法復原。')) return;
  const qs = new URLSearchParams(params).toString();
  const r = await api('/highlights' + (qs ? '?' + qs : ''), { method: 'DELETE' });
  toast(`已清除 ${r.deleted} 筆畫記`);
  renderHighlightManager(); loadKnowledge();
}
$('#hlClearOrphan').onclick = () => clearHighlights({ orphan_only: 'true' }, '清除所有已失去對應的畫記？');
$('#hlClearNoNote').onclick = () => clearHighlights({ keep_with_notes: 'true' }, '清除所有未關聯筆記的畫記？');
$('#hlClearAll').onclick = () => clearHighlights({}, '清除全部畫記？');

document.addEventListener('keydown', ev => {
  if (SV.on && $('#lightbox').classList.contains('open')) {
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); svStep(-1); return; }
    if (ev.key === 'ArrowRight') { ev.preventDefault(); svStep(1); return; }
  }
  if (ev.key === 'Escape') {
    hideToolbar(); $('#drawer').classList.remove('open');
    $('#modal').classList.remove('open'); $('#pageModal').classList.remove('open');
    $('#loginModal').classList.remove('open');
    $('#imgModal').classList.remove('open'); lbClose();
  }
});

/* ================= 右側「問 AI」抽屜 =================
   後端 /api/assistant/* 用本機 claude -p 走訂閱額度；只有管理員看得到。
   上下文：目前主題＋（選填）某一則條目＋（選填）反白的文字，送出後才附上。 */
const AI = { thread: null, entryId: null, entryTitle: '', selection: '', busy: false, loaded: false };

function aiOpen() {
  if (!state.isAdmin) return;
  $('#aiPanel').hidden = false;
  document.body.classList.add('ai-open');
  $('#aiBtn').classList.add('active');
  aiSetWidth(aiSavedWidth());
  if (!AI.loaded) aiInit();
  aiRenderCtx();
  setTimeout(() => $('#aiQ').focus(), 30);
}
/* 抽屜寬度：預設約半個螢幕，可拖左緣調整、⤢ 一鍵放大，寬度記在 localStorage */
function aiDefaultWidth() { return Math.round(Math.max(560, Math.min(820, window.innerWidth * 0.5))); }
function aiSavedWidth() {
  try { const w = +localStorage.getItem('aiWidth'); if (w) return w; } catch (e) { }
  return aiDefaultWidth();
}
function aiSetWidth(w, save) {
  w = Math.round(Math.max(380, Math.min(w, window.innerWidth - 40)));
  document.documentElement.style.setProperty('--ai-w', w + 'px');
  // 剩下的內文寬度至少 720px 才往左推，不然內文會被擠得很窄，乾脆蓋在上面
  document.body.classList.toggle('ai-push', window.innerWidth - w >= 720);
  if (save) { try { localStorage.setItem('aiWidth', String(w)); } catch (e) { } }
  AI.width = w;
}
function aiClose() {
  $('#aiPanel').hidden = true;
  document.body.classList.remove('ai-open');
  $('#aiBtn').classList.remove('active');
}
async function aiInit() {
  AI.loaded = true;
  if (!$('#aiLog').children.length) aiEmpty();
  try {
    const st = await api('/assistant/status');
    if (st.model) $('#aiModel').value = st.model;
    $('#aiWeb').checked = st.allow_web !== false;
    if (!st.ok) aiAppend('err', `⚠ ${st.error}${st.hint ? '。' + st.hint : ''}`);
  } catch (e) { aiAppend('err', '⚠ ' + e.message); }
}
function aiEmpty() {
  $('#aiLog').innerHTML = '';
}
function aiRenderCtx() {
  const chips = [];
  const t = state.topics.find(x => x.id === state.topicId);
  if (t && !AI.thread) chips.push(`<span class="ai-chip"><span>主題：${esc(t.name)}</span></span>`);
  if (AI.entryId) chips.push(`<span class="ai-chip"><span>條目：${esc(AI.entryTitle || '#' + AI.entryId)}</span><button data-aictx="entry" title="不附這則">✕</button></span>`);
  const selLabel = AI.selection.startsWith('PubMed 文獻：')
    ? '📄 ' + AI.selection.split('\n')[0].replace('PubMed 文獻：', '') : `反白：「${AI.selection}」`;
  if (AI.selection) chips.push(`<span class="ai-chip"><span>${esc(selLabel)}</span><button data-aictx="sel" title="不附這段">✕</button></span>`);
  $('#aiCtx').innerHTML = chips.join('');
  $$('#aiCtx [data-aictx]').forEach(b => b.onclick = () => {
    if (b.dataset.aictx === 'entry') { AI.entryId = null; AI.entryTitle = ''; }
    else AI.selection = '';
    aiRenderCtx();
  });
}
function aiAttach(entryId, selection, maxLen) {
  AI.entryId = entryId || null;
  const card = entryId ? $(`.card[data-entry="${entryId}"]`) : null;
  const src = card ? card.querySelector('.src span') : null;
  AI.entryTitle = src ? src.textContent.replace(/^📄[^·]*·\s*/, '').trim() : '';
  AI.selection = (selection || '').trim().slice(0, maxLen || 1200);
  aiOpen();
}
function aiAppend(kind, html) {
  const log = $('#aiLog');
  const empty = log.querySelector('.ai-empty'); if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'ai-msg ' + kind + (kind === 'bot' ? ' md' : '');   // .md：表格等樣式跟條目一致
  if (kind === 'user') el.textContent = html; else el.innerHTML = html;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}
function aiBotTools(el, text, entryId) {
  const bar = document.createElement('div');
  bar.className = 'ai-tools';
  bar.innerHTML = `<button data-a="copy">複製</button><button data-a="note">存成筆記</button>`;
  bar.querySelector('[data-a=copy]').onclick = async () => {
    try { await navigator.clipboard.writeText(text); toast('已複製'); } catch (e) { toast('複製失敗', true); }
  };
  bar.querySelector('[data-a=note]').onclick = async () => {
    const q = (el.dataset.q || '').slice(0, 40);
    try {
      await api('/notes', { method: 'POST', body: {
        title: '✦ AI：' + q, body_md: text, is_correction: false,
        entry_id: entryId || null, figure_id: null, topic_id: state.topicId,
        category: realCat(state.activeCat) || null } });
      toast('已存進筆記區');
      if (typeof loadNotes === 'function') loadNotes();
    } catch (e) { toast(e.message, true); }
  };
  el.appendChild(bar);
}
async function aiSend() {
  const q = $('#aiQ').value.trim();
  if (!q || AI.busy) return;
  AI.busy = true; $('#aiSend').disabled = true;
  $('#aiQ').value = '';
  aiAppend('user', q);
  const bot = aiAppend('bot', '<span class="ai-status">思考中…</span>');
  bot.dataset.q = q;
  const entryId = AI.entryId;
  const body = { question: q, thread_id: AI.thread, entry_id: entryId, topic_id: state.topicId,
                 selection: AI.selection, use_kb: true, allow_web: $('#aiWeb').checked };
  AI.selection = '';                         // 反白只附一次；條目留著，追問時後端會自己判斷要不要重附
  let text = '', raf = 0;
  const paint = () => { raf = 0; bot.innerHTML = md(text) || '<span class="ai-status">思考中…</span>';
                        const log = $('#aiLog'); log.scrollTop = log.scrollHeight; };
  try {
    const res = await fetch('/api/assistant/ask', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? '需要管理員登入' : res.statusText);
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!line.startsWith('data: ')) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === 'thread') AI.thread = ev.thread_id;
        else if (ev.type === 'delta') { text += ev.text; if (!raf) raf = requestAnimationFrame(paint); }
        else if (ev.type === 'status') { if (!text) bot.innerHTML = `<span class="ai-status">${esc(ev.message)}</span>`; }
        else if (ev.type === 'error') { bot.className = 'ai-msg err'; bot.textContent = '⚠ ' + ev.message; }
        else if (ev.type === 'done') { text = ev.text || text; paint(); aiBotTools(bot, text, entryId); }
      }
    }
  } catch (e) { bot.className = 'ai-msg err'; bot.textContent = '⚠ ' + e.message; }
  AI.busy = false; $('#aiSend').disabled = false;
  aiRenderCtx();
  $('#aiQ').focus();
}
async function aiShowHistory() {
  const box = $('#aiHist');
  if (!box.hidden) { box.hidden = true; return; }
  try {
    const { threads } = await api('/assistant/threads');
    box.innerHTML = threads.length ? threads.map(t =>
      `<a href="#" data-aith="${t.id}">${esc(t.title.replace(/^✦ /, ''))}<div class="t">${fmtTime(t.updated_at)}</div></a>`).join('')
      : '<div class="ai-empty" style="padding:8px 14px">還沒有紀錄</div>';
    box.hidden = false;
    $$('#aiHist [data-aith]').forEach(a => a.onclick = ev => { ev.preventDefault(); aiLoadThread(+a.dataset.aith); });
  } catch (e) { toast(e.message, true); }
}
async function aiLoadThread(id) {
  const { messages } = await api(`/qa/threads/${id}`);
  $('#aiHist').hidden = true;
  $('#aiLog').innerHTML = '';
  AI.thread = id; AI.entryId = null; AI.selection = '';
  let lastQ = '';
  (messages || []).forEach(m => {
    if (m.role === 'user') { aiAppend('user', m.content_md); lastQ = m.content_md; }
    else if (m.source_type === 'error') aiAppend('err', '⚠ ' + esc(m.content_md));
    else { const el = aiAppend('bot', md(m.content_md)); el.dataset.q = lastQ;
           const meta = m.meta || {}; aiBotTools(el, m.content_md, meta.entry_id); }
  });
  aiRenderCtx();
}
$('#aiBtn').onclick = () => $('#aiPanel').hidden ? aiOpen() : aiClose();
$('#aiClose').onclick = aiClose;
$('#aiMax').onclick = () => {
  const big = Math.round(window.innerWidth * 0.92);
  if ((AI.width || 0) >= big - 10) aiSetWidth(AI.prevWidth || aiDefaultWidth(), true);
  else { AI.prevWidth = AI.width; aiSetWidth(big, true); }
};
$('#aiGrip').onmousedown = ev => {
  ev.preventDefault();
  const grip = $('#aiGrip'); grip.classList.add('drag'); document.body.classList.add('ai-resizing');
  const move = e => aiSetWidth(window.innerWidth - e.clientX);
  const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
                     grip.classList.remove('drag'); document.body.classList.remove('ai-resizing'); aiSetWidth(AI.width, true); };
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
};
$('#aiGrip').ondblclick = () => aiSetWidth(aiDefaultWidth(), true);
window.addEventListener('resize', debounce(() => { if (!$('#aiPanel').hidden) aiSetWidth(AI.width || aiSavedWidth()); }, 150));
$('#aiSend').onclick = aiSend;
$('#aiQ').onkeydown = ev => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); aiSend(); } };
$('#aiNew').onclick = () => { AI.thread = null; AI.selection = ''; $('#aiHist').hidden = true; aiEmpty(); aiRenderCtx(); $('#aiQ').focus(); };
$('#aiHistBtn').onclick = aiShowHistory;
$('#aiModel').onchange = () => api('/assistant/settings', { method: 'POST', body: { model: $('#aiModel').value } })
  .then(() => toast('之後的問題改用 ' + $('#aiModel').value)).catch(e => toast(e.message, true));
$('#aiWeb').onchange = () => api('/assistant/settings', { method: 'POST', body: { allow_web: $('#aiWeb').checked } }).catch(() => {});
document.addEventListener('click', ev => {
  const b = ev.target instanceof Element ? ev.target.closest('[data-askai-entry]') : null;
  if (b) { ev.preventDefault(); aiAttach(+b.dataset.askaiEntry, ''); }
});
document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !$('#aiPanel').hidden) aiClose(); });


/* ================= PubMed 分頁：直接查 NCBI，不經 AI、不耗額度 =================
   只有「問 AI 這篇」會打開右側 AI 抽屜。 */
const PM = { q: '', page: 1, count: 0, items: {} };
function pmItemHtml(it) {
  const types = (it.types || []).map(t =>
    `<span class="pm-type ${/Retracted/.test(t) ? 'warn' : ''}">${esc(t)}</span>`).join('');
  return `<div class="pm-item" data-pmid="${it.pmid}">
    <a class="pm-title" href="${it.url}" target="_blank" rel="noreferrer">${esc(it.title)}</a>
    <div class="pm-meta">${types}${esc(it.journal)} · ${esc(it.date || it.year)}${it.authors ? ' · ' + esc(it.authors) : ''} · PMID ${it.pmid}</div>
    <div class="pm-acts">
      <button data-pmabs>摘要</button>
      <button data-pmask>問 AI 這篇</button>
      <button data-pmnote>存成筆記</button>
      ${it.pmc ? `<button class="primary" data-pmread>在這裡讀全文</button>` : ''}
      ${it.library_url ? `<a href="${esc(it.library_url)}" target="_blank" rel="noreferrer" title="經圖書館代理開啟，可看學校訂閱的全文">${esc(PM.lib || '院內')}全文 ↗</a>` : ''}
      <a href="${it.url}" target="_blank" rel="noreferrer">PubMed ↗</a>
    </div>
    <div class="pm-abs md" hidden></div>
  </div>`;
}
async function pmSearch(more) {
  const q = $('#pmQ').value.trim();
  if (!q) return;
  if (/[一-鿿]/.test(q)) toast('PubMed 只認英文，中文關鍵字大多查不到；可以按「用目前主題」', true);
  if (!more) { PM.q = q; PM.page = 1; PM.items = {}; $('#pmList').innerHTML = '<div class="ai-status">搜尋中…</div>'; }
  else PM.page += 1;
  const types = $$('.pmType').filter(x => x.checked).map(x => x.value).join(',');
  const qs = new URLSearchParams({ q: PM.q, page: PM.page, sort: $('#pmSort').value, types,
                                   free: $('#pmFree').checked ? 'true' : 'false' });
  if ($('#pmYears').value) qs.set('years', $('#pmYears').value);
  try {
    const r = await api('/pubmed/search?' + qs.toString());
    r.items.forEach(it => { PM.items[it.pmid] = it; });
    PM.lib = r.library_name || '';
    PM.count = r.count;
    const list = $('#pmList');
    const old = list.querySelector('.pm-more'); if (old) old.remove();
    if (!more) list.innerHTML = `<div class="pm-count">共 ${r.count.toLocaleString()} 篇</div>`
      + (r.items.length ? '' : '<div class="ai-empty">查無結果，換個英文關鍵字或放寬篩選。</div>');
    list.insertAdjacentHTML('beforeend', r.items.map(pmItemHtml).join(''));
    if (PM.page * 20 < r.count) list.insertAdjacentHTML('beforeend', '<button class="pm-more">載入更多</button>');
    const mb = list.querySelector('.pm-more'); if (mb) mb.onclick = () => pmSearch(true);
  } catch (e) { $('#pmList').innerHTML = `<div class="ai-msg err">⚠ ${esc(e.message)}</div>`; }
}
async function pmAbstract(pmid) {
  const it = PM.items[pmid] || {};
  if (it.abs === undefined) {
    const r = await api('/pubmed/abstract/' + pmid);
    it.abs = r.abstract || ''; it.mesh = r.mesh || [];
  }
  return it;
}
$('#pmGo').onclick = () => pmSearch(false);
$('#pmQ').onkeydown = ev => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); pmSearch(false); } };
['#pmSort', '#pmYears', '#pmFree'].forEach(s => $(s).onchange = () => { if (PM.q) pmSearch(false); });
$$('.pmType').forEach(x => x.onchange = () => { if (PM.q) pmSearch(false); });
$('#pmTopic').onclick = () => {
  const t = state.topics.find(x => x.id === state.topicId);
  if (!t) { toast('先在左邊選一個疾病主題', true); return; }
  if (!t.name_en) { toast(`「${t.name}」沒有設定英文名稱`, true); return; }
  $('#pmQ').value = t.name_en; pmSearch(false);
};
$('#pmList').addEventListener('click', async ev => {
  const b = ev.target instanceof Element ? ev.target.closest('button[data-pmabs],button[data-pmask],button[data-pmnote],button[data-pmread]') : null;
  if (!b) return;
  const box = b.closest('.pm-item'); const pmid = box.dataset.pmid;
  if (b.hasAttribute('data-pmread')) { pmRead(pmid); return; }
  try {
    const it = await pmAbstract(pmid);
    const cite = `${it.journal} ${it.year}${it.authors ? '；' + it.authors : ''}；PMID ${pmid}`;
    if (b.hasAttribute('data-pmabs')) {
      const el = box.querySelector('.pm-abs');
      if (el.hidden) el.innerHTML = it.abs ? md(it.abs) : '<span class="muted">這篇沒有摘要</span>';
      el.hidden = !el.hidden;
    } else if (b.hasAttribute('data-pmask')) {
      await pmAskAbout(pmid);
    } else {
      await api('/notes', { method: 'POST', body: {
        title: 'PubMed：' + it.title.slice(0, 60), is_correction: false,
        body_md: `[${it.title}](${it.url})\n\n${cite}\n\n${it.abs || '（無摘要）'}`,
        entry_id: null, figure_id: null, topic_id: state.topicId, category: null } });
      toast('已存進筆記區');
      if (typeof loadNotes === 'function') loadNotes();
    }
  } catch (e) { toast(e.message, true); }
});


/* PMC 免費全文直接在頁面裡讀：後端把 JATS 轉成 HTML（白名單標籤），圖片直接連 NCBI 的 CDN */
function pmShowReader(on) {
  $('#pmReader').hidden = !on;
  ['.pm-bar', '.pm-filters', '#pmList'].forEach(s => { $('#view-pubmed ' + s).hidden = on; });
}
async function pmAskAbout(pmid) {
  const it = await pmAbstract(pmid);
  const cite = `${it.journal} ${it.year}${it.authors ? '；' + it.authors : ''}；PMID ${pmid}`;
  if (!it.abs) toast('這篇沒有摘要，AI 只看得到標題', true);
  aiAttach(null, `PubMed 文獻：${it.title}（${cite}）\n\n${it.abs || ''}`, 4000);
}
async function pmRead(pmid) {
  const it = PM.items[pmid]; if (!it || !it.pmc) return;
  PM.listScroll = window.scrollY;
  const rd = $('#pmReader');
  const links = `${it.library_url ? `<a href="${esc(it.library_url)}" target="_blank" rel="noreferrer">${esc(PM.lib || '院內')}全文 ↗</a>` : ''}
    <a href="https://pmc.ncbi.nlm.nih.gov/articles/${it.pmc}/" target="_blank" rel="noreferrer">PMC 原頁 ↗</a>`;
  rd.innerHTML = `<div class="pmr-top"><button data-pmrback>← 回到搜尋結果</button><span class="spacer"></span>
      <button data-pmrask>問 AI 這篇</button>${links}</div>
    <h2 class="pmr-title">${esc(it.title)}</h2>
    <div class="pm-meta">${esc(it.journal)} · ${esc(it.date || it.year)}${it.authors ? ' · ' + esc(it.authors) : ''} · PMID ${pmid} · ${it.pmc}</div>
    <div class="ai-status" style="margin-top:16px">載入全文中…（第一次開約需幾秒，之後會記住）</div>`;
  pmShowReader(true); window.scrollTo(0, 0);
  rd.querySelector('[data-pmrback]').onclick = () => { pmShowReader(false); window.scrollTo(0, PM.listScroll || 0); };
  rd.querySelector('[data-pmrask]').onclick = () => pmAskAbout(pmid).catch(e => toast(e.message, true));
  let f;
  try { f = await api('/pubmed/pmc/' + it.pmc); }
  catch (e) { rd.querySelector('.ai-status').outerHTML = `<div class="ai-msg err">⚠ ${esc(e.message)}</div>`; return; }
  if (!f.ok) {
    rd.querySelector('.ai-status').outerHTML = `<div class="pmr-na">${esc(f.reason || '無法取得全文')}<div class="pm-acts" style="margin-top:8px">${links}</div></div>`;
    return;
  }
  const toc = (f.toc || []).length ? `<details class="pmr-toc" open><summary>目錄</summary><ol>${
    f.toc.map(t => `<li><a href="#" data-pmrgo="${t.id}">${esc(t.title)}</a></li>`).join('')}</ol></details>` : '';
  const nrefs = (f.refs_html.match(/<li>/g) || []).length;
  rd.querySelector('.ai-status').outerHTML = `
    ${f.license ? `<div class="pmr-lic">${esc(f.license)}</div>` : ''}
    ${toc}
    ${f.abstract_html ? `<h3>Abstract</h3><div class="pmr-abs">${f.abstract_html}</div>` : ''}
    <div class="pmr-body">${f.body_html}</div>
    ${nrefs ? `<details class="pmr-refs"><summary>參考文獻（${nrefs}）</summary><ol>${f.refs_html}</ol></details>` : ''}
    <div class="pmr-top" style="margin-top:18px"><button data-pmrback2>← 回到搜尋結果</button></div>`;
  rd.querySelector('[data-pmrback2]').onclick = () => { pmShowReader(false); window.scrollTo(0, PM.listScroll || 0); };
}
$('#pmReader').addEventListener('click', ev => {
  const t = ev.target instanceof Element ? ev.target : null; if (!t) return;
  const go = t.closest('[data-pmrgo]');
  if (go) { ev.preventDefault(); const h = document.getElementById(go.dataset.pmrgo);
            if (h) h.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  const ref = t.closest('[data-pmref]');
  if (ref) { ev.preventDefault(); pmShowReader(false); $('#pmQ').value = ref.dataset.pmref + '[pmid]'; pmSearch(false); return; }
  if (t.matches('.pmc-fig img')) t.classList.toggle('big');
});

/* ================= init ================= */
(async function init() {
  const { categories } = await api('/categories');
  state.categories = categories;
  await loadColors();
  renderCatNav(null);
  await loadAccess();
  setAside(localStorage.getItem('asideOpen') !== '0');
  await loadPages();
  await loadTopics();
  await refreshStatus();
  setInterval(refreshStatus, 4000);
})();
