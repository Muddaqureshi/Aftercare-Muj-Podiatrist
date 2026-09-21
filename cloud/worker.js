import { HttpError, clinicClock, mutatePatients } from "../backend-shared.js";
import { makeSeed } from "../domain.js";
import { hash, rateLimit, getState, closedCases, saveState, expireCases, demoVisitor } from "./core.js";
import { hostedAI, hostedMailer, sendReminder } from "./services.js";

const assets = new Set(["/", "/index.html", "/domain.js", "/csv.js", "/styles.css", "/tokens.css", "/favicon.svg", "/pilot/client.js", "/pilot/pilot.css"]);
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
        const user = demoVisitor;
        if (request.method === "GET" && path === "/api/bootstrap") return json({ setupRequired: false, user, deployment: "cloud", accessMode: "public" }, 200, {
          "Set-Cookie": "__Host-aftercare=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
        });
        const { today, time } = clinicClock(date);
        const settings = async () => {
          const row = await db.prepare("SELECT * FROM settings WHERE id=1").first();
          return { enabled: Boolean(row.enabled), time: row.time };
        };
        if (request.method === "GET") {
          if (path === "/api/state") return json({ ...await getState(db), today, time, user, mailMode: "scheduled", deployment: "cloud", accessMode: "public" });
          if (path === "/api/ai/status") return json(await aiFactory(env).status());
          if (path === "/api/settings") return json({ settings: await settings(), mailMode: "scheduled", timezone: "America/New_York" });
          throw new HttpError(404, "This endpoint was not found.");
        }
        if (!["/api/actions", "/api/assistant"].includes(path)) throw new HttpError(404, "This action is not available in the public demo.");
        const ip = await hash(request.headers.get("CF-Connecting-IP") || "local");
        await rateLimit(db, `public-writes:${ip}`, 30, 60, date);
        await rateLimit(db, "public-writes-total", 120, 60, date);
        await rateLimit(db, "public-writes-day", 500, 86400, date);
        const body = await bodyJSON(request);
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
          await rateLimit(db, `public-ai:${ip}`, 10, 3600, date);
          await rateLimit(db, "owner-ai-hour", 20, 3600, date);
          await rateLimit(db, "owner-ai-day", 50, 86400, date);
          return json(await aiFactory(env).ask(body.prompt, await getState(db), today));
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
