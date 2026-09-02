/**
 * Fixed import-upload safety contract shared by the Application Host and UI.
 *
 * These are protocol/security fences, not user settings: the frontend may
 * reject earlier for UX, while the server remains authoritative.
 */
export const MAX_IMPORT_FILES = 10;
export const MAX_IMPORT_FILE_BYTES = 500 * 1024 * 1024;
export const MAX_IMPORT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
