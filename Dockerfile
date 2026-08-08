# Node 22+ é obrigatório: o sistema usa `node:sqlite`, que não existe antes disso.
# Por isso Docker em vez do runtime Node padrão do Render — assim a versão fica
# travada aqui, e não depende do que o provedor resolver instalar.
FROM node:22-slim

# O Baileys usa criptografia nativa e o firebase-admin faz chamadas HTTPS:
# sem os certificados raiz, ambos falham em container enxuto.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Camada de dependências separada: só reinstala quando o package.json muda.
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
# Os dados NÃO ficam no container — vão para o disco persistente montado aqui.
ENV DATA_DIR=/var/dados

EXPOSE 3333

# O Render envia SIGTERM antes de cada deploy. Rodar o node como PID 1 sem
# init faz o sinal chegar direto ao processo, que fecha o WhatsApp preservando
# a sessão no disco.
CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.js"]
