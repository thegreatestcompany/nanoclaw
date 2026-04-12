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
          <h1 style="font-size:1.6rem;font-weight:800;letter-spacing:-0.03em;color:#128C7E;margin-bottom:4px">Otto</h1>
          <p style="color:#999;font-size:0.75rem;letter-spacing:0.1em;text-transform:uppercase">by HNTIC</p>
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
          <h1 style="font-size:1.6rem;font-weight:800;letter-spacing:-0.03em;color:#128C7E;margin-bottom:4px">Otto</h1>
          <p style="color:#999;font-size:0.75rem;letter-spacing:0.1em;text-transform:uppercase">by HNTIC</p>
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

  const s = (t: string) =>
    `<tr><td style="padding:6px 0;color:#555;font-size:0.9rem">${t}</td></tr>`;

  await transporter.sendMail({
    from: FROM,
    to,
    subject: 'Otto est actif — voici comment l\'utiliser 🚀',
    html: `
      <div style="font-family:'Inter',system-ui,sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;color:#333">
        <div style="text-align:center;margin-bottom:32px">
          <h1 style="font-size:1.6rem;font-weight:800;letter-spacing:-0.03em;color:#128C7E;margin-bottom:4px">Otto</h1>
          <p style="color:#999;font-size:0.75rem;letter-spacing:0.1em;text-transform:uppercase">by HNTIC</p>
        </div>

        <p style="font-size:1rem;line-height:1.6;margin-bottom:24px">
          ${greeting} assistant business IA est connect&eacute; et pr&ecirc;t &agrave; t'aider.
        </p>

        <!-- OÙ LE TROUVER -->
        <h2 style="font-size:0.85rem;text-transform:uppercase;letter-spacing:0.08em;color:#128C7E;margin-bottom:12px">&#128241; O&ugrave; le trouver</h2>
        <p style="font-size:0.95rem;line-height:1.6;margin-bottom:24px">
          Otto est dans ton <strong>"self-chat" WhatsApp</strong> &mdash; la conversation avec toi-m&ecirc;me.
          Ouvre WhatsApp et cherche ton propre nom ou "Otto" dans tes conversations.
        </p>

        <!-- CE QU'OTTO SAIT FAIRE -->
        <h2 style="font-size:0.85rem;text-transform:uppercase;letter-spacing:0.08em;color:#128C7E;margin-bottom:12px">&#128172; Ce qu'Otto sait faire</h2>
        <div style="background:#f9f9f9;border-radius:12px;padding:20px;margin-bottom:24px">
          <table style="width:100%;border-collapse:collapse">
            ${s('&#128188; G&eacute;rer tes contacts, deals, t&acirc;ches et projets')}
            ${s('&#128231; Lire et envoyer des emails (Gmail)')}
            ${s('&#128197; Consulter et g&eacute;rer ton agenda (Calendar)')}
            ${s('&#9200; Te rappeler tes RDV 15 min avant avec un brief')}
            ${s('&#10060; Te pr&eacute;venir si un RDV est annul&eacute;')}
            ${s('&#128196; Cr&eacute;er des documents (Word, Excel, PowerPoint, PDF)')}
            ${s('&#128247; Extraire les infos de photos, PDF, Word, Excel, vocaux')}
            ${s('&#128269; Faire des recherches web')}
            ${s('&#128200; Te faire un brief quotidien de ta journ&eacute;e')}
          </table>
        </div>

        <!-- PREMIERS PAS -->
        <h2 style="font-size:0.85rem;text-transform:uppercase;letter-spacing:0.08em;color:#128C7E;margin-bottom:12px">&#128640; Premiers pas (5 min)</h2>
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:20px;margin-bottom:24px">
          <ol style="margin:0;padding-left:20px;line-height:2">
            <li>Envoie-lui <strong>"Bonjour, mon entreprise s'appelle [nom]"</strong> &mdash; il te posera quelques questions pour se configurer</li>
            <li>Connecte tes apps : <strong>"Connecte mon Gmail"</strong> ou <strong>"Connecte mon Calendar"</strong> &mdash; il t'enverra un lien d'autorisation</li>
            <li>Programme ton brief matinal : <strong>"Programme un brief tous les matins &agrave; 9h"</strong></li>
          </ol>
        </div>

        <!-- ASTUCE FORWARD -->
        <h2 style="font-size:0.85rem;text-transform:uppercase;letter-spacing:0.08em;color:#128C7E;margin-bottom:12px">&#128640; L'astuce qui change tout : transf&egrave;re &agrave; Otto</h2>
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:20px;margin-bottom:24px">
          <p style="font-size:0.95rem;line-height:1.6;margin:0 0 12px;color:#1e3a8a">
            Tu peux <strong>transf&eacute;rer n'importe quel message, photo, PDF ou vocal</strong>
            de n'importe quelle conversation WhatsApp vers ton chat avec Otto. Il extrait,
            structure et stocke automatiquement.
          </p>
          <p style="font-size:0.85rem;line-height:1.6;margin:0;color:#1e3a8a">
            Quelques exemples concrets :
          </p>
          <ul style="font-size:0.85rem;line-height:1.7;color:#1e3a8a;padding-left:20px;margin:6px 0 0">
            <li>Une <strong>photo de carte de visite</strong> &rarr; Otto cr&eacute;e le contact</li>
            <li>Un <strong>devis PDF</strong> re&ccedil;u d'un fournisseur &rarr; Otto extrait montant et conditions</li>
            <li>Un <strong>vocal client</strong> qui d&eacute;crit son besoin &rarr; Otto transcrit et cr&eacute;e un lead</li>
            <li>Une <strong>convocation URSSAF</strong> en photo &rarr; Otto cr&eacute;e l'&eacute;ch&eacute;ance</li>
          </ul>
          <p style="font-size:0.8rem;line-height:1.5;margin:12px 0 0;color:#3b82f6;font-style:italic">
            Ton chat Otto devient ta bo&icirc;te de r&eacute;ception universelle. Drop ce que tu veux, il s'occupe du reste.
          </p>
        </div>

        <!-- GROUPES -->
        <h2 style="font-size:0.85rem;text-transform:uppercase;letter-spacing:0.08em;color:#128C7E;margin-bottom:12px">&#128101; Dans tes groupes WhatsApp</h2>
        <p style="font-size:0.95rem;line-height:1.6;margin-bottom:12px">
          Tu peux aussi activer Otto dans tes groupes WhatsApp d'&eacute;quipe.
          Dis-lui <strong>"ajoute Otto au groupe [nom]"</strong> depuis ton self-chat.
        </p>
        <div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:12px;padding:16px;margin-bottom:24px">
          <p style="font-size:0.85rem;line-height:1.5;margin:0;color:#92400e">
            &#9888;&#65039; <strong>Important :</strong> dans un groupe activ&eacute;, tous les membres peuvent interroger Otto
            en &eacute;crivant <strong>@otto</strong> suivi de leur question. Ils auront acc&egrave;s aux donn&eacute;es
            enregistr&eacute;es sur ton entreprise. Les conversations du groupe seront aussi analys&eacute;es pour
            enrichir ta base de donn&eacute;es. R&eacute;serve cette activation &agrave; tes collaborateurs de confiance.
          </p>
          <p style="font-size:0.85rem;line-height:1.5;margin:8px 0 0;color:#92400e">
            Dans un groupe, Otto ne r&eacute;pond <strong>qu'aux messages qui le mentionnent avec @otto</strong>.
          </p>
        </div>

        <!-- PORTAIL -->
        <h2 style="font-size:0.85rem;text-transform:uppercase;letter-spacing:0.08em;color:#128C7E;margin-bottom:12px">&#127760; Ton espace client</h2>
        <p style="font-size:0.95rem;line-height:1.6;margin-bottom:24px">
          Tu as aussi un tableau de bord web avec toutes tes donn&eacute;es.
          Dis <strong>"mon portail"</strong> &agrave; Otto, il t'enverra un code d'acc&egrave;s.
        </p>

        <!-- AIDE -->
        <p style="color:#999;font-size:0.85rem;line-height:1.5;margin-bottom:8px"><strong>Besoin d'aide ?</strong></p>
        <ul style="color:#999;font-size:0.85rem;line-height:1.8;padding-left:20px;margin-bottom:24px">
          <li>Parle directement &agrave; Otto &mdash; il est l&agrave; pour &ccedil;a !</li>
          <li>Tu peux aussi nous &eacute;crire &agrave; <a href="mailto:otto@hntic.fr" style="color:#128C7E">otto@hntic.fr</a></li>
          <li>En cas de probl&egrave;me de connexion : <a href="https://otto.hntic.fr/reconnect" style="color:#666">otto.hntic.fr/reconnect</a></li>
        </ul>

        <hr style="border:none;border-top:1px solid #eee;margin:32px 0">
        <p style="color:#bbb;font-size:0.75rem;text-align:center">
          <a href="https://otto.hntic.fr/cgv" style="color:#999;text-decoration:none;margin-right:12px">CGV</a>
          <a href="https://otto.hntic.fr/privacy" style="color:#999;text-decoration:none;margin-right:12px">Confidentialit&eacute;</a>
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
          <h1 style="font-size:1.6rem;font-weight:800;letter-spacing:-0.03em;color:#128C7E;margin-bottom:4px">Otto</h1>
          <p style="color:#999;font-size:0.75rem;letter-spacing:0.1em;text-transform:uppercase">by HNTIC</p>
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

/**
 * Send a contact form notification to the team.
 */
export async function sendContactNotification(
  name: string,
  email: string,
  company?: string,
  message?: string,
): Promise<void> {
  const notifyTo = process.env.CONTACT_NOTIFY_EMAIL || process.env.SMTP_USER;
  if (!transporter || !notifyTo) {
    console.log(`[CONTACT] Notification not sent (SMTP not configured): ${name} <${email}>`);
    return;
  }

  await transporter.sendMail({
    from: FROM,
    to: notifyTo,
    replyTo: email,
    subject: `Otto — Nouveau contact : ${name}${company ? ` (${company})` : ''}`,
    html: `
      <div style="font-family:'Inter',system-ui,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px">
        <h2 style="font-size:1.1rem;margin-bottom:20px">Nouveau contact depuis otto.hntic.fr</h2>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#888;font-size:0.85rem;width:100px">Nom</td><td style="padding:8px 0;font-size:0.95rem">${name}</td></tr>
          <tr><td style="padding:8px 0;color:#888;font-size:0.85rem">Email</td><td style="padding:8px 0;font-size:0.95rem"><a href="mailto:${email}">${email}</a></td></tr>
          ${company ? `<tr><td style="padding:8px 0;color:#888;font-size:0.85rem">Entreprise</td><td style="padding:8px 0;font-size:0.95rem">${company}</td></tr>` : ''}
          ${message ? `<tr><td style="padding:8px 0;color:#888;font-size:0.85rem;vertical-align:top">Message</td><td style="padding:8px 0;font-size:0.95rem">${message}</td></tr>` : ''}
        </table>
      </div>
    `,
  });

  console.log(`[EMAIL] Contact notification sent for ${name} <${email}>`);
}

/**
 * Send a billing notification via email (fallback when WhatsApp is unavailable).
 */
export async function sendBillingNotificationEmail(
  to: string,
  text: string,
): Promise<void> {
  if (!transporter) {
    console.warn(`SMTP not configured — billing email not sent to ${to}`);
    console.log(`[EMAIL] Would send billing notification to ${to}: ${text}`);
    return;
  }

  // Convert WhatsApp-style text to simple HTML
  const htmlText = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
    .replace(/\*([^*]+)\*/g, '<strong>$1</strong>');

  await transporter.sendMail({
    from: FROM,
    to,
    subject: 'Otto — Notification abonnement',
    html: `
      <div style="font-family:'Inter',system-ui,sans-serif;max-width:480px;margin:0 auto;padding:40px 20px">
        <div style="text-align:center;margin-bottom:32px">
          <h1 style="font-size:1.6rem;font-weight:800;letter-spacing:-0.03em;color:#128C7E;margin-bottom:4px">Otto</h1>
          <p style="color:#999;font-size:0.75rem;letter-spacing:0.1em;text-transform:uppercase">by HNTIC</p>
        </div>
        <div style="color:#333;font-size:1rem;line-height:1.6;margin-bottom:24px">
          ${htmlText}
        </div>
        <hr style="border:none;border-top:1px solid #eee;margin:32px 0">
        <p style="color:#bbb;font-size:0.75rem;text-align:center">
          Ce message a &eacute;t&eacute; envoy&eacute; par email car WhatsApp n'&eacute;tait pas disponible.<br>
          <a href="https://otto.hntic.fr/reconnect" style="color:#999">Reconnecter WhatsApp</a>
        </p>
      </div>
    `,
  });

  console.log(`[EMAIL] Billing notification sent to ${to}`);
}
