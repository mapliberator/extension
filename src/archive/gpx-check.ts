/**
 * Streaming sanity check for native GPX (PRD §6.3): well-formed XML, `<gpx>` root, at least one
 * point. It keeps HTML error pages and login redirects that arrive with a 200 out of the archive,
 * and counts points for the sidecar.
 */
import { SaxesParser } from 'saxes';

export class GpxCheckError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GpxCheckError';
	}
}

export interface GpxCheckResult {
	pointCount: number;
}

export class GpxStreamCheck {
	private readonly parser = new SaxesParser({ xmlns: false, position: false });
	private failure: GpxCheckError | null = null;
	private sawRoot = false;
	private depth = 0;
	private pointCount = 0;
	private finished = false;

	constructor() {
		this.parser.on('error', (error) => {
			this.failure ??= new GpxCheckError(`not well-formed XML: ${error.message}`);
		});
		this.parser.on('opentag', (tag) => {
			if (this.depth === 0) {
				this.sawRoot = true;
				if (localName(tag.name) !== 'gpx') {
					this.failure ??= new GpxCheckError(`root element is <${tag.name}>, expected <gpx>`);
				}
			}
			this.depth++;
			const name = localName(tag.name);
			if (name === 'trkpt' || name === 'rtept') this.pointCount++;
		});
		this.parser.on('closetag', () => {
			this.depth--;
		});
	}

	/** Feed the next piece of text. Throws as soon as the document cannot be valid GPX. */
	write(text: string): void {
		if (this.finished) throw new Error('GpxStreamCheck already finished');
		if (this.failure) throw this.failure;
		try {
			this.parser.write(text);
		} catch (error) {
			this.failure ??= new GpxCheckError(`not well-formed XML: ${(error as Error).message}`);
		}
		if (this.failure) throw this.failure;
	}

	finish(): GpxCheckResult {
		this.finished = true;
		if (!this.failure) {
			try {
				this.parser.close();
			} catch (error) {
				this.failure ??= new GpxCheckError(`not well-formed XML: ${(error as Error).message}`);
			}
		}
		if (this.failure) throw this.failure;
		if (!this.sawRoot) throw new GpxCheckError('empty document');
		if (this.pointCount === 0) throw new GpxCheckError('GPX contains no track or route points');
		return { pointCount: this.pointCount };
	}
}

function localName(name: string): string {
	const colon = name.indexOf(':');
	return colon === -1 ? name : name.slice(colon + 1);
}
