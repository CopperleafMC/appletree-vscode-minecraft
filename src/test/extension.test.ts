import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
	assertNoUnexpandedVariables,
	createProfileValidator,
	expandVariables,
	formatProcessInvocation,
	OperationLocks,
	simpleGlob,
	toTerminalLines,
} from '../extension';

suite('Extension Test Suite', () => {
	test('expands known profile variables without interpreting shell syntax', () => {
		const variables = new Map([
			['workspaceFolder', '/tmp/My Project'],
			['world', 'ExampleWorld'],
		]);

		assert.strictEqual(
			expandVariables('${workspaceFolder}/run/saves/${world}', variables),
			'/tmp/My Project/run/saves/ExampleWorld',
		);
		assert.strictEqual(expandVariables('${unknown}', variables), '${unknown}');
	});

	test('excludes conflicting operations before process spawn', () => {
		const locks = new OperationLocks();
		const release = locks.acquire('file:///project-a', 'Project A', 'Build', ['workspace-build']);
		assert.throws(
			() => locks.acquire('file:///project-a', 'Project A', 'Test', ['workspace-build']),
			/Build in Project A already holds workspace-build/u,
		);
		assert.doesNotThrow(() => {
			const releaseOther = locks.acquire('file:///project-b', 'Project B', 'Build', ['workspace-build']);
			releaseOther();
		});
		release();
		assert.doesNotThrow(() => locks.acquire('file:///project-a', 'Project A', 'Test', ['workspace-build'])());
	});

	test('accepts profile-defined actions during runtime validation', () => {
		const schema = JSON.parse(
			fs.readFileSync(path.join(__dirname, '../../schemas/minecraft-project.schema.json'), 'utf8'),
		) as object;
		const validate = createProfileValidator(schema);
		const profile = validate({
			name: 'Fixture',
			adapter: 'script',
			commands: {
				generateAssets: {
					label: 'Generate assets',
					icon: 'file-media',
					executable: 'bash',
					locks: ['workspace-build'],
				},
			},
		});
		assert.strictEqual(profile.name, 'Fixture');
		assert.strictEqual(profile.commands.generateAssets.label, 'Generate assets');
		assert.throws(
			() => validate({ name: 'Broken', adapter: 'script', commands: { broken: { label: 'Missing executable' } } }),
			/schema validation failed/u,
		);
	});

	test('accepts standard world and visual comparison workflows', () => {
		const schema = JSON.parse(
			fs.readFileSync(path.join(__dirname, '../../schemas/minecraft-project.schema.json'), 'utf8'),
		) as object;
		const validate = createProfileValidator(schema);
		const profile = validate({
			name: 'Visual Fixture',
			adapter: 'script',
			commands: {
				launch: {
					label: 'Launch world',
					executable: './project-tool',
					args: ['launch', '${world}'],
				},
				visualPrimary: {
					label: 'Launch primary renderer',
					icon: 'eye',
					executable: './project-tool',
					args: ['visual', 'primary', '${world}'],
				},
				visualBaseline: {
					label: 'Launch baseline renderer',
					icon: 'compare-changes',
					executable: './project-tool',
					args: ['visual', 'baseline', '${world}'],
				},
			},
			worlds: {
				directory: 'run/saves',
				default: 'DevelopmentWorld',
			},
		});

		assert.strictEqual(profile.worlds?.default, 'DevelopmentWorld');
		assert.strictEqual(profile.commands.visualPrimary.icon, 'eye');
	});

	test('rejects unknown variables before launching project code', () => {
		assert.doesNotThrow(() => assertNoUnexpandedVariables(['/tmp/project', 'ExampleWorld']));
		assert.throws(
			() => assertNoUnexpandedVariables(['/tmp/${unknown}']),
			/unknown variable/u,
		);
	});

	test('matches only files selected by a simple deployment glob', () => {
		const matcher = simpleGlob('example-mod-*.jar');

		assert.strictEqual(matcher.test('example-mod-0.1.0.jar'), true);
		assert.strictEqual(matcher.test('example-mod-0.1.0-sources.jar'), true);
		assert.strictEqual(matcher.test('other-mod.jar'), false);
		assert.strictEqual(matcher.test('example-mod-0.1.0.zip'), false);
	});

	test('formats external test output for the VS Code test terminal', () => {
		assert.strictEqual(toTerminalLines('one\ntwo\r\n'), 'one\r\ntwo\r\n');
	});

	test('renders external test invocations without shell execution', () => {
		assert.strictEqual(
			formatProcessInvocation('bash', ['script.sh', 'New World']),
			'bash script.sh "New World"',
		);
	});
});
