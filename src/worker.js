const MAX_BODY = 350_000;
const SESSION_AGE = 30 * 24 * 60 * 60;
const ITERATIONS = 210_000;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

const error = (message, status = 400) => json({ error: message }, status);

function randomHex(size = 32) {
  return [...crypto.getRandomValues(new Uint8Array(size))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(value) {
  const result = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return [...new Uint8Array(result)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(value) {
  return Uint8Array.from(value.match(/../g).map((part) => parseInt(part, 16)));
}

async function passwordHash(password, salt) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: fromHex(salt),
      iterations: ITERATIONS,
      hash: "SHA-256"
    },
    material,
    256
  );

  return [...new Uint8Array(bits)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function equalHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;

  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return difference === 0;
}

async function body(request) {
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY) {
    throw new Error("TOO_LARGE");
  }

  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error("TOO_LARGE");

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("BAD_JSON");
  }
}

function cleanNote(data) {
  if (!data || typeof data !== "object") return null;

  const title = typeof data.title === "string" ? data.title.trim() : "";
  const markdown = data.markdown;

  if (!title || title.length > 160) return null;
  if (typeof markdown !== "string" || markdown.length > 200_000) return null;
  if (!Array.isArray(data.sources) || data.sources.length > 30) return null;

  const sources = [];

  for (const source of data.sources) {
    const name = typeof source?.name === "string"
      ? source.name.trim()
      : "";

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

      sources.push({ type: "url", name, url: url.toString() });
    } else if (source.type === "markdown") {
      if (
        typeof source.content !== "string" ||
        source.content.length > 100_000
      ) {
        return null;
      }

      sources.push({
        type: "markdown",
        name,
        content: source.content
      });
    } else {
      return null;
    }
  }

  return { title, markdown, sources };
}

function cookie(request, name) {
  const match = request.headers.get("cookie")?.match(
    new RegExp(`(?:^|;\\s*)${name}=([^;]+)`)
  );

  return match?.[1] || null;
}

function sessionCookie(token, maxAge = SESSION_AGE) {
  return `note_session=${token}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

async function currentUser(request, env) {
  const token = cookie(request, "note_session");
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;

  return env.DB.prepare(
    `SELECT users.id, users.username, users.display_name
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > ?`
  )
    .bind(await sha256(token), Math.floor(Date.now() / 1000))
    .first();
}

async function issueSession(env, userId) {
  const token = randomHex();

  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES (?, ?, ?)`
  )
    .bind(
      await sha256(token),
      userId,
      Math.floor(Date.now() / 1000) + SESSION_AGE
    )
    .run();

  return token;
}

async function rateLimit(env, request, category, limit = 10) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const key = await sha256(`${category}:${ip}`);
  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `INSERT INTO auth_limits (key, attempts, reset_at)
     VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       attempts = CASE
         WHEN reset_at <= ? THEN 1
         ELSE attempts + 1
       END,
       reset_at = CASE
         WHEN reset_at <= ? THEN excluded.reset_at
         ELSE reset_at
       END`
  )
    .bind(key, now + 900, now, now)
    .run();

  const record = await env.DB.prepare(
    "SELECT attempts FROM auth_limits WHERE key = ?"
  )
    .bind(key)
    .first();

  return record.attempts <= limit;
}

async function noteAccess(env, id, user) {
  const note = await env.DB.prepare(
    `SELECT id, owner_id, title, markdown, sources_json,
            version, updated_at, invite_hash, edit_hash, view_hash
     FROM notes WHERE id = ?`
  )
    .bind(id)
    .first();

  if (!note) return null;

  let role = null;

  if (user?.id === note.owner_id) {
    role = "owner";
  } else if (user) {
    const member = await env.DB.prepare(
      "SELECT role FROM note_members WHERE note_id = ? AND user_id = ?"
    )
      .bind(id, user.id)
      .first();

    role = member?.role || null;
  }

  return { note, role };
}

function publicNote(note, role) {
  return {
    id: note.id,
    title: note.title,
    markdown: note.markdown,
    sources: JSON.parse(note.sources_json),
    version: note.version,
    updatedAt: note.updated_at,
    role,
    canEdit: role === "owner" || role === "editor"
  };
}

function legacyKey(request) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(
    request.headers.get("authorization") || ""
  );

  return match?.[1] || null;
}

function validId(id) {
  return /^[a-f0-9-]{36}$/.test(id);
}

async function api(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // Cookie-сессии: изменяющие запросы разрешены только с нашего origin.
  if (!["GET", "HEAD"].includes(method)) {
    if (request.headers.get("origin") !== url.origin) {
      return error("Недопустимый источник запроса.", 403);
    }
  }

  const user = await currentUser(request, env);

  if (path === "/api/me" && method === "GET") {
    return json({
      user: user
        ? {
            id: user.id,
            username: user.username,
            displayName: user.display_name
          }
        : null
    });
  }

  if (path === "/api/auth/register" && method === "POST") {
    if (!(await rateLimit(env, request, "register", 6))) {
      return error("Слишком много попыток. Попробуй позже.", 429);
    }

    const data = await body(request);
    const username = String(data?.username || "").trim().toLowerCase();
    const displayName = String(data?.displayName || "").trim();
    const password = data?.password;

    if (!/^[a-z0-9_]{3,24}$/.test(username)) {
      return error("Логин: 3–24 символа, латинские буквы, цифры и _."); 
    }

    if (!displayName || displayName.length > 50) {
      return error("Укажи имя длиной до 50 символов.");
    }

    if (
      typeof password !== "string" ||
      password.length < 12 ||
      password.length > 128
    ) {
      return error("Пароль должен содержать от 12 до 128 символов.");
    }

    const salt = randomHex(16);
    const id = crypto.randomUUID();

    try {
      await env.DB.prepare(
        `INSERT INTO users
         (id, username, display_name, password_hash, password_salt)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind(
          id,
          username,
          displayName,
          await passwordHash(password, salt),
          salt
        )
        .run();
    } catch (e) {
      if (String(e).includes("UNIQUE")) {
        return error("Этот логин уже занят.", 409);
      }

      throw e;
    }

    const token = await issueSession(env, id);
    const response = json({ ok: true });
    response.headers.append("set-cookie", sessionCookie(token));
    return response;
  }

  if (path === "/api/auth/login" && method === "POST") {
    if (!(await rateLimit(env, request, "login", 12))) {
      return error("Слишком много попыток. Попробуй через 15 минут.", 429);
    }

    const data = await body(request);
    const username = String(data?.username || "").trim().toLowerCase();
    const password = data?.password;

    if (
      !/^[a-z0-9_]{3,24}$/.test(username) ||
      typeof password !== "string" ||
      password.length > 128
    ) {
      return error("Неверный логин или пароль.", 401);
    }

    const account = await env.DB.prepare(
      `SELECT id, password_hash, password_salt
       FROM users WHERE username = ?`
    )
      .bind(username)
      .first();

    // Даже для отсутствующего логина выполняем вычисление хеша.
    const salt = account?.password_salt || "0".repeat(32);
    const calculated = await passwordHash(password, salt);

    if (!account || !equalHex(calculated, account.password_hash)) {
      return error("Неверный логин или пароль.", 401);
    }

    const token = await issueSession(env, account.id);
    const response = json({ ok: true });
    response.headers.append("set-cookie", sessionCookie(token));
    return response;
  }

  if (path === "/api/auth/logout" && method === "POST") {
    const token = cookie(request, "note_session");

    if (token && /^[a-f0-9]{64}$/.test(token)) {
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
        .bind(await sha256(token))
        .run();
    }

    const response = json({ ok: true });
    response.headers.append("set-cookie", sessionCookie("", 0));
    return response;
  }

  if (path === "/api/notes" && method === "GET") {
    if (!user) return error("Сначала войди в аккаунт.", 401);

    const result = await env.DB.prepare(
      `SELECT notes.id, notes.title, notes.updated_at,
              CASE
                WHEN notes.owner_id = ? THEN 'owner'
                ELSE note_members.role
              END AS role
       FROM notes
       LEFT JOIN note_members
         ON note_members.note_id = notes.id
        AND note_members.user_id = ?
       WHERE notes.owner_id = ?
          OR note_members.user_id = ?
       ORDER BY notes.updated_at DESC
       LIMIT 100`
    )
      .bind(user.id, user.id, user.id, user.id)
      .all();

    return json({ notes: result.results });
  }

  if (path === "/api/notes" && method === "POST") {
    if (!user) return error("Сначала войди в аккаунт.", 401);

    const input = cleanNote(await body(request));
    if (!input) return error("Проверь текст и источники.");

    const id = crypto.randomUUID();
    const inviteToken = randomHex();

    await env.DB.prepare(
      `INSERT INTO notes
       (id, title, markdown, sources_json, edit_hash, view_hash,
        owner_id, invite_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        input.title,
        input.markdown,
        JSON.stringify(input.sources),
        await sha256(randomHex()),
        await sha256(randomHex()),
        user.id,
        await sha256(inviteToken)
      )
      .run();

    return json({ id, inviteToken }, 201);
  }

  const match = /^\/api\/notes\/([a-f0-9-]{36})(?:\/(.+))?$/.exec(path);
  if (!match || !validId(match[1])) return error("Не найдено.", 404);

  const id = match[1];
  const action = match[2] || "";
  const access = await noteAccess(env, id, user);
  if (!access) return error("Не найдено.", 404);

  const { note, role } = access;

  // Старые конспекты до переноса в аккаунт работают со старыми ключами.
  if (!note.owner_id && !action) {
    const key = legacyKey(request);
    const keyHash = key ? await sha256(key) : "";
    const canEdit = equalHex(keyHash, note.edit_hash);
    const canView = canEdit || equalHex(keyHash, note.view_hash);

    if (!canView) return error("Нет доступа.", 403);

    if (method === "GET") {
      return json({
        ...publicNote(note, canEdit ? "legacy-editor" : "legacy-viewer"),
        canEdit,
        legacy: true
      });
    }

    if (method === "PUT" && canEdit) {
      const data = await body(request);
      const input = cleanNote(data);

      if (!input || !Number.isSafeInteger(data.version)) {
        return error("Некорректные данные.");
      }

      const result = await env.DB.prepare(
        `UPDATE notes SET
           title = ?, markdown = ?, sources_json = ?,
           version = version + 1,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND owner_id IS NULL
           AND edit_hash = ? AND version = ?`
      )
        .bind(
          input.title,
          input.markdown,
          JSON.stringify(input.sources),
          id,
          keyHash,
          data.version
        )
        .run();

      if (result.meta.changes !== 1) {
        return error("Конспект изменился. Скопируй свои правки перед обновлением.", 409);
      }

      return json({ version: data.version + 1 });
    }

    return error("Нет доступа.", 403);
  }

  if (action === "claim" && method === "POST") {
    if (!user) return error("Сначала войди в аккаунт.", 401);
    if (note.owner_id) return error("Конспект уже перенесён.", 409);

    const data = await body(request);
    const editKey = data?.editKey;

    if (!/^[a-f0-9]{64}$/.test(editKey || "")) {
      return error("Нужна старая ссылка редактирования.", 403);
    }

    const editHash = await sha256(editKey);
    const inviteToken = randomHex();

    const result = await env.DB.prepare(
      `UPDATE notes
       SET owner_id = ?, invite_hash = ?,
           edit_hash = ?, view_hash = ?
       WHERE id = ? AND owner_id IS NULL AND edit_hash = ?`
    )
      .bind(
        user.id,
        await sha256(inviteToken),
        await sha256(randomHex()),
        await sha256(randomHex()),
        id,
        editHash
      )
      .run();

    if (result.meta.changes !== 1) {
      return error("Старая ссылка не подходит или конспект уже перенесён.", 409);
    }

    return json({ id, inviteToken });
  }

  if (action === "access" && method === "GET") {
    if (!user) return error("Сначала войди в аккаунт.", 401);

    if (role) return json({ status: "approved", role });

    const requestRow = await env.DB.prepare(
      `SELECT status FROM access_requests
       WHERE note_id = ? AND user_id = ?`
    )
      .bind(id, user.id)
      .first();

    return json({ status: requestRow?.status || "none" });
  }

  if (action === "request" && method === "POST") {
    if (!user) return error("Сначала войди в аккаунт.", 401);
    if (role) return json({ status: "approved", role });

    const data = await body(request);
    const token = data?.inviteToken;
    const requestedRole = data?.role;
    const message = String(data?.message || "").trim();

    if (
      !/^[a-f0-9]{64}$/.test(token || "") ||
      !(await sha256(token)).startsWith(note.invite_hash || "INVALID")
    ) {
      return error("Ссылка-приглашение недействительна.", 403);
    }

    if (!["viewer", "editor"].includes(requestedRole) || message.length > 300) {
      return error("Проверь заявку.");
    }

    const existing = await env.DB.prepare(
      `SELECT status FROM access_requests
       WHERE note_id = ? AND user_id = ?`
    )
      .bind(id, user.id)
      .first();

    if (existing?.status === "pending") {
      return json({ status: "pending" });
    }

    await env.DB.prepare(
      `INSERT INTO access_requests
       (note_id, user_id, requested_role, message, status)
       VALUES (?, ?, ?, ?, 'pending')
       ON CONFLICT(note_id, user_id) DO UPDATE SET
         requested_role = excluded.requested_role,
         message = excluded.message,
         status = 'pending',
         created_at = CURRENT_TIMESTAMP`
    )
      .bind(id, user.id, requestedRole, message)
      .run();

    return json({ status: "pending" });
  }

  if (action === "request" && method === "DELETE") {
    if (!user) return error("Сначала войди в аккаунт.", 401);

    await env.DB.prepare(
      "DELETE FROM access_requests WHERE note_id = ? AND user_id = ?"
    )
      .bind(id, user.id)
      .run();

    return json({ ok: true });
  }

  if (!role) return error("Нет доступа к конспекту.", 403);

  if (!action && method === "GET") {
    return json(publicNote(note, role));
  }

  if (!action && method === "PUT") {
    if (!["owner", "editor"].includes(role)) {
      return error("Нет права редактирования.", 403);
    }

    const data = await body(request);
    const input = cleanNote(data);

    if (
      !input ||
      !Number.isSafeInteger(data.version) ||
      data.version < 1
    ) {
      return error("Некорректные данные.");
    }

    // Права проверяются ещё раз прямо в UPDATE: отзыв доступа не должен
    // проигрывать гонку с сохранением уже открытой вкладки.
    const result = await env.DB.prepare(
      `UPDATE notes SET
         title = ?, markdown = ?, sources_json = ?,
         version = version + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND version = ?
         AND (
           owner_id = ?
           OR EXISTS (
             SELECT 1 FROM note_members
             WHERE note_id = notes.id
               AND user_id = ?
               AND role = 'editor'
           )
         )`
    )
      .bind(
        input.title,
        input.markdown,
        JSON.stringify(input.sources),
        id,
        data.version,
        user.id,
        user.id
      )
      .run();

    if (result.meta.changes !== 1) {
      return error(
        "Конспект изменился или доступ отозван. Скопируй свои правки перед обновлением.",
        409
      );
    }

    return json({ version: data.version + 1 });
  }

  if (role !== "owner") return error("Только владелец может это делать.", 403);

  if (action === "admin" && method === "GET") {
    const requests = await env.DB.prepare(
      `SELECT u.id AS userId, u.username, u.display_name AS displayName,
              r.requested_role AS requestedRole, r.message, r.created_at
       FROM access_requests r
       JOIN users u ON u.id = r.user_id
       WHERE r.note_id = ? AND r.status = 'pending'
       ORDER BY r.created_at ASC`
    )
      .bind(id)
      .all();

    const members = await env.DB.prepare(
      `SELECT u.id AS userId, u.username, u.display_name AS displayName,
              m.role
       FROM note_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.note_id = ?
       ORDER BY u.username ASC`
    )
      .bind(id)
      .all();

    return json({
      requests: requests.results,
      members: members.results
    });
  }

  if (action === "approve" && method === "POST") {
    const data = await body(request);
    const target = data?.userId;
    const approvedRole = data?.role;

    if (!validId(target || "") || !["viewer", "editor"].includes(approvedRole)) {
      return error("Некорректная заявка.");
    }

    const pending = await env.DB.prepare(
      `SELECT 1 FROM access_requests
       WHERE note_id = ? AND user_id = ? AND status = 'pending'`
    )
      .bind(id, target)
      .first();

    if (!pending) return error("Заявка уже обработана.", 409);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO note_members (note_id, user_id, role)
         VALUES (?, ?, ?)
         ON CONFLICT(note_id, user_id) DO UPDATE SET role = excluded.role`
      ).bind(id, target, approvedRole),
      env.DB.prepare(
        "DELETE FROM access_requests WHERE note_id = ? AND user_id = ?"
      ).bind(id, target)
    ]);

    return json({ ok: true });
  }

  if (action === "reject" && method === "POST") {
    const data = await body(request);
    if (!validId(data?.userId || "")) return error("Некорректная заявка.");

    await env.DB.prepare(
      `UPDATE access_requests SET status = 'rejected'
       WHERE note_id = ? AND user_id = ? AND status = 'pending'`
    )
      .bind(id, data.userId)
      .run();

    return json({ ok: true });
  }

  if (action === "member" && method === "PUT") {
    const data = await body(request);

    if (
      !validId(data?.userId || "") ||
      !["viewer", "editor"].includes(data?.role)
    ) {
      return error("Некорректная роль.");
    }

    await env.DB.prepare(
      `UPDATE note_members SET role = ?
       WHERE note_id = ? AND user_id = ?`
    )
      .bind(data.role, id, data.userId)
      .run();

    return json({ ok: true });
  }

  if (action === "member" && method === "DELETE") {
    const data = await body(request);
    if (!validId(data?.userId || "")) return error("Некорректный участник.");

    await env.DB.prepare(
      "DELETE FROM note_members WHERE note_id = ? AND user_id = ?"
    )
      .bind(id, data.userId)
      .run();

    return json({ ok: true });
  }

  if (action === "invite" && method === "POST") {
    const inviteToken = randomHex();

    await env.DB.prepare(
      "UPDATE notes SET invite_hash = ? WHERE id = ? AND owner_id = ?"
    )
      .bind(await sha256(inviteToken), id, user.id)
      .run();

    return json({ inviteToken });
  }

  return error("Не найдено.", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/api/")) {
        return await api(request, env, url);
      }

      return env.ASSETS.fetch(request);
    } catch (e) {
      if (e?.message === "TOO_LARGE") {
        return error("Слишком большой запрос.", 413);
      }

      if (e?.message === "BAD_JSON") {
        return error("Некорректные данные.");
      }

      console.error(e);
      return error("Ошибка сервера.", 500);
    }
  }
};
