// Carrega o .env ANTES de qualquer outro módulo.
//
// POR QUE UM ARQUIVO SÓ PARA ISTO: em ESM, todos os `import` de um arquivo são
// resolvidos antes da primeira linha dele executar. Então qualquer módulo que
// leia `process.env` no topo já leu — e leu vazio — enquanto o .env ainda nem
// foi aberto. Era esse o motivo de "WACORE_TOKEN não está configurado" com o
// token escrito no arquivo.
//
// Sendo o primeiro import de server.js, este módulo roda antes dos outros e
// popula o ambiente a tempo. Em produção não há .env — as variáveis vêm do
// provedor — e a ausência do arquivo é ignorada de propósito.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const arquivo of ['.env', '.env.dev']) {
  try {
    process.loadEnvFile(join(RAIZ, arquivo));
  } catch {
    // Arquivo ausente é o normal em produção.
  }
}

export const ambienteCarregado = true;
