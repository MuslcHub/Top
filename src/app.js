import { marked } from "marked";
import DOMPurify from "dompurify";
import "./style.css";

marked.setOptions({ gfm: true, breaks: true });

const app = document.querySelector("#app");

const state = {
  me: null,
  note: null,
  route: null,
  sources: [],
  dirty: false,
  timer: null,
  inviteToken: null
};

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function markdown(value) {
  const clean = DOMPurify.sanitize(marked.parse(value || ""), {
    ALLOWED_TAGS: [
      "p", "br", "strong", "em", "s", "blockquote", "ul", "ol", "li",
      "h1", "h2", "h3", "h4", "h5", "h6", "a", "code", "pre", "hr",
      "table", "thead", "tbody", "tr", "th", "td", "input"
    ],
    ALLOWED_ATTR: ["href", "title", "type", "checked", "disabled"]
  });

  const element = document.createElement("div");
  element.innerHTML = clean;

  element.querySelectorAll("a").forEach((link) => {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  });

  element.querySelectorAll("input").forEach((input) => {
    input.disabled = true;
  });

  return element.innerHTML;
}

function theme() {
  return localStorage.getItem("theme") || "light";
}

function setTheme(value) {
  localStorage.setItem("theme", value);
  document.documentElement.dataset.theme = value;
}

function toast(message, bad = false) {
  document.querySelector(".toast")?.remove();

  const el = document.createElement("div");
  el.className = `toast${bad ? " error" : ""}`;
  el.textContent = message;
  document.body.append(el);

  setTimeout(() => el.remove(), 5000);
}

async function api(path, method = "GET", data = null, legacyKey = null) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(data !== null ? { "content-type": "application/json" } : {}),
      ...(legacyKey ? { authorization: `Bearer ${legacyKey}` } : {})
    },
    ...(data !== null ? { body: JSON.stringify(data) } : {})
  });

  const result = await response.json();

  if (!response.ok) {
    const e = new Error(result.error || "Ошибка запроса");
    e.status = response.status;
    throw e;
  }

  return result;
}

function parseRoute() {
  const value = location.hash;
  let match;

  if ((match = /^#\/note\/([a-f0-9-]{36})$/.exec(value))) {
    return { type: "note", id: match[1] };
  }

  if ((match = /^#\/read\/([a-f0-9-]{36})$/.exec(value))) {
    return { type: "read", id: match[1] };
  }

  if ((match = /^#\/invite\/([a-f0-9-]{36})\/([a-f0-9]{64})$/.exec(value))) {
    return { type: "invite", id: match[1], token: match[2] };
  }

  if ((match = /^#\/(edit|view)\/([a-f0-9-]{36})\/([a-f0-9]{64})$/.exec(value))) {
    return { type: "legacy", id: match[2], key: match[3], mode: match[1] };
  }

  if (value === "#/login") return { type: "login" };
  if (value === "#/register") return { type: "register" };

  return { type: "home" };
}

function shell(content) {
  app.innerHTML = `
    <header class="topbar">
      <a href="/" class="brand">✳ <span>Поле заметок</span></a>
      <div class="top-actions">
        <span class="top-caption">
          ${state.me ? esc(state.me.displayName) : "Место для совместных мыслей"}
        </span>
        ${state.me
          ? '<button id="logout" class="text-button">Выйти</button>'
          : '<a href="#/login" class="text-button">Войти</a>'}
        <button class="icon-button" id="theme" title="Сменить тему">
          ${theme() === "light" ? "☾" : "☀"}
        </button>
      </div>
    </header>
    ${content}
  `;

  document.querySelector("#theme").onclick = () => {
    setTheme(theme() === "light" ? "dark" : "light");
    document.querySelector("#theme").textContent =
      theme() === "light" ? "☾" : "☀";
  };

  document.querySelector("#logout")?.addEventListener("click", async () => {
    await api("/api/auth/logout", "POST");
    state.me = null;
    location.hash = "";
    await navigate();
  });
}

async function refreshMe() {
  const result = await api("/api/me");
  state.me = result.user;
}

function home() {
  shell(`
    <main class="home">
      <div class="hero">
        <div class="eyebrow">СОВМЕСТНЫЕ КОНСПЕКТЫ</div>
        <h1>Собирайте знания.<br><em>Делитесь пониманием.</em></h1>
        <p>
          У конспекта есть владелец. Друг попросит доступ по ссылке,
          а ты решишь, может ли он читать или редактировать.
        </p>
        ${state.me
          ? '<button class="button primary" id="create">＋ Новый конспект</button>'
          : '<a class="button primary" href="#/register">Создать аккаунт</a>'}
      </div>

      <section class="library">
        <div class="section-title">
          <div>
            <div class="eyebrow">ВАША ПОЛКА</div>
            <h2>Конспекты</h2>
          </div>
        </div>
        <div class="note-grid" id="notes-grid"></div>
        <p class="fine-print">
          Старые конспекты можно открыть по прежним ссылкам редактирования
          и перенести в аккаунт.
        </p>
      </section>
    </main>
  `);

  if (!state.me) {
    document.querySelector("#notes-grid").innerHTML = `
      <div class="empty">
        <h3>Здесь пока тихо</h3>
        <p>Войди или создай аккаунт, чтобы увидеть свою полку.</p>
      </div>
    `;
    return;
  }

  api("/api/notes").then(({ notes }) => {
    const grid = document.querySelector("#notes-grid");
    if (!grid) return;

    grid.innerHTML = notes.length
      ? notes.map((note) => `
          <a class="note-card" href="#/note/${note.id}">
            <span class="card-icon">✦</span>
            <h3>${esc(note.title)}</h3>
            <span class="card-bottom">
              ${note.role === "owner" ? "Ваш конспект" :
                note.role === "editor" ? "Редактор" : "Читатель"}
              <span>↗</span>
            </span>
          </a>
        `).join("")
      : `
        <div class="empty">
          <h3>Полка пока пуста</h3>
          <p>Создай первый конспект или открой приглашение друга.</p>
        </div>
      `;
  }).catch((e) => toast(e.message, true));

  document.querySelector("#create").onclick = async () => {
    try {
      const created = await api("/api/notes", "POST", {
        title: "Новый конспект",
        markdown: "# Главная мысль\n\nНачните писать...",
        sources: []
      });

      // Приглашение показывается владельцу сразу после создания.
      state.inviteToken = created.inviteToken;
      location.hash = `#/note/${created.id}`;
    } catch (e) {
      toast(e.message, true);
    }
  };
}

function authPage(register) {
  shell(`
    <main class="auth-page">
      <div class="panel auth-panel">
        <div class="eyebrow">${register ? "НОВАЯ ГЛАВА" : "С ВОЗВРАЩЕНИЕМ"}</div>
        <h1>${register ? "Создать аккаунт" : "Войти в аккаунт"}</h1>

        <form id="auth-form">
          ${register
            ? '<label>Как вас называть<input name="displayName" maxlength="50" required></label>'
            : ""}
          <label>Логин
            <input name="username" minlength="3" maxlength="24"
              pattern="[A-Za-z0-9_]+" autocomplete="username" required>
          </label>
          <label>Пароль
            <input name="password" type="password"
              minlength="${register ? 12 : 1}"
              autocomplete="${register ? "new-password" : "current-password"}"
              required>
          </label>
          <button class="button primary full">
            ${register ? "Зарегистрироваться" : "Войти"}
          </button>
        </form>

        <p class="fine-print">
          ${register
            ? 'Уже есть аккаунт? <a href="#/login">Войти</a>'
            : 'Нет аккаунта? <a href="#/register">Зарегистрироваться</a>'}
        </p>
        ${register
          ? '<p class="fine-print">Без почты восстановление забытого пароля пока недоступно. Сохрани его в менеджере паролей.</p>'
          : ""}
      </div>
    </main>
  `);

  document.querySelector("#auth-form").onsubmit = async (event) => {
    event.preventDefault();

    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    const button = form.querySelector("button");
    button.disabled = true;

    try {
      await api(
        register ? "/api/auth/register" : "/api/auth/login",
        "POST",
        data
      );

      await refreshMe();

      // Не теряем приглашение при переходе на вход.
      const destination = sessionStorage.getItem("afterLogin");
      sessionStorage.removeItem("afterLogin");

      location.hash = destination || "";
      await navigate();
    } catch (e) {
      toast(e.message, true);
    } finally {
      button.disabled = false;
    }
  };
}

async function invitation(route) {
  if (!state.me) {
    sessionStorage.setItem("afterLogin", location.hash);
    authPage(false);
    toast("Войди в аккаунт, чтобы запросить доступ.");
    return;
  }

  const access = await api(`/api/notes/${route.id}/access`);

  if (access.status === "approved") {
    location.hash = `#/note/${route.id}`;
    return;
  }

  shell(`
    <main class="auth-page">
      <div class="panel auth-panel">
        <div class="eyebrow">ПРИГЛАШЕНИЕ</div>
        <h1>Доступ к конспекту</h1>
        <p class="muted">
          Содержимое конспекта откроется только после одобрения владельцем.
        </p>

        <div id="invitation-body"></div>
      </div>
    </main>
  `);

  const container = document.querySelector("#invitation-body");

  if (access.status === "pending") {
    container.innerHTML = `
      <div class="waiting">
        <span class="waiting-icon">✳</span>
        <h2>Ожидаем подтверждения</h2>
        <p>Владелец увидит твою заявку. Эта страница откроет конспект
        автоматически после одобрения.</p>
        <button class="button quiet" id="cancel-request">
          Отменить заявку
        </button>
      </div>
    `;

    document.querySelector("#cancel-request").onclick = async () => {
      await api(`/api/notes/${route.id}/request`, "DELETE");
      await invitation(route);
    };

    state.timer = setInterval(async () => {
      try {
        const updated = await api(`/api/notes/${route.id}/access`);

        if (updated.status === "approved") {
          clearInterval(state.timer);
          location.hash = `#/note/${route.id}`;
        } else if (updated.status !== "pending") {
          clearInterval(state.timer);
          await invitation(route);
        }
      } catch {
        // При временном отсутствии связи продолжаем ждать.
      }
    }, 5000);

    return;
  }

  container.innerHTML = `
    ${access.status === "rejected"
      ? '<p class="notice">Предыдущая заявка отклонена. Можно отправить новую.</p>'
      : ""}
    <form id="request-form">
      <label>Мне нужен доступ
        <select name="role">
          <option value="viewer">Для чтения</option>
          <option value="editor">Для редактирования</option>
        </select>
      </label>
      <label>Сообщение владельцу — необязательно
        <textarea name="message" maxlength="300"
          placeholder="Привет! Это я, хочу дополнить конспект."></textarea>
      </label>
      <button class="button primary full">Отправить заявку</button>
    </form>
  `;

  document.querySelector("#request-form").onsubmit = async (event) => {
    event.preventDefault();

    const data = Object.fromEntries(new FormData(event.currentTarget));

    try {
      await api(`/api/notes/${route.id}/request`, "POST", {
        inviteToken: route.token,
        role: data.role,
        message: data.message
      });

      await invitation(route);
    } catch (e) {
      toast(e.message, true);
    }
  };
}

function sourceRows() {
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

    const name = document.createElement("span");
    name.className = "source-name";
    name.textContent = `${source.type === "url" ? "↗" : "MD"}  ${source.name}`;

    const remove = document.createElement("button");
    remove.className = "text-button";
    remove.textContent = "Удалить";
    remove.onclick = () => {
      state.sources.splice(index, 1);
      state.dirty = true;
      sourceRows();
    };

    row.append(name, remove);
    list.append(row);
  });
}

async function editor(route, note) {
  state.note = note;
  state.sources = structuredClone(note.sources);

  const legacy = route.type === "legacy";

  shell(`
    <main class="workspace">
      <div class="workspace-heading">
        <div>
          <a class="back-link" href="/">← На полку</a>
          <div class="eyebrow">РЕДАКТОР · ${esc(note.role)}</div>
          <h1>Слова обретают форму.</h1>
        </div>
        <div class="heading-actions">
          ${note.role === "owner"
            ? '<button class="button quiet" id="manage">Заявки и участники</button>'
            : ""}
          ${legacy && note.canEdit && state.me
            ? '<button class="button quiet" id="claim">Перенести в аккаунт</button>'
            : ""}
          <a class="button quiet"
            href="${legacy
              ? `#/view/${note.id}/${route.key}`
              : `#/read/${note.id}`}">Читать как книгу</a>
          <button class="button primary" id="save">Сохранить</button>
        </div>
      </div>

      <div class="editor-layout">
        <section class="panel editor-panel">
          <div class="panel-heading">
            <span>01 / СОДЕРЖАНИЕ</span>
            <span class="muted">Markdown</span>
          </div>
          <label class="field-label">Название</label>
          <input class="title-input" id="title" maxlength="160"
            value="${esc(note.title)}">
          <label class="field-label">Текст</label>
          <textarea class="markdown-input" id="text"></textarea>
          <div class="editor-footer">
            <span id="status">Изменения сохранены</span>
            <button class="text-button" id="import" type="button">
              Импортировать .md в текст
            </button>
            <input id="import-file" type="file" accept=".md,text/markdown" hidden>
          </div>
        </section>

        <aside class="side-column">
          <section class="panel">
            <div class="panel-heading"><span>02 / ПРЕДПРОСМОТР</span></div>
            <div class="preview-paper prose" id="preview"></div>
          </section>
          <section class="panel">
            <div class="panel-heading"><span>03 / ИСТОЧНИКИ</span></div>
            <div id="sources-list"></div>
            <div class="source-form">
              <input id="source-name" placeholder="Название источника">
              <input id="source-url" placeholder="https://example.com">
              <button class="button quiet full" id="add-url">
                ＋ Добавить ссылку
              </button>
              <button class="button quiet full" id="add-md">
                ＋ Добавить .md как источник
              </button>
              <input id="source-file" type="file"
                accept=".md,text/markdown" hidden>
            </div>
          </section>
        </aside>
      </div>
    </main>
  `);

  const title = document.querySelector("#title");
  const text = document.querySelector("#text");
  const preview = document.querySelector("#preview");

  text.value = note.markdown;
  preview.innerHTML = markdown(text.value);
  sourceRows();

  const dirty = () => {
    state.dirty = true;
    document.querySelector("#status").textContent =
      "Есть несохранённые изменения";
  };

  title.oninput = dirty;
  text.oninput = () => {
    dirty();
    preview.innerHTML = markdown(text.value);
  };

  document.querySelector("#save").onclick = async () => {
    const button = document.querySelector("#save");
    button.disabled = true;

    const submitted = {
      title: title.value.trim(),
      markdown: text.value,
      sources: structuredClone(state.sources),
      version: state.note.version
    };

    try {
      const result = await api(
        `/api/notes/${note.id}`,
        "PUT",
        submitted,
        legacy ? route.key : null
      );

      state.note.version = result.version;
      state.dirty =
        title.value.trim() !== submitted.title ||
        text.value !== submitted.markdown ||
        JSON.stringify(state.sources) !== JSON.stringify(submitted.sources);

      document.querySelector("#status").textContent = state.dirty
        ? "Появились новые несохранённые изменения"
        : "Изменения сохранены";

      toast("Конспект сохранён.");
    } catch (e) {
      toast(e.message, true);

      if (e.status === 403) {
        state.dirty = false;
        await navigate();
      }
    } finally {
      button.disabled = false;
    }
  };

  document.querySelector("#add-url").onclick = () => {
    const name = document.querySelector("#source-name");
    const input = document.querySelector("#source-url");

    let url;

    try {
      url = new URL(input.value.trim());
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    } catch {
      toast("Нужна ссылка http:// или https://", true);
      return;
    }

    if (!name.value.trim() || state.sources.length >= 30) {
      toast("Укажи название. Максимум — 30 источников.", true);
      return;
    }

    state.sources.push({
      type: "url",
      name: name.value.trim(),
      url: url.toString()
    });

    name.value = "";
    input.value = "";
    dirty();
    sourceRows();
  };

  document.querySelector("#add-md").onclick = () => {
    document.querySelector("#source-file").click();
  };

  document.querySelector("#source-file").onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (
      !file.name.toLowerCase().endsWith(".md") ||
      file.size > 100_000 ||
      state.sources.length >= 30
    ) {
      toast("Нужен .md до 100 КБ. Максимум — 30 источников.", true);
      return;
    }

    state.sources.push({
      type: "markdown",
      name: file.name,
      content: await file.text()
    });

    dirty();
    sourceRows();
    event.target.value = "";
  };

  document.querySelector("#import").onclick = () => {
    document.querySelector("#import-file").click();
  };

  document.querySelector("#import-file").onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".md") || file.size > 200_000) {
      toast("Нужен файл .md до 200 КБ.", true);
      return;
    }

    if (text.value.trim() && !confirm("Заменить текущий текст файлом?")) {
      return;
    }

    text.value = await file.text();
    preview.innerHTML = markdown(text.value);
    dirty();
  };

  if (note.role === "owner") {
    document.querySelector("#manage").onclick = () => management(note.id);
  }

  if (legacy && note.canEdit && state.me) {
    document.querySelector("#claim").onclick = async () => {
      if (state.dirty) {
        toast("Сначала сохрани изменения.", true);
        return;
      }

      if (!confirm(
        "Перенести конспект в твой аккаунт? Старые ссылки чтения и " +
        "редактирования перестанут работать."
      )) return;

      try {
        const result = await api(
          `/api/notes/${note.id}/claim`,
          "POST",
          { editKey: route.key }
        );

        state.inviteToken = result.inviteToken;
        location.hash = `#/note/${note.id}`;
      } catch (e) {
        toast(e.message, true);
      }
    };
  }

  // Пока нет WebSocket: регулярно проверяем, не отозван ли доступ.
  if (!legacy) {
    state.timer = setInterval(async () => {
      try {
        const current = await api(`/api/notes/${note.id}`);

        if (!current.canEdit) {
          clearInterval(state.timer);
          state.dirty = false;
          await navigate();
          toast("Право редактирования изменилось.", true);
        }
      } catch (e) {
        if (e.status === 403) {
          clearInterval(state.timer);
          state.dirty = false;
          await navigate();
          toast("Доступ к конспекту отозван.", true);
        }
      }
    }, 8000);
  }
}

function reader(route, note) {
  shell(`
    <main class="reader">
      <div class="reader-navigation">
        <a class="back-link" href="/">← На полку</a>
        <span class="reader-label">РЕЖИМ ЧТЕНИЯ · РЕДАКЦИЯ ${note.version}</span>
        ${note.canEdit
          ? `<a class="button quiet" href="${route.type === "legacy"
              ? `#/edit/${note.id}/${route.key}`
              : `#/note/${note.id}`}">Редактировать ↗</a>`
          : "<span></span>"}
      </div>

      <article class="book">
        <div class="book-topline">ПОЛЕ ЗАМЕТОК <span>✳</span> КОНСПЕКТ</div>
        <div class="book-cover">
          <span class="book-ornament">✦</span>
          <div class="eyebrow">ЗАПИСИ И ИДЕИ</div>
          <h1>${esc(note.title)}</h1>
          <div class="cover-rule"></div>
          <p>Текст, к которому можно вернуться.</p>
        </div>
        <div class="book-body prose" id="book-text"></div>
        <div id="reader-sources"></div>
        <div class="book-end">✳</div>
      </article>
    </main>
  `);

  document.querySelector("#book-text").innerHTML = markdown(note.markdown);

  const list = document.querySelector("#reader-sources");
  if (!note.sources.length) return;

  const heading = document.createElement("h2");
  heading.className = "sources-heading";
  heading.textContent = "Источники";
  list.append(heading);

  note.sources.forEach((source, index) => {
    const row = document.createElement("div");
    row.className = "book-source";

    const number = document.createElement("span");
    number.className = "book-source-number";
    number.textContent = String(index + 1).padStart(2, "0");

    const content = document.createElement("div");

    if (source.type === "url") {
      const link = document.createElement("a");
      link.href = source.url;
      link.textContent = source.name;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      content.append(link);
    } else {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = `${source.name} · файл Markdown`;

      const text = document.createElement("div");
      text.className = "source-markdown prose";
      text.innerHTML = markdown(source.content);

      details.append(summary, text);
      content.append(details);
    }

    row.append(number, content);
    list.append(row);
  });

  if (route.type !== "legacy") {
    state.timer = setInterval(async () => {
      try {
        await api(`/api/notes/${note.id}`);
      } catch (e) {
        if (e.status === 403) {
          clearInterval(state.timer);
          await navigate();
          toast("Доступ отозван.", true);
        }
      }
    }, 8000);
  }
}

async function management(id) {
  const { requests, members } = await api(`/api/notes/${id}/admin`);

  shell(`
    <main class="workspace">
      <a class="back-link" href="#/note/${id}">← К конспекту</a>
      <div class="workspace-heading">
        <div>
          <div class="eyebrow">УПРАВЛЕНИЕ ДОСТУПОМ</div>
          <h1>Заявки и участники</h1>
        </div>
      </div>

      <div class="management-grid">
        <section class="panel">
          <div class="panel-heading"><span>ОЖИДАЮТ ОТВЕТА</span></div>
          <div id="requests"></div>
        </section>

        <section class="panel">
          <div class="panel-heading"><span>УЧАСТНИКИ</span></div>
          <div id="members"></div>
        </section>

        <section class="panel">
          <div class="panel-heading"><span>ПРИГЛАШЕНИЕ</span></div>
          <p class="muted">
            Ссылка не открывает конспект сразу — только позволяет
            отправить заявку. После замены ссылки старая больше не
            принимает заявки. Доступ одобренных участников сохранится.
          </p>
          <button class="button quiet" id="copy-invite">
            Скопировать ссылку
          </button>
          <button class="button quiet" id="rotate-invite">
            Заменить ссылку
          </button>
        </section>
      </div>
    </main>
  `);

  const pending = document.querySelector("#requests");
  const people = document.querySelector("#members");

  if (!requests.length) {
    pending.innerHTML = '<p class="muted">Новых заявок нет.</p>';
  }

  requests.forEach((request) => {
    const row = document.createElement("div");
    row.className = "management-row";

    row.innerHTML = `
      <strong>${esc(request.displayName)}</strong>
      <span class="muted">@${esc(request.username)} ·
        просит ${request.requestedRole === "editor"
          ? "редактирование"
          : "чтение"}
      </span>
      ${request.message
        ? `<p>${esc(request.message)}</p>`
        : ""}
      <div class="row-actions"></div>
    `;

    const actions = row.querySelector(".row-actions");

    for (const [label, role] of [
      ["Разрешить чтение", "viewer"],
      ["Разрешить редактирование", "editor"]
    ]) {
      const button = document.createElement("button");
      button.className = "button quiet";
      button.textContent = label;

      button.onclick = async () => {
        try {
          await api(`/api/notes/${id}/approve`, "POST", {
            userId: request.userId,
            role
          });
          await management(id);
        } catch (e) {
          toast(e.message, true);
        }
      };

      actions.append(button);
    }

    const reject = document.createElement("button");
    reject.className = "text-button";
    reject.textContent = "Отклонить";
    reject.onclick = async () => {
      await api(`/api/notes/${id}/reject`, "POST", {
        userId: request.userId
      });
      await management(id);
    };

    actions.append(reject);
    pending.append(row);
  });

  if (!members.length) {
    people.innerHTML = '<p class="muted">Пока нет участников.</p>';
  }

  members.forEach((member) => {
    const row = document.createElement("div");
    row.className = "management-row";

    row.innerHTML = `
      <strong>${esc(member.displayName)}</strong>
      <span class="muted">@${esc(member.username)} ·
        ${member.role === "editor" ? "редактор" : "читатель"}
      </span>
      <div class="row-actions"></div>
    `;

    const actions = row.querySelector(".row-actions");

    const change = document.createElement("button");
    change.className = "button quiet";
    change.textContent = member.role === "editor"
      ? "Оставить только чтение"
      : "Разрешить редактирование";

    change.onclick = async () => {
      await api(`/api/notes/${id}/member`, "PUT", {
        userId: member.userId,
        role: member.role === "editor" ? "viewer" : "editor"
      });

      await management(id);
    };

    const revoke = document.createElement("button");
    revoke.className = "text-button";
    revoke.textContent = "Отозвать доступ";

    revoke.onclick = async () => {
      if (!confirm(`Отозвать доступ у @${member.username}?`)) return;

      await api(`/api/notes/${id}/member`, "DELETE", {
        userId: member.userId
      });

      await management(id);
    };

    actions.append(change, revoke);
    people.append(row);
  });

  document.querySelector("#copy-invite").onclick = async () => {
    if (!state.inviteToken) {
      toast(
        "Текущий токен показывается только при создании/замене ссылки. " +
        "Нажми «Заменить ссылку», чтобы получить новую.",
        true
      );
      return;
    }

    await navigator.clipboard.writeText(
      `${location.origin}/#/invite/${id}/${state.inviteToken}`
    );

    toast("Ссылка-приглашение скопирована.");
  };

  document.querySelector("#rotate-invite").onclick = async () => {
    if (!confirm(
      "Старая ссылка перестанет принимать новые заявки. Продолжить?"
    )) return;

    const data = await api(`/api/notes/${id}/invite`, "POST");
    state.inviteToken = data.inviteToken;

    await navigator.clipboard.writeText(
      `${location.origin}/#/invite/${id}/${data.inviteToken}`
    );

    toast("Новая ссылка создана и скопирована.");
  };
}

async function navigate() {
  clearInterval(state.timer);
  state.timer = null;
  state.dirty = false;

  const route = parseRoute();
  state.route = route;

  if (route.type === "home") return home();
  if (route.type === "login") return authPage(false);
  if (route.type === "register") return authPage(true);

  shell('<main class="loading">Открываем страницу…</main>');

  try {
    if (route.type === "invite") {
      await invitation(route);
      return;
    }

    if (!state.me && route.type !== "legacy") {
      sessionStorage.setItem("afterLogin", location.hash);
      authPage(false);
      return;
    }

    const note = await api(
      `/api/notes/${route.id}`,
      "GET",
      null,
      route.type === "legacy" ? route.key : null
    );

    if (route.type === "read" || (
      route.type === "legacy" && route.mode === "view"
    )) {
      reader(route, note);
      return;
    }

    if (note.canEdit) {
      await editor(route, note);
    } else {
      reader(route, note);
    }
  } catch (e) {
    shell(`
      <main class="loading">
        <h1>Не удалось открыть страницу</h1>
        <p>${esc(e.message)}</p>
        <a class="button primary" href="/">На главную</a>
      </main>
    `);
  }
}

window.addEventListener("hashchange", () => {
  if (state.dirty && !confirm("Есть несохранённые изменения. Уйти?")) {
    history.forward();
    return;
  }

  navigate();
});

window.addEventListener("beforeunload", (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

setTheme(theme());

refreshMe()
  .then(navigate)
  .catch((e) => {
    toast(e.message, true);
    navigate();
  });
