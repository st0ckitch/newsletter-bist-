const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const dataDir = path.resolve(process.env.DATA_DIR || './data');

let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  console.warn(
    '[config] SESSION_SECRET is not set - using a random secret. ' +
      'All sessions will be invalidated on restart. Set SESSION_SECRET in .env.'
  );
}

module.exports = {
  port: Number(process.env.PORT || 3000),
  appBaseUrl: (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, ''),
  sessionSecret,
  dataDir,
  dbPath: path.join(dataDir, 'newsletter.sqlite'),
  uploadDir: path.join(dataDir, 'uploads'),
  admin: {
    email: process.env.ADMIN_EMAIL || 'admin@bist.ge',
    name: process.env.ADMIN_NAME || 'Administrator',
    // No well-known default: when unset, a random password is generated at
    // first boot and printed to the server log.
    password: process.env.ADMIN_PASSWORD || '',
  },
  mailchimp: {
    apiKey: process.env.MAILCHIMP_API_KEY || '',
    serverPrefix:
      process.env.MAILCHIMP_SERVER_PREFIX ||
      // The server prefix is the suffix of the API key ("<key>-us21")
      (process.env.MAILCHIMP_API_KEY && process.env.MAILCHIMP_API_KEY.includes('-')
        ? process.env.MAILCHIMP_API_KEY.split('-').pop()
        : ''),
    audienceId: process.env.MAILCHIMP_AUDIENCE_ID || '',
    teachersAudienceId:
      process.env.MAILCHIMP_TEACHERS_AUDIENCE_ID || process.env.MAILCHIMP_AUDIENCE_ID || '',
  },
};
