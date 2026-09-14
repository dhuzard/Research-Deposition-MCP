#!/usr/bin/env node
import { chmod, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  canonicalizeApprovalRequest,
  createApprovalReceipt,
  generateApprovalKeyPair,
} from "./approval.js";

function usage(): never {
  console.error(`Usage:
  research-deposition-approve keygen --private-key <path> --public-key <path>
  research-deposition-approve sign --request <approval-request.json> --private-key <path> --receipt <path> [--expires-in <seconds>]
`);
  process.exit(2);
}

function arg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

async function keygen(args: string[]): Promise<void> {
  const privatePath = arg(args, "--private-key");
  const publicPath = arg(args, "--public-key");
  if (!privatePath || !publicPath) usage();

  const pair = generateApprovalKeyPair();
  await writeFile(privatePath, pair.privateKeyPem, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(privatePath, 0o600);
  await writeFile(publicPath, pair.publicKeyPem, { encoding: "utf8", mode: 0o644, flag: "wx" });
  console.log(JSON.stringify({ publicKey: publicPath, privateKey: privatePath, keyId: pair.keyId }, null, 2));
}

async function signRequest(args: string[]): Promise<void> {
  const requestPath = arg(args, "--request");
  const privatePath = arg(args, "--private-key");
  const receiptPath = arg(args, "--receipt");
  const expiresRaw = arg(args, "--expires-in");
  if (!requestPath || !privatePath || !receiptPath) usage();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Approval signing requires an interactive TTY. It is intentionally not a non-interactive agent tool.");
  }

  const request = canonicalizeApprovalRequest(JSON.parse(await readFile(requestPath, "utf8")));
  const privateKeyPem = await readFile(privatePath, "utf8");
  const expiresInSeconds = expiresRaw === undefined ? 900 : Number(expiresRaw);
  const phrase = `APPROVE ${request.packageDigest.slice(0, 19)} ${request.draftId}`;

  console.log("Publication approval request:");
  console.log(JSON.stringify(request, null, 2));
  console.log("\nThis signature authorizes publication only for the exact package digest, repository endpoint, draft, and policy shown above.");

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`Type exactly '${phrase}' to sign: `);
    if (answer !== phrase) throw new Error("Approval phrase did not match; no receipt was created.");
  } finally {
    rl.close();
  }

  const receipt = createApprovalReceipt(request, privateKeyPem, { expiresInSeconds });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ receipt: receiptPath, keyId: receipt.keyId, expiresAt: receipt.payload.expiresAt }, null, 2));
}

const [command, ...args] = process.argv.slice(2);
if (command === "keygen") await keygen(args);
else if (command === "sign") await signRequest(args);
else usage();
