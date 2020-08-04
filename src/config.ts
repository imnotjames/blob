import env from 'env-var';

export default {
  http: {
    port: env.get('PORT').default(8080).asPortNumber(),
    key: env.get('TLS_KEY').asString(),
    cert: env.get('TLS_CERT').asString()
  },
  storage: {
    redis: {
      url: env.get('REDIS_URL').default('redis://127.0.0.1:6379/0').asUrlString()
    },
    memory: {
      maxSize: env.get('BLOB_MEMORY_SIZE').default(Infinity).asFloatPositive()
    }
  },
  blob: {
    source: env.get('BLOB_SOURCE').default('memory').asEnum(['redis', 'memory']),
    maxSize: env.get('BLOB_MAX_SIZE').default(Infinity).asFloatPositive(),
    maxAge: env.get('BLOB_MAX_AGE').default(Infinity).asFloatPositive()
  }
};
