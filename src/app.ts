import 'reflect-metadata';
import tsyringe from 'tsyringe';
import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import logger from 'koa-logger';
import { getRouter } from '@imnotjames/koa-openapi-router';
import Redis from 'ioredis';

import config from './config.js';
import { getApiDoc } from './api-doc.js';
import { BlobRouteFactory, RouteFactory } from './routes.js';
import { BlobRepository, RedisBlobRepository, MemoryBlobRepository } from './repository.js';

class Router {
  private router: any;

  constructor (
    apiDoc: any,
    routes: RouteFactory
  ) {
    this.router = getRouter(
      {
        apiDoc,
        operations: routes.makeRoutes(),
        consumers: {
          'application/json': bodyParser({ enableTypes: ['json'] })
        }
      }
    );
  }

  routes () {
    return this.router.routes();
  }

  allowedMethods () {
    return this.router.allowedMethods();
  }
}

async function getContainer (): Promise<tsyringe.DependencyContainer> {
  const container = tsyringe.container.createChildContainer();

  container.registerInstance('APIDoc', await getApiDoc());

  container.register<Redis.Redis>(Redis, { useFactory: () => new Redis(config.storage.redis.url) });

  container.register<BlobRepository>(RedisBlobRepository, { useFactory: c => new RedisBlobRepository(c.resolve<Redis.Redis>(Redis)) });
  container.register<BlobRepository>(MemoryBlobRepository, { useFactory: () => new MemoryBlobRepository(config.storage.memory) });

  if (config.blob.source === 'memory') {
    container.register<BlobRepository>('BlobRepository', { useToken: MemoryBlobRepository });
  } else if (config.blob.source === 'redis') {
    container.register<BlobRepository>('BlobRepository', { useToken: RedisBlobRepository });
  }

  container.register<RouteFactory>(BlobRouteFactory, { useFactory: c => new BlobRouteFactory(c.resolve<BlobRepository>('BlobRepository')) });

  container.register<RouteFactory>('RouteFactory', { useToken: BlobRouteFactory });
  container.register<Router>(Router, { useFactory: c => new Router(c.resolve('APIDoc'), c.resolve('RouteFactory')) });

  return container;
}

export async function getApp (): Promise<Koa> {
  const router = (await getContainer()).resolve(Router);

  const app = new Koa();

  app.use(logger());

  app
    .use(router.routes())
    .use(router.allowedMethods());

  return app;
}