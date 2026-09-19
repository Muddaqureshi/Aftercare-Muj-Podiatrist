import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { HttpError, openStore, getState, setup, credentials, passwordHash, passwordMatches, hashToken, requireClinician, mutate, clinicClock } from "./store.js";
import { makeAI } from "./ai.js";
import { makeMailer, makeReminders, reminderSettings, saveReminderSettings } from "./reminders.js";
import { makePublisher } from "./publish.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const assets = new Map([
  ["/", ["pilot/index.html", "text/html"]], ["/pilot/client.js", ["pilot/client.js", "text/javascript"]],
  ["/pilot/pilot.css", ["pilot/pilot.css", "text/css"]], ["/styles.css", ["styles.css", "text/css"]],
  ["/tokens.css", ["tokens.css", "text/css"]], ["/domain.js", ["domain.js", "text/javascript"]],
  ["/csv.js", ["csv.js", "text/javascript"]],
  ["/password-auth.js", ["password-auth.js", "text/javascript"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]]
]);

async function bodyJSON(req) {
  if (!(req.headers["content-type"] || "").startsWith("application/json")) throw new HttpError(415, "Send a JSON request.");
  let raw = "", size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new HttpError(413, "This request is too large.");
    raw += chunk;
  }
  let body;
  try { body = JSON.parse(raw); }
  catch { throw new HttpError(400, "The request is not valid JSON."); }
  if (!body || Array.isArray(body) || typeof body !== "object") throw new HttpError(400, "Send a JSON object.");
  return body;
}

export function createPilot({ dbPath = resolve(root, ".data/aftercare.sqlite"), now = () => new Date(), ai = makeAI({ model: process.env.OLLAMA_MODEL || "qwen3:1.7b" }), mailer = makeMailer(), publisher = makePublisher(), schedule = true } = {}) {
  const db = openStore(dbPath);
  const dummyHash = passwordHash(randomBytes(24).toString("hex"));
  const attempts = new Map();
  let timer, reminders, scheduledTask;
  function send(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  }
  function userFor(req) {
    const cookie = (req.headers.cookie || "").split(";").map(p => p.trim()).find(p => p.startsWith("aftercare_session="));
    const token = cookie?.slice("aftercare_session=".length);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    return db.prepare("SELECT u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?").get(hashToken(token), now().getTime()) || null;
  }
  function session(res, user) {
    const token = randomBytes(32).toString("hex");
    db.prepare("DELETE FROM sessions WHERE expires<=?").run(now().getTime());
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(hashToken(token), user.id, now().getTime() + 8 * 3600000);
    res.setHeader("Set-Cookie", `aftercare_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
  }
  function throttle(key, limit, minutes = 15) {
    const time = now().getTime();
    for (const [entry, value] of attempts) if (value.until <= time) attempts.delete(entry);
    if (attempts.size > 2000) throw new HttpError(429, "Too many requests. Please wait before trying again.");
    const record = attempts.get(key) || { count: 0, until: time + minutes * 60000 };
    record.count++;
    attempts.set(key, record);
    if (record.count > limit) throw new HttpError(429, "Too many attempts. Please wait before trying again.");
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
    try {
      const port = server.address().port;
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) throw new HttpError(403, "This pilot accepts only localhost requests.");
      const path = new URL(req.url, `http://${req.headers.host}`).pathname;
      if (req.method === "GET" && assets.has(path)) {
        const [file, type] = assets.get(path);
        const content = await readFile(resolve(root, file));
        res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
        res.end(content);
        return;
      }
      if (!path.startsWith("/api/")) throw new HttpError(404, "Not found.");
      if (!["GET", "POST"].includes(req.method)) throw new HttpError(405, "This method is not supported.");
      if (req.method === "POST" && (req.headers.origin !== `http://${req.headers.host}` || req.headers["x-aftercare"] !== "1")) throw new HttpError(403, "This request did not come from the Aftercare page. Refresh and try again.");
      const user = userFor(req);
      if (req.method === "GET" && path === "/api/bootstrap") {
        send(res, 200, { setupRequired: db.prepare("SELECT count(*) AS n FROM users").get().n === 0, user, scope: "Fictional-data local pilot" });
        return;
      }
      if (req.method === "POST" && ["/api/setup", "/api/login"].includes(path)) {
        throttle(`auth:${req.socket.remoteAddress}`, 20);
        const body = await bodyJSON(req);
        let account;
        if (path === "/api/setup") {
          account = setup(db, body, now());
        } else {
          const { username, password } = credentials(body);
          const row = db.prepare("SELECT * FROM users WHERE username=?").get(username);
          const matches = passwordMatches(password, row?.password || dummyHash);
          if (!row || !matches) throw new HttpError(401, "The username or password is incorrect.");
          account = { id: row.id, username: row.username, role: row.role };
        }
        session(res, account);
        send(res, 200, { user: account });
        return;
      }
      if (!user) throw new HttpError(401, "Sign in to the local pilot.");
      if (req.method === "POST") throttle(`writes:${user.id}`, 180, 1);
      if (req.method === "GET" && path === "/api/state") {
        send(res, 200, { ...getState(db), ...clinicClock(now()), user, mailMode: mailer.mode });
      } else if (req.method === "POST" && path === "/api/logout") {
        const cookie = (req.headers.cookie || "").split(";").map(v => v.trim()).find(v => v.startsWith("aftercare_session="));
        if (cookie) db.prepare("DELETE FROM sessions WHERE token=?").run(hashToken(cookie.slice("aftercare_session=".length)));
        res.setHeader("Set-Cookie", "aftercare_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
        send(res, 200, { signedOut: true });
      } else if (req.method === "POST" && path === "/api/actions") {
        send(res, 200, mutate(db, user, await bodyJSON(req), now()));
      } else if (req.method === "GET" && path === "/api/ai/status") {
        send(res, 200, await ai.status());
      } else if (req.method === "POST" && path === "/api/assistant") {
        throttle(`ai:${user.id}`, 20);
        const body = await bodyJSON(req);
        const result = await ai.ask(body.prompt, getState(db), clinicClock(now()).today);
        if (result.kind === "proposal") requireClinician(user);
        send(res, 200, result);
      } else if (req.method === "GET" && path === "/api/settings") {
        requireClinician(user);
        send(res, 200, { settings: reminderSettings(db), mailMode: mailer.mode, timezone: "America/New_York", users: db.prepare("SELECT id,username,role FROM users ORDER BY id").all(), reminders: db.prepare("SELECT * FROM reminders ORDER BY created_at DESC LIMIT 30").all() });
      } else if (req.method === "POST" && path === "/api/settings") {
        requireClinician(user);
        const settings = saveReminderSettings(db, await bodyJSON(req));
        db.prepare("INSERT INTO audit(user_id,action,at) VALUES(?,'reminder-settings',?)").run(user.id, now().toISOString());
        send(res, 200, { settings });
      } else if (req.method === "POST" && path === "/api/users") {
        requireClinician(user);
        const body = await bodyJSON(req);
        const { username, password } = credentials(body);
        if (db.prepare("SELECT count(*) AS n FROM users").get().n >= 20) throw new HttpError(400, "This local pilot supports up to 20 accounts.");
        if (db.prepare("SELECT id FROM users WHERE username=?").get(username)) throw new HttpError(409, "That username is already in use.");
        db.prepare("INSERT INTO users(username,password,role,created_at) VALUES(?,?,'staff',?)").run(username, passwordHash(password), now().toISOString());
        db.prepare("INSERT INTO audit(user_id,action,at) VALUES(?,'staff-account-created',?)").run(user.id, now().toISOString());
        send(res, 201, { created: true });
      } else if (req.method === "POST" && path === "/api/reminders/test") {
        requireClinician(user);
        throttle(`email:${user.id}`, 3, 1);
        const reminder = await reminders.send({ test: true });
        send(res, reminder.status === "failed" ? 502 : 200, { reminder, ...(reminder.status === "failed" ? { error: reminder.error } : {}) });
      } else if (req.method === "POST" && path === "/api/publish") {
        requireClinician(user);
        const body = await bodyJSON(req);
        if (body.fictionalOnly !== true) throw new HttpError(400, "Confirm that every case is fictional before publishing public data.");
        const state = getState(db);
        if (body.revision !== state.revision) throw new HttpError(409, "Refresh and review the latest cases before publishing.");
        const publication = await publisher.publish(state.patients, state.revision);
        db.prepare("INSERT INTO audit(user_id,action,at) VALUES(?,'fictional-snapshot-published',?)").run(user.id, now().toISOString());
        send(res, 200, publication);
      } else if (req.method === "GET" && path === "/api/audit") {
        send(res, 200, { entries: db.prepare("SELECT a.action,a.case_id,a.milestone_id,a.at,u.username FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 100").all() });
      } else {
        throw new HttpError(404, "This endpoint was not found.");
      }
    } catch (error) {
      if (!(error instanceof HttpError)) console.error("Aftercare request failed:", error.message);
      if (!res.headersSent) send(res, error.status || 500, { error: error instanceof HttpError ? error.message : "The server could not complete this request. No success was recorded; check the server log." });
      else res.end();
    }
  });
  server.requestTimeout = 100000;
  server.headersTimeout = 10000;
  return {
    db, server,
    async listen(port = 4317) {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
      const appURL = `http://127.0.0.1:${server.address().port}`;
      reminders = makeReminders(db, mailer, { now, appURL });
      if (schedule) {
        const tick = () => {
          if (scheduledTask) return;
          scheduledTask = reminders.send().catch(error => console.error("Reminder scheduler failed:", error.message)).finally(() => { scheduledTask = null; });
        };
        tick();
        timer = setInterval(tick, 30000);
        timer.unref();
      }
      return appURL;
    },
    async close() {
      clearInterval(timer);
      await new Promise(resolve => server.close(resolve));
      if (scheduledTask) await scheduledTask;
      db.close();
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("PORT must be between 1024 and 65535.");
  const pilot = createPilot();
  const url = await pilot.listen(port);
  console.log(`Aftercare local pilot: ${url}\nFictional data only. Create your clinician account in the browser.\nShared records: .data/aftercare.sqlite (not published).\nReminders run only while this process is running; keep this Mac awake.`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await pilot.close(); process.exit(0); });
}
