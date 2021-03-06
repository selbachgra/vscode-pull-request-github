/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { migrateConfiguration } from './authentication/vsConfiguration';
import { Resource } from './common/resources';
import { ReviewManager } from './view/reviewManager';
import { registerCommands } from './commands';
import Logger from './common/logger';
import { PullRequestManager } from './github/pullRequestManager';
import { formatError, onceEvent } from './common/utils';
import { GitExtension, API as GitAPI, Repository } from './typings/git';
import { Telemetry } from './common/telemetry';
import { handler as uriHandler } from './common/uri';
import { ITelemetry } from './github/interface';
import * as Keychain from './authentication/keychain';
import { FileTypeDecorationProvider } from './view/fileTypeDecorationProvider';

// fetch.promise polyfill
const fetch = require('node-fetch');
const PolyfillPromise = require('es6-promise').Promise;
fetch.Promise = PolyfillPromise;

let telemetry: ITelemetry;

async function init(context: vscode.ExtensionContext, git: GitAPI, repository: Repository): Promise<void> {
	context.subscriptions.push(Logger);
	Logger.appendLine('Git repository found, initializing review manager and pr tree view.');

	Keychain.init(context);
	await migrateConfiguration();
	context.subscriptions.push(Keychain.onDidChange(async _ => {
		if (prManager) {
			try {
				await prManager.clearCredentialCache();
				if (repository) {
					repository.status();
				}
			} catch (e) {
				vscode.window.showErrorMessage(formatError(e));
			}
		}
	}));

	context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));
	context.subscriptions.push(new FileTypeDecorationProvider());
	const prManager = new PullRequestManager(repository, telemetry);
	const reviewManager = new ReviewManager(context, Keychain.onDidChange, repository, prManager, telemetry);
	registerCommands(context, prManager, reviewManager, telemetry);

	git.repositories.forEach(repo => {
		repo.ui.onDidChange(() => {
			// No multi-select support, always show last selected repo
			if (repo.ui.selected) {
				prManager.repository = repo;
				reviewManager.repository = repo;
			}
		});
	});

	git.onDidOpenRepository(repo => {
		repo.ui.onDidChange(() => {
			if (repo.ui.selected) {
				prManager.repository = repo;
				reviewManager.repository = repo;
			}
		});
	});

	telemetry.on('startup');
}

export async function activate(context: vscode.ExtensionContext) {
	// initialize resources
	Resource.initialize(context);

	telemetry = new Telemetry(context);

	const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')!.exports;
	const git = gitExtension.getAPI(1);

	Logger.appendLine('Looking for git repository');
	const firstRepository = git.repositories[0];

	if (firstRepository) {
		await init(context, git, firstRepository);
	} else {
		onceEvent(git.onDidOpenRepository)(r => init(context, git, r));
	}
}

export async function deactivate() {
	if (telemetry) {
		await telemetry.shutdown();
	}
}