import * as os from 'os';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import Ajv2020, { ErrorObject, ValidateFunction } from 'ajv/dist/2020';
import * as vscode from 'vscode';

const taskType = 'minecraft-project';
const source = 'Appletree Minecraft Tools';

type Operation =
  | 'environment'
  | 'buildNative'
  | 'build'
  | 'test'
  | 'launch'
  | 'visualMetal'
  | 'visualVanilla'
  | 'profile'
  | 'profileSummary'
  | 'usage';

interface ProjectCommand {
  label: string;
  executable: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  longRunning?: boolean;
  locks?: string[];
}

interface ProjectTest extends ProjectCommand {
  id: string;
  description?: string;
}

interface EvidenceConfiguration {
  latestLog?: string;
  crashReportsGlob?: string;
  screenshotsGlob?: string;
}

interface ProjectMetadata {
  loader?: string;
  minecraftVersionProperty?: string;
  modVersionProperty?: string;
  artifactGlob?: string;
  excludeArtifactGlobs?: string[];
}

interface WorldConfiguration {
  directory: string;
  default?: string;
}

interface DeployTarget {
  id: string;
  label: string;
  type: 'copy';
  destination: string;
  cleanMatching?: string;
  requiresConfirmation?: boolean;
  locks?: string[];
}

interface ProjectProfile {
  name: string;
  adapter: string;
  platforms?: NodeJS.Platform[];
  architectures?: string[];
  remoteSupported?: boolean;
  metadata?: ProjectMetadata;
  commands: Partial<Record<Operation, ProjectCommand>>;
  tests?: ProjectTest[];
  evidence?: EvidenceConfiguration;
  worlds?: WorldConfiguration;
  deployTargets?: DeployTarget[];
}

interface LoadedProject {
  folder: vscode.WorkspaceFolder;
  profileUri: vscode.Uri;
  profile: ProjectProfile;
  properties: Map<string, string>;
}

interface MinecraftTaskDefinition extends vscode.TaskDefinition {
  operation: Operation;
  projectFolder: string;
}

type ProfileValidator = (value: unknown) => ProjectProfile;

export class OperationLocks {
  private readonly holders = new Map<string, string>();

  acquire(
    projectKey: string,
    projectName: string,
    owner: string,
    locks: readonly string[]
  ): () => void {
    const acquired: string[] = [];
    for (const lock of locks) {
      const key = `${projectKey}\0${lock}`;
      const holder = this.holders.get(key);
      if (holder) {
        for (const acquiredKey of acquired) {
          this.holders.delete(acquiredKey);
        }
        throw new Error(
          `Operation blocked: ${holder} in ${projectName} already holds ${lock}.`
        );
      }
      this.holders.set(key, owner);
      acquired.push(key);
    }
    return () => {
      for (const key of acquired) {
        if (this.holders.get(key) === owner) {
          this.holders.delete(key);
        }
      }
    };
  }
}

class ProjectTaskTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;
  private readonly closeEmitter = new vscode.EventEmitter<number>();
  readonly onDidClose = this.closeEmitter.event;

  private child: ChildProcess | undefined;
  private releaseLocks: (() => void) | undefined;
  private settled = false;

  constructor(
    private readonly project: LoadedProject,
    private readonly command: ProjectCommand,
    private readonly args: string[],
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly operationLocks: OperationLocks
  ) {}

  open(): void {
    try {
      this.releaseLocks = this.operationLocks.acquire(
        this.project.folder.uri.toString(),
        this.project.folder.name,
        this.command.label,
        this.command.locks ?? []
      );
      this.writeEmitter.fire(
        `> ${formatProcessInvocation(this.command.executable, this.args)}\r\n`
      );
      this.child = spawn(this.command.executable, this.args, {
        cwd: this.cwd,
        env: this.env,
        shell: false,
        detached: process.platform !== 'win32',
      });
      this.child.stdout?.on('data', (chunk: Buffer) =>
        this.writeEmitter.fire(toTerminalLines(chunk.toString()))
      );
      this.child.stderr?.on('data', (chunk: Buffer) =>
        this.writeEmitter.fire(toTerminalLines(chunk.toString()))
      );
      this.child.once('error', (error) => {
        this.writeEmitter.fire(`${messageOf(error)}\r\n`);
        this.finish(1);
      });
      this.child.once('close', (code, signal) => {
        if (signal) {
          this.writeEmitter.fire(`Process exited from signal ${signal}.\r\n`);
        }
        this.finish(code ?? (signal ? 1 : 0));
      });
    } catch (error) {
      this.writeEmitter.fire(`${messageOf(error)}\r\n`);
      this.finish(1);
    }
  }

  close(): void {
    if (this.child) {
      terminateProcessTree(this.child);
    } else {
      this.finish(130);
    }
  }

  private finish(exitCode: number): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.releaseLocks?.();
    this.releaseLocks = undefined;
    this.closeEmitter.fire(exitCode);
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }
}

class ProjectService implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  private cachedProjects: LoadedProject[] | undefined;
  private watchers: vscode.FileSystemWatcher[] = [];

  constructor(private readonly validateProfile: ProfileValidator) {
    this.resetWatcher();
  }

  dispose(): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.changeEmitter.dispose();
  }

  refresh(): void {
    this.cachedProjects = undefined;
    this.resetWatcher();
    this.changeEmitter.fire();
  }

  async getProjects(): Promise<LoadedProject[]> {
    if (!vscode.workspace.isTrusted) {
      return [];
    }
    if (this.cachedProjects) {
      return this.cachedProjects;
    }

    const projects: LoadedProject[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const project = await this.loadProject(folder);
      if (project) {
        projects.push(project);
      }
    }
    this.cachedProjects = projects;
    return projects;
  }

  async getProject(folderUri?: vscode.Uri | string): Promise<LoadedProject | undefined> {
    const projects = await this.getProjects();
    if (folderUri === undefined) {
      return projects.length === 1 ? projects[0] : undefined;
    }
    const key = typeof folderUri === 'string' ? folderUri : folderUri.toString();
    return projects.find((project) => project.folder.uri.toString() === key);
  }

  async requireProject(folderUri?: vscode.Uri | string): Promise<LoadedProject> {
    if (folderUri !== undefined) {
      const project = await this.getProject(folderUri);
      if (project) {
        return project;
      }
      throw new Error('The selected workspace folder has no valid Minecraft project profile.');
    }

    const projects = await this.getProjects();
    if (projects.length === 1) {
      return projects[0];
    }
    if (!projects.length) {
      throw new Error('No minecraft-project.json profile was found in the workspace.');
    }
    const selected = await vscode.window.showQuickPick(
      projects.map((project) => ({
        label: project.profile.name,
        description: project.folder.name,
        project,
      })),
      { placeHolder: 'Choose a Minecraft project', ignoreFocusOut: true }
    );
    if (!selected) {
      throw new Error('No Minecraft project was selected.');
    }
    return selected.project;
  }

  private async loadProject(folder: vscode.WorkspaceFolder): Promise<LoadedProject | undefined> {
    const profileFile = vscode.workspace
      .getConfiguration('minecraftProjectDeploy', folder.uri)
      .get<string>('profileFile', 'minecraft-project.json');
    const profileUri = vscode.Uri.joinPath(folder.uri, profileFile);

    try {
      const raw = await vscode.workspace.fs.readFile(profileUri);
      const profile = this.validateProfile(JSON.parse(new TextDecoder().decode(raw)));
      return {
        folder,
        profileUri,
        profile,
        properties: await readProperties(
          vscode.Uri.joinPath(folder.uri, 'gradle.properties')
        ),
      };
    } catch (error) {
      if (isFileNotFound(error)) {
        return undefined;
      }
      throw new Error(
        `Unable to load ${profileFile} from ${folder.name}: ${messageOf(error)}`
      );
    }
  }

  private resetWatcher(): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const profileFile = vscode.workspace
        .getConfiguration('minecraftProjectDeploy', folder.uri)
        .get<string>('profileFile', 'minecraft-project.json');
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, profileFile)
      );
      watcher.onDidCreate(() => this.refresh());
      watcher.onDidChange(() => this.refresh());
      watcher.onDidDelete(() => this.refresh());
      this.watchers.push(watcher);
      const propertiesWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, 'gradle.properties')
      );
      propertiesWatcher.onDidCreate(() => this.refresh());
      propertiesWatcher.onDidChange(() => this.refresh());
      propertiesWatcher.onDidDelete(() => this.refresh());
      this.watchers.push(propertiesWatcher);
    }
  }
}

class ProjectNode extends vscode.TreeItem {
  constructor(
    label: string,
    description: string | undefined,
    icon: string,
    command?: vscode.Command,
    readonly children: ProjectNode[] = []
  ) {
    super(
      label,
      children.length
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = command;
  }
}

class ProjectTreeProvider
  implements vscode.TreeDataProvider<ProjectNode>, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<
    ProjectNode | undefined
  >();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly projectChanged: vscode.Disposable;

  constructor(private readonly projects: ProjectService) {
    this.projectChanged = projects.onDidChange(() =>
      this.changeEmitter.fire(undefined)
    );
  }

  dispose(): void {
    this.projectChanged.dispose();
    this.changeEmitter.dispose();
  }

  getTreeItem(element: ProjectNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ProjectNode): Promise<ProjectNode[]> {
    if (element) {
      return element.children;
    }
    return Promise.all((await this.projects.getProjects()).map((project) => this.projectNode(project)));
  }

  private async projectNode(project: LoadedProject): Promise<ProjectNode> {
    const metadata = project.profile.metadata;
    const minecraftVersion = propertyValue(
      project,
      metadata?.minecraftVersionProperty
    );
    const modVersion = propertyValue(project, metadata?.modVersionProperty);
    const nodes = [
      new ProjectNode(project.profile.name, project.profile.adapter, 'game'),
      new ProjectNode(
        'Host',
        hostDescription(project.profile),
        hostCompatible(project.profile) ? 'vm' : 'warning'
      ),
      new ProjectNode(
        'Loader',
        metadata?.loader ?? 'not specified',
        'symbol-interface'
      ),
      new ProjectNode(
        'Minecraft',
        minecraftVersion ?? 'not detected',
        'versions'
      ),
      new ProjectNode('Mod version', modVersion ?? 'not detected', 'tag'),
      new ProjectNode(
        'Profile',
        path.basename(project.profileUri.fsPath),
        'json',
        {
          command: 'minecraftProjectDeploy.openProfile',
          title: 'Open profile',
          arguments: [project.folder.uri.toString()],
        }
      ),
    ];

    const artifact = await findArtifact(project);
    nodes.push(
      new ProjectNode(
        'Artifact',
        artifact ? path.basename(artifact.fsPath) : 'build required',
        artifact ? 'package' : 'circle-slash',
        artifact
          ? {
              command: 'revealFileInOS',
              title: 'Reveal artifact',
              arguments: [artifact],
            }
          : undefined
      )
    );
    return new ProjectNode(
      project.profile.name,
      project.folder.name,
      'game',
      undefined,
      nodes
    );
  }
}

class ActionsTreeProvider
  implements vscode.TreeDataProvider<ProjectNode>, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<
    ProjectNode | undefined
  >();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly projectChanged: vscode.Disposable;

  constructor(private readonly projects: ProjectService) {
    this.projectChanged = projects.onDidChange(() =>
      this.changeEmitter.fire(undefined)
    );
  }

  dispose(): void {
    this.projectChanged.dispose();
    this.changeEmitter.dispose();
  }

  getTreeItem(element: ProjectNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ProjectNode): Promise<ProjectNode[]> {
    if (element) {
      return element.children;
    }
    return (await this.projects.getProjects()).map((project) =>
      this.projectNode(project)
    );
  }

  private projectNode(project: LoadedProject): ProjectNode {
    const actions: Array<[Operation, string, string, string]> = [
      [
        'environment',
        'Check environment',
        'minecraftProjectDeploy.checkEnvironment',
        'pass',
      ],
      [
        'buildNative',
        'Build native components',
        'minecraftProjectDeploy.buildNative',
        'tools',
      ],
      ['build', 'Build project', 'minecraftProjectDeploy.build', 'package'],
      ['test', 'Run project tests', 'minecraftProjectDeploy.test', 'beaker'],
      [
        'launch',
        'Launch development client',
        'minecraftProjectDeploy.launch',
        'play',
      ],
      [
        'visualMetal',
        'Launch Metal visual variant',
        'minecraftProjectDeploy.visualMetal',
        'eye',
      ],
      [
        'visualVanilla',
        'Launch vanilla visual baseline',
        'minecraftProjectDeploy.visualVanilla',
        'compare-changes',
      ],
      [
        'profile',
        'Capture frame-hitch profile',
        'minecraftProjectDeploy.profile',
        'pulse',
      ],
      [
        'profileSummary',
        'Summarize latest frame profile',
        'minecraftProjectDeploy.profileSummary',
        'graph',
      ],
      [
        'usage',
        'Capture CPU, GPU, and memory usage',
        'minecraftProjectDeploy.usage',
        'dashboard',
      ],
    ];
    const nodes = actions
      .filter(([operation]) => project.profile.commands[operation])
      .map(
        ([, label, command, icon]) =>
          new ProjectNode(label, undefined, icon, {
            command,
            title: label,
            arguments: [project.folder.uri.toString()],
          })
      );

    if (project.profile.deployTargets?.length) {
      nodes.push(
        new ProjectNode('Deploy mod artifact…', undefined, 'cloud-upload', {
          command: 'minecraftProjectDeploy.deploy',
          title: 'Deploy mod artifact',
          arguments: [project.folder.uri.toString()],
        })
      );
    }
    return new ProjectNode(
      project.profile.name,
      project.folder.name,
      'game',
      undefined,
      nodes
    );
  }
}

class EvidenceTreeProvider
  implements vscode.TreeDataProvider<ProjectNode>, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<
    ProjectNode | undefined
  >();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly projectChanged: vscode.Disposable;

  constructor(private readonly projects: ProjectService) {
    this.projectChanged = projects.onDidChange(() =>
      this.changeEmitter.fire(undefined)
    );
  }

  dispose(): void {
    this.projectChanged.dispose();
    this.changeEmitter.dispose();
  }

  getTreeItem(element: ProjectNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ProjectNode): Promise<ProjectNode[]> {
    if (element) {
      return element.children;
    }
    const roots: ProjectNode[] = [];
    for (const project of await this.projects.getProjects()) {
      const node = await this.projectNode(project);
      if (node) {
        roots.push(node);
      }
    }
    return roots;
  }

  private async projectNode(project: LoadedProject): Promise<ProjectNode | undefined> {
    const evidence = project.profile.evidence;
    if (!evidence) {
      return undefined;
    }
    const nodes: ProjectNode[] = [];
    if (evidence.latestLog) {
      const log = vscode.Uri.joinPath(project.folder.uri, evidence.latestLog);
      let description = 'not found';
      try {
        description = formatModifiedTime((await vscode.workspace.fs.stat(log)).mtime);
      } catch (error) {
        if (!isFileNotFound(error)) {
          throw error;
        }
      }
      nodes.push(
        new ProjectNode('Latest log', description, 'output', {
          command: 'minecraftProjectDeploy.openLatestLog',
          title: 'Open latest Minecraft log',
          arguments: [project.folder.uri.toString()],
        })
      );
    }
    if (evidence.crashReportsGlob) {
      const crash = await findNewestFile(
        project.folder,
        evidence.crashReportsGlob
      );
      nodes.push(
        new ProjectNode(
          'Latest crash report',
          crash ? path.basename(crash.fsPath) : 'none',
          crash ? 'bug' : 'pass',
          crash
            ? {
                command: 'minecraftProjectDeploy.openLatestCrash',
                title: 'Open latest crash report',
                arguments: [project.folder.uri.toString()],
              }
            : undefined
        )
      );
    }
    if (evidence.screenshotsGlob) {
      const screenshots = await vscode.workspace.findFiles(
        new vscode.RelativePattern(project.folder, evidence.screenshotsGlob),
        undefined,
        1000
      );
      nodes.push(
        new ProjectNode(
          'Screenshots',
          `${screenshots.length}`,
          'device-camera',
          {
            command: 'minecraftProjectDeploy.openScreenshots',
            title: 'Open Minecraft screenshots',
            arguments: [project.folder.uri.toString()],
          }
        )
      );
    }
    return new ProjectNode(
      project.profile.name,
      project.folder.name,
      'game',
      undefined,
      nodes
    );
  }
}

class MinecraftTaskProvider implements vscode.TaskProvider {
  constructor(
    private readonly projects: ProjectService,
    private readonly operationLocks: OperationLocks
  ) {}

  async provideTasks(): Promise<vscode.Task[]> {
    if (!vscode.workspace.isTrusted) {
      return [];
    }
    const tasks: vscode.Task[] = [];
    for (const project of await this.projects.getProjects()) {
      if (
        !hostCompatible(project.profile) ||
        (project.profile.remoteSupported === false && vscode.env.remoteName)
      ) {
        continue;
      }
      for (const operation of operations) {
        const task = await createTask(
          project,
          operation,
          false,
          this.operationLocks
        );
        if (task) {
          tasks.push(task);
        }
      }
    }
    return tasks;
  }

  async resolveTask(task: vscode.Task): Promise<vscode.Task | undefined> {
    if (!vscode.workspace.isTrusted) {
      return undefined;
    }
    const operation = task.definition.operation as Operation | undefined;
    if (!operation || !operations.includes(operation)) {
      return undefined;
    }
    const projectFolder = task.definition.projectFolder;
    if (typeof projectFolder !== 'string' || !projectFolder) {
      return undefined;
    }
    try {
      const project = await this.projects.requireProject(projectFolder);
      requireCompatibleHost(project.profile);
      return createTask(project, operation, false, this.operationLocks);
    } catch {
      return undefined;
    }
  }
}

class MinecraftTestProvider implements vscode.Disposable {
  private readonly controller = vscode.tests.createTestController(
    'minecraftProjectDeploy.tests',
    'Minecraft Project Tests'
  );
  private readonly projectChanged: vscode.Disposable;
  private readonly testsByItem = new WeakMap<vscode.TestItem, ProjectTest>();

  constructor(
    private readonly projects: ProjectService,
    private readonly operationLocks: OperationLocks
  ) {
    this.controller.resolveHandler = async () => this.refresh();
    this.controller.refreshHandler = async () => this.refresh();
    this.controller.createRunProfile(
      'Run',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.run(request, token),
      true
    );
    this.projectChanged = projects.onDidChange(() => {
      void this.refresh();
    });
    void this.refresh();
  }

  dispose(): void {
    this.projectChanged.dispose();
    this.controller.dispose();
  }

  private async refresh(): Promise<void> {
    this.controller.items.replace([]);
    if (!vscode.workspace.isTrusted) {
      return;
    }

    let projects: LoadedProject[];
    try {
      projects = await this.projects.getProjects();
    } catch {
      return;
    }
    for (const project of projects) {
      if (
        !project.profile.tests?.length ||
        !hostCompatible(project.profile) ||
        (project.profile.remoteSupported === false && vscode.env.remoteName)
      ) {
        continue;
      }

      const projectItem = this.controller.createTestItem(
        `project:${project.folder.uri.toString()}`,
        project.profile.name,
        project.folder.uri
      );
      projectItem.description = `${project.folder.name} · ${project.profile.metadata?.loader ?? project.profile.adapter} ${propertyValue(project, project.profile.metadata?.minecraftVersionProperty) ?? ''}`.trim();
      for (const definition of project.profile.tests) {
        const item = this.controller.createTestItem(
          `${projectItem.id}:${definition.id}`,
          definition.label,
          project.folder.uri
        );
        projectItem.children.add(item);
        this.testsByItem.set(item, definition);
      }
      this.controller.items.add(projectItem);
    }
  }

  private async run(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken
  ): Promise<void> {
    const run = this.controller.createTestRun(request);
    const selected = collectRunnableTests(
      request,
      this.controller.items,
      this.testsByItem
    );
    try {
      requireTrust();
      if (!selected.length) {
        return;
      }

      for (const item of selected) {
        if (token.isCancellationRequested) {
          run.skipped(item);
          continue;
        }
        const definition = this.testsByItem.get(item);
        if (!definition) {
          continue;
        }
        try {
          const folder = vscode.workspace.getWorkspaceFolder(item.uri!);
          if (!folder) {
            throw new Error('The test project workspace folder is unavailable.');
          }
          const project = await this.projects.requireProject(folder.uri);
          requireCompatibleHost(project.profile);
          run.enqueued(item);
          await this.runOne(project, item, definition, run, token);
        } catch (error) {
          const message = new vscode.TestMessage(messageOf(error));
          run.errored(item, message);
          run.appendOutput(`${message.message}\r\n`, undefined, item);
        }
      }
    } catch (error) {
      const message = new vscode.TestMessage(messageOf(error));
      for (const item of selected) {
        run.errored(item, message);
      }
      run.appendOutput(`${message.message}\r\n`);
    } finally {
      run.end();
    }
  }

  private async runOne(
    project: LoadedProject,
    item: vscode.TestItem,
    definition: ProjectTest,
    run: vscode.TestRun,
    token: vscode.CancellationToken
  ): Promise<void> {
    const started = Date.now();
    const variables = new Map<string, string>([
      ['workspaceFolder', project.folder.uri.fsPath],
      ['userHome', os.homedir()],
      ['world', project.profile.worlds?.default ?? ''],
    ]);
    const args = (definition.args ?? []).map((argument) =>
      expandVariables(argument, variables)
    );
    const cwd = expandVariables(
      definition.cwd ?? '${workspaceFolder}',
      variables
    );
    const env = {
      ...process.env,
      ...(definition.env
        ? expandEnvironment(definition.env, variables)
        : undefined),
    };
    assertNoUnexpandedVariables([
      definition.executable,
      ...args,
      cwd,
      ...Object.values(env).filter((value): value is string => value !== undefined),
    ]);
    const releaseLocks = this.operationLocks.acquire(
      project.folder.uri.toString(),
      project.folder.name,
      definition.label,
      definition.locks ?? []
    );

    run.started(item);
    run.appendOutput(
      `\r\n> ${formatProcessInvocation(definition.executable, args)}\r\n`,
      undefined,
      item
    );

    try {
      await new Promise<void>((resolve) => {
        let settled = false;
        let cancelled = false;
        let stderr = '';
        const child = spawn(definition.executable, args, {
          cwd,
          env,
          shell: false,
          detached: process.platform !== 'win32',
        });
        const cancellation = token.onCancellationRequested(() => {
          cancelled = true;
          terminateProcessTree(child);
        });
        const append = (chunk: Buffer, isError: boolean) => {
          const text = chunk.toString();
          if (isError) {
            stderr = (stderr + text).slice(-8000);
          }
          run.appendOutput(toTerminalLines(text), undefined, item);
        };
        child.stdout.on('data', (chunk: Buffer) => append(chunk, false));
        child.stderr.on('data', (chunk: Buffer) => append(chunk, true));
        child.once('error', (error) => {
          if (settled) {
            return;
          }
          settled = true;
          cancellation.dispose();
          run.errored(
            item,
            new vscode.TestMessage(messageOf(error)),
            Date.now() - started
          );
          resolve();
        });
        child.once('close', (code, signal) => {
          if (settled) {
            return;
          }
          settled = true;
          cancellation.dispose();
          const duration = Date.now() - started;
          if (cancelled || token.isCancellationRequested) {
            run.skipped(item);
          } else if (code === 0) {
            run.passed(item, duration);
          } else {
            const suffix = signal ? ` (signal ${signal})` : '';
            const detail = stderr.trim();
            const summary = `Exited with code ${code ?? 'unknown'}${suffix}.`;
            run.failed(
              item,
              new vscode.TestMessage(detail ? `${summary}\n\n${detail}` : summary),
              duration
            );
          }
          resolve();
        });
      });
    } finally {
      releaseLocks();
    }
  }
}

function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) {
    return;
  }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }, 5000);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
}

const operations: Operation[] = [
  'environment',
  'buildNative',
  'build',
  'test',
  'launch',
  'visualMetal',
  'visualVanilla',
  'profile',
  'profileSummary',
  'usage',
];

function collectRunnableTests(
  request: vscode.TestRunRequest,
  roots: vscode.TestItemCollection,
  definitions: WeakMap<vscode.TestItem, ProjectTest>
): vscode.TestItem[] {
  return collectTestItems(request, roots).filter((item) => definitions.has(item));
}

function collectTestItems(
  request: vscode.TestRunRequest,
  roots: vscode.TestItemCollection
): vscode.TestItem[] {
  const excluded = new Set(request.exclude ?? []);
  const queue: vscode.TestItem[] = [];
  const selected: vscode.TestItem[] = [];
  if (request.include) {
    queue.push(...request.include);
  } else {
    roots.forEach((item) => queue.push(item));
  }
  while (queue.length) {
    const item = queue.shift();
    if (!item || excluded.has(item)) {
      continue;
    }
    selected.push(item);
    item.children.forEach((child) => queue.push(child));
  }
  return selected;
}

export function toTerminalLines(text: string): string {
  return text.replace(/\r?\n/gu, '\r\n');
}

export function formatProcessInvocation(
  executable: string,
  args: readonly string[]
): string {
  return [executable, ...args]
    .map((part) => (/^[A-Za-z0-9_./:=+-]+$/u.test(part) ? part : JSON.stringify(part)))
    .join(' ');
}

function formatModifiedTime(mtime: number): string {
  if (!mtime) {
    return 'available';
  }
  return new Date(mtime).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const profileValidator = await loadProfileValidator(context);
  const projects = new ProjectService(profileValidator);
  const operationLocks = new OperationLocks();
  const projectTree = new ProjectTreeProvider(projects);
  const actionsTree = new ActionsTreeProvider(projects);
  const evidenceTree = new EvidenceTreeProvider(projects);
  const testProvider = new MinecraftTestProvider(projects, operationLocks);

  context.subscriptions.push(
    projects,
    projectTree,
    actionsTree,
    evidenceTree,
    testProvider,
    vscode.window.registerTreeDataProvider(
      'minecraftProjectDeploy.project',
      projectTree
    ),
    vscode.window.registerTreeDataProvider(
      'minecraftProjectDeploy.actions',
      actionsTree
    ),
    vscode.window.registerTreeDataProvider(
      'minecraftProjectDeploy.evidence',
      evidenceTree
    ),
    vscode.tasks.registerTaskProvider(
      taskType,
      new MinecraftTaskProvider(projects, operationLocks)
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('minecraftProjectDeploy')) {
        projects.refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => projects.refresh()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => projects.refresh()),
    vscode.commands.registerCommand('minecraftProjectDeploy.refresh', () =>
      projects.refresh()
    ),
    vscode.commands.registerCommand(
      'minecraftProjectDeploy.openProfile',
      async (projectFolder?: string) => {
        await showError(async () => {
          const project = await projects.requireProject(projectFolder);
          await vscode.window.showTextDocument(project.profileUri);
        });
      }
    ),
    registerOperationCommand(
      'minecraftProjectDeploy.checkEnvironment',
      'environment',
      projects,
      operationLocks
    ),
    registerOperationCommand(
      'minecraftProjectDeploy.buildNative',
      'buildNative',
      projects,
      operationLocks
    ),
    registerOperationCommand(
      'minecraftProjectDeploy.build',
      'build',
      projects,
      operationLocks
    ),
    registerOperationCommand(
      'minecraftProjectDeploy.test',
      'test',
      projects,
      operationLocks
    ),
    registerOperationCommand(
      'minecraftProjectDeploy.launch',
      'launch',
      projects,
      operationLocks
    ),
    registerOperationCommand(
      'minecraftProjectDeploy.visualMetal',
      'visualMetal',
      projects,
      operationLocks
    ),
    registerOperationCommand(
      'minecraftProjectDeploy.visualVanilla',
      'visualVanilla',
      projects,
      operationLocks
    ),
    registerOperationCommand(
      'minecraftProjectDeploy.profile',
      'profile',
      projects,
      operationLocks
    ),
    registerOperationCommand(
      'minecraftProjectDeploy.profileSummary',
      'profileSummary',
      projects,
      operationLocks
    ),
    registerOperationCommand(
      'minecraftProjectDeploy.usage',
      'usage',
      projects,
      operationLocks
    ),
    vscode.commands.registerCommand(
      'minecraftProjectDeploy.deploy',
      async (projectFolder?: string) => {
        await showError(() =>
          deployArtifact(projects, operationLocks, projectFolder)
        );
      }
    ),
    vscode.commands.registerCommand(
      'minecraftProjectDeploy.openLatestLog',
      async (projectFolder?: string) => {
        await showError(async () => {
          const project = await projects.requireProject(projectFolder);
          const relative = project.profile.evidence?.latestLog;
          if (!relative) {
            throw new Error('The project profile does not define a latest log.');
          }
          const uri = vscode.Uri.joinPath(project.folder.uri, relative);
          await vscode.window.showTextDocument(uri, { preview: false });
        });
      }
    ),
    vscode.commands.registerCommand(
      'minecraftProjectDeploy.openLatestCrash',
      async (projectFolder?: string) => {
        await showError(async () => {
          const project = await projects.requireProject(projectFolder);
          const pattern = project.profile.evidence?.crashReportsGlob;
          if (!pattern) {
            throw new Error('The project profile does not define crash reports.');
          }
          const crash = await findNewestFile(project.folder, pattern);
          if (!crash) {
            throw new Error('No Minecraft crash report was found.');
          }
          await vscode.window.showTextDocument(crash, { preview: false });
        });
      }
    ),
    vscode.commands.registerCommand(
      'minecraftProjectDeploy.openScreenshots',
      async (projectFolder?: string) => {
        await showError(async () => {
          const project = await projects.requireProject(projectFolder);
          const pattern = project.profile.evidence?.screenshotsGlob;
          if (!pattern) {
            throw new Error('The project profile does not define screenshots.');
          }
          const screenshot = await findNewestFile(project.folder, pattern);
          const target = screenshot
            ? vscode.Uri.file(path.dirname(screenshot.fsPath))
            : vscode.Uri.file(path.dirname(vscode.Uri.joinPath(project.folder.uri, pattern).fsPath));
          await vscode.commands.executeCommand('revealFileInOS', target);
        });
      }
    )
  );
}

function registerOperationCommand(
  commandId: string,
  operation: Operation,
  projects: ProjectService,
  operationLocks: OperationLocks
): vscode.Disposable {
  return vscode.commands.registerCommand(commandId, async (projectFolder?: string) => {
    await showError(async () => {
      requireTrust();
      const project = await projects.requireProject(projectFolder);
      requireCompatibleHost(project.profile);
      const task = await createTask(
        project,
        operation,
        true,
        operationLocks
      );
      if (!task) {
        throw new Error(
          `The project profile does not define a ${operation} command.`
        );
      }
      await vscode.tasks.executeTask(task);
    });
  });
}

async function createTask(
  project: LoadedProject,
  operation: Operation,
  promptForWorld = false,
  operationLocks?: OperationLocks
): Promise<vscode.Task | undefined> {
  const command = project.profile.commands[operation];
  if (!command) {
    return undefined;
  }

  let world = project.profile.worlds?.default ?? '';
  if (
    command.args?.some((argument) => argument.includes('${world}')) &&
    project.profile.worlds &&
    promptForWorld
  ) {
    const selected = await selectWorld(project, world);
    if (!selected) {
      return undefined;
    }
    world = selected;
  }

  const variables = new Map<string, string>([
    ['workspaceFolder', project.folder.uri.fsPath],
    ['world', world],
    ['userHome', os.homedir()],
  ]);
  const args = (command.args ?? []).map((argument) =>
    expandVariables(argument, variables)
  );
  const cwd = expandVariables(command.cwd ?? '${workspaceFolder}', variables);
  const environment = command.env
    ? expandEnvironment(command.env, variables)
    : undefined;
  assertNoUnexpandedVariables([
    command.executable,
    ...args,
    cwd,
    ...Object.values(environment ?? {}),
  ]);
  const definition: MinecraftTaskDefinition = {
    type: taskType,
    operation,
    projectFolder: project.folder.uri.toString(),
  };
  const execution = operationLocks
    ? new vscode.CustomExecution(async () =>
        new ProjectTaskTerminal(
          project,
          command,
          args,
          cwd,
          { ...process.env, ...environment },
          operationLocks
        )
      )
    : new vscode.ProcessExecution(command.executable, args, {
        cwd,
        env: environment,
      });
  const task = new vscode.Task(
    definition,
    project.folder,
    command.label,
    source,
    execution,
    []
  );
  task.presentationOptions = {
    reveal: vscode.workspace
      .getConfiguration('minecraftProjectDeploy')
      .get<boolean>('autoRevealOutput', true)
      ? vscode.TaskRevealKind.Always
      : vscode.TaskRevealKind.Silent,
    panel:
      command.longRunning
        ? vscode.TaskPanelKind.Dedicated
        : vscode.TaskPanelKind.Shared,
    clear: true,
  };
  if (operation === 'build') {
    task.group = vscode.TaskGroup.Build;
  }
  if (operation === 'test') {
    task.group = vscode.TaskGroup.Test;
  }
  return task;
}

async function selectWorld(
  project: LoadedProject,
  preferred: string
): Promise<string | undefined> {
  const worlds = project.profile.worlds;
  if (!worlds) {
    return preferred;
  }

  const directory = vscode.Uri.joinPath(project.folder.uri, worlds.directory);
  let names: string[] = [];
  try {
    const entries = await vscode.workspace.fs.readDirectory(directory);
    names = entries
      .filter(([, type]) => type === vscode.FileType.Directory)
      .map(([name]) => name)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (!isFileNotFound(error)) {
      throw error;
    }
  }

  if (!names.length) {
    return vscode.window.showInputBox({
      prompt: 'World save directory name',
      value: preferred,
      ignoreFocusOut: true,
    });
  }

  const selected = await vscode.window.showQuickPick(
    names.map((name) => ({
      label: name,
      description: name === preferred ? 'default' : undefined,
    })),
    { placeHolder: 'Choose the development world', ignoreFocusOut: true }
  );
  return selected?.label;
}

async function deployArtifact(
  projects: ProjectService,
  operationLocks: OperationLocks,
  projectFolder?: string
): Promise<void> {
  requireTrust();
  const project = await projects.requireProject(projectFolder);
  requireCompatibleHost(project.profile);
  const targets = project.profile.deployTargets ?? [];
  if (!targets.length) {
    throw new Error(
      'The project profile does not define any deployment targets.'
    );
  }

  const selected = await vscode.window.showQuickPick(
    targets.map((target) => ({
      label: target.label,
      description: target.destination,
      target,
    })),
    { placeHolder: 'Choose a deployment target', ignoreFocusOut: true }
  );
  if (!selected) {
    return;
  }

  let releaseLocks = operationLocks.acquire(
    project.folder.uri.toString(),
    project.folder.name,
    `Deploy to ${selected.target.label}`,
    selected.target.locks ?? []
  );
  try {
    const artifact = await findArtifact(project);
    if (!artifact) {
      releaseLocks();
      releaseLocks = () => {};
      const build = await vscode.window.showWarningMessage(
        'No deployable mod artifact was found. Build the project now?',
        { modal: true },
        'Build'
      );
      if (build === 'Build') {
        await vscode.commands.executeCommand(
          'minecraftProjectDeploy.build',
          project.folder.uri.toString()
        );
      }
      return;
    }

    const variables = new Map<string, string>([
      ['workspaceFolder', project.folder.uri.fsPath],
      ['userHome', os.homedir()],
    ]);
    const destinationDirectory = vscode.Uri.file(
      expandVariables(selected.target.destination, variables)
    );
    const destination = vscode.Uri.joinPath(
      destinationDirectory,
      path.basename(artifact.fsPath)
    );
    const alwaysConfirm = vscode.workspace
      .getConfiguration('minecraftProjectDeploy')
      .get<boolean>('confirmDeploy', true);
    if (alwaysConfirm || selected.target.requiresConfirmation !== false) {
      const confirmation = await vscode.window.showWarningMessage(
        `Copy ${path.basename(artifact.fsPath)} to ${destinationDirectory.fsPath}?`,
        { modal: true },
        'Deploy'
      );
      if (confirmation !== 'Deploy') {
        return;
      }
    }

    await vscode.workspace.fs.createDirectory(destinationDirectory);
    if (selected.target.cleanMatching) {
      await cleanDeploymentTarget(
        destinationDirectory,
        selected.target.cleanMatching,
        destination
      );
    }
    await vscode.workspace.fs.copy(artifact, destination, { overwrite: true });
    void vscode.window.showInformationMessage(
      `Deployed ${path.basename(artifact.fsPath)} to ${destinationDirectory.fsPath}.`
    );
    projects.refresh();
  } finally {
    releaseLocks();
  }
}

async function cleanDeploymentTarget(
  directory: vscode.Uri,
  pattern: string,
  keep: vscode.Uri
): Promise<void> {
  const matcher = simpleGlob(pattern);
  for (const [name, type] of await vscode.workspace.fs.readDirectory(
    directory
  )) {
    if (type !== vscode.FileType.File || !matcher.test(name)) {
      continue;
    }
    const candidate = vscode.Uri.joinPath(directory, name);
    if (candidate.fsPath !== keep.fsPath) {
      await vscode.workspace.fs.delete(candidate);
    }
  }
}

async function findArtifact(
  project: LoadedProject
): Promise<vscode.Uri | undefined> {
  const include = project.profile.metadata?.artifactGlob;
  if (!include) {
    return undefined;
  }
  const excluded = project.profile.metadata?.excludeArtifactGlobs ?? [];
  const excludePattern =
    excluded.length === 1
      ? excluded[0]
      : excluded.length > 1
        ? `{${excluded.join(',')}}`
        : undefined;
  const matches = await vscode.workspace.findFiles(
    new vscode.RelativePattern(project.folder, include),
    excludePattern,
    50
  );
  const withStats = await Promise.all(
    matches.map(async (uri) => ({
      uri,
      stat: await vscode.workspace.fs.stat(uri),
    }))
  );
  withStats.sort((left, right) => right.stat.mtime - left.stat.mtime);
  return withStats[0]?.uri;
}

async function findNewestFile(
  folder: vscode.WorkspaceFolder,
  pattern: string
): Promise<vscode.Uri | undefined> {
  const matches = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, pattern),
    undefined,
    100
  );
  const withStats = await Promise.all(
    matches.map(async (uri) => ({
      uri,
      stat: await vscode.workspace.fs.stat(uri),
    }))
  );
  withStats.sort((left, right) => right.stat.mtime - left.stat.mtime);
  return withStats[0]?.uri;
}

async function readProperties(uri: vscode.Uri): Promise<Map<string, string>> {
  try {
    const raw = await vscode.workspace.fs.readFile(uri);
    const properties = new Map<string, string>();
    for (const line of new TextDecoder().decode(raw).split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const separator = trimmed.indexOf('=');
      if (separator > 0) {
        properties.set(
          trimmed.slice(0, separator).trim(),
          trimmed.slice(separator + 1).trim()
        );
      }
    }
    return properties;
  } catch (error) {
    if (isFileNotFound(error)) {
      return new Map();
    }
    throw error;
  }
}

function propertyValue(
  project: LoadedProject,
  key: string | undefined
): string | undefined {
  return key ? project.properties.get(key) : undefined;
}

function expandEnvironment(
  environment: Record<string, string>,
  variables: ReadonlyMap<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [
      key,
      expandVariables(value, variables),
    ])
  );
}

export function expandVariables(
  value: string,
  variables: ReadonlyMap<string, string>
): string {
  return value.replace(
    /\$\{([^}]+)\}/gu,
    (token, name: string) => variables.get(name) ?? token
  );
}

export function assertNoUnexpandedVariables(values: readonly string[]): void {
  const unresolved = values.find((value) => /\$\{[^}]+\}/u.test(value));
  if (unresolved) {
    throw new Error(`Profile contains an unknown variable in: ${unresolved}`);
  }
}

export function simpleGlob(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replace(/\*/gu, '.*')
    .replace(/\?/gu, '.');
  return new RegExp(`^${escaped}$`, 'u');
}

async function loadProfileValidator(
  context: vscode.ExtensionContext
): Promise<ProfileValidator> {
  const schemaUri = vscode.Uri.joinPath(
    context.extensionUri,
    'schemas',
    'minecraft-project.schema.json'
  );
  let schema: object;
  try {
    const raw = await vscode.workspace.fs.readFile(schemaUri);
    schema = JSON.parse(new TextDecoder().decode(raw)) as object;
  } catch (error) {
    throw new Error(
      `Unable to load the bundled Appletree project schema; the extension installation may be incomplete: ${messageOf(error)}`
    );
  }
  return createProfileValidator(schema);
}

export function createProfileValidator(schema: object): ProfileValidator {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema) as ValidateFunction<ProjectProfile>;
  return (value: unknown): ProjectProfile => {
    if (!validate(value)) {
      throw new Error(`profile schema validation failed: ${formatSchemaErrors(validate.errors)}`);
    }
    const profile = value;
    assertUniqueIds(profile.tests ?? [], 'test');
    assertUniqueIds(profile.deployTargets ?? [], 'deployment target');
    return profile;
  };
}

function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ');
}

function assertUniqueIds(
  entries: readonly { id: string }[],
  kind: string
): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!ids.add(entry.id)) {
      throw new Error(`duplicate ${kind} id: ${entry.id}`);
    }
  }
}

function hostDescription(profile: ProjectProfile): string {
  const platforms = profile.platforms?.join(', ') ?? 'any OS';
  const architectures = profile.architectures?.join(', ') ?? 'any architecture';
  return hostCompatible(profile)
    ? `${process.platform}/${process.arch}`
    : `requires ${platforms}/${architectures}`;
}

function hostCompatible(profile: ProjectProfile): boolean {
  return (
    (!profile.platforms?.length ||
      profile.platforms.includes(process.platform)) &&
    (!profile.architectures?.length ||
      profile.architectures.includes(process.arch))
  );
}

function requireCompatibleHost(profile: ProjectProfile): void {
  if (!hostCompatible(profile)) {
    throw new Error(
      `This project requires ${profile.platforms?.join(' or ') ?? 'any OS'} on ${profile.architectures?.join(' or ') ?? 'any architecture'}; the current extension host is ${process.platform}/${process.arch}.`
    );
  }
  if (profile.remoteSupported === false && vscode.env.remoteName) {
    throw new Error(
      `This project must run on the local extension host, not ${vscode.env.remoteName}.`
    );
  }
}

function requireTrust(): void {
  if (!vscode.workspace.isTrusted) {
    throw new Error(
      'Trust this workspace before executing project-controlled build, launch, test, or deployment commands.'
    );
  }
}

async function showError(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    void vscode.window.showErrorMessage(messageOf(error));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof vscode.FileSystemError && error.code === 'FileNotFound'
  );
}
