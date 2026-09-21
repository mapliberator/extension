import { defineConfig } from 'vitest/config';

// BUILD stage: assertions about the built extensions in .output/ (run after both builds).
export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/build/*.test.ts'],
		allowOnly: false
	}
});
