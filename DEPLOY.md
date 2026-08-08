# Colocar em produção no Render

## Leia isto antes de escolher o plano

O sistema tem duas exigências que o **plano gratuito do Render não atende**:

**1. Disco persistente.** O sistema de arquivos do container é apagado a cada
deploy e a cada reinício. Sem disco, você perde a cada deploy: os bancos das
campanhas, as sessões do WhatsApp (volta a pedir QR), as chaves do Firebase e os
CSVs de leads. Disco persistente no Render exige instância paga.

**2. Não hibernar.** Serviço gratuito dorme depois de alguns minutos sem acesso.
Dormindo, o processo morre — e com ele a conexão do WhatsApp. O sistema para de
ler os grupos, de detectar atrito e de avisar quando alguém sai. Acorda só quando
alguém abre o painel, e nesse meio-tempo tudo que passou nos grupos foi perdido.

**Conclusão honesta:** para o WhatsApp ficar de pé 24h, o serviço precisa ser pago
e ter disco. Confirme os valores atuais no site do Render — eles mudam.

Se o orçamento não permitir agora, existe um meio-termo funcional:
- **Render (pago ou grátis)** hospeda o painel e os formulários públicos;
- **o leitor do WhatsApp roda numa máquina que fica ligada** (o PC da equipe ou
  uma VPS barata), apontando para o mesmo Firebase.

O sistema já suporta isso: os dados vivem no Firestore, e cada campanha tem o
projeto dela.

---

## Passo a passo

### 1. Suba o código para o GitHub

```bash
git add -A
git commit -m "Sistema multi-campanha pronto para produção"
git push
```

O `.gitignore` já protege o que não pode subir: `data/`, `.env`, chaves do
Firebase e CSVs de leads. **Confira antes de dar push:**

```bash
git ls-files | grep -E "data/|\.env$|firebase-key"
```

Se esse comando imprimir alguma coisa, pare e corrija.

### 2. Crie o serviço

Render → **New** → **Blueprint** → aponte para o repositório.
Ele lê o `render.yaml` e cria tudo: serviço Docker, disco de 5 GB montado em
`/var/dados` e as variáveis de ambiente.

Se preferir criar na mão: **New → Web Service**, runtime **Docker**, e adicione
um **Disk** em `/var/dados` com a variável `DATA_DIR=/var/dados`.

> Por que Docker e não o runtime Node do Render: o sistema usa `node:sqlite`,
> que só existe no Node 22+. O `Dockerfile` trava a versão; o runtime do
> provedor não dá essa garantia.

### 3. Defina o administrador

Em **Environment**, adicione:

| Variável | Valor |
|---|---|
| `ADMIN_EMAIL` | seu e-mail |
| `ADMIN_SENHA` | uma senha forte |
| `ADMIN_NOME` | seu nome |

No primeiro boot, com o disco vazio, o sistema cria esse administrador sozinho.
Depois disso a variável é ignorada — ele nunca sobrescreve usuário existente.

### 4. Crie as campanhas pelo painel

Entre com o seu acesso → **🔑 Acessos** → **+ Campanha**.

Cada campanha criada gera na hora dois acessos com senha aleatória (equipe e
candidato). **Anote as senhas: elas aparecem uma única vez.**

### 5. Suba a chave do Firebase de cada campanha

O disco é privado, então o upload é pelo Render Shell (aba **Shell** do serviço):

```bash
mkdir -p /var/dados/campanhas/fernando-souza
cat > /var/dados/campanhas/fernando-souza/firebase-key.json
# cole o conteúdo do JSON, depois Ctrl+D
```

E aponte a chave:

```bash
node --no-warnings=ExperimentalWarning src/configurar.js \
  --firebase fernando-souza \
  --caminho /var/dados/campanhas/fernando-souza/firebase-key.json
```

### 6. Migre os dados da Cláudia (opcional)

A base local dela tem 744 pessoas. Para levar junto, copie pelo Shell os
arquivos de `data/campanhas/claudia/` para `/var/dados/campanhas/claudia/`.

Alternativa mais simples: como tudo já está no Firestore dela, você pode
recomeçar o banco local em produção e reimportar os CSVs dos abaixo-assinados.

### 7. Leia o QR de cada campanha

Painel → troque para a campanha → **🔌 WhatsApp** → **Gerar QR Code**.

Feito uma vez, a sessão fica no disco e sobrevive a deploys.

---

## O que mantém o WhatsApp conectado

Quatro camadas, da mais rasa para a mais profunda:

**1. Keep-alive de 25 segundos.** Conexão ociosa é derrubada por proxies e
provedores. O ping mantém o canal vivo e detecta queda em segundos, não quando
chega mensagem.

**2. Reconexão com espera crescente.** Ao cair, tenta em 5s, 10s, 20s, 40s… com
teto de 5 minutos. Nunca desiste. Só para de tentar em dois casos —
`loggedOut` (deslogaram no celular) e `badSession` — que exigem QR humano.
Todo o resto é tratado como queda temporária.

**3. Vigia de um minuto.** O evento de queda do Baileys resolve quase tudo, mas
não tudo: evento perdido, socket zumbi, container hibernado e acordado. A cada
minuto o sistema verifica quem tem sessão salva no disco e não está conectado,
e religa.

**4. Desligamento limpo.** O Render manda `SIGTERM` antes de cada deploy. O
sistema fecha o socket com `end()`, **não** com `logout()`: a diferença é que
`logout()` apagaria o pareamento e exigiria QR na próxima subida. A sessão fica
no disco e a nova instância reconecta sozinha.

E a trava que evita o erro mais comum de todos:

**Instância única por pasta de dados.** Dois processos apontando para a mesma
pasta abrem duas conexões com a mesma sessão — o WhatsApp derruba uma e pode
invalidar o pareamento. O sistema grava `.instancia.lock` na pasta de dados e
recusa subir se outra instância viva estiver usando. É por isso que o
`render.yaml` fixa `numInstances: 1`: escalar horizontalmente quebraria o
WhatsApp.

Para rodar uma cópia de teste em paralelo, aponte outra pasta:

```bash
DATA_DIR=data-teste PORT=3399 npm start
```

---

## Endereços de produção

| Caminho | Quem usa |
|---|---|
| `/login` | equipe e candidatos |
| `/` | painel (exige sessão) |
| `/cadastro/<slug>` | formulário público de cada campanha |
| `/formulario/<slug>` | pesquisa de pautas de cada campanha |
| `/api/saude` | health check do Render |

Exemplo com o domínio da Cláudia já existente:
`claudiacamargo.onrender.com` é o **site** dela. Este sistema é outro serviço —
sugestão de nome: `rede-apoio.onrender.com`, com os formulários em
`rede-apoio.onrender.com/cadastro/claudia`.

---

## Verificações depois do deploy

```bash
curl https://SEU-SERVICO.onrender.com/api/saude
```

Deve responder com `ok: true`, quantas campanhas existem e o status do WhatsApp
de cada uma:

```json
{
  "ok": true,
  "emAr": 3120,
  "campanhas": 3,
  "whatsapp": [{ "slug": "claudia", "status": "conectado", "telefone": "5519991469316" }]
}
```

Se `status` ficar em `conectando` por muito tempo, veja os logs: o vigia
registra cada tentativa com o código do erro.
