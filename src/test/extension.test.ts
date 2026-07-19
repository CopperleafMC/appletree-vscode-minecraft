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
			['world', 'MetalerTest'],
		]);

		assert.strictEqual(
			expandVariables('${workspaceFolder}/run/saves/${world}', variables),
			'/tmp/My Project/run/saves/MetalerTest',
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

	test('uses the bundled schema for runtime profile validation', () => {
		const schema = JSON.parse(
			fs.readFileSync(path.join(__dirname, '../../schemas/minecraft-project.schema.json'), 'utf8'),
		) as object;
		const validate = createProfileValidator(schema);
		const profile = validate({
			name: 'Fixture',
			adapter: 'script',
			commands: {
				build: {
					label: 'Build',
					executable: 'bash',
					locks: ['workspace-build'],
				},
			},
		});
		assert.strictEqual(profile.name, 'Fixture');
		assert.throws(
			() => validate({ name: 'Broken', adapter: 'script', commands: { unknown: { label: 'X', executable: 'x' } } }),
			/schema validation failed/u,
		);
	});

	test('rejects unknown variables before launching project code', () => {
		assert.doesNotThrow(() => assertNoUnexpandedVariables(['/tmp/project', 'MetalerTest']));
		assert.throws(
			() => assertNoUnexpandedVariables(['/tmp/${unknown}']),
			/unknown variable/u,
		);
	});

	test('matches only files selected by a simple deployment glob', () => {
		const matcher = simpleGlob('metaler-*.jar');

		assert.strictEqual(matcher.test('metaler-0.1.0.jar'), true);
		assert.strictEqual(matcher.test('metaler-0.1.0-sources.jar'), true);
		assert.strictEqual(matcher.test('other-mod.jar'), false);
		assert.strictEqual(matcher.test('metaler-0.1.0.zip'), false);
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
