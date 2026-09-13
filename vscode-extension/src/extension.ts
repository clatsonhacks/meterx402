// MeterX402 VSCode Extension - Main entry point
import * as vscode from 'vscode';
import { ServicesProvider, ServiceItem } from './servicesProvider';
import { MeterX402Client } from './client';

let client: MeterX402Client;
let servicesProvider: ServicesProvider;
let secrets: vscode.SecretStorage;
const TOKEN_KEY = 'meterx402.connectorToken';

/** Open a terminal running the user's own connector with a fresh token. The
 *  connector reads BUYER_ACCOUNT_ID / BUYER_PRIVATE_KEY from that terminal's
 *  environment or the workspace .env, so the key never touches VS Code. */
async function startConnector() {
    const config = vscode.workspace.getConfiguration('meterx402');
    const hubUrl = config.get<string>('hubUrl') || 'http://localhost:4021';
    const connectorUrl = config.get<string>('connectorUrl') || 'http://localhost:3402';
    const port = new URL(connectorUrl).port || '3402';
    const bytes = new Uint8Array(24);
    globalThis.crypto.getRandomValues(bytes);
    const token = Buffer.from(bytes).toString('base64url');
    await secrets.store(TOKEN_KEY, token);
    const terminal = vscode.window.createTerminal({
        name: 'MeterX402 connector',
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        env: { CONNECTOR_TOKEN: token, MX_HUB: hubUrl }
    });
    terminal.show();
    terminal.sendText(`npx -y mx402 connector --port ${port}`);
    vscode.window.showInformationMessage(
        'Connector starting. It pays from BUYER_ACCOUNT_ID / BUYER_PRIVATE_KEY in this workspace\'s .env (or your shell): your own testnet account, not a shared wallet.'
    );
}

async function explainConnector(result: { connector?: string; error?: string }) {
    const choice = await vscode.window.showErrorMessage(
        `${result.error} Calls are paid from your own testnet account through your connector.`,
        'Start My Connector',
        'Set Token'
    );
    if (choice === 'Start My Connector') {
        await startConnector();
    } else if (choice === 'Set Token') {
        await vscode.commands.executeCommand('meterx402.setConnectorToken');
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('MeterX402 extension is now active');

    // Initialize client: discovery from the hub, payments through the user's own
    // connector. The connector's bearer token lives in VS Code's secret storage.
    const config = vscode.workspace.getConfiguration('meterx402');
    secrets = context.secrets;
    client = new MeterX402Client(
        config.get('hubUrl') || 'http://localhost:4021',
        {
            url: (config.get<string>('connectorUrl') || 'http://localhost:3402').replace(/\/+$/, ''),
            token: async () => secrets.get(TOKEN_KEY)
        }
    );

    // Command: Start My Connector (a terminal running `npx mx402 connector`)
    context.subscriptions.push(
        vscode.commands.registerCommand('meterx402.startConnector', async () => {
            await startConnector();
        })
    );

    // Command: Set Connector Token (for a connector started by hand)
    context.subscriptions.push(
        vscode.commands.registerCommand('meterx402.setConnectorToken', async () => {
            const token = await vscode.window.showInputBox({
                prompt: 'Bearer token printed by `npx mx402 connector`',
                password: true,
                ignoreFocusOut: true
            });
            if (token) {
                await secrets.store(TOKEN_KEY, token.trim());
                vscode.window.showInformationMessage('Connector token saved.');
            }
        })
    );

    // Register services tree view
    servicesProvider = new ServicesProvider(client);
    vscode.window.registerTreeDataProvider('meterx402.services', servicesProvider);

    // Command: Search Services
    context.subscriptions.push(
        vscode.commands.registerCommand('meterx402.searchServices', async () => {
            try {
                console.log('Search Services command triggered');
                const query = await vscode.window.showInputBox({
                    prompt: 'Search for services (e.g., weather, llm, blockchain)',
                    placeHolder: 'Enter capability or search term'
                });

                if (query) {
                    console.log('Searching for:', query);
                    await servicesProvider.search(query);
                }
            } catch (error: any) {
                console.error('Search Services error:', error);
                vscode.window.showErrorMessage(`Search failed: ${error.message}`);
            }
        })
    );

    // Command: Refresh Services
    context.subscriptions.push(
        vscode.commands.registerCommand('meterx402.refreshServices', () => {
            servicesProvider.refresh();
        })
    );

    // Command: Call Service
    context.subscriptions.push(
        vscode.commands.registerCommand('meterx402.callService', async (item: ServiceItem) => {
            await callService(item);
        })
    );

    // Command: Publish Dataset
    context.subscriptions.push(
        vscode.commands.registerCommand('meterx402.publishDataset', async (uri: vscode.Uri) => {
            await publishDataset(uri);
        })
    );

    // Command: Publish API
    context.subscriptions.push(
        vscode.commands.registerCommand('meterx402.publishAPI', async () => {
            await publishAPI();
        })
    );

    // Command: View Wallet
    context.subscriptions.push(
        vscode.commands.registerCommand('meterx402.viewWallet', async () => {
            await viewWallet();
        })
    );

    // Command: Open Dashboard
    context.subscriptions.push(
        vscode.commands.registerCommand('meterx402.openDashboard', () => {
            try {
                console.log('Open Dashboard command triggered');
                const hubUrl = config.get<string>('hubUrl') || 'http://localhost:4021';
                console.log('Opening URL:', hubUrl);
                vscode.env.openExternal(vscode.Uri.parse(hubUrl));
            } catch (error: any) {
                console.error('Open Dashboard error:', error);
                vscode.window.showErrorMessage(`Failed to open dashboard: ${error.message}`);
            }
        })
    );

    // Status bar item
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = '$(globe) MeterX402';
    statusBarItem.tooltip = 'MeterX402: Pay only for what you use';
    statusBarItem.command = 'meterx402.openDashboard';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Show welcome message on first activation
    const hasShownWelcome = context.globalState.get('hasShownWelcome', false);
    if (!hasShownWelcome) {
        vscode.window.showInformationMessage(
            'Welcome to MeterX402! Browse metered APIs and publish datasets.',
            'Open Dashboard',
            'Search Services'
        ).then(selection => {
            if (selection === 'Open Dashboard') {
                vscode.commands.executeCommand('meterx402.openDashboard');
            } else if (selection === 'Search Services') {
                vscode.commands.executeCommand('meterx402.searchServices');
            }
        });
        context.globalState.update('hasShownWelcome', true);
    }
}

async function callService(item: ServiceItem) {
    const service = item.service;

    // Ask for parameters
    const path = await vscode.window.showInputBox({
        prompt: 'API path (e.g., /?latitude=51.5&longitude=-0.1)',
        value: service.sample?.path || '/'
    });

    if (!path) {
        return;
    }

    const maxPrice = await vscode.window.showInputBox({
        prompt: `Most you'll pay for this call (${service.price.currency})`,
        value: vscode.workspace.getConfiguration('meterx402').get<string>('maxPerCall') || '0.1'
    });

    // Call the service
    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Calling ${service.name}...`,
            cancellable: false
        }, async (progress) => {
            progress.report({ message: 'Metering, quoting and paying from your account...' });

            const result = await client.callService(service.service_id, {
                path,
                maxPrice: parseFloat(maxPrice || '0.1')
            });

            if (result.connector) {
                void explainConnector(result);
            } else if (result.success) {
                // Show result in new document
                const doc = await vscode.workspace.openTextDocument({
                    content: JSON.stringify(result.data, null, 2),
                    language: 'json'
                });
                await vscode.window.showTextDocument(doc);

                vscode.window.showInformationMessage(
                    `✅ Success! Paid ${result.receipt?.amount || 0} ${result.receipt?.currency || 'HBAR'}`
                );
            } else {
                vscode.window.showErrorMessage(`Failed to call service: ${result.error}`);
            }
        });
    } catch (error: any) {
        vscode.window.showErrorMessage(`Error: ${error.message}`);
    }
}

async function publishDataset(uri: vscode.Uri) {
    const filePath = uri.fsPath;

    const wallet = await vscode.window.showInputBox({
        prompt: 'Payout wallet (Hedera account ID)',
        placeHolder: '0.0.xxxxx'
    });

    if (!wallet) {
        return;
    }

    const rate = await vscode.window.showInputBox({
        prompt: 'Price per row (HBAR)',
        value: '0.0001'
    });

    const title = await vscode.window.showInputBox({
        prompt: 'Dataset title',
        placeHolder: 'e.g., Weather Data 2024'
    });

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Publishing dataset...',
            cancellable: false
        }, async (progress) => {
            progress.report({ message: 'Reading file...' });

            const result = await client.publishDataset({
                path: filePath,
                wallet,
                rate: parseFloat(rate || '0.0001'),
                title: title || undefined
            });

            if (result.ok) {
                vscode.window.showInformationMessage(
                    `✅ Dataset published! ${result.rows} rows available.`,
                    'Open Dashboard'
                ).then(selection => {
                    if (selection === 'Open Dashboard') {
                        vscode.commands.executeCommand('meterx402.openDashboard');
                    }
                });
            } else {
                vscode.window.showErrorMessage(`Failed to publish: ${result.error}`);
            }
        });
    } catch (error: any) {
        vscode.window.showErrorMessage(`Error: ${error.message}`);
    }
}

async function publishAPI() {
    const url = await vscode.window.showInputBox({
        prompt: 'API URL',
        placeHolder: 'https://api.example.com/v1/endpoint'
    });

    if (!url) {
        return;
    }

    const wallet = await vscode.window.showInputBox({
        prompt: 'Payout wallet (Hedera account ID)',
        placeHolder: '0.0.xxxxx'
    });

    if (!wallet) {
        return;
    }

    vscode.window.showInformationMessage(
        'For full API publishing options, please use the dashboard.',
        'Open Dashboard'
    ).then(selection => {
        if (selection === 'Open Dashboard') {
            vscode.commands.executeCommand('meterx402.openDashboard');
        }
    });
}

async function viewWallet() {
    try {
        const info = await client.getWalletInfo();
        if (info.connector) {
            await explainConnector(info);
            return;
        }
        if (!info.ok) {
            vscode.window.showWarningMessage(`${info.error}`);
            return;
        }
        vscode.window.showInformationMessage(
            `Paying from your account ${info.account} · budget left ${info.budget_remaining ?? 'unlimited'} HBAR${info.evm ? ' · Base Sepolia' : ''}${info.solana ? ' · Solana devnet' : ''}`
        );
    } catch (error: any) {
        vscode.window.showErrorMessage(`Error fetching wallet info: ${error.message}`);
    }
}

export function deactivate() {
    console.log('MeterX402 extension deactivated');
}
