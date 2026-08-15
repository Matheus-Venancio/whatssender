# Colocar em produção — passo a passo

## Por que o painel aparece vazio (e o deploy está certo)

O serviço no Render **está atualizado**. O commit que aparece em Events é o mesmo
do seu `git log`, e o log de boot já mostra `Rede de Apoio — multi-campanha`.

O que falta é outra coisa:

```
Campanhas (nenhuma — rode: npm run configurar)
```

O banco fica em `data/`, que está no `.gitignore` — e precisa estar: são os dados
pessoais de mais de mil pessoas mais a chave do Firebase. **Isso nunca vai subir
por git.** Um servidor novo sempre nasce vazio.

E hoje, mesmo se você criasse as campanhas lá, elas sumiriam: o serviço está no
plano **Free**, sem disco. O sistema de arquivos do container é recriado a cada
deploy e a cada hibernação.

| | localhost | produção hoje |
|---|---|---|
| Código | `fa60747` | `fa60747` ✅ |
| Administrador | existe | existe ✅ |
| Campanhas | 2 | **0** |
| Disco persistente | pasta local | **nenhum** |
| Hiberna | não | **sim, por inatividade** |

---

## O que decidir antes

O plano Free **não sustenta o WhatsApp**. Hibernar mata o processo, e com ele a
conexão: o sistema para de ler os grupos, de detectar atrito e de avisar quando
alguém sai. Só acorda quando alguém abre o painel — e o que passou nos grupos
nesse meio-tempo está perdido para sempre.

Disco persistente no Render também exige instância paga.

**Duas saídas honestas:**

**A) Upgrade da instância + disco.** É o caminho direto. Confira os valores
atuais no site do Render.

**B) Dividir.** Render (mesmo Free) hospeda painel e formulários públicos; o
leitor de WhatsApp roda numa máquina que fica ligada — o PC da equipe ou uma VPS
barata. Os dois lados apontam para o mesmo Firebase. Funciona porque o Firestore
já é o sistema de registro; a máquina local mantém a conexão e o Render serve os
formulários com domínio bonito.

O resto deste guia é o caminho A.

---

## 1. Disco persistente

No serviço → **Disk** → *Add Disk*:

| Campo | Valor |
|---|---|
| Name | `dados` |
| Mount path | `/var/dados` |
| Size | 5 GB |

Adicionar disco exige instância paga; o Render avisa na hora.

> **Por que o mount path importa:** é o único lugar que sobrevive ao deploy.
> Qualquer coisa fora dele é apagada quando o container é recriado.

## 2. Variáveis de ambiente

Em **Environment**, confira/adicione:

| Variável | Valor | Para quê |
|---|---|---|
| `DATA_DIR` | `/var/dados` | manda o sistema gravar no disco |
| `ADMIN_EMAIL` | seu e-mail | cria o administrador no 1º boot |
| `ADMIN_SENHA` | senha forte | idem |
| `FORCAR_HTTPS` | `true` | cookie de sessão com `Secure` |
| `NODE_ENV` | `production` | liga os avisos de produção |
| `SINCRONIZAR_HISTORICO` | `true` | traz o histórico ao parear |

Sem `DATA_DIR`, o sistema avisa no log:

```
⚠  PRODUÇÃO SEM DISCO PERSISTENTE
```

## 3. Suba o código

```bash
git add -A
git commit -m "producao"
git push
```

O Render publica sozinho. Confirme:

```bash
curl https://whatsappsender.com/api/saude
```

## 4. Crie as campanhas em produção

Entre com o e-mail e a senha de `ADMIN_EMAIL`/`ADMIN_SENHA`. Como o servidor é
novo e ainda não tem campanha nenhuma, o painel abre direto na tela de primeiro
uso, com o botão **+ Criar a primeira campanha**. O menu fica apagado até existir
uma campanha — não é falta de permissão, é que não há base para essas telas
lerem.

Depois da primeira, as próximas saem por **🔑 Acessos** → **+ Campanha**.
Anote as senhas dos dois acessos (equipe e candidato) — elas aparecem uma vez só.

Ou pelo **Shell** do Render:

```bash
node --no-warnings=ExperimentalWarning src/configurar.js \
  --campanha "Dra. Cláudia Camargo" --cargo "Deputada Estadual · SP" --slug claudia

node --no-warnings=ExperimentalWarning src/configurar.js \
  --campanha "Fernandão" --cargo "Prefeito · Morungaba" --slug fernandao
```

## 5. Envie a chave do Firebase

O disco é privado; o upload é pelo **Shell** do Render:

```bash
mkdir -p /var/dados/campanhas/claudia
cat > /var/dados/campanhas/claudia/firebase-key.json
# cole o conteúdo do JSON e tecle Ctrl+D
```

Aponte a chave:

```bash
node --no-warnings=ExperimentalWarning src/configurar.js \
  --firebase claudia --caminho /var/dados/campanhas/claudia/firebase-key.json
```

O Fernandão usa o mesmo projeto, em árvore separada — repita apontando o mesmo
arquivo e configure `firebase_prefixo = campanhas`.

## 6. Traga a base

Aqui está a peça que faltava. A base **não viaja por git**, mas já está no
Firestore. No Shell do Render:

```bash
node --no-warnings=ExperimentalWarning src/restaurar-do-firestore.js --campanha claudia
```

Isso só mostra o que viria. Para aplicar:

```bash
node --no-warnings=ExperimentalWarning src/restaurar-do-firestore.js --campanha claudia --confirmar
```

Testado numa pasta limpa, simulando servidor novo:

```
✅ Base de "Dra. Cláudia Camargo" restaurada
   1007 pessoas · 12 grupos · 770 vínculos
   152 assinaturas
```

**O que não volta:** o histórico de mensagens (não é espelhado no Firestore por
padrão — volume alto) e a sessão do WhatsApp. A sessão é de propósito: a mesma
sessão em duas máquinas faz o WhatsApp invalidar o pareamento.

## 7. Leia o QR

Painel → escolha a campanha → **🔌 WhatsApp** → *Gerar QR Code*.

Feito uma vez, a sessão fica no disco e sobrevive a deploys — o desligamento
fecha o socket com `end()`, não `logout()`.

---

## Depois de tudo

```bash
curl https://whatsappsender.com/api/saude
```

```json
{
  "ok": true,
  "campanhas": 2,
  "whatsapp": [{ "slug": "claudia", "status": "conectado", "telefone": "5519…" }]
}
```

---

## Erro: EACCES ao subir

```
Error: EACCES: permission denied, mkdir '/var/dados/campanhas'
    at file:///opt/render/project/src/src/db.js:33:1
==> Exited with status 1
```

`EACCES` é **permissão negada**, não "não encontrado". Um disco montado chega
pronto e gravável; se o processo precisa criar o ponto de montagem, é porque
**não há disco** — e `/var` pertence ao root.

Causa: `DATA_DIR` definido (passo 2) sem o disco adicionado (passo 1). No plano
Free o Render não permite disco, então essa combinação é o padrão de quem
seguiu só metade do guia.

**Para o serviço voltar ao ar agora:** Environment → apague `DATA_DIR` → *Save*.
O sistema volta a gravar em `./data`, dentro do projeto. Sobe e funciona — mas
os dados somem a cada deploy e a cada hibernação.

**Para resolver de verdade:** adicione o disco (passo 1) e devolva `DATA_DIR`.

## Recursos que exigem instância paga

No menu do serviço, o raio ⚡ marca o que o plano Free não tem:

| | Free | Pago |
|---|---|---|
| Disk | ⚡ | sim |
| Shell | ⚡ | sim |
| Scaling | ⚡ | sim |
| One-Off Jobs | ⚡ | sim |

Isso importa porque os passos 5 e 6 deste guia rodam **no Shell**. Sem instância
paga não há Shell, e portanto não há como enviar a chave do Firebase nem
restaurar a base pelo servidor.

## Duas armadilhas

**Não escale para 2 instâncias.** Duas instâncias = duas conexões com a mesma
sessão do WhatsApp = pareamento invalidado. O sistema tem uma trava de pasta que
recusa a segunda instância, mas o certo é manter `numInstances: 1`.

**Runtime.** Seu serviço está com runtime **Node**, e funciona: o sistema usa
`node:sqlite`, que exige Node 22+, e o Render já entrega isso. O `Dockerfile` do
repositório é a alternativa para travar a versão — se um dia o boot falhar com
erro em `node:sqlite`, troque o runtime para Docker em Settings.
