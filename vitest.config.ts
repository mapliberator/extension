import { defineConfig } from 'vitest/config';

// STATIC stage: pure unit suites. Nothing here needs a browser or a build.
export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/*.test.ts'],
		testTimeout: 60_000,
		// Lets the fake-source streaming test collect garbage before it measures memory.
		execArgv: ['--expose-gc'],
		allowOnly: false
	}
});
