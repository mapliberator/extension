/**
 * Archive entry names: `<sequence>-<slug>.<ext>` (PRD §8.4). Source-provided strings never form
 * paths: the slug alphabet is [a-z0-9-] and the sequence guarantees uniqueness.
 */
import type { ObjectType } from '../shared/schemas';

export const SLUG_MAX = 60;

export const DIRECTORIES = {
	track: 'tracks',
	route: 'routes',
	photo: 'photos'
} as const;

export function formatSequence(sequence: number): string {
	return String(sequence).padStart(6, '0');
}

export function archiveId(type: ObjectType, sequence: number): string {
	return `${type}/${formatSequence(sequence)}`;
}

/** ASCII-fold and reduce a display name to a safe slug. Returns '' when nothing survives. */
export function slugify(name: string): string {
	const folded = name
		.normalize('NFKD')
		.replace(/\p{M}+/gu, '')
		.replace(/ß/g, 'ss')
		.replace(/[æÆ]/g, 'ae')
		.replace(/[øØ]/g, 'o')
		.replace(/[đĐ]/g, 'd')
		.replace(/[łŁ]/g, 'l')
		.toLowerCase();
	let slug = folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	if (slug.length > SLUG_MAX) {
		slug = slug.slice(0, SLUG_MAX).replace(/-+$/g, '');
	}
	return slug;
}

/** `000001-mount-whitney-loop` — or just `000001` when the name has no usable characters. */
export function baseName(sequence: number, name: string | null | undefined): string {
	const slug = slugify(name ?? '');
	return slug ? `${formatSequence(sequence)}-${slug}` : formatSequence(sequence);
}

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
	'image/jpeg': 'jpg',
	'image/jpg': 'jpg',
	'image/png': 'png',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/heic': 'heic',
	'image/heif': 'heif',
	'image/avif': 'avif',
	'image/tiff': 'tif',
	'image/bmp': 'bmp',
	'video/mp4': 'mp4',
	'video/quicktime': 'mov',
	'video/webm': 'webm'
};

/** Photo extensions derive from the response Content-Type, never from the source URL. */
export function extensionForContentType(contentType: string | null | undefined): string {
	const mime = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
	return CONTENT_TYPE_EXTENSIONS[mime] ?? 'bin';
}

export function normalizeContentType(contentType: string | null | undefined): string {
	const mime = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
	return mime || 'application/octet-stream';
}
