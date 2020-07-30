import env from 'env-var';

export default {
  port: env.get('PORT').default(8080).asIntPositive(),
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
    maxAge: env.get('BLOB_AGE').default(Infinity).asFloatPositive()
  }
};
