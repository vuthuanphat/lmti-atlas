export const DRIVE_ERROR_CODES = [
  "DRIVE_INVALID_REQUEST", "DRIVE_INVALID_RESPONSE", "DRIVE_NOT_CONNECTED",
  "DRIVE_ALREADY_SELECTED", "DRIVE_SCOPE_DENIED", "DRIVE_ACCESS_DENIED",
  "DRIVE_AUTH_REQUIRED", "DRIVE_NOT_FOUND", "DRIVE_UNSUPPORTED", "DRIVE_CHANGED",
  "DRIVE_LIMIT_EXCEEDED", "DRIVE_TIMEOUT", "DRIVE_CANCELLED", "DRIVE_BUSY",
  "DRIVE_UNAVAILABLE", "DRIVE_RATE_LIMITED", "DRIVE_CURSOR_INVALID"
] as const;
export type DriveErrorCode = typeof DRIVE_ERROR_CODES[number];

/** Errors contain a fixed code, never provider bodies, URLs or credentials. */
export class DriveError extends Error {
  readonly code: DriveErrorCode;
  constructor(code: DriveErrorCode) {
    const safe = DRIVE_ERROR_CODES.includes(code) ? code : "DRIVE_UNAVAILABLE";
    super(safe);
    this.name = "DriveError";
    this.code = safe;
  }
}
export interface DriveAccount { id: string; displayName: string; }
export interface DriveItem {
  id: string; name: string; mimeType: string; version: string; modifiedTime?: string;
  canDownload: boolean; kind: "folder" | "document" | "unsupported"; readable: boolean;
}
export interface DrivePage {
  folder: DriveItem; files: DriveItem[]; nextCursor?: string; partial: boolean; checkedAt: string;
}
export interface DriveRead {
  file: DriveItem; text: string;
  /** SHA-256 of emitted text encoded as UTF-8, after decoding removes any UTF-8 BOM. */
  contentHash: string; checkedAt: string; scopeId: string;
}
