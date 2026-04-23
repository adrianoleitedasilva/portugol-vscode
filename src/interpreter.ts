import * as vscode from 'vscode';

type Value = number | string | boolean | null | Value[];

interface Variable {
    name: string;
    type: string;
    value: Value;
}

const MAX_CALL_DEPTH = 500;
const MAX_LOOP_ITERATIONS = 1_000_000;

export class PortugolInterpreter {
    private output: vscode.OutputChannel;
    private onFinish: () => void;
    private variables = new Map<string, Variable>();
    private functions = new Map<string, FunctionDef>();
    private callStack: Map<string, Variable>[] = [];
    private cancelled = false;

    constructor(output: vscode.OutputChannel, onFinish: () => void) {
        this.output = output;
        this.onFinish = onFinish;
    }

    cancel() {
        this.cancelled = true;
    }

    async run(code: string) {
        this.variables.clear();
        this.functions.clear();
        this.cancelled = false;

        const startTime = Date.now();
        this.output.appendLine('[Portugol] Iniciando execução...');
        this.output.appendLine('─'.repeat(50));

        try {
            const tokens = tokenize(code);
            const ast = parse(tokens);
            await this.executeProgram(ast);
        } catch (err: any) {
            if (this.cancelled) {
                // já reportado em stopPortugol()
            } else if (err instanceof UserCancelledError) {
                this.output.appendLine('\n[Execução cancelada pelo usuário]');
            } else if (err instanceof PortugolError) {
                this.output.appendLine(`\n[Erro na linha ${err.line}] ${err.message}`);
            } else {
                this.output.appendLine(`\n[Erro] ${err.message}`);
            }
        }

        if (!this.cancelled) {
            const elapsed = Date.now() - startTime;
            this.output.appendLine('\n' + '─'.repeat(50));
            this.output.appendLine(`[Portugol] Execução concluída em ${elapsed}ms`);
            this.onFinish();
        }
    }

    private async executeProgram(ast: ProgramNode) {
        for (const fn of ast.functions) {
            this.functions.set(fn.name.toLowerCase(), fn);
        }
        await this.executeBlock(ast.body, this.variables);
    }

    private async executeBlock(stmts: Statement[], scope: Map<string, Variable>): Promise<Value> {
        for (const stmt of stmts) {
            if (this.cancelled) throw new UserCancelledError();
            const result = await this.executeStatement(stmt, scope);
            if (result instanceof ReturnSignal) return result.value;
            if (result instanceof BreakSignal || result instanceof ContinueSignal) throw result;
        }
        return null;
    }

    private async executeStatement(stmt: Statement, scope: Map<string, Variable>): Promise<Value | ReturnSignal | BreakSignal | ContinueSignal> {
        if (this.cancelled) throw new UserCancelledError();

        switch (stmt.type) {
            case 'VarDecl':
                this.declareVars(stmt as VarDeclNode, scope);
                break;

            case 'Assign':
                this.assign(stmt as AssignNode, scope);
                break;

            case 'Escreva':
            case 'Escreval': {
                const vals = (stmt as EscrevaNode).args.map(a => this.evalExpr(a, scope));
                const text = vals.map(v => this.valueToString(v)).join('');
                if (stmt.type === 'Escreval') {
                    this.output.appendLine(text);
                } else {
                    this.output.append(text);
                }
                break;
            }

            case 'Leia': {
                const leiaNode = stmt as LeiaNode;
                for (const target of leiaNode.targets) {
                    if (this.cancelled) throw new UserCancelledError();
                    const varEntry = this.lookupVar(target.name, scope, leiaNode.line);
                    const input = await vscode.window.showInputBox({
                        title: `Portugol — Entrada`,
                        prompt: `Variável "${target.name}" (${varEntry.type})`,
                        placeHolder: this.typeHint(varEntry.type),
                        ignoreFocusOut: true,
                    });
                    if (input === undefined) throw new UserCancelledError();
                    this.output.appendLine(`leia(${target.name}): ${input}`);
                    const parsed = this.parseInput(input, varEntry.type);
                    if (target.indices.length > 0) {
                        this.assignIndexed(varEntry, target.indices, scope, parsed, leiaNode.line);
                    } else {
                        varEntry.value = this.coerce(parsed, varEntry.type);
                    }
                }
                break;
            }

            case 'Se': {
                const s = stmt as SeNode;
                if (this.isTruthy(this.evalExpr(s.condition, scope))) {
                    return await this.executeBlock(s.then, scope);
                } else if (s.else) {
                    return await this.executeBlock(s.else, scope);
                }
                break;
            }

            case 'Para': {
                const p = stmt as ParaNode;
                const from = Number(this.evalExpr(p.from, scope));
                const to   = Number(this.evalExpr(p.to,   scope));
                const step = p.step ? Number(this.evalExpr(p.step, scope)) : (from <= to ? 1 : -1);
                if (step === 0) throw new PortugolError('Passo do "para" não pode ser zero', p.line);
                const loopScope = new Map(scope);
                loopScope.set(p.var.toLowerCase(), { name: p.var, type: 'inteiro', value: from });
                let iters = 0;
                for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
                    if (++iters > MAX_LOOP_ITERATIONS) throw new PortugolError('Loop infinito detectado (excedeu 1.000.000 iterações)', p.line);
                    if (this.cancelled) throw new UserCancelledError();
                    loopScope.get(p.var.toLowerCase())!.value = i;
                    try {
                        const r = await this.executeBlock(p.body, loopScope);
                        if (r instanceof ReturnSignal) return r;
                    } catch (e) {
                        if (e instanceof BreakSignal) break;
                        if (e instanceof ContinueSignal) continue;
                        throw e;
                    }
                }
                // propagar alterações nas variáveis de escopo externo
                for (const [k, v] of loopScope) {
                    if (k !== p.var.toLowerCase() && scope.has(k)) scope.set(k, v);
                }
                break;
            }

            case 'Enquanto': {
                const w = stmt as EnquantoNode;
                let iters = 0;
                while (this.isTruthy(this.evalExpr(w.condition, scope))) {
                    if (++iters > MAX_LOOP_ITERATIONS) throw new PortugolError('Loop infinito detectado (excedeu 1.000.000 iterações)', w.line);
                    if (this.cancelled) throw new UserCancelledError();
                    try {
                        const r = await this.executeBlock(w.body, scope);
                        if (r instanceof ReturnSignal) return r;
                    } catch (e) {
                        if (e instanceof BreakSignal) break;
                        if (e instanceof ContinueSignal) continue;
                        throw e;
                    }
                }
                break;
            }

            case 'Repita': {
                const rp = stmt as RepitaNode;
                let iters = 0;
                do {
                    if (++iters > MAX_LOOP_ITERATIONS) throw new PortugolError('Loop infinito detectado (excedeu 1.000.000 iterações)', rp.line);
                    if (this.cancelled) throw new UserCancelledError();
                    try {
                        const r = await this.executeBlock(rp.body, scope);
                        if (r instanceof ReturnSignal) return r;
                    } catch (e) {
                        if (e instanceof BreakSignal) break;
                        if (e instanceof ContinueSignal) continue;
                        throw e;
                    }
                } while (!this.isTruthy(this.evalExpr(rp.condition, scope)));
                break;
            }

            case 'Escolha': {
                const ch = stmt as EscolhaNode;
                const val = this.evalExpr(ch.expr, scope);
                let matched = false;
                for (const caso of ch.cases) {
                    if (caso.values.some(v => this.evalExpr(v, scope) === val)) {
                        matched = true;
                        const r = await this.executeBlock(caso.body, scope);
                        if (r instanceof ReturnSignal) return r;
                        break;
                    }
                }
                if (!matched && ch.otherwise) {
                    const r = await this.executeBlock(ch.otherwise, scope);
                    if (r instanceof ReturnSignal) return r;
                }
                break;
            }

            case 'Retorne':
                return new ReturnSignal(this.evalExpr((stmt as RetorneNode).value, scope));

            case 'Pare':
                throw new BreakSignal();

            case 'Continue':
                throw new ContinueSignal();

            case 'CallStmt': {
                const cs = stmt as CallStmtNode;
                await this.callFunction(cs.name, cs.args, scope, cs.line);
                break;
            }
        }
        return null;
    }

    // ─── Variáveis ────────────────────────────────────────────────────────────

    private declareVars(node: VarDeclNode, scope: Map<string, Variable>) {
        for (const v of node.vars) {
            scope.set(v.name.toLowerCase(), {
                name: v.name,
                type: node.varType,
                value: this.defaultValue(node.varType, v.sizes),
            });
        }
    }

    private defaultValue(type: string, sizes?: number[]): Value {
        if (sizes && sizes.length > 0) {
            const [first, ...rest] = sizes;
            return Array.from({ length: first }, () => this.defaultValue(type, rest.length > 0 ? rest : undefined));
        }
        switch (type) {
            case 'inteiro':  return 0;
            case 'real':     return 0.0;
            case 'logico':   return false;
            case 'caracter':
            case 'cadeia':
            case 'texto':    return '';
            default:         return null;
        }
    }

    private assign(node: AssignNode, scope: Map<string, Variable>) {
        const val = this.evalExpr(node.value, scope);
        const varEntry = this.lookupVar(node.target, scope, node.line);
        if (node.indices.length > 0) {
            this.assignIndexed(varEntry, node.indices, scope, val, node.line);
        } else {
            varEntry.value = this.coerce(val, varEntry.type);
        }
    }

    private assignIndexed(varEntry: Variable, indexExprs: Expression[], scope: Map<string, Variable>, val: Value, line: number) {
        let current: Value = varEntry.value;
        for (let d = 0; d < indexExprs.length - 1; d++) {
            const idx = Number(this.evalExpr(indexExprs[d], scope)) - 1;
            if (!Array.isArray(current)) throw new PortugolError('Variável não é um vetor/matriz', line);
            if (idx < 0 || idx >= current.length) throw new PortugolError(`Índice ${idx + 1} fora dos limites (tamanho ${current.length})`, line);
            current = current[idx];
        }
        const lastIdx = Number(this.evalExpr(indexExprs[indexExprs.length - 1], scope)) - 1;
        if (!Array.isArray(current)) throw new PortugolError('Variável não é um vetor/matriz', line);
        if (lastIdx < 0 || lastIdx >= current.length) throw new PortugolError(`Índice ${lastIdx + 1} fora dos limites (tamanho ${current.length})`, line);
        (current as Value[])[lastIdx] = this.coerce(val, varEntry.type);
    }

    private lookupVar(name: string, scope: Map<string, Variable>, line: number): Variable {
        const key = name.toLowerCase();
        if (scope.has(key)) return scope.get(key)!;
        for (let i = this.callStack.length - 1; i >= 0; i--) {
            if (this.callStack[i].has(key)) return this.callStack[i].get(key)!;
        }
        if (this.variables.has(key)) return this.variables.get(key)!;
        throw new PortugolError(`Variável '${name}' não declarada`, line);
    }

    private coerce(val: Value, type: string): Value {
        switch (type) {
            case 'inteiro': return Math.trunc(Number(val));
            case 'real':    return Number(val);
            case 'logico': {
                if (typeof val === 'string') {
                    const l = val.trim().toLowerCase();
                    if (l === 'verdadeiro' || l === 'true'  || l === 's' || l === 'sim') return true;
                    if (l === 'falso'      || l === 'false' || l === 'n' || l === 'nao' || l === 'não') return false;
                    return Boolean(Number(val));
                }
                return Boolean(val);
            }
            case 'caracter':
            case 'cadeia':
            case 'texto': return String(val ?? '');
            default: return val;
        }
    }

    private parseInput(input: string, type: string): Value {
        const s = input.trim();
        switch (type) {
            case 'inteiro': { const n = parseInt(s, 10);           return isNaN(n) ? 0 : n; }
            case 'real':    { const n = parseFloat(s.replace(',', '.')); return isNaN(n) ? 0.0 : n; }
            case 'logico': {
                const l = s.toLowerCase();
                return l === 'verdadeiro' || l === 'true' || l === 's' || l === 'sim' || l === '1';
            }
            default: return s;
        }
    }

    private typeHint(type: string): string {
        switch (type) {
            case 'inteiro':  return 'ex: 42';
            case 'real':     return 'ex: 3.14';
            case 'logico':   return 'verdadeiro ou falso';
            case 'caracter': return 'um caractere';
            default:         return 'texto';
        }
    }

    // ─── Expressões ───────────────────────────────────────────────────────────

    private evalExpr(expr: Expression, scope: Map<string, Variable>): Value {
        switch (expr.type) {
            case 'Literal': return (expr as LiteralExpr).value;

            case 'Var': {
                const ve = expr as VarExpr;
                const v = this.lookupVar(ve.name, scope, ve.line);
                if (ve.indices.length > 0) {
                    return this.readIndexed(v.value, ve.indices, scope, ve.line);
                }
                return v.value;
            }

            case 'BinOp': {
                const b = expr as BinOpExpr;
                const left  = this.evalExpr(b.left,  scope);
                const right = this.evalExpr(b.right, scope);
                return this.applyBinOp(b.op, left, right, b.line);
            }

            case 'UnOp': {
                const u = expr as UnOpExpr;
                const val = this.evalExpr(u.operand, scope);
                if (u.op === 'nao' || u.op === '!') return !this.isTruthy(val);
                if (u.op === '-') return -Number(val);
                return val;
            }

            case 'Call': {
                const c = expr as CallExpr;
                return this.callFunctionSync(c.name, c.args, scope, c.line);
            }

            default: return null;
        }
    }

    private readIndexed(value: Value, indexExprs: Expression[], scope: Map<string, Variable>, line: number): Value {
        let current = value;
        for (const idxExpr of indexExprs) {
            const idx = Number(this.evalExpr(idxExpr, scope)) - 1;
            if (!Array.isArray(current)) throw new PortugolError('Variável não é um vetor/matriz', line);
            if (idx < 0 || idx >= current.length) throw new PortugolError(`Índice ${idx + 1} fora dos limites (tamanho ${current.length})`, line);
            current = current[idx];
        }
        return current;
    }

    private applyBinOp(op: string, left: Value, right: Value, line: number): Value {
        switch (op) {
            case '+':
                if (typeof left === 'string' || typeof right === 'string') return String(left ?? '') + String(right ?? '');
                return Number(left) + Number(right);
            case '-':   return Number(left) - Number(right);
            case '*':   return Number(left) * Number(right);
            case '/': {
                if (Number(right) === 0) throw new PortugolError('Divisão por zero', line);
                return Number(left) / Number(right);
            }
            case 'div': {
                if (Number(right) === 0) throw new PortugolError('Divisão por zero (div)', line);
                return Math.trunc(Number(left) / Number(right));
            }
            case 'mod':
            case '%':   return Number(left) % Number(right);
            case '^':
            case '**':  return Math.pow(Number(left), Number(right));
            case '=':
            case '==':  return left === right;
            case '<>':
            case '!=':  return left !== right;
            case '<':   return Number(left) <  Number(right);
            case '>':   return Number(left) >  Number(right);
            case '<=':  return Number(left) <= Number(right);
            case '>=':  return Number(left) >= Number(right);
            case 'e':
            case '&&':  return this.isTruthy(left) && this.isTruthy(right);
            case 'ou':
            case '||':  return this.isTruthy(left) || this.isTruthy(right);
            case 'xou': return this.isTruthy(left) !== this.isTruthy(right);
            default: throw new PortugolError(`Operador desconhecido: ${op}`, line);
        }
    }

    // ─── Chamadas de função ───────────────────────────────────────────────────

    // Versão síncrona usada em contexto de expressão (apenas built-ins + funções sem leia)
    private callFunctionSync(name: string, args: Expression[], scope: Map<string, Variable>, line: number): Value {
        const argVals = args.map(a => this.evalExpr(a, scope));
        const key = name.toLowerCase();
        const builtin = this.builtinCall(key, argVals, line);
        if (builtin !== undefined) return builtin;

        const fn = this.functions.get(key);
        if (!fn) throw new PortugolError(`Função '${name}' não encontrada`, line);
        if (this.callStack.length >= MAX_CALL_DEPTH) throw new PortugolError('Limite de recursão atingido (500 níveis)', line);

        const fnScope = this.buildFnScope(fn, argVals);
        this.callStack.push(fnScope);
        let result: Value = null;
        try {
            for (const st of fn.body) {
                const r = this.executeStatementSync(st, fnScope);
                if (r instanceof ReturnSignal) { result = r.value; break; }
                if (r instanceof BreakSignal || r instanceof ContinueSignal) break;
            }
        } finally {
            this.callStack.pop();
        }
        return result;
    }

    // Versão assíncrona usada em CallStmt (suporta leia dentro de função)
    async callFunction(name: string, args: Expression[], scope: Map<string, Variable>, line: number): Promise<Value> {
        const argVals = args.map(a => this.evalExpr(a, scope));
        const key = name.toLowerCase();
        const builtin = this.builtinCall(key, argVals, line);
        if (builtin !== undefined) return builtin;

        const fn = this.functions.get(key);
        if (!fn) throw new PortugolError(`Função ou procedimento '${name}' não encontrado`, line);
        if (this.callStack.length >= MAX_CALL_DEPTH) throw new PortugolError('Limite de recursão atingido (500 níveis)', line);

        const fnScope = this.buildFnScope(fn, argVals);
        this.callStack.push(fnScope);
        let result: Value = null;
        try {
            result = await this.executeBlock(fn.body, fnScope) ?? null;
        } finally {
            this.callStack.pop();
        }
        return result;
    }

    private buildFnScope(fn: FunctionDef, argVals: Value[]): Map<string, Variable> {
        const fnScope = new Map<string, Variable>();
        fn.params.forEach((p, i) => {
            fnScope.set(p.name.toLowerCase(), {
                name: p.name,
                type: p.type,
                value: argVals[i] ?? this.defaultValue(p.type),
            });
        });
        for (const decl of fn.vars) this.declareVars(decl, fnScope);
        return fnScope;
    }

    // Execução síncrona mínima para funções chamadas em expressões
    private executeStatementSync(stmt: Statement, scope: Map<string, Variable>): Value | ReturnSignal | BreakSignal | ContinueSignal {
        switch (stmt.type) {
            case 'VarDecl':  this.declareVars(stmt as VarDeclNode, scope); break;
            case 'Assign':   this.assign(stmt as AssignNode, scope); break;
            case 'Escreva':
            case 'Escreval': {
                const vals = (stmt as EscrevaNode).args.map(a => this.evalExpr(a, scope));
                const text = vals.map(v => this.valueToString(v)).join('');
                stmt.type === 'Escreval' ? this.output.appendLine(text) : this.output.append(text);
                break;
            }
            case 'Leia':
                this.output.appendLine('[Aviso] leia() dentro de função usada em expressão não é suportado — mova a chamada para uma instrução separada');
                break;
            case 'Se': {
                const s = stmt as SeNode;
                const branch = this.isTruthy(this.evalExpr(s.condition, scope)) ? s.then : (s.else ?? []);
                for (const st of branch) {
                    const r = this.executeStatementSync(st, scope);
                    if (r instanceof ReturnSignal || r instanceof BreakSignal || r instanceof ContinueSignal) return r;
                }
                break;
            }
            case 'Para': {
                const p = stmt as ParaNode;
                const from = Number(this.evalExpr(p.from, scope));
                const to   = Number(this.evalExpr(p.to,   scope));
                const step = p.step ? Number(this.evalExpr(p.step, scope)) : (from <= to ? 1 : -1);
                const loopScope = new Map(scope);
                loopScope.set(p.var.toLowerCase(), { name: p.var, type: 'inteiro', value: from });
                let iters = 0;
                for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
                    if (++iters > MAX_LOOP_ITERATIONS) throw new PortugolError('Loop infinito detectado', p.line);
                    loopScope.get(p.var.toLowerCase())!.value = i;
                    let broke = false;
                    for (const st of p.body) {
                        const r = this.executeStatementSync(st, loopScope);
                        if (r instanceof ReturnSignal) return r;
                        if (r instanceof BreakSignal) { broke = true; break; }
                        if (r instanceof ContinueSignal) break;
                    }
                    if (broke) break;
                }
                for (const [k, v] of loopScope) {
                    if (k !== p.var.toLowerCase() && scope.has(k)) scope.set(k, v);
                }
                break;
            }
            case 'Enquanto': {
                const w = stmt as EnquantoNode;
                let iters = 0;
                while (this.isTruthy(this.evalExpr(w.condition, scope))) {
                    if (++iters > MAX_LOOP_ITERATIONS) throw new PortugolError('Loop infinito detectado', w.line);
                    let broke = false;
                    for (const st of w.body) {
                        const r = this.executeStatementSync(st, scope);
                        if (r instanceof ReturnSignal) return r;
                        if (r instanceof BreakSignal) { broke = true; break; }
                        if (r instanceof ContinueSignal) break;
                    }
                    if (broke) break;
                }
                break;
            }
            case 'Retorne': return new ReturnSignal(this.evalExpr((stmt as RetorneNode).value, scope));
            case 'Pare':    throw new BreakSignal();
            case 'Continue': throw new ContinueSignal();
            case 'CallStmt': {
                const cs = stmt as CallStmtNode;
                this.callFunctionSync(cs.name, cs.args, scope, cs.line);
                break;
            }
        }
        return null;
    }

    // ─── Built-ins ────────────────────────────────────────────────────────────

    private builtinCall(key: string, argVals: Value[], line: number): Value | undefined {
        switch (key) {
            // Matemática
            case 'abs':       return Math.abs(Number(argVals[0]));
            case 'arredonde': return Math.round(Number(argVals[0]));
            case 'teto':      return Math.ceil(Number(argVals[0]));
            case 'piso':      return Math.floor(Number(argVals[0]));
            case 'raiz':      return Math.sqrt(Number(argVals[0]));
            case 'potencia':  return Math.pow(Number(argVals[0]), Number(argVals[1]));
            case 'sen':       return Math.sin(Number(argVals[0]));
            case 'cos':       return Math.cos(Number(argVals[0]));
            case 'tan':       return Math.tan(Number(argVals[0]));
            case 'arcsen':    return Math.asin(Number(argVals[0]));
            case 'arccos':    return Math.acos(Number(argVals[0]));
            case 'arctan':    return Math.atan(Number(argVals[0]));
            case 'exp':       return Math.exp(Number(argVals[0]));
            case 'log':       return Math.log(Number(argVals[0]));   // logaritmo natural (ln)
            case 'log2':      return Math.log2(Number(argVals[0]));
            case 'log10':     return Math.log10(Number(argVals[0]));
            case 'int':       return Math.trunc(Number(argVals[0]));
            case 'pi':        return Math.PI;
            case 'aleatorio': {
                const min = argVals.length >= 2 ? Number(argVals[0]) : 0;
                const max = argVals.length >= 2 ? Number(argVals[1]) : Number(argVals[0] ?? 1);
                return Math.floor(Math.random() * (max - min + 1)) + min;
            }
            case 'resto':
            case 'modulo':    return Number(argVals[0]) % Number(argVals[1]);

            // Cadeia
            case 'comprimento':
            case 'compr':     return String(argVals[0] ?? '').length;
            case 'maiusculo':
            case 'maiuscula': return String(argVals[0] ?? '').toUpperCase();
            case 'minusculo':
            case 'minuscula': return String(argVals[0] ?? '').toLowerCase();
            case 'inverte': {
                return String(argVals[0] ?? '').split('').reverse().join('');
            }
            case 'copia':
            case 'subcadeia': {
                const s = String(argVals[0] ?? '');
                const start = Number(argVals[1]) - 1;
                const len   = Number(argVals[2]);
                return s.substr(start, len);
            }
            case 'pos': {
                const haystack = String(argVals[1] ?? '');
                const needle   = String(argVals[0] ?? '');
                const idx = haystack.indexOf(needle);
                return idx === -1 ? 0 : idx + 1;
            }
            case 'substitua': {
                const s    = String(argVals[0] ?? '');
                const from = String(argVals[1] ?? '');
                const to   = String(argVals[2] ?? '');
                return s.split(from).join(to);
            }
            case 'apaga':
            case 'remova': {
                const s     = String(argVals[0] ?? '');
                const start = Number(argVals[1]) - 1;
                const len   = Number(argVals[2]);
                return s.slice(0, start) + s.slice(start + len);
            }
            case 'insere': {
                const s   = String(argVals[0] ?? '');
                const ins = String(argVals[1] ?? '');
                const pos = Number(argVals[2]) - 1;
                return s.slice(0, pos) + ins + s.slice(pos);
            }
            case 'espacos': {
                return ' '.repeat(Math.max(0, Number(argVals[0])));
            }
            case 'numerico':
            case 'converteinteiro': return Number(argVals[0]);
            case 'caracter':
            case 'chr':       return String.fromCharCode(Number(argVals[0]));
            case 'asc':
            case 'ord':       return String(argVals[0] ?? ' ').charCodeAt(0);

            // I/O
            case 'escreva': {
                const text = argVals.map(v => this.valueToString(v)).join('');
                this.output.append(text);
                return null;
            }
            case 'escreval': {
                const text = argVals.map(v => this.valueToString(v)).join('');
                this.output.appendLine(text);
                return null;
            }
            case 'limpa':
                this.output.clear();
                return null;
            case 'pausa':
                // sem suporte real a pausa — apenas informa
                this.output.appendLine('[pausa] Pressione Enter no terminal para continuar...');
                return null;

            // Verificação de tipo
            case 'eh_numero':  return typeof argVals[0] === 'number';
            case 'eh_cadeia':  return typeof argVals[0] === 'string';
            case 'eh_logico':  return typeof argVals[0] === 'boolean';

            default: return undefined;
        }
    }

    // ─── Utilitários ──────────────────────────────────────────────────────────

    private isTruthy(val: Value): boolean {
        return val !== null && val !== false && val !== 0 && val !== '';
    }

    private valueToString(val: Value): string {
        if (val === null)  return 'nulo';
        if (val === true)  return 'VERDADEIRO';
        if (val === false) return 'FALSO';
        if (Array.isArray(val)) return '[' + val.map(v => this.valueToString(v)).join(', ') + ']';
        return String(val);
    }
}

// ─── Sinais de controle de fluxo ────────────────────────────────────────────

class ReturnSignal   { constructor(public value: Value) {} }
class BreakSignal    {}
class ContinueSignal {}
class UserCancelledError extends Error {}

class PortugolError extends Error {
    constructor(message: string, public line: number) { super(message); }
}

// ─── AST ────────────────────────────────────────────────────────────────────

interface ProgramNode  { functions: FunctionDef[]; body: Statement[] }

interface FunctionDef {
    name: string;
    params: { name: string; type: string }[];
    returnType: string;
    vars: VarDeclNode[];
    body: Statement[];
}

interface Statement    { type: string; line: number }
interface VarDeclNode  extends Statement { type: 'VarDecl'; varType: string; vars: { name: string; sizes?: number[] }[] }
interface AssignNode   extends Statement { type: 'Assign'; target: string; indices: Expression[]; value: Expression }
interface EscrevaNode  extends Statement { type: 'Escreva' | 'Escreval'; args: Expression[] }
interface LeiaNode     extends Statement { type: 'Leia'; targets: { name: string; indices: Expression[] }[] }
interface SeNode       extends Statement { type: 'Se'; condition: Expression; then: Statement[]; else?: Statement[] }
interface ParaNode     extends Statement { type: 'Para'; var: string; from: Expression; to: Expression; step?: Expression; body: Statement[] }
interface EnquantoNode extends Statement { type: 'Enquanto'; condition: Expression; body: Statement[] }
interface RepitaNode   extends Statement { type: 'Repita'; body: Statement[]; condition: Expression }
interface EscolhaNode  extends Statement { type: 'Escolha'; expr: Expression; cases: { values: Expression[]; body: Statement[] }[]; otherwise?: Statement[] }
interface RetorneNode  extends Statement { type: 'Retorne'; value: Expression }
interface CallStmtNode extends Statement { type: 'CallStmt'; name: string; args: Expression[] }

interface Expression   { type: string; line: number }
interface LiteralExpr  extends Expression { type: 'Literal'; value: Value }
interface VarExpr      extends Expression { type: 'Var'; name: string; indices: Expression[] }
interface BinOpExpr    extends Expression { type: 'BinOp'; op: string; left: Expression; right: Expression }
interface UnOpExpr     extends Expression { type: 'UnOp'; op: string; operand: Expression }
interface CallExpr     extends Expression { type: 'Call'; name: string; args: Expression[] }

// ─── Tokenizer ──────────────────────────────────────────────────────────────

interface Token { type: string; value: string; line: number }

const KEYWORDS = new Set([
    'algoritmo','fimalgoritmo','programa','var','inicio','fim',
    'se','senao','entao','fimse',
    'para','de','ate','passo','fimpara',
    'enquanto','faca','fimenquanto',
    'repita',
    'escolha','caso','outrocaso','fimescolha',
    'funcao','fimfuncao','procedimento','fimprocedimento',
    'retorne','pare','continue','leia','escreva','escreval',
    'e','ou','nao','xou',
    'div','mod',
    'inteiro','real','logico','caracter','cadeia','texto','vetor','booleano',
    'verdadeiro','falso','nulo',
    'const','tipo',
]);

function tokenize(code: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    let line = 1;

    while (i < code.length) {
        if (code[i] === '\n') { line++; i++; continue; }
        if (/\s/.test(code[i])) { i++; continue; }

        // Comentário de linha
        if (code[i] === '/' && code[i+1] === '/') {
            while (i < code.length && code[i] !== '\n') i++;
            continue;
        }

        // Comentário de bloco
        if (code[i] === '/' && code[i+1] === '*') {
            const startLine = line;
            i += 2;
            while (i < code.length && !(code[i] === '*' && code[i+1] === '/')) {
                if (code[i] === '\n') line++;
                i++;
            }
            if (i >= code.length) throw new PortugolError('Comentário de bloco não fechado (falta */)', startLine);
            i += 2;
            continue;
        }

        // String
        if (code[i] === '"') {
            const startLine = line;
            let s = '';
            i++;
            while (i < code.length && code[i] !== '"') {
                if (code[i] === '\n') { line++; }
                if (code[i] === '\\') { i++; s += code[i] || ''; }
                else s += code[i];
                i++;
            }
            if (i >= code.length) throw new PortugolError('String não fechada (falta ")', startLine);
            i++;
            tokens.push({ type: 'STRING', value: s, line: startLine });
            continue;
        }

        // Caractere (aspas simples)
        if (code[i] === "'") {
            const startLine = line;
            i++;
            let ch = '';
            if (code[i] === '\\') { i++; ch = code[i] || ''; i++; }
            else if (code[i] !== "'") { ch = code[i]; i++; }
            if (code[i] === "'") i++;
            tokens.push({ type: 'CHAR', value: ch, line: startLine });
            continue;
        }

        // Número
        if (/[0-9]/.test(code[i])) {
            let s = '';
            while (i < code.length && /[0-9]/.test(code[i])) s += code[i++];
            if (i < code.length && code[i] === '.' && /[0-9]/.test(code[i+1])) {
                s += code[i++];
                while (i < code.length && /[0-9]/.test(code[i])) s += code[i++];
                tokens.push({ type: 'REAL', value: s, line });
            } else {
                tokens.push({ type: 'INT', value: s, line });
            }
            continue;
        }

        // Identificador ou palavra-chave
        if (/[a-zA-ZÀ-ÿ_]/.test(code[i])) {
            let s = '';
            while (i < code.length && /[a-zA-ZÀ-ÿ0-9_]/.test(code[i])) s += code[i++];
            const lower = s.toLowerCase();
            tokens.push({ type: KEYWORDS.has(lower) ? 'KW' : 'ID', value: s, line });
            continue;
        }

        // Operadores de dois caracteres (ordem: mais longos primeiro)
        const two = code.slice(i, i + 2);
        if (['<-', ':=', '<>', '<=', '>=', '..'].includes(two)) {
            tokens.push({ type: 'OP', value: two, line });
            i += 2;
            continue;
        }

        // Operadores e pontuação de um caractere
        const one = code[i];
        if ('+-*/^%=<>()[],.:{}'.includes(one)) {
            tokens.push({ type: 'OP', value: one, line });
            i++;
            continue;
        }

        // Caractere inválido — reportar erro
        throw new PortugolError(`Caractere inválido: '${code[i]}'`, line);
    }

    tokens.push({ type: 'EOF', value: '', line });
    return tokens;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

class Parser {
    private pos = 0;
    constructor(private tokens: Token[]) {}

    private peek():    Token { return this.tokens[this.pos]; }
    private consume(): Token { return this.tokens[this.pos++]; }

    private match(value: string): boolean {
        if (this.peek().value.toLowerCase() === value.toLowerCase()) { this.consume(); return true; }
        return false;
    }
    private check(value: string): boolean {
        return this.peek().value.toLowerCase() === value.toLowerCase();
    }
    private checkAny(...values: string[]): boolean {
        return values.some(v => this.check(v));
    }
    private checkType(type: string): boolean {
        return this.peek().type === type;
    }

    parse(): ProgramNode {
        if (this.checkAny('algoritmo', 'programa')) {
            this.consume();
            if (this.checkType('STRING') || this.checkType('ID')) this.consume();
        }

        const functions: FunctionDef[] = [];
        const vars: VarDeclNode[] = [];

        while (this.check('var')) {
            this.consume();
            while (!this.checkAny('inicio', 'funcao', 'procedimento') && !this.checkType('EOF')) {
                const decl = this.parseVarDecl();
                if (decl) vars.push(decl);
            }
        }

        while (this.checkAny('funcao', 'procedimento')) {
            functions.push(this.parseFunctionDef());
        }

        let body: Statement[] = [...vars];
        if (this.check('inicio')) {
            this.consume();
            body = [...vars, ...this.parseBlock(['fimalgoritmo', 'fim', 'EOF'])];
        }

        return { functions, body };
    }

    private parseFunctionDef(): FunctionDef {
        const isProc = this.peek().value.toLowerCase() === 'procedimento';
        this.consume();
        const name = this.consume().value;
        const params: { name: string; type: string }[] = [];

        if (this.check('(')) {
            this.consume();
            while (!this.check(')') && !this.checkType('EOF')) {
                const paramName = this.consume().value;
                this.match(':');
                const paramType = this.consume().value.toLowerCase();
                params.push({ name: paramName, type: paramType });
                this.match(',');
            }
            this.match(')');
        }

        let returnType = 'void';
        if (!isProc && this.check(':')) {
            this.consume();
            returnType = this.consume().value.toLowerCase();
        }

        const fnVars: VarDeclNode[] = [];
        if (this.check('var')) {
            this.consume();
            while (!this.checkAny('inicio', 'fimfuncao', 'fimprocedimento') && !this.checkType('EOF')) {
                const d = this.parseVarDecl();
                if (d) fnVars.push(d);
            }
        }

        this.match('inicio');
        const endKw = isProc ? ['fimprocedimento', 'fim'] : ['fimfuncao', 'fim'];
        const body = this.parseBlock(endKw);
        return { name, params, returnType, vars: fnVars, body };
    }

    private parseVarDecl(): VarDeclNode | null {
        const line = this.peek().line;
        if (this.checkType('EOF') || this.checkAny('inicio', 'funcao', 'procedimento')) return null;

        const names: { name: string; sizes?: number[] }[] = [];
        names.push({ name: this.consume().value });
        while (this.check(',')) { this.consume(); names.push({ name: this.consume().value }); }
        this.match(':');

        let varType = this.consume().value.toLowerCase();

        if (varType === 'vetor') {
            this.match('[');
            const sizes: number[] = [];
            while (!this.check(']') && !this.checkType('EOF')) {
                const from = Number(this.consume().value);
                this.match('..');
                const to   = Number(this.consume().value);
                sizes.push(to - from + 1);
                this.match(',');
            }
            this.match(']');
            this.match('de');
            varType = this.consume().value.toLowerCase();
            for (const n of names) n.sizes = sizes;
        }

        return { type: 'VarDecl', varType, vars: names, line };
    }

    private parseBlock(endTokens: string[]): Statement[] {
        const stmts: Statement[] = [];
        while (!this.checkAny(...endTokens) && !this.checkType('EOF')) {
            const stmt = this.parseStatement();
            if (stmt) stmts.push(stmt);
        }
        if (!this.checkType('EOF')) this.consume(); // consome token de fim
        return stmts;
    }

    private parseStatement(): Statement | null {
        const t    = this.peek();
        const line = t.line;

        if (this.check('var')) {
            this.consume();
            return this.parseVarDecl();
        }

        if (this.checkAny('escreva', 'escreval')) {
            const kind = this.consume().value.toLowerCase();
            const args: Expression[] = [];
            if (this.check('(')) {
                this.consume();
                while (!this.check(')') && !this.checkType('EOF')) {
                    args.push(this.parseExpr());
                    this.match(',');
                }
                this.match(')');
            } else {
                args.push(this.parseExpr());
            }
            const stmtType = kind === 'escreval' ? 'Escreval' : 'Escreva';
            return { type: stmtType, args, line } as unknown as EscrevaNode;
        }

        if (this.check('leia')) {
            this.consume();
            const targets: { name: string; indices: Expression[] }[] = [];
            this.match('(');
            while (!this.check(')') && !this.checkType('EOF')) {
                const varName = this.consume().value;
                const indices: Expression[] = [];
                if (this.check('[')) {
                    this.consume();
                    indices.push(this.parseExpr());
                    while (this.check(',')) { this.consume(); indices.push(this.parseExpr()); }
                    this.match(']');
                }
                targets.push({ name: varName, indices });
                this.match(',');
            }
            this.match(')');
            return { type: 'Leia', targets, line } as LeiaNode;
        }

        if (this.check('se')) {
            this.consume();
            const condition = this.parseExpr();
            this.match('entao');
            const then = this.parseBlock(['senao', 'fimse']);
            let elseBlock: Statement[] | undefined;
            if (this.tokens[this.pos - 1]?.value.toLowerCase() === 'senao') {
                elseBlock = this.parseBlock(['fimse']);
            }
            return { type: 'Se', condition, then, else: elseBlock, line } as SeNode;
        }

        if (this.check('para')) {
            this.consume();
            const varName = this.consume().value;
            this.match('de');
            const from = this.parseExpr();
            this.match('ate');
            const to = this.parseExpr();
            let step: Expression | undefined;
            if (this.match('passo')) step = this.parseExpr();
            this.match('faca');
            const body = this.parseBlock(['fimpara']);
            return { type: 'Para', var: varName, from, to, step, body, line } as ParaNode;
        }

        if (this.check('enquanto')) {
            this.consume();
            const condition = this.parseExpr();
            this.match('faca');
            const body = this.parseBlock(['fimenquanto']);
            return { type: 'Enquanto', condition, body, line } as EnquantoNode;
        }

        if (this.check('repita')) {
            this.consume();
            const body = this.parseBlock(['ate']);
            const condition = this.parseExpr();
            return { type: 'Repita', body, condition, line } as RepitaNode;
        }

        if (this.check('escolha')) {
            this.consume();
            const expr = this.parseExpr();
            const cases: { values: Expression[]; body: Statement[] }[] = [];
            let otherwise: Statement[] | undefined;
            while (!this.check('fimescolha') && !this.checkType('EOF')) {
                if (this.check('caso')) {
                    this.consume();
                    const values: Expression[] = [this.parseExpr()];
                    while (this.check(',')) { this.consume(); values.push(this.parseExpr()); }
                    this.match(':');
                    const body = this.parseBlock(['caso', 'outrocaso', 'fimescolha']);
                    this.pos--; // devolve o token que encerrou o bloco
                    cases.push({ values, body });
                } else if (this.check('outrocaso')) {
                    this.consume();
                    this.match(':');
                    otherwise = this.parseBlock(['fimescolha']);
                    this.pos--;
                    break;
                } else {
                    this.consume();
                }
            }
            this.match('fimescolha');
            return { type: 'Escolha', expr, cases, otherwise, line } as EscolhaNode;
        }

        if (this.check('retorne')) {
            this.consume();
            const value = this.parseExpr();
            return { type: 'Retorne', value, line } as RetorneNode;
        }

        if (this.check('pare'))     { this.consume(); return { type: 'Pare',     line } as Statement; }
        if (this.check('continue')) { this.consume(); return { type: 'Continue', line } as Statement; }

        // Atribuição ou chamada de procedimento
        if (t.type === 'ID') {
            const name = this.consume().value;

            // Índices para atribuição: a[1] ou m[i, j]
            const indices: Expression[] = [];
            if (this.check('[')) {
                this.consume();
                indices.push(this.parseExpr());
                while (this.check(',')) { this.consume(); indices.push(this.parseExpr()); }
                this.match(']');
            }

            if (this.checkAny('<-', ':=') || (indices.length === 0 && this.check('='))) {
                this.consume();
                const value = this.parseExpr();
                return { type: 'Assign', target: name, indices, value, line } as AssignNode;
            }

            if (this.check('(')) {
                this.consume();
                const args: Expression[] = [];
                while (!this.check(')') && !this.checkType('EOF')) {
                    args.push(this.parseExpr());
                    this.match(',');
                }
                this.match(')');
                return { type: 'CallStmt', name, args, line } as CallStmtNode;
            }

            return null;
        }

        this.consume(); // ignora token desconhecido
        return null;
    }

    // ─── Expressões (precedência crescente) ──────────────────────────────────

    private parseExpr():       Expression { return this.parseOr(); }

    private parseOr(): Expression {
        let left = this.parseAnd();
        while (this.checkAny('ou', 'xou')) {
            const op = this.consume().value.toLowerCase();
            left = { type: 'BinOp', op, left, right: this.parseAnd(), line: left.line } as BinOpExpr;
        }
        return left;
    }

    private parseAnd(): Expression {
        let left = this.parseNot();
        while (this.check('e')) {
            const op = this.consume().value.toLowerCase();
            left = { type: 'BinOp', op, left, right: this.parseNot(), line: left.line } as BinOpExpr;
        }
        return left;
    }

    private parseNot(): Expression {
        if (this.checkAny('nao', '!')) {
            const line = this.peek().line;
            this.consume();
            return { type: 'UnOp', op: 'nao', operand: this.parseNot(), line } as UnOpExpr;
        }
        return this.parseComparison();
    }

    private parseComparison(): Expression {
        let left = this.parseAdd();
        while (['<>', '<=', '>=', '<', '>', '='].includes(this.peek().value)) {
            const op = this.consume().value;
            left = { type: 'BinOp', op, left, right: this.parseAdd(), line: left.line } as BinOpExpr;
        }
        return left;
    }

    private parseAdd(): Expression {
        let left = this.parseMul();
        while (['+', '-'].includes(this.peek().value)) {
            const op = this.consume().value;
            left = { type: 'BinOp', op, left, right: this.parseMul(), line: left.line } as BinOpExpr;
        }
        return left;
    }

    private parseMul(): Expression {
        let left = this.parseUnary();
        while (['*', '/', '^'].includes(this.peek().value) || this.checkAny('div', 'mod')) {
            const op = this.consume().value.toLowerCase();
            left = { type: 'BinOp', op, left, right: this.parseUnary(), line: left.line } as BinOpExpr;
        }
        return left;
    }

    private parseUnary(): Expression {
        if (this.peek().value === '-') {
            const line = this.peek().line;
            this.consume();
            return { type: 'UnOp', op: '-', operand: this.parsePrimary(), line } as UnOpExpr;
        }
        return this.parsePrimary();
    }

    private parsePrimary(): Expression {
        const t    = this.peek();
        const line = t.line;

        if (t.type === 'INT')    { this.consume(); return { type: 'Literal', value: parseInt(t.value, 10), line } as LiteralExpr; }
        if (t.type === 'REAL')   { this.consume(); return { type: 'Literal', value: parseFloat(t.value),   line } as LiteralExpr; }
        if (t.type === 'STRING') { this.consume(); return { type: 'Literal', value: t.value, line } as LiteralExpr; }
        if (t.type === 'CHAR')   { this.consume(); return { type: 'Literal', value: t.value, line } as LiteralExpr; }

        if (this.check('verdadeiro')) { this.consume(); return { type: 'Literal', value: true,  line } as LiteralExpr; }
        if (this.check('falso'))      { this.consume(); return { type: 'Literal', value: false, line } as LiteralExpr; }
        if (this.check('nulo'))       { this.consume(); return { type: 'Literal', value: null,  line } as LiteralExpr; }

        if (t.value === '(') {
            this.consume();
            const expr = this.parseExpr();
            this.match(')');
            return expr;
        }

        if (t.type === 'ID' || t.type === 'KW') {
            const name = this.consume().value;

            // Chamada de função em expressão
            if (this.check('(')) {
                this.consume();
                const args: Expression[] = [];
                while (!this.check(')') && !this.checkType('EOF')) {
                    args.push(this.parseExpr());
                    this.match(',');
                }
                this.match(')');
                return { type: 'Call', name, args, line } as CallExpr;
            }

            // Acesso a vetor/matriz: a[i] ou m[i, j]
            const indices: Expression[] = [];
            if (this.check('[')) {
                this.consume();
                indices.push(this.parseExpr());
                while (this.check(',')) { this.consume(); indices.push(this.parseExpr()); }
                this.match(']');
            }
            return { type: 'Var', name, indices, line } as VarExpr;
        }

        this.consume();
        return { type: 'Literal', value: null, line } as LiteralExpr;
    }
}

function parse(tokens: Token[]): ProgramNode {
    return new Parser(tokens).parse();
}
