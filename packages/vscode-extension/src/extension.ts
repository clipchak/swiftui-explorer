import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

let runtimeProcess: ChildProcess | null = null;
let runtimeOutput: vscode.OutputChannel | null = null;

type RuntimeHealth = {
  version: string;
  status: string;
  service: string;
};

type WorkspaceInspection = {
  version: string;
  workspaceRoot: string;
  hasPackageSwift: boolean;
  hasXcodeProject: boolean;
  hasWorkspace: boolean;
  hasXcodeGenSpec: boolean;
  suggestedNextAction: string;
};

type PreviewFixture = {
  id: string;
  displayName: string;
};

type PreviewEnvironment = {
  id: string;
  displayName: string;
  colorScheme: "light" | "dark";
  localeIdentifier: string;
  dynamicTypeSize: string;
};

type PreviewDescriptor = {
  id: string;
  displayName: string;
  status?: "placeholder" | "configured";
  fixtures: PreviewFixture[];
  supportedEnvironments: PreviewEnvironment[];
};

type PreviewTargetDiscovery = {
  version: string;
  appName: string | null;
  scheme: string | null;
  projectPath: string | null;
  manifestPath: string | null;
  targets: PreviewDescriptor[];
};

type OpenPreviewRequest = {
  targetId: string;
  fixtureId?: string;
  environmentId?: string;
};

type OpenPreviewResponse = {
  version: string;
  status: "launched" | "refreshed";
  appName: string;
  scheme: string;
  simulatorId: string;
  simulatorName: string;
  bundleIdentifier: string;
  targetId: string;
  fixtureId: string | null;
  environmentId: string | null;
};

type AutoRefreshState = {
  version: string;
  enabled: boolean;
};

type HostAppConfiguration = {
  version: string;
  usingDefault: boolean;
  appRoot: string;
  projectPath: string | null;
  workspacePath: string | null;
  xcodeGenSpecPath: string | null;
  scheme: string;
  manifestPath: string;
  bundleIdentifier: string;
};

const LAST_PREVIEW_STATE_KEY = "swiftuiExplorer.lastPreviewSelection";

type ExplorerSnapshot = {
  health: RuntimeHealth;
  inspection: WorkspaceInspection;
  discovery: PreviewTargetDiscovery;
  autoRefresh: AutoRefreshState;
  hostAppConfiguration: HostAppConfiguration;
  selection: OpenPreviewRequest | null;
};

type SetupPreviewResult = {
  hostApp: HostAppConfiguration;
  appEntryFilePath: string;
  targetCount: number;
};

type AppEntryCandidate = {
  appName: string;
  filePath: string;
  relativePath: string;
};

type ViewCandidate = {
  typeName: string;
  displayName: string;
  filePath: string;
  relativePath: string;
  targetId: string;
};

export function activate(context: vscode.ExtensionContext): void {
  void ensureRuntimeStarted(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("swiftuiExplorer.restartRuntime", async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Restarting SwiftUI Explorer runtime..." },
        () => restartRuntime(context),
      );
      vscode.window.showInformationMessage("SwiftUI Explorer runtime restarted.");
    }),
    vscode.commands.registerCommand("swiftuiExplorer.checkRuntime", async () => {
      const baseUrl = getRuntimeBaseUrl();

      try {
        const health = await getJson<RuntimeHealth>(`${baseUrl}/health`);
        vscode.window.showInformationMessage(
          `SwiftUI Explorer runtime is ${health.status} (${health.service} ${health.version}).`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown runtime error";
        vscode.window.showWarningMessage(`SwiftUI Explorer runtime is unavailable: ${message}`);
      }
    }),
    vscode.commands.registerCommand("swiftuiExplorer.openPreview", async () => {
      const baseUrl = getRuntimeBaseUrl();

      try {
        const discovery = await getJson<PreviewTargetDiscovery>(`${baseUrl}/api/v1/targets`);
        if (discovery.targets.length === 0) {
          vscode.window.showWarningMessage("SwiftUI Explorer did not find any preview targets.");
          return;
        }

        const selectedTarget = await pickTarget(discovery.targets);
        if (!selectedTarget) {
          return;
        }

        const selectedFixture = await pickFixture(selectedTarget);
        if (selectedFixture === undefined) {
          return;
        }

        const selectedEnvironment = await pickEnvironment(selectedTarget);
        if (!selectedEnvironment) {
          return;
        }

        const payload: OpenPreviewRequest = {
          targetId: selectedTarget.id,
          fixtureId: selectedFixture?.id,
          environmentId: selectedEnvironment.id,
        };

        const launchedPreview = await openPreviewSelection(context, baseUrl, payload, selectedTarget.displayName);

        vscode.window.showInformationMessage(
          `Opened ${selectedTarget.displayName} in ${launchedPreview.simulatorName}.`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown runtime error";
        vscode.window.showWarningMessage(`Could not open preview: ${message}`);
      }
    }),
    vscode.commands.registerCommand("swiftuiExplorer.refreshPreview", async () => {
      const baseUrl = getRuntimeBaseUrl();
      const lastPreviewSelection = context.globalState.get<OpenPreviewRequest>(LAST_PREVIEW_STATE_KEY);

      if (!lastPreviewSelection) {
        vscode.window.showWarningMessage("No previous SwiftUI Explorer preview selection is available yet.");
        return;
      }

      try {
        const refreshedPreview = await refreshPreviewSelection(context, baseUrl, lastPreviewSelection, {
          progressTitle: "Refreshing SwiftUI preview",
        });

        vscode.window.showInformationMessage(
          `Refreshed ${refreshedPreview.targetId} in ${refreshedPreview.simulatorName}.`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown runtime error";
        vscode.window.showWarningMessage(`Could not refresh preview: ${message}`);
      }
    }),
    vscode.commands.registerCommand("swiftuiExplorer.configureHostApp", async () => {
      const baseUrl = getRuntimeBaseUrl();

      try {
        const configuredHostApp = await promptForHostAppConfiguration(context, baseUrl);
        if (!configuredHostApp) {
          return;
        }

        vscode.window.showInformationMessage(
          `Configured ${path.basename(configuredHostApp.appRoot)} for SwiftUI Explorer.`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown runtime error";
        void offerRuntimeRestart(context, `Could not configure host app: ${message}`);
      }
    }),
    vscode.commands.registerCommand("swiftuiExplorer.setupPreviews", async () => {
      const baseUrl = getRuntimeBaseUrl();

      try {
        const result = await setupPreviewsForConfiguredHostApp(context, baseUrl);
        if (!result) {
          return;
        }

        vscode.window.showInformationMessage(
          `Generated ${result.targetCount} preview adapter${result.targetCount === 1 ? "" : "s"} in ${path.basename(result.appEntryFilePath)}. Fill in the adapter functions to render your real views.`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown runtime error";
        vscode.window.showErrorMessage(`Could not set up previews: ${message}`);
      }
    }),
    vscode.commands.registerCommand("swiftuiExplorer.openPanel", async () => {
      const panel = vscode.window.createWebviewPanel(
        "swiftuiExplorer",
        "SwiftUI Explorer",
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
        },
      );

      panel.webview.html = renderLoadingHtml();

      const baseUrl = getRuntimeBaseUrl();

      try {
        await ensureRuntimeReady(context);
        let snapshot = await loadExplorerSnapshot(context, baseUrl);
        panel.webview.html = renderPanelHtml(snapshot);

        panel.webview.onDidReceiveMessage(async (message: unknown) => {
          if (!isPanelMessage(message)) {
            return;
          }

          if (message.type === "openPreview") {
            try {
              const launchedPreview = await openPreviewSelection(
                context,
                baseUrl,
                message.payload,
                findTargetDisplayName(snapshot.discovery.targets, message.payload.targetId),
              );

              panel.webview.postMessage({
                type: "previewStatus",
                kind: "success",
                text: `Opened ${launchedPreview.targetId} in ${launchedPreview.simulatorName}.`,
              });
            } catch (error) {
              const messageText = error instanceof Error ? error.message : "Unknown runtime error";
              panel.webview.postMessage({
                type: "previewStatus",
                kind: "error",
                text: `Could not open preview: ${messageText}`,
              });
            }

            return;
          }

          if (message.type === "configureHostApp") {
            try {
              const configuredHostApp = await promptForHostAppConfiguration(context, baseUrl);
              if (!configuredHostApp) {
                panel.webview.postMessage({
                  type: "previewStatus",
                  kind: "success",
                  text: "Host app configuration canceled.",
                });
                return;
              }

              snapshot = await loadExplorerSnapshot(context, baseUrl);
              panel.webview.html = renderPanelHtml(snapshot);
            } catch (error) {
              const messageText = error instanceof Error ? error.message : "Unknown runtime error";
              panel.webview.postMessage({
                type: "previewStatus",
                kind: "error",
                text: `Could not configure host app: ${messageText}`,
              });
              void offerRuntimeRestart(context, `Could not configure host app: ${messageText}`);
            }

            return;
          }

          if (message.type === "setupPreviews") {
            try {
              const result = await setupPreviewsForConfiguredHostApp(context, baseUrl);
              if (!result) {
                panel.webview.postMessage({
                  type: "previewStatus",
                  kind: "success",
                  text: "Preview setup canceled.",
                });
                return;
              }

              snapshot = await loadExplorerSnapshot(context, baseUrl);
              panel.webview.html = renderPanelHtml(snapshot);
              panel.webview.postMessage({
                type: "previewStatus",
                kind: "success",
                text: `Generated ${result.targetCount} adapter stub${result.targetCount === 1 ? "" : "s"}. Fill in the adapter functions to render your real views.`,
              });
            } catch (error) {
              const messageText = error instanceof Error ? error.message : "Unknown runtime error";
              panel.webview.postMessage({
                type: "previewStatus",
                kind: "error",
                text: `Could not set up previews: ${messageText}`,
              });
              vscode.window.showErrorMessage(`Could not set up previews: ${messageText}`);
            }

            return;
          }

          if (message.type === "toggleAutoRefresh") {
            try {
              const autoRefresh = await postJson<AutoRefreshState>(`${baseUrl}/api/v1/auto-refresh`, {
                enabled: message.enabled,
              });

              panel.webview.postMessage({
                type: "autoRefreshState",
                enabled: autoRefresh.enabled,
              });
              panel.webview.postMessage({
                type: "previewStatus",
                kind: "success",
                text: `Auto-refresh ${autoRefresh.enabled ? "enabled" : "disabled"}.`,
              });
            } catch (error) {
              const messageText = error instanceof Error ? error.message : "Unknown runtime error";
              panel.webview.postMessage({
                type: "previewStatus",
                kind: "error",
                text: `Could not update auto-refresh: ${messageText}`,
              });
            }

            return;
          }

          if (message.type === "refreshPreview") {
            try {
              const lastPreviewSelection = context.globalState.get<OpenPreviewRequest>(LAST_PREVIEW_STATE_KEY);
              if (!lastPreviewSelection) {
                throw new Error("No previous SwiftUI Explorer preview selection is available yet.");
              }

              const refreshedPreview = await refreshPreviewSelection(
                context,
                baseUrl,
                lastPreviewSelection,
              );

              panel.webview.postMessage({
                type: "previewStatus",
                kind: "success",
                text: `Refreshed ${refreshedPreview.targetId} in ${refreshedPreview.simulatorName}.`,
              });
            } catch (error) {
              const messageText = error instanceof Error ? error.message : "Unknown runtime error";
              panel.webview.postMessage({
                type: "previewStatus",
                kind: "error",
                text: `Could not refresh preview: ${messageText}`,
              });
            }
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown runtime error";
        panel.webview.html = renderErrorHtml(baseUrl, message);
        void offerRuntimeRestart(context, `Could not load explorer panel: ${message}`);
      }
    }),
  );
}

export function deactivate(): void {
  if (runtimeProcess) {
    runtimeProcess.kill("SIGTERM");
    runtimeProcess = null;
  }
  runtimeOutput?.dispose();
  runtimeOutput = null;
}

function resolveWorkspaceRoot(context: vscode.ExtensionContext): string | undefined {
  const fromWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (fromWorkspace) {
    return fromWorkspace;
  }

  const fromExtensionPath = path.resolve(context.extensionPath, "..", "..");
  if (existsSync(path.join(fromExtensionPath, "package.json"))) {
    return fromExtensionPath;
  }

  return undefined;
}

function getRuntimeEntryPath(extensionPath: string): string {
  return path.join(extensionPath, "..", "preview-cli", "dist", "index.js");
}

function getRuntimePort(): string {
  const baseUrl = getRuntimeBaseUrl();
  try {
    return new URL(baseUrl).port || "4123";
  } catch {
    return "4123";
  }
}

async function isRuntimeReachable(): Promise<boolean> {
  try {
    await getJson<RuntimeHealth>(`${getRuntimeBaseUrl()}/health`);
    return true;
  } catch {
    return false;
  }
}

async function ensureRuntimeStarted(context: vscode.ExtensionContext): Promise<void> {
  if (await isRuntimeReachable()) {
    return;
  }

  const failReason = await spawnRuntime(context);
  if (failReason) {
    runtimeOutput?.appendLine(`[extension] auto-start failed: ${failReason}`);
  }
}

async function spawnRuntime(context: vscode.ExtensionContext): Promise<string | null> {
  if (!runtimeOutput) {
    runtimeOutput = vscode.window.createOutputChannel("SwiftUI Explorer Runtime");
  }

  const entryPath = getRuntimeEntryPath(context.extensionPath);
  runtimeOutput.appendLine(`[extension] looking for runtime at: ${entryPath}`);

  if (!existsSync(entryPath)) {
    const reason = `Runtime entry not found at ${entryPath}. Run 'npm run build' in the workspace root.`;
    runtimeOutput.appendLine(`[extension] ${reason}`);
    return reason;
  }

  const workspaceRoot = resolveWorkspaceRoot(context);
  if (!workspaceRoot) {
    const reason = "Could not determine workspace root.";
    runtimeOutput.appendLine(`[extension] ${reason}`);
    return reason;
  }

  runtimeOutput.appendLine(`[extension] workspace root: ${workspaceRoot}`);

  await killProcessOnPort(getRuntimePort());
  await delay(300);

  runtimeProcess = spawn("node", [entryPath], {
    cwd: workspaceRoot,
    env: { ...process.env, SWIFTUI_EXPLORER_WORKSPACE_ROOT: workspaceRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });

  runtimeProcess.stdout?.on("data", (data: Buffer) => {
    runtimeOutput?.append(data.toString());
  });
  runtimeProcess.stderr?.on("data", (data: Buffer) => {
    runtimeOutput?.append(data.toString());
  });
  runtimeProcess.on("exit", (code) => {
    runtimeOutput?.appendLine(`[runtime exited with code ${code}]`);
    runtimeProcess = null;
  });

  for (let attempt = 0; attempt < 20; attempt++) {
    await delay(250);
    if (await isRuntimeReachable()) {
      runtimeOutput.appendLine("[extension] runtime is healthy");
      return null;
    }
  }

  return "Runtime process started but did not become healthy within 5 seconds.";
}

async function stopRuntime(): Promise<void> {
  if (runtimeProcess) {
    runtimeProcess.kill("SIGTERM");
    runtimeProcess = null;
  }

  await killProcessOnPort(getRuntimePort());
}

async function killProcessOnPort(port: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    for (const pid of stdout.trim().split("\n").filter(Boolean)) {
      try {
        await execFileAsync("kill", [pid]);
      } catch {
        // already dead
      }
    }
  } catch {
    // nothing listening
  }
}

async function restartRuntime(context: vscode.ExtensionContext): Promise<string | null> {
  await stopRuntime();
  await delay(500);
  return spawnRuntime(context);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureRuntimeReady(context: vscode.ExtensionContext): Promise<void> {
  if (await isRuntimeReachable()) {
    return;
  }

  const failReason = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Starting SwiftUI Explorer runtime..." },
    () => spawnRuntime(context),
  );

  if (failReason) {
    runtimeOutput?.show(true);
    throw new Error(failReason);
  }
}

async function offerRuntimeRestart(context: vscode.ExtensionContext, errorMessage: string): Promise<void> {
  const action = await vscode.window.showErrorMessage(errorMessage, "Restart Runtime");
  if (action === "Restart Runtime") {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Restarting SwiftUI Explorer runtime..." },
      () => restartRuntime(context),
    );
    vscode.window.showInformationMessage("SwiftUI Explorer runtime restarted. Try your action again.");
  }
}

async function loadExplorerSnapshot(
  context: vscode.ExtensionContext,
  baseUrl: string,
): Promise<ExplorerSnapshot> {
  const [health, inspection, discovery, autoRefresh, hostAppConfiguration] = await Promise.all([
    getJson<RuntimeHealth>(`${baseUrl}/health`),
    getJson<WorkspaceInspection>(`${baseUrl}/api/v1/workspace/inspect`),
    getJson<PreviewTargetDiscovery>(`${baseUrl}/api/v1/targets`),
    getJson<AutoRefreshState>(`${baseUrl}/api/v1/auto-refresh`),
    getJson<HostAppConfiguration>(`${baseUrl}/api/v1/config`),
  ]);

  return {
    health,
    inspection,
    discovery,
    autoRefresh,
    hostAppConfiguration,
    selection: normalizeSelection(
      context.globalState.get<OpenPreviewRequest>(LAST_PREVIEW_STATE_KEY),
      discovery.targets,
    ),
  };
}

async function promptForHostAppConfiguration(context: vscode.ExtensionContext, baseUrl: string): Promise<HostAppConfiguration | undefined> {
  const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  const appRootUri = await pickSingleUri({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: workspaceUri,
    openLabel: "Select Host App Root",
    title: "Select SwiftUI Host App Root",
  });
  if (!appRootUri) {
    return undefined;
  }

  const buildContainer = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Scanning for Xcode projects..." },
    () => detectAndPickBuildContainer(appRootUri.fsPath),
  );
  if (!buildContainer) {
    return undefined;
  }

  const scheme = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Detecting Xcode schemes..." },
    () => detectAndPickScheme(buildContainer),
  );
  if (!scheme) {
    return undefined;
  }

  const detectedBundleId = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Reading build settings..." },
    () => detectBundleIdentifier(buildContainer, scheme),
  );
  const bundleIdentifier = await vscode.window.showInputBox({
    title: "SwiftUI Explorer Bundle Identifier",
    prompt: "Confirm or edit the app bundle identifier used to launch in Simulator.",
    value: detectedBundleId ?? "",
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : "Bundle identifier is required.",
  });
  if (!bundleIdentifier) {
    return undefined;
  }

  const detectedXcodeGenSpecPath = ["project.yml", "project.yaml"]
    .map((name) => path.join(appRootUri.fsPath, name))
    .find((candidate) => existsSync(candidate));

  const input = {
    appRoot: appRootUri.fsPath,
    ...(buildContainer.endsWith(".xcworkspace")
      ? { workspacePath: buildContainer }
      : { projectPath: buildContainer }),
    ...(detectedXcodeGenSpecPath ? { xcodeGenSpecPath: detectedXcodeGenSpecPath } : {}),
    scheme: scheme.trim(),
    bundleIdentifier: bundleIdentifier.trim(),
  };

  await ensureRuntimeReady(context);

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Saving host app configuration..." },
    () => postJson<HostAppConfiguration>(`${baseUrl}/api/v1/config`, input),
  );
}

async function setupPreviewsForConfiguredHostApp(
  context: vscode.ExtensionContext,
  baseUrl: string,
): Promise<SetupPreviewResult | undefined> {
  await ensureRuntimeReady(context);

  const hostApp = await getJson<HostAppConfiguration>(`${baseUrl}/api/v1/config`);
  const buildContainerPath = hostApp.workspacePath ?? hostApp.projectPath;
  if (!buildContainerPath) {
    throw new Error("Configure a host app project or workspace before setting up previews.");
  }

  const appEntryCandidates = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Scanning for app entry files..." },
    async () => findAppEntryCandidates(hostApp.appRoot),
  );
  if (appEntryCandidates.length === 0) {
    throw new Error("Could not find an '@main ... : App' file in the configured host app.");
  }

  const selectedAppEntry = await pickAppEntryCandidate(appEntryCandidates);
  if (!selectedAppEntry) {
    return undefined;
  }

  const viewCandidates = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Discovering SwiftUI views..." },
    async () => findSwiftUIViewCandidates(hostApp.appRoot, selectedAppEntry.filePath),
  );
  if (viewCandidates.length === 0) {
    throw new Error("No SwiftUI views were found to scaffold preview targets from.");
  }

  const selectedViews = await pickSetupPreviewCandidates(viewCandidates);
  if (!selectedViews || selectedViews.length === 0) {
    return undefined;
  }

  const productName = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Reading app product name..." },
    async () => detectBuildProductName(buildContainerPath, hostApp.scheme),
  );

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Generating preview adapters..." },
    async () => {
      scaffoldPreviewsIntoAppEntryFile({
        appEntryPath: selectedAppEntry.filePath,
        appStructName: selectedAppEntry.appName,
        productName: normalizeProductName(productName ?? path.basename(hostApp.appRoot)),
        scheme: hostApp.scheme,
        selectedViews,
      });
    },
  );

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Writing preview manifest..." },
    async () => {
      writeStarterPreviewManifest(hostApp, normalizeProductName(productName ?? path.basename(hostApp.appRoot)), selectedViews);
    },
  );

  return {
    hostApp,
    appEntryFilePath: selectedAppEntry.filePath,
    targetCount: selectedViews.length,
  };
}

async function pickAppEntryCandidate(candidates: AppEntryCandidate[]): Promise<AppEntryCandidate | undefined> {
  if (candidates.length === 1) {
    return candidates[0];
  }

  const selection = await vscode.window.showQuickPick(
    candidates.map((candidate) => ({
      label: candidate.appName,
      description: candidate.relativePath,
      candidate,
    })),
    {
      title: "Select App Entry File",
      ignoreFocusOut: true,
      matchOnDescription: true,
    },
  );

  return selection?.candidate;
}

async function pickSetupPreviewCandidates(candidates: ViewCandidate[]): Promise<ViewCandidate[] | undefined> {
  const selection = await vscode.window.showQuickPick(
    candidates.map((candidate) => ({
      label: candidate.displayName,
      description: candidate.relativePath,
      detail: candidate.typeName,
      candidate,
    })),
    {
      title: "Select Views To Scaffold",
      placeHolder: "Choose one or more SwiftUI views to expose as starter preview targets.",
      canPickMany: true,
      ignoreFocusOut: true,
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );

  return selection?.map((item) => item.candidate);
}

function findAppEntryCandidates(appRoot: string): AppEntryCandidate[] {
  const candidates: AppEntryCandidate[] = [];

  for (const filePath of walkSwiftFiles(appRoot)) {
    const contents = readFileSync(filePath, "utf8");
    const match = /@main[\s\S]*?struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*App\b/m.exec(contents);
    if (!match) {
      continue;
    }

    candidates.push({
      appName: match[1],
      filePath,
      relativePath: path.relative(appRoot, filePath),
    });
  }

  return candidates;
}

function findSwiftUIViewCandidates(appRoot: string, appEntryPath: string): ViewCandidate[] {
  const candidates: ViewCandidate[] = [];
  const seen = new Set<string>();

  for (const filePath of walkSwiftFiles(appRoot)) {
    if (filePath === appEntryPath) {
      continue;
    }

    const contents = readFileSync(filePath, "utf8");
    if (contents.includes("swiftui-explorer:begin")) {
      continue;
    }

    for (const match of contents.matchAll(/struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*View\b/g)) {
      const typeName = match[1];
      if (typeName.startsWith("SwiftUIExplorer")) {
        continue;
      }

      const key = `${filePath}:${typeName}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      candidates.push({
        typeName,
        displayName: humanizeIdentifier(typeName),
        filePath,
        relativePath: path.relative(appRoot, filePath),
        targetId: slugifyIdentifier(typeName),
      });
    }
  }

  return candidates.sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function walkSwiftFiles(root: string): string[] {
  const results: string[] = [];
  const ignoredDirectories = new Set([
    ".git",
    ".build",
    ".swiftpm",
    "DerivedData",
    "Pods",
    "Carthage",
    "node_modules",
  ]);

  const visit = (currentPath: string): void => {
    for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
      if (ignoredDirectories.has(entry.name) || entry.name.endsWith(".xcodeproj") || entry.name.endsWith(".xcworkspace")) {
        continue;
      }

      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }

      if (entry.isFile() && absolutePath.endsWith(".swift")) {
        results.push(absolutePath);
      }
    }
  };

  visit(root);
  return results;
}

function scaffoldPreviewsIntoAppEntryFile(input: {
  appEntryPath: string;
  appStructName: string;
  productName: string;
  scheme: string;
  selectedViews: ViewCandidate[];
}): void {
  let contents = readFileSync(input.appEntryPath, "utf8");
  contents = ensureSwiftImport(contents, "Foundation");
  contents = ensureSwiftImport(contents, "SwiftUI");
  contents = ensureSwiftUIExplorerStoredProperties(contents, input.productName, input.scheme);
  contents = ensureSwiftUIExplorerWindowGroupWrapper(contents);
  contents = upsertSwiftUIExplorerGeneratedBlock(
    contents,
    generateSwiftUIExplorerGeneratedBlock(input.appStructName, input.selectedViews),
  );

  writeFileSync(input.appEntryPath, contents, "utf8");
}

function writeStarterPreviewManifest(
  hostApp: HostAppConfiguration,
  appName: string,
  selectedViews: ViewCandidate[],
): void {
  const manifest = {
    appName,
    scheme: hostApp.scheme,
    targets: selectedViews.map((view) => ({
      id: view.targetId,
      displayName: view.displayName,
      status: "placeholder",
      fixtures: [],
      supportedEnvironments: [
        {
          id: "light",
          displayName: "Light",
          colorScheme: "light",
          localeIdentifier: "en_US",
          dynamicTypeSize: "large",
        },
        {
          id: "dark",
          displayName: "Dark",
          colorScheme: "dark",
          localeIdentifier: "en_US",
          dynamicTypeSize: "large",
        },
      ],
    })),
  };

  mkdirSync(path.dirname(hostApp.manifestPath), {
    recursive: true,
  });
  writeFileSync(`${hostApp.manifestPath}`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function ensureSwiftImport(contents: string, moduleName: string): string {
  if (new RegExp(`^import\\s+${escapeRegExp(moduleName)}\\s*$`, "m").test(contents)) {
    return contents;
  }

  const firstImportMatch = /^import\s+\w+/m.exec(contents);
  if (!firstImportMatch || firstImportMatch.index === undefined) {
    return `import ${moduleName}\n${contents}`;
  }

  return `${contents.slice(0, firstImportMatch.index)}import ${moduleName}\n${contents.slice(firstImportMatch.index)}`;
}

function ensureSwiftUIExplorerStoredProperties(contents: string, productName: string, scheme: string): string {
  if (contents.includes("swiftUIExplorerLaunchSelection = SwiftUIExplorerLaunchSelection.fromProcessEnvironment()")) {
    return contents;
  }

  const appStructMatch = /@main[\s\S]*?struct\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*App\s*\{/.exec(contents);
  if (!appStructMatch || appStructMatch.index === undefined) {
    throw new Error("Could not find the app struct to inject preview state into.");
  }

  const insertionIndex = appStructMatch.index + appStructMatch[0].length;
  const snippet = `

    private let swiftUIExplorerLaunchSelection = SwiftUIExplorerLaunchSelection.fromProcessEnvironment()
    private let swiftUIExplorerPreviewRegistry = SwiftUIExplorerPreviewRegistry()
    private let swiftUIExplorerManifestBootstrapped = SwiftUIExplorerPreviewBootstrap.writeManifestIfNeeded(
        registry: SwiftUIExplorerPreviewRegistry(),
        appName: ${toSwiftStringLiteral(productName)},
        scheme: ${toSwiftStringLiteral(scheme)}
    )
`;

  return `${contents.slice(0, insertionIndex)}${snippet}${contents.slice(insertionIndex)}`;
}

function ensureSwiftUIExplorerWindowGroupWrapper(contents: string): string {
  if (contents.includes("swiftUIExplorerRoot {")) {
    return contents;
  }

  const appStructMatch = /@main[\s\S]*?struct\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*App\s*\{/.exec(contents);
  if (!appStructMatch || appStructMatch.index === undefined) {
    throw new Error("Could not find the app struct for preview wrapping.");
  }

  const structOpenBraceIndex = appStructMatch.index + appStructMatch[0].length - 1;
  const structCloseBraceIndex = findMatchingBrace(contents, structOpenBraceIndex);
  const structBody = contents.slice(structOpenBraceIndex + 1, structCloseBraceIndex);
  const windowGroupMatch = /WindowGroup\b/.exec(structBody);
  if (!windowGroupMatch || windowGroupMatch.index === undefined) {
    throw new Error("Could not find a WindowGroup in the app body to wrap.");
  }

  const windowGroupIndex = structOpenBraceIndex + 1 + windowGroupMatch.index;
  const windowGroupBraceIndex = contents.indexOf("{", windowGroupIndex);
  if (windowGroupBraceIndex === -1) {
    throw new Error("Could not parse the WindowGroup body.");
  }

  const windowGroupCloseBraceIndex = findMatchingBrace(contents, windowGroupBraceIndex);
  const lineStartIndex = contents.lastIndexOf("\n", windowGroupIndex) + 1;
  const baseIndent = contents.slice(lineStartIndex, windowGroupIndex).match(/^\s*/)?.[0] ?? "";
  const wrapperIndent = `${baseIndent}    `;
  const contentIndent = `${wrapperIndent}    `;
  const originalInner = contents.slice(windowGroupBraceIndex + 1, windowGroupCloseBraceIndex).trim();
  const replacement = `WindowGroup {\n${wrapperIndent}swiftUIExplorerRoot {\n${indentMultiline(originalInner, contentIndent)}\n${wrapperIndent}}\n${baseIndent}}`;

  return `${contents.slice(0, windowGroupIndex)}${replacement}${contents.slice(windowGroupCloseBraceIndex + 1)}`;
}

function upsertSwiftUIExplorerGeneratedBlock(contents: string, generatedBlock: string): string {
  const beginMarker = "// swiftui-explorer:begin";
  const endMarker = "// swiftui-explorer:end";
  const beginIndex = contents.indexOf(beginMarker);
  const endIndex = contents.indexOf(endMarker);

  if (beginIndex !== -1 && endIndex !== -1 && endIndex > beginIndex) {
    const replaceEnd = endIndex + endMarker.length;
    return `${contents.slice(0, beginIndex)}${generatedBlock}${contents.slice(replaceEnd)}`;
  }

  return `${contents.trimEnd()}\n\n${generatedBlock}\n`;
}

function generateSwiftUIExplorerGeneratedBlock(appStructName: string, selectedViews: ViewCandidate[]): string {
  const targetLines = selectedViews.map((view) => {
    const adapterName = `render${sanitizeSwiftIdentifier(view.typeName)}`;

    return [
      "            SwiftUIExplorerPreviewTarget(",
      `                id: ${toSwiftStringLiteral(view.targetId)},`,
      `                displayName: ${toSwiftStringLiteral(view.displayName)}`,
      "            ) { context in",
      `                SwiftUIExplorerPreviewAdapters.${adapterName}(context)`,
      "            },",
    ].join("\n");
  }).join("\n");

  const adapterLines = selectedViews.map((view) => {
    const adapterName = `render${sanitizeSwiftIdentifier(view.typeName)}`;

    return [
      `    // TODO: Replace the placeholder below with your real ${view.typeName} initializer.`,
      `    //   Example: ${view.typeName}()`,
      "    @ViewBuilder",
      `    static func ${adapterName}(_ context: SwiftUIExplorerPreviewContext) -> some View {`,
      "        ContentUnavailableView(",
      `            ${toSwiftStringLiteral(view.displayName)},`,
      '            systemImage: "puzzlepiece.extension",',
      `            description: Text("Open this file and replace this adapter stub with a real ${view.typeName} initializer.")`,
      "        )",
      "    }",
    ].join("\n");
  }).join("\n\n");

  return `// swiftui-explorer:begin
// MARK: - SwiftUI Explorer Generated Preview Support

private extension ${appStructName} {
    @ViewBuilder
    func swiftUIExplorerRoot<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        if swiftUIExplorerLaunchSelection.isActive {
            SwiftUIExplorerPreviewHostRootView(
                registry: swiftUIExplorerPreviewRegistry,
                launchSelection: swiftUIExplorerLaunchSelection
            )
        } else {
            content()
        }
    }
}

private struct SwiftUIExplorerLaunchSelection {
    let targetID: String?
    let fixtureID: String?
    let environmentID: String?

    var isActive: Bool {
        targetID != nil || ProcessInfo.processInfo.environment["SWIFTUI_EXPLORER_MANIFEST_OUTPUT"] != nil
    }

    static func fromProcessEnvironment() -> SwiftUIExplorerLaunchSelection {
        let environment = ProcessInfo.processInfo.environment
        return SwiftUIExplorerLaunchSelection(
            targetID: environment["SWIFTUI_EXPLORER_TARGET_ID"],
            fixtureID: environment["SWIFTUI_EXPLORER_FIXTURE_ID"],
            environmentID: environment["SWIFTUI_EXPLORER_ENVIRONMENT_ID"]
        )
    }
}

private struct SwiftUIExplorerPreviewFixture: Codable, Hashable, Identifiable {
    let id: String
    let displayName: String
}

private struct SwiftUIExplorerPreviewEnvironment: Codable, Hashable, Identifiable {
    enum ColorSchemeOption: String, Codable, Hashable {
        case light
        case dark
    }

    enum DynamicTypeSizeOption: String, Codable, Hashable {
        case small
        case large
        case accessibility1
    }

    let id: String
    let displayName: String
    let colorScheme: ColorSchemeOption
    let localeIdentifier: String
    let dynamicTypeSize: DynamicTypeSizeOption

    static let defaultLight = SwiftUIExplorerPreviewEnvironment(
        id: "light",
        displayName: "Light",
        colorScheme: .light,
        localeIdentifier: "en_US",
        dynamicTypeSize: .large
    )

    static let defaultDark = SwiftUIExplorerPreviewEnvironment(
        id: "dark",
        displayName: "Dark",
        colorScheme: .dark,
        localeIdentifier: "en_US",
        dynamicTypeSize: .large
    )

    static let defaults = [defaultLight, defaultDark]

    @MainActor
    func apply<Content: View>(to content: Content) -> some View {
        content
            .environment(\\.locale, Locale(identifier: localeIdentifier))
            .environment(\\.dynamicTypeSize, swiftUIDynamicTypeSize)
            .preferredColorScheme(swiftUIColorScheme)
    }

    private var swiftUIColorScheme: SwiftUI.ColorScheme {
        switch colorScheme {
        case .light:
            return .light
        case .dark:
            return .dark
        }
    }

    private var swiftUIDynamicTypeSize: SwiftUI.DynamicTypeSize {
        switch dynamicTypeSize {
        case .small:
            return .small
        case .large:
            return .large
        case .accessibility1:
            return .accessibility1
        }
    }
}

private struct SwiftUIExplorerPreviewDescriptor: Codable, Hashable {
    let id: String
    let displayName: String
    let status: String
    let fixtures: [SwiftUIExplorerPreviewFixture]
    let supportedEnvironments: [SwiftUIExplorerPreviewEnvironment]
}

private struct SwiftUIExplorerPreviewManifest: Codable, Hashable {
    let appName: String
    let scheme: String
    let targets: [SwiftUIExplorerPreviewDescriptor]
}

private struct SwiftUIExplorerPreviewContext {
    let fixture: SwiftUIExplorerPreviewFixture?
    let environment: SwiftUIExplorerPreviewEnvironment
}

private struct SwiftUIExplorerPreviewTarget: Identifiable {
    let descriptor: SwiftUIExplorerPreviewDescriptor
    private let renderBody: @MainActor (SwiftUIExplorerPreviewContext) -> AnyView

    var id: String {
        descriptor.id
    }

    init<Content: View>(
        id: String,
        displayName: String,
        status: String = "placeholder",
        fixtures: [SwiftUIExplorerPreviewFixture] = [],
        supportedEnvironments: [SwiftUIExplorerPreviewEnvironment] = SwiftUIExplorerPreviewEnvironment.defaults,
        @ViewBuilder render: @escaping @MainActor (SwiftUIExplorerPreviewContext) -> Content
    ) {
        self.descriptor = SwiftUIExplorerPreviewDescriptor(
            id: id,
            displayName: displayName,
            status: status,
            fixtures: fixtures,
            supportedEnvironments: supportedEnvironments
        )
        self.renderBody = { context in
            AnyView(render(context))
        }
    }

    @MainActor
    func makeView(
        fixtureID: String? = nil,
        environment: SwiftUIExplorerPreviewEnvironment? = nil
    ) -> some View {
        let selectedEnvironment = environment ?? descriptor.supportedEnvironments.first ?? .defaultLight
        let selectedFixture = descriptor.fixtures.first { $0.id == fixtureID } ?? descriptor.fixtures.first
        let context = SwiftUIExplorerPreviewContext(fixture: selectedFixture, environment: selectedEnvironment)

        return selectedEnvironment.apply(to: renderBody(context))
    }
}

private protocol SwiftUIExplorerPreviewRegistryProtocol {
    func allPreviews() -> [SwiftUIExplorerPreviewTarget]
}

private extension SwiftUIExplorerPreviewRegistryProtocol {
    func manifest(appName: String, scheme: String) -> SwiftUIExplorerPreviewManifest {
        SwiftUIExplorerPreviewManifest(
            appName: appName,
            scheme: scheme,
            targets: allPreviews().map(\\.descriptor)
        )
    }
}

private struct SwiftUIExplorerPreviewRegistry: SwiftUIExplorerPreviewRegistryProtocol {
    func allPreviews() -> [SwiftUIExplorerPreviewTarget] {
        [
${targetLines}
        ]
    }
}

private enum SwiftUIExplorerPreviewBootstrap {
    static func writeManifestIfNeeded(
        registry: SwiftUIExplorerPreviewRegistry,
        appName: String,
        scheme: String
    ) -> Bool {
        guard let outputPath = ProcessInfo.processInfo.environment["SWIFTUI_EXPLORER_MANIFEST_OUTPUT"] else {
            return false
        }

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]

        guard let data = try? encoder.encode(registry.manifest(appName: appName, scheme: scheme)) else {
            return false
        }

        let url = URL(fileURLWithPath: outputPath)
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? data.write(to: url)
        return true
    }
}

// MARK: - Preview Adapters
// Each function below is a preview adapter stub. Replace the placeholder with your
// real view initializer. The context parameter provides fixture and environment
// selection so you can render different states of your view.

private enum SwiftUIExplorerPreviewAdapters {
${adapterLines}
}

private struct SwiftUIExplorerPreviewHostRootView: View {
    private let previews: [SwiftUIExplorerPreviewTarget]

    @State private var selectedPreviewID: String
    @State private var selectedFixtureID: String
    @State private var selectedEnvironmentID: String

    init(
        registry: some SwiftUIExplorerPreviewRegistryProtocol,
        launchSelection: SwiftUIExplorerLaunchSelection
    ) {
        let previews = registry.allPreviews()
        self.previews = previews

        let initialPreview = previews.first(where: { $0.id == launchSelection.targetID }) ?? previews.first
        let initialFixtureID = initialPreview?.descriptor.fixtures.first(where: { $0.id == launchSelection.fixtureID })?.id
            ?? initialPreview?.descriptor.fixtures.first?.id
            ?? ""
        let initialEnvironmentID = initialPreview?.descriptor.supportedEnvironments.first(where: { $0.id == launchSelection.environmentID })?.id
            ?? initialPreview?.descriptor.supportedEnvironments.first?.id
            ?? SwiftUIExplorerPreviewEnvironment.defaultLight.id

        _selectedPreviewID = State(initialValue: initialPreview?.descriptor.id ?? "")
        _selectedFixtureID = State(initialValue: initialFixtureID)
        _selectedEnvironmentID = State(initialValue: initialEnvironmentID)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("SwiftUI Explorer")
                        .font(.headline)

                    Picker("Target", selection: $selectedPreviewID) {
                        ForEach(previews) { preview in
                            Text(preview.descriptor.displayName).tag(preview.id)
                        }
                    }
                    .pickerStyle(.menu)

                    if let preview = selectedPreview, !preview.descriptor.fixtures.isEmpty {
                        Picker("Fixture", selection: $selectedFixtureID) {
                            ForEach(preview.descriptor.fixtures) { fixture in
                                Text(fixture.displayName).tag(fixture.id)
                            }
                        }
                        .pickerStyle(.segmented)
                    }

                    if let preview = selectedPreview {
                        Picker("Environment", selection: $selectedEnvironmentID) {
                            ForEach(preview.descriptor.supportedEnvironments) { environment in
                                Text(environment.displayName).tag(environment.id)
                            }
                        }
                        .pickerStyle(.segmented)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Divider()

                if let preview = selectedPreview {
                    ScrollView {
                        preview.makeView(
                            fixtureID: selectedFixtureID.isEmpty ? nil : selectedFixtureID,
                            environment: selectedEnvironment
                        )
                        .padding(.vertical, 24)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                } else {
                    ContentUnavailableView(
                        "No Preview Targets",
                        systemImage: "rectangle.on.rectangle.slash",
                        description: Text("Run the setup command again to regenerate starter previews.")
                    )
                }
            }
            .padding()
            .navigationTitle("SwiftUI Explorer")
            .onChange(of: selectedPreviewID) { _, _ in
                syncSelectionToCurrentPreview()
            }
        }
    }

    private var selectedPreview: SwiftUIExplorerPreviewTarget? {
        previews.first { $0.id == selectedPreviewID }
    }

    private var selectedEnvironment: SwiftUIExplorerPreviewEnvironment {
        selectedPreview?.descriptor.supportedEnvironments.first(where: { $0.id == selectedEnvironmentID })
            ?? selectedPreview?.descriptor.supportedEnvironments.first
            ?? .defaultLight
    }

    private func syncSelectionToCurrentPreview() {
        guard let preview = selectedPreview else {
            selectedFixtureID = ""
            selectedEnvironmentID = SwiftUIExplorerPreviewEnvironment.defaultLight.id
            return
        }

        selectedFixtureID = preview.descriptor.fixtures.first?.id ?? ""
        selectedEnvironmentID = preview.descriptor.supportedEnvironments.first?.id ?? SwiftUIExplorerPreviewEnvironment.defaultLight.id
    }
}
// swiftui-explorer:end`;
}

function findMatchingBrace(contents: string, openingBraceIndex: number): number {
  let depth = 0;

  for (let index = openingBraceIndex; index < contents.length; index += 1) {
    const character = contents[index];
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  throw new Error("Could not match braces in the selected Swift file.");
}

function indentMultiline(value: string, prefix: string): string {
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugifyIdentifier(value: string): string {
  return humanizeIdentifier(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sanitizeSwiftIdentifier(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]/g, "");
  return sanitized.length > 0 ? sanitized[0].toUpperCase() + sanitized.slice(1) : "View";
}

function normalizeProductName(value: string): string {
  return value.endsWith(".app") ? value.slice(0, -4) : value;
}

function toSwiftStringLiteral(value: string): string {
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function detectAndPickBuildContainer(appRoot: string): Promise<string | undefined> {
  const entries = readdirSync(appRoot, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && (entry.name.endsWith(".xcodeproj") || entry.name.endsWith(".xcworkspace")))
    .map((entry) => ({
      name: entry.name,
      fullPath: path.join(appRoot, entry.name),
      isWorkspace: entry.name.endsWith(".xcworkspace"),
    }));

  if (candidates.length === 0) {
    vscode.window.showWarningMessage("No .xcodeproj or .xcworkspace found in the selected directory.");
    return undefined;
  }

  if (candidates.length === 1) {
    return candidates[0].fullPath;
  }

  const selection = await vscode.window.showQuickPick(
    candidates.map((candidate) => ({
      label: candidate.name,
      description: candidate.isWorkspace ? "Workspace" : "Project",
      fullPath: candidate.fullPath,
    })),
    {
      title: "Select Xcode Project or Workspace",
      ignoreFocusOut: true,
    },
  );

  return selection?.fullPath;
}

async function detectAndPickScheme(buildContainerPath: string): Promise<string | undefined> {
  const isWorkspace = buildContainerPath.endsWith(".xcworkspace");
  const flag = isWorkspace ? "-workspace" : "-project";

  try {
    const { stdout } = await execFileAsync("xcodebuild", [flag, buildContainerPath, "-list"], {
      timeout: 15000,
    });

    const schemes: string[] = [];
    let inSchemes = false;
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "Schemes:") {
        inSchemes = true;
        continue;
      }
      if (inSchemes) {
        if (!trimmed || trimmed.endsWith(":")) {
          break;
        }
        schemes.push(trimmed);
      }
    }

    if (schemes.length === 1) {
      return schemes[0];
    }

    if (schemes.length > 1) {
      const selection = await vscode.window.showQuickPick(
        schemes.map((name) => ({ label: name })),
        { title: "Select Xcode Scheme", ignoreFocusOut: true },
      );
      return selection?.label;
    }
  } catch {
    // xcodebuild -list failed — fall through to manual input
  }

  return vscode.window.showInputBox({
    title: "SwiftUI Explorer Scheme",
    prompt: "Could not detect schemes automatically. Enter the Xcode scheme to build.",
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "Scheme is required."),
  });
}

async function detectBundleIdentifier(buildContainerPath: string, scheme: string): Promise<string | null> {
  return detectBuildSetting(buildContainerPath, scheme, "PRODUCT_BUNDLE_IDENTIFIER");
}

async function detectBuildProductName(buildContainerPath: string, scheme: string): Promise<string | null> {
  const fullProductName = await detectBuildSetting(buildContainerPath, scheme, "FULL_PRODUCT_NAME");
  if (fullProductName) {
    return normalizeProductName(fullProductName);
  }

  return detectBuildSetting(buildContainerPath, scheme, "PRODUCT_NAME");
}

async function detectBuildSetting(
  buildContainerPath: string,
  scheme: string,
  settingKey: string,
): Promise<string | null> {
  const isWorkspace = buildContainerPath.endsWith(".xcworkspace");
  const flag = isWorkspace ? "-workspace" : "-project";

  try {
    const { stdout } = await execFileAsync(
      "xcodebuild",
      [flag, buildContainerPath, "-scheme", scheme, "-showBuildSettings"],
      { timeout: 30000 },
    );

    for (const line of stdout.split("\n")) {
      const match = line.match(new RegExp(`^\\s*${escapeRegExp(settingKey)}\\s*=\\s*(.+)$`));
      if (match) {
        return match[1].trim();
      }
    }
  } catch {
    // fall through
  }

  return null;
}

async function pickSingleUri(options: vscode.OpenDialogOptions): Promise<vscode.Uri | undefined> {
  const selection = await vscode.window.showOpenDialog(options);
  return selection?.[0];
}

function getRuntimeBaseUrl(): string {
  return vscode.workspace
    .getConfiguration("swiftuiExplorer")
    .get<string>("runtimeBaseUrl", "http://127.0.0.1:4123")
    .replace(/\/$/, "");
}

function getJson<T>(urlString: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const url = new URL(urlString);
    const client = url.protocol === "https:" ? https : http;

    const request = client.get(url, (response) => {
      if (!response.statusCode) {
        reject(new Error("Runtime did not return a status code."));
        return;
      }

      if (response.statusCode >= 400) {
        reject(new Error(`Runtime returned HTTP ${response.statusCode}.`));
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body) as T);
        } catch (error) {
          reject(error);
        }
      });
    });

    request.on("error", (error) => {
      reject(error);
    });
  });
}

async function openPreviewSelection(
  context: vscode.ExtensionContext,
  baseUrl: string,
  payload: OpenPreviewRequest,
  targetDisplayName?: string,
): Promise<OpenPreviewResponse> {
  const launchedPreview = await vscode.window.withProgress<OpenPreviewResponse>(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Opening ${targetDisplayName ?? payload.targetId}`,
      cancellable: false,
    },
    async () => postJson<OpenPreviewResponse>(`${baseUrl}/api/v1/preview/open`, payload),
  );

  await context.globalState.update(LAST_PREVIEW_STATE_KEY, payload);
  return launchedPreview;
}

async function refreshPreviewSelection(
  context: vscode.ExtensionContext,
  baseUrl: string,
  lastPreviewSelection: OpenPreviewRequest,
  options?: {
    progressTitle?: string;
    showProgress?: boolean;
    showStatusBar?: boolean;
  },
): Promise<OpenPreviewResponse> {
  const runRefresh = async (): Promise<OpenPreviewResponse> => {
    if (options?.showStatusBar) {
      void vscode.window.setStatusBarMessage("$(sync~spin) Auto-refreshing SwiftUI preview...", 4000);
    }

    try {
      return await postJson<OpenPreviewResponse>(`${baseUrl}/api/v1/preview/refresh`, {});
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown runtime error";
      if (!message.includes("No preview has been opened yet")) {
        throw error;
      }

      return openPreviewSelection(context, baseUrl, lastPreviewSelection);
    }
  };

  if (options?.showProgress === false) {
    return runRefresh();
  }

  return vscode.window.withProgress<OpenPreviewResponse>(
    {
      location: vscode.ProgressLocation.Notification,
      title: options?.progressTitle ?? "Refreshing SwiftUI preview",
      cancellable: false,
    },
    async () => runRefresh(),
  );
}

function postJson<T>(urlString: string, body: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const url = new URL(urlString);
    const client = url.protocol === "https:" ? https : http;
    const payload = JSON.stringify(body);

    const request = client.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        const statusCode = response.statusCode;
        if (!statusCode) {
          reject(new Error("Runtime did not return a status code."));
          return;
        }

        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(responseBody) as T & { error?: string };
            if (statusCode >= 400) {
              reject(new Error(parsed.error ?? `Runtime returned HTTP ${statusCode}.`));
              return;
            }
            resolve(parsed as T);
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    request.on("error", (error) => {
      reject(error);
    });

    request.write(payload);
    request.end();
  });
}

async function pickTarget(targets: PreviewDescriptor[]): Promise<PreviewDescriptor | undefined> {
  const selection = await vscode.window.showQuickPick(
    targets.map((target) => ({
      label: target.displayName,
      description: target.id,
      detail: `${target.fixtures.length} fixture(s), ${target.supportedEnvironments.length} environment(s)`,
      target,
    })),
    {
      title: "Select SwiftUI preview target",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );

  return selection?.target;
}

async function pickFixture(target: PreviewDescriptor): Promise<PreviewFixture | null | undefined> {
  if (target.fixtures.length === 0) {
    return null;
  }

  const selection = await vscode.window.showQuickPick(
    target.fixtures.map((fixture) => ({
      label: fixture.displayName,
      description: fixture.id,
      fixture,
    })),
    {
      title: `Select fixture for ${target.displayName}`,
      matchOnDescription: true,
    },
  );

  return selection?.fixture;
}

async function pickEnvironment(target: PreviewDescriptor): Promise<PreviewEnvironment | undefined> {
  const selection = await vscode.window.showQuickPick(
    target.supportedEnvironments.map((environment) => ({
      label: environment.displayName,
      description: environment.id,
      detail: `${environment.colorScheme}, ${environment.dynamicTypeSize}, ${environment.localeIdentifier}`,
      environment,
    })),
    {
      title: `Select environment for ${target.displayName}`,
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );

  return selection?.environment;
}

function renderLoadingHtml(): string {
  return renderShell(`
    <h1>SwiftUI Explorer</h1>
    <p>Loading runtime status...</p>
  `);
}

function renderErrorHtml(baseUrl: string, message: string): string {
  return renderShell(`
    <h1>SwiftUI Explorer</h1>
    <p>Could not reach the local runtime at <code>${escapeHtml(baseUrl)}</code>.</p>
    <p>${escapeHtml(message)}</p>
    <p>Start <code>@swiftui-explorer/preview-cli</code> and reopen this panel.</p>
  `);
}

function renderPanelHtml(snapshot: ExplorerSnapshot): string {
  const { health, inspection, discovery, autoRefresh, hostAppConfiguration, selection } = snapshot;
  const checkItems: Array<[string, boolean]> = [
    ["Package.swift found", inspection.hasPackageSwift],
    ["Xcode project found", inspection.hasXcodeProject],
    ["Xcode workspace found", inspection.hasWorkspace],
    ["XcodeGen spec found", inspection.hasXcodeGenSpec],
  ];

  const checks = checkItems
    .map(([label, ok]) => `<li>${escapeHtml(label)}: <strong>${ok ? "yes" : "no"}</strong></li>`)
    .join("");
  const buildContainerLabel = hostAppConfiguration.workspacePath
    ? `Workspace: <code>${escapeHtml(hostAppConfiguration.workspacePath)}</code>`
    : `Project: <code>${escapeHtml(hostAppConfiguration.projectPath ?? "not configured")}</code>`;
  const hostAppSummary = `
    <div class="detailCard">
      <div class="buttonRow configHeader">
        <strong>Host App</strong>
        <div class="buttonRow">
          <button id="setupButton">Generate Adapters</button>
          <button id="configureButton" class="secondary">Configure Host App</button>
        </div>
      </div>
      <p>Mode: <strong>${hostAppConfiguration.usingDefault ? "Sample app" : "Custom app"}</strong></p>
      <p>Root: <code>${escapeHtml(hostAppConfiguration.appRoot)}</code></p>
      <p>${buildContainerLabel}</p>
      <p>Scheme: <code>${escapeHtml(hostAppConfiguration.scheme)}</code></p>
      <p>Bundle ID: <code>${escapeHtml(hostAppConfiguration.bundleIdentifier)}</code></p>
      <p>Manifest (auto-detected): <code>${escapeHtml(hostAppConfiguration.manifestPath)}</code></p>
      <p>XcodeGen: <code>${escapeHtml(hostAppConfiguration.xcodeGenSpecPath ?? "not configured")}</code></p>
    </div>
  `;

  const bootstrapJson = escapeScriptJson(
    JSON.stringify({
      targets: discovery.targets,
      autoRefresh,
      selection,
    }),
  );

  const placeholderCount = discovery.targets.filter((target) => target.status === "placeholder").length;
  const configuredCount = discovery.targets.length - placeholderCount;
  const adapterStatusLine = placeholderCount > 0
    ? `<p>${configuredCount} configured, ${placeholderCount} adapter stub${placeholderCount === 1 ? "" : "s"} remaining.</p>`
    : `<p>All ${discovery.targets.length} adapter${discovery.targets.length === 1 ? "" : "s"} configured.</p>`;

  const targetSummary = discovery.targets.length > 0
    ? `
      <p>Discovered <strong>${discovery.targets.length}</strong> preview target${discovery.targets.length === 1 ? "" : "s"} from <code>${escapeHtml(discovery.appName ?? "unknown app")}</code>.</p>
      ${adapterStatusLine}
      <p>Scheme: <code>${escapeHtml(discovery.scheme ?? "unknown")}</code></p>
      <p>Manifest: <code>${escapeHtml(discovery.manifestPath ?? "not found")}</code></p>
      <div class="controls">
        <div class="detailCard">
          <div class="autoRefreshRow">
            <div>
              <strong>Auto-refresh</strong>
              <div id="autoRefreshStatus" class="status">${autoRefresh.enabled ? "On" : "Off"}</div>
            </div>
            <button id="autoRefreshToggle" class="secondary">${autoRefresh.enabled ? "Turn Off" : "Turn On"}</button>
          </div>
        </div>
        <label class="field">
          <span>Target</span>
          <select id="targetSelect"></select>
        </label>
        <label class="field">
          <span>Fixture</span>
          <select id="fixtureSelect"></select>
        </label>
        <label class="field">
          <span>Environment</span>
          <select id="environmentSelect"></select>
        </label>
        <div class="buttonRow">
          <button id="openButton">Open In Simulator</button>
          <button id="refreshButton" class="secondary">Refresh Last Preview</button>
        </div>
        <p id="panelStatus" class="status">Use the selectors above to launch or refresh a preview.</p>
      </div>
      <div id="targetDetails"></div>
    `
    : `
      <div class="detailCard">
        <p>No preview targets are available yet.</p>
        <p>Run setup to generate preview adapter stubs in your app entry file. Each adapter is a single function where you supply your real view initializer.</p>
        <div class="buttonRow">
          <button id="emptySetupButton">Generate Preview Adapters</button>
        </div>
      </div>
    `;

  return renderShell(`
    <h1>SwiftUI Explorer</h1>
    <p>Runtime status: <strong>${escapeHtml(health.status)}</strong></p>
    <p>Runtime version: <code>${escapeHtml(health.version)}</code></p>
    <p>Workspace root: <code>${escapeHtml(inspection.workspaceRoot)}</code></p>
    <h2>Host app</h2>
    ${hostAppSummary}
    <h2>Workspace inspection</h2>
    <ul>${checks}</ul>
    <h2>Preview targets</h2>
    ${targetSummary}
    <h2>Status</h2>
    <p>${escapeHtml(inspection.suggestedNextAction)}</p>
    <script id="swiftuiExplorerBootstrap" type="application/json">${bootstrapJson}</script>
    <script>
      const vscode = acquireVsCodeApi();
      const bootstrapElement = document.getElementById("swiftuiExplorerBootstrap");
      const bootstrap = bootstrapElement ? JSON.parse(bootstrapElement.textContent || "{}") : {};
      const targets = Array.isArray(bootstrap.targets) ? bootstrap.targets : [];
      const storedSelection = bootstrap.selection || null;
      let autoRefreshEnabled = !!(bootstrap.autoRefresh && bootstrap.autoRefresh.enabled);

      const targetSelect = document.getElementById("targetSelect");
      const fixtureSelect = document.getElementById("fixtureSelect");
      const environmentSelect = document.getElementById("environmentSelect");
      const openButton = document.getElementById("openButton");
      const refreshButton = document.getElementById("refreshButton");
      const autoRefreshToggle = document.getElementById("autoRefreshToggle");
      const configureButton = document.getElementById("configureButton");
      const setupButton = document.getElementById("setupButton");
      const emptySetupButton = document.getElementById("emptySetupButton");
      const autoRefreshStatus = document.getElementById("autoRefreshStatus");
      const panelStatus = document.getElementById("panelStatus");
      const targetDetails = document.getElementById("targetDetails");

      function currentTarget() {
        return targets.find((target) => target.id === targetSelect.value) || null;
      }

      function setStatus(kind, text) {
        panelStatus.textContent = text;
        panelStatus.className = "status " + kind;
      }

      function renderAutoRefresh() {
        if (autoRefreshStatus) {
          autoRefreshStatus.textContent = autoRefreshEnabled ? 'On' : 'Off';
          autoRefreshStatus.className = 'status ' + (autoRefreshEnabled ? 'success' : '');
        }

        if (autoRefreshToggle) {
          autoRefreshToggle.textContent = autoRefreshEnabled ? 'Turn Off' : 'Turn On';
        }
      }

      function populateTargets() {
        targetSelect.innerHTML = targets
          .map((target) => {
            const suffix = target.status === 'placeholder' ? ' (stub)' : '';
            return '<option value="' + escapeAttribute(target.id) + '">' + escapeText(target.displayName) + suffix + '</option>';
          })
          .join("");

        const initialTargetId = storedSelection && storedSelection.targetId
          ? storedSelection.targetId
          : (targets[0] ? targets[0].id : "");

        if (initialTargetId) {
          targetSelect.value = initialTargetId;
        }
      }

      function populateFixtures() {
        const target = currentTarget();
        if (!target) {
          fixtureSelect.innerHTML = "";
          fixtureSelect.disabled = true;
          return;
        }

        const fixtures = target.fixtures || [];
        if (fixtures.length === 0) {
          fixtureSelect.innerHTML = '<option value="">No fixtures</option>';
          fixtureSelect.value = "";
          fixtureSelect.disabled = true;
          return;
        }

        fixtureSelect.disabled = false;
        fixtureSelect.innerHTML = fixtures
          .map((fixture) => '<option value="' + escapeAttribute(fixture.id) + '">' + escapeText(fixture.displayName) + '</option>')
          .join("");

        const preferredFixtureId = storedSelection && storedSelection.targetId === target.id
          ? storedSelection.fixtureId
          : "";
        fixtureSelect.value = fixtures.some((fixture) => fixture.id === preferredFixtureId)
          ? preferredFixtureId
          : fixtures[0].id;
      }

      function populateEnvironments() {
        const target = currentTarget();
        if (!target) {
          environmentSelect.innerHTML = "";
          environmentSelect.disabled = true;
          return;
        }

        const environments = target.supportedEnvironments || [];
        environmentSelect.disabled = environments.length === 0;
        environmentSelect.innerHTML = environments
          .map((environment) => '<option value="' + escapeAttribute(environment.id) + '">' + escapeText(environment.displayName) + '</option>')
          .join("");

        const preferredEnvironmentId = storedSelection && storedSelection.targetId === target.id
          ? storedSelection.environmentId
          : "";
        environmentSelect.value = environments.some((environment) => environment.id === preferredEnvironmentId)
          ? preferredEnvironmentId
          : (environments[0] ? environments[0].id : "");
      }

      function renderDetails() {
        const target = currentTarget();
        if (!target) {
          targetDetails.innerHTML = "";
          return;
        }

        const fixtures = (target.fixtures || []).map((fixture) => escapeText(fixture.displayName)).join(", ") || "No fixtures";
        const environments = (target.supportedEnvironments || []).map((environment) => escapeText(environment.displayName)).join(", ");
        const isPlaceholder = target.status === "placeholder";
        const statusBadge = isPlaceholder
          ? '<span class="badge badge-placeholder">Adapter Stub</span>'
          : '<span class="badge badge-configured">Configured</span>';
        const adapterHint = isPlaceholder
          ? '<div class="adapterHint">This target renders a placeholder. Open your app entry file and fill in the adapter function for <strong>' + escapeText(target.displayName) + '</strong> to render your real view.</div>'
          : '';

        targetDetails.innerHTML =
          '<div class="detailCard">' +
            '<h3>' + escapeText(target.displayName) + ' ' + statusBadge + '</h3>' +
            '<div><code>' + escapeText(target.id) + '</code></div>' +
            '<div>Fixtures: ' + fixtures + '</div>' +
            '<div>Environments: ' + environments + '</div>' +
            adapterHint +
          '</div>';
      }

      function currentPayload() {
        const target = currentTarget();
        return {
          targetId: target ? target.id : "",
          fixtureId: fixtureSelect.disabled || !fixtureSelect.value ? undefined : fixtureSelect.value,
          environmentId: environmentSelect.value || undefined,
        };
      }

      function syncAll() {
        populateFixtures();
        populateEnvironments();
        renderDetails();
      }

      function escapeText(value) {
        return String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;');
      }

      function escapeAttribute(value) {
        return escapeText(value).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
      }

      if (targets.length > 0) {
        populateTargets();
        syncAll();
      } else {
        if (openButton) {
          openButton.disabled = true;
        }
        if (refreshButton) {
          refreshButton.disabled = true;
        }
      }
      renderAutoRefresh();

      targetSelect && targetSelect.addEventListener('change', () => {
        syncAll();
      });

      openButton && openButton.addEventListener('click', () => {
        const payload = currentPayload();
        if (!payload.targetId) {
          setStatus('error', 'No preview target is selected.');
          return;
        }

        setStatus('pending', 'Opening preview in Simulator...');
        vscode.postMessage({
          type: 'openPreview',
          payload,
        });
      });

      refreshButton && refreshButton.addEventListener('click', () => {
        setStatus('pending', 'Refreshing last preview...');
        vscode.postMessage({
          type: 'refreshPreview',
        });
      });

      configureButton && configureButton.addEventListener('click', () => {
        setStatus('pending', 'Opening host app configuration...');
        vscode.postMessage({
          type: 'configureHostApp',
        });
      });

      function triggerSetupPreviews() {
        if (panelStatus) {
          setStatus('pending', 'Generating preview adapters...');
        }
        vscode.postMessage({
          type: 'setupPreviews',
        });
      }

      setupButton && setupButton.addEventListener('click', triggerSetupPreviews);
      emptySetupButton && emptySetupButton.addEventListener('click', triggerSetupPreviews);

      autoRefreshToggle && autoRefreshToggle.addEventListener('click', () => {
        const nextEnabled = !autoRefreshEnabled;
        setStatus('pending', (nextEnabled ? 'Enabling' : 'Disabling') + ' auto-refresh...');
        vscode.postMessage({
          type: 'toggleAutoRefresh',
          enabled: nextEnabled,
        });
      });

      window.addEventListener('message', (event) => {
        const message = event.data;
        if (!message) {
          return;
        }

        if (message.type === 'previewStatus') {
          setStatus(message.kind === 'error' ? 'error' : 'success', message.text);
          return;
        }

        if (message.type === 'autoRefreshState') {
          autoRefreshEnabled = !!message.enabled;
          renderAutoRefresh();
        }
      });
    </script>
  `);
}

function renderShell(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 16px;
      }

      code {
        font-family: var(--vscode-editor-font-family);
      }

      h1, h2 {
        font-weight: 600;
      }

      li {
        margin-bottom: 10px;
      }

      .controls {
        display: grid;
        gap: 12px;
        margin: 16px 0;
      }

      .field {
        display: grid;
        gap: 6px;
      }

      .field span {
        font-weight: 600;
      }

      select {
        background: var(--vscode-dropdown-background);
        color: var(--vscode-dropdown-foreground);
        border: 1px solid var(--vscode-dropdown-border, transparent);
        padding: 6px 8px;
      }

      .buttonRow {
        display: flex;
        gap: 8px;
      }

      .configHeader {
        justify-content: space-between;
        align-items: center;
      }

      button {
        border: 1px solid var(--vscode-button-border, transparent);
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        padding: 8px 12px;
        cursor: pointer;
      }

      button.secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }

      .status {
        margin: 0;
        color: var(--vscode-descriptionForeground);
      }

      .status.pending {
        color: var(--vscode-descriptionForeground);
      }

      .status.success {
        color: var(--vscode-testing-iconPassed);
      }

      .status.error {
        color: var(--vscode-errorForeground);
      }

      .detailCard {
        border: 1px solid var(--vscode-panel-border);
        padding: 12px;
        border-radius: 6px;
      }

      .detailCard h3 {
        margin-top: 0;
        margin-bottom: 8px;
      }

      .autoRefreshRow {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .badge {
        display: inline-block;
        font-size: 11px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 10px;
        vertical-align: middle;
      }

      .badge-placeholder {
        background: var(--vscode-editorWarning-foreground, #cca700);
        color: var(--vscode-editor-background);
      }

      .badge-configured {
        background: var(--vscode-testing-iconPassed, #73c991);
        color: var(--vscode-editor-background);
      }

      .adapterHint {
        margin-top: 10px;
        padding: 8px 10px;
        border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700);
        background: var(--vscode-textBlockQuote-background, rgba(127,127,127,.1));
        font-size: 12px;
        line-height: 1.5;
      }
    </style>
  </head>
  <body>
    ${content}
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeScriptJson(value: string): string {
  return value
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

function normalizeSelection(
  selection: OpenPreviewRequest | undefined,
  targets: PreviewDescriptor[],
): OpenPreviewRequest | null {
  if (targets.length === 0) {
    return null;
  }

  const selectedTarget = targets.find((target) => target.id === selection?.targetId) ?? targets[0];
  const selectedFixture = selection?.fixtureId && selectedTarget.fixtures.some((fixture) => fixture.id === selection.fixtureId)
    ? selection.fixtureId
    : selectedTarget.fixtures[0]?.id;
  const selectedEnvironment = selection?.environmentId && selectedTarget.supportedEnvironments.some(
    (environment) => environment.id === selection.environmentId,
  )
    ? selection.environmentId
    : selectedTarget.supportedEnvironments[0]?.id;

  return {
    targetId: selectedTarget.id,
    fixtureId: selectedFixture,
    environmentId: selectedEnvironment,
  };
}

function findTargetDisplayName(targets: PreviewDescriptor[], targetId: string): string | undefined {
  return targets.find((target) => target.id === targetId)?.displayName;
}

function isPanelMessage(
  value: unknown,
): value is
  | { type: "openPreview"; payload: OpenPreviewRequest }
  | { type: "refreshPreview" }
  | { type: "configureHostApp" }
  | { type: "setupPreviews" }
  | { type: "toggleAutoRefresh"; enabled: boolean } {
  if (!value || typeof value !== "object" || !("type" in value)) {
    return false;
  }

  const message = value as { type?: unknown; payload?: unknown; enabled?: unknown };
  if (message.type === "refreshPreview") {
    return true;
  }

  if (message.type === "configureHostApp") {
    return true;
  }

  if (message.type === "setupPreviews") {
    return true;
  }

  if (message.type === "toggleAutoRefresh") {
    return typeof message.enabled === "boolean";
  }

  if (message.type !== "openPreview" || !message.payload || typeof message.payload !== "object") {
    return false;
  }

  return "targetId" in (message.payload as object);
}
