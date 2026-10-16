export const CHECKSUMS_FILE: string
export function sha256File(path: string): string
export function checksumLines(directory: string, names: readonly string[]): string
export function writeChecksums(directory: string, names: readonly string[]): string
