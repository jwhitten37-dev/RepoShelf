import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { CoordinationJournal } from "../src/infrastructure/coordinationJournal.js";
import {
  CoordinationSession,
  createEnvironmentFingerprint,
  type CoordinationClock,
} from "../src/infrastructure/coordinationSession.js";

const temporaryRoots: string[] = [];
const FINGERPRINT = "a".repeat(64);
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const BOOT_NONCE = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("CoordinationSession", () => {
  it("publishes immutable identity and renews leases in monotonic order", async () => {
    const journal = await createJournal();
    const clock = new FakeClock();
    const session = makeSession(journal, clock);

    await session.start();
    expect(session.leaseHealth).toBe("healthy");
    await expect(journal.readSessionDescriptor(SESSION_ID)).resolves.toEqual(
      session.descriptor,
    );
    await expect(journal.readLease(SESSION_ID)).resolves.toMatchObject({
      sequence: 1,
      observedAt: 1_000,
      expiresAt: 31_000,
    });

    await clock.advance(10_000);
    await expect(journal.readLease(SESSION_ID)).resolves.toMatchObject({
      sequence: 2,
      observedAt: 11_000,
    });
  });

  it("marks sleep and backward clock anomalies indeterminate", async () => {
    const journal = await createJournal();
    const clock = new FakeClock();
    const session = makeSession(journal, clock);
    await session.start();

    await clock.advance(20_000);
    expect(session.leaseHealth).toBe("indeterminate");
    await expect(journal.readLease(SESSION_ID)).resolves.toMatchObject({
      sequence: 1,
    });

    await session.establishFreshLease();
    expect(session.leaseHealth).toBe("healthy");
    clock.wall = 500;
    await clock.advanceMonotonic(10_000);
    expect(session.leaseHealth).toBe("indeterminate");
  });

  it("stopping a session only stops renewal and creates no release operation", async () => {
    const journal = await createJournal();
    const clock = new FakeClock();
    const session = makeSession(journal, clock);
    await session.start();

    session.stop();
    await clock.advance(10_000);

    expect(session.leaseHealth).toBe("stopped");
    await expect(journal.discoverOperations()).resolves.toEqual([]);
    await expect(journal.readLease(SESSION_ID)).resolves.toMatchObject({
      sequence: 1,
    });
  });

  it("creates a bounded workspace handoff without sensitive host identity", async () => {
    const journal = await createJournal();
    const clock = new FakeClock();
    const session = makeSession(journal, clock);
    await session.start();
    const handoff = session.createMaterializationHandoff(
      WORKSPACE_ID,
      path.resolve("managed", "workspace"),
    );

    await journal.publishMaterializationHandoff(handoff);

    await expect(
      journal.readMaterializationHandoffs(WORKSPACE_ID),
    ).resolves.toEqual([handoff]);
    expect(handoff.expiresAt - handoff.createdAt).toBe(120_000);
  });
});

describe("createEnvironmentFingerprint", () => {
  it("is deterministic and excludes usernames and hostnames by contract", () => {
    const input = {
      extensionId: "chiefwizard.reposhelf",
      applicationName: "Visual Studio Code",
      applicationHost: "desktop",
      uiKind: 1,
      remoteName: "ssh-remote",
    };

    expect(createEnvironmentFingerprint(input)).toMatch(/^[0-9a-f]{64}$/u);
    expect(createEnvironmentFingerprint(input)).toBe(
      createEnvironmentFingerprint(input),
    );
    expect(createEnvironmentFingerprint({ ...input, uiKind: 2 })).not.toBe(
      createEnvironmentFingerprint(input),
    );
  });
});

class FakeClock implements CoordinationClock {
  public wall = 1_000;
  public monotonic = 0;
  private callback: (() => void | Promise<void>) | undefined;

  public wallTime(): number {
    return this.wall;
  }

  public monotonicTime(): number {
    return this.monotonic;
  }

  public setTimeout(
    callback: () => void | Promise<void>,
    delayMs: number,
  ): unknown {
    expect(delayMs).toBe(10_000);
    this.callback = callback;
    return callback;
  }

  public clearTimeout(handle: unknown): void {
    if (this.callback === handle) this.callback = undefined;
  }

  public async advance(elapsed: number): Promise<void> {
    this.wall += elapsed;
    await this.advanceMonotonic(elapsed);
  }

  public async advanceMonotonic(elapsed: number): Promise<void> {
    this.monotonic += elapsed;
    const callback = this.callback;
    this.callback = undefined;
    await callback?.();
  }
}

function makeSession(
  journal: CoordinationJournal,
  clock: CoordinationClock,
): CoordinationSession {
  return new CoordinationSession(
    journal,
    "coordinator",
    FINGERPRINT,
    "0.1.0",
    clock,
    { sessionId: SESSION_ID, bootNonce: BOOT_NONCE },
  );
}

async function createJournal(): Promise<CoordinationJournal> {
  const root = await mkdtemp(path.join(tmpdir(), "reposhelf-session-test-"));
  temporaryRoots.push(root);
  const journal = new CoordinationJournal(root);
  await journal.initialize();
  return journal;
}
