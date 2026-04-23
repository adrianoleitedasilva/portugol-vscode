import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';

export class PortugolRunner {
    private process: ChildProcess | null = null;
    private output: vscode.OutputChannel;
    private onFinish: () => void;

    constructor(output: vscode.OutputChannel, onFinish: () => void) {
        this.output = output;
        this.onFinish = onFinish;
    }

    runWithCLI(interpreterPath: string, filePath: string) {
        this.output.appendLine(`[Portugol] Executando: ${filePath}`);
        this.output.appendLine('─'.repeat(50));

        try {
            this.process = spawn(interpreterPath, [filePath], {
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: true,
            });

            this.process.stdout?.on('data', (data: Buffer) => {
                this.output.append(data.toString());
            });

            this.process.stderr?.on('data', (data: Buffer) => {
                this.output.append('[Erro] ' + data.toString());
            });

            this.process.on('close', (code: number | null) => {
                this.output.appendLine('\n' + '─'.repeat(50));
                this.output.appendLine(`[Portugol] Processo encerrado com código: ${code ?? 0}`);
                this.onFinish();
            });

            this.process.on('error', (err: Error) => {
                this.output.appendLine(`[Erro] Não foi possível iniciar o interpretador: ${err.message}`);
                this.output.appendLine('Verifique o caminho em Configurações > portugol.interpreterPath');
                this.onFinish();
            });
        } catch (err: any) {
            this.output.appendLine(`[Erro] ${err.message}`);
            this.onFinish();
        }
    }

    stop() {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
    }
}
