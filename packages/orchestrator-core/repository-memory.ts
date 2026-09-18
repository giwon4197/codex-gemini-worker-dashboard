// Repository memory (Phase 3): a compressed, evidence-only view of what past
// runs already proved about this repository. Everything here is derived from
// the run stores; nothing is inferred by a model and nothing is authoritative.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { LiveWorkerData, RunStatus } from './workspace-contract.ts';
import {
  getAllowedRepoRoot,
  getRepositoryId,
  getRunDetails,
  listCompactRuns,
} from './workspace-store.ts';
import { containsSecretMaterial, containsUnsafePathLikeValue, sanitizeText } from './workspace-sanitize.ts';

export const MEMORY_SCHEMA_VERSION = 1;
/** Runs that finished and therefore carry evidence worth remembering. */
const EVIDENCE_RUN_STATUSES = new Set<RunStatus>([
  'completed',
  'awaiting_review',
  'failed',
  'escalated',
]);
const SUCCESS_RETENTION_DAYS = 90;
const FAILURE_RETENTION_DAYS = 30;
const MAX_RUNS = 50;
const MAX_HASHED_FILES = 20;

export type MemoryConfidence = 'confirmed' | 'verified' | 'inferred' | 'stale';

export interface MemoryRecordSource {
  type: 'run' | 'verifier';
  runId: string;
  baseCommit?: string;
}

export interface MemoryRecord<T> {
  id: string;
  kind: 'task_history' | 'test_map';
  scope: 'repository';
  value: T;
  source: MemoryRecordSource;
  createdAt: string;
  lastValidatedAt: string;
  expiresAt: string;
  confidence: MemoryConfidence;
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  /** Repo-relative path to its sha256 when written; a mismatch marks it stale. */
  fileHashes: Record<string, string>;
}

export interface TaskHistoryValue {
  runId: string;
  prompt: string;
  status: RunStatus;
  changedFiles: string[];
  verificationDecision?: string;
  verificationCommands: Array<{ command: string; status: 'PASS' | 'FAIL' }>;
  failure?: { category?: string; reason?: string };
  integrationBranch?: string;
  /** Set only when the caller could check git; undefined means unknown, not false. */
  merged?: boolean;
  completedAt: string;
}

export interface TestMapValue {
  file: string;
  /** Verification commands that passed on a run which changed this file. */
  commands: string[];
  runIds: string[];
}

export interface RepositoryMemorySnapshot {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  repositoryId: string;
  updatedAt: string;
  headCommit?: string;
  /** True when the memory was built against a different checkout than the caller's. */
  staleAgainstHead: boolean;
  taskHistory: Array<MemoryRecord<TaskHistoryValue>>;
  testMap: Array<MemoryRecord<TestMapValue>>;
}

interface MemoryFile<T> {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  repositoryId: string;
  updatedAt: string;
  headCommit?: string;
  records: Array<MemoryRecord<T>>;
}

export function getMemoryDir(repoRoot: string): string {
  return path.join(repoRoot, '.agent', 'memory');
}

function addDays(from: Date, days: number): string {
  return new Date(from.getTime() + days * 86_400_000).toISOString();
}

/** Same commit even when one side is abbreviated and the other is not. */
function sameCommit(left?: string, right?: string): boolean {
  if (!left || !right) return false;
  return left.startsWith(right) || right.startsWith(left);
}

function hashFile(repoRoot: string, relativePath: string): string | undefined {
  try {
    return crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(repoRoot, relativePath)))
      .digest('hex')
      .slice(0, 32);
  } catch {
    return undefined;
  }
}

/**
 * Only files that live in this repository are remembered. Upstream sanitizing
 * already strips traversal markers, so containment is decided by resolving the
 * path, and the file must exist: a record that cannot be re-hashed later could
 * never be revalidated or marked stale.
 */
function keepSafeFiles(files: string[], repoRoot: string): string[] {
  const root = path.resolve(repoRoot);
  const safe = new Set<string>();
  for (const raw of files) {
    const file = String(raw || '').trim().replace(/\\/g, '/');
    if (!file || containsUnsafePathLikeValue(file) || containsSecretMaterial(file)) continue;
    const resolved = path.resolve(root, file);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) continue;
    if (!fs.existsSync(resolved)) continue;
    safe.add(file);
  }
  return [...safe].sort();
}

function collectVerification(workers: LiveWorkerData[]): {
  decision?: string;
  commands: Array<{ command: string; status: 'PASS' | 'FAIL' }>;
} {
  const commands: Array<{ command: string; status: 'PASS' | 'FAIL' }> = [];
  let decision: string | undefined;
  for (const worker of workers) {
    decision = decision || worker.verification?.decision;
    for (const command of worker.verification?.commands || []) {
      if (!command?.command || containsSecretMaterial(command.command)) continue;
      commands.push({ command: command.command, status: command.status });
    }
  }
  return { decision, commands };
}

async function writeMemoryFile<T>(filePath: string, data: MemoryFile<T>): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(data, null, 2), 'utf8');
  await fs.promises.rename(temporary, filePath);
}

async function readMemoryFile<T>(filePath: string): Promise<MemoryFile<T> | null> {
  try {
    const parsed = JSON.parse(
      (await fs.promises.readFile(filePath, 'utf8')).replace(/^﻿/, '')
    ) as MemoryFile<T>;
    if (parsed?.schemaVersion !== MEMORY_SCHEMA_VERSION) return null;
    if (!Array.isArray(parsed.records)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Rebuilds the memory from finished runs. Prompts, failure reasons and paths go
 * through the sanitizer first, and a record carrying secret material is skipped
 * rather than masked.
 */
export async function rebuildRepositoryMemory(options?: {
  repoRoot?: string;
  headCommit?: string;
  now?: Date;
  /** Answers whether an integration branch already landed on the default branch. */
  isMerged?: (integrationBranch: string) => Promise<boolean>;
}): Promise<RepositoryMemorySnapshot> {
  const root = options?.repoRoot || getAllowedRepoRoot();
  const now = options?.now || new Date();
  const timestamp = now.toISOString();
  const runs = (await listCompactRuns(root))
    .filter(run => EVIDENCE_RUN_STATUSES.has(run.status))
    .slice(0, MAX_RUNS);

  const taskHistory: Array<MemoryRecord<TaskHistoryValue>> = [];
  const testMapByFile = new Map<string, TestMapValue>();

  for (const run of runs) {
    const details = await getRunDetails(run.runId, root);
    if (!details) continue;
    const workers = [...(details.activeWorkers || []), ...(details.historyWorkers || [])];
    const changedFiles = keepSafeFiles(
      workers.flatMap(worker => worker.changedFiles || []),
      root
    );
    const verification = collectVerification(workers);
    // Run details rebuild these from the manifest; the compact state keeps them when it is gone.
    const integrationBranch = details.integrationBranch || run.integrationBranch;
    const baseCommit = details.baseCommit || run.baseCommit;
    const prompt = sanitizeText(details.prompt || run.prompt || '', root);
    const failureReason = details.failureReason
      ? sanitizeText(details.failureReason, root)
      : undefined;
    if (containsSecretMaterial(prompt) || (failureReason && containsSecretMaterial(failureReason))) {
      continue;
    }

    const passed =
      verification.commands.length > 0 &&
      verification.commands.every(command => command.status === 'PASS');
    const succeeded = details.status === 'completed' || details.status === 'awaiting_review';
    const fileHashes: Record<string, string> = {};
    for (const file of changedFiles.slice(0, MAX_HASHED_FILES)) {
      const hash = hashFile(root, file);
      if (hash) fileHashes[file] = hash;
    }

    taskHistory.push({
      id: `task-history:${details.runId}`,
      kind: 'task_history',
      scope: 'repository',
      value: {
        runId: details.runId,
        prompt,
        status: details.status,
        changedFiles,
        verificationDecision: verification.decision,
        verificationCommands: verification.commands,
        failure: succeeded
          ? undefined
          : { category: details.errorCategory, reason: failureReason },
        integrationBranch,
        merged:
          succeeded && integrationBranch && options?.isMerged
            ? await options.isMerged(integrationBranch)
            : undefined,
        completedAt: details.updatedAt || timestamp,
      },
      source: {
        type: passed ? 'verifier' : 'run',
        runId: details.runId,
        baseCommit,
      },
      createdAt: details.createdAt || timestamp,
      lastValidatedAt: timestamp,
      expiresAt: addDays(now, succeeded ? SUCCESS_RETENTION_DAYS : FAILURE_RETENTION_DAYS),
      // Evidence, not self-assessment: only passing commands make it 'verified'.
      confidence: passed && succeeded ? 'verified' : 'inferred',
      schemaVersion: MEMORY_SCHEMA_VERSION,
      fileHashes,
    });

    if (!passed || !succeeded) continue;
    for (const file of changedFiles) {
      const entry = testMapByFile.get(file) || { file, commands: [], runIds: [] };
      for (const command of verification.commands) {
        if (!entry.commands.includes(command.command)) entry.commands.push(command.command);
      }
      if (!entry.runIds.includes(details.runId)) entry.runIds.push(details.runId);
      testMapByFile.set(file, entry);
    }
  }

  const testMap: Array<MemoryRecord<TestMapValue>> = [...testMapByFile.values()].map(value => {
    const hash = hashFile(root, value.file);
    return {
      id: `test-map:${value.file}`,
      kind: 'test_map',
      scope: 'repository',
      value,
      source: { type: 'verifier', runId: value.runIds[0] },
      createdAt: timestamp,
      lastValidatedAt: timestamp,
      expiresAt: addDays(now, SUCCESS_RETENTION_DAYS),
      confidence: 'verified',
      schemaVersion: MEMORY_SCHEMA_VERSION,
      fileHashes: hash ? { [value.file]: hash } : {},
    };
  });

  const repositoryId = getRepositoryId(root);
  const directory = getMemoryDir(root);
  await writeMemoryFile(path.join(directory, 'task-history.json'), {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    repositoryId,
    updatedAt: timestamp,
    headCommit: options?.headCommit,
    records: taskHistory,
  });
  await writeMemoryFile(path.join(directory, 'test-map.json'), {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    repositoryId,
    updatedAt: timestamp,
    headCommit: options?.headCommit,
    records: testMap,
  });

  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    repositoryId,
    updatedAt: timestamp,
    headCommit: options?.headCommit,
    staleAgainstHead: false,
    taskHistory,
    testMap,
  };
}

function revalidate<T>(
  records: Array<MemoryRecord<T>>,
  repoRoot: string,
  now: Date
): Array<MemoryRecord<T>> {
  const kept: Array<MemoryRecord<T>> = [];
  for (const record of records) {
    if (record?.schemaVersion !== MEMORY_SCHEMA_VERSION) continue;
    if (Date.parse(record.expiresAt) <= now.getTime()) continue;
    // A remembered fact survives a new HEAD only while its files still match.
    const changed = Object.entries(record.fileHashes || {}).some(
      ([file, hash]) => hashFile(repoRoot, file) !== hash
    );
    kept.push(changed ? { ...record, confidence: 'stale' } : record);
  }
  return kept;
}

/**
 * Reads the memory and revalidates it against the current checkout: expired
 * records are dropped and records whose files moved on are marked stale.
 */
export async function readRepositoryMemory(options?: {
  repoRoot?: string;
  headCommit?: string;
  now?: Date;
}): Promise<RepositoryMemorySnapshot> {
  const root = options?.repoRoot || getAllowedRepoRoot();
  const now = options?.now || new Date();
  const repositoryId = getRepositoryId(root);
  const directory = getMemoryDir(root);
  const history = await readMemoryFile<TaskHistoryValue>(
    path.join(directory, 'task-history.json')
  );
  const tests = await readMemoryFile<TestMapValue>(path.join(directory, 'test-map.json'));
  const stored = history || tests;

  if (!stored || stored.repositoryId !== repositoryId) {
    return {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      repositoryId,
      updatedAt: stored?.updatedAt || new Date(0).toISOString(),
      staleAgainstHead: Boolean(stored),
      taskHistory: [],
      testMap: [],
    };
  }

  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    repositoryId,
    updatedAt: stored.updatedAt,
    headCommit: stored.headCommit,
    staleAgainstHead: Boolean(
      options?.headCommit && !sameCommit(stored.headCommit, options.headCommit)
    ),
    taskHistory: revalidate(history?.records || [], root, now),
    testMap: revalidate(tests?.records || [], root, now),
  };
}

/** Deletes the whole repository memory, including anything derived from it. */
export async function clearRepositoryMemory(repoRoot?: string): Promise<void> {
  const root = repoRoot || getAllowedRepoRoot();
  await fs.promises.rm(getMemoryDir(root), { recursive: true, force: true });
}
