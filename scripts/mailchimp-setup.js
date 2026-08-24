// Verifies the Mailchimp connection and prints your audiences so you can
// fill MAILCHIMP_AUDIENCE_ID in .env:  npm run mailchimp:setup
const config = require('../src/config');
const mailchimp = require('../src/mailchimp');

(async () => {
  if (!mailchimp.isConfigured()) {
    console.error('Set MAILCHIMP_API_KEY in .env first.');
    process.exit(1);
  }
  try {
    const pong = await mailchimp.ping();
    console.log(`✅ Mailchimp connection OK (${config.mailchimp.serverPrefix}): ${pong.health_status || 'healthy'}\n`);
  } catch (err) {
    console.error(`❌ Mailchimp ping failed: ${err.message}`);
    process.exit(1);
  }
  const res = await fetch(`https://${config.mailchimp.serverPrefix}.api.mailchimp.com/3.0/lists?count=50`, {
    headers: { Authorization: `Basic ${Buffer.from(`anystring:${config.mailchimp.apiKey}`).toString('base64')}` },
  });
  const data = await res.json();
  const lists = data.lists || [];
  if (!lists.length) {
    console.log('No audiences found — create one in Mailchimp (Audience → Audience dashboard) first.');
    process.exit(0);
  }
  console.log('Your audiences:\n');
  for (const l of lists) {
    console.log(`  ${l.name}`);
    console.log(`    id: ${l.id}   members: ${l.stats ? l.stats.member_count : '?'}\n`);
  }
  if (config.mailchimp.audienceId) {
    console.log(`MAILCHIMP_AUDIENCE_ID is set to ${config.mailchimp.audienceId} — you're ready.`);
  } else {
    console.log('Copy the id of your PARENTS audience into .env as MAILCHIMP_AUDIENCE_ID');
    console.log('(and optionally a separate MAILCHIMP_TEACHERS_AUDIENCE_ID for staff reminders).');
  }
})();
