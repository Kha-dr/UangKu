const DRIVE_DB_FILENAME = 'kasin.sqlite';
const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const SQLITE_MIME_TYPE = 'application/x-sqlite3';
const JSON_MIME_TYPE = 'application/json';

export const COMPACT_THRESHOLD = 50;

export interface DriveFileMeta {
  id: string;
  name: string;
  modifiedTime?: string;
  size?: string;
}

export interface DeltaFileMeta {
  id: string;
  name: string;
  modifiedTime?: string;
  size?: string;
}

export type DeltaBindValue = string | number | null;

export interface DeltaOp {
  sql: string;
  bind: DeltaBindValue[];
  relasiRefIndex?: number;
  relasiParamIndex?: number;
}

export interface DeltaFilePayload {
  v: 1;
  id: string;
  ts: string;
  ops: DeltaOp[];
}

export interface LoadedDriveSqlite {
  fileId: string | null;
  modifiedTime: string | null;
  bytes: Uint8Array | null;
}

export interface SavedDriveSqlite {
  fileId: string;
  modifiedTime: string | null;
}

export interface UploadedDeltaFile {
  fileId: string;
  name: string;
  modifiedTime: string | null;
  payload: DeltaFilePayload;
}

export interface LoadedDelta {
  fileId: string;
  name: string;
  modifiedTime: string | null;
  payload: DeltaFilePayload;
}

export interface LoadedSqliteWithDeltas {
  snapshot: LoadedDriveSqlite;
  deltas: LoadedDelta[];
}

export class UnauthorizedError extends Error {
  readonly status = 401;

  constructor(message = 'Google Drive access token is missing, invalid, or expired.') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ConflictError extends Error {
  readonly status = 409;

  constructor(message = 'Remote Google Drive database was modified concurrently. Please retry.') {
    super(message);
    this.name = 'ConflictError';
  }
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function driveFetch(url: string, accessToken: string, init: RequestInit = {}): Promise<Response> {
  if (!accessToken) {
    throw new UnauthorizedError();
  }

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);

  const response = await fetch(url, {
    ...init,
    headers
  });

  if (response.status === 401) {
    throw new UnauthorizedError('Google Drive returned 401 Unauthorized.');
  }

  if (!response.ok) {
    let detail = '';
    try {
      const text = await response.text();
      if (text) detail = `: ${text}`;
    } catch {
      detail = '';
    }
    throw new Error(`Google Drive API error (${response.status})${detail}`);
  }

  return response;
}

function buildMultipartBody(
  fileId: string | null,
  name: string,
  mimeType: string,
  bytes: Uint8Array
): { boundary: string; body: Blob } {
  const randomSuffix =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const boundary = `kasin_${randomSuffix}`;

  const metadata = fileId
    ? { name, mimeType }
    : { name, mimeType, parents: ['appDataFolder'] };

  const headerPart =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;
  const footerPart = `\r\n--${boundary}--`;

  const payloadCopy = new Uint8Array(bytes.byteLength);
  payloadCopy.set(bytes);

  const body = new Blob([headerPart, payloadCopy.buffer, footerPart], {
    type: `multipart/related; boundary=${boundary}`
  });

  return { boundary, body };
}

function generateRandomHex4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint8Array(2);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0');
}

function isDeltaAfterOrAtSnapshot(
  deltaModifiedTime: string | undefined,
  snapshotModifiedTime: string | null
): boolean {
  if (!snapshotModifiedTime || !deltaModifiedTime) {
    return true;
  }
  const deltaMs = Date.parse(deltaModifiedTime);
  const snapMs = Date.parse(snapshotModifiedTime);
  if (!Number.isNaN(deltaMs) && !Number.isNaN(snapMs)) {
    return deltaMs >= snapMs;
  }
  return deltaModifiedTime >= snapshotModifiedTime;
}

export async function findAppDataFile(
  accessToken: string,
  name: string = DRIVE_DB_FILENAME
): Promise<DriveFileMeta | null> {
  const escapedName = escapeDriveQueryValue(name);
  const query = `name = '${escapedName}' and trashed = false`;
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    q: query,
    fields: 'files(id,name,modifiedTime,size)',
    orderBy: 'modifiedTime desc',
    pageSize: '1'
  });

  const response = await driveFetch(`${DRIVE_FILES_API}?${params.toString()}`, accessToken);
  const data = (await response.json()) as { files?: DriveFileMeta[] };
  return data.files?.[0] ?? null;
}

export async function loadSqliteFromDrive(accessToken: string): Promise<LoadedDriveSqlite> {
  const file = await findAppDataFile(accessToken, DRIVE_DB_FILENAME);
  if (!file) {
    return {
      fileId: null,
      modifiedTime: null,
      bytes: null
    };
  }

  const response = await driveFetch(
    `${DRIVE_FILES_API}/${encodeURIComponent(file.id)}?alt=media`,
    accessToken
  );
  const buffer = await response.arrayBuffer();

  return {
    fileId: file.id,
    modifiedTime: file.modifiedTime ?? null,
    bytes: new Uint8Array(buffer)
  };
}

export async function saveSqliteToDrive(
  accessToken: string,
  bytes: Uint8Array,
  expectedFileId: string | null,
  expectedModifiedTime: string | null
): Promise<SavedDriveSqlite> {
  const remoteFile = await findAppDataFile(accessToken, DRIVE_DB_FILENAME);

  if (expectedFileId) {
    if (
      remoteFile &&
      expectedModifiedTime &&
      remoteFile.modifiedTime &&
      remoteFile.modifiedTime !== expectedModifiedTime
    ) {
      throw new ConflictError(
        `Optimistic lock conflict: expected modifiedTime=${expectedModifiedTime}, found=${remoteFile.modifiedTime}`
      );
    }
  } else if (remoteFile) {
    throw new ConflictError(
      'Optimistic lock conflict: kasin.sqlite already exists in Google Drive appDataFolder.'
    );
  }

  const targetFileId = expectedFileId ?? remoteFile?.id ?? null;
  const { boundary, body } = buildMultipartBody(
    targetFileId,
    DRIVE_DB_FILENAME,
    SQLITE_MIME_TYPE,
    bytes
  );

  const uploadUrl = targetFileId
    ? `${DRIVE_UPLOAD_API}/${encodeURIComponent(targetFileId)}?uploadType=multipart&fields=id,modifiedTime`
    : `${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id,modifiedTime`;

  const response = await driveFetch(uploadUrl, accessToken, {
    method: targetFileId ? 'PATCH' : 'POST',
    headers: {
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body
  });

  const saved = (await response.json()) as { id: string; modifiedTime?: string };
  return {
    fileId: saved.id,
    modifiedTime: saved.modifiedTime ?? null
  };
}

export async function listDeltaFiles(accessToken: string): Promise<DeltaFileMeta[]> {
  const files: DeltaFileMeta[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      q: "name contains 'delta_' and trashed = false",
      fields: 'nextPageToken,files(id,name,modifiedTime,size)',
      orderBy: 'name',
      pageSize: '1000'
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const response = await driveFetch(`${DRIVE_FILES_API}?${params.toString()}`, accessToken);
    const data = (await response.json()) as {
      nextPageToken?: string;
      files?: DeltaFileMeta[];
    };

    if (Array.isArray(data.files)) {
      for (const file of data.files) {
        if (file.name.startsWith('delta_') && file.name.endsWith('.json')) {
          files.push(file);
        }
      }
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return files;
}

export async function downloadJsonFile<T>(accessToken: string, fileId: string): Promise<T> {
  const response = await driveFetch(
    `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}?alt=media`,
    accessToken
  );
  return (await response.json()) as T;
}

export async function deleteAppDataFile(accessToken: string, fileId: string): Promise<void> {
  await driveFetch(`${DRIVE_FILES_API}/${encodeURIComponent(fileId)}`, accessToken, {
    method: 'DELETE'
  });
}

export async function uploadDeltaFile(
  accessToken: string,
  ops: DeltaOp[]
): Promise<UploadedDeltaFile> {
  const now = new Date();
  const iso = now.toISOString();
  const compactTs = iso.replace(/[-:.]/g, '');
  const id = `${compactTs}_${generateRandomHex4()}`;
  const filename = `delta_${id}.json`;

  const payload: DeltaFilePayload = {
    v: 1,
    id,
    ts: iso,
    ops
  };

  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const { boundary, body } = buildMultipartBody(null, filename, JSON_MIME_TYPE, bytes);

  const response = await driveFetch(
    `${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id,name,modifiedTime`,
    accessToken,
    {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body
    }
  );

  const saved = (await response.json()) as {
    id: string;
    name?: string;
    modifiedTime?: string;
  };

  return {
    fileId: saved.id,
    name: saved.name ?? filename,
    modifiedTime: saved.modifiedTime ?? null,
    payload
  };
}

export async function loadSqliteWithDeltas(
  accessToken: string
): Promise<LoadedSqliteWithDeltas> {
  const [snapshot, allDeltaFiles] = await Promise.all([
    loadSqliteFromDrive(accessToken),
    listDeltaFiles(accessToken)
  ]);

  const relevantFiles = snapshot.fileId
    ? allDeltaFiles.filter((f) => isDeltaAfterOrAtSnapshot(f.modifiedTime, snapshot.modifiedTime))
    : allDeltaFiles;

  const deltas = await Promise.all(
    relevantFiles.map(async (file): Promise<LoadedDelta> => {
      const payload = await downloadJsonFile<DeltaFilePayload>(accessToken, file.id);
      return {
        fileId: file.id,
        name: file.name,
        modifiedTime: file.modifiedTime ?? null,
        payload
      };
    })
  );

  deltas.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    snapshot,
    deltas
  };
}

export async function compactSnapshotToDrive(
  accessToken: string,
  bytes: Uint8Array,
  existingSnapshotFileId: string | null,
  deltaFileIds: string[]
): Promise<SavedDriveSqlite> {
  let targetFileId = existingSnapshotFileId;
  if (!targetFileId) {
    const remoteFile = await findAppDataFile(accessToken, DRIVE_DB_FILENAME);
    targetFileId = remoteFile?.id ?? null;
  }

  const { boundary, body } = buildMultipartBody(
    targetFileId,
    DRIVE_DB_FILENAME,
    SQLITE_MIME_TYPE,
    bytes
  );

  const uploadUrl = targetFileId
    ? `${DRIVE_UPLOAD_API}/${encodeURIComponent(targetFileId)}?uploadType=multipart&fields=id,modifiedTime`
    : `${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id,modifiedTime`;

  const response = await driveFetch(uploadUrl, accessToken, {
    method: targetFileId ? 'PATCH' : 'POST',
    headers: {
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body
  });

  const saved = (await response.json()) as { id: string; modifiedTime?: string };

  if (deltaFileIds.length > 0) {
    await Promise.allSettled(
      deltaFileIds.map((fileId) => deleteAppDataFile(accessToken, fileId))
    );
  }

  return {
    fileId: saved.id,
    modifiedTime: saved.modifiedTime ?? null
  };
}
