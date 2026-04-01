/**
 * Email sending via Gmail SMTP (App Password).
 * Used for onboarding links and transactional notifications.
 */

import nodemailer from 'nodemailer';

const transporter = process.env.SMTP_USER
  ? nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    })
  : null;

const FROM = process.env.SMTP_FROM
  ? `Otto by HNTIC <${process.env.SMTP_FROM}>`
  : 'Otto by HNTIC <otto@hntic.fr>';

/**
 * Send the onboarding email with the WhatsApp connection link.
 */
export async function sendOnboardingEmail(
  to: string,
  onboardUrl: string,
  name?: string | null,
): Promise<void> {
  if (!transporter) {
    console.warn('SMTP not configured — onboarding email not sent');
    console.log(`[EMAIL] Would send onboarding link to ${to}: ${onboardUrl}`);
    return;
  }

  const greeting = name ? `Bonjour ${name.split(' ')[0]},` : 'Bonjour,';

  await transporter.sendMail({
    from: FROM,
    to,
    subject: 'Connecte ton WhatsApp à Otto',
    html: `
      <div style="font-family:'Inter',system-ui,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px">
        <div style="text-align:center;margin-bottom:32px">
          <h1 style="font-size:1.5rem;font-weight:300;letter-spacing:0.3em;text-transform:uppercase;margin-bottom:4px">Otto</h1>
          <p style="color:#999;font-style:italic;font-size:0.9rem">by HNTIC</p>
        </div>
        <p style="color:#333;font-size:1rem;line-height:1.6;margin-bottom:24px">
          ${greeting} Ton compte Otto est pr&ecirc;t. Connecte ton WhatsApp pour activer ton assistant IA.
        </p>
        <div style="text-align:center;margin-bottom:32px">
          <a href="${onboardUrl}" style="display:inline-block;padding:14px 32px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:8px;font-size:1rem;font-weight:500">
            Connecter WhatsApp
          </a>
        </div>
        <p style="color:#999;font-size:0.85rem;line-height:1.5">
          Ce lien est valable 24 heures. Si tu as besoin d'un nouveau lien plus tard,
          rends-toi sur <a href="https://otto.hntic.fr/reconnect" style="color:#666">otto.hntic.fr/reconnect</a>.
        </p>
        <hr style="border:none;border-top:1px solid #eee;margin:32px 0">
        <p style="color:#bbb;font-size:0.75rem;text-align:center">
          <a href="https://hntic.fr" style="color:#999;text-decoration:none">HNTIC</a>
        </p>
      </div>
    `,
  });

  console.log(`[EMAIL] Onboarding email sent to ${to}`);
}

/**
 * Send a reconnection email with a fresh link.
 */
export async function sendReconnectionEmail(
  to: string,
  onboardUrl: string,
): Promise<void> {
  if (!transporter) {
    console.warn('SMTP not configured — reconnection email not sent');
    console.log(`[EMAIL] Would send reconnection link to ${to}: ${onboardUrl}`);
    return;
  }

  await transporter.sendMail({
    from: FROM,
    to,
    subject: 'Reconnecte ton WhatsApp à Otto',
    html: `
      <div style="font-family:'Inter',system-ui,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px">
        <div style="text-align:center;margin-bottom:32px">
          <h1 style="font-size:1.5rem;font-weight:300;letter-spacing:0.3em;text-transform:uppercase;margin-bottom:4px">Otto</h1>
          <p style="color:#999;font-style:italic;font-size:0.9rem">by HNTIC</p>
        </div>
        <p style="color:#333;font-size:1rem;line-height:1.6;margin-bottom:24px">
          Clique sur le bouton ci-dessous pour reconnecter ton WhatsApp &agrave; Otto.
        </p>
        <div style="text-align:center;margin-bottom:32px">
          <a href="${onboardUrl}" style="display:inline-block;padding:14px 32px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:8px;font-size:1rem;font-weight:500">
            Reconnecter WhatsApp
          </a>
        </div>
        <p style="color:#999;font-size:0.85rem;line-height:1.5">
          Ce lien est valable 24 heures.
        </p>
        <hr style="border:none;border-top:1px solid #eee;margin:32px 0">
        <p style="color:#bbb;font-size:0.75rem;text-align:center">
          <a href="https://hntic.fr" style="color:#999;text-decoration:none">HNTIC</a>
        </p>
      </div>
    `,
  });

  console.log(`[EMAIL] Reconnection email sent to ${to}`);
}

/**
 * Send the welcome email after successful WhatsApp connection.
 */
export async function sendWelcomeEmail(to: string, name?: string | null): Promise<void> {
  if (!transporter) {
    console.warn('SMTP not configured — welcome email not sent');
    return;
  }

  const greeting = name ? `${name.split(' ')[0]}, ton` : 'Ton';

  await transporter.sendMail({
    from: FROM,
    to,
    subject: 'Otto est actif — ton assistant IA est prêt',
    html: `
      <div style="font-family:'Inter',system-ui,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px">
        <div style="text-align:center;margin-bottom:32px">
          <h1 style="font-size:1.5rem;font-weight:300;letter-spacing:0.3em;text-transform:uppercase;margin-bottom:4px">Otto</h1>
          <p style="color:#999;font-style:italic;font-size:0.9rem">by HNTIC</p>
        </div>

        <p style="color:#333;font-size:1rem;line-height:1.6;margin-bottom:24px">
          ${greeting} assistant IA est connect&eacute; et pr&ecirc;t &agrave; t'aider. Envoie-lui un message sur WhatsApp pour commencer.
        </p>

        <div style="background:#f9f9f9;border-radius:12px;padding:24px;margin-bottom:24px">
          <p style="color:#333;font-weight:500;margin-bottom:16px">Ce qu'Otto peut faire pour toi :</p>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:6px 0;color:#555;font-size:0.9rem">&#128196; Cr&eacute;er des documents (Word, PowerPoint, Excel, PDF)</td></tr>
            <tr><td style="padding:6px 0;color:#555;font-size:0.9rem">&#128197; G&eacute;rer ton agenda et tes rappels</td></tr>
            <tr><td style="padding:6px 0;color:#555;font-size:0.9rem">&#128188; Suivre tes deals, contacts et pipeline</td></tr>
            <tr><td style="padding:6px 0;color:#555;font-size:0.9rem">&#128176; Analyser tes finances et factures</td></tr>
            <tr><td style="padding:6px 0;color:#555;font-size:0.9rem">&#128269; Rechercher des infos sur le web</td></tr>
            <tr><td style="padding:6px 0;color:#555;font-size:0.9rem">&#127908; Comprendre tes messages vocaux</td></tr>
          </table>
        </div>

        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:20px;margin-bottom:24px;text-align:center">
          <p style="color:#166534;font-size:0.95rem;margin:0">
            Envoie <strong>"Bonjour"</strong> sur WhatsApp pour d&eacute;marrer.
          </p>
        </div>

        <p style="color:#999;font-size:0.85rem;line-height:1.5;margin-bottom:8px">
          <strong>Bon &agrave; savoir :</strong>
        </p>
        <ul style="color:#999;font-size:0.85rem;line-height:1.8;padding-left:20px;margin-bottom:24px">
          <li>Otto apprend de tes conversations et s'am&eacute;liore avec le temps</li>
          <li>Tes donn&eacute;es sont priv&eacute;es et s&eacute;curis&eacute;es</li>
          <li>Tu peux lui envoyer des documents, des vocaux ou du texte</li>
          <li>En cas de probl&egrave;me de connexion : <a href="https://otto.hntic.fr/reconnect" style="color:#666">otto.hntic.fr/reconnect</a></li>
        </ul>

        <hr style="border:none;border-top:1px solid #eee;margin:32px 0">
        <p style="color:#bbb;font-size:0.75rem;text-align:center">
          <a href="https://hntic.fr" style="color:#999;text-decoration:none">HNTIC</a>
        </p>
      </div>
    `,
  });

  console.log(`[EMAIL] Welcome email sent to ${to}`);
}

/**
 * Send a portal access link via email.
 */
export async function sendPortalLinkEmail(
  to: string,
  portalUrl: string,
): Promise<void> {
  if (!transporter) {
    console.warn('SMTP not configured — portal link email not sent');
    console.log(`[EMAIL] Would send portal link to ${to}: ${portalUrl}`);
    return;
  }

  await transporter.sendMail({
    from: FROM,
    to,
    subject: 'Ton espace client Otto',
    html: `
      <div style="font-family:'Inter',system-ui,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px">
        <div style="text-align:center;margin-bottom:32px">
          <h1 style="font-size:1.5rem;font-weight:300;letter-spacing:0.3em;text-transform:uppercase;margin-bottom:4px">Otto</h1>
          <p style="color:#999;font-style:italic;font-size:0.9rem">by HNTIC</p>
        </div>
        <p style="color:#333;font-size:1rem;line-height:1.6;margin-bottom:24px">
          Clique sur le bouton ci-dessous pour acc&eacute;der &agrave; ton espace client.
        </p>
        <div style="text-align:center;margin-bottom:32px">
          <a href="${portalUrl}" style="display:inline-block;padding:14px 32px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:8px;font-size:1rem;font-weight:500">
            Mon espace Otto
          </a>
        </div>
        <p style="color:#999;font-size:0.85rem;line-height:1.5">
          Ce lien est valable 24 heures.
        </p>
        <hr style="border:none;border-top:1px solid #eee;margin:32px 0">
        <p style="color:#bbb;font-size:0.75rem;text-align:center">
          <a href="https://hntic.fr" style="color:#999;text-decoration:none">HNTIC</a>
        </p>
      </div>
    `,
  });

  console.log(`[EMAIL] Portal link email sent to ${to}`);
}
