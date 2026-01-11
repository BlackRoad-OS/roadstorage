# RoadStorage

S3-compatible object storage for the BlackRoad ecosystem.

## Features

- **S3-Compatible API** - Works with existing S3 tools
- **R2 Backend** - Cloudflare R2 for storage
- **Presigned URLs** - Secure temporary access
- **Multipart Uploads** - Large file support
- **Range Requests** - Partial content delivery
- **Custom Metadata** - Attach metadata to objects

## Quick Start

```bash
npm install
wrangler deploy
```

## API Endpoints

### Buckets
- `GET /buckets` - List buckets
- `PUT /buckets/:name` - Create bucket
- `DELETE /buckets/:name` - Delete bucket

### Objects
- `GET /:bucket` - List objects
- `GET /:bucket/:key` - Get object
- `PUT /:bucket/:key` - Upload object
- `DELETE /:bucket/:key` - Delete object
- `HEAD /:bucket/:key` - Get object metadata

### Advanced
- `POST /presign` - Generate presigned URL
- Multipart upload support (S3-compatible)

## Usage Examples

### Upload
```bash
curl -X PUT \
  -H "Content-Type: image/png" \
  --data-binary @photo.png \
  https://roadstorage.blackroad.io/mybucket/photos/photo.png
```

### Download
```bash
curl https://roadstorage.blackroad.io/mybucket/photos/photo.png
```

### Presigned URL
```bash
curl -X POST https://roadstorage.blackroad.io/presign \
  -d '{"bucket": "mybucket", "key": "photos/photo.png", "method": "GET"}'
```

### Custom Metadata
```bash
curl -X PUT \
  -H "x-amz-meta-author: john" \
  -H "x-amz-meta-created: 2024-01-01" \
  --data-binary @file.txt \
  https://roadstorage.blackroad.io/mybucket/file.txt
```

## License

Proprietary - BlackRoad OS, Inc.
