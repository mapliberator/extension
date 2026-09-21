<script lang="ts">
	import { SOURCES, sourceForUrl, type SourceDescriptor } from '../../adapters';
	import type { OpenExportMessage } from '../../shared/messages';

	let detected = $state<SourceDescriptor | null>(null);

	// activeTab exposes the URL of the tab the toolbar button was clicked on — and nothing else.
	// The popup never checks login state: that would need host access nobody asked for yet.
	$effect(() => {
		void browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
			detected = sourceForUrl(tab?.url);
		});
	});

	async function open(source: SourceDescriptor) {
		// The background service worker only opens the export page; no export state lives there.
		await browser.runtime.sendMessage({
			type: 'open-export',
			source: source.id
		} satisfies OpenExportMessage);
		window.close();
	}
</script>

<main class="w-72 p-4">
	<h1 class="text-base font-semibold">MapLiberator</h1>
	<p class="text-muted mt-1 text-xs">
		Export your own maps into an open archive. Everything happens in this browser.
	</p>

	{#if detected}
		{@const source = detected}
		<button
			class="btn-primary mt-4 w-full"
			data-testid="export-detected"
			onclick={() => open(source)}
		>
			Export from {source.label} →
		</button>
	{:else}
		<p class="mt-4 text-xs font-medium">Supported sites</p>
		<ul class="mt-2 space-y-2">
			{#each SOURCES as source (source.id)}
				<li>
					<button
						class="btn w-full text-left"
						data-testid={`source-${source.id}`}
						onclick={() => open(source)}
					>
						{source.label}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</main>
