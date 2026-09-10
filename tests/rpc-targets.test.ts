// The picker's machine list decides which workspace modes are offered at all,
// so `listTargets` must never turn "bb could not read the project's sources"
// into the claim "this project has no checkout there".
import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@bb/plugin-sdk";

// bb injects the real SDK at load time; tests that import the backend need a
// stand-in for the one value it imports (everything else is type-only).
vi.mock("@bb/plugin-sdk", () => ({ defineRpcContract: (contract: unknown) => contract }));

import plugin from "../server";
import { REMOTE_LOOKUP_TIMEOUT_MS } from "../machines";

const MAC = { id: "host_mac", name: "Mac", status: "connected" as const };
const MINI = { id: "host_mini", name: "mini", status: "connected" as const };

interface MachineRow {
  id: string;
  hasCheckout: boolean | null;
}

async function listTargets(options: { projectsHang?: boolean } = {}): Promise<MachineRow[]> {
  return (await listTargetsResult(options)).machines;
}

async function listTargetsResult(
  options: { projectsHang?: boolean; machineId?: string } = {},
): Promise<{ machines: MachineRow[]; rejected: string | null }> {
  const handlers = new Map<string, (input: unknown) => Promise<{ machines: MachineRow[] }>>();
  const bb = {
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    events: { on: () => {} },
    onDispose: () => {},
    cli: { register: () => {} },
    rpc: {
      register: (_contract: unknown, registered: Record<string, never>) => {
        for (const [name, handler] of Object.entries(registered)) handlers.set(name, handler);
      },
    },
    sdk: {
      hosts: { list: async () => [MAC, MINI] },
      system: { config: async () => ({ primaryHostId: MAC.id }) },
      threads: { get: async () => ({ id: "thr_1", projectId: "proj_1", environmentId: "env_1" }) },
      environments: { get: async () => ({ hostId: MAC.id }) },
      providers: { list: async () => [] },
      projects: {
        list: async () => {
          if (options.projectsHang) return new Promise(() => {});
          return [
            {
              id: "proj_1",
              name: "aurora",
              sources: [{ hostId: MAC.id, path: "/Users/dev/aurora", isDefault: true }],
            },
          ];
        },
      },
    },
  };
  await plugin(bb as unknown as BbPluginApi);
  const handler = handlers.get("listTargets");
  if (!handler) throw new Error("listTargets was not registered");
  try {
    const result = await handler({
      threadId: "thr_1",
      ...(options.machineId ? { machineId: options.machineId } : {}),
    });
    return { machines: result.machines, rejected: null };
  } catch (error) {
    return { machines: [], rejected: error instanceof Error ? error.message : String(error) };
  }
}

describe("listTargets", () => {
  const checkouts = (machines: MachineRow[]) => machines.map(({ id, hasCheckout }) => ({ id, hasCheckout }));

  it("reports a known checkout as a boolean", async () => {
    expect(checkouts(await listTargets())).toEqual([
      { id: MAC.id, hasCheckout: true },
      { id: MINI.id, hasCheckout: false },
    ]);
  });

  it("reports an unreadable project list as unknown, not as no checkout", async () => {
    vi.useFakeTimers();
    try {
      const assertion = listTargets({ projectsHang: true });
      await vi.advanceTimersByTimeAsync(REMOTE_LOOKUP_TIMEOUT_MS + 1);
      expect(checkouts(await assertion)).toEqual([
        { id: MAC.id, hasCheckout: null },
        { id: MINI.id, hasCheckout: null },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a named machine's checkout unknown rather than blocking its modes", async () => {
    vi.useFakeTimers();
    try {
      const assertion = listTargetsResult({ projectsHang: true, machineId: MINI.id });
      await vi.advanceTimersByTimeAsync(REMOTE_LOOKUP_TIMEOUT_MS + 1);
      const { machines, rejected } = await assertion;
      expect(rejected).toBeNull();
      // Unknown, so `checkout`/`worktree` stay selectable; a real miss is
      // reported by planTransfer when the handoff starts, not guessed here.
      expect(checkouts(machines)).toContainEqual({ id: MINI.id, hasCheckout: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects for a named machine that cannot be resolved", async () => {
    const { rejected } = await listTargetsResult({ machineId: "nope" });
    expect(rejected).toContain("Unknown machine");
  });
});
