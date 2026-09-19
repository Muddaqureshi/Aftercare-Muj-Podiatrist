import nodemailer from "nodemailer";

export function makeMailer(env = process.env, getSocket) {
  if (!env.SMTP_HOST) return { mode: "local-inbox", async send() {} };
  if (!env.SMTP_FROM || !env.SMTP_USER || !env.SMTP_PASS) throw new Error("SMTP is partially configured. Set SMTP_FROM, SMTP_USER, and SMTP_PASS, or remove SMTP_HOST to use the local inbox.");
  const port = Number(env.SMTP_PORT || 587);
  if (![465, 587].includes(port)) throw new Error("Use SMTP port 465 (TLS) or 587 (STARTTLS).");
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST, port, secure: port === 465, requireTLS: true,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    disableFileAccess: true, disableUrlAccess: true,
    ...(getSocket ? { getSocket } : {})
  });
  return {
    mode: "smtp",
    async send(message) {
      const result = await transport.sendMail({ from: env.SMTP_FROM, to: message.recipient, subject: message.subject, text: message.body, messageId: `<${message.id}@aftercare.local>` });
      if (!result.accepted?.length) throw new Error("The email server did not accept the recipient.");
    }
  };
}
