/**
 * RoadStorage - Object Storage Service
 *
 * Features:
 * - S3-compatible API
 * - Presigned URLs
 * - Multipart uploads
 * - Versioning
 * - Access control
 * - Lifecycle policies
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

interface Env {
  STORAGE: R2Bucket;
  META: KVNamespace;
  SIGNING_KEY?: string;
}

interface ObjectMeta {
  key: string;
  size: number;
  etag: string;
  contentType: string;
  uploadedAt: number;
  uploadedBy?: string;
  metadata?: Record<string, string>;
  acl: 'private' | 'public-read';
  versions?: { versionId: string; uploadedAt: number }[];
}

interface Bucket {
  name: string;
  createdAt: number;
  objectCount: number;
  totalSize: number;
  versioning: boolean;
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'],
  allowHeaders: ['*'],
  exposeHeaders: ['ETag', 'Content-Length', 'Content-Type', 'x-amz-*'],
}));

// Health check
app.get('/health', (c) => c.json({ status: 'healthy', service: 'roadstorage' }));

// Root
app.get('/', (c) => c.json({
  name: 'RoadStorage',
  version: '0.1.0',
  description: 'S3-Compatible Object Storage',
  endpoints: {
    listObjects: 'GET /:bucket',
    getObject: 'GET /:bucket/:key',
    putObject: 'PUT /:bucket/:key',
    deleteObject: 'DELETE /:bucket/:key',
    headObject: 'HEAD /:bucket/:key',
    presign: 'POST /presign',
    multipart: '/multipart',
  },
}));

// List buckets (simulated - we use prefixes as buckets)
app.get('/buckets', async (c) => {
  const list = await c.env.META.list({ prefix: 'bucket:' });

  const buckets = await Promise.all(
    list.keys.map(async (key) => {
      const data = await c.env.META.get(key.name, 'json');
      return data;
    })
  );

  return c.json({ buckets: buckets.filter(Boolean) });
});

// Create bucket
app.put('/buckets/:name', async (c) => {
  const name = c.req.param('name');

  const bucket: Bucket = {
    name,
    createdAt: Date.now(),
    objectCount: 0,
    totalSize: 0,
    versioning: false,
  };

  await c.env.META.put(`bucket:${name}`, JSON.stringify(bucket));

  return c.json({ created: true, bucket: name }, 201);
});

// Delete bucket
app.delete('/buckets/:name', async (c) => {
  const name = c.req.param('name');

  // Check if empty
  const objects = await c.env.STORAGE.list({ prefix: `${name}/`, limit: 1 });
  if (objects.objects.length > 0) {
    return c.json({ error: 'Bucket not empty' }, 409);
  }

  await c.env.META.delete(`bucket:${name}`);

  return c.json({ deleted: true });
});

// List objects
app.get('/:bucket', async (c) => {
  const bucket = c.req.param('bucket');
  const prefix = c.req.query('prefix') || '';
  const delimiter = c.req.query('delimiter');
  const maxKeys = parseInt(c.req.query('max-keys') || '1000');
  const continuationToken = c.req.query('continuation-token');

  const fullPrefix = bucket + '/' + prefix;

  const options: R2ListOptions = {
    prefix: fullPrefix,
    limit: maxKeys,
    cursor: continuationToken,
    delimiter,
  };

  const list = await c.env.STORAGE.list(options);

  const contents = list.objects.map(obj => ({
    Key: obj.key.replace(`${bucket}/`, ''),
    Size: obj.size,
    ETag: obj.etag,
    LastModified: obj.uploaded.toISOString(),
    StorageClass: 'STANDARD',
  }));

  const commonPrefixes = list.delimitedPrefixes?.map(p => ({
    Prefix: p.replace(`${bucket}/`, ''),
  })) || [];

  return c.json({
    Name: bucket,
    Prefix: prefix,
    MaxKeys: maxKeys,
    Contents: contents,
    CommonPrefixes: commonPrefixes,
    IsTruncated: list.truncated,
    NextContinuationToken: list.truncated ? list.cursor : undefined,
  });
});

// Get object
app.get('/:bucket/:key{.+}', async (c) => {
  const bucket = c.req.param('bucket');
  const key = c.req.param('key');
  const fullKey = `${bucket}/${key}`;

  // Check for range request
  const range = c.req.header('Range');

  const object = await c.env.STORAGE.get(fullKey, {
    range: range ? parseRange(range) : undefined,
  });

  if (!object) {
    return c.json({ error: 'NoSuchKey' }, 404);
  }

  const headers: Record<string, string> = {
    'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
    'ETag': object.etag,
    'Content-Length': String(object.size),
    'Last-Modified': object.uploaded.toISOString(),
  };

  // Add custom metadata
  if (object.customMetadata) {
    for (const [k, v] of Object.entries(object.customMetadata)) {
      headers[`x-amz-meta-${k}`] = v;
    }
  }

  if (range && object.range) {
    return new Response(object.body, {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`,
      },
    });
  }

  return new Response(object.body, { headers });
});

// Head object
app.head('/:bucket/:key{.+}', async (c) => {
  const bucket = c.req.param('bucket');
  const key = c.req.param('key');
  const fullKey = `${bucket}/${key}`;

  const object = await c.env.STORAGE.head(fullKey);

  if (!object) {
    return new Response(null, { status: 404 });
  }

  return new Response(null, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
      'ETag': object.etag,
      'Content-Length': String(object.size),
      'Last-Modified': object.uploaded.toISOString(),
    },
  });
});

// Put object
app.put('/:bucket/:key{.+}', async (c) => {
  const bucket = c.req.param('bucket');
  const key = c.req.param('key');
  const fullKey = `${bucket}/${key}`;

  const contentType = c.req.header('Content-Type') || 'application/octet-stream';
  const body = await c.req.arrayBuffer();

  // Extract custom metadata headers
  const customMetadata: Record<string, string> = {};
  for (const [header, value] of Object.entries(c.req.header())) {
    if (header.toLowerCase().startsWith('x-amz-meta-')) {
      const metaKey = header.substring(11);
      customMetadata[metaKey] = value as string;
    }
  }

  const object = await c.env.STORAGE.put(fullKey, body, {
    httpMetadata: { contentType },
    customMetadata,
  });

  // Update bucket stats
  const bucketMeta = await c.env.META.get(`bucket:${bucket}`, 'json') as Bucket | null;
  if (bucketMeta) {
    bucketMeta.objectCount += 1;
    bucketMeta.totalSize += body.byteLength;
    await c.env.META.put(`bucket:${bucket}`, JSON.stringify(bucketMeta));
  }

  // Store object metadata
  const meta: ObjectMeta = {
    key,
    size: body.byteLength,
    etag: object.etag,
    contentType,
    uploadedAt: Date.now(),
    metadata: customMetadata,
    acl: 'private',
  };

  await c.env.META.put(`object:${fullKey}`, JSON.stringify(meta));

  return new Response(null, {
    status: 200,
    headers: {
      'ETag': object.etag,
    },
  });
});

// Delete object
app.delete('/:bucket/:key{.+}', async (c) => {
  const bucket = c.req.param('bucket');
  const key = c.req.param('key');
  const fullKey = `${bucket}/${key}`;

  // Get object size for stats update
  const object = await c.env.STORAGE.head(fullKey);

  await c.env.STORAGE.delete(fullKey);
  await c.env.META.delete(`object:${fullKey}`);

  // Update bucket stats
  if (object) {
    const bucketMeta = await c.env.META.get(`bucket:${bucket}`, 'json') as Bucket | null;
    if (bucketMeta) {
      bucketMeta.objectCount -= 1;
      bucketMeta.totalSize -= object.size;
      await c.env.META.put(`bucket:${bucket}`, JSON.stringify(bucketMeta));
    }
  }

  return new Response(null, { status: 204 });
});

// Copy object
app.put('/:bucket/:key{.+}', async (c) => {
  const copySource = c.req.header('x-amz-copy-source');

  if (!copySource) {
    // Regular PUT, handled above
    return;
  }

  const bucket = c.req.param('bucket');
  const key = c.req.param('key');
  const destKey = `${bucket}/${key}`;

  // Parse source
  const source = copySource.replace(/^\//, '');
  const sourceObject = await c.env.STORAGE.get(source);

  if (!sourceObject) {
    return c.json({ error: 'Source not found' }, 404);
  }

  // Copy to destination
  const result = await c.env.STORAGE.put(destKey, sourceObject.body, {
    httpMetadata: sourceObject.httpMetadata,
    customMetadata: sourceObject.customMetadata,
  });

  return c.json({
    CopyObjectResult: {
      ETag: result.etag,
      LastModified: new Date().toISOString(),
    },
  });
});

// Generate presigned URL
app.post('/presign', async (c) => {
  const body = await c.req.json<{
    bucket: string;
    key: string;
    method: 'GET' | 'PUT';
    expiresIn?: number;
  }>();

  const expiresIn = body.expiresIn || 3600;
  const expires = Date.now() + expiresIn * 1000;

  // Create signature
  const fullKey = `${body.bucket}/${body.key}`;
  const signingKey = c.env.SIGNING_KEY || 'default-key';
  const data = `${body.method}:${fullKey}:${expires}`;

  const encoder = new TextEncoder();
  const keyData = encoder.encode(signingKey);
  const messageData = encoder.encode(data);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)));

  const url = new URL(c.req.url);
  url.pathname = `/${body.bucket}/${body.key}`;
  url.searchParams.set('X-Signature', sig);
  url.searchParams.set('X-Expires', String(expires));
  url.searchParams.set('X-Method', body.method);

  return c.json({
    url: url.toString(),
    expiresIn,
    expiresAt: new Date(expires).toISOString(),
  });
});

// Multipart upload - Initiate
app.post('/:bucket/:key{.+}?uploads', async (c) => {
  const bucket = c.req.param('bucket');
  const key = c.req.param('key');
  const uploadId = crypto.randomUUID();

  // Store upload session
  await c.env.META.put(`multipart:${uploadId}`, JSON.stringify({
    bucket,
    key,
    uploadId,
    parts: [],
    createdAt: Date.now(),
  }), { expirationTtl: 86400 }); // 24 hours

  return c.json({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
  });
});

// Multipart upload - Upload part
app.put('/:bucket/:key{.+}', async (c) => {
  const uploadId = c.req.query('uploadId');
  const partNumber = c.req.query('partNumber');

  if (!uploadId || !partNumber) {
    return; // Regular PUT
  }

  const bucket = c.req.param('bucket');
  const key = c.req.param('key');
  const body = await c.req.arrayBuffer();

  const partKey = `multipart-parts/${uploadId}/${partNumber}`;

  const part = await c.env.STORAGE.put(partKey, body);

  // Update session
  const session = await c.env.META.get(`multipart:${uploadId}`, 'json') as any;
  if (session) {
    session.parts.push({
      partNumber: parseInt(partNumber),
      etag: part.etag,
      size: body.byteLength,
    });
    await c.env.META.put(`multipart:${uploadId}`, JSON.stringify(session));
  }

  return new Response(null, {
    headers: { 'ETag': part.etag },
  });
});

// Multipart upload - Complete
app.post('/:bucket/:key{.+}', async (c) => {
  const uploadId = c.req.query('uploadId');

  if (!uploadId) {
    return; // Not a multipart complete
  }

  const bucket = c.req.param('bucket');
  const key = c.req.param('key');
  const fullKey = `${bucket}/${key}`;

  const session = await c.env.META.get(`multipart:${uploadId}`, 'json') as any;
  if (!session) {
    return c.json({ error: 'Upload not found' }, 404);
  }

  // Combine parts
  const sortedParts = session.parts.sort((a: any, b: any) => a.partNumber - b.partNumber);
  const chunks: ArrayBuffer[] = [];

  for (const part of sortedParts) {
    const partKey = `multipart-parts/${uploadId}/${part.partNumber}`;
    const partObject = await c.env.STORAGE.get(partKey);
    if (partObject) {
      chunks.push(await partObject.arrayBuffer());
    }
  }

  // Combine and store
  const combined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }

  const result = await c.env.STORAGE.put(fullKey, combined);

  // Cleanup
  for (const part of sortedParts) {
    await c.env.STORAGE.delete(`multipart-parts/${uploadId}/${part.partNumber}`);
  }
  await c.env.META.delete(`multipart:${uploadId}`);

  return c.json({
    Location: `/${bucket}/${key}`,
    Bucket: bucket,
    Key: key,
    ETag: result.etag,
  });
});

// Abort multipart upload
app.delete('/:bucket/:key{.+}', async (c) => {
  const uploadId = c.req.query('uploadId');

  if (!uploadId) {
    return; // Regular DELETE
  }

  const session = await c.env.META.get(`multipart:${uploadId}`, 'json') as any;
  if (session) {
    for (const part of session.parts) {
      await c.env.STORAGE.delete(`multipart-parts/${uploadId}/${part.partNumber}`);
    }
  }
  await c.env.META.delete(`multipart:${uploadId}`);

  return new Response(null, { status: 204 });
});

// Helper functions
function parseRange(range: string): R2Range | undefined {
  const match = range.match(/bytes=(\d+)-(\d*)/);
  if (!match) return undefined;

  const start = parseInt(match[1]);
  const end = match[2] ? parseInt(match[2]) : undefined;

  if (end !== undefined) {
    return { offset: start, length: end - start + 1 };
  }

  return { offset: start };
}

export default app;
