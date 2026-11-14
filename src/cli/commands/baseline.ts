import type { BaselineImportInput, SimlockAdminClient } from "../../admin/index.js";
import { commandArgs, subcommandOrUsage, UsageError, withHelpHint, writeResult } from "../args.js";
import { connectDaemonClient } from "../connect.js";
import {
  baselineImportedLine,
  baselineRemovedLine,
  baselineSavedLine,
  baselineTable,
} from "../format.js";
import type { CommandContext } from "../tree.js";

const BASELINE_USAGE =
  "Usage: simlock baseline save <name> --lease <id> [--note <text>]\n" +
  "       simlock baseline import <name> --device <udid> [--mode slim|full] [--note <text>]\n" +
  "       simlock baseline list [--json]\n" +
  "       simlock baseline remove <name> [--yes] [--worker <id>]\n";

async function run(argv: readonly string[], context: CommandContext): Promise<number> {
  const { environment, token } = context;
  const parsed = subcommandOrUsage(argv, context.path, environment.stdout, BASELINE_USAGE);
  if (parsed === 0) return 0;
  if (parsed.command === "list") return runList(parsed.flagArgs, environment, token);
  if (parsed.command === "remove") return runRemove(parsed.flagArgs, environment, token);
  if (parsed.command === "import") return runImport(parsed.flagArgs, environment, token);
  if (parsed.command !== "save") {
    throw new UsageError(withHelpHint(`Unknown baseline command: ${String(parsed.command)}`));
  }
  return runSave(parsed.flagArgs, environment, token);
}

async function runList(
  argv: readonly string[],
  environment: CommandContext["environment"],
  token: string | undefined,
): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" },
  });
  if (values.help) {
    environment.stdout.write(BASELINE_USAGE);
    return 0;
  }
  if (values.positionals.length > 0) {
    throw new UsageError(withHelpHint("baseline list takes no positional arguments"));
  }
  const client = await connectDaemonClient(environment, token);
  try {
    const listed = await client.listBaselines();
    if (values.json) writeResult((value) => environment.stdout.write(value), listed);
    else {
      const gateway = environment.daemonHome.role === "gateway";
      environment.stdout.write(baselineTable(listed.baselines, { gateway }));
    }
    return 0;
  } finally {
    await client.close();
  }
}

async function runRemove(
  argv: readonly string[],
  environment: CommandContext["environment"],
  token: string | undefined,
): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    worker: { type: "string" },
    yes: { type: "boolean" },
  });
  if (values.help) {
    environment.stdout.write(BASELINE_USAGE);
    return 0;
  }
  const [name, ...extra] = values.positionals;
  if (name === undefined || extra.length > 0) {
    throw new UsageError(withHelpHint("baseline remove takes one <name>"));
  }
  const workerId = typeof values.worker === "string" ? values.worker : undefined;
  // why: a gateway needs the worker that holds the baseline; without one the CLI asks nothing and sends the remove, so the gateway's BAD_REQUEST is the answer.
  const unnamedOnGateway = environment.daemonHome.role === "gateway" && workerId === undefined;
  const client = await connectDaemonClient(environment, token);
  try {
    if (values.yes !== true && !unnamedOnGateway) {
      await confirmRemoval(client, environment, name, workerId);
    }
    const removed = await client.removeBaseline({
      name,
      ...(workerId === undefined ? {} : { workerId }),
    });
    environment.stdout.write(baselineRemovedLine(removed, workerId));
    return 0;
  } finally {
    await client.close();
  }
}

// why: the question names the version the operator is about to lose; a name nobody holds is not asked about, since the daemon answers it.
async function confirmRemoval(
  client: SimlockAdminClient,
  environment: CommandContext["environment"],
  name: string,
  workerId: string | undefined,
): Promise<void> {
  const { baselines } = await client.listBaselines();
  const held = baselines.find(
    (baseline) =>
      baseline.name === name && (workerId === undefined || baseline.workerId === workerId),
  );
  if (held === undefined) return;
  const from = workerId === undefined ? "" : ` from ${workerId}`;
  const confirmed = await environment.confirm?.(
    `Remove baseline ${name} v${String(held.version)}${from}? [y/N] `,
  );
  if (confirmed !== true) throw new UsageError("baseline remove requires confirmation or --yes");
}

async function runImport(
  argv: readonly string[],
  environment: CommandContext["environment"],
  token: string | undefined,
): Promise<number> {
  const values = commandArgs(argv, {
    device: { type: "string" },
    help: { type: "boolean", short: "h" },
    mode: { type: "string" },
    note: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write(BASELINE_USAGE);
    return 0;
  }
  const input = importInput(values);
  return answer(environment, token, async (client) =>
    baselineImportedLine(await client.importBaseline(input)),
  );
}

function importInput(values: {
  readonly positionals: readonly string[];
  readonly device?: unknown;
  readonly mode?: unknown;
  readonly note?: unknown;
}): BaselineImportInput {
  const [name, ...extra] = values.positionals;
  if (name === undefined || extra.length > 0) {
    throw new UsageError(withHelpHint("baseline import takes one <name>"));
  }
  if (typeof values.device !== "string" || values.device === "") {
    throw new UsageError(withHelpHint("baseline import requires --device <udid>"));
  }
  const { mode, note } = values;
  if (mode !== undefined && mode !== "slim" && mode !== "full") {
    throw new UsageError(withHelpHint("--mode must be slim or full"));
  }
  return {
    device: values.device,
    name,
    ...(mode === undefined ? {} : { mode }),
    ...(typeof note === "string" ? { note } : {}),
  };
}

async function runSave(
  argv: readonly string[],
  environment: CommandContext["environment"],
  token: string | undefined,
): Promise<number> {
  const values = commandArgs(argv, {
    help: { type: "boolean", short: "h" },
    lease: { type: "string" },
    note: { type: "string" },
  });
  if (values.help) {
    environment.stdout.write(BASELINE_USAGE);
    return 0;
  }
  const [name, ...extra] = values.positionals;
  if (name === undefined || extra.length > 0) {
    throw new UsageError(withHelpHint("baseline save takes one <name>"));
  }
  const leaseId = values.lease;
  if (typeof leaseId !== "string" || leaseId === "") {
    throw new UsageError(withHelpHint("baseline save requires --lease <id>"));
  }
  const note = typeof values.note === "string" ? values.note : undefined;
  return answer(environment, token, async (client) =>
    baselineSavedLine(
      await client.saveBaseline({ leaseId, name, ...(note === undefined ? {} : { note }) }),
    ),
  );
}

/** why: a command that writes one answer opens the admin connection, writes the line `ask` makes of the daemon's answer, and closes it. */
async function answer(
  environment: CommandContext["environment"],
  token: string | undefined,
  ask: (client: SimlockAdminClient) => Promise<string>,
): Promise<number> {
  const client = await connectDaemonClient(environment, token);
  try {
    environment.stdout.write(await ask(client));
    return 0;
  } finally {
    await client.close();
  }
}

export { run };
