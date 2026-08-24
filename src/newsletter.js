// Renders the weekly newsletter as email-safe HTML (tables + inline styles).
// The layout mirrors the school's original three-page issue of The Roar,
// rebuilt in the BIST navy/gold design language:
//   A  masthead ("THE ROAR" + "Newsletter by …") and the quote banner
//   B  Upcoming Events table - left column
//   C  Principal's Message - right column
//   D/F/H and E/G/I - admin-assigned article slots in the left and right
//   columns, each article under a colored header bar with its photos
//   Footer - staff directory grid + branding.
const { formatIssueDate } = require('./week');
const { LEFT_SLOTS, RIGHT_SLOTS, DEFAULT_SLOT } = require('./slots');

const NAVY = '#1B2F5B';
const NAVY_DEEP = '#101E3C';
const GOLD = '#D9A441';
const GOLD_DEEP = '#B9862B';
const GOLD_SOFT = '#F6ECD9';
const IVORY = '#FAF7F1';
const INK = '#2E3A4E';
const MUTED = '#75809A';
const CARD_BORDER = '#E9E2D2';
const BAR_COLORS = ['#B23A32', '#2F6DA3', '#B9862B', '#1B2F5B'];

// FiraGO (OFL) - Fira with full Georgian support. Heavy carries titles,
// Light carries running text; email clients without webfont support fall
// back to the system sans stack.
const FIRAGO = "'FiraGO', 'Fira Sans', 'Segoe UI', Helvetica, Arial, sans-serif";
const SERIF = FIRAGO; // display/title role - used with font-weight:800
const SANS = FIRAGO; // text role - used with font-weight:300

const FONT_WEIGHTS = [
  ['Light', 300],
  ['Regular', 400],
  ['SemiBold', 600],
  ['Heavy', 800],
];

// @font-face block for the newsletter/reminder <head>. The URLs must be
// publicly reachable for the fonts to load in email clients that support
// webfonts (Apple Mail etc.); everything else falls back gracefully.
function fontFaceCss(base) {
  return FONT_WEIGHTS.map(
    ([name, weight]) =>
      `@font-face{font-family:'FiraGO';font-style:normal;font-weight:${weight};font-display:swap;src:url('${base}/fonts/FiraGO-${name}.woff2') format('woff2');}`
  ).join('\n');
}

// Column geometry: 680px sheet, 14px outer padding, 16px gutter.
const COL_W = 318;
const CARD_TEXT_W = COL_W - 2 - 28; // 1px borders + 14px card padding => 288
const PAIR_W = Math.floor((CARD_TEXT_W - 10) / 2); // two-up photo => 139

// Responsive rules for phones (<=640px): the two columns stack into one,
// photos stretch to the full screen width, running text steps up a size and
// the masthead/footer reflow. Desktop and tablet keep the fixed two-column
// sheet; Outlook ignores media queries and always gets the desktop layout.
const MOBILE_CSS = `
  @media only screen and (max-width: 640px) {
    .sheet { width: 100% !important; }
    .col { display: block !important; width: 100% !important; }
    .gutter { display: none !important; }
    .mast-pad { padding: 20px 18px 18px 18px !important; }
    .mast-cell { display: block !important; width: 100% !important; }
    .mast-title { font-size: 34px !important; letter-spacing: 3px !important; }
    .mast-side { display: block !important; width: 100% !important; text-align: left !important; padding: 12px 0 0 0 !important; }
    .quote-pad { padding: 24px 18px 22px 18px !important; }
    .wrap-pad { padding: 14px 10px 2px 10px !important; }
    .atext p { font-size: 16px !important; line-height: 1.7 !important; }
    .ph-hero, .ph-pair { width: 100% !important; max-width: 100% !important; }
    .dir-cell { display: block !important; width: 100% !important; text-align: center !important; padding: 5px 0 !important; }
    .foot-pad { padding: 22px 16px 20px 16px !important; }
  }`;

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Plain text -> paragraphs. Blank line separates paragraphs, single newline = <br>.
function textToHtml(text, color = INK, size = 15) {
  return escapeHtml(text)
    .split(/\r?\n\s*\r?\n/)
    .filter((p) => p.trim() !== '')
    .map(
      (p) =>
        `<p style="margin:0 0 12px 0; line-height:1.65; font-size:${size}px; font-weight:300; font-family:${SANS}; color:${color};">${p.replace(
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

function goldDivider(width = 42, align = 'left') {
  return `<table role="presentation" cellpadding="0" cellspacing="0" align="${align}" style="margin:${
    align === 'center' ? '0 auto' : '0'
  };"><tr><td width="${width}" height="3" style="background:${GOLD}; font-size:0; line-height:0;">&nbsp;</td></tr></table>`;
}

function columnHeading(kicker, title, rightHtml = '') {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
    <tr>
      <td valign="bottom">
        <p style="margin:0 0 4px 0; font-family:${SANS}; font-size:10px; font-weight:600; letter-spacing:3px; color:${GOLD_DEEP};">${escapeHtml(
    kicker.toUpperCase()
  )}</p>
        <h2 style="margin:0 0 8px 0; font-family:${SERIF}; font-size:22px; font-weight:800; line-height:1.2; color:${NAVY};">${escapeHtml(
    title
  )}</h2>
        ${goldDivider()}
      </td>
      ${rightHtml ? `<td align="right" valign="bottom" style="padding-bottom:10px;">${rightHtml}</td>` : ''}
    </tr>
  </table>`;
}

/* ---------- Placeholders (admin preview only) ---------- */

// In the admin preview every template section stays visible: an empty slot
// renders as a labelled dashed box and fills with content once assigned.
function placeholderBox(letter, title, hint) {
  return `
  <div style="padding:0 0 18px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate; border:2px dashed #D9CFBA; border-radius:10px; background:#FDFBF3;">
      <tr>
        <td align="center" style="padding:22px 14px;">
          <p style="margin:0; font-family:${SERIF}; font-size:20px; font-weight:800; letter-spacing:3px; color:#C4B896;">SECTION ${escapeHtml(
    letter
  )}</p>
          <p style="margin:6px 0 0 0; font-family:${SANS}; font-size:12px; font-weight:600; color:${MUTED};">${escapeHtml(
    title
  )}</p>
          <p style="margin:4px 0 0 0; font-family:${SANS}; font-size:11px; color:#A8AFC2;">${escapeHtml(hint)}</p>
        </td>
      </tr>
    </table>
  </div>`;
}

/* ---------- Section B: Upcoming Events ---------- */

function renderEventRow(ev, editable) {
  const day = dayParts(ev.event_date);
  const ed = (field) => (editable && ev.id ? ` data-edit="event:${ev.id}:${field}"` : '');
  let range = '';
  const metaHtml = [];
  if (ev.end_date && ev.end_date !== ev.event_date) {
    const end = dayParts(ev.end_date);
    if (ev.end_date.slice(0, 7) === ev.event_date.slice(0, 7)) {
      range = `<span style="font-size:10px; color:#f7ecd8;">-${end.num}</span>`;
    } else {
      // Range crosses a month boundary - "31-2" would mislead, spell it out.
      metaHtml.push(escapeHtml(`Until ${end.num} ${monthLabel(ev.end_date)}`));
    }
  }
  if (ev.location) metaHtml.push(`<span${ed('location')}>${escapeHtml(ev.location)}</span>`);
  if (ev.time_note) metaHtml.push(`<span${ed('time_note')}>${escapeHtml(ev.time_note)}</span>`);
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate; background:#ffffff; border:1px solid ${CARD_BORDER}; border-radius:10px;">
    <tr>
      <td width="54" align="center" valign="middle" style="background:${NAVY}; border-radius:10px 0 0 10px; padding:10px 4px;">
        <p style="margin:0; font-family:${SANS}; font-size:9px; font-weight:600; letter-spacing:2px; color:${GOLD};">${day.weekday}</p>
        <p style="margin:1px 0 0 0; font-family:${SERIF}; font-size:20px; font-weight:800; line-height:1; color:#ffffff;">${day.num}${range}</p>
      </td>
      <td valign="middle" style="padding:8px 12px;">
        <p style="margin:0; font-family:${SANS}; font-size:13px; font-weight:600; color:${NAVY}; line-height:1.35;"><span${ed(
    'title'
  )}>${escapeHtml(ev.title)}</span></p>
        ${
          metaHtml.length
            ? `<p style="margin:3px 0 0 0; font-family:${SANS}; font-size:11px; color:${MUTED};">${metaHtml.join(
                ' &nbsp;&bull;&nbsp; '
              )}</p>`
            : ''
        }
      </td>
    </tr>
  </table>`;
}

function renderEventsBlock(events, calendarUrl, editable) {
  if (!events.length) return '';
  const calendarChip = calendarUrl
    ? `<a href="${escapeHtml(
        calendarUrl
      )}" style="display:inline-block; border:1px solid ${GOLD}; border-radius:14px; padding:4px 12px; font-family:${SANS}; font-size:10px; font-weight:600; letter-spacing:2px; color:${GOLD_DEEP}; text-decoration:none;">CALENDAR</a>`
    : '';
  let rows = '';
  let lastMonth = '';
  for (const ev of events) {
    const m = monthLabel(ev.event_date);
    if (m !== lastMonth) {
      lastMonth = m;
      rows += `
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:10px 0 8px 0;"><tr>
        <td width="7" height="7" style="background:${GOLD}; border-radius:7px; font-size:0; line-height:0;">&nbsp;</td>
        <td style="font-family:${SANS}; font-size:10px; font-weight:600; letter-spacing:3px; color:${NAVY}; padding:0 0 0 8px;">${escapeHtml(
        m.toUpperCase()
      )}</td>
      </tr></table>`;
    }
    rows += `<div style="padding:0 0 7px 0;">${renderEventRow(ev, editable)}</div>`;
  }
  return `
  <div style="padding:0 0 18px 0;">
    ${columnHeading('Save the date', 'Upcoming Events', calendarChip)}
    <div style="padding-top:8px;">${rows}</div>
  </div>`;
}

/* ---------- Section C: Principal's Message ---------- */

function renderPrincipalBlock(principalMessage, editable) {
  if (!principalMessage) return '';
  const week = principalMessage.weekStart || '';
  const canEdit = editable && week;
  return `
  <div style="padding:0 0 18px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;">
      <tr>
        <td style="background:${NAVY}; border-radius:10px 10px 0 0; padding:11px 14px;">
          <p style="margin:0; font-family:${SANS}; font-size:13px; font-weight:600; letter-spacing:2px; color:#ffffff;">PRINCIPAL&#39;S MESSAGE</p>
        </td>
      </tr>
      <tr><td height="3" style="background:${GOLD}; font-size:0; line-height:0;">&nbsp;</td></tr>
      <tr>
        <td style="background:#ffffff; border:1px solid ${CARD_BORDER}; border-top:none; border-radius:0 0 10px 10px; padding:16px 14px 6px 14px;"${
    canEdit ? ` data-principal-week="${week}"${principalMessage.photoUrl ? '' : ' data-no-portrait="1"'}` : ''
  }>
          ${
            principalMessage.photoUrl
              ? `<img src="${escapeHtml(principalMessage.photoUrl)}"${
                  canEdit ? ` data-photo="principal:${week}"` : ''
                } alt="Principal" width="96" align="right" style="width:96px; height:auto; border-radius:8px; margin:0 0 8px 12px;">`
              : ''
          }
          <div class="atext"${canEdit ? ` data-edit="principal:${week}:body"` : ''}>${textToHtml(principalMessage.body, INK, 13.5)}</div>
        </td>
      </tr>
    </table>
  </div>`;
}

/* ---------- Article slots D-I ---------- */

const photoUrl = (p) => (typeof p === 'string' ? p : p.url);
const photoAttr = (p, editable) => (editable && typeof p !== 'string' && p.id ? ` data-photo="${p.id}"` : '');

function renderPhotos(photos, editable) {
  if (!photos || !photos.length) return '';
  // First photo runs the full card width as a hero; the rest pair up.
  const [hero, ...rest] = photos;
  let html = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin-top:10px;">
      <tr><td style="padding:0;">
        <img src="${escapeHtml(photoUrl(hero))}"${photoAttr(
    hero,
    editable
  )} alt="Newsletter photo" class="ph-hero" width="${CARD_TEXT_W}" style="width:100%; max-width:${CARD_TEXT_W}px; height:auto; display:block; border-radius:9px;">
      </td></tr>
    </table>`;
  for (let i = 0; i < rest.length; i += 2) {
    const pair = rest.slice(i, i + 2);
    html += `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin-top:8px;">
      <tr>
        ${pair
          .map(
            (p) => `
        <td width="50%" valign="top" style="padding:0 4px;">
          <img src="${escapeHtml(photoUrl(p))}"${photoAttr(
              p,
              editable
            )} alt="Newsletter photo" class="ph-pair" width="${PAIR_W}" style="width:100%; max-width:${PAIR_W}px; height:auto; display:block; border-radius:8px;">
        </td>`
          )
          .join('')}
        ${pair.length === 1 ? '<td width="50%" style="padding:0 4px;">&nbsp;</td>' : ''}
      </tr>
    </table>`;
  }
  return html;
}

function renderArticle(article, barColor, slotLetter, editable) {
  const ed = (field) => (editable && article.id ? ` data-edit="news:${article.id}:${field}"` : '');
  const slotChip = slotLetter
    ? `<span style="display:inline-block; background:rgba(255,255,255,0.28); border-radius:4px; padding:1px 7px; font-family:${SANS}; font-size:9px; font-weight:600; letter-spacing:1px; margin-right:8px;">${escapeHtml(
        slotLetter
      )}</span>`
    : '';
  return `
  <div style="padding:0 0 18px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;">
      <tr>
        <td style="background:${barColor}; border-radius:10px 10px 0 0; padding:11px 14px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font-family:${SANS}; font-size:14px; font-weight:600; color:#ffffff; line-height:1.35;">${slotChip}<span${ed(
    'title'
  )}>${escapeHtml(article.title)}</span></td>
            ${
              article.sectionLabel
                ? `<td align="right" valign="top" style="font-family:${SANS}; font-size:8px; font-weight:600; letter-spacing:2px; color:#ffffff; opacity:0.75; padding-left:8px; white-space:nowrap;">${escapeHtml(
                    article.sectionLabel.toUpperCase()
                  )}</td>`
                : ''
            }
          </tr></table>
        </td>
      </tr>
      <tr>
        <td style="background:#ffffff; border:1px solid ${CARD_BORDER}; border-top:none; border-radius:0 0 10px 10px; padding:14px 14px 8px 14px;"${
    editable && article.id ? ` data-add-photo="${article.id}"` : ''
  }>
          <div class="atext"${ed('body')}>${textToHtml(article.body, INK, 13.5)}</div>
          ${renderPhotos(article.photos, editable)}
        </td>
      </tr>
    </table>
  </div>`;
}

// Articles carry a slot letter; D/F/H flow down the left column, E/G/I down
// the right, in slot order (matching the original page layout). In
// placeholder mode an empty slot renders as a labelled dashed box instead of
// disappearing.
function columnHtml(letters, articles, articleHtml, placeholders, strays = []) {
  const known = new Set([...LEFT_SLOTS, ...RIGHT_SLOTS]);
  let html = '';
  for (const letter of letters) {
    const inSlot = articles.filter((a) => (a.slot || DEFAULT_SLOT) === letter);
    if (inSlot.length) {
      html += inSlot.map((a) => articleHtml(a, letter)).join('');
    } else if (placeholders) {
      const side = LEFT_SLOTS.includes(letter) ? 'left' : 'right';
      const pos = ['top', 'middle', 'bottom'][(LEFT_SLOTS.includes(letter) ? LEFT_SLOTS : RIGHT_SLOTS).indexOf(letter)];
      html += placeholderBox(letter, `Article slot - ${side} column, ${pos}`, 'Assign an article to this section in the News list.');
    }
  }
  html += strays.filter((a) => !known.has(a.slot || DEFAULT_SLOT)).map((a) => articleHtml(a, DEFAULT_SLOT)).join('');
  return html;
}

/* ---------- Footer ---------- */

// Lines like "Robert Snowden - Principal" become a staff directory grid;
// anything else falls back to plain text.
function parseDirectory(footerNote) {
  const lines = String(footerNote || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.map((line) => {
    const parts = line.split(/\s+(?:-|-|\||-)\s+/);
    return { name: parts[0], title: parts.slice(1).join(' - ') };
  });
}

function renderFooter(footerNote, newsletterName, schoolName, issueDateLabel) {
  const entries = parseDirectory(footerNote);
  const hasDirectory = entries.length > 0 && entries.some((e) => e.title);
  let directoryHtml = '';
  if (hasDirectory) {
    let rows = '';
    for (let i = 0; i < entries.length; i += 3) {
      const triple = entries.slice(i, i + 3);
      rows += `<tr>${triple
        .map(
          (e) => `
        <td class="dir-cell" width="33%" valign="top" style="padding:7px 10px;">
          <p style="margin:0; font-family:${SANS}; font-size:12px; font-weight:600; color:#ffffff;">${escapeHtml(
            e.name
          )}</p>
          ${
            e.title
              ? `<p style="margin:2px 0 0 0; font-family:${SANS}; font-size:10px; letter-spacing:1px; color:${GOLD};">${escapeHtml(
                  e.title
                )}</p>`
              : ''
          }
        </td>`
        )
        .join('')}${triple.length < 3 ? `<td width="${(3 - triple.length) * 33}%">&nbsp;</td>` : ''}</tr>`;
    }
    directoryHtml = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin-bottom:16px;">${rows}</table>
      <div style="margin:0 auto 16px auto;">${goldDivider(42, 'center')}</div>`;
  } else if (footerNote) {
    directoryHtml = `<div style="margin-bottom:12px;">${textToHtml(footerNote, '#AEB8D0', 12)}</div>`;
  }
  return `
    <tr><td height="5" style="background:${GOLD}; font-size:0; line-height:0;">&nbsp;</td></tr>
    <tr>
      <td class="foot-pad" align="center" style="background:${NAVY_DEEP}; padding:26px 24px 24px 24px;">
        ${directoryHtml}
        <p style="margin:0; font-family:${SERIF}; font-size:19px; font-weight:800; letter-spacing:3px; color:#ffffff;">${escapeHtml(
    newsletterName.toUpperCase()
  )}</p>
        <p style="margin:7px 0 0 0; font-family:${SANS}; font-size:10px; letter-spacing:2px; color:${GOLD};">NEWSLETTER BY ${escapeHtml(
    schoolName.toUpperCase()
  )}</p>
        <p style="margin:12px 0 0 0; font-family:${SANS}; font-size:11px; color:#8D99B8;">${escapeHtml(
    issueDateLabel
  )}</p>
      </td>
    </tr>`;
}

/* ---------- The full issue ---------- */

function renderNewsletter(data) {
  const {
    newsletterName = 'The Roar',
    schoolName = 'British International School of Tbilisi',
    issueDate,
    quote,
    events = [],
    principalMessage,
    articles = [],
    footerNote = '',
    calendarUrl = '',
  } = data;

  const issueDateLabel = formatIssueDate(issueDate);
  const placeholders = Boolean(data.placeholders);
  const editable = Boolean(data.editable);
  const fontBase = data.fontBase || '';

  let barIndex = 0;
  const articleHtml = (a, letter) =>
    renderArticle(a, BAR_COLORS[barIndex++ % BAR_COLORS.length], placeholders ? letter : null, editable);

  const eventsHtml = events.length
    ? renderEventsBlock(events, calendarUrl, editable)
    : placeholders
      ? placeholderBox('B', 'Upcoming Events', 'Add events on the Events page.')
      : '';
  const principalHtml = principalMessage
    ? renderPrincipalBlock(principalMessage, editable)
    : placeholders
      ? placeholderBox('C', "Principal's Message", "Written on the Principal's message page.")
      : '';

  const leftColumn = eventsHtml + columnHtml(LEFT_SLOTS, articles, articleHtml, placeholders, articles);
  const rightColumn = principalHtml + columnHtml(RIGHT_SLOTS, articles, articleHtml, placeholders);

  const quoteBlock =
    quote && quote.text
      ? `
    <tr>
      <td class="quote-pad" style="background:${NAVY_DEEP}; background-color:${NAVY_DEEP}; padding:30px 36px 28px 36px; text-align:center;">
        <p style="margin:0; font-family:${SERIF}; font-size:46px; font-weight:800; line-height:0.6; color:${GOLD};">&ldquo;</p>
        <p style="margin:8px 0 0 0; font-family:${SERIF}; font-style:italic; font-size:18px; font-weight:300; color:#ffffff; line-height:1.6;"${
          editable && quote.weekStart ? ` data-edit="quote:${quote.weekStart}:text"` : ''
        }>${escapeHtml(quote.text)}</p>
        ${
          quote.author
            ? `<div style="margin-top:14px;">${goldDivider(36, 'center')}</div>
        <p style="margin:10px 0 0 0; font-family:${SANS}; font-size:10px; font-weight:600; letter-spacing:3px; text-transform:uppercase; color:${GOLD};"${
                editable && quote.weekStart ? ` data-edit="quote:${quote.weekStart}:author"` : ''
              }>${escapeHtml(editable ? quote.author : quote.author.toUpperCase())}</p>`
            : ''
        }
      </td>
    </tr>`
      : placeholders
        ? `<tr><td style="padding:16px 14px 0 14px;">${placeholderBox(
            'A',
            'Quote of the week',
            "Added together with the principal's message."
          )}</td></tr>`
        : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(newsletterName)} - ${escapeHtml(issueDateLabel)}</title>
<meta name="x-apple-disable-message-reformatting">
<style>
${fontFaceCss(fontBase)}
</style>
<style>
  ${MOBILE_CSS}
</style>
</head>
<body style="margin:0; padding:0; background:#EDEAE2; -webkit-text-size-adjust:100%;">
  <center>
  <table role="presentation" class="sheet" width="680" cellpadding="0" cellspacing="0" style="border-collapse:collapse; width:680px; max-width:100%; background:${IVORY};">

    <!-- A: masthead -->
    <tr><td height="6" style="background:${GOLD}; font-size:0; line-height:0;">&nbsp;</td></tr>
    <tr>
      <td class="mast-pad" style="background:${NAVY_DEEP}; background-color:${NAVY_DEEP}; padding:26px 30px 24px 30px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td class="mast-cell" valign="bottom">
              <h1 class="mast-title" style="margin:0; font-family:${SERIF}; font-size:52px; font-weight:800; letter-spacing:5px; line-height:1; color:#ffffff;">${escapeHtml(
    newsletterName.toUpperCase()
  )}</h1>
            </td>
            <td class="mast-side" align="right" valign="bottom" style="padding-left:12px;">
              <p style="margin:0 0 3px 0; font-family:${SANS}; font-size:9px; font-weight:600; letter-spacing:3px; color:${GOLD};">NEWSLETTER BY</p>
              <p style="margin:0; font-family:${SANS}; font-size:12px; font-weight:600; color:#ffffff;">${escapeHtml(
    schoolName
  )}</p>
              <p style="margin:5px 0 0 0; font-family:${SANS}; font-size:9px; letter-spacing:2px; color:${GOLD_SOFT};">WEEKLY &bull; ${escapeHtml(
    issueDateLabel.toUpperCase()
  )}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    ${quoteBlock}

    <!-- B/C + article slots: two columns, as in the print layout -->
    <tr>
      <td class="wrap-pad" style="padding:20px 14px 6px 14px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          <tr>
            <td class="col" width="${COL_W}" valign="top">${leftColumn || '&nbsp;'}</td>
            <td class="gutter" width="16" style="font-size:0; line-height:0;">&nbsp;</td>
            <td class="col" width="${COL_W}" valign="top">${rightColumn || '&nbsp;'}</td>
          </tr>
        </table>
      </td>
    </tr>

    ${renderFooter(footerNote, newsletterName, schoolName, issueDateLabel)}
  </table>
  </center>
  ${
    editable
      ? `<script>window.CSRF=${JSON.stringify(data.csrf || '')};</script><script src="/js/preview-editor.js"></script>`
      : ''
  }
</body>
</html>`;
}

// Branded template for reminder emails to staff (navy + gold, red for the
// hard-deadline variant via headingColor).
function renderReminderEmail({ heading, headingColor, bodyHtml, buttonUrl, buttonLabel, schoolName, fontBase }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${escapeHtml(heading)}</title><style>
${fontFaceCss(fontBase || '')}
@media only screen and (max-width: 640px) { .sheet { width: 100% !important; margin: 0 !important; } }
</style></head>
<body style="margin:0; padding:0; background:#EDEAE2; -webkit-text-size-adjust:100%;">
  <center>
  <table role="presentation" class="sheet" width="560" cellpadding="0" cellspacing="0" style="border-collapse:collapse; width:560px; max-width:100%; background:#ffffff; margin:24px 0;">
    <tr><td height="5" style="background:${GOLD}; font-size:0; line-height:0;">&nbsp;</td></tr>
    <tr><td style="background:${NAVY_DEEP}; padding:18px 26px; font-family:${SERIF}; font-size:24px; font-weight:800; letter-spacing:3px; color:#ffffff;">THE ROAR</td></tr>
    <tr><td style="background:${escapeHtml(headingColor)}; padding:14px 26px; font-family:${SANS}; font-size:17px; font-weight:600; color:#ffffff;">${escapeHtml(
    heading
  )}</td></tr>
    <tr><td style="padding:22px 26px 8px 26px; font-family:${SANS};">${bodyHtml}</td></tr>
    ${
      buttonUrl
        ? `<tr><td style="padding:8px 26px 26px 26px;">
      <a href="${escapeHtml(buttonUrl)}" style="display:inline-block; background:${NAVY}; color:#ffffff; font-family:${SANS}; font-size:15px; font-weight:600; text-decoration:none; padding:13px 26px; border-radius:8px; border-bottom:3px solid ${GOLD_DEEP};">${escapeHtml(
            buttonLabel || 'Open the admin panel'
          )}</a></td></tr>`
        : ''
    }
    <tr><td style="padding:12px 26px 22px 26px; font-family:${SANS}; font-size:12px; color:#8a8a8a;">${escapeHtml(
    schoolName
  )} - automated newsletter reminder.</td></tr>
  </table>
  </center>
</body>
</html>`;
}

module.exports = {
  renderNewsletter,
  renderReminderEmail,
  escapeHtml,
  textToHtml,
  PALETTE: { NAVY, NAVY_DEEP, GOLD, GOLD_DEEP, IVORY, INK },
  WIDTHS: { CARD_TEXT_W, PAIR_W },
};
