# Appletree Minecraft Tools

Build, test, launch, inspect, and locally deploy Minecraft projects from VS Code.

Appletree runs commands owned by each repository. It works with Fabric, Forge, NeoForge, Quilt, vanilla projects, and custom script-based toolchains without replacing Gradle or project scripts.

## Features

- Standard build, test, launch, visual comparison, profiling, and usage workflows
- Persistent development-world selection for `${world}` commands
- Custom project actions and detected VS Code tasks
- Profile-defined Test Explorer suites
- Multi-root workspace support
- Logs, crash reports, and screenshot shortcuts
- Local mod artifact deployment with confirmation
- Workspace Trust, operation locks, and process-tree cancellation

## Built-in workflows

Profiles opt into standard actions with conventional command IDs: `environment`, `buildNative`, `build`, `test`, `launch`, `visualPrimary`, `visualBaseline`, `profile`, `profileSummary`, and `usage`. These receive Command Palette entries and familiar icons; project labels and executables remain fully configurable.

Adding `worlds` enables **Select Development World...** and persists one choice per workspace. Commands containing `${world}` receive that selection. The `tests`, `evidence`, and `deployTargets` sections similarly enable Test Explorer, runtime shortcuts, and confirmed local deployment. Any other command ID appears as a custom action.

## Project setup

Add `minecraft-project.json` to a project root. Every command ID and label is project-defined:

```json
{
	"name": "Example Mod",
	"adapter": "script",
	"metadata": {
		"loader": "fabric",
		"artifactGlob": "build/libs/*.jar"
	},
	"commands": {
		"build": {
			"label": "Build mod",
			"executable": "./gradlew",
			"args": ["--no-daemon", "build"],
			"locks": ["workspace-build"]
		},
		"launch": {
			"label": "Launch client",
			"icon": "play",
			"executable": "./gradlew",
			"args": ["--no-daemon", "runClient", "--args=--quickPlaySingleplayer ${world}"],
			"longRunning": true,
			"locks": ["workspace-build", "minecraft-client"]
		}
	},
	"worlds": {
		"directory": "run/saves",
		"default": "DevelopmentWorld"
	}
}
```

Profiles may also declare host constraints, tests, worlds, runtime evidence, artifact rules, and local deployment targets. The bundled schema provides completion and validation.

## Safety

Profiles run repository-controlled programs, so execution requires Workspace Trust. Arguments are passed without shell assembly, conflicting operations can share locks, and deployment requires confirmation by default.

## Development

- `npm run compile` validates and bundles the extension.
- `npm test` runs extension-host tests.
- `npm run vsix` creates an installable package under `artifacts/`.

Released under the [MIT License](LICENSE).
