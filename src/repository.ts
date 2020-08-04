import { Readable } from 'stream';

import getRawBody from 'raw-body';
import LRU from 'lru-cache';
import { Redis } from 'ioredis';
import Redlock, { Lock } from 'redlock';
import { EventEmitter } from 'events';

export interface BlobInput {
  mimeType: string;

  checksum: string;

  blob: Readable;
}

export interface Blob {
  mimeType: string;

  updatedAt: number;

  expiresAt?: number;

  checksum: string;

  blob: Readable;
}

export interface BlobRepository extends EventEmitter {
  getBlob (id: string): Promise<Blob>;

  updateBlob (id: string, blob: BlobInput): Promise<void>;

  deleteBlob (id: string): Promise<void>;
}

export class MemoryBlobRepository extends EventEmitter implements BlobRepository {
  private store: LRU<string, { mimeType: string; updatedAt: number; checksum: string; blob: Buffer; }>;

  constructor ({ max = Infinity, maxAge = Infinity } = {}) {
    super();

    // Max Age comes in as seconds and we want milliseconds
    maxAge *= 1000;

    this.store = new LRU({ max, maxAge });
  }

  async getBlob (id: string): Promise<Blob> {
    const blob = this.store.get(id);

    if (!blob) {
      return undefined;
    }

    return {
      mimeType: blob.mimeType,
      updatedAt: blob.updatedAt,
      expiresAt: this.store.maxAge === Infinity ? undefined : Math.floor(blob.updatedAt + this.store.maxAge),
      checksum: blob.checksum,
      blob: Readable.from(blob.blob)
    };
  }

  async updateBlob (id: string, blob: BlobInput): Promise<void> {
    this.store.set(id, {
      mimeType: blob.mimeType,
      updatedAt: Date.now(),
      checksum: blob.checksum,
      blob: await getRawBody(blob.blob)
    });
    this.emit('update', { id });
  }

  async deleteBlob (id: string): Promise<void> {
    this.store.del(id);
    this.emit('delete', { id });
  }
}

export class RedisBlobRepository extends EventEmitter implements BlobRepository {
  private readonly client: Redis;
  private readonly maxAge: number;
  private readonly lock: Redlock;

  constructor (client: Redis, maxAge = Infinity) {
    super();

    this.client = client;
    // Max Age comes in as seconds and we expect milliseconds
    this.maxAge = maxAge * 1000;
    this.lock = new Redlock([client]);
  }

  private getBlobResourceName (id: string): string {
    return `blob:${id}`;
  }

  private async getBlobLock (id: string, ttl = 1000): Promise<Lock> {
    const resourceName = `${this.getBlobResourceName(id)}:lock`;

    return await this.lock.lock(resourceName, ttl);
  }

  async getBlob (id: string): Promise<Blob> {
    const resourceName = this.getBlobResourceName(id);
    const metadataResourceName = `${resourceName}:metadata`;

    const [
      metadataString,
      buffer
    ] = await Promise.all(
      [
        this.client.get(metadataResourceName),
        this.client.getBuffer(resourceName)
      ]
    );

    if (!metadataString) {
      return undefined;
    }

    const metadata = JSON.parse(metadataString);

    return {
      mimeType: metadata?.mimeType,
      updatedAt: metadata.updatedAt,
      expiresAt: this.maxAge === Infinity ? undefined : Math.floor(metadata.updatedAt + this.maxAge),
      checksum: metadata?.checksum,
      blob: Readable.from(buffer)
    };
  }

  async updateBlob (id: string, blob: BlobInput): Promise<void> {
    const resourceName = this.getBlobResourceName(id);
    const metadataResourceName = `${resourceName}:metadata`;

    const lock = await this.getBlobLock(id);

    const {
      blob: readable,
      checksum,
      mimeType
    } = blob;

    const metadata = {
      checksum,
      mimeType,
      updatedAt: Date.now()
    };

    if (this.maxAge === Infinity) {
      await Promise.all([
        this.client.setBuffer(resourceName, await getRawBody(readable)),
        this.client.set(metadataResourceName, JSON.stringify(metadata))
      ]);
    } else {
      await Promise.all([
        this.client.setBuffer(resourceName, await getRawBody(readable), 'PX', this.maxAge),
        this.client.set(metadataResourceName, JSON.stringify(metadata), 'PX', this.maxAge)
      ]);
    }

    this.emit('update', { id });

    await lock.unlock();
  }

  async deleteBlob (id: string): Promise<void> {
    const resourceName = this.getBlobResourceName(id);
    const metadataResourceName = `${resourceName}:metadata`;

    const lock = await this.getBlobLock(id);

    await Promise.all([
      this.client.del(resourceName),
      this.client.del(metadataResourceName)
    ]);

    this.emit('delete', { id });

    await lock.unlock();
  }
}
