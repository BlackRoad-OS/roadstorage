"""
RoadStorage - Object Storage for BlackRoad
Abstract storage interface for files and objects.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, BinaryIO, Callable, Dict, Generator, List, Optional, Union
import hashlib
import io
import json
import logging
import os
import threading
import uuid

logger = logging.getLogger(__name__)


class StorageClass(str, Enum):
    STANDARD = "standard"
    INFREQUENT = "infrequent"
    ARCHIVE = "archive"


@dataclass
class ObjectMetadata:
    key: str
    size: int
    content_type: str = "application/octet-stream"
    etag: str = ""
    last_modified: datetime = field(default_factory=datetime.now)
    storage_class: StorageClass = StorageClass.STANDARD
    metadata: Dict[str, str] = field(default_factory=dict)


@dataclass
class StorageObject:
    key: str
    data: bytes
    metadata: ObjectMetadata

    @property
    def size(self) -> int:
        return len(self.data)


@dataclass
class ListResult:
    objects: List[ObjectMetadata]
    prefixes: List[str]
    is_truncated: bool
    next_token: Optional[str] = None


class StorageBackend:
    def put(self, key: str, data: bytes, **kwargs) -> ObjectMetadata:
        raise NotImplementedError

    def get(self, key: str) -> Optional[StorageObject]:
        raise NotImplementedError

    def delete(self, key: str) -> bool:
        raise NotImplementedError

    def exists(self, key: str) -> bool:
        raise NotImplementedError

    def list(self, prefix: str = "", delimiter: str = "", max_keys: int = 1000) -> ListResult:
        raise NotImplementedError


class MemoryBackend(StorageBackend):
    def __init__(self):
        self.objects: Dict[str, StorageObject] = {}
        self._lock = threading.Lock()

    def put(self, key: str, data: bytes, content_type: str = "application/octet-stream", **kwargs) -> ObjectMetadata:
        etag = hashlib.md5(data).hexdigest()
        metadata = ObjectMetadata(
            key=key,
            size=len(data),
            content_type=content_type,
            etag=etag,
            metadata=kwargs.get("metadata", {})
        )
        obj = StorageObject(key=key, data=data, metadata=metadata)
        
        with self._lock:
            self.objects[key] = obj
        
        return metadata

    def get(self, key: str) -> Optional[StorageObject]:
        return self.objects.get(key)

    def delete(self, key: str) -> bool:
        with self._lock:
            if key in self.objects:
                del self.objects[key]
                return True
            return False

    def exists(self, key: str) -> bool:
        return key in self.objects

    def list(self, prefix: str = "", delimiter: str = "", max_keys: int = 1000) -> ListResult:
        objects = []
        prefixes = set()
        
        for key, obj in self.objects.items():
            if not key.startswith(prefix):
                continue
            
            if delimiter:
                suffix = key[len(prefix):]
                if delimiter in suffix:
                    common_prefix = prefix + suffix.split(delimiter)[0] + delimiter
                    prefixes.add(common_prefix)
                    continue
            
            objects.append(obj.metadata)
            if len(objects) >= max_keys:
                break
        
        return ListResult(
            objects=objects,
            prefixes=sorted(prefixes),
            is_truncated=len(objects) >= max_keys
        )


class FileBackend(StorageBackend):
    def __init__(self, base_path: str):
        self.base_path = base_path
        os.makedirs(base_path, exist_ok=True)

    def _get_path(self, key: str) -> str:
        return os.path.join(self.base_path, key)

    def put(self, key: str, data: bytes, content_type: str = "application/octet-stream", **kwargs) -> ObjectMetadata:
        path = self._get_path(key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        
        with open(path, "wb") as f:
            f.write(data)
        
        etag = hashlib.md5(data).hexdigest()
        return ObjectMetadata(
            key=key,
            size=len(data),
            content_type=content_type,
            etag=etag,
            metadata=kwargs.get("metadata", {})
        )

    def get(self, key: str) -> Optional[StorageObject]:
        path = self._get_path(key)
        if not os.path.exists(path):
            return None
        
        with open(path, "rb") as f:
            data = f.read()
        
        stat = os.stat(path)
        metadata = ObjectMetadata(
            key=key,
            size=stat.st_size,
            etag=hashlib.md5(data).hexdigest(),
            last_modified=datetime.fromtimestamp(stat.st_mtime)
        )
        
        return StorageObject(key=key, data=data, metadata=metadata)

    def delete(self, key: str) -> bool:
        path = self._get_path(key)
        if os.path.exists(path):
            os.remove(path)
            return True
        return False

    def exists(self, key: str) -> bool:
        return os.path.exists(self._get_path(key))

    def list(self, prefix: str = "", delimiter: str = "", max_keys: int = 1000) -> ListResult:
        objects = []
        prefixes = set()
        
        for root, dirs, files in os.walk(self.base_path):
            for file in files:
                full_path = os.path.join(root, file)
                key = os.path.relpath(full_path, self.base_path)
                
                if not key.startswith(prefix):
                    continue
                
                stat = os.stat(full_path)
                objects.append(ObjectMetadata(
                    key=key,
                    size=stat.st_size,
                    last_modified=datetime.fromtimestamp(stat.st_mtime)
                ))
                
                if len(objects) >= max_keys:
                    break
        
        return ListResult(objects=objects, prefixes=sorted(prefixes), is_truncated=len(objects) >= max_keys)


class Storage:
    def __init__(self, backend: StorageBackend = None, bucket: str = "default"):
        self.backend = backend or MemoryBackend()
        self.bucket = bucket
        self.hooks: Dict[str, List[Callable]] = {
            "before_put": [], "after_put": [],
            "before_get": [], "after_get": [],
            "before_delete": [], "after_delete": []
        }

    def add_hook(self, event: str, handler: Callable) -> None:
        if event in self.hooks:
            self.hooks[event].append(handler)

    def _emit(self, event: str, key: str, data: Any = None) -> None:
        for handler in self.hooks.get(event, []):
            try:
                handler(key, data)
            except Exception as e:
                logger.error(f"Hook error: {e}")

    def put(self, key: str, data: Union[bytes, str, BinaryIO], **kwargs) -> ObjectMetadata:
        if isinstance(data, str):
            data = data.encode("utf-8")
            kwargs.setdefault("content_type", "text/plain")
        elif hasattr(data, "read"):
            data = data.read()
        
        self._emit("before_put", key, data)
        result = self.backend.put(key, data, **kwargs)
        self._emit("after_put", key, result)
        return result

    def get(self, key: str) -> Optional[StorageObject]:
        self._emit("before_get", key)
        result = self.backend.get(key)
        self._emit("after_get", key, result)
        return result

    def get_string(self, key: str) -> Optional[str]:
        obj = self.get(key)
        if obj:
            return obj.data.decode("utf-8")
        return None

    def get_json(self, key: str) -> Optional[Any]:
        data = self.get_string(key)
        if data:
            return json.loads(data)
        return None

    def put_json(self, key: str, data: Any) -> ObjectMetadata:
        return self.put(key, json.dumps(data), content_type="application/json")

    def delete(self, key: str) -> bool:
        self._emit("before_delete", key)
        result = self.backend.delete(key)
        self._emit("after_delete", key, result)
        return result

    def exists(self, key: str) -> bool:
        return self.backend.exists(key)

    def list(self, prefix: str = "", **kwargs) -> ListResult:
        return self.backend.list(prefix, **kwargs)

    def copy(self, source: str, dest: str) -> Optional[ObjectMetadata]:
        obj = self.get(source)
        if obj:
            return self.put(dest, obj.data, content_type=obj.metadata.content_type)
        return None

    def move(self, source: str, dest: str) -> Optional[ObjectMetadata]:
        result = self.copy(source, dest)
        if result:
            self.delete(source)
        return result

    def url(self, key: str, expires: int = 3600) -> str:
        return f"storage://{self.bucket}/{key}?expires={expires}"


def example_usage():
    storage = Storage(MemoryBackend())
    
    storage.put("hello.txt", "Hello, World!")
    storage.put("data/config.json", json.dumps({"key": "value"}), content_type="application/json")
    storage.put("images/logo.png", b"\x89PNG\r\n\x1a\n...", content_type="image/png")
    
    obj = storage.get("hello.txt")
    print(f"Content: {obj.data.decode()}")
    print(f"Size: {obj.metadata.size}")
    print(f"ETag: {obj.metadata.etag}")
    
    config = storage.get_json("data/config.json")
    print(f"Config: {config}")
    
    result = storage.list()
    print(f"\nAll objects ({len(result.objects)}):")
    for obj in result.objects:
        print(f"  {obj.key} ({obj.size} bytes)")
    
    storage.copy("hello.txt", "backup/hello.txt")
    print(f"\nCopied: {storage.exists('backup/hello.txt')}")
    
    storage.delete("hello.txt")
    print(f"Deleted: {not storage.exists('hello.txt')}")

