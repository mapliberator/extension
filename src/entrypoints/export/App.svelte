<script lang="ts">
	import { SOURCES } from '../../adapters';
	import { TYPE_ORDER, type PluralType } from '../../engine/progress';
	import { ExportSession, type SessionView } from '../../engine/session';
	import type { PauseReason } from '../../engine/state';
	import { formatBytes } from '../../shared/errors';
	import type { ExportSelection } from '../../shared/models';
	import { PLURAL } from '../../shared/schemas';

	const SPEC_URL = 'https://mapliberator.com/spec/';

	const LABELS: Record<PluralType, string> = {
		routes: 'Routes',
		tracks: 'Tracks / activities',
		waypoints: 'Waypoints',
		areas: 'Areas / polygons',
		collections: 'Folders / collections',
		photos: 'Photos'
	};
	const TYPES = TYPE_ORDER.map((type) => PLURAL[type]);

	const session = new ExportSession();
	let view = $state<SessionView>(session.current());
	let now = $state(Date.now());
	let copied = $state(false);

	type Preset = 'everything' | 'maps' | 'custom';
	let preset = $state<Preset>('everything');
	let selection = $state<ExportSelection>({
		routes: true,
		tracks: true,
		waypoints: true,
		areas: true,
		collections: true,
		photos: true,
		rawSourceData: true
	});

	$effect(() => {
		const unsubscribe = session.subscribe((next) => (view = next));
		void session.init(new URLSearchParams(location.search).get('source'));
		const clock = setInterval(() => (now = Date.now()), 500);
		return () => {
			unsubscribe();
			clearInterval(clock);
		};
	});

	function applyPreset(next: Preset) {
		preset = next;
		if (next === 'custom') return;
		selection = {
			routes: true,
			tracks: true,
			waypoints: true,
			areas: true,
			collections: true,
			photos: next === 'everything',
			rawSourceData: selection.rawSourceData
		};
	}

	const label = $derived(view.source?.label ?? 'your account');
	const paused = $derived(view.run.state === 'paused' ? view.run.pause : null);
	const nothingSelected = $derived(TYPES.every((type) => !selection[type]));
	const countdown = $derived.by(() => {
		if (!paused?.resumeAt) return null;
		const seconds = Math.max(0, Math.ceil((paused.resumeAt - now) / 1000));
		return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
	});

	function pauseTitle(reason: PauseReason): string {
		switch (reason) {
			case 'auth':
				return `your ${label} session ended.`;
			case 'rate-limited':
				return `${label} is rate-limiting requests.`;
			case 'challenge':
				return `${label} is showing a verification page.`;
			case 'network':
				return 'the network connection was lost.';
			case 'tab-lost':
				return `the ${label} tab was closed. Reopening it…`;
			case 'failures':
				return `${label} keeps returning errors.`;
		}
	}

	const errorsByType = $derived.by(() => {
		const groups = new Map<string, number>();
		for (const entry of view.result?.errors ?? []) {
			groups.set(entry.type, (groups.get(entry.type) ?? 0) + 1);
		}
		return [...groups];
	});

	async function copyReport() {
		await navigator.clipboard.writeText(session.diagnosticReport());
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
</script>

<main
	class="mx-auto max-w-xl px-6 py-12"
	data-testid="export-page"
	data-phase={view.phase}
	data-history={view.history}
>
	<h1 class="text-xl font-semibold">
		MapLiberator{#if view.source}
			— {view.source.label}{/if}
	</h1>

	{#if view.phase === 'starting'}
		<p class="text-muted mt-6 text-sm">Starting…</p>
	{:else if view.phase === 'locked-out'}
		<section class="card mt-6" data-testid="locked-out">
			<h2 class="font-semibold">An export is already running</h2>
			<p class="text-muted mt-2 text-sm">
				MapLiberator runs one export at a time. We switched you to the tab where it is running; you
				can close this one.
			</p>
		</section>
	{:else if view.phase === 'pick-source'}
		<section class="card mt-6">
			<h2 class="font-semibold">Where do you want to export from?</h2>
			<ul class="mt-4 space-y-2">
				{#each SOURCES as source (source.id)}
					<li>
						<button
							class="btn w-full text-left"
							data-testid={`pick-${source.id}`}
							onclick={() => session.chooseSource(source.id)}
						>
							{source.label}
						</button>
					</li>
				{/each}
			</ul>
		</section>
	{:else if view.phase === 'permission' || view.phase === 'connecting' || view.phase === 'ready'}
		<section class="card mt-6" data-testid="preflight">
			<ul class="space-y-2 text-sm">
				<li class="flex gap-3">
					<span class="w-4">{view.phase === 'permission' ? '·' : '✓'}</span>
					<span class="w-24 font-medium">Permission</span>
					<span class="text-muted">
						{#if view.phase === 'permission'}
							MapLiberator needs access to {label} to read your data.
						{:else}
							Access to {label} granted
						{/if}
					</span>
				</li>
				<li class="flex gap-3">
					<span class="w-4">{view.user ? '✓' : '·'}</span>
					<span class="w-24 font-medium">Session</span>
					<span class="text-muted">
						{#if view.user}Connected{:else if view.phase === 'connecting'}Connecting…{:else}—{/if}
					</span>
				</li>
				<li class="flex gap-3">
					<span class="w-4">{view.user ? '✓' : '·'}</span>
					<span class="w-24 font-medium">Account</span>
					<span class="text-muted">
						{#if view.user}
							Signed in as <strong data-testid="account-name">“{view.user.displayName}”</strong>
							<button class="ml-2 underline" onclick={() => session.showLogin()}>Not you?</button>
						{:else}—{/if}
					</span>
				</li>
			</ul>

			{#if view.phase === 'permission'}
				<button
					class="btn-primary mt-5"
					data-testid="grant-access"
					onclick={() => session.grantAndConnect()}
				>
					Allow access to {label}
				</button>
				{#if view.permissionDenied}
					<p class="text-danger mt-3 text-sm">
						Access was not granted. MapLiberator cannot read your data without it.
					</p>
				{/if}
				<p class="text-muted mt-3 text-xs">
					Your data never leaves this computer. MapLiberator only talks to {label}.
				</p>
			{/if}
		</section>
	{/if}

	{#if paused && (view.phase === 'connecting' || view.phase === 'exporting')}
		<section class="card border-warn mt-6" data-testid="paused" data-reason={paused.reason}>
			<h2 class="font-semibold">Paused — {pauseTitle(paused.reason)}</h2>
			{#if paused.reason === 'auth'}
				<p class="text-muted mt-2 text-sm">
					Sign in {view.phase === 'exporting' ? 'again ' : ''}in the {label} tab, then resume.
				</p>
			{:else if paused.reason === 'challenge'}
				<p class="text-muted mt-2 text-sm">
					Switch to the {label} tab, complete the check, then resume.
				</p>
			{/if}
			{#if countdown}
				<p class="mt-2 text-sm" data-testid="auto-resume">Resuming automatically in {countdown}</p>
			{/if}
			<div class="mt-4 flex gap-2">
				{#if paused.reason === 'auth' || paused.reason === 'challenge'}
					<button class="btn" onclick={() => session.showLogin()}>Open the {label} tab</button>
				{/if}
				<button class="btn-primary" data-testid="resume" onclick={() => session.resume()}>
					{paused.resumeAt ? 'Resume now' : view.phase === 'connecting' ? 'Retry' : 'Resume'}
				</button>
				<button class="btn" onclick={() => session.cancel()}>Cancel</button>
			</div>
		</section>
	{/if}

	{#if view.phase === 'ready'}
		<section class="card mt-6" data-testid="selection">
			<h2 class="font-semibold">Export</h2>
			<ul class="mt-3 space-y-2 text-sm">
				{#each TYPES as type (type)}
					<li class="flex items-center gap-3">
						<label class="flex flex-1 items-center gap-2">
							<input
								type="checkbox"
								data-testid={`select-${type}`}
								bind:checked={selection[type]}
								onchange={() => (preset = 'custom')}
							/>
							{LABELS[type]}
						</label>
						{#if view.counts[type] !== null && view.counts[type] !== undefined}
							<span class="text-muted tabular-nums">
								{type === 'photos' ? '~' : ''}{view.counts[type]?.toLocaleString()}
							</span>
						{/if}
					</li>
				{/each}
			</ul>
			<p class="text-muted mt-1 pl-6 text-xs">Photos can make archives very large.</p>

			<label class="mt-4 flex items-center gap-2 text-sm">
				<input type="checkbox" data-testid="select-raw" bind:checked={selection.rawSourceData} />
				Include raw source data
			</label>

			{#each view.source?.notes ?? [] as note (note)}
				<p class="text-muted mt-3 text-xs">{note}</p>
			{/each}
			<p class="text-muted mt-3 text-xs">
				Content you saved but did not create is exported as links, never as copies.
			</p>

			<div class="mt-4 flex gap-4 text-sm">
				{#each [['everything', 'Everything'], ['maps', 'Maps only — no photos'], ['custom', 'Custom']] as [value, text] (value)}
					<label class="flex items-center gap-1.5">
						<input
							type="radio"
							name="preset"
							data-testid={`preset-${value}`}
							checked={preset === value}
							onchange={() => applyPreset(value as Preset)}
						/>
						{text}
					</label>
				{/each}
			</div>

			<button
				class="btn-primary mt-5"
				data-testid="start-export"
				disabled={nothingSelected}
				onclick={() => session.startExport($state.snapshot(selection))}
			>
				Export
			</button>
		</section>
	{/if}

	{#if view.phase === 'exporting' || view.phase === 'saving'}
		<section class="card mt-6" data-testid="progress" data-state={view.run.state}>
			<h2 class="font-semibold">
				{view.phase === 'saving' || view.run.state === 'finalizing'
					? 'Finalizing…'
					: `Exporting ${label}`}
			</h2>
			<ul class="mt-3 space-y-1 text-sm">
				{#each TYPES as type (type)}
					{@const row = view.progress.types[type]}
					{#if row.selected}
						<li class="flex justify-between">
							<span>{LABELS[type]}</span>
							<span class="tabular-nums" data-testid={`progress-${type}`}>
								{#if row.total !== null}
									{row.done + row.errors} / {Math.max(row.total, row.done + row.errors)}
								{:else}
									{row.done} exported
								{/if}
							</span>
						</li>
					{/if}
				{/each}
			</ul>
			<div class="border-line mt-4 flex justify-between border-t pt-3 text-sm">
				<span>Overall</span>
				<span class="tabular-nums">
					{view.progress.overall === null ? '—' : `${Math.floor(view.progress.overall * 100)}%`}
				</span>
			</div>
			<div class="text-muted mt-1 flex justify-between text-sm">
				<span data-testid="bytes-written">{formatBytes(view.progress.bytesWritten)} written</span>
				<span>{view.progress.errorCount} errors</span>
			</div>
			{#if view.progress.currentName && view.phase === 'exporting'}
				<p class="text-muted mt-2 truncate text-xs">{view.progress.currentName}</p>
			{/if}
			{#if view.storageWarning}
				<p class="text-warn mt-3 text-sm">{view.storageWarning}</p>
			{/if}
			<p class="text-muted mt-4 text-xs">Keep your computer awake during large exports.</p>

			{#if view.result?.saveInterrupted}
				<p class="text-warn mt-4 text-sm">
					The download did not finish. Your archive is still here.
				</p>
				<div class="mt-3 flex gap-2">
					<button class="btn-primary" data-testid="save-again" onclick={() => session.saveAgain()}>
						Save archive
					</button>
					<button class="btn" onclick={() => session.cancel()}>Discard</button>
				</div>
			{:else if view.phase === 'exporting'}
				<button class="btn mt-4" data-testid="cancel" onclick={() => session.cancel()}>
					Cancel
				</button>
			{/if}
		</section>
	{/if}

	{#if view.phase === 'done' && view.result}
		{@const result = view.result}
		{@const status = result.manifest.status}
		<section class="card mt-6" data-testid="done" data-status={status}>
			<h2 class={`text-lg font-semibold ${status === 'complete' ? 'text-accent' : 'text-warn'}`}>
				{status === 'complete' ? 'Complete' : 'Partial export'}
			</h2>
			<p class="text-muted mt-1 text-sm">
				{result.filename} · {formatBytes(result.bytesWritten)}
			</p>
			{#if status === 'partial'}
				<p class="text-warn mt-2 text-sm">
					Some items could not be exported. They are listed in errors.json inside the archive.
				</p>
			{/if}
			<ul class="mt-4 space-y-1 text-sm">
				{#each TYPES as type (type)}
					{#if result.manifest.selection[type] === 'included'}
						<li class="flex justify-between">
							<span>{LABELS[type]}</span>
							<span class="tabular-nums">{result.manifest.contents[type]}</span>
						</li>
					{/if}
				{/each}
			</ul>
			{#if errorsByType.length > 0}
				<h3 class="mt-4 text-sm font-medium">Errors</h3>
				<ul class="text-danger mt-1 space-y-1 text-sm">
					{#each errorsByType as [type, count] (type)}
						<li class="flex justify-between"><span>{type}</span><span>{count}</span></li>
					{/each}
				</ul>
			{/if}
			<div class="mt-5 flex flex-wrap gap-2">
				{#if result.downloadId !== null}
					<button class="btn" onclick={() => session.showInFolder()}>Show in folder</button>
				{/if}
				<button class="btn" data-testid="copy-report" onclick={copyReport}>
					{copied ? 'Copied' : 'Copy diagnostic report'}
				</button>
				<a class="btn" href={SPEC_URL} target="_blank" rel="noreferrer">What can open this?</a>
			</div>
		</section>
	{/if}

	{#if view.phase === 'failed'}
		<section class="card border-danger mt-6" data-testid="failed">
			<h2 class="text-danger font-semibold">The export could not be completed</h2>
			<p class="mt-2 text-sm whitespace-pre-line" data-testid="failure-message">{view.failure}</p>
			<p class="text-muted mt-2 text-sm">Nothing was saved, and no partial file was left behind.</p>
			<div class="mt-4 flex gap-2">
				<button class="btn-primary" onclick={() => location.reload()}>Start over</button>
				<button class="btn" onclick={copyReport}>
					{copied ? 'Copied' : 'Copy diagnostic report'}
				</button>
			</div>
		</section>
	{/if}

	{#if view.phase === 'cancelled'}
		<section class="card mt-6" data-testid="cancelled">
			<h2 class="font-semibold">Export cancelled</h2>
			<p class="text-muted mt-2 text-sm">Nothing was saved, and no partial file was left behind.</p>
			<button class="btn-primary mt-4" onclick={() => location.reload()}>Start over</button>
		</section>
	{/if}
</main>
