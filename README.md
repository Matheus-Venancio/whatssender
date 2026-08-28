# Rede de Apoio — inteligência de WhatsApp para campanhas

Sistema **multi-campanha**: vários candidatos usando a mesma estratégia, cada um com
a sua base, o seu WhatsApp e o seu Firebase. Nenhum enxerga o apoiador do outro.

Para cada campanha, o sistema junta duas coisas que hoje vivem separadas:

1. **Os abaixo-assinados** captados por anúncio no Facebook/Instagram (nome, cidade, atuação);
2. **Os grupos de WhatsApp** (quem fala, sobre o quê, quem some, quem sai).

O casamento é sempre pelo **telefone**. O resultado é uma ficha viva por pessoa:
quem é, onde mora, do que entende, o quanto participa, o que quer resolver e qual
é a próxima ação com ela.

```bash
npm install
npm run configurar      # migra a base existente e cria os acessos
npm start               # painel em http://localhost:3333/login
```

**Campanhas hoje:** `claudia` (744 pessoas · 152 assinaturas · 11 grupos),
`fernando-souza` e `gustavo-lima` (bases novas, prontas para usar).

---

## 0. Acessos e isolamento

### Três papéis

| Papel | O que faz |
|---|---|
| **admin** | vê e administra TODAS as campanhas, cria acessos, troca de campanha no seletor |
| **equipe** | trabalha numa campanha só: responde, adiciona ao grupo, edita ficha, importa leads |
| **candidato** | vê a base dele e usa o **formulário de cadastro** para preencher com as pessoas. Não conecta WhatsApp, não mexe no Firebase, não dispara adição em massa e não exporta a base |

### Como o isolamento funciona

Não é por coluna `campanha_id` — é por **arquivo**:

```
data/
  admin.db                    campanhas, usuários e sessões (o único compartilhado)
  campanhas/
    claudia/
      rede.db                 base da Cláudia
      auth/                   sessão do WhatsApp dela
      leads/                  CSVs dos abaixo-assinados dela
      firebase-key.json       projeto Firebase dela
    fernando-souza/...
    gustavo-lima/...
```

É impossível uma consulta esquecer o filtro e vazar base de um candidato para outro:
os dados nem estão no mesmo arquivo. O `db` do código é um Proxy que resolve, a cada
acesso, o banco da campanha ativa no contexto (`AsyncLocalStorage`) — por isso as ~200
consultas do sistema continuam escritas do jeito simples, sem `WHERE campanha = ?`.

Se alguém forjar o cabeçalho `x-campanha` apontando para uma campanha que não é dele,
o servidor ignora e devolve a base dele. Isso está coberto por teste.

### Comandos de gestão

```bash
npm run configurar -- --listar
npm run configurar -- --campanha "Fernando Souza" --cargo "Vereador · Campinas"
npm run configurar -- --usuario ana@campanha.com --nome "Ana" --papel equipe --campanha-slug claudia
npm run configurar -- --firebase fernando-souza
```

Criar campanha pelo painel (**Acessos → + Campanha**) já gera os dois acessos —
equipe e candidato — com senhas aleatórias mostradas **uma única vez**. As senhas são
guardadas com scrypt e sal; não existem em texto em lugar nenhum.

### Firebase por campanha

Cada campanha aponta a **sua** chave. Uma campanha sem chave própria simplesmente
**não sincroniza** — o sistema se recusa a escrever a base de um candidato dentro do
projeto Firebase de outro. Para compartilhar um projeto de propósito, defina
`firebase_prefixo` e os dados vão para `campanhas/<slug>/…`.

### O que o candidato usa

Aba **✍️ Cadastrar pessoa**: formulário dentro do painel para preencher na hora com a
pessoa do lado, mais o **link público** e um **QR Code** para eventos e panfletos.
Cada campanha tem os seus: `/cadastro/<slug>` e `/formulario/<slug>`.

### Rodar comandos numa campanha específica

Os scripts de linha de comando trabalham sobre uma campanha por vez:

```bash
CAMPANHA=fernando-souza npm run importar
CAMPANHA=claudia npm run teste
```

Sem a variável, usam a primeira campanha encontrada.

---

## As seis colunas que você pediu

| Coluna | De onde vem |
|---|---|
| **Nome** | abaixo-assinado; sem cadastro, mostra o `pushName` do WhatsApp e marca a ficha como incompleta |
| **Cidade** | abaixo-assinado, normalizado (cidade + UF separados, "iracemapolis são Paulo" → Iracemapolis/SP) |
| **Atuação** | abaixo-assinado (`professor(a)_ou_educador(a)` → "Professor(a) ou educador(a)") |
| **Última resposta no grupo** | último texto real da pessoa + há quanto tempo + em qual grupo |
| **Classificação** | score 0–100 → Embaixador / Ativo / Morno / Observador / Adormecido |
| **Interesse** | temas das mensagens **+ temas do abaixo-assinado que ela assinou** + sinais de intenção |

Tudo sai em CSV com um clique, já filtrado.

---

## 1. Os abaixo-assinados em produção

Os três formulários do Meta Lead Ads já estão importados:

| Abaixo-assinado | Assinaturas | Bandeira | Temas que alimenta |
|---|---:|---|---|
| Pelo fim da violência nas escolas | 113 | Educação preventiva | segurança, educação, infância |
| Psicólogos em tempo integral nas escolas | 63 | Saúde mental | saúde, educação, infância |
| Pena mais dura para quem abusa de crianças | 50 | Proteção da infância | infância, segurança |

**226 assinaturas → 204 pessoas**: 22 pessoas assinaram mais de um. Elas são as mais
quentes da base e o sistema já as trata assim (os temas somam).

### Quando o Proteja Digital virar formulário de anúncio

`form_id` do Meta só existe depois do formulário publicado, então o mapa `ABAIXOS`
(em `src/leads.js`) não pode ter a entrada dele antes da hora. Até lá, o
importador **deduz** bandeira e temas pelo nome do formulário
(`PISTAS_DE_ABAIXO`): um formulário chamado "Proteja Digital: crianças seguras na
internet" já entra com `protecao_digital`, `infancia_juventude` e `seguranca` — sem
isso, os leads da bandeira mais forte da campanha chegariam com `temas: []`, ou
seja, sem interesse registrado, sem segmentação e sem recomendação de grupo.

Assim que o formulário estiver no ar, registre o `form_id` real em `ABAIXOS` (ele
aparece na coluna `form_id` do CSV, no formato `f:123…`): a chave fica estável
mesmo se o nome do anúncio mudar depois.

`protecao_digital` é um tema próprio no `lexicon.js`, e não um pedaço de
"infância". Diluído lá, o painel não conseguia responder quanta gente fala
especificamente de criança no ambiente digital — que é o recorte que sustenta o
projeto de lei. Também é a nova opção **📱 Proteção Digital** no formulário de
pautas.

### Subir o CSV pela tela

Em produção não existe "colocar o arquivo na pasta": o disco é do servidor, não
da máquina de quem exportou o lead. A aba **Abaixo-assinados** tem área de
upload — clique ou arraste, vários arquivos de uma vez.

**Formato:** o Gerenciador de Anúncios não exporta um formato só. O mesmo
abaixo-assinado sai ora em **UTF-8 com vírgula**, ora em **UTF-16LE com TAB**. O
sistema detecta pelo BOM e pelo cabeçalho — não pela extensão. Isso importa
porque um arquivo UTF-16 lido como UTF-8 não dá erro nenhum: vira uma linha só
com bytes nulos e a importação "funciona" gravando lixo.

O upload guarda uma cópia em `data/campanhas/<slug>/leads/` antes de importar,
empurra a fila do Firestore na hora (para o lead não ficar só no banco local) e
diz na tela se foi espelhado. Se o Firebase estiver fora, o aviso é explícito.

Nada duplica: assinatura repetida é reconhecida pelo `lead_id`, inclusive quando
o mesmo lead vem no outro formato.

### Importar novos leads (linha de comando)

O Meta exporta CSV pelo Gerenciador de Anúncios. Jogue os arquivos em `data/leads/` e:

```bash
npm run importar
```

Ou pelo painel, em **Abaixo-assinados → Importar novos CSV**. O importador:

- reconhece as colunas em português ou inglês, e por `form_id` (estável);
- **nunca duplica**: `lead_id` já importado é ignorado;
- **nunca sobrescreve** o que a equipe preencheu à mão — só completa campos vazios;
- limpa os dados sujos: idade digitada no campo cidade (`"51"`) vira `null`,
  UF grudada é separada, nome em CAIXA ALTA é normalizado.

O que o sistema descobriu na limpeza desta base: 153 cidades distintas em 14 estados,
134 pessoas em SP, e todo mundo com UF preenchida (deduzida pelo DDD quando faltava).

---

## 2. Firebase — a base de produção

**O SQLite local é o motor de cálculo** (score, cruzamentos e filtros em milissegundos).
**O Firestore é onde o dado mora**: compartilhado com a equipe, com backup do Google,
acessível por qualquer app que você fizer depois.

Toda escrita passa por uma **outbox** no SQLite. Se o Firebase estiver fora do ar — ou
nem configurado ainda — nada se perde: a fila reprocessa sozinha a cada 15 segundos.

### Coleções

| Coleção | Documento | Conteúdo |
|---|---|---|
| `pessoas` | telefone | a ficha inteira, desnormalizada — perfil, interesse, tags, grupos e assinaturas juntos, sem precisar de join |
| `assinaturas` | lead_id do Meta | cada assinatura, com anúncio e plataforma de origem |
| `abaixos` | chave | os abaixo-assinados e seus totais |
| `grupos` | jid | grupos do WhatsApp e tamanho |
| `alertas` | id | saídas e entradas de grupo |
| `eventos` | id | linha do tempo de cada pessoa |
| `mensagens` | id | só com `FIRESTORE_ESPELHAR_MENSAGENS=true` — volume alto, desligado por padrão |

### Já está ligado ✅

Projeto **`claudia-66b8e`**. A chave está em `data/firebase-key.json` e o `.env` aponta
para ela. O servidor conecta sozinho ao subir:

```
[firebase] conectado ao projeto claudia-66b8e
```

**433 documentos já sincronizados**: 204 pessoas + 226 assinaturas + 3 abaixo-assinados.
A partir daqui é automático — cada cadastro novo, edição de ficha, mensagem de grupo
ou saída de participante sobe sozinho.

```bash
npm run firebase:sync      # forçar reenvio de tudo
npm run firebase:previa    # ver o que subiria, sem enviar
```

### Segurança

As regras ativas hoje no projeto são as do **modo produção**: `allow read, write: if false`.
Ou seja, ninguém lê nem escreve de fora — só o servidor, que usa a conta de serviço e
passa por cima das regras. Para uma base de dado pessoal, é o estado certo.

O arquivo `firestore.rules` deste projeto é o **próximo passo**, para quando existir um
app ou painel da equipe: libera leitura para usuários com custom claim `equipe: true`, e
exige `papel: 'coordenacao'` para `assinaturas` e `mensagens` (o dado mais sensível).
Só publique quando for usar:

```bash
npx firebase-tools deploy --only firestore
```

`data/firebase-key.json`, `.env` e `data/leads/*.csv` estão no `.gitignore`.
Não versione nenhum dos três — a chave dá acesso total ao banco.

---

## 3. WhatsApp — funcionando

Baileys e qrcode já estão instalados. Basta:

```bash
npm start
```

Painel → **WhatsApp → Gerar QR Code** → ler com o celular que já está nos cinco grupos
(WhatsApp → Dispositivos conectados → Conectar dispositivo). O QR aparece na tela em
poucos segundos e se renova sozinho.

Ao conectar, o sistema:

1. lê os grupos e **todos os participantes**, criando uma ficha por telefone;
2. reconhece quem já assinou um abaixo-assinado e junta tudo numa ficha só;
3. recebe mensagens, respostas e reações em tempo real;
4. recalcula os perfis em lote a cada 20 segundos e publica no Firestore;
5. atualiza o painel sozinho, sem refresh (SSE).

A sessão fica em `data/auth/` — reiniciar o servidor reconecta sozinho.

> Código escrito para **Baileys 7**, que mudou o formato dos participantes de grupo:
> agora vêm como objetos e o `id` pode ser um LID (`@lid`), que não é telefone.
> O número real vem em `phoneNumber` — `jidDeParticipante()` trata as duas formas.

### Três coisas antes de plugar

1. **Use um número dedicado da campanha, não o da candidata.** É integração não-oficial;
   o sistema basicamente escuta (o uso mais seguro), mas o número âncora não deve ser o pessoal.
2. **Não existe API oficial para ler grupos.** A Cloud API da Meta só faz conversa 1:1 com
   quem iniciou contato. Para ler os cinco grupos, o caminho é este.
3. **LGPD.** Avise nos grupos que a equipe acompanha; o formulário já tem consentimento
   explícito; tenha um responsável pela base; permita exclusão a pedido. E não importe
   lista de terceiros — disparo em massa por WhatsApp é vedado pela legislação eleitoral.

---

## 4. Detecção de atrito nos grupos

O `lexicon.js` entende **interesse** (do que a pessoa gosta). O `risco.js` entende
**quando a conversa azeda** — e é o que protege o número da campanha.

Seis categorias, em ordem de gravidade:

| Sinal | O que dispara | Gravidade |
|---|---|---|
| 🚨 Ameaça de denúncia | "vou denunciar", "isso é golpe", "procon", "meu advogado" | crítico |
| ❓ Não sabe por que está no grupo | "quem é você", "quem me adicionou", "onde conseguiu meu número" | crítico |
| 🚪 Vai sair do grupo | "não quero saber do grupo", "me tira daqui", "vou sair" | crítico |
| ⚡ Hostilidade / ofensa | xingamento, "que palhaçada", "ridículo" | aviso |
| 🗳️ Rejeição política | "só promessa", "chega de política" | aviso |
| 🔕 Incomodado com o volume | "muita mensagem", "já silenciei" | info |

Cada alerta vem com **o que fazer**, não só com o diagnóstico:

> ❓ **Ana Luiza Moraes — não sabe por que está no grupo** em *Protegendo quem protege | Saúde*
> “Quem é você?”
> Morno · 2 mensagens · está em 4 grupos
> **O que fazer:** responda no privado, não no grupo: diga quem é a candidata, quem
> adicionou e ofereça a saída. É daqui que nasce a denúncia.

Detalhes que evitam ruído:

- **Um alerta por mensagem**, sempre o sinal mais grave. Denúncia ganha de saída, que ganha de xingamento.
- **Sem enxurrada**: a mesma pessoa repetindo o mesmo tipo de reclamação em 30 minutos gera um alerta só.
- **Conflito coletivo**: quando 2+ pessoas diferentes geram atrito no mesmo grupo dentro de
  1 hora, sai um alerta separado — aí não é caso isolado, é briga, e você precisa entrar no grupo.
- **Mensagem da própria campanha não vira alerta** (`fromMe` é ignorado).
- Quem gera risco crítico é marcado com a tag **"Atenção / atrito"** e fica visível na lista de pessoas.

Ajustar o dicionário: `src/risco.js`. Depois de mexer, reavalie o histórico:

```bash
npm run riscos           # últimos 30 dias
npm run riscos -- --tudo # histórico inteiro
```

O teste (`npm run teste:risco`) cobre 14 frases que **precisam** disparar e 12 frases
normais que **não podem** disparar — "vou sair para o trabalho" e "denunciei maus tratos
de animais" não podem virar alerta.

---

## 5. Conversas — o WhatsApp espelhado no sistema

A aba **Conversas** é a caixa de entrada da campanha: grupos e conversas privadas
lado a lado, com a thread completa e um campo para responder sem sair do painel.

- **Privadas** trazem contador de não lidas e o marcador *aguardando resposta*
  (última mensagem é dela e ninguém respondeu). É o que precisa de ação.
- **Grupos** entram pela atividade, sem contador — senão a caixa vira ruído.
- Filtros: `Tudo`, `Não lidas`, `Aguardando resposta`, `Privadas`, `Grupos`, `Atrito`.
- Responder pelo painel envia pelo WhatsApp de verdade e já grava na timeline da pessoa.
- Mensagem nova no privado dispara um aviso no canto da tela, mesmo em outra aba.

### Análise da conversa 1 para 1

Cada mensagem recebida ganha um **sentimento**: `positivo`, `neutro`, `negativo` ou
`crítico`. O conjunto das últimas seis define o clima da conversa, mostrado no topo
da thread e como bolinha colorida na lista.

Uma decisão que importa: **pedido de ajuda conta como negativo.** Quem escreve
"preciso muito de ajuda, meu filho sofre bullying e ninguém faz nada" não está num
momento neutro, mesmo sem usar nenhuma palavra de tristeza.

### Sugestões de resposta

Abaixo da thread, o sistema propõe de 1 a 3 respostas prontas, cada uma com **tom**
(acolhedor / direto / formal) e com o **porquê** da sugestão. Clicar joga o texto no
campo — **nunca envia sozinho**, a equipe revisa e edita antes.

As sugestões saem do cruzamento entre o que a pessoa acabou de escrever e o que o
sistema já sabe dela: nome, cidade, se assinou abaixo-assinado, se está em algum
grupo, tema de interesse e classificação.

| Situação | O que ele sugere |
|---|---|
| Ameaçou denunciar | Pedir desculpas e encerrar — e só isso, sem tentar reverter |
| "Quem é você?" | Explicar quem somos e oferecer saída, **ou** só remover sem argumentar |
| Vai sair do grupo | Segurar sem pressionar, ou remover com porta aberta |
| Pediu ajuda | Acolher e pedir os detalhes que faltam para encaminhar |
| Se ofereceu para ajudar | Aceitar com **tarefa concreta** — oferta sem tarefa esfria em 48h |
| Conversa positiva | Retribuir e pedir compartilhamento |
| Não tem cadastro | Mandar o link do formulário |
| Assinou e não está em grupo | Convidar para o grupo da região dela |

Repare no que ele **não** faz: quando a pessoa está irritada, nenhuma sugestão tenta
captar cadastro ou convidar para grupo. Insistir nessa hora é o que gera denúncia.

Personalizar: `CANDIDATA` e `URL_CADASTRO` no `.env`; os textos ficam em `src/conversa.js`.

### Espelhar o histórico que já existe

```env
SINCRONIZAR_HISTORICO=true
```

O WhatsApp só envia o histórico **no momento do pareamento**. Se o número já estava
conectado antes de você ligar essa opção, é preciso desconectar (Painel → WhatsApp →
Desconectar) e ler o QR de novo para o espelho puxar as conversas antigas.

Num número novo, só da campanha, vale muito a pena. Num número com anos de conversa
pessoal, pense duas vezes: é dado de terceiros entrando na base.

---

## 6. Adicionar gente aos grupos sem perder o número

**O problema:** adicionar 100 pessoas a um grupo de uma vez desconecta e bloqueia o
número. Isso não é limitação da biblioteca — é o WhatsApp reagindo ao *comportamento*.
Evolution API, Z-API ou qualquer outra ferramenta bate no mesmo muro. Não existe truque.

**O que dá para fazer:** um clique enfileira as 100 pessoas, e o sistema adiciona
sozinho, devagar, ao longo de horas ou dias. Você não fica olhando.

### Antes de tudo: quais grupos são da campanha

O Baileys lista **todos** os grupos do telefone âncora — inclusive os que não têm
nada a ver com a campanha (curso, igreja, grupo de outra profissional). Nesta base
são 7 de 12. Enquanto eles não estiverem separados, dois estragos ficam à espera
de um clique distraído:

- a fila de adição oferece esses grupos como destino, e assinante de
  abaixo-assinado acaba dentro do grupo de terceiro — dano de reputação e uso
  indevido de dado pessoal;
- a recomendação de grupo do formulário caía em "o primeiro grupo por id", que
  aqui é um grupo externo.

Cada grupo tem agora `da_campanha` (é nosso ou não) e `tema` (qual pilar atende,
usando as mesmas chaves de `lexicon.js`). Quem classifica é o **nome** do grupo,
não a descrição: o nome é o que a equipe padroniza (`Protegendo quem protege |
Educação`), enquanto a descrição do grupo geral fala de crianças e o faria
competir com o grupo do pilar, deixando a campanha sem destino para quem não casa
com nenhum tema.

```bash
npm run grupos                      # mostra a situação (não altera nada)
npm run grupos -- --aplicar         # (re)classifica pelo nome
npm run grupos -- --marcar 12       # "este é da campanha", decisão da equipe
npm run grupos -- --marcar 12 --tema educacao
npm run grupos -- --desmarcar 1     # "este NÃO é da campanha"
```

Renomear um grupo no WhatsApp reclassifica sozinho na próxima sincronização
(`Protegendo quem protege | Saúde` → `Salve a Escola` continua achando o tema).
O que foi marcado à mão (✋) a automação não desfaz.

**Um único grupo da campanha deve ficar sem tema**: é o grupo geral, destino de
quem não casa com nenhum pilar. Com dois sem tema, o `npm run grupos` avisa.

`enfileirar()` **recusa** grupo não marcado, com erro explicando o que fazer. É
trava de propósito: melhor a fila reclamar do que descobrir depois.

### Como usar

Aba **Grupos** → botão **➕ Adicionar** no grupo desejado. Escolha o filtro
(abaixo-assinado, estado, cidade, só quem não está em nenhum grupo), veja a prévia
com o total e clique. Pode fechar a janela: a fila roda em segundo plano.

### O ritmo, e por que ele é assim

| | Padrão | Por quê |
|---|---|---|
| Intervalo | 90–210s, **sorteado** | ritmo fixo é assinatura de robô |
| Teto diário | 50 | acima disso o risco cresce muito |
| Teto por hora | 15 | evita rajada dentro do dia |
| Horário | 9h–20h | ninguém adiciona 40 pessoas às 3h da manhã |
| Pausa longa | 12 min a cada 12 pessoas | quebra a cadência mecânica |
| Parada automática | 3 erros seguidos | para antes de virar bloqueio |

A fila também **pausa sozinha se a conexão cair** durante a adição — queda no meio do
processo costuma ser o WhatsApp reclamando.

Tudo isso é ajustável no `.env` (`ADICAO_*`). Subir os números aumenta o risco; foram
escolhidos para o lado seguro de propósito.

### Quem não pode ser adicionada direto

Muita gente tem a privacidade fechada para adição em grupo. O WhatsApp responde `403`
e o sistema, em vez de desistir, **manda o link de convite no privado**, explicando de
onde veio o contato e dando saída educada:

> Oi, Maria! Tudo bem?
> Você assinou nosso abaixo-assinado e queremos te incluir no grupo *Protegendo quem
> protege | Saúde*, onde a gente organiza as ações.
> Seu WhatsApp não permite que a gente adicione direto, então segue o convite: …
> Se preferir não participar, é só ignorar esta mensagem 🙏

Os outros retornos também são tratados: `408` (saiu do grupo há pouco — o WhatsApp não
deixa readicionar), `401` (bloqueou o número), `409` (já está no grupo). Cada um vira um
motivo em português na lista de "não deu certo".

### Acompanhamento

O painel mostra barra de progresso, quantas foram adicionadas, quantas foram convidadas
por link, quantas faltam, quanto sobrou da cota do dia e a estimativa de término. Dá para
**pausar, retomar e cancelar** a qualquer momento.

---

## 7. Aviso de saída de grupo

Quando alguém sai, o sistema **não registra só que saiu**. Ele monta o retrato da pessoa
no momento da saída, porque perder um embaixador que assinou dois abaixo-assinados é um
problema, e perder alguém que nunca falou não é.

O alerta traz:

- se **saiu sozinha** ou **foi removida** — e por quem (o Baileys informa o autor da ação);
- a classificação e o score que ela tinha;
- a última coisa que escreveu e o tema principal dela;
- se tinha se oferecido para ajudar;
- quais abaixo-assinados assinou;
- se **ainda está em outros grupos** ou saiu de todos.

Gravidade **crítica** (vermelho) quando era engajada, tinha cadastro ou assinou algo.
Gravidade **aviso** para quem nunca participou.

Onde aparece:

- **toast no canto da tela**, na hora, via SSE;
- **contador no menu lateral** (🔔 Alertas);
- **tela de Alertas**, com o retrato completo;
- **coluna "Saíram dos grupos"** na Fila de ação;
- **coleção `alertas`** no Firestore;
- **mensagem no WhatsApp da equipe**, se você preencher `ALERTA_WHATSAPP` no `.env`.

O vínculo com o grupo **não é apagado** — recebe `saiu_em`, preservando o histórico.
Se a pessoa voltar, o vínculo é reativado.

Saídas que aconteceram com o sistema desligado também são detectadas: na sincronização,
quem estava na base e não aparece mais na lista do grupo gera alerta.

---

## 8. Coletar dados — captação por embaixador

A base tem mais de mil pessoas, mas só ~148 estão em grupo da campanha. A Luciana
(Rede Lara Maria), a Lucilene e o Cadima têm alcance real e querem ajudar a mapear
apoiador. Esta é a peça que transforma esse alcance em base própria da campanha.

**Como funciona:** cada embaixador ganha um código, um link e um QR Code próprios.
Ele divulga na rede dele; quem quiser entrar abre o link, preenche o formulário
(que já pede consentimento) e cai na base da Cláudia **já atribuído a quem
trouxe**, com o potencial de apoio calculado.

```bash
npm run embaixadores                                   # rendimento de cada um
npm run embaixadores -- --criar "Luciana" --papel "Rede Lara Maria"
npm run embaixadores -- --links                        # link e QR de cada um
npm run embaixadores -- --captadas 1                   # quem ela trouxe, por propensão
npm run embaixadores -- --desativar 3
```

No painel: aba **📡 Coletar dados** — cria embaixador, copia links, mostra QR e
acompanha o rendimento de cada um.

### Os QR desta tela NÃO conectam WhatsApp

Este é o erro que aparece primeiro, e não é bug: lido em **WhatsApp →
Dispositivos conectados**, o QR de captação devolve **"QR code inválido"**.

São dois tipos de QR completamente diferentes, e o sistema tem os dois:

| QR | Onde fica | O que é | Como se lê |
|---|---|---|---|
| **Pareamento** | aba 🔌 WhatsApp | payload do próprio WhatsApp; conecta **o número da campanha** ao sistema | WhatsApp → Dispositivos conectados |
| **Captação** | aba 📡 Coletar dados | um **endereço** (formulário ou conversa) | câmera do celular |

O leitor de "Dispositivos conectados" só aceita o payload de pareamento — para ele,
qualquer endereço é inválido. Use a câmera do celular (ou a câmera dentro de uma
conversa do WhatsApp). O painel avisa isso em cima da tela.

E vale repetir: o QR de pareamento conecta **o número da campanha**, nunca o
celular da aliada. Não existe fluxo em que a Luciana pareia o WhatsApp dela — é
justamente o que este recurso evita.

### Dois modos de captação por embaixador

| Modo | Link | Serve para |
|---|---|---|
| 📋 **Formulário** | `/formulario/<slug>?e=<código>` | dado rico: cidade, atuação, pautas — e já recomenda o grupo certo |
| 💬 **WhatsApp** | `wa.me/<número da campanha>?text=…(indicação: código)` | atrito zero; a conversa nasce com **a pessoa** chamando a campanha |

O modo WhatsApp é o que fica mais perto do que se imagina ao ouvir "captar pelo
WhatsApp", e é legítimo porque **quem inicia o contato é a pessoa** — o único
formato em que abordar por WhatsApp não é disparo a lista de terceiro. A mensagem
sugerida carrega o código de quem indicou, e o `whatsapp.js` atribui na hora que a
primeira mensagem chega.

A atribuição por mensagem vale **só na primeira**: depois disso, colar o código de
outro embaixador não muda nada — senão qualquer um mexeria na atribuição alheia.

### Kit de divulgação

O gargalo da captação não é o link — é a pergunta *"o que eu escrevo?"*. A Luciana
tem alcance, boa vontade e nenhum texto pronto, e cada dia sem postar é alcance que
não virou base.

Botão **✉️ Kit de divulgação** no cartão de cada embaixador: cinco peças prontas
(story/status, grupo de WhatsApp, mensagem individual, legenda de post, fala de 20
segundos em evento com o QR na mão), cada uma com o link dela já embutido e um
botão de copiar. Mais uma peça de WhatsApp quando há número conectado.

Os textos são escritos **na voz da embaixadora**, não na da campanha — é o nome
dela que dá credibilidade, e texto de campanha na boca dela soa a panfleto. A fala
de evento é a única sem link no corpo, de propósito: é roteiro falado apontando
para o QR impresso.

O kit sai junto com as regras que ela precisa saber: não prometer nada em nome da
candidata, não citar caso real nem nome de vítima, oferecer saída a quem não quer,
e não copiar a agenda de ninguém. Nenhuma peça cita número de urna — número errado
em peça divulgada não se recolhe, e quem confirma isso é o jurídico.

O kit é recusado enquanto o endereço público não estiver configurado: texto com
link `localhost` mandado para a aliada é pior que texto nenhum.

### Se os links saírem com localhost

O painel roda em `localhost:3333` na máquina da equipe, e um link
`http://localhost:3333/formulario/...` **não abre no celular de ninguém**. O
endereço público vem do servidor (`base_publica` em `/api/config`), lido da config
`url_cadastro` da campanha ou de `URL_CADASTRO` no `.env`. Enquanto não estiver
configurado, o painel e o `npm run embaixadores` avisam em vez de entregar link
quebrado:

```bash
# no .env, e reinicie o servidor
URL_CADASTRO=https://SEU-DOMINIO/formulario
```

O relatório não mostra só volume, porque volume engana: 200 contatos frios não
valem 20 prováveis apoiadores. Por isso vem a quebra por faixa de potencial de
apoio, a propensão média e quantos já entraram em grupo da campanha — que é o
passo em que a captação vira audiência de verdade.

**A primeira atribuição vale.** Se a pessoa voltar depois por outro link, ela
continua contando para quem a captou primeiro; senão o último clique roubaria o
crédito e o relatório viraria ficção.

### O que este recurso NÃO faz, de propósito

Ler a agenda de contatos ou as conversas do embaixador. Pareado por QR Code, o
WhatsApp entrega as duas coisas, e é tentador — resolveria a base num dia. Não dá
para fazer:

- as pessoas da agenda da Luciana **nunca deram dado nenhum à campanha**. Entrar
  numa base política com finalidade de abordagem exige base legal, e não há
  nenhuma aqui (LGPD art. 7 e 11 — preferência política é dado sensível);
- a Luciana pode consentir pela conta **dela**, nunca pelas centenas de pessoas
  que escreveram para ela. Conversa privada é dado de terceiro;
- a Rede Lara Maria é rede de **mães de vítimas**. Estar naquela lista já revela
  dado sensível. Se vazar que a lista virou base de campanha, o estrago cai na
  Luciana e na Lucilene — que são o ativo de credibilidade da candidatura;
- operacionalmente é o caminho mais curto para *"quem é você, onde conseguiu meu
  número"* — o sinal crítico que o `risco.js` já monitora — e para a denúncia por
  disparo em massa a lista de terceiro.

A captação por link/QR chega no mesmo lugar (base própria, atribuída, com
potencial de apoio calculado) sem nenhum desses riscos. O `teste:coleta` tem um
bloco que verifica que essas funções de extração **não existem** no módulo.

### Potencial de apoio de quem acaba de chegar

O motor de propensão (`scoring.js`) foi feito para quem a campanha já observa nos
grupos: mensagem, conversa privada, agenda. Quem chega só pelo formulário tinha
apenas dois sinais (tema de interesse + formulário preenchido), pontuava 17 e caía
em "Contato frio" — ou seja, a fila de tratamento da captação nascia vazia.

Três sinais que já estavam na base e ninguém lia entraram na conta:

| Sinal | Peso | Por quê |
|---|---:|---|
| Intenção declarada | 22 | "coordeno a associação", "quero ser voluntária" — o mais forte de quem ainda não conversou. Escala pelo peso do lexicon: liderança (4) vale mais que demanda (2) |
| Veio por indicação | 14 | confiança emprestada de quem trouxe; converte muito melhor que clique em anúncio |
| Marcou várias pautas | 6 cada | leu o formulário em vez de só enviar |

Quem se declara liderança e vem por indicação sai de 17 para 57 — de "Contato
frio" para "Possível apoiador". Quem não declarou nada continua nos mesmos 17: os
pesos novos não inflam a régua de quem não deu sinal, e há teste garantindo isso.

Atrito registrado continua tirando a pessoa da lista, por mais sinais que ela
tenha.

---

## 9. O cadastro de hoje sobrevive ao próximo deploy?

Num servidor sem disco persistente, a resposta depende de uma cadeia de quatro
elos em arquivos diferentes: disco, credencial de sistema, Firestore da campanha
conectado e fila de saída andando. Quando um elo quebrava, o painel continuava
verde e a perda só aparecia depois do deploy seguinte — com a equipe já tendo
cadastrado gente na rua o dia inteiro.

`src/protecao.js` junta os quatro numa resposta só, e ela aparece em três lugares:

- **no boot**, uma linha quando está tudo certo e um bloco em vermelho quando não está;
- **no painel**, uma faixa no topo de *todas* as telas, com o que fazer;
- **em `/api/saude`**, no campo `cadastros_protegidos` — dá para conferir sem login.

O elo que mais falta é `FIREBASE_SERVICE_ACCOUNT_JSON`. É a credencial de
**sistema**, e resolve um ovo-e-galinha: a chave do Firebase de cada campanha
mora em `data/campanhas/<slug>/firebase-key.json`, que é justamente o que o disco
efêmero apaga. Sem ela vinda do ambiente, o boot não tem como buscar a chave de
volta — o Firestore nunca conecta, nada é espelhado e não há o que restaurar.
Com ela, o boot refaz a cadeia sozinho: contas, chaves, sessão do WhatsApp e,
se a base local estiver vazia, as pessoas.

Ver `PRODUCAO.md`, seção 2.

---

## Testes

```bash
npm run teste
```

- **`teste:firestore`** (16 verificações) — formato dos documentos, envio em lote de 433
  documentos, limite de 500 por lote, deduplicação da fila, e recuperação de falha de rede
  sem perder dado. Roda contra um cliente falso, sem rede.
- **`teste:contas`** (43 verificações) — isolamento entre campanhas (inclusive tentativa de
  acesso cruzado), contexto obrigatório no banco, hash de senha, login, sessão, permissões
  por papel e desativação de acesso.
- **`teste:adicao`** (32 verificações) — elegibilidade, filtros, deduplicação, os quatro
  status que o WhatsApp devolve (adicionou / privacidade / saiu recente / bloqueou),
  texto do convite e a parada automática após erros seguidos.
- **`teste:conversa`** (31 verificações) — sentimento, intenção, sugestões para conversa hostil/positiva/pedido de ajuda, pessoa sem nome, e a caixa de entrada (contadores e filtros).
- **`teste:risco`** (37 verificações) — 14 frases que precisam virar alerta, 12 frases normais que não podem, prioridade entre sinais, deduplicação, conflito coletivo e o que chega no painel.
- **`teste:importacao`** (36 verificações) — UTF-8, UTF-16 com e sem BOM, vírgula,
  TAB e ponto-e-vírgula; vírgula dentro do dado que não engana a detecção; upload em
  base64; reimportação que não duplica nem quando o formato muda; nome de arquivo
  hostil; e planilha que não é lead, contada como inválida em vez de importada.
- **`teste:protecao`** (20 verificações) — o diagnóstico de persistência em cada
  combinação de credencial, chave e Firestore; que todo problema venha com o que
  fazer, não só com o diagnóstico; e que o boot grite quando há risco e fique
  quieto quando não há.
- **`teste:coleta`** (61 verificações) — código próprio e não adivinhável por embaixador,
  atribuição de quem trouxe quem, primeira atribuição prevalecendo sobre a segunda,
  embaixador desativado que para de atribuir, os três sinais novos de potencial de apoio
  com guarda de regressão contra inflação da régua, o relatório de captação, e a
  verificação de que não existe função de ler agenda ou conversa de terceiro. Cobre
  também o modo WhatsApp: link wa.me, extração do código da mensagem, atribuição na
  primeira mensagem e a recusa de mudar atribuição numa mensagem posterior.
- **`teste:grupos`** (49 verificações) — reconhecimento de grupo da campanha contra
  os nomes reais desta base (inclusive o typo "Criaças"), tema pelo nome e não pela
  descrição, recomendação por pauta com queda no grupo geral, a trava que recusa
  enfileirar em grupo de terceiro, reclassificação ao renomear, decisão manual que
  a automação não desfaz, e a dedução de tema/bandeira de abaixo-assinado novo.
- **`teste:alertas`** (22 verificações) — injeta os mesmos eventos que o Baileys entrega e
  confere entrada, saída voluntária, remoção por admin, idempotência, publicação no
  Firestore e o que o painel mostra. Cria um grupo temporário e apaga tudo no fim.

---

## Estrutura

```
src/
  db.js                esquema SQLite
  leads.js             normalização do CSV do Meta (cidade, UF, telefone, atuação)
  lexicon.js           dicionário de temas e intenções ← a equipe customiza aqui
  scoring.js           engajamento, faixas, completude e próxima ação
  ingest.js            escrita normalizada + alertas
  repo.js              consultas do painel
  firestore.js         ponte com o Firebase (outbox, lotes, documentos)
  embaixadores.js      ⭐ coletar dados: captação atribuída por embaixador
  gerir-embaixadores.js    CLI da captação (npm run embaixadores)
  protecao.js          ⭐ o cadastro de hoje sobrevive ao próximo deploy?
  optout.js            ⭐ descadastramento (art. 57-G), independente de disparo
  grupos-campanha.js   ⭐ que grupo é da campanha e que pilar ele atende
  classificar-grupos.js    CLI da classificação (npm run grupos)
  risco.js             ⭐ dicionário de atrito — quando a conversa azeda
  conversa.js          ⭐ sentimento, leitura da conversa e sugestões de resposta
  contas.js            ⭐ campanhas, usuários, sessões e permissões
  porcampanha.js       estado (WhatsApp/Firebase/fila) isolado por campanha
  configurar.js        migração inicial e gestão pela linha de comando
  adicionar-grupo.js   ⭐ fila de adição a grupo em ritmo seguro
  filtrar-uf.js        limpeza da base por estado
  whatsapp.js          conector Baileys 7 (QR, grupos, tempo real, saídas, atrito)
  importar-leads.js    importador dos abaixo-assinados
  sincronizar-firebase.js / teste-firestore.js / teste-alertas.js
  server.js            HTTP + API + SSE
public/
  index.html · app.js  painel: Panorama, Conversas, Pessoas, Fila, Alertas,
                       Abaixo-assinados, Grupos, WhatsApp, Firebase
  cadastro.html        formulário público do abaixo-assinado
firestore.rules · firestore.indexes.json · firebase.json
data/leads/*.csv       exports do Meta (não versionados)
```

### Comandos

| Comando | O que faz |
|---|---|
| `npm start` | sobe o painel |
| `npm run producao` | zera a base e importa os CSV de `data/leads/` |
| `npm run importar` | importa sem zerar (uso do dia a dia) |
| `npm run firebase:sync` | envia tudo para o Firestore |
| `npm run firebase:previa` | mostra o que subiria, sem enviar |
| `npm run riscos` | reavalia o histórico com o dicionário de atrito atual |
| `npm run grupos` | mostra/classifica quais grupos são da campanha (`-- --aplicar` grava) |
| `npm run embaixadores` | captação por embaixador: rendimento, links e QR (`-- --criar "Nome"`) |
| `npm run configurar` | cria campanhas e acessos (`-- --listar` mostra tudo) |
| `npm run filtrar-uf` | simula a limpeza da base por estado (`-- --confirmar` aplica) |
| `npm run teste` | roda as seis suítes |

---

## O que ainda dá para fazer

- **Convite automático em massa** para os 204 assinantes que ainda não estão em grupo —
  a base existe (`enviarMensagem`), mas precisa de intervalo entre envios e opt-out para
  não queimar o número.
- **Autenticação do painel** antes de subir para qualquer lugar que não seja a máquina da equipe.
- **Rede de indicação**: quem trouxe quem para o grupo (o Baileys entrega o autor do `add`).
- **Mapa por bairro** cruzando cidade/UF com zona eleitoral.
