// MeterX402 VSCode Extension - Main entry point
import * as vscode from 'vscode';
import { ServicesProvider, ServiceItem } from './servicesProvider';
import { MeterX402Client } from './client';

let client: MeterX402Client;
let servicesProvider: ServicesProvider;

export function activate(context: vscode.ExtensionContext) {
    console.log('MeterX402 extension is now active');

    // Initialize client
    const config = vscode.workspace.getConfiguration('meterx402');
    client = new MeterX402Client(
        config.get('hubUrl') || 'http://localhost:4021',
        {
            accountId: config.get('buyerAccountId'),
            privateKey: config.get('buyerPrivateKey'),
            maxPerCall: config.get('maxPerCall'),
            budget: config.get('budget')
        }
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
        prompt: 'Maximum price (HBAR)',
        value: '0.1'
    });

    // Call the service
    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Calling ${service.name}...`,
            cancellable: false
        }, async (progress) => {
            progress.report({ message: 'Getting quote...' });

            const result = await client.callService(service.service_id, {
                path,
                maxPrice: parseFloat(maxPrice || '0.1')
            });

            if (result.success) {
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
    const config = vscode.workspace.getConfiguration('meterx402');
    const accountId = config.get<string>('buyerAccountId');

    if (!accountId) {
        const result = await vscode.window.showInformationMessage(
            'No wallet configured. Set up your Hedera account in settings.',
            'Open Settings'
        );

        if (result === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'meterx402');
        }
        return;
    }

    try {
        const info = await client.getWalletInfo();

        const message = `
Wallet: ${info.account}
Balance: ${info.balance || 'N/A'} HBAR
Max per call: ${config.get('maxPerCall')} HBAR
Budget: ${config.get('budget')} HBAR
        `.trim();

        vscode.window.showInformationMessage(message);
    } catch (error: any) {
        vscode.window.showErrorMessage(`Error fetching wallet info: ${error.message}`);
    }
}

export function deactivate() {
    console.log('MeterX402 extension deactivated');
}
