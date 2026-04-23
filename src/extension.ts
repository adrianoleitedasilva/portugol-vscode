import * as vscode from 'vscode';
import { PortugolInterpreter } from './interpreter';
import { PortugolRunner } from './runner';

let outputChannel: vscode.OutputChannel;
let currentRunner: PortugolRunner | null = null;
let currentInterpreter: PortugolInterpreter | null = null;
let statusBarItem: vscode.StatusBarItem;
let isRunning = false;

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Portugol');

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'portugol.run';
    statusBarItem.text = '$(play) Executar Portugol';
    statusBarItem.tooltip = 'Executar programa Portugol (F5)';
    context.subscriptions.push(outputChannel, statusBarItem);

    context.subscriptions.push(
        vscode.commands.registerCommand('portugol.run',     () => runPortugol()),
        vscode.commands.registerCommand('portugol.stop',    () => stopPortugol()),
        vscode.commands.registerCommand('portugol.newFile', () => newPortugolFile()),
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor?.document.languageId === 'portugol') {
                statusBarItem.show();
            } else {
                statusBarItem.hide();
            }
        })
    );

    if (vscode.window.activeTextEditor?.document.languageId === 'portugol') {
        statusBarItem.show();
    }
}

async function runPortugol() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('Nenhum arquivo aberto.');
        return;
    }
    if (editor.document.languageId !== 'portugol') {
        vscode.window.showErrorMessage('O arquivo ativo não é um arquivo Portugol (.por).');
        return;
    }
    if (isRunning) {
        stopPortugol();
        return;
    }

    await editor.document.save();

    const config = vscode.workspace.getConfiguration('portugol');
    if (config.get<boolean>('clearOutputOnRun', true)) outputChannel.clear();
    if (config.get<boolean>('showOutputOnRun',  true)) outputChannel.show(true);

    const interpreterPath = config.get<string>('interpreterPath', '').trim();
    const code     = editor.document.getText();
    const filePath = editor.document.fileName;

    setRunning(true);

    if (interpreterPath) {
        currentRunner = new PortugolRunner(outputChannel, () => setRunning(false));
        currentRunner.runWithCLI(interpreterPath, filePath);
    } else {
        currentInterpreter = new PortugolInterpreter(outputChannel, () => setRunning(false));
        // Não awaitar aqui — run() chama onFinish() quando termina, seja por conclusão ou erro
        currentInterpreter.run(code);
    }
}

function stopPortugol() {
    if (currentRunner) {
        currentRunner.stop();
        currentRunner = null;
    }
    if (currentInterpreter) {
        currentInterpreter.cancel();
        currentInterpreter = null;
    }
    if (isRunning) {
        outputChannel.appendLine('\n[Execução interrompida pelo usuário]');
        setRunning(false);
    }
}

function setRunning(running: boolean) {
    isRunning = running;
    // Expõe estado para menus condicionais (when: portugol.running)
    vscode.commands.executeCommand('setContext', 'portugol.running', running);

    if (running) {
        statusBarItem.text    = '$(stop-circle) Parar (Shift+F5)';
        statusBarItem.command = 'portugol.stop';
        statusBarItem.tooltip = 'Parar execução (Shift+F5)';
    } else {
        statusBarItem.text    = '$(play) Executar Portugol';
        statusBarItem.command = 'portugol.run';
        statusBarItem.tooltip = 'Executar programa Portugol (F5)';
        currentRunner      = null;
        currentInterpreter = null;
    }
}

async function newPortugolFile() {
    const template = [
        'algoritmo "MeuPrograma"',
        'var',
        '   // declare suas variáveis aqui',
        'inicio',
        '   escreval("Olá, Mundo!")',
        'fimalgoritmo',
    ].join('\n');

    const doc = await vscode.workspace.openTextDocument({ language: 'portugol', content: template });
    await vscode.window.showTextDocument(doc);
}

export function deactivate() {
    stopPortugol();
}
