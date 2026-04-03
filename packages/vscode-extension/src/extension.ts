import * as http from "node:http";
import * as https from "node:https";
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
  status: "launched";
  appName: string;
  scheme: string;
  simulatorId: string;
  simulatorName: string;
  bundleIdentifier: string;
  targetId: string;
  fixtureId: string | null;
  environmentId: string | null;
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

        const launchedPreview = await vscode.window.withProgress<OpenPreviewResponse>(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Opening ${selectedTarget.displayName}`,
            cancellable: false,
          },
          async () => postJson<OpenPreviewResponse>(`${baseUrl}/api/v1/preview/open`, payload),
        );

        vscode.window.showInformationMessage(
          `Opened ${selectedTarget.displayName} in ${launchedPreview.simulatorName}.`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown runtime error";
        vscode.window.showWarningMessage(`Could not open preview: ${message}`);
      }
    }),
    vscode.commands.registerCommand("swiftuiExplorer.openPanel", async () => {
      const panel = vscode.window.createWebviewPanel(
        "swiftuiExplorer",
        "SwiftUI Explorer",
        vscode.ViewColumn.Beside,
        {
          enableScripts: false,
        },
      );

      panel.webview.html = renderLoadingHtml();

      const baseUrl = getRuntimeBaseUrl();

      try {
        const [health, inspection, discovery] = await Promise.all([
          getJson<RuntimeHealth>(`${baseUrl}/health`),
          getJson<WorkspaceInspection>(`${baseUrl}/api/v1/workspace/inspect`),
          getJson<PreviewTargetDiscovery>(`${baseUrl}/api/v1/targets`),
        ]);

        panel.webview.html = renderPanelHtml(health, inspection, discovery);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown runtime error";
        panel.webview.html = renderErrorHtml(baseUrl, message);
      }
    }),
  );
}

export function deactivate(): void {}

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

function renderPanelHtml(
  health: RuntimeHealth,
  inspection: WorkspaceInspection,
  discovery: PreviewTargetDiscovery,
): string {
  const checkItems: Array<[string, boolean]> = [
    ["Package.swift found", inspection.hasPackageSwift],
    ["Xcode project found", inspection.hasXcodeProject],
    ["Xcode workspace found", inspection.hasWorkspace],
    ["XcodeGen spec found", inspection.hasXcodeGenSpec],
  ];

  const checks = checkItems
    .map(([label, ok]) => `<li>${escapeHtml(label)}: <strong>${ok ? "yes" : "no"}</strong></li>`)
    .join("");

  const targetSummary = discovery.targets.length > 0
    ? `
      <p>Discovered <strong>${discovery.targets.length}</strong> preview target${discovery.targets.length === 1 ? "" : "s"} from <code>${escapeHtml(discovery.appName ?? "unknown app")}</code>.</p>
      <p>Scheme: <code>${escapeHtml(discovery.scheme ?? "unknown")}</code></p>
      <p>Manifest: <code>${escapeHtml(discovery.manifestPath ?? "not found")}</code></p>
      ${renderTargetsList(discovery.targets)}
    `
    : `
      <p>No preview targets are available yet.</p>
    `;

  return renderShell(`
    <h1>SwiftUI Explorer</h1>
    <p>Runtime status: <strong>${escapeHtml(health.status)}</strong></p>
    <p>Runtime version: <code>${escapeHtml(health.version)}</code></p>
    <p>Workspace root: <code>${escapeHtml(inspection.workspaceRoot)}</code></p>
    <h2>Workspace inspection</h2>
    <ul>${checks}</ul>
    <h2>Preview targets</h2>
    ${targetSummary}
    <h2>Next step</h2>
    <p>${escapeHtml(inspection.suggestedNextAction)}</p>
  `);
}

function renderTargetsList(targets: PreviewDescriptor[]): string {
  const items = targets
    .map((target) => {
      const fixtures = target.fixtures.length === 0
        ? "No fixtures"
        : target.fixtures.map((fixture) => fixture.displayName).join(", ");
      const environments = target.supportedEnvironments.map((environment) => environment.displayName).join(", ");

      return `
        <li>
          <strong>${escapeHtml(target.displayName)}</strong>
          <div><code>${escapeHtml(target.id)}</code></div>
          <div>Fixtures: ${escapeHtml(fixtures)}</div>
          <div>Environments: ${escapeHtml(environments)}</div>
        </li>
      `;
    })
    .join("");

  return `<ul>${items}</ul>`;
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
