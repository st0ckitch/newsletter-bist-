# Hosting The Roar admin panel

## What this app needs from a host

- An **always-running Node.js server** (Node 22.13+). The Monday/Thursday
  reminders and the scheduled generation (default Thursday 18:00) are cron jobs inside the app -
  a host that sleeps or runs "serverless functions" will miss them.
- A **persistent disk**. The database is a SQLite file and uploaded photos
  are files on disk (both under `DATA_DIR`). Without a persistent volume
  they are wiped on every redeploy.
- **HTTPS** with a public URL (staff log in from anywhere; Mailchimp fetches
  fonts/photos from it).

That rules out static hosts and pure-serverless platforms (GitHub Pages,
Netlify, Vercel functions). You do **not** need a separate database service
(Supabase/Postgres) - SQLite comfortably handles a school's staff.

Cost on any option below: roughly **$5-7/month**.

## Option A - Railway (easiest, recommended)

1. Sign up at https://railway.app with your GitHub account (Hobby plan).
2. **New Project → Deploy from GitHub repo** → pick `newsletter-bist-`.
   Railway detects Node and uses `npm start` automatically.
3. Open the service → **Variables** → add:

   | Variable | Value |
   |---|---|
   | `DATA_DIR` | `/data` |
   | `SESSION_SECRET` | any long random string |
   | `ADMIN_EMAIL` | your login email |
   | `ADMIN_PASSWORD` | your login password |
   | `MAILCHIMP_API_KEY` | your Mailchimp API key |
   | `MAILCHIMP_SERVER_PREFIX` | `us1` |
   | `MAILCHIMP_AUDIENCE_ID` | your parents audience ID |

4. Right-click the service → **Attach Volume** → mount path `/data`.
5. **Settings → Networking → Generate Domain**. Copy the URL (e.g.
   `https://xxx.up.railway.app`) and add one more variable:
   `APP_BASE_URL` = that URL. The service redeploys; done.

## Option B - Render

1. Sign up at https://render.com with GitHub.
2. **New → Blueprint** → pick this repo. `render.yaml` creates the service
   with a 1 GB persistent disk at `/data` (Starter plan - the free tier has
   no disk and sleeps, which would skip the generation job).
3. Fill in the prompted secrets (same table as above).
4. After the first deploy, set `APP_BASE_URL` to the service URL
   (e.g. `https://roar-newsletter.onrender.com`).

## Option C - your own server / school hosting

Any VPS (Hetzner, DigitalOcean, ...) or a school server with Docker:

```
docker build -t roar .
docker run -d --name roar -p 3000:3000 \
  -v roar-data:/data --env-file .env --restart unless-stopped roar
```

Put a reverse proxy with HTTPS in front (Caddy makes this two lines) and set
`APP_BASE_URL` to the public URL.

## Troubleshooting

- **"Incorrect email or password" right after deploying:** make sure the
  variable changes were actually applied (Railway stages them until you press
  **Deploy**). The app re-syncs the `ADMIN_EMAIL` / `ADMIN_PASSWORD` account
  on every start - creating it if missing, fixing the password if it drifted -
  so once a deploy with the right variables is live, those credentials work.
  The same mechanism recovers a lost admin password: change `ADMIN_PASSWORD`
  on the host and redeploy.
- **Everything resets after a redeploy:** the persistent volume is missing or
  mounted somewhere other than `DATA_DIR`. Attach a volume and make sure its
  mount path and the `DATA_DIR` variable are both `/data`.
- **Login throttling:** 10 failed attempts per email block logins for
  15 minutes - wait it out rather than retrying.

## After it is live

- Log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`, create the teacher and
  principal accounts under **Users**.
- **Regenerate the Mailchimp API key** (Mailchimp → Account → Extras → API
  keys) and update the variable on the host if the old key was ever shared
  in chat or email.
- Optional custom domain (e.g. `roar.bist.ge`): add it in the host's
  dashboard and create the CNAME record it shows you in your DNS; then set
  `APP_BASE_URL` to that domain.
- The cron schedules run in the timezone from **Settings** (default
  `Asia/Tbilisi`) regardless of where the server is located.
