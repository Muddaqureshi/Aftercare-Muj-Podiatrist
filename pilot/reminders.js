import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { attentionTasks, weeklyTasks, isOpen } from "../domain.js";
import { clinicClock, getState, HttpError } from "./store.js";

export function reminderSettings(db) {
  return JSON.parse(db.prepare("SELECT value FROM settings WHERE id=1").get().value);
}

export function saveReminderSettings(db, settings) {
  if (typeof settings.enabled !== "boolean" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(settings.time) || typeof settings.recipient !== "string" || settings.recipient.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(settings.recipient)) throw new HttpError(400, "Enter a valid reminder time and a single email address.");
  const value = { enabled: settings.enabled, time: settings.time, recipient: settings.recipient };
  db.prepare("UPDATE settings SET value=? WHERE id=1").run(JSON.stringify(value));
  return value;
}

export function makeMailer(env = process.env) {
  if (!env.SMTP_HOST) return { mode: "local-inbox", async send() {} };
  if (!env.SMTP_FROM || !env.SMTP_USER || !env.SMTP_PASS) throw new Error("SMTP is partially configured. Set SMTP_FROM, SMTP_USER, and SMTP_PASS, or remove SMTP_HOST to use the local inbox.");
  const port = Number(env.SMTP_PORT || 587);
  if (![465, 587].includes(port)) throw new Error("Use SMTP port 465 (TLS) or 587 (STARTTLS).");
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST, port, secure: port === 465, requireTLS: true,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    disableFileAccess: true, disableUrlAccess: true
  });
  return {
    mode: "smtp",
    async send(message) {
      const result = await transport.sendMail({ from: env.SMTP_FROM, to: message.recipient, subject: message.subject, text: message.body, messageId: `<${message.id}@aftercare.local>` });
      if (!result.accepted?.length) throw new Error("The email server did not accept the recipient.");
    }
  };
}

export function makeReminders(db, mailer, { now = () => new Date(), appURL = "http://127.0.0.1:4317" } = {}) {
  return {
    async send({ test = false } = {}) {
      const date = now(), { today, time } = clinicClock(date), settings = reminderSettings(db);
      if (!db.prepare("SELECT count(*) AS n FROM users").get().n) return null;
      if (!test && (!settings.enabled || time < settings.time)) return null;
      const key = test ? `test:${randomUUID()}` : `daily:${today}`;
      const existing = db.prepare("SELECT * FROM reminders WHERE run_key=?").get(key);
      if (existing) return existing;
      const state = getState(db);
      const overdue = attentionTasks(state.patients, today).length;
      const due = weeklyTasks(state.patients, today).filter(({ milestone }) => isOpen(milestone) && milestone.date >= today).length;
      const id = randomUUID();
      const message = {
        id, recipient: settings.recipient,
        subject: test ? "Aftercare pilot: test reminder" : "Aftercare: review your follow-up list",
        body: `Fictional-data Aftercare pilot.\n\n${overdue} milestone(s) need an attendance or outcome update.\n${due} open milestone(s) are due from today through Sunday.\n\nSign in to review: ${appURL}\n\nNo patient codes, treatment details, or surgery dates are included in this email. Attendance must be recorded by you or your staff. No patient has been contacted.\n${mailer.mode === "local-inbox" ? "\nLOCAL PREVIEW ONLY: this message was not emailed." : ""}`
      };
      const skip = !test && overdue === 0 && due === 0;
      db.prepare("INSERT INTO reminders(id,run_key,status,recipient,subject,body,created_at) VALUES(?,?,?,?,?,?,?)").run(id, key, skip ? "skipped" : "sending", message.recipient, message.subject, message.body, date.toISOString());
      if (!skip) {
        try {
          await mailer.send(message);
          db.prepare("UPDATE reminders SET status=?,finished_at=? WHERE id=?").run(mailer.mode === "local-inbox" ? "captured" : "accepted", now().toISOString(), id);
        } catch (error) {
          db.prepare("UPDATE reminders SET status='failed',error=?,finished_at=? WHERE id=?").run(`Delivery failed: ${error.message}`.slice(0, 500), now().toISOString(), id);
        }
      }
      return db.prepare("SELECT * FROM reminders WHERE id=?").get(id);
    }
  };
}
