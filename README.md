# The Roar — Newsletter Admin Tool

Admin panel for the weekly BIST parents newsletter. Teachers and the principal
log in, submit events, news, photos and the principal's message during the
week; the app reminds them by email (via Mailchimp) and every **Friday at
15:00** it aggregates everything into a branded email template and creates the
**draft campaign in Mailchimp** automatically. Staff review the draft in
Mailchimp and press send.

## How the week works

| When | What happens |
|---|---|
| **Monday 09:00** | Reminder email to all primary/secondary teachers + principal: "please submit content". |
| Mon–Thu | Staff log in and add events, news articles, photos; principal adds the weekly message + quote. |
| **Thursday 09:00** | **Hard-deadline** reminder — sent *only* to staff who have not submitted anything yet. |
| **Friday 15:00** | Everything submitted since Monday is aggregated into the newsletter HTML, photos are uploaded to the Mailchimp File Manager, and a **draft campaign** is created (or updated) in Mailchimp. Nothing is sent automatically. |

All times run in the school's timezone (`Asia/Tbilisi` by default) and every
schedule is editable in **Settings** (cron syntax) without a restart.
Content submitted after the Friday generation time (or over the weekend)
automatically counts toward the *next* issue, so nothing can silently land
in an already-generated newsletter. Regenerating on Friday evening or during
the weekend rebuilds the week that just finished.

## Roles

- **primary / secondary** — teachers: submit events, news and photos for their
  section (or whole-school); receive the reminder emails; can edit/delete only
  their own items.
- **principal** — everything teachers can do, plus the weekly principal's
  message & quote, user management, settings, manual draft generation.
- **admin** — full access (for IT); receives no reminders.

Everyone gets their own login. Accounts are created under **Users** (or with
`npm run create-user`).

## Setup

```bash
npm install
cp .env.example .env      # edit values
npm start                 # http://localhost:3000
```

On first start an admin account is created from `ADMIN_EMAIL` /
`ADMIN_PASSWORD` in `.env`. If `ADMIN_PASSWORD` is not set, a random
password is generated and printed once in the server log — log in with it
and change it under Users.

### Mailchimp

Following the [Mailchimp Marketing API quick start](https://mailchimp.com/developer/marketing/guides/quick-start/):

1. Create an API key: Mailchimp → Account → Extras → **API keys**.
2. The **server prefix** is the suffix of the key (e.g. `us21`).
3. Find the **Audience ID** of your parents list: Audience → Settings →
   *Audience name and defaults*.
4. Put all three in `.env` (`MAILCHIMP_API_KEY`, `MAILCHIMP_SERVER_PREFIX`,
   `MAILCHIMP_AUDIENCE_ID`). Optionally set `MAILCHIMP_TEACHERS_AUDIENCE_ID`
   to keep staff reminder emails in a separate audience.
5. Verify with **Settings → Test Mailchimp connection** in the app.

How the integration is used:

- **Reminders** — teacher addresses are upserted into the teachers audience
  (tagged `newsletter-staff`), a static segment is built for exactly the
  recipients of that reminder, and a campaign is created and sent to it.
- **Photos** — uploaded to the Mailchimp **File Manager** at generation time,
  so the newsletter references CDN-hosted images.
- **The draft** — a regular campaign addressed to the parents audience is
  created with the generated HTML. Re-generating the same week updates the
  same draft. The app never sends the parents campaign.

Without Mailchimp configured the app still works: content collection, preview
and local issue generation all function; reminders/drafts are skipped and the
dashboard shows a warning.

### Running in production

- Set `APP_BASE_URL` to the public URL of the tool (used for links in
  reminder emails and as a fallback for photo URLs).
- Set a strong `SESSION_SECRET`.
- `DATA_DIR` (default `./data`) holds the SQLite database and uploaded
  photos — back it up.
- Run behind HTTPS (any reverse proxy); the app sets `trust proxy`.
- The process must keep running for the schedules to fire (systemd, pm2,
  Docker, etc.).

## Tests

```bash
npm test
```

Covers the timezone/week logic, the newsletter renderer (including HTML
escaping of user content) and an end-to-end smoke test of login, CSRF,
role restrictions, content submission and issue generation.

## Project layout

```
server.js            entry point (boots app + cron scheduler)
src/app.js           express app wiring
src/db.js            SQLite schema, settings, admin seeding
src/week.js          timezone-aware week/date helpers
src/auth.js          sessions, roles, CSRF
src/mailchimp.js     Mailchimp Marketing API v3 client
src/newsletter.js    email-safe HTML templates (newsletter + reminders)
src/generate.js      Friday aggregation -> Mailchimp draft
src/reminders.js     Monday/Thursday reminder logic
src/scheduler.js     node-cron jobs (timezone-aware, hot-reloaded)
src/routes/*         admin panel routes
views/, public/      EJS templates + admin styling
```
