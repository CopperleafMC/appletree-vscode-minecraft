import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	launchArgs: [
		`--user-data-dir=${mkdtempSync(join(tmpdir(), 'appletree-vscode-test-'))}`,
	],
});
