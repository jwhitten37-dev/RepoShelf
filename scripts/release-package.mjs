import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { PackageManager, createVSIX, listFiles } from "@vscode/vsce";

export const EXPECTED_EXTENSION_ID = "chiefwizard.reposhelf";
export const EXPECTED_PAYLOAD_FILES = Object.freeze([
  "LICENSE",
  "README.md",
  "dist/extension.js",
  "dist/extension.js.map",
  "package.json",
  "resources/reposhelf-activitybar.svg",
  "resources/reposhelf-icon.png",
]);

const GENERATED_ARCHIVE_FILES = Object.freeze([
  "[Content_Types].xml",
  "extension.vsixmanifest",
]);
const PROHIBITED_FILE_PATTERN =
  /(^|\/)(?:\.env(?:\.[^/]*)?|node_modules|src|test|scripts|coverage|\.git|\.github|\.vscode)(?:\/|$)|\.(?:pem|key|p12|pfx|vsix)$|(?:^|\/)vitest\.config\./iu;

export function validateManifest(manifest) {
  if (!isRecord(manifest))
    throw new Error("Extension manifest must be an object.");
  const extensionId = `${manifest.publisher}.${manifest.name}`;
  if (extensionId !== EXPECTED_EXTENSION_ID) {
    throw new Error(`Unexpected Marketplace extension ID: ${extensionId}`);
  }
  if (typeof manifest.version !== "string" || manifest.version.trim() === "") {
    throw new Error("Extension manifest version is missing.");
  }
  if (manifest.main !== "./dist/extension.js") {
    throw new Error(
      `Unexpected extension entry point: ${String(manifest.main)}`,
    );
  }
  if (
    !Array.isArray(manifest.extensionKind) ||
    !manifest.extensionKind.includes("workspace")
  ) {
    throw new Error("RepoShelf must run as a workspace extension.");
  }
  return { extensionId, version: manifest.version };
}

export function validatePayloadFiles(files) {
  const normalized = [...files].map(normalizeArchivePath).sort();
  const expected = [...EXPECTED_PAYLOAD_FILES].sort();
  for (const file of normalized) {
    if (PROHIBITED_FILE_PATTERN.test(file)) {
      throw new Error(`Prohibited file selected for the VSIX: ${file}`);
    }
  }
  assertExactFiles(normalized, expected, "VSIX payload");
  return normalized;
}

export function validateArchiveFiles(files) {
  const normalized = [...files].map(normalizeArchivePath).sort();
  const expected = [
    ...GENERATED_ARCHIVE_FILES,
    ...EXPECTED_PAYLOAD_FILES.map((file) =>
      file === "LICENSE"
        ? "extension/LICENSE.txt"
        : file === "README.md"
          ? "extension/readme.md"
          : `extension/${file}`,
    ),
  ].sort();
  for (const file of normalized) {
    if (PROHIBITED_FILE_PATTERN.test(file.replace(/^extension\//u, ""))) {
      throw new Error(`Prohibited file found in the VSIX: ${file}`);
    }
  }
  assertExactFiles(normalized, expected, "VSIX archive");
  return normalized;
}

export async function packageReleaseCandidate({
  root = process.cwd(),
  outputDirectory,
  preRelease = true,
}) {
  const manifestPath = path.join(root, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const identity = validateManifest(manifest);
  const payloadFiles = validatePayloadFiles(
    await listFiles({ cwd: root, packageManager: PackageManager.None }),
  );
  const resolvedOutputDirectory = path.resolve(
    outputDirectory ?? path.join(root, "release-artifacts"),
  );
  const vsixPath = path.join(
    resolvedOutputDirectory,
    `reposhelf-${identity.version}.vsix`,
  );

  await mkdir(resolvedOutputDirectory, { recursive: true });
  await createVSIX({
    cwd: root,
    dependencies: false,
    packagePath: vsixPath,
    preRelease,
    useYarn: false,
  });

  const archive = await readZip(vsixPath);
  const archiveFiles = validateArchiveFiles(archive.names);
  const packagedManifest = JSON.parse(
    archive.readText("extension/package.json"),
  );
  const packagedIdentity = validateManifest(packagedManifest);
  if (packagedIdentity.version !== identity.version) {
    throw new Error(
      `Packaged version ${packagedIdentity.version} does not match ${identity.version}.`,
    );
  }

  const bytes = await readFile(vsixPath);
  const fileStat = await stat(vsixPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const evidence = {
    schemaVersion: 1,
    extensionId: identity.extensionId,
    version: identity.version,
    preRelease,
    vsix: {
      fileName: path.basename(vsixPath),
      bytes: fileStat.size,
      sha256,
    },
    payloadFiles,
    archiveFiles,
  };
  const evidencePath = path.join(
    resolvedOutputDirectory,
    `reposhelf-${identity.version}.evidence.json`,
  );
  await writeFile(evidencePath, `${JSON.stringify(evidence, undefined, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { ...evidence, evidencePath, vsixPath };
}

function assertExactFiles(actual, expected, label) {
  if (
    actual.length === expected.length &&
    actual.every((v, i) => v === expected[i])
  ) {
    return;
  }
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const unexpected = actual.filter((file) => !expectedSet.has(file));
  const missing = expected.filter((file) => !actualSet.has(file));
  throw new Error(
    `${label} differs from the reviewed allowlist. Missing: ${missing.join(", ") || "none"}. Unexpected: ${unexpected.join(", ") || "none"}.`,
  );
}

function normalizeArchivePath(file) {
  return file.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readZip(file) {
  const bytes = await readFile(file);
  const end = findEndOfCentralDirectory(bytes);
  const entryCount = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < entryCount; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Invalid VSIX central directory.");
    }
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    const normalizedName = normalizeArchivePath(name);
    if (entries.has(normalizedName)) {
      throw new Error(`Duplicate VSIX entry: ${normalizedName}`);
    }
    entries.set(normalizedName, {
      compressedSize,
      localOffset,
      method,
      uncompressedSize,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return {
    names: [...entries.keys()],
    readText(name) {
      const entry = entries.get(name);
      if (entry === undefined) throw new Error(`Missing VSIX entry: ${name}`);
      if (bytes.readUInt32LE(entry.localOffset) !== 0x04034b50) {
        throw new Error(`Invalid VSIX local entry: ${name}`);
      }
      const nameLength = bytes.readUInt16LE(entry.localOffset + 26);
      const extraLength = bytes.readUInt16LE(entry.localOffset + 28);
      const start = entry.localOffset + 30 + nameLength + extraLength;
      const compressed = bytes.subarray(start, start + entry.compressedSize);
      const content =
        entry.method === 0
          ? compressed
          : entry.method === 8
            ? inflateRawSync(compressed)
            : undefined;
      if (content === undefined || content.length !== entry.uncompressedSize) {
        throw new Error(`Unsupported or invalid VSIX entry: ${name}`);
      }
      return content.toString("utf8");
    },
  };
}

function findEndOfCentralDirectory(bytes) {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("VSIX end-of-central-directory record was not found.");
}
