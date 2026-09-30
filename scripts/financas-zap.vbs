' Sobe a ponte sem nenhuma janela e espera por ela ate o fim.
'
' Este arquivo existe por um motivo so: node.exe e um programa de console, e o
' Agendador de Tarefas do Windows nao consegue esconder o console de uma tarefa
' que roda com o usuario logado. O wscript.exe consegue -- ele nasce sem janela
' e chama o node com a janela desligada.
'
' Ele espera pelo node (o True no fim do Run) de proposito: enquanto a ponte
' estiver de pe, a tarefa continua "em execucao", e a repeticao configurada no
' agendador nao sobe uma segunda copia.
'
' Quando a ponte cai com erro, ele mesmo a sobe de novo: 15 s, depois o dobro a
' cada queda seguida, ate 5 min. Uma ponte que ficou de pe mais de 10 min volta
' a esperar so 15 s. Saida 0 (encerrada de proposito) e 2 (.env recusado ou
' outra ponte ja de pe) nao se repetem. A repeticao do agendador fica como rede
' para o caso de o proprio wscript morrer.
'
' Sem acentos: o wscript le .vbs na codificacao antiga do Windows.
Option Explicit

Dim shell, fso, raiz, comando, saida, inicio, espera

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' A raiz do projeto e a pasta acima de scripts\.
raiz = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

If Not fso.FileExists(raiz & "\dist\index.js") Then
  WScript.Quit 2
End If

shell.CurrentDirectory = raiz

' Sem console, o que a ponte diria na tela vai para o diario em disco.
shell.Environment("PROCESS")("LOG_PATH") = ".runtime\financas-zap.log"

' Teto de memoria do lado do Node, que so manuseia texto e a arte em base64.
' O Chromium tem os limites dele em whatsapp-client.ts.
shell.Environment("PROCESS")("NODE_OPTIONS") = "--max-old-space-size=512"

comando = "node.exe """ & raiz & "\dist\index.js"""
espera = 15

Do
  inicio = Now
  saida = shell.Run(comando, 0, True)
  If saida = 0 Or saida = 2 Then Exit Do
  If DateDiff("s", inicio, Now) > 600 Then espera = 15
  WScript.Sleep espera * 1000
  espera = espera * 2
  If espera > 300 Then espera = 300
Loop

WScript.Quit saida
