import { mkdir } from "node:fs/promises";
import path from "node:path";
import { CoordinationJournal } from "../../src/infrastructure/coordinationJournal.js";
import type { ReleaseClaim } from "../../src/infrastructure/coordinationRecords.js";

async function main(): Promise<void> {
  const [storageRoot, mode, serializedClaim] = process.argv.slice(2);
  if (
    storageRoot === undefined ||
    mode === undefined ||
    serializedClaim === undefined
  ) {
    process.exit(2);
  }
  const claim = JSON.parse(serializedClaim) as ReleaseClaim;
  const journal = new CoordinationJournal(storageRoot);

  if (mode === "crashAfterClaimDirectory") {
    await mkdir(
      path.join(
        journal.root,
        "workspaces",
        claim.workspaceId,
        "operations",
        claim.operationId,
        "claim",
      ),
    );
    process.exit(91);
  }

  try {
    process.stdout.write(await journal.claim(claim));
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "error";
    process.stdout.write(code);
    process.exitCode = 1;
  }
}

void main();
