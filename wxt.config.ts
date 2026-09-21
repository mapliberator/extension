import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';
import { matchPatternsFor, sourceHosts } from './src/adapters/hosts';

export default defineConfig({
	srcDir: 'src',
	modules: ['@wxt-dev/module-svelte'],
	manifestVersion: 3,
	vite: ({ mode }) => ({
		plugins: [tailwindcss()],
		// Lets production bundles tree-shake the fake-source hosts (src/adapters/hosts.ts).
		define: { __E2E__: JSON.stringify(mode === 'e2e') }
	}),
	zip: {
		artifactTemplate: 'mapliberator-{{version}}-{{browser}}.zip'
	},
	manifest: ({ mode, browser }) => {
		const hosts = Object.values(sourceHosts(mode)).flatMap(matchPatternsFor);
		return {
			name: 'MapLiberator',
			description:
				'Export your routes, tracks, waypoints and photos from outdoor mapping services into an open archive, locally in your browser.',
			permissions: ['activeTab', 'scripting', 'downloads', 'unlimitedStorage'],
			// Host access is optional and requested per source at first use (PRD §17).
			optional_host_permissions: hosts,
			// Browser permission prompts cannot be driven by Playwright, so the e2e build (which can
			// only ever reach tools/fake-source on *.localhost) has its hosts granted at install.
			...(mode === 'e2e' ? { host_permissions: hosts } : {}),
			action: { default_title: 'MapLiberator' },
			...(browser === 'firefox'
				? {
						browser_specific_settings: {
							gecko: {
								id: 'mapliberator@mapliberator.com',
								strict_min_version: '140.0',
								data_collection_permissions: { required: ['none'] }
							}
						}
					}
				: { minimum_chrome_version: '116' })
		};
	}
});
