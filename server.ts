import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Request, Response } from 'express';
import nodemailer from 'nodemailer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;

interface AppointmentPayload {
  name?: unknown;
  phone?: unknown;
  email?: unknown;
  date?: unknown;
  time?: unknown;
  treatment?: unknown;
  message?: unknown;
  source?: unknown;
}

interface ValidatedAppointment {
  name: string;
  phone: string;
  email: string;
  date: string;
  time: string;
  treatment: string;
  message: string;
  source: 'booking_modal' | 'contact_section';
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function validateAppointment(body: AppointmentPayload): {
  valid: boolean;
  data?: ValidatedAppointment;
  fieldErrors?: Record<string, string>;
  error?: string;
} {
  const fieldErrors: Record<string, string> = {};

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const date = typeof body.date === 'string' ? body.date.trim() : '';
  const time = typeof body.time === 'string' ? body.time.trim() : '';
  const treatment = typeof body.treatment === 'string' ? body.treatment.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const source =
    body.source === 'contact_section' ? 'contact_section' : 'booking_modal';

  if (name.length < 2) {
    fieldErrors.name = 'Please enter your full name (at least 2 characters).';
  } else if (name.length > 120) {
    fieldErrors.name = 'Name must be 120 characters or fewer.';
  }

  const digitsOnly = phone.replace(/\D/g, '');
  if (!phone) {
    fieldErrors.phone = 'Please enter a valid phone number.';
  } else if (digitsOnly.length < 7 || digitsOnly.length > 15) {
    fieldErrors.phone = 'Phone number must contain between 7 and 15 digits.';
  }

  if (email && !EMAIL_REGEX.test(email)) {
    fieldErrors.email = 'Please enter a valid email address.';
  }

  if (date) {
    if (!DATE_REGEX.test(date)) {
      fieldErrors.date = 'Preferred date must be in YYYY-MM-DD format.';
    } else {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const selected = new Date(`${date}T00:00:00`);
      if (Number.isNaN(selected.getTime())) {
        fieldErrors.date = 'Please choose a valid appointment date.';
      } else if (selected < today) {
        fieldErrors.date = 'Preferred appointment date cannot be in the past.';
      }
    }
  }

  if (!treatment) {
    fieldErrors.treatment = 'Please select a treatment or consultation type.';
  }

  if (message.length > 2000) {
    fieldErrors.message = 'Notes must be 2000 characters or fewer.';
  }

  if (Object.keys(fieldErrors).length > 0) {
    const firstError = Object.values(fieldErrors)[0];
    return {
      valid: false,
      fieldErrors,
      error: firstError,
    };
  }

  return {
    valid: true,
    data: {
      name,
      phone,
      email,
      date,
      time,
      treatment,
      message,
      source,
    },
  };
}

function getEmailProviderConfig() {
  const resendApiKey = process.env.RESEND_API_KEY?.trim() || '';
  const gmailUser = process.env.GMAIL_USER?.trim() || '';
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD?.trim() || '';
  const smtpHost = process.env.SMTP_HOST?.trim() || (gmailUser ? 'smtp.gmail.com' : '');
  const smtpPort = Number(process.env.SMTP_PORT) || 465;
  const smtpUser = process.env.SMTP_USER?.trim() || gmailUser;
  const smtpPass = process.env.SMTP_PASS?.trim() || gmailAppPassword;
  const clinicOwnerEmail =
    process.env.CLINIC_OWNER_EMAIL?.trim() ||
    (smtpUser && EMAIL_REGEX.test(smtpUser) ? smtpUser : '');

  if (resendApiKey) {
    return {
      configured: Boolean(clinicOwnerEmail && EMAIL_REGEX.test(clinicOwnerEmail)),
      provider: 'resend' as const,
      clinicOwnerEmail,
      resendApiKey,
      fromEmail:
        process.env.RESEND_FROM_EMAIL?.trim() ||
        'Dental Health Clinic <onboarding@resend.dev>',
    };
  }

  if (smtpHost && smtpUser && smtpPass) {
    return {
      configured: Boolean(clinicOwnerEmail && EMAIL_REGEX.test(clinicOwnerEmail)),
      provider: 'smtp' as const,
      clinicOwnerEmail,
      smtpHost,
      smtpPort,
      smtpUser,
      smtpPass,
      fromEmail:
        process.env.SMTP_FROM?.trim() ||
        `Dental Health Clinic <${smtpUser}>`,
    };
  }

  return {
    configured: false,
    provider: null,
    clinicOwnerEmail,
  };
}

function buildEmailContent(appt: ValidatedAppointment) {
  const submittedAt = new Date().toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const sourceLabel =
    appt.source === 'contact_section'
      ? 'Contact Desk Form'
      : 'Request Appointment Modal';

  const subject = `New Appointment Request: ${appt.treatment} — ${appt.name}`;

  const textLines = [
    'New Appointment Request — Dental Health Practice',
    '================================================',
    `Patient Name: ${appt.name}`,
    `Phone Number: ${appt.phone}`,
    appt.email ? `Patient Email: ${appt.email}` : null,
    `Treatment / Service: ${appt.treatment}`,
    appt.date ? `Preferred Date: ${appt.date}` : null,
    appt.time ? `Preferred Time: ${appt.time}` : null,
    appt.message ? `Patient Notes: ${appt.message}` : null,
    `Submitted Via: ${sourceLabel}`,
    `Submitted At: ${submittedAt}`,
  ].filter(Boolean);

  const text = textLines.join('\n');

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background-color: #f8f8f6; color: #111111;">
      <div style="background-color: #ffffff; border-radius: 16px; padding: 28px; border: 1px solid #e5e5e5;">
        <p style="margin: 0 0 6px; font-size: 11px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #737373;">
          Dental Health • West New York
        </p>
        <h1 style="margin: 0 0 20px; font-size: 22px; font-weight: 800; color: #000000;">
          New Appointment Request
        </h1>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; color: #525252; width: 160px; font-weight: 600;">Patient Name</td>
            <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; color: #000000; font-weight: 700;">${escapeHtml(appt.name)}</td>
          </tr>
          <tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; color: #525252; font-weight: 600;">Phone Number</td>
            <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; color: #000000; font-weight: 700;">${escapeHtml(appt.phone)}</td>
          </tr>
          ${
            appt.email
              ? `<tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; color: #525252; font-weight: 600;">Email Address</td>
            <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; color: #000000;">${escapeHtml(appt.email)}</td>
          </tr>`
              : ''
          }
          <tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; color: #525252; font-weight: 600;">Treatment / Service</td>
            <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; color: #000000; font-weight: 700;">${escapeHtml(appt.treatment)}</td>
          </tr>
          ${
            appt.date
              ? `<tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; color: #525252; font-weight: 600;">Preferred Date</td>
            <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; color: #000000;">${escapeHtml(appt.date)}</td>
          </tr>`
              : ''
          }
          ${
            appt.time
              ? `<tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; color: #525252; font-weight: 600;">Preferred Time</td>
            <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; color: #000000;">${escapeHtml(appt.time)}</td>
          </tr>`
              : ''
          }
          ${
            appt.message
              ? `<tr>
            <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; color: #525252; font-weight: 600; vertical-align: top;">Patient Notes</td>
            <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; color: #000000; white-space: pre-wrap;">${escapeHtml(appt.message)}</td>
          </tr>`
              : ''
          }
        </table>
        <p style="margin: 20px 0 0; font-size: 12px; color: #737373;">
          Submitted via ${escapeHtml(sourceLabel)} on ${escapeHtml(submittedAt)}
        </p>
      </div>
    </div>
  `;

  return { subject, text, html };
}

async function sendAppointmentEmail(appt: ValidatedAppointment) {
  const config = getEmailProviderConfig();

  if (!config.configured || !config.clinicOwnerEmail) {
    const missingParts: string[] = [];
    if (!config.clinicOwnerEmail || !EMAIL_REGEX.test(config.clinicOwnerEmail)) {
      missingParts.push('CLINIC_OWNER_EMAIL');
    }
    if (!config.provider) {
      missingParts.push('RESEND_API_KEY or SMTP/Gmail credentials (GMAIL_USER + GMAIL_APP_PASSWORD or SMTP_HOST/SMTP_USER/SMTP_PASS)');
    }
    const err = new Error(
      `Email delivery is not configured on the server. Missing: ${missingParts.join(' and ')}.`
    ) as Error & { statusCode?: number; code?: string };
    err.statusCode = 503;
    err.code = 'EMAIL_NOT_CONFIGURED';
    throw err;
  }

  const { subject, text, html } = buildEmailContent(appt);

  if (config.provider === 'resend') {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.fromEmail,
        to: [config.clinicOwnerEmail],
        reply_to: appt.email || undefined,
        subject,
        text,
        html,
      }),
    });

    const data = (await response.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
      name?: string;
    };

    if (!response.ok) {
      const err = new Error(
        data.message || `Email provider rejected the request (${response.status}).`
      ) as Error & { statusCode?: number; code?: string };
      err.statusCode = 502;
      err.code = 'EMAIL_PROVIDER_ERROR';
      throw err;
    }

    return {
      provider: 'resend',
      messageId: data.id || null,
      recipient: config.clinicOwnerEmail,
    };
  }

  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
  });

  const info = await transporter.sendMail({
    from: config.fromEmail,
    to: config.clinicOwnerEmail,
    replyTo: appt.email || undefined,
    subject,
    text,
    html,
  });

  return {
    provider: 'smtp',
    messageId: info.messageId || null,
    recipient: config.clinicOwnerEmail,
  };
}

async function createAppServer() {
  const app = express();
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    const config = getEmailProviderConfig();
    res.json({
      ok: true,
      emailConfigured: config.configured,
      provider: config.provider,
    });
  });

  app.post('/api/appointments', async (req: Request, res: Response) => {
    const validation = validateAppointment((req.body || {}) as AppointmentPayload);
    if (!validation.valid || !validation.data) {
      res.status(400).json({
        ok: false,
        code: 'VALIDATION_ERROR',
        error: validation.error || 'Please check the appointment form fields.',
        fieldErrors: validation.fieldErrors || {},
      });
      return;
    }

    try {
      const result = await sendAppointmentEmail(validation.data);
      res.status(200).json({
        ok: true,
        message: 'Appointment request sent successfully.',
        messageId: result.messageId,
        provider: result.provider,
      });
    } catch (error) {
      const typedErr = error as Error & { statusCode?: number; code?: string };
      const statusCode = typedErr.statusCode || 500;
      const code = typedErr.code || 'EMAIL_SEND_FAILED';
      console.error('[appointments] Email send failed:', typedErr.message);
      res.status(statusCode).json({
        ok: false,
        code,
        error:
          typedErr.message ||
          'Unable to send appointment email right now. Please call the clinic directly.',
      });
    }
  });

  const DEFAULT_PUBLIC_ORIGIN =
    'https://ais-pre-5zh2r6ymmz4vlqtdzlqur4-499997219733.asia-southeast1.run.app';

  const resolvePublicOrigin = (req: Request): string => {
    const forwardedHost = (req.get('x-forwarded-host') || req.get('host') || '').trim();
    if (
      forwardedHost &&
      !forwardedHost.startsWith('localhost') &&
      !forwardedHost.startsWith('127.0.0.1') &&
      !forwardedHost.startsWith('0.0.0.0')
    ) {
      return `https://${forwardedHost}`;
    }
    const envAppUrl = process.env.APP_URL?.trim().replace(/\/+$/, '');
    if (envAppUrl && envAppUrl !== 'MY_APP_URL' && /^https?:\/\//i.test(envAppUrl)) {
      return envAppUrl.replace(/^http:\/\//i, 'https://');
    }
    return DEFAULT_PUBLIC_ORIGIN;
  };

  const injectOpenGraphOrigin = (html: string, req: Request): string => {
    const origin = resolvePublicOrigin(req);
    return html.split(DEFAULT_PUBLIC_ORIGIN).join(origin);
  };

  const distDir = path.resolve(__dirname, 'dist');
  const isProd =
    process.env.NODE_ENV === 'production' ||
    (process.env.NODE_ENV !== 'development' &&
      fs.existsSync(path.join(distDir, 'index.html')) &&
      process.argv.includes('--prod'));

  if (isProd && fs.existsSync(path.join(distDir, 'index.html'))) {
    app.use(express.static(distDir, { index: false }));
    app.get('/{*splat}', (req: Request, res: Response) => {
      const rawHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf-8');
      res
        .status(200)
        .set({ 'Content-Type': 'text/html; charset=utf-8' })
        .send(injectOpenGraphOrigin(rawHtml, req));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });

    app.use(async (req: Request, res: Response, next) => {
      const reqPath = req.path;
      const isHtmlRequest =
        req.method === 'GET' &&
        !reqPath.startsWith('/api/') &&
        !reqPath.startsWith('/@') &&
        !reqPath.startsWith('/src/') &&
        !reqPath.startsWith('/node_modules/') &&
        !path.extname(reqPath) &&
        (req.headers.accept?.includes('text/html') ||
          req.headers['user-agent']?.toLowerCase().includes('whatsapp') ||
          req.headers['user-agent']?.toLowerCase().includes('facebook') ||
          req.headers['user-agent']?.toLowerCase().includes('twitter') ||
          reqPath === '/');

      if (!isHtmlRequest) {
        next();
        return;
      }

      try {
        const template = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf-8');
        const transformed = await vite.transformIndexHtml(req.originalUrl, template);
        res
          .status(200)
          .set({ 'Content-Type': 'text/html; charset=utf-8' })
          .send(injectOpenGraphOrigin(transformed, req));
      } catch (err) {
        vite.ssrFixStacktrace(err as Error);
        next(err);
      }
    });

    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

createAppServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
