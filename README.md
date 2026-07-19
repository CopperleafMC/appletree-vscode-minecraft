# Appletree Minecraft Tools

An early prototype of **Appletree Minecraft Tools**, a VS Code extension for building, validating, launching, and locally deploying Minecraft projects through a small project-owned profile.

The core design rule is that the extension orchestrates workflows; it does not replace Gradle, Fabric Loom, ForgeGradle, NeoGradle, project scripts, or launchers. Each repository remains the authority for its own commands.

This is an independent Git repository inside **minecraft Copperleaf**. Its recommended remote repository slug is `appletree-vscode-minecraft`; the shared protocol/schema foundation will later live in the separate `Appletree` project. The current ownership contract is maintained in the sibling **Metaler Render** project under `docs/PROJECT_FAMILY.md`.

## Prototype experience

The **Appletree Minecraft Tools** Activity Bar container has three views:

- **Project** — project name, adapter, loader, Minecraft version, mod version, profile, and newest deployable artifact.
- **Actions** — environment check, native build when present, full build, tests, development launch, and local artifact deployment.
- **Runtime Evidence** — one-click access to the active client log, newest crash report, and screenshots folder.

The same operations are available in the Command Palette and as auto-detected VS Code tasks.

Profiles can also publish deterministic suites into VS Code's native **Test Explorer**. Metaler exposes four independently runnable lanes:

- JNI and Java command contracts;
- the sanitized native render-command decoder;
- ordered Metal texture uploads;
- ray-tracing V2 ownership and completion lifetime.

Test output streams into VS Code, cancellation terminates the child process, and each lane receives its own pass/fail duration. These tests exercise real project scripts and Gradle tasks; the extension does not duplicate test logic.

## Profile-driven design

Each project supplies a `minecraft-project.json` file at its workspace root. The bundled JSON schema drives both editor validation and runtime validation. Multi-root workspaces can contain multiple profiled projects; views, tasks, tests, evidence, and commands remain scoped to the owning root. A profile declares:

- metadata used for display and artifact discovery;
- optional operating-system, architecture, and remote-host constraints;
- named commands with an executable and argument array;
- named operation locks that prevent incompatible builds and clients from overlapping;
- independently runnable Test Explorer suites;
- optional log, crash-report, and screenshot evidence paths;
- an optional save directory and default development world;
- zero or more local copy deployment targets.

This allows one extension to support Fabric, Forge, NeoForge, Quilt, and unusual native/JNI projects without hard-coding one project's shell commands.

Metaler is the first profile. It calls the stable project-owned `scripts/metalerctl` facade so Java 25 selection, `--no-daemon`, native verification, single-client checks, and direct-world launch behavior stay in one authoritative place. Private Gradle tasks and skill-script paths are not extension APIs.

## Safety model

- Static extension UI is available in Restricted Mode, but project profiles are not trusted or loaded there.
- Profile inspection, build, test, launch, and deployment require Workspace Trust because profiles can select repository-controlled programs.
- Process arguments are passed as an array through VS Code tasks rather than assembled as a shell command line.
- Deployment is local-copy only in this prototype and is confirmed before writing.
- A profile can opt into removing older matching mod JARs, but the included Metaler target is copy-only and non-destructive.
- The extension never edits Minecraft saves, runtime configuration, source, or roadmap files.

## Metaler profile

The profile currently exposes:

| Action | Repository authority |
| --- | --- |
| Check environment | `scripts/metalerctl environment` |
| Build native | `scripts/metalerctl build native` |
| Build project | `scripts/metalerctl build full` |
| Run contracts | `scripts/metalerctl test <lane>` |
| Launch world | `scripts/metalerctl launch <world>` |
| Launch Metal visual variant | `scripts/metalerctl visual metal <world>` |
| Launch vanilla baseline | `scripts/metalerctl visual vanilla <world>` |
| Capture frame-hitch profile | `scripts/metalerctl profile <threshold> <world>` |
| Summarize profile | `scripts/metalerctl profile-summary` |
| Capture CPU/GPU/RSS usage | `scripts/metalerctl usage` |
| Deploy | Copy newest non-sources JAR into the selected local mods folder |

The development-world picker is populated from `run/saves`. Long-running launches use a dedicated task terminal, so the client can be stopped through VS Code's normal task controls.

## Additional Minecraft testing worth adding

The next useful layers are deliberately different from deterministic contract tests:

1. **Profile runs** — wrap the existing hitch profiler and summary scripts, then surface median, p99, worst-frame, hitch, GPU, and GC evidence.
2. **Guided visual A/B cards** — launch one Metal or vanilla variant at a time, lock the world and diagnostic variable, and record a user-supplied pass/fail/inconclusive verdict. A build cannot automatically prove rendering correctness.
3. **GameTest or headless integration suites** — when a future project supplies deterministic in-world GameTests, expose them as additional profile test entries.
4. **Screenshot regression assistance** — capture matching views and present diffs, but retain a human verdict for antialiasing, temporal, and driver-dependent rendering differences.
5. **Startup smoke verification** — observe backend-active and world-join log markers, with a timeout and clean client shutdown. This should use a dedicated project script rather than guessing from the extension.

## Extension settings

- `minecraftProjectDeploy.profileFile` — workspace-relative profile path; defaults to `minecraft-project.json`.
- `minecraftProjectDeploy.autoRevealOutput` — reveal the task terminal when an operation starts.
- `minecraftProjectDeploy.confirmDeploy` — always require deployment confirmation.

## Development

1. Open this folder as the extension-development workspace.
2. Run `npm run compile` for type checking, linting, and an esbuild development bundle.
3. Press F5 to launch an Extension Development Host, then open any trusted workspace containing one or more `minecraft-project.json` profiles.
4. Select the Appletree Minecraft Tools icon in that host.
5. Run `npm test` for extension-host tests, `npm run package` for a production bundle, or `npm run vsix` for an installable package under `artifacts/`.

## Intentionally deferred

- automatic generation/migration of profiles;
- dedicated Fabric/Forge/NeoForge/Quilt adapters;
- remote server upload over SSH/SFTP;
- Modrinth or CurseForge publishing;
- server lifecycle and log-health checks;
- launch success parsing and richer diagnostics;
- Marketplace publisher identity and release automation.

These should follow only after the local Metaler workflow is exercised and the reusable profile boundary is stable.
