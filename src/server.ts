import http from 'http';
import http2 from 'http2';

import { getApp } from './app.js';
import config from './config.js';

function getServer (): http.Server|http2.Http2Server {
  if (config.http.key && config.http.cert) {
    // If SSL use HTTP2 secure server with ALPN
    return http2.createSecureServer(
      {
        allowHTTP1: true,
        key: config.http.key,
        cert: config.http.cert
      }
    );
  }

  // If no SSL use HTTP1
  return http.createServer();
}

try {
  const app = await getApp();

  const server = getServer();

  server.on('request', app.callback());

  server.listen(
    process.env.PORT || 8080,
    () => process.stdout.write(`Listening on port ${config.http.port}\n`)
  );
} catch (e) {
  process.stderr.write(e.stack);

  process.exit(1);
}
