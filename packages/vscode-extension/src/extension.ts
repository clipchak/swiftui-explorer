import * as http from "node:http";
import * as https from "node:https";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

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

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
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
        const configuredHostApp = await promptForHostAppConfiguration(baseUrl);
        if (!configuredHostApp) {
          return;
        }

        vscode.window.showInformationMessage(
          `Configured ${path.basename(configuredHostApp.appRoot)} for SwiftUI Explorer.`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown runtime error";
        vscode.window.showWarningMessage(`Could not configure host app: ${message}`);
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
              const configuredHostApp = await promptForHostAppConfiguration(baseUrl);
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
      }
    }),
  );
}

export function deactivate(): void {}

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

async function promptForHostAppConfiguration(baseUrl: string): Promise<HostAppConfiguration | undefined> {
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

  const buildContainerUri = await pickSingleUri({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    defaultUri: appRootUri,
    openLabel: "Select Project or Workspace",
    title: "Select Xcode Project or Workspace",
    filters: {
      "Xcode Project or Workspace": ["xcodeproj", "xcworkspace"],
    },
  });
  if (!buildContainerUri) {
    return undefined;
  }

  const manifestUri = await pickSingleUri({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    defaultUri: appRootUri,
    openLabel: "Select Preview Manifest",
    title: "Select Preview Manifest",
    filters: {
      JSON: ["json"],
    },
  });
  if (!manifestUri) {
    return undefined;
  }

  const scheme = await vscode.window.showInputBox({
    title: "SwiftUI Explorer Scheme",
    prompt: "Enter the Xcode scheme to build for previews.",
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : "Scheme is required.",
  });
  if (!scheme) {
    return undefined;
  }

  const bundleIdentifier = await vscode.window.showInputBox({
    title: "SwiftUI Explorer Bundle Identifier",
    prompt: "Enter the app bundle identifier used to launch the host app in Simulator.",
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
    ...(buildContainerUri.fsPath.endsWith(".xcworkspace")
      ? { workspacePath: buildContainerUri.fsPath }
      : { projectPath: buildContainerUri.fsPath }),
    ...(detectedXcodeGenSpecPath ? { xcodeGenSpecPath: detectedXcodeGenSpecPath } : {}),
    scheme: scheme.trim(),
    manifestPath: manifestUri.fsPath,
    bundleIdentifier: bundleIdentifier.trim(),
  };

  return postJson<HostAppConfiguration>(`${baseUrl}/api/v1/config`, input);
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
        <button id="configureButton" class="secondary">Configure Host App</button>
      </div>
      <p>Mode: <strong>${hostAppConfiguration.usingDefault ? "Sample app" : "Custom app"}</strong></p>
      <p>Root: <code>${escapeHtml(hostAppConfiguration.appRoot)}</code></p>
      <p>${buildContainerLabel}</p>
      <p>Scheme: <code>${escapeHtml(hostAppConfiguration.scheme)}</code></p>
      <p>Bundle ID: <code>${escapeHtml(hostAppConfiguration.bundleIdentifier)}</code></p>
      <p>Manifest: <code>${escapeHtml(hostAppConfiguration.manifestPath)}</code></p>
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

  const targetSummary = discovery.targets.length > 0
    ? `
      <p>Discovered <strong>${discovery.targets.length}</strong> preview target${discovery.targets.length === 1 ? "" : "s"} from <code>${escapeHtml(discovery.appName ?? "unknown app")}</code>.</p>
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
      <p>No preview targets are available yet.</p>
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
          .map((target) => '<option value="' + escapeAttribute(target.id) + '">' + escapeText(target.displayName) + '</option>')
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

        targetDetails.innerHTML =
          '<div class="detailCard">' +
            '<h3>' + escapeText(target.displayName) + '</h3>' +
            '<div><code>' + escapeText(target.id) + '</code></div>' +
            '<div>Fixtures: ' + fixtures + '</div>' +
            '<div>Environments: ' + environments + '</div>' +
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

  if (message.type === "toggleAutoRefresh") {
    return typeof message.enabled === "boolean";
  }

  if (message.type !== "openPreview" || !message.payload || typeof message.payload !== "object") {
    return false;
  }

  return "targetId" in (message.payload as object);
}
