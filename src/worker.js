const MAX_BODY = 350_000;
const MAX_MARKDOWN = 200_000;
const MAX_SOURCE_MARKDOWN = 100_000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function fail(message, status) {
  return json({ error: message }, status);
}

function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function hash(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

async function readJson(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY) throw new Error("BODY_TOO_LARGE");

  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error("BODY_TOO_LARGE");

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("BAD_JSON");
  }
}

function validateInput(data) {
  if (!data || typeof data !== "object") return null;

  const title = typeof data.title === "string" ? data.title.trim() : "";
  const markdown = data.markdown;
  const sources = data.sources;

  if (!title || title.length > 160) return null;
  if (typeof markdown !== "string" || markdown.length > MAX_MARKDOWN) return null;
  if (!Array.isArray(sources) || sources.length > 30) return null;

  const cleaned = [];

  for (const source of sources) {
    if (!source || typeof source !== "object") return null;

    const name = typeof source.name === "string" ? source.name.trim() : "";
    if (!name || name.length > 160) return null;

    if (source.type === "url") {
      if (typeof source.url !== "string" || source.url.length > 2048) {
        return null;
      }

      let url;
      try {
        url = new URL(source.url);
      } catch {
        return null;
      }

      if (!["http:", "https:"].includes(url.protocol)) return null;
      cleaned.push({ type: "url", name, url: url.toString() });
    } else if (source.type === "markdown") {
      if (
        typeof source.content !== "string" ||
        source.content.length > MAX_SOURCE_MARKDOWN
      ) {
        return null;
      }

      cleaned.push({
        type: "markdown",
        name,
        content: source.content
      });
    } else {
      return null;
    }
  }

  return { title, markdown, sources: cleaned };
}

function getBearer(request) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(
    request.headers.get("authorization") || ""
  );
  return match?.[1] || null;
}

async function getAuthorizedNote(env, id, key, needEdit = false) {
  if (!key) return null;

  const keyHash = await hash(key);
  const note = await env.DB.prepare(
    `SELECT id, title, markdown, sources_json, version, updated_at,
            edit_hash, view_hash
     FROM notes WHERE id = ?`
  )
    .bind(id)
    .first();

  if (!note) return null;

  const canEdit = note.edit_hash === keyHash;
  const canView = canEdit || note.view_hash === keyHash;

  if (!canView || (needEdit && !canEdit)) return null;

  return { note, canEdit };
}

async function api(request, env, pathname) {
  if (pathname === "/api/notes" && request.method === "POST") {
    const input = validateInput(await readJson(request));
    if (!input) return fail("Проверь название, текст и источники.", 400);

    const id = crypto.randomUUID();
    const editKey = randomKey();
    const viewKey = randomKey();

    await env.DB.prepare(
      `INSERT INTO notes
       (id, title, markdown, sources_json, edit_hash, view_hash)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        input.title,
        input.markdown,
        JSON.stringify(input.sources),
        await hash(editKey),
        await hash(viewKey)
      )
      .run();

    return json({ id, editKey, viewKey }, 201);
  }

  const match = /^\/api\/notes\/([a-f0-9-]{36})$/.exec(pathname);
  if (!match) return fail("Не найдено.", 404);

  const id = match[1];
  const key = getBearer(request);

  if (request.method === "GET") {
    const access = await getAuthorizedNote(env, id, key);
    if (!access) return fail("Конспект не найден или нет доступа.", 404);

    const { note, canEdit } = access;

    return json({
      id: note.id,
      title: note.title,
      markdown: note.markdown,
      sources: JSON.parse(note.sources_json),
      version: note.version,
      updatedAt: note.updated_at,
      canEdit
    });
  }

  if (request.method === "PUT") {
    const access = await getAuthorizedNote(env, id, key, true);
    if (!access) return fail("Нет доступа к редактированию.", 403);

    const data = await readJson(request);
    const input = validateInput(data);
    if (!input || !Number.isSafeInteger(data.version) || data.version < 1) {
      return fail("Некорректные данные.", 400);
    }

    const result = await env.DB.prepare(
      `UPDATE notes
       SET title = ?,
           markdown = ?,
           sources_json = ?,
           version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND version = ?`
    )
      .bind(
        input.title,
        input.markdown,
        JSON.stringify(input.sources),
        id,
        data.version
      )
      .run();

    if (result.meta.changes !== 1) {
      return fail(
        "Конспект уже изменён другим редактором. Скопируй свой текст перед обновлением страницы.",
        409
      );
    }

    return json({ version: data.version + 1 });
  }

  return fail("Метод не поддерживается.", 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/api/")) {
        return await api(request, env, url.pathname);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error?.message === "BODY_TOO_LARGE") {
        return fail("Слишком большой конспект или файл.", 413);
      }

      if (error?.message === "BAD_JSON") {
        return fail("Некорректный JSON.", 400);
      }

      console.error(error);
      return fail("Ошибка сервера.", 500);
    }
  }
};
