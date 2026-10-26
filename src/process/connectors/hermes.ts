/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * LOCAL ADDITION (not upstream): Flux connector for Nous Research's Hermes Agent.
 *
 * Upstream ships connectors for opencode and codex only; `fluxConnector` had no
 * Hermes methods at all, so "route Hermes through Flux" was not merely broken —
 * it did not exist.
 *
 * Hermes differs from opencode/codex in an important way. opencode registers Flux
 * as an ADDITIONAL named provider (`provider.flux`) alongside its siblings, so the
 * rollback is a surgical delete. Hermes selects exactly ONE primary inference
 * provider under the `model:` key:
 *
 *   model:
 *     provider: custom          # "custom" = any OpenAI-compatible endpoint
 *     base_url: https://...
 *     api_key: sk-...
 *
 * So routing Hermes necessarily OVERWRITES its primary provider rather than adding
 * a sibling. To keep that reversible we snapshot the three prior scalar values into
 * the install receipt (`previous`) and restore them on remove, in addition to the
 * usual full-file backup. `fallback_providers` and every other top-level key are
 * left untouched.
 *
 * Config path resolution mirrors hermes_constants.py: `$HERMES_HOME` when set,
 * otherwise `~/.hermes`. The file is YAML, so we round-trip with js-yaml instead of
 * JSON.parse. Comments are NOT preserved by js-yaml — hence the full-file backup on
 * first install is load-bearing here, more so than for the JSON connectors.
 */

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import yaml from 'js-yaml';

import { FLUX_SURFACE } from '@/common/config/flux';
import { writeAtomic } from '@process/utils/atomicFile';

import { deleteReceipt, getReceipt, setReceipt } from './manifest';
import type {
  ConnectorContext,
  ConnectorStatus,
  FluxConnectorReport,
  InstallReceipt,
} from './types';

const TOOL = 'hermes';

type YamlObject = Record<string, unknown>;

function isObject(value: unknown): value is YamlObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** ISO timestamp with characters that are unsafe in filenames replaced. */
function isoSafeTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}

/**
 * Resolve Hermes' config file. Mirrors hermes_constants.py: `$HERMES_HOME` wins,
 * otherwise `~/.hermes`. The config file inside either root is `config.yaml`.
 */
export function resolveHermesConfigPath(): string {
  const hermesHome = process.env.HERMES_HOME?.trim();
  const root = hermesHome !== undefined && hermesHome.length > 0 ? hermesHome : path.join(os.homedir(), '.hermes');
  return path.join(root, 'config.yaml');
}

/** sha256 of `model.base_url=<baseURL>` (api_key excluded). */
export function managedHash(baseURL: string): string {
  return createHash('sha256').update(`model.base_url=${baseURL}`).digest('hex');
}

/** Parse Hermes' YAML config, tolerating an empty file. Never returns null. */
function parseConfig(raw: string, configPath: string): YamlObject {
  if (raw.trim() === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`hermes config at ${configPath} is not valid YAML: ${message}`);
  }
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (!isObject(parsed)) {
    throw new Error(`hermes config at ${configPath} root must be a YAML mapping`);
  }
  return parsed;
}

/** Read the current `model.base_url`, if present. */
function readModelBaseUrl(root: YamlObject): string | undefined {
  const model = root.model;
  if (!isObject(model)) {
    return undefined;
  }
  const baseUrl = model.base_url;
  return typeof baseUrl === 'string' ? baseUrl : undefined;
}

/**
 * Report Hermes' routing state against its install receipt.
 * - absent:       no config file on disk
 * - unconfigured: no receipt (we never routed it)
 * - routed:       model.base_url still matches the receipt's managed hash
 * - drifted:      a receipt exists but the config no longer matches
 */
export async function hermesStatus(ctx: ConnectorContext): Promise<ConnectorStatus> {
  const configPath = ctx.configPathOverride ?? resolveHermesConfigPath();

  let raw: string;
  try {
    raw = await fs.promises.readFile(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'absent';
    }
    throw err;
  }

  const receipt = await getReceipt(ctx.manifestPath, TOOL);
  if (receipt === undefined) {
    return 'unconfigured';
  }

  let root: YamlObject;
  try {
    root = parseConfig(raw, configPath);
  } catch {
    // Unparseable YAML is no longer our known-good managed state.
    return 'drifted';
  }

  const baseURL = readModelBaseUrl(root);
  if (baseURL === undefined) {
    return 'drifted';
  }
  return managedHash(baseURL) === receipt.managedHash ? 'routed' : 'drifted';
}

/**
 * Point Hermes' primary provider at Flux. Preserves `fallback_providers` and
 * every other top-level key; only `model.provider`, `model.base_url` and
 * `model.api_key` are rewritten, with their prior values recorded for rollback.
 */
export async function setupHermes(ctx: ConnectorContext): Promise<FluxConnectorReport> {
  const baseURL = ctx.baseURL || FLUX_SURFACE.openai;
  const configPath = ctx.configPathOverride ?? resolveHermesConfigPath();
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });

  const configExistedBefore = fs.existsSync(configPath);
  const raw = configExistedBefore ? await fs.promises.readFile(configPath, 'utf-8') : '';
  const root = parseConfig(raw, configPath);

  const priorBaseURL = readModelBaseUrl(root);
  const priorReceipt = await getReceipt(ctx.manifestPath, TOOL);

  // Full-file snapshot on FIRST install only; later installs reuse it. This
  // matters more than for the JSON connectors because js-yaml drops comments,
  // and Hermes' shipped config.yaml is heavily commented.
  let backupPath: string | null;
  if (priorReceipt !== undefined) {
    backupPath = priorReceipt.backupPath;
  } else if (configExistedBefore) {
    const snapshotDir = path.join(ctx.backupDir, TOOL);
    const nonce = randomBytes(4).toString('hex');
    backupPath = path.join(snapshotDir, `config.${isoSafeTimestamp(new Date().toISOString())}.${nonce}.yaml`);
    await writeAtomic(backupPath, raw);
  } else {
    backupPath = null;
  }

  if (root.model === undefined) {
    root.model = {};
  } else if (!isObject(root.model)) {
    throw new Error(`hermes config at ${configPath} has a non-mapping \`model\` key`);
  }
  const model = root.model as YamlObject;

  // Capture what we are about to overwrite so remove() can put it back. Only
  // recorded on the first install — a re-install must not memoise Flux's own
  // values as the "previous" state.
  const previous =
    priorReceipt?.previous ??
    ({
      provider: typeof model.provider === 'string' ? model.provider : undefined,
      baseUrl: typeof model.base_url === 'string' ? model.base_url : undefined,
      apiKey: typeof model.api_key === 'string' ? model.api_key : undefined,
    } as InstallReceipt['previous']);

  // "custom" is Hermes' selector for an arbitrary OpenAI-compatible endpoint.
  model.provider = 'custom';
  model.base_url = baseURL;
  model.api_key = ctx.fluxKey;

  await writeAtomic(configPath, yaml.dump(root, { lineWidth: 120, noRefs: true }));

  const receipt: InstallReceipt = {
    tool: TOOL,
    managedHash: managedHash(baseURL),
    configPath,
    backupPath,
    baseURL,
    installedAt: new Date().toISOString(),
    previous,
  };
  await setReceipt(ctx.manifestPath, receipt);

  let action: FluxConnectorReport['action'];
  const changes: string[] = [];
  if (priorBaseURL === undefined) {
    action = 'installed';
    changes.push(`Pointed model.provider at Flux (custom) with base_url ${baseURL}`);
  } else if (priorBaseURL === baseURL) {
    action = 'already-routed';
    changes.push(`model.base_url already pointed at ${baseURL}; refreshed api_key`);
  } else {
    action = 'updated';
    changes.push(`Updated model.base_url from ${priorBaseURL} to ${baseURL}`);
  }
  if (previous?.provider !== undefined) {
    changes.push(`Previous provider "${previous.provider}" recorded for rollback`);
  }

  const rollbackCommand =
    backupPath !== null
      ? `Run the in-app "Remove Flux from Hermes" action, or restore the backup: cp "${backupPath}" "${configPath}"`
      : `Run the in-app "Remove Flux from Hermes" action, or clear model.base_url/api_key in ${configPath}`;

  return {
    tool: TOOL,
    action,
    status: 'routed',
    configPath,
    configExistedBefore,
    backupPath,
    changes,
    rollbackCommand,
    baseURL,
  };
}

/**
 * Roll back: restore the three `model.*` scalars we overwrote from the receipt
 * (deleting them when there was nothing there before) and drop the receipt.
 * Every other key, including `fallback_providers`, is left as-is. The full
 * snapshot remains for a manual nuclear restore.
 */
export async function removeHermes(ctx: ConnectorContext): Promise<FluxConnectorReport> {
  const configPath = ctx.configPathOverride ?? resolveHermesConfigPath();
  const receipt = await getReceipt(ctx.manifestPath, TOOL);

  let raw: string | undefined;
  try {
    raw = await fs.promises.readFile(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  const changes: string[] = [];
  let action: FluxConnectorReport['action'] = 'noop';

  if (raw !== undefined) {
    const root = parseConfig(raw, configPath);
    if (isObject(root.model)) {
      const model = root.model as YamlObject;
      const prev = receipt?.previous;

      if (prev?.provider !== undefined) {
        model.provider = prev.provider;
      } else {
        delete model.provider;
      }
      if (prev?.baseUrl !== undefined) {
        model.base_url = prev.baseUrl;
      } else {
        delete model.base_url;
      }
      if (prev?.apiKey !== undefined) {
        model.api_key = prev.apiKey;
      } else {
        delete model.api_key;
      }

      await writeAtomic(configPath, yaml.dump(root, { lineWidth: 120, noRefs: true }));
      action = 'removed';
      changes.push(
        prev?.provider !== undefined
          ? `Restored model.provider to "${prev.provider}" and its base_url/api_key`
          : 'Cleared model.provider/base_url/api_key (nothing was set before Flux)',
      );
    }
  }

  if (receipt !== undefined) {
    await deleteReceipt(ctx.manifestPath, TOOL);
  }

  return {
    tool: TOOL,
    action,
    status: 'unconfigured',
    configPath,
    configExistedBefore: raw !== undefined,
    backupPath: receipt?.backupPath ?? null,
    changes,
    rollbackCommand:
      receipt?.backupPath != null
        ? `Full restore if needed: cp "${receipt.backupPath}" "${configPath}"`
        : `No backup was taken; ${configPath} was created by Flux setup`,
    baseURL: receipt?.baseURL ?? FLUX_SURFACE.openai,
  };
}
