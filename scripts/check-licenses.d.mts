export const ALLOWED_LICENSES: readonly string[];

export function createLicenseInventory(lockfileBytes: Buffer): {
  readonly schemaVersion: number;
  readonly lockfile: { readonly fileName: string; readonly sha256: string };
  readonly policy: {
    readonly allowedLicenses: readonly string[];
    readonly reviewedException: {
      readonly packagePattern: string;
      readonly declaredLicense: string;
      readonly restriction: string;
    };
  };
  readonly summary: {
    readonly packageInstances: number;
    readonly directDevelopment: number;
    readonly production: number;
    readonly reviewedExceptions: number;
  };
  readonly packages: readonly {
    readonly name: string;
    readonly version: string;
    readonly license: string;
    readonly development: boolean;
    readonly optional: boolean;
    readonly direct: boolean;
    readonly reviewedException: boolean;
  }[];
};
