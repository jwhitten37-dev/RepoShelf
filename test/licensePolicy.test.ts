import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_LICENSES,
  createLicenseInventory,
} from "../scripts/check-licenses.mjs";

const lockfile = readFileSync("package-lock.json");

describe("Phase 7 third-party license policy", () => {
  it("accepts the complete locked development graph", () => {
    const inventory = createLicenseInventory(lockfile);
    expect(inventory.summary.packageInstances).toBeGreaterThan(300);
    expect(inventory.summary.production).toBe(0);
    expect(inventory.summary.reviewedExceptions).toBe(10);
    expect(inventory.policy.allowedLicenses).toEqual(ALLOWED_LICENSES);
    expect(inventory.packages.every(({ development }) => development)).toBe(
      true,
    );
  });

  it("fails closed for missing or unreviewed licenses", () => {
    const dependency: { version: string; dev: boolean; license?: string } = {
      version: "1.0.0",
      dev: true,
    };
    const base = {
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: { example: "1.0.0" } },
        "node_modules/example": dependency,
      },
    };
    expect(() => inventory(base)).toThrow("license is missing");
    dependency.license = "GPL-3.0-only";
    expect(() => inventory(base)).toThrow("Unreviewed dependency license");
  });

  it("limits the package-specific exception to development-only vsce-sign tools", () => {
    const makeLock = (name: string, dev: boolean) => ({
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: { [name]: "1.0.0" } },
        [`node_modules/${name}`]: {
          version: "1.0.0",
          dev,
          license: "SEE LICENSE IN LICENSE.txt",
        },
      },
    });
    expect(() => inventory(makeLock("unrelated", true))).toThrow("Unreviewed");
    expect(() => inventory(makeLock("@vscode/vsce-sign", false))).toThrow(
      "Invalid reviewed vsce-sign exception",
    );
  });
});

function inventory(value: unknown) {
  return createLicenseInventory(Buffer.from(JSON.stringify(value)));
}
