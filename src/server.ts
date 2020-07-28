import { getApp } from './app.js';
import config from './config.js';

try {
  const app = await getApp()

  app.listen(
    process.env.PORT || 8080,
    () => process.stdout.write(`Listening on port ${config.port}\n`)
  );
} catch (e) {
  process.stderr.write(e.stack);

  process.exit(1);
}
