import { HttpError, clinicClock, mutatePatients } from "../backend-shared.js";
import { makeSeed } from "../domain.js";
import { authenticated, hash, token, rateLimit, getState, closedCases, saveState, expireCases, surgeon, cookieName } from "./core.js";
import { hostedAI, hostedMailer, sendReminder } from "./services.js";
import { proofVerifier, sameVerifier } from "../password-auth.js";

const assets = new Set(["/", "/index.html", "/domain.js", "/csv.js", "/password-auth.js", "/styles.css", "/tokens.css", "/favicon.svg", "/pilot/client.js", "/pilot/pilot.css"]);
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'"
};
const json = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8", ...extra } });

async function bodyJSON(request) {
  if (!(request.headers.get("content-type") || "").startsWith("application/json")) throw new HttpError(415, "Send a JSON request.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Send a JSON object.");
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) { await reader.cancel(); throw new HttpError(413, "This request is too large."); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new HttpError(400, "The request is not valid JSON."); }
  if (!body || Array.isArray(body) || typeof body !== "object") throw new HttpError(400, "Send a JSON object.");
  return body;
}

function configured(env, url) {
  if (!env.APP_ORIGIN || url.origin !== env.APP_ORIGIN) throw new HttpError(503, "This deployment's address has not been configured.");
  if (!env.GMAIL_ADDRESS || !/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(env.GMAIL_ADDRESS)) throw new HttpError(503, "The owner account has not been configured.");
}

function loginProfile(env) {
  let profile;
  try { profile = JSON.parse(env.OWNER_LOGIN); }
  catch { throw new HttpError(503, "The owner must finish setting up username-and-password sign-in."); }
  if (!profile || profile.version !== 1 || !/^[a-z][a-z0-9._-]{2,39}$/.test(profile.username || "") || !/^[a-f0-9]{64}$/.test(profile.salt || "") || !/^[a-f0-9]{64}$/.test(profile.verifier || "")) throw new HttpError(503, "The owner login configuration is invalid.");
  return profile;
}

async function login(request, env, now) {
  const db = env.DB;
  const ip = await hash(request.headers.get("CF-Connecting-IP") || "local");
  await rateLimit(db, `password-auth:${ip}`, 20, 900, now);
  await rateLimit(db, "password-auth-total", 100, 3600, now);
  const body = await bodyJSON(request);
  const profile = loginProfile(env);
  if (typeof body.username !== "string" || typeof body.proof !== "string" || !/^[a-f0-9]{64}$/.test(body.proof)) throw new HttpError(401, "The username or password is incorrect.");
  const matches = sameVerifier(await proofVerifier(body.proof), profile.verifier);
  if (!matches || body.username.trim().toLowerCase() !== profile.username) throw new HttpError(401, "The username or password is incorrect.");
  const secret = token();
  await db.prepare("INSERT INTO sessions(token,expires) VALUES(?,?)").bind(await hash(secret), now.getTime() + 8 * 3600000).run();
  return json({ user: surgeon }, 200, { "Set-Cookie": `${cookieName}=${secret}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` });
}

export function createWorker({ now = () => new Date(), mailerFactory = hostedMailer, aiFactory = hostedAI } = {}) {
  return {
    async fetch(request, env) {
      try {
        const url = new URL(request.url);
        configured(env, url);
        if (request.method === "GET" && assets.has(url.pathname)) {
          const response = await env.ASSETS.fetch(request);
          return new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), ...headers } });
        }
        if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found.");
        if (!["GET", "POST"].includes(request.method)) throw new HttpError(405, "This method is not supported.");
        if (request.method === "POST" && (request.headers.get("origin") !== env.APP_ORIGIN || request.headers.get("X-Aftercare") !== "1")) throw new HttpError(403, "This request did not come from Aftercare. Refresh and try again.");
        const date = now(), db = env.DB, path = url.pathname;
        const user = await authenticated(request, db, date);
        if (request.method === "GET" && path === "/api/bootstrap") return json({ setupRequired: false, user, deployment: "cloud", loginMethod: "password", passwordSalt: loginProfile(env).salt });
        if (request.method === "POST" && path === "/api/login") return await login(request, env, date);
        if (!user) throw new HttpError(401, "Sign in to your private online workspace.");
        const { today, time } = clinicClock(date);
        const settings = async () => {
          const row = await db.prepare("SELECT * FROM settings WHERE id=1").first();
          return { enabled: Boolean(row.enabled), time: row.time, recipient: env.GMAIL_ADDRESS };
        };
        if (request.method === "GET") {
          if (path === "/api/state") return json({ ...await getState(db), today, time, user, mailMode: "smtp", deployment: "cloud" });
          if (path === "/api/ai/status") return json(await aiFactory(env).status());
          if (path === "/api/settings") return json({ settings: await settings(), mailMode: "smtp", timezone: "America/New_York", reminders: (await db.prepare("SELECT * FROM reminders ORDER BY created_at DESC LIMIT 30").all()).results });
          throw new HttpError(404, "This endpoint was not found.");
        }
        await rateLimit(db, "owner-writes", 120, 60, date);
        const body = await bodyJSON(request);
        if (path === "/api/logout") {
          const value = (request.headers.get("cookie") || "").split(";").map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`)).slice(cookieName.length + 1);
          await db.prepare("DELETE FROM sessions WHERE token=?").bind(await hash(value)).run();
          return json({ signedOut: true }, 200, { "Set-Cookie": `${cookieName}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
        }
        if (path === "/api/actions") {
          const state = await getState(db);
          if (!Number.isInteger(body.revision) || body.revision !== state.revision) throw new HttpError(409, "Refresh and review the latest records before saving.");
          let patients;
          if (body.action === "load-demo") {
            if (state.patients.length || body.fictionalOnly !== true) throw new HttpError(400, "Examples can only be loaded into an empty workspace after confirmation.");
            patients = makeSeed(today);
          } else patients = mutatePatients(state.patients, user, body, date);
          return json({ ...await saveState(db, state.revision, patients, closedCases(patients, state.closedSince, today)), today });
        }
        if (path === "/api/assistant") {
          await rateLimit(db, "owner-ai-hour", 20, 3600, date);
          await rateLimit(db, "owner-ai-day", 50, 86400, date);
          return json(await aiFactory(env).ask(body.prompt, await getState(db), today));
        }
        if (path === "/api/settings") {
          if (typeof body.enabled !== "boolean" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(body.time) || body.recipient !== env.GMAIL_ADDRESS) throw new HttpError(400, "Use a valid time. Hosted reminders can only go to the configured owner.");
          await db.prepare("UPDATE settings SET enabled=?,time=? WHERE id=1").bind(Number(body.enabled), body.time).run();
          return json({ settings: await settings() });
        }
        if (path === "/api/reminders/test") {
          await rateLimit(db, "owner-test-email", 3, 3600, date);
          const reminder = await sendReminder(env, mailerFactory(env), date, true);
          return json({ reminder, ...(reminder.status !== "accepted" ? { error: reminder.error || "Email delivery was not confirmed." } : {}) }, reminder.status === "accepted" ? 200 : 502);
        }
        throw new HttpError(404, "This endpoint was not found.");
      } catch (error) {
        if (!(error instanceof HttpError)) console.error("Aftercare hosted request failed; no request contents logged.");
        return json({ error: error instanceof HttpError ? error.message : "The server could not confirm this request. Refresh before retrying any change." }, error instanceof HttpError ? error.status : 500);
      }
    },
    async scheduled(_event, env) {
      try {
        const date = now();
        if (!env.APP_ORIGIN?.startsWith("https://")) throw new Error("Hosted origin missing");
        await expireCases(env.DB, clinicClock(date).today);
        await env.DB.batch([
          env.DB.prepare("DELETE FROM sessions WHERE expires<=?").bind(date.getTime()),
          env.DB.prepare("DELETE FROM login_challenge WHERE expires<=?").bind(date.getTime()),
          env.DB.prepare("DELETE FROM limits WHERE expires<=?").bind(date.getTime()),
          env.DB.prepare("DELETE FROM reminders WHERE created_at<?").bind(new Date(date.getTime() - 30 * 86400000).toISOString()),
          env.DB.prepare("UPDATE reminders SET status='uncertain',error=? WHERE status='sending' AND created_at<?")
            .bind("A prior run ended without a delivery confirmation. Check Gmail; it will not be retried automatically.", new Date(date.getTime() - 600000).toISOString())
        ]);
        await sendReminder(env, mailerFactory(env), date);
      } catch {
        console.error("Aftercare scheduled job failed. Inspect the deployment and reminder log; no patient data was logged.");
        throw new Error("Aftercare scheduled job failed.");
      }
    }
  };
}

export default createWorker();
