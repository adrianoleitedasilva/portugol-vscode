algoritmo "ExemploLeia"
var
   nome : cadeia
   idade : inteiro
   altura : real
   maior : logico

inicio
   escreval("=== Cadastro de Pessoa ===")

   escreva("Digite seu nome: ")
   leia(nome)

   escreva("Digite sua idade: ")
   leia(idade)

   escreva("Digite sua altura (ex: 1.75): ")
   leia(altura)

   maior <- idade >= 18

   escreval("")
   escreval("=== Dados Informados ===")
   escreva("Nome: ")
   escreval(nome)
   escreva("Idade: ")
   escreval(idade)
   escreva("Altura: ")
   escreval(altura)
   escreva("Maior de idade: ")
   escreval(maior)

   se maior entao
      escreval("Você é maior de idade.")
   senao
      escreval("Você é menor de idade.")
   fimse

fimalgoritmo
