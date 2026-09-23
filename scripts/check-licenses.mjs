import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWED_LICENSES = Object.freeze([
  "0BSD",
  "Apache-2.0",
  "Artistic-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "ISC",
  "MIT",
  "MPL-2.0",
]);

const REVIEWED_VSCE_SIGN_LICENSE = "SEE LICENSE IN LICENSE.txt";
const VSCE_SIGN_PACKAGE = /^@vscode\/vsce-sign(?:-|$)/u;

export function createLicenseInventory(lockfileBytes) {
  const lock = JSON.parse(lockfileBytes.toString("utf8"));
  if (lock.lockfileVersion !== 3 || !isRecord(lock.packages)) {
    throw new Error("Expected an npm lockfileVersion 3 package graph.");
  }
  const root = lock.packages[""];
  if (!isRecord(root)) throw new Error("Lockfile root package is missing.");
  const directDevelopment = new Set(Object.keys(root.devDependencies ?? {}));
  const directProduction = new Set(Object.keys(root.dependencies ?? {}));
  const packages = [];
  for (const [packagePath, value] of Object.entries(lock.packages)) {
    if (packagePath === "") continue;
    if (!isRecord(value))
      throw new Error(`Invalid lockfile entry: ${packagePath}`);
    const name = packageNameFromPath(packagePath);
    if (typeof value.version !== "string" || value.version === "") {
      throw new Error(`Dependency version is missing: ${name}`);
    }
    if (typeof value.license !== "string" || value.license === "") {
      throw new Error(
        `Dependency license is missing: ${name}@${value.version}`,
      );
    }
    const reviewedException = VSCE_SIGN_PACKAGE.test(name);
    if (reviewedException) {
      if (value.license !== REVIEWED_VSCE_SIGN_LICENSE || value.dev !== true) {
        throw new Error(
          `Invalid reviewed vsce-sign exception: ${name}@${value.version}`,
        );
      }
    } else if (!ALLOWED_LICENSES.includes(value.license)) {
      throw new Error(
        `Unreviewed dependency license ${value.license}: ${name}@${value.version}`,
      );
    }
    const topLevel = packagePath === `node_modules/${name}`;
    packages.push({
      name,
      version: value.version,
      license: value.license,
      development: value.dev === true,
      optional: value.optional === true,
      direct:
        topLevel && (directDevelopment.has(name) || directProduction.has(name)),
      reviewedException,
    });
  }
  packages.sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
  const productionPackages = packages.filter((entry) => !entry.development);
  if (productionPackages.length !== 0) {
    throw new Error(
      `Unexpected production dependencies: ${productionPackages.map(({ name, version }) => `${name}@${version}`).join(", ")}`,
    );
  }
  return {
    schemaVersion: 1,
    lockfile: {
      fileName: "package-lock.json",
      sha256: createHash("sha256").update(lockfileBytes).digest("hex"),
    },
    policy: {
      allowedLicenses: ALLOWED_LICENSES,
      reviewedException: {
        packagePattern: "@vscode/vsce-sign*",
        declaredLicense: REVIEWED_VSCE_SIGN_LICENSE,
        restriction:
          "Development-only use with the VS Code Marketplace toolchain; not distributed in the VSIX.",
      },
    },
    summary: {
      packageInstances: packages.length,
      directDevelopment: packages.filter(
        (entry) => entry.direct && entry.development,
      ).length,
      production: productionPackages.length,
      reviewedExceptions: packages.filter((entry) => entry.reviewedException)
        .length,
    },
    packages,
  };
}

function packageNameFromPath(packagePath) {
  const marker = "node_modules/";
  const index = packagePath.lastIndexOf(marker);
  if (index < 0)
    throw new Error(`Invalid lockfile package path: ${packagePath}`);
  return packagePath.slice(index + marker.length);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main() {
  const root = process.cwd();
  const lockfileBytes = await readFile(path.join(root, "package-lock.json"));
  const inventory = createLicenseInventory(lockfileBytes);
  const outputArgument = process.argv[2];
  if (outputArgument !== undefined) {
    const output = path.resolve(root, outputArgument);
    await writeFile(output, `${JSON.stringify(inventory, null, 2)}\n`, {
      mode: 0o600,
    });
    console.log(`License inventory: ${output}`);
  }
  console.log(
    `License policy passed: ${inventory.summary.packageInstances} development package instances, ${inventory.summary.reviewedExceptions} reviewed tool exceptions, no production dependencies.`,
  );
}

const invokedPath =
  process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
