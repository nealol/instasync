import * as fs from "node:fs";
import type { CanvasOperation, CanvasOperationBatch, StructuredResponse } from "@realtime-md/sdk";
import type { Command } from "commander";
import { CliError } from "../config";
import { ctxFrom, out, vaultClients } from "../context";

function readStdin(): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (value += chunk));
  process.stdin.on("end", () => resolve(value));
  process.stdin.on("error", reject);
  return promise;
}

function parseBatch(text: string, mutationId?: string): CanvasOperationBatch {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new CliError(`invalid Canvas operation JSON: ${String(error)}`);
  }
  const batch = Array.isArray(value) ? { operations: value } : value;
  if (!batch || typeof batch !== "object" || !("operations" in batch)) {
    throw new CliError(
      "Canvas operation input must be an operation array or an object with operations",
    );
  }
  const operations = batch.operations;
  if (!Array.isArray(operations) || !operations.every(isCanvasOperation)) {
    throw new CliError("Canvas operations contain an invalid shape");
  }
  const batchMutationId =
    "mutationId" in batch && typeof batch.mutationId === "string" ? batch.mutationId : undefined;
  return {
    operations,
    ...(batchMutationId ? { mutationId: batchMutationId } : {}),
    ...(mutationId ? { mutationId } : {}),
  };
}

function isCanvasOperation(value: unknown): value is CanvasOperation {
  if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string")
    return false;
  switch (value.type) {
    case "node-create":
    case "node-restore":
      return "node" in value && !!value.node && typeof value.node === "object";
    case "edge-create":
    case "edge-restore":
      return "edge" in value && !!value.edge && typeof value.edge === "object";
    case "node-patch":
    case "edge-patch":
      return (
        "id" in value &&
        typeof value.id === "string" &&
        "patch" in value &&
        !!value.patch &&
        typeof value.patch === "object"
      );
    case "node-delete":
    case "edge-delete":
      return "id" in value && typeof value.id === "string";
    case "node-order":
    case "edge-order":
      return (
        "order" in value &&
        Array.isArray(value.order) &&
        value.order.every((id) => typeof id === "string")
      );
    default:
      return false;
  }
}

function printResult(response: StructuredResponse): void {
  process.stdout.write(`${response.path}\n`);
}

export function registerCanvasCommands(program: Command): void {
  program
    .command("canvas-apply <path>")
    .description("apply an atomic Canvas operation batch from JSON")
    .option("--file <path>", "read the JSON batch from a file instead of stdin")
    .option("--mutation-id <id>", "deduplicate a safely retried mutation")
    .action(
      async (path: string, options: { file?: string; mutationId?: string }, command: Command) => {
        const ctx = ctxFrom(command);
        const input = options.file ? fs.readFileSync(options.file, "utf8") : await readStdin();
        const response = await vaultClients(ctx).vault.canvases.applyOperations(
          path,
          parseBatch(input, options.mutationId),
        );
        out(ctx, response, () => printResult(response));
      },
    );
}
