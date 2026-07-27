import { parse as parseYaml } from 'yaml';
import type { ListeningFormat, RawListeningRow } from '@/types.js';

/**
 * Result of parsing a listening log. `rows` is the successfully validated rows;
 * `warnings` collects soft failures. A bad row is skipped with a warning rather
 * than throwing, so one typo never fails a whole site build.
 */
export interface ParseListeningLogResult {
  rows: RawListeningRow[];
  warnings: string[];
}

const FORMATS: readonly ListeningFormat[] = ['vinyl', 'cd', 'cassette', 'digital'];

/** Fields the schema knows about. Anything else warns but does not reject the row. */
const KNOWN_FIELDS = new Set<string>([
  'title',
  'artist',
  'format',
  'playedAt',
  'appleMusicAlbumId',
  'discogsReleaseId',
  'source',
  'private',
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** A present, non-whitespace string. Whitespace-only counts as empty. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isListeningFormat(value: unknown): value is ListeningFormat {
  return isString(value) && (FORMATS as readonly string[]).includes(value);
}

/** Render a value for a warning: strings in single quotes, everything else as JSON. */
function show(value: unknown): string {
  return isString(value) ? `'${value}'` : JSON.stringify(value);
}

/** Human-readable label for a row in warnings: its title, else its position. */
function rowLabel(item: Record<string, unknown>, index: number): string {
  return isNonEmptyString(item.title) ? `'${item.title}'` : `#${index + 1}`;
}

/** Describe the JSON-ish type of a value, for the root-not-a-list warning. */
function describeType(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  return `a ${typeof value}`;
}

/**
 * True when a value is a real calendar date in ISO YYYY-MM-DD form. The regex
 * alone would accept 2026-02-30, so the parsed date is round-tripped to confirm
 * it did not roll over into March.
 *
 * Note this validates a string. The `yaml` package's default schema resolves
 * an unquoted `2026-05-28` to a string rather than a Date, which is what makes
 * a string check safe here; test/parse.test.ts locks that behavior down.
 */
function isIsoDate(value: unknown): value is string {
  if (!isString(value) || !ISO_DATE.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Validate one raw item against the schema. Returns a row, or undefined with a
 * warning pushed. Unknown fields warn but do not reject: a field this version
 * does not know about is more likely a note to self than a mistake.
 */
function validateRow(
  item: unknown,
  index: number,
  warnings: string[],
): RawListeningRow | undefined {
  if (!isPlainObject(item)) {
    warnings.push(`Row #${index + 1}: each row must be an object`);
    return undefined;
  }

  const label = rowLabel(item, index);

  // The four required fields. Each is fatal to the row on its own.
  for (const field of ['title', 'artist'] as const) {
    if (!isNonEmptyString(item[field])) {
      warnings.push(
        isPresent(item[field])
          ? `Row ${label}: '${field}' must be a non-empty string, got ${show(item[field])}`
          : `Row ${label}: missing required field '${field}'`,
      );
      return undefined;
    }
  }

  if (!isListeningFormat(item.format)) {
    warnings.push(
      isPresent(item.format)
        ? `Row ${label}: 'format' must be one of ${FORMATS.join(', ')}, got ${show(item.format)}`
        : `Row ${label}: missing required field 'format'`,
    );
    return undefined;
  }

  if (!isIsoDate(item.playedAt)) {
    warnings.push(
      isPresent(item.playedAt)
        ? `Row ${label}: 'playedAt' must be a real ISO date (YYYY-MM-DD), got ${show(item.playedAt)}`
        : `Row ${label}: missing required field 'playedAt'`,
    );
    return undefined;
  }

  const row: RawListeningRow = {
    title: item.title as string,
    artist: item.artist as string,
    format: item.format,
    playedAt: item.playedAt,
  };

  for (const field of ['appleMusicAlbumId', 'source'] as const) {
    if (!isPresent(item[field])) {
      continue;
    }
    if (!isNonEmptyString(item[field])) {
      warnings.push(`Row ${label}: '${field}' must be a non-empty string`);
      return undefined;
    }
    row[field] = item[field];
  }

  if (isPresent(item.discogsReleaseId)) {
    if (typeof item.discogsReleaseId !== 'number' || !Number.isInteger(item.discogsReleaseId)) {
      warnings.push(
        `Row ${label}: 'discogsReleaseId' must be a whole number, got ${show(item.discogsReleaseId)}`,
      );
      return undefined;
    }
    row.discogsReleaseId = item.discogsReleaseId;
  }

  if (isPresent(item.private)) {
    if (typeof item.private !== 'boolean') {
      warnings.push(`Row ${label}: 'private' must be a boolean, got ${show(item.private)}`);
      return undefined;
    }
    row.private = item.private;
  }

  for (const key of Object.keys(item)) {
    if (!KNOWN_FIELDS.has(key)) {
      warnings.push(`Row ${label}: unknown field '${key}'`);
    }
  }

  return row;
}

/**
 * Parse the text of a listening log into validated rows.
 *
 * The file must be a list (YAML sequence or JSON array) of row objects. Rows
 * that fail validation are skipped with a warning; a wholly malformed file
 * returns zero rows and one warning describing the failure. Nothing throws.
 *
 * @param content the raw text of the listening log
 * @param format 'yaml' or 'json'
 */
export function parseListeningLog(
  content: string,
  format: 'yaml' | 'json',
): ParseListeningLogResult {
  let parsed: unknown;
  try {
    parsed = format === 'yaml' ? parseYaml(content) : JSON.parse(content);
  } catch (error) {
    const kind = format === 'yaml' ? 'YAML' : 'JSON';
    const message = error instanceof Error ? error.message : String(error);
    return { rows: [], warnings: [`Invalid ${kind}: ${message}`] };
  }

  // An empty file parses to null in YAML and is a legitimate "nothing logged
  // yet" state, not an error worth warning about.
  if (parsed === null || parsed === undefined) {
    return { rows: [], warnings: [] };
  }

  if (!Array.isArray(parsed)) {
    return {
      rows: [],
      warnings: [`The listening log must be a list of rows, got ${describeType(parsed)}`],
    };
  }

  const warnings: string[] = [];
  const rows: RawListeningRow[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const row = validateRow(parsed[i], i, warnings);
    if (row !== undefined) {
      rows.push(row);
    }
  }

  return { rows, warnings };
}
