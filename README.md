# Rede de Apoio — inteligência de WhatsApp para campanha

Sistema que junta duas coisas que hoje vivem separadas:

1. **Os abaixo-assinados** captados por anúncio no Facebook/Instagram (nome, cidade, atuação);
2. **Os grupos de WhatsApp** da campanha (quem fala, sobre o quê, quem some, quem sai).

O casamento é sempre pelo **telefone**. O resultado é uma ficha viva por pessoa:
quem é, onde mora, do que entende, o quanto participa, o que quer resolver e qual
é a próxima ação com ela.

```bash
npm install
npm run producao     # importa os CSV de data/leads/ (zera a base antes)
npm start            # painel em http://localhost:3333
```

**Base 100% de produção** — 743 pessoas, sendo 134 leads (todos de **SP**) e 609 membros
vindos dos grupos. 152 assinaturas, 11 grupos monitorados. Nenhum dado fictício.

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

### Importar novos leads

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

## Testes

```bash
npm run teste
```

- **`teste:firestore`** (16 verificações) — formato dos documentos, envio em lote de 433
  documentos, limite de 500 por lote, deduplicação da fila, e recuperação de falha de rede
  sem perder dado. Roda contra um cliente falso, sem rede.
- **`teste:adicao`** (32 verificações) — elegibilidade, filtros, deduplicação, os quatro
  status que o WhatsApp devolve (adicionou / privacidade / saiu recente / bloqueou),
  texto do convite e a parada automática após erros seguidos.
- **`teste:conversa`** (31 verificações) — sentimento, intenção, sugestões para conversa hostil/positiva/pedido de ajuda, pessoa sem nome, e a caixa de entrada (contadores e filtros).
- **`teste:risco`** (37 verificações) — 14 frases que precisam virar alerta, 12 frases normais que não podem, prioridade entre sinais, deduplicação, conflito coletivo e o que chega no painel.
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
  risco.js             ⭐ dicionário de atrito — quando a conversa azeda
  conversa.js          ⭐ sentimento, leitura da conversa e sugestões de resposta
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
| `npm run filtrar-uf` | simula a limpeza da base por estado (`-- --confirmar` aplica) |
| `npm run teste` | roda as cinco suítes |

---

## O que ainda dá para fazer

- **Convite automático em massa** para os 204 assinantes que ainda não estão em grupo —
  a base existe (`enviarMensagem`), mas precisa de intervalo entre envios e opt-out para
  não queimar o número.
- **Autenticação do painel** antes de subir para qualquer lugar que não seja a máquina da equipe.
- **Rede de indicação**: quem trouxe quem para o grupo (o Baileys entrega o autor do `add`).
- **Mapa por bairro** cruzando cidade/UF com zona eleitoral.
