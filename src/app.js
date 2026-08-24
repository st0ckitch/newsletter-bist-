const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieSession = require('cookie-session');
const config = require('./config');
const { attachUser, csrfProtection } = require('./auth');

function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // The newsletter preview is email HTML with inline styles/images.
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          frameSrc: ["'self'"],
          formAction: ["'self'"],
        },
      },
    })
  );

  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(
    cookieSession({
      name: 'roar.sid',
      secret: config.sessionSecret,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 14 * 24 * 60 * 60 * 1000,
    })
  );

  app.use(express.static(path.join(__dirname, '..', 'public')));
  // Uploaded photos: filenames are random, and the same files are embedded in
  // the parents' newsletter, so they are served without auth. Email clients
  // load them cross-origin, which helmet's default CORP header would block.
  app.use(
    '/uploads',
    (req, res, next) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      next();
    },
    express.static(config.uploadDir, { maxAge: '7d' })
  );

  app.use(attachUser);
  app.use(csrfProtection);

  app.use(require('./routes/auth'));
  app.use(require('./routes/dashboard'));
  app.use(require('./routes/events'));
  app.use(require('./routes/news'));
  app.use(require('./routes/principal'));
  app.use(require('./routes/newsletter'));
  app.use(require('./routes/users'));
  app.use(require('./routes/settings'));

  app.use((req, res) => res.status(404).render('error', { message: 'Page not found.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[app] Unhandled error:', err);
    if (res.headersSent) return next(err);
    const message = err.status === 400 || err.expose ? err.message : 'Something went wrong. Please try again.';
    res.status(err.status || 500).render('error', { message });
  });

  return app;
}

module.exports = { createApp };
