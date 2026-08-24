const config = require('./src/config');
const { seedAdmin } = require('./src/db');
const { createApp } = require('./src/app');
const scheduler = require('./src/scheduler');

seedAdmin();

const app = createApp();
app.listen(config.port, () => {
  console.log(`[server] Newsletter admin panel running on ${config.appBaseUrl} (port ${config.port})`);
  scheduler.start();
});
