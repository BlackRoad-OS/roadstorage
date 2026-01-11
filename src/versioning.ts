/**
 * RoadStorage Object Versioning
 *
 * Features:
 * - Automatic version creation on updates
 * - Version listing and retrieval
 * - Rollback to previous versions
 * - Version deletion policies
 * - Soft delete with recovery
 * - Version metadata
 */

interface ObjectVersion {
  versionId: string;
  key: string;
  size: number;
  etag: string;
  contentType: string;
  uploadedAt: number;
  isLatest: boolean;
  isDeleteMarker: boolean;
  metadata?: Record<string, string>;
  uploadedBy?: string;
}

interface VersioningConfig {
  enabled: boolean;
  maxVersions: number; // 0 = unlimited
  retentionDays: number; // Days to keep old versions
  deleteMarkerRetentionDays: number;
}

interface VersionListResult {
  key: string;
  versions: ObjectVersion[];
  deleteMarkers: ObjectVersion[];
  currentVersion?: ObjectVersion;
}

interface VersionDiff {
  versionA: string;
  versionB: string;
  sizeChange: number;
  contentChanged: boolean;
  metadataChanges: {
    added: string[];
    removed: string[];
    modified: string[];
  };
}

/**
 * Versioning Manager
 */
export class VersioningManager {
  private bucket: R2Bucket;
  private meta: KVNamespace;
  private config: VersioningConfig;

  constructor(
    bucket: R2Bucket,
    meta: KVNamespace,
    config: Partial<VersioningConfig> = {},
  ) {
    this.bucket = bucket;
    this.meta = meta;
    this.config = {
      enabled: true,
      maxVersions: 100,
      retentionDays: 90,
      deleteMarkerRetentionDays: 30,
      ...config,
    };
  }

  /**
   * Put object with versioning
   */
  async putVersion(
    key: string,
    body: ArrayBuffer,
    options: {
      contentType?: string;
      metadata?: Record<string, string>;
      uploadedBy?: string;
    } = {},
  ): Promise<ObjectVersion> {
    if (!this.config.enabled) {
      // Just put without versioning
      const result = await this.bucket.put(key, body, {
        httpMetadata: { contentType: options.contentType || 'application/octet-stream' },
        customMetadata: options.metadata,
      });

      return {
        versionId: 'null',
        key,
        size: body.byteLength,
        etag: result.etag,
        contentType: options.contentType || 'application/octet-stream',
        uploadedAt: Date.now(),
        isLatest: true,
        isDeleteMarker: false,
        metadata: options.metadata,
        uploadedBy: options.uploadedBy,
      };
    }

    // Generate version ID
    const versionId = this.generateVersionId();
    const versionedKey = this.getVersionedKey(key, versionId);

    // Store the versioned object
    const result = await this.bucket.put(versionedKey, body, {
      httpMetadata: { contentType: options.contentType || 'application/octet-stream' },
      customMetadata: {
        ...options.metadata,
        _versionId: versionId,
        _originalKey: key,
        _uploadedBy: options.uploadedBy || '',
      },
    });

    const version: ObjectVersion = {
      versionId,
      key,
      size: body.byteLength,
      etag: result.etag,
      contentType: options.contentType || 'application/octet-stream',
      uploadedAt: Date.now(),
      isLatest: true,
      isDeleteMarker: false,
      metadata: options.metadata,
      uploadedBy: options.uploadedBy,
    };

    // Update version index
    await this.updateVersionIndex(key, version);

    // Also store at the main key for latest access
    await this.bucket.put(key, body, {
      httpMetadata: { contentType: options.contentType || 'application/octet-stream' },
      customMetadata: {
        ...options.metadata,
        _currentVersionId: versionId,
      },
    });

    // Cleanup old versions if needed
    await this.cleanupOldVersions(key);

    return version;
  }

  /**
   * Get specific version
   */
  async getVersion(key: string, versionId?: string): Promise<{
    body: ReadableStream<Uint8Array>;
    version: ObjectVersion;
  } | null> {
    let objectKey: string;
    let actualVersionId: string;

    if (versionId && versionId !== 'null') {
      objectKey = this.getVersionedKey(key, versionId);
      actualVersionId = versionId;
    } else {
      // Get latest
      const current = await this.bucket.head(key);
      if (!current) return null;

      actualVersionId = current.customMetadata?._currentVersionId || 'null';
      objectKey = actualVersionId !== 'null'
        ? this.getVersionedKey(key, actualVersionId)
        : key;
    }

    const object = await this.bucket.get(objectKey);
    if (!object) return null;

    const version: ObjectVersion = {
      versionId: actualVersionId,
      key,
      size: object.size,
      etag: object.etag,
      contentType: object.httpMetadata?.contentType || 'application/octet-stream',
      uploadedAt: object.uploaded.getTime(),
      isLatest: !versionId,
      isDeleteMarker: false,
      metadata: object.customMetadata as Record<string, string>,
    };

    return { body: object.body, version };
  }

  /**
   * List all versions of an object
   */
  async listVersions(key: string): Promise<VersionListResult> {
    const indexKey = `versions:${key}`;
    const indexData = await this.meta.get(indexKey, 'json') as ObjectVersion[] | null;

    const versions = indexData || [];
    const deleteMarkers = versions.filter(v => v.isDeleteMarker);
    const regularVersions = versions.filter(v => !v.isDeleteMarker);

    return {
      key,
      versions: regularVersions.sort((a, b) => b.uploadedAt - a.uploadedAt),
      deleteMarkers,
      currentVersion: regularVersions.find(v => v.isLatest),
    };
  }

  /**
   * Delete with versioning (creates delete marker)
   */
  async deleteVersion(
    key: string,
    versionId?: string,
    permanent: boolean = false,
  ): Promise<{ deleteMarker?: ObjectVersion; deleted: boolean }> {
    if (versionId && permanent) {
      // Permanently delete specific version
      const versionedKey = this.getVersionedKey(key, versionId);
      await this.bucket.delete(versionedKey);
      await this.removeFromVersionIndex(key, versionId);

      return { deleted: true };
    }

    if (!this.config.enabled || permanent) {
      // Hard delete
      await this.bucket.delete(key);
      return { deleted: true };
    }

    // Create delete marker
    const deleteMarkerId = this.generateVersionId();
    const deleteMarker: ObjectVersion = {
      versionId: deleteMarkerId,
      key,
      size: 0,
      etag: '',
      contentType: '',
      uploadedAt: Date.now(),
      isLatest: true,
      isDeleteMarker: true,
    };

    await this.updateVersionIndex(key, deleteMarker);

    // Remove the main key (but keep versions)
    await this.bucket.delete(key);

    return { deleteMarker, deleted: true };
  }

  /**
   * Restore a deleted object
   */
  async restoreVersion(key: string, versionId: string): Promise<ObjectVersion> {
    const versionResult = await this.getVersion(key, versionId);
    if (!versionResult) {
      throw new Error(`Version ${versionId} not found`);
    }

    // Read the entire body
    const body = await new Response(versionResult.body).arrayBuffer();

    // Create new version (copy of old one)
    return this.putVersion(key, body, {
      contentType: versionResult.version.contentType,
      metadata: versionResult.version.metadata,
    });
  }

  /**
   * Rollback to a specific version
   */
  async rollback(key: string, versionId: string): Promise<ObjectVersion> {
    return this.restoreVersion(key, versionId);
  }

  /**
   * Compare two versions
   */
  async compareVersions(
    key: string,
    versionIdA: string,
    versionIdB: string,
  ): Promise<VersionDiff> {
    const [versionA, versionB] = await Promise.all([
      this.getVersion(key, versionIdA),
      this.getVersion(key, versionIdB),
    ]);

    if (!versionA || !versionB) {
      throw new Error('One or both versions not found');
    }

    const metadataA = versionA.version.metadata || {};
    const metadataB = versionB.version.metadata || {};

    const allKeys = new Set([...Object.keys(metadataA), ...Object.keys(metadataB)]);
    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];

    for (const key of allKeys) {
      if (key.startsWith('_')) continue; // Skip internal keys

      if (!(key in metadataA)) {
        added.push(key);
      } else if (!(key in metadataB)) {
        removed.push(key);
      } else if (metadataA[key] !== metadataB[key]) {
        modified.push(key);
      }
    }

    return {
      versionA: versionIdA,
      versionB: versionIdB,
      sizeChange: versionB.version.size - versionA.version.size,
      contentChanged: versionA.version.etag !== versionB.version.etag,
      metadataChanges: { added, removed, modified },
    };
  }

  /**
   * Get version history with pagination
   */
  async getVersionHistory(
    key: string,
    options: {
      limit?: number;
      startAfter?: string;
      includeDeleteMarkers?: boolean;
    } = {},
  ): Promise<{
    versions: ObjectVersion[];
    hasMore: boolean;
    nextToken?: string;
  }> {
    const { limit = 50, startAfter, includeDeleteMarkers = false } = options;

    const result = await this.listVersions(key);
    let versions = includeDeleteMarkers
      ? [...result.versions, ...result.deleteMarkers]
      : result.versions;

    // Sort by uploadedAt descending
    versions.sort((a, b) => b.uploadedAt - a.uploadedAt);

    // Apply startAfter
    if (startAfter) {
      const startIndex = versions.findIndex(v => v.versionId === startAfter);
      if (startIndex >= 0) {
        versions = versions.slice(startIndex + 1);
      }
    }

    // Apply limit
    const hasMore = versions.length > limit;
    versions = versions.slice(0, limit);

    return {
      versions,
      hasMore,
      nextToken: hasMore ? versions[versions.length - 1].versionId : undefined,
    };
  }

  /**
   * Update versioning configuration
   */
  async setConfig(config: Partial<VersioningConfig>): Promise<void> {
    this.config = { ...this.config, ...config };
    await this.meta.put('versioning:config', JSON.stringify(this.config));
  }

  /**
   * Get versioning configuration
   */
  async getConfig(): Promise<VersioningConfig> {
    const stored = await this.meta.get('versioning:config', 'json') as VersioningConfig | null;
    if (stored) {
      this.config = stored;
    }
    return this.config;
  }

  // Private helper methods

  private generateVersionId(): string {
    // Time-based + random for sortability and uniqueness
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    return `${timestamp}-${random}`;
  }

  private getVersionedKey(key: string, versionId: string): string {
    return `_versions/${key}/${versionId}`;
  }

  private async updateVersionIndex(key: string, version: ObjectVersion): Promise<void> {
    const indexKey = `versions:${key}`;
    const existing = await this.meta.get(indexKey, 'json') as ObjectVersion[] | null;

    const versions = existing || [];

    // Mark all existing as not latest
    for (const v of versions) {
      v.isLatest = false;
    }

    // Add new version
    versions.push(version);

    // Sort by uploadedAt descending
    versions.sort((a, b) => b.uploadedAt - a.uploadedAt);

    // Save
    await this.meta.put(indexKey, JSON.stringify(versions), {
      expirationTtl: 86400 * this.config.retentionDays,
    });
  }

  private async removeFromVersionIndex(key: string, versionId: string): Promise<void> {
    const indexKey = `versions:${key}`;
    const existing = await this.meta.get(indexKey, 'json') as ObjectVersion[] | null;

    if (!existing) return;

    const filtered = existing.filter(v => v.versionId !== versionId);

    // Update latest flag
    if (filtered.length > 0) {
      filtered.sort((a, b) => b.uploadedAt - a.uploadedAt);
      filtered[0].isLatest = true;
    }

    await this.meta.put(indexKey, JSON.stringify(filtered));
  }

  private async cleanupOldVersions(key: string): Promise<void> {
    if (this.config.maxVersions === 0) return;

    const result = await this.listVersions(key);
    const versions = result.versions;

    if (versions.length <= this.config.maxVersions) return;

    // Get versions to delete (oldest first)
    const toDelete = versions
      .filter(v => !v.isLatest)
      .slice(this.config.maxVersions - 1);

    for (const version of toDelete) {
      await this.deleteVersion(key, version.versionId, true);
    }
  }
}

/**
 * Lifecycle Policy Manager
 */
export class VersionLifecycleManager {
  private versioning: VersioningManager;
  private meta: KVNamespace;

  constructor(versioning: VersioningManager, meta: KVNamespace) {
    this.versioning = versioning;
    this.meta = meta;
  }

  /**
   * Apply lifecycle policies
   */
  async applyPolicies(): Promise<{
    deletedVersions: number;
    deletedMarkers: number;
  }> {
    const config = await this.versioning.getConfig();
    let deletedVersions = 0;
    let deletedMarkers = 0;

    // Get all version indexes
    const list = await this.meta.list({ prefix: 'versions:' });

    for (const item of list.keys) {
      const key = item.name.replace('versions:', '');
      const result = await this.versioning.listVersions(key);

      const now = Date.now();
      const versionCutoff = now - config.retentionDays * 86400 * 1000;
      const markerCutoff = now - config.deleteMarkerRetentionDays * 86400 * 1000;

      // Delete old versions
      for (const version of result.versions) {
        if (!version.isLatest && version.uploadedAt < versionCutoff) {
          await this.versioning.deleteVersion(key, version.versionId, true);
          deletedVersions++;
        }
      }

      // Delete old delete markers
      for (const marker of result.deleteMarkers) {
        if (marker.uploadedAt < markerCutoff) {
          await this.versioning.deleteVersion(key, marker.versionId, true);
          deletedMarkers++;
        }
      }
    }

    return { deletedVersions, deletedMarkers };
  }
}

/**
 * Version Audit Logger
 */
export class VersionAuditLogger {
  private meta: KVNamespace;

  constructor(meta: KVNamespace) {
    this.meta = meta;
  }

  async log(
    action: 'create' | 'get' | 'delete' | 'restore' | 'rollback',
    key: string,
    versionId: string,
    userId?: string,
    details?: Record<string, any>,
  ): Promise<void> {
    const entry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      action,
      key,
      versionId,
      userId,
      details,
    };

    const logKey = `audit:${entry.timestamp}:${entry.id}`;
    await this.meta.put(logKey, JSON.stringify(entry), {
      expirationTtl: 86400 * 90, // 90 days
    });
  }

  async getAuditLog(
    key?: string,
    limit: number = 100,
  ): Promise<Array<{
    id: string;
    timestamp: number;
    action: string;
    key: string;
    versionId: string;
    userId?: string;
  }>> {
    const list = await this.meta.list({ prefix: 'audit:', limit: limit * 2 });
    const entries = [];

    for (const item of list.keys) {
      const data = await this.meta.get(item.name, 'json');
      if (data) {
        if (!key || (data as any).key === key) {
          entries.push(data);
        }
      }
      if (entries.length >= limit) break;
    }

    return entries
      .sort((a: any, b: any) => b.timestamp - a.timestamp)
      .slice(0, limit) as any;
  }
}
