import { describe, expect, it } from "vitest";
import {
  EXPECTED_EXTENSION_ID,
  EXPECTED_PAYLOAD_FILES,
  validateArchiveFiles,
  validateManifest,
  validatePayloadFiles,
} from "../scripts/release-package.mjs";

describe("Phase 7 release packaging", () => {
  it("accepts only the reviewed Marketplace identity and entry point", () => {
    expect(
      validateManifest({
        publisher: "chiefwizard",
        name: "reposhelf",
        version: "0.1.0",
        main: "./dist/extension.js",
        extensionKind: ["workspace"],
      }),
    ).toEqual({ extensionId: EXPECTED_EXTENSION_ID, version: "0.1.0" });
    expect(() =>
      validateManifest({
        publisher: "attacker",
        name: "reposhelf",
        version: "0.1.0",
        main: "./dist/extension.js",
        extensionKind: ["workspace"],
      }),
    ).toThrow("Unexpected Marketplace extension ID");
  });

  it("accepts the exact reviewed payload independent of path separators", () => {
    expect(
      validatePayloadFiles(
        EXPECTED_PAYLOAD_FILES.map((file) => file.replaceAll("/", "\\")),
      ),
    ).toEqual([...EXPECTED_PAYLOAD_FILES].sort());
  });

  it.each([
    "vitest.config.mts",
    ".env",
    ".env.production",
    "src/extension.ts",
    "secret.pem",
  ])("rejects prohibited payload file %s", (file) => {
    expect(() =>
      validatePayloadFiles([...EXPECTED_PAYLOAD_FILES, file]),
    ).toThrow("Prohibited file");
  });

  it("rejects missing or unexpected payload files", () => {
    expect(() => validatePayloadFiles(["package.json"])).toThrow("Missing:");
    expect(() =>
      validatePayloadFiles([...EXPECTED_PAYLOAD_FILES, "unexpected.txt"]),
    ).toThrow("Unexpected: unexpected.txt");
  });

  it("accepts only the exact final VSIX archive allowlist", () => {
    const archive = [
      "[Content_Types].xml",
      "extension.vsixmanifest",
      ...EXPECTED_PAYLOAD_FILES.map((file) =>
        file === "LICENSE"
          ? "extension/LICENSE.txt"
          : file === "README.md"
            ? "extension/readme.md"
            : `extension/${file}`,
      ),
    ];
    expect(validateArchiveFiles(archive)).toEqual([...archive].sort());
    expect(() =>
      validateArchiveFiles([...archive, "extension/test/leak.test.js"]),
    ).toThrow("Prohibited file");
  });
});
