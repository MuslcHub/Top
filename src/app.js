import { marked } from "marked";
import DOMPurify from "dompurify";
import "./style.css";

const app = document.querySelector("#app");

marked.setOptions({ gfm: true, breaks: true });

const state = {
  note: null,
  route: null,
  sources: [],
  dirty: false,
  saving: false
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function renderMarkdown(value) {
  const html = DOMPurify.sanitize(marked.parse(value || ""), {
    ALLOWED_TAGS: [
      "p", "br", "strong", "em", "s", "blockquote", "ul", "ol", "li",
      "h1", "h2", "h3", "h4", "h5", "h6", "a", "code", "pre", "hr",
      "table", "thead", "tbody", "tr", "th", "td", "input"
    ],
    ALLOWED_ATTR: ["href", "title", "type", "checked", "disabled"]
  });

  const container = document.createElement("div");
  container.innerHTML = html;

  container.querySelectorAll("a").forEach((link) => {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  });

  container.querySelectorAll("input").forEach((input) => {
    input.disabled = true;
  });

  return container.innerHTML;
}

function route() {
  const match = /^#\/(edit|view)\/([a-f0-9-]{36})\/([a-f0-9]{64})$/.exec(
    location.hash
  );

  return match
    ? { mode: match[1], id: match[2], key: match[3] }
    : null;
}

function noteLink(mode, id, key) {
  return `${location.origin}/#/${mode}/${id}/${key}`;
}

function storedNotes() {
  try {
    return JSON.parse(localStorage.getItem("myNotes") || "[]");
  } catch {
    return [];
  }
}

function rememberNote(entry) {
  const others = storedNotes().filter((item) => item.id !== entry.id);
  localStorage.setItem("myNotes", JSON.stringify([entry, ...others]));
}

function theme() {
  return localStorage.getItem("theme") || "light";
}

function setTheme(value) {
  document.documentElement.dataset.theme = value;
  localStorage.setItem("theme", value);
}

function shell(content) {
  app.innerHTML = `
    <header class="topbar">
      <a class="brand" href="/">✳ <span>Поле заметок</span></a>
      <div class="top-actions">
        <span class="top-caption">Место, где мысли становятся яснее</span>
        <button class="icon-button" id="theme-button" type="button"
          aria-label="Переключить тему" title="Переключить тему">
          ${theme() === "light" ? "☾" : "☀"}
        </button>
      </div>
    </header>
    ${content}
  `;

  document.querySelector("#theme-button").onclick = () => {
    setTheme(theme() === "light" ? "dark" : "light");
    document.querySelector("#theme-button").textContent =
      theme() === "light" ? "☾" : "☀";
  };
}

function notify(text, kind = "normal") {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.append(toast);
  }

  toast.className = `toast ${kind}`;
  toast.textContent = text;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.remove(), 5500);
}

async function request(path, options = {}, key) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...options.headers
    }
  });

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(data.error || "Ошибка запроса.");
    error.status = response.status;
    throw error;
  }

  return data;
}

function renderHome() {
  const items = storedNotes();

  shell(`
    <main class="home">
      <div class="hero">
        <div class="eyebrow">КОНСПЕКТЫ, К КОТОРЫМ ХОЧЕТСЯ ВЕРНУТЬСЯ</div>
        <h1>Собирайте знания.<br /><em>Делитесь пониманием.</em></h1>
        <p>
          Пишите вместе, сохраняйте первоисточники и читайте готовые
          конспекты в спокойном книжном режиме.
        </p>
        <button class="button primary" id="create-note">＋ Новый конспект</button>
      </div>

      <section class="library">
        <div class="section-title">
          <div>
            <div class="eyebrow">ВАША ПОЛКА</div>
            <h2>Конспекты в этом браузере</h2>
          </div>
          <span class="muted">${items.length} шт.</span>
        </div>
        <div class="note-grid" id="note-grid"></div>
        <p class="fine-print">
          Список хранится только в этом браузере. Для доступа с другого
          устройства сохраните ссылку на конспект.
        </p>
      </section>
    </main>
  `);

  const grid = document.querySelector("#note-grid");

  if (!items.length) {
    grid.innerHTML = `
      <div class="empty">
        <div class="empty-icon">✳</div>
        <h3>Здесь пока тихо</h3>
        <p>Создайте первый конспект и начните собирать важное.</p>
      </div>
    `;
  } else {
    for (const item of items) {
      const card = document.createElement("a");
      card.className = "note-card";
      card.href = `#/${item.mode}/${item.id}/${item.key}`;
      card.innerHTML = `
        <span class="card-icon">✦</span>
        <h3>${escapeHtml(item.title)}</h3>
        <span class="card-bottom">
          ${item.mode === "edit" ? "Можно редактировать" : "Только чтение"}
          <span>↗</span>
        </span>
      `;
      grid.append(card);
    }
  }

  document.querySelector("#create-note").onclick = async () => {
    const button = document.querySelector("#create-note");
    button.disabled = true;

    try {
      const data = await request("/api/notes", {
        method: "POST",
        body: JSON.stringify({
          title: "Новый конспект",
          markdown: "# Начните с главной мысли\n\nО чём этот конспект?",
          sources: []
        })
      });

      rememberNote({
        id: data.id,
        key: data.editKey,
        viewKey: data.viewKey,
        title: "Новый конспект",
        mode: "edit"
      });

      location.hash = `/edit/${data.id}/${data.editKey}`;
    } catch (error) {
      notify(error.message, "error");
      button.disabled = false;
    }
  };
}

function sourceList() {
  const list = document.querySelector("#sources-list");
  if (!list) return;

  list.replaceChildren();

  if (!state.sources.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Пока нет источников.";
    list.append(empty);
    return;
  }

  state.sources.forEach((source, index) => {
    const row = document.createElement("div");
    row.className = "source-row";

    const icon = document.createElement("span");
    icon.className = "source-icon";
    icon.textContent = source.type === "url" ? "↗" : "MD";

    const label = document.createElement("span");
    label.className = "source-name";
    label.textContent = source.name;

    const remove = document.createElement("button");
    remove.className = "text-button";
    remove.type = "button";
    remove.textContent = "Удалить";
    remove.onclick = () => {
      state.sources.splice(index, 1);
      markDirty();
      sourceList();
    };

    row.append(icon, label, remove);
    list.append(row);
  });
}

function markDirty() {
  state.dirty = true;
  const status = document.querySelector("#save-status");
  if (status) status.textContent = "Есть несохранённые изменения";
}

function renderEditor() {
  const note = state.note;
  const saved = storedNotes().find((item) => item.id === note.id);
  const viewLink = saved?.viewKey
    ? noteLink("view", note.id, saved.viewKey)
    : null;
  const editLink = noteLink("edit", note.id, state.route.key);

  shell(`
    <main class="workspace">
      <div class="workspace-heading">
        <div>
          <a class="back-link" href="/">← На полку</a>
          <div class="eyebrow">РЕДАКТОР КОНСПЕКТА</div>
          <h1>Слова обретают форму.</h1>
        </div>
        <div class="heading-actions">
          <button class="button quiet" id="copy-view" type="button">
            Ссылка для чтения
          </button>
          <button class="button quiet" id="copy-edit" type="button">
            Ссылка для редактирования
          </button>
          <button class="button primary" id="save-note" type="button">
            Сохранить
          </button>
        </div>
      </div>

      <div class="editor-layout">
        <section class="panel editor-panel">
          <div class="panel-heading">
            <span>01 / СОДЕРЖАНИЕ</span>
            <span class="muted">Markdown</span>
          </div>
          <label class="field-label" for="note-title">Название</label>
          <input id="note-title" class="title-input" maxlength="160"
            placeholder="Название конспекта"
            value="${escapeHtml(note.title)}" />
          <label class="field-label" for="note-markdown">Текст</label>
          <textarea id="note-markdown" class="markdown-input"
            spellcheck="true" placeholder="Начните писать..."></textarea>
          <div class="editor-footer">
            <span id="save-status">Изменения сохранены</span>
            <button id="import-md" class="text-button" type="button">
              Импортировать .md в текст
            </button>
            <input id="import-file" type="file" accept=".md,text/markdown"
              hidden />
          </div>
        </section>

        <aside class="side-column">
          <section class="panel">
            <div class="panel-heading">
              <span>02 / ПРЕДПРОСМОТР</span>
              <a id="open-reader" href="#"
                class="text-button">Открыть книгу ↗</a>
            </div>
            <div class="preview-paper prose" id="preview"></div>
          </section>

          <section class="panel sources-panel">
            <div class="panel-heading"><span>03 / ИСТОЧНИКИ</span></div>
            <div id="sources-list"></div>
            <div class="source-form">
              <input id="source-name" placeholder="Название источника"
                maxlength="160" />
              <input id="source-url"
                placeholder="https://example.com/article" />
              <button class="button quiet full" id="add-url" type="button">
                ＋ Добавить ссылку
              </button>
              <button class="button quiet full" id="add-md" type="button">
                ＋ Добавить файл .md как источник
              </button>
              <input id="source-file" type="file"
                accept=".md,text/markdown" hidden />
            </div>
          </section>
        </aside>
      </div>
      <p class="fine-print bottom-note">
        Сохраняйте изменения кнопкой «Сохранить». Одновременные правки
        проверяются: чужие изменения не будут молча перезаписаны.
      </p>
    </main>
  `);

  const title = document.querySelector("#note-title");
  const markdown = document.querySelector("#note-markdown");
  const preview = document.querySelector("#preview");

  markdown.value = note.markdown;

  function updatePreview() {
    preview.innerHTML = renderMarkdown(markdown.value);
  }

  updatePreview();
  sourceList();

  title.addEventListener("input", markDirty);
  markdown.addEventListener("input", () => {
    markDirty();
    updatePreview();
  });

  document.querySelector("#open-reader").onclick = (event) => {
    if (state.dirty && !confirm(
      "Есть несохранённые изменения. Открыть сохранённую версию?"
    )) {
      event.preventDefault();
    }
  };

  document.querySelector("#open-reader").href =
    viewLink || `#/view/${note.id}/${state.route.key}`;

  document.querySelector("#copy-view").onclick = async () => {
    if (!viewLink) {
      notify(
        "Ссылка для чтения доступна в браузере, где создан конспект. " +
        "Сейчас можно поделиться ссылкой редактирования.",
        "error"
      );
      return;
    }

    await navigator.clipboard.writeText(viewLink);
    notify("Ссылка только для чтения скопирована.");
  };

  document.querySelector("#copy-edit").onclick = async () => {
    await navigator.clipboard.writeText(editLink);
    notify("Ссылка для редактирования скопирована. Делитесь ей осторожно.");
  };

  document.querySelector("#save-note").onclick = async () => {
    if (state.saving) return;

    const button = document.querySelector("#save-note");
    const submitted = {
      title: title.value.trim(),
      markdown: markdown.value,
      sources: structuredClone(state.sources),
      version: state.note.version
    };

    state.saving = true;
    button.disabled = true;

    try {
      const result = await request(`/api/notes/${note.id}`, {
        method: "PUT",
        body: JSON.stringify(submitted)
      }, state.route.key);

      state.note.version = result.version;
      state.note.title = submitted.title;
      state.note.markdown = submitted.markdown;
      state.note.sources = submitted.sources;

      const currentMatches =
        title.value.trim() === submitted.title &&
        markdown.value === submitted.markdown &&
        JSON.stringify(state.sources) === JSON.stringify(submitted.sources);

      state.dirty = !currentMatches;
      document.querySelector("#save-status").textContent = currentMatches
        ? "Изменения сохранены"
        : "После сохранения появились новые изменения";

      const existing = storedNotes().find((item) => item.id === note.id);
      rememberNote({
        id: note.id,
        key: state.route.key,
        viewKey: existing?.viewKey,
        title: submitted.title,
        mode: "edit"
      });

      notify("Конспект сохранён.");
    } catch (error) {
      notify(error.message, "error");
    } finally {
      state.saving = false;
      button.disabled = false;
    }
  };

  document.querySelector("#add-url").onclick = () => {
    const name = document.querySelector("#source-name");
    const urlInput = document.querySelector("#source-url");

    let url;
    try {
      url = new URL(urlInput.value.trim());
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    } catch {
      notify("Укажите ссылку, начинающуюся с https:// или http://.", "error");
      return;
    }

    if (!name.value.trim()) {
      notify("Укажите название источника.", "error");
      return;
    }

    if (state.sources.length >= 30) {
      notify("Можно добавить не больше 30 источников.", "error");
      return;
    }

    state.sources.push({
      type: "url",
      name: name.value.trim(),
      url: url.toString()
    });

    name.value = "";
    urlInput.value = "";
    markDirty();
    sourceList();
  };

  document.querySelector("#add-md").onclick = () => {
    document.querySelector("#source-file").click();
  };

  document.querySelector("#source-file").onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".md") || file.size > 100_000) {
      notify("Выберите файл .md размером до 100 КБ.", "error");
      event.target.value = "";
      return;
    }

    if (state.sources.length >= 30) {
      notify("Можно добавить не больше 30 источников.", "error");
      event.target.value = "";
      return;
    }

    state.sources.push({
      type: "markdown",
      name: file.name,
      content: await file.text()
    });

    markDirty();
    sourceList();
    event.target.value = "";
    notify("Файл добавлен как источник. Не забудьте сохранить конспект.");
  };

  document.querySelector("#import-md").onclick = () => {
    document.querySelector("#import-file").click();
  };

  document.querySelector("#import-file").onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".md") || file.size > 200_000) {
      notify("Выберите файл .md размером до 200 КБ.", "error");
      event.target.value = "";
      return;
    }

    const text = await file.text();

    if (markdown.value.trim() && !confirm(
      "Заменить текущий текст содержимым файла?"
    )) {
      event.target.value = "";
      return;
    }

    markdown.value = text;
    markDirty();
    updatePreview();
    event.target.value = "";
  };
}

function renderReader() {
  const note = state.note;

  shell(`
    <main class="reader">
      <div class="reader-navigation">
        <a class="back-link" href="/">← На полку</a>
        <span class="reader-label">РЕЖИМ ЧТЕНИЯ · ${note.version} РЕДАКЦИЯ</span>
        <div id="reader-actions"></div>
      </div>

      <article class="book">
        <div class="book-topline">ПОЛЕ ЗАМЕТОК <span>✳</span> КОНСПЕКТ</div>
        <div class="book-cover">
          <span class="book-ornament">✦</span>
          <div class="eyebrow">ЗАПИСИ И ИДЕИ</div>
          <h1>${escapeHtml(note.title)}</h1>
          <div class="cover-rule"></div>
          <p>Текст, к которому можно вернуться.</p>
        </div>
        <div class="book-body prose" id="book-content"></div>
        <div id="book-sources"></div>
        <div class="book-end">✳</div>
      </article>

      <footer class="reader-footer">
        Сделано с вниманием к мыслям · Поле заметок
      </footer>
    </main>
  `);

  document.querySelector("#book-content").innerHTML =
    renderMarkdown(note.markdown);

  const actions = document.querySelector("#reader-actions");

  if (note.canEdit) {
    const link = document.createElement("a");
    link.className = "button quiet";
    link.href = `#/edit/${note.id}/${state.route.key}`;
    link.textContent = "Редактировать ↗";
    actions.append(link);
  } else {
    const existing = storedNotes().find(
      (item) => item.id === note.id && item.mode === "edit"
    );

    if (existing) {
      const link = document.createElement("a");
      link.className = "button quiet";
      link.href = `#/edit/${note.id}/${existing.key}`;
      link.textContent = "Редактировать ↗";
      actions.append(link);
    }
  }

  if (note.sources.length) {
    const section = document.querySelector("#book-sources");
    const heading = document.createElement("h2");
    heading.className = "sources-heading";
    heading.textContent = "Источники";
    section.append(heading);

    note.sources.forEach((source, index) => {
      const entry = document.createElement("div");
      entry.className = "book-source";

      const number = document.createElement("span");
      number.className = "book-source-number";
      number.textContent = String(index + 1).padStart(2, "0");

      const content = document.createElement("div");

      if (source.type === "url") {
        const link = document.createElement("a");
        link.textContent = source.name;
        link.href = source.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        content.append(link);

        const address = document.createElement("div");
        address.className = "muted source-address";
        address.textContent = source.url;
        content.append(address);
      } else {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = `${source.name} · файл Markdown`;

        const body = document.createElement("div");
        body.className = "source-markdown prose";
        body.innerHTML = renderMarkdown(source.content);

        details.append(summary, body);
        content.append(details);
      }

      entry.append(number, content);
      section.append(entry);
    });
  }
}

async function showRoute() {
  state.route = route();
  state.note = null;
  state.sources = [];
  state.dirty = false;

  if (!state.route) {
    renderHome();
    return;
  }

  shell(`<main class="loading">Открываем конспект…</main>`);

  try {
    const note = await request(
      `/api/notes/${state.route.id}`,
      {},
      state.route.key
    );

    state.note = note;
    state.sources = structuredClone(note.sources);

    if (state.route.mode === "edit" && !note.canEdit) {
      location.hash = `/view/${state.route.id}/${state.route.key}`;
      return;
    }

    const existing = storedNotes().find((item) => item.id === note.id);

    if (!existing || existing.mode !== "edit") {
      rememberNote({
        id: note.id,
        key: state.route.key,
        title: note.title,
        mode: note.canEdit ? "edit" : "view"
      });
    }

    if (state.route.mode === "edit") renderEditor();
    else renderReader();
  } catch (error) {
    shell(`
      <main class="loading">
        <h1>Не получилось открыть конспект</h1>
        <p>${escapeHtml(error.message)}</p>
        <a class="button primary" href="/">На главную</a>
      </main>
    `);
  }
}

window.addEventListener("hashchange", () => {
  if (state.dirty && !confirm(
    "Есть несохранённые изменения. Покинуть редактор?"
  )) {
    history.forward();
    return;
  }

  showRoute();
});

window.addEventListener("beforeunload", (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

setTheme(theme());
showRoute();
