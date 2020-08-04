import crypto from 'crypto';
import { Readable, PassThrough } from 'stream';

import { v4 as uuidv4 } from 'uuid';
import getRawBody from 'raw-body';
import { Context, Middleware } from 'koa';

import { BlobRepository } from './repository.js';

type Routes = { [operationId: string]: Middleware; };

export interface RouteFactory {
  makeRoutes (): Routes;
}

export class BlobRouteFactory implements RouteFactory {
  private repository: BlobRepository;

  constructor (repository: BlobRepository) {
    this.repository = repository;
  }

  /**
   * @param pattern Pattern can be `"foo"`, `"foo", "bar"`, or `*`
   * @param checksum The checksum we want to check against
   * @private
   */
  private checkMatchingRule (pattern: string, checksum: string): boolean {
    const patterns = pattern
      .split(',')
      .map(p => p.trim());

    for (const p of patterns) {
      if (p === '*') {
        if (checksum != null) {
          // Special case - "*" matches anything except "null"-ish (eg, nothing.)
          // This means is CANNOT be null - if it is, that's a failure
          return true;
        }

        continue;
      }

      if (p.match(/^(?:W\/)?"(.+)"$/)) {
        if (p.replace(/^(?:W\/)?"(.+)"$/, '$1') === checksum) {
          return true;
        }

        continue;
      }

      if (p === checksum) {
        return true;
      }
    }
  }

  private checkMatchingRules (headers: { [name: string]: string }, checksum: string): boolean {
    // If-match is a positive check.
    // If it does match it's good.
    if ('if-match' in headers) {
      if (!this.checkMatchingRule(headers['if-match'], checksum)) {
        return false;
      }
    }

    // If-None-Match is effectively a negation.
    // If it doesn't match it's good.
    if ('if-none-match' in headers) {
      if (this.checkMatchingRule(headers['if-none-match'], checksum)) {
        return false;
      }
    }

    // Only return true if both are good or are omitted!
    return true;
  }

  private async createBlob ({ req, request: { headers }, response, router }: Context) {
    const id = uuidv4();
    const blob = await getRawBody(req);
    const checksum = crypto.createHash('sha256').update(blob).digest('hex');

    await this.repository.updateBlob(
      id,
      {
        mimeType: headers['content-type'],
        checksum,
        blob: Readable.from(blob)
      }
    );

    response.body = null;
    response.status = 201;
    response.set('Content-Length', '0');
    response.set('ETAG', `"${checksum}"`);
    response.set('Location', router.url('get-blob', { blob_id: id }));
  }

  private async listenBlob({ req, res, params: { blob_id: id }, response }: Context) {
    response.set('Connection', 'keep-alive');
    response.set('Cache-Control', 'no-cache');
    response.type = 'text/event-stream';
    response.body = new PassThrough();

    const send = (id: string, type: string, message: string = '') => {
      response.body.write(`id: ${id}\n`);

      response.body.write(`event: ${type}\n`);

      for (const line of message.split('\n')) {
        response.body.write(`data: ${line}\n`);
      }

      response.body.write('\n');
    };

    response.body.write('retry: 10000\n');

    response.body.write('\n');

    const onUpdate = async ({ id: updatedId }: { id: string }) => {
      if (id === updatedId) {
        const blob = await this.repository.getBlob(id);

        send(blob.checksum, 'update');
      }
    };

    const onDelete = async ({ id: deletedId }: { id: string }) => {
      if (id === deletedId) {
        send(Date.now().toString(), 'delete');
      }
    };

    this.repository.on(`update`, onUpdate);
    this.repository.on(`delete`, onDelete);

    const end = () => {
      console.log("Client disconnected");
      response.body.end();

      this.repository.off('update', onUpdate);
      this.repository.off('delete', onDelete);
    };

    req.on('close', end);
    req.on('finish', end);
    req.on('error', end);
  }

  private async getBlob ({ params: { blob_id: id }, request: { accept, headers }, response }: Context) {
    const blob = await this.repository.getBlob(id);

    if (!blob) {
      response.status = 404;
      return;
    }

    if (blob.mimeType && !accept.types([blob.mimeType])) {
      response.status = 406;
      return;
    }

    if (!this.checkMatchingRules(headers, blob?.checksum)) {
      response.status = 304;
      return;
    }

    const {
      mimeType,
      updatedAt,
      expiresAt,
      checksum,
      blob: readable
    } = blob;

    try {
      response.set('Last-Modified', new Date(updatedAt).toISOString());
    } catch (e) {
      // Do nothing
    }

    try {
      response.set('Expires', new Date(expiresAt).toISOString());
    } catch (e) {
      // Do nothing
    }

    response.set('ETAG', `"${checksum}"`);
    response.set('Cache-Control', 'no-cache');
    response.set('Content-Type', mimeType);

    response.status = 200;
    response.body = readable;
  }

  private async updateBlob ({ req, request: { headers }, params: { blob_id: id }, response, router }: Context) {
    const blob = await this.repository.getBlob(id);

    // TODO: Create a lock - This could cause a race condition
    //       between when the check happens and when the update occurs.
    if (!this.checkMatchingRules(headers, blob?.checksum)) {
      response.status = 412;
      return;
    }

    const mimeType = headers['content-type'] || blob?.mimeType;
    const body = await getRawBody(req);
    const checksum = crypto.createHash('sha256').update(body).digest('hex');

    await this.repository.updateBlob(
      id,
      {
        mimeType,
        checksum,
        blob: Readable.from(body)
      }
    );

    response.body = null;
    response.status = 201;
    response.set('Content-Length', '0');
    response.set('ETAG', `"${checksum}"`);
    response.set('Location', router.url('get-blob', { blob_id: id }));
  }

  private async deleteBlob ({ request: { headers }, params: { blob_id: id }, response }: Context) {
    const blob = await this.repository.getBlob(id);

    if (!blob) {
      response.status = 404;
      return;
    }

    // TODO: Create a lock - This could cause a race condition
    //       between when the check happens and when the delete occurs.
    if (!this.checkMatchingRules(headers, blob?.checksum)) {
      response.status = 412;
      return;
    }

    await this.repository.deleteBlob(id);

    response.body = null;
    response.status = 202;
    response.set('Content-Length', '0');
  }

  makeRoutes (): Routes {
    return {
      'create-blob': context => this.createBlob(context),
      'listen-blob': context => this.listenBlob(context),
      'get-blob': context => this.getBlob(context),
      'update-blob': context => this.updateBlob(context),
      'delete-blob': context => this.deleteBlob(context)
    };
  }
}
