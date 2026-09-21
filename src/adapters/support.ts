/** Helpers shared by adapters. Nothing platform-specific lives here. */
import type { z } from 'zod';
import { AdapterOutdatedError, ItemError } from '../shared/errors';

export interface AdapterIdentity {
	label: string;
	version: string;
}

/**
 * Listing responses: a schema failure is fatal, because we cannot know what we are missing
 * (PRD §6.5).
 */
export function parseListing<S extends z.ZodType>(
	identity: AdapterIdentity,
	schema: S,
	json: unknown,
	what: string
): z.output<S> {
	const result = schema.safeParse(json);
	if (result.success) return result.data;
	throw new AdapterOutdatedError(
		identity.label,
		identity.version,
		`unexpected ${what} response: ${describeIssue(result.error)}`
	);
}

/** Single-item responses: a schema failure is an item-level error. */
export function parseItem<S extends z.ZodType>(schema: S, json: unknown): z.output<S> {
	const result = schema.safeParse(json);
	if (result.success) return result.data;
	throw new ItemError('schema', `unexpected response shape: ${describeIssue(result.error)}`);
}

/** Path and code only: never echo response values into errors. */
function describeIssue(error: z.ZodError): string {
	const issue = error.issues[0];
	if (!issue) return 'schema mismatch';
	return `${issue.path.join('.') || '(root)'}: ${issue.code}`;
}

/** Any parseable date → RFC 3339 UTC without milliseconds; null when unusable. */
export function toUtcTimestamp(value: string | number | null | undefined): string | null {
	if (value === null || value === undefined || value === '') return null;
	const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function nonEmpty(text: string | null | undefined): string | null {
	const trimmed = text?.trim();
	return trimmed ? trimmed : null;
}

export function finiteOrNull(value: number | null | undefined): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
