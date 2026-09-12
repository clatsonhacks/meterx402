// Tree view provider for MeterX402 services
import * as vscode from 'vscode';
import { MeterX402Client, Service } from './client';

export class ServiceItem extends vscode.TreeItem {
    constructor(
        public readonly service: Service,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(service.name, collapsibleState);

        this.description = `${service.price.amount} ${service.price.currency}/${service.price.unit}`;
        this.tooltip = this.createTooltip();
        this.contextValue = 'service';
        this.iconPath = new vscode.ThemeIcon('symbol-interface');

        // Add inline command button
        this.command = {
            command: 'meterx402.callService',
            title: 'Call Service',
            arguments: [this]
        };
    }

    private createTooltip(): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${this.service.name}**\n\n`);

        if (this.service.description) {
            md.appendMarkdown(`${this.service.description}\n\n`);
        }

        md.appendMarkdown(`**Price:** ${this.service.price.amount} ${this.service.price.currency} per ${this.service.price.unit}\n\n`);

        if (this.service.capabilities.length) {
            md.appendMarkdown(`**Capabilities:** ${this.service.capabilities.join(', ')}\n\n`);
        }

        if (this.service.reputation !== undefined) {
            md.appendMarkdown(`**Reputation:** ${this.service.reputation}/100\n\n`);
        }

        md.appendMarkdown(`**Service ID:** \`${this.service.service_id}\`\n\n`);
        md.appendMarkdown(`[View in Dashboard](${this.service.endpoint})`);

        return md;
    }
}

export class ServicesProvider implements vscode.TreeDataProvider<ServiceItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ServiceItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private services: Service[] = [];
    private currentQuery: string = '';

    constructor(private client: MeterX402Client) {
        this.loadServices();
    }

    refresh(): void {
        this.loadServices();
    }

    async search(query: string): Promise<void> {
        this.currentQuery = query;
        await this.loadServices();
    }

    private async loadServices(): Promise<void> {
        try {
            this.services = await this.client.searchServices(this.currentQuery);
            this._onDidChangeTreeData.fire();
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to load services: ${error.message}`);
        }
    }

    getTreeItem(element: ServiceItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ServiceItem): Thenable<ServiceItem[]> {
        if (element) {
            return Promise.resolve([]);
        }

        if (this.services.length === 0) {
            return Promise.resolve([]);
        }

        const items = this.services.map(service =>
            new ServiceItem(service, vscode.TreeItemCollapsibleState.None)
        );

        return Promise.resolve(items);
    }
}
