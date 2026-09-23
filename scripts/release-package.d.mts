export const EXPECTED_EXTENSION_ID: string;
export const EXPECTED_PAYLOAD_FILES: readonly string[];

export function validateManifest(value: unknown): {
  readonly extensionId: string;
  readonly version: string;
};
export function validatePayloadFiles(
  files: readonly string[],
): readonly string[];
export function validateArchiveFiles(
  files: readonly string[],
): readonly string[];
export function packageReleaseCandidate(options: {
  readonly root?: string;
  readonly outputDirectory?: string;
  readonly preRelease?: boolean;
}): Promise<{
  readonly schemaVersion: number;
  readonly extensionId: string;
  readonly version: string;
  readonly preRelease: boolean;
  readonly vsix: {
    readonly fileName: string;
    readonly bytes: number;
    readonly sha256: string;
  };
  readonly payloadFiles: readonly string[];
  readonly archiveFiles: readonly string[];
  readonly evidencePath: string;
  readonly vsixPath: string;
}>;
