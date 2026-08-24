// Renders the weekly newsletter as email-safe HTML (tables + inline styles).
// Design: modern editorial/magazine style in the BIST brand palette —
// deep royal navy + warm gold + ivory (derived from the school's crest and
// masthead branding at bist.ge).
const { formatIssueDate } = require('./week');

const NAVY = '#1B2F5B';
const NAVY_DEEP = '#101E3C';
const GOLD = '#D9A441';
const GOLD_DEEP = '#B9862B';
const GOLD_SOFT = '#F6ECD9';
const IVORY = '#FAF7F1';
const INK = '#2E3A4E';
const MUTED = '#75809A';
const CARD_BORDER = '#E9E2D2';
const RED = '#C4432E';

const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif";

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Plain text -> paragraphs. Blank line separates paragraphs, single newline = <br>.
function textToHtml(text, color = INK) {
  return escapeHtml(text)
    .split(/\r?\n\s*\r?\n/)
    .filter((p) => p.trim() !== '')
    .map(
      (p) =>
        `<p style="margin:0 0 14px 0; line-height:1.7; font-size:15px; font-family:${SANS}; color:${color};">${p.replace(
          /\r?\n/g,
          '<br>'
        )}</p>`
    )
    .join('');
}

function monthLabel(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
}

function dayParts(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return {
    num: d,
    weekday: dt.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }).toUpperCase(),
  };
}

function goldDivider(width = 46, align = 'left') {
  return `<table role="presentation" cellpadding="0" cellspacing="0" align="${align}" style="margin:${
    align === 'center' ? '0 auto' : '0'
  };"><tr><td width="${width}" height="3" style="background:${GOLD}; font-size:0; line-height:0;">&nbsp;</td></tr></table>`;
}

function sectionHeading(kicker, title) {
  return `
    <tr>
      <td style="padding:34px 32px 6px 32px;">
        <p style="margin:0 0 6px 0; font-family:${SANS}; font-size:11px; font-weight:bold; letter-spacing:3px; color:${GOLD_DEEP};">${escapeHtml(
    kicker.toUpperCase()
  )}</p>
        <h2 style="margin:0 0 10px 0; font-family:${SERIF}; font-size:28px; line-height:1.2; color:${NAVY};">${escapeHtml(
    title
  )}</h2>
        ${goldDivider()}
      </td>
    </tr>`;
}

function renderEventCard(ev) {
  const day = dayParts(ev.event_date);
  let range = '';
  const metaBits = [];
  if (ev.end_date && ev.end_date !== ev.event_date) {
    const end = dayParts(ev.end_date);
    if (ev.end_date.slice(0, 7) === ev.event_date.slice(0, 7)) {
      range = `<span style="font-size:11px; color:#f7ecd8;">&ndash;${end.num}</span>`;
    } else {
      // Range crosses a month boundary — "31–2" would mislead, spell it out.
      metaBits.push(`Until ${end.num} ${monthLabel(ev.end_date)}`);
    }
  }
  metaBits.push(...[ev.location, ev.time_note].filter(Boolean));
  const metaHtml = metaBits.map(escapeHtml);
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate; background:#ffffff; border:1px solid ${CARD_BORDER}; border-radius:12px; margin:0 0 10px 0;">
      <tr>
        <td width="74" align="center" valign="middle" style="background:${NAVY}; border-radius:12px 0 0 12px; padding:14px 6px;">
          <p style="margin:0; font-family:${SANS}; font-size:10px; font-weight:bold; letter-spacing:2px; color:${GOLD};">${day.weekday}</p>
          <p style="margin:2px 0 0 0; font-family:${SERIF}; font-size:26px; line-height:1; color:#ffffff;">${day.num}${range}</p>
        </td>
        <td valign="middle" style="padding:12px 18px;">
          <p style="margin:0; font-family:${SANS}; font-size:15px; font-weight:bold; color:${NAVY}; line-height:1.4;">${escapeHtml(
    ev.title
  )}</p>
          ${
            metaHtml.length
              ? `<p style="margin:4px 0 0 0; font-family:${SANS}; font-size:12px; color:${MUTED};">${metaHtml.join(
                  ' &nbsp;&bull;&nbsp; '
                )}</p>`
              : ''
          }
        </td>
      </tr>
    </table>`;
}

function renderEvents(events) {
  if (!events.length) return '';
  let cards = '';
  let lastMonth = '';
  for (const ev of events) {
    const m = monthLabel(ev.event_date);
    if (m !== lastMonth) {
      lastMonth = m;
      cards += `
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px 0 10px 0;"><tr>
          <td style="font-family:${SANS}; font-size:11px; font-weight:bold; letter-spacing:3px; color:${NAVY}; padding:0 10px 0 0;">${escapeHtml(
        m.toUpperCase()
      )}</td>
          <td width="8" height="8" style="background:${GOLD}; border-radius:8px; font-size:0; line-height:0;">&nbsp;</td>
        </tr></table>`;
    }
    cards += renderEventCard(ev);
  }
  return `
    ${sectionHeading('Save the date', 'The Week Ahead')}
    <tr>
      <td style="padding:12px 32px 8px 32px;">
        ${cards}
      </td>
    </tr>`;
}

function renderPhotos(photos) {
  if (!photos || !photos.length) return '';
  // First photo runs full width as a hero; the rest flow in a two-column
  // grid. Widths fit the 482px article-card content area (600 - 2×32 outer
  // padding - 2×1 border - 2×26 inner padding) so Outlook does not overflow.
  const [hero, ...rest] = photos;
  let html = `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin-top:14px;">
          <tr><td style="padding:0;">
            <img src="${escapeHtml(hero)}" alt="Newsletter photo" width="482" style="width:100%; max-width:482px; height:auto; display:block; border-radius:12px;">
          </td></tr>
        </table>`;
  for (let i = 0; i < rest.length; i += 2) {
    const pair = rest.slice(i, i + 2);
    html += `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin-top:10px;">
          <tr>
            ${pair
              .map(
                (url) => `
            <td width="50%" valign="top" style="padding:0 5px;">
              <img src="${escapeHtml(url)}" alt="Newsletter photo" width="231" style="width:100%; max-width:231px; height:auto; display:block; border-radius:10px;">
            </td>`
              )
              .join('')}
            ${pair.length === 1 ? '<td width="50%" style="padding:0 5px;">&nbsp;</td>' : ''}
          </tr>
        </table>`;
  }
  return html;
}

function renderArticle(item, sectionLabel) {
  return `
    <tr>
      <td style="padding:12px 32px 12px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate; background:#ffffff; border:1px solid ${CARD_BORDER}; border-radius:14px;">
          <tr>
            <td style="padding:24px 26px 20px 26px;">
              <p style="margin:0 0 8px 0; font-family:${SANS}; font-size:10px; font-weight:bold; letter-spacing:3px; color:${GOLD_DEEP};">${escapeHtml(
    sectionLabel.toUpperCase()
  )}</p>
              <h3 style="margin:0 0 12px 0; font-family:${SERIF}; font-size:22px; line-height:1.3; color:${NAVY};">${escapeHtml(
    item.title
  )}</h3>
              ${goldDivider(36)}
              <div style="margin-top:14px;">${textToHtml(item.body)}</div>
              ${renderPhotos(item.photos)}
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

function renderNewsletter(data) {
  const {
    newsletterName = 'The Roar',
    schoolName = 'British International School of Tbilisi',
    issueDate,
    quote,
    events = [],
    principalMessage,
    sections = [],
    footerNote = '',
  } = data;

  const issueDateLabel = formatIssueDate(issueDate);

  const quoteBlock =
    quote && quote.text
      ? `
    <tr>
      <td style="background:${NAVY_DEEP}; background-color:${NAVY_DEEP}; padding:36px 40px 34px 40px; text-align:center;">
        <p style="margin:0; font-family:${SERIF}; font-size:52px; line-height:0.6; color:${GOLD};">&ldquo;</p>
        <p style="margin:10px 0 0 0; font-family:${SERIF}; font-style:italic; font-size:19px; color:#ffffff; line-height:1.6;">${escapeHtml(
          quote.text
        )}</p>
        ${
          quote.author
            ? `<div style="margin-top:16px;">${goldDivider(36, 'center')}</div>
        <p style="margin:12px 0 0 0; font-family:${SANS}; font-size:11px; font-weight:bold; letter-spacing:3px; color:${GOLD};">${escapeHtml(
                quote.author.toUpperCase()
              )}</p>`
            : ''
        }
      </td>
    </tr>`
      : '';

  const principalBlock = principalMessage
    ? `
    ${sectionHeading("From the Principal's desk", "Principal's Message")}
    <tr>
      <td style="padding:12px 32px 8px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate; background:#ffffff; border:1px solid ${CARD_BORDER}; border-top:4px solid ${GOLD}; border-radius:14px;">
          <tr>
            <td style="padding:26px 28px 16px 28px;">
              ${textToHtml(principalMessage.body)}
            </td>
          </tr>
        </table>
      </td>
    </tr>`
    : '';

  const articlesHtml = sections
    .map((s) => s.items.map((item) => renderArticle(item, s.label)).join(''))
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(newsletterName)} — ${escapeHtml(issueDateLabel)}</title>
</head>
<body style="margin:0; padding:0; background:#EDEAE2;">
  <center>
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="border-collapse:collapse; width:600px; max-width:100%; background:${IVORY};">

    <!-- Masthead -->
    <tr>
      <td style="background:${NAVY_DEEP}; background-color:${NAVY_DEEP}; padding:0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td height="6" style="background:${GOLD}; font-size:0; line-height:0;">&nbsp;</td></tr>
          <tr>
            <td align="center" style="padding:38px 30px 8px 30px;">
              <p style="margin:0 0 10px 0; font-family:${SANS}; font-size:10px; font-weight:bold; letter-spacing:4px; color:${GOLD};">${escapeHtml(
    schoolName.toUpperCase()
  )}</p>
              <h1 style="margin:0; font-family:${SERIF}; font-size:64px; letter-spacing:6px; line-height:1; color:#ffffff;">${escapeHtml(
    newsletterName.toUpperCase()
  )}</h1>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:14px 30px 34px 30px;">
              <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                <td style="border:1px solid ${GOLD}; border-radius:20px; padding:6px 20px; font-family:${SANS}; font-size:11px; font-weight:bold; letter-spacing:2px; color:${GOLD_SOFT};">WEEKLY NEWSLETTER &nbsp;&bull;&nbsp; ${escapeHtml(
    issueDateLabel.toUpperCase()
  )}</td>
              </tr></table>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    ${quoteBlock}
    ${renderEvents(events)}
    ${principalBlock}
    ${
      articlesHtml
        ? `${sectionHeading('This week at BIST', 'School News & Highlights')}${articlesHtml}`
        : ''
    }

    <!-- Footer -->
    <tr>
      <td style="padding:24px 0 0 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td height="6" style="background:${GOLD}; font-size:0; line-height:0;">&nbsp;</td></tr>
          <tr>
            <td align="center" style="background:${NAVY_DEEP}; padding:30px 30px 28px 30px;">
              <p style="margin:0; font-family:${SERIF}; font-size:20px; letter-spacing:3px; color:#ffffff;">${escapeHtml(
    newsletterName.toUpperCase()
  )}</p>
              <p style="margin:8px 0 0 0; font-family:${SANS}; font-size:11px; letter-spacing:2px; color:${GOLD};">${escapeHtml(
    schoolName.toUpperCase()
  )}</p>
              ${footerNote ? `<div style="margin-top:14px;">${textToHtml(footerNote, '#AEB8D0')}</div>` : ''}
              <p style="margin:14px 0 0 0; font-family:${SANS}; font-size:11px; color:#8D99B8;">${escapeHtml(
    issueDateLabel
  )}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
  </center>
</body>
</html>`;
}

// Branded template for reminder emails to staff (navy + gold, red for the
// hard-deadline variant via headingColor).
function renderReminderEmail({ heading, headingColor, bodyHtml, buttonUrl, buttonLabel, schoolName }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(heading)}</title></head>
<body style="margin:0; padding:0; background:#EDEAE2;">
  <center>
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="border-collapse:collapse; width:560px; max-width:100%; background:#ffffff; margin:24px 0;">
    <tr><td height="5" style="background:${GOLD}; font-size:0; line-height:0;">&nbsp;</td></tr>
    <tr><td style="background:${NAVY_DEEP}; padding:18px 26px; font-family:${SERIF}; font-size:24px; letter-spacing:3px; color:#ffffff;">THE ROAR</td></tr>
    <tr><td style="background:${escapeHtml(headingColor)}; padding:14px 26px; font-family:${SANS}; font-size:17px; font-weight:bold; color:#ffffff;">${escapeHtml(
    heading
  )}</td></tr>
    <tr><td style="padding:22px 26px 8px 26px; font-family:${SANS};">${bodyHtml}</td></tr>
    ${
      buttonUrl
        ? `<tr><td style="padding:8px 26px 26px 26px;">
      <a href="${escapeHtml(buttonUrl)}" style="display:inline-block; background:${NAVY}; color:#ffffff; font-family:${SANS}; font-size:15px; font-weight:bold; text-decoration:none; padding:13px 26px; border-radius:8px; border-bottom:3px solid ${GOLD_DEEP};">${escapeHtml(
            buttonLabel || 'Open the admin panel'
          )}</a></td></tr>`
        : ''
    }
    <tr><td style="padding:12px 26px 22px 26px; font-family:${SANS}; font-size:12px; color:#8a8a8a;">${escapeHtml(
    schoolName
  )} — automated newsletter reminder.</td></tr>
  </table>
  </center>
</body>
</html>`;
}

module.exports = { renderNewsletter, renderReminderEmail, escapeHtml, textToHtml, PALETTE: { NAVY, NAVY_DEEP, GOLD, GOLD_DEEP, IVORY, INK, RED } };
