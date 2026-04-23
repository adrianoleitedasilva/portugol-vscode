# Portugol VSCode

Extensão para o Visual Studio Code que adiciona suporte completo à linguagem **Portugol** diretamente no editor — sem precisar instalar o Portugol Studio.

## Funcionalidades

### Syntax Highlighting
Colorização completa para arquivos `.por` e `.portugol`, incluindo palavras-chave, tipos, funções embutidas, strings, comentários e operadores.

### Execução de Programas
Execute seus programas Portugol sem sair do VSCode:

- Pressione **F5** para executar o programa ativo
- Pressione **Shift+F5** para parar a execução
- Use o botão **▶** na barra de título do editor
- Clique com o botão direito e escolha **Portugol: Executar Programa**

A saída aparece no painel **Portugol** integrado ao VSCode.

### Entrada Interativa (`leia`)
O comando `leia()` abre uma caixa de entrada nativa do VSCode. O valor digitado é convertido automaticamente para o tipo da variável (`inteiro`, `real`, `logico`, `cadeia`). Pressionar **ESC** cancela a execução.

### Snippets
Digite o prefixo e pressione `Tab` para expandir:

| Prefixo | Descrição |
|---------|-----------|
| `algoritmo` | Estrutura básica do algoritmo |
| `helloworld` | Programa Olá, Mundo! |
| `se` | Condicional simples |
| `sesenao` | Condicional com senão |
| `para` | Laço para |
| `parapasso` | Laço para com passo |
| `enquanto` | Laço enquanto |
| `repita` | Laço repita-até |
| `escolha` | Estrutura escolha-caso |
| `funcao` | Declaração de função |
| `procedimento` | Declaração de procedimento |
| `leia` | Leitura de variável |
| `escreva` | Escrita sem nova linha |
| `escreval` | Escrita com nova linha |
| `vetor` | Declaração de vetor |
| `matriz` | Declaração de matriz |
| `var_inteiro` | Variável inteira |
| `var_real` | Variável real |
| `var_cadeia` | Variável cadeia |
| `var_logico` | Variável lógica |

### Funções Embutidas Suportadas

**Matemática:** `abs`, `arredonde`, `teto`, `piso`, `raiz`, `potencia`, `sen`, `cos`, `tan`, `arcsen`, `arccos`, `arctan`, `exp`, `log`, `log2`, `log10`, `int`, `pi`, `aleatorio`, `resto`, `modulo`

**Cadeia:** `comprimento`, `maiusculo`, `minusculo`, `inverte`, `copia`, `subcadeia`, `pos`, `substitua`, `apaga`, `insere`, `espacos`, `numerico`, `caracter`, `asc`, `ord`

**I/O:** `escreva`, `escreval`, `leia`, `limpa`

**Verificação de tipo:** `eh_numero`, `eh_cadeia`, `eh_logico`

---

## Uso Rápido

1. Crie um arquivo com extensão `.por` ou `.portugol`
2. Ou use o comando **Portugol: Novo Arquivo** (`Ctrl+Shift+P`)
3. Escreva seu código e pressione **F5** para executar

```portugol
algoritmo "OlaMundo"
var
   nome : cadeia
inicio
   escreva("Qual é o seu nome? ")
   leia(nome)
   escreval("Olá, " + nome + "!")
fimalgoritmo
```

---

## Configurações

Acesse em **Arquivo → Preferências → Configurações** e pesquise por `Portugol`:

| Configuração | Padrão | Descrição |
|---|---|---|
| `portugol.interpreterPath` | `""` | Caminho para o executável do Portugol Studio CLI. Deixe vazio para usar o interpretador embutido. |
| `portugol.showOutputOnRun` | `true` | Mostrar o painel de saída automaticamente ao executar. |
| `portugol.clearOutputOnRun` | `true` | Limpar a saída anterior ao executar novamente. |

### Usando o Portugol Studio como interpretador externo

Se quiser usar o Portugol Studio CLI como backend (para suporte a recursos avançados), configure o caminho do executável:

```json
{
  "portugol.interpreterPath": "C:\\Portugol\\portugol-studio.jar"
}
```

---

## Atalhos de Teclado

| Atalho | Ação |
|--------|------|
| `F5` | Executar programa |
| `Shift+F5` | Parar execução |

---

## Limitações do Interpretador Embutido

- `leia()` dentro de uma função chamada em expressão (ex: `x <- f()` onde `f` usa `leia`) não é suportado — mova o `leia` para antes da chamada
- `pausa()` exibe uma mensagem informativa mas não bloqueia a execução

---

## Requisitos

- Visual Studio Code **1.85** ou superior
- Node.js não é necessário para uso — apenas para desenvolvimento da extensão

---

## Desenvolvimento

```bash
git clone https://github.com/adriano-silva/portugol-vscode
cd portugol-vscode
npm install
npm run compile
```

Pressione **F5** no VSCode para abrir uma janela de desenvolvimento com a extensão carregada.

Para empacotar:

```bash
npm run package
```

---

## Licença

MIT © Adriano da Silva
