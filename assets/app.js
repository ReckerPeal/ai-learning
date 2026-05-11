/* AI-Learn SPA viewer
 *
 * 哈希路由：
 *   #/                          → 首页（主题列表）
 *   #/topic/{slug}              → 主题页（章节列表，从 README.md 解析）
 *   #/topic/{slug}/{chapter}    → 章节页（fetch 并渲染 .md）
 *
 * 设计：不修改任何 .md 文件；解析 README.md 的有序列表抽取章节；
 *      渲染时把相对 .md 链接重写为 hash 路由。
 */
(function () {
  'use strict';

  const app = document.getElementById('app');
  const breadcrumb = document.getElementById('breadcrumb');
  const themeBtn = document.getElementById('theme-toggle');
  const hlLight = document.getElementById('hl-light');
  const hlDark = document.getElementById('hl-dark');

  let manifestCache = null;
  const mdCache = new Map();

  // === 主题（明/暗） ===
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    if (theme === 'dark') {
      hlLight.disabled = true;
      hlDark.disabled = false;
    } else {
      hlLight.disabled = false;
      hlDark.disabled = true;
    }
    localStorage.setItem('ai-learn-theme', theme);
  }
  const initialTheme = localStorage.getItem('ai-learn-theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(initialTheme);
  themeBtn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });

  // === marked 配置 ===
  marked.setOptions({
    gfm: true,
    breaks: false,
    headerIds: true,
    mangle: false,
  });
  if (window.hljs) {
    marked.setOptions({
      highlight(code, lang) {
        try {
          if (lang && hljs.getLanguage(lang)) {
            return hljs.highlight(code, { language: lang }).value;
          }
          return hljs.highlightAuto(code).value;
        } catch (e) {
          return code;
        }
      },
    });
  }

  // === 工具 ===
  async function loadManifest() {
    if (manifestCache) return manifestCache;
    const res = await fetch('./manifest.json');
    if (!res.ok) throw new Error('无法加载 manifest.json');
    manifestCache = await res.json();
    return manifestCache;
  }

  async function loadMarkdown(path) {
    if (mdCache.has(path)) return mdCache.get(path);
    const res = await fetch(path);
    if (!res.ok) throw new Error(`无法加载 ${path}（${res.status}）`);
    const text = await res.text();
    mdCache.set(path, text);
    return text;
  }

  /**
   * 解析主题 README.md 抽取章节列表。
   * 期望格式：
   *    1. [01 · 概览](./01-overview.md) — 描述...
   *    - [01 · 概览](./01-overview.md)
   * 同时支持 `[标题](./xx.md)` 不在有序列表里的情况。
   */
  function parseChapters(md) {
    const chapters = [];
    const seen = new Set();
    const lineRegex = /^\s*(?:\d+\.|\-|\*)\s+\[([^\]]+)\]\(\.\/([^)]+)\.md\)(?:\s*[—\-:]\s*(.+))?/;
    for (const line of md.split('\n')) {
      const m = line.match(lineRegex);
      if (!m) continue;
      const slug = m[2].trim();
      if (slug === 'README' || seen.has(slug)) continue;
      seen.add(slug);
      chapters.push({
        title: m[1].trim(),
        slug,
        summary: (m[3] || '').trim(),
      });
    }
    return chapters;
  }

  /**
   * 把 markdown 渲染后的相对链接重写为 hash 路由。
   *   ./01-overview.md            → #/topic/{topic}/01-overview
   *   ./README.md                 → #/topic/{topic}
   *   ../langgraph/04-control.md  → #/topic/langgraph/04-control
   *   ../README.md                → #/
   *   #section                    → 保留
   *   http(s)://...               → 保留
   */
  function rewriteLinks(html, topicSlug) {
    const div = document.createElement('div');
    div.innerHTML = html;
    div.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href');
      if (!href) return;
      if (/^https?:/i.test(href)) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        return;
      }
      if (href.startsWith('#')) return;
      if (href.startsWith('mailto:')) return;

      // 解析路径
      // 同主题：./xxx.md / xxx.md
      let m = href.match(/^\.?\/?([^./][^/]*)\.md(#.*)?$/);
      if (m) {
        const slug = m[1];
        const anchor = m[2] || '';
        if (slug === 'README') {
          a.setAttribute('href', `#/topic/${topicSlug}${anchor}`);
        } else {
          a.setAttribute('href', `#/topic/${topicSlug}/${slug}${anchor}`);
        }
        return;
      }
      // 跨主题：../{topic}/xxx.md
      m = href.match(/^\.\.\/([^/]+)\/([^/]+)\.md(#.*)?$/);
      if (m) {
        const otherTopic = m[1];
        const slug = m[2];
        const anchor = m[3] || '';
        if (slug === 'README') {
          a.setAttribute('href', `#/topic/${otherTopic}${anchor}`);
        } else {
          a.setAttribute('href', `#/topic/${otherTopic}/${slug}${anchor}`);
        }
        return;
      }
      // 根 README
      m = href.match(/^\.\.\/README\.md(#.*)?$/);
      if (m) {
        a.setAttribute('href', `#/${m[1] || ''}`);
        return;
      }
      // 主题资源（图片、assets/）保持相对
      // 但注意当前 base 在 index.html 同级，需把 ./assets/x.png 改成 ./{topic}/assets/x.png
      // 仅对图片做：渲染时另行处理
    });

    // 图片相对路径修正（章节里 ./assets/x.png → ./{topic}/assets/x.png）
    div.querySelectorAll('img[src]').forEach((img) => {
      const src = img.getAttribute('src');
      if (!src) return;
      if (/^https?:/i.test(src) || src.startsWith('/')) return;
      // ./assets/x.png 或 assets/x.png
      const m = src.match(/^\.?\/?(.*)$/);
      if (m) {
        img.setAttribute('src', `./${topicSlug}/${m[1]}`);
      }
    });

    return div.innerHTML;
  }

  // === 路由 ===
  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    if (!h) return { route: 'home' };
    const parts = h.split('/').filter(Boolean);
    if (parts[0] === 'topic' && parts[1] && parts[2]) {
      // 章节锚点支持：parts[2] 可能是 "01-overview#section"
      const [chapterSlug, anchor] = parts[2].split('#');
      return { route: 'chapter', topic: parts[1], chapter: chapterSlug, anchor };
    }
    if (parts[0] === 'topic' && parts[1]) {
      return { route: 'topic', topic: parts[1] };
    }
    return { route: 'home' };
  }

  function setBreadcrumb(items) {
    breadcrumb.innerHTML = items
      .map((item, i) => {
        const isLast = i === items.length - 1;
        if (isLast) {
          return `<span class="current">${escapeHtml(item.label)}</span>`;
        }
        return `<a href="${item.href}">${escapeHtml(item.label)}</a><span class="sep">/</span>`;
      })
      .join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function showError(msg, detail) {
    app.innerHTML = `
      <div class="error">
        <h2>出错了</h2>
        <p>${escapeHtml(msg)}</p>
        ${detail ? `<pre>${escapeHtml(detail)}</pre>` : ''}
        <p style="margin-top:16px;">
          通常原因：直接用 <code>file://</code> 打开的页面无法 fetch 本地文件。
          请用本地服务器：<code>python3 -m http.server</code> 或 VS Code Live Server。
        </p>
      </div>
    `;
  }

  // === 渲染：首页 ===
  function renderTopicCard(t) {
    if (!t) return '';

    const tagsHtml = (t.tags || []).map(
      (tag) => `<span class="tag">${escapeHtml(tag)}</span>`
    ).join('');

    if (t.planned) {
      const priority = t.priority ? `<span class="badge badge-priority badge-${escapeHtml(t.priority.toLowerCase())}">${escapeHtml(t.priority)}</span>` : '';
      const value = typeof t.value === 'number' ? `<span class="badge-value" title="价值评估">${'⭐'.repeat(Math.max(0, Math.min(5, t.value)))}</span>` : '';
      return `
        <div class="topic-card topic-card-planned" aria-disabled="true">
          <div class="card-header">
            <h3>${escapeHtml(t.title)}</h3>
            <span class="badge badge-planned">规划中</span>
          </div>
          <p class="summary">${escapeHtml(t.summary || '')}</p>
          <div class="card-footer">
            <div class="tags">${tagsHtml}</div>
            <div class="card-meta">${priority}${value}</div>
          </div>
        </div>
      `;
    }

    return `
      <a class="topic-card" href="#/topic/${escapeHtml(t.slug)}">
        <div class="card-header">
          <h3>${escapeHtml(t.title)}</h3>
          <span class="badge badge-done">已完成</span>
        </div>
        <p class="summary">${escapeHtml(t.summary || '')}</p>
        <div class="tags">${tagsHtml}</div>
      </a>
    `;
  }

  async function renderHome() {
    setBreadcrumb([{ label: '总目录', href: '#/' }]);
    const m = await loadManifest();

    const topicMap = Object.fromEntries((m.topics || []).map((t) => [t.slug, t]));
    const stages = Array.isArray(m.stages) && m.stages.length ? m.stages : null;

    let bodyHtml;
    if (stages) {
      // 顶部学习路径速览
      const pathHtml = `
        <nav class="learn-path" aria-label="学习路径">
          ${stages.map((s, i) => `
            <a class="learn-path-step" href="#stage-${escapeHtml(s.id)}">
              <span class="step-num">${escapeHtml(String(s.step))}</span>
              <span class="step-info">
                <span class="step-title">${escapeHtml(s.title)}</span>
                <span class="step-tagline">${escapeHtml(s.tagline || '')}</span>
              </span>
            </a>
            ${i < stages.length - 1 ? '<span class="learn-path-arrow" aria-hidden="true">→</span>' : ''}
          `).join('')}
        </nav>
      `;

      const stagesHtml = stages.map((s) => {
        const stageTopics = (s.topics || []).map((slug) => topicMap[slug]).filter(Boolean);
        const doneCount = stageTopics.filter((t) => !t.planned).length;
        const plannedCount = stageTopics.filter((t) => t.planned).length;
        const counterText = `${doneCount} 已完成${plannedCount ? ` · ${plannedCount} 规划中` : ''}`;
        return `
          <section class="stage" id="stage-${escapeHtml(s.id)}">
            <header class="stage-header">
              <div class="stage-eyebrow">
                <span class="stage-step-badge">Step ${escapeHtml(String(s.step))}</span>
                ${s.tagline ? `<span class="stage-tagline">${escapeHtml(s.tagline)}</span>` : ''}
                <span class="stage-counter">${escapeHtml(counterText)}</span>
              </div>
              <h2 class="stage-title">${escapeHtml(s.title)}</h2>
              ${s.description ? `<p class="stage-desc">${escapeHtml(s.description)}</p>` : ''}
            </header>
            <div class="topic-grid">
              ${stageTopics.map(renderTopicCard).join('')}
            </div>
          </section>
        `;
      }).join('');

      // 收集已分组的 topics；剩余未分组的放在末尾
      const grouped = new Set(stages.flatMap((s) => s.topics || []));
      const ungrouped = (m.topics || []).filter((t) => !grouped.has(t.slug));
      const ungroupedHtml = ungrouped.length ? `
        <section class="stage stage-extra">
          <header class="stage-header">
            <h2 class="stage-title">其他</h2>
            <p class="stage-desc">尚未归入学习路径的主题。</p>
          </header>
          <div class="topic-grid">
            ${ungrouped.map(renderTopicCard).join('')}
          </div>
        </section>
      ` : '';

      bodyHtml = pathHtml + stagesHtml + ungroupedHtml;
    } else {
      // 兼容旧 manifest（无 stages）
      bodyHtml = `
        <section class="topic-grid">
          ${(m.topics || []).map(renderTopicCard).join('')}
        </section>
      `;
    }

    app.innerHTML = `
      <section class="hero">
        <h1>${escapeHtml(m.title)}</h1>
        <div class="subtitle">${escapeHtml(m.subtitle || '')}</div>
        <p class="description">${escapeHtml(m.description || '')}</p>
      </section>
      ${bodyHtml}
      <section class="home-footer-cta">
        <p>完整规划路线、章节大纲、依赖关系见
          <a href="./ROADMAP.md">ROADMAP.md</a>。
        </p>
      </section>
    `;
    document.title = `${m.title} · 学习目录`;
  }

  // === 渲染：主题页 ===
  async function renderTopic(slug) {
    const m = await loadManifest();
    const topic = (m.topics || []).find((t) => t.slug === slug);
    if (!topic) {
      showError(`未知主题：${slug}`);
      return;
    }
    setBreadcrumb([
      { label: '总目录', href: '#/' },
      { label: topic.title },
    ]);
    document.title = `${topic.title} · ${m.title}`;

    let chapters = [];
    try {
      const md = await loadMarkdown(`./${slug}/README.md`);
      chapters = parseChapters(md);
    } catch (e) {
      showError(`无法读取主题 README`, e.message);
      return;
    }

    app.innerHTML = `
      <header class="topic-header">
        <h1>${escapeHtml(topic.title)}</h1>
        <p class="summary">${escapeHtml(topic.summary || '')}</p>
      </header>
      ${chapters.length === 0 ? `
        <div class="error">
          <h2>没有解析到章节</h2>
          <p>请确认 <code>${slug}/README.md</code> 章节索引格式为：</p>
          <pre>1. [01 · 标题](./01-slug.md) — 说明</pre>
        </div>
      ` : `
        <ul class="chapter-list">
          ${chapters.map((c) => {
            const numMatch = c.title.match(/^(\d+)/);
            const num = numMatch ? numMatch[1].padStart(2, '0') : '';
            const titleNoNum = c.title.replace(/^\d+\s*[·.\-]?\s*/, '');
            return `
              <li>
                <a href="#/topic/${escapeHtml(slug)}/${escapeHtml(c.slug)}">
                  ${num ? `<span class="num">${num}</span>` : ''}
                  <span class="title">${escapeHtml(titleNoNum)}</span>
                  ${c.summary ? `<span class="summary">${escapeHtml(c.summary)}</span>` : ''}
                </a>
              </li>
            `;
          }).join('')}
        </ul>
      `}
    `;
  }

  // === 渲染：章节页 ===
  async function renderChapter(topicSlug, chapterSlug, anchor) {
    const m = await loadManifest();
    const topic = (m.topics || []).find((t) => t.slug === topicSlug);
    if (!topic) {
      showError(`未知主题：${topicSlug}`);
      return;
    }
    let mdText, chapters;
    try {
      [mdText, chapters] = await Promise.all([
        loadMarkdown(`./${topicSlug}/${chapterSlug}.md`),
        loadMarkdown(`./${topicSlug}/README.md`).then(parseChapters),
      ]);
    } catch (e) {
      showError(`无法加载章节 ${topicSlug}/${chapterSlug}.md`, e.message);
      return;
    }

    const idx = chapters.findIndex((c) => c.slug === chapterSlug);
    const cur = chapters[idx] || { title: chapterSlug };
    const prev = idx > 0 ? chapters[idx - 1] : null;
    const next = idx >= 0 && idx < chapters.length - 1 ? chapters[idx + 1] : null;

    setBreadcrumb([
      { label: '总目录', href: '#/' },
      { label: topic.title, href: `#/topic/${topicSlug}` },
      { label: cur.title },
    ]);
    document.title = `${cur.title} · ${topic.title}`;

    const rawHtml = marked.parse(mdText);
    const html = rewriteLinks(rawHtml, topicSlug);

    app.innerHTML = `
      <article class="md">${html}</article>
      <nav class="chapter-nav">
        ${prev ? `
          <a class="prev" href="#/topic/${topicSlug}/${prev.slug}">
            <span class="label">← 上一章</span>
            ${escapeHtml(prev.title)}
          </a>
        ` : '<span></span>'}
        ${next ? `
          <a class="next" href="#/topic/${topicSlug}/${next.slug}">
            <span class="label">下一章 →</span>
            ${escapeHtml(next.title)}
          </a>
        ` : ''}
      </nav>
    `;

    // 滚动到锚点或顶部
    if (anchor) {
      const el = document.getElementById(anchor);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }
    window.scrollTo(0, 0);
  }

  // === 路由分发 ===
  async function route() {
    const r = parseHash();
    try {
      if (r.route === 'home') {
        await renderHome();
      } else if (r.route === 'topic') {
        await renderTopic(r.topic);
      } else if (r.route === 'chapter') {
        await renderChapter(r.topic, r.chapter, r.anchor);
      }
    } catch (e) {
      showError('渲染失败', e.message);
      console.error(e);
    }
  }

  window.addEventListener('hashchange', route);
  window.addEventListener('DOMContentLoaded', route);
  // 立即触发（脚本可能在 DOM 之后加载）
  if (document.readyState !== 'loading') route();
})();
