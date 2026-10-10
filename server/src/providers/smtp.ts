import nodemailer from 'nodemailer';
import type { Provider, ProviderContext } from './types.ts';
import { ProviderError } from './types.ts';

/** Outgoing email (invoices, supplier POs, customer replies) through the business's own SMTP mailbox. */

function transport(ctx: ProviderContext) {
  const c = ctx.creds;
  if (!c.HOST || !c.USER || !c.PASS) throw new ProviderError('Email is not connected. Add SMTP details in Settings → Integrations.');
  const port = Number(c.PORT || 587);
  return nodemailer.createTransport({ host: c.HOST, port, secure: port === 465, auth: { user: c.USER, pass: c.PASS } });
}

export interface MailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; content: string | Buffer; contentType?: string }[];
}

export async function sendMail(ctx: ProviderContext, m: MailInput) {
  if (!m.to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m.to)) throw new ProviderError(`"${m.to}" is not a valid email address.`);
  const info = await transport(ctx).sendMail({
    from: ctx.creds.FROM || ctx.creds.USER,
    to: m.to,
    subject: m.subject,
    text: m.text,
    html: m.html,
    attachments: m.attachments,
  });
  return { messageId: info.messageId, sentTo: m.to };
}

export const smtp: Provider = {
  id: 'smtp',
  label: 'Email (SMTP)',
  category: 'Communication',
  description: 'Send invoices, purchase orders and customer replies from your own mailbox (Gmail, Outlook, Zoho…).',
  docs: 'https://support.google.com/mail/answer/185833',
  fields: [
    { key: 'HOST', label: 'SMTP host', env: 'SMTP_HOST', secret: false, placeholder: 'smtp.gmail.com' },
    { key: 'PORT', label: 'Port', env: 'SMTP_PORT', secret: false, placeholder: '587', help: 'Optional. 587 (STARTTLS) or 465 (SSL).' },
    { key: 'USER', label: 'Username', env: 'SMTP_USER', secret: false },
    { key: 'PASS', label: 'Password / app password', env: 'SMTP_PASS', secret: true },
    { key: 'FROM', label: 'From address', env: 'SMTP_FROM', secret: false, placeholder: 'Shop Name <hello@shop.my>', help: 'Optional. Defaults to the username.' },
  ],
  async test(ctx) {
    try {
      await transport(ctx).verify();
      return { ok: true, message: `SMTP login OK for ${ctx.creds.USER}.` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },
};
