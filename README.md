# TradupPop

> Selecione qualquer palavra ou frase em uma página web e receba a tradução instantaneamente com fonética, áudio, dicionário, definições e exemplos de uso e salve palavras para praticar com repetição espaçada.

## Preview

### Popup de tradução na página

Ao selecionar uma palavra ou frase, o TradupPop abre um popup contextual com tradução, fonética, áudio e dicionário.

![Preview do TradupPop](./tradupop.png)

### Painel de controle da extensão

No painel, você ajusta idioma, preferências e recursos para personalizar a experiência.

![Preview do Painel TradupPop](./tradupop_painel.png)

## O que é

**TradupPop** é uma extensão para Google Chrome e Mozilla Firefox que traduz palavras e frases diretamente na página, sem precisar abrir uma nova aba ou copiar o texto. Basta selecionar e o popup aparece na hora.

Criada para quem está aprendendo um novo idioma e quer entender o significado de palavras sem perder o contexto da leitura e depois fixar esse vocabulário com um sistema de revisão espaçada estilo Anki.

## Instalação

### Chrome

1. Clone ou baixe este repositório
2. Abra `chrome://extensions/` no Chrome
3. Ative o **Modo do desenvolvedor** (canto superior direito)
4. Clique em **Carregar sem compactação**
5. Selecione a pasta do projeto
6. Pronto, acesse qualquer página e selecione um texto

### Firefox (128+)

Para testar localmente:

1. Abra `about:debugging#/runtime/this-firefox`
2. Clique em **Carregar extensão temporária...**
3. Selecione o arquivo `manifest.json` na pasta do projeto

> A extensão temporária dura até fechar o navegador. Instalação permanente no Firefox exige o pacote assinado pela Mozilla (publicação em [addons.mozilla.org](https://addons.mozilla.org)) — instalar o zip direto mostra o erro "corrompido".

## Como usar

| Ação | Resultado |
|---|---|
| Selecionar uma palavra | Popup com tradução, fonética, dicionário e definições |
| Selecionar uma frase | Popup com tradução + exemplos de uso |
| Clicar em 🔊 | Ouve a palavra no idioma original |
| Clicar em 🔊½× | Ouve em velocidade lenta |
| Clicar em ★ | Salva a palavra no seu vocabulário (com contexto da frase) |
| Clicar em 📌 | Fixa o popup na tela (persiste entre páginas) |
| Arrastar o cabeçalho | Move o popup para onde quiser |
| Clicar numa alternativa | Troca a tradução ativa |
| Clicar num termo do dicionário | Retraduz aquela palavra |
| Clicar em voltar | Retorna à palavra anterior |
| `Ctrl + Q` | Ouve o texto selecionado (configurável) |
| `Esc` | Fecha o popup |

## Funcionalidades

### Tradução

- **Tradução instantânea** — selecione qualquer texto e o popup aparece automaticamente
- **Fonética** — transcrição da pronúncia junto da palavra
- **Áudio TTS** — pronúncia em velocidade normal e lenta (½×)
- **Dicionário integrado** — classes gramaticais, sinônimos e traduções por sentido
- **Definições monolíngues** — definição da palavra no idioma original
- **Exemplos de uso** — frases reais com a palavra em contexto, com tradução sob demanda
- **Outras traduções** — alternativas clicáveis para explorar variações
- **Navegação por histórico** — botão voltar para palavras anteriores
- **Menu de contexto** — botão direito → "Traduzir com TradupPop"

### Onde mostrar a tradução

Escolha no painel entre dois modos:

- **Na página** (padrão) — popup contextual junto da seleção, com fixar e arrastar
- **No ícone da extensão** — a tradução abre no popup da barra do navegador ao selecionar; se o navegador bloquear a abertura automática, o ícone mostra um aviso. Também abre pelo atalho `Ctrl + Shift + Y` (configurável em `chrome://extensions/shortcuts`)

### Vocabulário e prática

Palavras salvas vão para uma página de vocabulário estilo Anki (★ no popup → ícone da extensão → **Palavras salvas**):

- **Repetição espaçada** — intervalos de 1, 3, 7, 14 e 30 dias; errar desce um nível (sem zerar o progresso)
- **Direção dos cards** — Palavra → Tradução, Tradução → Palavra ou Misto
- **Exercício cloze** — nos cards reversos, a frase de contexto aparece com a palavra em lacuna
- **Fonética e áudio** em cada card e na lista
- **Busca e ordenação** — A–Z, mais recentes, por nível ou a revisar primeiro
- **Exportar / importar** o vocabulário em JSON
- **Desfazer** ao remover palavras

### Geral

- **Múltiplos idiomas** — tradução entre EN, PT, ES, FR, DE, IT, JA, ZH, KO, RU
- **Interface em 5 idiomas** — PT, EN, ES, FR, DE
- **Modo escuro** — manual ou seguindo o tema do sistema
- **Acessível** — navegação por teclado com foco visível e anúncios para leitores de tela

## Painel de controle

Clique no ícone da extensão para abrir o painel onde você pode:

- Trocar o idioma da interface (PT, EN, ES, FR, DE)
- Selecionar idioma de origem e destino (com botão de inverter)
- Escolher onde a tradução aparece (na página ou no ícone)
- Configurar o atalho de teclado
- Ativar/desativar modo escuro
- Abrir o vocabulário e ver quantas palavras estão para revisar

## Apoie o projeto

O TradupPop é gratuito e sem anúncios. Se ele te ajuda, você pode pagar um café ☕ procure o botão **❤ Apoiar projeto** no popup de tradução ou no painel da extensão (doação via Pix).

## Tecnologias

- **Manifest V3** — compatível com Chrome (121+) e Firefox (128+) num único pacote
- **Google Translate API** — tradução, fonética, dicionário, definições e exemplos
- **MyMemory API** — fallback de tradução
- **Google TTS** — síntese de voz
- **Web Speech API** — fallback de áudio e velocidade lenta
- **Dictionary API (dictionaryapi.dev)** — fallback de fonética (inglês)
- **Chrome Storage API** — persistência de dados local

## Estrutura do projeto

```text
tradupop/
├── manifest.json       # Configuração da extensão
├── background.js       # Service worker tradução, cache, menu de contexto, modo ícone
├── content.js          # Script injetado nas páginas — popup de tradução
├── styles.css          # Estilos do popup de tradução
├── ui-strings.js       # Strings de interface (i18n) e config de doação
├── popup.html          # Painel de controle + tradução no modo ícone
├── popup.js            # Lógica do painel
├── popup.css           # Estilos do painel
├── vocabulary.html     # Página de vocabulário (lista + praticar)
├── vocabulary.js       # Lógica do vocabulário e repetição espaçada
├── vocabulary.css      # Estilos do vocabulário
└── icons/              # Ícones da extensão
```

## Autor

Criado por **José Lucas**

- GitHub: [@lucasaffonso0](https://github.com/lucasaffonso0/)
- LinkedIn: [lucasaffonso0](https://www.linkedin.com/in/lucasaffonso0/)
