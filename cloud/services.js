import { makeMailer } from "../pilot/mailer.js";
import { makeInterpreter } from "../pilot/ai.js";
import { HttpError, clinicClock } from "../backend-shared.js";
import { attentionTasks, weeklyTasks, isOpen } from "../domain.js";
import { getState } from "./core.js";
import { connect } from "node:tls";

export function hostedMailer(env) {
  if (!env.GMAIL_ADDRESS || !env.GMAIL_APP_PASSWORD) throw new HttpError(503, "Gmail delivery is not configured. The account owner must finish deployment.");
  // Let the Workers socket runtime resolve Gmail instead of Nodemailer's Node DNS path.
  return makeMailer({ SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "465", SMTP_USER: env.GMAIL_ADDRESS, SMTP_FROM: env.GMAIL_ADDRESS, SMTP_PASS: env.GMAIL_APP_PASSWORD }, (_options, callback) => {
    const socket = connect({ host: "smtp.gmail.com", port: 465, servername: "smtp.gmail.com", rejectUnauthorized: true });
    const fail = error => callback(error);
    socket.once("error", fail);
    const timeout = () => socket.destroy(new Error("Gmail TLS connection timed out."));
    socket.setTimeout(10000, timeout);
    socket.once("secureConnect", () => {
      socket.removeListener("error", fail);
      socket.removeListener("timeout", timeout);
      socket.setTimeout(0);
      callback(null, { connection: socket, secured: true });
    });
  });
}

export function hostedAI(env) {
  const model = env.AI_MODEL;
  return {
    async status() {
      return { ready: Boolean(env.AI && model), model, message: "Hosted AI is configured. Free daily limits apply; a failed request is shown explicitly. No records are sent automatically." };
    },
    ...makeInterpreter({
      model,
      async interpret(schema, messages) {
        if (!env.AI || !model) throw new HttpError(503, "Hosted AI has not been configured.");
        let result;
        try {
          result = await env.AI.run(model, { messages, temperature: 0, max_tokens: 1200, response_format: { type: "json_schema", json_schema: schema } });
        } catch (error) {
          console.error("Hosted AI request failed; provider code:", String(error.message || "").match(/^\d{3,6}/)?.[0] || "unavailable");
          throw new HttpError(503, "Hosted AI is unavailable or its free allowance has been reached. Nothing was changed; use the manual plan form or try later.");
        }
        try {
          const parsed = typeof result.response === "string" ? JSON.parse(result.response) : result.response;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid response");
          return parsed;
        } catch {
          throw new HttpError(502, "The AI returned an unreadable interpretation. Nothing was changed.");
        }
      }
    })
  };
}

export async function sendReminder(env, mailer, now, test = false) {
  const db = env.DB, { today, time } = clinicClock(now);
  const settings = await db.prepare("SELECT * FROM settings WHERE id=1").first();
  if (!test && (!settings.enabled || time < settings.time)) return null;
  const key = test ? `test:${crypto.randomUUID()}` : `daily:${today}`;
  const state = await getState(db);
  const attention = attentionTasks(state.patients, today).length;
  const due = weeklyTasks(state.patients, today).filter(({ milestone }) => isOpen(milestone) && milestone.date >= today).length;
  const message = {
    id: crypto.randomUUID(), recipient: env.GMAIL_ADDRESS,
    subject: test ? "Aftercare: hosted reminder test" : "Aftercare: review your follow-up list",
    body: `Fictional-data Aftercare public demo.\n\n${attention} milestone(s) need an attendance or outcome update.\n${due} open milestone(s) are due from today through Sunday.\n\nOpen the demo: ${env.APP_ORIGIN}\n\nAnyone with the link can view and edit the fictional cases. Attendance must be recorded manually. No patient information is included and no patient has been contacted.`
  };
  const skip = !test && attention === 0 && due === 0;
  const inserted = await db.prepare("INSERT OR IGNORE INTO reminders(id,run_key,status,recipient,subject,body,created_at) VALUES(?,?,?,?,?,?,?) RETURNING id")
    .bind(message.id, key, skip ? "skipped" : "sending", message.recipient, message.subject, message.body, now.toISOString()).first();
  if (!inserted) return db.prepare("SELECT * FROM reminders WHERE run_key=?").bind(key).first();
  if (!skip) {
    try {
      await mailer.send(message);
      await db.prepare("UPDATE reminders SET status='accepted',finished_at=? WHERE id=?").bind(new Date().toISOString(), message.id).run();
    } catch {
      await db.prepare("UPDATE reminders SET status='uncertain',error=?,finished_at=? WHERE id=?")
        .bind("Email delivery was not confirmed. Check Gmail before requesting another test; no automatic retry will occur.", new Date().toISOString(), message.id).run();
    }
  }
  return db.prepare("SELECT * FROM reminders WHERE id=?").bind(message.id).first();
}
